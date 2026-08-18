import { describe, expect, it } from 'vitest'
import { nip19 } from 'nostr-tools'
import {
  docketIdFromSearch,
  docketSubjectName,
  formatRelativeTime,
  notesFromSnapshot,
  reasonSnippet,
  shortNpub,
} from './docket'

const PUBKEY = 'a'.repeat(64)

describe('docket display helpers', () => {
  it('shortens an npub and falls back to the display name', () => {
    const npub = nip19.npubEncode(PUBKEY)
    expect(shortNpub(PUBKEY)).toBe(`${npub.slice(0, 12)}…${npub.slice(-4)}`)
    expect(docketSubjectName({ pubkey: PUBKEY, displayName: 'Alice' })).toBe(
      'Alice',
    )
    expect(docketSubjectName({ pubkey: PUBKEY })).toBe(shortNpub(PUBKEY))
  })

  it('clips reason snippets on a word boundary', () => {
    const text = 'Alpha beta gamma delta epsilon zeta eta theta iota kappa'
    expect(reasonSnippet(text, 24)).toBe('Alpha beta gamma delta…')
    expect(reasonSnippet('short')).toBe('short')
  })

  it('formats relative times', () => {
    const now = Date.parse('2026-08-18T19:00:00.000Z')
    expect(formatRelativeTime('2026-08-18T18:59:50.000Z', now)).toBe('just now')
    expect(formatRelativeTime('2026-08-18T18:50:00.000Z', now)).toBe(
      '10 minutes ago',
    )
    expect(formatRelativeTime('2026-08-18T16:00:00.000Z', now)).toBe(
      '3 hours ago',
    )
    expect(formatRelativeTime('2026-08-17T19:00:00.000Z', now)).toBe('yesterday')
  })

  it('reads a docket id from the query string', () => {
    const id = '11111111-1111-4111-8111-111111111111'
    expect(docketIdFromSearch(`?docket=${id}`)).toBe(id)
    expect(docketIdFromSearch('?docket=nope')).toBeNull()
    expect(docketIdFromSearch('')).toBeNull()
  })

  it('rebuilds located notes for Open in…', () => {
    const notes = notesFromSnapshot([
      {
        id: 'b'.repeat(64),
        pubkey: PUBKEY,
        created_at: 1_700_000_000,
        content: 'hello',
        seenOn: ['wss://nos.lol'],
      },
    ])
    expect(notes[0]).toMatchObject({
      kind: 1,
      tags: [],
      content: 'hello',
      seenOn: ['wss://nos.lol'],
    })
  })
})
