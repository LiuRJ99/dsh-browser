// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import type { ElementIds } from '../src/content/ids.ts'

const BUDGET = { maxItems: 60, maxForms: 30, maxChars: 4_000 }

function ctx(ids: Partial<ElementIds> = {}) {
  return { ids: ids as ElementIds, budget: BUDGET }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('browser_click_text', () => {
  it('clicks a button by visible text even when it is not in the inventory', async () => {
    const button = document.createElement('button')
    button.textContent = '导出数据'
    button.scrollIntoView = vi.fn()
    const click = vi.spyOn(button, 'click').mockImplementation(() => {})
    document.body.appendChild(button)

    const result = await runAction('browser_click_text', { text: '导出数据' }, ctx())

    expect(result.text).toContain('Clicked button')
    expect(click).toHaveBeenCalledOnce()
  })

  it('clicks an element by CSS selector when no text is provided', async () => {
    const button = document.createElement('button')
    button.className = 'export-btn'
    button.scrollIntoView = vi.fn()
    const click = vi.spyOn(button, 'click').mockImplementation(() => {})
    document.body.appendChild(button)

    const result = await runAction('browser_click_text', { selector: '.export-btn' }, ctx())

    expect(result.text).toContain('Clicked button')
    expect(click).toHaveBeenCalledOnce()
  })

  it('fails loudly when neither text nor selector matches', async () => {
    await expect(runAction('browser_click_text', { text: '不存在的按钮' }, ctx())).rejects.toMatchObject({
      code: 'action-failed',
    })
  })

  it('rejects when both text and selector are omitted', async () => {
    await expect(runAction('browser_click_text', {}, ctx())).rejects.toMatchObject({ code: 'bad-args' })
  })
})

describe('browser_wait_for', () => {
  it('resolves as soon as a selector appears', async () => {
    const pending = runAction('browser_wait_for', { selector: '#late', timeoutMs: 3_000 }, ctx())
    setTimeout(() => {
      const el = document.createElement('div')
      el.id = 'late'
      document.body.appendChild(el)
    }, 50)
    await expect(pending).resolves.toMatchObject({ text: expect.stringContaining('#late') })
  })

  it('resolves when page text contains the substring', async () => {
    const pending = runAction('browser_wait_for', { text: '生成完成', timeoutMs: 3_000 }, ctx())
    setTimeout(() => {
      const el = document.createElement('div')
      el.textContent = '数据生成完成'
      document.body.appendChild(el)
    }, 50)
    await expect(pending).resolves.toMatchObject({ text: expect.stringContaining('生成完成') })
  })

  it('fails when the condition never appears', async () => {
    await expect(runAction('browser_wait_for', { selector: '#never', timeoutMs: 200 }, ctx()))
      .rejects.toMatchObject({ code: 'action-failed' })
  })

  it('rejects when neither selector nor text is provided', async () => {
    await expect(runAction('browser_wait_for', {}, ctx())).rejects.toMatchObject({ code: 'bad-args' })
  })
})

describe('browser_get_table', () => {
  it('renders a table with a header row as CSV', async () => {
    const table = document.createElement('table')
    table.innerHTML = `
      <tr><th>日期</th><th>曝光</th></tr>
      <tr><td>2026-08-22</td><td>1,234</td></tr>
      <tr><td>2026-08-21</td><td>987</td></tr>
    `
    document.body.appendChild(table)

    const result = await runAction('browser_get_table', { format: 'csv' }, ctx())
    expect(result.text).toBe('日期,曝光\n2026-08-22,"1,234"\n2026-08-21,987')
  })

  it('renders a table as JSON objects keyed by header', async () => {
    const table = document.createElement('table')
    table.innerHTML = `
      <tr><th>日期</th><th>曝光</th></tr>
      <tr><td>2026-08-22</td><td>1234</td></tr>
    `
    document.body.appendChild(table)

    const result = await runAction('browser_get_table', { format: 'json' }, ctx())
    expect(JSON.parse(result.text)).toEqual([{ 日期: '2026-08-22', 曝光: '1234' }])
  })

  it('fails when no table exists', async () => {
    await expect(runAction('browser_get_table', {}, ctx())).rejects.toMatchObject({ code: 'action-failed' })
  })
})
