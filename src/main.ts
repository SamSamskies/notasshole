import { setGeminiConsent } from './gemini-backend'
import {
  clientHref,
  clientsForPlatform,
  detectClientPlatform,
  encodeNevent,
  isWebClientHref,
} from './nostr-clients'
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
import { attachIdentityCombobox } from './identity-combobox'
import {
  SEARCH_RESULT_LIMIT,
  searchProfiles,
  shouldSuggestProfiles,
} from './profile-search'
import {
  fetchProfile,
  fetchRecentNotes,
  formatNotesForPrompt,
  IdentityError,
  MIN_NOTES,
  Nip05Error,
  PrivateKeyError,
  resolveIdentity,
  type LocatedEvent,
  type NostrIdentity,
  type ProfileInfo,
} from './nostr'
import {
  cachedDocketCase,
  docketIdFromSearch,
  docketSubjectName,
  fetchDocketCase,
  fetchDocketList,
  formatRelativeTime,
  notesFromSnapshot,
  publishDocketCase,
  reasonSnippet,
  type DocketCard,
  type DocketCase,
} from './docket'
import { isStampSearch } from './stamp'
import {
  attachStampWindowListeners,
  renderStampActions,
  renderStampPanel,
  resetStampSession,
  STAMP_DISCLAIMER,
  STAMP_TAGLINE,
} from './stamp-view'

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
  | { view: 'stamp' }
  | { view: 'loading'; message: string }
  | {
      view: 'consent'
      resolve: (ok: boolean) => void
    }
  | { view: 'error'; title: string; detail: string; retryable: boolean; bridgeCta?: boolean }
  | {
      view: 'result'
      verdict: Verdict
      notes: LocatedEvent[]
      profile: ProfileInfo
      showNotes: boolean
      snapshot?: {
        id: string
        judgedAt: string
        pubkey: string
      }
    }

const appEl = document.querySelector<HTMLDivElement>('#app')
if (!appEl) throw new Error('#app missing')
const app = appEl

let state: AppState = { view: 'idle' }
let loadingTimer: number | undefined
let abortController: AbortController | undefined
let comboboxCleanup: (() => void) | undefined
let lastInput = ''
let docketList: DocketCase[] | undefined
let docketRefresh: Promise<void> | undefined

function rememberDocketCase(snapshot: DocketCase) {
  const rest = (docketList ?? []).filter(
    (item) => item.id !== snapshot.id && item.pubkey !== snapshot.pubkey,
  )
  docketList = [snapshot, ...rest]
}

function renderDocket(cards: DocketCard[] | undefined): HTMLElement | undefined {
  if (!cards || cards.length === 0) return undefined

  const section = document.createElement('section')
  section.className = 'docket'
  section.setAttribute('aria-label', 'Recent docket')

  const heading = document.createElement('div')
  heading.className = 'docket-heading'

  const kicker = document.createElement('p')
  kicker.className = 'docket-kicker'
  kicker.textContent = 'Public record'

  const title = document.createElement('h2')
  title.className = 'docket-title'
  title.textContent = 'Recent docket'

  const blurb = document.createElement('p')
  blurb.className = 'docket-blurb'
  blurb.textContent =
    'Snapshots of public notes at judgement time. Entertainment only.'

  heading.append(kicker, title, blurb)

  const grid = document.createElement('div')
  grid.className = 'docket-grid'

  for (const card of cards) {
    grid.append(renderDocketCard(card))
  }

  section.append(heading, grid)
  return section
}

function renderDocketCard(card: DocketCard): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'docket-card'
  const name = docketSubjectName(card)
  const when = formatRelativeTime(card.judgedAt)
  button.setAttribute(
    'aria-label',
    `${name}, ${card.verdict}${when ? `, filed ${when}` : ''}`,
  )
  button.addEventListener('click', () => {
    void openSnapshot(card.id, { pushUrl: true })
  })

  const mugshot = document.createElement('div')
  mugshot.className = 'mugshot'
  mugshot.append(createAnonAvatar())
  if (card.picture) {
    const img = document.createElement('img')
    img.className = 'avatar'
    img.src = card.picture
    img.alt = ''
    img.referrerPolicy = 'no-referrer'
    img.decoding = 'async'
    img.addEventListener('error', () => {
      img.remove()
    })
    mugshot.append(img)
  }

  const body = document.createElement('div')
  body.className = 'docket-card-copy'

  const subject = document.createElement('p')
  subject.className = 'docket-card-name'
  subject.textContent = name

  const stamp = document.createElement('p')
  stamp.className = `docket-card-stamp ${card.verdict === 'ASSHOLE' ? 'bad' : 'good'}`
  stamp.textContent = card.verdict

  const snippet = document.createElement('p')
  snippet.className = 'docket-card-reason'
  snippet.textContent = reasonSnippet(card.reason)

  const time = document.createElement('p')
  time.className = 'docket-card-time'
  time.textContent = when ? `Filed ${when}` : 'Filed recently'

  body.append(subject, stamp, snippet, time)
  button.append(mugshot, body)
  return button
}

function mountDocket(cards: DocketCard[] | undefined) {
  if (state.view !== 'idle') return
  const next = renderDocket(cards)
  const existing = document.querySelector('.docket')
  if (!next) {
    existing?.remove()
    return
  }
  if (existing) {
    existing.replaceWith(next)
    return
  }
  const shell = document.querySelector('.shell')
  const disclaimer = shell?.querySelector(':scope > .disclaimer')
  if (disclaimer) disclaimer.before(next)
  else shell?.append(next)
}

function refreshDocket() {
  if (docketRefresh) return docketRefresh
  docketRefresh = fetchDocketList()
    .then((cases) => {
      if (cases) docketList = cases
      mountDocket(docketList)
    })
    .finally(() => {
      docketRefresh = undefined
    })
  return docketRefresh
}

function appPath(opts?: { docket?: string; stamp?: boolean }): string {
  const url = new URL(location.href)
  url.searchParams.delete('docket')
  url.searchParams.delete('stamp')
  if (opts?.docket) url.searchParams.set('docket', opts.docket)
  if (opts?.stamp) url.searchParams.set('stamp', '1')
  const query = url.searchParams.toString()
  return query ? `${url.pathname}?${query}` : url.pathname
}

function cancelInFlight() {
  abortController?.abort()
  stopLoadingCycle()
}

function goIdle() {
  cancelInFlight()
  if (docketIdFromSearch() || isStampSearch()) {
    history.pushState({ view: 'idle' }, '', appPath())
  }
  setState({ view: 'idle' })
}

function goStamp() {
  cancelInFlight()
  if (!isStampSearch() || docketIdFromSearch()) {
    history.pushState({ view: 'stamp' }, '', appPath({ stamp: true }))
  }
  if (state.view === 'stamp') return
  setState({ view: 'stamp' })
}

function applySnapshot(snapshot: DocketCase) {
  stopLoadingCycle()
  setState({
    view: 'result',
    verdict: {
      verdict: snapshot.verdict,
      confidence: snapshot.confidence,
      reason: snapshot.reason,
      model: snapshot.model,
    },
    notes: notesFromSnapshot(snapshot.notes),
    profile: {
      displayName: snapshot.displayName,
      picture: snapshot.picture,
    },
    showNotes: false,
    snapshot: {
      id: snapshot.id,
      judgedAt: snapshot.judgedAt,
      pubkey: snapshot.pubkey,
    },
  })
}

async function openSnapshot(
  id: string,
  options?: { pushUrl?: boolean },
) {
  if (options?.pushUrl) {
    history.pushState({ view: 'snapshot', id }, '', appPath({ docket: id }))
  }

  abortController?.abort()
  abortController = new AbortController()
  const signal = abortController.signal

  const cached = cachedDocketCase(docketList, id)
  if (cached) {
    applySnapshot(cached)
    return
  }

  startLoadingCycle(['PULLING THE FILE...', 'OPENING THE DOCKET...'])

  const snapshot = await fetchDocketCase(id)
  if (!isActiveJudge(signal)) return
  stopLoadingCycle()

  if (!snapshot) {
    setState({
      view: 'error',
      title: 'FILE NOT FOUND',
      detail:
        'That docket entry is gone. Judgements fall off this public list after a while.',
      retryable: false,
    })
    return
  }

  applySnapshot(snapshot)
}

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
  if (state.view === 'stamp' && next.view !== 'stamp') resetStampSession()
  if (state.view === 'consent' && next.view !== 'consent') {
    state.resolve(false)
  }
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
    let settled = false
    stopLoadingCycle()
    setState({
      view: 'consent',
      resolve: (ok) => {
        if (settled) return
        settled = true
        setGeminiConsent(ok)
        if (ok) startLoadingCycle(INFERENCE_LOADING_MESSAGES)
        resolve(ok)
      },
    })
  })
}

const DISCLAIMER_TEXT =
  'For entertainment only. Results are AI-generated jokes based on public Nostr posts. Powered by highly questionable science.'

const SNAPSHOT_DISCLAIMER_TEXT =
  'Entertainment only. This is a snapshot of public notes at judgement time.'

function createDisclaimer(snapshot = false, text?: string): HTMLParagraphElement {
  const disclaimer = document.createElement('p')
  disclaimer.className = 'disclaimer'
  disclaimer.textContent =
    text ?? (snapshot ? SNAPSHOT_DISCLAIMER_TEXT : DISCLAIMER_TEXT)
  return disclaimer
}

function renderShell(
  content: HTMLElement,
  options?: {
    after?: HTMLElement
    disclaimer?: boolean
    disclaimerText?: string
    tagline?: string
    brandHome?: boolean
  },
) {
  app.replaceChildren()

  const shell = document.createElement('div')
  shell.className = 'shell'

  const header = document.createElement('header')
  header.className = 'hero'

  const brand = options?.brandHome
    ? document.createElement('button')
    : document.createElement('p')
  brand.className = 'brand'
  brand.textContent = 'ASSHOLE DETECTOR'
  if (brand instanceof HTMLButtonElement) {
    brand.type = 'button'
    brand.title = 'Back to the detector'
    brand.addEventListener('click', () => goIdle())
  }

  const tagline = document.createElement('p')
  tagline.className = 'tagline'
  tagline.textContent =
    options?.tagline ?? 'Advanced AI-powered Nostr personality analysis.'

  header.append(brand, tagline)
  shell.append(header, content)
  if (options?.after) shell.append(options.after)
  if (options?.disclaimer !== false) {
    shell.append(createDisclaimer(false, options?.disclaimerText))
  }
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
  input.placeholder = 'name, npub, nprofile, nip05, or pubkey'
  input.value = lastInput
  input.required = true

  const button = document.createElement('button')
  button.type = 'submit'
  button.className = 'primary'
  button.textContent = 'JUDGE'

  form.append(label, input, button)
  panel.append(form)

  comboboxCleanup?.()
  comboboxCleanup = attachIdentityCombobox(input)

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
    'Inference Bridge is not here. We can still judge, but only if you are cool sending this asshole request to Google. Google may use prompts to improve their products. Inference Bridge keeps notes with your own provider instead.'

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
    goIdle()
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

function createNoteMenuIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'note-menu-icon')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')

  for (const cx of [6, 12, 18]) {
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    dot.setAttribute('cx', String(cx))
    dot.setAttribute('cy', '12')
    dot.setAttribute('r', '1.65')
    dot.setAttribute('fill', 'currentColor')
    svg.append(dot)
  }

  return svg
}

function closeOpenInDialog() {
  for (const el of document.querySelectorAll('dialog.open-in-dialog')) {
    if (el instanceof HTMLDialogElement) el.close()
  }
}

function openNoteInClient(note: LocatedEvent) {
  closeOpenInDialog()

  let nevent: string
  try {
    nevent = encodeNevent(note)
  } catch {
    return
  }

  const clients = clientsForPlatform(detectClientPlatform())
  const dialog = document.createElement('dialog')
  dialog.className = 'open-in-dialog'
  dialog.setAttribute('aria-labelledby', 'open-in-title')

  const title = document.createElement('h2')
  title.id = 'open-in-title'
  title.className = 'open-in-title'
  title.textContent = 'Open in'

  const list = document.createElement('div')
  list.className = 'open-in-list'

  for (const [index, client] of clients.entries()) {
    const href = clientHref(client, nevent)
    const link = document.createElement('a')
    link.className =
      index === 0 ? 'open-in-link primary' : 'open-in-link secondary'
    link.href = href
    link.textContent = client.name
    if (isWebClientHref(href)) {
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
    }
    list.append(link)
  }

  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'open-in-cancel'
  cancel.textContent = 'Cancel'
  cancel.addEventListener('click', () => dialog.close())

  dialog.append(title, list, cancel)
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close()
  })
  dialog.addEventListener('close', () => dialog.remove())

  document.body.append(dialog)
  dialog.showModal()
}

function renderResult(
  verdict: Verdict,
  notes: LocatedEvent[],
  profile: ProfileInfo,
  showNotes: boolean,
  snapshot?: {
    id: string
    judgedAt: string
    pubkey: string
  },
) {
  const panel = document.createElement('section')
  panel.className = 'panel result-panel'

  if (snapshot) {
    const banner = document.createElement('p')
    banner.className = 'snapshot-banner'
    const when = formatRelativeTime(snapshot.judgedAt)
    banner.textContent = when
      ? `Filed ${when} · snapshot, not a new ruling`
      : 'Snapshot, not a new ruling'
    panel.append(banner)
  }

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
  subject.textContent = snapshot
    ? docketSubjectName({
        displayName: profile.displayName,
        pubkey: snapshot.pubkey,
      })
    : profile.displayName?.trim() || 'Unknown subject'

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
  again.addEventListener('click', () => goIdle())

  actions.append(toggle, again)

  panel.append(
    mugshot,
    subject,
    stamp,
    confidence,
    reason,
    meta,
    judgedBy,
    createDisclaimer(Boolean(snapshot)),
  )

  if (showNotes) {
    const list = document.createElement('ol')
    list.className = 'notes'
    for (const note of notes) {
      const item = document.createElement('li')

      const body = document.createElement('p')
      body.className = 'note-body'
      body.textContent = note.content

      const open = document.createElement('button')
      open.type = 'button'
      open.className = 'note-menu'
      open.setAttribute('aria-haspopup', 'dialog')
      open.setAttribute('aria-label', 'Open this note in…')
      open.title = 'Open this note in…'
      open.append(createNoteMenuIcon())
      open.addEventListener('click', () => openNoteInClient(note))

      item.append(body, open)
      list.append(item)
    }
    panel.append(list)
  }

  renderShell(panel, { after: actions, disclaimer: false })
}

function render() {
  closeOpenInDialog()

  if (state.view !== 'idle') {
    comboboxCleanup?.()
    comboboxCleanup = undefined
  }

  switch (state.view) {
    case 'idle':
      renderShell(renderForm(), { after: renderDocket(docketList) })
      document.querySelector<HTMLInputElement>('#identity')?.focus()
      void refreshDocket()
      break
    case 'stamp':
      renderShell(renderStampPanel(), {
        after: renderStampActions(),
        tagline: STAMP_TAGLINE,
        brandHome: true,
        disclaimerText: STAMP_DISCLAIMER,
      })
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
        state.snapshot,
      )
      break
  }

  syncStampFooter()
}

function isActiveJudge(signal: AbortSignal): boolean {
  return !signal.aborted && abortController?.signal === signal
}

async function resolveSubmittedIdentity(
  raw: string,
  signal?: AbortSignal,
): Promise<NostrIdentity> {
  const input = raw.trim()
  if (shouldSuggestProfiles(input)) {
    const matches = await searchProfiles(input, {
      limit: SEARCH_RESULT_LIMIT,
      signal,
    })
    if (matches.length === 1) {
      return resolveIdentity(matches[0].npub)
    }
    if (matches.length > 1) {
      throw new IdentityError(
        'Multiple profiles match that name — pick one from the suggestions or use npub/NIP-05.',
      )
    }
  }
  return resolveIdentity(input)
}

async function judge(raw: string) {
  lastInput = raw.trim()
  if (docketIdFromSearch()) {
    history.replaceState({ view: 'judge' }, '', appPath())
  }
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
          'Nobody here is available to judge assholeness right now. Install Inference Bridge to keep judging with your own provider and model.',
        retryable: true,
        bridgeCta: true,
      })
      return
    }
    if (!isActiveJudge(signal)) return

    const identity = await resolveSubmittedIdentity(lastInput, signal)
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
      name: profile.displayName,
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
    void publishDocketCase({
      pubkey: identity.pubkey,
      profile,
      verdict,
      notes,
    }).then((snapshot) => {
      if (snapshot) rememberDocketCase(snapshot)
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
        detail:
          error.message !== 'INVALID NOSTR IDENTITY'
            ? error.message
            : 'Enter a name, npub, nprofile, NIP-05 address, or pubkey.',
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
          'This browser has used up its free judgments for today. Install Inference Bridge to keep judging with your own provider and model.',
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
          'Our asshole judge needs a minute. Try again in a little while, or install Inference Bridge to keep judging with your own provider and model.',
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
          'Our asshole judge is cooked. Install Inference Bridge to keep judging with your own provider and model.',
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
          'Nobody here is available to judge assholeness right now. Install Inference Bridge to keep judging with your own provider and model.',
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

function applyLocation() {
  const id = docketIdFromSearch()
  if (id) {
    void openSnapshot(id)
    return
  }
  if (isStampSearch()) {
    cancelInFlight()
    if (state.view !== 'stamp') setState({ view: 'stamp' })
    return
  }
  cancelInFlight()
  if (state.view !== 'idle') setState({ view: 'idle' })
}

window.addEventListener('popstate', applyLocation)

function syncStampFooter() {
  const link = document.querySelector<HTMLAnchorElement>('.footer-stamp')
  if (!link) return
  link.setAttribute('aria-current', state.view === 'stamp' ? 'page' : 'false')
}

document.querySelector('.footer-stamp')?.addEventListener('click', (event) => {
  if (!(event instanceof MouseEvent)) return
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  if (event.button !== 0) return
  event.preventDefault()
  goStamp()
})

attachStampWindowListeners(() => state.view === 'stamp')

const bootId = docketIdFromSearch()
if (bootId) {
  void openSnapshot(bootId)
} else if (isStampSearch()) {
  setState({ view: 'stamp' })
} else {
  render()
}
syncStampFooter()
