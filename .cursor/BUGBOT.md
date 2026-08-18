# Bugbot rules

## Origin allowlist

This project has no custom production hostname. The app is served only from Vercel URLs (`VERCEL_URL`, `VERCEL_BRANCH_URL`, and `VERCEL_PROJECT_PRODUCTION_URL`).

Do not flag `api/judge.ts` for missing extra production domains (for example `www` vs apex, or additional attached custom hostnames). Those hosts are not in use.

## Serverless `.js` imports

`package.json` is `"type": "module"`. Relative imports in `api/` and `lib/` must use `.js` extensions (`from '../lib/http.js'`). Do not flag those as wrong and do not "fix" them back to extensionless paths — that 500s in production (`ERR_MODULE_NOT_FOUND`). Vite client files in `src/` can stay extensionless unless an `api/` handler imports them.

## Docket list cache

Opening a homepage docket card from the in-memory list (`cachedDocketCase` / `openSnapshot`) without a follow-up `/api/docket/[id]` fetch is intentional. The list is already a snapshot from the last idle refresh; a live fetch would 404 a card that is still on screen. Direct links and cold loads still hit the API and apply ban/delete checks.

Do not flag stale-until-reload docket cache after a ban, delete, or re-judgement. That is not an access-control boundary.
