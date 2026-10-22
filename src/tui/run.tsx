import type { Instance } from 'ink';
import { render } from 'ink';
import { clipboardByteLimit, copyText } from '../cli/clipboard.js';
import { writeOutput } from '../cli/output.js';
import type { ViewSettings } from '../cli/types.js';
import type { DocumentHandle } from '../document/document.js';
import { openBrowserXml } from '../document/document.js';
import type { Progress } from '../document/protocol.js';
import type { CopyChoice, CopySelection } from './App.js';
import { App } from './App.js';

export async function runView(settings: ViewSettings): Promise<number> {
  const controller = new AbortController();
  const signal = settings.openOptions.signal
    ? AbortSignal.any([settings.openOptions.signal, controller.signal])
    : controller.signal;
  let document: DocumentHandle | undefined;
  let loading: Promise<DocumentHandle> | undefined;
  let instance: Instance | undefined;
  const pendingExports = new Set<Promise<void>>();
  const pendingCopies = new Set<Promise<string>>();
  const trackCopy = (pending: Promise<string>): Promise<string> => {
    pendingCopies.add(pending);
    const settled = (): void => {
      pendingCopies.delete(pending);
    };
    void pending.then(settled, settled);
    return pending;
  };
  const copySelection = (selection: CopySelection, choice: CopyChoice): Promise<string> =>
    trackCopy(
      (async () => {
        signal.throwIfAborted();
        if (!document)
          throw new Error('No XML document is available for copying. Nothing was copied.');
        const { elementId, match } = selection;
        let source: string;
        if (choice === 'xml') {
          if (match && match.ref.kind !== 'element') {
            return match.ref.kind === 'document'
              ? 'Document/root XML copy is unsupported. Select a non-root element. Nothing was copied.'
              : 'Formatted XML copy requires an element selection; it does not copy the owner of an attribute, text, comment or processing instruction. Nothing was copied.';
          }
          const maxBytes = clipboardByteLimit(settings.clipboard);
          source = await document.session.copyElement(elementId, {
            ...settings.formatOptions,
            whitespace: 'reindent',
            maxBytes,
            signal,
          });
        } else if (choice === 'value') {
          if (!match || (match.ref.kind !== 'attribute' && match.ref.kind !== 'text'))
            throw new Error(
              'Select an XPath attribute or text result before copying a value. Nothing was copied.',
            );
          source = await document.readValue(
            match,
            { ...settings.selectOptions, signal },
            clipboardByteLimit(settings.clipboard),
          );
        } else if (choice === 'xpath' && match) source = match.xpath;
        else {
          source = await document.session.request('nodePath', {
            ref:
              match?.ref ??
              (elementId === 0 ? { kind: 'document', id: 0 } : { kind: 'element', elementId }),
            kind: choice,
          });
        }
        return copyText(source, {
          mode: settings.clipboard,
          output: settings.terminal.output,
          signal,
        });
      })(),
    );
  const exportXml = (chunks: AsyncIterable<string>, path: string): Promise<void> => {
    const pending = writeOutput(chunks, { output: path, inputPath: settings.inputPath, signal });
    pendingExports.add(pending);
    const settled = (): void => {
      pendingExports.delete(pending);
    };
    void pending.then(settled, settled);
    return pending;
  };
  const load = (onProgress: (progress: Progress) => void): Promise<DocumentHandle> => {
    loading ??= openBrowserXml(
      settings.source,
      { ...settings.openOptions, signal },
      { preview: true, onProgress },
    ).then((value) => {
      document = value;
      return value;
    });
    return loading;
  };
  const externalAbort = () => instance?.unmount();
  settings.openOptions.signal?.addEventListener('abort', externalAbort, { once: true });
  try {
    signal.throwIfAborted();
    instance = render(
      <App settings={settings} load={load} exportXml={exportXml} copySelection={copySelection} />,
      {
        stdin: settings.terminal.input,
        stdout: settings.terminal.output,
        stderr: settings.terminal.output,
        alternateScreen: true,
        incrementalRendering: true,
        maxFps: 30,
        patchConsole: false,
        exitOnCtrlC: false,
        interactive: true,
      },
    );
    const result: unknown = await instance.waitUntilExit();
    return typeof result === 'number' ? result : 0;
  } finally {
    instance?.unmount();
    settings.openOptions.signal?.removeEventListener('abort', externalAbort);
    controller.abort();
    // Effects cannot await; settle aborted readers and clipboard/output writes before explicit workspace release.
    try {
      if (loading) await loading.catch(() => {});
      await Promise.allSettled([...pendingExports, ...pendingCopies]);
      await document?.close();
    } finally {
      instance?.cleanup();
    }
  }
}
