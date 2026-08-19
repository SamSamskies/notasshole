---
name: docket
description: List, delete, and ban AssholeNet public docket cases. Measure homepage docket list payload size and Redis storage vs the Upstash free-tier cap. Use when the user asks to delete a docket entry, clear the recent docket, list docket ids, ban/exclude/block a spammer npub from the feed, unban, manage stored judgements, check how big the docket list/payload is, or whether Redis is near the 256 MB free-tier limit.
---

# Docket admin

Manage the public docket in Redis. Snapshots are kept so shared `/docket/:id` links keep working; the homepage still shows the newest 8. Bans live in the `docket:excluded` set (hex pubkeys) and take effect immediately — no Vercel env var or redeploy. There is no HTTP delete/ban API — use the CLI from the **repo root**.

```bash
node .cursor/skills/docket/scripts/docket.mjs list [--json]
node .cursor/skills/docket/scripts/docket.mjs size [--json]
node .cursor/skills/docket/scripts/docket.mjs usage [--json]
node .cursor/skills/docket/scripts/docket.mjs get <id> [--json]
node .cursor/skills/docket/scripts/docket.mjs delete <id> [id...]
node .cursor/skills/docket/scripts/docket.mjs clear --yes
node .cursor/skills/docket/scripts/docket.mjs bans [--json]
node .cursor/skills/docket/scripts/docket.mjs ban <npub|hex> [npub...]
node .cursor/skills/docket/scripts/docket.mjs unban <npub|hex> [npub...]
```

Credentials come from `.env.local`: `KV_REST_API_URL` + `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_*`). Never print tokens or dump `.env.local`.

Upstash REST is blocked in the default sandbox. Run these commands with unrestricted network (`required_permissions: ["all"]`).

## Ban spammers (exclude npubs)

Judging still works; excluded pubkeys are not stored or listed on the homepage. Local, preview, and production share this Redis DB, so a ban is live everywhere as soon as `SADD` succeeds.

1. If the user names a **card / person / display name** and not an npub, `list --json` first and match `displayName` / `pubkey`. Confirm if several rows match.
2. Run `ban` with the npub, `nostr:` npub, nprofile, or 64-char hex.
3. `ban` also deletes that pubkey’s existing docket cases. Do not also `delete` unless something is left over.
4. Report the npub(s) banned. Do not print Redis credentials.

`unban` removes them from the set (does not restore deleted cases). `bans` lists the current set.

Do not put bans in `DOCKET_EXCLUDE_NPUBS`, `.env.local`, or Vercel env.

## Delete / clear

1. **List** when the user names a person, a verdict, or “that card” — cards in the UI do not show ids.
2. Match on `displayName` / `pubkey` from `list --json`. If several rows match, show them and confirm which ids before deleting.
3. **Delete by id** for one or more cases (does not ban; they can reappear on the next judgement).
4. **Clear** only when the user explicitly asks to delete all / wipe / empty the docket. Always pass `--yes` (the script refuses otherwise).
5. Report what was removed (id, name, verdict). Do not dump note bodies unless they asked for `get`.

Do not delete `docket:writes:*` (daily write caps) or `docket:excluded` (bans). Do not add a public delete endpoint.

## Payload size

`GET /api/docket` returns full snapshots (notes included) so opening a card does not need a second fetch. Check that body with `size` — do not stringify the list in the API just to log bytes.

1. Run `size` from the repo root (optional `--json`).
2. Report case count, total JSON bytes for `{ cases }`, how many bytes notes add, and the largest case (name, bytes, note count). Do not dump note bodies.
3. A line about 150 KB is a soft flag only. Do not change the list API unless the user asks.

`size` uses the same 8-card feed, pubkey dedupe, and ban filter as the homepage. `list` still shows every stored id.

## Redis storage

There is no automatic alert. Check remaining room on the 256 MB Upstash free tier with `usage` when the user asks if Redis is getting full, how much docket storage we use, or whether we are near the free-tier cap.

1. Run `usage` from the repo root (optional `--json`).
2. Report stored case count, snapshot JSON bytes, Redis `used_memory` if the command returns it, and percent of 256 MB.
3. Flag **warn** at 50% and **high** at 80%. Do not delete cases unless the user asks.
4. `size` is the homepage payload (8 cards). `usage` is all stored snapshots vs the Redis cap. Do not mix them up.

The Upstash console also shows data size. Do not print Redis credentials.

## Redis keys

- `docket:ids` — newest-first list of case ids
- `docket:case:{id}` — full snapshot JSON
- `docket:pubkey:{hex}` — pointer used to replace a person’s card
- `docket:excluded` — SET of banned hex pubkeys

The CLI already `LREM`s the id, deletes the snapshot, and drops the pubkey pointer when it still names that case.

## Examples

- “Ban this spammer npub1…” → `ban npub1…`
- “Keep NotBiebs off the feed” → `list --json`, match name, `ban <hex-or-npub>`
- “Who is banned?” → `bans`
- “Unban npub1…” → `unban npub1…`
- “Delete the NotBiebs docket” → `list --json`, match display name, `delete <id>`
- “Clear the docket” → `clear --yes`
- “How big is the docket list?” → `size`
- “Check docket payload size” → `size --json`
- “Are we near the Redis limit?” → `usage`
- “How much docket storage?” → `usage --json`
