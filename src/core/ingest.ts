import { XmlError } from './errors.js';
import type { TapeWriter } from './event-tape.js';
import type { XmlEvent } from './events.js';
import { Content, Kind, XML_NS } from './events.js';
import type { FormatOptions } from './options.js';
import { parseNormalized } from './parser.js';
import { transformEvents } from './transform.js';

export type IngestObserver = (
  event: XmlEvent,
  offset: number,
  nextOffset: number,
  contentFlags?: number,
) => void;

/** Classification concerns only transformed direct content, never descendant text. */
export async function ingest(
  source: AsyncIterable<Uint8Array>,
  writer: Pick<TapeWriter, 'append' | 'patchFlags' | 'bytes'>,
  options: FormatOptions = {},
  observe?: IngestObserver,
): Promise<void> {
  const stack: { offset: number; flags: number; preserve: boolean }[] = [];
  for await (const event of transformEvents(parseNormalized(source, options), options)) {
    const parent = stack.at(-1);
    if (event.kind === Kind.Start) {
      if (parent) parent.flags |= Content.Markup;
      let preserve = parent?.preserve ?? false;
      for (const attribute of event.data.attributes) {
        if (attribute.namespaceURI !== XML_NS || attribute.localName !== 'space') continue;
        if (attribute.value !== 'default' && attribute.value !== 'preserve')
          throw new XmlError(
            'ERR_XML_PARSE',
            `Invalid xml:space value ${JSON.stringify(attribute.value)}`,
          );
        preserve = attribute.value === 'preserve';
      }
      const offset = writer.append(event);
      stack.push({ offset, flags: preserve ? Content.Preserve : 0, preserve });
      if (observe) observe(event, offset, writer.bytes, preserve ? Content.Preserve : 0);
    } else if (event.kind === Kind.End) {
      const current = stack.pop()!;
      const offset = writer.append(event);
      writer.patchFlags(current.offset, current.flags);
      if (observe) observe(event, offset, writer.bytes, current.flags);
    } else {
      if (parent) {
        if (event.kind === Kind.Text && event.data.length) {
          parent.flags |= Content.DirectText;
          if (/[^\x20\x09\x0D\x0A]/.test(event.data)) parent.flags |= Content.NonWhitespace;
        } else if (event.kind === Kind.CdataStart) parent.flags |= Content.Cdata;
        else if (event.kind === Kind.Comment || event.kind === Kind.Pi)
          parent.flags |= Content.Markup;
      }
      const offset = writer.append(event);
      if (observe) observe(event, offset, writer.bytes);
    }
  }
}
