/**
 * Hosted Gemini Developer API fallback for AssholeNet.
 * Key stays server-side. Local: `npx vercel dev` (loads `.env.local`).
 *
 * Shared Google free-tier quota is enforced by Gemini 429s.
 * 429s are classified as per-minute (retryable) vs per-day (done until reset).
 * We only soft-cap per browser client token to blunt casual spam.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VercelRequest, VercelResponse } from '@vercel/node'

type GeminiQuotaKind = 'daily' | 'rate'

type JudgeMessage = {
  role: string
  content: string | null
}

type ReasoningEffort = 'auto' | 'none' | 'low' | 'medium' | 'high'

type JudgeOptions = {
  reasoningEffort?: ReasoningEffort
  temperature?: number
}

type JudgeBody = {
  messages?: JudgeMessage[]
  options?: unknown
}

type DayBucket = { day: string; count: number }

/** Free-tier 3.5 Flash is 5 RPM / 20 RPD; Gemma 4 31B is ~30 RPM / 14.4K RPD. */
const DEFAULT_MODEL = 'gemma-4-31b-it'
const MAX_BODY_BYTES = 100_000
const MAX_PROMPT_CHARS = 60_000
/** Per-browser daily cap (spam blunt). Google free-tier RPD is the shared backstop. */
const DEFAULT_CLIENT_DAILY = 50

const clientBuckets = new Map<string, DayBucket>()

/**
 * `vercel dev` sometimes does not inject `.env.local` into serverless
 * functions. Fill GEMINI_* from local files when missing (no-op if set).
 */
function loadLocalEnvFallback(): void {
  const files = ['.env.local', '.env']
  for (const file of files) {
    try {
      const path = join(process.cwd(), file)
      if (!existsSync(path)) continue
      for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq <= 0) continue
        const key = trimmed.slice(0, eq).trim()
        if (!key.startsWith('GEMINI_')) continue
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
    } catch {
      // ignore unreadable env files
    }
  }
}

loadLocalEnvFallback()

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function fallbackEnabled(): boolean {
  const flag = process.env.GEMINI_FALLBACK_ENABLED?.trim().toLowerCase()
  if (flag === '0' || flag === 'false' || flag === 'off') return false
  return Boolean(process.env.GEMINI_API_KEY?.trim())
}

function modelId(): string {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL
}

/** Vercel injects hosts without a scheme (e.g. `app.vercel.app`). */
function originFromHost(host: string | undefined): string | null {
  const trimmed = host?.trim()
  if (!trimmed) return null
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/$/, '')
  return `https://${trimmed}`
}

function allowedOrigins(): Set<string> {
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

function applyCors(res: VercelResponse, origin: string | null): void {
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

function tryConsumeClient(key: string, limit: number): boolean {
  const day = todayUtc()
  const cur = clientBuckets.get(key)
  if (!cur || cur.day !== day) {
    clientBuckets.set(key, { day, count: 1 })
    return true
  }
  if (cur.count >= limit) return false
  cur.count += 1
  return true
}

function releaseClient(key: string): void {
  const day = todayUtc()
  const cur = clientBuckets.get(key)
  if (!cur || cur.day !== day || cur.count <= 0) return
  cur.count -= 1
}

function requestOrigin(req: VercelRequest): string | null {
  const origin = req.headers.origin
  return typeof origin === 'string' ? origin : null
}

function originAllowed(req: VercelRequest): boolean {
  const origin = requestOrigin(req)
  if (!origin) return false
  return allowedOrigins().has(origin)
}

function extractPrompt(messages: JudgeMessage[]): {
  system: string
  user: string
} | null {
  let system = ''
  const userParts: string[] = []
  for (const msg of messages) {
    if (msg == null || typeof msg !== 'object') continue
    const content = typeof msg.content === 'string' ? msg.content : ''
    if (!content.trim()) continue
    if (msg.role === 'system') {
      system = system ? `${system}\n\n${content}` : content
    } else if (msg.role === 'user') {
      userParts.push(content)
    }
  }
  const user = userParts.join('\n\n').trim()
  if (!user) return null
  return { system: system.trim(), user }
}

function readBody(req: VercelRequest): string {
  if (typeof req.body === 'string') return req.body
  if (req.body == null) return ''
  return JSON.stringify(req.body)
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const origin = requestOrigin(req)
  applyCors(res, origin)

  if (req.method === 'OPTIONS') {
    if (origin && !allowedOrigins().has(origin)) {
      res.status(403).end()
      return
    }
    res.status(204).end()
    return
  }

  if (req.method === 'GET') {
    const enabled = fallbackEnabled()
    if (enabled) {
      res.status(200).json({ ok: true, enabled: true })
      return
    }
    const hasKey = Boolean(process.env.GEMINI_API_KEY?.trim())
    res.status(503).json({
      ok: false,
      enabled: false,
      error: hasKey ? 'disabled' : 'missing_api_key',
    })
    return
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' })
    return
  }

  if (!fallbackEnabled()) {
    const hasKey = Boolean(process.env.GEMINI_API_KEY?.trim())
    res.status(503).json({
      error: hasKey ? 'disabled' : 'missing_api_key',
    })
    return
  }

  if (!originAllowed(req)) {
    res.status(403).json({ error: 'forbidden_origin' })
    return
  }

  const contentLength = Number(req.headers['content-length'] || '0')
  if (contentLength > MAX_BODY_BYTES) {
    res.status(413).json({ error: 'payload_too_large' })
    return
  }

  let body: JudgeBody
  try {
    const text = readBody(req)
    if (text.length > MAX_BODY_BYTES) {
      res.status(413).json({ error: 'payload_too_large' })
      return
    }
    body = (typeof req.body === 'object' && req.body != null
      ? req.body
      : JSON.parse(text)) as JudgeBody
  } catch {
    res.status(400).json({ error: 'invalid_json' })
    return
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    res.status(400).json({ error: 'invalid_request' })
    return
  }

  const prompt = extractPrompt(body.messages)
  if (!prompt) {
    res.status(400).json({ error: 'invalid_request' })
    return
  }
  if (prompt.system.length + prompt.user.length > MAX_PROMPT_CHARS) {
    res.status(413).json({ error: 'payload_too_large' })
    return
  }

  const options = parseJudgeOptions(body.options)
  if (options === null) {
    res.status(400).json({ error: 'invalid_request' })
    return
  }

  const clientHeader = req.headers['x-assholenet-client']
  const clientId =
    typeof clientHeader === 'string' ? clientHeader.trim() : ''
  if (!clientId) {
    res.status(400).json({ error: 'missing_client_token' })
    return
  }

  const clientLimit = envInt('GEMINI_CLIENT_DAILY_LIMIT', DEFAULT_CLIENT_DAILY)
  if (!tryConsumeClient(clientId, clientLimit)) {
    res.status(429).json({ error: 'client_limit' })
    return
  }

  const apiKey = process.env.GEMINI_API_KEY!.trim()
  const model = modelId()
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`

  const generationConfig: Record<string, unknown> = {
    responseMimeType: 'application/json',
  }
  const thinkingConfig = thinkingConfigForEffort(model, options.reasoningEffort)
  if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig
  if (options.temperature !== undefined) {
    generationConfig.temperature = options.temperature
  }

  const geminiBody: Record<string, unknown> = {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt.user }],
      },
    ],
    generationConfig,
  }
  if (prompt.system) {
    geminiBody.systemInstruction = {
      parts: [{ text: prompt.system }],
    }
  }

  let geminiRes: globalThis.Response
  try {
    geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody),
    })
  } catch {
    releaseClient(clientId)
    res.status(502).json({ error: 'provider_error' })
    return
  }

  if (geminiRes.status === 429) {
    releaseClient(clientId)
    let quota: GeminiQuotaKind = 'rate'
    try {
      const errJson = (await geminiRes.json()) as unknown
      quota = classifyGemini429(errJson)
      console.warn('[api/judge] Gemini 429', {
        kind: quota,
        quotaIds: collectQuotaIds(errJson),
        message: geminiErrorMessage(errJson)?.slice(0, 200),
      })
    } catch {
      console.warn('[api/judge] Gemini 429', { kind: quota, unreadable: true })
    }
    res.status(429).json({
      error: quota === 'daily' ? 'quota_exhausted' : 'rate_limited',
    })
    return
  }

  if (!geminiRes.ok) {
    releaseClient(clientId)
    // Surface status only (no prompt / key material).
    let geminiCode: string | undefined
    try {
      const errJson = (await geminiRes.json()) as {
        error?: { status?: string; message?: string }
      }
      geminiCode = errJson.error?.status
      console.warn('[api/judge] Gemini error', {
        http: geminiRes.status,
        status: geminiCode,
        message: errJson.error?.message?.slice(0, 200),
      })
    } catch {
      console.warn('[api/judge] Gemini error', { http: geminiRes.status })
    }
    const status = geminiRes.status >= 500 ? 502 : 400
    res.status(status).json({
      error: 'provider_error',
      http: geminiRes.status,
      ...(geminiCode ? { geminiStatus: geminiCode } : {}),
    })
    return
  }

  let geminiJson: unknown
  try {
    geminiJson = await geminiRes.json()
  } catch {
    releaseClient(clientId)
    res.status(502).json({ error: 'provider_error' })
    return
  }

  const text = extractGeminiText(geminiJson)
  if (!text) {
    releaseClient(clientId)
    res.status(502).json({ error: 'provider_error' })
    return
  }

  res.status(200).json({ content: text, model })
}

const REASONING_EFFORTS = new Set<ReasoningEffort>([
  'auto',
  'none',
  'low',
  'medium',
  'high',
])

/** IPA `options` from complete(); unknown keys ignored. */
function parseJudgeOptions(raw: unknown): JudgeOptions | null {
  if (raw == null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const options: JudgeOptions = {}

  if ('reasoningEffort' in record && record.reasoningEffort !== undefined) {
    if (
      typeof record.reasoningEffort !== 'string' ||
      !REASONING_EFFORTS.has(record.reasoningEffort as ReasoningEffort)
    ) {
      return null
    }
    options.reasoningEffort = record.reasoningEffort as ReasoningEffort
  }

  if ('temperature' in record && record.temperature !== undefined) {
    if (
      typeof record.temperature !== 'number' ||
      !Number.isFinite(record.temperature) ||
      record.temperature < 0 ||
      record.temperature > 2
    ) {
      return null
    }
    options.temperature = record.temperature
  }

  return options
}

/** Map IPA `reasoningEffort` onto Gemini thinking knobs. Omit for auto/absent. */
function thinkingConfigForEffort(
  model: string,
  effort: ReasoningEffort | undefined,
): Record<string, unknown> | undefined {
  if (effort == null || effort === 'auto') return undefined
  // 2.5 Flash uses token budgets; 3.x rejects thinkingBudget and has no off.
  if (/\b2\.5\b/.test(model)) {
    if (effort === 'none') return { thinkingBudget: 0 }
    if (effort === 'low') return { thinkingBudget: 1024 }
    if (effort === 'medium') return { thinkingBudget: 8192 }
    return { thinkingBudget: -1 }
  }
  // Gemma 4 only accepts high (on) or minimal (off).
  if (/^gemma-/i.test(model)) {
    return { thinkingLevel: effort === 'none' ? 'minimal' : 'high' }
  }
  return { thinkingLevel: effort === 'none' ? 'minimal' : effort }
}

/** Keep in sync with src/gemini-quota.ts — Vercel does not ship that file with this function. */
function classifyGemini429(body: unknown): GeminiQuotaKind {
  const text = collectStrings(body).join(' ')
  if (/PerDay|per_day|per day|RequestsPerDay|_rpd\b/i.test(text)) return 'daily'
  return 'rate'
}

function collectQuotaIds(value: unknown): string[] {
  const ids: string[] = []
  walkObjects(value, (record) => {
    if (typeof record.quotaId === 'string' && record.quotaId.trim()) {
      ids.push(record.quotaId)
    }
  })
  return ids
}

function collectStrings(value: unknown): string[] {
  const parts: string[] = []
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      parts.push(node)
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (node && typeof node === 'object') {
      for (const child of Object.values(node as Record<string, unknown>)) {
        visit(child)
      }
    }
  }
  visit(value)
  return parts
}

function walkObjects(
  value: unknown,
  visit: (record: Record<string, unknown>) => void,
): void {
  if (Array.isArray(value)) {
    for (const item of value) walkObjects(item, visit)
    return
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    visit(record)
    for (const child of Object.values(record)) walkObjects(child, visit)
  }
}

function geminiErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const error = (value as { error?: unknown }).error
  if (!error || typeof error !== 'object') return undefined
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' ? message : undefined
}

function extractGeminiText(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const candidates = (data as { candidates?: unknown }).candidates
  if (!Array.isArray(candidates) || candidates.length === 0) return null
  const content = (candidates[0] as { content?: unknown }).content
  if (!content || typeof content !== 'object') return null
  const parts = (content as { parts?: unknown }).parts
  if (!Array.isArray(parts)) return null
  const chunks: string[] = []
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    const record = part as { text?: unknown; thought?: unknown }
    // Thinking models emit reasoning parts with thought: true alongside the
    // JSON answer. Concatenating them yields invalid JSON for parseVerdict.
    if (record.thought === true) continue
    if (typeof record.text === 'string') chunks.push(record.text)
  }
  const joined = chunks.join('').trim()
  return joined || null
}
