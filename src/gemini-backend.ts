import {
  makeInferenceError,
  type InferenceBackend,
  type InferenceRequest,
} from 'ipa-tools'

export const GEMINI_CONSENT_KEY = 'assholenet.geminiConsent'
export const GEMINI_CLIENT_TOKEN_KEY = 'assholenet.clientToken'
export const GEMINI_BACKEND_ID = 'vercelGemini'

/** Align with server DEFAULT_CLIENT_DAILY in api/judge.ts. */
const CLIENT_SOFT_DAILY = 20
const CLIENT_SOFT_COUNT_KEY = 'assholenet.clientSoftCount'

export function hasGeminiConsent(): boolean {
  try {
    return sessionStorage.getItem(GEMINI_CONSENT_KEY) === '1'
  } catch {
    return false
  }
}

export function setGeminiConsent(ok: boolean): void {
  try {
    if (ok) sessionStorage.setItem(GEMINI_CONSENT_KEY, '1')
    else sessionStorage.removeItem(GEMINI_CONSENT_KEY)
  } catch {
    // ignore quota / private mode
  }
}

export function getOrCreateClientToken(): string {
  try {
    const existing = localStorage.getItem(GEMINI_CLIENT_TOKEN_KEY)
    if (existing) return existing
    const token = crypto.randomUUID()
    localStorage.setItem(GEMINI_CLIENT_TOKEN_KEY, token)
    return token
  } catch {
    return crypto.randomUUID()
  }
}

function softClientCount(): number {
  try {
    const day = new Date().toISOString().slice(0, 10)
    const raw = localStorage.getItem(CLIENT_SOFT_COUNT_KEY)
    if (!raw) return 0
    const parsed = JSON.parse(raw) as { day: string; count: number }
    if (!parsed || parsed.day !== day) return 0
    return typeof parsed.count === 'number' ? parsed.count : 0
  } catch {
    return 0
  }
}

function softClientAllowed(): boolean {
  return softClientCount() < CLIENT_SOFT_DAILY
}

function bumpSoftClientCount(): void {
  try {
    const day = new Date().toISOString().slice(0, 10)
    const count = softClientCount() + 1
    localStorage.setItem(
      CLIENT_SOFT_COUNT_KEY,
      JSON.stringify({ day, count }),
    )
  } catch {
    // ignore
  }
}

export function createVercelGeminiBackend(): InferenceBackend {
  return {
    id: GEMINI_BACKEND_ID,
    getFeatures() {
      return { toolCalling: false }
    },
    async probe() {
      try {
        const res = await fetch('/api/judge', { method: 'GET' })
        if (res.ok) return 'available'
        return 'unavailable'
      } catch {
        return 'unavailable'
      }
    },
    async create() {
      return {
        getFeatures() {
          return { toolCalling: false }
        },
        async *request(req: InferenceRequest) {
          if (!hasGeminiConsent()) {
            throw makeInferenceError(
              'permission_denied',
              'Hosted Gemini consent required',
            )
          }
          if (!softClientAllowed()) {
            throw makeInferenceError('unavailable', 'client_limit')
          }

          const res = await fetch('/api/judge', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-AssholeNet-Client': getOrCreateClientToken(),
            },
            body: JSON.stringify({
              messages: req.messages.map((m) => ({
                role: m.role,
                content: 'content' in m ? m.content : null,
              })),
            }),
            signal: req.signal,
          })

          let data: unknown = null
          try {
            data = await res.json()
          } catch {
            data = null
          }

          const errorCode =
            data &&
            typeof data === 'object' &&
            typeof (data as { error?: unknown }).error === 'string'
              ? (data as { error: string }).error
              : null

          if (errorCode === 'client_limit') {
            throw makeInferenceError('unavailable', 'client_limit')
          }
          if (res.status === 429 || errorCode === 'quota_exhausted') {
            throw makeInferenceError('unavailable', 'quota_exhausted')
          }
          if (res.status === 503 || errorCode === 'disabled') {
            throw makeInferenceError('unavailable', 'Hosted Gemini disabled')
          }
          if (!res.ok) {
            throw makeInferenceError(
              'provider_error',
              `judge failed: ${res.status}`,
            )
          }

          const record = data as { content?: unknown; model?: unknown }
          const content =
            typeof record.content === 'string' ? record.content : ''
          const model =
            typeof record.model === 'string' && record.model.trim()
              ? record.model.trim()
              : 'gemini-3.5-flash'

          if (!content.trim()) {
            throw makeInferenceError('provider_error', 'empty Gemini response')
          }

          bumpSoftClientCount()

          yield { type: 'accepted' as const }
          yield {
            type: 'done' as const,
            model,
            message: { role: 'assistant' as const, content },
          }
        },
      }
    },
  }
}
