import { Buffer } from 'buffer';
import { normalizeInput } from '../../src/core/input.js';

// The library decodes with Node's Buffer; the `buffer` package is API-compatible.
const scope = globalThis as unknown as Record<string, unknown>;
scope.Buffer ??= Buffer;

// The polyfill handles UTF-8 strings with array-building JavaScript; both calls sit on hot
// paths (normalized input, formatted output batching), so route them to native code.
const encoder = new TextEncoder();
const bufferFrom = Buffer.from as (...args: unknown[]) => Buffer;
Buffer.from = function from(value: unknown, encoding?: unknown, length?: unknown) {
  if (typeof value === 'string' && (encoding === undefined || encoding === 'utf8')) {
    const bytes = encoder.encode(value);
    return bufferFrom.call(Buffer, bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  return bufferFrom.call(Buffer, value, encoding, length);
} as typeof Buffer.from;
const byteLength = Buffer.byteLength;
Buffer.byteLength = function utf8Length(value: unknown, encoding?: unknown) {
  if (typeof value !== 'string' || (encoding !== undefined && encoding !== 'utf8'))
    return (byteLength as (...args: unknown[]) => number).call(Buffer, value, encoding);
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit < 0xdc00 && unit >= 0xd800 && (value.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
} as typeof Buffer.byteLength;

const CHUNK_BYTES = 256 * 1024;
let parserReady: Promise<unknown> | undefined;

/**
 * The vendored Emscripten build enables only the `web` and `node` environments, so
 * the worker briefly presents itself as a window while the WASM module initializes.
 */
export function loadParser(): Promise<unknown> {
  parserReady ??= (async () => {
    const workerScope = scope.WorkerGlobalScope;
    scope.window = scope;
    delete scope.WorkerGlobalScope;
    try {
      return await import('#expat-wasm');
    } finally {
      scope.WorkerGlobalScope = workerScope;
      delete scope.window;
    }
  })();
  return parserReady;
}

/** Reads a Blob lazily: a slice is fetched only when the parser pulls the next chunk. */
export async function* blobChunks(
  blob: Blob,
  beforeChunk?: () => Promise<void>,
): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
    if (beforeChunk) await beforeChunk();
    yield new Uint8Array(await blob.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
  }
}

/** Strict decoding to the library's normalized UTF-8 stream. */
export function normalizedBlob(
  blob: Blob,
  options: { signal?: AbortSignal; onSourceBytes?: (bytes: number) => void } = {},
  beforeChunk?: () => Promise<void>,
): AsyncGenerator<Uint8Array> {
  return normalizeInput(blobChunks(blob, beforeChunk), options);
}

const ticks = new MessageChannel();
const tickWaiters: (() => void)[] = [];
ticks.port1.onmessage = () => tickWaiters.shift()?.();

/** A macrotask boundary lets queued messages (cancel, navigation) run during long scans. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    tickWaiters.push(resolve);
    ticks.port2.postMessage(null);
  });
}

export interface WireError {
  code: string;
  message: string;
}

export function wireError(cause: unknown): WireError {
  const code =
    cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string'
      ? cause.code
      : cause instanceof DOMException && cause.name === 'AbortError'
        ? 'ABORT_ERR'
        : 'ERR_DEMO';
  return { code, message: cause instanceof Error ? cause.message : String(cause) };
}
