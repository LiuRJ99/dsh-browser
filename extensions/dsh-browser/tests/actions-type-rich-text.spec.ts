// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import type { ElementIds } from '../src/content/ids.ts'

/**
 * Rich-text hosts (Lexical, Draft.js, ProseMirror) keep their own document
 * model and reconcile away foreign `textContent` writes, so typing must go
 * through the browser editing pipeline instead of a direct DOM assignment.
 */

const BUDGET = { maxItems: 20, maxForms: 10, maxChars: 2_000 }

function idsFor(element: Element): ElementIds {
  return { elementByIndex: vi.fn(() => element) } as unknown as ElementIds
}

function host(html = ''): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('contenteditable', 'true')
  el.innerHTML = html
  document.body.append(el)
  return el
}

function stubExecCommand(inserted = true): ReturnType<typeof vi.fn> {
  const spy = vi.fn(() => inserted)
  Object.defineProperty(document, 'execCommand', { configurable: true, writable: true, value: spy })
  return spy
}

afterEach(() => {
  document.body.innerHTML = ''
  Reflect.deleteProperty(document, 'execCommand')
  vi.restoreAllMocks()
})

describe('typing into rich-text editors', () => {
  it('inserts through execCommand instead of assigning textContent', async () => {
    const el = host()
    const spy = stubExecCommand()

    await runAction('browser_type', { index: 3, text: 'hello world' }, { ids: idsFor(el), budget: BUDGET })

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith('insertText', false, 'hello world')
    // The direct-write path must not also run, or editors see a duplicate write.
    expect(el.textContent).toBe('')
  })

  it('places the selection inside the editing host before inserting', async () => {
    const el = host()
    let anchorInside = false
    const spy = vi.fn((_command: string, _ui: boolean, _value: string) => {
      const selection = document.getSelection()
      anchorInside = selection !== null
        && selection.rangeCount > 0
        && el.contains(selection.getRangeAt(0).startContainer)
      return true
    })
    Object.defineProperty(document, 'execCommand', { configurable: true, writable: true, value: spy })

    await runAction('browser_type', { index: 3, text: 'hi' }, { ids: idsFor(el), budget: BUDGET })

    expect(anchorInside).toBe(true)
  })

  it('selects existing contents when replace is set, so insertText overwrites them', async () => {
    const el = host('previous draft')
    let selectedText = ''
    const spy = vi.fn((_command: string, _ui: boolean, _value: string) => {
      selectedText = document.getSelection()?.toString() ?? ''
      return true
    })
    Object.defineProperty(document, 'execCommand', { configurable: true, writable: true, value: spy })

    await runAction('browser_type', { index: 3, text: 'fresh', replace: true }, { ids: idsFor(el), budget: BUDGET })

    expect(selectedText).toBe('previous draft')
  })

  it('appends rather than selects when replace is not set', async () => {
    const el = host('draft')
    let selectedText = ''
    const spy = vi.fn((_command: string, _ui: boolean, _value: string) => {
      selectedText = document.getSelection()?.toString() ?? ''
      return true
    })
    Object.defineProperty(document, 'execCommand', { configurable: true, writable: true, value: spy })

    await runAction('browser_type', { index: 3, text: ' more' }, { ids: idsFor(el), budget: BUDGET })

    expect(selectedText).toBe('')
  })

  it('resolves the editable host when the addressed element is a nested child', async () => {
    const el = host('<span id="inner">x</span>')
    const inner = el.querySelector('#inner')
    expect(inner).not.toBeNull()
    const spy = stubExecCommand()
    let anchorInsideHost = false
    spy.mockImplementation((_command: string, _ui: boolean, _value: string) => {
      const selection = document.getSelection()
      anchorInsideHost = selection !== null
        && selection.rangeCount > 0
        && el.contains(selection.getRangeAt(0).startContainer)
      return true
    })

    await runAction('browser_type', { index: 5, text: 'y' }, { ids: idsFor(inner!), budget: BUDGET })

    expect(anchorInsideHost).toBe(true)
  })

  it('falls back to the direct write when the host lacks execCommand', async () => {
    const el = host()
    Reflect.deleteProperty(document, 'execCommand')

    await runAction('browser_type', { index: 3, text: 'plain' }, { ids: idsFor(el), budget: BUDGET })

    expect(el.textContent).toBe('plain')
  })

  it('falls back to the direct write when execCommand reports failure', async () => {
    const el = host()
    stubExecCommand(false)

    await runAction('browser_type', { index: 3, text: 'plain' }, { ids: idsFor(el), budget: BUDGET })

    expect(el.textContent).toBe('plain')
  })
})

describe('typing into plain inputs is unchanged', () => {
  it('still sets value through the native setter', async () => {
    const input = document.createElement('input')
    document.body.append(input)
    const spy = stubExecCommand()

    await runAction('browser_type', { index: 1, text: 'search term' }, { ids: idsFor(input), budget: BUDGET })

    expect(input.value).toBe('search term')
    expect(spy).not.toHaveBeenCalled()
  })

  it('still replaces an existing value', async () => {
    const input = document.createElement('input')
    input.value = 'old'
    document.body.append(input)

    await runAction('browser_type', { index: 1, text: 'new', replace: true }, { ids: idsFor(input), budget: BUDGET })

    expect(input.value).toBe('new')
  })
})
