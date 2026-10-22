import { checkAbort } from './errors.js';
import type { StartData, TapeRecord } from './events.js';
import { Content, Kind } from './events.js';
import type { FormatOptions } from './options.js';
import { CdataSerializer, escapeText, serializeStartParts } from './serialize.js';

export interface ReplayOptions extends Pick<FormatOptions, 'indent' | 'whitespace' | 'signal'> {
  start?: number;
  end?: number;
  root?: StartData;
  onElement?: (phase: 'start' | 'end', tapeOffset: number, byte: number, line: number) => void;
}

export function indentation(options: Pick<FormatOptions, 'indent' | 'whitespace'>): string {
  const indent = options.indent ?? 2;
  if (indent !== 'tab' && (!Number.isInteger(indent) || indent < 0 || indent > 16))
    throw new RangeError('indent must be an integer from 0 through 16, or tab');
  if (
    options.whitespace !== undefined &&
    options.whitespace !== 'preserve' &&
    options.whitespace !== 'reindent'
  )
    throw new RangeError('whitespace must be preserve or reindent');
  return indent === 'tab' ? '\t' : ' '.repeat(indent);
}

async function* replayParts(
  records: AsyncIterable<TapeRecord>,
  options: ReplayOptions,
  onElement?: (phase: 'start' | 'end', tapeOffset: number) => void,
): AsyncGenerator<string> {
  const indent = indentation(options);
  const iterator = records[Symbol.asyncIterator]();
  const stack: { name: string; layout: boolean }[] = [];
  const cdata = new CdataSerializer();
  let inCdata = false;
  let seenTop = false;
  let firstElement = true;
  let next = await iterator.next();
  try {
    while (!next.done) {
      checkAbort(options.signal);
      const event = next.value;
      next = await iterator.next();
      const parent = stack.at(-1);
      if (event.kind === Kind.Text) {
        if (!parent || (parent.layout && !inCdata)) continue;
        yield inCdata ? cdata.text(event.data) : escapeText(event.data);
      } else if (event.kind === Kind.CdataStart) {
        inCdata = true;
        yield cdata.start();
      } else if (event.kind === Kind.CdataEnd) {
        yield cdata.end();
        inCdata = false;
      } else if (event.kind === Kind.End) {
        const current = stack.pop()!;
        if (current.layout) yield `\n${indent.repeat(stack.length)}`;
        yield `</${current.name}>`;
        onElement?.('end', event.nextOffset);
      } else {
        if (parent?.layout) yield `\n${indent.repeat(stack.length)}`;
        else if (!parent) {
          if (seenTop) yield '\n';
          seenTop = true;
        }
        if (event.kind === Kind.Start) {
          const data = firstElement && options.root ? options.root : event.data;
          firstElement = false;
          const empty = !next.done && next.value.kind === Kind.End;
          onElement?.('start', event.offset);
          yield* serializeStartParts(data, empty);
          if (empty) {
            onElement?.('end', next.value!.nextOffset);
            next = await iterator.next();
          } else {
            const flags = event.flags;
            const layout =
              !(flags & (Content.Preserve | Content.Cdata)) &&
              (!(flags & Content.DirectText) ||
                (options.whitespace === 'reindent' &&
                  !(flags & Content.NonWhitespace) &&
                  !!(flags & Content.Markup)));
            stack.push({ name: data.name, layout });
          }
        } else if (event.kind === Kind.Comment) yield `<!--${event.data}-->`;
        else if (event.kind === Kind.Pi)
          yield `<?${event.data.target}${event.data.value ? ` ${event.data.value}` : ''}?>`;
        else if (event.kind === Kind.Declaration)
          yield `<?xml version="1.0" encoding="UTF-8"${event.data.standalone === undefined ? '' : ` standalone="${event.data.standalone ? 'yes' : 'no'}"`}?>`;
      }
    }
    if (seenTop) yield '\n';
  } finally {
    await iterator.return?.(undefined);
  }
}

/** UTF-8-bounded output batching; a slow consumer stops record reads. */
export async function* replayRecords(
  records: AsyncIterable<TapeRecord>,
  options: ReplayOptions = {},
): AsyncGenerator<string> {
  let pending: string[] = [];
  let size = 0;
  let byte = 0;
  let line = 0;
  const onElement = options.onElement
    ? (phase: 'start' | 'end', offset: number) => options.onElement!(phase, offset, byte, line)
    : undefined;
  for await (const part of replayParts(records, options, onElement)) {
    if (onElement) {
      byte += Buffer.byteLength(part);
      for (let i = 0; i < part.length; i++) if (part.charCodeAt(i) === 10) line++;
    }
    for (let start = 0; start < part.length; ) {
      let end = Math.min(start + 8192, part.length);
      const last = part.charCodeAt(end - 1);
      if (end < part.length && last >= 0xd800 && last <= 0xdbff) end--;
      const piece = part.slice(start, end);
      const bytes = Buffer.byteLength(piece);
      if (size + bytes > 65_536) {
        checkAbort(options.signal);
        yield pending.join('');
        checkAbort(options.signal);
        pending = [];
        size = 0;
      }
      pending.push(piece);
      size += bytes;
      start = end;
    }
  }
  if (size) {
    checkAbort(options.signal);
    yield pending.join('');
    checkAbort(options.signal);
  }
}
