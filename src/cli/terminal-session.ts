import { closeSync, openSync, writeSync } from 'node:fs';
import type { TransformCallback } from 'node:stream';
import { Transform } from 'node:stream';
import { isatty, ReadStream, WriteStream } from 'node:tty';
import { XmlError } from '../core/errors.js';
import type { TerminalMouseEvent } from './mouse.js';
import { SgrMouseParser } from './mouse.js';
import type { TerminalInput, ViewTerminal } from './types.js';

export interface TerminalEnterOptions {
  mouse?: boolean;
}

const escapeDelayMs = 50;

class TerminalKeyboardInput extends Transform implements TerminalInput {
  private readonly parser = new SgrMouseParser();
  private mouse = false;
  private escapeTimer: NodeJS.Timeout | undefined;
  private readonly forwardKeyboard = (chunk: Uint8Array | string): void => {
    this.push(chunk);
  };
  private readonly sourceError = (error: Error): void => {
    this.destroy(error);
  };

  constructor(
    private readonly physical: ReadStream,
    private readonly emitMouse: (event: TerminalMouseEvent) => void,
  ) {
    super({ highWaterMark: 4_096 });
  }

  get isTTY(): boolean {
    return this.physical.isTTY;
  }
  get isRaw(): boolean {
    return this.physical.isRaw;
  }
  setRawMode(mode: boolean): this {
    this.physical.setRawMode(mode);
    return this;
  }
  ref(): this {
    this.physical.ref();
    return this;
  }
  unref(): this {
    this.physical.unref();
    return this;
  }

  start(mouse: boolean): void {
    this.mouse = mouse;
    this.physical.on('error', this.sourceError);
    // Node's pipe/Transform backpressure bounds unread keyboard data and pauses
    // the physical TTY when Ink stops draining this readable side.
    this.physical.pipe(this);
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    clearTimeout(this.escapeTimer);
    this.escapeTimer = undefined;
    if (!this.mouse) {
      callback(null, chunk);
      return;
    }
    try {
      this.parser.push(chunk, this.emitMouse, this.forwardKeyboard);
      if (this.parser.hasPendingEscape) {
        this.escapeTimer = setTimeout(() => {
          this.escapeTimer = undefined;
          this.parser.flushPendingEscape(this.forwardKeyboard);
        }, escapeDelayMs);
        this.escapeTimer.unref();
      }
      callback();
    } catch (cause) {
      callback(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }

  override _flush(callback: TransformCallback): void {
    clearTimeout(this.escapeTimer);
    this.escapeTimer = undefined;
    this.parser.finish(this.forwardKeyboard);
    callback();
  }

  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    clearTimeout(this.escapeTimer);
    this.escapeTimer = undefined;
    this.parser.reset();
    this.physical.unpipe(this);
    this.physical.removeListener('error', this.sourceError);
    this.physical.pause();
    callback(error);
  }
}

interface OwnedTerminal {
  inputFd?: number;
  outputFd?: number;
  input?: ReadStream;
  output?: WriteStream;
}

function releaseOwned(terminal: OwnedTerminal): unknown[] {
  const failures: unknown[] = [];
  const release = (fd: number | undefined, stream: ReadStream | WriteStream | undefined): void => {
    try {
      stream?.destroy();
    } catch (error) {
      failures.push(error);
    }
    // TTY streams have no autoClose option. POSIX libuv reopens the device;
    // Windows transfers ownership of nonstandard descriptors to the stream.
    if (fd !== undefined && (process.platform !== 'win32' || stream === undefined)) {
      try {
        closeSync(fd);
      } catch (error) {
        failures.push(error);
      }
    }
  };
  release(terminal.inputFd, terminal.input);
  release(terminal.outputFd, terminal.output);
  return failures;
}

export class TerminalSession implements ViewTerminal {
  private entered = false;
  private closed = false;
  private initialRaw = false;
  private mouseActive = false;
  private readonly keyboard: TerminalKeyboardInput;
  private readonly mouseListeners = new Set<(event: TerminalMouseEvent) => void>();
  private readonly emitMouse = (event: TerminalMouseEvent): void => {
    if (!this.mouseEnabled) return;
    for (const listener of this.mouseListeners) listener(event);
  };
  private readonly restoreOnExit = (): void => {
    // A fatal exception or explicit process.exit must not leave capture enabled.
    try {
      this.close();
    } catch {
      /* Normal close() reports restoration failures. */
    }
  };

  private constructor(
    private readonly physicalInput: ReadStream,
    readonly output: WriteStream,
    private readonly displayFd: number,
    private readonly owned?: OwnedTerminal,
  ) {
    this.keyboard = new TerminalKeyboardInput(physicalInput, this.emitMouse);
  }

  static open(): TerminalSession {
    const input = process.stdin;
    if (
      input instanceof ReadStream &&
      input.isTTY &&
      !input.destroyed &&
      input.readable &&
      isatty(input.fd)
    ) {
      const stderr = process.stderr;
      if (
        stderr instanceof WriteStream &&
        stderr.isTTY &&
        !stderr.destroyed &&
        stderr.writable &&
        isatty(stderr.fd)
      ) {
        return new TerminalSession(input, stderr, stderr.fd);
      }
      const stdout = process.stdout;
      if (
        stdout instanceof WriteStream &&
        stdout.isTTY &&
        !stdout.destroyed &&
        stdout.writable &&
        isatty(stdout.fd)
      ) {
        return new TerminalSession(input, stdout, stdout.fd);
      }
    }

    const owned: OwnedTerminal = {};
    try {
      const windows = process.platform === 'win32';
      owned.inputFd = openSync(windows ? '\\\\.\\CONIN$' : '/dev/tty', 'r+');
      owned.outputFd = openSync(windows ? '\\\\.\\CONOUT$' : '/dev/tty', 'r+');
      if (!isatty(owned.inputFd) || !isatty(owned.outputFd)) {
        throw new Error('The controlling terminal descriptors are not TTYs');
      }
      owned.input = new ReadStream(owned.inputFd, { readable: true, writable: false });
      owned.output = new WriteStream(owned.outputFd);
      // Do not start reading here: a piped process.stdin belongs exclusively to XML.
      owned.input.pause();
      owned.input.unref();
      owned.output.unref();
      return new TerminalSession(owned.input, owned.output, owned.outputFd, owned);
    } catch (cause) {
      const failures = releaseOwned(owned);
      throw new XmlError(
        'ERR_TTY_REQUIRED',
        'Interactive viewing requires an available controlling terminal',
        {
          cause:
            failures.length === 0
              ? cause
              : new AggregateError(
                  [cause, ...failures],
                  'Opening and releasing the terminal failed',
                ),
        },
      );
    }
  }

  get input(): TerminalInput {
    return this.keyboard;
  }

  get mouseEnabled(): boolean {
    return this.entered && this.mouseActive && !this.closed;
  }

  onMouse(listener: (event: TerminalMouseEvent) => void): () => void {
    if (this.closed) return () => {};
    const subscription = (event: TerminalMouseEvent): void => {
      listener(event);
    };
    this.mouseListeners.add(subscription);
    return () => {
      this.mouseListeners.delete(subscription);
    };
  }

  enter(options: TerminalEnterOptions = {}): void {
    if (this.closed) throw new XmlError('ERR_TTY_CLOSED', 'The terminal session is closed');
    if (this.entered) return;
    this.initialRaw = this.physicalInput.isRaw;
    this.entered = true;
    this.mouseActive = options.mouse !== false;
    process.once('exit', this.restoreOnExit);
    // Ink owns alternate-screen entry; this session provides final restoration.
    // SGR encoding comes first, and normal tracking never enables drag/hover.
    writeSync(
      this.displayFd,
      this.mouseActive ? '\u001b[?25l\u001b[?1006h\u001b[?1000h' : '\u001b[?25l',
    );
    this.keyboard.start(this.mouseActive);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const failures: unknown[] = [];
    process.removeListener('exit', this.restoreOnExit);
    this.mouseListeners.clear();
    try {
      this.keyboard.destroy();
    } catch (error) {
      failures.push(error);
    }
    if (this.entered) {
      try {
        if (this.physicalInput.isRaw !== this.initialRaw)
          this.physicalInput.setRawMode(this.initialRaw);
      } catch (error) {
        failures.push(error);
      }
      try {
        // The caller unmounts Ink first; repeat restoration for interrupted renders.
        writeSync(
          this.displayFd,
          this.mouseActive
            ? '\u001b[?1000l\u001b[?1006l\u001b[0m\u001b[?1049l\u001b[?25h'
            : '\u001b[0m\u001b[?1049l\u001b[?25h',
        );
      } catch (error) {
        failures.push(error);
      }
    }
    this.mouseActive = false;
    if (this.owned) {
      try {
        this.physicalInput.pause();
      } catch (error) {
        failures.push(error);
      }
      failures.push(...releaseOwned(this.owned));
    }
    if (failures.length > 0) {
      throw new XmlError('ERR_TTY_RESTORE', 'Failed to restore or release the terminal', {
        cause:
          failures.length === 1
            ? failures[0]
            : new AggregateError(failures, 'Terminal cleanup failed'),
      });
    }
  }
}
