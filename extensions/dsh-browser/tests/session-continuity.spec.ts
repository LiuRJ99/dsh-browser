// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { RecentSessionTracker, sessionIdFromFrame, sessionTitleFromFrame } from '../src/background/session-continuity.ts'

describe('RecentSessionTracker', () => {
  it('restores and persists the latest browser session', async () => {
    const write = vi.fn(async () => {})
    const tracker = new RecentSessionTracker({ read: async () => 'session-restored', write })
    await tracker.ready
    expect(tracker.current()).toBe('session-restored')

    expect(tracker.remember('session-current')).toBe(true)
    expect(tracker.remember('session-current')).toBe(false)
    await vi.waitFor(() => { expect(write).toHaveBeenCalledWith('session-current') })
  })

  it('does not let a late storage read overwrite a live update', async () => {
    let finishRead!: (value: unknown) => void
    const tracker = new RecentSessionTracker({
      read: async () => await new Promise((resolve) => { finishRead = resolve }),
      write: async () => {},
    })
    tracker.remember('session-live')
    finishRead('session-stale')
    await tracker.ready
    expect(tracker.current()).toBe('session-live')
  })

  it('ignores global activity from sessions not claimed by the browser', async () => {
    const write = vi.fn(async () => {})
    const tracker = new RecentSessionTracker({ read: async () => 'session-browser', write })
    await tracker.ready

    expect(tracker.noteActivity('session-other-client')).toBe(false)
    expect(tracker.current()).toBe('session-browser')
    expect(write).not.toHaveBeenCalled()
  })

  it('tracks activity among sessions claimed by the browser', async () => {
    const write = vi.fn(async () => {})
    const tracker = new RecentSessionTracker({ read: async () => undefined, write })
    await tracker.ready
    tracker.remember('session-first')
    tracker.remember('session-second')

    expect(tracker.noteActivity('session-first')).toBe(true)
    expect(tracker.current()).toBe('session-first')
    await vi.waitFor(() => { expect(write).toHaveBeenLastCalledWith('session-first') })
  })
})

describe('sessionIdFromFrame', () => {
  it('reads live session events without treating subscription metadata as activity', () => {
    expect(sessionIdFromFrame({
      t: 'event',
      frame: { rpcId: '1', method: 'session/event', payload: { sessionId: 'session-1', event: { type: 'turn/start' } } },
    })).toBe('session-1')
    expect(sessionIdFromFrame({
      t: 'event',
      frame: { rpcId: '2', method: 'session/subscribed', payload: { sessionId: 'session-2' } },
    })).toBeUndefined()
  })
})

describe('sessionTitleFromFrame', () => {
  it('reads the durable title carried by a session/title event', () => {
    expect(sessionTitleFromFrame({
      t: 'event',
      frame: {
        rpcId: '1',
        method: 'session/event',
        payload: { sessionId: 'session-1', event: { type: 'session/title', data: { title: '环境运维助手' } } },
      },
    })).toEqual({ sessionId: 'session-1', title: '环境运维助手' })
  })

  it('ignores other session events and blank titles', () => {
    expect(sessionTitleFromFrame({
      t: 'event',
      frame: {
        rpcId: '2',
        method: 'session/event',
        payload: { sessionId: 'session-1', event: { type: 'turn/start' } },
      },
    })).toBeUndefined()
    expect(sessionTitleFromFrame({
      t: 'event',
      frame: {
        rpcId: '3',
        method: 'session/event',
        payload: { sessionId: 'session-1', event: { type: 'session/title', data: { title: '   ' } } },
      },
    })).toBeUndefined()
    expect(sessionTitleFromFrame({
      t: 'event',
      frame: { rpcId: '4', method: 'session/event', payload: { event: { type: 'session/title', data: { title: 'x' } } } },
    })).toBeUndefined()
  })
})
