import { nip19 } from 'nostr-tools'
import { getOrCreateClientToken } from './gemini-backend'
import type { Verdict } from './inference'
import type { LocatedEvent, ProfileInfo } from './nostr'
import {
  CASE_ID_RE,
  MAX_NOTES,
  type DocketCard,
  type DocketCase,
  type DocketNote,
} from './docket-payload'

export type { DocketCard, DocketCase, DocketNote }

export function docketIdFromSearch(search = location.search): string | null {
  const id = new URLSearchParams(search).get('docket')
  if (!id || !CASE_ID_RE.test(id)) return null
  return id
}

export function shortNpub(pubkey: string): string {
  try {
    const npub = nip19.npubEncode(pubkey)
    return `${npub.slice(0, 12)}…${npub.slice(-4)}`
  } catch {
    return `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`
  }
}

export function npubForPubkey(pubkey: string): string {
  try {
    return nip19.npubEncode(pubkey)
  } catch {
    return pubkey
  }
}

export function docketSubjectName(card: {
  displayName?: string
  pubkey: string
}): string {
  const name = card.displayName?.trim()
  return name || shortNpub(card.pubkey)
}

export function reasonSnippet(text: string, max = 140): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  const cut = trimmed.slice(0, max)
  const space = cut.lastIndexOf(' ')
  const clipped = (space > max * 0.4 ? cut.slice(0, space) : cut).trimEnd()
  return `${clipped}…`
}

export function formatRelativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return ''
  const sec = Math.round((now - then) / 1000)
  if (sec < 45) return 'just now'
  if (sec < 90) return '1 minute ago'
  if (sec < 3600) return `${Math.round(sec / 60)} minutes ago`
  if (sec < 5400) return '1 hour ago'
  if (sec < 86400) return `${Math.round(sec / 3600)} hours ago`
  if (sec < 172800) return 'yesterday'
  if (sec < 86400 * 30) return `${Math.round(sec / 86400)} days ago`
  return new Date(then).toISOString().slice(0, 10)
}

export function notesFromSnapshot(notes: DocketNote[]): LocatedEvent[] {
  return notes.map((note) => ({
    id: note.id,
    pubkey: note.pubkey,
    created_at: note.created_at,
    kind: 1,
    tags: [],
    content: note.content,
    sig: note.sig ?? '',
    seenOn: note.seenOn,
  }))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

async function readJson(res: Response): Promise<unknown> {
  const type = res.headers.get('content-type') ?? ''
  if (!type.includes('application/json')) return undefined
  try {
    return await res.json()
  } catch {
    return undefined
  }
}

function readCard(raw: unknown): DocketCard | undefined {
  if (!isRecord(raw)) return undefined
  if (typeof raw.id !== 'string' || !CASE_ID_RE.test(raw.id)) return undefined
  if (typeof raw.pubkey !== 'string') return undefined
  if (raw.verdict !== 'ASSHOLE' && raw.verdict !== 'NOT ASSHOLE') {
    return undefined
  }
  if (typeof raw.confidence !== 'number') return undefined
  if (typeof raw.reason !== 'string') return undefined
  if (typeof raw.judgedAt !== 'string') return undefined
  const card: DocketCard = {
    id: raw.id,
    judgedAt: raw.judgedAt,
    pubkey: raw.pubkey,
    verdict: raw.verdict,
    confidence: raw.confidence,
    reason: raw.reason,
    model: typeof raw.model === 'string' ? raw.model : '',
  }
  if (typeof raw.displayName === 'string' && raw.displayName.trim()) {
    card.displayName = raw.displayName.trim()
  }
  if (typeof raw.picture === 'string' && raw.picture.trim()) {
    card.picture = raw.picture.trim()
  }
  return card
}

function readNote(raw: unknown): DocketNote | undefined {
  if (!isRecord(raw)) return undefined
  if (typeof raw.id !== 'string' || typeof raw.pubkey !== 'string') {
    return undefined
  }
  if (typeof raw.created_at !== 'number' || typeof raw.content !== 'string') {
    return undefined
  }
  const seenOn = Array.isArray(raw.seenOn)
    ? raw.seenOn.filter((item): item is string => typeof item === 'string')
    : []
  const note: DocketNote = {
    id: raw.id,
    pubkey: raw.pubkey,
    created_at: raw.created_at,
    content: raw.content,
    seenOn,
  }
  if (typeof raw.sig === 'string' && raw.sig) note.sig = raw.sig
  return note
}

function readSnapshot(raw: unknown): DocketCase | undefined {
  const card = readCard(raw)
  if (!card || !isRecord(raw) || !Array.isArray(raw.notes)) return undefined
  const notes: DocketNote[] = []
  for (const item of raw.notes) {
    const note = readNote(item)
    if (!note) return undefined
    notes.push(note)
  }
  if (notes.length === 0) return undefined
  return { ...card, notes }
}

export async function fetchDocketList(): Promise<DocketCard[] | undefined> {
  try {
    const res = await fetch('/api/docket')
    if (!res.ok) return undefined
    const data = await readJson(res)
    if (!isRecord(data) || !Array.isArray(data.cases)) return undefined
    const cards: DocketCard[] = []
    for (const item of data.cases) {
      const card = readCard(item)
      if (card) cards.push(card)
    }
    return cards
  } catch {
    return undefined
  }
}

export async function fetchDocketCase(
  id: string,
): Promise<DocketCase | undefined> {
  if (!CASE_ID_RE.test(id)) return undefined
  try {
    const res = await fetch(`/api/docket/${encodeURIComponent(id)}`)
    if (!res.ok) return undefined
    return readSnapshot(await readJson(res))
  } catch {
    return undefined
  }
}

export async function publishDocketCase(input: {
  pubkey: string
  profile: ProfileInfo
  verdict: Verdict
  notes: LocatedEvent[]
}): Promise<DocketCard | undefined> {
  try {
    const res = await fetch('/api/docket', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AssholeNet-Client': getOrCreateClientToken(),
      },
      body: JSON.stringify({
        pubkey: input.pubkey,
        displayName: input.profile.displayName,
        picture: input.profile.picture,
        verdict: input.verdict.verdict,
        confidence: input.verdict.confidence,
        reason: input.verdict.reason,
        model: input.verdict.model,
        notes: input.notes.slice(0, MAX_NOTES).map((note) => ({
          id: note.id,
          pubkey: note.pubkey,
          created_at: note.created_at,
          content: note.content,
          ...(note.sig ? { sig: note.sig } : {}),
          seenOn: note.seenOn,
        })),
      }),
    })
    if (!res.ok) return undefined
    const data = await readJson(res)
    if (!isRecord(data)) return undefined
    return readCard(data.case)
  } catch {
    return undefined
  }
}
