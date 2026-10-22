import { checkAbort, positiveInteger, XmlError } from './errors.js';
import type { StartData, XmlEvent } from './events.js';
import { Kind } from './events.js';
import type { FormatOptions } from './options.js';

/** Input is source-budget-checked UTF-8; never sniff or charge normalized markup again. */
export async function* parseNormalized(
  source: AsyncIterable<Uint8Array>,
  options: Pick<FormatOptions, 'signal' | 'maxDepth'> = {},
): AsyncGenerator<readonly XmlEvent[]> {
  const maxDepth = positiveInteger(options.maxDepth, 1024, 'maxDepth');
  checkAbort(options.signal);
  // Lazy loading keeps the WASM runtime out of the public entry module until parsing.
  const { XmlParser, XmlParseError } = await import('#expat-wasm');
  const parser = new XmlParser({
    encoding: 'UTF-8',
    separator: '\u001f',
    expandInternalEntities: false,
    systemEntity: null,
  });
  let batch: XmlEvent[] = [];
  let depth = -1;
  let namespaces: { prefix: string; uri: string }[] = [];
  let prolog = '';
  let declarationFinished = false;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const nameInfo = (raw: string) => {
    const pieces = parser.triple(raw);
    const prefix = pieces.prefix ?? '';
    return {
      name: prefix ? `${prefix}:${pieces.local}` : pieces.local,
      prefix,
      localName: pieces.local,
      namespaceURI: pieces.ns ?? '',
    };
  };
  parser.on('startNamespaceDecl', (prefix, uri) =>
    namespaces.push({ prefix: prefix ?? '', uri: uri ?? '' }),
  );
  parser.on('startElement', (name, attributes) => {
    if (++depth > maxDepth)
      throw new XmlError('ERR_XML_LIMIT', `Element depth exceeds ${maxDepth}`);
    const data: StartData = {
      ...nameInfo(name),
      attributes: Object.entries(attributes).map(([key, value]) => ({
        ...nameInfo(key),
        value: value as string,
      })),
      namespaces,
    };
    namespaces = [];
    batch.push({ kind: Kind.Start, data });
  });
  parser.on('endElement', () => {
    batch.push({ kind: Kind.End, data: null });
    depth--;
  });
  parser.on('characterData', (data) => batch.push({ kind: Kind.Text, data }));
  parser.on('startCdataSection', () => batch.push({ kind: Kind.CdataStart, data: null }));
  parser.on('endCdataSection', () => batch.push({ kind: Kind.CdataEnd, data: null }));
  parser.on('comment', (data) => batch.push({ kind: Kind.Comment, data }));
  parser.on('processingInstruction', (target, value) =>
    batch.push({ kind: Kind.Pi, data: { target, value } }),
  );
  parser.on('xmlDecl', (version) => {
    if (version !== '1.0')
      throw new XmlError(
        'ERR_XML_VERSION',
        `Unsupported XML version ${version}; only XML 1.0 is supported`,
      );
    const standalone = /\bstandalone\s*=\s*(['"])(yes|no)\1/.exec(prolog)?.[2];
    batch.push({
      kind: Kind.Declaration,
      data: { version, ...(standalone ? { standalone: standalone === 'yes' } : {}) },
    });
  });
  parser.on('startDoctypeDecl', () => {
    throw new XmlError('ERR_XML_DTD', 'DOCTYPE declarations are not allowed');
  });
  parser.on('error', (cause) => {
    throw new XmlError('ERR_XML_PARSE', 'XML parser failed', { cause });
  });
  try {
    for await (const input of source) {
      checkAbort(options.signal);
      for (let offset = 0; offset < input.byteLength; offset += 65_536) {
        const bytes = input.subarray(offset, offset + 65_536);
        if (!declarationFinished) {
          const text = decoder.decode(bytes, { stream: true });
          // Rewriting a one-letter encoding name can grow the bounded source prolog by four.
          prolog += text.slice(0, Math.max(0, 4100 - prolog.length));
          const end = prolog.indexOf('?>');
          if (end >= 0) {
            prolog = prolog.slice(0, end + 2);
            declarationFinished = true;
          } else declarationFinished = prolog.length >= 6 && !prolog.startsWith('<?xml');
        }
        parser.parse(bytes, 0);
        if (batch.length) {
          const ready = batch;
          batch = [];
          yield ready;
        }
      }
    }
    parser.parse(Buffer.alloc(0), 1);
    if (batch.length) yield batch;
  } catch (cause) {
    if (!(cause instanceof XmlParseError)) throw cause;
    const location = cause as { line?: number; column?: number; byteOffset?: number };
    throw new XmlError(
      'ERR_XML_PARSE',
      `Invalid XML (normalized stream): ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause, line: location?.line, column: location?.column, byteOffset: location?.byteOffset },
    );
  } finally {
    parser.destroy();
  }
}
