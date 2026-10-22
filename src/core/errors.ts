export class XmlError extends Error {
  readonly code: string;
  readonly line?: number;
  readonly column?: number;
  readonly byteOffset?: number;
  readonly path?: readonly string[];
  constructor(
    code: string,
    message: string,
    details: {
      cause?: unknown;
      line?: number;
      column?: number;
      byteOffset?: number;
      path?: readonly string[];
    } = {},
  ) {
    super(message, { cause: details.cause });
    this.name = 'XmlError';
    this.code = code;
    this.line = details.line;
    this.column = details.column;
    this.byteOffset = details.byteOffset;
    this.path = details.path;
  }
}
export function checkAbort(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}
export async function abortable<T>(value: T | PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await value;
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const abort = () => {
    signal.removeEventListener('abort', abort);
    reject(signal.reason);
  };
  signal.addEventListener('abort', abort, { once: true });
  Promise.resolve(value)
    .then(resolve, reject)
    .finally(() => signal.removeEventListener('abort', abort));
  if (signal.aborted) abort();
  return await promise;
}
export function positiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n <= 0)
    throw new RangeError(`${label} must be a positive safe integer`);
  return n;
}
