import type { Event } from 'nostr-tools'
import { setGeminiConsent } from './gemini-backend'
import {
  canRequestVerdict,
  ClientLimitError,
  INFERENCE_BRIDGE_URL,
  InferenceUnavailableError,
  GeminiConsentRequiredError,
  QuotaExhaustedError,
  RateLimitedError,
  requestVerdict,
  VerdictParseError,
  type Verdict,
} from './inference'
import {
  fetchProfile,
  fetchRecentNotes,
  formatNotesForPrompt,
  IdentityError,
  MIN_NOTES,
  Nip05Error,
  PrivateKeyError,
  resolveIdentity,
  type ProfileInfo,
} from './nostr'

const FETCH_LOADING_MESSAGES = [
  'SEARCHING THE RELAYS...',
  'COLLECTING EVIDENCE...',
  'SCANNING PUBLIC NOTES...',
]

const INFERENCE_LOADING_MESSAGES = [
  'ANALYZING REPLY-GUY ACTIVITY...',
  'MEASURING CONDESCENSION...',
  'CALCULATING ASSHOLE COEFFICIENT...',
  'CONSULTING ASSHOLENET...',
  'CHECKING FOR "WELL ACTUALLY"...',
]

type AppState =
  | { view: 'idle' }
  | { view: 'loading'; message: string }
  | {
      view: 'consent'
      resolve: (ok: boolean) => void
    }
  | { view: 'error'; title: string; detail: string; retryable: boolean; bridgeCta?: boolean }
  | {
      view: 'result'
      verdict: Verdict
      notes: Event[]
      profile: ProfileInfo
      showNotes: boolean
    }

const appEl = document.querySelector<HTMLDivElement>('#app')
if (!appEl) throw new Error('#app missing')
const app = appEl

let state: AppState = { view: 'idle' }
let loadingTimer: number | undefined
let abortController: AbortController | undefined
let lastInput = ''

function shuffleMessages(messages: string[]): string[] {
  const copy = [...messages]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

function displayModelName(model: string | undefined): string {
  const name = model?.trim()
  if (!name) return 'an unnamed asshole model'
  if (name.toLowerCase() === 'on-device') return 'your on-device asshole model'
  return name
}

function setState(next: AppState) {
  state = next
  render()
}

function stopLoadingCycle() {
  if (loadingTimer !== undefined) {
    window.clearInterval(loadingTimer)
    loadingTimer = undefined
  }
}

function startLoadingCycle(messages: string[]) {
  stopLoadingCycle()
  const shuffled = shuffleMessages(messages)
  let index = 0
  const message = shuffled[0]

  // Already on the loading screen: swap copy in place so the rise animation
  // does not replay when moving from relay fetch → inference.
  if (state.view === 'loading') {
    state = { view: 'loading', message }
    const status = document.querySelector('.loading-status')
    if (status) status.textContent = message
  } else {
    setState({ view: 'loading', message })
  }

  loadingTimer = window.setInterval(() => {
    index = (index + 1) % shuffled.length
    if (state.view !== 'loading') return
    state = { view: 'loading', message: shuffled[index] }
    const status = document.querySelector('.loading-status')
    if (status) status.textContent = shuffled[index]
  }, 1600)
}

function askGeminiConsent(): Promise<boolean> {
  return new Promise((resolve) => {
    stopLoadingCycle()
    setState({
      view: 'consent',
      resolve: (ok) => {
        setGeminiConsent(ok)
        if (ok) startLoadingCycle(INFERENCE_LOADING_MESSAGES)
        resolve(ok)
      },
    })
  })
}

const DISCLAIMER_TEXT =
  'For entertainment only. Results are AI-generated jokes based on public Nostr posts. Powered by highly questionable science.'

function createDisclaimer(): HTMLParagraphElement {
  const disclaimer = document.createElement('p')
  disclaimer.className = 'disclaimer'
  disclaimer.textContent = DISCLAIMER_TEXT
  return disclaimer
}

function renderShell(
  content: HTMLElement,
  options?: { after?: HTMLElement; disclaimer?: boolean },
) {
  app.replaceChildren()

  const shell = document.createElement('div')
  shell.className = 'shell'

  const header = document.createElement('header')
  header.className = 'hero'

  const brand = document.createElement('p')
  brand.className = 'brand'
  brand.textContent = 'ASSHOLE DETECTOR'

  const tagline = document.createElement('p')
  tagline.className = 'tagline'
  tagline.textContent =
    'Advanced AI-powered Nostr personality analysis.'

  header.append(brand, tagline)
  shell.append(header, content)
  if (options?.after) shell.append(options.after)
  if (options?.disclaimer !== false) shell.append(createDisclaimer())
  app.append(shell)
}

function renderForm(): HTMLElement {
  const panel = document.createElement('section')
  panel.className = 'panel'

  const form = document.createElement('form')
  form.className = 'judge-form'
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const input = form.querySelector<HTMLInputElement>('#identity')
    void judge(input?.value ?? '')
  })

  const label = document.createElement('label')
  label.className = 'sr-only'
  label.htmlFor = 'identity'
  label.textContent = 'Nostr identity'

  const input = document.createElement('input')
  input.id = 'identity'
  input.name = 'identity'
  input.type = 'text'
  input.autocomplete = 'off'
  input.spellcheck = false
  input.placeholder = 'npub / nprofile / nip05 / pubkey'
  input.value = lastInput
  input.required = true

  const button = document.createElement('button')
  button.type = 'submit'
  button.className = 'primary'
  button.textContent = 'JUDGE'

  form.append(label, input, button)
  panel.append(form)
  return panel
}

function renderConsent(resolve: (ok: boolean) => void) {
  const panel = document.createElement('section')
  panel.className = 'panel consent-panel'

  const heading = document.createElement('h2')
  heading.className = 'error-title'
  heading.textContent = 'SEND THIS TO GOOGLE?'

  const body = document.createElement('p')
  body.className = 'error-detail'
  body.textContent =
    'Inference Bridge is not here. We can still judge, but only if you are cool sending this asshole request to Google. Gemini may use prompts to improve Google products. Inference Bridge keeps notes with your own provider instead.'

  const actions = document.createElement('div')
  actions.className = 'actions'

  const send = document.createElement('button')
  send.type = 'button'
  send.className = 'primary'
  send.textContent = 'JUDGE WITH GOOGLE'
  send.addEventListener('click', () => resolve(true))

  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'secondary'
  cancel.textContent = 'CANCEL'
  cancel.addEventListener('click', () => resolve(false))

  const bridge = document.createElement('a')
  bridge.className = 'consent-alt'
  bridge.href = INFERENCE_BRIDGE_URL
  bridge.target = '_blank'
  bridge.rel = 'noopener noreferrer'
  bridge.textContent = 'Get Inference Bridge instead'

  actions.append(send, cancel)
  panel.append(heading, body, actions, bridge)
  renderShell(panel)
}

function renderLoading(message: string) {
  const panel = document.createElement('section')
  panel.className = 'panel loading-panel'

  const status = document.createElement('p')
  status.className = 'loading-status'
  status.setAttribute('aria-live', 'polite')
  status.textContent = message

  const meter = document.createElement('div')
  meter.className = 'meter'
  meter.setAttribute('aria-hidden', 'true')
  const bar = document.createElement('span')
  meter.append(bar)

  panel.append(status, meter)
  renderShell(panel)
}

function renderError(
  title: string,
  detail: string,
  retryable: boolean,
  bridgeCta = false,
) {
  const panel = document.createElement('section')
  panel.className = 'panel error-panel'

  const heading = document.createElement('h2')
  heading.className = 'error-title'
  heading.textContent = title

  const body = document.createElement('p')
  body.className = 'error-detail'
  body.textContent = detail

  const actions = document.createElement('div')
  actions.className = 'actions'

  if (bridgeCta) {
    const bridge = document.createElement('a')
    bridge.className = 'primary consent-bridge'
    bridge.href = INFERENCE_BRIDGE_URL
    bridge.target = '_blank'
    bridge.rel = 'noopener noreferrer'
    bridge.textContent = 'GET INFERENCE BRIDGE'
    actions.append(bridge)
  }

  if (retryable) {
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.className = 'primary'
    retry.textContent = 'TRY AGAIN'
    retry.addEventListener('click', () => void judge(lastInput))
    actions.append(retry)
  }

  const again = document.createElement('button')
  again.type = 'button'
  again.className = 'secondary'
  again.textContent = 'JUDGE ANOTHER'
  again.addEventListener('click', () => {
    abortController?.abort()
    stopLoadingCycle()
    setState({ view: 'idle' })
  })
  actions.append(again)

  panel.append(heading, body, actions)
  renderShell(panel)
}

function createAnonAvatar(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'anon-avatar')
  svg.setAttribute('viewBox', '0 0 64 64')
  svg.setAttribute('aria-hidden', 'true')

  const head = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
  head.setAttribute('cx', '32')
  head.setAttribute('cy', '24')
  head.setAttribute('r', '12')
  head.setAttribute('fill', 'currentColor')

  const body = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  body.setAttribute(
    'd',
    'M12 58c0-12.15 8.95-22 20-22s20 9.85 20 22',
  )
  body.setAttribute('fill', 'currentColor')

  svg.append(head, body)
  return svg
}

function renderResult(
  verdict: Verdict,
  notes: Event[],
  profile: ProfileInfo,
  showNotes: boolean,
) {
  const panel = document.createElement('section')
  panel.className = 'panel result-panel'

  const mugshot = document.createElement('div')
  mugshot.className = 'mugshot'
  mugshot.append(createAnonAvatar())

  if (profile.picture) {
    const img = document.createElement('img')
    img.className = 'avatar'
    img.src = profile.picture
    img.alt = profile.displayName
      ? `Profile picture of ${profile.displayName}`
      : 'Profile picture'
    img.referrerPolicy = 'no-referrer'
    img.decoding = 'async'
    img.addEventListener('error', () => {
      img.remove()
    })
    mugshot.append(img)
  }

  const subject = document.createElement('p')
  subject.className = 'subject-name'
  subject.textContent = profile.displayName?.trim() || 'Unknown subject'

  const stamp = document.createElement('div')
  stamp.className = `stamp ${verdict.verdict === 'ASSHOLE' ? 'bad' : 'good'}`
  stamp.textContent =
    verdict.verdict === 'ASSHOLE' ? '🚨 ASSHOLE' : '✅ NOT ASSHOLE'

  const confidence = document.createElement('p')
  confidence.className = 'confidence'
  confidence.textContent = `${verdict.confidence}% CONFIDENCE`

  const reason = document.createElement('blockquote')
  reason.className = 'reason'
  reason.textContent = verdict.reason

  const meta = document.createElement('p')
  meta.className = 'meta'
  meta.textContent = `Based on ${notes.length} recent Nostr notes.`

  const judgedBy = document.createElement('p')
  judgedBy.className = 'judged-by'
  const judgedLabel = document.createElement('span')
  judgedLabel.className = 'judged-by-label'
  judgedLabel.textContent = 'Judged by'
  const judgedModel = document.createElement('span')
  judgedModel.className = 'judged-by-model'
  judgedModel.textContent = displayModelName(verdict.model)
  judgedBy.append(judgedLabel, document.createTextNode(' '), judgedModel)

  const actions = document.createElement('div')
  actions.className = 'actions'

  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'secondary'
  toggle.textContent = showNotes ? 'HIDE NOTES' : 'VIEW NOTES'
  toggle.addEventListener('click', () => {
    if (state.view !== 'result') return
    setState({ ...state, showNotes: !state.showNotes })
  })

  const again = document.createElement('button')
  again.type = 'button'
  again.className = 'primary'
  again.textContent = 'JUDGE ANOTHER'
  again.addEventListener('click', () => setState({ view: 'idle' }))

  actions.append(toggle, again)
  panel.append(
    mugshot,
    subject,
    stamp,
    confidence,
    reason,
    meta,
    judgedBy,
    createDisclaimer(),
  )

  if (showNotes) {
    const list = document.createElement('ol')
    list.className = 'notes'
    for (const note of notes) {
      const item = document.createElement('li')
      item.textContent = note.content
      list.append(item)
    }
    panel.append(list)
  }

  renderShell(panel, { after: actions, disclaimer: false })
}

function render() {
  switch (state.view) {
    case 'idle':
      renderShell(renderForm())
      document.querySelector<HTMLInputElement>('#identity')?.focus()
      break
    case 'loading':
      renderLoading(state.message)
      break
    case 'consent':
      renderConsent(state.resolve)
      break
    case 'error':
      renderError(
        state.title,
        state.detail,
        state.retryable,
        state.bridgeCta,
      )
      break
    case 'result':
      renderResult(
        state.verdict,
        state.notes,
        state.profile,
        state.showNotes,
      )
      break
  }
}

function isActiveJudge(signal: AbortSignal): boolean {
  return !signal.aborted && abortController?.signal === signal
}

async function judge(raw: string) {
  lastInput = raw.trim()
  abortController?.abort()
  abortController = new AbortController()
  const signal = abortController.signal

  startLoadingCycle(FETCH_LOADING_MESSAGES)

  try {
    if (!(await canRequestVerdict())) {
      stopLoadingCycle()
      setState({
        view: 'error',
        title: 'NO JUDGE AVAILABLE',
        detail:
          'No inference extension and no free Google fallback right now. Install Inference Bridge to keep judging with your own provider.',
        retryable: true,
        bridgeCta: true,
      })
      return
    }
    if (!isActiveJudge(signal)) return

    const identity = await resolveIdentity(lastInput)
    if (!isActiveJudge(signal)) return

    const [notes, profile] = await Promise.all([
      fetchRecentNotes(identity),
      fetchProfile(identity),
    ])
    if (!isActiveJudge(signal)) return

    if (notes.length === 0) {
      stopLoadingCycle()
      setState({
        view: 'error',
        title: 'NO ASSHOLE DATA FOUND',
        detail:
          "This account doesn't appear to have enough recent kind 1 posts.",
        retryable: true,
      })
      return
    }

    if (notes.length < MIN_NOTES) {
      stopLoadingCycle()
      setState({
        view: 'error',
        title: 'INSUFFICIENT EVIDENCE',
        detail:
          'AssholeNet requires at least 3 usable posts before ruining someone\'s reputation.',
        retryable: false,
      })
      return
    }

    startLoadingCycle(INFERENCE_LOADING_MESSAGES)

    const verdict = await requestVerdict(formatNotesForPrompt(notes), {
      signal,
      ensureGeminiConsent: askGeminiConsent,
    })
    if (!isActiveJudge(signal)) return

    stopLoadingCycle()
    setState({
      view: 'result',
      verdict,
      notes,
      profile,
      showNotes: false,
    })
  } catch (error) {
    if (!isActiveJudge(signal)) return
    stopLoadingCycle()

    if (error instanceof PrivateKeyError) {
      lastInput = ''
      setState({
        view: 'error',
        title: 'PRIVATE KEY DETECTED',
        detail:
          'Never paste an nsec here. Use an npub, nprofile, NIP-05, or pubkey instead.',
        retryable: false,
      })
      return
    }

    if (error instanceof IdentityError) {
      setState({
        view: 'error',
        title: 'INVALID NOSTR IDENTITY',
        detail: 'Enter an npub, nprofile, NIP-05 address, or pubkey.',
        retryable: false,
      })
      return
    }

    if (error instanceof Nip05Error) {
      setState({
        view: 'error',
        title: 'NIP-05 LOOKUP FAILED',
        detail: error.message,
        retryable: true,
      })
      return
    }

    if (error instanceof GeminiConsentRequiredError) {
      setState({ view: 'idle' })
      return
    }

    if (error instanceof ClientLimitError) {
      setState({
        view: 'error',
        title: 'EASY, JUDGE',
        detail:
          'This browser has used up its free Google judgments for today. Install Inference Bridge to keep judging with your own provider and model.',
        retryable: false,
        bridgeCta: true,
      })
      return
    }

    if (error instanceof RateLimitedError) {
      setState({
        view: 'error',
        title: 'TOO MANY JUDGMENTS AT ONCE',
        detail:
          'Gemini needs a minute. Try again in a little while, or install Inference Bridge to keep judging with your own provider and model.',
        retryable: true,
        bridgeCta: true,
      })
      return
    }

    if (error instanceof QuotaExhaustedError) {
      setState({
        view: 'error',
        title: 'NO MORE FREE ASSHOLE DETECTIONS FOR TODAY',
        detail:
          'Gemini is cooked. Install Inference Bridge to keep judging with your own provider and model.',
        retryable: false,
        bridgeCta: true,
      })
      return
    }

    if (error instanceof InferenceUnavailableError) {
      setState({
        view: 'error',
        title: 'NO JUDGE AVAILABLE',
        detail:
          'No inference extension and no free Google fallback right now. Install Inference Bridge to keep judging with your own provider.',
        retryable: true,
        bridgeCta: true,
      })
      return
    }

    if (error instanceof VerdictParseError) {
      console.error('[AssholeNet] malfunction', {
        cause: error.causeDetail,
        raw: error.raw,
      })
      setState({
        view: 'error',
        title: 'ASSHOLENET MALFUNCTION',
        detail: 'The machine refuses to pass judgment.',
        retryable: true,
      })
      return
    }

    const message = error instanceof Error ? error.message : String(error)
    const looksLikeRelay =
      /websocket|relay|timeout|failed to fetch|network/i.test(message)

    if (looksLikeRelay) {
      setState({
        view: 'error',
        title: 'THE RELAYS ARE BEING DIFFICULT.',
        detail: 'Try again.',
        retryable: true,
      })
      return
    }

    console.error('[AssholeNet] unexpected judge error', error)
    setState({
      view: 'error',
      title: 'ASSHOLENET MALFUNCTION',
      detail: 'The machine refuses to pass judgment.',
      retryable: true,
    })
  }
}

render()
