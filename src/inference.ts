import { complete, isInferenceAvailable } from 'ipa-tools'

export type Verdict = {
  verdict: 'ASSHOLE' | 'NOT ASSHOLE'
  confidence: number
  reason: string
  model: string
}

export const SYSTEM_PROMPT = `You are AssholeNet, an intentionally ridiculous fictional classifier.

Your job is to read a person's recent public Nostr posts and produce a humorous verdict:

ASSHOLE

or

NOT ASSHOLE

This is entertainment and not a factual psychological assessment.

Base the joke only on the content and behavior visible in the provided posts.

Things you may humorously notice include:

- unnecessary hostility
- constant arguing
- excessive self-importance
- condescension
- reply-guy behavior
- needless negativity
- performative outrage
- bragging
- excessive lecturing
- relentless complaining
- surprisingly wholesome behavior
- helpfulness
- humor
- friendliness
- self-awareness

Do not infer protected or sensitive traits.

Do not make claims about mental illness, intelligence, criminality, sexuality, religion, ethnicity, health, or other sensitive characteristics.

Be willing to return either verdict.

Do not automatically choose NOT ASSHOLE just to be polite.

Keep the explanation funny but grounded in the supplied posts.

Return only JSON:

{
  "verdict": "ASSHOLE" | "NOT ASSHOLE",
  "confidence": integer from 50 to 99,
  "reason": "one concise humorous explanation"
}`

export const INFERENCE_BRIDGE_URL =
  'https://chromewebstore.google.com/detail/ekjldffogogadhfhgkibgkfdhhikfamd'

export function isSupportedContext(): boolean {
  return window.isSecureContext && location.origin !== 'null'
}

export function hasInference(): boolean {
  return isInferenceAvailable() && isSupportedContext()
}

export class InferenceUnavailableError extends Error {
  constructor(
    message = 'INFERENCE PROVIDER API NOT DETECTED',
  ) {
    super(message)
    this.name = 'InferenceUnavailableError'
  }
}

export class VerdictParseError extends Error {
  readonly raw: string
  readonly causeDetail: string

  constructor(causeDetail: string, raw = '') {
    super(`ASSHOLENET MALFUNCTION: ${causeDetail}`)
    this.name = 'VerdictParseError'
    this.causeDetail = causeDetail
    this.raw = raw
  }
}

/** Strip ``` / ```json fences models often wrap around JSON. */
function stripCodeFences(text: string): string {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenced?.[1]) return fenced[1].trim()

  const embedded = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (embedded?.[1]) return embedded[1].trim()

  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return undefined
    try {
      return JSON.parse(text.slice(start, end + 1))
    } catch {
      return undefined
    }
  }
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) {
    throw new VerdictParseError('empty model response', text)
  }

  for (const candidate of [trimmed, stripCodeFences(trimmed)]) {
    const parsed = tryParseJson(candidate)
    if (parsed !== undefined) return parsed
  }

  throw new VerdictParseError('no JSON object found in response', text)
}

export function parseVerdict(raw: string): Verdict {
  let data: unknown
  try {
    data = extractJsonObject(raw)
  } catch (error) {
    if (error instanceof VerdictParseError) throw error
    throw new VerdictParseError('failed to extract JSON', raw)
  }

  if (!data || typeof data !== 'object') {
    throw new VerdictParseError(
      `parsed value is ${data === null ? 'null' : typeof data}, expected object`,
      raw,
    )
  }

  const record = data as Record<string, unknown>
  const verdict = record.verdict
  const confidence = coerceConfidence(record.confidence)
  const reason = record.reason

  if (verdict !== 'ASSHOLE' && verdict !== 'NOT ASSHOLE') {
    throw new VerdictParseError(
      `invalid verdict ${JSON.stringify(verdict)} (expected "ASSHOLE" | "NOT ASSHOLE")`,
      raw,
    )
  }
  if (confidence === null) {
    throw new VerdictParseError(
      `invalid confidence ${JSON.stringify(record.confidence)}`,
      raw,
    )
  }
  if (typeof reason !== 'string' || !reason.trim()) {
    throw new VerdictParseError(
      `invalid reason ${JSON.stringify(reason)}`,
      raw,
    )
  }

  const clamped = Math.max(50, Math.min(99, Math.round(confidence)))

  return {
    verdict,
    confidence: clamped,
    reason: reason.trim(),
    model: '',
  }
}

/** Accept numeric JSON numbers or common string forms like "85". */
function coerceConfidence(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    const parsed = Number(trimmed)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

export async function requestVerdict(
  notesText: string,
  signal?: AbortSignal,
): Promise<Verdict> {
  if (!hasInference()) {
    throw new InferenceUnavailableError(
      isInferenceAvailable()
        ? 'Unsupported context — open over https or localhost.'
        : 'INFERENCE PROVIDER API NOT DETECTED',
    )
  }

  const userContent = `Recent Nostr posts:\n\n${notesText}`
  let content = ''
  let model = ''

  try {
    const done = await complete({
      method: 'chat',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      signal,
    })
    content =
      typeof done.message.content === 'string' ? done.message.content : ''
    model = done.model?.trim() ?? ''

    const verdict = parseVerdict(content)
    return { ...verdict, model }
  } catch (error) {
    if (error instanceof VerdictParseError) {
      console.warn('[AssholeNet] verdict parse failed', {
        model: model || '(unknown)',
        cause: error.causeDetail,
        raw: error.raw || content,
      })
    } else {
      console.warn('[AssholeNet] unexpected inference error', error)
    }
    throw error
  }
}
