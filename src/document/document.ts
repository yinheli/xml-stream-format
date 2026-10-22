import type { FormatOptions } from '../core/options.js';
import { extractMatches } from '../xpath/extract.js';
import { QueryClient } from '../xpath/query-client.js';
import type { DocumentSession, SessionViewOptions } from './session.js';
import { createSession } from './session.js';
import type { OpenOptions, SelectOptions, XmlDocument, XmlNodeMatch } from './types.js';

/** Internal browser handle; root exports deliberately expose only XmlDocument. */
export class DocumentHandle implements XmlDocument {
  readonly queries: QueryClient;
  private closing?: Promise<void>;
  constructor(readonly session: DocumentSession) {
    this.queries = new QueryClient(session);
  }
  select(expression: string, options?: SelectOptions): Promise<readonly XmlNodeMatch[]> {
    return this.queries.select(expression, options);
  }
  async *extract(
    expression: string,
    options: SelectOptions & Pick<FormatOptions, 'indent' | 'whitespace'> = {},
  ): AsyncGenerator<string> {
    const matches = await this.select(expression, options);
    yield* extractMatches(this.session, matches, options);
  }
  readValue(
    match: XmlNodeMatch,
    options: SelectOptions = {},
    maxBytes = 1_048_576,
  ): Promise<string> {
    return this.queries.readValue(match, options, maxBytes);
  }
  close(): Promise<void> {
    if (this.closing === undefined) {
      this.closing = (async () => {
        try {
          await this.queries.close();
        } finally {
          await this.session.close();
        }
      })();
    }
    return this.closing;
  }
}

export async function openXml(
  source: AsyncIterable<Uint8Array | string>,
  options: OpenOptions = {},
): Promise<XmlDocument> {
  const session = await createSession(source, options);
  try {
    await session.ensureComplete();
    return new DocumentHandle(session);
  } catch (error) {
    await session.close();
    throw error;
  }
}

export async function openBrowserXml(
  source: AsyncIterable<Uint8Array | string>,
  options: OpenOptions = {},
  view: SessionViewOptions = {},
): Promise<DocumentHandle> {
  return new DocumentHandle(await createSession(source, options, view));
}
