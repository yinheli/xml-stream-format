import type { SQLInputValue, StatementSync } from 'node:sqlite';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as yieldToWorker } from 'node:timers/promises';
import fuzzysort from 'fuzzysort';
import { positiveInteger, XmlError } from '../core/errors.js';
import type { StartData, XmlEvent } from '../core/events.js';
import { Kind } from '../core/events.js';
import { xpathLiteral } from '../xpath/paths.js';
import type { FuzzyMatch, Overview, TreePage, TreeRequest } from './types.js';

const FRAME_BYTES = 64;
const DATABASE_BYTES = 128 * 1024;
const NODE_CACHE_BYTES = 384;
const NONE = 0xffff_ffff;
const MAX_RESULTS = 200;
const MAX_PATH_UNITS = 16 * 1024;
const MAX_BATCH_WRITES = 256;
// Index-only metadata, disjoint from the core Content flags (bits 0–4).
const HAS_SAME_EXPANDED_NAME_SIBLING = 1 << 5;
const UINT_FIELDS = [
  'parent',
  'firstChild',
  'lastChild',
  'nextSibling',
  'previousSibling',
  'depth',
  'nameId',
  'sameNameOrdinal',
  'directChildCount',
  'contentFlags',
] as const;
const FLOAT_FIELDS = [
  'tapeStart',
  'tapeEnd',
  'previewStart',
  'previewEnd',
  'startLine',
  'endLine',
  'openEnd',
  'closeStart',
] as const;
const NODE_FIELDS = [...UINT_FIELDS, ...FLOAT_FIELDS] as const;
const SQL = {
  node: 'SELECT * FROM nodes WHERE id = ?',
  insertNode: `INSERT INTO nodes (id,${NODE_FIELDS.join(',')}) VALUES (${Array.from({ length: NODE_FIELDS.length + 1 }, () => '?').join(',')})`,
  updateNode: `UPDATE nodes SET ${NODE_FIELDS.map((field) => `${field} = ?`).join(',')} WHERE id = ?`,
  nameId: 'SELECT id, expandedId FROM names WHERE namespaceURI = ? AND localName = ? AND name = ?',
  nameSize: 'SELECT units FROM names WHERE id = ?',
  name: 'SELECT name, localName, namespaceURI, prefix FROM names WHERE id = ?',
  insertName:
    'INSERT INTO names (id,name,localName,namespaceURI,prefix,units,expandedId) VALUES (?,?,?,?,?,?,?)',
  expandedName: 'SELECT id FROM expanded_names WHERE namespaceURI = ? AND localName = ?',
  insertExpanded: 'INSERT INTO expanded_names (namespaceURI,localName,name,count) VALUES (?,?,?,0)',
  countName: 'UPDATE expanded_names SET count = count + 1 WHERE id = ?',
  bumpName: 'UPDATE expanded_names SET count = count + ? WHERE id = ?',
  ordinal: 'SELECT count, firstId FROM ordinals WHERE parent = ? AND expandedId = ?',
  updateOrdinal:
    'INSERT INTO ordinals (parent,expandedId,count,firstId) VALUES (?,?,?,?) ON CONFLICT(parent,expandedId) DO UPDATE SET count = excluded.count',
  fold: 'SELECT expanded FROM folds WHERE id = ?',
  setFold:
    'INSERT INTO folds (id,expanded) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET expanded = excluded.expanded',
  deleteFold: 'DELETE FROM folds WHERE id = ?',
  clearFolds: 'DELETE FROM folds',
  owner:
    'SELECT id FROM nodes WHERE id > 0 AND openEnd > 0 AND previewStart <= ? ORDER BY previewStart DESC, id DESC LIMIT 1',
  lineStart:
    'SELECT id FROM nodes WHERE id > 0 AND openEnd > 0 AND startLine = ? ORDER BY previewStart, id LIMIT 1',
  nextStart:
    'SELECT id FROM nodes WHERE id > 0 AND openEnd > 0 AND previewStart >= ? ORDER BY previewStart, id LIMIT 1',
  endings:
    'SELECT id FROM nodes WHERE id > 0 AND previewEnd > 0 AND closeStart >= ? AND closeStart < ? ORDER BY closeStart, id DESC LIMIT ?',
  overview:
    'SELECT id, count, 2 * (length(name) + length(namespaceURI)) AS units FROM expanded_names ORDER BY count DESC, name, id LIMIT 20',
  overviewName: 'SELECT name, namespaceURI FROM expanded_names WHERE id = ?',
  distinctNames: 'SELECT COUNT(*) AS count FROM expanded_names',
  searchNames: 'SELECT id FROM names WHERE id < ? ORDER BY id',
  searchNodes: 'SELECT id FROM nodes WHERE nameId = ? AND id > 0 AND id <= ? ORDER BY id LIMIT 200',
} as const;
type StatementKey = keyof typeof SQL;

export interface IndexedNode {
  parent: number;
  firstChild: number;
  lastChild: number;
  nextSibling: number;
  previousSibling: number;
  depth: number;
  nameId: number;
  sameNameOrdinal: number;
  directChildCount: number;
  contentFlags: number;
  tapeStart: number;
  tapeEnd: number;
  previewStart: number;
  previewEnd: number;
  startLine: number;
  endLine: number;
  openEnd: number;
  closeStart: number;
}

interface NodeName {
  name: string;
  localName: string;
  namespaceURI: string;
  prefix: string;
}
interface CacheEntry {
  value: IndexedNode | Readonly<NodeName>;
  bytes: number;
}
interface OrdinalRecord {
  count: number;
  firstId: number;
}
interface InternedName {
  id: number;
  expandedId: number;
}
interface ScoredNode {
  elementId: number;
  score: number;
}

function emptyNode(): IndexedNode {
  return {
    parent: NONE,
    firstChild: NONE,
    lastChild: NONE,
    nextSibling: NONE,
    previousSibling: NONE,
    depth: 0,
    nameId: 0,
    sameNameOrdinal: 0,
    directChildCount: 0,
    contentFlags: 0,
    tapeStart: 0,
    tapeEnd: 0,
    previewStart: 0,
    previewEnd: 0,
    startLine: 0,
    endLine: 0,
    openEnd: 0,
    closeStart: 0,
  };
}

/** Worker-owned disk index. The budget covers resident working storage, not database file size. */
export class NodeIndex {
  private readonly database: DatabaseSync;
  private readonly statements: Record<StatementKey, StatementSync>;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly stack: number[] = [];
  private readonly maxIndexBytes: number;
  private readonly cacheLimit: number;
  private cacheBytes = 0;
  private usedBytes = 0;
  private elementCount = 0;
  private nameCount = 0;
  private maximumDepth = 0;
  private selectedId = 0;
  private firstId = 0;
  private expansionDepth = 3;
  private transaction = false;
  private writes = 0;
  private readonly nameCache = new Map<string, { id: number; expandedId: number }>();
  private readonly countDeltas = new Map<number, number>();
  private readonly ordinals = new Map<string, { count: number; firstId: number }>();
  private readonly dirtyOrdinals = new Map<string, { parent: number; expandedId: number }>();
  private readonly dirtyNodes = new Set<number>();
  private closed = false;

  constructor(path: string, maxIndexBytes = 268_435_456) {
    this.maxIndexBytes = positiveInteger(maxIndexBytes, 268_435_456, 'maxIndexBytes');
    this.cacheLimit = Math.min(1024 * 1024, Math.floor(this.maxIndexBytes / 8));
    // Reject tiny budgets before opening SQLite or allocating its page/statement storage.
    this.charge(DATABASE_BYTES + FRAME_BYTES);
    this.database = new DatabaseSync(path);
    try {
      this.database.exec(`
        PRAGMA page_size = 4096;
        PRAGMA cache_size = -64;
        PRAGMA cache_spill = ON;
        PRAGMA mmap_size = 0;
        PRAGMA temp_store = FILE;
        PRAGMA journal_mode = DELETE;
        PRAGMA synchronous = OFF;
        CREATE TABLE nodes (id INTEGER PRIMARY KEY, ${NODE_FIELDS.map((field) => `${field} INTEGER NOT NULL`).join(',')});
        CREATE INDEX node_names ON nodes(nameId, id);
        CREATE INDEX node_starts ON nodes(previewStart, id) WHERE id > 0 AND openEnd > 0;
        CREATE INDEX node_lines ON nodes(startLine, previewStart, id) WHERE id > 0 AND openEnd > 0;
        CREATE INDEX node_ends ON nodes(closeStart, id DESC) WHERE id > 0 AND previewEnd > 0;
        CREATE TABLE expanded_names (id INTEGER PRIMARY KEY, namespaceURI TEXT NOT NULL, localName TEXT NOT NULL, name TEXT NOT NULL, count INTEGER NOT NULL, UNIQUE(namespaceURI, localName));
        CREATE INDEX expanded_counts ON expanded_names(count DESC, name, id);
        CREATE TABLE names (id INTEGER PRIMARY KEY, name TEXT NOT NULL, localName TEXT NOT NULL, namespaceURI TEXT NOT NULL, prefix TEXT NOT NULL, units INTEGER NOT NULL, expandedId INTEGER NOT NULL, UNIQUE(namespaceURI, localName, name));
        CREATE TABLE ordinals (parent INTEGER NOT NULL, expandedId INTEGER NOT NULL, count INTEGER NOT NULL, firstId INTEGER NOT NULL, PRIMARY KEY(parent, expandedId)) WITHOUT ROWID;
        CREATE TABLE folds (id INTEGER PRIMARY KEY, expanded INTEGER NOT NULL);
      `);
      this.statements = Object.fromEntries(
        Object.entries(SQL).map(([key, sql]) => [key, this.database.prepare(sql)]),
      ) as Record<StatementKey, StatementSync>;
      const document = emptyNode();
      this.write('insertNode', 0, ...NODE_FIELDS.map((field) => document[field]));
      this.stack.push(0);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  get count(): number {
    return this.elementCount;
  }
  get allocatedBytes(): number {
    return this.usedBytes;
  }
  get budgetBytes(): number {
    return this.maxIndexBytes;
  }
  get selectedElementId(): number {
    return this.selectedId;
  }

  /** Reserve retained or transient work before allocating; evict optional caches first. */
  charge(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new RangeError('Index charge must be a nonnegative safe integer');
    while (bytes > this.maxIndexBytes - this.usedBytes && this.cache.size) this.evict();
    if (bytes > this.maxIndexBytes - this.usedBytes) {
      throw new XmlError(
        'ERR_XML_INDEX_LIMIT',
        'XML browsing working storage exceeds maxIndexBytes; increase maxIndexBytes (CLI: --max-index-bytes) or use streaming format',
      );
    }
    this.usedBytes += bytes;
  }

  release(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.usedBytes)
      throw new RangeError('Invalid index storage release');
    this.usedBytes -= bytes;
  }

  private evict(): void {
    const key = this.cache.keys().next().value;
    if (key === undefined) return;
    const entry = this.cache.get(key)!;
    // A dirty node must reach the database before its only cached copy disappears.
    if (key.charCodeAt(0) === 110 /* n */) {
      const id = Number(key.slice(1));
      if (this.dirtyNodes.has(id)) this.applyNode(id);
    }
    this.cache.delete(key);
    this.cacheBytes -= entry.bytes;
    this.release(entry.bytes);
  }

  private cached(key: string): CacheEntry | undefined {
    const entry = this.cache.get(key);
    if (entry) {
      this.cache.delete(key);
      this.cache.set(key, entry);
    }
    return entry;
  }

  private remember(key: string, value: CacheEntry['value'], bytes: number): void {
    const previous = this.cache.get(key);
    if (previous) {
      this.cache.delete(key);
      this.cacheBytes -= previous.bytes;
      this.release(previous.bytes);
    }
    if (bytes > this.cacheLimit) return;
    while (this.cacheBytes + bytes > this.cacheLimit && this.cache.size) this.evict();
    // Caches are optional: do not turn a valid uncached read into a budget failure.
    while (bytes > this.maxIndexBytes - this.usedBytes && this.cache.size) this.evict();
    if (bytes > this.maxIndexBytes - this.usedBytes) return;
    this.charge(bytes);
    this.cache.set(key, { value, bytes });
    this.cacheBytes += bytes;
  }

  private write(key: StatementKey, ...parameters: SQLInputValue[]): void {
    if (this.closed) throw new Error('Document index is closed');
    if (!this.transaction) {
      this.database.exec('BEGIN');
      this.transaction = true;
    }
    this.statements[key].run(...parameters);
    if (++this.writes >= MAX_BATCH_WRITES) this.flush();
  }

  /** Publishes pending deferred writes, then commits. Runs only between ingests. */
  flush(): void {
    if (this.closed) return;
    if (
      !this.transaction &&
      !this.dirtyNodes.size &&
      !this.dirtyOrdinals.size &&
      !this.countDeltas.size
    )
      return;
    if (!this.transaction) {
      this.database.exec('BEGIN');
      this.transaction = true;
    }
    if (this.dirtyOrdinals.size) {
      for (const [key, parts] of this.dirtyOrdinals) {
        const record = this.ordinals.get(key)!;
        this.statements.updateOrdinal.run(
          parts.parent,
          parts.expandedId,
          record.count,
          record.firstId,
        );
        this.writes++;
      }
      this.dirtyOrdinals.clear();
    }
    if (this.countDeltas.size) {
      for (const [expandedId, delta] of this.countDeltas) {
        this.statements.bumpName.run(delta, expandedId);
        this.writes++;
      }
      this.countDeltas.clear();
    }
    if (this.dirtyNodes.size) {
      for (const id of this.dirtyNodes) {
        const entry = this.cache.get(`n${id}`) as CacheEntry | undefined;
        const node = entry?.value as IndexedNode | undefined;
        if (!node) continue;
        this.statements.updateNode.run(...NODE_FIELDS.map((field) => node[field]), id);
        this.writes++;
      }
      this.dirtyNodes.clear();
    }
    this.database.exec('COMMIT');
    this.transaction = false;
    this.writes = 0;
  }

  /** Writes one node's cached row immediately; used before eviction drops the copy. */
  private applyNode(id: number): void {
    const entry = this.cache.get(`n${id}`) as CacheEntry | undefined;
    const node = entry?.value as IndexedNode | undefined;
    if (!node) return;
    if (!this.transaction) {
      this.database.exec('BEGIN');
      this.transaction = true;
    }
    this.statements.updateNode.run(...NODE_FIELDS.map((field) => node[field]), id);
    this.writes++;
    this.dirtyNodes.delete(id);
  }

  close(): void {
    if (this.closed) return;
    try {
      this.flush();
    } finally {
      this.database.close();
      this.closed = true;
      while (this.cache.size) this.evict();
      this.release(DATABASE_BYTES + FRAME_BYTES * this.stack.length);
      this.stack.length = 0;
    }
  }

  private validateId(id: number): void {
    if (!Number.isSafeInteger(id) || id < 0 || id > this.elementCount || id === NONE)
      throw new RangeError('Invalid element ID');
  }

  private node(id: number): IndexedNode {
    this.validateId(id);
    const key = `n${id}`;
    const cached = this.cached(key);
    if (cached) return cached.value as IndexedNode;
    const row = this.statements.node.get(id)!;
    const node = emptyNode();
    for (const field of NODE_FIELDS) node[field] = row[field] as number;
    this.remember(key, node, NODE_CACHE_BYTES);
    return node;
  }

  private uint(id: number, field: number): number {
    return this.node(id)[UINT_FIELDS[field]!];
  }

  get(id: number): IndexedNode {
    return { ...this.node(id) };
  }

  set(id: number, patch: Partial<IndexedNode>): void {
    this.validateId(id);
    // Validate the entire patch before changing any field; integers must not silently wrap.
    for (const field of UINT_FIELDS) {
      const value = patch[field];
      if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > NONE))
        throw new RangeError(`Invalid index field ${field}`);
    }
    for (const field of FLOAT_FIELDS) {
      const value = patch[field];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
        throw new RangeError(`Invalid index field ${field}`);
    }
    const node = { ...this.node(id) };
    for (const field of NODE_FIELDS) if (patch[field] !== undefined) node[field] = patch[field]!;
    // Readers see the cached row immediately; the row reaches SQLite once per commit.
    this.remember(`n${id}`, node, NODE_CACHE_BYTES);
    this.dirtyNodes.add(id);
    if (id !== 0 && patch.depth !== undefined)
      this.maximumDepth = Math.max(this.maximumDepth, patch.depth);
  }

  name(id: number): Readonly<NodeName> {
    if (!Number.isSafeInteger(id) || id < 0 || id >= this.nameCount)
      throw new RangeError('Invalid name ID');
    const key = `s${id}`;
    const cached = this.cached(key);
    if (cached) return cached.value as Readonly<NodeName>;
    const units = this.statements.nameSize.get(id)!.units as number;
    const bytes = 192 + units * 2;
    this.charge(bytes);
    let name: Readonly<NodeName>;
    try {
      name = Object.freeze({ ...this.statements.name.get(id)! }) as unknown as Readonly<NodeName>;
    } finally {
      this.release(bytes);
    }
    this.remember(key, name, bytes);
    return name;
  }

  private internName(data: StartData): InternedName {
    // Names repeat heavily inside real documents; one map lookup replaces four
    // statements per element, and the running count is published per commit.
    const key = `${data.namespaceURI}\u0000${data.localName}\u0000${data.name}`;
    const cached = this.nameCache.get(key);
    if (cached) {
      this.countDeltas.set(cached.expandedId, (this.countDeltas.get(cached.expandedId) ?? 0) + 1);
      return cached;
    }
    const units =
      data.name.length + data.localName.length + data.namespaceURI.length + data.prefix.length;
    // Binding/decoding a dictionary record is bounded even when its strings are not cached.
    const bytes = 192 + units * 2;
    this.charge(bytes);
    try {
      const existing = this.statements.nameId.get(data.namespaceURI, data.localName, data.name);
      let interned: { id: number; expandedId: number };
      if (existing) {
        interned = { id: existing.id as number, expandedId: existing.expandedId as number };
      } else {
        let expanded = this.statements.expandedName.get(data.namespaceURI, data.localName);
        if (!expanded) {
          this.write('insertExpanded', data.namespaceURI, data.localName, data.name);
          expanded = this.statements.expandedName.get(data.namespaceURI, data.localName)!;
        }
        const expandedId = expanded.id as number;
        const id = this.nameCount;
        this.write(
          'insertName',
          id,
          data.name,
          data.localName,
          data.namespaceURI,
          data.prefix,
          units,
          expandedId,
        );
        this.nameCount++;
        interned = { id, expandedId };
      }
      this.countDeltas.set(
        interned.expandedId,
        (this.countDeltas.get(interned.expandedId) ?? 0) + 1,
      );
      this.nameCache.set(key, interned);
      return interned;
    } finally {
      this.release(bytes);
    }
  }

  private append(
    nameId: number,
    parent: number,
    depth: number,
    ordinal: number,
    tapeStart: number,
    flags: number,
  ): number {
    if (this.elementCount + 1 >= NONE)
      throw new XmlError(
        'ERR_XML_INDEX_LIMIT',
        'XML element IDs exceed the uint32 browsing index capacity',
      );
    const id = this.elementCount + 1;
    const parentNode = this.node(parent);
    const previousSibling = parentNode.lastChild;
    const node = {
      ...emptyNode(),
      parent,
      depth,
      nameId,
      sameNameOrdinal: ordinal,
      tapeStart,
      contentFlags: flags,
      previousSibling,
    };
    this.write('insertNode', id, ...NODE_FIELDS.map((field) => node[field]));
    this.elementCount = id;
    this.maximumDepth = Math.max(this.maximumDepth, depth);
    this.remember(`n${id}`, node, NODE_CACHE_BYTES);
    if (previousSibling !== NONE) this.set(previousSibling, { nextSibling: id });
    this.set(parent, {
      firstChild: previousSibling === NONE ? id : parentNode.firstChild,
      lastChild: id,
      directChildCount: parentNode.directChildCount + 1,
    });
    return id;
  }

  /** Publishes one appended tape event without waiting for its element to close. */
  accept(
    event: XmlEvent,
    offset: number,
    nextOffset: number,
    contentFlags?: number,
  ): number | undefined {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(nextOffset) ||
      nextOffset < offset
    )
      throw new RangeError('Invalid tape event offsets');
    const flags = contentFlags ?? event.flags;
    if (flags !== undefined && (!Number.isInteger(flags) || flags < 0 || flags > NONE))
      throw new RangeError('Invalid index field contentFlags');
    let elementId: number | undefined;
    if (event.kind === Kind.Start) {
      this.charge(FRAME_BYTES);
      try {
        const parent = this.stack[this.stack.length - 1]!;
        const name = this.internName(event.data);
        const ordinalKey = `${parent}:${name.expandedId}`;
        let record = this.ordinals.get(ordinalKey);
        if (!record) {
          const previous = this.statements.ordinal.get(parent, name.expandedId) as unknown as
            | OrdinalRecord
            | undefined;
          record = { count: previous?.count ?? 0, firstId: previous?.firstId ?? 0 };
          this.ordinals.set(ordinalKey, record);
        }
        const ordinal = record.count + 1;
        elementId = this.append(
          name.id,
          parent,
          this.stack.length - 1,
          ordinal,
          offset,
          contentFlags ?? event.flags ?? 0,
        );
        if (!record.count) record.firstId = elementId;
        record.count = ordinal;
        this.dirtyOrdinals.set(ordinalKey, { parent, expandedId: name.expandedId });
        if (ordinal === 2)
          this.set(record.firstId, {
            contentFlags: this.uint(record.firstId, 9) | HAS_SAME_EXPANDED_NAME_SIBLING,
          });
        this.stack.push(elementId);
      } catch (error) {
        this.release(FRAME_BYTES);
        throw error;
      }
    } else if (event.kind === Kind.End) {
      if (this.stack.length === 1)
        throw new XmlError('ERR_XML_PARSE', 'Unexpected closing event in document index');
      elementId = this.stack[this.stack.length - 1]!;
      const previousFlags = this.uint(elementId, 9);
      this.set(elementId, {
        tapeEnd: nextOffset,
        contentFlags:
          (contentFlags ?? event.flags ?? previousFlags) |
          (previousFlags & HAS_SAME_EXPANDED_NAME_SIBLING),
      });
      this.stack.pop();
      this.release(FRAME_BYTES);
    }
    this.set(0, { tapeEnd: nextOffset });
    return elementId;
  }

  finish(tapeEnd: number): void {
    if (this.stack.length !== 1)
      throw new XmlError('ERR_XML_PARSE', 'Unclosed element in document index');
    this.set(0, { tapeEnd });
    this.flush();
  }

  isExpanded(id: number): boolean {
    this.validateId(id);
    if (id === 0) return true;
    const override = this.statements.fold.get(id);
    return override ? override.expanded === 1 : this.uint(id, 5) + 1 < this.expansionDepth;
  }

  setExpanded(id: number, expanded: boolean): void {
    this.validateId(id);
    if (id === 0) return;
    if (typeof expanded !== 'boolean') throw new RangeError('Expansion state must be a boolean');
    if (expanded === this.uint(id, 5) + 1 < this.expansionDepth) this.write('deleteFold', id);
    else this.write('setFold', id, Number(expanded));
  }

  reveal(elementId: number): void {
    this.validateId(elementId);
    let parent = this.uint(elementId, 0);
    while (parent !== NONE && parent !== 0) {
      this.setExpanded(parent, true);
      parent = this.uint(parent, 0);
    }
  }

  async expand(options: { elementId?: number; expanded?: boolean; depth?: number }): Promise<void> {
    if (options.depth !== undefined) {
      if (!Number.isSafeInteger(options.depth) || options.depth < 0)
        throw new RangeError('Expansion depth must be a nonnegative safe integer');
      this.write('clearFolds');
      this.expansionDepth = options.depth;
    } else {
      const id = options.elementId ?? this.uint(0, 1);
      if (id !== NONE) this.setExpanded(id, options.expanded ?? !this.isExpanded(id));
    }
  }

  private previewPosition(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError('Preview position must be a nonnegative safe integer');
  }

  ownerAtPreview(byte: number): number {
    this.previewPosition(byte);
    const row = this.statements.owner.get(byte);
    let id = row?.id as number | undefined;
    while (id !== undefined && id !== 0 && id !== NONE) {
      const node = this.node(id);
      if (node.previewEnd === 0 || byte < node.previewEnd) return id;
      id = node.parent;
    }
    return 0;
  }

  startingAtLine(line: number): number | undefined {
    this.previewPosition(line);
    return this.statements.lineStart.get(line)?.id as number | undefined;
  }

  startingAtOrAfter(byte: number): number | undefined {
    this.previewPosition(byte);
    return this.statements.nextStart.get(byte)?.id as number | undefined;
  }

  endingBetween(start: number, end: number, limit = 256): readonly number[] {
    this.previewPosition(start);
    this.previewPosition(end);
    if (end < start) throw new RangeError('Preview range end precedes start');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256)
      throw new RangeError('Closing-node limit must be from 1 through 256');
    const bytes = 64 + limit * 16;
    this.charge(bytes);
    try {
      const ids: number[] = [];
      for (const row of this.statements.endings.iterate(start, end, limit))
        ids.push(row.id as number);
      return ids;
    } finally {
      this.release(bytes);
    }
  }

  collapsedAncestor(id: number): number | undefined {
    this.validateId(id);
    let collapsed: number | undefined;
    while (id !== 0 && id !== NONE) {
      const node = this.node(id);
      // Completed leaves always retain their values, regardless of expansion presets.
      if ((node.firstChild !== NONE || node.tapeEnd === 0) && !this.isExpanded(id)) collapsed = id;
      id = node.parent;
    }
    return collapsed;
  }

  private nextVisible(id: number): number {
    if (this.isExpanded(id)) {
      const child = this.uint(id, 1);
      if (child !== NONE) return child;
    }
    while (id !== 0 && id !== NONE) {
      const sibling = this.uint(id, 3);
      if (sibling !== NONE) return sibling;
      id = this.uint(id, 0);
    }
    return NONE;
  }

  private previousVisible(id: number): number {
    const sibling = this.uint(id, 4);
    if (sibling !== NONE) return this.lastVisible(sibling);
    const parent = this.uint(id, 0);
    return parent === 0 ? NONE : parent;
  }

  private lastVisible(id: number): number {
    while (this.isExpanded(id)) {
      const child = this.uint(id, 2);
      if (child === NONE) break;
      id = child;
    }
    return id;
  }

  private visibleAncestor(id: number, fallback: number): number {
    if (!Number.isSafeInteger(id) || id < 1 || id > this.count) return fallback;
    let visible = id;
    let parent = this.uint(id, 0);
    while (parent !== 0 && parent !== NONE) {
      if (!this.isExpanded(parent)) visible = parent;
      parent = this.uint(parent, 0);
    }
    return visible;
  }

  private isOpen(id: number): boolean {
    return id !== 0 && id !== NONE && this.stack[this.uint(id, 5) + 1] === id;
  }

  /** Future rows can appear only below a visible, expanded open ancestor. */
  private visibleFrontier(): number {
    let frontier = NONE;
    for (let frame = 1; frame < this.stack.length; frame++) {
      const id = this.stack[frame]!;
      if (!this.isExpanded(id)) break;
      frontier = id;
    }
    return frontier;
  }

  treeRows(request: TreeRequest): TreePage {
    const limit = request.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4096)
      throw new RangeError('Tree page limit must be from 1 through 4096');
    if (
      request.steps !== undefined &&
      (!Number.isSafeInteger(request.steps) || request.steps < 0 || request.steps > 4096)
    )
      throw new RangeError('Tree movement steps must be from 0 through 4096');
    const root = this.uint(0, 1);
    if (root === NONE)
      return {
        rows: [],
        firstId: 0,
        selectedId: 0,
        totalElements: 0,
        path: '/',
        needsMore: true,
        ...(request.move ? { continuation: { ...request, firstId: 0, selectedId: 0, limit } } : {}),
      };
    let selected = this.visibleAncestor(request.selectedId ?? this.selectedId, root);
    let first = this.visibleAncestor(request.firstId ?? this.firstId, root);
    let pendingMove: TreeRequest['move'];
    let pendingSteps: number | undefined;
    const take = (candidate: number): void => {
      if (candidate !== NONE && candidate !== 0) selected = candidate;
    };
    switch (request.move) {
      case 'next': {
        const candidate = this.nextVisible(selected);
        if (candidate === NONE && this.visibleFrontier() !== NONE) pendingMove = 'next';
        else take(candidate);
        break;
      }
      case 'previous':
        take(this.previousVisible(selected));
        break;
      case 'left':
        if (this.isExpanded(selected) && (this.uint(selected, 1) !== NONE || this.isOpen(selected)))
          this.setExpanded(selected, false);
        else take(this.uint(selected, 0));
        break;
      case 'right':
        if (
          !this.isExpanded(selected) &&
          (this.uint(selected, 1) !== NONE || this.isOpen(selected))
        )
          this.setExpanded(selected, true);
        else if (this.uint(selected, 1) === NONE && this.isOpen(selected)) pendingMove = 'right';
        else take(this.uint(selected, 1));
        break;
      case 'toggle':
        this.setExpanded(selected, !this.isExpanded(selected));
        break;
      case 'previousSibling':
        take(this.uint(selected, 4));
        break;
      case 'nextSibling': {
        const sibling = this.uint(selected, 3);
        if (sibling === NONE && this.isOpen(this.uint(selected, 0))) pendingMove = 'nextSibling';
        else take(sibling);
        break;
      }
      case 'first':
        selected = root;
        first = root;
        break;
      case 'last': {
        const last = this.lastVisible(this.uint(0, 2));
        if (last === selected && this.visibleFrontier() !== NONE) pendingMove = 'next';
        selected = last;
        break;
      }
      case 'pageUp':
      case 'pageDown':
        for (let remaining = request.steps ?? limit; remaining > 0; remaining--) {
          const candidate =
            request.move === 'pageUp' ? this.previousVisible(selected) : this.nextVisible(selected);
          if (candidate === NONE) {
            if (request.move === 'pageDown' && this.visibleFrontier() !== NONE) {
              pendingMove = 'pageDown';
              pendingSteps = remaining;
            }
            break;
          }
          selected = candidate;
        }
        break;
    }
    let cursor = first;
    let selectionOnPage = false;
    for (let row = 0; row < limit && cursor !== NONE; row++) {
      if (cursor === selected) selectionOnPage = true;
      cursor = this.nextVisible(cursor);
    }
    if (!selectionOnPage) {
      first = selected;
      if (request.move !== 'previous' && request.move !== 'pageUp' && request.move !== 'left') {
        for (let row = 1; row < limit; row++) {
          const previous = this.previousVisible(first);
          if (previous === NONE) break;
          first = previous;
        }
      }
    }
    let rowBytes = 0;
    try {
      const rows: TreePage['rows'][number][] = [];
      cursor = first;
      let available = 0;
      while (cursor !== NONE && available < limit * 2) {
        if (available < limit) {
          const node = this.node(cursor);
          const bytes = 128 + (this.statements.nameSize.get(node.nameId)!.units as number) * 2;
          this.charge(bytes);
          rowBytes += bytes;
          rows.push({
            id: cursor,
            name: this.name(node.nameId).name,
            depth: node.depth,
            directChildCount: node.directChildCount,
            expanded: this.isExpanded(cursor),
            incomplete: node.tapeEnd === 0,
          });
        }
        available++;
        cursor = this.nextVisible(cursor);
      }
      this.firstId = first;
      this.selectedId = selected;
      const continuation: TreeRequest | undefined = pendingMove
        ? {
            firstId: first,
            selectedId: selected,
            limit,
            move: pendingMove,
            ...(pendingSteps === undefined ? {} : { steps: pendingSteps }),
            ...(request.loadMore === undefined ? {} : { loadMore: request.loadMore }),
          }
        : undefined;
      const needsMore =
        continuation !== undefined || (available < limit * 2 && this.visibleFrontier() !== NONE);
      return {
        rows,
        firstId: first,
        selectedId: selected,
        totalElements: this.count,
        path: this.readablePath(selected),
        needsMore,
        ...(continuation ? { continuation } : {}),
      };
    } finally {
      this.release(rowBytes);
    }
  }

  readablePath(id: number): string {
    return this.elementPath(id, false);
  }

  canonicalXPath(id: number): string {
    return this.elementPath(id, true);
  }

  private elementPath(id: number, canonical: boolean): string {
    this.validateId(id);
    // Bound both the joined path and its temporary component array before constructing either.
    const reservation = Math.min(128 * 1024, Math.floor(this.maxIndexBytes / 4));
    const maximumUnits = Math.min(MAX_PATH_UNITS, Math.floor(reservation / 8));
    this.charge(reservation);
    try {
      const parts: string[] = [];
      let units = 1;
      while (id !== 0 && id !== NONE) {
        const node = this.node(id);
        const nameUnits = this.statements.nameSize.get(node.nameId)!.units as number;
        // A single dictionary record must also fit before decoding its qualified name.
        if (nameUnits > maximumUnits * 4)
          throw new XmlError(
            'ERR_XML_INDEX_LIMIT',
            'XML element path exceeds the bounded readable-path limit',
          );
        const name = this.name(node.nameId);
        const needsOrdinal =
          node.sameNameOrdinal > 1 || !!(node.contentFlags & HAS_SAME_EXPANDED_NAME_SIBLING);
        const ordinal = canonical || needsOrdinal ? `[${node.sameNameOrdinal}]` : '';
        const literalUnits = (value: string): number => {
          let singles = 0;
          let doubles = false;
          for (let i = 0; i < value.length; i++) {
            if (value.charCodeAt(i) === 39) singles++;
            if (value.charCodeAt(i) === 34) doubles = true;
          }
          return singles && doubles ? value.length + singles * 8 + 10 : value.length + 2;
        };
        // Compute literal expansion before xpathLiteral can split or concatenate strings.
        const stepUnits = canonical
          ? '*[local-name()= and namespace-uri()=]'.length +
            literalUnits(name.localName) +
            literalUnits(name.namespaceURI) +
            ordinal.length
          : name.name.length + ordinal.length;
        units += stepUnits + 1;
        if (units > maximumUnits || units * 8 + (parts.length + 1) * 96 > reservation)
          throw new XmlError(
            'ERR_XML_INDEX_LIMIT',
            'XML element path exceeds the bounded readable-path limit',
          );
        parts.push(
          canonical
            ? `*[local-name()=${xpathLiteral(name.localName)} and namespace-uri()=${xpathLiteral(name.namespaceURI)}]${ordinal}`
            : name.name + ordinal,
        );
        id = node.parent;
      }
      return `/${parts.reverse().join('/')}`;
    } finally {
      this.release(reservation);
    }
  }

  overview(): Overview {
    const names: Overview['names'][number][] = [];
    let bytes = 0;
    try {
      // Counts are accumulated on disk by expanded name; sorting spills to FILE, never a JS dictionary.
      for (const row of this.statements.overview.iterate()) {
        // SQLite length counts Unicode scalars; two UTF-16 units per scalar is a safe upper bound.
        const weight = 128 + (row.units as number) * 2;
        this.charge(weight);
        bytes += weight;
        const value = this.statements.overviewName.get(row.id as number)!;
        const name = value.name as string;
        const namespaceURI = value.namespaceURI as string;
        names.push({ name, namespaceURI, count: row.count as number });
      }
      const totalDistinctNames = this.statements.distinctNames.get()!.count as number;
      return {
        totalElements: this.count,
        maxDepth: this.maximumDepth,
        indexBytes: this.allocatedBytes - bytes,
        names,
        totalDistinctNames,
        namesTruncated: totalDistinctNames > names.length,
      };
    } finally {
      this.release(bytes);
    }
  }

  async fuzzy(
    query: string,
    shouldCancel: () => boolean = () => false,
  ): Promise<readonly FuzzyMatch[]> {
    if (!query || shouldCancel()) return [];
    // Explicitly prepared single-name targets avoid fuzzysort's process-global string-target cache.
    const reservation = MAX_RESULTS * 64 + 512 + query.length * 128;
    this.charge(reservation);
    let outputBytes = 0;
    try {
      const best: ScoredNode[] = [];
      const count = this.count;
      let visited = 0;
      for (const row of this.statements.searchNames.iterate(this.nameCount)) {
        if (shouldCancel()) return [];
        const nameId = row.id as number;
        const units = this.statements.nameSize.get(nameId)!.units as number;
        const workBytes = 1024 + units * 130;
        this.charge(workBytes);
        let score: number | undefined;
        try {
          const name = this.name(nameId);
          const target = {
            qname: fuzzysort.prepare(name.name),
            local: fuzzysort.prepare(name.localName),
          };
          score = fuzzysort.go(query, [target], {
            keys: [(item) => item.qname, (item) => item.local],
            threshold: 0,
            limit: 1,
          })[0]?.score;
        } finally {
          fuzzysort.cleanup();
          this.release(workBytes);
        }
        if (score !== undefined) {
          for (const match of this.statements.searchNodes.iterate(nameId, count)) {
            const candidate = { elementId: match.id as number, score };
            if (best.length === MAX_RESULTS) {
              const last = best[best.length - 1]!;
              if (
                candidate.score < last.score ||
                (candidate.score === last.score && candidate.elementId >= last.elementId)
              )
                break;
            }
            best.push(candidate);
            best.sort((a, b) => b.score - a.score || a.elementId - b.elementId);
            if (best.length > MAX_RESULTS) best.pop();
          }
        }
        if (++visited % 128 === 0) await yieldToWorker();
      }
      if (shouldCancel()) return [];
      const results: FuzzyMatch[] = [];
      for (const match of best) {
        const nameId = this.uint(match.elementId, 6);
        const bytes = 96 + (this.statements.nameSize.get(nameId)!.units as number) * 2;
        this.charge(bytes);
        outputBytes += bytes;
        const label = this.name(nameId).name;
        results.push({ ...match, label });
      }
      return results;
    } finally {
      fuzzysort.cleanup();
      this.release(outputBytes + reservation);
    }
  }
}
