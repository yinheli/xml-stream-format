import { XmlError } from './errors.js';
import { readTape, TapeWriter } from './event-tape.js';
import type { StartData } from './events.js';
import { Kind } from './events.js';
import { ingest } from './ingest.js';
import type { FormatOptions } from './options.js';
import { parseNormalized } from './parser.js';
import { serializeEvents } from './serialize.js';
import type { Workspace } from './workspace.js';

/** Persist only validated events; all consumers share this parsing and hook pipeline. */
export async function buildTape(
  source: AsyncIterable<Uint8Array>,
  workspace: Workspace,
  options: FormatOptions = {},
): Promise<string> {
  const path = workspace.file('events.tape');
  const validateHooks = Boolean(options.hooks);
  const writer = await TapeWriter.create(path);
  try {
    await ingest(source, writer, options);
  } finally {
    await writer.close();
  }
  if (validateHooks) {
    // Valid serialized XML alone could hide an invalid name that injected extra attributes.
    // Expat must recover the exact streamed names and values, without a second QName grammar.
    const expected: (StartData | undefined)[] = [];
    let head = 0;
    async function* encoded(): AsyncGenerator<Buffer> {
      for await (const text of serializeEvents(readTape(path, { signal: options.signal }), (data) =>
        expected.push(data),
      ))
        yield Buffer.from(text, 'utf8');
    }
    try {
      // Source tokens were bounded before normalization; generated validation XML is not charged.
      for await (const batch of parseNormalized(encoded(), options)) {
        for (const event of batch) {
          if (event.kind !== Kind.Start) continue;
          const original = expected[head];
          expected[head++] = undefined;
          if (
            !original ||
            event.data.name !== original.name ||
            event.data.namespaceURI !== original.namespaceURI ||
            event.data.attributes.length !== original.attributes.length ||
            event.data.namespaces.length !== original.namespaces.length
          ) {
            throw new XmlError(
              'ERR_XML_PARSE',
              'A transformed QName changed the serialized XML structure',
            );
          }
          const attributesChanged = event.data.attributes.some((attribute, index) => {
            const before = original.attributes[index]!;
            return (
              attribute.name !== before.name ||
              attribute.namespaceURI !== before.namespaceURI ||
              attribute.value !== before.value
            );
          });
          const namespacesChanged = event.data.namespaces.some((namespace, index) => {
            const before = original.namespaces[index]!;
            return namespace.prefix !== before.prefix || namespace.uri !== before.uri;
          });
          if (attributesChanged || namespacesChanged)
            throw new XmlError(
              'ERR_XML_PARSE',
              'A transformed attribute QName or namespace did not reparse unchanged',
            );
        }
        if (head === expected.length) {
          expected.length = 0;
          head = 0;
        } else if (head >= 4096) {
          expected.copyWithin(0, head);
          expected.length -= head;
          head = 0;
        }
      }
      if (head !== expected.length)
        throw new XmlError('ERR_XML_PARSE', 'A transformed QName suppressed an expected element');
    } catch (cause) {
      if (options.signal?.aborted) throw cause;
      if (cause instanceof XmlError)
        throw new XmlError('ERR_XML_HOOK', `Transformed XML is invalid: ${cause.message}`, {
          cause,
        });
      throw cause;
    }
  }
  return path;
}
