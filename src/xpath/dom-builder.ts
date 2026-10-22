import type { Node } from 'slimdom';
import { Document, Element } from 'slimdom';
import { XmlError } from '../core/errors.js';
import type { XmlEvent } from '../core/events.js';
import { Kind, XMLNS_NS } from '../core/events.js';
import type { XmlNodeRef } from '../document/types.js';

export interface DomDocument {
  document: Document;
  refs: WeakMap<Node, XmlNodeRef>;
  ordinals: WeakMap<Node, number>;
}

interface ParentFrame {
  node: Document | Element;
  id: number;
  elementOrdinals?: Map<string, number>;
  textOrdinal: number;
  commentOrdinal: number;
  piOrdinal: number;
}

/** Builds the query DOM from source events, never from the formatted preview. */
export async function buildDom(events: AsyncIterable<XmlEvent>): Promise<DomDocument> {
  const document = new Document();
  const refs = new WeakMap<Node, XmlNodeRef>();
  const ordinals = new WeakMap<Node, number>();
  refs.set(document, { kind: 'document', id: 0 });
  const stack: ParentFrame[] = [
    { node: document, id: 0, textOrdinal: 0, commentOrdinal: 0, piOrdinal: 0 },
  ];
  let elementId = 0;
  let textParts: string[] = [];

  const flushText = (): void => {
    if (textParts.length === 0) return;
    const parent = stack[stack.length - 1]!;
    const text = document.createTextNode(
      textParts.length === 1 ? textParts[0]! : textParts.join(''),
    );
    textParts = [];
    parent.node.appendChild(text);
    const ordinal = ++parent.textOrdinal;
    refs.set(text, { kind: 'text', parentElementId: parent.id, textRunOrdinal: ordinal });
    ordinals.set(text, ordinal);
  };

  for await (const event of events) {
    if (event.kind === Kind.Text) {
      // Document-level whitespace is not an XPath text node. CDATA boundaries
      // deliberately do not flush, so decoded adjacent pieces form one run.
      if (stack.length > 1 && event.data.length > 0) textParts.push(event.data);
      continue;
    }
    if (
      event.kind === Kind.Declaration ||
      event.kind === Kind.CdataStart ||
      event.kind === Kind.CdataEnd
    )
      continue;
    flushText();
    const parent = stack[stack.length - 1]!;
    if (event.kind === Kind.Start) {
      if (elementId + 1 >= 0xffff_ffff) {
        throw new XmlError(
          'ERR_XML_INDEX_LIMIT',
          'XML element IDs exceed the uint32 browsing index capacity',
        );
      }
      // Source names are already namespace-validated; DOM factories additionally forbid legal bare xmlns elements.
      const element = document.adoptNode(
        new Element(
          event.data.namespaceURI || null,
          event.data.prefix || null,
          event.data.localName,
        ),
      );
      for (const namespace of event.data.namespaces) {
        element.setAttributeNS(
          XMLNS_NS,
          namespace.prefix ? `xmlns:${namespace.prefix}` : 'xmlns',
          namespace.uri,
        );
      }
      for (const attribute of event.data.attributes) {
        element.setAttributeNS(attribute.namespaceURI || null, attribute.name, attribute.value);
      }
      const id = ++elementId;
      refs.set(element, { kind: 'element', elementId: id });
      for (const attribute of element.attributes) {
        refs.set(attribute, {
          kind: 'attribute',
          ownerElementId: id,
          namespaceURI: attribute.namespaceURI ?? '',
          localName: attribute.localName,
        });
      }
      const expandedName = JSON.stringify([event.data.namespaceURI, event.data.localName]);
      parent.elementOrdinals ??= new Map<string, number>();
      const siblings = parent.elementOrdinals;
      const ordinal = (siblings.get(expandedName) ?? 0) + 1;
      siblings.set(expandedName, ordinal);
      ordinals.set(element, ordinal);
      parent.node.appendChild(element);
      stack.push({ node: element, id, textOrdinal: 0, commentOrdinal: 0, piOrdinal: 0 });
    } else if (event.kind === Kind.End) {
      if (stack.length === 1)
        throw new XmlError('ERR_XML_PARSE', 'Unexpected closing event in query DOM');
      stack.pop();
    } else if (event.kind === Kind.Comment) {
      const comment = document.createComment(event.data);
      const ordinal = ++parent.commentOrdinal;
      parent.node.appendChild(comment);
      refs.set(comment, { kind: 'comment', parentId: parent.id, ordinal });
      ordinals.set(comment, ordinal);
    } else if (event.kind === Kind.Pi) {
      const instruction = document.createProcessingInstruction(event.data.target, event.data.value);
      const ordinal = ++parent.piOrdinal;
      parent.node.appendChild(instruction);
      refs.set(instruction, { kind: 'processing-instruction', parentId: parent.id, ordinal });
      ordinals.set(instruction, ordinal);
    }
  }
  flushText();
  if (stack.length !== 1 || !document.documentElement) {
    throw new XmlError('ERR_XML_PARSE', 'Incomplete document in query DOM');
  }
  return { document, refs, ordinals };
}
