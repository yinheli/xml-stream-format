import assert from 'node:assert/strict';
import { test } from 'vitest';
import { XmlError } from '../src/core/errors.js';
import { TokenBudget } from '../src/core/token-budget.js';

function scanned(text: string, limit: number, chunkSize = text.length): () => void {
  return () => {
    const budget = new TokenBudget(limit);
    for (let i = 0; i < text.length; i += chunkSize) budget.scan(text.slice(i, i + chunkSize));
  };
}

function throwsXml(run: () => void, code: string): void {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof XmlError, `expected XmlError, got ${String(error)}`);
    assert.equal(error.code, code);
    return;
  }
  assert.fail(`expected XmlError ${code}`);
}

test('constructor requires a positive safe integer token limit', () => {
  for (const limit of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
    assert.throws(() => new TokenBudget(limit), RangeError);
  }
  assert.ok(new TokenBudget(1));
});

test('plain text never trips the budget regardless of length', () => {
  const text = `${'正文'.repeat(10_000)}ordinary words without markup`;
  assert.doesNotThrow(scanned(text, 32));
  assert.doesNotThrow(scanned(text, 32, 3));
});

test('markup and reference tokens are charged across chunk boundaries with exact limits', () => {
  // <r a=" + 50 x + "/> is 59 code units of one markup token.
  const markup = `<r a="${'x'.repeat(50)}"/>`;
  assert.doesNotThrow(scanned(markup, 59));
  for (const size of [1, 2, 7, 59]) throwsXml(scanned(markup, 58, size), 'ERR_XML_LIMIT');
  // Each reference restarts the budget at its own opening &.
  assert.doesNotThrow(scanned('&#65;&#65;', 5));
  for (const size of [1, 2, 5, 10]) throwsXml(scanned('&#65;&#65;', 4, size), 'ERR_XML_LIMIT');
});

test('comments and processing instructions are charged but CDATA is exempt', () => {
  throwsXml(scanned(`<!--${'x'.repeat(40)}-->`, 32), 'ERR_XML_LIMIT');
  throwsXml(scanned(`<?p ${'x'.repeat(40)}?>`, 32), 'ERR_XML_LIMIT');
  assert.doesNotThrow(scanned(`<![CDATA[${'&'.repeat(40_000)}]]>`, 32));
  assert.doesNotThrow(scanned('<![CDATA[x]]' + '>rest', 32, 2));
});

test('DOCTYPE declarations are rejected even when split across chunks', () => {
  for (const size of [1, 5, 9, 40])
    throwsXml(scanned('<!DOCTYPE r [<!ENTITY x "y">]><r>&x;</r>', 32, size), 'ERR_XML_DTD');
  // A prefix that abandons the DOCTYPE spelling returns to ordinary tag handling.
  assert.doesNotThrow(scanned('<!DX/><r/>', 32));
});

test('quoted angle brackets cannot close a tag and the state resumes in text afterwards', () => {
  // <a b=">"/> is exactly 10 code units; the quoted > must not end the token.
  assert.doesNotThrow(scanned('<a b=">"/>', 10));
  throwsXml(scanned('<a b=">"/>', 9), 'ERR_XML_LIMIT');
  // A following reference restarts the budget, which only holds if quoting ended.
  const budget = new TokenBudget(10);
  budget.scan('<a b=">"/>');
  budget.scan('&#65;');
});

test('CDATA sections close correctly when the terminator is split across chunks', () => {
  const budget = new TokenBudget(32);
  budget.scan('<![CDATA[a]b]]');
  budget.scan('>');
  budget.scan('<r/>'); // Tag markup fits again, proving cdata state ended.
});
