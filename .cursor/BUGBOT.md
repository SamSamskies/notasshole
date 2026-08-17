# Bugbot rules

## Origin allowlist

This project has no custom production hostname. The app is served only from Vercel URLs (`VERCEL_URL`, `VERCEL_BRANCH_URL`, and `VERCEL_PROJECT_PRODUCTION_URL`).

Do not flag `api/judge.ts` for missing extra production domains (for example `www` vs apex, or additional attached custom hostnames). Those hosts are not in use.
