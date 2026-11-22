import { execFileSync } from 'node:child_process';
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
/** the commit this bundle is built from (the release pipeline checks it on /healthz); TB_BUILD_COMMIT wins */
function buildCommit(): string {
  if (process.env.TB_BUILD_COMMIT && /^[0-9a-f]{40}$/.test(process.env.TB_BUILD_COMMIT)) return process.env.TB_BUILD_COMMIT;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

export default defineConfig({
  root,
  publicDir: false,
  define: { __APP_VERSION__: JSON.stringify(pkg.version), __APP_COMMIT__: JSON.stringify(buildCommit()) },
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
