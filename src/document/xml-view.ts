import { Buffer } from 'node:buffer';
import stringWidth from 'string-width';
import { XmlError } from '../core/errors.js';
import type { NodeIndex } from './index.js';
import type { PreviewStore } from './preview.js';
import type { XmlHit, XmlPage, XmlRequest, XmlRow } from './types.js';

const NONE = 0xffff_ffff;
const RESPONSE_BYTES = 65_536;
const WORK_BYTES = 192 * 1024;
const MAX_HITS = 256;
const pathSegments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
interface SourcePart {
  start: number;
  end: number;
}
interface LiteralPart {
  text: string;
  elementId: number;
  muted?: boolean;
}
interface Layout {
  anchor: number;
  line: number;
  elementId: number;
  foldElementId?: number;
  foldable: boolean;
  expanded: boolean;
  incomplete: boolean;
  blocked: boolean;
  next: number;
  parts: readonly (SourcePart | LiteralPart)[];
}

function integer(
  value: number | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum)
    throw new RangeError(`${name} must be a safe integer from ${minimum} through ${maximum}`);
  return result;
}

/** Source anchors, rather than retained row history, make reverse traversal bounded. */
export class FoldedXmlView {
  private first = 0;
  private cursor = 0;
  private selectedId = 0;
  private initialized = false;
  private lastRows: readonly XmlRow[] = [];
  private closed = false;

  constructor(
    private readonly index: NodeIndex,
    private readonly preview: PreviewStore,
  ) {
    index.charge(WORK_BYTES);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lastRows = [];
    this.index.release(WORK_BYTES);
  }

  private canonical(byte: number): number {
    if (!this.preview.publishedBytes) return 0;
    const position = this.preview.position(Math.min(byte, this.preview.publishedBytes - 1));
    const opening = this.index.startingAtLine(position.line);
    const owner = opening ?? this.index.ownerAtPreview(byte);
    let collapsed = this.index.collapsedAncestor(owner);
    if (collapsed === undefined) {
      const bounds = this.preview.lineBounds(position.line);
      // A folded row also owns its closing line's parent suffix. At the final
      // newline ownerAtPreview already points at the parent, so use the first
      // closing node (all closes on a formatted line form an ancestor chain).
      const ending = this.index.endingBetween(bounds.start, bounds.end, 1)[0];
      if (ending !== undefined) collapsed = this.index.collapsedAncestor(ending);
    }
    return this.preview.lineBounds(
      collapsed === undefined ? position.line : this.index.get(collapsed).startLine,
    ).start;
  }

  private layout(byte: number): Layout {
    const anchor = this.canonical(byte);
    const line = this.preview.position(anchor).line;
    const bounds = this.preview.lineBounds(line);
    const opening = this.index.startingAtLine(line);
    const elementId = opening ?? this.index.ownerAtPreview(anchor);
    const node = this.index.get(elementId);
    const foldable = elementId !== 0 && (node.directChildCount > 0 || node.tapeEnd === 0);
    const expanded = !foldable || this.index.isExpanded(elementId);
    const incomplete = elementId !== 0 && node.tapeEnd === 0;
    const result: Layout = {
      anchor,
      line,
      elementId,
      foldable,
      expanded,
      incomplete,
      blocked: false,
      next: bounds.next,
      parts: [{ start: bounds.start, end: bounds.end }],
      ...(opening !== undefined && foldable ? { foldElementId: opening } : {}),
    };
    if (
      opening !== undefined &&
      !foldable &&
      node.openEnd &&
      node.closeStart === node.openEnd &&
      node.previewEnd > node.openEnd
    ) {
      const closing = this.preview.lineBounds(this.preview.position(node.previewEnd).line);
      result.parts = [
        { start: bounds.start, end: node.openEnd - 1 },
        { text: '/>', elementId },
        { start: node.previewEnd, end: closing.end },
      ];
      result.next = closing.next;
      return result;
    }
    if (opening === undefined || !foldable || expanded || !node.openEnd) return result;
    const header = { start: bounds.start, end: Math.min(bounds.end, node.openEnd) };
    if (incomplete) {
      result.parts = [header, { text: ' … [incomplete]', elementId, muted: true }];
      result.blocked = true;
      result.next = this.preview.publishedBytes;
    } else {
      const closing = this.preview.lineBounds(this.preview.position(node.closeStart).line);
      result.parts = [
        header,
        { text: ' … ', elementId, muted: true },
        { start: node.closeStart, end: closing.end },
      ];
      result.next = closing.next;
    }
    return result;
  }

  private previous(anchor: number): number | undefined {
    const start = this.canonical(anchor);
    return start ? this.canonical(start - 1) : undefined;
  }

  private next(anchor: number): number | undefined {
    const row = this.layout(anchor);
    return row.next < this.preview.publishedBytes ? this.canonical(row.next) : undefined;
  }

  private canReadAfter(anchor: number): boolean {
    if (this.preview.isFinished) return false;
    // A blocked frontier row is readable: filling the viewport finishes the element
    // being written. Only an unfinished folded root must not be scanned for blank
    // rows; a closed root can still be followed by document comments or PIs.
    const row = this.layout(anchor);
    if (row.elementId && !row.expanded) {
      const node = this.index.get(row.elementId);
      if (node.parent === 0 && node.tapeEnd === 0) return false;
    }
    return true;
  }

  private select(anchor: number, id?: number): void {
    this.cursor = this.canonical(anchor);
    this.selectedId = id ?? this.layout(this.cursor).elementId;
  }

  private async render(layout: Layout, column: number, columns: number): Promise<XmlRow> {
    const row: XmlRow = {
      key: `x:${layout.anchor}`,
      line: layout.line,
      text: '',
      elementId: layout.elementId,
      foldable: layout.foldable,
      expanded: layout.expanded,
      incomplete: layout.incomplete,
      ...(layout.foldElementId === undefined ? {} : { foldElementId: layout.foldElementId }),
      hits: [],
    };
    const hits: XmlHit[] = [];
    let logical = 0;
    let output = 0;
    for (const part of layout.parts) {
      const source = 'start' in part;
      const startPosition = source ? this.preview.position(part.start) : undefined;
      const width = source
        ? this.preview.position(part.end).column - startPosition!.column
        : stringWidth(part.text, { ambiguousIsNarrow: true });
      const left = Math.max(0, column - logical);
      const take = Math.min(width - left, columns - output);
      if (take > 0) {
        if (hits.length >= MAX_HITS) {
          row.continued = true;
          break;
        }
        if (!source) {
          const text = part.text.slice(left, left + take);
          row.text += text;
          if (!part.muted)
            hits.push({ from: output, to: output + text.length, elementId: part.elementId });
          output += text.length;
          row.state ??= 'text';
        } else {
          const window = await this.preview.fragmentWindow(part.start, part.end, left, take);
          const endings = this.index.endingBetween(
            window.start,
            window.end,
            MAX_HITS - hits.length,
          );
          let safeEnd = part.end;
          if (endings.length === MAX_HITS - hits.length)
            safeEnd = Math.min(safeEnd, this.index.get(endings.at(-1)!).closeStart);
          const boundaries: number[] = [window.start];
          for (const id of endings) {
            const node = this.index.get(id);
            if (node.previewEnd < safeEnd) boundaries.push(node.previewEnd);
          }
          let ancestor = this.index.ownerAtPreview(window.start);
          let ancestorEnds = 0;
          while (ancestor !== 0 && ancestor !== NONE) {
            const node = this.index.get(ancestor);
            if (node.previewEnd === 0 || node.previewEnd >= Math.min(window.end, safeEnd)) break;
            if (node.previewEnd > window.start && node.previewEnd < Math.min(window.end, safeEnd)) {
              if (++ancestorEnds >= MAX_HITS - hits.length) {
                safeEnd = node.previewEnd;
                break;
              }
              boundaries.push(node.previewEnd);
            }
            ancestor = node.parent;
          }
          let opening = this.index.startingAtOrAfter(window.start);
          let openings = 0;
          while (
            opening !== undefined &&
            this.index.get(opening).previewStart < Math.min(window.end, safeEnd)
          ) {
            const node = this.index.get(opening);
            if (++openings >= MAX_HITS - hits.length) {
              safeEnd = Math.min(safeEnd, node.previewStart);
              break;
            }
            boundaries.push(node.previewStart);
            opening = this.index.startingAtOrAfter(node.previewStart + 1);
          }
          boundaries.push(Math.min(window.end, safeEnd));
          boundaries.sort((a, b) => a - b);
          const detail =
            safeEnd < window.end
              ? await this.preview.fragment(part.start, safeEnd, left, take)
              : window.row;
          const rendered = stringWidth(detail.text, { ambiguousIsNarrow: true });
          const viewportColumn = startPosition!.column + left;
          for (let index = 0; index + 1 < boundaries.length && hits.length < MAX_HITS; index++) {
            const byte = boundaries[index]!;
            const after = boundaries[index + 1]!;
            if (after <= byte) continue;
            const from = Math.max(0, this.preview.position(byte).column - viewportColumn);
            const to = Math.min(rendered, this.preview.position(after).column - viewportColumn);
            if (to > from) {
              const elementId = this.index.ownerAtPreview(byte);
              const previous = hits.at(-1);
              if (previous?.elementId === elementId && previous.to === output + from)
                previous.to = output + to;
              else hits.push({ from: output + from, to: output + to, elementId });
            }
          }
          // If metadata fills the hit budget, show only the cells whose owner is
          // represented. An unmapped suffix must never select an ancestor.
          const mapped = Math.max(0, (hits.at(-1)?.to ?? output) - output);
          if (mapped < rendered) {
            const clipped = await this.preview.fragment(
              part.start,
              safeEnd,
              left,
              Math.max(1, mapped),
            );
            row.text += mapped ? clipped.text : '';
            output += mapped;
            row.continued = true;
            break;
          }
          row.text += detail.text;
          output += rendered;
          row.state ??= detail.state;
          if (detail.truncatedGrapheme) row.truncatedGrapheme = true;
          if (safeEnd < part.end || rendered < take) {
            row.continued = true;
            break;
          }
        }
      }
      logical += width;
      if (output >= columns) {
        if (logical > column + columns || part !== layout.parts.at(-1)) row.continued = true;
        break;
      }
    }
    if (column) row.continued = true;
    row.hits = hits;
    return row;
  }

  async rows(request: XmlRequest): Promise<XmlPage> {
    const limit = integer(request.limit, 40, 'limit', 1, 256);
    const columns = integer(request.columns, 120, 'columns', 1, 4096);
    const column = integer(request.column, 0, 'column', 0);
    if (!Number.isSafeInteger(column + columns))
      throw new RangeError('XML column range exceeds the safe integer limit');
    const steps = integer(
      request.steps,
      request.move === 'pageDown' || request.move === 'pageUp' ? limit : 1,
      'steps',
      0,
      4096,
    );
    const scroll = integer(request.scroll, 0, 'scroll', -4096, 4096);
    if (!this.preview.publishedBytes)
      return {
        rows: [],
        selectedId: 0,
        selectedRow: -1,
        totalElements: this.index.count,
        path: '/',
        pathTruncated: false,
        column,
        needsMore: !this.preview.isFinished && request.move !== 'last',
        ...(!this.preview.isFinished && request.move !== 'last' && (request.move || scroll)
          ? { continuation: { ...request } }
          : {}),
      };
    if (!this.initialized) {
      this.select(0);
      this.initialized = true;
    }
    this.first = this.canonical(this.first);
    const canonicalCursor = this.canonical(this.cursor);
    if (canonicalCursor !== this.cursor) this.select(canonicalCursor);
    if (request.selectKey !== undefined) {
      let accepted = false;
      const clicked = this.lastRows.find((row) => row.key === request.selectKey);
      if (clicked) {
        const id = request.selectedId;
        if (
          id === undefined ||
          id === clicked.elementId ||
          id === clicked.foldElementId ||
          clicked.hits.some((hit) => hit.elementId === id)
        ) {
          this.select(Number(clicked.key.slice(2)), id ?? clicked.elementId);
          accepted = true;
        }
      }
      if (!accepted) request = { limit, columns, column, loadMore: request.loadMore };
    } else if (request.selectedId !== undefined) {
      const node = this.index.get(request.selectedId);
      this.index.reveal(request.selectedId);
      this.select(this.preview.lineBounds(node.startLine).start, request.selectedId);
    }
    // Drop the previous response before constructing its bounded replacement.
    this.lastRows = [];
    let continuation: XmlRequest | undefined;
    let movementNeedsMore = false;
    const continueWith = (pending: XmlRequest): void => {
      movementNeedsMore = true;
      continuation = { ...pending, loadMore: request.loadMore, limit, columns, column };
    };
    const moveRows = (direction: 1 | -1, count: number, scrolling: boolean): void => {
      for (let done = 0; done < count; done++) {
        const anchor = scrolling ? this.first : this.cursor;
        const candidate = direction > 0 ? this.next(anchor) : this.previous(anchor);
        if (candidate === undefined) {
          if (direction > 0 && this.canReadAfter(anchor))
            continueWith(
              scrolling ? { scroll: count - done } : { move: request.move, steps: count - done },
            );
          break;
        }
        if (scrolling) this.first = candidate;
        else this.select(candidate);
      }
    };
    if (scroll) moveRows(scroll > 0 ? 1 : -1, Math.abs(scroll), true);
    if (request.move === 'first') {
      this.first = 0;
      this.select(0);
    } else if (request.move === 'last') {
      this.select(this.canonical(this.preview.publishedBytes - 1));
    } else if (request.move === 'next' || request.move === 'pageDown') moveRows(1, steps, false);
    else if (request.move === 'previous' || request.move === 'pageUp') moveRows(-1, steps, false);
    else if (request.move) {
      const node = this.index.get(this.selectedId);
      const foldable = this.selectedId !== 0 && (node.directChildCount > 0 || node.tapeEnd === 0);
      if (request.move === 'toggle') {
        if (foldable)
          this.index.setExpanded(this.selectedId, !this.index.isExpanded(this.selectedId));
      } else if (request.move === 'left') {
        if (foldable && this.index.isExpanded(this.selectedId))
          this.index.setExpanded(this.selectedId, false);
        else if (node.parent !== NONE && node.parent !== 0)
          this.select(this.index.get(node.parent).previewStart, node.parent);
      } else if (request.move === 'right') {
        if (foldable && !this.index.isExpanded(this.selectedId))
          this.index.setExpanded(this.selectedId, true);
        else if (node.firstChild !== NONE)
          this.select(this.index.get(node.firstChild).previewStart, node.firstChild);
        else if (foldable && !node.tapeEnd) continueWith({ move: 'right' });
      } else {
        const sibling = request.move === 'nextSibling' ? node.nextSibling : node.previousSibling;
        if (sibling !== NONE) this.select(this.index.get(sibling).previewStart, sibling);
        else if (
          request.move === 'nextSibling' &&
          node.parent !== 0 &&
          node.parent !== NONE &&
          !this.index.get(node.parent).tapeEnd
        )
          continueWith({ move: 'nextSibling' });
      }
      this.cursor = this.canonical(this.cursor);
      this.first = this.canonical(this.first);
    }
    const keepCursorVisible = Boolean(
      request.move || request.selectedId !== undefined || request.selectKey !== undefined,
    );
    if (keepCursorVisible && this.cursor < this.first) this.first = this.cursor;
    let path = '/';
    let pathTruncated = false;
    if (this.selectedId) {
      try {
        path = this.index.treeRows({ selectedId: this.selectedId, limit: 1, loadMore: false }).path;
      } catch (error) {
        if (!(error instanceof XmlError) || error.code !== 'ERR_XML_INDEX_LIMIT') throw error;
        path = '[path exceeds display work limit]';
        pathTruncated = true;
      }
      if (Buffer.byteLength(path) > 4096) {
        let bounded = '';
        let bytes = 0;
        for (const part of pathSegments.segment(path)) {
          const cost = Buffer.byteLength(part.segment);
          if (bytes + cost + 3 > 4096) break;
          bounded += part.segment;
          bytes += cost;
        }
        path = `${bounded}…`;
        pathTruncated = true;
      }
    }
    const rows: XmlRow[] = [];
    const rowBudget =
      RESPONSE_BYTES -
      Buffer.byteLength(JSON.stringify({ path, pathTruncated, continuation })) -
      1024;
    const renderPage = async (backwards: boolean): Promise<void> => {
      rows.length = 0;
      let anchor = backwards ? this.cursor : this.first;
      let remaining = rowBudget;
      for (let count = 0; count < limit && remaining >= 512; count++) {
        const layout = this.layout(anchor);
        let renderColumns = columns;
        let row = await this.render(layout, column, renderColumns);
        let bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
        // The cursor row always fits on its own. Backfilling must not squeeze
        // preceding rows just to consume the final bytes of the page.
        while (bytes > remaining && renderColumns > 1 && (!backwards || count === 0)) {
          renderColumns = Math.max(1, Math.floor(renderColumns / 2));
          row = await this.render(layout, column, renderColumns);
          row.continued = true;
          bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
        }
        if (bytes > remaining) break;
        if (backwards) {
          rows.unshift(row);
          this.first = anchor;
        } else {
          rows.push(row);
        }
        remaining -= bytes;
        const candidate = backwards ? this.previous(anchor) : this.next(anchor);
        if (candidate === undefined) break;
        anchor = candidate;
      }
    };
    const page: XmlPage = {
      rows,
      selectedId: this.selectedId,
      selectedRow: -1,
      path,
      pathTruncated,
      totalElements: this.index.count,
      column,
      needsMore: movementNeedsMore,
      ...(continuation ? { continuation } : {}),
    };
    const trimPage = (backwards: boolean): void => {
      // Include all wire metadata, and preserve the cursor at the end of a
      // backfilled replacement rather than trimming it away again.
      while (rows.length && Buffer.byteLength(JSON.stringify(page)) > RESPONSE_BYTES) {
        if (backwards) rows.shift();
        else rows.pop();
      }
      if (rows.length) this.first = Number(rows[0]!.key.slice(2));
      page.selectedRow = rows.findIndex((row) => row.key === `x:${this.cursor}`);
    };
    await renderPage(false);
    trimPage(false);
    // Logical row counts cannot establish visibility: wide values or hit/path
    // metadata can exhaust the response budget before the cursor. Keyboard,
    // absolute and reveal intents replace that page with bounded real rows
    // ending at the cursor. Scroll-only requests deliberately keep selection
    // offscreen, including during subsequent passive refreshes.
    if (keepCursorVisible && page.selectedRow < 0) {
      await renderPage(true);
      trimPage(true);
    }
    const last = rows.length ? this.layout(Number(rows.at(-1)!.key.slice(2))) : undefined;
    const fillNeedsMore =
      request.move !== 'last' &&
      rows.length < limit &&
      last !== undefined &&
      this.next(last.anchor) === undefined &&
      this.canReadAfter(last.anchor);

    page.needsMore = movementNeedsMore || fillNeedsMore;
    this.lastRows = rows;
    return page;
  }
}
