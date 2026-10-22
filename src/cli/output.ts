import { randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { link, lstat, open, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setImmediate } from 'node:timers';
import { abortable, checkAbort, XmlError } from '../core/errors.js';

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

async function consumeChunks(
  iterator: AsyncIterator<string>,
  signal: AbortSignal | undefined,
  write: (chunk: string) => Promise<void>,
): Promise<void> {
  for (;;) {
    checkAbort(signal);
    const next = await abortable(iterator.next(), signal);
    if (next.done) break;
    checkAbort(signal);
    await write(next.value);
  }
  checkAbort(signal);
}

async function writeToStream(
  chunks: AsyncIterator<string>,
  stream: NodeJS.WritableStream,
  signal?: AbortSignal,
): Promise<void> {
  const failure = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, failure.signal]) : failure.signal;
  const onError = (error: Error): void => failure.abort(error);
  stream.on('error', onError);
  let writePending = false;
  let writeFinished: Promise<void> | undefined;

  try {
    await consumeChunks(
      chunks,
      combinedSignal,
      (chunk) =>
        new Promise<void>((resolveWrite, rejectWrite) => {
          let callbackDone = false;
          let writeReturned = false;
          let needsDrain = false;
          let drained = false;
          let settled = false;
          let finishCallback!: () => void;
          writeFinished = new Promise<void>((done) => {
            finishCallback = done;
          });

          const cleanup = (): void => {
            stream.removeListener('drain', onDrain);
            combinedSignal.removeEventListener('abort', onAbort);
          };
          const reject = (error: unknown): void => {
            if (settled) return;
            settled = true;
            cleanup();
            rejectWrite(error);
          };
          const finish = (): void => {
            if (settled || !writeReturned || !callbackDone || (needsDrain && !drained)) return;
            settled = true;
            cleanup();
            resolveWrite();
          };
          const onDrain = (): void => {
            drained = true;
            finish();
          };
          const onAbort = (): void => reject(combinedSignal.reason);
          stream.on('drain', onDrain);
          combinedSignal.addEventListener('abort', onAbort, { once: true });
          if (combinedSignal.aborted) {
            finishCallback();
            onAbort();
            return;
          }

          writePending = true;
          try {
            needsDrain = !stream.write(chunk, 'utf8', (error?: Error | null) => {
              writePending = false;
              finishCallback();
              if (error) failure.abort(error);
              else {
                callbackDone = true;
                finish();
              }
            });
            writeReturned = true;
            finish();
          } catch (error) {
            writePending = false;
            finishCallback();
            failure.abort(error);
          }
        }),
    );
  } finally {
    const removeErrorListener = (): void => {
      stream.removeListener('error', onError);
    };
    // A write callback can precede Node's corresponding error event. Keep its
    // listener through that event, including when cancellation abandons a write.
    if (writePending && writeFinished) {
      void writeFinished.then(() => {
        setImmediate(removeErrorListener);
      });
    } else if (failure.signal.aborted) {
      await new Promise<void>((done) => {
        setImmediate(() => {
          removeErrorListener();
          done();
        });
      });
    } else {
      removeErrorListener();
    }
  }
}

async function assertOutputAvailable(
  target: string,
  inputPath?: string,
  cause?: unknown,
): Promise<void> {
  if (inputPath !== undefined && target === resolve(inputPath)) {
    throw new XmlError('ERR_XML_OUTPUT_INPUT', 'Output must not refer to the input file', {
      cause,
    });
  }

  let existing: BigIntStats;
  try {
    existing = await lstat(target, { bigint: true });
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return;
    throw error;
  }

  if (inputPath !== undefined) {
    let destination = existing;
    if (existing.isSymbolicLink()) {
      try {
        destination = await stat(target, { bigint: true });
      } catch (error) {
        if (!hasCode(error, 'ENOENT') && !hasCode(error, 'ELOOP')) throw error;
      }
    }
    // stat follows realpath aliases; device/inode equality also catches hard links.
    const input = await stat(inputPath, { bigint: true });
    if (input.dev === destination.dev && input.ino === destination.ino) {
      throw new XmlError('ERR_XML_OUTPUT_INPUT', 'Output must not refer to the input file', {
        cause,
      });
    }
  }
  throw new XmlError('ERR_XML_OUTPUT_EXISTS', 'Output path already exists', { cause });
}

async function writeToFile(
  chunks: AsyncIterator<string>,
  output: string,
  inputPath?: string,
  signal?: AbortSignal,
): Promise<void> {
  checkAbort(signal);
  const target = resolve(output);
  await assertOutputAvailable(target, inputPath);
  checkAbort(signal);
  const temporaryPath = join(dirname(target), `.xml-stream-format-${randomUUID()}.tmp`);
  let file: FileHandle | undefined = await open(temporaryPath, 'wx', 0o600);
  let failed = false;
  let failure: unknown;

  try {
    const handle = file;
    await consumeChunks(chunks, signal, async (chunk) => {
      if (chunk.length === 0) return;
      const buffer = Buffer.from(chunk, 'utf8');
      let offset = 0;
      while (offset < buffer.length) {
        checkAbort(signal);
        const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null);
        if (bytesWritten === 0)
          throw new XmlError('ERR_XML_OUTPUT_WRITE', 'Output file write made no progress');
        offset += bytesWritten;
      }
      checkAbort(signal);
    });
    await file.close();
    file = undefined;
    checkAbort(signal);
    try {
      await link(temporaryPath, target);
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
      await assertOutputAvailable(target, inputPath, error);
      throw new XmlError('ERR_XML_OUTPUT_EXISTS', 'Output path already exists', { cause: error });
    }
  } catch (error) {
    failed = true;
    failure = error;
  }

  try {
    await file?.close();
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  try {
    await unlink(temporaryPath);
  } catch (error) {
    if (!hasCode(error, 'ENOENT') && !failed) {
      failed = true;
      failure = error;
    }
  }
  if (failed) throw failure;
}

export async function writeOutput(
  chunks: AsyncIterable<string>,
  options: {
    output?: string;
    inputPath?: string;
    signal?: AbortSignal;
    stdout?: NodeJS.WritableStream;
  } = {},
): Promise<void> {
  const iterator = chunks[Symbol.asyncIterator]();
  try {
    if (options.output !== undefined) {
      await writeToFile(iterator, options.output, options.inputPath, options.signal);
    } else {
      await writeToStream(iterator, options.stdout ?? process.stdout, options.signal);
    }
  } catch (error) {
    try {
      await iterator.return?.();
    } catch {
      // Preserve the output/abort error rather than an iterator cleanup error.
    }
    throw error;
  }
}
