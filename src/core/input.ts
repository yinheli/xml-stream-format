import { abortable, checkAbort, positiveInteger, XmlError } from './errors.js';
import { TokenBudget } from './token-budget.js';

const CHUNK_BYTES = 65_536;
const PROLOG_BYTES = 4_096;
const STRING_CHARS = CHUNK_BYTES / 4;
type Encoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'us-ascii' | 'iso-8859-1';

export interface InputOptions {
  signal?: AbortSignal;
  /** Maximum UTF-16 code units in original source markup or references. */
  maxTokenCodeUnits?: number;
  /** Original source bytes consumed in this increment, before normalization. */
  onSourceBytes?: (bytes: number) => void;
}

function encodingError(message: string, cause?: unknown): XmlError {
  return new XmlError('ERR_XML_ENCODING', message, { cause });
}

/** undefined means that more of the bounded prolog is needed. */
function declarationEnd(text: string, eof: boolean): number | undefined {
  const opening = '<?xml';
  if (text.length < opening.length && opening.startsWith(text)) return eof ? 0 : undefined;
  if (!text.startsWith(opening)) return 0;
  if (text.length === opening.length) return eof ? 0 : undefined;
  if (!/[\x20\x09\x0a\x0d]/.test(text[opening.length]!)) return 0;
  const end = text.indexOf('?>', opening.length);
  return end === -1 ? (eof ? text.length : undefined) : end + 2;
}

function rewriteDeclaration(text: string, end: number): string {
  if (!end) return text;
  const declaration = text
    .slice(0, end)
    .replace(
      /\bencoding[\x20\x09\x0a\x0d]*=[\x20\x09\x0a\x0d]*(['"])([^'"]*)\1/,
      (_match: string, _quote: string, name: string) => {
        if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(name))
          throw encodingError('Invalid XML declaration encoding name');
        return 'encoding="UTF-8"';
      },
    );
  return declaration + text.slice(end);
}

function resolveEncoding(
  name: string | undefined,
  inferred: Encoding,
  signature: boolean,
): Encoding {
  if (name === undefined) return inferred;
  const normalized = name.toUpperCase();
  let result: Encoding;
  switch (normalized) {
    case 'UTF-8':
      result = 'utf-8';
      break;
    case 'UTF-16':
      if (inferred !== 'utf-16le' && inferred !== 'utf-16be') {
        throw encodingError('UTF-16 declaration does not match the XML byte signature');
      }
      result = inferred;
      break;
    case 'UTF-16LE':
      result = 'utf-16le';
      break;
    case 'UTF-16BE':
      result = 'utf-16be';
      break;
    case 'US-ASCII':
      result = 'us-ascii';
      break;
    case 'ISO-8859-1':
      result = 'iso-8859-1';
      break;
    default:
      throw encodingError(`Unsupported XML encoding: ${name}`);
  }
  if (
    (signature && result !== inferred) ||
    (!signature && (result === 'utf-16le' || result === 'utf-16be'))
  ) {
    throw encodingError('XML encoding declaration conflicts with the BOM or byte signature');
  }
  return result;
}

class ByteDecoder {
  private readonly prefix = Buffer.allocUnsafe(PROLOG_BYTES);
  private prefixLength = 0;
  private encoding?: Encoding;
  private decoder?: TextDecoder;

  constructor(private readonly budget: TokenBudget) {}

  *push(bytes: Uint8Array): Generator<string> {
    let offset = 0;
    if (!this.encoding) {
      const count = Math.min(bytes.length, PROLOG_BYTES - this.prefixLength);
      this.prefix.set(bytes.subarray(0, count), this.prefixLength);
      this.prefixLength += count;
      offset = count;
      const initial = this.start(false);
      if (initial !== undefined) yield initial;
    }
    if (offset < bytes.length) yield this.decode(bytes.subarray(offset));
  }

  finish(): string {
    if (!this.encoding) return this.start(true)! + this.decode(new Uint8Array(), true);
    return this.decode(new Uint8Array(), true);
  }

  private start(eof: boolean): string | undefined {
    const bytes = this.prefix.subarray(0, this.prefixLength);
    if (bytes.length < 4 && !eof) return undefined;
    let inferred: Encoding = 'utf-8';
    let signature = false;
    let bom = 0;
    if (
      (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff) ||
      (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0) ||
      (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 0x3c) ||
      (bytes[0] === 0x3c && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 0) ||
      (bytes[0] === 0x4c && bytes[1] === 0x6f && bytes[2] === 0xa7 && bytes[3] === 0x94)
    )
      throw encodingError('Unsupported XML byte signature');
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      signature = true;
      bom = 3;
    } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      inferred = 'utf-16le';
      signature = true;
      bom = 2;
    } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      inferred = 'utf-16be';
      signature = true;
      bom = 2;
    } else if (bytes[0] === 0x3c && bytes[1] === 0 && bytes[2] !== 0 && bytes[3] === 0) {
      inferred = 'utf-16le';
      signature = true;
    } else if (bytes[0] === 0 && bytes[1] === 0x3c && bytes[2] === 0 && bytes[3] !== 0) {
      inferred = 'utf-16be';
      signature = true;
    }
    // Only the ASCII declaration is inspected before choosing the fatal decoder.
    // latin1 here preserves every byte rather than prematurely rejecting a later
    // ISO-8859-1 body that happens to be in this same prefix.
    const body = bytes.subarray(bom);
    let probe: string;
    if (inferred === 'utf-16le' || inferred === 'utf-16be') {
      probe = '';
      for (let i = 0; i + 1 < body.length; i += 2) {
        probe += String.fromCharCode(
          inferred === 'utf-16le' ? body[i]! | (body[i + 1]! << 8) : (body[i]! << 8) | body[i + 1]!,
        );
      }
    } else {
      probe = body.toString('latin1');
    }
    const end = declarationEnd(probe, eof);
    if (end === undefined) {
      if (bytes.length === PROLOG_BYTES)
        throw new XmlError('ERR_XML_LIMIT', 'XML declaration exceeds the 4 KiB prolog budget');
      return undefined;
    }
    const name = /\bencoding[\x20\x09\x0a\x0d]*=[\x20\x09\x0a\x0d]*(['"])([^'"]*)\1/.exec(
      probe.slice(0, end),
    )?.[2];
    this.encoding = resolveEncoding(name, inferred, signature);
    if (this.encoding !== 'us-ascii' && this.encoding !== 'iso-8859-1') {
      this.decoder = new TextDecoder(this.encoding, { fatal: true, ignoreBOM: true });
    }
    return rewriteDeclaration(this.decode(body), end);
  }

  private decode(bytes: Uint8Array, eof = false): string {
    try {
      let text: string;
      if (this.encoding === 'us-ascii') {
        for (const byte of bytes)
          if (byte >= 0x80) throw encodingError('Non-ASCII byte in US-ASCII XML');
        text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('ascii');
      } else if (this.encoding === 'iso-8859-1') {
        text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
      } else {
        text = this.decoder!.decode(bytes, { stream: !eof });
      }
      this.budget.scan(text);
      return text;
    } catch (cause) {
      if (cause instanceof XmlError) throw cause;
      throw encodingError(`Invalid ${this.encoding} XML input`, cause);
    }
  }
}

class StringProlog {
  private prefix = '';
  private prefixBytes = 0;
  private complete = false;

  push(text: string, eof = false): string {
    if (this.complete) return text;
    let count = 0;
    while (count < text.length) {
      const unit = text.charCodeAt(count);
      const width = unit < 0x80 ? 1 : unit < 0x800 ? 2 : unit >= 0xd800 && unit <= 0xdbff ? 4 : 3;
      if (this.prefixBytes + width > PROLOG_BYTES) break;
      this.prefixBytes += width;
      count += width === 4 ? 2 : 1;
    }
    this.prefix += text.slice(0, count);
    const end = declarationEnd(this.prefix, eof);
    if (end === undefined) {
      if (this.prefixBytes === PROLOG_BYTES || count < text.length)
        throw new XmlError('ERR_XML_LIMIT', 'XML declaration exceeds the 4 KiB prolog budget');
      return '';
    }
    this.complete = true;
    const result = rewriteDeclaration(this.prefix, end) + text.slice(count);
    this.prefix = '';
    return result;
  }
}

/** Enforce original source token limits while decoding incrementally to UTF-8. */
export async function* normalizeInput(
  source: AsyncIterable<Uint8Array | string>,
  options: InputOptions = {},
): AsyncGenerator<Buffer> {
  const budget = new TokenBudget(
    positiveInteger(options.maxTokenCodeUnits, 8_388_608, 'maxTokenCodeUnits'),
  );
  const iterator = source[Symbol.asyncIterator]();
  let mode: 'bytes' | 'string' | undefined;
  let done = false;
  let failed = false;
  let highSurrogate = '';
  let firstString = true;
  let firstOutput = true;
  const byteDecoder = new ByteDecoder(budget);
  const stringProlog = new StringProlog();

  function* output(text: string): Generator<Buffer> {
    if (firstOutput && text.length) {
      firstOutput = false;
      if (text.charCodeAt(0) === 0xfeff)
        throw new XmlError('ERR_XML_PARSE', 'Unexpected additional BOM before the XML document');
    }
    // Each slice contains at most 64 KiB of UTF-8 and never bisects a pair.
    for (let offset = 0; offset < text.length; ) {
      let end = Math.min(text.length, offset + STRING_CHARS);
      const last = text.charCodeAt(end - 1);
      if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
      yield Buffer.from(text.slice(offset, end), 'utf8');
      offset = end;
    }
  }

  try {
    while (true) {
      checkAbort(options.signal);
      const next = await abortable(iterator.next(), options.signal);
      if (next.done) {
        done = true;
        break;
      }
      const value = next.value;
      const nextMode = typeof value === 'string' ? 'string' : 'bytes';
      if (mode && mode !== nextMode)
        throw encodingError('XML source cannot mix string and byte chunks');
      mode = nextMode;
      if (typeof value === 'string') {
        for (let offset = 0; offset < value.length; offset += STRING_CHARS) {
          checkAbort(options.signal);
          let text = highSurrogate + value.slice(offset, offset + STRING_CHARS);
          highSurrogate = '';
          for (let i = 0; i < text.length; i++) {
            const unit = text.charCodeAt(i);
            if (unit >= 0xd800 && unit <= 0xdbff) {
              if (i + 1 === text.length) {
                highSurrogate = text[i]!;
                text = text.slice(0, -1);
                break;
              }
              const low = text.charCodeAt(++i);
              if (low < 0xdc00 || low > 0xdfff)
                throw encodingError('Unpaired high surrogate in XML string input');
            } else if (unit >= 0xdc00 && unit <= 0xdfff) {
              throw encodingError('Unpaired low surrogate in XML string input');
            }
          }
          options.onSourceBytes?.(Buffer.byteLength(text, 'utf8'));
          if (firstString && text.length) {
            firstString = false;
            if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
          }
          budget.scan(text);
          yield* output(stringProlog.push(text));
        }
      } else {
        if (!(value instanceof Uint8Array))
          throw new TypeError('XML source chunks must be strings or Uint8Arrays');
        options.onSourceBytes?.(value.byteLength);
        for (let offset = 0; offset < value.byteLength; offset += CHUNK_BYTES) {
          checkAbort(options.signal);
          for (const text of byteDecoder.push(value.subarray(offset, offset + CHUNK_BYTES)))
            yield* output(text);
        }
      }
    }
    checkAbort(options.signal);
    if (highSurrogate) throw encodingError('Unpaired high surrogate at end of XML string input');
    yield* output(mode === 'string' ? stringProlog.push('', true) : byteDecoder.finish());
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // Do not wait indefinitely for a producer that ignores cancellation.
    if (!done && iterator.return) {
      const closing = Promise.resolve().then(() => iterator.return!());
      if (options.signal?.aborted) void closing.catch(() => {});
      else if (failed) await abortable(closing, options.signal).catch(() => {});
      else await abortable(closing, options.signal);
    }
  }
}
