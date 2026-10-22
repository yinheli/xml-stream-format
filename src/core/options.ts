import type { XmlHooks } from './hooks.js';
export interface FormatOptions {
  indent?: number | 'tab';
  whitespace?: 'preserve' | 'reindent';
  hooks?: XmlHooks;
  signal?: AbortSignal;
  tempDirectory?: string;
  maxDepth?: number;
  maxTokenCodeUnits?: number;
}
