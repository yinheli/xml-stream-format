import { parentPort } from 'node:worker_threads';
import type * as slimdom from 'slimdom';
import fontoxpath from '#fontoxpath';
import { XmlError } from '../core/errors.js';
import { readTape } from '../core/event-tape.js';
import { XML_NS } from '../core/events.js';
import type { WireError, WorkerResponse } from '../document/protocol.js';
import type { XmlNodeMatch, XmlNodeRef } from '../document/types.js';
import type { DomDocument } from './dom-builder.js';
import { buildDom } from './dom-builder.js';
import { canonicalXPath, nodeLabel } from './paths.js';
import type { QueryRequest } from './protocol.js';

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
// FontoXPath's predefined namespaces resolve before the caller's resolver.
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

if (!parentPort) throw new Error('XPath worker requires a parent port');
const port = parentPort;
let dom: DomDocument | undefined;
let sessionId: string | undefined;
let valueNodes = new Map<string, slimdom.Node>();
let queue = Promise.resolve();

function valueKey(ref: XmlNodeRef): string | undefined {
  switch (ref.kind) {
    case 'attribute':
      return JSON.stringify(['attribute', ref.ownerElementId, ref.namespaceURI, ref.localName]);
    case 'text':
      return `text:${ref.parentElementId}:${ref.textRunOrdinal}`;
    default:
      return undefined;
  }
}

function select(
  request: Extract<QueryRequest, { type: 'select' }>,
  document: DomDocument,
): readonly XmlNodeMatch[] {
  const { expression, namespaces, maxResults } = request.payload;
  const bindings = new Map<string, string>();
  for (const [prefix, uri] of namespaces) {
    const predefined = Object.hasOwn(PREDEFINED_NAMESPACES, prefix)
      ? PREDEFINED_NAMESPACES[prefix]
      : undefined;
    if (predefined !== undefined && uri !== predefined) {
      throw new XmlError(
        'ERR_XPATH_QUERY',
        `The ${prefix} prefix must resolve to its built-in namespace (${predefined})`,
      );
    }
    bindings.set(prefix, uri);
  }
  bindings.set('xml', XML_NS);

  let nodes: slimdom.Node[];
  try {
    nodes = fontoxpath.evaluateXPathToNodes<slimdom.Node>(
      expression,
      document.document,
      null,
      {},
      {
        language: fontoxpath.evaluateXPath.XPATH_3_1_LANGUAGE,
        namespaceResolver: (prefix) => bindings.get(prefix) ?? null,
        logger: { trace: () => {} },
      },
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const code =
      message === `Expected XPath ${expression} to resolve to a sequence of Nodes.`
        ? 'ERR_XPATH_RESULT_TYPE'
        : 'ERR_XPATH_QUERY';
    throw new XmlError(code, message, { cause });
  }

  if (nodes.length > maxResults) {
    throw new XmlError(
      'ERR_XPATH_LIMIT',
      `XPath returned ${nodes.length} nodes, exceeding maxResults (${maxResults})`,
    );
  }

  const matches: XmlNodeMatch[] = [];
  const nextValueNodes = new Map<string, slimdom.Node>();
  let responseBytes = Buffer.byteLength(
    JSON.stringify({
      sessionId: request.sessionId,
      requestId: request.requestId,
      type: 'result',
      value: [],
    } satisfies WorkerResponse),
    'utf8',
  );
  for (const node of nodes) {
    const ref = document.refs.get(node);
    if (!ref) {
      throw new XmlError(
        'ERR_XPATH_RESULT_TYPE',
        'XPath results must refer to nodes in the source document',
      );
    }
    const match: XmlNodeMatch = {
      ref,
      xpath: canonicalXPath(node, document),
      label: nodeLabel(node),
    };
    responseBytes +=
      Buffer.byteLength(JSON.stringify(match), 'utf8') + (matches.length === 0 ? 0 : 1);
    if (responseBytes > MAX_RESPONSE_BYTES) {
      throw new XmlError('ERR_XPATH_LIMIT', 'XPath response exceeds the 16 MiB response limit');
    }
    matches.push(match);
    const key = valueKey(ref);
    if (key !== undefined) nextValueNodes.set(key, node);
  }
  valueNodes = nextValueNodes;
  return matches;
}

async function handle(request: QueryRequest): Promise<unknown> {
  if (request.type === 'load') {
    const loaded = await buildDom(readTape(request.payload.tapePath));
    dom = loaded;
    sessionId = request.sessionId;
    valueNodes.clear();
    return null;
  }
  if (request.sessionId !== sessionId)
    throw new XmlError('ERR_XML_CLOSED', 'XPath session is not loaded');
  if (request.type === 'close') {
    dom = undefined;
    valueNodes.clear();
    return null;
  }
  if (!dom) throw new XmlError('ERR_XML_CLOSED', 'XPath document is not loaded');
  if (request.type === 'select') return select(request, dom);

  const { ref, maxBytes } = request.payload;
  const key = valueKey(ref);
  if (key === undefined) {
    throw new XmlError(
      'ERR_XML_COPY_NODE_TYPE',
      'Only matched attributes and text nodes have copyable values',
    );
  }
  const node = valueNodes.get(key);
  if (!node)
    throw new XmlError(
      'ERR_XML_COPY_NODE_TYPE',
      'Node was not matched by the last successful XPath query',
    );
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new RangeError('maxBytes must be a nonnegative safe integer');
  const value = node.nodeValue ?? '';
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new XmlError('ERR_XML_COPY_LIMIT', `Node value exceeds the ${maxBytes}-byte copy limit`);
  }
  return value;
}

function wireError(cause: unknown): WireError {
  const error: WireError = {
    code:
      cause instanceof XmlError
        ? cause.code
        : cause instanceof Error && 'code' in cause && typeof cause.code === 'string'
          ? cause.code
          : 'ERR_XPATH_QUERY',
    message: cause instanceof Error ? cause.message : String(cause),
  };
  if (cause instanceof XmlError) {
    error.line = cause.line;
    error.column = cause.column;
    error.byteOffset = cause.byteOffset;
    error.path = cause.path;
  }
  if (cause instanceof Error && cause.cause !== undefined) error.cause = String(cause.cause);
  return error;
}

port.on('message', (request: QueryRequest) => {
  if (
    !request ||
    typeof request !== 'object' ||
    typeof request.sessionId !== 'string' ||
    !Number.isSafeInteger(request.requestId) ||
    !['load', 'select', 'readValue', 'close'].includes(request.type)
  )
    return;
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
      port.postMessage({
        sessionId: request.sessionId,
        requestId: request.requestId,
        type: 'error',
        error: wireError(cause),
      } satisfies WorkerResponse);
    }
  });
});
