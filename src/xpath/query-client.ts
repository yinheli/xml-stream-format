import { Worker } from 'node:worker_threads';
import { abortable, checkAbort, positiveInteger, XmlError } from '../core/errors.js';
import type { WorkerResponse } from '../document/protocol.js';
import type { DocumentSession } from '../document/session.js';
import type { SelectOptions, XmlNodeMatch } from '../document/types.js';
import type { QueryRequests, QueryResults } from './protocol.js';

interface Pending {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
}

/** Only this parent-thread controller can interrupt synchronous XPath evaluation. */
export class QueryClient {
  private worker?: Worker;
  private heap?: number;
  private requestId = 0;
  private pending = new Map<number, Pending>();
  private tail: Promise<void> = Promise.resolve();
  private closing?: Promise<void>;
  private stopping?: Promise<void>;
  private readonly onAbort: () => void;

  constructor(private readonly session: DocumentSession) {
    this.onAbort = () => {
      void this.close();
    };
    session.signal.addEventListener('abort', this.onAbort, { once: true });
  }

  private enqueue<T>(task: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.closing)
      return Promise.reject(new XmlError('ERR_XML_CLOSED', 'XML document is closed'));
    const combined = signal ? AbortSignal.any([signal, this.session.signal]) : this.session.signal;
    const result = this.tail.then(async () => {
      if (this.closing) throw new XmlError('ERR_XML_CLOSED', 'XML document is closed');
      this.session.assertOpen();
      checkAbort(combined);
      return await task(combined);
    });
    this.tail = result.then(
      () => {},
      () => {},
    );
    return abortable(result, combined);
  }

  private stop(reason: unknown): Promise<void> {
    if (this.stopping) return this.stopping;
    const worker = this.worker;
    this.worker = undefined;
    this.heap = undefined;
    this.stopping = (async () => {
      try {
        if (worker) await worker.terminate();
      } finally {
        for (const pending of this.pending.values()) pending.reject(reason);
        this.pending.clear();
      }
    })().finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }

  private async ensureWorker(heap: number, signal: AbortSignal): Promise<void> {
    if (this.stopping) await this.stopping;
    if (this.closing) throw new XmlError('ERR_XML_CLOSED', 'XML document is closed');
    if (this.worker && this.heap === heap) return;
    if (this.worker) await this.stop(new XmlError('ERR_XPATH_LIMIT', 'XPath heap budget changed'));
    if (this.closing) throw new XmlError('ERR_XML_CLOSED', 'XML document is closed');
    checkAbort(signal);
    let worker: Worker;
    try {
      worker = new Worker(new URL('./query-worker.js', import.meta.url), {
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: heap },
      });
    } catch (cause) {
      throw new XmlError(
        'ERR_XPATH_LIMIT',
        'Cannot start XPath worker with the requested heap budget',
        { cause },
      );
    }
    this.worker = worker;
    this.heap = heap;
    worker.on('message', (message: WorkerResponse) => {
      if (
        this.worker !== worker ||
        !message ||
        message.sessionId !== this.session.id ||
        message.type === 'progress'
      )
        return;
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      if (message.type === 'result') pending.resolve(message.value);
      else
        pending.reject(
          new XmlError(message.error.code, message.error.message, {
            ...message.error,
            cause: message.error.cause ? new Error(message.error.cause) : undefined,
          }),
        );
    });
    worker.on('error', (cause) => {
      if (this.worker === worker)
        void this.stop(
          new XmlError(
            'ERR_XPATH_LIMIT',
            `XPath worker failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            { cause },
          ),
        );
    });
    worker.on('exit', (code) => {
      if (this.worker === worker)
        void this.stop(
          new XmlError('ERR_XPATH_LIMIT', `XPath worker exited unexpectedly (${code})`),
        );
    });
    await this.request('load', { tapePath: this.session.tapePath }, signal, 30_000);
  }

  private async request<K extends keyof QueryRequests>(
    type: K,
    payload: QueryRequests[K],
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<QueryResults[K]> {
    checkAbort(signal);
    const worker = this.worker;
    if (!worker)
      throw new XmlError('ERR_XPATH_QUERY', 'XPath worker is not loaded; run the query again');
    const requestId = ++this.requestId;
    const result = new Promise<unknown>((resolve, reject) =>
      this.pending.set(requestId, { resolve, reject }),
    );
    const abort = () => {
      void this.stop(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      void this.stop(
        new XmlError(
          'ERR_XPATH_TIMEOUT',
          `${type === 'load' ? 'XPath DOM loading' : 'XPath evaluation'} exceeded ${timeoutMs} ms; worker terminated`,
        ),
      );
    }, timeoutMs);
    try {
      worker.postMessage({ sessionId: this.session.id, requestId, type, payload });
      // This key selects the corresponding result from our paired worker protocol.
      return (await result) as QueryResults[K];
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      this.pending.delete(requestId);
    }
  }

  private async selectCore(
    expression: string,
    options: SelectOptions,
    signal: AbortSignal,
  ): Promise<readonly XmlNodeMatch[]> {
    const maxSourceBytes = positiveInteger(options.maxSourceBytes, 67_108_864, 'maxSourceBytes');
    const heap = positiveInteger(options.maxOldGenerationSizeMb, 512, 'maxOldGenerationSizeMb');
    const timeout = positiveInteger(options.queryTimeoutMs, 10_000, 'queryTimeoutMs');
    if (timeout > 2_147_483_647) throw new RangeError('queryTimeoutMs must be at most 2147483647');
    const maxResults = positiveInteger(options.maxResults, 100_000, 'maxResults');
    await this.session.ensureComplete(signal, maxSourceBytes);
    const namespaces = Object.entries(options.namespaces ?? {});
    await this.ensureWorker(heap, signal);
    return await this.request('select', { expression, namespaces, maxResults }, signal, timeout);
  }

  select(expression: string, options: SelectOptions = {}): Promise<readonly XmlNodeMatch[]> {
    return this.enqueue((signal) => this.selectCore(expression, options, signal), options.signal);
  }

  readValue(
    match: XmlNodeMatch,
    options: SelectOptions = {},
    maxBytes = 1_048_576,
  ): Promise<string> {
    return this.enqueue(async (signal) => {
      const limit = positiveInteger(maxBytes, 1_048_576, 'maxBytes');
      if (match.ref.kind !== 'attribute' && match.ref.kind !== 'text') {
        throw new XmlError(
          'ERR_XML_COPY_NODE_TYPE',
          'Only matched attributes and text nodes have copyable values',
        );
      }
      const matches = await this.selectCore(match.xpath, options, signal);
      const recovered = matches[0];
      if (
        matches.length !== 1 ||
        !recovered ||
        JSON.stringify(recovered.ref) !== JSON.stringify(match.ref)
      ) {
        throw new XmlError(
          'ERR_XML_COPY_NODE_TYPE',
          'Matched node no longer identifies the same source value',
        );
      }
      return await this.request(
        'readValue',
        { ref: recovered.ref, maxBytes: limit },
        signal,
        positiveInteger(options.queryTimeoutMs, 10_000, 'queryTimeoutMs'),
      );
    }, options.signal);
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.session.signal.removeEventListener('abort', this.onAbort);
      this.closing = this.stop(new XmlError('ERR_XML_CLOSED', 'XML document is closed'));
    }
    return this.closing;
  }
}
