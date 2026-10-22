import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { openBrowserXml } from '../dist/document/document.js';

async function* input(xml: string) {
  yield xml;
}

test('folded XML crosses unfinished hidden branches only on explicit navigation demand', {
  timeout: 10_000,
}, async () => {
  async function* streamed() {
    yield '<r><branch><x>';
    for (let block = 0; block < 8; block++) yield 'x'.repeat(65_536);
    yield '</x></branch><later code="reachable"/></r>';
  }
  const doc = await openBrowserXml(streamed(), {}, { preview: true });
  try {
    await doc.session.request('xmlRows', { limit: 3 });
    const folded = await doc.session.request('xmlRows', {
      limit: 3,
      selectedId: 2,
      move: 'left',
      loadMore: false,
    });
    assert.match(folded.rows.find((row) => row.elementId === 2)!.text, /\[incomplete\]/);
    const before = doc.session.sourceBytes;
    await doc.session.request('xmlRows', { limit: 5, loadMore: false });
    assert.equal(doc.session.sourceBytes, before);
    let next = await doc.session.request('xmlRows', { limit: 3, move: 'next' });
    assert.ok(doc.session.sourceBytes > before);
    assert.ok(doc.session.sourceBytes - before <= 256 * 1024);
    for (let attempt = 0; next.continuation && attempt < 32; attempt++)
      next = await doc.session.request('xmlRows', { limit: 3, move: 'next' });
    assert.equal(next.path, '/r/later');
    assert.match(next.rows[next.selectedRow]!.text, /code="reachable"/);
  } finally {
    await doc.close();
  }
});

test('single XML rows retain leaf values, mixed tails and closing-tag mouse ownership', async () => {
  const doc = await openBrowserXml(
    input(
      '<r><p>head<b role="important"><i>inside</i></b>tail<c><![CDATA[x<y]]></c>end</p><last/></r>',
    ),
    {},
    { preview: true },
  );
  try {
    await doc.session.ensureComplete();
    let page = await doc.session.request('xmlRows', {
      limit: 20,
      columns: 120,
      selectedId: 3,
      move: 'left',
    });
    const folded = page.rows.find((row) => row.foldElementId === 3)!;
    assert.match(folded.text, /<b role="important">.*<\/b>tail/);
    assert.equal(folded.expanded, false);
    assert.equal(
      page.rows.some((row) => row.text.includes('inside')),
      false,
    );
    const ownerAt = (column: number) =>
      folded.hits.find((hit) => column >= hit.from && column < hit.to)?.elementId;
    assert.equal(ownerAt(folded.text.indexOf('</b>') + 2), 3);
    assert.equal(ownerAt(folded.text.indexOf('tail')), 2);
    assert.ok(page.rows.some((row) => row.text.includes('<![CDATA[x<y]]>')));
    page = await doc.session.request('xmlRows', {
      limit: 20,
      selectKey: folded.key,
      selectedId: 2,
      loadMore: false,
    });
    assert.equal(page.path, '/r/p');
    assert.equal(page.rows[page.selectedRow]!.key, folded.key);
    page = await doc.session.request('xmlRows', {
      limit: 20,
      selectKey: folded.key,
      selectedId: 3,
      move: 'toggle',
    });
    assert.ok(page.rows.some((row) => row.text.includes('<i>inside</i>')));
    assert.equal(page.rows.find((row) => row.foldElementId === 3)!.expanded, true);
    await doc.session.request('expand', { depth: 3 });
    page = await doc.session.request('xmlRows', { limit: 20, move: 'first' });
    assert.ok(page.rows.some((row) => row.text.includes('<![CDATA[x<y]]>')));
    assert.equal(
      page.rows.some((row) => row.text.includes('inside')),
      false,
    );
  } finally {
    await doc.close();
  }
});

test('byte-bounded XML pages retain keyboard and absolute-jump cursors', async () => {
  const doc = await openBrowserXml(
    input(
      '<r>' +
        Array.from({ length: 40 }, (_, id) => `<i id="${id}">${'界'.repeat(1800)}</i>`).join('') +
        '</r>',
    ),
    {},
    { preview: true },
  );
  try {
    await doc.session.ensureComplete();
    let page = await doc.session.request('xmlRows', { limit: 40, columns: 4096, selectedId: 25 });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 65_536);
    assert.ok(page.selectedRow >= 0);
    assert.match(page.rows[page.selectedRow]!.text, /id="23"/);
    page = await doc.session.request('xmlRows', { limit: 40, columns: 4096, move: 'last' });
    assert.ok(page.selectedRow >= 0);
    assert.equal(page.rows[page.selectedRow]!.text.trim(), '</r>');
    await doc.session.request('xmlRows', { limit: 40, columns: 4096, move: 'first' });
    page = await doc.session.request('xmlRows', {
      limit: 40,
      columns: 4096,
      move: 'pageDown',
      steps: 25,
    });
    assert.ok(page.selectedRow >= 0);
    assert.match(page.rows[page.selectedRow]!.text, /id="24"/);
  } finally {
    await doc.close();
  }
});

test('disk-backed browsing evicts names and sibling records without losing backscroll', {
  timeout: 15_000,
}, async () => {
  const xml =
    '<r>' +
    Array.from({ length: 2048 }, (_, id) => `<n${id}>v${id}</n${id}>`).join('') +
    Array.from({ length: 4096 }, (_, id) => `<i>v${id}</i>`).join('') +
    '</r>';
  const doc = await openBrowserXml(input(xml), { maxIndexBytes: 1_048_576 }, { preview: true });
  try {
    await doc.session.ensureComplete();
    const overview = await doc.session.request('overview', {});
    assert.equal(overview.totalElements, 6145);
    assert.equal(overview.totalDistinctNames, 2050);
    assert.equal(overview.namesTruncated, true);
    assert.equal(overview.names.length, 20);
    assert.deepEqual(overview.names[0], { name: 'i', namespaceURI: '', count: 4096 });
    assert.ok(overview.indexBytes <= 1_048_576);
    await doc.session.request('xmlRows', { limit: 4, move: 'last' });
    let page = await doc.session.request('xmlRows', { limit: 4, move: 'previous' });
    assert.equal(page.path, '/r/i[4096]');
    assert.match(page.rows[page.selectedRow]!.text, /<i>v4095<\/i>/);
    page = await doc.session.request('xmlRows', { limit: 4, selectedId: 2 });
    assert.equal(page.path, '/r/n0');
    assert.match(page.rows[page.selectedRow]!.text, /<n0>v0<\/n0>/);
    await doc.session.request('xmlRows', { limit: 4, selectedId: 1, move: 'left' });
    page = await doc.session.request('xmlRows', { limit: 4, move: 'right' });
    assert.ok(page.rows.some((row) => row.text.includes('<n0>v0</n0>')));
  } finally {
    await doc.close();
  }
});

test('queued XML movement is superseded by gg before it can pull source', {
  timeout: 10_000,
}, async () => {
  let pulls = 0;
  const paused = Promise.withResolvers<void>();
  async function* streamed() {
    pulls++;
    yield '<r><i/><i/><i/>';
    for (let block = 0; block < 100; block++) {
      pulls++;
      yield '<i/>'.repeat(4096);
    }
    yield '</r>';
  }
  const doc = await openBrowserXml(
    streamed(),
    {},
    {
      preview: true,
      onProgress(value) {
        if (value.stage === 'paused' && value.nodes >= 4) paused.resolve();
      },
    },
  );
  try {
    await paused.promise;
    await doc.session.request('xmlRows', { limit: 4, loadMore: false });
    const before = doc.session.sourceBytes;
    const pending = Array.from({ length: 12 }, () =>
      doc.session.request('xmlRows', { limit: 4, move: 'pageDown', steps: 100 }),
    );
    const first = doc.session.request('xmlRows', { limit: 4, move: 'first' });
    await Promise.all(pending);
    assert.equal((await first).path, '/r');
    assert.equal(pulls, 1);
    assert.equal(doc.session.sourceBytes, before);
    const last = await doc.session.request('xmlRows', { limit: 4, move: 'last' });
    assert.equal(last.path, '/r/i[3]');
    assert.equal(doc.session.sourceBytes, before);
    assert.equal(doc.session.complete, false);
  } finally {
    await doc.close();
  }
});

test('wheel scrolling preserves selection and stale mouse keys cannot select hidden rows', async () => {
  const doc = await openBrowserXml(
    input(`<r>${Array.from({ length: 20 }, (_, id) => `<i>${id}</i>`).join('')}</r>`),
    {},
    { preview: true },
  );
  try {
    await doc.session.ensureComplete();
    const first = await doc.session.request('xmlRows', { limit: 3 });
    let page = await doc.session.request('xmlRows', { limit: 3, scroll: 3 });
    assert.equal(page.selectedId, 1);
    assert.equal(page.selectedRow, -1);
    assert.match(page.rows[0]!.text, /<i>2<\/i>/);
    page = await doc.session.request('xmlRows', {
      limit: 3,
      selectKey: first.rows[0]!.key,
      selectedId: 1,
    });
    assert.equal(page.selectedRow, -1);
    assert.match(page.rows[0]!.text, /<i>2<\/i>/);
    page = await doc.session.request('xmlRows', { limit: 3, move: 'next' });
    assert.equal(page.path, '/r/i[1]');
    assert.match(page.rows[page.selectedRow]!.text, /<i>0<\/i>/);
  } finally {
    await doc.close();
  }
});

test('pending XML continuations use current geometry and preserve Unicode horizontal access', {
  timeout: 10_000,
}, async () => {
  const paused = Promise.withResolvers<void>();
  async function* streamed() {
    yield '<r a="abcdefghijklmnopqrst界😀TAIL" b="\u009bsafe"><i/><i/><i/>';
    await new Promise(() => {});
  }
  const doc = await openBrowserXml(
    streamed(),
    {},
    {
      preview: true,
      onProgress(value) {
        if (value.stage === 'paused' && value.nodes >= 4) paused.resolve();
      },
    },
  );
  try {
    await paused.promise;
    await doc.session.request('xmlRows', { limit: 4, columns: 40, loadMore: false });
    const pending = await doc.session.request('xmlRows', {
      limit: 4,
      columns: 40,
      move: 'pageDown',
      steps: 100,
      loadMore: false,
    });
    assert.ok(pending.continuation);
    const before = doc.session.sourceBytes;
    let page = await doc.session.request('xmlRows', {
      limit: 2,
      columns: 8,
      column: 26,
      loadMore: false,
    });
    assert.equal(page.column, 26);
    assert.ok(page.rows.length <= 2);
    assert.equal(doc.session.sourceBytes, before);
    page = await doc.session.request('xmlRows', {
      limit: 2,
      columns: 8,
      column: 26,
      selectedId: 1,
      loadMore: false,
    });
    assert.equal(page.rows[page.selectedRow]!.text, '界😀TAIL');
    page = await doc.session.request('xmlRows', {
      limit: 2,
      columns: 200,
      column: 0,
      loadMore: false,
    });
    assert.ok(!page.rows[page.selectedRow]!.text.includes('\u009b'));
    assert.match(page.rows[page.selectedRow]!.text, /safe/);
  } finally {
    await doc.close();
  }
});

test('more than 256 inline closing owners remain reachable through horizontal fragments', {
  timeout: 15_000,
}, async () => {
  const doc = await openBrowserXml(
    input(`<r>${'<n>head'.repeat(300)}<z/>${'tail</n>'.repeat(300)}</r>`),
    {},
    { preview: true },
  );
  try {
    await doc.session.ensureComplete();
    await doc.session.request('expand', { depth: 1000 });
    const first = await doc.session.request('xmlRows', {
      limit: 1,
      columns: 4096,
      selectedId: 302,
    });
    assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 65_536);
    assert.ok(first.rows[first.selectedRow]!.hits.length <= 256);
    let text = '';
    const owners = new Set<number>();
    for (let column = 0; column < 4096; column += 128) {
      const page = await doc.session.request('xmlRows', { limit: 1, columns: 128, column });
      const row = page.rows[page.selectedRow]!;
      text += row.text;
      for (const hit of row.hits) owners.add(hit.elementId);
    }
    assert.equal(text.trimStart(), `<z/>${'tail</n>'.repeat(300)}`);
    assert.deepEqual(
      [...owners].sort((a, b) => a - b),
      Array.from({ length: 301 }, (_, id) => id + 2),
    );
  } finally {
    await doc.close();
  }
});

test('oversized display paths do not prevent depth changes or XML extraction', async () => {
  const name = 'r'.repeat(17_000);
  const doc = await openBrowserXml(
    input(`<${name}><small>value</small></${name}>`),
    {},
    { preview: true },
  );
  try {
    await doc.session.ensureComplete();
    let page = await doc.session.request('xmlRows', { limit: 3, columns: 40 });
    assert.equal(page.pathTruncated, true);
    await doc.session.request('expand', { depth: 0 });
    page = await doc.session.request('xmlRows', { limit: 3, columns: 40 });
    assert.equal(page.rows.length, 1);
    assert.equal(page.rows[0]!.expanded, false);
    let extracted = '';
    for await (const chunk of doc.session.extractElements([2])) extracted += chunk;
    assert.equal(extracted, '<small>value</small>\n');
    await assert.rejects(
      doc.session.request('nodePath', { ref: { kind: 'element', elementId: 2 }, kind: 'path' }),
      { code: 'ERR_XML_INDEX_LIMIT' },
    );
    assert.equal(
      await doc.session.request('nodePath', { ref: { kind: 'document', id: 0 }, kind: 'path' }),
      '/',
    );
  } finally {
    await doc.close();
  }
});

test('metadata-only copy paths retain namespace literals, ordinals and non-element owners', async () => {
  const doc = await openBrowserXml(
    input('<!--top--><r xmlns="urn:a&apos;b&quot;c"><a id="first"/><a id="second">value</a></r>'),
  );
  try {
    await doc.session.ensureComplete();
    const xpath = await doc.session.request('nodePath', {
      ref: { kind: 'element', elementId: 3 },
      kind: 'xpath',
    });
    assert.deepEqual(
      (await doc.select(xpath)).map((match) => match.ref),
      [{ kind: 'element', elementId: 3 }],
    );
    assert.equal(
      await doc.session.request('nodePath', {
        ref: { kind: 'attribute', ownerElementId: 3, namespaceURI: '', localName: 'id' },
        kind: 'path',
      }),
      '/r/a[2]/@id',
    );
    assert.equal(
      await doc.session.request('nodePath', {
        ref: { kind: 'text', parentElementId: 3, textRunOrdinal: 1 },
        kind: 'path',
      }),
      '/r/a[2]/text()[1]',
    );
    assert.equal(
      await doc.session.request('nodePath', {
        ref: { kind: 'comment', parentId: 0, ordinal: 1 },
        kind: 'path',
      }),
      '/comment()[1]',
    );
  } finally {
    await doc.close();
  }
});

test('closing a browser releases suspended document and element exports before workspace cleanup', {
  timeout: 10_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xml-browser-close-'));
  const doc = await openBrowserXml(input(`<r><part>${'<x>value</x>'.repeat(10_000)}</part></r>`), {
    tempDirectory: directory,
  });
  try {
    const element = doc.session.extractElements([2]);
    const document = doc.session.extractDocument();
    const chunks = await Promise.all([element.next(), document.next()]);
    assert.match(chunks[0].value!, /^<part>/);
    assert.match(chunks[1].value!, /^<r>/);
    await doc.close();
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await doc.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('hundreds of inline siblings keep distinct text and parent-tail mouse owners', async () => {
  const xml =
    '<r><p>head' +
    Array.from({ length: 600 }, (_, id) => `<e id="${id}"/>tail`).join('') +
    '</p></r>';
  const doc = await openBrowserXml(input(xml), {}, { preview: true });
  try {
    await doc.session.ensureComplete();
    const seen = new Set<number>();
    let page = await doc.session.request('xmlRows', { limit: 128, columns: 80 });
    for (let step = 0; step < 10; step++) {
      for (const row of page.rows) {
        const match = /<e id="(\d+)"\/>tail/.exec(row.text);
        if (!match) continue;
        const id = Number(match[1]);
        seen.add(id);
        const element = row.hits.find(
          (hit) => row.text.indexOf('<e') >= hit.from && row.text.indexOf('<e') < hit.to,
        );
        const tail = row.hits.find(
          (hit) => row.text.indexOf('tail') >= hit.from && row.text.indexOf('tail') < hit.to,
        );
        assert.equal(element?.elementId, id + 3);
        assert.equal(tail?.elementId, 2);
      }
      if (page.rows.at(-1)?.text.trim() === '</r>') break;
      page = await doc.session.request('xmlRows', {
        limit: 128,
        columns: 80,
        scroll: page.rows.length,
      });
    }
    assert.deepEqual(
      [...seen],
      Array.from({ length: 600 }, (_, id) => id),
    );
  } finally {
    await doc.close();
  }
});

test('too-small browser budgets reject before source reads and release partial stores', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xml-browser-budget-'));
  let read = false;
  async function* source() {
    read = true;
    yield '<r/>';
  }
  try {
    await assert.rejects(
      openBrowserXml(
        source(),
        { maxIndexBytes: 512 * 1024, tempDirectory: directory },
        { preview: true },
      ),
      { code: 'ERR_XML_INDEX_LIMIT' },
    );
    assert.equal(read, false);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Unicode source chunks cannot overshoot a viewport refill byte budget', {
  timeout: 10_000,
}, async () => {
  const paused = Promise.withResolvers<void>();
  async function* source() {
    yield '<r><a>';
    for (let chunk = 0; chunk < 6; chunk++) yield '界'.repeat(16_384);
    await new Promise(() => {});
  }
  const doc = await openBrowserXml(
    source(),
    {},
    {
      onProgress(value) {
        if (value.stage === 'paused' && value.nodes >= 2) paused.resolve();
      },
    },
  );
  try {
    await paused.promise;
    const before = doc.session.sourceBytes;
    const page = await doc.session.request('treeRows', {
      selectedId: 2,
      move: 'nextSibling',
      limit: 1,
    });
    assert.ok(page.continuation);
    assert.ok(doc.session.sourceBytes - before <= 256 * 1024);
    assert.equal(doc.session.complete, false);
  } finally {
    await doc.close();
  }
});

test('explicit XML navigation reaches unread epilog comments after a closed folded root', {
  timeout: 10_000,
}, async () => {
  const paused = Promise.withResolvers<void>();
  async function* source() {
    yield '<r><a/></r>';
    yield `<!--TAIL${'x'.repeat(16_384)}`;
    yield `${'y'.repeat(16_384)}-->`;
  }
  const doc = await openBrowserXml(
    source(),
    {},
    {
      preview: true,
      onProgress(value) {
        if (value.stage === 'paused' && value.nodes >= 2) paused.resolve();
      },
    },
  );
  try {
    await paused.promise;
    await doc.session.request('xmlRows', {
      limit: 3,
      selectedId: 1,
      move: 'left',
      loadMore: false,
    });
    const before = doc.session.sourceBytes;
    await doc.session.request('xmlRows', { limit: 3, loadMore: false });
    assert.equal(doc.session.sourceBytes, before);
    const page = await doc.session.request('xmlRows', { limit: 3, move: 'next' });
    assert.equal(page.selectedId, 0);
    assert.match(page.rows[page.selectedRow]!.text, /^<!--TAIL/);
  } finally {
    await doc.close();
  }
});
