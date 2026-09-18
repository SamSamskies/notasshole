import { setGeminiConsent } from './gemini-backend'
import {
  clientHref,
  clientsForPlatform,
  detectClientPlatform,
  encodeNevent,
  encodeNpub,
  isWebClientHref,
  type OpenInKind,
} from './nostr-clients'
import {
  canRequestVerdict,
  ClientLimitError,
  INFERENCE_BRIDGE_URL,
  InferenceUnavailableError,
  GeminiConsentRequiredError,
  QuotaExhaustedError,
  RateLimitedError,
  requestBattleVerdict,
  requestVerdict,
  VerdictParseError,
  type BattleOutcome,
  type BattleVerdict,
  type Verdict,
} from './inference'
import { attachIdentityCombobox } from './identity-combobox'
import {
  SEARCH_RESULT_LIMIT,
  searchProfiles,
  shouldSuggestProfiles,
  vertexHasKind0,
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
import { DOCKET_LIST_LIMIT } from './docket-payload'
import { isStampSearch, overlaySearch } from './stamp'
import {
  attachStampWindowListeners,
  mountStampOverlay,
  setStampOverlayOpen,
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

const BATTLE_LOADING_MESSAGES = [
  'WEIGHING THE ASSHOLES...',
  'COMPARING REPLY-GUY ENERGY...',
  'STACKING THE RECEIPTS...',
  'MEASURING MUTUAL CONDESCENSION...',
  'CONSULTING THE THUNDERDOME...',
]

type JudgeMode = 'judge' | 'battle'

type BattleFighter = {
  label: string
  profile: ProfileInfo
  noteCount: number
}

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
      notes: LocatedEvent[]
      profile: ProfileInfo
      showNotes: boolean
      snapshot?: {
        id: string
        judgedAt: string
        pubkey: string
      }
    }
  | {
      view: 'battle-result'
      verdict: BattleVerdict
      left: BattleFighter
      right: BattleFighter
    }

const appEl = document.querySelector<HTMLDivElement>('#app')
if (!appEl) throw new Error('#app missing')
const app = appEl

let state: AppState = { view: 'idle' }
let loadingTimer: number | undefined
let abortController: AbortController | undefined
let comboboxCleanups: Array<() => void> = []
let judgeMode: JudgeMode = 'judge'
let lastInput = ''
let lastBattleLeft = ''
let lastBattleRight = ''
let docketList: DocketCase[] | undefined
let docketRefresh: Promise<void> | undefined
let docketOverlay: DocketOverlay = { status: 'closed' }
let docketDialog: HTMLDialogElement | undefined
let snapshotAbort: AbortController | undefined
let ignoreDocketClose = false

type DocketOverlay =
  | { status: 'closed' }
  | { status: 'loading'; id: string }
  | { status: 'missing'; id: string }
  | { status: 'ready'; snapshot: DocketCase; showNotes: boolean }

function rememberDocketCase(snapshot: DocketCase) {
  const rest = (docketList ?? []).filter(
    (item) => item.id !== snapshot.id && item.pubkey !== snapshot.pubkey,
  )
  docketList = [snapshot, ...rest].slice(0, DOCKET_LIST_LIMIT)
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
    void openSnapshot(card.id)
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

function appPath(overlay: 'none' | 'stamp' | { docket: string }): string {
  return overlaySearch(location.href, overlay)
}

function locationPath(): string {
  return `${location.pathname}${location.search}${location.hash}`
}

function syncOverlayUrl(overlay: 'none' | 'stamp' | { docket: string }) {
  const next = appPath(overlay)
  if (next === locationPath()) return
  history.replaceState(history.state, '', next)
}

function cancelInFlight() {
  abortController?.abort()
  stopLoadingCycle()
}

function goIdle() {
  cancelInFlight()
  closeStamp({ replaceUrl: true })
  closeDocket({ replaceUrl: true })
  setState({ view: 'idle' })
}

function openStamp() {
  closeDocket({ replaceUrl: false })
  syncOverlayUrl('stamp')
  setStampOverlayOpen(true)
}

function closeStamp(options?: { replaceUrl?: boolean }) {
  setStampOverlayOpen(false)
  if (options?.replaceUrl !== false) syncOverlayUrl('none')
}

function applySnapshot(snapshot: DocketCase) {
  docketOverlay = { status: 'ready', snapshot, showNotes: false }
  syncDocketDialog()
}

async function openSnapshot(id: string) {
  closeStamp({ replaceUrl: false })
  if (state.view !== 'idle') {
    cancelInFlight()
    setState({ view: 'idle' })
  }

  syncOverlayUrl({ docket: id })

  snapshotAbort?.abort()
  snapshotAbort = new AbortController()
  const signal = snapshotAbort.signal

  const cached = cachedDocketCase(docketList, id)
  if (cached) {
    applySnapshot(cached)
    return
  }

  docketOverlay = { status: 'loading', id }
  syncDocketDialog()

  const snapshot = await fetchDocketCase(id)
  if (signal.aborted) return

  if (!snapshot) {
    docketOverlay = { status: 'missing', id }
    syncDocketDialog()
    return
  }

  applySnapshot(snapshot)
}

function closeDocket(options?: { replaceUrl?: boolean }) {
  snapshotAbort?.abort()
  docketOverlay = { status: 'closed' }
  if (!docketDialog?.open) {
    if (options?.replaceUrl !== false) syncOverlayUrl('none')
    return
  }
  ignoreDocketClose = true
  docketDialog.close()
  ignoreDocketClose = false
  if (options?.replaceUrl !== false) syncOverlayUrl('none')
}

function mountDocketDialog() {
  if (docketDialog) return
  docketDialog = document.createElement('dialog')
  docketDialog.className = 'docket-dialog'
  docketDialog.setAttribute('aria-labelledby', 'docket-dialog-title')
  docketDialog.addEventListener('close', () => {
    snapshotAbort?.abort()
    docketOverlay = { status: 'closed' }
    if (ignoreDocketClose) return
    if (docketIdFromSearch()) syncOverlayUrl('none')
  })
  docketDialog.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return
    const rect = docketDialog?.getBoundingClientRect()
    if (!rect) return
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    ) {
      docketDialog?.close()
    }
  })
  document.body.append(docketDialog)
}

function syncDocketDialog() {
  if (!docketDialog) return
  if (docketOverlay.status === 'closed') {
    if (docketDialog.open) {
      ignoreDocketClose = true
      docketDialog.close()
      ignoreDocketClose = false
    }
    docketDialog.replaceChildren()
    return
  }

  docketDialog.replaceChildren(renderDocketDialogBody())
  if (!docketDialog.open) docketDialog.showModal()
}

function renderDocketDialogBody(): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'docket-dialog-sheet'

  const chrome = document.createElement('div')
  chrome.className = 'docket-dialog-chrome'

  const kicker = document.createElement('p')
  kicker.className = 'docket-dialog-kicker'
  kicker.id = 'docket-dialog-title'
  kicker.textContent = 'Case file'

  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'docket-dialog-close'
  close.setAttribute('aria-label', 'Close case file')
  close.title = 'Close'
  close.textContent = '×'
  close.addEventListener('click', () => docketDialog?.close())

  chrome.append(kicker, close)
  wrap.append(chrome)

  if (docketOverlay.status === 'loading') {
    const status = document.createElement('p')
    status.className = 'docket-dialog-status'
    status.textContent = 'Opening the file…'
    wrap.append(status)
    return wrap
  }

  if (docketOverlay.status !== 'ready') {
    const status = document.createElement('p')
    status.className = 'docket-dialog-status'
    status.textContent =
      docketOverlay.status === 'missing'
        ? 'That docket entry is gone. Judgements fall off this public list after a while.'
        : 'Opening the file…'
    wrap.append(status)
    return wrap
  }

  const { snapshot, showNotes } = docketOverlay
  const built = buildResult(
    {
      verdict: snapshot.verdict,
      confidence: snapshot.confidence,
      reason: snapshot.reason,
      model: snapshot.model,
    },
    notesFromSnapshot(snapshot.notes),
    {
      displayName: snapshot.displayName,
      picture: snapshot.picture,
    },
    showNotes,
    {
      id: snapshot.id,
      judgedAt: snapshot.judgedAt,
      pubkey: snapshot.pubkey,
    },
  )
  built.toggle.className = 'primary'
  built.toggle.addEventListener('click', () => {
    if (docketOverlay.status !== 'ready') return
    docketOverlay = { ...docketOverlay, showNotes: !docketOverlay.showNotes }
    syncDocketDialog()
  })
  built.again.remove()
  wrap.append(built.panel, built.actions)
  return wrap
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
  },
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
    options?.tagline ??
    (judgeMode === 'battle'
      ? 'Two public Nostr personalities. One bigger asshole.'
      : 'Advanced AI-powered Nostr personality analysis.')

  header.append(brand, tagline)
  shell.append(header, content)
  if (options?.after) shell.append(options.after)
  if (options?.disclaimer !== false) {
    shell.append(createDisclaimer(false, options?.disclaimerText))
  }
  app.append(shell)
}

function clearComboboxes() {
  for (const cleanup of comboboxCleanups) cleanup()
  comboboxCleanups = []
}

function attachFormCombobox(input: HTMLInputElement, idPrefix: string) {
  comboboxCleanups.push(attachIdentityCombobox(input, { idPrefix }))
}

function setJudgeMode(mode: JudgeMode) {
  if (judgeMode === mode) return
  judgeMode = mode
  if (state.view === 'idle') render()
}

function createModeToggle(): HTMLElement {
  const group = document.createElement('div')
  group.className = 'mode-toggle'
  group.setAttribute('role', 'tablist')
  group.setAttribute('aria-label', 'Judgment mode')

  for (const mode of ['judge', 'battle'] as const) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'mode-toggle-btn'
    button.setAttribute('role', 'tab')
    button.setAttribute('aria-selected', judgeMode === mode ? 'true' : 'false')
    button.textContent = mode === 'judge' ? 'SINGLE' : 'BATTLE'
    button.addEventListener('click', () => setJudgeMode(mode))
    group.append(button)
  }

  return group
}

function createIdentityField(options: {
  id: string
  name: string
  label: string
  placeholder: string
  value: string
}): { label: HTMLLabelElement; input: HTMLInputElement } {
  const label = document.createElement('label')
  label.className = 'sr-only'
  label.htmlFor = options.id
  label.textContent = options.label

  const input = document.createElement('input')
  input.id = options.id
  input.name = options.name
  input.type = 'text'
  input.autocomplete = 'off'
  input.spellcheck = false
  input.placeholder = options.placeholder
  input.value = options.value
  input.required = true

  return { label, input }
}

function renderForm(): HTMLElement {
  const panel = document.createElement('section')
  panel.className = 'panel'

  const form = document.createElement('form')
  form.className =
    judgeMode === 'battle' ? 'judge-form battle-form' : 'judge-form'
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (judgeMode === 'battle') {
      const left = form.querySelector<HTMLInputElement>('#battle-left')
      const right = form.querySelector<HTMLInputElement>('#battle-right')
      void battle(left?.value ?? '', right?.value ?? '')
      return
    }
    const input = form.querySelector<HTMLInputElement>('#identity')
    void judge(input?.value ?? '')
  })

  form.append(createModeToggle())

  clearComboboxes()

  if (judgeMode === 'battle') {
    const left = createIdentityField({
      id: 'battle-left',
      name: 'battleLeft',
      label: 'Contender A',
      placeholder: 'name, npub, nprofile, nip05, or pubkey',
      value: lastBattleLeft,
    })
    const right = createIdentityField({
      id: 'battle-right',
      name: 'battleRight',
      label: 'Contender B',
      placeholder: 'name, npub, nprofile, nip05, or pubkey',
      value: lastBattleRight,
    })

    const versus = document.createElement('p')
    versus.className = 'battle-vs'
    versus.setAttribute('aria-hidden', 'true')
    versus.textContent = 'VS'

    const button = document.createElement('button')
    button.type = 'submit'
    button.className = 'primary'
    button.textContent = 'JUDGE'

    form.append(left.label, left.input, versus, right.label, right.input, button)
    panel.append(form)
    attachFormCombobox(left.input, 'battle-left')
    attachFormCombobox(right.input, 'battle-right')
    return panel
  }

  const field = createIdentityField({
    id: 'identity',
    name: 'identity',
    label: 'Nostr identity',
    placeholder: 'name, npub, nprofile, nip05, or pubkey',
    value: lastInput,
  })

  const button = document.createElement('button')
  button.type = 'submit'
  button.className = 'primary'
  button.textContent = 'JUDGE'

  form.append(field.label, field.input, button)
  panel.append(form)
  attachFormCombobox(field.input, 'identity')
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
    retry.addEventListener('click', () => {
      if (judgeMode === 'battle') {
        void battle(lastBattleLeft, lastBattleRight)
        return
      }
      void judge(lastInput)
    })
    actions.append(retry)
  }

  const again = document.createElement('button')
  again.type = 'button'
  again.className = 'secondary'
  again.textContent = judgeMode === 'battle' ? 'NEW BATTLE' : 'JUDGE ANOTHER'
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

function openInClient(kind: OpenInKind, code: string) {
  if (!code) return
  closeOpenInDialog()

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
    const href = clientHref(client, code, kind)
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

function openNoteInClient(note: LocatedEvent) {
  try {
    openInClient('note', encodeNevent(note))
  } catch {
    return
  }
}

function openProfileInClient(pubkey: string) {
  try {
    openInClient('profile', encodeNpub(pubkey))
  } catch {
    return
  }
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
  const built = buildResult(verdict, notes, profile, showNotes, snapshot)
  built.toggle.addEventListener('click', () => {
    if (state.view !== 'result') return
    setState({ ...state, showNotes: !state.showNotes })
  })
  renderShell(built.panel, { after: built.actions, disclaimer: false })
}

function buildResult(
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

  const mugshot = document.createElement(snapshot ? 'button' : 'div')
  mugshot.className = 'mugshot'
  mugshot.append(createAnonAvatar())
  if (snapshot && mugshot instanceof HTMLButtonElement) {
    mugshot.type = 'button'
    mugshot.setAttribute('aria-haspopup', 'dialog')
    mugshot.setAttribute('aria-label', 'Open this profile in…')
    mugshot.title = 'Open this profile in…'
    mugshot.addEventListener('click', () => openProfileInClient(snapshot.pubkey))
  }

  if (profile.picture) {
    const img = document.createElement('img')
    img.className = 'avatar'
    img.src = profile.picture
    img.alt = snapshot
      ? ''
      : profile.displayName
        ? `Profile picture of ${profile.displayName}`
        : 'Profile picture'
    img.referrerPolicy = 'no-referrer'
    img.decoding = 'async'
    img.addEventListener('error', () => {
      img.remove()
    })
    mugshot.append(img)
  }

  const subject = document.createElement(snapshot ? 'button' : 'p')
  subject.className = 'subject-name'
  subject.textContent = snapshot
    ? docketSubjectName({
        displayName: profile.displayName,
        pubkey: snapshot.pubkey,
      })
    : profile.displayName?.trim() || 'Unknown subject'
  if (snapshot && subject instanceof HTMLButtonElement) {
    subject.type = 'button'
    subject.setAttribute('aria-haspopup', 'dialog')
    subject.title = 'Open this profile in…'
    subject.addEventListener('click', () => openProfileInClient(snapshot.pubkey))
  }

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

  return { panel, actions, toggle, again }
}

function createFighterCard(
  fighter: BattleFighter,
  role: 'winner' | 'loser' | 'tied',
): HTMLElement {
  const card = document.createElement('div')
  card.className = `battle-fighter ${role}`

  const mugshot = document.createElement('div')
  mugshot.className = 'mugshot'
  mugshot.append(createAnonAvatar())
  if (fighter.profile.picture) {
    const img = document.createElement('img')
    img.className = 'avatar'
    img.src = fighter.profile.picture
    img.alt = fighter.profile.displayName
      ? `Profile picture of ${fighter.profile.displayName}`
      : 'Profile picture'
    img.referrerPolicy = 'no-referrer'
    img.decoding = 'async'
    img.addEventListener('error', () => {
      img.remove()
    })
    mugshot.append(img)
  }

  const name = document.createElement('p')
  name.className = 'subject-name'
  name.textContent = fighter.label

  card.append(mugshot, name)
  if (role === 'winner') {
    const badge = document.createElement('p')
    badge.className = 'battle-role'
    badge.textContent = 'King asshole'
    card.append(badge)
  }
  return card
}

function battleStampCopy(outcome: BattleOutcome): { text: string; tone: string } {
  switch (outcome) {
    case 'a':
    case 'b':
      return { text: '🚨 KING ASSHOLE', tone: 'bad' }
    case 'tie-assholes':
      return { text: '🚨 MUTUAL ASSHOLERY', tone: 'bad' }
    case 'tie-civil':
      return { text: '✅ DISAPPOINTINGLY CIVIL', tone: 'good' }
  }
}

function renderBattleResult(
  verdict: BattleVerdict,
  left: BattleFighter,
  right: BattleFighter,
) {
  const panel = document.createElement('section')
  panel.className = 'panel result-panel battle-result'

  const arena = document.createElement('div')
  arena.className = 'battle-arena'
  arena.setAttribute('aria-label', 'Battle contenders')

  const leftRole =
    verdict.outcome === 'a'
      ? 'winner'
      : verdict.outcome === 'b'
        ? 'loser'
        : 'tied'
  const rightRole =
    verdict.outcome === 'b'
      ? 'winner'
      : verdict.outcome === 'a'
        ? 'loser'
        : 'tied'

  const versus = document.createElement('p')
  versus.className = 'battle-vs battle-vs-result'
  versus.setAttribute('aria-hidden', 'true')
  versus.textContent = 'VS'

  arena.append(
    createFighterCard(left, leftRole),
    versus,
    createFighterCard(right, rightRole),
  )

  const stampCopy = battleStampCopy(verdict.outcome)
  const stamp = document.createElement('div')
  stamp.className = `stamp ${stampCopy.tone}`
  stamp.textContent = stampCopy.text

  const confidence = document.createElement('p')
  confidence.className = 'confidence'
  confidence.textContent = `${verdict.confidence}% CONFIDENCE`

  const reason = document.createElement('blockquote')
  reason.className = 'reason'
  reason.textContent = verdict.reason

  const meta = document.createElement('p')
  meta.className = 'meta'
  meta.textContent = `Based on ${left.noteCount} vs ${right.noteCount} recent Nostr notes.`

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

  const again = document.createElement('button')
  again.type = 'button'
  again.className = 'primary'
  again.textContent = 'NEW BATTLE'
  again.addEventListener('click', () => goIdle())

  actions.append(again)

  panel.append(
    arena,
    stamp,
    confidence,
    reason,
    meta,
    judgedBy,
    createDisclaimer(),
  )
  renderShell(panel, { after: actions, disclaimer: false })
}

function fighterLabel(profile: ProfileInfo, fallback: string): string {
  const named = profile.displayName?.trim()
  if (named) return named.length <= 28 ? named : `${named.slice(0, 25)}…`
  const trimmed = fallback.trim()
  if (!trimmed) return 'Unknown subject'
  if (trimmed.length <= 28) return trimmed
  return `${trimmed.slice(0, 25)}…`
}

function mapJudgeError(error: unknown): AppState | undefined {
  if (error instanceof PrivateKeyError) {
    return {
      view: 'error',
      title: 'PRIVATE KEY DETECTED',
      detail:
        'Never paste an nsec here. Use an npub, nprofile, NIP-05, or pubkey instead.',
      retryable: false,
    }
  }

  if (error instanceof IdentityError) {
    return {
      view: 'error',
      title: 'INVALID NOSTR IDENTITY',
      detail:
        error.message !== 'INVALID NOSTR IDENTITY'
          ? error.message
          : 'Enter a name, npub, nprofile, NIP-05 address, or pubkey.',
      retryable: false,
    }
  }

  if (error instanceof Nip05Error) {
    return {
      view: 'error',
      title: 'NIP-05 LOOKUP FAILED',
      detail: error.message,
      retryable: true,
    }
  }

  if (error instanceof GeminiConsentRequiredError) {
    return { view: 'idle' }
  }

  if (error instanceof ClientLimitError) {
    return {
      view: 'error',
      title: 'EASY, JUDGE',
      detail:
        'This browser has used up its free judgments for today. Install Inference Bridge to keep judging with your own provider and model.',
      retryable: false,
      bridgeCta: true,
    }
  }

  if (error instanceof RateLimitedError) {
    return {
      view: 'error',
      title: 'TOO MANY JUDGMENTS AT ONCE',
      detail:
        'Our asshole judge needs a minute. Try again in a little while, or install Inference Bridge to keep judging with your own provider and model.',
      retryable: true,
      bridgeCta: true,
    }
  }

  if (error instanceof QuotaExhaustedError) {
    return {
      view: 'error',
      title: 'NO MORE FREE ASSHOLE DETECTIONS FOR TODAY',
      detail:
        'Our asshole judge is cooked. Install Inference Bridge to keep judging with your own provider and model.',
      retryable: false,
      bridgeCta: true,
    }
  }

  if (error instanceof InferenceUnavailableError) {
    return {
      view: 'error',
      title: 'NO JUDGE AVAILABLE',
      detail:
        'Nobody here is available to judge assholeness right now. Install Inference Bridge to keep judging with your own provider and model.',
      retryable: true,
      bridgeCta: true,
    }
  }

  if (error instanceof VerdictParseError) {
    console.error('[AssholeNet] malfunction', {
      cause: error.causeDetail,
      raw: error.raw,
    })
    return {
      view: 'error',
      title: 'ASSHOLENET MALFUNCTION',
      detail: 'The machine refuses to pass judgment.',
      retryable: true,
    }
  }

  const message = error instanceof Error ? error.message : String(error)
  const looksLikeRelay =
    /websocket|relay|timeout|failed to fetch|network/i.test(message)

  if (looksLikeRelay) {
    return {
      view: 'error',
      title: 'THE RELAYS ARE BEING DIFFICULT.',
      detail: 'Try again.',
      retryable: true,
    }
  }

  console.error('[AssholeNet] unexpected judge error', error)
  return {
    view: 'error',
    title: 'ASSHOLENET MALFUNCTION',
    detail: 'The machine refuses to pass judgment.',
    retryable: true,
  }
}

async function battle(rawLeft: string, rawRight: string) {
  lastBattleLeft = rawLeft.trim()
  lastBattleRight = rawRight.trim()
  closeDocket({ replaceUrl: false })
  closeStamp({ replaceUrl: false })
  syncOverlayUrl('none')
  abortController?.abort()
  abortController = new AbortController()
  const signal = abortController.signal

  if (!lastBattleLeft || !lastBattleRight) {
    setState({
      view: 'error',
      title: 'NEED TWO CONTENDERS',
      detail: 'Enter two Nostr identities before starting a battle.',
      retryable: false,
    })
    return
  }

  if (lastBattleLeft.toLowerCase() === lastBattleRight.toLowerCase()) {
    setState({
      view: 'error',
      title: 'THAT IS JUST ONE PERSON',
      detail:
        'Pick two different identities. Fighting yourself is a different product.',
      retryable: false,
    })
    return
  }

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

    const [leftIdentity, rightIdentity] = await Promise.all([
      resolveSubmittedIdentity(lastBattleLeft, signal),
      resolveSubmittedIdentity(lastBattleRight, signal),
    ])
    if (!isActiveJudge(signal)) return

    if (leftIdentity.pubkey === rightIdentity.pubkey) {
      stopLoadingCycle()
      setState({
        view: 'error',
        title: 'THAT IS JUST ONE PERSON',
        detail:
          'Those identities resolve to the same pubkey. Pick two different people.',
        retryable: false,
      })
      return
    }

    const [leftNotes, rightNotes, leftProfile, rightProfile] =
      await Promise.all([
        fetchRecentNotes(leftIdentity),
        fetchRecentNotes(rightIdentity),
        fetchProfile(leftIdentity),
        fetchProfile(rightIdentity),
      ])
    if (!isActiveJudge(signal)) return

    if (leftNotes.length === 0 || rightNotes.length === 0) {
      stopLoadingCycle()
      const who =
        leftNotes.length === 0 && rightNotes.length === 0
          ? 'Neither contender'
          : leftNotes.length === 0
            ? 'Contender A'
            : 'Contender B'
      setState({
        view: 'error',
        title: 'NO ASSHOLE DATA FOUND',
        detail: `${who} doesn't appear to have enough recent kind 1 posts.`,
        retryable: true,
      })
      return
    }

    if (leftNotes.length < MIN_NOTES || rightNotes.length < MIN_NOTES) {
      stopLoadingCycle()
      setState({
        view: 'error',
        title: 'INSUFFICIENT EVIDENCE',
        detail:
          'AssholeNet needs at least 3 usable posts from each contender before the thunderdome opens.',
        retryable: false,
      })
      return
    }

    startLoadingCycle(BATTLE_LOADING_MESSAGES)

    const leftName = leftProfile.displayName
    const rightName = rightProfile.displayName
    const verdict = await requestBattleVerdict(
      {
        leftNotes: formatNotesForPrompt(leftNotes),
        rightNotes: formatNotesForPrompt(rightNotes),
      },
      {
        signal,
        leftName,
        rightName,
        ensureGeminiConsent: askGeminiConsent,
      },
    )
    if (!isActiveJudge(signal)) return

    stopLoadingCycle()
    setState({
      view: 'battle-result',
      verdict,
      left: {
        label: fighterLabel(leftProfile, lastBattleLeft),
        profile: leftProfile,
        noteCount: leftNotes.length,
      },
      right: {
        label: fighterLabel(rightProfile, lastBattleRight),
        profile: rightProfile,
        noteCount: rightNotes.length,
      },
    })
  } catch (error) {
    if (!isActiveJudge(signal)) return
    stopLoadingCycle()
    if (error instanceof PrivateKeyError) {
      lastBattleLeft = ''
      lastBattleRight = ''
    }
    const next = mapJudgeError(error)
    if (next) setState(next)
  }
}

function render() {
  closeOpenInDialog()

  if (state.view !== 'idle') {
    clearComboboxes()
  }

  switch (state.view) {
    case 'idle':
      renderShell(renderForm(), { after: renderDocket(docketList) })
      if (!docketIdFromSearch() && !isStampSearch()) {
        const focusId =
          judgeMode === 'battle' ? '#battle-left' : '#identity'
        document.querySelector<HTMLInputElement>(focusId)?.focus()
      }
      void refreshDocket()
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
    case 'battle-result':
      renderBattleResult(state.verdict, state.left, state.right)
      break
  }
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
  closeDocket({ replaceUrl: false })
  closeStamp({ replaceUrl: false })
  syncOverlayUrl('none')
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

    const vertexListed = vertexHasKind0(identity.pubkey)
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
    void vertexListed.then((listed) => {
      if (!listed) return
      return publishDocketCase({
        pubkey: identity.pubkey,
        profile,
        verdict,
        notes,
      }).then((snapshot) => {
        if (snapshot) rememberDocketCase(snapshot)
      })
    })
  } catch (error) {
    if (!isActiveJudge(signal)) return
    stopLoadingCycle()
    if (error instanceof PrivateKeyError) {
      lastInput = ''
    }
    const next = mapJudgeError(error)
    if (next) setState(next)
  }
}

function applyLocation() {
  const id = docketIdFromSearch()
  if (id) {
    void openSnapshot(id)
    return
  }
  closeDocket({ replaceUrl: false })
  if (isStampSearch()) {
    setStampOverlayOpen(true)
    return
  }
  closeStamp({ replaceUrl: false })
}

window.addEventListener('popstate', applyLocation)

mountStampOverlay({
  onRequestOpen: openStamp,
  onDismiss: () => closeStamp({ replaceUrl: true }),
})
mountDocketDialog()
attachStampWindowListeners()

const bootId = docketIdFromSearch()
render()
if (bootId) {
  void openSnapshot(bootId)
} else if (isStampSearch()) {
  setStampOverlayOpen(true)
}
