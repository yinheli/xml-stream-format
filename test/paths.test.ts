import assert from 'node:assert/strict';
import * as slimdom from 'slimdom';
import { test } from 'vitest';
import type { XmlNodeRef } from '../src/document/types.js';
import type { DomDocument } from '../src/xpath/dom-builder.js';
import { canonicalXPath, nodeLabel, xpathLiteral } from '../src/xpath/paths.js';

function buildDom(): {
  dom: DomDocument;
  root: slimdom.Element;
  item: slimdom.Element;
  second: slimdom.Element;
} {
  const doc = new slimdom.Document();
  const refs = new WeakMap<slimdom.Node, XmlNodeRef>();
  const ordinals = new WeakMap<slimdom.Node, number>();
  const root = doc.createElementNS('urn:r', 'r:root');
  doc.appendChild(root);
  const item = doc.createElementNS('urn:r', 'r:item');
  item.setAttribute('id', '1');
  item.appendChild(doc.createTextNode('value'));
  const second = doc.createElementNS('urn:r', 'r:item');
  second.setAttribute('id', '2');
  root.appendChild(item);
  root.appendChild(second);
  root.appendChild(doc.createComment('note'));
  root.appendChild(doc.createProcessingInstruction('target', 'data'));
  refs.set(doc, { kind: 'document', id: 0 });
  refs.set(root, { kind: 'element', elementId: 1 });
  refs.set(item, { kind: 'element', elementId: 2 });
  refs.set(second, { kind: 'element', elementId: 3 });
  refs.set(item.getAttributeNode('id')!, {
    kind: 'attribute',
    ownerElementId: 2,
    namespaceURI: '',
    localName: 'id',
  });
  refs.set(item.firstChild!, { kind: 'text', parentElementId: 2, textRunOrdinal: 1 });
  refs.set(root.lastChild!.previousSibling!, { kind: 'comment', parentId: 1, ordinal: 1 });
  refs.set(root.lastChild!, { kind: 'processing-instruction', parentId: 1, ordinal: 1 });
  ordinals.set(root, 1);
  ordinals.set(item, 1);
  ordinals.set(second, 2);
  ordinals.set(item.firstChild!, 1);
  return { dom: { document: doc, refs, ordinals }, root, item, second };
}

test('canonicalXPath builds namespace-free absolute paths for every node kind', () => {
  const { dom, root, item, second } = buildDom();
  const rootStep = "*[local-name()='root' and namespace-uri()='urn:r'][1]";
  const itemStep = "*[local-name()='item' and namespace-uri()='urn:r'][1]";
  assert.equal(canonicalXPath(dom.document, dom), '/');
  assert.equal(canonicalXPath(root, dom), `/${rootStep}`);
  assert.equal(canonicalXPath(item, dom), `/${rootStep}/${itemStep}`);
  assert.equal(canonicalXPath(second, dom), `/${rootStep}/${itemStep.replace('[1]', '[2]')}`);
  assert.equal(
    canonicalXPath(item.getAttributeNode('id')!, dom),
    `/${rootStep}/${itemStep}/@*[local-name()='id' and namespace-uri()='']`,
  );
  assert.equal(canonicalXPath(item.firstChild!, dom), `/${rootStep}/${itemStep}/text()[1]`);
  assert.equal(canonicalXPath(root.lastChild!.previousSibling!, dom), `/${rootStep}/comment()[1]`);
  assert.equal(canonicalXPath(root.lastChild!, dom), `/${rootStep}/processing-instruction()[1]`);
});

test('canonicalXPath rejects nodes outside the source DOM', () => {
  const { dom } = buildDom();
  const foreign = new slimdom.Document();
  assert.throws(() => canonicalXPath(foreign.createElement('x'), dom), {
    code: 'ERR_XPATH_RESULT_TYPE',
  });
  assert.throws(() => canonicalXPath(foreign, dom), { code: 'ERR_XPATH_RESULT_TYPE' });
  // A tracked element detached from the document has no absolute path.
  const orphan = new slimdom.Document().createElement('orphan');
  dom.refs.set(orphan, { kind: 'element', elementId: 9 });
  dom.ordinals.set(orphan, 1);
  assert.throws(() => canonicalXPath(orphan, dom), {
    message: 'XPath result is detached from the source document',
  });
});

test('xpathLiteral quotes every string as a valid XPath literal', () => {
  assert.equal(xpathLiteral('value'), `'value'`);
  assert.equal(xpathLiteral("it's"), `"it's"`);
  assert.equal(xpathLiteral(`a'b"c`), `concat('a', "'", 'b"c')`);
  assert.equal(xpathLiteral(`''`), `"''"`);
  assert.equal(xpathLiteral(''), `''`);
});

test('nodeLabel summarizes node kinds with bounded, flattened text', () => {
  const doc = new slimdom.Document();
  const element = doc.createElementNS('urn:r', 'r:item');
  element.setAttribute('id', '1');
  doc.appendChild(element);
  const text = doc.createTextNode('正文');
  element.appendChild(text);
  element.appendChild(doc.createCDATASection('x'));
  element.appendChild(doc.createComment('note'));
  element.appendChild(doc.createProcessingInstruction('target', 'data'));
  assert.equal(nodeLabel(doc), '#document');
  assert.equal(nodeLabel(element), '<r:item>');
  assert.equal(nodeLabel(element.getAttributeNode('id')!), `@id="1"`);
  assert.equal(nodeLabel(text), 'text() "正文"');
  assert.equal(nodeLabel(element.childNodes[2]!), '<!--note-->');
  assert.equal(nodeLabel(element.childNodes[3]!), '<?target data?>');
  assert.equal(nodeLabel(doc.createProcessingInstruction('target', '')), '<?target?>');
  assert.equal(nodeLabel(doc.createDocumentFragment()), '#document-fragment');
});

test('nodeLabel bounds labels by graphemes, counting astral characters as one', () => {
  const doc = new slimdom.Document();
  const plain = doc.createTextNode('x'.repeat(200));
  assert.equal([...nodeLabel(plain)].length, 160);
  assert.ok(nodeLabel(plain).endsWith('…'));
  const astral = doc.createTextNode('😀'.repeat(300));
  assert.equal([...nodeLabel(astral)].length, 160);
  assert.ok(nodeLabel(astral).startsWith('text() "😀'));
});

test('nodeLabel bounds by code units and drops a trailing partial grapheme cluster', () => {
  const doc = new slimdom.Document();
  const combining = doc.createTextNode(`ab${'\u0301'.repeat(1022)}`);
  assert.equal(nodeLabel(combining), 'text() "a…');
});

test('nodeLabel replaces control whitespace inside labels with spaces', () => {
  const doc = new slimdom.Document();
  const text = doc.createTextNode('a\tb\rc\nd');
  assert.equal(nodeLabel(text), 'text() "a b c d"');
});
