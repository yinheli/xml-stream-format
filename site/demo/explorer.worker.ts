import fuzzysort from 'fuzzysort';
import { ingest } from '../../src/core/ingest.js';
import { normalizeInput } from '../../src/core/input.js';
import type {
  CancelMessage,
  ExplorerRequests,
  ExplorerResults,
  LoadState,
  Move,
  Page,
  Progress,
  Request,
  Response,
  SearchHit,
  Stats,
  ViewCommand,
} from './protocol.js';
import { blobChunks, loadParser, wireError, yieldToEventLoop } from './runtime.js';
import { ELEMENT, IndexLimitError, NodeStore } from './store.js';
import { EDGE, FoldedRows, NEED } from './view.js';

const MAX_INDEX_BYTES = 768 * 1024 * 1024;
const MAX_HITS = 200;

const post = (message: Response) => postMessage(message);

/** One opened file: demand-driven parsing into the index plus the folded viewport. */
class Session {
  readonly store = new NodeStore(MAX_INDEX_BYTES);
  readonly rows = new FoldedRows(this.store);
  state: LoadState = 'loading';
  message?: string;
  bytes = 0;
  private loadAll = false;
  private demand = 0;
  private wake?: () => void;
  private waiters: (() => void)[] = [];
  private readonly started = performance.now();
  private finished?: number;
  private lastProgress = 0;
  closed = false;

  // Viewport state, in row positions (see FoldedRows).
  top = 0;
  cursor = 0;
  height = 20;
  page: number[] = [];
  cancelled = false;

  constructor(readonly file: File) {}

  get final(): boolean {
    return this.state === 'ready' || this.state === 'error' || this.state === 'limit';
  }

  async run(): Promise<void> {
    try {
      await loadParser();
      const source = normalizeInput(
        blobChunks(this.file, () => this.gate()),
        { onSourceBytes: (bytes) => (this.bytes += bytes) },
      );
      await ingest(source, this.store);
      this.state = 'ready';
    } catch (cause) {
      if (this.closed) return;
      this.state = cause instanceof IndexLimitError ? 'limit' : 'error';
      this.message = wireError(cause).message;
    } finally {
      this.finished = performance.now();
      this.rows.final = true;
      this.release();
      if (!this.closed) this.progress(true);
    }
  }

  /** Called before each chunk read: everything earlier has been indexed. */
  private async gate(): Promise<void> {
    if (this.closed) throw new DOMException('File closed', 'AbortError');
    this.release();
    this.progress(false);
    // Let resumed waiters decide whether they still need input before reading more.
    await yieldToEventLoop();
    while (!this.loadAll && this.demand === 0 && !this.closed) {
      this.state = 'paused';
      this.progress(true);
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
    if (this.closed) throw new DOMException('File closed', 'AbortError');
    this.state = 'loading';
  }

  private release(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  close(): void {
    this.closed = true;
    this.cancelled = true;
    this.wake?.();
    this.release();
  }

  startLoadAll(): void {
    this.loadAll = true;
    this.wake?.();
  }

  cancel(): void {
    this.cancelled = true;
    this.release();
  }

  /** Retries `attempt` as parsing advances; resolves undefined at EOF or on cancel. */
  async need<T>(attempt: () => T | undefined): Promise<T | undefined> {
    for (;;) {
      const value = attempt();
      if (value !== undefined || this.final || this.cancelled) return value;
      this.demand++;
      this.wake?.();
      try {
        await new Promise<void>((resolve) => this.waiters.push(resolve));
      } finally {
        this.demand--;
      }
    }
  }

  progress(force: boolean): void {
    const now = performance.now();
    if (!force && now - this.lastProgress < 120) return;
    this.lastProgress = now;
    const progress: Progress = {
      state: this.state,
      bytes: this.bytes,
      total: this.file.size,
      nodes: this.store.count,
      elements: this.store.elementCount,
      indexBytes: this.store.indexBytes,
      elapsed: (this.finished ?? now) - this.started,
    };
    if (this.message) progress.message = this.message;
    post({ type: 'progress', progress });
  }

  // --- navigation ---------------------------------------------------------

  private async step(position: number, forward: boolean): Promise<number> {
    if (!forward) {
      const previous = this.rows.previous(position);
      return previous === EDGE ? position : previous;
    }
    const next = await this.need(() => {
      const value = this.rows.next(position);
      return value === NEED ? undefined : value;
    });
    return next === undefined || next === EDGE ? position : next;
  }

  private async walk(position: number, count: number, forward: boolean): Promise<number> {
    for (let i = 0; i < count && !this.cancelled; i++) {
      const next = await this.step(position, forward);
      if (next === position) break;
      position = next;
    }
    return position;
  }

  private back(position: number, count: number): number {
    for (let i = 0; i < count; i++) {
      const previous = this.rows.previous(position);
      if (previous === EDGE) break;
      position = previous;
    }
    return position;
  }

  /** Keep the cursor inside the viewport by moving the top edge only. */
  private reveal(margin = 0): void {
    const { rows } = this;
    if (rows.order(this.cursor) < rows.order(this.top)) {
      this.top = this.back(this.cursor, margin);
      return;
    }
    let position = this.top;
    for (let i = 0; i < this.height; i++) {
      if (position === this.cursor) return;
      const next = rows.next(position);
      if (next < 0) break;
      position = next;
    }
    this.top = this.back(this.cursor, Math.max(margin, this.height - 1));
  }

  private async move(move: Move): Promise<void> {
    const { rows, store } = this;
    const node = this.cursor >> 1;
    const half = Math.max(1, Math.floor(this.height / 2));
    switch (move) {
      case 'down':
        this.cursor = await this.step(this.cursor, true);
        break;
      case 'up':
        this.cursor = await this.step(this.cursor, false);
        break;
      case 'pageDown':
      case 'halfDown': {
        const distance = move === 'pageDown' ? Math.max(1, this.height - 1) : half;
        const before = this.cursor;
        this.cursor = await this.walk(this.cursor, distance, true);
        let moved = 0;
        for (let p = before; p !== this.cursor && moved < distance; moved++) p = rows.next(p);
        this.top = await this.walk(this.top, moved, true);
        break;
      }
      case 'pageUp':
      case 'halfUp': {
        const distance = move === 'pageUp' ? Math.max(1, this.height - 1) : half;
        this.cursor = this.back(this.cursor, distance);
        this.top = this.back(this.top, distance);
        break;
      }
      case 'home':
        this.top = this.cursor = 0;
        break;
      case 'end': {
        const last = rows.frontier();
        if (last >= 0) {
          this.cursor = last;
          this.top = this.back(last, this.height - 1);
        }
        break;
      }
      case 'left':
        if (rows.isOpen(node)) {
          rows.setExpanded(node, false);
          this.cursor = node * 2;
        } else if (store.parent[node]! >= 0) this.cursor = store.parent[node]! * 2;
        break;
      case 'right':
        if (this.cursor & 1) break;
        if (rows.isContainer(node) && !rows.expanded(node)) rows.setExpanded(node, true);
        else if (rows.isOpen(node)) this.cursor = await this.step(this.cursor, true);
        break;
      case 'toggle':
        if (rows.isContainer(node)) {
          rows.setExpanded(node, !rows.expanded(node));
          this.cursor = node * 2;
        }
        break;
      case 'nextSibling':
      case 'previousSibling': {
        const sibling = await this.sibling(node, move === 'nextSibling');
        if (sibling >= 0) this.cursor = sibling * 2;
        break;
      }
    }
    this.reveal();
  }

  /** `[`/`]`: nearest element sibling, scanning forward through unfinished branches. */
  private async sibling(node: number, forward: boolean): Promise<number> {
    const { store } = this;
    const parent = store.parent[node]!;
    if (!forward) {
      let found = -1;
      for (let s = parent + 1; s < node; s = store.following(s))
        if (store.kind[s] === ELEMENT) found = s;
      return found;
    }
    let candidate = node;
    for (;;) {
      const current = candidate;
      const next = await this.need(() => {
        if (store.kind[current] === ELEMENT && !store.end[current]) return undefined;
        const following = store.following(current);
        if (following < store.count) return store.parent[following] === parent ? following : -1;
        return parent >= 0 && store.end[parent] ? -1 : undefined;
      });
      if (next === undefined || next < 0) return -1;
      if (store.kind[next] === ELEMENT) return next;
      candidate = next;
    }
  }

  private async revealNode(node: number): Promise<void> {
    const { rows, store } = this;
    let target = node;
    // Text inside an inline leaf is shown on the leaf's row.
    const parent = store.parent[target]!;
    if (store.kind[target] !== ELEMENT && parent >= 0 && !rows.isContainer(parent)) target = parent;
    for (let a = store.parent[target]!; a >= 0; a = store.parent[a]!)
      if (!rows.expanded(a)) rows.setExpanded(a, true);
    this.cursor = target * 2;
    this.top = this.back(this.cursor, Math.floor(this.height / 3));
  }

  async command(command: ViewCommand): Promise<Page> {
    this.cancelled = false;
    const { rows, store } = this;
    if (!store.count) await this.need(() => (store.count ? true : undefined));
    switch (command.type) {
      case 'resize':
        this.height = Math.max(1, Math.min(500, Math.floor(command.rows)));
        this.reveal();
        break;
      case 'move':
        await this.move(command.move);
        break;
      case 'scroll': {
        const forward = command.delta > 0;
        const count = Math.abs(command.delta);
        this.top = forward ? await this.walk(this.top, count, true) : this.back(this.top, count);
        if (rows.order(this.cursor) < rows.order(this.top)) this.cursor = this.top;
        else {
          const bottom = await this.walk(this.top, this.height - 1, true);
          if (rows.order(this.cursor) > rows.order(bottom)) this.cursor = bottom;
        }
        break;
      }
      case 'select': {
        const position = this.page[command.row];
        if (position !== undefined) this.cursor = position;
        break;
      }
      case 'fold':
        if (rows.isContainer(command.node)) {
          rows.setExpanded(command.node, !rows.expanded(command.node));
          this.cursor = command.node * 2;
          this.top = rows.visible(this.top);
          this.reveal();
        }
        break;
      case 'level':
        rows.level = command.level;
        rows.overrides.clear();
        this.cursor = rows.visible(this.cursor);
        this.top = rows.visible(this.top);
        this.reveal();
        break;
      case 'reveal':
        await this.revealNode(command.node);
        break;
      case 'revealElement': {
        const node = await this.need(() =>
          command.ordinal <= store.elementCount ? store.elements[command.ordinal - 1] : undefined,
        );
        if (node !== undefined) await this.revealNode(node);
        break;
      }
      case 'refresh':
        break;
    }
    return this.fill();
  }

  /** Fill the viewport; an under-filled viewport is the only thing that resumes input. */
  private async fill(): Promise<Page> {
    const { rows } = this;
    const result: Page = { rows: [], cursor: -1, path: '/', stale: false };
    this.page = [];
    if (!this.store.count) return result;
    let position = this.top;
    for (;;) {
      this.page.push(position);
      result.rows.push(rows.render(position));
      const node = position >> 1;
      if (this.store.kind[node] === ELEMENT && !this.store.end[node]) result.stale = true;
      if (result.rows.length >= this.height) break;
      // Like the terminal browser, never scan a folded branch just to fill blank rows.
      if (rows.blocksFill(position)) {
        result.stale = true;
        break;
      }
      const next = await this.need(() => {
        const value = rows.next(position);
        return value === NEED ? undefined : value;
      });
      if (next === undefined || next === EDGE) {
        if (!this.final) result.stale = true;
        break;
      }
      position = next;
    }
    result.cursor = this.page.indexOf(this.cursor);
    result.path = rows.path(this.cursor >> 1, false);
    return result;
  }

  // --- panels ---------------------------------------------------------------

  search(query: string): SearchHit[] {
    const { store } = this;
    if (!query.trim()) return [];
    const ranked = fuzzysort.go(query.trim(), store.names, {
      keys: ['qname', 'local'],
      limit: MAX_HITS,
      threshold: 0,
    });
    const rank = new Int32Array(store.names.length).fill(-1);
    ranked.forEach((result, index) => {
      rank[result.obj.id] = index;
    });
    const buckets: number[][] = ranked.map(() => []);
    for (let i = 0; i < store.elementCount; i++) {
      const node = store.elements[i]!;
      const r = rank[store.name[node]!]!;
      if (r >= 0 && buckets[r]!.length < MAX_HITS) buckets[r]!.push(node);
    }
    const hits: SearchHit[] = [];
    for (const bucket of buckets) {
      for (const node of bucket) {
        if (hits.length === MAX_HITS) return hits;
        hits.push({
          node,
          label: store.qname(node),
          detail: `<${store.qname(node)}${store.preview(node).slice(0, 160)}>`,
        });
      }
    }
    return hits;
  }

  stats(): Stats {
    const { store } = this;
    const names = [...store.names]
      .sort((a, b) => b.count - a.count)
      .slice(0, 20)
      .map((name) => ({ name: name.qname, ns: name.ns, count: name.count }));
    return {
      elements: store.elementCount,
      nodes: store.count,
      distinctNames: store.names.length,
      maxDepth: store.maxDepth,
      attributes: store.attributes,
      textChars: store.textChars,
      comments: store.comments,
      instructions: store.instructions,
      cdataSections: store.cdataSections,
      names,
    };
  }

  selection(): ExplorerResults['selection'] {
    const { store, rows } = this;
    if (!store.count) return null;
    const owner = rows.owner(this.cursor >> 1);
    if (owner < 0) return null;
    return {
      path: rows.path(owner, false),
      xpath: rows.path(owner, true),
      ordinal: store.ordinalOf(owner) + 1,
      root: store.parent[owner] === -1,
      closed: store.end[owner] !== 0,
    };
  }
}

let session: Session | undefined;

async function handle(request: Request<ExplorerRequests>): Promise<unknown> {
  if (request.type === 'open') {
    session?.close();
    session = new Session(request.file);
    session.height = request.rows;
    void session.run();
    return null;
  }
  if (!session) throw new Error('No file is open');
  switch (request.type) {
    case 'view':
      return session.command(request.command);
    case 'loadAll':
      session.startLoadAll();
      return null;
    case 'search':
      return session.search(request.query);
    case 'stats':
      return session.stats();
    case 'selection':
      return session.selection();
  }
}

self.onmessage = async (event: MessageEvent<Request<ExplorerRequests> | CancelMessage>) => {
  const request = event.data;
  if (request.type === 'cancel') {
    session?.cancel();
    return;
  }
  try {
    post({ id: request.id, ok: true, value: await handle(request) });
  } catch (cause) {
    post({ id: request.id, ok: false, error: wireError(cause) });
  }
};
