import type { WriteStream } from 'node:tty';
import type { FormatOptions } from '../core/options.js';
import type { OpenOptions, SelectOptions } from '../document/types.js';
import type { TerminalMouseEvent } from './mouse.js';
export type ClipboardMode = 'auto' | 'local' | 'osc52' | 'off';
export interface TerminalInput extends NodeJS.ReadableStream {
  readonly isTTY: boolean;
  readonly isRaw: boolean;
  setRawMode(mode: boolean): this;
  ref(): this;
  unref(): this;
}
export interface ViewTerminal {
  readonly input: TerminalInput;
  readonly output: WriteStream;
  readonly mouseEnabled: boolean;
  onMouse(listener: (event: TerminalMouseEvent) => void): () => void;
}
export interface ViewSettings {
  source: AsyncIterable<Uint8Array | string>;
  sourceLabel: string;
  inputPath?: string;
  openOptions: OpenOptions;
  selectOptions: SelectOptions;
  formatOptions: Pick<FormatOptions, 'indent' | 'whitespace'>;
  clipboard: ClipboardMode;
  terminal: ViewTerminal;
}
