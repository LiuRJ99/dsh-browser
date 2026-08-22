// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// Stub chrome before importing the module under test so the module-level
// closures (and any late `finally` detach) always see a defined global.
vi.stubGlobal('chrome', { runtime: { lastError: undefined } })

// Mock chrome globals before importing the module under test.
const listeners: Array<(_source: unknown, method: string, params: unknown) => void> = []
let attachError: string | undefined
let lastCommand: { method: string; params: Record<string, unknown> } | null = null
let commandResult: unknown = { data: 'aGVsbG8=' }

const debuggerMock = {
  attach: vi.fn((_target: unknown, _version: string, cb: () => void) => {
    if (attachError !== undefined) {
      const err = attachError
      attachError = undefined
      chrome.runtime.lastError = { message: err }
      cb()
      chrome.runtime.lastError = undefined
      return
    }
    chrome.runtime.lastError = undefined
    cb()
  }),
  detach: vi.fn(),
  sendCommand: vi.fn((_target: unknown, method: string, params: Record<string, unknown>, cb: (result: unknown) => void) => {
    lastCommand = { method, params }
    chrome.runtime.lastError = undefined
    cb(commandResult)
  }),
  onEvent: {
    addListener: vi.fn((fn: (_source: unknown, method: string, params: unknown) => void) => { listeners.push(fn) }),
    removeListener: vi.fn((fn: (_source: unknown, method: string, params: unknown) => void) => {
      const i = listeners.indexOf(fn)
      if (i >= 0) listeners.splice(i, 1)
    }),
  },
}

const downloadsMock = {
  onChanged: {
    addListener: vi.fn(),
    removeListener: vi.fn(),
  },
  search: vi.fn(async () => [{ id: 1, filename: '/tmp/export.csv', fileSize: 1234 }]),
}

beforeEach(() => {
  listeners.length = 0
  attachError = undefined
  lastCommand = null
  commandResult = { data: 'aGVsbG8=' }
  Object.assign(globalThis.chrome, {
    runtime: { lastError: undefined },
    debugger: debuggerMock,
    downloads: downloadsMock,
    tabs: { query: vi.fn(async () => [{ id: 1, title: 'A', url: 'https://a.example' }, { id: 2, title: 'B', url: 'https://b.example' }]) },
  })
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
  // Re-establish a minimal chrome global for any late `finally` detach.
  vi.stubGlobal('chrome', { runtime: { lastError: undefined } })
})

const { runScreenshot, runDownloadWait, runListTabs, runNetworkCapture, runEval } = await import('../src/background/debugger-tools.ts')

describe('runScreenshot', () => {
  it('attaches, captures, and returns base64 data', async () => {
    const answer = await runScreenshot(1, { fullPage: true, format: 'png' })
    expect(answer.ok).toBe(true)
    expect((answer as { result: { data: string } }).result.data).toBe('aGVsbG8=')
    expect(lastCommand?.method).toBe('Page.captureScreenshot')
    expect(lastCommand?.params.captureBeyondViewport).toBe(true)
    expect(debuggerMock.detach).toHaveBeenCalled()
  })

  it('fails cleanly when attach is rejected', async () => {
    attachError = 'Cannot access a chrome:// URL'
    const answer = await runScreenshot(1, {})
    expect(answer.ok).toBe(false)
    if (!answer.ok) expect(answer.error?.message).toContain('Cannot access')
  })
})

describe('runDownloadWait', () => {
  it('resolves with the completed download path', async () => {
    let deltaListener: ((delta: unknown) => void) | undefined
    downloadsMock.onChanged.addListener.mockImplementation((fn: (delta: unknown) => void) => { deltaListener = fn })
    const pending = runDownloadWait(1, { timeoutMs: 5_000 })
    deltaListener!({ id: 1, state: { current: 'complete' } })
    const answer = await pending
    expect(answer.ok).toBe(true)
    if (answer.ok) expect((answer.result as { text: string }).text).toContain('/tmp/export.csv')
  })

  it('times out when no download completes', async () => {
    const answer = await runDownloadWait(1, { timeoutMs: 100 })
    expect(answer.ok).toBe(false)
    if (!answer.ok) expect(answer.error?.code).toBe('timeout')
  })
})

describe('runListTabs', () => {
  it('lists tabs as id | title | url lines', async () => {
    const answer = await runListTabs()
    expect(answer.ok).toBe(true)
    if (answer.ok) {
      const text = (answer.result as { text: string }).text
      expect(text).toContain('1 | A | https://a.example')
      expect(text).toContain('2 | B | https://b.example')
    }
  })
})

describe('runNetworkCapture', () => {
  it('captures matching responses with bodies', async () => {
    commandResult = { body: '{"rows":[]}' }
    const pending = runNetworkCapture(1, { durationMs: 50, urlPattern: 'data' })
    // Wait for attach + Network.enable + onEvent.addListener to complete.
    await vi.waitFor(() => expect(listeners.length).toBeGreaterThan(0))
    listeners[0]!(undefined, 'Network.responseReceived', { requestId: 'r1', response: { url: 'https://x/data', status: 200 } })
    listeners[0]!(undefined, 'Network.loadingFinished', { requestId: 'r1' })
    const answer = await pending
    expect(answer.ok).toBe(true)
    if (answer.ok) {
      const text = (answer.result as { text?: unknown }).text
      expect(typeof text === 'string' && text.includes('https://x/data')).toBe(true)
    }
  })
})

describe('runEval', () => {
  it('evaluates via Runtime.evaluate and returns the value as text', async () => {
    commandResult = { result: { value: 'hello-page', type: 'string' } }
    const answer = await runEval(1, { expression: 'document.title' })
    expect(answer.ok).toBe(true)
    if (answer.ok) expect((answer.result as { text: string }).text).toBe('hello-page')
    expect(lastCommand?.method).toBe('Runtime.evaluate')
    expect(lastCommand?.params.returnByValue).toBe(true)
  })

  it('surfaces an evaluation exception as a stable error', async () => {
    commandResult = { exceptionDetails: { text: 'ReferenceError', exception: { description: 'x is not defined' } } }
    const answer = await runEval(1, { expression: 'x.y' })
    expect(answer.ok).toBe(false)
    if (!answer.ok) expect(answer.error?.message).toContain('x is not defined')
  })

  it('rejects an empty expression', async () => {
    const answer = await runEval(1, { expression: '' })
    expect(answer.ok).toBe(false)
    if (!answer.ok) expect(answer.error?.code).toBe('bad-args')
  })
})
