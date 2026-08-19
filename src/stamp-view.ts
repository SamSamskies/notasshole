import {
  canvasToBlob,
  clampStampCenter,
  clampStampScale,
  DEFAULT_STAMP_PLACEMENT,
  DEFAULT_STAMP_SCALES,
  drawStampedPhoto,
  exportStampedCanvas,
  fitContain,
  fitStampScale,
  imageFileError,
  loadHtmlImage,
  measureStamp,
  pointerToImage,
  pointInRotatedRect,
  saveBlob,
  STAMP_SCALE_DEFAULT,
  STAMP_SCALE_MAX,
  STAMP_SCALE_MIN,
  stampOccupiedSize,
  stampFilename,
  type StampBox,
  type StampPlacement,
  type StampVerdict,
} from './stamp'

export const STAMP_DISCLAIMER =
  'Stays in your browser. We never see the photo. Not a legal ruling.'

type StampSession = {
  image: HTMLImageElement | null
  objectUrl: string | null
  placement: StampPlacement
  scales: Record<StampVerdict, number>
  error: string | null
}

const session: StampSession = {
  image: null,
  objectUrl: null,
  placement: { ...DEFAULT_STAMP_PLACEMENT },
  scales: { ...DEFAULT_STAMP_SCALES },
  error: null,
}

type DragState = {
  pointerId: number
  grabDx: number
  grabDy: number
}

let drag: DragState | undefined
let lastBox: StampBox | undefined
let stageObserver: ResizeObserver | undefined
let windowListenersBound = false
let sessionGeneration = 0
let stampDialog: HTMLDialogElement | undefined
let stampLauncher: HTMLButtonElement | undefined
let ignoreStampClose = false
let stampHandlers: { onRequestOpen: () => void; onDismiss: () => void } | undefined

export function resetStampSession() {
  sessionGeneration += 1
  if (session.objectUrl) URL.revokeObjectURL(session.objectUrl)
  session.image = null
  session.objectUrl = null
  session.placement = { ...DEFAULT_STAMP_PLACEMENT }
  session.scales = { ...DEFAULT_STAMP_SCALES }
  session.error = null
  drag = undefined
  lastBox = undefined
  stageObserver?.disconnect()
  stageObserver = undefined
}

export function attachStampWindowListeners() {
  if (windowListenersBound) return
  windowListenersBound = true
  window.addEventListener('resize', () => {
    if (stampDialog?.open) drawPreview()
  })
  window.addEventListener('paste', (event) => {
    if (!stampDialog?.open) return
    void handlePaste(event)
  })
}

export function mountStampOverlay(handlers: {
  onRequestOpen: () => void
  onDismiss: () => void
}) {
  stampHandlers = handlers
  if (stampLauncher && stampDialog) return

  stampLauncher = document.createElement('button')
  stampLauncher.type = 'button'
  stampLauncher.className = 'stamp-launcher'
  stampLauncher.setAttribute('aria-label', 'Stamp a photo')
  stampLauncher.setAttribute('aria-haspopup', 'dialog')
  stampLauncher.setAttribute('aria-expanded', 'false')
  stampLauncher.setAttribute('aria-controls', 'stamp-drawer')
  stampLauncher.title = 'Stamp a photo'
  stampLauncher.append(createStampLauncherIcon())
  stampLauncher.addEventListener('click', () => {
    if (stampDialog?.open) stampDialog.close()
    else stampHandlers?.onRequestOpen()
  })

  stampDialog = document.createElement('dialog')
  stampDialog.id = 'stamp-drawer'
  stampDialog.className = 'stamp-overlay'
  stampDialog.setAttribute('aria-labelledby', 'stamp-drawer-title')
  stampDialog.addEventListener('close', () => {
    stampLauncher?.setAttribute('aria-expanded', 'false')
    if (ignoreStampClose) return
    stampHandlers?.onDismiss()
  })
  stampDialog.addEventListener('click', (event) => {
    if (event.target === stampDialog) stampDialog.close()
  })

  const sheet = document.createElement('div')
  sheet.className = 'stamp-sheet'

  const chrome = document.createElement('div')
  chrome.className = 'stamp-drawer-chrome'

  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'stamp-drawer-close'
  close.setAttribute('aria-label', 'Close stamp')
  close.title = 'Close'
  close.append(createCloseIcon())
  close.addEventListener('click', () => stampDialog?.close())

  chrome.append(close)
  sheet.append(chrome, renderStampPanel(), renderStampActions())

  const disclaimer = document.createElement('p')
  disclaimer.className = 'disclaimer stamp-drawer-disclaimer'
  disclaimer.textContent = STAMP_DISCLAIMER
  sheet.append(disclaimer)

  stampDialog.append(sheet)
  document.body.append(stampLauncher, stampDialog)
}

export function setStampOverlayOpen(open: boolean) {
  if (!stampDialog || !stampLauncher) return
  stampLauncher.setAttribute('aria-expanded', open ? 'true' : 'false')
  if (open) {
    if (!stampDialog.open) stampDialog.showModal()
    queueMicrotask(() => drawPreview())
    stampDialog
      .querySelector<HTMLButtonElement>('.stamp-drawer-close')
      ?.focus()
    return
  }
  if (!stampDialog.open) return
  ignoreStampClose = true
  stampDialog.close()
  ignoreStampClose = false
}

function createStampLauncherIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', 'stamp-launcher-icon')

  const handle = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  handle.setAttribute(
    'd',
    'M10 2.5h4c.6 0 1 .4 1 1V5h-6V3.5c0-.6.4-1 1-1Z',
  )
  handle.setAttribute('fill', 'currentColor')

  const neck = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  neck.setAttribute('d', 'M9 5h6l1.2 3.2H7.8L9 5Z')
  neck.setAttribute('fill', 'currentColor')

  const pad = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  pad.setAttribute('x', '5')
  pad.setAttribute('y', '8.5')
  pad.setAttribute('width', '14')
  pad.setAttribute('height', '5.5')
  pad.setAttribute('rx', '1.2')
  pad.setAttribute('fill', 'currentColor')

  const ink1 = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  ink1.setAttribute('d', 'M6.5 17.2h11')
  ink1.setAttribute('fill', 'none')
  ink1.setAttribute('stroke', 'currentColor')
  ink1.setAttribute('stroke-width', '1.6')
  ink1.setAttribute('stroke-linecap', 'round')

  const ink2 = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  ink2.setAttribute('d', 'M8 20.2h8')
  ink2.setAttribute('fill', 'none')
  ink2.setAttribute('stroke', 'currentColor')
  ink2.setAttribute('stroke-width', '1.6')
  ink2.setAttribute('stroke-linecap', 'round')
  ink2.setAttribute('opacity', '0.55')

  svg.append(handle, neck, pad, ink1, ink2)
  return svg
}

function createCloseIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute(
    'd',
    'M6.3 6.3a1 1 0 0 1 1.4 0L12 10.6l4.3-4.3a1 1 0 1 1 1.4 1.4L13.4 12l4.3 4.3a1 1 0 1 1-1.4 1.4L12 13.4l-4.3 4.3a1 1 0 0 1-1.4-1.4L10.6 12 6.3 7.7a1 1 0 0 1 0-1.4Z',
  )
  path.setAttribute('fill', 'currentColor')
  svg.append(path)
  return svg
}

export function renderStampPanel(): HTMLElement {
  const panel = document.createElement('section')
  panel.className = 'panel stamp-panel'

  const heading = document.createElement('div')
  heading.className = 'stamp-heading'

  const kicker = document.createElement('p')
  kicker.className = 'stamp-kicker'
  kicker.textContent = 'No AI, no relays'

  const title = document.createElement('h2')
  title.id = 'stamp-drawer-title'
  title.className = 'stamp-title'
  title.textContent = 'Official stamp'

  const blurb = document.createElement('p')
  blurb.className = 'stamp-blurb'
  blurb.textContent =
    'Drop, click, or paste a photo, then drag the stamp.'

  heading.append(kicker, title, blurb)
  panel.append(heading, renderError(), renderIntake(), renderEditor())
  bindPanelDrop(panel)
  queueMicrotask(() => drawPreview())
  void document.fonts.ready.then(() => {
    if (session.image) applyFittedScales('current')
    if (stampDialog?.open) refreshStampDom()
  })
  return panel
}

export function renderStampActions(): HTMLElement {
  const actions = document.createElement('div')
  actions.className = 'actions'

  const download = document.createElement('button')
  download.type = 'button'
  download.className = 'primary stamp-download'
  download.textContent = 'DOWNLOAD PNG'
  download.disabled = !session.image
  download.hidden = !session.image
  download.addEventListener('click', () => {
    void downloadStamp()
  })

  const clear = document.createElement('button')
  clear.type = 'button'
  clear.className = 'secondary stamp-clear'
  clear.textContent = 'NEW PHOTO'
  clear.hidden = !session.image
  clear.addEventListener('click', () => {
    clearPhoto()
    refreshStampDom()
  })

  actions.append(clear, download)
  return actions
}

function renderError(): HTMLParagraphElement {
  const error = document.createElement('p')
  error.className = 'stamp-error'
  error.hidden = !session.error
  error.textContent = session.error ?? ''
  return error
}

function renderIntake(): HTMLElement {
  const intake = document.createElement('div')
  intake.className = 'stamp-intake'
  intake.hidden = Boolean(session.image)

  const drop = document.createElement('label')
  drop.className = 'stamp-drop'
  drop.htmlFor = 'stamp-file'

  const file = document.createElement('input')
  file.id = 'stamp-file'
  file.className = 'sr-only'
  file.type = 'file'
  file.accept = 'image/*'
  file.addEventListener('change', () => {
    const picked = file.files?.[0]
    file.value = ''
    if (picked) void adoptFile(picked)
  })

  const dropTitle = document.createElement('span')
  dropTitle.className = 'stamp-drop-title'
  dropTitle.textContent = 'Drop a photo'

  const dropHint = document.createElement('span')
  dropHint.className = 'stamp-drop-hint'
  dropHint.textContent = 'or click / paste'

  drop.append(file, dropTitle, dropHint)
  intake.append(drop)
  return intake
}

function renderEditor(): HTMLElement {
  const editor = document.createElement('div')
  editor.className = 'stamp-editor'
  editor.hidden = !session.image

  const stage = document.createElement('div')
  stage.className = 'stamp-stage'

  const canvas = document.createElement('canvas')
  canvas.setAttribute('role', 'img')
  canvas.tabIndex = 0
  updateCanvasLabel(canvas)
  bindCanvas(canvas)
  stage.append(canvas)
  watchStage(stage)

  const verdicts = document.createElement('div')
  verdicts.className = 'stamp-verdicts'
  verdicts.setAttribute('role', 'group')
  verdicts.setAttribute('aria-label', 'Verdict stamp')
  verdicts.append(
    verdictButton('ASSHOLE'),
    verdictButton('NOT ASSHOLE'),
  )

  const size = document.createElement('div')
  size.className = 'stamp-size'

  const sizeLabel = document.createElement('label')
  sizeLabel.htmlFor = 'stamp-scale'
  sizeLabel.textContent = 'Stamp size'

  const slider = document.createElement('input')
  slider.id = 'stamp-scale'
  slider.type = 'range'
  slider.min = String(STAMP_SCALE_MIN)
  slider.max = String(STAMP_SCALE_MAX)
  slider.step = '0.01'
  slider.value = String(session.placement.scale)
  slider.addEventListener('input', () => {
    session.placement.scale = clampStampScale(Number(slider.value))
    session.scales[session.placement.verdict] = session.placement.scale
    keepStampOnPhoto()
    drawPreview()
  })

  size.append(sizeLabel, slider)
  editor.append(stage, verdicts, size)
  return editor
}

function verdictButton(verdict: StampVerdict): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `stamp-verdict ${verdict === 'ASSHOLE' ? 'bad' : 'good'}`
  button.setAttribute(
    'aria-pressed',
    verdict === session.placement.verdict ? 'true' : 'false',
  )
  button.textContent = verdict
  button.addEventListener('click', () => {
    session.scales[session.placement.verdict] = session.placement.scale
    session.placement.verdict = verdict
    session.placement.scale = session.scales[verdict]
    keepStampOnPhoto()
    const slider = document.querySelector<HTMLInputElement>('#stamp-scale')
    if (slider) slider.value = String(session.placement.scale)
    for (const other of button.parentElement?.querySelectorAll('.stamp-verdict') ??
      []) {
      other.setAttribute(
        'aria-pressed',
        other === button ? 'true' : 'false',
      )
    }
    updateCanvasLabel()
    drawPreview()
  })
  return button
}

function updateCanvasLabel(canvas?: HTMLCanvasElement) {
  const node =
    canvas ?? document.querySelector<HTMLCanvasElement>('.stamp-stage canvas')
  if (!node) return
  node.setAttribute(
    'aria-label',
    `Photo with ${session.placement.verdict} stamp. Drag the stamp to move it.`,
  )
}

function bindCanvas(canvas: HTMLCanvasElement) {
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !session.image) return
    const point = pointerToImage(
      event.clientX,
      event.clientY,
      canvas.getBoundingClientRect(),
      session.image.naturalWidth,
      session.image.naturalHeight,
    )
    const box = lastBox ?? measureOnImage()
    if (!box) return
    const pad = Math.max(12, box.width * 0.06)
    if (
      !pointInRotatedRect(
        point.x,
        point.y,
        box.cx,
        box.cy,
        box.width + pad,
        box.height + pad,
        box.rotation,
      )
    ) {
      return
    }
    event.preventDefault()
    canvas.setPointerCapture(event.pointerId)
    drag = {
      pointerId: event.pointerId,
      grabDx: point.x - box.cx,
      grabDy: point.y - box.cy,
    }
    canvas.classList.add('dragging')
  })

  canvas.addEventListener('pointermove', (event) => {
    if (!session.image) return
    const point = pointerToImage(
      event.clientX,
      event.clientY,
      canvas.getBoundingClientRect(),
      session.image.naturalWidth,
      session.image.naturalHeight,
    )
    if (drag && event.pointerId === drag.pointerId) {
      const nextNx = (point.x - drag.grabDx) / session.image.naturalWidth
      const nextNy = (point.y - drag.grabDy) / session.image.naturalHeight
      const box = lastBox ?? measureOnImage()
      if (box) {
        const occupied = stampOccupiedSize(
          box,
          session.placement,
          session.image.naturalWidth,
          session.image.naturalHeight,
        )
        const clamped = clampStampCenter(
          nextNx,
          nextNy,
          occupied.width,
          occupied.height,
          session.image.naturalWidth,
          session.image.naturalHeight,
        )
        session.placement.nx = clamped.nx
        session.placement.ny = clamped.ny
      } else {
        session.placement.nx = Math.min(1, Math.max(0, nextNx))
        session.placement.ny = Math.min(1, Math.max(0, nextNy))
      }
      drawPreview()
      return
    }
    const box = lastBox
    if (!box) return
    const over = pointInRotatedRect(
      point.x,
      point.y,
      box.cx,
      box.cy,
      box.width,
      box.height,
      box.rotation,
    )
    canvas.classList.toggle('over-stamp', over)
  })

  const endDrag = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return
    drag = undefined
    canvas.classList.remove('dragging')
  }

  canvas.addEventListener('pointerup', endDrag)
  canvas.addEventListener('pointercancel', endDrag)
}

function measureOnImage(): StampBox | undefined {
  if (!session.image) return undefined
  const ctx = stampMeasureCtx()
  if (!ctx) return undefined
  return measureStamp(
    ctx,
    session.placement,
    session.image.naturalWidth,
    session.image.naturalHeight,
  )
}

function watchStage(stage: HTMLElement) {
  stageObserver?.disconnect()
  stageObserver = new ResizeObserver(() => drawPreview())
  stageObserver.observe(stage)
}

function bindPanelDrop(panel: HTMLElement) {
  const drop = panel.querySelector('.stamp-drop')

  panel.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    drop?.classList.add('is-hot')
  })

  panel.addEventListener('dragleave', (event) => {
    if (event.relatedTarget instanceof Node && panel.contains(event.relatedTarget)) {
      return
    }
    drop?.classList.remove('is-hot')
  })

  panel.addEventListener('drop', (event) => {
    drop?.classList.remove('is-hot')
    const file = event.dataTransfer?.files[0]
    if (!file) return
    event.preventDefault()
    void adoptFile(file)
  })
}

function hasFiles(event: DragEvent): boolean {
  return Boolean(event.dataTransfer?.types.includes('Files'))
}

async function handlePaste(event: ClipboardEvent) {
  const items = event.clipboardData?.items
  if (!items) return
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file) {
        event.preventDefault()
        await adoptFile(file)
        return
      }
    }
  }
}

async function adoptFile(file: File) {
  const invalid = imageFileError(file)
  if (invalid) {
    session.error = invalid
    refreshStampDom()
    return
  }
  sessionGeneration += 1
  const generation = sessionGeneration
  const objectUrl = URL.createObjectURL(file)
  try {
    const image = await loadHtmlImage(objectUrl)
    if (generation !== sessionGeneration) {
      URL.revokeObjectURL(objectUrl)
      return
    }
    adoptImage(image, objectUrl)
  } catch {
    URL.revokeObjectURL(objectUrl)
    if (generation !== sessionGeneration) return
    session.error = 'That file is not an image we can stamp.'
    refreshStampDom()
  }
}

function adoptImage(image: HTMLImageElement, objectUrl: string) {
  if (session.objectUrl) URL.revokeObjectURL(session.objectUrl)
  session.image = image
  session.objectUrl = objectUrl
  const verdict = session.placement.verdict
  session.placement = {
    ...DEFAULT_STAMP_PLACEMENT,
    verdict,
  }
  applyFittedScales(STAMP_SCALE_DEFAULT)
  session.error = null
  refreshStampDom()
}

/** Fit per-verdict scales so the stamp stays inside the photo with current font metrics. */
function applyFittedScales(desiredScale: number | 'current') {
  const image = session.image
  if (!image) return
  const verdict = session.placement.verdict
  const ctx = stampMeasureCtx()
  if (!ctx) {
    session.scales = { ...DEFAULT_STAMP_SCALES }
    session.placement.scale = session.scales[verdict]
    return
  }
  for (const option of ['ASSHOLE', 'NOT ASSHOLE'] as const) {
    const desired =
      desiredScale === 'current' ? session.scales[option] : desiredScale
    session.scales[option] = fitStampScale(
      ctx,
      { ...session.placement, verdict: option, scale: desired },
      image.naturalWidth,
      image.naturalHeight,
      desired,
    )
  }
  session.placement.scale = session.scales[verdict]
  keepStampOnPhoto()
}

function stampMeasureCtx(): CanvasRenderingContext2D | undefined {
  return document.createElement('canvas').getContext('2d') ?? undefined
}

function keepStampOnPhoto() {
  if (!session.image) return
  const box = measureOnImage()
  if (!box) return
  const occupied = stampOccupiedSize(
    box,
    session.placement,
    session.image.naturalWidth,
    session.image.naturalHeight,
  )
  const clamped = clampStampCenter(
    session.placement.nx,
    session.placement.ny,
    occupied.width,
    occupied.height,
    session.image.naturalWidth,
    session.image.naturalHeight,
  )
  session.placement.nx = clamped.nx
  session.placement.ny = clamped.ny
}

function clearPhoto() {
  sessionGeneration += 1
  if (session.objectUrl) URL.revokeObjectURL(session.objectUrl)
  session.image = null
  session.objectUrl = null
  session.error = null
  lastBox = undefined
}

function refreshStampDom() {
  const panel = document.querySelector('.stamp-panel')
  if (!panel) return
  const error = panel.querySelector('.stamp-error')
  if (error instanceof HTMLElement) {
    error.hidden = !session.error
    error.textContent = session.error ?? ''
  }
  const intake = panel.querySelector('.stamp-intake')
  if (intake instanceof HTMLElement) intake.hidden = Boolean(session.image)
  const editor = panel.querySelector('.stamp-editor')
  if (editor instanceof HTMLElement) editor.hidden = !session.image
  const slider = panel.querySelector<HTMLInputElement>('#stamp-scale')
  if (slider) slider.value = String(session.placement.scale)
  for (const button of panel.querySelectorAll('.stamp-verdict')) {
    button.setAttribute(
      'aria-pressed',
      button.textContent === session.placement.verdict ? 'true' : 'false',
    )
  }
  updateCanvasLabel()
  syncStampActions()
  drawPreview()
}

function syncStampActions() {
  const download = document.querySelector<HTMLButtonElement>('.stamp-download')
  const clear = document.querySelector<HTMLButtonElement>('.stamp-clear')
  if (download) {
    const ready = Boolean(session.image)
    download.hidden = !ready
    download.disabled = !ready
    download.title = ready ? '' : 'Load a photo first'
  }
  if (clear) clear.hidden = !session.image
}

function drawPreview() {
  const canvas = document.querySelector<HTMLCanvasElement>('.stamp-stage canvas')
  const stage = canvas?.parentElement
  if (!canvas || !stage || !session.image || stage.clientWidth <= 0) return

  const maxH = Math.min(window.innerHeight * 0.42, 420)
  const fitted = fitContain(
    session.image.naturalWidth,
    session.image.naturalHeight,
    stage.clientWidth,
    maxH,
  )
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.max(1, Math.round(fitted.width * dpr))
  canvas.height = Math.max(1, Math.round(fitted.height * dpr))
  canvas.style.width = `${fitted.width}px`
  canvas.style.height = `${fitted.height}px`

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  drawStampedPhoto(
    ctx,
    session.image,
    session.placement,
    fitted.width,
    fitted.height,
  )
  lastBox = measureStamp(
    ctx,
    session.placement,
    session.image.naturalWidth,
    session.image.naturalHeight,
  )
}

async function downloadStamp() {
  if (!session.image) return
  try {
    await document.fonts.ready
    if (!session.image) return
    applyFittedScales('current')
    refreshStampDom()
    const canvas = exportStampedCanvas(session.image, session.placement)
    const blob = await canvasToBlob(canvas)
    saveBlob(blob, stampFilename(session.placement.verdict))
  } catch {
    session.error = 'Could not save that PNG.'
    refreshStampDom()
  }
}
