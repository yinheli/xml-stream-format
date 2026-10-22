import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * The vendored FontoXPath is UMD. Production builds convert CommonJS anywhere, but the dev
 * server only pre-bundles node_modules, so wrap it as an ES module while serving.
 */
const fontoxpathModule: Plugin = {
  name: 'fontoxpath-umd',
  apply: 'serve',
  transform(code, id) {
    if (!id.endsWith('/vendor/fontoxpath/dist/fontoxpath.js')) return;
    return [
      "import * as xspattern from 'xspattern';",
      "import * as prsc from 'prsc';",
      'const module = { exports: {} };',
      'const exports = module.exports;',
      "const require = (name) => (name === 'xspattern' ? xspattern : prsc);",
      code,
      'export default module.exports;',
    ].join('\n');
  },
};

export default defineConfig({
  root,
  // Relative URLs work on any GitHub Pages path (user, project or custom domain).
  base: './',
  // The library imports Buffer from node:buffer; the `buffer` package is its browser twin.
  resolve: { alias: { 'node:buffer': 'buffer' } },
  plugins: [fontoxpathModule],
  worker: { format: 'es', plugins: () => [fontoxpathModule] },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: { index: `${root}index.html`, demo: `${root}demo/index.html` },
    },
  },
});
