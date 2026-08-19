import {
  canvasToBlob,
  clamp01,
  clampStampScale,
  DEFAULT_STAMP_PLACEMENT,
  drawStampedPhoto,
  exportStampedCanvas,
  fitContain,
  imageFileError,
  loadHtmlImage,
  measureStamp,
  pointerToImage,
  pointInRotatedRect,
  saveBlob,
  STAMP_SCALE_DEFAULT,
  STAMP_SCALE_MAX,
  STAMP_SCALE_MIN,
  stampFilename,
  type StampBox,
  type StampPlacement,
  type StampVerdict,
} from './stamp'

export const STAMP_TAGLINE = 'Rubber stamps. No AI, no relays.'
export const STAMP_DISCLAIMER =
  'Stays in your browser. We never see the photo. Not a legal ruling.'

type StampSession = {
  image: HTMLImageElement | null
  objectUrl: string | null
  placement: StampPlacement
  error: string | null
}

const session: StampSession = {
  image: null,
  objectUrl: null,
  placement: { ...DEFAULT_STAMP_PLACEMENT },
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
let isStampViewActive = () => false
let windowListenersBound = false
let sessionGeneration = 0

export function resetStampSession() {
  sessionGeneration += 1
  if (session.objectUrl) URL.revokeObjectURL(session.objectUrl)
  session.image = null
  session.objectUrl = null
  session.placement = { ...DEFAULT_STAMP_PLACEMENT }
  session.error = null
  drag = undefined
  lastBox = undefined
  stageObserver?.disconnect()
  stageObserver = undefined
}

export function attachStampWindowListeners(isActive: () => boolean) {
  isStampViewActive = isActive
  if (windowListenersBound) return
  windowListenersBound = true
  window.addEventListener('resize', () => {
    if (isStampViewActive()) drawPreview()
  })
  window.addEventListener('paste', (event) => {
    if (!isStampViewActive()) return
    void handlePaste(event)
  })
}

export function renderStampPanel(): HTMLElement {
  const panel = document.createElement('section')
  panel.className = 'panel stamp-panel'

  const heading = document.createElement('div')
  heading.className = 'stamp-heading'

  const kicker = document.createElement('p')
  kicker.className = 'stamp-kicker'
  kicker.textContent = 'Field kit'

  const title = document.createElement('h2')
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
    if (isStampViewActive()) drawPreview()
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
    session.placement.verdict = verdict
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
      session.placement.nx = clamp01(
        (point.x - drag.grabDx) / session.image.naturalWidth,
      )
      session.placement.ny = clamp01(
        (point.y - drag.grabDy) / session.image.naturalHeight,
      )
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
  const ctx = document.createElement('canvas').getContext('2d')
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
  session.placement = {
    ...session.placement,
    nx: DEFAULT_STAMP_PLACEMENT.nx,
    ny: DEFAULT_STAMP_PLACEMENT.ny,
    scale: STAMP_SCALE_DEFAULT,
  }
  session.error = null
  refreshStampDom()
}

function clearPhoto() {
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

  const maxH = Math.min(window.innerHeight * 0.55, 540)
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
    const canvas = exportStampedCanvas(session.image, session.placement)
    const blob = await canvasToBlob(canvas)
    saveBlob(blob, stampFilename(session.placement.verdict))
  } catch {
    session.error = 'Could not save that PNG.'
    refreshStampDom()
  }
}
