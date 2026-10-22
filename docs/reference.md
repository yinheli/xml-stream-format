# xml-stream-format reference

Complete behavior, limits and guarantees. Start with the [README](../README.md) for an overview.
Node.js `^22.13.0 || >=23.4.0`, ESM, MIT.

```js
import { Readable } from 'node:stream';
import { formatXml } from 'xml-stream-format';

for await (const chunk of formatXml(Readable.from(['<r><a/></r>']))) {
  process.stdout.write(chunk);
}
```

`formatXml(source, options)` accepts an async iterable of byte chunks or string
chunks (not both). It returns an async generator of UTF-8-ready strings. It
validates and writes a private temporary event tape **before the first output**;
it does not retain the whole document or build a DOM. A slow output consumer
stops replay reads. Temporary data is removed on completion, error, abort, or
consumer `return()`.
Cancellation is checked at every emitted chunk boundary, including when one
oversized markup record is split across multiple output chunks.
Input and decoding errors retain their original error identity/code even when
closing the source iterator also fails.

Options:

- `indent`: 0–16 spaces (default 2), or `'tab'`. Zero keeps structural line breaks.
- `whitespace`: `'preserve'` (default) or `'reindent'`. Preserve protects *all*
  existing direct text, including whitespace. Reindent replaces only formatting
  whitespace around markup children. Mixed text, CDATA and `xml:space="preserve"`
  remain protected; `xml:space="default"` restores the selected mode.
- `hooks`: serial, optionally asynchronous `onNode`, `onAttribute`, `onText`.
  `onNode` may rename/replace ordinary attributes or return `false` to remove a
  subtree. `onAttribute` may rename/change a value or return `null` to remove it.
  Node snapshots include read-only `xmlns` declarations; attribute hooks and
  replacement attribute lists contain ordinary attributes only.
  `onText` may replace each parser segment (including with an empty string).
  Hooks receive source QName path, depth and optional signal. Text callbacks are
  **not** guaranteed to receive the whole element text. Namespace declarations
  cannot be edited; renamed prefixes must already be bound. The root cannot be
  removed. Transformed XML and QName identity are validated before output, so
  malformed names cannot inject otherwise-well-formed markup. Skipped input is still
  strictly parsed. User closures execute once in the caller's thread.
- `signal`, `tempDirectory`, `maxDepth` (default 1024), `maxTokenCodeUnits`
  (default 8,388,608). The token limit covers original decoded source markup and
  unfinished references before declaration encoding normalization, not ordinary
  text or CDATA bodies; generated hook-validation XML does not consume that
  source budget again. Cancellation stops waiting for an
  async hook but cannot undo user side effects.

Byte inputs support UTF-8, UTF-16LE/BE, US-ASCII and ISO-8859-1. Decoding is
strict; unsupported or conflicting declarations fail. String input is already
decoded Unicode; declaration encoding names must still obey XML grammar.
One optional leading BOM is accepted; additional leading BOMs are rejected.
Output declarations retain version/standalone and use UTF-8; generated line breaks are LF,
and the document ends with one LF. Empty elements use `<name/>`. Entity spelling,
quote style and original CRLF bytes are not retained. Formatting may introduce
indentation text nodes in structural containers.

DOCTYPE is prohibited, including custom entities; no network/file entities are
loaded. Names follow the bundled Expat XML 1.0 Fourth Edition implementation;
XML 1.1 and complete Fifth Edition name support are not promised. Errors expose
stable `code` values through `XmlError`; parser line/column/byte offsets refer to
the normalized UTF-8 stream, not original source bytes.

## XPath documents

```js
import { openXml } from 'xml-stream-format';
const document = await openXml(source);
try {
  const matches = await document.select('//r:item[@id = ["1", "3"]?*]', {
    namespaces: { r: 'urn:r' },
  });
  for await (const chunk of document.extract(matches[0].xpath)) {
    process.stdout.write(chunk);
  }
} finally {
  await document.close();
}
```

`openXml` accepts parsing, cancellation and temporary-directory options (no
function hooks), plus `maxIndexBytes` (default 256 MiB). Normalized input is parsed
once into a private event tape and a worker-owned element index; no full input
snapshot or second index-building pass is required. `openXml` still waits for
complete validation before returning. Structural records, names, sibling ordinals
and fold overrides live in worker-owned SQLite files with bounded page caches
and weighted, evicting JavaScript caches. `maxIndexBytes` caps accounted working
storage, not the size of the on-disk index or process RSS; it is a ceiling, not
an allocation made at startup. Preview files are created only for the browser.

`select` returns `{ref, xpath, label}` matches. References belong to this session;
canonical XPath strings are namespace-independent. Namespace bindings use supplied
own properties, not inherited dictionary properties or source `xmlns` declarations.
The empty key sets the default element namespace, not the attribute namespace.
FontoXPath predefines `xml`, `xs`, `fn`, `map`, `array`, `math`, `fontoxpath` and
`local`; conflicting explicit mappings fail with `ERR_XPATH_QUERY` rather than
silently selecting another namespace. Use a different prefix for custom URIs.
Their fixed URIs are the XML namespace, XML Schema namespace, XPath functions
namespace (including its `/map`, `/array` and `/math` variants),
`http://fontoxml.com/fontoxpath`, and the XQuery local-functions namespace,
respectively. Queries always use the source document as context. Adjacent
text/CDATA/entity segments form one logical Text. `fn:trace()` retains its XPath
result but emits no host stdout/stderr or terminal output.

XPath uses the open-source FontoXPath 3.1 implementation, including its upstream
unsupported-expression limits; there is no subset fallback, XQuery Update,
custom extension function loading or experimental JavaScript code generation.
Atomic/map/array results are rejected (`ERR_XPATH_RESULT_TYPE`), not filtered.
The fixed FontoXPath 3.34.0 runtime is vendored with six dictionary-ownership
corrections for prototype-named prefixes/variables; no grammar or evaluation
algorithm is changed. This covers QName syntax, dynamically constructed
`xs:QName` strings and nested `fontoxpath:evaluate` map variables without rewriting
queries. Its artifact integrity, exact changes and MIT license are under
`vendor/fontoxpath/`.

Select options: `maxSourceBytes` (default 64 MiB, original pre-normalization input
bytes), `maxOldGenerationSizeMb` (512), `queryTimeoutMs` (10,000; supported range
1–2,147,483,647), `maxResults` (100,000), `namespaces`, `signal`. DOM loading has a
separate 30-second deadline.
The DOM exists only in an on-demand worker; timeout, cancellation and heap failure
terminate it. Later queries can rebuild it without closing the browsing session.
Heap limits are V8 old-generation limits, **not total RSS**. Results are checked
after evaluation and capped at 16 MiB response size; result limits do not cap
evaluation peak memory. Queries in a session are serialized; queued requests can
be cancelled. Open's signal closes the document; select's signal cancels only
that operation. Close is idempotent; later operations fail `ERR_XML_CLOSED`.

`extract` also accepts `indent` and `whitespace`. It preflights all result types:
only elements/documents are accepted, otherwise output is empty and the operation
fails. Sequence order, duplicates and ancestor/descendant overlap are preserved.
Zero matches succeeds with no output. Multiple matches are LF-separated XML
fragments, without a synthetic wrapper. Independent element roots inherit all
in-scope namespace bindings and effective `xml:lang`/`xml:space`. Extraction reads
tape ranges rather than serializing/cloning a whole DOM subtree. Relative URIs
and `xml:base` are not resolved or rewritten.
Inherited context is hydrated only for explicit fragment extraction/copy and is
request-local; ordinary ancestor attributes are not retained as a context cache.
Path copying uses bounded index metadata independently of XML extraction.

## CLI

```sh
xml-stream-format format input.xml --indent tab -o new.xml
cat input.xml | xml-stream-format --reindent
xml-stream-format extract input.xml -N r=urn:r --xpath '//r:item[@id = ["1", "3"]?*]'
xml-stream-format view input.xml
```

Without a command, `--output` selects format; otherwise a terminal stdout selects
view and redirected stdout selects format. Explicit format never starts a UI.
Interactive stdin without a file shows help instead of waiting indefinitely.
View requires a controlling TTY; piped XML remains separate from keyboard input.
Use `--help` or `<command> --help` for parsing, index and XPath budget flags.
`-N '=URI'` sets XPath's default element namespace; bindings may be repeated but
conflicting mappings for one prefix are rejected.

Output paths must be new: no overwrite, including input aliases and hard links.
Success commits a private same-directory staging file with a non-overwriting
hard link; failure removes owned staging data. XML alone goes to stdout;
diagnostics go to stderr. Exit codes: 0 success/zero matches/downstream EPIPE,
2 arguments, 1 XML/I/O/resource errors, 3 XPath syntax or node-result/type errors,
130 Ctrl+C. SIGTERM also performs cleanup (143), including pending browser
exports. Interrupted runs finish cleanup and exit even if a downstream stdout
reader remains open without consuming output. Stdout cannot be rolled back
after an output-stage I/O failure.
Owned input streams open lazily so input-open failures remain normal diagnostics.
Quitting while a live pipe is still loading cancels that reader without waiting
for the producer to reach EOF.

### Read-only terminal browser

The browser has one collapsible, syntax-highlighted XML viewport: opening tags,
attributes, leaf values, CDATA and closing tags are visible together. A collapsed
branch shows its opening tag, omission marker and real closing tag when known;
unfinished branches show `[incomplete]`, never an invented ending. Leaf values
remain visible below the expansion preset. Mixed-content tails survive folding.
Below 40×10 it asks for a larger terminal and still accepts quit.

The first bounded input chunks are usable before EOF. Loading is demand-driven:
when the requested visible content is available, input, parsing, indexing and
preview writing pause together. Progress updates authorize reads only to finish a
viewport that is still under-filled; they never scan otherwise. Forward
navigation past an unfinished collapsed branch may sequentially scan and
spool its hidden contents to find the next sibling; those contents are not loaded
into React or retained as a subtree. A collapsed root does not scan just to fill
blank screen rows.

Each refill is limited to 256 KiB normalized input / approximately 250 ms, checked
between bounded chunks. One input chunk or EOF probe already in flight may finish
after the deadline, but cannot start an unrequested background scan. Long hidden
subtrees or unfinished markup can leave a page partly filled; further progress
keeps filling it, and the next navigation continues it. Unfinished relative
movement never chases the frontier on later turns: the newest navigation always
applies to the view it sees, and wheel bursts collapse into the newest scroll.
`G`/End stays at the indexed visible frontier, not file EOF.

`paused` and `loaded prefix (not fully validated)` differ from `ready`. Fuzzy
search and statistics inspect the indexed prefix. XPath and export explicitly
load and validate the complete document; cancelling XPath releases only that
operation's demand. Copying paths or a closed, bounded non-root subtree never
resumes input and does not build a DOM. Late parse errors remain explicit; export
does not publish partial XML.

Node/name/ordinal/fold records and preview line/checkpoint indexes grow on disk,
not as all-document arrays or visited-row objects. Cached records are evicted and
can be read again when scrolling back. SQLite uses bounded page caches, file-backed
temporary storage and no mmap. The browser's fixed charged reservations total
640 KiB before frames and variable metadata, so smaller `--max-index-bytes`
budgets may be rejected before input is consumed. Runtime, native SQLite and GC
overhead are additional: this option is not a process-RSS cap. Temporary disk
space must accommodate the parsed prefix, event tape, preview and SQLite indexes.
Statistics list at most the top 20 names and report the total distinct-name count.

| Context | Keys |
| --- | --- |
| XML rows | ↑/↓ or j/k; ←/h collapse or parent; →/l expand or first child; Space toggle |
| Paging | PgUp/PgDn or Ctrl+B/F; Ctrl+U/D half-page; gg/Home first; G/End last indexed row; [/] element siblings |
| Horizontal view | Shift+←/→, including long attributes and values |
| Expansion | 0 collapse all; 1–9 maximum visible levels (1 = root only) |
| Search | / fuzzy QName/local name (best 200); : XPath; Enter reveal; n/N cycle; Tab results/XML |
| Result navigation | gg/G first/last result; Ctrl+B/F pages; Ctrl+U/D half-page |
| Other | o statistics; y copy menu; e export to a new file; ? help; q quit |

Esc cancels input, closes a transient panel or clears results. Late search or
overview responses cannot reopen a dismissed mode. Letters in editors do not
navigate. Relative moves retain input order; absolute gg/G/Home/End supersede
unfinished relative movement, and gg/Home does not read ahead to finish old moves.
Another key or input-mode change cancels the gg prefix. Copy/export asks for a
retry while navigation is pending rather than silently acting on an old selection.
Ctrl+C cancels an active XPath operation first, otherwise exits. Failed queries
leave the loaded document and retained matches available.

Mouse capture defaults to `--mouse on` in view/automatic mode: click XML text to
select its owner, click an opening-tag gutter arrow to fold/unfold, and wheel to
scroll without moving the selection. Inertial wheel bursts collapse into one
scroll, so fast scrolling neither floods requests nor loses distance. Closing-tag
and mixed-tail ownership is preserved. Keyboard and mouse share the same cursor/folds; no hover inspector is
opened. SGR mouse reports are separated from keyboard input before Ink, including
fragmented and delayed reports. A lone Escape is released after 50 ms; an already
released Escape cannot be undone if a report arrives later, but its bracket and
numeric suffix never become navigation keys. Bracketed paste is preserved.
Mouse and raw modes are restored on exit. Use `--mouse off` for native terminal
selection; Shift-drag bypass is terminal-dependent and is not guaranteed.

Complete XML responses, including hit targets, keys and display paths, are bounded
to 64 KiB and 256 rows. A response shortened by byte/hit limits remains reachable
with paging, and keyboard jumps keep the cursor in the rendered page. Display
paths are capped at 4 KiB and marked when shortened; actual path copying never
copies an ellipsis and can reject a separate path-work limit. Display uses grapheme
boundaries, Unicode cell widths and four-column tabs. C0/C1/ESC/DEL are escaped;
single combining graphemes over 4096 code units are replaced only on display with
a warning. Copy/export retains original data. Structural display line breaks and
bounded indentation are presentation, not source XML; neither React nor navigation
receives full innerXML or a complete DOM.

The builtin SQLite API is experimental on some supported Node releases. Its
native diagnostics remain visible for noninteractive use; interactive worker
diagnostics become bounded, escaped notices instead of corrupting the terminal.

Press `y` to choose what to copy. The default first item remains **Readable path**;
the second is **Executable XPath**. The third, **Formatted XML: selected node +
descendants**, copies the selected element and its complete subtree as independent,
reindented XML, preserving in-scope namespaces, effective `xml:lang`/`xml:space`,
mixed text and CDATA. Attribute/logical Text matches have a separate value action;
formatted XML copy never silently substitutes their owning element.

Formatted XML copy is intentionally unsupported for the document/root element,
elements whose closing tag has not yet been loaded, and oversized subtrees or
inherited contexts. It does not load ahead to finish an element or validate the
rest of the file. A copied closed fragment is locally parsed XML, not a claim
that the unread document tail is valid. Export retains full-document validation.

Copy checks the indexed range before reading tape, enforces a conservative
4 MiB source-event/context processing budget, checks record sizes before payload
allocation, and counts formatted UTF-8 incrementally. Output is capped at 1 MiB
for local clipboard or 75 KiB for OSC52. Only a bounded successful result is
assembled; refusal reports a message, writes nothing to the clipboard, and never
truncates. Markup escaping is streamed rather than joined into an oversized tag.

`--clipboard auto` uses local clipboardy, or OSC52 with SSH environment markers.
Choose local/osc52/off explicitly if needed. OSC52 reports only “Sent to terminal”,
not clipboard acceptance. Tmux envelopes require no terminal/tmux configuration
changes. Clipboard contents are never probed/read. Export and subtree copy read
tape by ID and do not require the source to fit XPath's DOM budget.
Quitting cancels pending copies and terminates owned native clipboard process
trees before exit, without changing the selected clipboard backend.
The copy menu keeps the selected action visible by scrolling, including at the
minimum supported 40×10 size.

## Development

```sh
npm install --include=dev
npm run lint
npm run build
npm test
npm run site:build   # GitHub Pages site and browser demo (site/)
```

With pnpm 12, use `pnpm install --frozen-lockfile`, `pnpm run lint`,
`pnpm run build` and `pnpm test`. `pnpm-workspace.yaml` explicitly approves
esbuild's installation script; other dependency scripts still require explicit
approval.

Biome 2 checks formatting, lint and import organization in one pass
(`npm run lint`; `npm run lint:fix` or `npm run format` to apply). Configuration
lives in `biome.jsonc`.

Tests run on Vitest (`npm test` builds first, then runs `vitest run`;
`npm run test:watch` re-runs on change, `npm run test:coverage` reports V8
coverage). Type checking covers the tests too via `tsconfig.test.json`.
Because worker threads spawn compiled files by URL and the CLI tests
spawn the built binary, `browser.test.ts`, `query.test.ts` and `cli.test.ts`
import from `dist/`; run `npm run build` before `npm run test:watch` after
editing those areas.

### Large-file measurements

Run `node scripts/benchmark.mjs --keep` after building. It generates bounded-write
64 MiB/1 GiB repeated-node fixtures plus 64 MiB single-text/CDATA fixtures outside
the repository. Each fixture gets one warm-up and three measured real CLI runs
to `os.devNull`, with `/usr/bin/time -l` on macOS (`-v` on Linux). Cached fixtures
must match their generated size, kind and completion markers; invalid caches fail
before measurements. Newly generated fixtures are published only after completion.
The retained directory contains per-run OS reports and `results.json`; omit
`--keep` to remove an automatically created directory. An explicit `--directory`
is always retained, including on failure. Results below are medians of three runs.

Observed on Apple M3 Pro, 36 GiB RAM, macOS arm64, Node v26.11.1:

| Input | Seconds | MiB/s | Peak RSS MiB | Heap MiB | External MiB | Temp MiB | First byte s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Repeated nodes, ~64 MiB | 1.541 | 41.54 | 113.84 | 25.06 | 7.66 | 81.07 | 0.973 |
| Repeated nodes, ~1 GiB | 20.765 | 49.31 | 165.09 | 39.18 | 11.86 | 1296.87 | 13.236 |
| Single text, ~64 MiB | 0.700 | 91.43 | 96.58 | 14.69 | 9.29 | 64.16 | 0.562 |
| Single CDATA, ~64 MiB | 0.684 | 93.53 | 96.58 | 15.25 | 9.61 | 64.16 | 0.562 |

RSS uses the OS process high-water mark; heap/external/temp are 20 ms sampled
peaks. The repeated-node 1 GiB versus 64 MiB median peak-RSS delta was 51.25 MiB,
within the 64 MiB acceptance bound. This is end-to-end formatting, not a parser
microbenchmark. First output is deliberately delayed until validation finishes.

The single-viewport browser was exercised on a real 1,468,828,201-byte financial
XML file. In one local run, the first useful XML viewport appeared in 0.49 s with a 65,536-byte
source counter and 69 indexed elements; attributes and leaf values were visible
before EOF. Spool/SQLite sizes stayed unchanged in two-second idle windows.
Mouse expansion, selection, wheel scrolling, indexed-frontier G, paging, gg,
closed-fragment copy and incomplete-copy refusal were exercised on that file.

A separate bounded producer mixed unique names with repeated sibling names,
using a 1 MiB working budget and including the document element in these counts:

| Indexed elements | Distinct names | Charged bytes | RSS sample MiB | Node index MiB |
| ---: | ---: | ---: | ---: | ---: |
| 5,001 | 2,502 | 786,498 | 178.9 | 0.95 |
| 50,001 | 25,002 | 786,498 | 235.7 | 9.73 |
| 200,001 | 100,002 | 786,498 | 245.8 | 41.62 |

These are process RSS snapshots including the document worker, not high-water
marks or an RSS guarantee. Both structural and preview metadata grew on disk;
charged working storage remained fixed. Backscroll and paths for evicted first
and last records remained correct. Producer barriers used bounded whitespace
padding, so this is a cache-growth check, not a representative throughput test.

The complete behavior suite also ran locally on Node 22.13.0, 24.0.0 and 26.11.1.
Actual PTY checks were macOS only, including mouse on/off, fragmented/delayed SGR,
normal-TTY and piped XML input, syntax colors, path/XML copy, export and terminal
restoration on quit, interrupt and parse error. Node 22 SQLite warnings appeared
as owned UI notices. CI runs on Linux (Ubuntu 26.04) with Node 22/24; that console
environment, actual clipboard pasting and remote terminal acceptance were not
exercised locally. No clipboard probing is used.


Published code is compiled JavaScript with declarations. Consumers do not need a
TypeScript loader. Controlled Expat and FontoXPath vendors, their exact small
patches, source integrity and licenses are included under `vendor/`.
