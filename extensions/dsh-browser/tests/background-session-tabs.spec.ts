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
  sharePageContent?: 'ask' | 'auto' | 'off'
  localSet?: (items: Record<string, unknown>) => Promise<void>
  nativeTabGroups?: boolean
} = {}) {
  const onConnect = chromeEvent<[chrome.runtime.Port]>()
  const onMessage = chromeEvent<[unknown, chrome.runtime.MessageSender, (response: unknown) => void]>()
  const onActivated = chromeEvent<[{ tabId: number; windowId: number }]>()
  const onRemoved = chromeEvent<[number]>()
  const onUpdated = chromeEvent<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>()
  const onReplaced = chromeEvent<[number, number]>()

  let nextTabId = 10
  let nextGroupId = 20
  const tabStore = new Map<number, chrome.tabs.Tab>()
  const groups = new Map<number, chrome.tabGroups.TabGroup>()
  const sessionStorage = new Map<string, unknown>()
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

  const update = vi.fn(async (tabId: number, props: { active?: boolean; url?: string }) => {
    const existing = tabStore.get(tabId) ?? tab(tabId)
    if (props.active !== undefined) existing.active = props.active
    if (props.url !== undefined) existing.url = props.url
    tabStore.set(tabId, existing)
    if (props.active) onActivated.emit({ tabId, windowId: 1 })
    return existing
  })

  const get = vi.fn(async (tabId: number) => {
    const existing = tabStore.get(tabId)
    if (existing === undefined) throw new Error(`No tab with id: ${tabId}`)
    return existing
  })

  const group = vi.fn(async ({ tabIds, groupId }: chrome.tabs.GroupOptions) => {
    if (tabIds === undefined) throw new Error('Expected a tab ID to group')
    const ids = Array.isArray(tabIds) ? tabIds : [tabIds]
    const id = groupId ?? ++nextGroupId
    if (groupId === undefined) groups.set(id, { id, windowId: 1, color: 'grey', collapsed: false })
    for (const tabId of ids) {
      const member = tabStore.get(tabId)
      if (member === undefined || !groups.has(id)) throw new Error('No tab or group')
      member.groupId = id
    }
    return id
  })
  const tabGroups = {
    query: vi.fn(async ({ title }: chrome.tabGroups.QueryInfo) => (
      [...groups.values()].filter((item) => title === undefined || item.title === title)
    )),
    get: vi.fn(async (id: number) => {
      const existing = groups.get(id)
      if (existing === undefined) throw new Error('No group')
      return existing
    }),
    update: vi.fn(async (id: number, changes: chrome.tabGroups.UpdateProperties) => {
      const updated = { ...await tabGroups.get(id), ...changes }
      groups.set(id, updated)
      return updated
    }),
  }
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
      onMessage,
    },
    scripting: {
      executeScript: vi.fn(async () => []),
    },
    sidePanel: { open: vi.fn(async () => {}), setPanelBehavior: vi.fn(async () => {}) },
    ...(options.nativeTabGroups ? { tabGroups } : {}),
    storage: {
      local: {
        get: vi.fn(async () => ({
          dshSettings: {
            bridgeUrl: 'ws://127.0.0.1:3080/ext/bridge',
            trustedActionOrigins: options.trustedActionOrigins ?? [],
            sharePageContent: options.sharePageContent ?? 'auto',
            ...(options.trustedActionOriginsVersion === undefined
              ? {}
              : { trustedActionOriginsVersion: options.trustedActionOriginsVersion }),
          },
        })),
        set: localSet,
      },
      session: {
        get: vi.fn(async (key: string) => options.nativeTabGroups ? { [key]: sessionStorage.get(key) } : {}),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) sessionStorage.set(key, value)
        }),
        remove: vi.fn(async (key: string) => { sessionStorage.delete(key) }),
      },
    },
    tabs: {
      create,
      ...(options.nativeTabGroups ? { group } : {}),
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
    onMessage,
    tabStore,
    onActivated,
    localSet,
    groups,
    group,
    tabGroups,
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

  it.each([
    ['background-session', false, undefined, undefined],
    ['another-session', false, undefined, undefined],
    ['background-session', true, undefined, undefined],
    ['another-session', true, undefined, '资料检索 Bot'],
    ['subagent-session', true, 'background-session', '环境运维助手'],
  ])('keeps %s in the background with grouping %s and root %s', async (callingSession, nativeTabGroups, groupSessionId, groupTitle) => {
    const chromeMock = mockChrome({ nativeTabGroups })
    const { panel, ws } = await prepareToolApprovalTest(chromeMock, 'background-session')
    // Preserve an unrelated foreground tab while the session opens its target.
    chromeMock.onActivated.emit({ tabId: 1, windowId: 1 })
    await vi.waitFor(() => { expect(affinityStates(panel.postMessage).at(-1)?.active?.tabId).toBe(1) })
    panel.postMessage.mockClear()
    ws.receive({ t: 'tool.call', id: 'background-open', name: 'browser_open_tab',
      args: { url: 'https://opened.example/path', ...(nativeTabGroups ? {} : { active: false }) }, sessionId: callingSession,
      groupSessionId, groupTitle, expiresAt: Date.now() + 10000 })
    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'approval.request' }))
    })
    const approval = panel.postMessage.mock.calls
      .map(([message]) => message as { type?: string; request?: { id?: string } })
      .find(message => message.type === 'approval.request')
    panel.onMessage.emit({ type: 'approval.response', id: approval?.request?.id, decision: 'allow-once' })
    await vi.waitFor(() => { expect(chromeMock.update).toHaveBeenCalledWith(12, { url: 'https://opened.example/path' }) })
    chromeMock.onMessage.emit({ type: 'DSH_CONTENT_READY' },
      { tab: { id: 12 }, frameId: 0, url: 'https://opened.example/path' } as chrome.runtime.MessageSender, () => {})
    await vi.waitFor(() => {
      expect(ws.sent.map(raw => JSON.parse(raw))).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'background-open', ok: true }))
      expect(affinityStates(panel.postMessage).at(-1)).toMatchObject({ controlled: { tabId: callingSession === 'background-session' ? 12 : 11 }, active: { tabId: 1 } })
    })
    expect(chromeMock.create).toHaveBeenCalledWith({ url: 'about:blank', active: false, windowId: 1 })
    expect(chromeMock.remove).not.toHaveBeenCalledWith(11) // This fixture's previous tab has page content.
    expect(chromeMock.remove).not.toHaveBeenCalledWith(1)
    if (nativeTabGroups) {
      const panelGroup = chromeMock.tabStore.get(11)!.groupId
      const toolGroup = chromeMock.tabStore.get(12)!.groupId
      expect(chromeMock.groups.get(panelGroup)).toMatchObject({ collapsed: true })
      expect(chromeMock.groups.get(toolGroup)).toMatchObject({ collapsed: true })
      if (groupTitle !== undefined) expect(chromeMock.groups.get(toolGroup)?.title).toBe(groupTitle)
      expect(toolGroup === panelGroup).toBe((groupSessionId ?? callingSession) === 'background-session')
      expect(chromeMock.tabStore.get(1)?.groupId).toBeUndefined()
      panel.onMessage.emit({ type: 'session.active', sessionId: callingSession })
      await vi.waitFor(() => { expect(affinityStates(panel.postMessage).at(-1)?.controlled?.tabId).toBe(12) })
      expect(chromeMock.update).not.toHaveBeenCalledWith(12, { active: true })
    }
    chromeMock.sendMessage.mockClear()
    ws.receive({ t: 'tool.call', id: 'background-snapshot', name: 'browser_snapshot', args: {},
      sessionId: callingSession, groupSessionId, expiresAt: Date.now() + 10000 })
    await vi.waitFor(() => { expect(chromeMock.sendMessage).toHaveBeenCalledWith(12, expect.objectContaining({ type: 'DSH_ACTION' }), expect.anything()) })
    expect(chromeMock.sendMessage.mock.calls.every(([id]) => id === 12)).toBe(true)
  })

  it('creates the first controlled tab of a subagent inside its root group', async () => {
    const chromeMock = mockChrome({ nativeTabGroups: true })
    const { panel, ws } = await prepareToolApprovalTest(chromeMock, 'session-main')
    ws.receive({ t: 'tool.call', id: 'first-child-tool', name: 'browser_snapshot', args: {},
      sessionId: 'session-child', groupSessionId: 'session-main', expiresAt: Date.now() + 10000 })
    await vi.waitFor(() => {
      expect(ws.sent.map(raw => JSON.parse(raw))).toContainEqual(expect.objectContaining({ id: 'first-child-tool', ok: true }))
    })
    expect(chromeMock.tabStore.get(12)!.groupId).toBe(chromeMock.tabStore.get(11)!.groupId)
    expect(chromeMock.sendMessage).toHaveBeenCalledWith(12, expect.objectContaining({ type: 'DSH_ACTION' }), expect.anything())
    expect(affinityStates(panel.postMessage).at(-1)?.controlled?.tabId).toBe(11)
  })

  it('creates one group for concurrent opens and reuses its saved ID without re-collapsing it', async () => {
    const chromeMock = mockChrome({ nativeTabGroups: true })
    const { SessionTabGroups } = await import('../src/background/session-tab-groups.ts')
    const groups = new SessionTabGroups()
    const [first, second] = await Promise.all([
      groups.createTab('agent-one', {}),
      groups.createTab('agent-one', {}),
    ])
    expect(first.groupId).toBe(second.groupId)
    expect(chromeMock.create).toHaveBeenCalledWith({ active: false })
    expect(chromeMock.groups.get(first.groupId)).toMatchObject({ collapsed: true })
    await chromeMock.tabGroups.update(first.groupId, { collapsed: false })

    const restored = new SessionTabGroups()
    const next = await restored.createTab('agent-one', { active: false })
    expect(next.groupId).toBe(first.groupId)
    expect(chromeMock.groups.get(first.groupId)).toMatchObject({ collapsed: false })
    expect(chromeMock.groups.size).toBe(1)
  })

  it('names the tab group after the session title and renames it when the title arrives later', async () => {
    const chromeMock = mockChrome({ nativeTabGroups: true })
    const { SessionTabGroups, formatGroupTitle } = await import('../src/background/session-tab-groups.ts')

    expect(formatGroupTitle(undefined, 'session-abc')).toBe('DSH · abc')
    expect(formatGroupTitle(undefined, `session-${'a'.repeat(20)}`)).toBe('DSH · aaaaaaaa')
    expect(formatGroupTitle('  环境 \n 运维助手 ', 'session-abc')).toBe('环境 运维助手')
    expect(formatGroupTitle('x'.repeat(40), 'session-abc')).toBe('x'.repeat(40))

    const groups = new SessionTabGroups()
    const before = await groups.createTab('session-abc', { active: false })
    expect(chromeMock.groups.get(before.groupId)).toMatchObject({ title: 'DSH · abc' })

    await groups.rememberTitle('session-abc', '环境运维助手')
    expect(chromeMock.groups.get(before.groupId)).toMatchObject({ title: '环境运维助手' })

    await groups.rememberTitle('session-new', '另一个会话')
    const after = await groups.createTab('session-new', { active: false })
    expect(chromeMock.groups.get(after.groupId)).toMatchObject({ title: '另一个会话' })
    expect(chromeMock.groups.size).toBe(2)
  })

  it('renames an existing fallback-named group after the Host title lookup', async () => {
    const chromeMock = mockChrome({ nativeTabGroups: true })
    const { SessionTabGroups } = await import('../src/background/session-tab-groups.ts')

    const plain = new SessionTabGroups()
    const first = await plain.createTab('session-lookup', { active: false })
    expect(chromeMock.groups.get(first.groupId)).toMatchObject({ title: 'DSH · lookup' })

    let answer!: (value: string) => void
    const titled = new SessionTabGroups({
      resolveTitle: async () => await new Promise<string>((resolve) => { answer = resolve }),
    })
    const second = await titled.createTab('session-lookup', { active: false })
    expect(second.groupId).toBe(first.groupId)
    expect(chromeMock.groups.get(first.groupId)).toMatchObject({ title: 'DSH · lookup' })

    answer('环境运维助手')
    await vi.waitFor(() => {
      expect(chromeMock.groups.get(first.groupId)).toMatchObject({ title: '环境运维助手' })
    })
  })

  it('keeps a newer title received while an older lookup is pending', async () => {
    const chromeMock = mockChrome({ nativeTabGroups: true })
    const { SessionTabGroups } = await import('../src/background/session-tab-groups.ts')
    let answer!: (value: string) => void
    const groups = new SessionTabGroups({
      resolveTitle: () => new Promise<string>((resolve) => { answer = resolve }),
    })
    const tab = await groups.createTab('session-rename', {})
    await groups.rememberTitle('session-rename', '新的 Bot 名称')
    answer('旧的 Bot 名称')
    // The next open reuses both the group and the saved title from the live update.
    await groups.createTab('session-rename', {})
    expect(chromeMock.groups.get(tab.groupId)).toMatchObject({ title: '新的 Bot 名称', collapsed: true })
  })

  it('adopts the existing group after the worker loses its stored ids', async () => {
    const chromeMock = mockChrome({ nativeTabGroups: true })
    const { SessionTabGroups } = await import('../src/background/session-tab-groups.ts')

    const first = await new SessionTabGroups().createTab('session-adopt', { active: false })
    // Simulate a worker restart that dropped chrome.storage.session.
    await chrome.storage.session.remove('dshSessionTabGroups')

    const adopted = new SessionTabGroups({
      resolveGroup: async () => first.groupId,
      resolveTitle: async () => '环境运维助手',
    })
    const next = await adopted.createTab('session-adopt', { active: false })
    expect(next.groupId).toBe(first.groupId)
    expect(chromeMock.groups.size).toBe(1)
    await vi.waitFor(() => {
      expect(chromeMock.groups.get(first.groupId)).toMatchObject({ title: '环境运维助手' })
    })
  })

  it('renames and reuses a fallback group using the history projection from an older bridge', async () => {
    const chromeMock = mockChrome({ nativeTabGroups: true })
    const sessionId = 'session-old-bot'
    const groupId = 17
    chromeMock.groups.set(groupId, { id: groupId, windowId: 1, color: 'blue', collapsed: true, title: 'DSH · old-bot' })
    const { ws } = await prepareToolApprovalTest(chromeMock, 'browser-panel-session')

    ws.receive({ t: 'tool.call', id: 'first-bot-tool', name: 'browser_snapshot', args: {},
      sessionId, expiresAt: Date.now() + 10000 })
    const request = await vi.waitFor(() => {
      const frame = ws.sent.map((raw) => JSON.parse(raw)).find((message) =>
        message.t === 'rpc' && message.method === 'session.history' && message.payload.sessionId === sessionId)
      expect(frame?.payload).toEqual({ sessionId, maxMessages: 1 })
      return frame
    })
    ws.receive({ t: 'rpc.result', id: request.id, ok: true, result: {
      type: 'server-response', rpcId: request.id, result: { ok: true, value: {
        events: [], projections: { values: { title: '资料检索 Bot' } },
      } },
    } })

    await vi.waitFor(() => {
      expect(chromeMock.groups.get(groupId)).toMatchObject({ title: '资料检索 Bot', collapsed: true })
    })
    expect(chromeMock.tabStore.get(12)).toMatchObject({ groupId, active: false })
    expect(chromeMock.groups.size).toBe(2)
  })

  it('keeps a group owned by the user separate when the controlled tab was attached', async () => {
    const chromeMock = mockChrome({ nativeTabGroups: true })
    const { SessionTabGroups } = await import('../src/background/session-tab-groups.ts')
    const userGroup = { id: 17, windowId: 1, color: 'blue' as const, collapsed: false, title: '我的工作页' }
    chromeMock.groups.set(userGroup.id, userGroup)
    const groups = new SessionTabGroups({ resolveGroup: async () => userGroup.id })

    await groups.rememberTitle('session-bot', '资料检索 Bot')
    const opened = await groups.createTab('session-bot', {})

    expect(opened.groupId).not.toBe(userGroup.id)
    expect(chromeMock.groups.get(opened.groupId)).toMatchObject({ title: '资料检索 Bot', collapsed: true })
    expect(chromeMock.groups.get(userGroup.id)).toEqual(userGroup)
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

    const localSetBeforeAdvancedGrant = chromeMock.localSet.mock.calls.length

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
    expect(approval?.request).toMatchObject({ canTrust: true, origins: ['https://example.com'] })
    panel.onMessage.emit({ type: 'approval.response', id: approval?.request?.id, decision: 'trust-session' })

    await vi.waitFor(() => {
      const results = ws.sent
        .map((raw) => JSON.parse(raw) as { t?: string; id?: string; ok?: boolean; result?: unknown })
        .filter((frame) => frame.t === 'tool.result')
      expect(results.some((r) => r.id === 'call-attach' && r.ok === true)).toBe(true)
    })
    expect(chromeMock.localSet).toHaveBeenCalledTimes(localSetBeforeAdvancedGrant)

    // 4. The session grant covers another attach without a second prompt.
    panel.postMessage.mockClear()
    ws.receive({
      t: 'tool.call',
      id: 'call-attach-again',
      name: 'browser_attach_tab',
      args: { tabId: 11 },
      sessionId: 'subagent-session',
      expiresAt: Date.now() + 10000,
    })
    await vi.waitFor(() => {
      const results = ws.sent
        .map((raw) => JSON.parse(raw) as { t?: string; id?: string; ok?: boolean })
        .filter((frame) => frame.t === 'tool.result')
      expect(results.some((result) => result.id === 'call-attach-again' && result.ok === true)).toBe(true)
    })
    expect(panel.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'approval.request' }))

    // 5. Subagent subsequently calls browser_snapshot -> targets Tab 11!
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
    await vi.waitFor(() => {
      const results = ws.sent
        .map((raw) => JSON.parse(raw) as { t?: string; id?: string; ok?: boolean })
        .filter((frame) => frame.t === 'tool.result')
      expect(results.some((result) => result.id === 'call-subagent-snapshot' && result.ok === true)).toBe(true)
    })

    // 5. A bound-session browser_close_tab must stay in the Service Worker;
    // content.js does not implement tab collection operations.
    chromeMock.sendMessage.mockClear()
    panel.postMessage.mockClear()
    ws.receive({
      t: 'tool.call',
      id: 'call-close-bound',
      name: 'browser_close_tab',
      args: { tabId: 11 },
      sessionId: 'subagent-session',
      expiresAt: Date.now() + 10000,
    })

    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'approval.request' }))
    })
    const closeApproval = panel.postMessage.mock.calls
      .map(([message]) => message as { type?: string; request?: { id?: string; advancedPermission?: string } })
      .find((message) => message.type === 'approval.request')
    expect(closeApproval?.request?.advancedPermission).toBeUndefined()
    panel.onMessage.emit({ type: 'approval.response', id: closeApproval?.request?.id, decision: 'allow-once' })

    await vi.waitFor(() => {
      expect(chromeMock.remove).toHaveBeenCalledWith(11)
      const results = ws.sent
        .map((raw) => JSON.parse(raw) as { t?: string; id?: string; ok?: boolean })
        .filter((frame) => frame.t === 'tool.result')
      expect(results.some((result) => result.id === 'call-close-bound' && result.ok === true)).toBe(true)
    })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()

    // 6. Opening a tab after the bound target is gone also uses the
    // Service Worker path, not resolveToolTab/content.js.
    panel.postMessage.mockClear()
    ws.receive({
      t: 'tool.call',
      id: 'call-open-bound',
      name: 'browser_open_tab',
      args: { url: 'https://opened.example/path' },
      sessionId: 'subagent-session',
      expiresAt: Date.now() + 10000,
    })

    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'approval.request' }))
    })
    const openApproval = panel.postMessage.mock.calls
      .map(([message]) => message as { type?: string; request?: { id?: string } })
      .find((message) => message.type === 'approval.request')
    panel.onMessage.emit({ type: 'approval.response', id: openApproval?.request?.id, decision: 'allow-once' })

    await vi.waitFor(() => {
      expect(chromeMock.update).toHaveBeenCalledWith(13, { url: 'https://opened.example/path' })
    })
    chromeMock.onMessage.emit(
      { type: 'DSH_CONTENT_READY' },
      { tab: { id: 13 }, frameId: 0, url: 'https://opened.example/path' } as chrome.runtime.MessageSender,
      () => {},
    )
    await vi.waitFor(() => {
      const results = ws.sent
        .map((raw) => JSON.parse(raw) as { t?: string; id?: string; ok?: boolean })
        .filter((frame) => frame.t === 'tool.result')
      expect(results.some((result) => result.id === 'call-open-bound' && result.ok === true)).toBe(true)
    })
    expect(chromeMock.create).toHaveBeenCalledWith({ url: 'about:blank', active: true, windowId: 1 })
    expect(chromeMock.sendMessage.mock.calls.some(([tabId, message]) =>
      tabId === 13 && (message as { action?: string }).action === 'browser_open_tab')).toBe(false)
  })
})
