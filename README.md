# xml-stream-format

Format, query and browse XML that doesn't fit in memory. Strict XML 1.0, streamed through a
disk tape: no DOM, no whole-document string.

**[Live demo](https://yinheli.github.io/xml-stream-format/demo/)**: open a multi-GB XML file in
your browser. · [Reference](docs/reference.md) · Node.js `^22.13 || >=23.4` · ESM · MIT

- **Bounded memory**: formats 1 GiB at ~165 MiB peak RSS.
- **Strict**: XML 1.0 via Expat (WASM). DOCTYPE and entities are rejected. Strict UTF-8/16,
  US-ASCII and ISO-8859-1 decoding.
- **Validate before output**: invalid input never produces partial output.
- **Instant browsing**: `view` shows the first screen of a multi-GB file before EOF.
- **XPath 3.1**: extract matches as standalone, namespace-complete XML.
- **Streaming hooks**: rename, rewrite or drop nodes while formatting. The output is re-validated.

```sh
npm i xml-stream-format
```

## CLI

```sh
xml-stream-format huge.xml -o pretty.xml        # format; never overwrites
cat huge.xml | xml-stream-format --reindent     # stdin → stdout
xml-stream-format extract huge.xml --xpath '//order[@status="returned"]'
xml-stream-format view huge.xml                 # terminal browser, ? for keys
```

Exit codes: `0` ok, `1` XML/I/O error, `2` bad arguments, `3` XPath error, `130` interrupted.

## API

```js
import { createReadStream } from 'node:fs';
import { formatXml, openXml } from 'xml-stream-format';

// Format: any async iterable of bytes or strings in, UTF-8 string chunks out.
for await (const chunk of formatXml(createReadStream('in.xml'), { indent: 2 }))
  process.stdout.write(chunk);

// Query: select nodes, then extract them as XML.
const doc = await openXml(createReadStream('in.xml'));
try {
  const [hit] = await doc.select('//order[1]');
  for await (const xml of doc.extract(hit.xpath)) process.stdout.write(xml);
} finally {
  await doc.close();
}

// Transform while streaming: drop <secret> subtrees, upper-case every `id`.
const hooks = {
  onNode: (node) => (node.localName === 'secret' ? false : undefined),
  onAttribute: (attr) => (attr.name === 'id' ? { value: attr.value.toUpperCase() } : undefined),
};
for await (const chunk of formatXml(createReadStream('in.xml'), { hooks }))
  process.stdout.write(chunk);
```

Errors are `XmlError` with a stable `code` (e.g. `ERR_XML_PARSE`, `ERR_XML_DTD`,
`ERR_XPATH_QUERY`).

| Option | Default | Notes |
| --- | --- | --- |
| `indent` | `2` | `0`–`16` spaces or `'tab'` |
| `whitespace` | `'preserve'` | `'reindent'` replaces formatting-only whitespace |
| `signal` | — | `AbortSignal`; temp data is always cleaned up |
| `maxDepth` / `maxTokenCodeUnits` | `1024` / `8388608` | parser limits |

## Numbers

| Input (CLI, Apple M3 Pro) | Time | Peak RSS |
| --- | ---: | ---: |
| 64 MiB, repeated nodes | 1.5 s | 114 MiB |
| 1 GiB, repeated nodes | 20.8 s | 165 MiB |
| `view` first screen, 1.47 GB file | 0.49 s | — |

Methodology, limits, the browser key map and every guarantee are in
[docs/reference.md](docs/reference.md).

## Development

```sh
npm install --include=dev
npm run lint && npm run build && npm test
npm run site:dev     # landing page + browser demo (site/), deployed to GitHub Pages
```

Commits follow [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`,
`docs:`, … with `!` for breaking changes); CI rejects others. To release, push a tag:

```sh
npm run release:preview                       # next version and its notes
git tag v0.2.0 && git push origin v0.2.0      # CI tests, publishes npm, writes the GitHub Release
```

Release notes come from commits via [git-cliff](https://git-cliff.org) (`cliff.toml`).
