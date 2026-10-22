import type { WireError } from './runtime.js';

export type Move =
  | 'up'
  | 'down'
  | 'pageUp'
  | 'pageDown'
  | 'halfUp'
  | 'halfDown'
  | 'home'
  | 'end'
  | 'left'
  | 'right'
  | 'toggle'
  | 'previousSibling'
  | 'nextSibling';

export type ViewCommand =
  | { type: 'refresh' }
  | { type: 'resize'; rows: number }
  | { type: 'move'; move: Move }
  | { type: 'scroll'; delta: number }
  | { type: 'select'; row: number }
  | { type: 'fold'; node: number }
  | { type: 'level'; level: number }
  | { type: 'reveal'; node: number }
  | { type: 'revealElement'; ordinal: number };

export interface RowPart {
  text: string;
  muted?: boolean;
}

export interface Row {
  node: number;
  depth: number;
  fold?: 'open' | 'closed';
  parts: RowPart[];
}

export interface Page {
  rows: Row[];
  cursor: number;
  path: string;
  /** Rows near the parse frontier may change shape as loading continues. */
  stale: boolean;
}

export type LoadState = 'loading' | 'paused' | 'ready' | 'error' | 'limit';

export interface Progress {
  state: LoadState;
  bytes: number;
  total: number;
  nodes: number;
  elements: number;
  indexBytes: number;
  elapsed: number;
  message?: string;
}

export interface SearchHit {
  node: number;
  label: string;
  detail: string;
}

export interface Stats {
  elements: number;
  nodes: number;
  distinctNames: number;
  maxDepth: number;
  attributes: number;
  textChars: number;
  comments: number;
  instructions: number;
  cdataSections: number;
  names: { name: string; ns: string; count: number }[];
}

export interface Selection {
  path: string;
  xpath: string;
  /** 1-based document-order ordinal of the owning element (matches the XPath DOM ids). */
  ordinal: number;
  root: boolean;
  closed: boolean;
}

export interface ExplorerRequests {
  open: { file: File; rows: number };
  view: { command: ViewCommand };
  loadAll: Record<string, never>;
  search: { query: string };
  stats: Record<string, never>;
  selection: Record<string, never>;
}

export interface ExplorerResults {
  open: null;
  view: Page;
  loadAll: null;
  search: SearchHit[];
  stats: Stats;
  selection: Selection | null;
}

export interface XPathHit {
  ordinal: number;
  xpath: string;
  label: string;
}

export interface FormatSettings {
  indent: number | 'tab';
  whitespace: 'preserve' | 'reindent';
}

export interface JobRequests {
  copy: { file: File; ordinal: number } & FormatSettings;
  export: { file: File; handle?: FileSystemFileHandle } & FormatSettings;
  xpath: { file: File; expression: string; namespaces: [string, string][] };
}

export interface JobResults {
  copy: string;
  export: { saved: 'handle' | 'opfs' | 'blob'; name: string; bytes: number; blob?: Blob };
  xpath: { hits: XPathHit[]; total: number };
}

export type Request<Map> = {
  [K in keyof Map]: { id: number; type: K } & Map[K];
}[keyof Map];

/** Unanswered: cancels the pending navigation (explorer) or the given job. */
export interface CancelMessage {
  type: 'cancel';
  target?: number;
}

export type Response =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: WireError }
  | { type: 'progress'; progress: Progress }
  | { type: 'jobProgress'; id: number; phase: string; bytes: number; total: number };
