export type StampVerdict = 'ASSHOLE' | 'NOT ASSHOLE'

export type StampPlacement = {
  nx: number
  ny: number
  scale: number
  verdict: StampVerdict
}

export type StampBox = {
  cx: number
  cy: number
  width: number
  height: number
  rotation: number
}

export const MAX_IMAGE_BYTES = 12 * 1024 * 1024
export const MAX_EXPORT_EDGE = 4096
export const STAMP_SCALE_MIN = 0.55
export const STAMP_SCALE_MAX = 1.75
export const STAMP_SCALE_DEFAULT = 1

export const DEFAULT_STAMP_PLACEMENT: StampPlacement = {
  nx: 0.5,
  ny: 0.52,
  scale: STAMP_SCALE_DEFAULT,
  verdict: 'ASSHOLE',
}

const STAMP_ROTATION: Record<StampVerdict, number> = {
  ASSHOLE: (-2.5 * Math.PI) / 180,
  'NOT ASSHOLE': (2 * Math.PI) / 180,
}

const STAMP_INK: Record<StampVerdict, { fill: string; ink: string }> = {
  ASSHOLE: { fill: '#f8d9d6', ink: '#c21f1f' },
  'NOT ASSHOLE': { fill: '#d6efe3', ink: '#176b45' },
}

export function isStampSearch(search = location.search): boolean {
  return new URLSearchParams(search).has('stamp')
}

export function applyAppSearch(
  href: string,
  updates: { docket?: string | null; stamp?: boolean },
): string {
  const url = new URL(href, 'http://local.invalid')
  if ('docket' in updates) {
    if (updates.docket) url.searchParams.set('docket', updates.docket)
    else url.searchParams.delete('docket')
  }
  if ('stamp' in updates) {
    if (updates.stamp) url.searchParams.set('stamp', '1')
    else url.searchParams.delete('stamp')
  }
  const query = url.searchParams.toString()
  return `${url.pathname}${query ? `?${query}` : ''}${url.hash}`
}

export type AppOverlay = 'none' | 'stamp' | { docket: string }

export function overlaySearch(href: string, overlay: AppOverlay): string {
  if (overlay === 'none') {
    return applyAppSearch(href, { docket: null, stamp: false })
  }
  if (overlay === 'stamp') {
    return applyAppSearch(href, { docket: null, stamp: true })
  }
  return applyAppSearch(href, { docket: overlay.docket, stamp: false })
}

export function imageFileError(file: {
  size: number
  type: string
}): string | undefined {
  if (file.size > MAX_IMAGE_BYTES) return 'That photo is too big (12MB max).'
  if (file.type && !file.type.startsWith('image/')) {
    return 'That file is not an image.'
  }
  return undefined
}

export function stampLabel(verdict: StampVerdict): string {
  return verdict === 'ASSHOLE' ? '🚨 ASSHOLE' : '✅ NOT ASSHOLE'
}

export function stampFilename(verdict: StampVerdict): string {
  return verdict === 'ASSHOLE' ? 'asshole-stamp.png' : 'not-asshole-stamp.png'
}

export function clampStampScale(value: number): number {
  if (!Number.isFinite(value)) return STAMP_SCALE_DEFAULT
  return Math.min(STAMP_SCALE_MAX, Math.max(STAMP_SCALE_MIN, value))
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  return Math.min(1, Math.max(0, value))
}

export function fitContain(
  srcW: number,
  srcH: number,
  maxW: number,
  maxH: number,
): { width: number; height: number } {
  if (srcW <= 0 || srcH <= 0 || maxW <= 0 || maxH <= 0) {
    return { width: 0, height: 0 }
  }
  const scale = Math.min(maxW / srcW, maxH / srcH)
  return {
    width: Math.max(1, Math.round(srcW * scale)),
    height: Math.max(1, Math.round(srcH * scale)),
  }
}

export function fitExportSize(
  width: number,
  height: number,
  maxEdge = MAX_EXPORT_EDGE,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 }
  const edge = Math.max(width, height)
  if (edge <= maxEdge) return { width, height }
  const scale = maxEdge / edge
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

export function pointInRotatedRect(
  px: number,
  py: number,
  cx: number,
  cy: number,
  width: number,
  height: number,
  rotation: number,
): boolean {
  const dx = px - cx
  const dy = py - cy
  const cos = Math.cos(-rotation)
  const sin = Math.sin(-rotation)
  const localX = dx * cos - dy * sin
  const localY = dx * sin + dy * cos
  return Math.abs(localX) <= width / 2 && Math.abs(localY) <= height / 2
}

export function pointerToImage(
  clientX: number,
  clientY: number,
  canvas: DOMRect,
  imageWidth: number,
  imageHeight: number,
): { x: number; y: number } {
  if (canvas.width <= 0 || canvas.height <= 0) return { x: 0, y: 0 }
  return {
    x: ((clientX - canvas.left) / canvas.width) * imageWidth,
    y: ((clientY - canvas.top) / canvas.height) * imageHeight,
  }
}

function stampFont(fontSize: number): string {
  return `800 ${fontSize}px Syne, system-ui, sans-serif`
}

export function measureStamp(
  ctx: CanvasRenderingContext2D,
  placement: StampPlacement,
  imageWidth: number,
  imageHeight: number,
): StampBox {
  const fontSize = Math.max(14, imageWidth * 0.078 * placement.scale)
  ctx.font = stampFont(fontSize)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.letterSpacing = `${fontSize * -0.03}px`
  const text = stampLabel(placement.verdict)
  const textW = ctx.measureText(text).width
  const padX = fontSize * 0.48
  const padY = fontSize * 0.42
  return {
    cx: clamp01(placement.nx) * imageWidth,
    cy: clamp01(placement.ny) * imageHeight,
    width: textW + padX * 2,
    height: fontSize * 1.05 + padY * 2,
    rotation: STAMP_ROTATION[placement.verdict],
  }
}

function pathRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, radius)
    return
  }
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

export function drawStamp(
  ctx: CanvasRenderingContext2D,
  placement: StampPlacement,
  imageWidth: number,
  imageHeight: number,
): StampBox {
  const box = measureStamp(ctx, placement, imageWidth, imageHeight)
  const fontSize = Math.max(14, imageWidth * 0.078 * placement.scale)
  const colors = STAMP_INK[placement.verdict]
  const border = Math.max(3, fontSize * 0.08)
  const radius = fontSize * 0.18

  ctx.save()
  ctx.translate(box.cx, box.cy)
  ctx.rotate(box.rotation)
  ctx.font = stampFont(fontSize)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.letterSpacing = `${fontSize * -0.03}px`
  ctx.fillStyle = colors.fill
  ctx.strokeStyle = colors.ink
  ctx.lineWidth = border
  pathRoundRect(
    ctx,
    -box.width / 2,
    -box.height / 2,
    box.width,
    box.height,
    radius,
  )
  ctx.fill()
  ctx.stroke()
  ctx.fillStyle = colors.ink
  ctx.fillText(stampLabel(placement.verdict), 0, 0)
  ctx.restore()
  return box
}

export function drawStampedPhoto(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  placement: StampPlacement,
  width: number,
  height: number,
): StampBox {
  ctx.clearRect(0, 0, width, height)
  ctx.drawImage(image, 0, 0, width, height)
  return drawStamp(ctx, placement, width, height)
}

export function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('load failed'))
    image.src = src
  })
}

export function exportStampedCanvas(
  image: HTMLImageElement,
  placement: StampPlacement,
): HTMLCanvasElement {
  const size = fitExportSize(image.naturalWidth, image.naturalHeight)
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not save that PNG.')
  drawStampedPhoto(ctx, image, placement, size.width, size.height)
  return canvas
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob)
        else reject(new Error('Could not save that PNG.'))
      }, 'image/png')
    } catch {
      reject(new Error('Could not save that PNG.'))
    }
  })
}

export function saveBlob(blob: Blob, filename: string) {
  const href = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = href
  link.download = filename
  link.click()
  URL.revokeObjectURL(href)
}
