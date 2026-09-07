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

  close(code = 1000): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    const event = new Event('close') as Event & { code: number }
    event.code = code
    this.dispatchEvent(event)
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
  const panel = { onDisconnect, onMessage, port, postMessage }
  activePanels.add(panel)
  return panel
}

const activePanels = new Set<ReturnType<typeof panelPort>>()

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

function mockChrome(options: {
  trustedActionOrigins?: string[]
  trustedActionOriginsVersion?: 1
  localSet?: (items: Record<string, unknown>) => Promise<void>
} = {}) {
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

  const localSet = vi.fn(options.localSet ?? (async () => {}))

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
        get: vi.fn(async () => ({
          dshSettings: {
            bridgeUrl: 'ws://127.0.0.1:3080/ext/bridge',
            trustedActionOrigins: options.trustedActionOrigins ?? [],
            ...(options.trustedActionOriginsVersion === undefined
              ? {}
              : { trustedActionOriginsVersion: options.trustedActionOriginsVersion }),
          },
        })),
        set: localSet,
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
    localSet,
  }
}

async function prepareToolApprovalTest(
  chromeMock: ReturnType<typeof mockChrome>,
  sessionId: string,
): Promise<{ panel: ReturnType<typeof panelPort>; ws: FakeWebSocket }> {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ wsUrl: 'ws://127.0.0.1:3080/ext/bridge' }), { status: 200 })))
  vi.stubGlobal('WebSocket', FakeWebSocket)
  await import('../src/background/index.ts')
  await vi.waitFor(() => { expect(chrome.storage.local.get).toHaveBeenCalled() })

  const panel = panelPort()
  chromeMock.onConnect.emit(panel.port)
  await vi.waitFor(() => { expect(FakeWebSocket.instances.length).toBeGreaterThan(0) })
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
  panel.onMessage.emit({ type: 'session.active', sessionId, isNew: true })
  await vi.waitFor(() => { expect(chromeMock.create).toHaveBeenCalledTimes(1) })
  await vi.waitFor(() => {
    expect(chromeMock.sendMessage).toHaveBeenCalledWith(11, expect.objectContaining({ type: 'DSH_ACTION' }), expect.anything())
  })
  chromeMock.sendMessage.mockClear()
  panel.postMessage.mockClear()
  return { panel, ws }
}

afterEach(async () => {
  for (const panel of activePanels) panel.onDisconnect.emit()
  activePanels.clear()
  for (const socket of FakeWebSocket.instances) socket.close()
  // Let bridge close handlers finish while the mocked chrome global still exists.
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
  FakeWebSocket.instances = []
  vi.resetModules()
  vi.unstubAllGlobals()
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
    await vi.waitFor(() => { expect(chrome.storage.local.get).toHaveBeenCalled() })

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
    await vi.waitFor(() => { expect(chrome.storage.local.get).toHaveBeenCalled() })

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

  it('repairs a legacy implicit global wildcard without blocking startup', async () => {
    const chromeMock = mockChrome({ trustedActionOrigins: ['*'] })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    await vi.waitFor(() => {
      expect(chromeMock.localSet).toHaveBeenCalledWith({
        dshSettings: expect.objectContaining({
          trustedActionOrigins: [],
          trustedActionOriginsVersion: 1,
        }),
      })
    })
  })

  it('requires approval by default, then persists a trusted origin selected by the user', async () => {
    const chromeMock = mockChrome()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ wsUrl: 'ws://127.0.0.1:3080/ext/bridge' }), { status: 200 })))
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(chrome.storage.local.get).toHaveBeenCalled() })

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances.length).toBeGreaterThan(0) })
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

    panel.onMessage.emit({ type: 'session.active', sessionId: 'approval-session', isNew: true })
    await vi.waitFor(() => { expect(chromeMock.create).toHaveBeenCalledTimes(1) })
    await vi.waitFor(() => {
      expect(chromeMock.sendMessage).toHaveBeenCalledWith(11, expect.objectContaining({ type: 'DSH_ACTION' }), expect.anything())
    })
    chromeMock.sendMessage.mockClear()
    panel.postMessage.mockClear()

    ws.receive({
      t: 'tool.call',
      id: 'call-needs-approval',
      name: 'browser_press',
      args: { key: 'Enter' },
      sessionId: 'approval-session',
      expiresAt: Date.now() + 10_000,
    })

    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'approval.request' }))
    })
    const approvalMessage = panel.postMessage.mock.calls
      .map(([message]) => message as { type?: string; request?: { id?: string; origins?: string[] } })
      .find((message) => message.type === 'approval.request')
    expect(approvalMessage?.request).toMatchObject({ origins: ['https://example.com'] })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()

    panel.onMessage.emit({
      type: 'approval.response',
      id: approvalMessage?.request?.id,
      decision: 'trust-origin',
    })
    await vi.waitFor(() => {
      expect(chromeMock.sendMessage).toHaveBeenCalledWith(11, expect.objectContaining({ type: 'DSH_ACTION' }), expect.anything())
    })
    expect(chromeMock.localSet).toHaveBeenCalledWith({
      dshSettings: expect.objectContaining({ trustedActionOrigins: ['https://example.com'] }),
    })

    chromeMock.sendMessage.mockClear()
    panel.postMessage.mockClear()
    ws.receive({
      t: 'tool.call',
      id: 'call-trusted-origin',
      name: 'browser_press',
      args: { key: 'Enter' },
      sessionId: 'approval-session',
      expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => {
      expect(chromeMock.sendMessage).toHaveBeenCalledWith(11, expect.objectContaining({ type: 'DSH_ACTION' }), expect.anything())
    })
    expect(panel.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'approval.request' }))
  })

  it('honors a literal wildcard only when it is present in configured settings', async () => {
    const chromeMock = mockChrome({ trustedActionOrigins: ['*'], trustedActionOriginsVersion: 1 })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ wsUrl: 'ws://127.0.0.1:3080/ext/bridge' }), { status: 200 })))
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(chrome.storage.local.get).toHaveBeenCalled() })

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances.length).toBeGreaterThan(0) })
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
    panel.onMessage.emit({ type: 'session.active', sessionId: 'wildcard-session', isNew: true })
    await vi.waitFor(() => { expect(chromeMock.create).toHaveBeenCalledTimes(1) })
    await vi.waitFor(() => {
      expect(chromeMock.sendMessage).toHaveBeenCalledWith(11, expect.objectContaining({ type: 'DSH_ACTION' }), expect.anything())
    })
    chromeMock.sendMessage.mockClear()
    panel.postMessage.mockClear()

    ws.receive({
      t: 'tool.call',
      id: 'call-explicit-wildcard',
      name: 'browser_press',
      args: { key: 'Enter' },
      sessionId: 'wildcard-session',
      expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => {
      expect(chromeMock.sendMessage).toHaveBeenCalledWith(11, expect.objectContaining({ type: 'DSH_ACTION' }), expect.anything())
    })
    expect(panel.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'approval.request' }))
  })

  it('does not retain an origin when trusted-list persistence fails', async () => {
    const chromeMock = mockChrome({ localSet: async () => { throw new Error('storage unavailable') } })
    const { panel, ws } = await prepareToolApprovalTest(chromeMock, 'failed-trust-session')

    ws.receive({
      t: 'tool.call',
      id: 'call-failed-trust',
      name: 'browser_press',
      args: { key: 'Enter' },
      sessionId: 'failed-trust-session',
      expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'approval.request' }))
    })
    const approvalMessage = panel.postMessage.mock.calls
      .map(([message]) => message as { type?: string; request?: { id?: string } })
      .find((message) => message.type === 'approval.request')
    panel.onMessage.emit({
      type: 'approval.response',
      id: approvalMessage?.request?.id,
      decision: 'trust-origin',
    })
    await vi.waitFor(() => {
      const results = ws.sent
        .map((raw) => JSON.parse(raw) as { t?: string; id?: string; ok?: boolean; error?: { code?: string } })
        .filter((frame) => frame.t === 'tool.result')
      expect(results.some((result) => result.id === 'call-failed-trust' && result.ok === false && result.error?.code === 'internal')).toBe(true)
    })

    panel.postMessage.mockClear()
    chromeMock.sendMessage.mockClear()
    ws.receive({
      t: 'tool.call',
      id: 'call-after-failed-trust',
      name: 'browser_press',
      args: { key: 'Enter' },
      sessionId: 'failed-trust-session',
      expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'approval.request' }))
    })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('allows a subagent or session to attach to an existing tab via browser_attach_tab', async () => {
    const chromeMock = mockChrome()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ wsUrl: 'ws://127.0.0.1:3080/ext/bridge' }), { status: 200 })))
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(chrome.storage.local.get).toHaveBeenCalled() })

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

    // 1. Parent session starts on Tab 11
    panel.onMessage.emit({ type: 'session.active', sessionId: 'parent-session', isNew: true })
    await vi.waitFor(() => {
      expect(chromeMock.create).toHaveBeenCalledTimes(1)
    })

    // 2. Subagent session starts and initially receives its own Tab 12
    panel.onMessage.emit({ type: 'session.active', sessionId: 'subagent-session', isNew: true })
    await vi.waitFor(() => {
      expect(chromeMock.create).toHaveBeenCalledTimes(2)
    })

    // 3. Subagent calls browser_attach_tab to take over Tab 11
    ws.receive({
      t: 'tool.call',
      id: 'call-attach',
      name: 'browser_attach_tab',
      args: { tabId: 11 },
      sessionId: 'subagent-session',
      expiresAt: Date.now() + 10000,
    })

    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'approval.request' }))
    })
    const approval = panel.postMessage.mock.calls
      .map(([message]) => message as { type?: string; request?: { id?: string } })
      .find((message) => message.type === 'approval.request')
    panel.onMessage.emit({ type: 'approval.response', id: approval?.request?.id, decision: 'allow-once' })

    await vi.waitFor(() => {
      const results = ws.sent
        .map((raw) => JSON.parse(raw) as { t?: string; id?: string; ok?: boolean; result?: unknown })
        .filter((frame) => frame.t === 'tool.result')
      expect(results.some((r) => r.id === 'call-attach' && r.ok === true)).toBe(true)
    })

    // 4. Subagent subsequently calls browser_snapshot -> targets Tab 11!
    ws.receive({
      t: 'tool.call',
      id: 'call-subagent-snapshot',
      name: 'browser_snapshot',
      args: {},
      sessionId: 'subagent-session',
      expiresAt: Date.now() + 10000,
    })

    await vi.waitFor(() => {
      expect(chromeMock.sendMessage).toHaveBeenCalledWith(11, expect.objectContaining({ type: 'DSH_ACTION' }), expect.anything())
    })
  })
})
