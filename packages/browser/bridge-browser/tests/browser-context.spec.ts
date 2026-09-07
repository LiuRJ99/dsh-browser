import { describe, expect, it, vi } from 'vitest'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import {
  BROWSER_CONTEXT_PLUGIN,
  BrowserContextInjector,
  createBrowserSnapshotMessage,
} from '../src/browser-context.ts'

function fakeAgent(id: string): Agent & { inject: ReturnType<typeof vi.fn> } {
  return { id, inject: vi.fn() } as unknown as Agent & { inject: ReturnType<typeof vi.fn> }
}

describe('browser page context', () => {
  it('builds plugin-owned snapshot context for the model', () => {
    const message = createBrowserSnapshotMessage('Page: Example')

    expect(message.role).toBe('user')
    expect(message.source).toEqual({
      kind: 'plugin',
      plugin: BROWSER_CONTEXT_PLUGIN,
      form: 'snapshot',
      sections: [{
        name: 'browser-page',
        text: expect.stringContaining('Page: Example'),
      }],
    })
    expect(message.content).toEqual([{
      type: 'text',
      text: expect.stringContaining('browser page context was refreshed'),
    }])
    expect(message.content[0].text).toContain('already completed browser_snapshot')
    expect(message.content[0].text).toContain('do not take an immediate duplicate snapshot')
  })

  it('injects immediately when the Agent is live', () => {
    const agent = fakeAgent('session-live')
    const agents = { get: vi.fn(() => agent) } as unknown as Pick<AgentRegistry, 'get'>
    const injector = new BrowserContextInjector(agents)

    expect(injector.inject('session-live', 'Live page')).toBe('injected')
    expect(agent.inject).toHaveBeenCalledOnce()
    expect(agent.inject.mock.calls[0]![0].content[0].text).toContain('Live page')
  })

  it('retains only the latest snapshot until a deferred Agent starts', () => {
    const agent = fakeAgent('session-later')
    const agents = { get: vi.fn(() => undefined) } as unknown as Pick<AgentRegistry, 'get'>
    const injector = new BrowserContextInjector(agents)

    expect(injector.inject('session-later', 'Old page')).toBe('queued')
    expect(injector.inject('session-later', 'New page')).toBe('queued')
    expect(injector.activate(agent)).toBe(true)
    expect(injector.activate(agent)).toBe(false)
    expect(agent.inject).toHaveBeenCalledOnce()
    expect(agent.inject.mock.calls[0]![0].content[0].text).toContain('New page')
    expect(agent.inject.mock.calls[0]![0].content[0].text).not.toContain('Old page')
  })

  it('drops provisional context when the Agent becomes live before another injection', () => {
    const agent = fakeAgent('session-race')
    const get = vi.fn()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(agent)
    const injector = new BrowserContextInjector({ get } as unknown as Pick<AgentRegistry, 'get'>)

    injector.inject('session-race', 'Queued page')
    injector.inject('session-race', 'Live page')

    expect(injector.activate(agent)).toBe(false)
    expect(agent.inject).toHaveBeenCalledOnce()
    expect(agent.inject.mock.calls[0]![0].content[0].text).toContain('Live page')
  })

  it('bounds snapshots for provisional sessions that never materialize', () => {
    const agents = { get: vi.fn(() => undefined) } as unknown as Pick<AgentRegistry, 'get'>
    const injector = new BrowserContextInjector(agents, 2)
    const first = fakeAgent('first')
    const second = fakeAgent('second')
    const third = fakeAgent('third')

    injector.inject('first', 'First page')
    injector.inject('second', 'Second page')
    injector.inject('third', 'Third page')

    expect(injector.activate(first)).toBe(false)
    expect(injector.activate(second)).toBe(true)
    expect(injector.activate(third)).toBe(true)
  })
})

describe('browser page context gating', () => {
  it('queues snapshots while the session gate is closed and flushes after it opens', () => {
    let gateOpen = false
    const agent = fakeAgent('session-gated')
    const agents = { get: vi.fn(() => agent) } as unknown as Pick<AgentRegistry, 'get'>
    const injector = new BrowserContextInjector(agents, undefined, () => gateOpen)

    expect(injector.inject('session-gated', 'Locked page')).toBe('queued')
    expect(agent.inject).not.toHaveBeenCalled()

    // Gate still closed: neither session-start activation nor step flushes leak it.
    expect(injector.activate(agent)).toBe(false)
    expect(injector.flush(agent)).toBe(false)
    expect(agent.inject).not.toHaveBeenCalled()

    // Unlock: the next delivery boundary injects the newest queued snapshot.
    gateOpen = true
    expect(injector.flush(agent)).toBe(true)
    expect(agent.inject).toHaveBeenCalledOnce()
    expect(agent.inject.mock.calls[0]![0].content[0].text).toContain('Locked page')
    expect(injector.flush(agent)).toBe(false)
  })

  it('delivers the newest snapshot when the gate opens over a queued supersession', () => {
    const agent = fakeAgent('session-superseded')
    const get = vi.fn()
      .mockReturnValueOnce(undefined)
      .mockReturnValue(agent)
    let gateOpen = false
    const injector = new BrowserContextInjector({ get } as unknown as Pick<AgentRegistry, 'get'>, undefined, () => gateOpen)

    expect(injector.inject('session-superseded', 'Old page')).toBe('queued')
    expect(injector.inject('session-superseded', 'New page')).toBe('queued')

    gateOpen = true
    expect(injector.activate(agent)).toBe(true)
    expect(agent.inject).toHaveBeenCalledOnce()
    expect(agent.inject.mock.calls[0]![0].content[0].text).toContain('New page')
    expect(agent.inject.mock.calls[0]![0].content[0].text).not.toContain('Old page')
  })

  it('keeps un-gated behavior when no gate is supplied', () => {
    const agent = fakeAgent('session-open')
    const agents = { get: vi.fn(() => agent) } as unknown as Pick<AgentRegistry, 'get'>
    const injector = new BrowserContextInjector(agents)

    expect(injector.inject('session-open', 'Live page')).toBe('injected')
    expect(agent.inject).toHaveBeenCalledOnce()
  })

  it('degrades to delivery when the gate itself throws', () => {
    const agent = fakeAgent('session-broken-gate')
    const agents = { get: vi.fn(() => agent) } as unknown as Pick<AgentRegistry, 'get'>
    const injector = new BrowserContextInjector(agents, undefined, () => { throw new Error('gate unavailable') })

    expect(injector.inject('session-broken-gate', 'Page')).toBe('injected')
    expect(agent.inject).toHaveBeenCalledOnce()
  })
})
