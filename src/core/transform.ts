import { checkAbort, XmlError } from './errors.js';
import type { StartData, XmlEvent } from './events.js';
import { Kind, XML_NS, XMLNS_NS } from './events.js';
import type { ElementInfo, HookContext, MaybePromise, XmlAttribute, XmlHooks } from './hooks.js';
import type { FormatOptions } from './options.js';

/** Run caller code once, retaining its cause while allowing an abort to stop waiting. */
function invokeHook<T>(
  name: keyof XmlHooks,
  invoke: () => MaybePromise<T>,
  context: HookContext,
): Promise<T> {
  const { signal, path } = context;
  checkAbort(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }

    let result: MaybePromise<T>;
    try {
      result = invoke();
    } catch (cause) {
      if (!settled) {
        settled = true;
        signal?.removeEventListener('abort', abort);
        reject(
          new XmlError('ERR_XML_HOOK', `${name} failed at /${path.join('/')}`, { cause, path }),
        );
      }
      return;
    }
    // Always attach both handlers, including when the hook synchronously aborts.
    // Its eventual result must not resume processing or become an unhandled rejection.
    Promise.resolve(result).then(
      (value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        resolve(value);
      },
      (cause) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        reject(
          new XmlError('ERR_XML_HOOK', `${name} failed at /${path.join('/')}`, { cause, path }),
        );
      },
    );
  });
}

/** UTF-8 encoding replaces lone surrogates before Expat can reject the original value. */
function assertUnicode(value: string, context: HookContext): void {
  // Node >=22 provides this method; the compilation target uses ES2022 library types.
  if (!(value as string & { isWellFormed(): boolean }).isWellFormed()) {
    throw new XmlError('ERR_XML_HOOK', 'Hook returned a string containing an unpaired surrogate', {
      path: context.path,
    });
  }
}

/** Resolve only existing bindings; the downstream Expat pass validates QName grammar. */
function resolveName(
  name: string,
  attribute: boolean,
  namespaces: ReadonlyMap<string, string>,
  context: HookContext,
): Omit<XmlAttribute, 'value'> {
  assertUnicode(name, context);
  const separator = name.indexOf(':');
  const prefix = separator < 0 ? '' : name.slice(0, separator);
  const localName = separator < 0 ? name : name.slice(separator + 1);
  if ((attribute && name === 'xmlns') || prefix === 'xmlns') {
    throw new XmlError('ERR_XML_HOOK', 'Hooks cannot create or modify namespace declarations', {
      path: context.path,
    });
  }
  const namespaceURI = prefix
    ? namespaces.get(prefix)
    : attribute
      ? ''
      : (namespaces.get('') ?? '');
  if (prefix && !namespaceURI) {
    throw new XmlError('ERR_XML_HOOK', `Hook name ${JSON.stringify(name)} uses an unbound prefix`, {
      path: context.path,
    });
  }
  return { name, prefix, localName, namespaceURI: namespaceURI ?? '' };
}

/** Transform before content classification, without retaining any document-wide state. */
export async function* transformEvents(
  batches: AsyncIterable<readonly XmlEvent[]>,
  options: FormatOptions,
): AsyncGenerator<XmlEvent> {
  checkAbort(options.signal);
  const hooks = options.hooks;
  if (!hooks?.onNode && !hooks?.onAttribute && !hooks?.onText) {
    for await (const batch of batches) {
      for (const event of batch) {
        checkAbort(options.signal);
        yield event;
      }
    }
    return;
  }

  const namespaces = new Map<string, string>([
    ['xml', XML_NS],
    ['', ''],
  ]);
  const sourcePath: string[] = [];
  const scopes: { prefix: string; previous: string | undefined }[][] = [];
  let skippedDepth = 0;
  let cdata = false;
  // Only invoked hooks receive immutable source-path snapshots; ancestors retain no copies.
  const context = (): HookContext =>
    Object.freeze({
      path: Object.freeze(sourcePath.slice()),
      depth: sourcePath.length - 1,
      ...(options.signal ? { signal: options.signal } : {}),
    });

  for await (const batch of batches) {
    for (const event of batch) {
      checkAbort(options.signal);
      if (skippedDepth) {
        if (event.kind === Kind.Start) skippedDepth++;
        else if (event.kind === Kind.End && --skippedDepth === 0) {
          for (const { prefix, previous } of scopes.pop()!) {
            if (previous === undefined) namespaces.delete(prefix);
            else namespaces.set(prefix, previous);
          }
          sourcePath.pop();
        }
        continue;
      }

      if (event.kind === Kind.Start) {
        const restore: { prefix: string; previous: string | undefined }[] = [];
        for (const { prefix, uri } of event.data.namespaces) {
          restore.push({ prefix, previous: namespaces.get(prefix) });
          namespaces.set(prefix, uri);
        }
        scopes.push(restore);
        sourcePath.push(event.data.name);
        if (!hooks.onNode && !hooks.onAttribute) {
          yield event;
          continue;
        }
        const current = context();
        const patch = hooks.onNode
          ? await invokeHook(
              'onNode',
              () => {
                const attributes: XmlAttribute[] = event.data.namespaces.map(({ prefix, uri }) =>
                  Object.freeze({
                    name: prefix ? `xmlns:${prefix}` : 'xmlns',
                    prefix: prefix ? 'xmlns' : '',
                    localName: prefix || 'xmlns',
                    namespaceURI: XMLNS_NS,
                    value: uri,
                  }),
                );
                for (const attribute of event.data.attributes) attributes.push({ ...attribute });
                const node: ElementInfo = {
                  name: event.data.name,
                  prefix: event.data.prefix,
                  localName: event.data.localName,
                  namespaceURI: event.data.namespaceURI,
                  attributes: Object.freeze(attributes),
                };
                return hooks.onNode!(node, current);
              },
              current,
            )
          : undefined;
        if (patch === false) {
          if (sourcePath.length === 1) {
            throw new XmlError('ERR_XML_HOOK', 'Hooks cannot remove the document root', {
              path: current.path,
            });
          }
          skippedDepth = 1;
          continue;
        }

        const replacementAttributes = patch ? patch.attributes : undefined;
        const replacementName = patch ? patch.name : undefined;
        let attributes: readonly XmlAttribute[] =
          replacementAttributes === undefined
            ? event.data.attributes
            : replacementAttributes.map((attribute) => {
                assertUnicode(attribute.value, current);
                return {
                  ...resolveName(attribute.name, true, namespaces, current),
                  value: attribute.value,
                };
              });
        const name =
          replacementName === undefined
            ? event.data
            : resolveName(replacementName, false, namespaces, current);
        if (hooks.onAttribute) {
          const updated: XmlAttribute[] = [];
          for (const attribute of attributes) {
            const attributePatch = await invokeHook(
              'onAttribute',
              () => hooks.onAttribute!({ ...attribute }, current),
              current,
            );
            if (attributePatch === null) continue;
            if (!attributePatch) updated.push(attribute);
            else {
              if (attributePatch.value !== undefined) assertUnicode(attributePatch.value, current);
              updated.push({
                ...(attributePatch.name === undefined
                  ? attribute
                  : resolveName(attributePatch.name, true, namespaces, current)),
                value: attributePatch.value ?? attribute.value,
              });
            }
          }
          attributes = updated;
        }
        const data: StartData = { ...name, attributes, namespaces: event.data.namespaces };
        checkAbort(options.signal);
        yield { ...event, data };
      } else if (event.kind === Kind.End) {
        // End events carry no name; serialization closes the transformed start name.
        for (const { prefix, previous } of scopes.pop()!) {
          if (previous === undefined) namespaces.delete(prefix);
          else namespaces.set(prefix, previous);
        }
        sourcePath.pop();
        yield event;
      } else if (event.kind === Kind.Text && hooks.onText) {
        const current = Object.freeze({
          ...context(),
          kind: cdata ? ('cdata' as const) : ('text' as const),
        });
        const replacement = await invokeHook(
          'onText',
          () => hooks.onText!(event.data, current),
          current,
        );
        if (typeof replacement === 'string') assertUnicode(replacement, current);
        const text = typeof replacement === 'string' ? replacement : event.data;
        checkAbort(options.signal);
        if (text.length) yield { ...event, data: text };
      } else {
        if (event.kind === Kind.CdataStart) cdata = true;
        else if (event.kind === Kind.CdataEnd) cdata = false;
        yield event;
      }
    }
  }
}
