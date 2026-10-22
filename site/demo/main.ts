import { highlightXml } from '../../src/tui/text.js';
import type {
  ExplorerRequests,
  ExplorerResults,
  FormatSettings,
  JobRequests,
  JobResults,
  Move,
  Page,
  Progress,
  Response,
  Selection,
  ViewCommand,
} from './protocol.js';
import { sampleFile } from './sample.js';

const ROW_HEIGHT = 20;
const SAMPLE_MB = 96;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const viewport = $<HTMLDivElement>('viewport');
const rowsElement = $<HTMLDivElement>('rows');
const intro = $<HTMLDivElement>('intro');
const statusElement = $<HTMLDivElement>('status');
const pathElement = $<HTMLDivElement>('path');
const panel = $<HTMLElement>('panel');
const prompt = $<HTMLFormElement>('prompt');
const promptLabel = $<HTMLSpanElement>('prompt-label');
const promptInput = $<HTMLInputElement>('prompt-input');
const promptNamespaces = $<HTMLInputElement>('prompt-ns');
const dialog = $<HTMLDialogElement>('dialog');
const toastElement = $<HTMLDivElement>('toast');
const fileInput = $<HTMLInputElement>('file');

class DemoError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type WorkerEvent = Exclude<Response, { ok: boolean }>;

function connect<Requests, Results>(worker: Worker, onEvent: (event: WorkerEvent) => void) {
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let next = 1;
  worker.onmessage = ({ data }: MessageEvent<Response>) => {
    if (!('ok' in data)) return onEvent(data);
    const entry = pending.get(data.id);
    pending.delete(data.id);
    if (data.ok) entry?.resolve(data.value);
    else entry?.reject(new DemoError(data.error.code, data.error.message));
  };
  worker.onerror = (event) => toast(`Worker failed: ${event.message}`, true);
  return {
    worker,
    pending,
    /** Resolves with the request id via `onId` so callers can correlate progress. */
    call<K extends keyof Requests & keyof Results>(
      type: K,
      payload: Requests[K],
      onId?: (id: number) => void,
    ): Promise<Results[K]> {
      const id = next++;
      onId?.(id);
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
        worker.postMessage({ id, type, ...payload });
      });
    },
  };
}

// Vite bundles workers only when `new Worker(new URL(...))` appears literally.
const explorer = connect<ExplorerRequests, ExplorerResults>(
  new Worker(new URL('./explorer.worker.ts', import.meta.url), { type: 'module' }),
  (event) => {
    if (event.type === 'progress') onProgress(event.progress);
  },
);

let jobProgress: ((phase: string, bytes: number, total: number) => void) | undefined;
function createJobs() {
  return connect<JobRequests, JobResults>(
    new Worker(new URL('./jobs.worker.ts', import.meta.url), { type: 'module' }),
    (event) => {
      if (event.type === 'jobProgress') jobProgress?.(event.phase, event.bytes, event.total);
    },
  );
}
let jobs = createJobs();

/** Jobs run to completion in their worker; cancelling replaces the worker. */
function cancelJobs(): void {
  jobs.worker.terminate();
  for (const entry of jobs.pending.values()) entry.reject(new DemoError('ABORT_ERR', 'Cancelled'));
  jobs = createJobs();
}

// --- state -------------------------------------------------------------------

let file: File | undefined;
let page: Page | undefined;
let progress: Progress | undefined;
let openedAt = 0;
let firstScreen: number | undefined;
type Hit = { label: string; detail: string; node?: number; ordinal?: number };
let results: { title: string; hits: Hit[]; index: number; total: number } | undefined;
let panelMode: 'results' | 'stats' | 'help' | undefined;
let focus: 'xml' | 'results' = 'xml';
let pendingG = false;
let wheelRemainder = 0;
const queue: ViewCommand[] = [];
let inflight = false;
let busyTimer: number | undefined;

// --- formatting helpers -------------------------------------------------------

const integer = new Intl.NumberFormat('en-US');
function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function toast(message: string, error = false): void {
  const item = element('div', error ? 'toast error' : 'toast', message);
  toastElement.append(item);
  setTimeout(() => item.remove(), error ? 6000 : 3000);
}

function failure(cause: unknown): void {
  if (cause instanceof DemoError && cause.code === 'ABORT_ERR') return;
  toast(cause instanceof Error ? cause.message : String(cause), true);
}

// --- viewport -------------------------------------------------------------------

function visibleRows(): number {
  return Math.max(1, Math.floor(viewport.clientHeight / ROW_HEIGHT));
}

function view(command: ViewCommand): void {
  if (!file) return;
  const last = queue.at(-1);
  if (command.type === 'scroll' && last?.type === 'scroll') last.delta += command.delta;
  else if (command.type === 'refresh' && (inflight || queue.length)) return;
  else queue.push(command);
  void pump();
}

async function pump(): Promise<void> {
  if (inflight) return;
  const command = queue.shift();
  if (!command) return;
  inflight = true;
  clearTimeout(busyTimer);
  busyTimer = window.setTimeout(() => document.body.classList.add('busy'), 200);
  try {
    page = await explorer.call('view', { command });
    if (firstScreen === undefined && page.rows.length) firstScreen = performance.now() - openedAt;
    renderPage();
  } catch (cause) {
    failure(cause);
  } finally {
    clearTimeout(busyTimer);
    document.body.classList.remove('busy');
    inflight = false;
    void pump();
  }
}

function cancelNavigation(): boolean {
  if (!inflight && !queue.length) return false;
  queue.length = 0;
  explorer.worker.postMessage({ type: 'cancel' });
  return true;
}

function renderPage(): void {
  if (!page) return;
  const fragment = document.createDocumentFragment();
  page.rows.forEach((row, index) => {
    const line = element('div', index === page!.cursor ? 'row cursor' : 'row');
    line.dataset.row = String(index);
    const gutter = element('span', 'gutter', row.fold === 'open' ? '▾' : row.fold ? '▸' : '');
    if (row.fold) gutter.dataset.node = String(row.node);
    const code = element('span', 'src');
    code.style.paddingLeft = `${row.depth * 2}ch`;
    for (const part of row.parts) {
      if (part.muted) {
        code.append(element('span', 'muted', part.text));
        continue;
      }
      for (const span of highlightXml(part.text)) {
        code.append(span.color ? element('span', `c-${span.color}`, span.text) : span.text);
      }
    }
    line.append(gutter, code);
    fragment.append(line);
  });
  rowsElement.replaceChildren(fragment);
  pathElement.textContent = page.path;
  renderStatus();
}

// --- status ----------------------------------------------------------------------

/** Short state, plus a detail that narrow screens hide. */
const STATE_LABEL: Record<Progress['state'], [string, string]> = {
  loading: ['loading', ''],
  paused: ['paused', ' · loaded prefix (not fully validated)'],
  ready: ['ready', ' · fully validated'],
  error: ['error', ''],
  limit: ['index budget reached', ''],
};

function onProgress(next: Progress): void {
  progress = next;
  renderStatus();
  if (page?.stale) view({ type: 'refresh' });
}

function renderStatus(): void {
  if (!file || !progress) return;
  const ratio = progress.total ? progress.bytes / progress.total : 1;
  statusElement.replaceChildren();
  const name = element('span', 'file', file.name);
  const [label, detail] = STATE_LABEL[progress.state];
  const state = element('span', `state ${progress.state}`, label);
  if (detail) state.append(element('span', 'state-detail', detail));
  const bar = element('span', 'meter');
  const fill = element('span', 'meter-fill');
  fill.style.width = `${(ratio * 100).toFixed(2)}%`;
  bar.append(fill);
  const facts = [
    `${bytes(progress.bytes)} / ${bytes(progress.total)} read`,
    `${integer.format(progress.elements)} elements`,
    `index ${bytes(progress.indexBytes)}`,
    `${(progress.elapsed / 1000).toFixed(2)} s`,
  ];
  if (firstScreen !== undefined) facts.push(`first screen ${(firstScreen / 1000).toFixed(2)} s`);
  statusElement.append(name, state, bar, element('span', 'facts', facts.join(' · ')));
  if (progress.state === 'loading' || progress.state === 'paused') {
    const all = element('button', 'small', 'Load all');
    all.title = 'Index and validate the whole file (search and stats then cover everything)';
    all.onclick = () => void explorer.call('loadAll', {}).catch(failure);
    statusElement.append(all);
  }
  if (progress.message) statusElement.append(element('span', 'error-text', progress.message));
}

// --- opening files ----------------------------------------------------------------

async function open(next: File): Promise<void> {
  file = next;
  page = undefined;
  progress = undefined;
  results = undefined;
  firstScreen = undefined;
  queue.length = 0;
  closePanel();
  intro.hidden = true;
  document.body.classList.remove('empty');
  rowsElement.replaceChildren();
  document.title = `${next.name} · xml-stream-format demo`;
  openedAt = performance.now();
  try {
    await explorer.call('open', { file: next, rows: visibleRows() });
    view({ type: 'refresh' });
  } catch (cause) {
    failure(cause);
  }
}

fileInput.onchange = () => {
  const selected = fileInput.files?.[0];
  if (selected) void open(selected);
  fileInput.value = '';
};

for (const button of document.querySelectorAll<HTMLElement>('[data-action="open"]'))
  button.onclick = () => fileInput.click();
for (const button of document.querySelectorAll<HTMLElement>('[data-action="sample"]')) {
  button.onclick = async () => {
    toast(`Generating a ${SAMPLE_MB} MiB sample in memory…`);
    void open(await sampleFile(SAMPLE_MB));
  };
}

window.addEventListener('dragover', (event) => {
  event.preventDefault();
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget) document.body.classList.remove('dragging');
});
window.addEventListener('drop', (event) => {
  event.preventDefault();
  document.body.classList.remove('dragging');
  const dropped = event.dataTransfer?.files[0];
  if (dropped) void open(dropped);
});

// --- mouse --------------------------------------------------------------------------

rowsElement.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const row = target.closest<HTMLElement>('.row');
  if (!row) return;
  focus = 'xml';
  if (target.dataset.node) view({ type: 'fold', node: Number(target.dataset.node) });
  else view({ type: 'select', row: Number(row.dataset.row) });
});

viewport.addEventListener(
  'wheel',
  (event) => {
    if (!file || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    event.preventDefault();
    const unit =
      event.deltaMode === 1 ? ROW_HEIGHT : event.deltaMode === 2 ? viewport.clientHeight : 1;
    wheelRemainder += event.deltaY * unit;
    const delta = Math.trunc(wheelRemainder / ROW_HEIGHT);
    if (!delta) return;
    wheelRemainder -= delta * ROW_HEIGHT;
    view({ type: 'scroll', delta });
  },
  { passive: false },
);

let lastRows = 0;
new ResizeObserver(() => {
  const rows = visibleRows();
  if (rows !== lastRows) {
    lastRows = rows;
    view({ type: 'resize', rows });
  }
}).observe(viewport);

// --- panels -------------------------------------------------------------------------

function closePanel(): void {
  panelMode = undefined;
  focus = 'xml';
  panel.hidden = true;
}

function showPanel(mode: NonNullable<typeof panelMode>, title: string, body: Node): void {
  panelMode = mode;
  panel.hidden = false;
  const head = element('div', 'panel-head');
  const close = element('button', 'ghost icon', '✕');
  close.type = 'button';
  close.title = 'Close (Esc)';
  close.setAttribute('aria-label', 'Close panel');
  close.onclick = closePanel;
  head.append(element('h2', undefined, title), close);
  panel.replaceChildren(head, body);
}

function renderResults(): void {
  if (!results) return;
  const list = element('ol', 'hits');
  results.hits.forEach((hit, index) => {
    const item = element('li', index === results!.index ? 'hit current' : 'hit');
    item.append(element('span', 'label', hit.label), element('span', 'detail', hit.detail));
    item.onclick = () => {
      results!.index = index;
      revealHit();
    };
    list.append(item);
  });
  const shown = results.hits.length;
  const title = `${results.title} · ${integer.format(results.total)} match${results.total === 1 ? '' : 'es'}${shown < results.total ? ` (first ${integer.format(shown)})` : ''}`;
  showPanel('results', title, list);
  list.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
  panel.classList.toggle('focused', focus === 'results');
}

function revealHit(): void {
  const hit = results?.hits[results.index];
  if (!hit) return;
  if (hit.node !== undefined) view({ type: 'reveal', node: hit.node });
  else if (hit.ordinal !== undefined) view({ type: 'revealElement', ordinal: hit.ordinal });
  renderResults();
}

function cycle(step: number): void {
  if (!results?.hits.length) return;
  const count = results.hits.length;
  results.index = (results.index + step + count) % count;
  revealHit();
}

async function search(query: string): Promise<void> {
  const hits = await explorer.call('search', { query });
  results = {
    title: `/ ${query}`,
    hits: hits.map((hit) => ({ label: hit.label, detail: hit.detail, node: hit.node })),
    index: 0,
    total: hits.length,
  };
  renderResults();
}

async function xpath(expression: string, namespaces: string): Promise<void> {
  if (!file) return;
  const bindings: [string, string][] = [];
  for (const binding of namespaces.split(/\s+/).filter(Boolean)) {
    const split = binding.indexOf('=');
    if (split < 0)
      throw new DemoError('ERR_ARGUMENT', `Namespace binding must be prefix=uri: ${binding}`);
    bindings.push([binding.slice(0, split), binding.slice(split + 1)]);
  }
  const started = performance.now();
  jobProgress = (phase, done, total) =>
    showPanel(
      'results',
      'XPath',
      element('p', 'muted', `${phase} ${bytes(done)} / ${bytes(total)}`),
    );
  showPanel('results', 'XPath', element('p', 'muted', 'Loading the document…'));
  try {
    const { hits, total } = await jobs.call('xpath', { file, expression, namespaces: bindings });
    results = {
      title: `: ${expression}`,
      hits: hits.map((hit) => ({ label: hit.label, detail: hit.xpath, ordinal: hit.ordinal })),
      index: 0,
      total,
    };
    renderResults();
    toast(
      `XPath: ${integer.format(total)} nodes in ${((performance.now() - started) / 1000).toFixed(2)} s`,
    );
    if (hits.length) revealHit();
  } catch (cause) {
    closePanel();
    throw cause;
  } finally {
    jobProgress = undefined;
  }
}

async function showStats(): Promise<void> {
  const stats = await explorer.call('stats', {});
  const body = element('div');
  const facts = element('dl', 'facts-grid');
  const add = (label: string, value: string) =>
    facts.append(element('dt', undefined, label), element('dd', undefined, value));
  add('Scope', progress?.state === 'ready' ? 'whole document' : 'indexed prefix');
  add('Elements', integer.format(stats.elements));
  add('Rows indexed', integer.format(stats.nodes));
  add('Distinct names', integer.format(stats.distinctNames));
  add('Max depth', integer.format(stats.maxDepth));
  add('Attributes', integer.format(stats.attributes));
  add('Text characters', integer.format(stats.textChars));
  add(
    'Comments / PIs / CDATA',
    `${stats.comments} / ${stats.instructions} / ${stats.cdataSections}`,
  );
  if (progress) {
    add('Read', `${bytes(progress.bytes)} of ${bytes(progress.total)}`);
    // Elapsed time includes paused periods, so a rate is only meaningful once loading ends.
    if (progress.state === 'ready' || progress.state === 'limit')
      add('Throughput', `${bytes(progress.bytes / Math.max(0.001, progress.elapsed / 1000))}/s`);
  }
  const table = element('table', 'names');
  for (const name of stats.names) {
    const row = element('tr');
    row.append(
      element('td', 'count', integer.format(name.count)),
      element('td', undefined, name.name),
    );
    row.title = name.ns ? `{${name.ns}}` : 'no namespace';
    table.append(row);
  }
  body.append(facts, element('h3', undefined, `Top ${stats.names.length} names`), table);
  showPanel('stats', 'Statistics', body);
}

const HELP: [string, string][] = [
  ['↑/↓ j/k', 'move between visible rows'],
  ['←/h', 'collapse, or go to parent'],
  ['→/l', 'expand, or go to first child'],
  ['Space', 'toggle fold'],
  ['PgUp/PgDn  Ctrl+B/F', 'page'],
  ['Ctrl+U/D', 'half page'],
  ['gg/Home  G/End', 'first row · last indexed row (not EOF)'],
  ['[  ]', 'previous / next element sibling'],
  ['0  1–9', 'collapse all · expand to N levels'],
  ['Shift+←/→', 'scroll horizontally'],
  ['/', 'fuzzy name search (best 200, indexed prefix)'],
  [':', 'XPath 3.1 (FontoXPath, loads the whole file)'],
  ['Enter  n/N  Tab', 'reveal · next/previous hit · results ⇄ XML'],
  ['y', 'copy path, XPath or formatted subtree'],
  ['e', 'export the whole file, formatted'],
  ['o', 'statistics'],
  ['Esc', 'cancel a pending scan, close panel'],
  ['Mouse', 'click selects · ▸ folds · wheel scrolls'],
];

function showHelp(): void {
  const table = element('table', 'keys');
  for (const [keys, action] of HELP) {
    const row = element('tr');
    row.append(element('td', 'key', keys), element('td', undefined, action));
    table.append(row);
  }
  showPanel('help', 'Keys', table);
}

// --- prompt (search / XPath) ----------------------------------------------------------

let promptMode: 'search' | 'xpath' = 'search';
let searchTimer: number | undefined;

function openPrompt(mode: typeof promptMode): void {
  if (!file) return;
  promptMode = mode;
  prompt.hidden = false;
  promptLabel.textContent = mode === 'search' ? '/' : ':';
  promptInput.placeholder =
    mode === 'search' ? 'fuzzy element name' : '//order[@status = "returned"]/customer';
  promptNamespaces.hidden = mode !== 'xpath';
  promptInput.value = '';
  promptInput.focus();
}

function closePrompt(): void {
  prompt.hidden = true;
  promptInput.blur();
}

promptInput.addEventListener('input', () => {
  if (promptMode !== 'search') return;
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void search(promptInput.value).catch(failure), 120);
});

function submitPrompt(): void {
  const value = promptInput.value;
  closePrompt();
  if (!value.trim()) return;
  if (promptMode === 'search') {
    clearTimeout(searchTimer);
    void search(value)
      .then(() => revealHit())
      .catch(failure);
  } else void xpath(value, promptNamespaces.value).catch(failure);
}

// Enter is handled directly: a form with two text inputs has no implicit submission.
prompt.addEventListener('submit', (event) => event.preventDefault());
prompt.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') submitPrompt();
  else if (event.key === 'Escape') closePrompt();
  else return;
  event.preventDefault();
});

// --- dialogs: copy and export -----------------------------------------------------------

function showDialog(title: string, body: Node, actions: HTMLElement[] = []): void {
  const footer = element('div', 'actions');
  const close = element('button', 'ghost', 'Close');
  close.onclick = () => dialog.close();
  footer.append(...actions, close);
  dialog.replaceChildren(element('h2', 'dialog-title', title), body, footer);
  if (!dialog.open) dialog.showModal();
}

dialog.addEventListener('close', () => {
  jobProgress = undefined;
  dialog.onkeydown = null;
});

async function writeClipboard(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${what} (${bytes(new TextEncoder().encode(text).byteLength)})`);
    dialog.close();
  } catch {
    // Some browsers drop clipboard access after an async job; offer a manual copy instead.
    const area = element('textarea', 'copy-area');
    area.value = text;
    area.readOnly = true;
    const copy = element('button', undefined, 'Copy');
    copy.onclick = () => {
      area.select();
      void navigator.clipboard.writeText(text).then(
        () => {
          toast(`Copied ${what}`);
          dialog.close();
        },
        () => document.execCommand('copy'),
      );
    };
    showDialog(`Copy ${what}`, area, [copy]);
    area.select();
  }
}

async function copyMenu(): Promise<void> {
  if (!file) return;
  const selection = await explorer.call('selection', {});
  if (!selection) return;
  const choices: [string, () => Promise<void>][] = [
    ['Readable path', () => writeClipboard(selection.path, 'path')],
    ['Executable XPath', () => writeClipboard(selection.xpath, 'XPath')],
    ['Formatted XML: selected node + descendants', () => copyXml(selection)],
  ];
  const list = element('ol', 'menu');
  let current = 0;
  const run = (index: number) => void choices[index]![1]().catch(failure);
  choices.forEach(([label], index) => {
    const item = element('li', index === 0 ? 'current' : undefined);
    item.append(element('kbd', undefined, String(index + 1)), ` ${label}`);
    item.onclick = () => run(index);
    list.append(item);
  });
  const path = element('p', 'muted mono', selection.path);
  const body = element('div');
  body.append(path, list);
  showDialog('Copy', body);
  dialog.onkeydown = (event) => {
    const items = [...list.children];
    if (event.key === 'ArrowDown' || event.key === 'j') current = (current + 1) % items.length;
    else if (event.key === 'ArrowUp' || event.key === 'k')
      current = (current + items.length - 1) % items.length;
    else if (event.key === 'Enter') return run(current);
    else if (/^[1-3]$/.test(event.key)) return run(Number(event.key) - 1);
    else return;
    event.preventDefault();
    items.forEach((item, index) => {
      item.classList.toggle('current', index === current);
    });
  };
}

async function copyXml(selection: Selection): Promise<void> {
  if (!file) return;
  dialog.onkeydown = null;
  if (selection.root)
    throw new DemoError(
      'ERR_XML_COPY_NODE_TYPE',
      'The document element is not copied; use export (e)',
    );
  const status = element('p', 'muted', 'Reading the subtree from the file…');
  const cancel = element('button', 'ghost', 'Cancel');
  cancel.onclick = () => {
    cancelJobs();
    dialog.close();
  };
  showDialog('Formatted XML', status, [cancel]);
  jobProgress = (phase, done, total) => {
    status.textContent = `${phase} ${bytes(done)} / ${bytes(total)}`;
  };
  const text = await jobs.call('copy', {
    file,
    ordinal: selection.ordinal,
    indent: 2,
    whitespace: 'reindent',
  });
  await writeClipboard(text, 'formatted XML');
}

function exportDialog(): void {
  if (!file) return;
  const source = file;
  dialog.onkeydown = null;
  const form = element('form', 'export');
  form.innerHTML = `
    <label>Indent <select name="indent">
      <option value="2" selected>2 spaces</option><option value="4">4 spaces</option>
      <option value="tab">tab</option><option value="0">0 (line breaks only)</option>
    </select></label>
    <label>Whitespace <select name="whitespace">
      <option value="preserve" selected>preserve</option><option value="reindent">reindent</option>
    </select></label>
    <p class="muted">Two passes over <b></b>: validate everything and record layout flags,
    then stream formatted output to disk. Nothing is written if the XML is invalid.</p>
    <div class="meter"><span class="meter-fill"></span></div><p class="muted" data-status></p>`;
  form.querySelector('b')!.textContent = `${source.name} (${bytes(source.size)})`;
  const status = form.querySelector<HTMLElement>('[data-status]')!;
  const fill = form.querySelector<HTMLElement>('.meter-fill')!;
  const start = element(
    'button',
    undefined,
    'showSaveFilePicker' in window ? 'Save as…' : 'Export',
  );
  const settings = (): FormatSettings => {
    const data = new FormData(form);
    const indent = String(data.get('indent'));
    return {
      indent: indent === 'tab' ? 'tab' : Number(indent),
      whitespace: data.get('whitespace') === 'reindent' ? 'reindent' : 'preserve',
    };
  };
  start.onclick = async () => {
    const suggestedName = source.name.replace(/(\.xml)?$/i, '.formatted.xml');
    let handle: FileSystemFileHandle | undefined;
    const picker = (
      window as unknown as {
        showSaveFilePicker?: (options: object) => Promise<FileSystemFileHandle>;
      }
    ).showSaveFilePicker;
    if (picker) {
      try {
        handle = await picker({
          suggestedName,
          types: [{ description: 'XML', accept: { 'application/xml': ['.xml'] } }],
        });
      } catch {
        return;
      }
    }
    start.disabled = true;
    const began = performance.now();
    jobProgress = (phase, done, total) => {
      const pass = phase === 'validate' ? 0 : 1;
      fill.style.width = `${(((done / total + pass) / 2) * 100).toFixed(1)}%`;
      status.textContent = `${phase === 'validate' ? '1/2 validate' : '2/2 write'} · ${bytes(done)} / ${bytes(total)}`;
    };
    try {
      const result = await jobs.call('export', {
        file: source,
        ...settings(),
        ...(handle ? { handle } : {}),
      });
      const seconds = ((performance.now() - began) / 1000).toFixed(1);
      if (result.saved === 'handle')
        status.textContent = `Saved ${result.name} · ${bytes(result.bytes)} in ${seconds} s`;
      else {
        const blob =
          result.blob ??
          (await (
            await (await navigator.storage.getDirectory()).getFileHandle('export.xml')
          ).getFile());
        const link = element('a', 'button', `Download ${result.name}`);
        link.href = URL.createObjectURL(blob);
        link.download = result.name;
        status.replaceChildren(`${bytes(result.bytes)} in ${seconds} s · `, link);
      }
      fill.style.width = '100%';
    } catch (cause) {
      status.textContent = '';
      failure(cause);
    } finally {
      start.disabled = false;
      jobProgress = undefined;
    }
  };
  const cancel = element('button', 'ghost', 'Cancel');
  cancel.onclick = () => {
    cancelJobs();
    start.disabled = false;
    status.textContent = 'Cancelled';
  };
  showDialog('Export formatted XML', form, [start, cancel]);
}

// --- keyboard ---------------------------------------------------------------------------------

const MOVES: Record<string, Move> = {
  ArrowDown: 'down',
  j: 'down',
  ArrowUp: 'up',
  k: 'up',
  ArrowLeft: 'left',
  h: 'left',
  ArrowRight: 'right',
  l: 'right',
  ' ': 'toggle',
  PageDown: 'pageDown',
  PageUp: 'pageUp',
  Home: 'home',
  End: 'end',
  G: 'end',
  '[': 'previousSibling',
  ']': 'nextSibling',
};
const CONTROL_MOVES: Record<string, Move> = {
  f: 'pageDown',
  b: 'pageUp',
  d: 'halfDown',
  u: 'halfUp',
};

/** Shared by the keyboard and the toolbar buttons. */
const ACTIONS: Record<string, () => void> = {
  '/': () => openPrompt('search'),
  ':': () => openPrompt('xpath'),
  y: () => void copyMenu().catch(failure),
  e: exportDialog,
  o: () => (panelMode === 'stats' ? closePanel() : void showStats().catch(failure)),
  '?': () => (panelMode === 'help' ? closePanel() : showHelp()),
};

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-key]')) {
  button.onclick = () => {
    // A focused button would also react to Space/Enter meant for the XML view.
    button.blur();
    ACTIONS[button.dataset.key!]?.();
  };
}

function resultsKey(event: KeyboardEvent, afterG: boolean): boolean {
  if (!results) return false;
  const count = results.hits.length;
  const control = event.ctrlKey ? CONTROL_MOVES[event.key] : undefined;
  let index = results.index;
  if (event.key === 'ArrowDown' || event.key === 'j') index++;
  else if (event.key === 'ArrowUp' || event.key === 'k') index--;
  else if (control === 'pageDown') index += 10;
  else if (control === 'pageUp') index -= 10;
  else if (control === 'halfDown') index += 5;
  else if (control === 'halfUp') index -= 5;
  else if (event.key === 'G') index = count - 1;
  else if (event.key === 'g' && afterG) index = 0;
  else if (event.key === 'Enter') {
    revealHit();
    focus = 'xml';
    renderResults();
    return true;
  } else return false;
  results.index = Math.max(0, Math.min(count - 1, index));
  renderResults();
  return true;
}

document.addEventListener('keydown', (event) => {
  if (
    dialog.open ||
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLSelectElement
  )
    return;
  if (event.metaKey || event.altKey) return;
  const wasG = pendingG;
  pendingG = event.key === 'g' && !wasG;
  if (event.key === 'Escape') {
    if (!cancelNavigation()) {
      if (panelMode) closePanel();
      else results = undefined;
    }
    return;
  }
  if (!file) return;
  if (event.key === 'Tab') {
    event.preventDefault();
    if (results && panelMode === 'results') {
      focus = focus === 'xml' ? 'results' : 'xml';
      renderResults();
    }
    return;
  }
  if (focus === 'results' && panelMode === 'results') {
    if (resultsKey(event, wasG)) {
      event.preventDefault();
      return;
    }
  }
  const control = event.ctrlKey ? CONTROL_MOVES[event.key] : undefined;
  if (event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    viewport.scrollLeft += event.key === 'ArrowLeft' ? -80 : 80;
  } else if (control) view({ type: 'move', move: control });
  else if (event.ctrlKey) return;
  else if (event.key === 'g') {
    if (wasG) view({ type: 'move', move: 'home' });
  } else if (MOVES[event.key]) view({ type: 'move', move: MOVES[event.key]! });
  else if (/^[0-9]$/.test(event.key)) view({ type: 'level', level: Number(event.key) });
  else if (event.key === 'n') cycle(1);
  else if (event.key === 'N') cycle(-1);
  else if (ACTIONS[event.key]) ACTIONS[event.key]!();
  else return;
  event.preventDefault();
});
