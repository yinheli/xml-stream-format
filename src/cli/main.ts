#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { addAbortSignal } from 'node:stream';
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import type { FormatOptions } from '../core/options.js';
import type { OpenOptions, SelectOptions } from '../document/types.js';
import { formatXml, openXml, XmlError } from '../index.js';
import { writeOutput } from './output.js';
import { TerminalSession } from './terminal-session.js';
import type { ClipboardMode, ViewSettings } from './types.js';

interface CliOptions {
  indent?: number | 'tab';
  reindent?: boolean;
  tempDirectory?: string;
  maxDepth?: number;
  maxTokenCodeUnits?: number;
  output?: string;
  namespace?: Record<string, string>;
  maxSourceBytes?: number;
  xpathHeapMb?: number;
  queryTimeoutMs?: number;
  maxResults?: number;
  maxIndexBytes?: number;
  clipboard?: ClipboardMode;
  mouse?: 'on' | 'off';
  xpath?: string;
}
type Mode = 'auto' | 'format' | 'view' | 'extract';

function positive(value: string): number {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number <= 0)
    throw new InvalidArgumentError('Expected a positive safe integer');
  return number;
}
function queryTimeout(value: string): number {
  const number = positive(value);
  if (number > 2_147_483_647)
    throw new InvalidArgumentError('Query timeout must be at most 2147483647 milliseconds');
  return number;
}
function indentValue(value: string): number | 'tab' {
  if (value === 'tab') return value;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(number) || number < 0 || number > 16)
    throw new InvalidArgumentError('Indent must be 0 through 16, or tab');
  return number;
}
function namespaces(value: string, previous?: Record<string, string>): Record<string, string> {
  const equal = value.indexOf('=');
  if (equal < 0)
    throw new InvalidArgumentError(
      'Namespace must be prefix=uri; =uri sets the default element namespace',
    );
  const prefix = value.slice(0, equal);
  const uri = value.slice(equal + 1);
  const result = previous ?? (Object.create(null) as Record<string, string>);
  if (Object.hasOwn(result, prefix) && result[prefix] !== uri)
    throw new InvalidArgumentError(`Conflicting namespace for ${JSON.stringify(prefix)}`);
  result[prefix] = uri;
  return result;
}

function configure(command: Command, mode: Mode): Command {
  command
    .argument('[file]', 'XML file, or - for stdin')
    .option('--indent <n|tab>', 'indent spaces (0–16) or tab', indentValue, 2)
    .option('--reindent', 'replace eligible formatting whitespace')
    .option('--temp-directory <path>', 'parent of private temporary workspace')
    .option('--max-depth <n>', 'maximum element depth', positive)
    .option('--max-token-code-units <n>', 'maximum markup/reference size', positive);
  if (mode !== 'view')
    command.option('-o, --output <path>', 'exclusively create a new output file');
  if (mode !== 'format')
    command
      .option('-N, --namespace <prefix=uri>', 'explicit XPath binding (repeatable)', namespaces)
      .option('--max-source-bytes <n>', 'XPath original input-byte budget', positive)
      .option('--xpath-heap-mb <n>', 'XPath worker old-generation heap budget', positive)
      .option('--query-timeout-ms <n>', 'XPath evaluation deadline (1–2147483647 ms)', queryTimeout)
      .option('--max-results <n>', 'maximum XPath matches', positive)
      .option('--max-index-bytes <n>', 'allocated browser index budget', positive);
  if (mode === 'auto' || mode === 'view')
    command
      .addOption(
        new Option('--clipboard <mode>', 'clipboard transport')
          .choices(['auto', 'local', 'osc52', 'off'])
          .default('auto'),
      )
      .addOption(
        new Option(
          '--mouse <on|off>',
          'capture mouse for selection, folding and scrolling; off keeps native selection',
        )
          .choices(['on', 'off'])
          .default('on'),
      );
  if (mode === 'extract')
    command.requiredOption('--xpath <expression>', 'XPath 3.1 node expression');
  return command;
}

function diagnostic(value: string): string {
  return value.replace(
    /[\x00-\x1f\x7f-\x9f]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

async function xmlSource(
  file: string | undefined,
  maxBytes?: number,
  signal?: AbortSignal,
): Promise<AsyncIterable<Uint8Array | string>> {
  const path = file && file !== '-' ? file : undefined;
  if (path && maxBytes !== undefined) {
    const info = await stat(path);
    if (info.size > maxBytes)
      throw new XmlError(
        'ERR_XPATH_LIMIT',
        `Source has ${info.size} bytes, exceeding maxSourceBytes=${maxBytes}`,
      );
  }
  return (async function* () {
    // Attach iteration/error handling in the same turn that opens our stream.
    const source = path ? createReadStream(path, { highWaterMark: 65_536 }) : process.stdin;
    if (signal) addAbortSignal(signal, source);
    let bytes = 0;
    for await (const chunk of source) {
      if (maxBytes !== undefined) {
        bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
        if (bytes > maxBytes)
          throw new XmlError('ERR_XPATH_LIMIT', `Input exceeds maxSourceBytes=${maxBytes}`);
      }
      yield chunk;
    }
  })();
}

async function dispatch(
  mode: Mode,
  file: string | undefined,
  command: Command,
  signal: AbortSignal,
): Promise<number> {
  const options = command.optsWithGlobals<CliOptions>();
  if ((!file || file === '-') && process.stdin.isTTY) {
    command.outputHelp();
    return 0;
  }
  const selected =
    mode === 'auto' ? (options.output ? 'format' : process.stdout.isTTY ? 'view' : 'format') : mode;
  const format: FormatOptions = {
    indent: options.indent,
    whitespace: options.reindent ? 'reindent' : 'preserve',
    tempDirectory: options.tempDirectory,
    maxDepth: options.maxDepth,
    maxTokenCodeUnits: options.maxTokenCodeUnits,
    signal,
  };
  const open: OpenOptions = {
    tempDirectory: options.tempDirectory,
    maxDepth: options.maxDepth,
    maxTokenCodeUnits: options.maxTokenCodeUnits,
    maxIndexBytes: options.maxIndexBytes,
    signal,
  };
  const select: SelectOptions = {
    namespaces: options.namespace,
    maxSourceBytes: options.maxSourceBytes,
    maxOldGenerationSizeMb: options.xpathHeapMb,
    queryTimeoutMs: options.queryTimeoutMs,
    maxResults: options.maxResults,
    signal,
  };
  const inputPath = file && file !== '-' ? file : undefined;
  if (selected === 'view') {
    const terminal = TerminalSession.open();
    try {
      const source = await xmlSource(file, undefined, signal);
      terminal.enter({ mouse: options.mouse !== 'off' });
      // Ink/React must never load in format/extract mode or through the library entry.
      const { runView } = await import('../tui/run.js');
      const settings: ViewSettings = {
        source,
        sourceLabel: inputPath ?? 'stdin',
        inputPath,
        openOptions: open,
        selectOptions: select,
        formatOptions: { indent: format.indent, whitespace: format.whitespace },
        clipboard: options.clipboard ?? 'auto',
        terminal,
      };
      return await runView(settings);
    } finally {
      terminal.close();
    }
  }
  const source = await xmlSource(
    file,
    selected === 'extract' ? (options.maxSourceBytes ?? 67_108_864) : undefined,
    signal,
  );
  if (selected === 'format')
    await writeOutput(formatXml(source, format), { output: options.output, inputPath, signal });
  else {
    const document = await openXml(source, open);
    try {
      await writeOutput(
        document.extract(options.xpath!, {
          ...select,
          indent: format.indent,
          whitespace: format.whitespace,
        }),
        { output: options.output, inputPath, signal },
      );
    } finally {
      await document.close();
    }
  }
  return 0;
}

async function main(): Promise<number> {
  const controller = new AbortController();
  let interrupted = 0;
  const interrupt = () => {
    interrupted = 130;
    controller.abort(new DOMException('Interrupted', 'AbortError'));
  };
  const terminate = () => {
    interrupted = 143;
    controller.abort(new DOMException('Terminated', 'AbortError'));
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  const root = new Command()
    .name('xml-stream-format')
    .description('Strict disk-assisted XML formatter, XPath extractor and read-only browser')
    .version('0.1.0')
    .exitOverride();
  root.configureOutput({
    outputError: (message, write) => write(`[ERR_CLI_ARGUMENT] ${diagnostic(message.trimEnd())}\n`),
  });
  let status = 0;
  for (const mode of ['auto', 'format', 'view', 'extract'] as const) {
    const command = configure(mode === 'auto' ? root : root.command(mode), mode);
    command.action(async (file: string | undefined, _options: CliOptions, current: Command) => {
      status = await dispatch(mode, file, current, controller.signal);
    });
  }
  try {
    await root.parseAsync(process.argv);
    return interrupted || status;
  } catch (cause) {
    if (interrupted) return interrupted;
    if (cause instanceof CommanderError) return cause.exitCode === 0 ? 0 : 2;
    const code =
      cause instanceof Error && 'code' in cause && typeof cause.code === 'string'
        ? cause.code
        : 'ERR_XML_IO';
    if (code === 'EPIPE') return 0;
    const message = cause instanceof Error ? cause.message : String(cause);
    const underlying =
      cause instanceof Error && cause.cause !== undefined
        ? `; caused by ${String(cause.cause)}`
        : '';
    process.stderr.write(`[${code}] ${diagnostic(message + underlying)}\n`);
    if (code === 'ERR_CLI_ARGUMENT') return 2;
    return code === 'ERR_XPATH_QUERY' ||
      code === 'ERR_XPATH_RESULT_TYPE' ||
      code === 'ERR_XML_EXTRACT_NODE_TYPE'
      ? 3
      : 1;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    controller.abort();
  }
}

const status = await main();
// All CLI-owned cleanup has completed; an abandoned stdout pipe write must
// not keep an interrupted process alive while its reader remains open.
if (status === 130 || status === 143) process.exit(status);
process.exitCode = status;
