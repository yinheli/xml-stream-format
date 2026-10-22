# AGENTS.md

`xml-stream-format` formats, queries, and browses XML too large for memory. One design rule
explains almost every module: **bounded memory**. Input is streamed in bounded (~64 KiB) chunks,
per-document state lives on a seekable **event tape** on disk plus SQLite indexes, and output is
emitted in bounded chunks. `docs/reference.md` is the authority on behavior, limits, and
guarantees — update it (and the README when user-visible) whenever you change behavior.

## Invariants

Breaking any of these is a bug even when tests stay green:

- **Bounded memory.** Stream bounded chunks; put state on the tape, in SQLite, or in evictable
  caches — not in arrays or accumulated strings. Applies to formatting and browsing in Node.
- **Validate before output.** `formatXml`, `select`, and `extract` validate the entire source
  before producing output. The `view` browser's progressive preview is the one deliberate
  exception: it presents not-yet-validated input by design.
- **Hooks get revalidated.** When `hooks` transform nodes, the transformed result is serialized
  and re-parsed; names, namespaces, and values are checked, not just well-formedness. Preserve
  this when touching `build-tape.ts` / `serialize.ts`.
- **Strict parsing.** XML 1.0 only; DOCTYPE and custom entities are rejected. Encodings
  (UTF-8/16, US-ASCII, ISO-8859-1) are decoded incrementally with explicit errors.
- **Cleanup and abort.** Temp artifacts live in a workspace-owned `xml-stream-format-*` temp
  directory (mode 0700) and are removed on every exit path, including abort. `AbortSignal`
  propagates through the whole pipeline.
- **Public API is exactly what `src/index.ts` exports.** `XmlDocument` exposes only
  `select` / `extract` / `close`; everything else (e.g. `openBrowserXml`, session internals) is
  internal and may change freely.

## Architecture

Node pipeline (`src/core/`), the spine everything shares:
`input.ts` (strict incremental decode) → `parser.ts` (Expat WASM, lazy-loaded) →
`transform.ts` + `hooks.ts` (user callbacks, caller thread) → `ingest.ts` → `event-tape.ts`
(seekable disk log of parse events) → `replay.ts` (formatted output). `build-tape.ts` assembles
the tape and, when hooks ran, re-parses the transformed output to validate it. `serialize.ts` is
the shared escaping/start-tag writer; keep its pieces bounded so escaping expansion can't balloon
into one buffer.

Browsing (`src/document/`): `document.ts` exposes `openXml`; `session.ts` (parent thread) feeds
bounded (~256 KiB) refills to `document-worker.ts`, which shares the core `ingest` and maintains
a SQLite `NodeIndex` (`index.ts`) plus a paged preview (`preview.ts`, `xml-view.ts`). Parent and
worker speak the typed envelope protocol in `protocol.ts`
(`{sessionId, requestId, type, payload}`); progress arrives as unsolicited `requestId: 0`
messages.

XPath (`src/xpath/`): `query-client.ts` forces full validation, enforces a source-size budget
(default 64 MiB), and lazily spawns a heap-limited `query-worker.ts` that builds a `slimdom` DOM
(`dom-builder.ts`) and evaluates XPath 3.1 via `#fontoxpath`. Results are tape ranges;
`extract.ts` preflights every result node before emitting.

CLI/TUI (`src/cli/`, `src/tui/`): `main.ts` (commander) auto-selects `view` for TTYs; Ink/React
load only for `view`. `output.ts` stages file output as a sibling temp file hard-linked into
place and refuses to overwrite existing files. `terminal-session.ts`, `mouse.ts`, and
`clipboard.ts` handle raw-TTY concerns with bounded parsers.

Browser demo (`site/demo/`) is a parallel implementation, not a port: it reuses core `ingest` in
Web Workers but keeps a typed-array index instead of SQLite and its own protocol
(`site/demo/protocol.ts` — the Node and demo protocols are separate by design). Its memory
guarantees are weaker (exports fall back to a whole-output Blob), so Node invariants do not
transfer wholesale.

## Vendored engines

`#expat-wasm` and `#fontoxpath` resolve via package.json `imports` to patched copies under
`vendor/` (see each NOTICE). Keep them external in builds; preserve their patches and licenses —
they are deliberate, not stale lockfile cruft.

## Verify

npm is the package manager of record (CI runs `npm ci`); `pnpm-lock.yaml` serves local pnpm use,
and `pnpm-workspace.yaml` only approves esbuild's postinstall — there is no workspace.

```sh
npm run build && npm run lint && npm test
```

- Build before testing: `test/query.test.ts`, `test/browser.test.ts`, and `test/cli.test.ts`
  import from `../dist/`, and `npm test` does not rebuild — a skipped build runs those suites
  against stale output.
- Vitest also typechecks `test/**` via `tsconfig.test.json`, so type errors fail the run.

## Commits

Conventional Commits are enforced by CI (`git-cliff --unreleased` must parse cleanly); commit
messages become the changelog. Releases are tag pushes (`vX.Y.Z`) — preview with
`npm run release:preview`.
