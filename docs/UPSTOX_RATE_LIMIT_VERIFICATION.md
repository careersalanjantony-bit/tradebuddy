# Browser smoke verification

Both commits were exported into separate directories, built with `npm run build`, and checked with `npm run smoke` using Node 24.22.1, Playwright 1.57.0, and Chromium 156.0.8078.79. The smoke harness mocked Upstox.

| Commit | Production build | Smoke checks | Browser errors | Order or GTT requests |
| --- | --- | --- | --- | --- |
| `2c67167` (`server-backend`) | Passed | 128 of 129 passed | 0 | 0 |
| `5402c16` (historical queue fix) | Passed | 128 of 129 passed | 0 | 0 |

Both smoke runs exited with status 1 after the same assertion failed. The smoke script expects a light canvas (`#F9F9FF`). Both revisions default `ui.theme` to `dark`, and the browser observed the dark canvas (`rgb(0, 0, 0)`). The separate check for switching to the light theme passed on both revisions. [Smoke assertion](../scripts/app-smoke.mjs#L441) · [Theme default](../src/storage/defaults.ts#L5) · [Dark canvas](../src/ui/styles/tokens.css#L124)
