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
  return (
    typeof window.inference?.request === 'function' && isSupportedContext()
  )
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
  constructor(message = 'ASSHOLENET MALFUNCTION') {
    super(message)
    this.name = 'VerdictParseError'
  }
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (fenced?.[1]) {
      return JSON.parse(fenced[1].trim())
    }
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1))
    }
    throw new VerdictParseError()
  }
}

export function parseVerdict(raw: string): Verdict {
  let data: unknown
  try {
    data = extractJsonObject(raw)
  } catch {
    throw new VerdictParseError()
  }

  if (!data || typeof data !== 'object') throw new VerdictParseError()

  const record = data as Record<string, unknown>
  const verdict = record.verdict
  const confidence = record.confidence
  const reason = record.reason

  if (verdict !== 'ASSHOLE' && verdict !== 'NOT ASSHOLE') {
    throw new VerdictParseError()
  }
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
    throw new VerdictParseError()
  }
  if (typeof reason !== 'string' || !reason.trim()) {
    throw new VerdictParseError()
  }

  const clamped = Math.max(50, Math.min(99, Math.round(confidence)))

  return {
    verdict,
    confidence: clamped,
    reason: reason.trim(),
    model: '',
  }
}

export async function requestVerdict(
  notesText: string,
  signal?: AbortSignal,
): Promise<Verdict> {
  if (!hasInference() || !window.inference) {
    throw new InferenceUnavailableError(
      window.inference
        ? 'Unsupported context — open over https or localhost.'
        : 'INFERENCE PROVIDER API NOT DETECTED',
    )
  }

  const userContent = `Recent Nostr posts:\n\n${notesText}`
  let content = ''
  let model = ''

  for await (const chunk of window.inference.request({
    method: 'chat',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    signal,
  })) {
    if (chunk.type === 'delta') {
      content += chunk.content
    } else if (chunk.type === 'done') {
      content = chunk.message.content
      model = chunk.model?.trim() ?? ''
    }
  }

  const verdict = parseVerdict(content)
  return { ...verdict, model }
}
