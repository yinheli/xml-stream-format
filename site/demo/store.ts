import type { StartData, XmlEvent } from '../../src/core/events.js';
import { Kind } from '../../src/core/events.js';
import { escapeAttribute } from '../../src/core/serialize.js';

export const ELEMENT = 1;
export const TEXT = 2;
export const CDATA = 3;
export const COMMENT = 4;
export const PI = 5;
export const DECLARATION = 6;

/** `info` bit owned by the demo; `flags` holds the library's Content flags. */
export const HAS_MARKUP = 1;

const TAG_CAP = 1024;
const TEXT_CAP = 512;
const PAGE_BYTES = 4 * 1024 * 1024;
// kind, info, flags (3) + depth (2) + parent, end, name (12) + text offset/length (8)
const BYTES_PER_NODE = 25;

export interface NameEntry {
  id: number;
  qname: string;
  local: string;
  ns: string;
  /** Shared by QNames with the same namespace URI and local name. */
  expanded: number;
  count: number;
}

export class IndexLimitError extends Error {
  readonly code = 'ERR_XML_INDEX_LIMIT';
}

type Column = Uint8Array | Uint16Array | Int32Array | Uint32Array;

function grow<T extends Column>(column: T, length: number): T {
  const next = new (column.constructor as new (length: number) => T)(length);
  next.set(column);
  return next;
}

function whitespaceOnly(value: string): boolean {
  return !/[^\x20\x09\x0d\x0a]/.test(value);
}

/**
 * A compact, append-only document index fed by the library's `ingest()` pipeline.
 * Columns are typed arrays; display previews live in UTF-8 pages and are capped,
 * so memory grows with node count, not with text or attribute sizes.
 */
export class NodeStore {
  count = 0;
  elementCount = 0;
  capacity = 0;
  kind = new Uint8Array(0);
  info = new Uint8Array(0);
  flags = new Uint8Array(0);
  depth = new Uint16Array(0);
  parent = new Int32Array(0);
  /** Index one past the last descendant; 0 while the element is still open. */
  end = new Int32Array(0);
  name = new Int32Array(0);
  /** Byte offset into the preview pages; the index budget keeps it below 4 GiB. */
  textOffset = new Uint32Array(0);
  textLength = new Uint32Array(0);
  elements = new Int32Array(1 << 12);

  readonly names: NameEntry[] = [];
  private readonly nameIds = new Map<string, number>();
  private readonly expandedIds = new Map<string, number>();
  private readonly pages: Uint8Array[] = [];
  private pageUsed = PAGE_BYTES;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  private readonly stack: number[] = [];
  private text = '';
  private textWhitespace = true;
  private textPending = false;
  private cdata: string | undefined;

  maxDepth = 0;
  attributes = 0;
  textChars = 0;
  comments = 0;
  instructions = 0;
  cdataSections = 0;

  /** Required by the library's tape-writer contract; observers are not used here. */
  readonly bytes = 0;

  constructor(private readonly maxBytes: number) {
    this.reserve(1 << 14);
  }

  get indexBytes(): number {
    return (
      this.capacity * BYTES_PER_NODE + this.elements.byteLength + this.pages.length * PAGE_BYTES
    );
  }

  /** Tape-writer contract: returns the record handle later passed to patchFlags. */
  append(event: XmlEvent): number {
    switch (event.kind) {
      case Kind.Text:
        this.textChars += event.data.length;
        if (this.cdata !== undefined) {
          if (this.cdata.length <= TEXT_CAP) this.cdata += event.data.slice(0, TEXT_CAP + 1);
        } else if (this.stack.length) {
          this.textPending = true;
          if (this.text.length <= TEXT_CAP) this.text += event.data.slice(0, TEXT_CAP + 1);
          if (this.textWhitespace) this.textWhitespace = whitespaceOnly(event.data);
        }
        return -1;
      case Kind.CdataStart:
        this.flushText();
        this.cdata = '';
        return -1;
      case Kind.CdataEnd: {
        const value = this.cdata ?? '';
        this.cdata = undefined;
        this.cdataSections++;
        return this.push(CDATA, value, TEXT_CAP);
      }
      case Kind.Start: {
        this.flushText();
        const parent = this.stack.at(-1);
        if (parent !== undefined) this.info[parent]! |= HAS_MARKUP;
        const node = this.push(ELEMENT, attributePreview(event.data), TAG_CAP);
        this.name[node] = this.nameId(event.data);
        if (this.elementCount === this.elements.length)
          this.elements = grow(this.elements, this.elements.length * 2);
        this.elements[this.elementCount++] = node;
        this.attributes += event.data.attributes.length;
        this.stack.push(node);
        if (this.stack.length > this.maxDepth) this.maxDepth = this.stack.length;
        return node;
      }
      case Kind.End: {
        this.flushText();
        const node = this.stack.pop()!;
        this.end[node] = this.count;
        return node;
      }
      case Kind.Comment:
        this.flushText();
        this.markParent();
        this.comments++;
        return this.push(COMMENT, event.data, TEXT_CAP);
      case Kind.Pi:
        this.flushText();
        this.markParent();
        this.instructions++;
        return this.push(
          PI,
          event.data.value ? `${event.data.target} ${event.data.value}` : event.data.target,
          TEXT_CAP,
        );
      case Kind.Declaration: {
        const { standalone } = event.data;
        return this.push(
          DECLARATION,
          `<?xml version="${event.data.version}"${standalone === undefined ? '' : ` standalone="${standalone ? 'yes' : 'no'}"`}?>`,
          TEXT_CAP,
        );
      }
    }
  }

  patchFlags(node: number, flags: number): void {
    if (node >= 0) this.flags[node] = flags;
  }

  /** Decoded display preview of a node (already capped at index time). */
  preview(node: number): string {
    const length = this.textLength[node]!;
    if (!length) return '';
    const offset = this.textOffset[node]!;
    const page = this.pages[Math.floor(offset / PAGE_BYTES)]!;
    const start = offset % PAGE_BYTES;
    return this.decoder.decode(page.subarray(start, start + length));
  }

  /** 0-based document-order ordinal of an element (`elements` is sorted). */
  ordinalOf(node: number): number {
    let low = 0;
    let high = this.elementCount - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const value = this.elements[middle]!;
      if (value === node) return middle;
      if (value < node) low = middle + 1;
      else high = middle - 1;
    }
    return -1;
  }

  qname(node: number): string {
    return this.names[this.name[node]!]!.qname;
  }

  /** Next node index at the same level, or `count` when it is not indexed yet. */
  following(node: number): number {
    if (this.kind[node] !== ELEMENT) return node + 1;
    return this.end[node] || this.count;
  }

  private markParent(): void {
    const parent = this.stack.at(-1);
    if (parent !== undefined) this.info[parent]! |= HAS_MARKUP;
  }

  private flushText(): void {
    if (!this.textPending) return;
    const value = this.text;
    const skip = this.textWhitespace;
    this.text = '';
    this.textWhitespace = true;
    this.textPending = false;
    // Formatting whitespace is not a browsable row; copy/export re-read the source.
    if (!skip) this.push(TEXT, value, TEXT_CAP);
  }

  private nameId(data: StartData): number {
    const key = `${data.namespaceURI}\u0000${data.name}`;
    let id = this.nameIds.get(key);
    if (id === undefined) {
      const expandedKey = `${data.namespaceURI}\u0000${data.localName}`;
      let expanded = this.expandedIds.get(expandedKey);
      if (expanded === undefined) {
        expanded = this.expandedIds.size;
        this.expandedIds.set(expandedKey, expanded);
      }
      id = this.names.length;
      this.names.push({
        id,
        qname: data.name,
        local: data.localName,
        ns: data.namespaceURI,
        expanded,
        count: 0,
      });
      this.nameIds.set(key, id);
    }
    this.names[id]!.count++;
    return id;
  }

  private push(kind: number, value: string, cap: number): number {
    if (this.count === this.capacity) this.reserve(Math.ceil(this.capacity * 1.5));
    const node = this.count++;
    this.kind[node] = kind;
    this.depth[node] = this.stack.length;
    this.parent[node] = this.stack.at(-1) ?? -1;
    this.info[node] = 0;
    if (value.length > cap) value = `${value.slice(0, cap)}…`;
    this.writeText(node, value);
    if (this.indexBytes > this.maxBytes)
      throw new IndexLimitError(
        `Browser index budget reached (${Math.round(this.maxBytes / 1048576)} MiB); the indexed prefix stays browsable`,
      );
    return node;
  }

  private writeText(node: number, value: string): void {
    if (!value) {
      this.textLength[node] = 0;
      return;
    }
    if (this.pageUsed + value.length * 3 > PAGE_BYTES) {
      this.pages.push(new Uint8Array(PAGE_BYTES));
      this.pageUsed = 0;
    }
    const page = this.pages.length - 1;
    const { written } = this.encoder.encodeInto(value, this.pages[page]!.subarray(this.pageUsed));
    this.textOffset[node] = page * PAGE_BYTES + this.pageUsed;
    this.textLength[node] = written;
    this.pageUsed += written;
  }

  private reserve(capacity: number): void {
    this.kind = grow(this.kind, capacity);
    this.info = grow(this.info, capacity);
    this.flags = grow(this.flags, capacity);
    this.depth = grow(this.depth, capacity);
    this.parent = grow(this.parent, capacity);
    this.end = grow(this.end, capacity);
    this.name = grow(this.name, capacity);
    this.textOffset = grow(this.textOffset, capacity);
    this.textLength = grow(this.textLength, capacity);
    this.capacity = capacity;
  }
}

/** Namespace declarations and attributes of an opening tag, with the library's escaping. */
function attributePreview(data: StartData): string {
  let tag = '';
  for (const namespace of data.namespaces) {
    if (tag.length > TAG_CAP) break;
    tag += `${namespace.prefix ? ` xmlns:${namespace.prefix}` : ' xmlns'}="${escapeAttribute(namespace.uri.slice(0, TAG_CAP))}"`;
  }
  for (const attribute of data.attributes) {
    if (tag.length > TAG_CAP) break;
    tag += ` ${attribute.name}="${escapeAttribute(attribute.value.slice(0, TAG_CAP))}"`;
  }
  return tag;
}
