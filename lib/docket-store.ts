import type { Redis } from '@upstash/redis'
import {
  CASE_ID_RE,
  DEFAULT_DOCKET_CLIENT_DAILY,
  DOCKET_LIST_LIMIT,
  DOCKET_STORE_LIMIT,
  HEX_64,
  type DocketCard,
  type DocketCase,
  type DocketCaseInput,
  toCardSummary,
} from '../src/docket-payload'
import { envInt, todayUtc } from './env'

const IDS_KEY = 'docket:ids'
/** Hex pubkeys hidden from the public feed. Survives `clear`. */
export const EXCLUDED_KEY = 'docket:excluded'

function caseKey(id: string): string {
  return `docket:case:${id}`
}

function pubkeyKey(hex: string): string {
  return `docket:pubkey:${hex}`
}

function writesKey(clientId: string, day: string): string {
  return `docket:writes:${clientId}:${day}`
}

function asMemberSet(members: unknown): Set<string> {
  if (!Array.isArray(members)) return new Set()
  return new Set(
    members
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.toLowerCase()),
  )
}

export async function isDocketPubkeyExcluded(
  redis: Redis,
  pubkey: string,
): Promise<boolean> {
  const hex = pubkey.toLowerCase()
  if (!HEX_64.test(hex)) return false
  const hit = await redis.sismember(EXCLUDED_KEY, hex)
  return hit === true || hit === 1
}

export async function tryConsumeDocketWrite(
  redis: Redis,
  clientId: string,
): Promise<boolean> {
  const limit = envInt('DOCKET_CLIENT_DAILY_LIMIT', DEFAULT_DOCKET_CLIENT_DAILY)
  const key = writesKey(clientId, todayUtc())
  const count = await redis.incr(key)
  if (count === 1) {
    await redis.expire(key, 60 * 60 * 36)
  }
  return count <= limit
}

export async function appendDocketCase(
  redis: Redis,
  input: DocketCaseInput,
): Promise<{ snapshot: DocketCase; replaced: boolean }> {
  const existing = await redis.get<string>(pubkeyKey(input.pubkey))
  const replaced =
    typeof existing === 'string' && CASE_ID_RE.test(existing)
  const id = replaced ? existing : crypto.randomUUID()
  const snapshot: DocketCase = {
    ...input,
    id,
    judgedAt: new Date().toISOString(),
  }

  const dropped = await redis.pipeline()
    .set(caseKey(id), snapshot)
    .lrem(IDS_KEY, 0, id)
    .lpush(IDS_KEY, id)
    .lrange(IDS_KEY, DOCKET_STORE_LIMIT, -1)
    .ltrim(IDS_KEY, 0, DOCKET_STORE_LIMIT - 1)
    .set(pubkeyKey(input.pubkey), id)
    .exec()

  const overflow = dropped[3]
  if (Array.isArray(overflow) && overflow.length > 0) {
    const stale = overflow.filter(
      (value): value is string =>
        typeof value === 'string' && CASE_ID_RE.test(value) && value !== id,
    )
    if (stale.length > 0) {
      await deleteDroppedCases(redis, stale)
    }
  }

  return { snapshot, replaced }
}

async function deleteDroppedCases(
  redis: Redis,
  ids: string[],
): Promise<void> {
  const blobs = await redis.mget<DocketCase>(...ids.map(caseKey))
  const keys = ids.map(caseKey)
  for (const blob of blobs) {
    if (!blob || typeof blob !== 'object' || typeof blob.pubkey !== 'string') {
      continue
    }
    const pointer = await redis.get<string>(pubkeyKey(blob.pubkey))
    if (pointer === blob.id) keys.push(pubkeyKey(blob.pubkey))
  }
  await redis.del(...keys)
}

export async function listDocketCards(redis: Redis): Promise<DocketCard[]> {
  const ids = await redis.lrange<string>(IDS_KEY, 0, DOCKET_LIST_LIMIT - 1)
  if (!ids.length) return []

  const [blobs, excludedMembers] = await Promise.all([
    redis.mget<DocketCase>(...ids.map(caseKey)),
    redis.smembers(EXCLUDED_KEY),
  ])
  const excluded = asMemberSet(excludedMembers)
  const cards: DocketCard[] = []
  const seen = new Set<string>()
  for (const blob of blobs) {
    if (!blob || typeof blob !== 'object' || typeof blob.id !== 'string') {
      continue
    }
    if (typeof blob.pubkey === 'string') {
      if (seen.has(blob.pubkey)) continue
      if (excluded.has(blob.pubkey.toLowerCase())) continue
      seen.add(blob.pubkey)
    }
    cards.push(toCardSummary(blob))
  }
  return cards
}

export async function getDocketCase(
  redis: Redis,
  id: string,
): Promise<DocketCase | null> {
  if (!CASE_ID_RE.test(id)) return null
  const blob = await redis.get<DocketCase>(caseKey(id))
  if (!blob || typeof blob !== 'object' || blob.id !== id) return null
  return blob
}
