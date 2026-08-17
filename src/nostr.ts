import { nip19, SimplePool, type Event, type Filter } from 'nostr-tools'
import { isNip05, queryProfile } from 'nostr-tools/nip05'

export type NostrIdentity = {
  pubkey: string
  relayHints: string[]
}

export const DEFAULT_RELAYS = [
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://pyramid.fiatjaf.com',
  'wss://relay.ditto.pub',
]

/** Popular but rate-limits aggressively — only hit as a last resort for notes. */
export const FALLBACK_RELAYS = ['wss://relay.damus.io']

/** Relays that often index profiles / NIP-65 lists even when notes live elsewhere. */
const DISCOVERY_RELAYS = ['wss://purplepag.es']

export const FETCH_LIMIT = 20
export const ANALYZE_LIMIT = 8
export const MIN_NOTES = 3
export const RELAY_MAX_WAIT_MS = 4500

const HEX_PUBKEY = /^[0-9a-f]{64}$/i
const URL_ONLY = /^(https?:\/\/\S+|www\.\S+)$/i
const MEDIA_EXT = /\.(png|jpe?g|gif|webp|mp4|mov|webm)(\?\S*)?$/i

export class IdentityError extends Error {
  constructor(message = 'INVALID NOSTR IDENTITY') {
    super(message)
    this.name = 'IdentityError'
  }
}

export class Nip05Error extends Error {
  constructor(message = 'NIP-05 NOT FOUND') {
    super(message)
    this.name = 'Nip05Error'
  }
}

export class PrivateKeyError extends Error {
  constructor(
    message = 'That looks like a private key (nsec). Never paste an nsec here.',
  ) {
    super(message)
    this.name = 'PrivateKeyError'
  }
}

/** Bech32 nsec tokens, including optional nostr: prefix. */
const NSEC_TOKEN = /(?:nostr:)?nsec1[02-9ac-hj-np-z]+/gi

export function looksLikePrivateKey(raw: string): boolean {
  const input = raw.trim()
  if (!input) return false

  let code = input
  if (code.toLowerCase().startsWith('nostr:')) {
    code = code.slice(6)
  }

  if (/^nsec1[02-9ac-hj-np-z]+$/i.test(code)) return true

  try {
    return nip19.decode(code).type === 'nsec'
  } catch {
    return false
  }
}

export function redactPrivateKeys(text: string): string {
  return text.replace(NSEC_TOKEN, '[REDACTED_NSEC]')
}

function parseLocalIdentity(raw: string): NostrIdentity | null {
  const input = raw.trim()
  if (!input) return null

  if (HEX_PUBKEY.test(input)) {
    return { pubkey: input.toLowerCase(), relayHints: [] }
  }

  let code = input
  if (code.toLowerCase().startsWith('nostr:')) {
    code = code.slice(6)
  }

  try {
    const decoded = nip19.decode(code)
    if (decoded.type === 'nsec') {
      throw new PrivateKeyError()
    }
    if (decoded.type === 'npub') {
      return { pubkey: decoded.data, relayHints: [] }
    }
    if (decoded.type === 'nprofile') {
      return {
        pubkey: decoded.data.pubkey,
        relayHints: (decoded.data.relays ?? []).filter((r) =>
          r.startsWith('wss://'),
        ),
      }
    }
  } catch (error) {
    if (error instanceof PrivateKeyError) throw error
    // fall through
  }

  return null
}

export async function resolveIdentity(raw: string): Promise<NostrIdentity> {
  const input = raw.trim()
  if (!input) throw new IdentityError()

  if (looksLikePrivateKey(input)) {
    throw new PrivateKeyError()
  }

  const local = parseLocalIdentity(input)
  if (local) return local

  if (isNip05(input)) {
    let profile
    try {
      profile = await queryProfile(input)
    } catch {
      throw new Nip05Error(
        'Could not look up that NIP-05 address. Check the spelling or try again.',
      )
    }

    if (!profile?.pubkey) {
      throw new Nip05Error(
        'No pubkey is registered for that NIP-05 address.',
      )
    }

    return {
      pubkey: profile.pubkey,
      relayHints: (profile.relays ?? []).filter((r) => r.startsWith('wss://')),
    }
  }

  throw new IdentityError()
}

function dedupeRelays(urls: string[]): string[] {
  const seen = new Set<string>()
  const relays: string[] = []
  for (const url of urls) {
    if (!url.startsWith('wss://') || seen.has(url)) continue
    seen.add(url)
    relays.push(url)
  }
  return relays
}

export function resolveRelays(identity: NostrIdentity): string[] {
  return dedupeRelays([...identity.relayHints, ...DEFAULT_RELAYS])
}

/** NIP-65 kind 10002 — prefer write (outbox) relays for authored notes. */
export function parseRelayListEvent(event: Event): string[] {
  const write: string[] = []
  const read: string[] = []

  for (const tag of event.tags) {
    if (tag[0] !== 'r' || typeof tag[1] !== 'string') continue
    const url = tag[1].trim()
    if (!url.startsWith('wss://')) continue

    if (tag[2] === 'read') read.push(url)
    else write.push(url)
  }

  return dedupeRelays([...write, ...read])
}

async function fetchOutboxRelays(
  identity: NostrIdentity,
  knownRelays: string[],
): Promise<string[]> {
  const discovery = dedupeRelays([
    ...knownRelays,
    ...identity.relayHints,
    ...DISCOVERY_RELAYS,
  ])

  const events = await queryRelays(discovery, {
    kinds: [10002],
    authors: [identity.pubkey],
    limit: 1,
  })

  const latest = events.sort((a, b) => b.created_at - a.created_at)[0]
  if (!latest) return []
  return parseRelayListEvent(latest)
}

function isUsefulNote(event: Event): boolean {
  const text = event.content.trim()
  if (!text) return false
  if (URL_ONLY.test(text)) return false
  if (MEDIA_EXT.test(text)) return false

  const withoutUrls = text
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!withoutUrls) return false

  const words = withoutUrls.split(/\s+/).filter(Boolean)
  if (words.length <= 2 && withoutUrls.length < 20) return false

  return true
}

export function selectNotes(events: Event[]): Event[] {
  const byId = new Map<string, Event>()
  for (const event of events) {
    if (!byId.has(event.id)) byId.set(event.id, event)
  }

  return [...byId.values()]
    .sort((a, b) => b.created_at - a.created_at)
    .filter(isUsefulNote)
    .slice(0, ANALYZE_LIMIT)
}

export type ProfileInfo = {
  picture?: string
  displayName?: string
}

export type Kind0Profile = ProfileInfo & {
  nip05?: string
}

function parseProfileContent(content: string): Kind0Profile {
  try {
    const data = JSON.parse(content) as Record<string, unknown>
    const picture =
      typeof data.picture === 'string' ? data.picture.trim() : ''
    const displayName =
      (typeof data.display_name === 'string' && data.display_name.trim()) ||
      (typeof data.name === 'string' && data.name.trim()) ||
      ''
    const nip05 =
      typeof data.nip05 === 'string' ? data.nip05.trim() : ''

    return {
      picture: isSafeHttpUrl(picture) ? picture : undefined,
      displayName: displayName || undefined,
      nip05: nip05 || undefined,
    }
  } catch {
    return {}
  }
}

export function parseKind0Profile(event: Event): Kind0Profile {
  return parseProfileContent(event.content)
}

function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
    if (url.username || url.password) return false
    return !isPrivateOrLocalHostname(url.hostname)
  } catch {
    return false
  }
}

/** Reject hosts that would make the browser hit the visitor's local/LAN network. */
function isPrivateOrLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === 'local' || host.endsWith('.local')) return true
  if (host === '::1' || host === '0.0.0.0' || host === '::') return true

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number)
    if (octets.some((n) => n > 255)) return true
    const [a, b] = octets
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    return false
  }

  if (host.includes(':')) {
    if (
      host.startsWith('fe80:') ||
      host.startsWith('fc') ||
      host.startsWith('fd')
    ) {
      return true
    }
    const mapped = /:ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host)
    if (mapped) return isPrivateOrLocalHostname(mapped[1])
  }

  return false
}

async function queryRelays(relays: string[], filter: Filter): Promise<Event[]> {
  const pool = new SimplePool()

  try {
    // Query each relay independently so one dead endpoint cannot fail the rest.
    const settled = await Promise.allSettled(
      relays.map((relay) =>
        pool.querySync([relay], filter, { maxWait: RELAY_MAX_WAIT_MS }),
      ),
    )

    const events: Event[] = []
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        events.push(...result.value)
      }
    }
    return events
  } catch {
    return []
  } finally {
    pool.destroy()
  }
}

export async function fetchRecentNotes(
  identity: NostrIdentity,
): Promise<Event[]> {
  const filter: Filter = {
    kinds: [1],
    authors: [identity.pubkey],
    limit: FETCH_LIMIT,
  }

  const tried = new Set<string>()
  let events: Event[] = []

  const queryUntried = async (relays: string[]) => {
    const fresh = relays.filter((url) => !tried.has(url))
    for (const url of fresh) tried.add(url)
    if (fresh.length === 0) return
    const more = await queryRelays(fresh, filter)
    events = [...events, ...more]
  }

  // 1. Identity hints + default relays (Damus excluded from defaults).
  await queryUntried(resolveRelays(identity))
  let notes = selectNotes(events)
  if (notes.length >= MIN_NOTES) return notes

  // 2. User NIP-65 outbox relays (may include Damus if they publish there).
  const outboxRelays = await fetchOutboxRelays(identity, [...tried])
  await queryUntried(outboxRelays)
  notes = selectNotes(events)
  if (notes.length >= MIN_NOTES) return notes

  // 3. Last resort: Damus (skipped if already tried via hints/outbox).
  await queryUntried(FALLBACK_RELAYS)
  return selectNotes(events)
}

export async function fetchProfile(
  identity: NostrIdentity,
): Promise<ProfileInfo> {
  try {
    const events = await queryRelays(resolveRelays(identity), {
      kinds: [0],
      authors: [identity.pubkey],
      limit: 1,
    })
    const event = events.sort((a, b) => b.created_at - a.created_at)[0]
    if (!event) return {}
    return parseKind0Profile(event)
  } catch {
    return {}
  }
}

export function formatNotesForPrompt(notes: Event[]): string {
  return notes
    .map((note, index) => {
      const date = new Date(note.created_at * 1000).toISOString().slice(0, 10)
      return `POST ${index + 1}\n${date}\n${redactPrivateKeys(note.content)}`
    })
    .join('\n\n')
}
