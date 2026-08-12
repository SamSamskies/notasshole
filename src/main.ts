import './style.css'
import type { Event } from 'nostr-tools'
import {
  hasInference,
  INFERENCE_BRIDGE_URL,
  InferenceUnavailableError,
  requestVerdict,
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

const LOADING_MESSAGES = [
  'SEARCHING THE RELAYS...',
  'COLLECTING EVIDENCE...',
  'ANALYZING REPLY-GUY ACTIVITY...',
  'MEASURING CONDESCENSION...',
  'CALCULATING ASSHOLE COEFFICIENT...',
  'CONSULTING ASSHOLENET...',
  'CHECKING FOR "WELL ACTUALLY"...',
]

type AppState =
  | { view: 'idle' }
  | { view: 'loading'; message: string }
  | { view: 'error'; title: string; detail: string; retryable: boolean }
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

function shuffleMessages(): string[] {
  const copy = [...LOADING_MESSAGES]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
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

function startLoadingCycle() {
  stopLoadingCycle()
  const messages = shuffleMessages()
  let index = 0
  setState({ view: 'loading', message: messages[0] })
  loadingTimer = window.setInterval(() => {
    index = (index + 1) % messages.length
    if (state.view !== 'loading') return
    state = { view: 'loading', message: messages[index] }
    const status = document.querySelector('.loading-status')
    if (status) status.textContent = messages[index]
  }, 1600)
}

function syncInferenceUi() {
  const available = hasInference()

  const banner = document.querySelector<HTMLElement>('#ipa-banner')
  if (banner) banner.hidden = available

  if (state.view !== 'idle') return

  const input = document.querySelector<HTMLInputElement>('#identity')
  const button = document.querySelector<HTMLButtonElement>(
    '.judge-form button[type="submit"]',
  )
  if (input) input.disabled = !available
  if (button) button.disabled = !available
}

function renderBanner(): HTMLElement {
  const banner = document.createElement('aside')
  banner.id = 'ipa-banner'
  banner.className = 'ipa-banner'
  banner.hidden = hasInference()

  const text = document.createElement('p')
  text.textContent =
    'Inference Provider API not detected. Install Inference Bridge to run AssholeNet.'

  const link = document.createElement('a')
  link.href = INFERENCE_BRIDGE_URL
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  link.textContent = 'Get Inference Bridge'

  banner.append(text, link)
  return banner
}

function renderShell(content: HTMLElement) {
  app.replaceChildren()

  const shell = document.createElement('div')
  shell.className = 'shell'

  shell.append(renderBanner())

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

  const disclaimer = document.createElement('p')
  disclaimer.className = 'disclaimer'
  disclaimer.textContent =
    'For entertainment only. Results are AI-generated jokes based on public Nostr posts. Powered by highly questionable science.'

  shell.append(header, content, disclaimer, renderFooter())
  app.append(shell)
}

function renderFooter(): HTMLElement {
  const footer = document.createElement('footer')
  footer.className = 'site-footer'

  const nav = document.createElement('nav')
  nav.className = 'footer-links'
  nav.setAttribute('aria-label', 'Footer')

  const code = document.createElement('a')
  code.className = 'footer-icon'
  code.href = 'https://github.com/SamSamskies/notasshole'
  code.target = '_blank'
  code.rel = 'noopener noreferrer'
  code.setAttribute('aria-label', 'View source on GitHub')
  code.title = 'View source'
  code.innerHTML = GITHUB_ICON

  const nostr = document.createElement('a')
  nostr.className = 'footer-text'
  nostr.href = 'https://njump.me'
  nostr.target = '_blank'
  nostr.rel = 'noopener noreferrer'
  nostr.textContent = 'What is Nostr?'

  nav.append(code, footerSep(), nostr)
  footer.append(nav)
  return footer
}

function footerSep(): HTMLElement {
  const sep = document.createElement('span')
  sep.className = 'footer-sep'
  sep.setAttribute('aria-hidden', 'true')
  sep.textContent = '·'
  return sep
}

const GITHUB_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>'

function renderForm(disabled = false): HTMLElement {
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
  input.disabled = disabled
  input.required = true

  const button = document.createElement('button')
  button.type = 'submit'
  button.className = 'primary'
  button.textContent = 'JUDGE'
  button.disabled = disabled

  form.append(label, input, button)
  panel.append(form)
  return panel
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

function renderError(title: string, detail: string, retryable: boolean) {
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
  judgedModel.textContent = verdict.model || 'an unnamed model'
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
    actions,
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

  renderShell(panel)
}

function render() {
  switch (state.view) {
    case 'idle':
      renderShell(renderForm(!hasInference()))
      document.querySelector<HTMLInputElement>('#identity')?.focus()
      break
    case 'loading':
      renderLoading(state.message)
      break
    case 'error':
      renderError(state.title, state.detail, state.retryable)
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

  syncInferenceUi()
}

function isActiveJudge(signal: AbortSignal): boolean {
  return !signal.aborted && abortController?.signal === signal
}

async function judge(raw: string) {
  lastInput = raw.trim()
  abortController?.abort()
  abortController = new AbortController()
  const signal = abortController.signal

  startLoadingCycle()

  try {
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

    if (state.view === 'loading') {
      setState({ view: 'loading', message: 'CONSULTING ASSHOLENET...' })
    }

    const verdict = await requestVerdict(formatNotesForPrompt(notes), signal)
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

    if (error instanceof InferenceUnavailableError) {
      setState({
        view: 'error',
        title: 'INFERENCE PROVIDER API NOT DETECTED',
        detail:
          'Enable an IPA-compatible extension (Inference Bridge) to perform the analysis, then reload.',
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

    setState({
      view: 'error',
      title: 'ASSHOLENET MALFUNCTION',
      detail: 'The machine refuses to pass judgment.',
      retryable: true,
    })
  }
}

// Extensions inject after load; re-check a few times and on focus.
render()
for (const ms of [250, 1000, 2500]) {
  window.setTimeout(syncInferenceUi, ms)
}
window.addEventListener('focus', syncInferenceUi)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') syncInferenceUi()
})
