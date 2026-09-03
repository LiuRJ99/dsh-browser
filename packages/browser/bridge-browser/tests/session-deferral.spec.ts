import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import type { BrowserGateway, GatewayResult } from '../src/gateway.ts'
import { withSessionDeferral } from '../src/session-deferral.ts'

const signal = (): AbortSignal => new AbortController().signal

function apiHarness() {
  const sessionCreate = vi.fn(async (_args: Readonly<Record<string, unknown>>): Promise<GatewayResult> => ({
    ok: true,
    value: { sessionId: 'session-materialized' },
  }))
  const sessionHistory = vi.fn(async (_args: Readonly<Record<string, unknown>>): Promise<GatewayResult> => ({
    ok: true,
    value: { events: [{ event: { type: 'user/message' } }], hasMore: false },
  }))
  const sessionPrompt = vi.fn(async (_args: Readonly<Record<string, unknown>>): Promise<GatewayResult> => ({
    ok: true,
    value: { accepted: true },
  }))
  const request = vi.fn(async (endpoint: string, args: Readonly<Record<string, unknown>>): Promise<GatewayResult> => {
    if (endpoint === 'session/create') return sessionCreate(args)
    if (endpoint === 'session/history') return sessionHistory(args)
    if (endpoint === 'session/prompt') return sessionPrompt(args)
    return { ok: true, value: {} }
  })
  const api: BrowserGateway = {
    request,
    open: vi.fn(async () => ({ async *[Symbol.asyncIterator]() {} })),
    respondEvent: vi.fn(async () => ({ ok: true, value: undefined })),
  }
  return { api, request, sessionCreate, sessionHistory, sessionPrompt }
}

async function provisionalId(gateway: BrowserGateway): Promise<string> {
  const response = await gateway.request('session/create', { request: {} }, signal())
  if (!response.ok || typeof response.value !== 'object' || response.value === null) throw new Error('unreachable')
  return (response.value as { sessionId: string }).sessionId
}

describe('withSessionDeferral', () => {
  afterEach(() => { vi.useRealTimers() })

  it('answers create with a provisional id without touching the gateway', async () => {
    const { api, sessionCreate } = apiHarness()
    const wrapped = withSessionDeferral(api, true)

    const id = await provisionalId(wrapped)

    expect(id).toMatch(/^session-/)
    expect(sessionCreate).not.toHaveBeenCalled()
  })

  it('honors an explicit session id from the caller', async () => {
    const { api } = apiHarness()
    const wrapped = withSessionDeferral(api, true)

    const response = await wrapped.request('session/create', {
      request: { sessionId: 'session-fixed' },
    }, signal())

    expect(response).toEqual({ ok: true, value: { sessionId: 'session-fixed' } })
  })

  it('serves empty history for a provisional id and passes other ids through', async () => {
    const { api, sessionHistory } = apiHarness()
    const wrapped = withSessionDeferral(api, true)
    const id = await provisionalId(wrapped)

    const empty = await wrapped.request('session/history', { sessionId: id }, signal())
    expect(empty).toEqual({ ok: true, value: { events: [], hasMore: false } })
    expect(sessionHistory).not.toHaveBeenCalled()

    await wrapped.request('session/history', { sessionId: 'session-real' }, signal())
    expect(sessionHistory).toHaveBeenCalledWith({ sessionId: 'session-real' })
  })

  it('advertises the real host image limits before a deferred session materializes', async () => {
    const { api } = apiHarness()
    const imageLimits: ImageAttachmentLimits = {
      maxImageBytes: 1024,
      maxImagesPerMessage: 4,
      maxMessageImageBytes: 4096,
      maxImagePixels: 1_000_000,
      maxImageDimension: 1200,
      mediaTypes: ['image/png', 'image/jpeg'],
    }
    const wrapped = withSessionDeferral(api, true, imageLimits)
    const id = await provisionalId(wrapped)

    const history = await wrapped.request('session/history', { sessionId: id }, signal())

    expect(history).toEqual({
      ok: true,
      value: {
        events: [],
        hasMore: false,
        projections: { asOfSeq: -1, values: { imageLimits } },
      },
    })
  })

  it('materializes the session on the first prompt, replaying the create payload', async () => {
    const { api, sessionCreate, sessionPrompt, sessionHistory } = apiHarness()
    const wrapped = withSessionDeferral(api, true)
    const created = await wrapped.request('session/create', { request: { cwd: '/work' } }, signal())
    if (!created.ok || typeof created.value !== 'object' || created.value === null) throw new Error('unreachable')
    const id = (created.value as { sessionId: string }).sessionId
    const prompt = { request: { sessionId: id, requestId: 'prompt-1', mode: 'queue', content: [] } }

    await wrapped.request('session/prompt', prompt, signal())

    expect(sessionCreate).toHaveBeenCalledWith({ request: { cwd: '/work', sessionId: id } })
    expect(sessionPrompt).toHaveBeenCalledWith(prompt)

    await wrapped.request('session/history', { sessionId: id }, signal())
    expect(sessionHistory).toHaveBeenCalledTimes(1)
  })

  it('passes prompts for unknown sessions through untouched', async () => {
    const { api, sessionPrompt } = apiHarness()
    const wrapped = withSessionDeferral(api, true)
    const prompt = { request: { sessionId: 'session-existing', requestId: 'p1', mode: 'queue', content: [] } }

    await wrapped.request('session/prompt', prompt, signal())

    expect(sessionPrompt).toHaveBeenCalledWith(prompt)
  })

  it('deduplicates concurrent prompts into one materialization', async () => {
    const { api, sessionCreate, sessionPrompt } = apiHarness()
    let release!: () => void
    sessionCreate.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return { ok: true, value: { sessionId: 'session-materialized' } }
    })
    const wrapped = withSessionDeferral(api, true)
    const id = await provisionalId(wrapped)

    const first = wrapped.request('session/prompt', { request: { sessionId: id, requestId: 'p1', mode: 'queue', content: [] } }, signal())
    const second = wrapped.request('session/prompt', { request: { sessionId: id, requestId: 'p2', mode: 'queue', content: [] } }, signal())
    release()
    await Promise.all([first, second])

    expect(sessionCreate).toHaveBeenCalledTimes(1)
    expect(sessionPrompt).toHaveBeenCalledTimes(2)
  })

  it('propagates a materialization failure without forwarding the prompt, and retries later', async () => {
    const { api, sessionCreate, sessionPrompt } = apiHarness()
    sessionCreate.mockResolvedValueOnce({
      ok: false,
      error: { code: 'internal', message: 'boom', details: {} },
    })
    const wrapped = withSessionDeferral(api, true)
    const id = await provisionalId(wrapped)
    const first = { request: { sessionId: id, requestId: 'p1', mode: 'queue', content: [] } }

    const failed = await wrapped.request('session/prompt', first, signal())
    expect(failed).toEqual({ ok: false, error: { code: 'internal', message: 'boom', details: {} } })
    expect(sessionPrompt).not.toHaveBeenCalled()

    await wrapped.request('session/prompt', { request: { sessionId: id, requestId: 'p2', mode: 'queue', content: [] } }, signal())
    expect(sessionCreate).toHaveBeenCalledTimes(2)
    expect(sessionPrompt).toHaveBeenCalledTimes(1)
  })

  it('propagates a thrown materialization failure and keeps the entry for retry', async () => {
    const { api, sessionCreate, sessionPrompt } = apiHarness()
    sessionCreate.mockRejectedValueOnce(new Error('create exploded'))
    const wrapped = withSessionDeferral(api, true)
    const id = await provisionalId(wrapped)
    const first = { request: { sessionId: id, requestId: 'p1', mode: 'queue', content: [] } }

    await expect(wrapped.request('session/prompt', first, signal())).rejects.toThrow('create exploded')
    expect(sessionPrompt).not.toHaveBeenCalled()

    await wrapped.request('session/prompt', { request: { sessionId: id, requestId: 'p2', mode: 'queue', content: [] } }, signal())
    expect(sessionCreate).toHaveBeenCalledTimes(2)
    expect(sessionPrompt).toHaveBeenCalledTimes(1)
  })

  it('prunes stale provisional entries on the next create', async () => {
    vi.useFakeTimers()
    const { api, sessionHistory } = apiHarness()
    const wrapped = withSessionDeferral(api, true)
    const first = await provisionalId(wrapped)

    vi.advanceTimersByTime(31 * 60_000)
    const second = await provisionalId(wrapped)

    await wrapped.request('session/history', { sessionId: first }, signal())
    expect(sessionHistory).toHaveBeenCalledTimes(1)
    await wrapped.request('session/history', { sessionId: second }, signal())
    expect(sessionHistory).toHaveBeenCalledTimes(1)
  })

  it('returns the original Gateway when disabled', () => {
    const { api } = apiHarness()
    expect(withSessionDeferral(api, false)).toBe(api)
  })
})
