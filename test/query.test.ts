import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { test } from 'vitest';
import { openBrowserXml } from '../dist/document/document.js';
import { openXml } from '../dist/index.js';

const namespaces = { r: 'urn:r', xsi: 'http://www.w3.org/2001/XMLSchema-instance' };
async function* input(xml: string | Uint8Array) {
  yield xml;
}
async function collect(chunks: AsyncIterable<string>) {
  let value = '';
  for await (const chunk of chunks) value += chunk;
  return value;
}

test('openXml applies token limits to source declarations before normalization', async () => {
  const cases: { xml: string | Uint8Array; limit: number }[] = [
    { xml: '<?xml version="1.0" encoding="A"?><r/>', limit: 34 },
    { xml: '<?xml version="1.0" encoding  =  "UTF-8"?><r/>', limit: 42 },
    { xml: Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><r/>'), limit: 43 },
  ];
  for (const { xml, limit } of cases) {
    const doc = await openXml(input(xml), { maxTokenCodeUnits: limit });
    try {
      assert.equal((await doc.select('/r')).length, 1);
    } finally {
      await doc.close();
    }
    await assert.rejects(() => openXml(input(xml), { maxTokenCodeUnits: limit - 1 }), {
      code: 'ERR_XML_LIMIT',
    });
    if (limit > 38)
      await assert.rejects(() => openXml(input(xml), { maxTokenCodeUnits: 38 }), {
        code: 'ERR_XML_LIMIT',
      });
  }
  await assert.rejects(
    () =>
      openXml(input(`<?xml version="1.0" encoding="A"?><r a="${'x'.repeat(40)}"/>`), {
        maxTokenCodeUnits: 34,
      }),
    { code: 'ERR_XML_LIMIT' },
  );
});

test('XPath 3.1 predicates and logical text runs operate on source, not preview indentation', async () => {
  const doc = await openXml(createReadStream(new URL('./fixtures/query.xml', import.meta.url)));
  try {
    const matches = await doc.select('//r:item[@id = ["1", "3"]?*]', { namespaces });
    assert.equal(matches.length, 2);
    assert.deepEqual(
      matches.map((match) => match.ref),
      [
        { kind: 'element', elementId: 2 },
        { kind: 'element', elementId: 5 },
      ],
    );
    assert.equal(
      (await doc.select('//r:item[@id="1"]/text()[.="ab&c"]', { namespaces })).length,
      1,
    );
    assert.deepEqual(await doc.select('//r:item[@id="1"]/text()[2]', { namespaces }), []);
    assert.equal((await doc.select(matches[0]!.xpath)).length, 1);
    const xml = await collect(doc.extract('//r:item[@id="1"]', { namespaces }));
    assert.ok(xml.includes('xmlns:p="urn:p"'));
    const extracted = await openXml(input(xml));
    try {
      assert.equal(
        (
          await extracted.select(
            '/r:item[@xsi:type="p:T" and @xml:lang="zh" and @xml:space="default"]',
            { namespaces },
          )
        ).length,
        1,
      );
    } finally {
      await extracted.close();
    }
  } finally {
    await doc.close();
  }
});

test('preserves XPath axes, sequence order and duplicate/ancestor extraction, rejecting non-node results', async () => {
  const doc = await openXml(createReadStream(new URL('./fixtures/query.xml', import.meta.url)));
  try {
    assert.deepEqual(
      (await doc.select('//r:item[last()]', { namespaces })).map((m) => m.ref),
      [
        { kind: 'element', elementId: 3 },
        { kind: 'element', elementId: 5 },
      ],
    );
    assert.deepEqual(
      (await doc.select('(//r:item)[last()]', { namespaces })).map((m) => m.ref),
      [{ kind: 'element', elementId: 5 }],
    );
    assert.deepEqual(
      (await doc.select('//r:item[@id="2"]/preceding-sibling::r:item[1]', { namespaces })).map(
        (m) => m.ref,
      ),
      [{ kind: 'element', elementId: 2 }],
    );
    assert.equal((await doc.select('//r:item[@id="3"]/ancestor::r:r', { namespaces })).length, 1);
    const xml = await collect(
      doc.extract('(//r:item[@id="3"], //r:item[@id="1"], //r:item[@id="3"])', { namespaces }),
    );
    assert.deepEqual(
      [...xml.matchAll(/ id="(\d)"/g)].map((m) => m[1]),
      ['3', '1', '3'],
    );
    const nested = await collect(doc.extract('(//r:group, //r:item[@id="3"])', { namespaces }));
    assert.deepEqual(
      [...nested.matchAll(/ id="(\d)"/g)].map((m) => m[1]),
      ['3', '3'],
    );
    assert.equal(await collect(doc.extract('//r:missing', { namespaces })), '');
    const attributes = await doc.select('//r:item/@id', { namespaces });
    assert.equal(attributes[0]?.ref.kind, 'attribute');
    assert.equal((await doc.select(attributes[0]!.xpath)).length, 1);
    let partial = '';
    await assert.rejects(
      async () => {
        for await (const chunk of doc.extract('(//r:item[1], //r:item/@id)', { namespaces }))
          partial += chunk;
      },
      { code: 'ERR_XML_EXTRACT_NODE_TYPE' },
    );
    assert.equal(partial, '');
    for (const expression of ['count(//r:item)', 'map {"a":1}', '[1,2]'])
      await assert.rejects(() => doc.select(expression, { namespaces }), {
        code: 'ERR_XPATH_RESULT_TYPE',
      });
    await assert.rejects(() => doc.select('//unbound:item'), { code: 'ERR_XPATH_QUERY' });
    await assert.rejects(() => doc.select('delete node //r:item', { namespaces }), {
      code: 'ERR_XPATH_QUERY',
    });
    assert.equal((await doc.select('//r:item', { namespaces })).length, 3);
  } finally {
    await doc.close();
    await doc.close();
  }
  await assert.rejects(() => doc.select('/*'), { code: 'ERR_XML_CLOSED' });
});

test('uses explicit namespaces, defaults only element names, and quote-safe canonical paths', async () => {
  const doc = await openXml(
    input(
      '<r xmlns="urn:r" xmlns:p="urn:p"><p:a id="x"/><g xmlns:p="urn:other"><p:a/></g><a xmlns=""/></r>',
    ),
  );
  try {
    assert.equal((await doc.select('//a')).length, 1);
    assert.equal((await doc.select('//a', { namespaces: { '': 'urn:p' } })).length, 1);
    assert.equal((await doc.select('//a/@id', { namespaces: { '': 'urn:p' } })).length, 1);
    assert.equal((await doc.select('//p:a', { namespaces: { p: 'urn:p' } })).length, 1);
    assert.equal((await doc.select('//p:a', { namespaces: { p: 'urn:other' } })).length, 1);
    const inherited = Object.create({ inherited: 'urn:r' }) as Record<string, string>;
    await assert.rejects(() => doc.select('//inherited:r', { namespaces: inherited }), {
      code: 'ERR_XPATH_QUERY',
    });
  } finally {
    await doc.close();
  }
  const quoted = await openXml(input('<r xmlns="urn:a&apos;b&quot;c"><a/><a/></r>'));
  try {
    const matches = await quoted.select('//*');
    for (const match of matches)
      assert.deepEqual(
        (await quoted.select(match.xpath)).map((m) => m.ref),
        [match.ref],
      );
  } finally {
    await quoted.close();
  }
});

test('legal unprefixed xmlns element names remain queryable and extractable', async () => {
  for (const [xml, namespaceURI] of [
    ['<xmlns/>', ''],
    ['<xmlns xmlns="urn:r"/>', 'urn:r'],
  ] as const) {
    const doc = await openXml(input(xml));
    try {
      const matches = await doc.select(
        `/*[local-name() = 'xmlns' and namespace-uri() = '${namespaceURI}']`,
      );
      assert.equal(matches.length, 1);
      assert.deepEqual(
        (await doc.select(matches[0]!.xpath)).map((match) => match.ref),
        [matches[0]!.ref],
      );
      const extracted = await openXml(input(await collect(doc.extract(matches[0]!.xpath))));
      try {
        assert.equal(
          (
            await extracted.select(
              `/*[local-name() = 'xmlns' and namespace-uri() = '${namespaceURI}']`,
            )
          ).length,
          1,
        );
      } finally {
        await extracted.close();
      }
    } finally {
      await doc.close();
    }
  }
});

test('query limits and worker timeout leave the same document usable', async () => {
  const doc = await openXml(
    input(`<r>${Array.from({ length: 2000 }, (_, id) => `<item id="${id}"/>`).join('')}</r>`),
  );
  try {
    await assert.rejects(() => doc.select('//item', { maxSourceBytes: 8 }), {
      code: 'ERR_XPATH_LIMIT',
    });
    await assert.rejects(() => doc.select('//item', { maxResults: 1 }), {
      code: 'ERR_XPATH_LIMIT',
    });
    await doc.select('/r');
    await assert.rejects(
      () => doc.select('//item[sum(//item/@id ! number(.)) >= 0]', { queryTimeoutMs: 1 }),
      { code: 'ERR_XPATH_TIMEOUT' },
    );
    assert.equal((await doc.select('/r/item[@id="1999"]')).length, 1);
    const controller = new AbortController();
    const pending = doc.select('//item[sum(//item/@id ! number(.)) >= 0]', {
      signal: controller.signal,
    });
    // Real worker termination integration: fake timers cannot interrupt another V8 isolate.
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(pending, { name: 'AbortError' });
    const queuedController = new AbortController();
    const active = doc.select('//item[sum(//item/@id ! number(.)) >= 0]', { queryTimeoutMs: 1 });
    const queued = doc.select('/*', { signal: queuedController.signal });
    queuedController.abort();
    await assert.rejects(queued, { name: 'AbortError' });
    await assert.rejects(active, { code: 'ERR_XPATH_TIMEOUT' });
    assert.equal((await doc.select('/r/item[@id="0"]')).length, 1);
  } finally {
    await doc.close();
  }
});

test('query timeout budgets respect the Node timer ceiling before loading a worker', async () => {
  const doc = await openBrowserXml(input('<r id="value"/>'));
  const postMessage = Worker.prototype.postMessage;
  let queryLoads = 0;
  Worker.prototype.postMessage = function (message, transferList) {
    if (message?.type === 'load' && message.payload?.tapePath) queryLoads++;
    return postMessage.call(this, message, transferList);
  };
  try {
    for (const queryTimeoutMs of [2_147_483_648, Number.MAX_SAFE_INTEGER]) {
      await assert.rejects(() => doc.select('/*', { queryTimeoutMs }), {
        name: 'RangeError',
        message: /queryTimeoutMs.*2147483647/,
      });
    }
    assert.equal(queryLoads, 0);
    const [attribute] = await doc.select('/*/@id', { queryTimeoutMs: 2_147_483_647 });
    assert.ok(attribute);
    assert.equal(queryLoads, 1);
    await assert.rejects(
      () =>
        doc.readValue(attribute, { queryTimeoutMs: 2_147_483_648, maxOldGenerationSizeMb: 256 }),
      { name: 'RangeError', message: /queryTimeoutMs.*2147483647/ },
    );
    assert.equal(queryLoads, 1);
    assert.equal(await doc.readValue(attribute, { queryTimeoutMs: 2_147_483_647 }), 'value');
  } finally {
    Worker.prototype.postMessage = postMessage;
    await doc.close();
  }
});

test('closing during a query heap replacement does not start another worker', {
  timeout: 10_000,
}, async () => {
  const doc = await openXml(input('<r/>'));
  const terminate = Worker.prototype.terminate;
  const postMessage = Worker.prototype.postMessage;
  const { promise: entered, resolve: enter } = Promise.withResolvers<void>();
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  let gateNextTermination = true;
  let closing = false;
  let lateLoads = 0;
  try {
    await doc.select('/*');
    Worker.prototype.terminate = function () {
      const stopped = terminate.call(this);
      if (!gateNextTermination) return stopped;
      gateNextTermination = false;
      enter();
      return stopped.then(async (code) => {
        await gate;
        return code;
      });
    };
    Worker.prototype.postMessage = function (message, transferList) {
      if (closing && message?.type === 'load' && message.payload?.tapePath) lateLoads++;
      return postMessage.call(this, message, transferList);
    };
    const query = assert.rejects(() => doc.select('/*', { maxOldGenerationSizeMb: 256 }), {
      code: 'ERR_XML_CLOSED',
    });
    await entered;
    closing = true;
    const closed = doc.close();
    release();
    await Promise.all([closed, query]);
    assert.equal(lateLoads, 0, 'No query worker may load after close begins');
    await assert.rejects(() => doc.select('/*'), { code: 'ERR_XML_CLOSED' });
  } finally {
    release();
    Worker.prototype.terminate = terminate;
    Worker.prototype.postMessage = postMessage;
    await doc.close();
  }
});

test('canonical paths count expanded-name siblings and extraction inherits whitespace context', async () => {
  const doc = await openXml(
    input(
      '<r xmlns:p="urn:p" xmlns:q="urn:p" xml:space="preserve"><p:a/><q:a/><g><b/></g><d xml:space="default"><b/></d></r>',
    ),
  );
  try {
    const siblings = await doc.select('/*/*[local-name()="a"]');
    assert.equal(siblings.length, 2);
    for (const match of siblings)
      assert.deepEqual(
        (await doc.select(match.xpath)).map((item) => item.ref),
        [match.ref],
      );
    const preserved = await collect(doc.extract('/*/g'));
    assert.ok(preserved.includes('xml:space="preserve"><b/></g>'));
    const reset = await collect(doc.extract('/*/d'));
    assert.ok(reset.includes('xml:space="default">\n  <b/>\n</d>'));
  } finally {
    await doc.close();
  }
  const rebound = await openXml(
    input(
      '<r xmlns="urn:r" xmlns:p="urn:old" xml:lang="en"><a xmlns="" xmlns:p="urn:new"><p:b/></a></r>',
    ),
  );
  try {
    const xml = await collect(rebound.extract('//*[local-name()="a"]'));
    const standalone = await openXml(input(xml));
    try {
      assert.equal(
        (await standalone.select('/a[@xml:lang="en"]/p:b', { namespaces: { p: 'urn:new' } }))
          .length,
        1,
      );
    } finally {
      await standalone.close();
    }
  } finally {
    await rebound.close();
  }
});

test('the opening signal closes the document lifecycle, not just the input read', async () => {
  const controller = new AbortController();
  const doc = await openXml(input('<r><a/></r>'), { signal: controller.signal });
  await doc.select('/*');
  controller.abort();
  await assert.rejects(() => doc.select('/*'), { code: 'ERR_XML_CLOSED' });
  await doc.close();
});

test('prototype-named XML prefixes and own namespace dictionary keys remain ordinary names', async () => {
  const doc = await openXml(
    input(
      '<__proto__:r xmlns:__proto__="urn:r" __proto__="keep" constructor="also-keep" toString="keep-too"/>',
    ),
  );
  try {
    const matches = await doc.select(
      '//constructor:r[@__proto__="keep" and @constructor="also-keep" and @toString="keep-too"]',
      { namespaces: { constructor: 'urn:r' } },
    );
    assert.equal(matches.length, 1);
    assert.deepEqual(
      (await doc.select(matches[0]!.xpath)).map((match) => match.ref),
      [matches[0]!.ref],
    );
    assert.equal(
      (
        await doc.select('/*[node-name(.) = xs:QName(concat("construc", "tor:r"))]', {
          namespaces: { constructor: 'urn:r' },
        })
      ).length,
      1,
    );
    assert.equal(
      (
        await doc.select('let $constructor := 1 return //constructor:r[$constructor = 1]', {
          namespaces: { constructor: 'urn:r' },
        })
      ).length,
      1,
    );
    await assert.rejects(() => doc.select('//constructor:r'), { code: 'ERR_XPATH_QUERY' });
  } finally {
    await doc.close();
  }
});

test('predefined XPath prefixes reject conflicts and accept their exact upstream bindings', async () => {
  const reserved = {
    xml: 'http://www.w3.org/XML/1998/namespace',
    xs: 'http://www.w3.org/2001/XMLSchema',
    fn: 'http://www.w3.org/2005/xpath-functions',
    map: 'http://www.w3.org/2005/xpath-functions/map',
    array: 'http://www.w3.org/2005/xpath-functions/array',
    math: 'http://www.w3.org/2005/xpath-functions/math',
    fontoxpath: 'http://fontoxml.com/fontoxpath',
    local: 'http://www.w3.org/2005/xquery-local-functions',
  };
  const doc = await openXml(input('<r/>'));
  try {
    for (const [prefix, uri] of Object.entries(reserved)) {
      await assert.rejects(() => doc.select('/*', { namespaces: { [prefix]: 'urn:conflict' } }), {
        code: 'ERR_XPATH_QUERY',
      });
      assert.equal((await doc.select('/*', { namespaces: { [prefix]: uri } })).length, 1);
      assert.equal(
        (
          await doc.select(`/*[namespace-uri-from-QName(xs:QName('${prefix}:value')) = '${uri}']`, {
            namespaces: { [prefix]: uri },
          })
        ).length,
        1,
      );
    }
    assert.equal((await doc.select('fn:trace(/*, "silent")')).length, 1);
  } finally {
    await doc.close();
  }
});

test('retained attribute and logical text values recover after a query worker timeout', async () => {
  const doc = await openBrowserXml(
    input(
      '<r><value id="a&amp;b">a<![CDATA[b]]>&amp;c</value>' +
        Array.from({ length: 2000 }, (_, id) => `<item id="${id}"/>`).join('') +
        '</r>',
    ),
  );
  try {
    const [attribute, text] = await doc.select('(/r/value/@id, /r/value/text())');
    assert.ok(attribute && text);
    await assert.rejects(
      () => doc.select('//item[sum(//item/@id ! number(.)) >= 0]', { queryTimeoutMs: 1 }),
      { code: 'ERR_XPATH_TIMEOUT' },
    );
    await assert.rejects(() => doc.readValue(text, { maxSourceBytes: 8 }), {
      code: 'ERR_XPATH_LIMIT',
    });
    assert.equal(await doc.readValue(text), 'ab&c');
    await doc.select('/r/item');
    assert.equal(await doc.readValue(attribute), 'a&b');
    assert.equal(await doc.readValue(text, { maxOldGenerationSizeMb: 256 }), 'ab&c');
    await assert.rejects(() => doc.readValue(text, {}, 2), { code: 'ERR_XML_COPY_LIMIT' });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => doc.readValue(text, { signal: controller.signal }), {
      name: 'AbortError',
    });
  } finally {
    await doc.close();
  }
});

test('fn:trace preserves node results without writing to stdout', () => {
  const entry = new URL('../dist/index.js', import.meta.url).href;
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { openXml } from ${JSON.stringify(entry)};
    async function* input() { yield '<r/>'; }
    const doc = await openXml(input());
    try {
      const matches = await doc.select('fn:trace(/*, "must-not-leak")');
      process.stdout.write(JSON.stringify(matches.map(match => match.ref)));
    } finally { await doc.close(); }
  `,
    ],
    { encoding: 'utf8' },
  );
  assert.deepEqual(JSON.parse(output), [{ kind: 'element', elementId: 1 }]);
});

test('handled openXml structured-clone failures do not cause unhandled rejections', () => {
  const entry = new URL('../dist/index.js', import.meta.url).href;
  const output = execFileSync(
    process.execPath,
    [
      '--unhandled-rejections=strict',
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { openXml } from ${JSON.stringify(entry)};
    import { setImmediate } from 'node:timers/promises';
    async function* input() { yield '<r/>'; }
    const options = { maxDepth: 1024, hooks: { onText: text => text } };
    await assert.rejects(() => openXml(input(), options), { name: 'DataCloneError' });
    await setImmediate();
    const doc = await openXml(input());
    try { assert.equal((await doc.select('/*')).length, 1); }
    finally { await doc.close(); }
    process.stdout.write('handled');
  `,
    ],
    { encoding: 'utf8', timeout: 10_000 },
  );
  assert.equal(output, 'handled');
});

test('nested fontoxpath:evaluate preserves prototype-named map variables and source identities', async () => {
  const doc = await openXml(input('<r><item id="first"/><item id="second"/></r>'));
  const source = '(/r/item[2], /r, /r/item[1], /r/item[2])';
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  try {
    const expected = (await doc.select(source)).map((match) => match.ref);
    assert.deepEqual(expected, [
      { kind: 'element', elementId: 3 },
      { kind: 'element', elementId: 1 },
      { kind: 'element', elementId: 2 },
      { kind: 'element', elementId: 3 },
    ]);
    for (const name of ['ordinary', '__proto__', 'constructor', 'toString']) {
      const inner = `fontoxpath:evaluate(${literal(`$${name}`)}, map {${literal(name)}: $${name}})`;
      for (const expression of [`$${name}`, inner]) {
        const query = `fontoxpath:evaluate(${literal(expression)}, map {${literal(name)}: ${source}})`;
        assert.deepEqual(
          (await doc.select(query)).map((match) => match.ref),
          expected,
          `${name}: ${expression}`,
        );
      }
    }
  } finally {
    await doc.close();
  }
});

test('rapid navigation and depth changes preserve their input order', async () => {
  const doc = await openBrowserXml(input('<r><a><x/><y/></a><b/></r>'));
  try {
    await doc.session.ensureComplete();
    await doc.session.request('treeRows', {});
    await Promise.all([
      doc.session.request('treeRows', { move: 'next' }),
      doc.session.request('treeRows', { move: 'next' }),
      doc.session.request('treeRows', { move: 'next' }),
      doc.session.request('expand', { depth: 2 }),
    ]);
    const page = await doc.session.request('treeRows', {});
    assert.equal(page.path, '/r/a');
    assert.equal(page.selectedId, 2);
  } finally {
    await doc.close();
  }
});

test('bounded detail pages traverse adjacent XML lines in both directions', async () => {
  const doc = await openBrowserXml(input(`<r>${'<a/>'.repeat(500)}</r>`), {}, { preview: true });
  try {
    await doc.session.ensureComplete();
    const first = await doc.session.request('detailRows', { elementId: 1, lineCount: 300 });
    const next = await doc.session.request('detailRows', {
      elementId: 1,
      startLine: first.endLine + 1,
      lineCount: 300,
    });
    assert.equal(next.startLine, first.endLine + 1);
    assert.equal(next.rows[0]!.text.trim(), '<a/>');
    const previous = await doc.session.request('detailRows', {
      elementId: 1,
      endLine: next.startLine - 1,
      lineCount: 300,
    });
    assert.deepEqual(previous.rows, first.rows);
    assert.equal(previous.startLine, 0);
  } finally {
    await doc.close();
  }
});

test('byte-bounded backwards pages end immediately before the current page', async () => {
  const doc = await openBrowserXml(
    input(`<r>${(`<a>${'界'.repeat(4000)}</a>`).repeat(30)}</r>`),
    {},
    { preview: true },
  );
  try {
    await doc.session.ensureComplete();
    const first = await doc.session.request('detailRows', {
      elementId: 1,
      lineCount: 25,
      columns: 4096,
    });
    assert.ok(first.endLine < 24);
    const next = await doc.session.request('detailRows', {
      elementId: 1,
      startLine: first.endLine + 1,
      lineCount: 25,
      columns: 4096,
    });
    const third = await doc.session.request('detailRows', {
      elementId: 1,
      startLine: next.endLine + 1,
      lineCount: 25,
      columns: 4096,
    });
    const previous = await doc.session.request('detailRows', {
      elementId: 1,
      endLine: third.startLine - 1,
      lineCount: 25,
      columns: 4096,
    });
    assert.equal(previous.endLine + 1, third.startLine);
    assert.equal(previous.rows.at(-1)!.line, next.endLine);
  } finally {
    await doc.close();
  }
});

test('extraction preserves inherited context overrides across cached ancestors', async () => {
  const doc = await openXml(
    input(
      '<r xmlns="urn:r" xmlns:p="urn:p" xml:lang="en" xml:space="preserve" pad="' +
        'x'.repeat(100_000) +
        '"><a><p:i/></a><b xmlns="" xml:lang="" xml:space="default"><i/></b></r>',
    ),
  );
  try {
    for (const [query, uri, lang, space] of [
      ['/*/*[1]/*', 'urn:p', 'en', 'preserve'],
      ['/*/*[2]/*', '', '', 'default'],
      ['/*/*[1]/*', 'urn:p', 'en', 'preserve'],
    ]) {
      const extracted = await openXml(input(await collect(doc.extract(query!))));
      try {
        const matches = await extracted.select(
          `/*[local-name()='i' and namespace-uri()='${uri}' and @xml:lang='${lang}' and @xml:space='${space}']`,
        );
        assert.deepEqual(
          matches.map((match) => match.ref),
          [{ kind: 'element', elementId: 1 }],
        );
        assert.deepEqual(await extracted.select('/*/@pad'), []);
      } finally {
        await extracted.close();
      }
    }
  } finally {
    await doc.close();
  }
});

test('browser exposes a navigable XML prefix before source EOF and grows in place', {
  timeout: 10_000,
}, async () => {
  const continueInput = Promise.withResolvers<void>();
  const prefixVisible = Promise.withResolvers<void>();
  let reachedEof = false;
  async function* streamed() {
    yield '<r><first id="1"/>';
    await continueInput.promise;
    yield '<second id="2"/></r>';
    reachedEof = true;
  }
  const doc = await openBrowserXml(
    streamed(),
    {},
    {
      preview: true,
      onProgress(value) {
        if (value.nodes >= 2) prefixVisible.resolve();
      },
    },
  );
  try {
    await prefixVisible.promise;
    assert.equal(reachedEof, false);
    assert.equal(doc.session.complete, false);
    const firstTree = await doc.session.request('treeRows', { loadMore: false });
    assert.deepEqual(
      firstTree.rows.map((row) => row.name),
      ['r', 'first'],
    );
    const before = await doc.session.request('detailRows', {
      elementId: 1,
      lineCount: 20,
      loadMore: false,
    });
    assert.match(before.rows.map((row) => row.text).join('\n'), /<first id="1"\/>/);
    assert.equal(
      (await doc.session.request('treeRows', { move: 'next', loadMore: false })).path,
      '/r/first',
    );
    continueInput.resolve();
    await doc.session.ensureComplete();
    assert.equal(doc.session.complete, true);
    const completeTree = await doc.session.request('treeRows', {});
    assert.equal(completeTree.path, '/r/first');
    assert.deepEqual(
      completeTree.rows.map((row) => row.name),
      ['r', 'first', 'second'],
    );
    const after = await doc.session.request('detailRows', { elementId: 1, lineCount: 20 });
    assert.match(after.rows.map((row) => row.text).join('\n'), /<second id="2"\/>/);
    assert.ok(after.totalLines > before.totalLines);
    assert.deepEqual(
      (await doc.select('/r/*')).map((match) => match.ref),
      [
        { kind: 'element', elementId: 2 },
        { kind: 'element', elementId: 3 },
      ],
    );
  } finally {
    continueInput.resolve();
    await doc.close();
  }
});

test('late malformed input keeps the prefix browsable but emits no extracted XML', {
  timeout: 10_000,
}, async () => {
  const continueInput = Promise.withResolvers<void>();
  const prefixVisible = Promise.withResolvers<void>();
  async function* streamed() {
    yield '<r><first/>';
    await continueInput.promise;
    yield '</wrong>';
  }
  const doc = await openBrowserXml(
    streamed(),
    {},
    {
      preview: true,
      onProgress(value) {
        if (value.nodes >= 2) prefixVisible.resolve();
      },
    },
  );
  try {
    await prefixVisible.promise;
    const extraction = doc.session.extractElements([2]).next();
    const rejectedExtraction = assert.rejects(extraction, { code: 'ERR_XML_PARSE' });
    continueInput.resolve();
    await assert.rejects(doc.session.ready, { code: 'ERR_XML_PARSE' });
    await rejectedExtraction;
    assert.equal(doc.session.complete, false);
    assert.deepEqual(
      (await doc.session.request('treeRows', {})).rows.map((row) => row.name),
      ['r', 'first'],
    );
    assert.match(
      (await doc.session.request('detailRows', { elementId: 1 })).rows
        .map((row) => row.text)
        .join('\n'),
      /<first\/>/,
    );
  } finally {
    continueInput.resolve();
    await doc.close();
  }
});

test('closing a progressive browser cancels a source stalled after its prefix', {
  timeout: 10_000,
}, async () => {
  const prefixVisible = Promise.withResolvers<void>();
  let returned = false;
  const source: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      let first = true;
      return {
        async next(): Promise<IteratorResult<string>> {
          if (first) {
            first = false;
            return { value: '<r><first/>', done: false };
          }
          return new Promise(() => {});
        },
        async return(): Promise<IteratorResult<string>> {
          returned = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
  const doc = await openBrowserXml(
    source,
    {},
    {
      preview: true,
      onProgress(value) {
        if (value.nodes >= 2) prefixVisible.resolve();
      },
    },
  );
  try {
    await prefixVisible.promise;
    await doc.close();
    await assert.rejects(doc.session.ready, { code: 'ERR_XML_CLOSED' });
    assert.equal(returned, true);
  } finally {
    await doc.close();
  }
});

test('loading-time expansion presets also apply to later nodes', { timeout: 10_000 }, async () => {
  const continueInput = Promise.withResolvers<void>();
  const prefixVisible = Promise.withResolvers<void>();
  async function* streamed() {
    yield '<r><a><x/></a>';
    await continueInput.promise;
    yield '<b><y/></b></r>';
  }
  const doc = await openBrowserXml(
    streamed(),
    {},
    {
      onProgress(value) {
        if (value.nodes >= 3) prefixVisible.resolve();
      },
    },
  );
  try {
    await prefixVisible.promise;
    await doc.session.request('expand', { depth: 1 });
    continueInput.resolve();
    await doc.session.ensureComplete();
    assert.deepEqual(
      (await doc.session.request('treeRows', {})).rows.map((row) => row.name),
      ['r'],
    );
    await doc.session.request('treeRows', { move: 'right' });
    await doc.session.request('treeRows', { move: 'next' });
    const page = await doc.session.request('treeRows', { move: 'next' });
    assert.equal(page.path, '/r/b');
    assert.equal(page.rows.find((row) => row.id === page.selectedId)!.expanded, false);
  } finally {
    continueInput.resolve();
    await doc.close();
  }
});

test('streamed previews escape controls and bound graphemes without changing values', async () => {
  const value = `\u009d\t中文😀a${'\u0301'.repeat(5000)}`;
  const doc = await openBrowserXml(input(`<r><a>${value}</a></r>`), {}, { preview: true });
  try {
    await doc.session.ensureComplete();
    const page = await doc.session.request('detailRows', { elementId: 2, columns: 80 });
    const text = page.rows.map((row) => row.text).join('\n');
    assert.ok(text.includes('\\x9D'));
    assert.ok(!text.includes('\u009d'));
    assert.ok(text.includes('中文😀'));
    assert.ok(page.rows.some((row) => row.truncatedGrapheme));
    const [match] = await doc.select('/r/a/text()');
    assert.equal(await doc.readValue(match!), value);
  } finally {
    await doc.close();
  }
});

test('viewport demand pauses source pulls while loaded metadata stays usable', {
  timeout: 10_000,
}, async () => {
  let pulls = 0;
  async function* streamed() {
    pulls++;
    yield '<r>';
    for (let id = 0; id < 200; id++) {
      pulls++;
      yield `<i id="${id}"/>`;
    }
    pulls++;
    yield '</r>';
  }
  const doc = await openBrowserXml(streamed(), {}, { preview: true });
  try {
    let page = await doc.session.request('treeRows', { limit: 4 });
    while (page.rows.length < 4 && !doc.session.complete)
      page = await doc.session.request('treeRows', { limit: 4 });
    assert.equal(page.rows.length, 4);
    assert.equal(doc.session.complete, false);
    const stoppedAt = pulls;
    await doc.session.request('overview', {});
    await doc.session.request('treeRows', { limit: 4, loadMore: false });
    await doc.session.request('detailRows', { elementId: 1, lineCount: 4, loadMore: false });
    await doc.session.request('fuzzy', { query: 'i' });
    const closed = await doc.session.request('detailRows', { elementId: 2, lineCount: 50 });
    assert.equal(closed.needsMore, false);
    assert.match(closed.rows[0]!.text, /<i id="0"\/>/);
    assert.equal(pulls, stoppedAt);
    assert.equal(doc.session.paused, true);
  } finally {
    await doc.close();
  }
});

test('navigation refills at the prefix boundary without repeating completed moves', {
  timeout: 10_000,
}, async () => {
  let pulls = 0;
  async function* streamed() {
    pulls++;
    yield '<r>';
    for (let id = 0; id < 200; id++) {
      pulls++;
      yield `<i id="${id}"/>`;
    }
    pulls++;
    yield '</r>';
  }
  const doc = await openBrowserXml(streamed());
  try {
    let page = await doc.session.request('treeRows', { limit: 4 });
    while (page.rows.length < 4) page = await doc.session.request('treeRows', { limit: 4 });
    const before = pulls;
    for (let step = 0; step < 5; step++)
      await doc.session.request('treeRows', { limit: 4, move: 'pageDown' });
    page = await doc.session.request('treeRows', { limit: 4, loadMore: false });
    while (page.continuation) page = await doc.session.request('treeRows', { limit: 4 });
    assert.equal(page.path, '/r/i[20]');
    assert.ok(pulls > before);
    assert.equal(doc.session.complete, false);
    const stoppedAt = pulls;
    await doc.session.request('treeRows', { move: 'first', loadMore: false });
    await doc.session.request('treeRows', { move: 'left' });
    page = await doc.session.request('treeRows', { limit: 50 });
    assert.deepEqual(
      page.rows.map((row) => row.name),
      ['r'],
    );
    assert.equal(page.needsMore, false);
    assert.equal(pulls, stoppedAt);
  } finally {
    await doc.close();
  }
});

test('explicit XPath resumes a paused browser and validates the complete source', {
  timeout: 10_000,
}, async () => {
  let ended = false;
  async function* streamed() {
    yield '<r>';
    for (let id = 0; id < 30; id++) yield `<i id="${id}"/>`;
    yield '</r>';
    ended = true;
  }
  const doc = await openBrowserXml(streamed());
  try {
    let page = await doc.session.request('treeRows', { limit: 4 });
    while (page.rows.length < 4) page = await doc.session.request('treeRows', { limit: 4 });
    assert.equal(ended, false);
    assert.equal(doc.session.paused, true);
    assert.deepEqual(
      (await doc.select('/r/i[@id="29"]')).map((match) => match.ref),
      [{ kind: 'element', elementId: 31 }],
    );
    assert.equal(ended, true);
    assert.equal(doc.session.complete, true);
    assert.equal((await doc.session.request('treeRows', { move: 'last' })).needsMore, false);
  } finally {
    await doc.close();
  }
});

test('a large hidden text body cannot force a full scan to fill the tree', {
  timeout: 10_000,
}, async () => {
  async function* streamed() {
    yield '<r><a><opaque>';
    for (let block = 0; block < 1000; block++) yield 'x'.repeat(65_536);
    yield '</opaque></a><later/></r>';
  }
  const doc = await openBrowserXml(streamed());
  try {
    await doc.session.request('treeRows', { limit: 50 });
    assert.ok(doc.session.sourceBytes <= 384 * 1024);
    assert.equal(doc.session.complete, false);
    assert.equal(doc.session.paused, true);
    const before = doc.session.sourceBytes;
    await doc.session.request('treeRows', { limit: 50, loadMore: false });
    await doc.session.request('overview', {});
    assert.equal(doc.session.sourceBytes, before);
  } finally {
    await doc.close();
  }
});

test('cancelling full loading releases its demand without closing the browser', {
  timeout: 10_000,
}, async () => {
  const release = Promise.withResolvers<void>();
  const blocked = Promise.withResolvers<void>();
  const paused = Promise.withResolvers<void>();
  let pulls = 0;
  async function* streamed() {
    pulls++;
    yield `<r>${'<i/>'.repeat(20)}`;
    pulls++;
    blocked.resolve();
    await release.promise;
    yield '<next/>';
    for (let id = 0; id < 100; id++) {
      pulls++;
      yield '<later/>';
    }
    yield '</r>';
  }
  const doc = await openBrowserXml(
    streamed(),
    {},
    {
      onProgress(value) {
        if (value.stage === 'paused' && value.nodes >= 22) paused.resolve();
      },
    },
  );
  const controller = new AbortController();
  try {
    await doc.session.request('treeRows', { limit: 4 });
    const query = doc.select('/*', { signal: controller.signal });
    await blocked.promise;
    controller.abort();
    await assert.rejects(query, { name: 'AbortError' });
    assert.equal((await doc.session.request('treeRows', { loadMore: false })).path, '/r');
    release.resolve();
    await paused.promise;
    await doc.session.request('overview', {});
    assert.equal(pulls, 2);
    assert.equal(doc.session.complete, false);
    assert.equal(doc.session.paused, true);
  } finally {
    controller.abort();
    release.resolve();
    await doc.close();
  }
});

test('pending navigation keeps its order ahead of later expansion presets', {
  timeout: 10_000,
}, async () => {
  const prefixVisible = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  async function* streamed() {
    yield '<r><a><x/>';
    await release.promise;
    yield '<y/></a><b/></r>';
  }
  const doc = await openBrowserXml(
    streamed(),
    {},
    {
      onProgress(value) {
        if (value.nodes >= 3) prefixVisible.resolve();
      },
    },
  );
  try {
    await prefixVisible.promise;
    await doc.session.request('treeRows', { limit: 1, loadMore: false });
    await Promise.all([
      doc.session.request('treeRows', { limit: 1, move: 'next' }),
      doc.session.request('treeRows', { limit: 1, move: 'next' }),
      doc.session.request('treeRows', { limit: 1, move: 'next' }),
      doc.session.request('expand', { depth: 2 }),
    ]);
    assert.equal(doc.session.complete, false);
    assert.equal(doc.session.paused, true);
    release.resolve();
    await doc.session.ensureComplete();
    const page = await doc.session.request('treeRows', { limit: 5, loadMore: false });
    assert.equal(page.path, '/r/a');
  } finally {
    release.resolve();
    await doc.close();
  }
});

test('formatted subtree copy stays within the loaded prefix', { timeout: 10_000 }, async () => {
  const paused = Promise.withResolvers<void>();
  let pulls = 0;
  async function* streamed() {
    pulls++;
    yield '<r xmlns:p="urn:p" xml:lang="en"><item>\n      <p:child id="one">x &amp; y</p:child>\n      <child/>\n </item>';
    pulls++;
    await new Promise(() => {});
  }
  const doc = await openBrowserXml(
    streamed(),
    {},
    {
      onProgress(value) {
        if (value.stage === 'paused' && value.nodes >= 4) paused.resolve();
      },
    },
  );
  try {
    await paused.promise;
    const copied = await doc.session.copyElement(2, { maxBytes: 1024, indent: 2 });
    assert.equal(
      copied,
      '<item xmlns:p="urn:p" xml:lang="en">\n  <p:child id="one">x &amp; y</p:child>\n  <child/>\n</item>\n',
    );
    assert.equal(pulls, 1);
    assert.equal(doc.session.complete, false);
    assert.equal(doc.session.paused, true);
  } finally {
    await doc.close();
  }
});

test('root and unfinished subtree copies are refused without reading more source', {
  timeout: 10_000,
}, async () => {
  const paused = Promise.withResolvers<void>();
  let pulls = 0;
  async function* streamed() {
    pulls++;
    yield '<r><first/><unfinished>';
    pulls++;
    await new Promise(() => {});
  }
  const doc = await openBrowserXml(
    streamed(),
    {},
    {
      onProgress(value) {
        if (value.stage === 'paused' && value.nodes >= 3) paused.resolve();
      },
    },
  );
  try {
    await paused.promise;
    for (const id of [0, 1])
      await assert.rejects(doc.session.copyElement(id, { maxBytes: 1024 }), {
        code: 'ERR_XML_COPY_ROOT',
      });
    await assert.rejects(doc.session.copyElement(3, { maxBytes: 1024 }), {
      code: 'ERR_XML_COPY_INCOMPLETE',
    });
    assert.equal(await doc.session.copyElement(2, { maxBytes: 1024 }), '<first/>\n');
    assert.equal(pulls, 1);
    assert.equal(doc.session.complete, false);
  } finally {
    await doc.close();
  }
});

test('subtree copy enforces serialized UTF-8 byte limits, including escaped text', async () => {
  const doc = await openBrowserXml(
    input(`<r><item>é</item><escaped>${'&amp;'.repeat(100)}</escaped></r>`),
  );
  try {
    await doc.session.ensureComplete();
    assert.equal(await doc.session.copyElement(2, { maxBytes: 16 }), '<item>é</item>\n');
    await assert.rejects(doc.session.copyElement(2, { maxBytes: 15 }), {
      code: 'ERR_XML_COPY_LIMIT',
    });
    await assert.rejects(doc.session.copyElement(3, { maxBytes: 200 }), {
      code: 'ERR_XML_COPY_LIMIT',
    });
  } finally {
    await doc.close();
  }
});

test('oversized closed subtree copy is unsupported while smaller siblings remain copyable', async () => {
  const doc = await openBrowserXml(
    input(`<r><big>${'x'.repeat(5 * 1024 * 1024)}</big><small/></r>`),
  );
  try {
    await doc.session.ensureComplete();
    await assert.rejects(doc.session.copyElement(2, { maxBytes: 1_048_576 }), {
      code: 'ERR_XML_COPY_LIMIT',
    });
    assert.equal(await doc.session.copyElement(3, { maxBytes: 1024 }), '<small/>\n');
  } finally {
    await doc.close();
  }
});

test('large ancestor metadata cannot bypass the safe subtree-copy budget', async () => {
  const doc = await openBrowserXml(
    input(`<r padding="${'x'.repeat(5 * 1024 * 1024)}"><small/></r>`),
  );
  try {
    await doc.session.ensureComplete();
    await assert.rejects(doc.session.copyElement(2, { maxBytes: 1_048_576 }), {
      code: 'ERR_XML_COPY_LIMIT',
    });
    const before = doc.session.sourceBytes;
    assert.equal(
      await doc.session.request('nodePath', {
        ref: { kind: 'element', elementId: 2 },
        kind: 'path',
      }),
      '/r/small',
    );
    assert.equal(doc.session.sourceBytes, before);
  } finally {
    await doc.close();
  }
});

test('independent copied XML retains effective namespace and XML-attribute overrides', async () => {
  const doc = await openBrowserXml(
    input(
      '<r xmlns="urn:r" xmlns:p="urn:p" xml:lang="en" xml:space="preserve"><b xmlns="" xml:lang="" xml:space="default"><p:item><a/></p:item></b></r>',
    ),
  );
  try {
    await doc.session.ensureComplete();
    const copied = await doc.session.copyElement(3, { maxBytes: 1024 });
    const standalone = await openXml(input(copied));
    try {
      assert.deepEqual(
        (
          await standalone.select(
            "/*[local-name()='item' and namespace-uri()='urn:p' and @xml:lang='' and @xml:space='default']",
          )
        ).map((match) => match.ref),
        [{ kind: 'element', elementId: 1 }],
      );
      assert.deepEqual(
        (await standalone.select("/*/*[local-name()='a' and namespace-uri()='']")).map(
          (match) => match.ref,
        ),
        [{ kind: 'element', elementId: 2 }],
      );
    } finally {
      await standalone.close();
    }
  } finally {
    await doc.close();
  }
});

test('closing a document cancels and joins its pending bounded copy', async () => {
  const doc = await openBrowserXml(input(`<r><item>${'<a/>'.repeat(1000)}</item></r>`));
  try {
    await doc.session.ensureComplete();
    const pending = assert.rejects(doc.session.copyElement(2, { maxBytes: 1_048_576 }), {
      code: 'ERR_XML_CLOSED',
    });
    await doc.close();
    await pending;
  } finally {
    await doc.close();
  }
});

test('jumping to the first row cancels unread relative navigation without more input', {
  timeout: 10_000,
}, async () => {
  const paused = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let pulls = 0;
  async function* streamed() {
    pulls++;
    yield '<r><i/><i/><i/>';
    pulls++;
    await release.promise;
    yield '<later/></r>';
  }
  const doc = await openBrowserXml(
    streamed(),
    {},
    {
      onProgress(value) {
        if (value.stage === 'paused' && value.nodes >= 4) paused.resolve();
      },
    },
  );
  try {
    await paused.promise;
    await doc.session.request('treeRows', { limit: 4, loadMore: false });
    const pending = await doc.session.request('treeRows', {
      limit: 4,
      move: 'pageDown',
      steps: 10,
    });
    assert.ok(pending.continuation);
    const before = pulls;
    assert.equal((await doc.session.request('treeRows', { limit: 4, move: 'first' })).path, '/r');
    assert.equal(pulls, before);
    release.resolve();
    await doc.session.ensureComplete();
    assert.equal((await doc.session.request('treeRows', { loadMore: false })).path, '/r');
  } finally {
    release.resolve();
    await doc.close();
  }
});
