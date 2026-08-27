// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  readyState = FakeWebSocket.CONNECTING

  constructor(readonly url: string) {
    super()
  }

  send(): void {}
}

function chromeEvent<T extends unknown[]>() {
  const listeners = new Set<(...args: T) => void>()
  return {
    addListener: vi.fn((listener: (...args: T) => void) => { listeners.add(listener) }),
    removeListener: vi.fn((listener: (...args: T) => void) => { listeners.delete(listener) }),
    emit: (...args: T) => { for (const listener of listeners) listener(...args) },
  }
}

function panelPort() {
  const onMessage = chromeEvent<[unknown]>()
  const onDisconnect = chromeEvent<[]>()
  const postMessage = vi.fn()
  const port = { name: 'dsh-panel', postMessage, onMessage, onDisconnect } as unknown as chrome.runtime.Port
  return { onDisconnect, onMessage, port, postMessage }
}

function tab(tabId: number): chrome.tabs.Tab {
  return {
    id: tabId,
    index: 0,
    windowId: 1,
    title: `Tab ${tabId}`,
    url: `https://example.com/${tabId}`,
    active: true,
  } as chrome.tabs.Tab
}

function affinityStates(postMessage: ReturnType<typeof vi.fn>): Array<{
  status?: string
  controlled?: { tabId?: number } | null
}> {
  return postMessage.mock.calls
    .map(([message]) => message as { type?: string; state?: { status?: string; controlled?: { tabId?: number } | null } })
    .filter((message) => message.type === 'tab-affinity')
    .map((message) => message.state ?? {})
}

function mockChrome() {
  const onConnect = chromeEvent<[chrome.runtime.Port]>()
  const onActivated = chromeEvent<[{ tabId: number; windowId: number }]>()
  const onRemoved = chromeEvent<[number]>()
  let activeTab = tab(1)
  const get = vi.fn(async (tabId: number) => tab(tabId))
  const query = vi.fn(async () => [activeTab])
  const sendMessage = vi.fn(async (tabId: number, message: unknown) => {
    if ((message as { type?: string }).type === 'DSH_ACTION') {
      return { ok: true, result: { text: `snapshot for tab ${tabId}` } }
    }
    return { ok: true }
  })

  vi.stubGlobal('chrome', {
    alarms: { create: vi.fn(), clear: vi.fn(async () => true), onAlarm: chromeEvent<[chrome.alarms.Alarm]>() },
    notifications: {
      create: vi.fn(async () => ''),
      clear: vi.fn(async () => true),
      onClicked: chromeEvent<[string]>(),
    },
    runtime: {
      id: 'test-extension',
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onConnect,
      onMessage: chromeEvent<[unknown, chrome.runtime.MessageSender, (response: unknown) => void]>(),
    },
    sidePanel: { open: vi.fn(async () => {}), setPanelBehavior: vi.fn(async () => {}) },
    storage: {
      local: {
        get: vi.fn(async () => ({ dshSettings: { autoFollowActiveTab: true } })),
        set: vi.fn(async () => {}),
      },
      session: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
    },
    tabs: {
      get,
      query,
      sendMessage,
      onActivated,
      onUpdated: chromeEvent<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>(),
      onReplaced: chromeEvent<[number, number]>(),
      onRemoved,
    },
    webNavigation: {
      getAllFrames: vi.fn(async () => []),
      onCommitted: chromeEvent<[{ tabId: number; frameId: number }]>(),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: chromeEvent<[number]>(),
      onRemoved: chromeEvent<[number]>(),
    },
  } as unknown as typeof chrome)

  return {
    activate(next: chrome.tabs.Tab): void {
      activeTab = next
      onActivated.emit({ tabId: next.id!, windowId: next.windowId! })
    },
    close(tabId: number, next: chrome.tabs.Tab): void {
      activeTab = next
      onRemoved.emit(tabId)
      onActivated.emit({ tabId: next.id!, windowId: next.windowId! })
    },
    onConnect,
    query,
    sendMessage,
  }
}

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe('automatic active-tab following', () => {
  it('rebinds the focused session without showing a handoff when enabled', async () => {
    const chromeMock = mockChrome()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(chromeMock.query).toHaveBeenCalled() })

    panel.onMessage.emit({ type: 'session.active', sessionId: 'session-1', isNew: true })
    await vi.waitFor(() => {
      expect(affinityStates(panel.postMessage).at(-1)).toMatchObject({
        status: 'following',
        controlled: { tabId: 1 },
      })
    })

    panel.postMessage.mockClear()
    chromeMock.activate(tab(2))

    await vi.waitFor(() => {
      expect(affinityStates(panel.postMessage).at(-1)).toMatchObject({
        status: 'following',
        controlled: { tabId: 2 },
      })
    })
    expect(affinityStates(panel.postMessage).some((state) => state.status === 'handoff')).toBe(false)
    expect(chromeMock.sendMessage).toHaveBeenCalled()
  })

  it('recovers the focused session when its controlled tab closes', async () => {
    const chromeMock = mockChrome()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(chromeMock.query).toHaveBeenCalled() })

    panel.onMessage.emit({ type: 'session.active', sessionId: 'session-closed-tab', isNew: true })
    await vi.waitFor(() => {
      expect(affinityStates(panel.postMessage).at(-1)).toMatchObject({
        status: 'following',
        controlled: { tabId: 1 },
      })
    })

    panel.postMessage.mockClear()
    chromeMock.close(1, tab(2))

    await vi.waitFor(() => {
      expect(affinityStates(panel.postMessage).at(-1)).toMatchObject({
        status: 'following',
        controlled: { tabId: 2 },
      })
    })
    expect(affinityStates(panel.postMessage).some((state) => state.status === 'lost')).toBe(false)
    expect(affinityStates(panel.postMessage).some((state) => state.status === 'handoff')).toBe(false)
  })
})
