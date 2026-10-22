import { checkAbort, XmlError } from '../core/errors.js';
import type { FormatOptions } from '../core/options.js';
import type { DocumentSession } from '../document/session.js';
import type { XmlNodeMatch } from '../document/types.js';

/** Preflight every match so an unsupported result cannot produce partial XML. */
export async function* extractMatches(
  session: DocumentSession,
  matches: readonly XmlNodeMatch[],
  options: Pick<FormatOptions, 'indent' | 'whitespace' | 'signal'> = {},
): AsyncGenerator<string> {
  session.assertOpen();
  for (const match of matches)
    if (match.ref.kind !== 'element' && match.ref.kind !== 'document')
      throw new XmlError(
        'ERR_XML_EXTRACT_NODE_TYPE',
        `Cannot extract ${match.ref.kind}; only elements and documents form XML fragments`,
      );
  const signal = options.signal
    ? AbortSignal.any([options.signal, session.signal])
    : session.signal;
  await session.ensureComplete(signal);
  for (const match of matches) {
    checkAbort(signal);
    if (match.ref.kind === 'document') yield* session.extractDocument({ ...options, signal });
    else if (match.ref.kind === 'element')
      yield* session.extractElements([match.ref.elementId], { ...options, signal });
  }
}
