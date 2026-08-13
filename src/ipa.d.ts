/** Inference Provider API (experimental draft) */
type InferenceMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
  reasoning?: string
}

type InferenceUsage = {
  inputTokens?: number
  outputTokens?: number
}

type InferenceRequest = {
  method: 'chat'
  messages: InferenceMessage[]
  signal?: AbortSignal
}

type InferenceChunk =
  | { type: 'accepted' }
  | { type: 'reasoning_delta'; content: string }
  | { type: 'delta'; content: string }
  | {
      type: 'done'
      model: string
      message: InferenceMessage
      usage?: InferenceUsage
    }

type InferenceProvider = {
  request(request: InferenceRequest): AsyncIterable<InferenceChunk>
}

interface Window {
  inference?: InferenceProvider
  nostrZap?: {
    init: (params: Record<string, unknown>) => Promise<unknown>
    initTarget: (el: Element) => void
    initTargets: (selector?: string) => void
  }
}
