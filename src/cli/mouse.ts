export interface TerminalMouseEvent {
  action: 'press' | 'release' | 'wheel';
  /** SGR button code without modifiers: 0/1/2, wheel 64..67, extra buttons 128..131. */
  button: number;
  /** One-based terminal cell coordinates, not pixels. */
  x: number;
  y: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

const escapeChar = '\u001b';
const pasteStart = '\u001b[200~';
const pasteEnd = '\u001b[201~';
const maximumCoordinate = 2_147_483_647;
const maximumReportLength = 29;

/** Bounded SGR1006 demultiplexer; keyboard and bracketed paste remain byte-for-byte literal. */
export class SgrMouseParser {
  private prefix = '';
  private forwardedPrefix = 0;
  private inMouse = false;
  private report = '';
  private paste = false;
  private pasteEndMatched = 0;

  get hasPendingEscape(): boolean {
    return (
      this.prefix.length > 0 && this.prefix.length <= 2 && this.forwardedPrefix < this.prefix.length
    );
  }

  /** Release an ambiguous Escape, retaining its prefix to recognize a late mouse remainder. */
  flushPendingEscape(keyboard: (chunk: Uint8Array | string) => void): void {
    if (!this.hasPendingEscape) return;
    if (this.forwardedPrefix === 0) keyboard(escapeChar);
    // '[' is protocol syntax, never a timeout-generated sibling-navigation key.
    this.forwardedPrefix = this.prefix.length;
  }

  finish(keyboard: (chunk: Uint8Array | string) => void): void {
    if (this.prefix.length > this.forwardedPrefix)
      keyboard(this.prefix.slice(this.forwardedPrefix));
    this.reset();
  }

  reset(): void {
    this.prefix = '';
    this.forwardedPrefix = 0;
    this.inMouse = false;
    this.report = '';
    this.paste = false;
    this.pasteEndMatched = 0;
  }

  push(
    chunk: Uint8Array | string,
    mouse: (event: TerminalMouseEvent) => void,
    keyboard?: (chunk: Uint8Array | string) => void,
  ): void {
    let index = 0;
    let ordinaryStart = 0;
    while (index < chunk.length) {
      const byte = typeof chunk === 'string' ? chunk.charCodeAt(index) : chunk[index]!;
      if (this.paste) {
        if (byte === pasteEnd.charCodeAt(this.pasteEndMatched)) this.pasteEndMatched++;
        else this.pasteEndMatched = byte === 0x1b ? 1 : 0;
        if (this.pasteEndMatched === pasteEnd.length) {
          this.paste = false;
          this.pasteEndMatched = 0;
        }
        index++;
        continue;
      }
      if (byte === 0x1b || this.prefix.length > 0 || this.inMouse) {
        if (index > ordinaryStart)
          keyboard?.(
            typeof chunk === 'string'
              ? chunk.slice(ordinaryStart, index)
              : chunk.subarray(ordinaryStart, index),
          );
        ordinaryStart = index;
      }
      if (byte === 0x1b) {
        if (this.prefix.length > this.forwardedPrefix)
          keyboard?.(this.prefix.slice(this.forwardedPrefix));
        this.prefix = escapeChar;
        this.forwardedPrefix = 0;
        this.inMouse = false;
        this.report = '';
        ordinaryStart = ++index;
        continue;
      }
      if (this.prefix.length > 0) {
        const candidate = this.prefix + String.fromCharCode(byte);
        if (candidate === '\u001b[<') {
          this.inMouse = true;
          this.report = candidate;
          this.prefix = '';
          this.forwardedPrefix = 0;
          ordinaryStart = ++index;
          continue;
        }
        if (pasteStart.startsWith(candidate)) {
          this.prefix = candidate;
          if (candidate === pasteStart) {
            keyboard?.(candidate);
            this.prefix = '';
            this.forwardedPrefix = 0;
            this.paste = true;
          }
          ordinaryStart = ++index;
          continue;
        }
        if (this.forwardedPrefix && this.prefix.startsWith(`${escapeChar}[`))
          keyboard?.(this.prefix);
        else if (this.prefix.length > this.forwardedPrefix)
          keyboard?.(this.prefix.slice(this.forwardedPrefix));
        this.prefix = '';
        this.forwardedPrefix = 0;
        // Reprocess the non-prefix character as ordinary input.
        continue;
      }
      if (this.inMouse) {
        if (byte < 0x20 || byte > 0x7e) {
          this.inMouse = false;
          this.report = '';
          // In particular, Ctrl+C must still interrupt a truncated report.
          continue;
        }
        if (this.report.length > 0) {
          this.report =
            this.report.length < maximumReportLength ? this.report + String.fromCharCode(byte) : '';
        }
        if (byte >= 0x40) {
          const report = this.report;
          this.inMouse = false;
          this.report = '';
          const match = /^\u001b\[<(\d{1,3});(\d{1,10});(\d{1,10})([Mm])$/.exec(report);
          if (match) {
            const encoded = Number(match[1]);
            const button = encoded & ~28;
            const x = Number(match[2]);
            const y = Number(match[3]);
            const wheel = button >= 64 && button <= 67;
            if (
              encoded <= 255 &&
              x > 0 &&
              y > 0 &&
              x <= maximumCoordinate &&
              y <= maximumCoordinate &&
              (button <= 2 || (button >= 128 && button <= 131) || (wheel && match[4] === 'M'))
            ) {
              mouse({
                action: wheel ? 'wheel' : match[4] === 'm' ? 'release' : 'press',
                button,
                x,
                y,
                shift: (encoded & 4) !== 0,
                alt: (encoded & 8) !== 0,
                ctrl: (encoded & 16) !== 0,
              });
            }
          }
        }
        ordinaryStart = ++index;
        continue;
      }
      index++;
    }
    if (ordinaryStart < chunk.length)
      keyboard?.(
        ordinaryStart === 0
          ? chunk
          : typeof chunk === 'string'
            ? chunk.slice(ordinaryStart)
            : chunk.subarray(ordinaryStart),
      );
  }
}
