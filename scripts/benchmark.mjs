import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { link, mkdir, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const keep = process.argv.includes('--keep');
const directoryArgument = process.argv.indexOf('--directory');
const directory =
  directoryArgument >= 0
    ? resolve(process.argv[directoryArgument + 1])
    : await mkdtemp(join(tmpdir(), 'xml-benchmark-'));
await mkdir(directory, { recursive: true });
const temporary = join(directory, 'work');
await mkdir(temporary, { recursive: true });
const monitor = join(directory, 'monitor.mjs');

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
    if (!bytesWritten) throw new Error('Fixture write made no progress');
    offset += bytesWritten;
  }
}

const nodeText = 'x'.repeat(1024);
const nodeRow = (id) => `<item id="${id}"><value>${nodeText}</value></item>`;

function fixtureShape(target, kind) {
  if (kind === 'nodes') {
    let bytes = 3;
    let id = 0;
    while (bytes < target) {
      const rowBytes = nodeRow(id).length;
      const groupEnd = 10 ** String(id).length;
      const rows = Math.min(groupEnd - id, Math.ceil((target - bytes) / rowBytes));
      bytes += rows * rowBytes;
      id += rows;
    }
    return {
      size: bytes + 4,
      prefix: Buffer.from(`<r>${id ? nodeRow(0) : ''}`),
      suffix: Buffer.from(`${id ? nodeRow(id - 1) : ''}</r>`),
    };
  }
  const opening = kind === 'cdata' ? '<r><![CDATA[' : '<r>';
  const closing = kind === 'cdata' ? ']]></r>' : '</r>';
  const sample = (kind === 'cdata' ? '&' : 'x').repeat(Math.min(target, 1024));
  return {
    size: target + opening.length + closing.length,
    prefix: Buffer.from(opening + sample),
    suffix: Buffer.from(sample + closing),
  };
}

async function validateFixture(path, metadata, target, kind) {
  const expected = fixtureShape(target, kind);
  const invalid = () =>
    new Error(
      `Invalid cached ${kind} fixture ${path}: expected ${expected.size} bytes with generated ${kind} prefix and tail; found ${metadata.size} bytes`,
    );
  if (!metadata.isFile() || metadata.size !== expected.size) throw invalid();
  const handle = await open(path, 'r');
  try {
    for (const [position, sample] of [
      [0, expected.prefix],
      [expected.size - expected.suffix.length, expected.suffix],
    ]) {
      const actual = Buffer.alloc(sample.length);
      let offset = 0;
      while (offset < actual.length) {
        const { bytesRead } = await handle.read(
          actual,
          offset,
          actual.length - offset,
          position + offset,
        );
        if (!bytesRead) throw invalid();
        offset += bytesRead;
      }
      if (!actual.equals(sample)) throw invalid();
    }
  } finally {
    await handle.close();
  }
}

async function fixture(name, target, kind) {
  const path = join(directory, name);
  let metadata;
  try {
    metadata = await stat(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (metadata) {
    await validateFixture(path, metadata, target, kind);
    return path;
  }
  const staging = join(directory, `.${name}.${randomUUID()}.tmp`);
  const handle = await open(staging, 'wx', 0o600);
  let closed = false;
  try {
    await writeAll(handle, Buffer.from(kind === 'cdata' ? '<r><![CDATA[' : '<r>'));
    if (kind === 'nodes') {
      let bytes = 3;
      let id = 0;
      while (bytes < target) {
        const rows = [];
        for (let count = 0; count < 64 && bytes < target; count++) {
          const row = nodeRow(id++);
          rows.push(row);
          bytes += row.length;
        }
        await writeAll(handle, Buffer.from(rows.join('')));
      }
    } else {
      const chunk = Buffer.alloc(65_536, kind === 'cdata' ? 38 : 120);
      for (let remaining = target; remaining > 0; remaining -= chunk.length)
        await writeAll(handle, chunk.subarray(0, Math.min(chunk.length, remaining)));
    }
    await writeAll(handle, Buffer.from(kind === 'cdata' ? ']]></r>' : '</r>'));
    await handle.close();
    closed = true;
    await link(staging, path);
  } finally {
    try {
      if (!closed) await handle.close();
    } finally {
      await rm(staging, { force: true });
    }
  }
  return path;
}

const fixtures = [
  { name: 'nodes-64MiB.xml', target: 64 * 1024 ** 2, kind: 'nodes' },
  { name: 'nodes-1GiB.xml', target: 1024 ** 3, kind: 'nodes' },
  { name: 'text-64MiB.xml', target: 64 * 1024 ** 2, kind: 'text' },
  { name: 'cdata-64MiB.xml', target: 64 * 1024 ** 2, kind: 'cdata' },
];
const nullFile = await open(devNull, 'w');
const results = [];
try {
  for (const entry of fixtures) entry.path = await fixture(entry.name, entry.target, entry.kind);
  await writeFile(
    monitor,
    `import {readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
const started=performance.now();let firstByteMs=null;let peak={rss:0,heapUsed:0,external:0,arrayBuffers:0,tempBytes:0};
const original=process.stdout.write;
process.stdout.write=function(...args){if(firstByteMs===null)firstByteMs=performance.now()-started;return Reflect.apply(original,this,args)};
function sample(){const memory=process.memoryUsage();for(const key of ['rss','heapUsed','external','arrayBuffers'])peak[key]=Math.max(peak[key],memory[key]);let bytes=0;try{for(const entry of readdirSync(process.env.XML_BENCH_TEMP)){const folder=join(process.env.XML_BENCH_TEMP,entry);for(const name of readdirSync(folder)){try{bytes+=statSync(join(folder,name)).size}catch{}}}}catch{}peak.tempBytes=Math.max(peak.tempBytes,bytes)}
const interval=setInterval(sample,20);interval.unref();process.on('exit',()=>{sample();peak.rss=Math.max(peak.rss,process.resourceUsage().maxRSS*1024);process.stderr.write('XML_BENCH '+JSON.stringify({firstByteMs,elapsedMs:performance.now()-started,...peak})+'\\n')});
  `,
  );
  console.log(
    JSON.stringify({
      directory,
      fixtures: fixtures.map((entry) => entry.path),
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
    }),
  );
  for (const entry of fixtures) {
    const runs = [];
    for (let run = 0; run < 4; run++) {
      const args = [
        '--import',
        monitor,
        join(root, 'dist/cli/main.js'),
        'format',
        entry.path,
        '--temp-directory',
        temporary,
      ];
      const executable =
        process.platform === 'darwin' || process.platform === 'linux'
          ? '/usr/bin/time'
          : process.execPath;
      const command =
        executable === process.execPath
          ? args
          : [process.platform === 'darwin' ? '-l' : '-v', process.execPath, ...args];
      const started = performance.now();
      const child = spawn(executable, command, {
        cwd: root,
        stdio: ['ignore', nullFile.fd, 'pipe'],
        env: { ...process.env, XML_BENCH_TEMP: temporary },
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      const [code] = await once(child, 'close');
      if (code !== 0) throw new Error(`Benchmark failed (${code}): ${stderr}`);
      const captured = /XML_BENCH (\{[^\n]+\})/.exec(stderr);
      if (!captured) throw new Error(`Missing resource monitor: ${stderr}`);
      const metric = JSON.parse(captured[1]);
      metric.wallMs = performance.now() - started;
      metric.inputBytes = (await stat(entry.path)).size;
      metric.mibPerSecond = metric.inputBytes / 1024 ** 2 / (metric.wallMs / 1000);
      if (run) runs.push(metric);
      await writeFile(join(directory, `${entry.name}.${run}.time.txt`), stderr);
      console.log(JSON.stringify({ fixture: entry.name, warmup: run === 0, run, ...metric }));
    }
    const median = (key) => runs.map((run) => run[key]).sort((a, b) => a - b)[1];
    results.push({
      fixture: entry.name,
      inputBytes: runs[0].inputBytes,
      wallMs: median('wallMs'),
      mibPerSecond: median('mibPerSecond'),
      firstByteMs: median('firstByteMs'),
      rss: median('rss'),
      heapUsed: median('heapUsed'),
      external: median('external'),
      tempBytes: median('tempBytes'),
    });
  }
  const memoryDelta = results[1].rss - results[0].rss;
  const report = {
    directory,
    machine: { node: process.version, platform: process.platform, architecture: process.arch },
    samplingMs: 20,
    results,
    memoryDelta,
    memoryBoundPassed: memoryDelta <= 64 * 1024 ** 2,
  };
  await writeFile(join(directory, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.memoryBoundPassed)
    throw new Error('1GiB formatter peak RSS exceeds 64MiB baseline by more than 64MiB');
} finally {
  await nullFile.close();
  if (!keep && directoryArgument < 0) await rm(directory, { recursive: true, force: true });
}
