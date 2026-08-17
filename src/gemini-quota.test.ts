import { describe, expect, it } from 'vitest'
import { classifyGemini429, collectQuotaIds } from './gemini-quota'

function quotaError(quotaId: string, extra?: Record<string, unknown>) {
  return {
    error: {
      code: 429,
      message:
        'You exceeded your current quota, please check your plan and billing details.',
      status: 'RESOURCE_EXHAUSTED',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [
            {
              quotaMetric:
                'generativelanguage.googleapis.com/generate_content_free_tier_requests',
              quotaId,
              ...extra,
            },
          ],
        },
        {
          '@type': 'type.googleapis.com/google.rpc.RetryInfo',
          retryDelay: '1s',
        },
      ],
    },
  }
}

describe('classifyGemini429', () => {
  it('treats PerDay quotaIds as daily exhaustion', () => {
    expect(
      classifyGemini429(
        quotaError('GenerateRequestsPerDayPerProjectPerModel-FreeTier'),
      ),
    ).toBe('daily')
  })

  it('treats PerMinute quotaIds as a short-window rate limit', () => {
    expect(
      classifyGemini429(
        quotaError('GenerateRequestsPerMinutePerProjectPerModel-FreeTier'),
      ),
    ).toBe('rate')
  })

  it('treats token-per-minute quotaIds as a short-window rate limit', () => {
    expect(
      classifyGemini429(
        quotaError(
          'GenerateContentInputTokensPerMinutePerProjectPerModel-FreeTier',
        ),
      ),
    ).toBe('rate')
  })

  it('prefers daily when a 429 lists both windows', () => {
    const body = {
      error: {
        details: [
          {
            violations: [
              { quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' },
              { quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' },
            ],
          },
        ],
      },
    }
    expect(classifyGemini429(body)).toBe('daily')
  })

  it('defaults unknown 429 bodies to rate', () => {
    expect(classifyGemini429({ error: { status: 'RESOURCE_EXHAUSTED' } })).toBe(
      'rate',
    )
    expect(classifyGemini429(null)).toBe('rate')
  })
})

describe('collectQuotaIds', () => {
  it('pulls quotaId values out of nested Gemini details', () => {
    expect(
      collectQuotaIds(
        quotaError('GenerateRequestsPerMinutePerProjectPerModel-FreeTier'),
      ),
    ).toEqual(['GenerateRequestsPerMinutePerProjectPerModel-FreeTier'])
  })
})
