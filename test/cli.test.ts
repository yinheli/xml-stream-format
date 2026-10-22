import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { link, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { copyText } from '../dist/cli/clipboard.js';
import type { TerminalMouseEvent } from '../dist/cli/mouse.js';
import { SgrMouseParser } from '../dist/cli/mouse.js';

const cli = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
async function run(
  args: string[],
  input = '',
  detached = false,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [cli, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (value) => {
    stdout += value;
  });
  child.stderr.setEncoding('utf8').on('data', (value) => {
    stderr += value;
  });
  child.stdin.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error;
  });
  child.stdin.end(input);
  const { promise, resolve, reject } = Promise.withResolvers<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>();
  child.once('error', reject);
  child.once('close', (code) => resolve({ code, stdout, stderr }));
  return await promise;
}

test('real CLI formats stdin and reports XML/argument/query failures separately', async () => {
  const result = await run(['format'], '<r><a/><b x="1"/></r>');
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '<r>\n  <a/>\n  <b x="1"/>\n</r>\n');
  assert.equal((await run([], '<r><a/></r>')).stdout, '<r>\n  <a/>\n</r>\n');
  assert.equal(
    (await run(['format', '--indent', 'tab'], '<r><a/></r>')).stdout,
    '<r>\n\t<a/>\n</r>\n',
  );
  assert.equal(
    (await run(['format', '--indent', '4'], '<r><a/></r>')).stdout,
    '<r>\n    <a/>\n</r>\n',
  );
  for (const args of [
    ['format', '--indent', '17'],
    ['format', '--max-depth', '0'],
    ['extract', '--xpath', '/*', '-N', 'r=a', '-N', 'r=b'],
  ]) {
    const error = await run(args, '<r/>');
    assert.equal(error.code, 2);
    assert.ok(error.stderr.startsWith('[ERR_CLI_ARGUMENT]'));
    assert.equal(error.stdout, '');
  }
  const invalid = await run(['format'], '<r>');
  assert.equal(invalid.code, 1);
  assert.ok(invalid.stderr.startsWith('[ERR_XML_PARSE]'));
  assert.equal(invalid.stdout, '');
  const query = await run(['extract', '--xpath', 'count(/*)'], '<r/>');
  assert.equal(query.code, 3);
  assert.match(query.stderr, /\[ERR_XPATH_RESULT_TYPE\]/);
  assert.equal(query.stdout, '');
});

test('view reports an absent controlling terminal in a detached session', {
  skip: process.platform === 'win32',
}, async () => {
  const result = await run(['view'], '<r/>', true);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /\[ERR_TTY_REQUIRED\]/);
});

test('XPath trace cannot write text or terminal controls outside XML output', async () => {
  const expression = 'trace(/*, "TRACE\u001b]52;c;aGk=\u0007")';
  const direct = await run(['extract', '--xpath', expression], '<r/>');
  assert.equal(direct.code, 0);
  assert.equal(direct.stdout, '<r/>\n');
  assert.doesNotMatch(direct.stderr, /TRACE|\u001b/);
  const directory = await mkdtemp(join(tmpdir(), 'xml-trace-test-'));
  try {
    const output = join(directory, 'output.xml');
    const saved = await run(['extract', '--xpath', expression, '-o', output], '<r/>');
    assert.equal(saved.code, 0);
    assert.equal(saved.stdout, '');
    assert.doesNotMatch(saved.stderr, /TRACE|\u001b/);
    assert.equal(await readFile(output, 'utf8'), '<r/>\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('real CLI atomically creates output without overwriting input, aliases or existing targets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xml-cli-test-'));
  const source = join(directory, 'source.xml');
  const output = join(directory, 'output.xml');
  const alias = join(directory, 'alias.xml');
  try {
    await writeFile(source, '<r><a/></r>');
    const result = await run(['format', source, '-o', output]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(await readFile(output, 'utf8'), '<r>\n  <a/>\n</r>\n');
    assert.equal((await run(['format', source, '-o', output])).code, 1);
    assert.equal((await run(['format', source, '-o', source])).code, 1);
    await link(source, alias);
    assert.equal((await run(['format', source, '-o', alias])).code, 1);
    assert.equal(await readFile(source, 'utf8'), '<r><a/></r>');
    const failed = join(directory, 'invalid.xml');
    assert.equal((await run(['format', '-', '-o', failed], '<r>')).code, 1);
    assert.deepEqual((await readdir(directory)).sort(), ['alias.xml', 'output.xml', 'source.xml']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('real extract supports XPath 3.1, default namespaces and source budget preflight', async () => {
  const file = fileURLToPath(new URL('./fixtures/query.xml', import.meta.url));
  const result = await run([
    'extract',
    file,
    '-N',
    'r=urn:r',
    '--xpath',
    '//r:item[@id = ["1", "3"]?*]',
  ]);
  assert.equal(result.code, 0);
  assert.deepEqual(
    [...result.stdout.matchAll(/ id="(\d)"/g)].map((m) => m[1]),
    ['1', '3'],
  );
  assert.equal((await run(['extract', file, '-N', '=urn:r', '--xpath', '//item/@id'])).code, 3);
  const missing = await run(['extract', file, '-N', '=urn:r', '--xpath', '//missing']);
  assert.equal(missing.code, 0);
  assert.equal(missing.stdout, '');
  for (const [args, input] of [
    [[file], ''],
    [['-'], `<r>${'x'.repeat(1000)}</r>`],
  ] as const) {
    const over = await run(['extract', ...args, '--xpath', '/*', '--max-source-bytes', '8'], input);
    assert.equal(over.code, 1);
    assert.ok(over.stderr.includes('[ERR_XPATH_LIMIT]'));
    assert.equal(over.stdout, '');
  }
});

test('real CLI reports input-open failures without unhandled stream errors or leftover output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xml-input-error-'));
  const missing = join(directory, 'missing.xml');
  try {
    const direct = await run(['format', missing]);
    assert.equal(direct.code, 1);
    assert.equal(direct.stdout, '');
    assert.match(direct.stderr, /^\[ENOENT\]/);
    const output = await run(['format', missing, '-o', join(directory, 'output.xml')]);
    assert.equal(output.code, 1);
    assert.equal(output.stdout, '');
    assert.match(output.stderr, /^\[ENOENT\]/);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('real CLI enforces the supported query timeout range as argument validation', async () => {
  for (const mode of [[], ['view'], ['extract', '--xpath', '/*']]) {
    for (const timeout of ['2147483648', '9007199254740991']) {
      const result = await run([...mode, '--query-timeout-ms', timeout], '<r/>');
      assert.equal(result.code, 2);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /^\[ERR_CLI_ARGUMENT\]/);
      assert.doesNotMatch(result.stderr, /TimeoutOverflowWarning/);
    }
  }
  const maximum = await run(
    ['extract', '--xpath', '/*', '--query-timeout-ms', '2147483647'],
    '<r/>',
  );
  assert.equal(maximum.code, 0);
  assert.equal(maximum.stdout, '<r/>\n');
});

for (const mode of ['format', 'extract']) {
  for (const [signal, expectedCode] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const) {
    test(`real ${mode} CLI cleans up and exits on one ${signal} with unread stdout`, {
      skip: process.platform === 'win32',
      timeout: 10_000,
    }, async (context) => {
      const directory = await mkdtemp(join(tmpdir(), 'xml-cli-signal-'));
      let child: ChildProcess | undefined;
      let exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
      try {
        const source = join(directory, 'source.xml');
        await writeFile(source, `<r>${'x'.repeat(8 * 1024 * 1024)}</r>`);
        child = spawn(
          process.execPath,
          [
            cli,
            mode,
            source,
            '--temp-directory',
            directory,
            ...(mode === 'extract' ? ['--xpath', '/*'] : []),
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        const output = child.stdout!;
        let stderr = '';
        child.stderr!.setEncoding('utf8').on('data', (value) => {
          stderr += value;
        });
        const exitState = Promise.withResolvers<{
          code: number | null;
          signal: NodeJS.Signals | null;
        }>();
        exited = exitState.promise;
        child.once('error', exitState.reject);
        child.once('exit', (code, exitSignal) => exitState.resolve({ code, signal: exitSignal }));
        const cancelled = once(context.signal, 'abort').then(() => {
          throw context.signal.reason;
        });
        // A readable listener observes real output without consuming any bytes or
        // releasing backpressure from the child's stdout pipe.
        await Promise.race([
          once(output, 'readable', { signal: context.signal }),
          exited.then((result) => {
            throw new Error(`CLI exited before output: ${JSON.stringify(result)}; ${stderr}`);
          }),
          cancelled,
        ]);
        assert.ok(output.readableLength > 0);
        assert.equal(child.kill(signal), true);
        const result = await Promise.race([exited, cancelled]);
        assert.deepEqual(result, { code: expectedCode, signal: null });
        assert.deepEqual(await readdir(directory), ['source.xml']);
      } finally {
        // A failed regression must not leave the hung child or pipe handles alive.
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        await exited?.catch(() => {});
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}

test('clipboard cancellation stops waiting for a stalled source without writing', {
  timeout: 5000,
}, async () => {
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  let returned = false;
  let output = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += String(chunk);
      callback();
    },
  });
  const source: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          entered.resolve();
          return new Promise<IteratorResult<string>>(() => {});
        },
        async return(): Promise<IteratorResult<string>> {
          returned = true;
          return { value: undefined, done: true };
        },
      };
    },
  };
  try {
    const pending = copyText(source, { mode: 'osc52', output: stream, signal: controller.signal });
    await entered.promise;
    controller.abort();
    await assert.rejects(pending, (error) => error === controller.signal.reason);
    assert.equal(returned, true);
    assert.equal(output, '');
  } finally {
    controller.abort();
    stream.destroy();
  }
});

test('SGR mouse demultiplexing preserves UTF-8 keyboard bytes at every split', () => {
  const bytes = Buffer.from('j界😀\u001b[<28;12;8Mk\u001b[<65;4;5Ml');
  for (let split = 0; split <= bytes.length; split++) {
    const parser = new SgrMouseParser();
    const events: TerminalMouseEvent[] = [];
    const keys: Buffer[] = [];
    const keyboard = (chunk: Uint8Array | string) => {
      keys.push(Buffer.from(chunk));
    };
    parser.push(bytes.subarray(0, split), (event) => events.push(event), keyboard);
    parser.push(bytes.subarray(split), (event) => events.push(event), keyboard);
    parser.finish(keyboard);
    assert.equal(Buffer.concat(keys).toString(), 'j界😀kl');
    assert.deepEqual(events, [
      { action: 'press', button: 0, x: 12, y: 8, shift: true, alt: true, ctrl: true },
      { action: 'wheel', button: 65, x: 4, y: 5, shift: false, alt: false, ctrl: false },
    ]);
  }
});

test('delayed SGR prefixes release Escape without leaking bracket or numeric navigation', () => {
  for (const prefix of ['\u001b', '\u001b[']) {
    const parser = new SgrMouseParser();
    const events: TerminalMouseEvent[] = [];
    const keys: Buffer[] = [];
    const keyboard = (chunk: Uint8Array | string) => {
      keys.push(Buffer.from(chunk));
    };
    parser.push(prefix, (event) => events.push(event), keyboard);
    parser.flushPendingEscape(keyboard);
    assert.equal(Buffer.concat(keys).toString(), '\u001b');
    parser.push(
      prefix.length === 1 ? '[<64;8;9M' : '<64;8;9M',
      (event) => events.push(event),
      keyboard,
    );
    parser.push('j', (event) => events.push(event), keyboard);
    assert.equal(Buffer.concat(keys).toString(), '\u001bj');
    assert.deepEqual(events, [
      { action: 'wheel', button: 64, x: 8, y: 9, shift: false, alt: false, ctrl: false },
    ]);
  }
});

test('bracketed paste remains literal and mouse parsing resumes after its end marker', () => {
  const parser = new SgrMouseParser();
  const events: TerminalMouseEvent[] = [];
  const keys: Buffer[] = [];
  const keyboard = (chunk: Uint8Array | string) => {
    keys.push(Buffer.from(chunk));
  };
  const paste = '\u001b[200~界😀\u001b[<0;1;2M\u001b[201~';
  for (const byte of Buffer.from(`${paste}\u001b[<0;3;4m`))
    parser.push(Buffer.from([byte]), (event) => events.push(event), keyboard);
  parser.finish(keyboard);
  assert.equal(Buffer.concat(keys).toString(), paste);
  assert.deepEqual(events, [
    { action: 'release', button: 0, x: 3, y: 4, shift: false, alt: false, ctrl: false },
  ]);
});

test('malformed and overlong mouse reports cannot become keys and Ctrl+C remains usable', () => {
  for (const report of [
    '\u001b[<0;0;1M',
    '\u001b[<300;1;1M',
    '\u001b[<0;2147483648;1M',
    '\u001b[<64;1;1m',
    `\u001b[<${'1'.repeat(10_000)};1;1M`,
  ]) {
    const parser = new SgrMouseParser();
    const events: TerminalMouseEvent[] = [];
    const keys: Buffer[] = [];
    const keyboard = (chunk: Uint8Array | string) => {
      keys.push(Buffer.from(chunk));
    };
    parser.push(`${report}j`, (event) => events.push(event), keyboard);
    parser.push('\u001b[<0;\u0003q', (event) => events.push(event), keyboard);
    parser.finish(keyboard);
    assert.deepEqual(events, []);
    assert.equal(Buffer.concat(keys).toString(), 'j\u0003q');
  }
});
