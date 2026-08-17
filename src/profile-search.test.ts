import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearProfileSearchCache,
  readProfileSearchCacheForTest,
  SEARCH_CACHE_TTL_MS,
  SEARCH_RESULT_LIMIT,
  searchProfiles,
  shouldSuggestProfiles,
  storeProfileSearchCacheForTest,
} from './profile-search'

const querySync = vi.fn()

vi.mock('nostr-tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('nostr-tools')>()
  return {
    ...actual,
    SimplePool: vi.fn(function MockSimplePool(this: {
      querySync: typeof querySync
      destroy: ReturnType<typeof vi.fn>
    }) {
      this.querySync = querySync
      this.destroy = vi.fn()
    }),
  }
})

const sampleEvent = {
  id: 'abc',
  sig: 'sig',
  kind: 0,
  tags: [],
  pubkey: '82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2',
  created_at: 1,
  content: JSON.stringify({
    name: 'jack',
    nip05: 'jack@jack.com',
  }),
}

describe('shouldSuggestProfiles', () => {
  it('requires at least four characters', () => {
    expect(shouldSuggestProfiles('jac')).toBe(false)
    expect(shouldSuggestProfiles('jack')).toBe(true)
  })

  it('skips structured nostr identities', () => {
    expect(
      shouldSuggestProfiles(
        'npub1sn0wdenkukak0d9afzce9sd3e4g5zary8ysklx96fzbq3jgp3sqjhmr9v',
      ),
    ).toBe(false)
    expect(
      shouldSuggestProfiles(
        'nprofile1qqsrhux4g4l20d69a4s3jhmvugm46r4p35hcs52sazn0tvgu5dvr2qer9e9k',
      ),
    ).toBe(false)
    expect(shouldSuggestProfiles('jack@mastodon.social')).toBe(false)
    expect(
      shouldSuggestProfiles(
        '82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2',
      ),
    ).toBe(false)
  })

  it('skips partial bech32 identity typing', () => {
    expect(shouldSuggestProfiles('npub1abc')).toBe(false)
    expect(shouldSuggestProfiles('nprofile1qq')).toBe(false)
  })

  it('allows plain name searches', () => {
    expect(shouldSuggestProfiles('jack')).toBe(true)
    expect(shouldSuggestProfiles('fiatjaf')).toBe(true)
  })
})

describe('searchProfiles cache', () => {
  afterEach(() => {
    clearProfileSearchCache()
    querySync.mockReset()
  })

  it('reuses cached results for the same query', async () => {
    querySync.mockResolvedValue([sampleEvent])

    const first = await searchProfiles('jack')
    const second = await searchProfiles('jack')

    expect(first).toHaveLength(1)
    expect(second).toEqual(first)
    expect(querySync).toHaveBeenCalledTimes(1)
  })

  it('normalizes cache keys by case and whitespace', async () => {
    querySync.mockResolvedValue([sampleEvent])

    await searchProfiles('jack')
    await searchProfiles('  JACK  ')

    expect(querySync).toHaveBeenCalledTimes(1)
  })

  it('dedupes concurrent requests for the same query', async () => {
    let resolveQuery: (events: typeof sampleEvent[]) => void = () => {}
    querySync.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveQuery = resolve
        }),
    )

    const pendingA = searchProfiles('jack')
    const pendingB = searchProfiles('jack')
    resolveQuery([sampleEvent])

    const [a, b] = await Promise.all([pendingA, pendingB])
    expect(a).toEqual(b)
    expect(querySync).toHaveBeenCalledTimes(1)
  })

  it('expires cached entries after the ttl', async () => {
    querySync.mockResolvedValue([sampleEvent])

    await searchProfiles('jack')
    storeProfileSearchCacheForTest(
      'jack',
      SEARCH_RESULT_LIMIT,
      readProfileSearchCacheForTest('jack', SEARCH_RESULT_LIMIT) ?? [],
      Date.now() - SEARCH_CACHE_TTL_MS - 1,
    )

    await searchProfiles('jack')
    expect(querySync).toHaveBeenCalledTimes(2)
  })
})
