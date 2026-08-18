import { describe, expect, it } from 'vitest'
import {
  MAX_NOTE_CONTENT_CHARS,
  MAX_NOTES,
  MAX_REASON_CHARS,
  parseDocketPost,
  toCardSummary,
  type DocketCase,
} from './docket-payload'

const PUBKEY = 'a'.repeat(64)
const NOTE_ID = 'b'.repeat(64)
const SIG = 'c'.repeat(128)

function validNote(overrides: Record<string, unknown> = {}) {
  return {
    id: NOTE_ID,
    pubkey: PUBKEY,
    created_at: 1_700_000_000,
    content: 'this is a real note with enough words',
    sig: SIG,
    seenOn: ['wss://nos.lol'],
    ...overrides,
  }
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    pubkey: PUBKEY,
    displayName: 'Alice',
    picture: 'https://example.com/alice.png',
    verdict: 'NOT ASSHOLE',
    confidence: 81,
    reason: 'Mostly wholesome posting with the occasional joke.',
    model: 'gemma-4-31b-it',
    notes: [validNote()],
    ...overrides,
  }
}

describe('parseDocketPost', () => {
  it('accepts a complete snapshot payload', () => {
    const parsed = parseDocketPost(validBody())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.pubkey).toBe(PUBKEY)
    expect(parsed.value.displayName).toBe('Alice')
    expect(parsed.value.picture).toBe('https://example.com/alice.png')
    expect(parsed.value.notes).toHaveLength(1)
    expect(parsed.value.notes[0]?.seenOn).toEqual(['wss://nos.lol'])
  })

  it('lowercases hex ids and pubkeys', () => {
    const parsed = parseDocketPost(
      validBody({
        pubkey: 'AB'.repeat(32),
        notes: [validNote({ id: 'CD'.repeat(32), pubkey: 'EF'.repeat(32) })],
      }),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.pubkey).toBe('ab'.repeat(32))
    expect(parsed.value.notes[0]?.id).toBe('cd'.repeat(32))
    expect(parsed.value.notes[0]?.pubkey).toBe('ef'.repeat(32))
  })

  it('strips unsafe picture URLs instead of rejecting the case', () => {
    const parsed = parseDocketPost(
      validBody({ picture: 'javascript:alert(1)' }),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.picture).toBeUndefined()
  })

  it('redacts nsec tokens in note content', () => {
    const parsed = parseDocketPost(
      validBody({
        notes: [
          validNote({
            content: 'do not use nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq please',
          }),
        ],
      }),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.notes[0]?.content).toContain('[REDACTED_NSEC]')
    expect(parsed.value.notes[0]?.content).not.toMatch(/nsec1/)
  })

  it('rejects invalid verdicts and short pubkeys', () => {
    expect(parseDocketPost(validBody({ verdict: 'MAYBE' })).ok).toBe(false)
    expect(parseDocketPost(validBody({ pubkey: 'abc' })).ok).toBe(false)
    expect(parseDocketPost(validBody({ confidence: 40 })).ok).toBe(false)
    expect(parseDocketPost(validBody({ notes: [] })).ok).toBe(false)
  })

  it('rejects oversized reasons and note counts', () => {
    const longReason = parseDocketPost(
      validBody({ reason: 'x'.repeat(MAX_REASON_CHARS + 1) }),
    )
    expect(longReason).toEqual({ ok: false, error: 'payload_too_large' })

    const tooMany = parseDocketPost(
      validBody({
        notes: Array.from({ length: MAX_NOTES + 1 }, () => validNote()),
      }),
    )
    expect(tooMany).toEqual({ ok: false, error: 'payload_too_large' })

    const hugeNote = parseDocketPost(
      validBody({
        notes: [validNote({ content: 'n'.repeat(MAX_NOTE_CONTENT_CHARS + 1) })],
      }),
    )
    expect(hugeNote.ok).toBe(false)
  })

  it('drops extra fields and ignores client ids', () => {
    const parsed = parseDocketPost(
      validBody({ id: 'client-supplied', judgedAt: '2020-01-01T00:00:00.000Z' }),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value).not.toHaveProperty('id')
    expect(parsed.value).not.toHaveProperty('judgedAt')
  })
})

describe('toCardSummary', () => {
  it('omits note bodies from list payloads', () => {
    const snapshot: DocketCase = {
      id: '11111111-1111-4111-8111-111111111111',
      judgedAt: '2026-08-18T19:00:00.000Z',
      pubkey: PUBKEY,
      displayName: 'Alice',
      verdict: 'ASSHOLE',
      confidence: 90,
      reason: 'Relentless reply-guy energy.',
      model: 'on-device',
      notes: [
        {
          id: NOTE_ID,
          pubkey: PUBKEY,
          created_at: 1_700_000_000,
          content: 'secret note body',
          seenOn: ['wss://nos.lol'],
        },
      ],
    }

    const card = toCardSummary(snapshot)
    expect(card).not.toHaveProperty('notes')
    expect(card.reason).toBe(snapshot.reason)
    expect(card.id).toBe(snapshot.id)
  })
})
