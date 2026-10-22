import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { readTape, TapeWriter } from '../src/core/event-tape.js';
import type { TapeRecord, XmlEvent } from '../src/core/events.js';
import { Kind } from '../src/core/events.js';

const sample: XmlEvent[] = [
  { kind: Kind.Declaration, data: { version: '1.0', standalone: false } },
  {
    kind: Kind.Start,
    data: {
      name: 'r',
      prefix: '',
      localName: 'r',
      namespaceURI: '',
      attributes: [{ name: 'id', value: '1', prefix: '', localName: 'id', namespaceURI: '' }],
      namespaces: [{ prefix: 'x', uri: 'urn:x' }],
    },
  },
  { kind: Kind.Text, data: '正文😀' },
  { kind: Kind.CdataStart, data: null },
  { kind: Kind.CdataEnd, data: null },
  { kind: Kind.Comment, data: 'note' },
  { kind: Kind.Pi, data: { target: 'xml-stylesheet', value: 'href="x"' } },
  { kind: Kind.End, data: null },
];

async function records(
  path: string,
  options: Parameters<typeof readTape>[1] = {},
): Promise<TapeRecord[]> {
  const result: TapeRecord[] = [];
  for await (const record of readTape(path, options)) result.push(record);
  return result;
}

test('tape round-trips every event kind with contiguous offsets and patchable flags', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xml-tape-roundtrip-'));
  try {
    const path = join(directory, 'events.tape');
    const writer = TapeWriter.create(path);
    const offsets = sample.map((event) => writer.append(event));
    const startTwice = writer.append(sample[1]!);
    writer.patchFlags(offsets[1]!, 3);
    writer.patchFlags(startTwice, 8);
    writer.close();
    assert.equal((await stat(path)).size, writer.bytes);
    const replay = await records(path);
    const written = [...sample, sample[1]!];
    assert.deepEqual(
      replay.map((record) => record.kind),
      written.map((event) => event.kind),
    );
    assert.deepEqual(
      replay.map((record) => record.offset),
      offsets.concat(startTwice),
    );
    for (const [index, record] of replay.entries()) {
      assert.deepEqual(record.data, written[index]!.data);
      assert.equal(record.nextOffset, replay[index + 1]?.offset ?? writer.bytes);
    }
    assert.equal(replay[1]!.flags, 3);
    assert.equal(replay[replay.length - 1]!.flags, 8);
    assert.equal(replay[0]!.flags, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('patchFlags reaches records already persisted and validates its arguments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xml-tape-patch-'));
  try {
    const path = join(directory, 'events.tape');
    const writer = TapeWriter.create(path);
    const first = writer.append({ kind: Kind.Text, data: 'a'.repeat(70_000) }); // Forces the first record out of the buffer.
    assert.ok(writer.bytes > 65_536);
    const second = writer.append({ kind: Kind.Text, data: 'buffered' });
    writer.patchFlags(first, 5); // Persisted: flush plus direct file write.
    writer.patchFlags(second, 2); // Still buffered.
    writer.close();
    const replay = await records(path);
    assert.equal(replay[0]!.flags, 5);
    assert.equal(replay[1]!.flags, 2);
    writer.close();
    assert.throws(() => writer.append({ kind: Kind.Text, data: 'x' }), {
      message: 'Event tape writer is closed',
    });
    assert.throws(() => writer.patchFlags(0, 1), { message: 'Event tape writer is closed' });
    assert.throws(() => TapeWriter.create(path), { code: 'EEXIST' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('patchFlags rejects out-of-range offsets and flag values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xml-tape-range-'));
  try {
    const writer = TapeWriter.create(join(directory, 'events.tape'));
    const offset = writer.append({ kind: Kind.End, data: null });
    // The record is 12 bytes (8 header + 4 payload), so offsets 0..4 are addressable.
    assert.doesNotThrow(() => writer.patchFlags(offset + 4, 1));
    for (const bad of [offset + 5, offset + 9, -1, 1.5, Number.NaN])
      assert.throws(() => writer.patchFlags(bad, 1), RangeError);
    for (const flags of [-1, 256, 1.5, Number.NaN])
      assert.throws(() => writer.patchFlags(offset, flags), RangeError);
    writer.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('readTape replays only the requested byte range', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xml-tape-range-'));
  try {
    const path = join(directory, 'events.tape');
    const writer = TapeWriter.create(path);
    const first = writer.append({ kind: Kind.Text, data: 'one' });
    const second = writer.append({ kind: Kind.Comment, data: 'two' });
    const third = writer.append({ kind: Kind.End, data: null });
    writer.close();
    const middle = await records(path, { start: second, end: third });
    assert.deepEqual(
      middle.map((record) => record.kind),
      [Kind.Comment],
    );
    const head = await records(path, { start: 0, end: second });
    assert.deepEqual(
      head.map((record) => record.data),
      ['one'],
    );
    // A range that ends inside the file truncates the record instead of rejecting up front.
    await assert.rejects(records(path, { start: third, end: third + 1 }), {
      code: 'ERR_XML_PARSE',
    });
    for (const range of [
      { start: 0, end: writer.bytes + 1 },
      { start: second, end: first },
      { start: -1, end: 4 },
    ]) {
      await assert.rejects(records(path, range), RangeError);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('readTape bounds record size, rejects truncation and corruption with byte offsets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xml-tape-corrupt-'));
  try {
    const path = join(directory, 'events.tape');
    const writer = TapeWriter.create(path);
    writer.append({ kind: Kind.Text, data: 'hello' });
    writer.close();
    await assert.rejects(records(path, { maxRecordBytes: 0 }), { code: 'ERR_XML_LIMIT' });
    await assert.rejects(records(path, { maxRecordBytes: -1 }), RangeError);
    await assert.rejects(records(path, { maxRecordBytes: 1.5 }), RangeError);

    const midPayload = join(directory, 'mid-payload.tape');
    await writeFile(midPayload, await readFile(path));
    await truncate(midPayload, 12);
    await assert.rejects(records(midPayload), {
      code: 'ERR_XML_PARSE',
      message: 'Truncated event tape payload',
    });

    const midHeader = join(directory, 'mid-header.tape');
    await writeFile(midHeader, await readFile(path));
    await truncate(midHeader, 6);
    await assert.rejects(records(midHeader), {
      code: 'ERR_XML_PARSE',
      message: 'Truncated event tape header',
    });

    for (const [position, value] of [
      [0, 9],
      [2, 1],
    ] as const) {
      const badKind = join(directory, `bad-kind-${position}.tape`);
      const bytes = await readFile(path);
      bytes[position] = value;
      await writeFile(badKind, bytes);
      await assert.rejects(records(badKind), {
        code: 'ERR_XML_PARSE',
        message: 'Invalid event tape header',
      });
    }

    const badPayload = join(directory, 'bad-payload.tape');
    const bytes = await readFile(path);
    bytes[8] = 0xff;
    await writeFile(badPayload, bytes);
    await assert.rejects(records(badPayload), {
      code: 'ERR_XML_PARSE',
      message: 'Invalid event tape payload',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('readTape honors abort signals before opening and between records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xml-tape-abort-'));
  try {
    const path = join(directory, 'events.tape');
    const writer = TapeWriter.create(path);
    writer.append({ kind: Kind.Text, data: 'one' });
    writer.append({ kind: Kind.Text, data: 'two' });
    writer.close();
    // Custom reasons keep their identity through the reader; default DOMExceptions do not on Node 26.
    const beforeRead = new Error('aborted before read');
    const controller = new AbortController();
    controller.abort(beforeRead);
    await assert.rejects(
      records(path, { signal: controller.signal }),
      (error) => error === beforeRead,
    );
    const midStream = new AbortController();
    const iterator = readTape(path, { signal: midStream.signal })[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value!.data, 'one');
    const midRead = new Error('aborted between records');
    midStream.abort(midRead);
    await assert.rejects(iterator.next(), (error) => error === midRead);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
