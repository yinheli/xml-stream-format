import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { parentPort } from 'node:worker_threads';
import { XmlError } from '../core/errors.js';
import { readTape, TapeWriter } from '../core/event-tape.js';
import type { StartData } from '../core/events.js';
import { Kind, XML_NS } from '../core/events.js';
import { ingest } from '../core/ingest.js';
import { serializeStartParts } from '../core/serialize.js';
import { xpathLiteral } from '../xpath/paths.js';
import { NodeIndex } from './index.js';
import { PreviewStore } from './preview.js';
import type { DocumentRequest, Progress, WireError, WorkerResponse } from './protocol.js';
import type { ElementRange, XmlNodeRef } from './types.js';
import { FoldedXmlView } from './xml-view.js';

if (!parentPort) throw new Error('Document worker requires a parent port');
const port = parentPort;
let index: NodeIndex | undefined;
let preview: PreviewStore | undefined;
let xmlView: FoldedXmlView | undefined;
let tapePath = '';
let sessionId = '';
let latestFuzzy = 0;
let lastProgress = 0;
let lastProgressNodes = 0;
let queue = Promise.resolve();
let sourceBytes = 0;
let writer: TapeWriter | undefined;
interface ChunkSource extends AsyncIterable<Uint8Array> {
  push(bytes: Uint8Array | null): Promise<void>;
}
let input: ChunkSource | undefined;
let ingestion: Promise<void> | undefined;
let complete = false;

/** One in-flight chunk; acknowledgement means ingestion has requested the next. */
function chunkSource(): ChunkSource {
  interface Chunk {
    bytes: Uint8Array | null;
    consumed(): void;
  }
  let waiting = Promise.withResolvers<Chunk>();
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
      for (;;) {
        const chunk = await waiting.promise;
        waiting = Promise.withResolvers<Chunk>();
        if (chunk.bytes === null) {
          chunk.consumed();
          return;
        }
        yield chunk.bytes;
        chunk.consumed();
      }
    },
    push(bytes: Uint8Array | null): Promise<void> {
      const consumed = Promise.withResolvers<void>();
      waiting.resolve({ bytes, consumed: consumed.resolve });
      return consumed.promise;
    },
  };
}

const COPY_WORK_BYTES = 4 * 1024 * 1024;

function copyLimit(
  message = 'Selected XML subtree or inherited context exceeds the 4 MiB copy work limit; nothing copied',
): XmlError {
  return new XmlError('ERR_XML_COPY_LIMIT', message);
}

class CopyBudget {
  remaining = COPY_WORK_BYTES;

  reserve(bytes: number): void {
    if (bytes > this.remaining) throw copyLimit();
    this.remaining -= bytes;
  }
}

interface ElementStart {
  data: StartData;
  bytes: number;
}
interface AncestorContext {
  namespaces: StartData['namespaces'];
  attributes: readonly { localName: string; value: string }[];
  bytes: number;
}

function progress(stage: Progress['stage'], nodes = 0, force = false): void {
  const now = Date.now();
  if (!force && now - lastProgress < 100 && !(nodes > 0 && lastProgressNodes === 0)) return;
  lastProgress = now;
  lastProgressNodes = nodes;
  port.postMessage({
    sessionId,
    requestId: 0,
    type: 'progress',
    value: { stage, sourceBytes, nodes },
  } satisfies WorkerResponse);
}

async function startData(id: number, maxRecordBytes?: number): Promise<ElementStart> {
  const node = index!.get(id);
  for await (const event of readTape(tapePath, {
    start: node.tapeStart,
    end: node.tapeEnd || undefined,
    maxRecordBytes,
  })) {
    if (event.kind !== Kind.Start) break;
    return { data: event.data, bytes: event.nextOffset - event.offset };
  }
  throw new XmlError('ERR_XML_PARSE', 'Element index does not point to a start event');
}

async function ancestorContext(id: number, budget?: CopyBudget): Promise<AncestorContext> {
  const record = await startData(id, budget?.remaining);
  budget?.reserve(record.bytes);
  const data = record.data;
  const attributes: { localName: string; value: string }[] = [];
  let bytes = 0;
  const reserve = (count: number): void => {
    budget?.reserve(count);
    bytes += count;
  };
  // Charge compact context storage before retaining entries, including empty contexts.
  reserve(128);
  for (const binding of data.namespaces)
    reserve(64 + (binding.prefix.length + binding.uri.length) * 2);
  for (const attribute of data.attributes) {
    if (
      attribute.namespaceURI !== XML_NS ||
      (attribute.localName !== 'lang' && attribute.localName !== 'space')
    )
      continue;
    reserve(64 + (attribute.localName.length + attribute.value.length) * 2);
    attributes.push({ localName: attribute.localName, value: attribute.value });
  }
  const context = { namespaces: data.namespaces, attributes, bytes };
  return context;
}

async function elementRange(elementId: number, budget?: CopyBudget): Promise<ElementRange> {
  const node = index!.get(elementId);
  const { data: root } = await startData(
    elementId,
    budget ? node.tapeEnd - node.tapeStart : undefined,
  );
  const ancestors: number[] = [];
  for (let id = node.parent; id !== 0 && id !== 0xffff_ffff; id = index!.get(id).parent) {
    budget?.reserve(16);
    ancestors.push(id);
  }
  const bindings = new Map<string, string>();
  const inherited = new Map<string, string>();
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const context = await ancestorContext(ancestors[i]!, budget);
    for (const binding of context.namespaces) bindings.set(binding.prefix, binding.uri);
    for (const attribute of context.attributes) inherited.set(attribute.localName, attribute.value);
  }
  for (const binding of root.namespaces) bindings.set(binding.prefix, binding.uri);
  const attributes = [...root.attributes];
  for (const [localName, value] of inherited)
    if (!attributes.some((a) => a.namespaceURI === XML_NS && a.localName === localName))
      attributes.push({
        name: `xml:${localName}`,
        prefix: 'xml',
        localName,
        namespaceURI: XML_NS,
        value,
      });
  return {
    elementId,
    start: node.tapeStart,
    end: node.tapeEnd,
    root: {
      ...root,
      attributes,
      namespaces: [...bindings].map(([prefix, uri]) => ({ prefix, uri })),
    },
  };
}

async function nodePath(ref: XmlNodeRef, kind: 'path' | 'xpath'): Promise<string> {
  if (ref.kind === 'document') return '/';
  if (ref.kind === 'element')
    return kind === 'xpath'
      ? index!.canonicalXPath(ref.elementId)
      : index!.readablePath(ref.elementId);
  const reservation = Math.min(128 * 1024, Math.floor(index!.budgetBytes / 4));
  const limit = Math.min(16 * 1024, Math.floor(reservation / 8));
  const reject = (): never => {
    throw new XmlError('ERR_XML_INDEX_LIMIT', 'XML node path exceeds the bounded path work limit');
  };
  index!.charge(reservation);
  try {
    let owner: number;
    let suffix: string;
    if (ref.kind === 'attribute') {
      owner = ref.ownerElementId;
      // Bound literal expansion before allocating XPath literals or decoding a tape record.
      if ((ref.localName.length + ref.namespaceURI.length) * 9 + 64 > limit) reject();
      if (kind === 'xpath') {
        suffix = `@*[local-name()=${xpathLiteral(ref.localName)} and namespace-uri()=${xpathLiteral(ref.namespaceURI)}]`;
      } else {
        const record = await startData(owner, Math.floor(reservation / 8));
        const attribute = record.data.attributes.find(
          (value) => value.localName === ref.localName && value.namespaceURI === ref.namespaceURI,
        );
        if (!attribute)
          throw new XmlError('ERR_XPATH_RESULT_TYPE', 'Attribute is not a source document node');
        if (attribute.name.length + 1 > limit) reject();
        suffix = `@${attribute.name}`;
      }
    } else if (ref.kind === 'text') {
      owner = ref.parentElementId;
      if (!Number.isSafeInteger(ref.textRunOrdinal) || ref.textRunOrdinal < 1)
        throw new RangeError('Invalid text ordinal');
      suffix = `text()[${ref.textRunOrdinal}]`;
    } else {
      owner = ref.parentId;
      if (!Number.isSafeInteger(ref.ordinal) || ref.ordinal < 1)
        throw new RangeError('Invalid node ordinal');
      suffix = `${ref.kind === 'comment' ? 'comment()' : 'processing-instruction()'}[${ref.ordinal}]`;
    }
    const base = kind === 'xpath' ? index!.canonicalXPath(owner) : index!.readablePath(owner);
    const separator = base === '/' ? '' : '/';
    if (base.length + separator.length + suffix.length > limit) reject();
    return base + separator + suffix;
  } catch (cause) {
    if (cause instanceof XmlError && cause.code === 'ERR_XML_LIMIT') reject();
    throw cause;
  } finally {
    index!.release(reservation);
  }
}

async function copyRange(elementId: number, maxBytes: number): Promise<ElementRange> {
  if (elementId === 0 || elementId === 1)
    throw new XmlError(
      'ERR_XML_COPY_ROOT',
      'Copying the XML document or root element is unsupported; nothing copied',
    );
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new RangeError('maxBytes must be a positive safe integer');
  const node = index!.get(elementId);
  if (node.parent === 0)
    throw new XmlError(
      'ERR_XML_COPY_ROOT',
      'Copying the XML document or root element is unsupported; nothing copied',
    );
  if (node.tapeEnd === 0)
    throw new XmlError(
      'ERR_XML_COPY_INCOMPLETE',
      'Selected XML element is incomplete; load its closing tag before copying; nothing copied',
    );
  const budget = new CopyBudget();
  // Index-only rejection precedes all tape reads. The selected range includes its root record.
  budget.reserve(node.tapeEnd - node.tapeStart);
  try {
    const range = await elementRange(elementId, budget);
    let bytes = 0;
    for (const part of serializeStartParts(range.root, true)) {
      const length = Buffer.byteLength(part, 'utf8');
      if (length > maxBytes - bytes)
        throw copyLimit('Formatted XML subtree exceeds the clipboard byte limit; nothing copied');
      bytes += length;
    }
    return range;
  } catch (cause) {
    if (cause instanceof XmlError && cause.code === 'ERR_XML_LIMIT') throw copyLimit();
    throw cause;
  }
}

async function handle(request: DocumentRequest): Promise<unknown> {
  if (request.type === 'load') {
    sessionId = request.sessionId;
    sourceBytes = 0;
    complete = false;
    tapePath = join(request.payload.workspaceDirectory, 'events.tape');
    index = new NodeIndex(
      join(request.payload.workspaceDirectory, 'index.sqlite'),
      request.payload.options.maxIndexBytes,
    );
    writer = TapeWriter.create(tapePath);
    if (request.payload.preview) {
      preview = await PreviewStore.begin(
        join(request.payload.workspaceDirectory, 'preview.xml'),
        index,
      );
      xmlView = new FoldedXmlView(index, preview);
    }
    input = chunkSource();
    const tape = writer;
    const nodes = index;
    ingestion = (async () => {
      try {
        await ingest(input!, tape, request.payload.options, (event, offset, nextOffset, flags) => {
          const id = nodes.accept(event, offset, nextOffset, flags);
          preview?.accept(event, id);
        });
      } finally {
        try {
          await tape.close();
        } finally {
          try {
            await preview?.flush();
          } finally {
            nodes.flush();
          }
        }
      }
    })();
    void ingestion.catch(() => {});
    progress('parse', 0, true);
    return { tapePath, totalElements: 0, indexBytes: index.allocatedBytes };
  }
  if (request.type === 'close') {
    xmlView?.close();
    xmlView = undefined;
    try {
      await preview?.close();
    } finally {
      try {
        await writer?.close();
      } finally {
        index?.close();
      }
    }
    preview = undefined;
    index = undefined;
    writer = undefined;
    complete = false;
    return null;
  }
  if (!index) throw new XmlError('ERR_XML_CLOSED', 'Document is not loaded');
  switch (request.type) {
    case 'append':
      sourceBytes = request.payload.sourceBytes;
      await Promise.race([input!.push(request.payload.chunk), ingestion!]);
      await writer!.flush();
      await preview?.flush();
      index.flush();
      progress('parse', index.count);
      return {
        totalElements: index.count,
        indexBytes: index.allocatedBytes,
        rootClosed: index.count > 0 && index.get(1).tapeEnd > 0,
      };
    case 'finish':
      sourceBytes = request.payload.sourceBytes;
      await Promise.race([input!.push(null), ingestion!]);
      await ingestion;
      index.finish(writer!.bytes);
      await preview?.finish();
      index.flush();
      complete = true;
      progress('ready', index.count, true);
      return { totalElements: index.count, indexBytes: index.allocatedBytes };
    case 'treeRows': {
      const page = index.treeRows(request.payload);
      if (complete) {
        page.needsMore = false;
        delete page.continuation;
      }
      return page;
    }
    case 'detailRows': {
      if (!preview)
        throw new XmlError('ERR_XML_PREVIEW', 'Preview was not requested for this session');
      const page = await preview.rows(request.payload);
      if (complete) page.needsMore = false;
      return page;
    }
    case 'xmlRows': {
      if (!xmlView)
        throw new XmlError('ERR_XML_PREVIEW', 'Preview was not requested for this session');
      const page = await xmlView.rows(request.payload);
      if (complete) {
        page.needsMore = false;
        delete page.continuation;
      }
      return page;
    }
    case 'overview':
      return index.overview();
    case 'fuzzy':
      return await index.fuzzy(request.payload.query, () => latestFuzzy !== request.requestId);
    case 'reveal':
      index.reveal(request.payload.elementId);
      return null;
    case 'expand':
      await index.expand(request.payload);
      return null;
    case 'copyRef':
      return await copyRange(request.payload.elementId, request.payload.maxBytes);
    case 'nodePath':
      return await nodePath(request.payload.ref, request.payload.kind);
    case 'elementRanges': {
      const ranges: ElementRange[] = [];
      for (const id of request.payload.elementIds) ranges.push(await elementRange(id));
      return ranges;
    }
  }
}

port.on('message', (request: DocumentRequest) => {
  if (
    !request ||
    typeof request !== 'object' ||
    typeof request.sessionId !== 'string' ||
    !Number.isSafeInteger(request.requestId) ||
    typeof request.type !== 'string'
  )
    return;
  if (request.type === 'fuzzy') latestFuzzy = request.requestId;
  queue = queue.then(async () => {
    try {
      const value = await handle(request);
      port.postMessage({
        sessionId: request.sessionId,
        requestId: request.requestId,
        type: 'result',
        value,
      } satisfies WorkerResponse);
    } catch (cause) {
      const error: WireError = {
        code:
          cause instanceof XmlError
            ? cause.code
            : cause instanceof Error && 'code' in cause && typeof cause.code === 'string'
              ? cause.code
              : 'ERR_XML_IO',
        message: cause instanceof Error ? cause.message : String(cause),
        ...(cause instanceof XmlError
          ? {
              line: cause.line,
              column: cause.column,
              byteOffset: cause.byteOffset,
              path: cause.path,
            }
          : {}),
        cause:
          cause instanceof Error && cause.cause !== undefined ? String(cause.cause) : undefined,
      };
      port.postMessage({
        sessionId: request.sessionId,
        requestId: request.requestId,
        type: 'error',
        error,
      } satisfies WorkerResponse);
    }
  });
});
