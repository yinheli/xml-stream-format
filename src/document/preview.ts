import { closeSync, openSync, readSync, writeSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import type { StatementSync } from 'node:sqlite';
import { DatabaseSync } from 'node:sqlite';
import stringWidth from 'string-width';
import { XmlError } from '../core/errors.js';
import type { StartData, XmlEvent } from '../core/events.js';
import { Kind } from '../core/events.js';
import { CdataSerializer, escapeAttribute, escapeText } from '../core/serialize.js';
import type { NodeIndex } from './index.js';
import type { DetailPage, DetailRequest, DetailRow } from './types.js';

const BLOCK_BYTES = 4096;
const MAX_GRAPHEME = 4096;
const MAX_RESPONSE_BYTES = 65_536;
const CACHE_BYTES = 65_536;
const WORK_BYTES = 320 * 1024;
const MAX_WRITE_BYTES = 65_536;
const INPUT_PIECE_UNITS = 1024;
const MAX_INDENT_DEPTH = 40;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

enum Lex {
  Text,
  Open,
  Bang,
  CommentPrefix,
  CdataPrefix,
  Tag,
  Single,
  Double,
  Comment,
  Cdata,
  Pi,
}

/** The high byte holds the short delimiter/prefix match, not source text. */
function advanceLexical(encoded: number, text: string): number {
  let mode = encoded & 255;
  let matched = encoded >>> 8;
  for (const character of text) {
    if (mode === Lex.Text) {
      if (character === '<') mode = Lex.Open;
    } else if (mode === Lex.Open) {
      matched = 0;
      mode =
        character === '?'
          ? Lex.Pi
          : character === '!'
            ? Lex.Bang
            : character === '>'
              ? Lex.Text
              : Lex.Tag;
    } else if (mode === Lex.Bang) {
      mode = character === '-' ? Lex.CommentPrefix : character === '[' ? Lex.CdataPrefix : Lex.Tag;
      matched = 0;
    } else if (mode === Lex.CommentPrefix) {
      mode = Lex.Comment;
      matched = 0;
    } else if (mode === Lex.CdataPrefix) {
      if (++matched === 6) {
        mode = Lex.Cdata;
        matched = 0;
      }
    } else if (mode === Lex.Tag) {
      if (character === '"') mode = Lex.Double;
      else if (character === "'") mode = Lex.Single;
      else if (character === '>') mode = Lex.Text;
    } else if (mode === Lex.Single || mode === Lex.Double) {
      if (character === (mode === Lex.Single ? "'" : '"')) mode = Lex.Tag;
    } else if (mode === Lex.Comment || mode === Lex.Cdata) {
      const delimiter = mode === Lex.Comment ? '-' : ']';
      if (character === delimiter) matched = Math.min(2, matched + 1);
      else if (character === '>' && matched === 2) {
        mode = Lex.Text;
        matched = 0;
      } else matched = 0;
    } else if (mode === Lex.Pi) {
      if (character === '>' && matched) {
        mode = Lex.Text;
        matched = 0;
      } else matched = character === '?' ? 1 : 0;
    }
  }
  return mode | (matched << 8);
}

function lexicalName(encoded: number): string {
  switch (encoded & 255) {
    case Lex.Text:
      return 'text';
    case Lex.Single:
      return 'attribute-single';
    case Lex.Double:
      return 'attribute-double';
    case Lex.Comment:
      return 'comment';
    case Lex.Cdata:
      return 'cdata';
    case Lex.Pi:
      return 'pi';
    default:
      return 'tag';
  }
}

function visible(text: string, column: number): string {
  if (text === '\t') return ' '.repeat(4 - (column % 4));
  return text.replace(
    /[\u0000-\u001f\u007f-\u009f]/gu,
    (character) => `\\x${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
}

function suffix(text: string, length: number): string {
  let start = Math.max(0, text.length - length);
  if (start && text.charCodeAt(start) >= 0xdc00 && text.charCodeAt(start) <= 0xdfff) start++;
  return text.slice(start);
}

/** Keep segmentation context, but never retain an unbounded combining sequence. */
function compactGrapheme(text: string): string {
  const head = text.slice(0, text.codePointAt(0)! > 0xffff ? 2 : 1);
  const candidate = head + suffix(text, MAX_GRAPHEME - head.length);
  const iterator = segmenter.segment(candidate)[Symbol.iterator]();
  iterator.next();
  if (iterator.next().done) return candidate;
  // Removing the middle can expose a boundary (for example in a ZWJ sequence).
  // Its final complete cluster carries the continuation context for the next feed.
  let last = '';
  for (const part of segmenter.segment(suffix(text, MAX_GRAPHEME))) last = part.segment;
  return last;
}

interface Checkpoint {
  byte: number;
  line: number;
  column: number;
  lexical: number;
  tail: string;
  tailStart: number;
  tailState: number;
  huge: boolean;
}
interface DisplaySegment {
  start: number;
  end: number;
  line: number;
  column: number;
  width: number;
  text: string;
  state: number;
  huge: boolean;
}

export interface PreviewFragment {
  row: DetailRow;
  start: number;
  end: number;
}
interface RowRead extends PreviewFragment {
  cost: number;
}

/** At most one unfinished, bounded grapheme survives a feed. */
class DisplayScanner {
  byte = 0;
  line = 0;
  column = 0;
  lexical = Lex.Text as number;
  tail = '';
  tailStart = 0;
  tailState = Lex.Text as number;
  huge = false;

  constructor(checkpoint?: Checkpoint) {
    if (checkpoint) Object.assign(this, checkpoint);
  }

  snapshot(): Checkpoint {
    return {
      byte: this.byte,
      line: this.line,
      column: this.column,
      lexical: this.lexical,
      tail: this.tail,
      tailStart: this.tailStart,
      tailState: this.tailState,
      huge: this.huge,
    };
  }

  feed(
    text: string,
    emit: (part: DisplaySegment) => boolean,
    newline?: (scanner: DisplayScanner) => void,
    final = false,
  ): boolean {
    const oldTail = this.tail;
    const oldHuge = this.huge;
    const oldByte = this.byte;
    const joined = oldTail + text;
    const segments = segmenter.segment(joined);
    const iterator = segments[Symbol.iterator]();
    let current = iterator.next();
    let first = true;
    let start = oldTail ? this.tailStart : oldByte;
    this.tail = '';
    this.huge = false;
    while (!current.done) {
      const next = iterator.next();
      const value = current.value.segment;
      const wasHuge = first && oldHuge;
      const newText = first && oldTail ? value.slice(oldTail.length) : value;
      const end =
        first && oldTail ? oldByte + Buffer.byteLength(newText) : start + Buffer.byteLength(value);
      const state = first && oldTail ? this.tailState : this.lexical;
      const huge = wasHuge || value.length > MAX_GRAPHEME;
      if (next.done && !final && value !== '\n') {
        this.tailStart = start;
        this.tailState = state;
        this.huge = huge;
        if (huge) {
          this.lexical = advanceLexical(this.lexical, wasHuge ? newText : value);
          this.tail = compactGrapheme(value);
        } else this.tail = value;
        this.byte = end;
        return true;
      }
      this.lexical = advanceLexical(this.lexical, wasHuge ? newText : value);
      this.byte = end;
      const display = value === '\n' ? '' : huge ? '…' : visible(value, this.column);
      const width = stringWidth(display, { ambiguousIsNarrow: true });
      const part: DisplaySegment = {
        start,
        end,
        line: this.line,
        column: this.column,
        width,
        text: display,
        state,
        huge,
      };
      this.column += width;
      if (value === '\n') {
        this.line++;
        this.column = 0;
      }
      if (!emit(part)) return false;
      if (value === '\n') newline?.(this);
      first = false;
      start = end;
      current = next;
    }
    return true;
  }
}

function integer(
  value: number | undefined,
  fallback: number,
  name: string,
  minimum: number,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum)
    throw new RangeError(`${name} must be a safe integer >= ${minimum}`);
  return result;
}

/** Bound escaping/scanning work without splitting a supplementary character. */
function* inputPieces(value: string): Generator<string> {
  for (let start = 0; start < value.length; ) {
    let end = Math.min(value.length, start + INPUT_PIECE_UNITS);
    if (
      end < value.length &&
      value.charCodeAt(end - 1) >= 0xd800 &&
      value.charCodeAt(end - 1) <= 0xdbff &&
      value.charCodeAt(end) >= 0xdc00 &&
      value.charCodeAt(end) <= 0xdfff
    )
      end--;
    yield value.slice(start, end);
    start = end;
  }
}

interface PreviewElement {
  id: number;
  name: string;
  markup: boolean;
  bytes: number;
}

export class PreviewStore {
  private readonly metadata: DatabaseSync;
  private readonly savePoint: StatementSync;
  private readonly byPosition: StatementSync;
  private readonly byByte: StatementSync;
  private readonly saveLine: StatementSync;
  private readonly findLine: StatementSync;
  private lastCheckpoint = -1;
  private readonly cache = new Map<string, { page: DetailPage; bytes: number }>();
  private cacheBytes = 0;
  private closed = false;
  private finished = false;
  private readonly scanner = new DisplayScanner();
  private readonly output = Buffer.allocUnsafe(MAX_WRITE_BYTES);
  private readonly stack: PreviewElement[] = [];
  private readonly cdata = new CdataSerializer();
  private inCdata = false;
  private pendingStart = false;
  private atLineStart = true;
  private buffered = 0;
  private written = 0;
  private published = 0;

  private constructor(
    private readonly file: number,
    private readonly index: NodeIndex,
    metadataPath: string,
  ) {
    this.metadata = new DatabaseSync(metadataPath);
    try {
      this.metadata.exec(`PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-64;
        PRAGMA temp_store=FILE; PRAGMA mmap_size=0;
        CREATE TABLE checkpoints(byte INTEGER PRIMARY KEY, line INTEGER NOT NULL, column INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE INDEX checkpoint_position ON checkpoints(line,column,byte);
        CREATE TABLE lines(line INTEGER PRIMARY KEY, byte INTEGER NOT NULL);
        BEGIN`);
      this.savePoint = this.metadata.prepare('INSERT OR REPLACE INTO checkpoints VALUES(?,?,?,?)');
      this.byPosition = this.metadata.prepare(
        'SELECT data FROM checkpoints WHERE line=? AND column<=? AND byte<=? ORDER BY column DESC,byte DESC LIMIT 1',
      );
      this.byByte = this.metadata.prepare(
        'SELECT data FROM checkpoints WHERE byte<=? ORDER BY byte DESC LIMIT 1',
      );
      this.saveLine = this.metadata.prepare('INSERT OR REPLACE INTO lines VALUES(?,?)');
      this.findLine = this.metadata.prepare('SELECT byte FROM lines WHERE line=?');
      this.saveLine.run(0, 0);
    } catch (error) {
      this.metadata.close();
      throw error;
    }
  }

  private checkpoint(scanner: DisplayScanner): void {
    if (this.lastCheckpoint === scanner.byte) return;
    this.savePoint.run(
      scanner.byte,
      scanner.line,
      scanner.column,
      JSON.stringify(scanner.snapshot()),
    );
    this.lastCheckpoint = scanner.byte;
  }

  private newline(scanner: DisplayScanner): void {
    this.saveLine.run(scanner.line, scanner.byte);
    this.checkpoint(scanner);
  }

  get publishedBytes(): number {
    return this.published;
  }
  get lineCount(): number {
    return this.scanner.line + Number(!this.atLineStart || !this.published);
  }
  get isFinished(): boolean {
    return this.finished;
  }

  static begin(previewPath: string, index: NodeIndex): PreviewStore {
    index.charge(WORK_BYTES);
    let file: number;
    try {
      file = openSync(previewPath, 'wx+', 0o600);
    } catch (error) {
      index.release(WORK_BYTES);
      throw error;
    }
    let store: PreviewStore | undefined;
    try {
      store = new PreviewStore(file, index, `${previewPath}.sqlite`);
    } catch (error) {
      try {
        closeSync(file);
      } catch {
        /* already closed */
      }
      void unlink(previewPath).catch(() => undefined);
      void unlink(`${previewPath}.sqlite`).catch(() => undefined);
      index.release(WORK_BYTES);
      throw error;
    }
    try {
      store.checkpoint(store.scanner);
      index.set(0, { previewStart: 0, previewEnd: 0, startLine: 0, endLine: 0 });
      return store;
    } catch (error) {
      store.close();
      void unlink(previewPath).catch(() => undefined);
      void unlink(`${previewPath}.sqlite`).catch(() => undefined);
      index.release(WORK_BYTES);
      throw error;
    }
  }

  private get byte(): number {
    return this.written + this.buffered;
  }

  private writeBuffered(): void {
    let position = 0;
    while (position < this.buffered) {
      const written = writeSync(
        this.file,
        this.output,
        position,
        this.buffered - position,
        this.written + position,
      );
      if (!written) throw new Error('Preview write made no progress');
      position += written;
    }
    this.written += this.buffered;
    this.buffered = 0;
  }

  private append(text: string): void {
    for (const piece of inputPieces(text)) {
      const bytes = Buffer.byteLength(piece);
      if (this.buffered + bytes > MAX_WRITE_BYTES) this.writeBuffered();
      this.output.write(piece, this.buffered, bytes, 'utf8');
      this.buffered += bytes;
      if (this.scanner.byte - this.lastCheckpoint + bytes > BLOCK_BYTES)
        this.checkpoint(this.scanner);
      this.scanner.feed(
        piece,
        () => true,
        (point) => this.newline(point),
      );
      this.atLineStart = piece.endsWith('\n');
    }
  }

  private escaped(value: string, escapePiece: (piece: string) => string): void {
    for (const piece of inputPieces(value)) this.append(escapePiece(piece));
  }

  private flushStart(): void {
    if (!this.pendingStart) return;
    this.append('>');
    this.pendingStart = false;
    const element = this.stack.at(-1);
    if (element) this.index.set(element.id, { openEnd: this.byte });
  }

  /** Layout is presentation-only: source text/CDATA is never discarded or reindented. */
  private markupLine(depth: number): void {
    if (this.byte && !this.atLineStart) this.append('\n');
    // Deep elements still start inside a useful default horizontal viewport.
    this.append('  '.repeat(Math.min(depth, MAX_INDENT_DEPTH)));
  }

  private start(data: StartData): void {
    this.append('<');
    this.append(data.name);
    for (const namespace of data.namespaces) {
      this.append(namespace.prefix ? ' xmlns:' : ' xmlns');
      if (namespace.prefix) this.append(namespace.prefix);
      this.append('="');
      this.escaped(namespace.uri, escapeAttribute);
      this.append('"');
    }
    for (const attribute of data.attributes) {
      this.append(' ');
      this.append(attribute.name);
      this.append('="');
      this.escaped(attribute.value, escapeAttribute);
      this.append('"');
    }
    this.pendingStart = true;
  }

  accept(event: XmlEvent, elementId: number | undefined): void {
    if (this.closed) throw new XmlError('ERR_XML_CLOSED', 'The preview is closed');
    if (this.finished) throw new Error('The preview is already finished');
    const parent = this.stack.at(-1);
    switch (event.kind) {
      case Kind.Start: {
        if (elementId === undefined) throw new Error('Missing preview start element ID');
        this.flushStart();
        if (parent) parent.markup = true;
        this.markupLine(this.stack.length);
        this.index.set(elementId, { previewStart: this.byte, startLine: this.scanner.line });
        const bytes = 64 + event.data.name.length * 2;
        this.index.charge(bytes);
        this.stack.push({ id: elementId, name: event.data.name, markup: false, bytes });
        this.start(event.data);
        break;
      }
      case Kind.End: {
        if (!parent || parent.id !== elementId) throw new Error('Unbalanced preview element IDs');
        if (this.pendingStart) {
          this.append('/>');
          this.index.set(parent.id, { openEnd: this.byte, closeStart: this.byte });
          this.pendingStart = false;
        } else {
          if (parent.markup) this.markupLine(this.stack.length - 1);
          this.index.set(parent.id, { closeStart: this.byte });
          this.append('</');
          this.append(parent.name);
          this.append('>');
        }
        this.index.set(parent.id, { previewEnd: this.byte, endLine: this.scanner.line });
        this.stack.pop();
        this.index.release(parent.bytes);
        break;
      }
      case Kind.Text:
        if (!event.data) break;
        this.flushStart();
        if (parent) parent.markup = false;
        this.escaped(event.data, this.inCdata ? (piece) => this.cdata.text(piece) : escapeText);
        break;
      case Kind.CdataStart:
        this.flushStart();
        if (parent) parent.markup = false;
        this.inCdata = true;
        this.append(this.cdata.start());
        break;
      case Kind.CdataEnd:
        this.append(this.cdata.end());
        this.inCdata = false;
        break;
      case Kind.Comment:
        this.flushStart();
        if (parent) parent.markup = true;
        this.markupLine(this.stack.length);
        this.append('<!--');
        this.append(event.data);
        this.append('-->');
        break;
      case Kind.Pi:
        this.flushStart();
        if (parent) parent.markup = true;
        this.markupLine(this.stack.length);
        this.append('<?');
        this.append(event.data.target);
        if (event.data.value) {
          this.append(' ');
          this.append(event.data.value);
        }
        this.append('?>');
        break;
      case Kind.Declaration:
        this.markupLine(0);
        this.append(
          `<?xml version="1.0" encoding="UTF-8"${event.data.standalone === undefined ? '' : ` standalone="${event.data.standalone ? 'yes' : 'no'}"`}?>`,
        );
        break;
    }
  }

  flush(): void {
    if (this.closed) throw new XmlError('ERR_XML_CLOSED', 'The preview is closed');
    // A chunk-ending start must be visible even before its first child arrives.
    this.flushStart();
    this.writeBuffered();
    this.metadata.exec('COMMIT; BEGIN');
    this.index.set(0, {
      previewEnd: this.written,
      endLine: Math.max(0, this.scanner.line - Number(this.atLineStart && this.written > 0)),
    });
    if (this.published !== this.written) {
      this.cache.clear();
      this.cacheBytes = 0;
      this.published = this.written;
    }
  }

  finish(): void {
    if (this.closed) throw new XmlError('ERR_XML_CLOSED', 'The preview is closed');
    if (this.finished) return;
    if (this.stack.length || this.inCdata) throw new Error('Unclosed preview element');
    if (this.byte && !this.atLineStart) this.append('\n');
    this.scanner.feed('', () => true, undefined, true);
    this.flush();
    this.finished = true;
  }

  private seek(line: number, column: number, end: number): Checkpoint {
    const last = this.seekByte(end);
    if (last.line < line || (last.line === line && last.column <= column)) return last;
    // Equality on the leading index column lets SQLite seek directly to the
    // requested column instead of walking the already-indexed hidden suffix.
    const row = this.byPosition.get(line, column, end) as { data: string } | undefined;
    if (row) return JSON.parse(row.data) as Checkpoint;
    // A line may begin between checkpoints. Seek its preceding byte directly
    // through the byte primary key, never through a range of position entries.
    return this.seekByte(Math.min(end, Math.max(0, this.lineBounds(line).start - 1)));
  }

  private seekByte(byte: number): Checkpoint {
    const row = this.byByte.get(byte) as { data: string } | undefined;
    if (!row) throw new Error('Missing preview byte checkpoint');
    return JSON.parse(row.data) as Checkpoint;
  }

  position(byte: number): { line: number; column: number; state: string } {
    if (!Number.isSafeInteger(byte) || byte < 0 || byte > this.published)
      throw new RangeError('Invalid preview byte');
    const point = this.seekByte(byte);
    const scanner = new DisplayScanner(point);
    const buffer = Buffer.allocUnsafe(BLOCK_BYTES + 4);
    for (let cursor = point.byte; cursor < byte; ) {
      const length = readSync(this.file, buffer, 0, Math.min(buffer.length, byte - cursor), cursor);
      if (!length) throw new Error('Preview position read made no progress');
      let count = length;
      if (cursor + count < byte) {
        let lead = count - 1;
        while (lead > 0 && (buffer[lead]! & 0xc0) === 0x80) lead--;
        const first = buffer[lead]!;
        const expected = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
        if (count - lead < expected) count = lead;
      }
      if (!count) throw new Error('Preview position UTF-8 read made no progress');
      scanner.feed(buffer.toString('utf8', 0, count), () => true);
      cursor += count;
    }
    scanner.feed('', () => true, undefined, true);
    return { line: scanner.line, column: scanner.column, state: lexicalName(scanner.lexical) };
  }

  lineBounds(line: number): { start: number; end: number; next: number } {
    integer(line, 0, 'line', 0);
    const row = this.findLine.get(line) as { byte: number } | undefined;
    if (!row || row.byte > this.published) throw new RangeError('Invalid preview line');
    const following = this.findLine.get(line + 1) as { byte: number } | undefined;
    const next = Math.min(this.published, following?.byte ?? this.published);
    return {
      start: row.byte,
      end: following && following.byte <= this.published ? next - 1 : next,
      next,
    };
  }

  async fragment(start: number, end: number, column: number, columns: number): Promise<DetailRow> {
    return (await this.fragmentWindow(start, end, column, columns)).row;
  }

  async fragmentWindow(
    start: number,
    end: number,
    column: number,
    columns: number,
  ): Promise<PreviewFragment> {
    integer(column, 0, 'column', 0);
    integer(columns, 120, 'columns', 1);
    if (!Number.isSafeInteger(end) || end < start || end > this.published)
      throw new RangeError('Invalid preview fragment');
    const position = this.position(start);
    const bounds = this.lineBounds(position.line);
    const result = await this.readRow(
      position.line,
      position.column + column,
      Math.min(4096, columns),
      start,
      Math.min(bounds.end, end),
      MAX_RESPONSE_BYTES - 1024,
    );
    if (!result.row.state) result.row.state = position.state;
    if (!column) delete result.row.continued;
    return result;
  }

  private async readRow(
    line: number,
    column: number,
    columns: number,
    start: number,
    end: number,
    budget: number,
  ): Promise<RowRead> {
    const viewport = this.seek(line, column, end);
    const selected = this.seekByte(start);
    const checkpoint = viewport.byte >= selected.byte ? viewport : selected;
    let scanner = new DisplayScanner(checkpoint);
    const row: DetailRow = { line, text: '', ...(column ? { continued: true } : {}) };
    let used = Buffer.byteLength(JSON.stringify(row)) + 2;
    let position = checkpoint.byte;
    let done = false;
    let displayedTo = column;
    let firstByte = end;
    let lastByte = start;
    let renderedHugeStart: number | undefined;
    const right = column + columns;
    const accept = (part: DisplaySegment): boolean => {
      if (part.line > line || part.start >= end) {
        done = true;
        return false;
      }
      if (part.line < line || part.end <= start) return true;
      if (part.huge && part.start === renderedHugeStart) {
        if (part.end >= end || scanner.line > line) {
          done = true;
          return false;
        }
        return true;
      }
      if (part.column + part.width <= column && part.width !== 0) {
        row.continued = true;
        return true;
      }
      if (part.column >= right) {
        row.continued = true;
        done = true;
        return false;
      }
      // A wide grapheme straddling an edge stays intact: padding occupies its
      // visible cells instead of returning a broken emoji/combining sequence.
      const leftClip = Math.max(column - part.column, 0);
      const rightClip = Math.max(part.column + part.width - right, 0);
      const padding = ' '.repeat(Math.max(0, Math.min(part.column, right) - displayedTo));
      const clipped =
        leftClip || rightClip
          ? ' '.repeat(Math.max(0, part.width - leftClip - rightClip))
          : part.text;
      const text = padding + clipped;
      const cost = Buffer.byteLength(JSON.stringify(text)) - 2;
      if (used + cost + 128 > budget) {
        row.continued = true;
        done = true;
        return false;
      }
      if (row.state === undefined && text) row.state = lexicalName(part.state);
      row.text += text;
      firstByte = Math.min(firstByte, Math.max(start, part.start));
      lastByte = Math.max(lastByte, Math.min(end, part.end));
      used += cost;
      displayedTo = Math.max(displayedTo, part.column + part.width);
      if (leftClip || rightClip) row.continued = true;
      if (part.huge) row.truncatedGrapheme = true;
      if (part.end >= end || scanner.line > line || part.column + part.width >= right) {
        done = true;
        return false;
      }
      return true;
    };
    const buffer = Buffer.allocUnsafe(BLOCK_BYTES + 4);
    while (!done && position < end) {
      let length = readSync(
        this.file,
        buffer,
        0,
        Math.min(buffer.length, end - position),
        position,
      );
      if (!length) break;
      if (position + length < end) {
        // The final byte may be a lead byte; trim any incomplete scalar.
        let lead = length - 1;
        while (lead > 0 && (buffer[lead]! & 0xc0) === 0x80) lead--;
        const first = buffer[lead]!;
        const expected = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
        if (length - lead < expected) length = lead;
      }
      if (!length) throw new Error('Preview UTF-8 read made no progress');
      position += length;
      scanner.feed(buffer.toString('utf8', 0, length), accept);
      if (
        !done &&
        scanner.huge &&
        scanner.line === line &&
        scanner.tailStart >= start &&
        scanner.tailStart !== renderedHugeStart
      ) {
        // Show the warning immediately, then seek over the suppressed body.
        // Even a gigabyte-long combining sequence is not read into a viewport.
        accept({
          start: scanner.tailStart,
          end: scanner.byte,
          line,
          column: scanner.column,
          width: 1,
          text: '…',
          state: scanner.tailState,
          huge: true,
        });
        renderedHugeStart = scanner.tailStart;
        const later = this.seek(line, scanner.column, end);
        if (!done && later.byte > position && later.huge && later.tailStart === scanner.tailStart) {
          scanner = new DisplayScanner(later);
          position = later.byte;
        }
      }
    }
    if (!done) scanner.feed('', accept, undefined, true);
    return {
      row,
      cost: Buffer.byteLength(JSON.stringify(row)) + 2,
      start: firstByte,
      end: Math.max(firstByte, lastByte),
    };
  }

  async rows(request: DetailRequest): Promise<DetailPage> {
    if (this.closed) throw new XmlError('ERR_XML_CLOSED', 'The preview is closed');
    const selected = this.index.get(request.elementId);
    const open = !this.finished && (request.elementId === 0 || selected.tapeEnd === 0);
    if (request.elementId !== 0 && selected.tapeEnd === 0) {
      const document = this.index.get(0);
      selected.previewEnd = document.previewEnd;
      selected.endLine = document.endLine;
    }
    const desiredStartLine = Math.max(
      selected.startLine,
      integer(request.startLine, selected.startLine, 'startLine', 0),
    );
    const startLine = Math.min(selected.endLine, desiredStartLine);
    const backward = request.endLine !== undefined;
    const endLine = Math.min(
      selected.endLine,
      Math.max(selected.startLine, integer(request.endLine, selected.endLine, 'endLine', 0)),
    );
    const count = Math.min(256, integer(request.lineCount, 40, 'lineCount', 1));
    const column = integer(request.column, 0, 'column', 0);
    const columns = Math.min(4096, integer(request.columns, 120, 'columns', 1));
    if (!Number.isSafeInteger(column + columns))
      throw new RangeError('The detail column range exceeds the safe integer limit');
    const needsMore = open && !backward && desiredStartLine > selected.endLine - count * 2 + 1;
    const key = `${request.elementId}:${backward ? 'end' : 'start'}:${backward ? endLine : desiredStartLine}:${count}:${column}:${columns}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.page.needsMore === needsMore ? cached.page : { ...cached.page, needsMore };
    }
    const rows: DetailRow[] = [];
    let remaining = MAX_RESPONSE_BYTES - 512;
    const firstLine = backward ? Math.max(selected.startLine, endLine - count + 1) : startLine;
    const lastLine = backward ? endLine : Math.min(selected.endLine, startLine + count - 1);
    for (
      let line = backward ? lastLine : firstLine;
      line >= firstLine && line <= lastLine && remaining >= 256;
      line += backward ? -1 : 1
    ) {
      const result = await this.readRow(
        line,
        column,
        columns,
        selected.previewStart,
        selected.previewEnd,
        remaining,
      );
      rows.push(result.row);
      remaining -= result.cost;
    }
    if (backward) rows.reverse();
    const pageStart = rows[0]?.line ?? startLine;
    const page: DetailPage = {
      rows,
      startLine: pageStart,
      endLine: rows.at(-1)?.line ?? pageStart,
      totalLines: selected.endLine - selected.startLine + 1,
      column,
      needsMore,
    };
    const bytes =
      Buffer.byteLength(JSON.stringify(page)) +
      rows.reduce((sum, row) => sum + row.text.length * 2 + 128, 0);
    while (this.cacheBytes + bytes > CACHE_BYTES && this.cache.size) {
      const oldest = this.cache.keys().next().value!;
      this.cacheBytes -= this.cache.get(oldest)!.bytes;
      this.cache.delete(oldest);
    }
    if (bytes <= CACHE_BYTES) {
      this.cache.set(key, { page, bytes });
      this.cacheBytes += bytes;
    }
    return page;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cache.clear();
    this.cacheBytes = 0;
    try {
      this.metadata.exec('COMMIT');
    } finally {
      try {
        this.metadata.close();
      } finally {
        this.index.release(WORK_BYTES);
        for (const frame of this.stack) this.index.release(frame.bytes);
        this.stack.length = 0;
        closeSync(this.file);
      }
    }
  }
}
