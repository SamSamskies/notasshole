import { describe, expect, it } from 'vitest'
import { nip19 } from 'nostr-tools'
import {
  isExcludedPubkey,
  parseExcludedPubkeys,
} from './docket-exclude'

const HEX_A = 'a'.repeat(64)
const HEX_B = 'b'.repeat(64)
const NPUB_A = nip19.npubEncode(HEX_A)

describe('parseExcludedPubkeys', () => {
  it('accepts comma-delimited npubs and hex, ignoring junk', () => {
    const excluded = parseExcludedPubkeys(
      ` ${NPUB_A}, ${HEX_B.toUpperCase()}, not-an-id, `,
    )
    expect(excluded).toEqual(new Set([HEX_A, HEX_B]))
  })

  it('accepts nostr: prefixed npubs', () => {
    expect(parseExcludedPubkeys(`nostr:${NPUB_A}`)).toEqual(new Set([HEX_A]))
  })

  it('returns an empty set for blank input', () => {
    expect(parseExcludedPubkeys('')).toEqual(new Set())
    expect(parseExcludedPubkeys('  ,  ')).toEqual(new Set())
  })
})

describe('isExcludedPubkey', () => {
  it('matches case-insensitively against a prepared set', () => {
    const excluded = parseExcludedPubkeys(NPUB_A)
    expect(isExcludedPubkey(HEX_A.toUpperCase(), excluded)).toBe(true)
    expect(isExcludedPubkey(HEX_B, excluded)).toBe(false)
  })
})
