import { Redis } from '@upstash/redis'
import { loadLocalEnvFallback } from './env'

loadLocalEnvFallback(['UPSTASH_', 'KV_', 'DOCKET_'])

let cached: Redis | undefined

function restCredentials(): { url: string; token: string } | null {
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
  if (!url || !token) return null
  return { url, token }
}

/** REST client, or null when Upstash/KV env is unset. */
export function getRedis(): Redis | null {
  if (cached) return cached
  const creds = restCredentials()
  if (!creds) return null
  cached = new Redis(creds)
  return cached
}
