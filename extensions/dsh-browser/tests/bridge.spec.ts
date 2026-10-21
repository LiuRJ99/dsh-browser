// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { BridgeClient, type BridgeState } from '../src/background/bridge.ts'

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING

  constructor(readonly url: string) {
    super()
    FakeWebSocket.instances.push(this)
  }

  send(): void {}

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  receive(frame: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }))
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new CloseEvent('close', { code, reason }))
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  FakeWebSocket.instances = []
})

describe('BridgeClient connection probe', () => {
  it('re-discovers after a connected Desktop restarts on a different port', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    let webPort = 49966
    const states: BridgeState[] = []
    const resolveUrl = vi.fn(async () => `ws://127.0.0.1:${webPort}/ext/bridge`)
    const client = new BridgeClient({
      onStateChange: (state) => { states.push(state) },
      onFrame: () => {},
      onHelloOk: () => {},
    }, async (url) => url === `ws://127.0.0.1:${webPort}/ext/bridge`, () => true, resolveUrl)
    client.start('ws://127.0.0.1:49966/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)
    const original = FakeWebSocket.instances[0]!
    original.open()
    await vi.advanceTimersByTimeAsync(0)
    original.receive({ t: 'hello.ok', caps: { textOnly: true, snapshotMaxChars: 32000, maxInteractiveItems: 60 } })
    await vi.advanceTimersByTimeAsync(0)
    expect(states.at(-1)).toBe('connected')

    webPort = 61967
    original.close(1001, 'server closing')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(resolveUrl).toHaveBeenCalledOnce()
    const replacement = FakeWebSocket.instances[1]!
    expect(replacement.url).toBe('ws://127.0.0.1:61967/ext/bridge')
    replacement.open()
    await vi.advanceTimersByTimeAsync(0)
    replacement.receive({ t: 'hello.ok', caps: { textOnly: true, snapshotMaxChars: 32000, maxInteractiveItems: 60 } })
    await vi.advanceTimersByTimeAsync(0)
    expect(states.at(-1)).toBe('connected')
    client.stop()
  })

  it('discards discovery that outlives a settings change', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    let finish!: (url: string) => void
    const resolveUrl = vi.fn(async () => await new Promise<string>((resolve) => { finish = resolve }))
    const client = new BridgeClient({ onStateChange: () => {}, onFrame: () => {}, onHelloOk: () => {} },
      async (url) => url.includes(':3080/'), () => true, resolveUrl)
    client.start('ws://127.0.0.1:49966/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(resolveUrl).toHaveBeenCalledOnce()
    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    finish('ws://127.0.0.1:61967/ext/bridge')
    await vi.advanceTimersByTimeAsync(0)
    expect(FakeWebSocket.instances.map((socket) => socket.url)).toEqual(['ws://127.0.0.1:3080/ext/bridge'])
    client.stop()
  })

  it('abandons discovery when the last panel closes', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    let active = true
    let finish!: (url: string) => void
    let canContinue!: () => boolean
    const resolveUrl = vi.fn(async (shouldContinue: () => boolean) => {
      canContinue = shouldContinue
      return await new Promise<string>((resolve) => { finish = resolve })
    })
    const states: BridgeState[] = []
    const client = new BridgeClient({ onStateChange: (state) => { states.push(state) }, onFrame: () => {}, onHelloOk: () => {} },
      async () => false, () => active, resolveUrl)
    client.start('ws://127.0.0.1:49966/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(canContinue()).toBe(true)
    active = false
    expect(canContinue()).toBe(false)
    finish('ws://127.0.0.1:61967/ext/bridge')
    await vi.advanceTimersByTimeAsync(0)
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(states.at(-1)).toBe('stopped')
    client.stop()
  })

  it('continues retrying when rediscovery fails', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const probe = vi.fn(async () => false)
    const resolveUrl = vi.fn(async () => { throw new Error('Host is still starting') })
    const client = new BridgeClient({ onStateChange: () => {}, onFrame: () => {}, onHelloOk: () => {} },
      probe, () => true, resolveUrl)
    client.start('ws://127.0.0.1:49966/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(resolveUrl.mock.calls.length).toBeGreaterThan(1)
    expect(probe.mock.calls.length).toBeGreaterThan(3)
    expect(client.state).toBe('reconnecting')
    client.stop()
  })

  it('waits without opening a WebSocket while the local bridge is unavailable', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const states: BridgeState[] = []
    const probe = vi.fn(async () => false)
    const client = new BridgeClient({
      onStateChange: (state) => { states.push(state) },
      onFrame: () => {},
      onHelloOk: () => {},
    }, probe)

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)

    expect(probe).toHaveBeenCalledOnce()
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(states.at(-1)).toBe('reconnecting')
    client.stop()
  })

  it('opens the WebSocket after the probe succeeds', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new BridgeClient({
      onStateChange: () => {},
      onFrame: () => {},
      onHelloOk: () => {},
    }, async () => true)

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)

    expect(FakeWebSocket.instances).toHaveLength(1)
    client.stop()
  })

  it('does not retry after the bridge explicitly replaces this connection', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const states: BridgeState[] = []
    const resolveUrl = vi.fn(async () => 'ws://127.0.0.1:61967/ext/bridge')
    const client = new BridgeClient({
      onStateChange: (state) => { states.push(state) },
      onFrame: () => {},
      onHelloOk: () => {},
    }, async () => true, () => true, resolveUrl)

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await vi.advanceTimersByTimeAsync(0)
    socket.receive({
      t: 'hello.ok',
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(states.at(-1)).toBe('connected')

    socket.close(4000, 'replaced')
    await vi.advanceTimersByTimeAsync(30_000)

    expect(states.at(-1)).toBe('stopped')
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(resolveUrl).not.toHaveBeenCalled()
  })

  it('stops reconnecting after its user-owned lease disappears', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    let active = true
    const states: BridgeState[] = []
    const client = new BridgeClient({
      onStateChange: (state) => { states.push(state) },
      onFrame: () => {},
      onHelloOk: () => {},
    }, async () => true, () => active)

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)
    const socket = FakeWebSocket.instances[0]!
    active = false
    socket.close()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(states.at(-1)).toBe('stopped')
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})
