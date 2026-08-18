# Bugbot rules

## Origin allowlist

This project has no custom production hostname. The app is served only from Vercel URLs (`VERCEL_URL`, `VERCEL_BRANCH_URL`, and `VERCEL_PROJECT_PRODUCTION_URL`).

Do not flag `api/judge.ts` for missing extra production domains (for example `www` vs apex, or additional attached custom hostnames). Those hosts are not in use.

## Serverless `.js` imports

`package.json` is `"type": "module"`. Relative imports in `api/` and `lib/` must use `.js` extensions (`from '../lib/http.js'`). Do not flag those as wrong and do not "fix" them back to extensionless paths — that 500s in production (`ERR_MODULE_NOT_FOUND`). Vite client files in `src/` can stay extensionless unless an `api/` handler imports them.
