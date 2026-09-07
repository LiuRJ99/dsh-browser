// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchToolCall, type TabManagementContext } from '../src/background/tools.ts'

function tab(id: number, url = `https://example.com/${id}`): chrome.tabs.Tab {
  return { id, windowId: 1, index: id, active: id === 1, title: `Tab ${id}`, url } as chrome.tabs.Tab
}

function installChrome(tabs: chrome.tabs.Tab[]) {
  const store = new Map(tabs.map((item) => [item.id!, item]))
  const remove = vi.fn(async (id: number) => { store.delete(id) })
  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn(async () => [...store.values()]),
      get: vi.fn(async (id: number) => {
        const value = store.get(id)
        if (value === undefined) throw new Error('missing tab')
        return value
      }),
      remove,
    },
  })
  return { remove }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('tab management tools', () => {
  it('blocks tab enumeration when page sharing is disabled', async () => {
    const chromeMock = installChrome([tab(1)])
    const result = await dispatchToolCall({ id: 'list', name: 'browser_list_tabs', args: {} }, 'off')
    expect(result).toMatchObject({ ok: false, error: { code: 'action-failed' } })
    expect(chromeMock.remove).not.toHaveBeenCalled()
  })

  it('returns stable untrusted tab metadata after explicit approval', async () => {
    installChrome([tab(1), tab(2)])
    const result = await dispatchToolCall(
      { id: 'list', name: 'browser_list_tabs', args: {} },
      'auto',
      undefined,
      async () => 'approved',
    )
    expect(result).toMatchObject({ ok: true, result: { text: expect.stringContaining('UNTRUSTED_PAGE_CONTENT') } })
    expect((result.result as { text: string }).text).toContain('"tabId": 1')
  })

  it('follows without activating and closes only the requested tab', async () => {
    const chromeMock = installChrome([tab(1), tab(2)])
    let followed: number | undefined
    const context: TabManagementContext = {
      unrestrictedAccess: false,
      controlledTabId: 1,
      followTab: async (selected) => { followed = selected.id },
    }
    const follow = await dispatchToolCall(
      { id: 'follow', name: 'browser_follow_tab', args: { tabId: 2 } },
      'auto',
      undefined,
      async () => 'approved',
      undefined,
      undefined,
      undefined,
      context,
    )
    expect(follow.ok).toBe(true)
    expect(followed).toBe(2)

    const close = await dispatchToolCall(
      { id: 'close', name: 'browser_close_tab', args: { tabId: 2 } },
      'auto',
      undefined,
      async () => 'approved',
      undefined,
      undefined,
      undefined,
      context,
    )
    expect(close.ok).toBe(true)
    expect(chromeMock.remove).toHaveBeenCalledWith(2)
  })
})
