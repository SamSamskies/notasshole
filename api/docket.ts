import type { VercelRequest, VercelResponse } from '@vercel/node'
import {
  CLIENT_TOKEN_RE,
  MAX_DOCKET_BODY_BYTES,
  parseDocketPost,
  toCardSummary,
} from '../src/docket-payload'
import {
  appendDocketCase,
  isDocketPubkeyExcluded,
  listDocketCards,
  releaseDocketWrite,
  tryConsumeDocketWrite,
} from '../lib/docket-store'
import { applyCors, originAllowed, requestOrigin } from '../lib/http'
import { getRedis } from '../lib/redis'

function readBody(req: VercelRequest): string {
  if (typeof req.body === 'string') return req.body
  if (req.body == null) return ''
  return JSON.stringify(req.body)
}

function clientToken(req: VercelRequest): string {
  const header = req.headers['x-assholenet-client']
  const raw = typeof header === 'string' ? header.trim() : ''
  return CLIENT_TOKEN_RE.test(raw) ? raw : ''
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const origin = requestOrigin(req)
  applyCors(res, origin)

  if (req.method === 'OPTIONS') {
    if (origin && !originAllowed(req)) {
      res.status(403).end()
      return
    }
    res.status(204).end()
    return
  }

  const redis = getRedis()
  if (!redis) {
    res.status(503).json({ error: 'unavailable' })
    return
  }

  if (req.method === 'GET') {
    try {
      const cases = await listDocketCards(redis)
      res.status(200).json({ cases })
    } catch (error) {
      console.warn('[api/docket] list failed', error)
      res.status(503).json({ error: 'unavailable' })
    }
    return
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' })
    return
  }

  if (!originAllowed(req)) {
    res.status(403).json({ error: 'forbidden_origin' })
    return
  }

  const contentLength = Number(req.headers['content-length'] || '0')
  if (contentLength > MAX_DOCKET_BODY_BYTES) {
    res.status(413).json({ error: 'payload_too_large' })
    return
  }

  let raw: unknown
  try {
    const text = readBody(req)
    if (text.length > MAX_DOCKET_BODY_BYTES) {
      res.status(413).json({ error: 'payload_too_large' })
      return
    }
    raw =
      typeof req.body === 'object' && req.body != null
        ? req.body
        : JSON.parse(text)
  } catch {
    res.status(400).json({ error: 'invalid_json' })
    return
  }

  const parsed = parseDocketPost(raw)
  if (!parsed.ok) {
    res
      .status(parsed.error === 'payload_too_large' ? 413 : 400)
      .json({ error: parsed.error })
    return
  }

  const token = clientToken(req)
  if (!token) {
    res.status(400).json({ error: 'missing_client_token' })
    return
  }

  if (await isDocketPubkeyExcluded(redis, parsed.value.pubkey)) {
    res.status(200).json({ skipped: true, reason: 'excluded' })
    return
  }

  let consumed = false
  try {
    if (!(await tryConsumeDocketWrite(redis, token))) {
      res.status(429).json({ error: 'client_limit' })
      return
    }
    consumed = true

    const { snapshot, replaced } = await appendDocketCase(redis, parsed.value)
    res.status(200).json({ case: toCardSummary(snapshot), replaced })
  } catch (error) {
    if (consumed) {
      try {
        await releaseDocketWrite(redis, token)
      } catch (releaseError) {
        console.warn('[api/docket] release write failed', releaseError)
      }
    }
    console.warn('[api/docket] write failed', error)
    res.status(503).json({ error: 'unavailable' })
  }
}
