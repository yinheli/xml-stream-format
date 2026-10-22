import type { StartData } from '../core/events.js';
import type { FormatOptions } from '../core/options.js';
export interface OpenOptions extends Omit<FormatOptions, 'hooks' | 'indent' | 'whitespace'> {
  maxIndexBytes?: number;
}
export interface CopyOptions extends Pick<FormatOptions, 'indent' | 'whitespace' | 'signal'> {
  maxBytes: number;
}
export interface SelectOptions {
  namespaces?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  maxSourceBytes?: number;
  maxOldGenerationSizeMb?: number;
  queryTimeoutMs?: number;
  maxResults?: number;
}
export type XmlNodeRef =
  | { kind: 'document'; id: 0 }
  | { kind: 'element'; elementId: number }
  | { kind: 'attribute'; ownerElementId: number; namespaceURI: string; localName: string }
  | { kind: 'text'; parentElementId: number; textRunOrdinal: number }
  | { kind: 'comment' | 'processing-instruction'; parentId: number; ordinal: number };
export interface XmlNodeMatch {
  ref: XmlNodeRef;
  xpath: string;
  label: string;
}
export interface XmlDocument {
  select(expression: string, options?: SelectOptions): Promise<readonly XmlNodeMatch[]>;
  extract(
    expression: string,
    options?: SelectOptions & Pick<FormatOptions, 'indent' | 'whitespace'>,
  ): AsyncGenerator<string>;
  close(): Promise<void>;
}
export interface TreeRow {
  id: number;
  name: string;
  depth: number;
  directChildCount: number;
  expanded: boolean;
  incomplete: boolean;
}
export type TreeMove =
  | 'next'
  | 'previous'
  | 'left'
  | 'right'
  | 'toggle'
  | 'previousSibling'
  | 'nextSibling'
  | 'first'
  | 'last'
  | 'pageUp'
  | 'pageDown';
export interface TreeRequest {
  firstId?: number;
  selectedId?: number;
  limit?: number;
  move?: TreeMove;
  loadMore?: boolean;
  steps?: number;
}
export interface TreePage {
  rows: readonly TreeRow[];
  firstId: number;
  selectedId: number;
  totalElements: number;
  path: string;
  needsMore: boolean;
  continuation?: TreeRequest;
}
export interface DetailRequest {
  elementId: number;
  startLine?: number;
  endLine?: number;
  lineCount?: number;
  column?: number;
  columns?: number;
  loadMore?: boolean;
}
export interface DetailRow {
  line: number;
  text: string;
  continued?: boolean;
  truncatedGrapheme?: boolean;
  state?: string;
}
export interface DetailPage {
  rows: readonly DetailRow[];
  startLine: number;
  endLine: number;
  totalLines: number;
  column: number;
  needsMore: boolean;
}
export type XmlMove = TreeMove;
export interface XmlHit {
  from: number;
  to: number;
  elementId: number;
}
export interface XmlRow extends DetailRow {
  key: string;
  elementId: number;
  foldable: boolean;
  expanded: boolean;
  incomplete: boolean;
  foldElementId?: number;
  hits: readonly XmlHit[];
}
export interface XmlRequest {
  limit?: number;
  columns?: number;
  column?: number;
  loadMore?: boolean;
  move?: XmlMove;
  steps?: number;
  selectedId?: number;
  selectKey?: string;
  scroll?: number;
}
export interface XmlPage {
  rows: readonly XmlRow[];
  selectedId: number;
  selectedRow: number;
  path: string;
  pathTruncated: boolean;
  totalElements: number;
  column: number;
  needsMore: boolean;
  continuation?: XmlRequest;
}
export interface Overview {
  totalElements: number;
  maxDepth: number;
  indexBytes: number;
  totalDistinctNames: number;
  namesTruncated: boolean;
  names: readonly { name: string; namespaceURI: string; count: number }[];
}
export interface FuzzyMatch {
  elementId: number;
  label: string;
  score: number;
}
export interface ElementRange {
  elementId: number;
  start: number;
  end: number;
  root: StartData;
}
