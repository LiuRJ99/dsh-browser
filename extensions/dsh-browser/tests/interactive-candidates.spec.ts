// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { collectInteractive } from '../src/content/extract.ts'
import { buildSnapshot, renderSnapshot } from '../src/content/snapshot.ts'
import { ElementIds } from '../src/content/ids.ts'
import { runAction } from '../src/content/actions.ts'

const budget = { maxItems: 12, maxForms: 12, maxChars: 8_000 }

describe('opt-in non-semantic controls', () => {
  it('finds a delegated card once without duplicating its pointer descendants or native wrappers', () => {
    document.body.innerHTML = `
      <div id="card" style="cursor:pointer"><span style="cursor:pointer">Exam</span></div>
      <div id="inline" onclick="void 0">Action</div>
      <div style="cursor:pointer"><button>Native</button></div>
      <label style="cursor:pointer"><input type="checkbox">Flag</label>
      <div tabindex="0">Focusable prose</div><div>Plain text</div>`
    expect(collectInteractive(document).map(el => el.tagName)).toEqual(['BUTTON', 'INPUT'])
    expect(collectInteractive(document, true).map(el => el.id || el.tagName)).toEqual(['card', 'inline', 'BUTTON', 'INPUT'])
  })

  it('excludes hidden ancestors, inert controls and unnamed boxes', () => {
    document.body.innerHTML = `
      <div style="opacity:0"><div onclick="void 0">Hidden</div></div>
      <div inert><div onclick="void 0">Inert</div></div>
      <div aria-hidden="true"><div onclick="void 0">Hidden from accessibility</div></div>
      <div style="cursor:pointer"></div><div onclick="void 0">Shown</div>`
    expect(collectInteractive(document, true).map(el => el.textContent)).toEqual(['Shown'])
  })

  it('filters before caps, preserves ids and never falls back on an empty match', () => {
    document.body.innerHTML = '<input value="outside"><nav>' + '<button>Noise</button>'.repeat(20) + '</nav><main><div class="option" style="cursor:pointer">A</div></main>'
    const ids = new ElementIds()
    const all = buildSnapshot(ids, { budget: { ...budget, maxItems: 40 }, includeNonSemantic: true }, null)
    const expectedId = all.items.find(item => item.name === 'A')!.index
    const scoped = buildSnapshot(ids, { budget, includeNonSemantic: true, candidateSelector: '.option' }, all)
    expect(scoped.items.map(item => item.index)).toEqual([expectedId])
    expect(scoped.truncated.itemsDropped).toBe(0)
    expect(scoped.forms).toEqual([])
    expect(buildSnapshot(ids, { budget, includeNonSemantic: true, candidateSelector: '.missing' }, scoped).items).toEqual([])
    expect(() => buildSnapshot(ids, { budget, candidateSelector: '[' }, scoped)).toThrow()
  })

  it('reports raw class changes and explicit false ARIA states in delta snapshots', () => {
    document.body.innerHTML = '<div class="option" style="cursor:pointer" aria-selected="false" aria-pressed="false">A</div>'
    const ids = new ElementIds()
    const first = buildSnapshot(ids, { budget, includeNonSemantic: true }, null)
    const el = document.querySelector('div')!
    el.classList.add('selected')
    const next = buildSnapshot(ids, { budget, includeNonSemantic: true, delta: true }, first)
    expect(next.changed).toContain(first.items[0]!.index)
    expect(renderSnapshot(next, true)).toContain('classes=option%20selected')
    expect(renderSnapshot(next, true)).toContain('unselected/unpressed')
    expect(next.items[0]!.checked).toBeUndefined()
  })

  it('escapes quoted control names so consumers can parse a complete candidate', () => {
    document.body.innerHTML = '<div style="cursor:pointer">Choose "A"</div>'
    const view = buildSnapshot(new ElementIds(), { budget, includeNonSemantic: true }, null)
    expect(renderSnapshot(view, false)).toContain('clickable "Choose \\"A\\""')
  })

  it('keeps scope in the action delta so a real click reports selection', async () => {
    vi.useFakeTimers()
    try {
      document.body.innerHTML = '<button>Exit</button><div class="option" style="cursor:pointer">A</div>'
      const el = document.querySelector('div')!
      ;(el as HTMLElement).scrollIntoView = vi.fn()
      el.addEventListener('click', () => el.classList.toggle('selected'))
      const ids = new ElementIds()
      await runAction('browser_snapshot', { includeNonSemantic: true, candidateSelector: '.option' }, { ids, budget })
      const pending = runAction('browser_click', { index: ids.indexOf(el) }, { ids, budget, includePageDelta: true })
      await vi.runAllTimersAsync()
      const result = await pending
      expect(result.pageContent).toContain('classes=option%20selected')
      expect(result.pageContent).toContain('Inventory scope:')
      expect(result.pageContent).not.toContain('Exit')
      await expect(runAction('browser_snapshot', { candidateSelector: '[' }, { ids, budget })).rejects.toThrow('valid CSS selector')
    } finally { vi.useRealTimers() }
  })
})
