import type * as slimdom from 'slimdom';
import fontoxpath from '#fontoxpath';
import { XmlError } from '../../src/core/errors.js';
import type { StartData, TapeRecord, XmlEvent } from '../../src/core/events.js';
import { Kind, XML_NS } from '../../src/core/events.js';
import { ingest } from '../../src/core/ingest.js';
import { parseNormalized } from '../../src/core/parser.js';
import { replayRecords } from '../../src/core/replay.js';
import { buildDom, type DomDocument } from '../../src/xpath/dom-builder.js';
import { canonicalXPath, nodeLabel } from '../../src/xpath/paths.js';
import type { JobRequests, JobResults, Request, Response, XPathHit } from './protocol.js';
import { loadParser, normalizedBlob, wireError } from './runtime.js';

const COPY_SOURCE_UNITS = 4 * 1024 * 1024;
const COPY_OUTPUT_BYTES = 1024 * 1024;
const XPATH_SOURCE_BYTES = 32 * 1024 * 1024;
const XPATH_LISTED = 2000;
const PREDEFINED_NAMESPACES: Readonly<Record<string, string>> = {
  xml: XML_NS,
  xs: 'http://www.w3.org/2001/XMLSchema',
  fn: 'http://www.w3.org/2005/xpath-functions',
  map: 'http://www.w3.org/2005/xpath-functions/map',
  array: 'http://www.w3.org/2005/xpath-functions/array',
  math: 'http://www.w3.org/2005/xpath-functions/math',
  fontoxpath: 'http://fontoxml.com/fontoxpath',
  local: 'http://www.w3.org/2005/xquery-local-functions',
};

const post = (message: Response) => postMessage(message);
const encoder = new TextEncoder();
type Reporter = (phase: string, bytes: number) => void;

function reporter(id: number, total: number): Reporter {
  let last = 0;
  return (phase, bytes) => {
    const now = performance.now();
    if (now - last < 100 && bytes < total) return;
    last = now;
    post({ type: 'jobProgress', id, phase, bytes, total });
  };
}

function sourceBytes(phase: string, report: Reporter): (bytes: number) => void {
  let read = 0;
  return (bytes) => {
    read += bytes;
    report(phase, read);
  };
}

async function* records(list: readonly TapeRecord[]): AsyncGenerator<TapeRecord> {
  yield* list;
}

function eventUnits(event: XmlEvent): number {
  switch (event.kind) {
    case Kind.Start:
      return event.data.attributes.reduce(
        (sum, attribute) => sum + attribute.name.length + attribute.value.length,
        event.data.name.length,
      );
    case Kind.Text:
    case Kind.Comment:
      return event.data.length;
    case Kind.Pi:
      return event.data.target.length + event.data.value.length;
    default:
      return 1;
  }
}

/** A fragment root carries every in-scope namespace and effective xml:lang/xml:space. */
function withContext(data: StartData, ancestors: readonly StartData[]): StartData {
  const declared = new Set(data.namespaces.map((namespace) => namespace.prefix));
  const inherited = new Map<string, string>();
  for (const ancestor of ancestors)
    for (const namespace of ancestor.namespaces) inherited.set(namespace.prefix, namespace.uri);
  const namespaces = [...data.namespaces];
  for (const [prefix, uri] of inherited)
    if (!declared.has(prefix) && (prefix || uri)) namespaces.push({ prefix, uri });
  const attributes = [...data.attributes];
  for (const local of ['lang', 'space']) {
    const matches = (attribute: { namespaceURI: string; localName: string }) =>
      attribute.namespaceURI === XML_NS && attribute.localName === local;
    if (attributes.some(matches)) continue;
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const found = ancestors[i]!.attributes.find(matches);
      if (found) {
        attributes.push(found);
        break;
      }
    }
  }
  return { ...data, namespaces, attributes };
}

const COMPLETE = Symbol('complete');

/** Formatted XML for one element subtree, read from the file and stopped at its end tag. */
async function copy(request: JobRequests['copy'], report: Reporter): Promise<string> {
  await loadParser();
  const list: TapeRecord[] = [];
  const ancestors: StartData[] = [];
  let seen = 0;
  let depth = -1;
  let units = 0;
  let root: StartData | undefined;
  let complete = false;
  const writer = {
    bytes: 0,
    append(event: XmlEvent): number {
      if (depth < 0) {
        if (event.kind === Kind.End) ancestors.pop();
        if (event.kind !== Kind.Start) return -1;
        if (++seen !== request.ordinal) {
          ancestors.push(event.data);
          return -1;
        }
        root = withContext(event.data, ancestors);
        depth = 0;
      } else if (event.kind === Kind.Start) depth++;
      else if (event.kind === Kind.End && --depth < 0) complete = true;
      units += eventUnits(event);
      if (units > COPY_SOURCE_UNITS)
        throw new XmlError(
          'ERR_XML_COPY_LIMIT',
          'Subtree exceeds the 4 MiB copy budget; use export instead',
        );
      list.push({
        ...event,
        offset: list.length,
        nextOffset: list.length + 1,
        flags: 0,
      } as TapeRecord);
      return list.length - 1;
    },
    patchFlags(offset: number, flags: number): void {
      if (offset < 0) return;
      list[offset]!.flags = flags;
      // The library patches an element's layout flags right after its end tag.
      if (complete && offset === 0) throw COMPLETE;
    },
  };
  try {
    await ingest(
      normalizedBlob(request.file, { onSourceBytes: sourceBytes('read', report) }),
      writer,
    );
    throw new XmlError('ERR_XML_COPY_NODE', 'Element was not found in the file');
  } catch (cause) {
    if (cause !== COMPLETE) throw cause;
  }
  let output = '';
  let bytes = 0;
  for await (const chunk of replayRecords(records(list), { ...request, root })) {
    bytes += encoder.encode(chunk).byteLength;
    if (bytes > COPY_OUTPUT_BYTES)
      throw new XmlError('ERR_XML_COPY_LIMIT', 'Formatted XML exceeds the 1 MiB clipboard limit');
    output += chunk;
  }
  return output;
}

interface Sink {
  write(data: Uint8Array): Promise<void> | void;
  close(): Promise<Pick<JobResults['export'], 'saved' | 'blob'>>;
}

interface SyncAccessHandle {
  truncate(size: number): void;
  write(data: Uint8Array, options: { at: number }): number;
  flush(): void;
  close(): void;
}

async function openSink(handle: FileSystemFileHandle | undefined): Promise<Sink> {
  if (handle) {
    const writable = await handle.createWritable();
    return {
      write: (data) => writable.write(data as Uint8Array<ArrayBuffer>),
      close: async () => {
        await writable.close();
        return { saved: 'handle' };
      },
    };
  }
  try {
    // Origin-private storage keeps a multi-GB export on disk instead of in memory.
    const directory = await navigator.storage.getDirectory();
    const file = await directory.getFileHandle('export.xml', { create: true });
    const access = await (
      file as unknown as { createSyncAccessHandle(): Promise<SyncAccessHandle> }
    ).createSyncAccessHandle();
    access.truncate(0);
    let at = 0;
    return {
      write: (data) => {
        at += access.write(data, { at });
      },
      close: async () => {
        access.flush();
        access.close();
        return { saved: 'opfs' };
      },
    };
  } catch {
    const parts: Uint8Array<ArrayBuffer>[] = [];
    return {
      write: (data) => {
        parts.push(data as Uint8Array<ArrayBuffer>);
      },
      close: async () => ({ saved: 'blob', blob: new Blob(parts, { type: 'application/xml' }) }),
    };
  }
}

/**
 * The library's own two-step shape: validate everything and record layout flags,
 * then replay the source with those flags. Memory is one byte per element.
 */
async function exportXml(
  request: JobRequests['export'],
  report: Reporter,
): Promise<JobResults['export']> {
  await loadParser();
  let flags = new Uint8Array(1 << 16);
  let elements = 0;
  const writer = {
    bytes: 0,
    append(event: XmlEvent): number {
      if (event.kind !== Kind.Start) return -1;
      if (elements === flags.length) {
        const next = new Uint8Array(flags.length * 2);
        next.set(flags);
        flags = next;
      }
      return elements++;
    },
    patchFlags(offset: number, value: number): void {
      if (offset >= 0) flags[offset] = value;
    },
  };
  await ingest(
    normalizedBlob(request.file, { onSourceBytes: sourceBytes('validate', report) }),
    writer,
  );
  let ordinal = 0;
  async function* replay(): AsyncGenerator<TapeRecord> {
    const source = normalizedBlob(request.file, { onSourceBytes: sourceBytes('write', report) });
    for await (const batch of parseNormalized(source)) {
      for (const event of batch) {
        const value = event.kind === Kind.Start ? flags[ordinal++]! : 0;
        yield { ...event, offset: 0, nextOffset: 0, flags: value } as TapeRecord;
      }
    }
  }
  const sink = await openSink(request.handle);
  let bytes = 0;
  for await (const chunk of replayRecords(replay(), request)) {
    const data = encoder.encode(chunk);
    bytes += data.byteLength;
    await sink.write(data);
  }
  const name = request.handle?.name ?? request.file.name.replace(/(\.xml)?$/i, '.formatted.xml');
  return { ...(await sink.close()), name, bytes };
}

let cached: { key: string; dom: DomDocument } | undefined;

async function xpath(
  request: JobRequests['xpath'],
  report: Reporter,
): Promise<JobResults['xpath']> {
  const { file } = request;
  const key = `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
  if (cached?.key !== key) {
    cached = undefined;
    if (file.size > XPATH_SOURCE_BYTES)
      throw new XmlError(
        'ERR_XPATH_LIMIT',
        `XPath builds a DOM; this demo caps it at ${XPATH_SOURCE_BYTES / 1048576} MiB of source. Use the CLI for larger files.`,
      );
    await loadParser();
    async function* events(): AsyncGenerator<XmlEvent> {
      const source = normalizedBlob(file, { onSourceBytes: sourceBytes('load DOM', report) });
      for await (const batch of parseNormalized(source)) yield* batch;
    }
    cached = { key, dom: await buildDom(events()) };
  }
  const { dom } = cached;
  const bindings = new Map<string, string>();
  for (const [prefix, uri] of request.namespaces) {
    const predefined = Object.hasOwn(PREDEFINED_NAMESPACES, prefix)
      ? PREDEFINED_NAMESPACES[prefix]
      : undefined;
    if (predefined !== undefined && uri !== predefined)
      throw new XmlError(
        'ERR_XPATH_QUERY',
        `The ${prefix} prefix must resolve to its built-in namespace (${predefined})`,
      );
    bindings.set(prefix, uri);
  }
  bindings.set('xml', XML_NS);
  let nodes: slimdom.Node[];
  try {
    nodes = fontoxpath.evaluateXPathToNodes<slimdom.Node>(
      request.expression,
      dom.document,
      null,
      {},
      {
        language: fontoxpath.evaluateXPath.XPATH_3_1_LANGUAGE,
        namespaceResolver: (prefix) => bindings.get(prefix) ?? null,
        logger: { trace: () => {} },
      },
    );
  } catch (cause) {
    throw new XmlError('ERR_XPATH_QUERY', cause instanceof Error ? cause.message : String(cause));
  }
  const hits: XPathHit[] = [];
  for (const node of nodes.slice(0, XPATH_LISTED)) {
    const ref = dom.refs.get(node);
    if (!ref) throw new XmlError('ERR_XPATH_RESULT_TYPE', 'XPath results must be source nodes');
    const ordinal =
      ref.kind === 'element'
        ? ref.elementId
        : ref.kind === 'attribute'
          ? ref.ownerElementId
          : ref.kind === 'text'
            ? ref.parentElementId
            : ref.kind === 'document'
              ? 1
              : ref.parentId;
    hits.push({
      ordinal: Math.max(1, ordinal),
      xpath: canonicalXPath(node, dom),
      label: nodeLabel(node),
    });
  }
  return { hits, total: nodes.length };
}

self.onmessage = async (event: MessageEvent<Request<JobRequests>>) => {
  const request = event.data;
  const report = reporter(request.id, request.file.size);
  try {
    const value =
      request.type === 'copy'
        ? await copy(request, report)
        : request.type === 'export'
          ? await exportXml(request, report)
          : await xpath(request, report);
    post({ id: request.id, ok: true, value });
  } catch (cause) {
    post({ id: request.id, ok: false, error: wireError(cause) });
  }
};
