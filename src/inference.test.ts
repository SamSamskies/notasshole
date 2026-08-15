import { describe, expect, it } from 'vitest'
import { parseVerdict, VerdictParseError } from './inference'

const validBody = {
  verdict: 'NOT ASSHOLE' as const,
  confidence: 78,
  reason: 'Reads more like a goofy enthusiast than malicious menace.',
}

describe('parseVerdict', () => {
  it('parses plain JSON', () => {
    expect(parseVerdict(JSON.stringify(validBody))).toEqual({
      ...validBody,
      model: '',
    })
  })

  it('parses JSON wrapped in ```json fences', () => {
    const raw = `\`\`\`json
{
  "verdict": "NOT ASSHOLE",
  "confidence": 78,
  "reason": "Reads more like a goofy enthusiast than malicious menace."
}
\`\`\``

    expect(parseVerdict(raw)).toEqual({
      ...validBody,
      model: '',
    })
  })

  it('parses JSON wrapped in plain ``` fences', () => {
    const raw = `\`\`\`
${JSON.stringify(validBody, null, 2)}
\`\`\``

    expect(parseVerdict(raw).verdict).toBe('NOT ASSHOLE')
  })

  it('parses JSON when fences are embedded in surrounding prose', () => {
    const raw = `Sure! Here you go:
\`\`\`json
${JSON.stringify(validBody)}
\`\`\`
Hope that helps!`

    expect(parseVerdict(raw).confidence).toBe(78)
  })

  it('parses a bare object when braces are extractable', () => {
    const raw = `Verdict follows:\n${JSON.stringify(validBody)}\nThanks.`
    expect(parseVerdict(raw).reason).toBe(validBody.reason)
  })

  it('accepts confidence as a numeric string', () => {
    expect(
      parseVerdict(
        JSON.stringify({ ...validBody, confidence: '85', verdict: 'ASSHOLE' }),
      ),
    ).toMatchObject({ verdict: 'ASSHOLE', confidence: 85 })
  })

  it('throws VerdictParseError for empty responses', () => {
    expect(() => parseVerdict('   ')).toThrow(VerdictParseError)
  })

  it('throws VerdictParseError for non-JSON refusals', () => {
    expect(() =>
      parseVerdict('I cannot pass judgment on people.'),
    ).toThrow(VerdictParseError)
  })
})
