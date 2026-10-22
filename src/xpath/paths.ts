import type { Attr, Element, Node } from 'slimdom';
import { XmlError } from '../core/errors.js';
import type { DomDocument } from './dom-builder.js';

/** XPath string literals have no backslash escaping. */
export function xpathLiteral(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat(${value
    .split("'")
    .map((part) => `'${part}'`)
    .join(`, "'", `)})`;
}

/** An absolute selector independent of source prefixes and caller namespaces. */
export function canonicalXPath(node: Node, dom: DomDocument): string {
  const ref = dom.refs.get(node);
  if (!ref)
    throw new XmlError('ERR_XPATH_RESULT_TYPE', 'XPath result is not a source document node');
  if (ref.kind === 'document') return '/';

  const steps: string[] = [];
  let current: Node | null = node;
  if (ref.kind === 'attribute') {
    steps.push(
      `@*[local-name()=${xpathLiteral(ref.localName)} and namespace-uri()=${xpathLiteral(ref.namespaceURI)}]`,
    );
    current = (node as Attr).ownerElement;
  } else if (ref.kind === 'text') {
    steps.push(`text()[${ref.textRunOrdinal}]`);
    current = node.parentNode;
  } else if (ref.kind === 'comment' || ref.kind === 'processing-instruction') {
    steps.push(
      `${ref.kind === 'comment' ? 'comment()' : 'processing-instruction()'}[${ref.ordinal}]`,
    );
    current = node.parentNode;
  }

  while (current && current !== dom.document) {
    const currentRef = dom.refs.get(current);
    const ordinal = dom.ordinals.get(current);
    if (currentRef?.kind !== 'element' || ordinal === undefined) {
      throw new XmlError('ERR_XPATH_RESULT_TYPE', 'XPath result has no source element path');
    }
    const element = current as Element;
    steps.push(
      `*[local-name()=${xpathLiteral(element.localName)} and namespace-uri()=${xpathLiteral(element.namespaceURI ?? '')}][${ordinal}]`,
    );
    current = current.parentNode;
  }
  if (!current)
    throw new XmlError(
      'ERR_XPATH_RESULT_TYPE',
      'XPath result is detached from the source document',
    );
  return `/${steps.reverse().join('/')}`;
}

const LABEL_GRAPHEMES = 160;
const LABEL_CODE_UNITS = 1024;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function boundedLabel(parts: readonly string[]): string {
  let value = '';
  let truncated = false;
  for (const part of parts) {
    const remaining = LABEL_CODE_UNITS - value.length;
    if (part.length > remaining) {
      let end = remaining;
      const last = part.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end--;
      value += part.slice(0, end);
      truncated = true;
      break;
    }
    value += part;
  }
  value = value.replace(/[\t\r\n]/g, ' ');
  const segments: string[] = [];
  for (const entry of graphemes.segment(value)) {
    if (segments.length === LABEL_GRAPHEMES) {
      return `${segments.slice(0, LABEL_GRAPHEMES - 1).join('')}…`;
    }
    segments.push(entry.segment);
  }
  if (!truncated) return value;
  // The final segment may continue beyond the bounded input prefix. Drop it
  // rather than retaining a partial (or arbitrarily large) combining cluster.
  return `${segments.slice(0, Math.min(segments.length - 1, LABEL_GRAPHEMES - 1)).join('')}…`;
}

/** Bounded summaries, never textContent or serialization of an element subtree. */
export function nodeLabel(node: Node): string {
  switch (node.nodeType) {
    case 9:
      return '#document';
    case 1:
      return boundedLabel(['<', node.nodeName, '>']);
    case 2:
      return boundedLabel(['@', node.nodeName, '="', node.nodeValue ?? '', '"']);
    case 3:
      return boundedLabel(['text() "', node.nodeValue ?? '', '"']);
    case 8:
      return boundedLabel(['<!--', node.nodeValue ?? '', '-->']);
    case 7: {
      const value = node.nodeValue ?? '';
      return boundedLabel(['<?', node.nodeName, value ? ' ' : '', value, '?>']);
    }
    default:
      return boundedLabel([node.nodeName]);
  }
}
