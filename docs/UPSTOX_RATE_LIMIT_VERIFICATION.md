# Browser smoke verification

The base and original PR commits were exported into separate directories. All three revisions were built with `npm run build` and checked with `npm run smoke` using Node 24.22.1, Playwright 1.57.0, and Chromium 156.0.8078.79. The smoke harness mocked Upstox.

| Commit | Production build | Smoke checks | Browser errors | Order or GTT requests |
| --- | --- | --- | --- | --- |
| `2c67167` (`server-backend`) | Passed | 128 of 129 passed | 0 | 0 |
| `5402c16` (historical queue fix) | Passed | 128 of 129 passed | 0 | 0 |
| `a3e81ad` (incremental retention follow-up) | Passed | 129 of 129 passed | 0 | 0 |

The base and original PR runs exited with status 1 after observing a black canvas (`rgb(0, 0, 0)`) at the check for a light canvas (`#F9F9FF`). The follow-up observed the expected light canvas. The explicit switch to light passed in all three runs. [Smoke assertion](../scripts/app-smoke.mjs#L441)

The startup code has two asynchronous writers to the same setting. The theme initializer converts dark to light on the first run with the new look. Storage migration 11 writes dark, and the app can start its screens before the migrations finish. The order of those writes can affect the canvas observed by the test. The UI, startup code, migrations, and smoke assertion are identical across the three revisions. [App startup](../src/main.tsx#L12) · [Background startup](../src/background/index.ts#L92) · [Migration 11](../src/storage/migrations.ts#L110) · [Theme initialization](../src/ui/theme.ts#L39)
