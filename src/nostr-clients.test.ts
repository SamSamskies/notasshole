import { describe, expect, it } from 'vitest'
import { nip19 } from 'nostr-tools'
import type { LocatedEvent } from './nostr'
import { selectNotes } from './nostr'
import {
  clientHref,
  clientsForPlatform,
  detectClientPlatform,
  encodeNevent,
  isWebClientHref,
  MAX_RELAY_HINTS,
} from './nostr-clients'

const PUBKEY = 'a'.repeat(64)
const NOTE_ID = 'b'.repeat(64)

function locatedNote(
  overrides: Partial<LocatedEvent> = {},
): LocatedEvent {
  return {
    id: NOTE_ID,
    pubkey: PUBKEY,
    created_at: 1_700_000_000,
    kind: 1,
    tags: [],
    content: 'this is a real note with enough words',
    sig: 'c'.repeat(128),
    seenOn: ['wss://nos.lol'],
    ...overrides,
  }
}

describe('detectClientPlatform', () => {
  it('detects android, ios, and desktop web', () => {
    expect(
      detectClientPlatform(
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36',
      ),
    ).toBe('android')
    expect(
      detectClientPlatform(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      ),
    ).toBe('ios')
    expect(
      detectClientPlatform(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120',
      ),
    ).toBe('web')
  })
})

describe('clientsForPlatform', () => {
  it('always includes the native handler, jumble, primal, and njump', () => {
    const names = clientsForPlatform('web').map((client) => client.name)
    expect(names[0]).toBe('Your default app')
    expect(names).toContain('Jumble')
    expect(names).toContain('Primal')
    expect(names).toContain('njump')
  })

  it('shows ios apps only on ios, and prefers the native primal link', () => {
    const ios = clientsForPlatform('ios')
    const web = clientsForPlatform('web')
    expect(ios.map((c) => c.id)).toContain('damus')
    expect(web.map((c) => c.id)).not.toContain('damus')
    expect(ios.filter((c) => c.name === 'Primal')).toEqual([
      expect.objectContaining({ id: 'primal-ios' }),
    ])
  })

  it('shows android apps only on android', () => {
    const android = clientsForPlatform('android').map((c) => c.id)
    const web = clientsForPlatform('web').map((c) => c.id)
    expect(android).toContain('amethyst')
    expect(android).toContain('primal-android')
    expect(web).not.toContain('amethyst')
  })
})

describe('clientHref', () => {
  it('substitutes the nevent into web and native templates', () => {
    const jumble = clientsForPlatform('web').find((c) => c.id === 'jumble')
    const native = clientsForPlatform('web').find((c) => c.id === 'native')
    expect(jumble).toBeDefined()
    expect(native).toBeDefined()
    expect(clientHref(jumble!, 'nevent1abc')).toBe(
      'https://jumble.social/nevent1abc',
    )
    expect(clientHref(native!, 'nevent1abc')).toBe('nostr:nevent1abc')
    expect(isWebClientHref('https://jumble.social/nevent1abc')).toBe(true)
    expect(isWebClientHref('nostr:nevent1abc')).toBe(false)
  })
})

describe('encodeNevent', () => {
  it('encodes id, author, kind, and relay hints', () => {
    const encoded = encodeNevent(
      locatedNote({
        seenOn: ['wss://nos.lol', 'wss://relay.primal.net'],
      }),
    )
    const decoded = nip19.decode(encoded)
    expect(decoded.type).toBe('nevent')
    if (decoded.type !== 'nevent') return
    expect(decoded.data.id).toBe(NOTE_ID)
    expect(decoded.data.author).toBe(PUBKEY)
    expect(decoded.data.kind).toBe(1)
    expect(decoded.data.relays).toEqual([
      'wss://nos.lol',
      'wss://relay.primal.net',
    ])
  })

  it('caps relay hints so the bech32 string stays short', () => {
    const relays = [
      'wss://a.example',
      'wss://b.example',
      'wss://c.example',
      'wss://d.example',
    ]
    const decoded = nip19.decode(encodeNevent(locatedNote({ seenOn: relays })))
    expect(decoded.type).toBe('nevent')
    if (decoded.type !== 'nevent') return
    expect(decoded.data.relays).toEqual(relays.slice(0, MAX_RELAY_HINTS))
  })
})

describe('selectNotes relay hints', () => {
  it('merges seenOn relays when the same note arrives from two relays', () => {
    const first = locatedNote({
      content: 'enough words to count as a real note here',
      seenOn: ['wss://nos.lol'],
    })
    const second = locatedNote({
      content: 'enough words to count as a real note here',
      created_at: 1_700_000_100,
      seenOn: ['wss://relay.primal.net'],
    })
    const notes = selectNotes([first, second])
    expect(notes).toHaveLength(1)
    expect(notes[0].seenOn).toEqual([
      'wss://nos.lol',
      'wss://relay.primal.net',
    ])
  })
})
