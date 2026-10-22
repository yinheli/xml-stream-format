import { Content } from '../../src/core/events.js';
import { escapeText } from '../../src/core/serialize.js';
import { xpathLiteral } from '../../src/xpath/paths.js';
import type { Row, RowPart } from './protocol.js';
import { CDATA, COMMENT, ELEMENT, HAS_MARKUP, type NodeStore, PI, TEXT } from './store.js';

/** Row positions are `node * 2 + (closing row ? 1 : 0)`; negatives are sentinels. */
export const NEED = -2;
export const EDGE = -1;
const LEAF_CAP = 1024;

function displayText(value: string): string {
  return escapeText(value.replace(/\s*\n\s*/g, ' '));
}

/**
 * Folding and row linearization over the append-only index, mirroring the terminal
 * browser: one viewport with opening tags, inline leaf values and real closing tags.
 * Every method is synchronous; `NEED` means more of the document must be parsed.
 */
export class FoldedRows {
  level = 3;
  final = false;
  readonly overrides = new Map<number, boolean>();

  constructor(private readonly store: NodeStore) {}

  /** Leaf/empty elements render inline; containers have child markup. */
  shapeKnown(node: number): boolean {
    return this.store.end[node] !== 0 || (this.store.info[node]! & HAS_MARKUP) !== 0;
  }

  isContainer(node: number): boolean {
    return this.store.kind[node] === ELEMENT && (this.store.info[node]! & HAS_MARKUP) !== 0;
  }

  expanded(node: number): boolean {
    return this.overrides.get(node) ?? this.store.depth[node]! + 1 < this.level;
  }

  isOpen(node: number): boolean {
    return this.isContainer(node) && this.expanded(node);
  }

  setExpanded(node: number, expanded: boolean): void {
    if (expanded === this.store.depth[node]! + 1 < this.level) this.overrides.delete(node);
    else this.overrides.set(node, expanded);
  }

  next(position: number): number {
    const node = position >> 1;
    if (!(position & 1) && this.store.kind[node] === ELEMENT) {
      if (!this.shapeKnown(node)) return NEED;
      if (this.isOpen(node)) return (node + 1) * 2;
    }
    return this.after(node);
  }

  /** A folded element whose end tag is not indexed yet: rows after it need a scan. */
  blocksFill(position: number): boolean {
    const node = position >> 1;
    return (
      !(position & 1) && this.isContainer(node) && !this.expanded(node) && !this.store.end[node]
    );
  }

  /** The row after a node's complete subtree. */
  after(node: number): number {
    const { store } = this;
    if (store.kind[node] === ELEMENT && !store.end[node]) return NEED;
    const following = store.following(node);
    const parent = store.parent[node]!;
    if (following < store.count) {
      return store.parent[following] === parent ? following * 2 : parent * 2 + 1;
    }
    if (parent < 0) return this.final ? EDGE : NEED;
    if (store.end[parent]) return parent * 2 + 1;
    return this.final ? EDGE : NEED;
  }

  previous(position: number): number {
    const { store } = this;
    const node = position >> 1;
    if (position & 1) return this.lastRow(this.lastChild(node));
    if (node === 0) return EDGE;
    const parent = store.parent[node]!;
    if (node - 1 === parent) return parent * 2;
    let sibling = node - 1;
    while (store.parent[sibling] !== parent) sibling = store.parent[sibling]!;
    return this.lastRow(sibling);
  }

  /** Last indexed child of an element (ancestor-or-self of the subtree's last node). */
  lastChild(node: number): number {
    const { store } = this;
    let child = (store.end[node] || store.count) - 1;
    if (child <= node) return -1;
    while (store.parent[child] !== node) child = store.parent[child]!;
    return child;
  }

  /** Last visible row inside a node's subtree, stopping at the indexed frontier. */
  lastRow(node: number): number {
    const { store } = this;
    if (node < 0) return EDGE;
    if (!this.isOpen(node)) return node * 2;
    if (store.end[node]) return node * 2 + 1;
    const child = this.lastChild(node);
    return child < 0 ? node * 2 : this.lastRow(child);
  }

  /** G/End: the indexed visible frontier, never file EOF. */
  frontier(): number {
    const { store } = this;
    if (!store.count) return EDGE;
    let top = store.count - 1;
    while (store.parent[top]! >= 0) top = store.parent[top]!;
    return this.lastRow(top);
  }

  /** Map a position to its visible owner after folds change. */
  visible(position: number): number {
    const { store } = this;
    const node = position >> 1;
    let owner = node;
    for (let ancestor = store.parent[node]!; ancestor >= 0; ancestor = store.parent[ancestor]!) {
      if (!this.isOpen(ancestor)) owner = ancestor;
    }
    if (owner !== node) return owner * 2;
    if (position & 1 && !(this.isOpen(node) && store.end[node])) return node * 2;
    return position;
  }

  /** Row order key: a closing row sorts after its last descendant. */
  order(position: number): number {
    const node = position >> 1;
    return position & 1 ? (this.store.end[node] || this.store.count) - 0.5 : node;
  }

  render(position: number): Row {
    const { store } = this;
    const node = position >> 1;
    const depth = store.depth[node]!;
    const row = (parts: RowPart[], fold?: Row['fold']): Row =>
      fold ? { node, depth, parts, fold } : { node, depth, parts };
    if (position & 1) return row([{ text: `</${store.qname(node)}>` }]);
    const value = store.preview(node);
    switch (store.kind[node]) {
      case ELEMENT: {
        const name = store.qname(node);
        const tag = `<${name}${value}`;
        if (!this.shapeKnown(node)) return row([{ text: `${tag}>` }, { text: ' …', muted: true }]);
        if (!this.isContainer(node)) {
          if (store.end[node] === node + 1) {
            const content = store.flags[node]! & (Content.DirectText | Content.Cdata);
            return row([{ text: content ? `${tag}></${name}>` : `${tag}/>` }]);
          }
          return row([{ text: `${tag}>${this.leafValue(node)}</${name}>` }]);
        }
        if (this.expanded(node)) return row([{ text: `${tag}>` }], 'open');
        return row(
          store.end[node]
            ? [{ text: `${tag}>` }, { text: ' … ', muted: true }, { text: `</${name}>` }]
            : [{ text: `${tag}>` }, { text: ' … [incomplete]', muted: true }],
          'closed',
        );
      }
      case TEXT:
        return row([{ text: displayText(value) }]);
      case CDATA:
        return row([{ text: `<![CDATA[${value}]]>` }]);
      case COMMENT:
        return row([{ text: `<!--${value}-->` }]);
      case PI:
        return row([{ text: `<?${value}?>` }]);
      default:
        return row([{ text: value }]);
    }
  }

  private leafValue(node: number): string {
    const { store } = this;
    let value = '';
    for (let child = node + 1; child < store.end[node]! && value.length < LEAF_CAP; child++) {
      const text = store.preview(child);
      value += store.kind[child] === CDATA ? `<![CDATA[${text}]]>` : displayText(text);
    }
    return value.length > LEAF_CAP ? `${value.slice(0, LEAF_CAP)}…` : value;
  }

  /** The element that owns a row: itself, or the parent of text/comment rows. */
  owner(node: number): number {
    return this.store.kind[node] === ELEMENT ? node : this.store.parent[node]!;
  }

  /** Readable (`/a/b[2]`) or canonical namespace-independent XPath of an element. */
  path(node: number, canonical: boolean): string {
    const { store } = this;
    const steps: string[] = [];
    for (let element = this.owner(node); element >= 0; element = store.parent[element]!) {
      const name = store.names[store.name[element]!]!;
      const { ordinal, shared } = this.sameNameOrdinal(element);
      steps.push(
        canonical
          ? `*[local-name()=${xpathLiteral(name.local)} and namespace-uri()=${xpathLiteral(name.ns)}][${ordinal}]`
          : ordinal > 1 || shared
            ? `${name.qname}[${ordinal}]`
            : name.qname,
      );
    }
    return `/${steps.reverse().join('/')}`;
  }

  private sameNameOrdinal(element: number): { ordinal: number; shared: boolean } {
    const { store } = this;
    const parent = store.parent[element]!;
    const expanded = store.names[store.name[element]!]!.expanded;
    const same = (node: number) =>
      store.kind[node] === ELEMENT && store.names[store.name[node]!]!.expanded === expanded;
    let ordinal = 1;
    for (let sibling = parent + 1; sibling < element; sibling = store.following(sibling))
      if (same(sibling)) ordinal++;
    let shared = ordinal > 1;
    for (
      let sibling = store.following(element);
      !shared && sibling < store.count && store.parent[sibling] === parent;
      sibling = store.following(sibling)
    )
      shared = same(sibling);
    return { ordinal, shared };
  }
}
