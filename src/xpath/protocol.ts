import type { XmlNodeMatch, XmlNodeRef } from '../document/types.js';
export interface QueryRequests {
  load: { tapePath: string };
  select: {
    expression: string;
    namespaces: readonly (readonly [string, string])[];
    maxResults: number;
  };
  readValue: { ref: XmlNodeRef; maxBytes: number };
  close: Record<string, never>;
}
export interface QueryResults {
  load: null;
  select: readonly XmlNodeMatch[];
  readValue: string;
  close: null;
}
export type QueryRequest = {
  [K in keyof QueryRequests]: {
    sessionId: string;
    requestId: number;
    type: K;
    payload: QueryRequests[K];
  };
}[keyof QueryRequests];
