import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { clearTimeout, setTimeout } from 'node:timers';
import { Worker } from 'node:worker_threads';
import { abortable, checkAbort, positiveInteger, XmlError } from '../core/errors.js';
import type { ReplayOptions } from '../core/format.js';
import { replayTape } from '../core/format.js';
import { normalizeInput } from '../core/input.js';
import type { FormatOptions } from '../core/options.js';
import { Workspace } from '../core/workspace.js';
import type { DocumentRequests, DocumentResults, Progress, WorkerResponse } from './protocol.js';
import type {
  CopyOptions,
  DetailPage,
  DetailRequest,
  OpenOptions,
  TreePage,
  TreeRequest,
  XmlPage,
  XmlRequest,
} from './types.js';

interface Pending {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
}
export interface SessionViewOptions {
  preview?: boolean;
  onProgress?: (progress: Progress) => void;
}
type FoldCommand =
  | { type: 'expand'; payload: DocumentRequests['expand'] }
  | { type: 'reveal'; payload: DocumentRequests['reveal'] };
type TreeCommand = { type: 'treeRows'; payload: TreeRequest } | FoldCommand;
type XmlCommand = { type: 'xmlRows'; payload: XmlRequest; waiting: boolean } | FoldCommand;
function relativeXmlRequest(request: XmlRequest): boolean {
  if (request.selectedId !== undefined || request.selectKey !== undefined) return false;
  return (
    request.scroll !== undefined ||
    (request.move !== undefined &&
      request.move !== 'first' &&
      request.move !== 'last' &&
      request.move !== 'left' &&
      request.move !== 'right' &&
      request.move !== 'toggle')
  );
}
const VIEWPORT_BYTES = 256 * 1024;
/** A demand may wait out one in-flight batch ingestion; the worker, not the UI, blocks. */
const VIEWPORT_MS = 250;
// normalizeInput yields at most 64 KiB; pull may also append one EOF probe.
const MAX_PULL_BYTES = 2 * 65_536;

/** Parent owns the workspace and workers; neither parser nor index blocks its event loop. */
export class DocumentSession {
  readonly id = randomUUID();
  sourceBytes = 0;
  readonly signal: AbortSignal;
  private readonly validation = Promise.withResolvers<void>();
  readonly ready = this.validation.promise;
  complete = false;
  tapePath = '';
  private readonly worker: Worker;
  private readonly controller = new AbortController();
  private readonly pending = new Map<number, Pending>();
  private readonly copies = new Set<Promise<string>>();
  private readonly replays = new Set<AsyncGenerator<string>>();
  private requestId = 0;
  private closing?: Promise<void>;
  private pages = 0;
  private pageWaiters: (() => void)[] = [];
  private treeTail: Promise<void> = Promise.resolve();
  private readonly lifecycleAbort: () => void;
  private input?: AsyncIterator<Uint8Array>;
  private pulling?: Promise<number>;
  private failed = false;
  private failure: unknown;
  private fullReaders = 0;
  private viewportReaders = 0;
  private nodes = 0;
  private lastTreeLimit = 50;
  private readonly xmlCommands: XmlCommand[] = [];
  private xmlGeneration = 0;
  private readonly treeCommands: TreeCommand[] = [];
  private reported?: Progress;
  private readonly onProgress?: (progress: Progress) => void;

  constructor(
    private readonly workspace: Workspace,
    private readonly options: OpenOptions,
    view: SessionViewOptions,
  ) {
    this.onProgress = view.onProgress;
    void this.ready.catch(() => {});
    this.signal = options.signal
      ? AbortSignal.any([options.signal, this.controller.signal])
      : this.controller.signal;
    this.worker = new Worker(new URL('./document-worker.js', import.meta.url), {
      execArgv: [],
      stderr: !!view.onProgress,
    });
    if (view.onProgress) {
      const decoder = new StringDecoder('utf8');
      let diagnostics = '';
      let truncated = false;
      this.worker.stderr.on('data', (chunk: Buffer) => {
        const text = decoder.write(chunk);
        const remaining = Math.max(0, 4096 - diagnostics.length);
        diagnostics += text.slice(0, remaining);
        truncated ||= text.length > remaining;
        if (!this.closing && diagnostics)
          this.onProgress?.({
            ...(this.reported ?? {
              stage: 'input',
              sourceBytes: this.sourceBytes,
              nodes: this.nodes,
            }),
            diagnostic:
              diagnostics.replace(/\r?\n/g, ' · ') + (truncated ? ' [diagnostic truncated]' : ''),
          });
      });
    }
    this.lifecycleAbort = () => {
      void this.close();
    };
    options.signal?.addEventListener('abort', this.lifecycleAbort, { once: true });
    this.worker.on('message', (message: WorkerResponse) => {
      if (!message || message.sessionId !== this.id || this.closing) return;
      if (message.type === 'progress') {
        this.nodes = message.value.nodes;
        this.report(message.value.stage);
        return;
      }
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
    this.worker.on('error', (cause) => {
      this.fail(cause);
      for (const pending of this.pending.values()) pending.reject(cause);
      this.pending.clear();
      void this.close();
    });
    this.worker.on('exit', (code) => {
      if (this.closing) return;
      const error = new XmlError('ERR_XML_WORKER', `Document worker exited unexpectedly (${code})`);
      this.fail(error);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      void this.close();
    });
  }

  get closed(): boolean {
    return this.closing !== undefined;
  }
  get paused(): boolean {
    return this.reported?.stage === 'paused';
  }

  private report(stage: Progress['stage']): void {
    if (this.closing) return;
    const value: Progress = { stage, sourceBytes: this.sourceBytes, nodes: this.nodes };
    if (
      this.reported?.stage === stage &&
      this.reported.sourceBytes === value.sourceBytes &&
      this.reported.nodes === value.nodes
    )
      return;
    this.reported = value;
    this.onProgress?.(value);
  }

  private pauseIfIdle(): void {
    if (!this.complete && !this.failed && this.fullReaders === 0 && this.viewportReaders === 0)
      this.report('paused');
  }

  private fail(error: unknown): void {
    if (this.failed || this.complete) return;
    this.failed = true;
    this.failure = error;
    this.validation.reject(error);
  }

  assertOpen(): void {
    if (this.closing) throw new XmlError('ERR_XML_CLOSED', 'XML document is closed');
    checkAbort(this.signal);
  }

  async load(view: SessionViewOptions): Promise<void> {
    const { signal: _signal, ...options } = this.options;
    const result = await this.request('load', {
      workspaceDirectory: this.workspace.directory,
      options,
      preview: view.preview ?? false,
    });
    this.tapePath = result.tapePath;
  }

  start(source: AsyncIterable<Uint8Array | string>): void {
    this.input = normalizeInput(source, {
      signal: this.signal,
      maxTokenCodeUnits: this.options.maxTokenCodeUnits,
      onSourceBytes: (bytes) => {
        this.sourceBytes += bytes;
        if (!Number.isSafeInteger(this.sourceBytes))
          throw new XmlError('ERR_XML_LIMIT', 'Source byte count exceeds safe integer range');
      },
    })[Symbol.asyncIterator]();
    // Bootstrap is bounded; subsequent reads require a viewport or full-load intent.
    void this.pull().catch(() => {});
  }

  private pull(): Promise<number> {
    this.assertOpen();
    if (this.complete) return Promise.resolve(0);
    if (this.failed) return Promise.reject(this.failure);
    this.report('parse');
    if (this.pulling) return this.pulling;
    const operation = (async () => {
      let bytes = 0;
      let probed = false;
      for (;;) {
        const next = await abortable(this.input!.next(), this.signal);
        if (next.done) {
          await this.sendRequest('finish', { sourceBytes: this.sourceBytes });
          this.complete = true;
          this.validation.resolve();
          this.report('ready');
          return bytes;
        }
        bytes += next.value.byteLength;
        const result = await this.sendRequest('append', {
          chunk: next.value,
          sourceBytes: this.sourceBytes,
        });
        this.nodes = result.totalElements;
        // One EOF probe lets small complete files finish without draining long tails.
        if (result.rootClosed && !probed) {
          probed = true;
          continue;
        }
        return bytes;
      }
    })();
    this.pulling = operation
      .catch((error) => {
        this.fail(error);
        throw error;
      })
      .finally(() => {
        this.pulling = undefined;
        this.pauseIfIdle();
      });
    return this.pulling;
  }

  private async readBefore(deadline: number, remainingBytes: number): Promise<number | undefined> {
    const remaining = deadline - performance.now();
    if (remaining <= 0 || remainingBytes < MAX_PULL_BYTES) return undefined;
    const timeout = Promise.withResolvers<undefined>();
    const timer = setTimeout(() => timeout.resolve(undefined), remaining);
    try {
      return await Promise.race([this.pull(), timeout.promise]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Explicit global operations consume the rest; cancellation releases only this intent. */
  async ensureComplete(signal?: AbortSignal, maxSourceBytes?: number): Promise<void> {
    this.assertOpen();
    const combined = signal ? AbortSignal.any([signal, this.signal]) : this.signal;
    checkAbort(combined);
    const checkBudget = (): void => {
      if (maxSourceBytes !== undefined && this.sourceBytes > maxSourceBytes)
        throw new XmlError(
          'ERR_XPATH_LIMIT',
          `Source has ${this.sourceBytes} bytes, exceeding maxSourceBytes=${maxSourceBytes}; increase the explicit XPath source budget`,
        );
    };
    checkBudget();
    if (this.complete) return;
    this.fullReaders++;
    try {
      while (!this.complete) {
        if (this.failed) throw this.failure;
        checkAbort(combined);
        await abortable(this.pull(), combined);
        checkBudget();
      }
      await abortable(this.ready, combined);
    } finally {
      this.fullReaders--;
      this.pauseIfIdle();
    }
  }

  private async treePage(payload: TreeRequest): Promise<TreePage> {
    this.lastTreeLimit = payload.limit ?? this.lastTreeLimit;
    if (payload.move === 'first' || payload.move === 'last') {
      let kept = 0;
      for (const command of this.treeCommands)
        if (command.type !== 'treeRows') this.treeCommands[kept++] = command;
      this.treeCommands.length = kept;
    }
    if (
      payload.move !== undefined ||
      payload.selectedId !== undefined ||
      payload.firstId !== undefined
    )
      this.treeCommands.push({ type: 'treeRows', payload });
    const snapshot: TreeRequest = { limit: this.lastTreeLimit, loadMore: false };
    const canRead = payload.loadMore !== false && payload.move !== 'first';
    if (canRead) this.viewportReaders++;
    const deadline = performance.now() + VIEWPORT_MS;
    let bytes = 0;
    try {
      for (;;) {
        const command = this.treeCommands[0];
        if (command?.type === 'expand' || command?.type === 'reveal') {
          await this.sendRequest(command.type, command.payload);
          this.treeCommands.shift();
          continue;
        }
        const page = await this.sendRequest('treeRows', command?.payload ?? snapshot);
        if (command) {
          if (page.continuation) command.payload = page.continuation;
          else this.treeCommands.shift();
        }
        if (!page.continuation && this.treeCommands.length) continue;
        if (!page.needsMore || !canRead || this.complete || this.failed || bytes >= VIEWPORT_BYTES)
          return page;
        const read = await this.readBefore(deadline, VIEWPORT_BYTES - bytes);
        if (read === undefined) return page;
        bytes += read;
      }
    } finally {
      if (canRead) this.viewportReaders--;
      this.pauseIfIdle();
    }
  }

  private async detailPage(payload: DetailRequest): Promise<DetailPage> {
    const canRead = payload.loadMore !== false;
    if (canRead) this.viewportReaders++;
    const deadline = performance.now() + VIEWPORT_MS;
    let bytes = 0;
    try {
      for (;;) {
        const page = await this.sendRequest('detailRows', payload);
        if (!page.needsMore || !canRead || this.complete || this.failed || bytes >= VIEWPORT_BYTES)
          return page;
        const read = await this.readBefore(deadline, VIEWPORT_BYTES - bytes);
        if (read === undefined) return page;
        bytes += read;
      }
    } finally {
      if (canRead) this.viewportReaders--;
      this.pauseIfIdle();
    }
  }

  private discardXmlNavigation(): void {
    let kept = 0;
    for (const command of this.xmlCommands) {
      if (command.type !== 'xmlRows' || (!command.waiting && !relativeXmlRequest(command.payload)))
        this.xmlCommands[kept++] = command;
    }
    this.xmlCommands.length = kept;
  }

  private async xmlPage(payload: XmlRequest, generation = this.xmlGeneration): Promise<XmlPage> {
    if (payload.move === 'left' || payload.move === 'right' || payload.move === 'toggle')
      this.discardXmlNavigation();
    if (
      payload.move !== undefined ||
      payload.scroll !== undefined ||
      payload.selectedId !== undefined ||
      payload.selectKey !== undefined
    ) {
      this.xmlCommands.push({ type: 'xmlRows', payload, waiting: false });
    }
    const snapshot: XmlRequest = {
      limit: payload.limit,
      columns: payload.columns,
      column: payload.column,
      loadMore: false,
    };
    const canRead =
      generation === this.xmlGeneration &&
      payload.loadMore !== false &&
      payload.move !== 'first' &&
      payload.move !== 'last';
    if (canRead) this.viewportReaders++;
    // Navigation turns must feel immediate: they read briefly and yield. Fill-only
    // turns (no move/scroll) own the longer budget while the user is not interacting.
    const deadline =
      performance.now() +
      (payload.move !== undefined || payload.scroll !== undefined ? 50 : VIEWPORT_MS);
    let bytes = 0;
    try {
      for (;;) {
        const command = this.xmlCommands[0];
        if (command?.type === 'expand' || command?.type === 'reveal') {
          await this.sendRequest(command.type, command.payload);
          this.xmlCommands.shift();
          continue;
        }
        const page = await this.sendRequest(
          'xmlRows',
          command ? { ...command.payload, ...snapshot } : snapshot,
        );
        if (command && this.xmlCommands[0] === command) {
          if (page.continuation && generation === this.xmlGeneration) {
            command.payload = page.continuation;
            command.waiting = true;
          } else this.xmlCommands.shift();
        }
        if (generation !== this.xmlGeneration) return page;
        if (!page.continuation && this.xmlCommands.length) continue;
        if (!page.needsMore || !canRead || this.complete || this.failed || bytes >= VIEWPORT_BYTES)
          return page;
        // The rendered page cannot improve while nothing arrives: read up to the
        // budget or deadline first, then render once with the new data. Freshly
        // queued navigation preempts the wait so keystrokes never queue behind it.
        const queued = this.xmlCommands.length;
        let readBytes = 0;
        while (bytes + readBytes < VIEWPORT_BYTES && this.xmlCommands.length <= queued) {
          const read = await this.readBefore(deadline, VIEWPORT_BYTES - bytes - readBytes);
          if (read === undefined) break;
          readBytes += read;
        }
        bytes += readBytes;
        if (!readBytes) return page;
      }
    } finally {
      if (canRead) this.viewportReaders--;
      // Unfinished relative demand belongs to the turn that requested it: a refill the
      // budget cut short never chases the frontier on later turns, so the newest
      // navigation always applies to the view it sees.
      let kept = 0;
      for (const queued of this.xmlCommands)
        if (queued.type !== 'xmlRows' || !queued.waiting) this.xmlCommands[kept++] = queued;
      this.xmlCommands.length = kept;
      this.pauseIfIdle();
    }
  }

  async request<K extends keyof DocumentRequests>(
    type: K,
    payload: DocumentRequests[K],
  ): Promise<DocumentResults[K]> {
    this.assertOpen();
    const xml = type === 'xmlRows' ? (payload as XmlRequest) : undefined;
    if (
      xml &&
      (xml.move === 'first' ||
        xml.move === 'last' ||
        xml.selectedId !== undefined ||
        xml.selectKey !== undefined)
    ) {
      this.xmlGeneration++;
      this.discardXmlNavigation();
    }
    const generation = this.xmlGeneration;
    if (type === 'xmlRows' || type === 'treeRows' || type === 'expand' || type === 'reveal') {
      const result = this.treeTail.then(async () => {
        if (xml) {
          if (generation !== this.xmlGeneration && relativeXmlRequest(xml)) {
            return this.sendRequest('xmlRows', {
              limit: xml.limit,
              columns: xml.columns,
              column: xml.column,
              loadMore: false,
            });
          }
          return this.xmlPage(xml, generation);
        }
        if (type === 'treeRows') return this.treePage(payload as TreeRequest);
        const command: FoldCommand =
          type === 'expand'
            ? { type, payload: payload as DocumentRequests['expand'] }
            : { type: 'reveal', payload: payload as DocumentRequests['reveal'] };
        if (this.treeCommands.length) {
          this.treeCommands.push(command);
          await this.treePage({ limit: this.lastTreeLimit, loadMore: false });
        } else if (this.xmlCommands.length) {
          this.xmlCommands.push(command);
          await this.xmlPage({ loadMore: false });
        } else await this.sendRequest(command.type, command.payload);
        return null;
      });
      this.treeTail = result.then(
        () => {},
        () => {},
      );
      return (await abortable(result, this.signal)) as DocumentResults[K];
    }
    if (type === 'detailRows')
      return (await this.detailPage(payload as DetailRequest)) as DocumentResults[K];
    return this.sendRequest(type, payload);
  }

  private async sendRequest<K extends keyof DocumentRequests>(
    type: K,
    payload: DocumentRequests[K],
  ): Promise<DocumentResults[K]> {
    this.assertOpen();
    const paged = type === 'xmlRows' || type === 'treeRows' || type === 'detailRows';
    if (paged) {
      if (this.pages >= 2)
        await abortable(
          new Promise<void>((resolve) => this.pageWaiters.push(resolve)),
          this.signal,
        );
      else this.pages++;
      this.assertOpen();
    }
    try {
      const requestId = ++this.requestId;
      const result = new Promise<unknown>((resolve, reject) => {
        this.pending.set(requestId, { resolve, reject });
        try {
          this.worker.postMessage({ sessionId: this.id, requestId, type, payload });
        } catch (cause) {
          this.pending.delete(requestId);
          reject(cause);
        }
      });
      // The paired worker emits the result type selected by this request key.
      return (await abortable(result, this.signal)) as DocumentResults[K];
    } finally {
      if (paged) {
        const nextPage = this.pageWaiters.shift();
        if (nextPage) nextPage();
        else this.pages--;
      }
    }
  }

  async *extractElements(
    elementIds: readonly number[],
    options: Pick<FormatOptions, 'indent' | 'whitespace' | 'signal'> = {},
  ): AsyncGenerator<string> {
    this.assertOpen();
    const signal = options.signal ? AbortSignal.any([this.signal, options.signal]) : this.signal;
    await this.ensureComplete(signal);
    for (const elementId of elementIds) {
      checkAbort(signal);
      const ranges = await this.request('elementRanges', { elementIds: [elementId] });
      const range = ranges[0]!;
      yield* this.replay({
        ...options,
        signal,
        start: range.start,
        end: range.end,
        root: range.root,
      });
    }
  }

  async *extractDocument(
    options: Pick<FormatOptions, 'indent' | 'whitespace' | 'signal'> = {},
  ): AsyncGenerator<string> {
    this.assertOpen();
    const signal = options.signal ? AbortSignal.any([this.signal, options.signal]) : this.signal;
    await this.ensureComplete(signal);
    yield* this.replay({ ...options, signal });
  }

  private async *replay(options: ReplayOptions): AsyncGenerator<string> {
    this.assertOpen();
    const iterator = replayTape(this.tapePath, options);
    this.replays.add(iterator);
    try {
      yield* iterator;
    } finally {
      this.replays.delete(iterator);
    }
  }

  /** Copies one closed, bounded element without resuming input or building a DOM. */
  copyElement(elementId: number, options: CopyOptions): Promise<string> {
    const pending = this.copyElementText(elementId, options);
    this.copies.add(pending);
    const settled = (): void => {
      this.copies.delete(pending);
    };
    void pending.then(settled, settled);
    return pending;
  }

  private async copyElementText(elementId: number, options: CopyOptions): Promise<string> {
    this.assertOpen();
    const signal = options.signal ? AbortSignal.any([this.signal, options.signal]) : this.signal;
    checkAbort(signal);
    if (elementId === 0 || elementId === 1)
      throw new XmlError(
        'ERR_XML_COPY_ROOT',
        'Root/document XML copy is unsupported. Select a smaller element; nothing was copied.',
      );
    const maxBytes = Math.min(positiveInteger(options.maxBytes, 0, 'maxBytes'), 1_048_576);
    const range = await abortable(this.request('copyRef', { elementId, maxBytes }), signal);
    const parts: string[] = [];
    let bytes = 0;
    for await (const chunk of replayTape(this.tapePath, {
      indent: options.indent,
      whitespace: options.whitespace ?? 'reindent',
      signal,
      start: range.start,
      end: range.end,
      root: range.root,
    })) {
      const size = Buffer.byteLength(chunk, 'utf8');
      if (size > maxBytes - bytes)
        throw new XmlError(
          'ERR_XML_COPY_LIMIT',
          `Formatted subtree exceeds the ${maxBytes.toLocaleString('en-US')}-byte copy limit. Copy is unsupported; nothing was copied.`,
        );
      parts.push(chunk);
      bytes += size;
    }
    checkAbort(signal);
    return parts.join('');
  }

  private async closeWorker(): Promise<void> {
    if (this.worker.threadId === -1) return;
    const requestId = ++this.requestId;
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        this.worker.removeListener('message', message);
        this.worker.removeListener('exit', exited);
        this.worker.removeListener('error', failed);
      };
      const exited = (): void => {
        cleanup();
        resolve();
      };
      const failed = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const message = (value: WorkerResponse): void => {
        if (
          value.sessionId !== this.id ||
          value.requestId !== requestId ||
          value.type === 'progress'
        )
          return;
        cleanup();
        if (value.type === 'error') reject(new XmlError(value.error.code, value.error.message));
        else resolve();
      };
      this.worker.on('message', message);
      this.worker.once('exit', exited);
      this.worker.once('error', failed);
      try {
        this.worker.postMessage({ sessionId: this.id, requestId, type: 'close', payload: {} });
      } catch (error) {
        failed(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    const error = new XmlError('ERR_XML_CLOSED', 'XML document is closed');
    this.fail(error);
    this.controller.abort(error);
    void Promise.resolve()
      .then(() => this.input?.return?.())
      .catch(() => {});
    this.options.signal?.removeEventListener('abort', this.lifecycleAbort);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.pageWaiters = [];
    const readers = [...this.replays].map((iterator) => iterator.return(undefined));
    this.closing = (async () => {
      try {
        await this.closeWorker();
      } finally {
        try {
          await this.worker.terminate();
        } finally {
          try {
            await Promise.allSettled([...this.copies, ...readers]);
          } finally {
            this.replays.clear();
            await this.workspace.close();
          }
        }
      }
    })();
    return this.closing;
  }
}

export async function createSession(
  source: AsyncIterable<Uint8Array | string>,
  options: OpenOptions = {},
  view: SessionViewOptions = {},
): Promise<DocumentSession> {
  positiveInteger(options.maxIndexBytes, 268_435_456, 'maxIndexBytes');
  checkAbort(options.signal);
  const workspace = await Workspace.create(options.tempDirectory);
  let session: DocumentSession | undefined;
  try {
    session = new DocumentSession(workspace, options, view);
    await session.load(view);
    session.start(source);
    return session;
  } catch (cause) {
    if (session) await session.close();
    else await workspace.close();
    throw cause;
  }
}
