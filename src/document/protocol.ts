import type {
  DetailPage,
  DetailRequest,
  ElementRange,
  FuzzyMatch,
  OpenOptions,
  Overview,
  TreePage,
  TreeRequest,
  XmlNodeRef,
  XmlPage,
  XmlRequest,
} from './types.js';
export interface Progress {
  stage: 'input' | 'parse' | 'paused' | 'ready';
  sourceBytes: number;
  nodes: number;
  diagnostic?: string;
}
export interface DocumentRequests {
  load: { workspaceDirectory: string; options: Omit<OpenOptions, 'signal'>; preview: boolean };
  append: { chunk: Uint8Array; sourceBytes: number };
  finish: { sourceBytes: number };
  treeRows: TreeRequest;
  detailRows: DetailRequest;
  xmlRows: XmlRequest;
  overview: Record<string, never>;
  fuzzy: { query: string };
  reveal: { elementId: number };
  expand: { elementId?: number; expanded?: boolean; depth?: number };
  elementRanges: { elementIds: readonly number[] };
  nodePath: { ref: XmlNodeRef; kind: 'path' | 'xpath' };
  copyRef: { elementId: number; maxBytes: number };
  close: Record<string, never>;
}
export interface DocumentResults {
  load: { tapePath: string; totalElements: number; indexBytes: number };
  append: { totalElements: number; indexBytes: number; rootClosed: boolean };
  finish: { totalElements: number; indexBytes: number };
  treeRows: TreePage;
  detailRows: DetailPage;
  xmlRows: XmlPage;
  overview: Overview;
  fuzzy: readonly FuzzyMatch[];
  reveal: null;
  expand: null;
  elementRanges: readonly ElementRange[];
  nodePath: string;
  copyRef: ElementRange;
  close: null;
}
export type DocumentRequest = {
  [K in keyof DocumentRequests]: {
    sessionId: string;
    requestId: number;
    type: K;
    payload: DocumentRequests[K];
  };
}[keyof DocumentRequests];
export interface WireError {
  code: string;
  message: string;
  line?: number;
  column?: number;
  byteOffset?: number;
  path?: readonly string[];
  cause?: string;
}
export type WorkerResponse =
  | { sessionId: string; requestId: number; type: 'result'; value: unknown }
  | { sessionId: string; requestId: number; type: 'error'; error: WireError }
  | { sessionId: string; requestId: 0; type: 'progress'; value: Progress };
