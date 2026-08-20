#!/usr/bin/env node
/**
 * Admin CLI for the public recent docket (Upstash Redis).
 * Run from the repo root so .env.local and node_modules resolve.
 *
 *   node .cursor/skills/docket/scripts/docket.mjs list [--json]
 *   node .cursor/skills/docket/scripts/docket.mjs size [--json]
 *   node .cursor/skills/docket/scripts/docket.mjs usage [--json]
 *   node .cursor/skills/docket/scripts/docket.mjs get <id> [--json]
 *   node .cursor/skills/docket/scripts/docket.mjs set-profile <id> (--name <str> | --picture <url> | --kind0 <json>)...
 *   node .cursor/skills/docket/scripts/docket.mjs delete <id> [id...]
 *   node .cursor/skills/docket/scripts/docket.mjs clear --yes
 *   node .cursor/skills/docket/scripts/docket.mjs bans [--json]
 *   node .cursor/skills/docket/scripts/docket.mjs ban <npub|hex> [npub...]
 *   node .cursor/skills/docket/scripts/docket.mjs unban <npub|hex> [npub...]
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Redis } from '@upstash/redis'
import { nip19 } from 'nostr-tools'

const IDS_KEY = 'docket:ids'
const EXCLUDED_KEY = 'docket:excluded'
const CASE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HEX_64 = /^[0-9a-f]{64}$/i
/** Keep in sync with DOCKET_LIST_LIMIT in src/docket-payload.ts */
const LIST_LIMIT = 8
/** Soft flag for a fat homepage list. Not an error. */
const LIST_BYTES_WARN = 150_000
/** Upstash Redis free-tier data cap. */
const FREE_TIER_BYTES = 256 * 1024 * 1024
const USAGE_WARN_RATIO = 0.5
const USAGE_HIGH_RATIO = 0.8

function loadLocalEnv() {
  for (const file of ['.env.local', '.env']) {
    const path = resolve(process.cwd(), file)
    if (!existsSync(path)) continue
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      const key = trimmed.slice(0, eq).trim()
      if (process.env[key]?.trim()) continue
      let value = trimmed.slice(eq + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      if (value) process.env[key] = value
    }
  }
}

function getRedis() {
  loadLocalEnv()
  const url = (
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.KV_REST_API_URL ||
    ''
  ).trim()
  const token = (
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.KV_REST_API_TOKEN ||
    ''
  ).trim()
  if (!url || !token) {
    fail(
      'Missing Redis REST credentials. Need KV_REST_API_URL + KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN) in .env.local.',
    )
  }
  return new Redis({ url, token })
}

function caseKey(id) {
  return `docket:case:${id}`
}

function pubkeyKey(hex) {
  return `docket:pubkey:${hex}`
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function usage() {
  console.log(`Usage:
  node .cursor/skills/docket/scripts/docket.mjs list [--json]
  node .cursor/skills/docket/scripts/docket.mjs size [--json]
  node .cursor/skills/docket/scripts/docket.mjs usage [--json]
  node .cursor/skills/docket/scripts/docket.mjs get <id> [--json]
  node .cursor/skills/docket/scripts/docket.mjs set-profile <id> (--name <str> | --picture <url> | --kind0 <json>)...
  node .cursor/skills/docket/scripts/docket.mjs delete <id> [id...]
  node .cursor/skills/docket/scripts/docket.mjs clear --yes
  node .cursor/skills/docket/scripts/docket.mjs bans [--json]
  node .cursor/skills/docket/scripts/docket.mjs ban <npub|hex> [npub...]
  node .cursor/skills/docket/scripts/docket.mjs unban <npub|hex> [npub...]`)
}

/** Options that take a following value (or --key=value). */
const VALUED_OPTIONS = new Set([
  'name',
  'display-name',
  'picture',
  'kind0',
])

function parseArgs(argv) {
  const flags = new Set()
  const options = {}
  const positionals = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }
    const body = arg.slice(2)
    const eq = body.indexOf('=')
    if (eq >= 0) {
      options[body.slice(0, eq)] = body.slice(eq + 1)
      continue
    }
    if (
      VALUED_OPTIONS.has(body) &&
      i + 1 < argv.length &&
      !argv[i + 1].startsWith('--')
    ) {
      options[body] = argv[++i]
      continue
    }
    flags.add(body)
  }
  return { command: positionals[0], args: positionals.slice(1), flags, options }
}

function isSafeHttpUrl(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
    if (url.username || url.password) return false
    return true
  } catch {
    return false
  }
}

/** Parse a kind 0 event JSON into profile fields. Requires event.pubkey. */
function profileFromKind0(raw) {
  let data
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    fail('--kind0 must be valid JSON (full kind 0 event)')
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    fail('--kind0 must be a JSON object (full kind 0 event)')
  }
  if (typeof data.content !== 'string') {
    fail(
      '--kind0 must be a full kind 0 event with string content (not profile content alone)',
    )
  }
  const eventPubkey =
    typeof data.pubkey === 'string' ? data.pubkey.trim().toLowerCase() : ''
  if (!HEX_64.test(eventPubkey)) {
    fail('--kind0 event must include a 64-char hex pubkey')
  }
  if (data.kind !== undefined && data.kind !== 0) {
    fail(`--kind0 event kind must be 0 (got ${data.kind})`)
  }
  let content
  try {
    content = JSON.parse(data.content)
  } catch {
    fail('--kind0 event content is not valid JSON')
  }
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    fail('--kind0 content must be a JSON object')
  }
  const displayName =
    (typeof content.display_name === 'string' && content.display_name.trim()) ||
    (typeof content.displayName === 'string' && content.displayName.trim()) ||
    (typeof content.name === 'string' && content.name.trim()) ||
    ''
  const picture =
    typeof content.picture === 'string' ? content.picture.trim() : ''
  return {
    displayName: displayName || undefined,
    picture: picture && isSafeHttpUrl(picture) ? picture : undefined,
    eventPubkey,
  }
}

function summary(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null
  return {
    id: snapshot.id,
    judgedAt: snapshot.judgedAt,
    pubkey: snapshot.pubkey,
    displayName: snapshot.displayName ?? '',
    verdict: snapshot.verdict,
    reason: snapshot.reason,
  }
}

function decodePubkeyToken(token) {
  const t = token.trim()
  if (!t) return undefined
  if (HEX_64.test(t)) return t.toLowerCase()
  let code = t
  if (code.toLowerCase().startsWith('nostr:')) code = code.slice(6)
  try {
    const decoded = nip19.decode(code)
    if (decoded.type === 'npub') return decoded.data
    if (decoded.type === 'nprofile') return decoded.data.pubkey
  } catch {
    return undefined
  }
  return undefined
}

function toNpub(hex) {
  return nip19.npubEncode(hex)
}

function resolveTokens(tokens) {
  if (tokens.length === 0) fail('needs at least one npub, nprofile, or hex pubkey')
  const resolved = []
  for (const token of tokens) {
    const hex = decodePubkeyToken(token)
    if (!hex) fail(`Not a valid npub / nprofile / hex pubkey: ${token}`)
    resolved.push({ hex, npub: toNpub(hex), input: token })
  }
  return resolved
}

async function loadBanList(redis) {
  const members = await redis.smembers(EXCLUDED_KEY)
  const rows = []
  for (const member of Array.isArray(members) ? members : []) {
    if (typeof member !== 'string' || !HEX_64.test(member)) continue
    const hex = member.toLowerCase()
    rows.push({ hex, npub: toNpub(hex) })
  }
  rows.sort((a, b) => a.npub.localeCompare(b.npub))
  return rows
}

async function loadCases(redis, ids) {
  if (ids.length === 0) return []
  const blobs = await redis.mget(...ids.map(caseKey))
  return ids.map((id, index) => {
    const blob = blobs[index]
    if (!blob || typeof blob !== 'object') return { id, snapshot: null }
    return { id, snapshot: blob }
  })
}

async function cmdList(redis, json) {
  const ids = await redis.lrange(IDS_KEY, 0, -1)
  const rows = (await loadCases(redis, ids))
    .map(({ snapshot }) => summary(snapshot))
    .filter(Boolean)
  if (json) {
    console.log(JSON.stringify(rows, null, 2))
    return
  }
  if (rows.length === 0) {
    console.log('Docket is empty.')
    return
  }
  for (const row of rows) {
    const name = row.displayName || row.pubkey.slice(0, 12)
    console.log(
      `${row.id}\t${row.verdict}\t${row.judgedAt}\t${name}\t${row.pubkey}`,
    )
  }
  console.log(`${rows.length} case(s)`)
}

function withoutNotes(snapshot) {
  const { notes: _notes, ...card } = snapshot
  return card
}

function noteChars(snapshot) {
  const notes = Array.isArray(snapshot.notes) ? snapshot.notes : []
  let chars = 0
  for (const note of notes) {
    if (typeof note?.content === 'string') chars += note.content.length
  }
  return chars
}

function formatBytes(n) {
  if (n < 1024) return `${n} bytes`
  if (n < 1024 * 1024) return `${n} bytes (${(n / 1024).toFixed(1)} KB)`
  return `${n} bytes (${(n / (1024 * 1024)).toFixed(2)} MB)`
}

function parseUsedMemory(raw) {
  if (typeof raw === 'string') {
    const match = raw.match(/used_memory:(\d+)/)
    if (match) return Number(match[1])
    return null
  }
  if (raw && typeof raw === 'object') {
    const value = raw.used_memory ?? raw.usedMemory
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

async function readUsedMemory(redis) {
  try {
    return parseUsedMemory(await redis.info('memory'))
  } catch {
    return null
  }
}

async function loadFeed(redis) {
  const ids = await redis.lrange(IDS_KEY, 0, LIST_LIMIT - 1)
  const [rows, excludedMembers] = await Promise.all([
    loadCases(redis, ids),
    redis.smembers(EXCLUDED_KEY),
  ])
  const excluded = new Set(
    (Array.isArray(excludedMembers) ? excludedMembers : [])
      .filter((value) => typeof value === 'string' && HEX_64.test(value))
      .map((value) => value.toLowerCase()),
  )
  const cases = []
  const seen = new Set()
  for (const { snapshot } of rows) {
    if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.id !== 'string') {
      continue
    }
    if (!Array.isArray(snapshot.notes) || snapshot.notes.length === 0) continue
    const hex = snapshot.pubkey
    if (typeof hex === 'string') {
      if (seen.has(hex)) continue
      if (excluded.has(hex.toLowerCase())) continue
      seen.add(hex)
    }
    cases.push(snapshot)
  }
  return cases
}

async function cmdSize(redis, json) {
  const cases = await loadFeed(redis)
  const listJson = JSON.stringify({ cases })
  const cardsJson = JSON.stringify({ cases: cases.map(withoutNotes) })
  const perCase = cases.map((snapshot) => ({
    id: snapshot.id,
    displayName:
      typeof snapshot.displayName === 'string' ? snapshot.displayName : '',
    bytes: JSON.stringify(snapshot).length,
    notes: snapshot.notes.length,
    noteChars: noteChars(snapshot),
  }))
  const largest = perCase.reduce(
    (best, row) => (!best || row.bytes > best.bytes ? row : best),
    null,
  )
  const report = {
    cases: cases.length,
    listLimit: LIST_LIMIT,
    bytes: listJson.length,
    cardBytes: cardsJson.length,
    noteBytes: listJson.length - cardsJson.length,
    averageBytes: perCase.length
      ? Math.round(perCase.reduce((sum, row) => sum + row.bytes, 0) / perCase.length)
      : 0,
    largest,
    warnBytes: LIST_BYTES_WARN,
    overWarn: listJson.length >= LIST_BYTES_WARN,
  }

  if (json) {
    console.log(JSON.stringify({ ...report, perCase }, null, 2))
    return
  }
  if (cases.length === 0) {
    console.log('Docket feed is empty.')
    return
  }
  console.log(
    `GET /api/docket\t${cases.length} case(s)\t${formatBytes(report.bytes)}`,
  )
  console.log(`notes add\t${formatBytes(report.noteBytes)}`)
  if (largest) {
    const name = largest.displayName || largest.id
    console.log(
      `largest\t${formatBytes(largest.bytes)}\t${name}\t${largest.notes} notes\t${largest.noteChars} chars`,
    )
  }
  if (report.overWarn) {
    console.log(
      `Feed is over ${formatBytes(LIST_BYTES_WARN)}. Homepage may feel slower; consider dropping notes from the list again.`,
    )
  }
}

function usageLevel(bytes) {
  const ratio = bytes / FREE_TIER_BYTES
  if (ratio >= USAGE_HIGH_RATIO) return 'high'
  if (ratio >= USAGE_WARN_RATIO) return 'warn'
  return 'ok'
}

async function cmdUsage(redis, json) {
  const ids = await redis.lrange(IDS_KEY, 0, -1)
  const rows = await loadCases(redis, ids)
  let snapshotBytes = 0
  let missing = 0
  for (const { snapshot } of rows) {
    if (!snapshot || typeof snapshot !== 'object') {
      missing += 1
      continue
    }
    snapshotBytes += JSON.stringify(snapshot).length
  }
  const redisBytes = await readUsedMemory(redis)
  const measured = redisBytes ?? snapshotBytes
  const report = {
    cases: ids.length,
    missing,
    snapshotBytes,
    redisBytes,
    freeTierBytes: FREE_TIER_BYTES,
    usedRatio: measured / FREE_TIER_BYTES,
    level: usageLevel(measured),
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  console.log(`stored cases\t${report.cases}`)
  if (missing > 0) console.log(`missing snapshots\t${missing}`)
  console.log(`snapshot JSON\t${formatBytes(snapshotBytes)}`)
  if (redisBytes != null) {
    console.log(`Redis used_memory\t${formatBytes(redisBytes)}`)
  }
  console.log(
    `free tier\t${formatBytes(FREE_TIER_BYTES)}\t${(report.usedRatio * 100).toFixed(1)}%`,
  )
  if (report.level === 'high') {
    console.log(
      'Storage is over 80% of the 256 MB free cap. Trim old cases or move off the free tier.',
    )
  } else if (report.level === 'warn') {
    console.log(
      'Storage is over 50% of the 256 MB free cap. Check again if the docket keeps growing.',
    )
  }
}

async function cmdGet(redis, id, json) {
  if (!CASE_ID_RE.test(id)) fail(`Invalid case id: ${id}`)
  const snapshot = await redis.get(caseKey(id))
  if (!snapshot) fail(`Not found: ${id}`)
  if (json) {
    console.log(JSON.stringify(snapshot, null, 2))
    return
  }
  const row = summary(snapshot)
  const npub =
    typeof snapshot.pubkey === 'string' && HEX_64.test(snapshot.pubkey)
      ? toNpub(snapshot.pubkey)
      : ''
  console.log(
    [
      `id: ${row.id}`,
      `judgedAt: ${row.judgedAt}`,
      `verdict: ${row.verdict}`,
      `name: ${row.displayName || '(none)'}`,
      `picture: ${typeof snapshot.picture === 'string' && snapshot.picture ? snapshot.picture : '(none)'}`,
      `pubkey: ${row.pubkey}`,
      ...(npub ? [`npub: ${npub}`] : []),
      `reason: ${row.reason}`,
      `notes: ${Array.isArray(snapshot.notes) ? snapshot.notes.length : 0}`,
    ].join('\n'),
  )
}

async function cmdSetProfile(redis, id, options, json) {
  if (!CASE_ID_RE.test(id)) fail(`Invalid case id: ${id}`)
  const snapshot = await redis.get(caseKey(id))
  if (!snapshot || typeof snapshot !== 'object') fail(`Not found: ${id}`)

  let displayName =
    options.name?.trim() || options['display-name']?.trim() || undefined
  let picture = options.picture?.trim() || undefined
  let kind0Pubkey

  if (options.kind0 !== undefined) {
    const fromKind0 = profileFromKind0(options.kind0)
    kind0Pubkey = fromKind0.eventPubkey
    if (!displayName && fromKind0.displayName) {
      displayName = fromKind0.displayName
    }
    if (!picture && fromKind0.picture) picture = fromKind0.picture
  }

  if (!displayName && !picture) {
    fail(
      'set-profile needs --name / --display-name, --picture, and/or --kind0 <json>',
    )
  }
  if (picture && !isSafeHttpUrl(picture)) {
    fail(`Unsafe or invalid picture URL: ${picture}`)
  }
  if (kind0Pubkey) {
    const casePubkey =
      typeof snapshot.pubkey === 'string'
        ? snapshot.pubkey.trim().toLowerCase()
        : ''
    if (!HEX_64.test(casePubkey)) {
      fail(`Case ${id} has no valid pubkey to compare against kind 0`)
    }
    if (kind0Pubkey !== casePubkey) {
      fail(
        `kind 0 pubkey ${kind0Pubkey} does not match case pubkey ${casePubkey}`,
      )
    }
  }

  const updated = { ...snapshot }
  if (displayName) updated.displayName = displayName
  if (picture) updated.picture = picture
  await redis.set(caseKey(id), updated)

  const result = {
    id: updated.id,
    pubkey: updated.pubkey,
    displayName: updated.displayName ?? '',
    picture: updated.picture ?? '',
  }
  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(
    [
      `updated ${result.id}`,
      `name: ${result.displayName || '(none)'}`,
      `picture: ${result.picture || '(none)'}`,
      `pubkey: ${result.pubkey}`,
    ].join('\n'),
  )
}

async function deleteOne(redis, id) {
  if (!CASE_ID_RE.test(id)) fail(`Invalid case id: ${id}`)
  const snapshot = await redis.get(caseKey(id))
  await redis.lrem(IDS_KEY, 0, id)
  const keys = [caseKey(id)]
  if (snapshot && typeof snapshot === 'object' && snapshot.pubkey) {
    const pointer = await redis.get(pubkeyKey(snapshot.pubkey))
    if (pointer === id) keys.push(pubkeyKey(snapshot.pubkey))
  }
  await redis.del(...keys)
  return Boolean(snapshot)
}

async function cmdDelete(redis, ids) {
  if (ids.length === 0) fail('delete requires at least one case id')
  const results = []
  for (const id of ids) {
    const existed = await deleteOne(redis, id)
    results.push({ id, deleted: existed })
  }
  for (const row of results) {
    console.log(`${row.deleted ? 'deleted' : 'missing'}\t${row.id}`)
  }
}

async function scanKeys(redis, match) {
  const found = []
  let cursor = '0'
  do {
    const [next, keys] = await redis.scan(cursor, { match, count: 100 })
    cursor = String(next)
    found.push(...keys)
  } while (cursor !== '0')
  return found
}

async function cmdClear(redis, flags) {
  if (!flags.has('yes')) {
    fail('Refusing to clear the docket without --yes')
  }
  const ids = await redis.lrange(IDS_KEY, 0, -1)
  const cases = await loadCases(redis, ids)
  const keys = [IDS_KEY]
  for (const { id, snapshot } of cases) {
    keys.push(caseKey(id))
    if (snapshot?.pubkey) keys.push(pubkeyKey(snapshot.pubkey))
  }
  const leftovers = [
    ...(await scanKeys(redis, 'docket:case:*')),
    ...(await scanKeys(redis, 'docket:pubkey:*')),
  ]
  const unique = [...new Set([...keys, ...leftovers])]
  if (unique.length > 0) await redis.del(...unique)
  console.log(`cleared ${ids.length} listed case(s), ${unique.length} key(s)`)
}

async function cmdBans(redis, json) {
  const rows = await loadBanList(redis)
  if (json) {
    console.log(JSON.stringify(rows, null, 2))
    return
  }
  if (rows.length === 0) {
    console.log('No npubs excluded.')
    return
  }
  for (const row of rows) {
    console.log(`${row.npub}\t${row.hex}`)
  }
  console.log(`${rows.length} excluded`)
}

async function deleteCasesForPubkeys(redis, hexes) {
  const ids = await redis.lrange(IDS_KEY, 0, -1)
  const cases = await loadCases(redis, ids)
  const want = new Set(hexes)
  const removed = []
  for (const { id, snapshot } of cases) {
    const hex = snapshot?.pubkey
    if (typeof hex === 'string' && want.has(hex.toLowerCase())) {
      await deleteOne(redis, id)
      removed.push({ id, hex, name: snapshot.displayName || '' })
    }
  }
  return removed
}

async function cmdBan(redis, tokens) {
  const resolved = resolveTokens(tokens)
  const before = new Set((await loadBanList(redis)).map((row) => row.hex))
  const added = resolved.filter((row) => !before.has(row.hex))
  if (added.length > 0) {
    await redis.sadd(EXCLUDED_KEY, ...added.map((row) => row.hex))
  }
  const removed = await deleteCasesForPubkeys(
    redis,
    resolved.map((row) => row.hex),
  )
  if (added.length === 0) {
    console.log('already excluded:')
    for (const row of resolved) console.log(`\t${row.npub}`)
  } else {
    console.log('banned:')
    for (const row of added) console.log(`\t${row.npub}`)
  }
  if (removed.length > 0) {
    console.log('removed from docket:')
    for (const row of removed) {
      console.log(`\t${row.id}\t${row.name || row.hex}`)
    }
  }
  const count = await redis.scard(EXCLUDED_KEY)
  console.log(`${count} excluded`)
}

async function cmdUnban(redis, tokens) {
  const resolved = resolveTokens(tokens)
  const before = new Set((await loadBanList(redis)).map((row) => row.hex))
  const removed = resolved.filter((row) => before.has(row.hex))
  const missing = resolved.filter((row) => !before.has(row.hex))
  if (removed.length > 0) {
    await redis.srem(EXCLUDED_KEY, ...removed.map((row) => row.hex))
  }
  if (removed.length > 0) {
    console.log('unbanned:')
    for (const row of removed) console.log(`\t${row.npub}`)
  }
  if (missing.length > 0) {
    console.log('not on list:')
    for (const row of missing) console.log(`\t${row.npub}`)
  }
  const count = await redis.scard(EXCLUDED_KEY)
  console.log(`${count} excluded`)
}

const { command, args, flags, options } = parseArgs(process.argv.slice(2))
if (!command || command === 'help' || flags.has('help')) {
  usage()
  process.exit(command ? 0 : 1)
}

const redis = getRedis()
const json = flags.has('json')

switch (command) {
  case 'list':
    await cmdList(redis, json)
    break
  case 'size':
    await cmdSize(redis, json)
    break
  case 'usage':
    await cmdUsage(redis, json)
    break
  case 'get':
    if (!args[0]) fail('get requires a case id')
    await cmdGet(redis, args[0], json)
    break
  case 'set-profile':
    if (!args[0]) fail('set-profile requires a case id')
    await cmdSetProfile(redis, args[0], options, json)
    break
  case 'delete':
    await cmdDelete(redis, args)
    break
  case 'clear':
    await cmdClear(redis, flags)
    break
  case 'bans':
    await cmdBans(redis, json)
    break
  case 'ban':
    await cmdBan(redis, args)
    break
  case 'unban':
    await cmdUnban(redis, args)
    break
  default:
    usage()
    fail(`Unknown command: ${command}`)
}
