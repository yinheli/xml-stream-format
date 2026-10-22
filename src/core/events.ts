import type { ElementInfo } from './hooks.js';
export const XML_NS = 'http://www.w3.org/XML/1998/namespace';
export const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
export enum Kind {
  Declaration = 1,
  Start = 2,
  End = 3,
  Text = 4,
  CdataStart = 5,
  CdataEnd = 6,
  Comment = 7,
  Pi = 8,
}
export enum Content {
  DirectText = 1,
  NonWhitespace = 2,
  Cdata = 4,
  Preserve = 8,
  Markup = 16,
}
export interface StartData extends ElementInfo {
  namespaces: readonly { prefix: string; uri: string }[];
}
export type XmlEvent =
  | { kind: Kind.Declaration; data: { version: string; standalone?: boolean }; flags?: number }
  | { kind: Kind.Start; data: StartData; flags?: number }
  | { kind: Kind.End | Kind.CdataStart | Kind.CdataEnd; data: null; flags?: number }
  | { kind: Kind.Text | Kind.Comment; data: string; flags?: number }
  | { kind: Kind.Pi; data: { target: string; value: string }; flags?: number };
export type TapeRecord = XmlEvent & { offset: number; nextOffset: number; flags: number };
