import { Buffer } from 'node:buffer';
import type { StartData, XmlEvent } from './events.js';
import { Kind } from './events.js';

const MAX_OUTPUT_BYTES = 64 * 1024;
const INPUT_CHUNK_CODE_UNITS = 8 * 1024;

export function escapeText(value: string): string {
  return value.replace(/[&<>"'\r]/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&apos;';
      default:
        return '&#xD;';
    }
  });
}

export function escapeAttribute(value: string): string {
  return value.replace(/[&<>"'\t\n\r]/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&apos;';
      case '\t':
        return '&#x9;';
      case '\n':
        return '&#xA;';
      default:
        return '&#xD;';
    }
  });
}

/** Keeps only a possible CDATA terminator prefix between text calls. */
export class CdataSerializer {
  private tail = '';

  start(): string {
    this.tail = '';
    return '<![CDATA[';
  }

  text(value: string): string {
    const combined = this.tail ? this.tail + value : value;
    this.tail = combined.endsWith(']]') ? ']]' : combined.endsWith(']') ? ']' : '';
    const body = this.tail ? combined.slice(0, -this.tail.length) : combined;
    return body.replace(/\]\]>|\r/g, (token) =>
      token === '\r' ? ']]>&#xD;<![CDATA[' : ']]]]><![CDATA[>',
    );
  }

  end(): string {
    const output = `${this.tail}]]>`;
    this.tail = '';
    return output;
  }
}

/** Bounds escaping work without cutting a supplementary Unicode character. */
function* inputPieces(value: string): Generator<string> {
  for (let start = 0; start < value.length; ) {
    let end = Math.min(start + INPUT_CHUNK_CODE_UNITS, value.length);
    if (end < value.length) {
      const previous = value.charCodeAt(end - 1);
      const next = value.charCodeAt(end);
      if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
    }
    yield value.slice(start, end);
    start = end;
  }
}

export function* serializeStartParts(data: StartData, selfClosing: boolean): Generator<string> {
  yield `<${data.name}`;
  for (const namespace of data.namespaces) {
    yield namespace.prefix ? ` xmlns:${namespace.prefix}="` : ' xmlns="';
    for (const piece of inputPieces(namespace.uri)) yield escapeAttribute(piece);
    yield '"';
  }
  for (const attribute of data.attributes) {
    yield ` ${attribute.name}="`;
    for (const piece of inputPieces(attribute.value)) yield escapeAttribute(piece);
    yield '"';
  }
  yield selfClosing ? '/>' : '>';
}

interface SerializationState {
  names: string[];
  cdata: CdataSerializer;
  inCdata: boolean;
}

function* eventParts(event: XmlEvent, state: SerializationState): Generator<string> {
  switch (event.kind) {
    case Kind.Declaration:
      yield '<?xml version="1.0" encoding="UTF-8"';
      if (event.data.standalone !== undefined)
        yield ` standalone="${event.data.standalone ? 'yes' : 'no'}"`;
      yield '?>';
      break;
    case Kind.Start:
      state.names.push(event.data.name);
      yield* serializeStartParts(event.data, false);
      break;
    case Kind.End:
      yield `</${state.names.pop()!}>`;
      break;
    case Kind.Text:
      for (const piece of inputPieces(event.data)) {
        yield state.inCdata ? state.cdata.text(piece) : escapeText(piece);
      }
      break;
    case Kind.CdataStart:
      state.inCdata = true;
      yield state.cdata.start();
      break;
    case Kind.CdataEnd:
      yield state.cdata.end();
      state.inCdata = false;
      break;
    case Kind.Comment:
      yield '<!--';
      yield event.data;
      yield '-->';
      break;
    case Kind.Pi:
      yield `<?${event.data.target}`;
      if (event.data.value) {
        yield ' ';
        yield event.data.value;
      }
      yield '?>';
      break;
  }
}

/** Splits oversized raw markup by UTF-8 bytes, keeping surrogate pairs intact. */
function* utf8Chunks(value: string): Generator<string> {
  let start = 0;
  let bytes = 0;
  for (let index = 0; index < value.length; ) {
    const character = value.charCodeAt(index);
    let units = 1;
    let width: number;
    if (character < 0x80) width = 1;
    else if (character < 0x800) width = 2;
    else {
      const next = value.charCodeAt(index + 1);
      if (character >= 0xd800 && character <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        units = 2;
        width = 4;
      } else width = 3;
    }
    if (bytes + width > MAX_OUTPUT_BYTES) {
      yield value.slice(start, index);
      start = index;
      bytes = 0;
    }
    bytes += width;
    index += units;
  }
  if (start < value.length) yield value.slice(start);
}

/** Raw, unindented serialization for validating transformed events with Expat. */
export async function* serializeEvents(
  events: AsyncIterable<XmlEvent>,
  onStart?: (data: StartData) => void,
): AsyncGenerator<string> {
  const state: SerializationState = { names: [], cdata: new CdataSerializer(), inCdata: false };
  let pending: string[] = [];
  let pendingBytes = 0;
  for await (const event of events) {
    if (event.kind === Kind.Start) onStart?.(event.data);
    for (const part of eventParts(event, state)) {
      if (!part) continue;
      const bytes = Buffer.byteLength(part, 'utf8');
      if (pendingBytes && pendingBytes + bytes > MAX_OUTPUT_BYTES) {
        yield pending.join('');
        pending = [];
        pendingBytes = 0;
      }
      if (bytes > MAX_OUTPUT_BYTES) {
        yield* utf8Chunks(part);
      } else {
        pending.push(part);
        pendingBytes += bytes;
      }
    }
  }
  if (pendingBytes) yield pending.join('');
}
