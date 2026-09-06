// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING
  sent: string[] = []

  constructor(readonly url: string) {
    super()
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  receive(frame: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }))
  }
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

function tab(tabId: number, url = `https://example.com/${tabId}`, active = true): chrome.tabs.Tab {
  return {
    id: tabId,
    index: 0,
    windowId: 1,
    title: `Tab ${tabId}`,
    url,
    active,
  } as chrome.tabs.Tab
}

function affinityStates(postMessage: ReturnType<typeof vi.fn>): Array<{
  status?: string
  controlled?: { tabId?: number } | null
  active?: { tabId?: number } | null
}> {
  return postMessage.mock.calls
    .map(([message]) => message as { type?: string; state?: { status?: string; controlled?: { tabId?: number } | null; active?: { tabId?: number } | null } })
    .filter((message) => message.type === 'tab-affinity')
    .map((message) => message.state ?? {})
}

function mockChrome() {
  const onConnect = chromeEvent<[chrome.runtime.Port]>()
  const onActivated = chromeEvent<[{ tabId: number; windowId: number }]>()
  const onRemoved = chromeEvent<[number]>()
  const onUpdated = chromeEvent<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>()
  const onReplaced = chromeEvent<[number, number]>()

  let nextTabId = 10
  const tabStore = new Map<number, chrome.tabs.Tab>()
  const initialActive = tab(1)
  tabStore.set(1, initialActive)

  const create = vi.fn(async ({ url, active }: { url?: string; active?: boolean }) => {
    nextTabId += 1
    const effectiveUrl = url && url !== 'about:blank' ? url : `https://example.com/${nextTabId}`
    const newTab = tab(nextTabId, effectiveUrl, active ?? false)
    tabStore.set(nextTabId, newTab)
    return newTab
  })

  const remove = vi.fn(async (tabId: number) => {
    tabStore.delete(tabId)
    onRemoved.emit(tabId)
  })

  const update = vi.fn(async (tabId: number, props: { active?: boolean }) => {
    const existing = tabStore.get(tabId) ?? tab(tabId)
    if (props.active !== undefined) existing.active = props.active
    tabStore.set(tabId, existing)
    if (props.active) onActivated.emit({ tabId, windowId: 1 })
    return existing
  })

  const get = vi.fn(async (tabId: number) => {
    const existing = tabStore.get(tabId)
    if (existing === undefined) throw new Error(`No tab with id: ${tabId}`)
    return existing
  })

  const query = vi.fn(async () => [tabStore.get(1) ?? initialActive])
  const sendMessage = vi.fn(async (tabId: number, message: unknown) => {
    if ((message as { type?: string }).type === 'DSH_ACTION') {
      return { ok: true, result: { text: `action result for tab ${tabId}` } }
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
    scripting: {
      executeScript: vi.fn(async () => []),
    },
    sidePanel: { open: vi.fn(async () => {}), setPanelBehavior: vi.fn(async () => {}) },
    storage: {
      local: {
        get: vi.fn(async () => ({ dshSettings: { bridgeUrl: 'ws://127.0.0.1:3080/ext/bridge' } })),
        set: vi.fn(async () => {}),
      },
      session: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
    },
    tabs: {
      create,
      remove,
      update,
      get,
      query,
      sendMessage,
      onActivated,
      onUpdated,
      onReplaced,
      onRemoved,
    },
    webNavigation: {
      getAllFrames: vi.fn(async () => [{ frameId: 0, parentFrameId: -1, url: 'https://example.com' }]),
      onCommitted: chromeEvent<[{ tabId: number; frameId: number }]>(),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: chromeEvent<[number]>(),
      onRemoved: chromeEvent<[number]>(),
    },
  } as unknown as typeof chrome)

  return {
    create,
    remove,
    update,
    get,
    query,
    sendMessage,
    onConnect,
    tabStore,
    onActivated,
  }
}

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
  FakeWebSocket.instances = []
})

describe('per-session tab management and isolation', () => {
  it('opens a dedicated new tab for each new session and manages its lifecycle', async () => {
    const chromeMock = mockChrome()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(chromeMock.query).toHaveBeenCalled() })

    // 1. Session 1 is created as a new session -> creates and binds a new dedicated tab
    panel.onMessage.emit({ type: 'session.active', sessionId: 'session-1', isNew: true })
    await vi.waitFor(() => {
      expect(chromeMock.create).toHaveBeenCalledWith(expect.objectContaining({ active: true, url: 'about:blank' }))
    })

    await vi.waitFor(() => {
      const state = affinityStates(panel.postMessage).at(-1)
      expect(state?.controlled?.tabId).toBe(11) // First created tab id
    })

    // 2. Session 2 is created as a new session -> creates and binds another new dedicated tab
    panel.postMessage.mockClear()
    panel.onMessage.emit({ type: 'session.active', sessionId: 'session-2', isNew: true })
    await vi.waitFor(() => {
      expect(chromeMock.create).toHaveBeenCalledTimes(2)
    })

    await vi.waitFor(() => {
      const state = affinityStates(panel.postMessage).at(-1)
      expect(state?.controlled?.tabId).toBe(12) // Second created tab id
    })

    // 3. User switches back to Session 1 -> focuses Tab 11
    panel.postMessage.mockClear()
    panel.onMessage.emit({ type: 'session.active', sessionId: 'session-1', isNew: false })
    await vi.waitFor(() => {
      expect(chromeMock.update).toHaveBeenCalledWith(11, { active: true })
      const state = affinityStates(panel.postMessage).at(-1)
      expect(state?.controlled?.tabId).toBe(11)
    })

    // 4. Session 2 is purged -> closes Tab 12
    panel.onMessage.emit({
      type: 'rpc',
      id: 'purge-1',
      method: 'bridge.session.purge',
      payload: { sessionId: 'session-2' },
    })

    await vi.waitFor(() => {
      expect(chromeMock.remove).toHaveBeenCalledWith(12)
    })
  })

  it('dispatches concurrent tool calls to their respective dedicated tabs without cross-interference', async () => {
    const chromeMock = mockChrome()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ wsUrl: 'ws://127.0.0.1:3080/ext/bridge' }), { status: 200 })))
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)

    await vi.waitFor(() => {
      expect(FakeWebSocket.instances.length).toBeGreaterThan(0)
    })
    const ws = FakeWebSocket.instances.at(-1)!
    ws.open()
    await Promise.resolve()
    ws.receive({
      t: 'hello.ok',
      caps: { textOnly: true, snapshotMaxChars: 32000, maxInteractiveItems: 60 },
    })
    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ state: 'connected' }))
    })

    // Bind session-1 to Tab 11 and session-2 to Tab 12
    panel.onMessage.emit({ type: 'session.active', sessionId: 'session-1', isNew: true })
    panel.onMessage.emit({ type: 'session.active', sessionId: 'session-2', isNew: true })
    await vi.waitFor(() => {
      expect(chromeMock.create).toHaveBeenCalledTimes(2)
    })

    // Now pretend user activates an unrelated tab (Tab 1) in browser
    chromeMock.onActivated.emit({ tabId: 1, windowId: 1 })

    // Concurrently dispatch tool calls from bridge to session-1 and session-2
    ws.receive({
      t: 'tool.call',
      id: 'call-sess-1',
      name: 'browser_snapshot',
      args: {},
      sessionId: 'session-1',
      expiresAt: Date.now() + 10000,
    })

    ws.receive({
      t: 'tool.call',
      id: 'call-sess-2',
      name: 'browser_snapshot',
      args: {},
      sessionId: 'session-2',
      expiresAt: Date.now() + 10000,
    })

    // Tool call 1 should target Tab 11, tool call 2 should target Tab 12
    await vi.waitFor(() => {
      expect(chromeMock.sendMessage).toHaveBeenCalledWith(11, expect.objectContaining({ type: 'DSH_ACTION' }), expect.anything())
      expect(chromeMock.sendMessage).toHaveBeenCalledWith(12, expect.objectContaining({ type: 'DSH_ACTION' }), expect.anything())
    })

    await vi.waitFor(() => {
      const results = ws.sent
        .map((raw) => JSON.parse(raw) as { t?: string; id?: string; ok?: boolean; result?: unknown })
        .filter((frame) => frame.t === 'tool.result')
      expect(results.some((r) => r.id === 'call-sess-1' && r.ok === true)).toBe(true)
      expect(results.some((r) => r.id === 'call-sess-2' && r.ok === true)).toBe(true)
    })
  })

  it('recreates a dedicated tab when a session tab was closed and a new tool call arrives', async () => {
    const chromeMock = mockChrome()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ wsUrl: 'ws://127.0.0.1:3080/ext/bridge' }), { status: 200 })))
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)

    await vi.waitFor(() => {
      expect(FakeWebSocket.instances.length).toBeGreaterThan(0)
    })
    const ws = FakeWebSocket.instances.at(-1)!
    ws.open()
    await Promise.resolve()
    ws.receive({
      t: 'hello.ok',
      caps: { textOnly: true, snapshotMaxChars: 32000, maxInteractiveItems: 60 },
    })
    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ state: 'connected' }))
    })

    // Start session-1 -> Tab 11
    panel.onMessage.emit({ type: 'session.active', sessionId: 'session-heal', isNew: true })
    await vi.waitFor(() => {
      expect(chromeMock.create).toHaveBeenCalledTimes(1)
    })

    // Now close Tab 11
    await chromeMock.remove(11)

    // Tool call arrives for session-heal -> should automatically self-heal and create Tab 12
    ws.receive({
      t: 'tool.call',
      id: 'call-heal',
      name: 'browser_snapshot',
      args: {},
      sessionId: 'session-heal',
      expiresAt: Date.now() + 10000,
    })

    await vi.waitFor(() => {
      expect(chromeMock.create).toHaveBeenCalledTimes(2)
      expect(chromeMock.sendMessage).toHaveBeenCalledWith(12, expect.objectContaining({ type: 'DSH_ACTION' }), expect.anything())
    })

    await vi.waitFor(() => {
      const results = ws.sent
        .map((raw) => JSON.parse(raw) as { t?: string; id?: string; ok?: boolean; result?: unknown })
        .filter((frame) => frame.t === 'tool.result')
      expect(results.some((r) => r.id === 'call-heal' && r.ok === true)).toBe(true)
    })
  })
})
