import { nip19 } from 'nostr-tools'
import { HEX_64 } from './docket-payload'

/** Comma-delimited npub, nprofile, nostr: prefix, or 64-char hex. */
export function parseExcludedPubkeys(raw: string): Set<string> {
  const excluded = new Set<string>()
  for (const part of raw.split(',')) {
    const hex = decodePubkeyToken(part.trim())
    if (hex) excluded.add(hex)
  }
  return excluded
}

export function isExcludedPubkey(
  pubkey: string,
  excluded: Set<string>,
): boolean {
  return excluded.has(pubkey.toLowerCase())
}

export function decodePubkeyToken(token: string): string | undefined {
  if (!token) return undefined
  if (HEX_64.test(token)) return token.toLowerCase()

  let code = token
  if (code.toLowerCase().startsWith('nostr:')) code = code.slice(6)

  try {
    const decoded = nip19.decode(code)
    if (decoded.type === 'npub') return decoded.data
    if (decoded.type === 'nprofile') return decoded.data.pubkey
  } catch {
    return undefined
  }
  return undefined
}
