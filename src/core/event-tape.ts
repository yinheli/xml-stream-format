import { closeSync, openSync, writeSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { checkAbort, XmlError } from './errors.js';
import { Kind, type TapeRecord, type XmlEvent } from './events.js';

const BUFFER_SIZE = 65_536;
const HEADER_SIZE = 8;

function writeAll(file: number, data: Uint8Array, position: number): void {
  let offset = 0;
  while (offset < data.byteLength) {
    const length = Math.min(BUFFER_SIZE, data.byteLength - offset);
    const written = writeSync(file, data, offset, length, position + offset);
    if (written === 0) throw new Error('Event tape write made no progress');
    offset += written;
  }
}

/** Sequential writer. Runs only on the worker thread; sync writes cannot interleave. */
export class TapeWriter {
  private readonly buffer = Buffer.allocUnsafe(BUFFER_SIZE);
  private used = 0;
  private persisted = 0;
  private closed = false;

  private constructor(private readonly file: number) {}

  static create(path: string): TapeWriter {
    return new TapeWriter(openSync(path, 'wx', 0o600));
  }

  get bytes(): number {
    return this.persisted + this.used;
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error('Event tape writer is closed');
  }

  flush(): void {
    if (this.used === 0) return;
    writeAll(this.file, this.buffer.subarray(0, this.used), this.persisted);
    this.persisted += this.used;
    this.used = 0;
  }

  append(event: XmlEvent): number {
    this.ensureOpen();
    const payload = Buffer.from(JSON.stringify(event.data), 'utf8');
    if (payload.byteLength > 0xffff_ffff)
      throw new XmlError('ERR_XML_LIMIT', 'Event tape payload exceeds uint32 capacity');
    if (!Number.isSafeInteger(this.bytes + HEADER_SIZE + payload.byteLength)) {
      throw new XmlError('ERR_XML_LIMIT', 'Event tape offset exceeds safe integer capacity');
    }
    if (this.buffer.length - this.used < HEADER_SIZE) this.flush();
    const offset = this.bytes;
    this.buffer[this.used] = event.kind;
    this.buffer[this.used + 1] = event.flags ?? 0;
    this.buffer.writeUInt16LE(0, this.used + 2);
    this.buffer.writeUInt32LE(payload.byteLength, this.used + 4);
    this.used += HEADER_SIZE;
    if (payload.byteLength > BUFFER_SIZE) {
      this.flush();
      writeAll(this.file, payload, this.persisted);
      this.persisted += payload.byteLength;
    } else {
      let copied = 0;
      while (copied < payload.byteLength) {
        if (this.used === this.buffer.length) this.flush();
        const count = Math.min(payload.byteLength - copied, this.buffer.length - this.used);
        payload.copy(this.buffer, this.used, copied, copied + count);
        copied += count;
        this.used += count;
      }
    }
    return offset;
  }

  patchFlags(offset: number, flags: number): void {
    this.ensureOpen();
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + HEADER_SIZE > this.bytes) {
      throw new RangeError('Invalid event tape header offset');
    }
    if (!Number.isInteger(flags) || flags < 0 || flags > 255)
      throw new RangeError('Invalid event tape flags');
    if (offset >= this.persisted) {
      this.buffer[offset - this.persisted + 1] = flags;
      return;
    }
    // Flush before patching so no later sequential write can overwrite the flag.
    this.flush();
    this.buffer[0] = flags;
    writeAll(this.file, this.buffer.subarray(0, 1), offset + 1);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.flush();
    } finally {
      closeSync(this.file);
    }
  }
}

/** Replays complete records in [start, end), retaining only the current payload. */
export async function* readTape(
  path: string,
  options: { start?: number; end?: number; signal?: AbortSignal; maxRecordBytes?: number } = {},
): AsyncGenerator<TapeRecord> {
  const { signal, maxRecordBytes } = options;
  if (
    maxRecordBytes !== undefined &&
    (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 0)
  ) {
    throw new RangeError('maxRecordBytes must be a nonnegative safe integer');
  }
  checkAbort(signal);
  const file = await open(path, 'r');
  try {
    const size = (await file.stat()).size;
    let position = options.start ?? 0;
    const end = options.end ?? size;
    if (
      !Number.isSafeInteger(position) ||
      !Number.isSafeInteger(end) ||
      position < 0 ||
      end < position ||
      end > size
    ) {
      throw new RangeError('Invalid event tape range');
    }
    const buffer = Buffer.allocUnsafe(BUFFER_SIZE);
    let available = 0;
    let cursor = 0;
    const invalid = (message: string): XmlError =>
      new XmlError('ERR_XML_PARSE', message, { byteOffset: position });
    const readExact = async (target: Buffer): Promise<void> => {
      let copied = 0;
      while (copied < target.length) {
        checkAbort(signal);
        if (cursor === available) {
          const length = Math.min(BUFFER_SIZE, end - position);
          if (length === 0) throw invalid('Truncated event tape record');
          const result = await file.read(buffer, 0, length, position);
          checkAbort(signal);
          if (result.bytesRead === 0) throw invalid('Unexpected end of event tape');
          available = result.bytesRead;
          cursor = 0;
        }
        const count = Math.min(target.length - copied, available - cursor);
        buffer.copy(target, copied, cursor, cursor + count);
        copied += count;
        cursor += count;
        position += count;
      }
    };
    const header = Buffer.allocUnsafe(HEADER_SIZE);
    while (position < end) {
      checkAbort(signal);
      const offset = position;
      if (end - position < HEADER_SIZE) throw invalid('Truncated event tape header');
      await readExact(header);
      const kind = header[0]!;
      const flags = header[1]!;
      if (kind < Kind.Declaration || kind > Kind.Pi || header.readUInt16LE(2) !== 0) {
        throw invalid('Invalid event tape header');
      }
      const length = header.readUInt32LE(4);
      if (length > end - position) throw invalid('Truncated event tape payload');
      if (maxRecordBytes !== undefined && HEADER_SIZE + length > maxRecordBytes) {
        throw new XmlError('ERR_XML_LIMIT', 'Event tape record exceeds maxRecordBytes', {
          byteOffset: offset,
        });
      }
      const payload = Buffer.allocUnsafe(length);
      await readExact(payload);
      let data: unknown;
      try {
        data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
      } catch (cause) {
        throw new XmlError('ERR_XML_PARSE', 'Invalid event tape payload', {
          cause,
          byteOffset: offset,
        });
      }
      checkAbort(signal);
      yield { kind, flags, data, offset, nextOffset: position } as TapeRecord;
    }
  } finally {
    await file.close();
  }
}
