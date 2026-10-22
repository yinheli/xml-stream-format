import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** Owns only the newly created directory, never its caller-provided parent. */
export class Workspace {
  private closing?: Promise<void>;

  private constructor(readonly directory: string) {}

  static async create(tempDirectory?: string): Promise<Workspace> {
    const directory = await mkdtemp(join(tempDirectory ?? tmpdir(), 'xml-stream-format-'));
    try {
      await chmod(directory, 0o700);
      return new Workspace(directory);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  /** Returns an owned filename; creators must open it with mode 0600. */
  file(name: string): string {
    if (this.closing) throw new Error('Workspace is closed');
    if (!name || name === '.' || name === '..' || isAbsolute(name) || /[/\\\0]/u.test(name)) {
      throw new TypeError('Workspace filenames must be single path components');
    }
    return join(this.directory, name);
  }

  close(): Promise<void> {
    if (this.closing === undefined)
      this.closing = rm(this.directory, { recursive: true, force: true });
    return this.closing;
  }
}
