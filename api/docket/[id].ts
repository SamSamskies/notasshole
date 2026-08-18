import type { VercelRequest, VercelResponse } from '@vercel/node'
import { CASE_ID_RE } from '../../src/docket-payload.js'
import { getDocketCase, isDocketPubkeyExcluded } from '../../lib/docket-store.js'
import { applyCors, originAllowed, requestOrigin } from '../../lib/http.js'
import { getRedis } from '../../lib/redis.js'

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

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' })
    return
  }

  const rawId = req.query.id
  const id = typeof rawId === 'string' ? rawId.trim() : ''
  if (!CASE_ID_RE.test(id)) {
    res.status(400).json({ error: 'invalid_request' })
    return
  }

  const redis = getRedis()
  if (!redis) {
    res.status(503).json({ error: 'unavailable' })
    return
  }

  try {
    const snapshot = await getDocketCase(redis, id)
    if (
      !snapshot ||
      (typeof snapshot.pubkey === 'string' &&
        (await isDocketPubkeyExcluded(redis, snapshot.pubkey)))
    ) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    res.status(200).json(snapshot)
  } catch (error) {
    console.warn('[api/docket/:id] read failed', error)
    res.status(503).json({ error: 'unavailable' })
  }
}
