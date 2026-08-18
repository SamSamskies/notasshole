import type { VercelRequest, VercelResponse } from '@vercel/node'

/** Vercel injects hosts without a scheme (e.g. `app.vercel.app`). */
function originFromHost(host: string | undefined): string | null {
  const trimmed = host?.trim()
  if (!trimmed) return null
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/$/, '')
  return `https://${trimmed}`
}

export function allowedOrigins(): Set<string> {
  const origins = new Set([
    'http://localhost:3000',
    'http://localhost:5173',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5173',
  ])
  for (const host of [
    process.env.VERCEL_URL,
    process.env.VERCEL_BRANCH_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
  ]) {
    const origin = originFromHost(host)
    if (origin) origins.add(origin)
  }
  return origins
}

export function applyCors(res: VercelResponse, origin: string | null): void {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  if (origin && allowedOrigins().has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, X-AssholeNet-Client',
    )
    res.setHeader('Vary', 'Origin')
  }
}

export function requestOrigin(req: VercelRequest): string | null {
  const origin = req.headers.origin
  return typeof origin === 'string' ? origin : null
}

export function originAllowed(req: VercelRequest): boolean {
  const origin = requestOrigin(req)
  if (!origin) return false
  return allowedOrigins().has(origin)
}
