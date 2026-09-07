/** Panel-local text scale preference. */
export const UI_SCALE_STORAGE_KEY = 'dshPanelUiScale'
export const UI_SCALE_PROPERTY = '--ui-scale'
export const UI_SCALE_STEPS = [0.9, 1, 1.15, 1.3, 1.5, 1.75] as const
export const DEFAULT_UI_SCALE = 1

export function normalizeUiScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_UI_SCALE
  let closest: number = UI_SCALE_STEPS[0]
  for (const step of UI_SCALE_STEPS) {
    if (Math.abs(step - value) < Math.abs(closest - value)) closest = step
  }
  return closest
}

export function stepUiScale(current: number, direction: 1 | -1): number {
  const normalized = normalizeUiScale(current)
  const index = UI_SCALE_STEPS.indexOf(normalized as (typeof UI_SCALE_STEPS)[number])
  const next = index + direction
  return next < 0 || next >= UI_SCALE_STEPS.length ? normalized : UI_SCALE_STEPS[next]!
}

export function uiScaleAtLimit(current: number, direction: 1 | -1): boolean {
  return stepUiScale(current, direction) === normalizeUiScale(current)
}

export function formatUiScale(scale: number): string {
  return `${Math.round(normalizeUiScale(scale) * 100)}%`
}

export function applyUiScale(scale: number, root: HTMLElement = document.documentElement): void {
  root.style.setProperty(UI_SCALE_PROPERTY, String(normalizeUiScale(scale)))
}

export async function loadUiScale(): Promise<number> {
  try {
    const stored = await chrome.storage.local.get(UI_SCALE_STORAGE_KEY)
    return normalizeUiScale(stored[UI_SCALE_STORAGE_KEY])
  } catch {
    return DEFAULT_UI_SCALE
  }
}

export function saveUiScale(scale: number): void {
  void chrome.storage.local.set({ [UI_SCALE_STORAGE_KEY]: normalizeUiScale(scale) }).catch(() => {})
}
