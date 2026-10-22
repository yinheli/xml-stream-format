import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'vitest';
import { formatXml } from '../src/index.js';

async function* source(value: string | Buffer, size = 65_536) {
  for (let i = 0; i < value.length; i += size) yield value.slice(i, i + size);
}
async function formatted(
  value: string | Buffer,
  options: Parameters<typeof formatXml>[1] = {},
  size?: number,
) {
  let result = '';
  for await (const text of formatXml(source(value, size), options)) result += text;
  return result;
}
test('formats structure without modifying mixed direct text, with explicit reindent', async () => {
  assert.equal(await formatted('<r><a/><b x="1"/></r>'), '<r>\n  <a/>\n  <b x="1"/>\n</r>\n');
  assert.equal(await formatted('<r> <a/><b/> </r>'), '<r> <a/><b/> </r>\n');
  assert.equal(
    await formatted('<r> <a/><b/> </r>', { whitespace: 'reindent' }),
    '<r>\n  <a/>\n  <b/>\n</r>\n',
  );
  assert.equal(
    await formatted('<p><b/>正文<i/></p>', { whitespace: 'reindent' }),
    '<p><b/>正文<i/></p>\n',
  );
});

test('preserves protected content, XML whitespace semantics, empty CDATA and xml:space', async () => {
  for (const whitespace of ['preserve', 'reindent'] as const) {
    assert.equal(await formatted('<p><b/>正文<i/></p>', { whitespace }), '<p><b/>正文<i/></p>\n');
    assert.equal(await formatted('<r>\u00a0<a/></r>', { whitespace }), '<r>\u00a0<a/></r>\n');
    assert.equal(await formatted('<r> \n </r>', { whitespace }), '<r> \n </r>\n');
    assert.equal(
      await formatted('<r><![CDATA[]]><a/></r>', { whitespace }),
      '<r><![CDATA[]]><a/></r>\n',
    );
    assert.equal(
      await formatted('<r xml:space="preserve"><a xml:space="default"><b/></a><c/></r>', {
        whitespace,
      }),
      '<r xml:space="preserve"><a xml:space="default">\n    <b/>\n  </a><c/></r>\n',
    );
  }
  const first = await formatted('<r><a/><b><c/></b></r>');
  assert.equal(await formatted(first), first);
  assert.equal(await formatted('<r><a/></r>', { indent: 'tab' }), '<r>\n\t<a/>\n</r>\n');
  assert.equal(await formatted('<r><a/></r>', { indent: 0 }), '<r>\n<a/>\n</r>\n');
});

test('applies asynchronous mutations once in document order and validates skipped input', async () => {
  const calls: string[] = [];
  assert.equal(
    await formatted('<r><old secret="x" keep="y">&amp;</old><skip><x/></skip></r>', {
      hooks: {
        async onNode(node) {
          calls.push(node.name);
          await Promise.resolve();
          if (node.name === 'old') return { name: 'new' };
          if (node.name === 'skip') return false;
        },
        onAttribute(attribute) {
          calls.push(`@${attribute.name}`);
          if (attribute.name === 'secret') return null;
        },
        onText(text) {
          calls.push(text);
          return '<';
        },
      },
    }),
    '<r>\n  <new keep="y">&lt;</new>\n</r>\n',
  );
  assert.deepEqual(calls, ['r', 'old', '@secret', '@keep', '&', 'skip']);
  const cause = new Error('user hook');
  await assert.rejects(
    () =>
      formatted('<r/>', {
        hooks: {
          onNode() {
            throw cause;
          },
        },
      }),
    { code: 'ERR_XML_HOOK', cause, path: ['r'] },
  );
  await assert.rejects(
    () =>
      formatted('<r><skip><a></b></skip></r>', {
        hooks: {
          onNode(n) {
            if (n.name === 'skip') return false;
          },
        },
      }),
    { code: 'ERR_XML_PARSE' },
  );
  for (const name of ['bad name', 'unbound:x', 'xmlns:x'])
    await assert.rejects(
      () =>
        formatted('<r/>', {
          hooks: {
            onNode() {
              return { name };
            },
          },
        }),
      { code: 'ERR_XML_HOOK' },
    );
  await assert.rejects(
    () =>
      formatted('<r>x</r>', {
        hooks: {
          onText() {
            return '\ud800';
          },
        },
      }),
    { code: 'ERR_XML_HOOK' },
  );
});

test('preserves prototype-named attributes and references across byte boundaries', async () => {
  assert.equal(
    await formatted('<r __proto__="keep" constructor="also-keep" toString="keep-too"/>'),
    '<r __proto__="keep" constructor="also-keep" toString="keep-too"/>\n',
  );
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?><r a="&#x9;&#xA;&#xD;">中文😀&amp;&#xD;<![CDATA[x&y]]></r>';
  const expected =
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<r a="&#x9;&#xA;&#xD;">中文😀&amp;&#xD;<![CDATA[x&y]]></r>\n';
  const utf16 = Buffer.concat([
    Buffer.from([255, 254]),
    Buffer.from(xml.replace('UTF-8', 'UTF-16'), 'utf16le'),
  ]);
  const be = Buffer.from(utf16);
  be.swap16();
  for (const bytes of [Buffer.from(xml), utf16, be])
    for (const size of [1, 7, 65_536]) assert.equal(await formatted(bytes, {}, size), expected);
  assert.equal(
    await formatted(
      Buffer.concat([
        Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><r>'),
        Buffer.from([128]),
        Buffer.from('</r>'),
      ]),
    ),
    '<?xml version="1.0" encoding="UTF-8"?>\n<r>\u0080</r>\n',
  );
});

test('consumes exactly one leading BOM across string and UTF-8/UTF-16 chunks', async () => {
  const single = '\ufeff<r>\ufeff</r>';
  const double = '\ufeff\ufeff<r/>';
  for (const size of [1, 2, 3, 7, 65_536]) {
    for (const value of [single, double]) {
      for (const input of [
        value,
        Buffer.from(value),
        Buffer.from(value, 'utf16le'),
        Buffer.from(value, 'utf16le').swap16(),
      ]) {
        if (value === single) assert.equal(await formatted(input, {}, size), '<r>\ufeff</r>\n');
        else await assert.rejects(() => formatted(input, {}, size), { code: 'ERR_XML_PARSE' });
      }
    }
  }
});

test('rejects malformed XML and over-budget markup without limiting ordinary text or CDATA', async () => {
  for (const xml of [
    '',
    '<r/><a/>',
    '<r>',
    '<r a="1" a="2"/>',
    '<x:r/>',
    '<r xmlns:a="urn:x" xmlns:b="urn:x" a:q="1" b:q="2"/>',
  ])
    await assert.rejects(() => formatted(xml, {}, 1), { code: 'ERR_XML_PARSE' });
  await assert.rejects(() => formatted('<?xml version="1.1"?><r/>'), { code: 'ERR_XML_VERSION' });
  await assert.rejects(() => formatted('<!DOCTYPE r [<!ENTITY x "boom">]><r>&x;</r>', {}, 1), {
    code: 'ERR_XML_DTD',
  });
  for (const xml of ['<r a="', '<r></', '<r><!--', '<r><?p ', '<r>&', '<r>&#'])
    await assert.rejects(
      () =>
        formatted(xml + (xml.endsWith('#') ? '1' : 'a').repeat(100), { maxTokenCodeUnits: 32 }, 1),
      { code: 'ERR_XML_LIMIT' },
    );
  const xml = `<r>${'a'.repeat(100_000)}<![CDATA[${'&'.repeat(100_000)}]]></r>`;
  assert.equal(await formatted(xml, { maxTokenCodeUnits: 32 }, 7), `${xml}\n`);
  for (const input of [Buffer.from([60, 114, 62, 255, 60, 47, 114, 62]), '\ud800'])
    await assert.rejects(() => formatted(input), { code: 'ERR_XML_ENCODING' });
});

test('cleans owned workspace on early return and aborts waiting hooks without reading ahead', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xml-format-test-'));
  try {
    const iterator = formatXml(source(`<r>${'<a/>'.repeat(30_000)}</r>`), {
      tempDirectory: directory,
    });
    const first = await iterator.next();
    assert.equal(first.done, false);
    await iterator.return(undefined);
    assert.deepEqual(await readdir(directory), []);
    let pulls = 0;
    let hooks = 0;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const signal = new AbortController();
    async function* input() {
      pulls++;
      yield '<r><a/>';
      pulls++;
      yield '<b/></r>';
    }
    const result = formatXml(input(), {
      tempDirectory: directory,
      signal: signal.signal,
      hooks: {
        async onNode() {
          hooks++;
          entered();
          await new Promise<void>(() => {});
        },
      },
    }).next();
    await waiting;
    assert.equal(pulls, 1);
    signal.abort();
    await assert.rejects(result, { name: 'AbortError' });
    assert.equal(hooks, 1);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('observes a rejected source pull even when that pull synchronously aborts', async () => {
  const script = `
    import assert from 'node:assert/strict';
    import { setImmediate } from 'node:timers/promises';
    import { formatXml } from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
    for (const reason of [new Error('cancelled during source pull'), null]) {
      const controller = new AbortController();
      let returned = 0;
      const input = {
        [Symbol.asyncIterator]() {
          return {
            next() {
              controller.abort(reason);
              return Promise.reject(new Error('source failed after abort'));
            },
            return() { returned++; return Promise.resolve({ done: true }); },
          };
        },
      };
      await assert.rejects(formatXml(input, { signal: controller.signal }).next(), error => error === reason);
      await setImmediate();
      assert.equal(returned, 1);
    }
    process.stdout.write('cancelled cleanly\\n');
  `;
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    ['--unhandled-rejections=strict', '--input-type=module', '--eval', script],
    { cwd: new URL('../', import.meta.url), timeout: 10_000 },
  );
  assert.equal(stdout, 'cancelled cleanly\n');
  assert.equal(stderr, '');
});

test('serializes hook-generated CDATA terminators and carriage returns without data loss', async () => {
  assert.equal(
    await formatted('<r><![CDATA[x]]></r>', {
      hooks: {
        onText() {
          return ']]>\r';
        },
      },
    }),
    '<r><![CDATA[]]]]><![CDATA[>]]>&#xD;<![CDATA[]]></r>\n',
  );
});

test('aborts the next output chunk even inside a single oversized markup record', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xml-replay-abort-'));
  const controller = new AbortController();
  const iterator = formatXml(source(`<r><!--${'x'.repeat(200_000)}--></r>`), {
    signal: controller.signal,
    tempDirectory: directory,
  });
  try {
    await iterator.next();
    controller.abort();
    await assert.rejects(iterator.next(), { name: 'AbortError' });
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await iterator.return(undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test('retains declaration standalone only from the declaration and rejects invalid encoding-name grammar', async () => {
  const xml = '<?xml version="1.0"?><r standalone="yes"/>';
  const expected = '<?xml version="1.0" encoding="UTF-8"?>\n<r standalone="yes"/>\n';
  assert.equal(await formatted(xml), expected);
  assert.equal(await formatted(Buffer.from(xml)), expected);
  for (const name of ['!invalid', '123', ''])
    await assert.rejects(() => formatted(`<?xml version="1.0" encoding="${name}"?><r/>`), {
      code: 'ERR_XML_ENCODING',
    });
  const prefix = '<?xml version="1.0" encoding="A"';
  const suffix = ' standalone="yes"?>';
  const padding = ' '.repeat(4096 - prefix.length - suffix.length);
  assert.equal(
    await formatted(`${prefix + padding + suffix}<r/>`),
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<r/>\n',
  );
  await assert.rejects(() => formatted(`${prefix + padding} ${suffix}<r/>`), {
    code: 'ERR_XML_LIMIT',
  });
});

test('rejects an invalid hook attribute QName even when it could serialize as multiple valid attributes', async () => {
  let output = '';
  await assert.rejects(
    async () => {
      for await (const chunk of formatXml(source('<r a="old"/>'), {
        hooks: {
          onAttribute() {
            return { name: 'x="injected" y' };
          },
        },
      }))
        output += chunk;
    },
    { code: 'ERR_XML_HOOK' },
  );
  assert.equal(output, '');
});

test('node hooks observe read-only namespace declarations while attribute hooks change only ordinary attributes', async () => {
  const output = await formatted('<r xmlns="urn:r" xmlns:p="urn:p" p:x="1"/>', {
    hooks: {
      onNode(node) {
        if (
          node.attributes.some(
            (attribute) =>
              attribute.name === 'xmlns:p' &&
              attribute.prefix === 'xmlns' &&
              attribute.localName === 'p' &&
              attribute.namespaceURI === 'http://www.w3.org/2000/xmlns/' &&
              attribute.value === 'urn:p',
          )
        )
          return { name: 'p:new' };
      },
      onAttribute(attribute) {
        return { value: `${attribute.value}2` };
      },
    },
  });
  assert.equal(output, '<p:new xmlns="urn:r" xmlns:p="urn:p" p:x="12"/>\n');
});

test('allows bare xmlns element renames but protects namespace declaration attributes and prefixes', async () => {
  assert.equal(
    await formatted('<r/>', {
      hooks: {
        onNode() {
          return { name: 'xmlns' };
        },
      },
    }),
    '<xmlns/>\n',
  );
  assert.equal(
    await formatted('<r xmlns="urn:r"/>', {
      hooks: {
        onNode() {
          return { name: 'xmlns' };
        },
      },
    }),
    '<xmlns xmlns="urn:r"/>\n',
  );
  for (const name of ['xmlns', 'xmlns:x']) {
    await assert.rejects(
      () =>
        formatted('<r a="1"/>', {
          hooks: {
            onAttribute() {
              return { name };
            },
          },
        }),
      { code: 'ERR_XML_HOOK' },
    );
    await assert.rejects(
      () =>
        formatted('<r/>', {
          hooks: {
            onNode() {
              return { attributes: [{ name, value: 'urn:x' }] };
            },
          },
        }),
      { code: 'ERR_XML_HOOK' },
    );
  }
});

test('clearing the caller hook option cannot bypass transformed-name validation', async () => {
  const options: NonNullable<Parameters<typeof formatXml>[1]> = {
    hooks: {
      onNode() {
        options.hooks = undefined;
        return { name: 'r x="injected"' };
      },
    },
  };
  await assert.rejects(() => formatted('<r/>', options), { code: 'ERR_XML_HOOK' });
});

test('validates hooked names and values across oversized Unicode attributes without altering them', async () => {
  let calls = 0;
  const xml = `<r a="${'中文😀>'.repeat(8000)}&#x9;&#xA;&#xD;"/>`;
  const output = await formatted(
    xml,
    {
      hooks: {
        onNode() {
          calls++;
        },
      },
    },
    7,
  );
  assert.equal(output, `<r a="${'中文😀&gt;'.repeat(8000)}&#x9;&#xA;&#xD;"/>\n`);
  assert.equal(calls, 1);
});

test('keeps source-token limits independent of escaped hook-validation XML', async () => {
  const xml = `<r a="${'>'.repeat(20)}"/>`;
  const expected = `<r a="${'&gt;'.repeat(20)}"/>\n`;
  const hooks = { onNode() {} };
  assert.equal(await formatted(xml, { maxTokenCodeUnits: 32 }), expected);
  assert.equal(await formatted(xml, { maxTokenCodeUnits: 32, hooks }, 1), expected);
  await assert.rejects(() => formatted(xml, { maxTokenCodeUnits: 16, hooks }, 1), {
    code: 'ERR_XML_LIMIT',
  });
  await assert.rejects(() => formatted('<r><a><b/></a></r>', { maxDepth: 1, hooks }), {
    code: 'ERR_XML_LIMIT',
  });
});

test('charges original declaration code units before encoding normalization', async () => {
  const expected = '<?xml version="1.0" encoding="UTF-8"?>\n<r/>\n';
  const cases: { input: string | Buffer; limit: number }[] = [
    { input: '<?xml version="1.0" encoding="A"?><r/>', limit: 34 },
    { input: '<?xml version="1.0" encoding  =  "UTF-8"?><r/>', limit: 42 },
    { input: Buffer.from('<?xml version="1.0" encoding  =  "UTF-8"?><r/>'), limit: 42 },
    { input: Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><r/>'), limit: 43 },
    {
      input: Buffer.from('\ufeff<?xml version="1.0" encoding="UTF-16"?><r/>', 'utf16le'),
      limit: 39,
    },
    {
      input: Buffer.from('\ufeff<?xml version="1.0" encoding="UTF-16"?><r/>', 'utf16le').swap16(),
      limit: 39,
    },
  ];
  for (const { input, limit } of cases) {
    for (const size of [1, 65_536]) {
      assert.equal(await formatted(input, { maxTokenCodeUnits: limit }, size), expected);
      await assert.rejects(() => formatted(input, { maxTokenCodeUnits: limit - 1 }, size), {
        code: 'ERR_XML_LIMIT',
      });
    }
  }
  await assert.rejects(
    () => formatted('<?xml version="1.0" encoding  =  "UTF-8"?><r/>', { maxTokenCodeUnits: 38 }, 1),
    { code: 'ERR_XML_LIMIT' },
  );
  await assert.rejects(
    () =>
      formatted(
        Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><r/>'),
        { maxTokenCodeUnits: 38 },
        1,
      ),
    { code: 'ERR_XML_LIMIT' },
  );
  await assert.rejects(
    () =>
      formatted(
        `<?xml version="1.0" encoding="A"?><r a="${'x'.repeat(40)}"/>`,
        { maxTokenCodeUnits: 34 },
        1,
      ),
    { code: 'ERR_XML_LIMIT' },
  );
});

test('keeps serial hook validation aligned over multiple output batches', async () => {
  let calls = 0;
  const output = await formatted(`<r xmlns="urn:r">${'<a/>'.repeat(10_000)}</r>`, {
    hooks: {
      onNode() {
        calls++;
      },
    },
  });
  assert.equal(output, `<r xmlns="urn:r">\n${'  <a/>\n'.repeat(10_000)}</r>\n`);
  assert.equal(calls, 10_001);
});

test('does not repair non-XML whitespace in an encoding declaration', async () => {
  const xml = '<?xml version="1.0" encoding\u00a0=\u00a0"UTF-8"?><r/>';
  for (const input of [xml, Buffer.from(xml)])
    await assert.rejects(() => formatted(input), { code: 'ERR_XML_PARSE' });
});

test('retains input failures when source cleanup also rejects', async () => {
  const cleanup = new Error('cleanup failed');
  for (const primary of [new Error('source failed'), null, undefined]) {
    let returned = false;
    const input: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<string>> {
            throw primary;
          },
          async return(): Promise<IteratorResult<string>> {
            returned = true;
            throw cleanup;
          },
        };
      },
    };
    await assert.rejects(formatXml(input).next(), (error) => error === primary);
    assert.equal(returned, true);
  }
  const input: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<string>> {
          return { value: '\ud800x', done: false };
        },
        async return(): Promise<IteratorResult<string>> {
          throw cleanup;
        },
      };
    },
  };
  await assert.rejects(formatXml(input).next(), { code: 'ERR_XML_ENCODING' });
});
