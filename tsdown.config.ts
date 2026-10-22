import { defineConfig } from 'tsdown';

// Unbundled (file-per-module) output:
// - tests import dist paths like ../dist/document/document.js and are
//   typechecked against the emitted .d.ts, so dist/ must mirror src/
// - worker/child-process files are spawned via `new URL(..., import.meta.url)`
//   and resolve relative to their own module, which mirrored structure keeps
// correct (tsc-equivalent layout, faster builds, emitted declarations).
// The vendored engines stay external and are resolved at runtime through the
// package.json `imports` field, exactly like the previous tsc build.
export default defineConfig({
  entry: [
    'src/index.ts',
    'src/cli/main.ts',
    'src/cli/clipboard-helper.ts',
    'src/cli/clipboard.ts',
    'src/cli/mouse.ts',
    'src/document/document.ts',
    'src/document/document-worker.ts',
    'src/xpath/query-worker.ts',
  ],
  unbundle: true,
  root: 'src',
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  // package.json "type": "module" -> emit .js/.d.ts
  fixedExtension: false,
  dts: true,
  external: ['#expat-wasm', '#fontoxpath'],
});
