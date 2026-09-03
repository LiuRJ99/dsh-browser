/**
 * Defer real Session creation until the first prompt.
 *
 * The panel opens a provisional session immediately. This adapter keeps that
 * id entirely in memory and only forwards `session/create` when the first
 * `session/prompt` arrives. It wraps the rc.1 Gateway adapter directly; no
 * legacy host-apiproxy request or response type is involved.
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import type { BrowserGateway, GatewayResult } from './gateway.ts'

/** Provisional entries older than this are dropped on the next create. */
const PROVISIONAL_TTL_MS = 30 * 60_000

interface ProvisionalEntry {
  /** Original rc.1 `session/create` request body, replayed at materialization. */
  request: Record<string, unknown>
  createdAt: number
}

/**
 * Wrap the Gateway with in-memory session creation deferral.
 *
 * @param gateway - canonical rc.1 Gateway adapter.
 * @param enabled - whether deferral is active.
 * @param imageLimits - optional image projection exposed by provisional history.
 */
export function withSessionDeferral(
  gateway: BrowserGateway,
  enabled: boolean,
  imageLimits?: ImageAttachmentLimits,
): BrowserGateway {
  if (!enabled) return gateway

  const provisional = new Map<string, ProvisionalEntry>()
  const materializing = new Map<string, Promise<GatewayResult>>()

  const prune = (): void => {
    const cutoff = Date.now() - PROVISIONAL_TTL_MS
    for (const [id, entry] of provisional) {
      if (entry.createdAt < cutoff) provisional.delete(id)
    }
  }

  const wrapped: BrowserGateway = {
    request: async (endpoint, args, signal) => {
      if (endpoint === 'session/create') return deferredCreate(args)
      if (endpoint === 'session/history') return deferredHistory(args, signal)
      if (endpoint === 'session/prompt') return deferredPrompt(args, signal)
      return gateway.request(endpoint, args, signal)
    },
    open: (endpoint, args, signal) => gateway.open(endpoint, args, signal),
    respondEvent: (clientId, eventId, outcome, signal) => gateway.respondEvent(clientId, eventId, outcome, signal),
  }
  return wrapped

  async function deferredCreate(args: Readonly<Record<string, unknown>>): Promise<GatewayResult> {
    prune()
    const request = plainRecord(args.request)
    if (request === undefined) return failure('gateway/arguments-invalid', 'session/create requires a request object')
    const sessionId = typeof request.sessionId === 'string' && request.sessionId !== ''
      ? request.sessionId
      : `session-${randomUUID()}`
    provisional.set(sessionId, { request: { ...request }, createdAt: Date.now() })
    return { ok: true, value: { sessionId } }
  }

  async function deferredHistory(args: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<GatewayResult> {
    const sessionId = args.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') return failure('gateway/arguments-invalid', 'sessionId must be a non-empty string')
    if (!provisional.has(sessionId)) return gateway.request('session/history', args, signal)
    return {
      ok: true,
      value: {
        events: [],
        hasMore: false,
        ...(imageLimits === undefined ? {} : { projections: { asOfSeq: -1, values: { imageLimits } } }),
      },
    }
  }

  async function deferredPrompt(args: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<GatewayResult> {
    const request = plainRecord(args.request)
    const sessionId = request?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') return gateway.request('session/prompt', args, signal)
    const entry = provisional.get(sessionId)
    if (entry === undefined) return gateway.request('session/prompt', args, signal)

    const existing = materializing.get(sessionId)
    const pending = existing ?? gateway.request('session/create', {
      request: { ...entry.request, sessionId },
    }, signal)
    if (existing === undefined) {
      materializing.set(sessionId, pending)
      void pending.then(
        () => { materializing.delete(sessionId) },
        () => { materializing.delete(sessionId) },
      )
    }

    const created = await pending
    if (!created.ok) return created
    provisional.delete(sessionId)
    return gateway.request('session/prompt', args, signal)
  }
}

function failure(code: string, message: string): GatewayResult {
  return { ok: false, error: { code, message, details: {} } }
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
