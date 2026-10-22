import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { abortable, checkAbort, XmlError } from '../core/errors.js';
import type { ClipboardMode } from './types.js';

export const LOCAL_LIMIT = 1_048_576;
const OSC52_LIMIT = 75 * 1024;

function clipboardTransport(mode: ClipboardMode): 'local' | 'osc52' {
  const transport =
    mode === 'auto'
      ? process.env.SSH_CONNECTION || process.env.SSH_TTY
        ? 'osc52'
        : 'local'
      : mode;
  if (transport === 'off')
    throw new XmlError('ERR_XML_CLIPBOARD', 'Clipboard copying is disabled (--clipboard off).');
  return transport;
}

export function clipboardByteLimit(mode: ClipboardMode): number {
  return clipboardTransport(mode) === 'local' ? LOCAL_LIMIT : OSC52_LIMIT;
}

function copyLimit(limit: number): XmlError {
  return new XmlError(
    'ERR_XML_COPY_LIMIT',
    `Copy exceeds the ${limit.toLocaleString('en-US')}-byte UTF-8 limit; extract or export the content instead. Nothing was copied.`,
  );
}

async function collectText(
  source: string | AsyncIterable<string>,
  limit: number,
  signal?: AbortSignal,
): Promise<string> {
  checkAbort(signal);
  if (typeof source === 'string') {
    if (Buffer.byteLength(source, 'utf8') > limit) throw copyLimit(limit);
    return source;
  }

  const parts: string[] = [];
  const iterator = source[Symbol.asyncIterator]();
  let bytes = 0;
  let pendingHighSurrogate = false;
  try {
    for (;;) {
      checkAbort(signal);
      const next = await abortable(iterator.next(), signal);
      checkAbort(signal);
      if (next.done) break;
      const chunk = next.value;
      if (chunk.length === 0) continue;

      // Defer the final high surrogate so a pair split between chunks is charged
      // as one UTF-8 character, rather than two replacement characters.
      const lastCode = chunk.charCodeAt(chunk.length - 1);
      const firstCode = chunk.charCodeAt(0);
      const nextPending = lastCode >= 0xd800 && lastCode <= 0xdbff;
      const startsLowSurrogate = firstCode >= 0xdc00 && firstCode <= 0xdfff;
      const carryBytes = pendingHighSurrogate ? (startsLowSurrogate ? 1 : 3) : 0;
      const nextBytes =
        bytes + Buffer.byteLength(chunk, 'utf8') + carryBytes - (nextPending ? 3 : 0);
      if (nextBytes > limit) throw copyLimit(limit);
      parts.push(chunk);
      bytes = nextBytes;
      pendingHighSurrogate = nextPending;
    }
    if (bytes + (pendingHighSurrogate ? 3 : 0) > limit) throw copyLimit(limit);
    return parts.join('');
  } catch (error) {
    try {
      await abortable(iterator.return?.(), signal);
    } catch {
      // Preserve the copy/source error even if closing its iterator also fails.
    }
    throw error;
  }
}

async function writeSequence(
  output: NodeJS.WritableStream,
  sequence: string,
  signal?: AbortSignal,
): Promise<void> {
  const completion = Promise.withResolvers<void>();
  let settled = false;
  let failed = false;
  let returned = false;
  let callbackDone = false;
  let needsDrain = false;
  let drained = false;
  let writePending = false;
  const writeFinished = Promise.withResolvers<void>();

  const reject = (error: unknown): void => {
    if (settled) return;
    settled = true;
    failed = true;
    completion.reject(error);
  };
  const finish = (): void => {
    if (settled || !returned || !callbackDone || (needsDrain && !drained)) return;
    settled = true;
    completion.resolve();
  };
  const onDrain = (): void => {
    drained = true;
    finish();
  };
  const onClose = (): void =>
    reject(new Error('Display stream closed before the OSC52 sequence was written'));
  const onAbort = (): void => reject(signal?.reason);
  output.on('error', reject);
  output.on('drain', onDrain);
  output.on('close', onClose);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal?.aborted) {
      onAbort();
    } else if (!output.writable) {
      reject(new Error('Display stream is not writable'));
    } else {
      try {
        writePending = true;
        needsDrain = !output.write(sequence, 'utf8', (error?: Error | null) => {
          writePending = false;
          writeFinished.resolve();
          if (error) reject(error);
          else {
            callbackDone = true;
            finish();
          }
        });
        returned = true;
        finish();
      } catch (error) {
        writePending = false;
        writeFinished.resolve();
        reject(error);
      }
    }
    await completion.promise;
  } finally {
    output.removeListener('drain', onDrain);
    output.removeListener('close', onClose);
    signal?.removeEventListener('abort', onAbort);
    const removeErrorListener = (): void => {
      output.removeListener('error', reject);
    };
    // An abandoned write can still report its error after its callback fires.
    if (writePending) {
      void writeFinished.promise.then(async () => {
        await setImmediate();
        removeErrorListener();
      });
    } else {
      if (failed) await setImmediate();
      removeErrorListener();
    }
  }
}

async function terminateCopy(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  if (process.platform !== 'win32') {
    try {
      // The helper is the session leader, so this also kills clipboardy's native descendants.
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
    return;
  }

  const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
  await new Promise<void>((resolve, reject) => {
    const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', reject);
    killer.once('close', (code) => {
      // The helper may have finished naturally before taskkill reached it.
      if (code === 0 || child.exitCode !== null || child.signalCode !== null) resolve();
      else
        reject(
          new Error(`Could not terminate the clipboard process tree (taskkill exited ${code})`),
        );
    });
  });
}

async function writeLocal(text: string, signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./clipboard-helper.js', import.meta.url))],
    {
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
    },
  );
  const completion = Promise.withResolvers<void>();
  let closed = false;
  let failure: unknown;
  let stopping: Promise<void> | undefined;
  let errorText = '';
  let errorBytes = 0;
  child.stderr.on('data', (chunk: Buffer) => {
    const remaining = LOCAL_LIMIT - errorBytes;
    if (remaining <= 0) return;
    const part = chunk.subarray(0, remaining);
    errorText += part.toString('utf8');
    errorBytes += part.length;
  });
  child.stdin.on('error', (error) => {
    failure ??= error;
  });
  child.on('error', (error) => {
    failure ??= error;
  });
  child.once('close', (code, exitSignal) => {
    closed = true;
    if (code !== 0)
      failure ??= new Error(errorText || `Clipboard helper exited ${exitSignal ?? code}`);
    completion.resolve();
  });
  const onAbort = (): void => {
    if (closed || stopping) return;
    child.stdin.destroy();
    stopping = terminateCopy(child).catch((error) => {
      // Still reap the owned helper if the OS tree-termination command itself fails.
      failure ??= error;
      child.kill('SIGKILL');
    });
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal?.aborted) onAbort();
    else child.stdin.end(text, 'utf8');
    await completion.promise;
    await stopping;
    checkAbort(signal);
    if (failure !== undefined) throw failure;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function copyText(
  source: string | AsyncIterable<string>,
  options: { mode: ClipboardMode; output: NodeJS.WritableStream; signal?: AbortSignal },
): Promise<string> {
  checkAbort(options.signal);
  const mode = clipboardTransport(options.mode);
  const text = await collectText(source, clipboardByteLimit(mode), options.signal);
  checkAbort(options.signal);
  if (mode === 'local') {
    try {
      await writeLocal(text, options.signal);
    } catch (cause) {
      checkAbort(options.signal);
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new XmlError('ERR_XML_CLIPBOARD', `Could not copy to local clipboard: ${reason}`, {
        cause,
      });
    }
    return 'Copied to local clipboard';
  }

  const sequence = `\u001b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\u0007`;
  const wrapped = process.env.TMUX
    ? `\u001bPtmux;${sequence.replaceAll('\u001b', '\u001b\u001b')}\u001b\\`
    : sequence;
  try {
    await writeSequence(options.output, wrapped, options.signal);
  } catch (cause) {
    checkAbort(options.signal);
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new XmlError('ERR_XML_CLIPBOARD', `Could not send OSC52 to terminal: ${reason}`, {
      cause,
    });
  }
  return 'Sent to terminal (OSC52)';
}
