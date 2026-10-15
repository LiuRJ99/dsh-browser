// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeState } from '../src/background/bridge.ts'
import type { PanelApi } from '../src/panel/api.ts'

let panelApi: PanelApi

vi.mock('../src/panel/api.ts', () => ({
  connectPanel: (): PanelApi => panelApi,
}))

import { App } from '../src/panel/App.tsx'

describe('panel session transitions', () => {
  let root: Root
  let onStatus: ((state: BridgeState, caps: null) => void) | undefined
  let onResumeHint: ((sessionId: string | null) => void) | undefined

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    HTMLElement.prototype.scrollTo = vi.fn()
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async () => ({ dshSettings: { autoResumeSession: false } })),
        },
      },
      windows: { getCurrent: vi.fn(async () => ({ id: 1 })) },
    })

    const rpc = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === 'session.create') return { sessionId: 'session-current' }
      if (method === 'session.history') return { events: [] }
      if (method === 'session.list') {
        return {
          items: [
            { sessionId: 'session-current', updatedAt: 2, running: false, blank: false },
            { sessionId: 'session-saved', updatedAt: 1, running: false, blank: false },
          ],
        }
      }
      throw new Error(`unexpected RPC: ${method}`)
    })
    const unsubscribe = (): void => {}
    panelApi = {
      rpc: async <T = unknown>(method: string, payload?: unknown): Promise<T> =>
        await rpc(method, payload) as T,
      respond: vi.fn(async () => undefined),
      onStatus: vi.fn((callback) => { onStatus = callback; return unsubscribe }),
      onEvent: vi.fn(() => unsubscribe),
      onApprovalRequest: vi.fn(() => unsubscribe),
      onApprovalResolved: vi.fn(() => unsubscribe),
      onTabAffinity: vi.fn(() => unsubscribe),
      onSelection: vi.fn(() => unsubscribe),
      onSessionResumeHint: vi.fn((callback) => { onResumeHint = callback; return unsubscribe }),
      respondToApproval: vi.fn(async () => {}),
      resolveTabAffinity: vi.fn(async () => {}),
      rebindTabAffinity: vi.fn(async () => {}),
      clearSelection: vi.fn(async () => {}),
      registerWindow: vi.fn(async () => {}),
      setActiveSession: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('runtime port unavailable')),
      updateSettings: vi.fn(async () => {}),
      requestStatus: vi.fn(async () => {}),
    }

    root = createRoot(document.querySelector('#root')!)
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('releases the controls and surfaces an activation failure', async () => {
    await act(async () => { root.render(createElement(App)) })
    await act(async () => {
      onStatus?.('connected', null)
      onResumeHint?.(null)
    })
    await vi.waitFor(() => {
      expect(panelApi.setActiveSession).toHaveBeenCalledWith('session-current', true)
    })

    const sessionMenu = document.querySelector<HTMLButtonElement>('.session-menu-trigger')!
    const originalSessionTitle = sessionMenu.textContent
    await act(async () => { sessionMenu.click() })
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.session-list li > button:not(.session-delete)')).toHaveLength(2)
    })

    const savedSession = document.querySelectorAll<HTMLButtonElement>('.session-list li > button:not(.session-delete)')[1]
    await act(async () => { savedSession.click() })
    await vi.waitFor(() => {
      expect(document.querySelector('.error')?.textContent).toBe('runtime port unavailable')
    })

    expect(sessionMenu.disabled).toBe(false)
    expect(document.querySelector<HTMLButtonElement>('.new-session-trigger')?.disabled).toBe(false)
    expect(savedSession.disabled).toBe(false)
    expect(sessionMenu.textContent).toBe(originalSessionTitle)
  })

  it('allows starting a new session while current session is working', async () => {
    let onEventCallback: ((frame: any) => void) | undefined
    panelApi.onEvent = vi.fn((callback) => { onEventCallback = callback; return () => {} })
    panelApi.setActiveSession = vi.fn().mockResolvedValue(undefined)

    await act(async () => { root.render(createElement(App)) })
    await act(async () => {
      onStatus?.('connected', null)
      onResumeHint?.(null)
    })
    await vi.waitFor(() => {
      expect(panelApi.setActiveSession).toHaveBeenCalledWith('session-current', true)
    })

    await act(async () => {
      onEventCallback?.({
        t: 'event',
        frame: {
          type: 'event',
          payload: {
            sessionId: 'session-current',
            event: { type: 'turn/start', seq: 1 },
          },
        },
      })
    })

    const newSessionButton = document.querySelector<HTMLButtonElement>('.new-session-trigger')!
    expect(newSessionButton.disabled).toBe(false)

    await act(async () => { newSessionButton.click() })
    await vi.waitFor(() => {
      expect(panelApi.setActiveSession).toHaveBeenCalledTimes(2)
    })
    expect(panelApi.rebindTabAffinity).not.toHaveBeenCalled()
  })

  it('waits for a fresh resume hint after a bridge restart', async () => {
    const storageGet = chrome.storage.local.get as unknown as { mockResolvedValue: (value: unknown) => void }
    storageGet.mockResolvedValue({ dshSettings: { autoResumeSession: true } })

    await act(async () => { root.render(createElement(App)) })
    await act(async () => {
      onStatus?.('connected', null)
      onResumeHint?.(null)
    })
    await vi.waitFor(() => {
      expect(panelApi.setActiveSession).toHaveBeenCalledWith('session-current')
    })
    const callsAfterInitialSession = (panelApi.setActiveSession as ReturnType<typeof vi.fn>).mock.calls.length

    await act(async () => { onStatus?.('stopped', null) })
    await act(async () => { onStatus?.('connected', null) })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect((panelApi.setActiveSession as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterInitialSession)

    await act(async () => { onResumeHint?.(null) })
    await vi.waitFor(() => {
      expect((panelApi.setActiveSession as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsAfterInitialSession)
    })
  })
  it('keeps the reading position on new activity and resumes following after the bottom control', async () => {
    let event: Parameters<PanelApi['onEvent']>[0] | undefined
    panelApi.onEvent = vi.fn(callback => { event = callback; return () => {} })
    panelApi.setActiveSession = vi.fn().mockResolvedValue(undefined)
    await act(async () => { root.render(createElement(App)) })
    await act(async () => { onStatus?.('connected', null); onResumeHint?.(null) })
    await vi.waitFor(() => { expect(panelApi.setActiveSession).toHaveBeenCalledWith('session-current', true) })
    const messages = document.querySelector<HTMLElement>('.messages')!
    Object.defineProperties(messages, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 300 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    })
    await act(async () => { messages.dispatchEvent(new Event('scroll')) })
    expect(document.querySelector('.scroll-to-bottom')).not.toBeNull()
    const scroll = vi.mocked(HTMLElement.prototype.scrollTo)
    scroll.mockClear()
    await act(async () => {
      event?.({ t: 'event', frame: { type: 'event', payload: {
        sessionId: 'session-current', event: { type: 'turn/start', seq: 1 },
      } } } as never)
    })
    expect(scroll).not.toHaveBeenCalled()
    await act(async () => { document.querySelector<HTMLButtonElement>('.scroll-to-bottom')!.click() })
    expect(scroll).toHaveBeenCalledWith({ top: 1000, behavior: 'smooth' })
    expect(document.querySelector('.scroll-to-bottom')).toBeNull()
    scroll.mockClear()
    await act(async () => {
      event?.({ t: 'event', frame: { type: 'event', payload: {
        sessionId: 'session-current', event: { type: 'turn/end', seq: 2 },
      } } } as never)
    })
    expect(scroll).toHaveBeenCalledWith({ top: 1000, behavior: 'instant' })
  })

})
