export type MaybePromise<T> = T | Promise<T>;
export interface XmlAttribute {
  name: string;
  value: string;
  prefix: string;
  localName: string;
  namespaceURI: string;
}
export interface ElementInfo {
  name: string;
  prefix: string;
  localName: string;
  namespaceURI: string;
  attributes: readonly XmlAttribute[];
}
export interface HookContext {
  path: readonly string[];
  depth: number;
  signal?: AbortSignal;
}
export interface ElementPatch {
  name?: string;
  attributes?: readonly { name: string; value: string }[];
}
export interface XmlHooks {
  onNode?(node: ElementInfo, context: HookContext): MaybePromise<ElementPatch | false | void>;
  onAttribute?(
    attribute: XmlAttribute,
    context: HookContext,
  ): MaybePromise<{ name?: string; value?: string } | null | void>;
  onText?(
    text: string,
    context: HookContext & { kind: 'text' | 'cdata' },
  ): MaybePromise<string | void>;
}
