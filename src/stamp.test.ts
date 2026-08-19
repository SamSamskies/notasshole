import { describe, expect, it } from 'vitest'
import {
  clamp01,
  overlaySearch,
  clampStampScale,
  fitContain,
  fitExportSize,
  imageFileError,
  isStampSearch,
  MAX_EXPORT_EDGE,
  MAX_IMAGE_BYTES,
  pointInRotatedRect,
  pointerToImage,
  stampFilename,
  stampLabel,
  STAMP_SCALE_MAX,
  STAMP_SCALE_MIN,
} from './stamp'

describe('isStampSearch', () => {
  it('detects the stamp query flag', () => {
    expect(isStampSearch('?stamp=1')).toBe(true)
    expect(isStampSearch('?stamp')).toBe(true)
    expect(isStampSearch('?stamp=&docket=nope')).toBe(true)
    expect(isStampSearch('?docket=111')).toBe(false)
    expect(isStampSearch('')).toBe(false)
  })
})

describe('overlaySearch', () => {
  it('keeps stamp and docket exclusive', () => {
    expect(overlaySearch('/?docket=abc', 'stamp')).toBe('/?stamp=1')
    expect(overlaySearch('/?stamp=1', { docket: 'abc' })).toBe('/?docket=abc')
    expect(overlaySearch('/?docket=abc&stamp=1', 'none')).toBe('/')
  })
})

describe('imageFileError', () => {
  it('rejects huge or non-image files', () => {
    expect(imageFileError({ size: 12, type: 'image/png' })).toBeUndefined()
    expect(imageFileError({ size: 12, type: '' })).toBeUndefined()
    expect(imageFileError({ size: MAX_IMAGE_BYTES + 1, type: 'image/png' })).toBe(
      'That photo is too big (12MB max).',
    )
    expect(imageFileError({ size: 12, type: 'application/pdf' })).toBe(
      'That file is not an image.',
    )
  })
})

describe('stamp copy helpers', () => {
  it('labels and names the download', () => {
    expect(stampLabel('ASSHOLE')).toBe('🚨 ASSHOLE')
    expect(stampLabel('NOT ASSHOLE')).toBe('✅ NOT ASSHOLE')
    expect(stampFilename('ASSHOLE')).toBe('asshole-stamp.png')
    expect(stampFilename('NOT ASSHOLE')).toBe('not-asshole-stamp.png')
  })
})

describe('layout math', () => {
  it('fits an image inside a box without cropping', () => {
    expect(fitContain(2000, 1000, 400, 400)).toEqual({
      width: 400,
      height: 200,
    })
    expect(fitContain(100, 400, 400, 200)).toEqual({
      width: 50,
      height: 200,
    })
    expect(fitContain(0, 10, 100, 100)).toEqual({ width: 0, height: 0 })
  })

  it('caps export on the long edge', () => {
    expect(fitExportSize(800, 600)).toEqual({ width: 800, height: 600 })
    expect(fitExportSize(MAX_EXPORT_EDGE * 2, MAX_EXPORT_EDGE)).toEqual({
      width: MAX_EXPORT_EDGE,
      height: MAX_EXPORT_EDGE / 2,
    })
  })

  it('clamps scale and unit coordinates', () => {
    expect(clamp01(-1)).toBe(0)
    expect(clamp01(2)).toBe(1)
    expect(clamp01(Number.NaN)).toBe(0.5)
    expect(clampStampScale(0)).toBe(STAMP_SCALE_MIN)
    expect(clampStampScale(99)).toBe(STAMP_SCALE_MAX)
  })

  it('hit-tests a rotated rectangle in local space', () => {
    const rotation = Math.PI / 4
    expect(pointInRotatedRect(50, 50, 50, 50, 20, 10, rotation)).toBe(true)
    expect(pointInRotatedRect(80, 50, 50, 50, 20, 10, rotation)).toBe(false)
    expect(pointInRotatedRect(50, 0, 50, 50, 100, 10, 0)).toBe(false)
    expect(pointInRotatedRect(50, 50, 50, 50, 100, 10, 0)).toBe(true)
  })

  it('maps pointer coordinates onto the image', () => {
    expect(
      pointerToImage(25, 60, { left: 10, top: 10, width: 100, height: 50 } as DOMRect, 800, 400),
    ).toEqual({ x: 120, y: 400 })
  })
})
