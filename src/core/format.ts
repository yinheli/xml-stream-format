import { buildTape } from './build-tape.js';
import { checkAbort } from './errors.js';
import { readTape } from './event-tape.js';
import { normalizeInput } from './input.js';
import type { FormatOptions } from './options.js';
import type { ReplayOptions } from './replay.js';
import { indentation, replayRecords } from './replay.js';
import { Workspace } from './workspace.js';

export type { ReplayOptions } from './replay.js';

/** UTF-8-bounded output batching; a slow consumer stops tape reads. */
export async function* replayTape(
  path: string,
  options: ReplayOptions = {},
): AsyncGenerator<string> {
  yield* replayRecords(readTape(path, options), options);
}

/** Disk-assisted streaming: input is validated completely before the first output. */
export async function* formatXml(
  source: AsyncIterable<Uint8Array | string>,
  options: FormatOptions = {},
): AsyncGenerator<string> {
  indentation(options);
  checkAbort(options.signal);
  const workspace = await Workspace.create(options.tempDirectory);
  try {
    const path = await buildTape(
      normalizeInput(source, {
        signal: options.signal,
        maxTokenCodeUnits: options.maxTokenCodeUnits,
      }),
      workspace,
      options,
    );
    yield* replayTape(path, options);
  } finally {
    await workspace.close();
  }
}
