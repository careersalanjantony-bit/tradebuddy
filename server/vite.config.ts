import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Builds the server into one file, server/dist/main.js, for Node 24 (`npm run server:build`).
 * The shared app code imports without file extensions, which Node cannot load directly, so it is
 * bundled. `ws` stays an ordinary package in node_modules.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  root,
  publicDir: false,
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  ssr: { noExternal: true, external: ['ws'] },
  build: {
    ssr: 'server/src/main.ts',
    outDir: 'server/dist',
    emptyOutDir: true,
    target: 'node24',
    sourcemap: true,
    minify: false,
    rollupOptions: { output: { entryFileNames: 'main.js', format: 'es' } },
  },
});
