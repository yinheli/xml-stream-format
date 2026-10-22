import type { Key } from 'ink';
import { Box, Text, useApp, useInput, usePaste, useWindowSize } from 'ink';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import stringWidth from 'string-width';
import type { TerminalMouseEvent } from '../cli/mouse.js';
import type { ViewSettings } from '../cli/types.js';
import type { DocumentHandle } from '../document/document.js';
import type { Progress } from '../document/protocol.js';
import type {
  FuzzyMatch,
  Overview,
  XmlNodeMatch,
  XmlNodeRef,
  XmlPage,
  XmlRequest,
  XmlRow,
} from '../document/types.js';
import { extractMatches } from '../xpath/extract.js';
import {
  fitText,
  highlightXml,
  nextGrapheme,
  previousGrapheme,
  sliceColumns,
  visibleText,
} from './text.js';

export interface CopySelection {
  elementId: number;
  match?: XmlNodeMatch;
}
export type CopyChoice = 'path' | 'xpath' | 'xml' | 'value';
interface AppProps {
  settings: ViewSettings;
  load(onProgress: (progress: Progress) => void): Promise<DocumentHandle>;
  exportXml(chunks: AsyncIterable<string>, path: string): Promise<void>;
  copySelection(selection: CopySelection, choice: CopyChoice): Promise<string>;
}
type Results =
  | { kind: 'fuzzy'; query: string; items: readonly FuzzyMatch[] }
  | { kind: 'xpath'; query: string; items: readonly XmlNodeMatch[] };
interface Editor {
  kind: 'fuzzy' | 'xpath' | 'export';
  value: string;
  cursor: number;
}
type NavigationMove = 'first' | 'last' | 'pageUp' | 'pageDown' | 'halfUp' | 'halfDown';
interface Viewport {
  height: number;
  width: number;
}
interface MouseLayout extends Viewport {
  page: XmlPage;
  generation: number;
  columns: number;
  rows: number;
  top: number;
}
interface XmlSpan {
  text: string;
  color: string | undefined;
  muted: boolean;
}

/** Input events may share a React batch; their next action must see prior edits immediately. */
function useInputState<T>(initial: T): readonly [T, Dispatch<SetStateAction<T>>, RefObject<T>] {
  const [value, renderValue] = useState(initial);
  const current = useRef(initial);
  const update = useCallback((next: SetStateAction<T>): void => {
    let resolved: T;
    if (typeof next === 'function') {
      const updater = next as (previous: T) => T;
      resolved = updater(current.current);
    } else resolved = next;
    current.current = resolved;
    renderValue(resolved);
  }, []);
  return [value, update, current];
}

function targetId(ref: XmlNodeRef): number {
  switch (ref.kind) {
    case 'element':
      return ref.elementId;
    case 'attribute':
      return ref.ownerElementId;
    case 'text':
      return ref.parentElementId || 1;
    case 'comment':
    case 'processing-instruction':
      return ref.parentId || 1;
    case 'document':
      return 1;
  }
}
function resultTarget(results: Results, index: number): number {
  return results.kind === 'fuzzy'
    ? results.items[index]!.elementId
    : targetId(results.items[index]!.ref);
}

const XmlLine = memo(function XmlLine({
  row,
  selected,
  width,
}: {
  row: XmlRow;
  selected: boolean;
  width: number;
}) {
  const spans: XmlSpan[] = [];
  let cell = 0;
  let hitIndex = 0;
  for (const span of highlightXml(row.text, row.state)) {
    const start = cell;
    const end = start + stringWidth(span.text);
    if (start === end) spans.push({ text: span.text, color: span.color, muted: false });
    while (cell < end) {
      while (row.hits[hitIndex] && row.hits[hitIndex]!.to <= cell) hitIndex++;
      const hit = row.hits[hitIndex];
      const muted = !hit || hit.from > cell;
      const until = Math.min(end, muted ? (hit?.from ?? end) : hit!.to);
      spans.push({
        text: sliceColumns(span.text, cell - start, until - cell),
        color: muted ? 'gray' : span.color,
        muted,
      });
      cell = until;
    }
  }
  const warning = row.truncatedGrapheme ? ' [oversized grapheme omitted]' : '';
  const padding = Math.max(0, width - 2 - stringWidth(row.text) - stringWidth(warning));
  // The selected row drops syntax colors: bold black on bright cyan stays legible
  // and unmistakable on every palette, including light "white" theme accents.
  return (
    <Text
      wrap="truncate-end"
      backgroundColor={selected ? 'cyan' : undefined}
      color={selected ? 'black' : undefined}
    >
      <Text
        bold={selected || undefined}
        color={selected ? 'black' : row.incomplete ? 'yellow' : 'gray'}
      >
        {row.foldElementId !== undefined ? (row.expanded ? '▾ ' : '▸ ') : '  '}
      </Text>
      {spans.map((span, index) => (
        <Text
          /* biome-ignore lint/suspicious/noArrayIndexKey: spans are positional segments of one row and always re-render together */
          key={index}
          bold={selected || undefined}
          color={selected ? 'black' : span.color}
          dimColor={selected ? undefined : span.muted}
        >
          {span.text}
        </Text>
      ))}
      {warning ? (
        <Text bold={selected || undefined} color={selected ? 'black' : 'yellow'}>
          {warning}
        </Text>
      ) : null}
      {padding ? ' '.repeat(padding) : undefined}
    </Text>
  );
});

const HELP = [
  'XML: ↑/↓ j/k visible rows; ←/h fold/parent',
  '→/l expand/child; Space toggle; [/] siblings',
  'gg/Home first; G/End loaded last (not EOF)',
  'PgUp/PgDn or Ctrl+B/F pages; Ctrl+U/D halves',
  'Shift+←/→ horizontal: view full attributes/text',
  '0 collapse all; 1..9 expansion depth presets',
  'Mouse: text selects owner; gutter folds',
  'Wheel scrolls; --mouse off for native selection',
  'Shift-drag bypass depends on your terminal',
  '/ fuzzy names (best 200); : full XPath 3.1',
  'Enter reveals result; n/N next/previous hit',
  'Tab results/XML; Esc cancels or clears results',
  'y copy: path, XPath, bounded non-root XML/value',
  'e export to NEW file (loads/validates all XML)',
  'o statistics; ? help; q quit',
  'Ctrl+C cancels query first, else exits (130)',
  'Paused browsing never loads the entire source',
  'No hover popups. Source is never modified.',
];

export function App({ settings, load, exportXml, copySelection }: AppProps) {
  const { exit } = useApp();
  const { columns: measuredColumns, rows: measuredRows } = useWindowSize();
  const columns = measuredColumns || 80;
  const rows = measuredRows || 24;
  const contentHeight = Math.min(256, Math.max(1, rows - 6));
  const xmlColumns = Math.max(1, columns - 2);
  const [document, setDocument, documentRef] = useInputState<DocumentHandle | undefined>(undefined);
  const [progress, setProgress] = useState<Progress>({ stage: 'input', sourceBytes: 0, nodes: 0 });
  const [loadError, setLoadError] = useState('');
  const [page, setPage, pageRef] = useInputState<XmlPage | undefined>(undefined);
  const [column, setColumn, columnRef] = useInputState(0);
  const [focus, setFocus, focusRef] = useInputState<'xml' | 'results'>('xml');
  const [overview, setOverview] = useState<Overview>();
  const [showOverview, setShowOverview, showOverviewRef] = useInputState(false);
  const [help, setHelp, helpRef] = useInputState(false);
  const [editor, setEditor, editorRef] = useInputState<Editor | null>(null);
  const [results, setResults, resultsRef] = useInputState<Results | null>(null);
  const [resultIndex, setResultIndex, resultIndexRef] = useInputState(0);
  const [revealedMatch, setRevealedMatch, revealedMatchRef] = useInputState<
    XmlNodeMatch | undefined
  >(undefined);
  const [querying, setQuerying, queryingRef] = useInputState(false);
  const [notice, setNotice] = useState('');
  const [copyMenu, setCopyMenu, copyMenuRef] = useInputState<number | null>(null);
  const viewport = useRef<Viewport>({ height: contentHeight, width: xmlColumns });
  viewport.current = { height: contentHeight, width: xmlColumns };
  const previousViewport = useRef(viewport.current);
  const pageViewport = useRef<Viewport | undefined>(undefined);
  const navigationGeneration = useRef(0);
  const pageGeneration = useRef(-1);
  const xmlPending = useRef(0);
  const inputRevision = useRef(0);
  const searchGeneration = useRef(0);
  const overviewGeneration = useRef(0);
  const overviewPending = useRef(false);
  const queryController = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const quitting = useRef(false);
  const pendingG = useRef<{ focus: 'xml' | 'results'; results: Results | null } | null>(null);
  const wheelSteps = useRef(0);
  const mouseLayout = useRef<MouseLayout | undefined>(undefined);
  const mouseHandler = useRef<(event: TerminalMouseEvent) => void>(() => {});

  const describeError = (error: unknown): string => {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'ERR_XML_IO';
    return `[${code}] ${error instanceof Error ? error.message : String(error)}`;
  };
  const action = (operation: () => Promise<unknown>): void => {
    void operation().catch((error) => {
      if (mounted.current) setNotice(describeError(error));
    });
  };
  const xmlVisible = (): boolean =>
    !editorRef.current &&
    !helpRef.current &&
    copyMenuRef.current === null &&
    !showOverviewRef.current &&
    !queryingRef.current &&
    focusRef.current === 'xml';

  function invalidateOverview(): void {
    overviewGeneration.current++;
    overviewPending.current = false;
    setShowOverview(false);
  }

  async function toggleOverview(): Promise<void> {
    if (showOverviewRef.current || overviewPending.current) {
      invalidateOverview();
      return;
    }
    const opened = documentRef.current;
    if (!opened) return;
    const generation = ++overviewGeneration.current;
    overviewPending.current = true;
    try {
      const value = await opened.session.request('overview', {});
      if (!mounted.current || generation !== overviewGeneration.current || !overviewPending.current)
        return;
      setOverview(value);
      mouseLayout.current = undefined;
      setShowOverview(true);
    } catch (error) {
      if (mounted.current && generation === overviewGeneration.current)
        setNotice(describeError(error));
    } finally {
      if (generation === overviewGeneration.current) overviewPending.current = false;
    }
  }

  function rejectPendingSelection(operation: 'copy' | 'export'): boolean {
    if (!xmlPending.current) return false;
    setNotice(
      `XML selection is still updating. Retry ${operation} after navigation finishes. Nothing was ${operation === 'copy' ? 'copied' : 'exported'}.`,
    );
    return true;
  }

  /** Inertial wheel bursts collapse into one scroll: the newest delta survives a pending refresh. */
  function scrollWheel(steps: number): void {
    wheelSteps.current = Math.max(-4000, Math.min(4000, wheelSteps.current + steps));
    if (xmlPending.current) return;
    const flush = wheelSteps.current;
    wheelSteps.current = 0;
    action(() => refreshXml({ scroll: flush, loadMore: true }));
  }

  async function refreshXml(
    request: XmlRequest = {},
    prepare?: () => Promise<unknown>,
    passive = false,
  ): Promise<XmlPage | undefined> {
    const opened = documentRef.current;
    if (!opened || (passive && (xmlPending.current || !xmlVisible()))) return;
    if (!passive && overviewPending.current) invalidateOverview();
    const generation = passive ? navigationGeneration.current : ++navigationGeneration.current;
    const revision = inputRevision.current;
    const dimensions = viewport.current;
    xmlPending.current++;
    try {
      // Submit both commands now: the session, not React, orders navigation and continuations.
      const preparation = prepare?.();
      const response = opened.session.request('xmlRows', {
        limit: dimensions.height,
        columns: dimensions.width,
        column: columnRef.current,
        ...request,
      });
      const [, next] = await Promise.all([preparation, response]);
      if (
        !mounted.current ||
        generation !== navigationGeneration.current ||
        (passive && (revision !== inputRevision.current || !xmlVisible()))
      )
        return;
      pageGeneration.current = generation;
      pageViewport.current = dimensions;
      setPage(next);
      setColumn(next.column);
      return next;
    } finally {
      xmlPending.current--;
      // A burst that arrived mid-refresh still applies, once, after the current page commits.
      if (!xmlPending.current && wheelSteps.current && mounted.current) {
        const flush = wheelSteps.current;
        wheelSteps.current = 0;
        if (xmlVisible()) action(() => refreshXml({ scroll: flush, loadMore: true }));
      }
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: action/describeError are render-stable helpers; only load may re-arm this mount effect
  useEffect(() => {
    mounted.current = true;
    // Input pieces report progress one by one; rendering the full frame per piece
    // starves input handling. Stage transitions always pass (they drive the fill
    // chain), byte counts coalesce to roughly ten updates per second.
    let lastRender = 0;
    let lastStage: Progress['stage'] | undefined;
    void load((value) => {
      if (!mounted.current) return;
      const now = Date.now();
      if (value.stage === lastStage && !value.diagnostic && now - lastRender < 100) return;
      lastRender = now;
      lastStage = value.stage;
      setProgress(value);
      if (value.diagnostic) setNotice(`[runtime] ${value.diagnostic}`);
    })
      .then(async (opened) => {
        if (!mounted.current) return;
        setDocument(opened);
        void opened.session.ready.then(
          () => {
            if (mounted.current)
              setProgress((current) => ({
                ...current,
                stage: 'ready',
                sourceBytes: opened.session.sourceBytes,
              }));
          },
          (error) => {
            if (mounted.current) {
              setLoadError(describeError(error));
              setNotice(`Validation failed; loaded prefix is read-only. ${describeError(error)}`);
            }
          },
        );
        await refreshXml({ loadMore: true });
      })
      .catch((error) => {
        if (mounted.current) setLoadError(describeError(error));
      });
    return () => {
      mounted.current = false;
      navigationGeneration.current++;
      searchGeneration.current++;
      overviewGeneration.current++;
      overviewPending.current = false;
      mouseLayout.current = undefined;
      queryController.current?.abort();
    };
  }, [load]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: action/refreshXml are render-stable; re-run only when the viewport or document changes
  useEffect(() => {
    const before = previousViewport.current;
    previousViewport.current = viewport.current;
    if (document && (before.height !== contentHeight || before.width !== xmlColumns))
      action(() => refreshXml({ loadMore: true }));
  }, [document, contentHeight, xmlColumns]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: action/refreshXml are render-stable; re-run only when progress advances the document
  useEffect(() => {
    if (!document) return;
    const page = pageRef.current;
    // An under-filled page keeps its read demand alive: refill while progress advances
    // and the frontier is readable. Blocked frontiers report needsMore=false and never scan.
    const fill = !!page && page.needsMore && page.continuation === undefined;
    action(() => refreshXml({ loadMore: fill }, undefined, true));
  }, [document, progress.nodes, progress.sourceBytes, progress.stage]);

  function invalidateSearch(): void {
    searchGeneration.current++;
    queryController.current?.abort();
    queryController.current = null;
    setQuerying(false);
  }

  async function reveal(
    set: Results,
    index: number,
    generation = searchGeneration.current,
  ): Promise<void> {
    if (
      !document ||
      generation !== searchGeneration.current ||
      !set.items.length ||
      resultsRef.current !== set ||
      resultIndexRef.current !== index
    )
      return;
    const elementId = resultTarget(set, index);
    setColumn(0);
    const next = await refreshXml({ selectedId: elementId, column: 0, loadMore: true }, () =>
      document.session.request('reveal', { elementId }),
    );
    if (
      !next ||
      !mounted.current ||
      generation !== searchGeneration.current ||
      resultsRef.current !== set ||
      resultIndexRef.current !== index
    )
      return;
    setRevealedMatch(set.kind === 'xpath' ? set.items[index] : undefined);
    invalidateOverview();
    setFocus('xml');
  }

  async function fuzzy(value: string, commit = false): Promise<void> {
    if (!document) return;
    const generation = ++searchGeneration.current;
    queryController.current?.abort();
    queryController.current = null;
    setQuerying(false);
    const items = await document.session.request('fuzzy', { query: value });
    if (!mounted.current || generation !== searchGeneration.current) return;
    const set: Results = { kind: 'fuzzy', query: value, items };
    setResults(set);
    setResultIndex(0);
    invalidateOverview();
    setFocus('results');
    setNotice(
      `Showing at most 200 best QName/local-name matches${document.session.complete ? '' : ' in the loaded prefix'}`,
    );
    if (commit && items.length) await reveal(set, 0, generation);
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: action/fuzzy are render-stable; debounce only on editor input changes
  useEffect(() => {
    if (editor?.kind !== 'fuzzy' || !document) return;
    const timer = setTimeout(() => action(() => fuzzy(editor.value)), 100);
    return () => clearTimeout(timer);
  }, [editor?.kind, editor?.value, document]);

  async function xpath(expression: string): Promise<void> {
    if (!document) return;
    const generation = ++searchGeneration.current;
    queryController.current?.abort();
    const controller = new AbortController();
    queryController.current = controller;
    setQuerying(true);
    setNotice(
      document.session.complete
        ? 'Evaluating XPath 3.1…'
        : 'Loading and validating full XML before XPath 3.1… Ctrl+C cancels query',
    );
    try {
      const items = await document.select(expression, {
        ...settings.selectOptions,
        signal: controller.signal,
      });
      if (
        !mounted.current ||
        generation !== searchGeneration.current ||
        queryController.current !== controller
      )
        return;
      const set: Results = { kind: 'xpath', query: expression, items };
      setResults(set);
      setResultIndex(0);
      invalidateOverview();
      setFocus('results');
      setNotice(`${items.length} XPath node match${items.length === 1 ? '' : 'es'}`);
      if (items.length) await reveal(set, 0, generation);
    } catch (error) {
      if (
        mounted.current &&
        generation === searchGeneration.current &&
        queryController.current === controller
      )
        setNotice(
          controller.signal.aborted
            ? 'Query cancelled; document remains available'
            : describeError(error),
        );
    } finally {
      if (queryController.current === controller) {
        queryController.current = null;
        setQuerying(false);
      }
    }
  }

  function selection(): CopySelection {
    const set = resultsRef.current;
    const index = resultIndexRef.current;
    if (focusRef.current === 'results' && set?.items.length)
      return {
        elementId: resultTarget(set, index),
        ...(set.kind === 'xpath' ? { match: set.items[index] } : {}),
      };
    const elementId = pageRef.current?.selectedId ?? 1;
    const match = revealedMatchRef.current;
    return { elementId, ...(match && targetId(match.ref) === elementId ? { match } : {}) };
  }
  const currentMatch =
    focus === 'results' && results?.kind === 'xpath'
      ? results.items[resultIndex]
      : revealedMatch && targetId(revealedMatch.ref) === page?.selectedId
        ? revealedMatch
        : undefined;
  const selectedId =
    focus === 'results' && results?.items.length
      ? resultTarget(results, resultIndex)
      : (page?.selectedId ?? 1);
  const hasValue = currentMatch?.ref.kind === 'attribute' || currentMatch?.ref.kind === 'text';
  const subtreeRestriction =
    currentMatch && currentMatch.ref.kind !== 'element' && currentMatch.ref.kind !== 'document'
      ? 'element selection required'
      : selectedId <= 1
        ? 'root unsupported'
        : 'non-root only';
  const copyChoices: readonly { choice: CopyChoice; label: string }[] = [
    { choice: 'path', label: 'Readable path' },
    { choice: 'xpath', label: 'Executable XPath' },
    { choice: 'xml', label: `Formatted XML: selected node + descendants (${subtreeRestriction})` },
    ...(hasValue ? [{ choice: 'value' as const, label: 'Attribute / logical text value' }] : []),
  ];

  async function copy(index: number): Promise<void> {
    const choice = copyChoices[index]?.choice;
    if (rejectPendingSelection('copy')) return;
    if (!choice) return;
    const selected = selection();
    setCopyMenu(null);
    setNotice('Copying…');
    const status = await copySelection(selected, choice);
    if (mounted.current) setNotice(status);
  }

  async function exportFile(path: string): Promise<void> {
    if (!document) return;
    if (rejectPendingSelection('export')) return;
    setNotice(
      document.session.complete
        ? 'Exporting to a new file…'
        : 'Loading and validating full XML before export; no partial XML will be written…',
    );
    const set = resultsRef.current;
    const chunks =
      set?.kind === 'xpath'
        ? extractMatches(document.session, set.items, settings.formatOptions)
        : set?.kind === 'fuzzy'
          ? document.session.extractElements(
              set.items.map((item) => item.elementId),
              settings.formatOptions,
            )
          : pageRef.current?.selectedId === 0
            ? document.session.extractDocument(settings.formatOptions)
            : document.session.extractElements(
                [pageRef.current?.selectedId ?? 1],
                settings.formatOptions,
              );
    await exportXml(chunks, path);
    if (mounted.current) setNotice(`Exported ${set ? set.items.length : 1} fragment(s) to ${path}`);
  }

  function handleMouse(event: TerminalMouseEvent): void {
    const layout = mouseLayout.current;
    if (
      !layout ||
      quitting.current ||
      !xmlVisible() ||
      columns < 40 ||
      rows < 10 ||
      (settings.terminal.output.columns && settings.terminal.output.columns !== columns) ||
      (settings.terminal.output.rows && settings.terminal.output.rows !== rows) ||
      event.shift ||
      event.alt ||
      event.ctrl
    )
      return;
    // Wheel events accumulate while a refresh runs; they never depend on row geometry.
    if (event.action === 'wheel') {
      if (event.button !== 64 && event.button !== 65) return;
      pendingG.current = null;
      inputRevision.current++;
      scrollWheel(event.button === 64 ? -3 : 3);
      return;
    }
    if (
      xmlPending.current ||
      layout.page !== pageRef.current ||
      layout.generation !== navigationGeneration.current ||
      layout.columns !== columns ||
      layout.rows !== rows ||
      event.x < 1 ||
      event.x > layout.columns ||
      event.y < layout.top ||
      event.y >= layout.top + layout.height
    )
      return;
    const row = layout.page.rows[event.y - layout.top];
    if (!row) return;
    if (event.x <= 2) {
      if (!row.foldable || row.foldElementId === undefined) return;
      pendingG.current = null;
      inputRevision.current++;
      setRevealedMatch(undefined);
      action(() =>
        refreshXml({
          selectKey: row.key,
          selectedId: row.foldElementId,
          move: 'toggle',
          loadMore: true,
        }),
      );
    } else {
      const column = event.x - 3;
      const hit = row.hits.find((candidate) => column >= candidate.from && column < candidate.to);
      if (!hit) return;
      pendingG.current = null;
      inputRevision.current++;
      setRevealedMatch(undefined);
      action(() => refreshXml({ selectKey: row.key, selectedId: hit.elementId, loadMore: false }));
    }
  }

  useLayoutEffect(() => {
    mouseHandler.current = handleMouse;
    // Publish only committed XML geometry: immediate mode refs alone cannot distinguish a closing modal.
    mouseLayout.current =
      !editor &&
      !help &&
      copyMenu === null &&
      !showOverview &&
      !querying &&
      focus === 'xml' &&
      columns >= 40 &&
      rows >= 10 &&
      page &&
      pageViewport.current?.width === xmlColumns &&
      pageViewport.current.height === contentHeight
        ? {
            page,
            generation: pageGeneration.current,
            columns,
            rows,
            top: 4,
            height: contentHeight,
            width: xmlColumns,
          }
        : undefined;
    return () => {
      mouseLayout.current = undefined;
    };
  });
  useEffect(
    () => settings.terminal.onMouse((event) => mouseHandler.current(event)),
    [settings.terminal],
  );

  const editInsertion = (value: string): void =>
    setEditor((current) =>
      current
        ? {
            ...current,
            value:
              current.value.slice(0, current.cursor) + value + current.value.slice(current.cursor),
            cursor: current.cursor + value.length,
          }
        : current,
    );
  usePaste((value) => {
    pendingG.current = null;
    inputRevision.current++;
    editInsertion(value);
  });

  function handleInput(input: string, key: Key): void {
    if (quitting.current || key.eventType === 'release') return;
    inputRevision.current++;
    const code = input.length === 1 ? input.charCodeAt(0) : 0;
    if (code >= 1 && code <= 26 && code !== 8 && code !== 9 && code !== 10 && code !== 13) {
      input = String.fromCharCode(96 + code);
      key = { ...key, ctrl: true };
    }
    const firstCharacterUnits = (input.codePointAt(0) ?? 0) > 0xffff ? 2 : 1;
    if (
      input.length > firstCharacterUnits &&
      (editorRef.current === null || /[\x01-\x1a\x7f]/.test(input))
    ) {
      for (const character of input)
        handleInput(character, {
          ...key,
          return: character === '\r' || character === '\n',
          backspace: character === '\x08' || character === '\x7f',
          delete: false,
          tab: character === '\t',
          escape: character === '\x1b',
        });
      return;
    }
    const editor = editorRef.current;
    const copyMenu = copyMenuRef.current;
    const resultIndex = resultIndexRef.current;
    const results = resultsRef.current;
    const focus = focusRef.current;
    const help = helpRef.current;
    const doubleG =
      pendingG.current?.focus === focus &&
      pendingG.current.results === results &&
      input === 'g' &&
      !key.ctrl &&
      !key.meta;
    pendingG.current = null;
    if (key.ctrl && input === 'c') {
      if (queryController.current) queryController.current.abort();
      else {
        quitting.current = true;
        exit(130);
      }
      return;
    }
    if (editor) {
      if (key.escape) {
        invalidateOverview();
        invalidateSearch();
        if (editor.kind === 'fuzzy') {
          setResults(null);
          setFocus('xml');
        }
        setEditor(null);
        return;
      }
      if (key.return) {
        const submitted = editor;
        setEditor(null);
        if (submitted.kind === 'fuzzy') action(() => fuzzy(submitted.value, true));
        else if (submitted.kind === 'xpath') action(() => xpath(submitted.value));
        else if (submitted.value) action(() => exportFile(submitted.value));
        return;
      }
      if (key.leftArrow)
        setEditor({ ...editor, cursor: previousGrapheme(editor.value, editor.cursor) });
      else if (key.rightArrow)
        setEditor({ ...editor, cursor: nextGrapheme(editor.value, editor.cursor) });
      else if (key.home || (key.ctrl && input === 'a')) setEditor({ ...editor, cursor: 0 });
      else if (key.end || (key.ctrl && input === 'e'))
        setEditor({ ...editor, cursor: editor.value.length });
      else if (key.backspace || key.delete) {
        const start = previousGrapheme(editor.value, editor.cursor);
        setEditor({
          ...editor,
          value: editor.value.slice(0, start) + editor.value.slice(editor.cursor),
          cursor: start,
        });
      } else if (!key.ctrl && !key.meta && input) editInsertion(input);
      return;
    }
    if (input === 'q') {
      quitting.current = true;
      exit(loadError ? 1 : 0);
      return;
    }
    if (key.escape) {
      invalidateOverview();
      invalidateSearch();
      setHelp(false);
      setCopyMenu(null);
      setResults(null);
      setRevealedMatch(undefined);
      setFocus('xml');
      setNotice('Returned to XML');
      return;
    }
    if (input === '?') {
      invalidateOverview();
      mouseLayout.current = undefined;
      setHelp(!help);
      return;
    }
    if (help || !document) return;
    if (copyMenu !== null) {
      if (key.upArrow || input === 'k')
        setCopyMenu((copyMenu + copyChoices.length - 1) % copyChoices.length);
      else if (key.downArrow || input === 'j') setCopyMenu((copyMenu + 1) % copyChoices.length);
      else if (key.return) action(() => copy(copyMenu));
      return;
    }
    let navigation: NavigationMove | undefined;
    if (input === 'g' && !key.ctrl && !key.meta) {
      if (overviewPending.current) invalidateOverview();
      if (!doubleG) {
        pendingG.current = { focus, results };
        return;
      }
      navigation = 'first';
    } else if (input === 'G' && !key.ctrl && !key.meta) navigation = 'last';
    else if (key.ctrl && !key.meta) {
      if (input === 'f') navigation = 'pageDown';
      else if (input === 'b') navigation = 'pageUp';
      else if (input === 'd') navigation = 'halfDown';
      else if (input === 'u') navigation = 'halfUp';
    } else if (key.home) navigation = 'first';
    else if (key.end) navigation = 'last';
    else if (key.pageDown) navigation = 'pageDown';
    else if (key.pageUp) navigation = 'pageUp';
    if (key.tab) {
      if (results || overviewPending.current) invalidateOverview();
      if (results) {
        mouseLayout.current = undefined;
        setFocus(focus === 'xml' ? 'results' : 'xml');
      }
      return;
    }
    if (input === '/' || input === ':') {
      invalidateOverview();
      invalidateSearch();
      mouseLayout.current = undefined;
      setEditor({ kind: input === '/' ? 'fuzzy' : 'xpath', value: '', cursor: 0 });
      setNotice('');
      return;
    }
    if (input === 'y') {
      invalidateOverview();
      if (rejectPendingSelection('copy')) return;
      if (focus === 'results' && results && !results.items.length)
        setNotice('Zero results; Tab or Esc returns to XML before copying');
      else {
        mouseLayout.current = undefined;
        setCopyMenu(0);
      }
      return;
    }
    if (input === 'e') {
      invalidateOverview();
      if (rejectPendingSelection('export')) return;
      mouseLayout.current = undefined;
      setEditor({ kind: 'export', value: '', cursor: 0 });
      return;
    }
    if (input === 'o') {
      action(toggleOverview);
      return;
    }
    if ((input === 'n' || input === 'N') && results?.items.length) {
      const index =
        (resultIndex + (input === 'n' ? 1 : -1) + results.items.length) % results.items.length;
      setResultIndex(index);
      action(() => reveal(results, index));
      return;
    }
    if (showOverviewRef.current || queryingRef.current) return;
    if (focus === 'results' && results) {
      if (
        key.return ||
        key.upArrow ||
        input === 'k' ||
        key.downArrow ||
        input === 'j' ||
        navigation
      )
        invalidateOverview();
      const length = results.items.length;
      if (!length) return;
      if (key.return) action(() => reveal(results, resultIndex));
      else if (key.upArrow || input === 'k') setResultIndex(Math.max(0, resultIndex - 1));
      else if (key.downArrow || input === 'j')
        setResultIndex(Math.min(length - 1, resultIndex + 1));
      else if (navigation === 'first') setResultIndex(0);
      else if (navigation === 'last') setResultIndex(length - 1);
      else if (navigation) {
        const distance =
          navigation === 'halfDown' || navigation === 'halfUp'
            ? Math.max(1, Math.floor(contentHeight / 2))
            : contentHeight;
        setResultIndex(
          Math.max(
            0,
            Math.min(
              length - 1,
              resultIndex +
                (navigation === 'pageUp' || navigation === 'halfUp' ? -distance : distance),
            ),
          ),
        );
      }
      return;
    }
    if (key.shift && (key.leftArrow || key.rightArrow)) {
      const next = Math.max(0, columnRef.current + (key.leftArrow ? -8 : 8));
      setColumn(next);
      action(() => refreshXml({ column: next, loadMore: true }));
      return;
    }
    setRevealedMatch(undefined);
    if (input === ' ') action(() => refreshXml({ move: 'toggle', loadMore: true }));
    else if (/^[0-9]$/.test(input))
      action(() =>
        refreshXml({ loadMore: true }, () =>
          document.session.request('expand', { depth: Number(input) }),
        ),
      );
    else if (key.leftArrow || input === 'h')
      action(() => refreshXml({ move: 'left', loadMore: true }));
    else if (key.rightArrow || input === 'l')
      action(() => refreshXml({ move: 'right', loadMore: true }));
    else if (navigation) {
      if (navigation === 'first') setColumn(0);
      action(() =>
        refreshXml({
          move:
            navigation === 'halfDown'
              ? 'pageDown'
              : navigation === 'halfUp'
                ? 'pageUp'
                : navigation,
          loadMore: navigation !== 'first' && navigation !== 'last',
          ...(navigation === 'first' ? { column: 0 } : {}),
          ...(navigation === 'halfDown' || navigation === 'halfUp'
            ? { steps: Math.max(1, Math.floor(contentHeight / 2)) }
            : {}),
        }),
      );
    } else {
      const move =
        key.upArrow || input === 'k'
          ? 'previous'
          : key.downArrow || input === 'j'
            ? 'next'
            : input === '['
              ? 'previousSibling'
              : input === ']'
                ? 'nextSibling'
                : undefined;
      if (move) action(() => refreshXml({ move, loadMore: true }));
    }
  }
  useInput(handleInput);

  if (columns < 40 || rows < 10)
    return (
      <Box width={columns} height={rows} flexDirection="column">
        <Text color="yellow">{fitText('Enlarge terminal to at least 40×10', columns)}</Text>
        <Text>q quit · Ctrl+C exit</Text>
      </Box>
    );
  const complete = document?.session.complete ?? false;
  // Any unfinished demand (under-filled viewport or a movement still chasing) reads
  // as loading; the momentary pause between refill rounds must not flicker the status.
  const pendingDemand =
    !!document && !complete && (page?.needsMore === true || page?.continuation !== undefined);
  const paused =
    !!document &&
    !complete &&
    !pendingDemand &&
    (document.session.paused || progress.stage === 'paused');
  const state = loadError
    ? 'error'
    : querying
      ? 'querying'
      : !document
        ? 'loading'
        : !complete
          ? pendingDemand
            ? 'loading'
            : paused
              ? 'paused'
              : 'loading'
          : focus === 'results' && results && !results.items.length
            ? 'empty-results'
            : 'ready';
  const resultStart = Math.max(0, resultIndex - contentHeight + 1);
  const copyStart = copyMenu === null ? 0 : Math.max(0, copyMenu - contentHeight + 1);
  const inputPrefix =
    editor?.kind === 'fuzzy' ? '/' : editor?.kind === 'xpath' ? ':' : 'Export new path: ';
  const beforeCursor = editor ? visibleText(editor.value.slice(0, editor.cursor)) : '';
  const inputWidth = Math.max(1, columns - stringWidth(inputPrefix) - 2);
  const inputTail = sliceColumns(
    beforeCursor,
    Math.max(0, stringWidth(beforeCursor) - inputWidth + 1),
    inputWidth - 1,
  );
  const overviewContent =
    showOverview && overview
      ? [
          `${complete ? 'Elements' : 'Loaded elements'}: ${overview.totalElements}`,
          `Maximum depth: ${overview.maxDepth}`,
          `Index/cache charged: ${overview.indexBytes} bytes`,
          `${overview.namesTruncated ? 'Top' : 'Expanded'} names: ${overview.names.length}/${overview.totalDistinctNames}`,
          ...overview.names.map((item) => `${item.count}  {${item.namespaceURI}}${item.name}`),
        ]
      : null;
  const title = help
    ? 'Keyboard help (? / Esc closes)'
    : copyMenu !== null
      ? 'Copy (↑/↓, Enter; Esc cancels)'
      : showOverview
        ? 'Overview statistics (o / Esc closes)'
        : focus === 'results' && results
          ? `${results.kind === 'xpath' ? 'XPath' : 'Fuzzy'} results ${results.items.length ? resultIndex + 1 : 0}/${results.items.length} · Enter reveal · Tab XML`
          : `XML · col ${column}${!complete ? ' · loaded prefix (not fully validated)' : ''}`;
  return (
    <Box width={columns} height={rows} flexDirection="column">
      <Text bold color="cyan">
        {fitText(`xml-stream-format · ${settings.sourceLabel}`, columns)}
      </Text>
      <Text>
        {fitText(
          `Path${page?.pathTruncated ? ' (display shortened)' : ''}: ${page?.path ?? '/'}${currentMatch && currentMatch.ref.kind !== 'element' ? ` · ${currentMatch.label}` : ''}`,
          columns,
        )}
      </Text>
      <Box height={Math.max(1, rows - 5)} width={columns} flexDirection="column">
        <Text bold color="cyan">
          {fitText(title, columns)}
        </Text>
        {help ? (
          HELP.slice(0, contentHeight).map((line) => (
            <Text key={line}>{fitText(line, columns)}</Text>
          ))
        ) : copyMenu !== null ? (
          copyChoices.slice(copyStart, copyStart + contentHeight).map((choice, index) => (
            <Text key={choice.choice} inverse={copyMenu === copyStart + index}>
              {fitText(`${copyMenu === copyStart + index ? '›' : ' '} ${choice.label}`, columns)}
            </Text>
          ))
        ) : overviewContent ? (
          overviewContent
            .slice(0, contentHeight)
            // biome-ignore lint/suspicious/noArrayIndexKey: overview lines are a positional sliding window
            .map((line, index) => <Text key={index}>{fitText(line, columns)}</Text>)
        ) : focus === 'results' && results ? (
          results.items.length ? (
            results.items.slice(resultStart, resultStart + contentHeight).map((item, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: absolute index keys keep row identity stable while scrolling
              <Text key={resultStart + index} inverse={resultStart + index === resultIndex}>
                {fitText(
                  `${resultStart + index === resultIndex ? '›' : ' '} ${item.label}`,
                  columns,
                )}
              </Text>
            ))
          ) : (
            <Text color="yellow">Zero matches · Tab XML · Esc clears results</Text>
          )
        ) : page?.rows.length ? (
          page.rows
            .slice(0, contentHeight)
            .map((row, index) => (
              <XmlLine
                key={row.key}
                row={row}
                selected={index === page.selectedRow}
                width={columns}
              />
            ))
        ) : loadError ? (
          <Text color="red">{fitText(loadError, columns)}</Text>
        ) : (
          <Text color="yellow">
            {fitText(
              paused
                ? 'Paused before visible XML · ↓ continues'
                : document
                  ? 'Loading visible XML…'
                  : `Loading ${progress.stage}… q exits`,
              columns,
            )}
          </Text>
        )}
      </Box>
      <Text
        color={state === 'error' ? 'red' : !complete || state === 'querying' ? 'yellow' : 'green'}
      >
        {fitText(
          `${state} · ${progress.sourceBytes} bytes · ${Math.max(page?.totalElements ?? 0, progress.nodes)} elements${complete ? '' : ' loaded'}${results ? ` · ${results.kind}: ${results.query}` : ''}`,
          columns,
        )}
      </Text>
      {editor ? (
        <Text>
          <Text color="yellow">{inputPrefix}</Text>
          {inputTail}
          <Text inverse>
            {visibleText(
              editor.value.slice(editor.cursor, nextGrapheme(editor.value, editor.cursor)),
            ) || ' '}
          </Text>
          {fitText(
            editor.value.slice(nextGrapheme(editor.value, editor.cursor)),
            Math.max(0, columns - stringWidth(inputPrefix + inputTail) - 1),
          )}
        </Text>
      ) : (
        <Text>
          {fitText(
            notice ||
              '↑↓ j/k · ←→ h/l · Shift+←→ columns · / fuzzy · : XPath · y copy · ? help · q quit',
            columns,
          )}
        </Text>
      )}
      <Text dimColor>
        {fitText(
          editor
            ? 'Enter submit · Esc cancel · letters only edit input'
            : !complete
              ? `${paused ? 'Paused' : pendingDemand ? 'Loading' : 'Loaded'} · navigation reads on demand · XML copy bounded · XPath/export load all`
              : results
                ? 'Tab results/XML · Enter reveal · n/N cycle · Esc clear'
                : `o overview · 0 collapse · 1..9 levels · [/] siblings · mouse ${settings.terminal.mouseEnabled ? 'on' : 'off'}`,
          columns,
        )}
      </Text>
    </Box>
  );
}
