/** Shared docket snapshot shapes and POST-body validation (client + API). */

export const DOCKET_STORE_LIMIT = 50
export const DOCKET_LIST_LIMIT = 8
export const MAX_DOCKET_BODY_BYTES = 80_000
export const MAX_REASON_CHARS = 2_000
export const MAX_NOTES = 8
export const MAX_NOTE_CONTENT_CHARS = 8_000
export const MAX_TOTAL_NOTE_CHARS = 40_000
export const MAX_DISPLAY_NAME_CHARS = 200
export const MAX_PICTURE_URL_CHARS = 2_048
export const MAX_MODEL_CHARS = 120
export const MAX_SEEN_ON = 8
export const DEFAULT_DOCKET_CLIENT_DAILY = 50

export const HEX_64 = /^[0-9a-f]{64}$/i
export const HEX_128 = /^[0-9a-f]{128}$/i
export const CASE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const CLIENT_TOKEN_RE = /^[A-Za-z0-9._:-]{8,128}$/

const NSEC_TOKEN = /(?:nostr:)?nsec1[02-9ac-hj-np-z]+/gi

export type DocketVerdict = 'ASSHOLE' | 'NOT ASSHOLE'

export type DocketNote = {
  id: string
  pubkey: string
  created_at: number
  content: string
  sig?: string
  seenOn: string[]
}

export type DocketCaseInput = {
  pubkey: string
  displayName?: string
  picture?: string
  verdict: DocketVerdict
  confidence: number
  reason: string
  model: string
  notes: DocketNote[]
}

export type DocketCase = DocketCaseInput & {
  id: string
  judgedAt: string
}

export type DocketCard = Omit<DocketCase, 'notes'>

export type ParseDocketResult =
  | { ok: true; value: DocketCaseInput }
  | { ok: false; error: 'invalid_request' | 'payload_too_large' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function redactPrivateKeys(text: string): string {
  return text.replace(NSEC_TOKEN, '[REDACTED_NSEC]')
}

function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
    if (url.username || url.password) return false
    return true
  } catch {
    return false
  }
}

function isRelayUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'wss:' && url.protocol !== 'ws:') return false
    if (url.username || url.password) return false
    return true
  } catch {
    return false
  }
}

function parseSeenOn(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const relays: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!isRelayUrl(trimmed) || seen.has(trimmed)) continue
    seen.add(trimmed)
    relays.push(trimmed)
    if (relays.length >= MAX_SEEN_ON) break
  }
  return relays
}

function parseNote(raw: unknown): DocketNote | null {
  if (!isRecord(raw)) return null
  if (typeof raw.id !== 'string' || !HEX_64.test(raw.id)) return null
  if (typeof raw.pubkey !== 'string' || !HEX_64.test(raw.pubkey)) return null
  if (
    typeof raw.created_at !== 'number' ||
    !Number.isFinite(raw.created_at) ||
    !Number.isInteger(raw.created_at) ||
    raw.created_at < 0
  ) {
    return null
  }
  if (typeof raw.content !== 'string') return null
  if (raw.content.length > MAX_NOTE_CONTENT_CHARS) return null

  let sig: string | undefined
  if (raw.sig !== undefined) {
    if (typeof raw.sig !== 'string' || !HEX_128.test(raw.sig)) return null
    sig = raw.sig.toLowerCase()
  }

  return {
    id: raw.id.toLowerCase(),
    pubkey: raw.pubkey.toLowerCase(),
    created_at: raw.created_at,
    content: redactPrivateKeys(raw.content),
    ...(sig ? { sig } : {}),
    seenOn: parseSeenOn(raw.seenOn),
  }
}

export function parseDocketPost(raw: unknown): ParseDocketResult {
  if (!isRecord(raw)) return { ok: false, error: 'invalid_request' }

  if (typeof raw.pubkey !== 'string' || !HEX_64.test(raw.pubkey)) {
    return { ok: false, error: 'invalid_request' }
  }

  const verdict = raw.verdict
  if (verdict !== 'ASSHOLE' && verdict !== 'NOT ASSHOLE') {
    return { ok: false, error: 'invalid_request' }
  }

  const confidence = raw.confidence
  if (
    typeof confidence !== 'number' ||
    !Number.isFinite(confidence) ||
    !Number.isInteger(confidence) ||
    confidence < 50 ||
    confidence > 99
  ) {
    return { ok: false, error: 'invalid_request' }
  }

  if (typeof raw.reason !== 'string' || !raw.reason.trim()) {
    return { ok: false, error: 'invalid_request' }
  }
  if (raw.reason.length > MAX_REASON_CHARS) {
    return { ok: false, error: 'payload_too_large' }
  }

  if (!Array.isArray(raw.notes) || raw.notes.length === 0) {
    return { ok: false, error: 'invalid_request' }
  }
  if (raw.notes.length > MAX_NOTES) {
    return { ok: false, error: 'payload_too_large' }
  }

  const notes: DocketNote[] = []
  let noteChars = 0
  for (const item of raw.notes) {
    const note = parseNote(item)
    if (!note) return { ok: false, error: 'invalid_request' }
    noteChars += note.content.length
    if (noteChars > MAX_TOTAL_NOTE_CHARS) {
      return { ok: false, error: 'payload_too_large' }
    }
    notes.push(note)
  }

  let displayName: string | undefined
  if (raw.displayName !== undefined) {
    if (typeof raw.displayName !== 'string') {
      return { ok: false, error: 'invalid_request' }
    }
    const trimmed = raw.displayName.trim()
    if (trimmed.length > MAX_DISPLAY_NAME_CHARS) {
      return { ok: false, error: 'payload_too_large' }
    }
    if (trimmed) displayName = trimmed
  }

  let picture: string | undefined
  if (raw.picture !== undefined && raw.picture !== null && raw.picture !== '') {
    if (typeof raw.picture !== 'string') {
      return { ok: false, error: 'invalid_request' }
    }
    const trimmed = raw.picture.trim()
    if (
      trimmed &&
      trimmed.length <= MAX_PICTURE_URL_CHARS &&
      isSafeHttpUrl(trimmed)
    ) {
      picture = trimmed
    }
  }

  let model = ''
  if (raw.model !== undefined) {
    if (typeof raw.model !== 'string') {
      return { ok: false, error: 'invalid_request' }
    }
    if (raw.model.length > MAX_MODEL_CHARS) {
      return { ok: false, error: 'payload_too_large' }
    }
    model = raw.model.trim()
  }

  return {
    ok: true,
    value: {
      pubkey: raw.pubkey.toLowerCase(),
      ...(displayName ? { displayName } : {}),
      ...(picture ? { picture } : {}),
      verdict,
      confidence,
      reason: raw.reason.trim(),
      model,
      notes,
    },
  }
}

export function toCardSummary(snapshot: DocketCase): DocketCard {
  const { notes: _notes, ...card } = snapshot
  return card
}
