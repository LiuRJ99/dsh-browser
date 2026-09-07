// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_UI_SCALE,
  formatUiScale,
  normalizeUiScale,
  stepUiScale,
  uiScaleAtLimit,
} from '../src/panel/ui-scale.ts'

describe('panel UI scale', () => {
  it('snaps values to the supported scale steps', () => {
    expect(normalizeUiScale(undefined)).toBe(DEFAULT_UI_SCALE)
    expect(normalizeUiScale(1.17)).toBe(1.15)
    expect(formatUiScale(1.3)).toBe('130%')
  })

  it('steps and clamps at both ends', () => {
    expect(stepUiScale(1, 1)).toBe(1.15)
    expect(stepUiScale(1, -1)).toBe(0.9)
    expect(uiScaleAtLimit(0.9, -1)).toBe(true)
    expect(uiScaleAtLimit(1.75, 1)).toBe(true)
  })
})
