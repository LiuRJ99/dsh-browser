/**
 * Browser-bridge adapter for the rc.1 Typert Gateway.
 *
 * The extension deliberately keeps its small, stable RPC vocabulary.  The
 * Host side is the only place that translates that vocabulary to rc.1's
 * named Remote arguments, invokes the live Gateway, and turns its failures
 * into the Connection result shape carried by the bridge protocol.
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import { decodeStorageRecord, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'

/** One rc.1 Connection business result. */
export type GatewayResult<T = unknown> = ConnectionRpcResult<T>

/** Transport-independent target Gateway used by the bridge and its wrappers. */
export interface BrowserGateway {
  /** Invoke one canonical rc.1 Remote endpoint with named arguments. */
  request(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<GatewayResult>
  /** Open one canonical rc.1 Remote stream, or one Gateway-owned stream. */
  open(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<AsyncIterable<unknown>>
  /** Submit one Gateway-owned forwarded-event outcome through `/api`. */
  respondEvent(
    clientId: string,
    eventId: string,
    outcome: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<GatewayResult>
}

/** Host event frame consumed by BridgeServer; independent of any old DSH API. */
export interface BridgeEventFrame {
  rpcId: string
  method: string
  payload: unknown
}

/** Target Gateway failure projected to a JSON-safe Connection result. */
export interface GatewayFailure {
  code: string
  message: string
  details: object
}

/**
 * Construct a direct rc.1 Gateway adapter.  Unary calls use `invoke`; stream
 * calls use `stream`, except for `$events`, which is owned by the Gateway's
 * forwarded-event carrier and therefore uses `wireStream.open`.
 */
export function createBrowserGateway(ctx: Context): BrowserGateway {
  const sharedFetch = ctx.connection.createSharedFetchHandler('/api')
  const gateway: BrowserGateway = {
    request: async (endpoint, args, signal) => {
      const split = splitEndpoint(endpoint)
      if (split === undefined) return failureResult('gateway/arguments-invalid', `invalid Remote endpoint ${JSON.stringify(endpoint)}`)

      if (endpoint === 'session/history') {
        return readSessionHistory(gateway, args, signal)
      }
      if (endpoint === 'workspace/list') {
        return readWorkspaceList(gateway, signal)
      }

      try {
        const value = await ctx.typertGateway.invoke({
          namespace: split.namespace,
          method: split.method,
          args,
          signal,
        })
        return { ok: true, value }
      } catch (error: unknown) {
        return { ok: false, error: asGatewayFailure(error) }
      }
    },
    open: async (endpoint, args, signal) => {
      if (endpoint === '$events') {
        return ctx.typertGateway.wireStream.open(endpoint, { args }, signal)
      }
      const split = splitEndpoint(endpoint)
      if (split === undefined) throw new Error(`invalid Remote endpoint ${JSON.stringify(endpoint)}`)
      return ctx.typertGateway.stream({
        namespace: split.namespace,
        method: split.method,
        args,
        signal,
      })
    },
    respondEvent: async (clientId, eventId, outcome, signal) => {
      const rpcId = randomUUID()
      try {
        const response = await sharedFetch.fetch(new Request('http://dsh.internal/api/$events/result', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId,
            method: '$events/result',
            payload: { args: { clientId, eventId, outcome } },
          }),
          signal,
        }))
        if (!response.ok) return failureResult('http', await response.text())
        const body = await response.json() as unknown
        const result = isRecord(body) ? body.result : undefined
        return isRecord(result) && typeof result.ok === 'boolean'
          ? result as GatewayResult
          : failureResult('gateway/result-invalid', 'event result response was malformed')
      } catch (error: unknown) {
        return { ok: false, error: asGatewayFailure(error) }
      }
    },
  }
  return gateway
}

/**
 * Translate one extension RPC to rc.1 named Remote arguments.  This keeps the
 * extension's own protocol stable while removing every dependency on the
 * pre-rc.1 host-apiproxy transport.
 */
export function dispatchBrowserRpc(
  gateway: BrowserGateway,
  method: string,
  payload: unknown,
  signal: AbortSignal,
): Promise<GatewayResult> {
  const value = recordPayload(payload)
  if (value === undefined) return Promise.resolve(failureResult('gateway/arguments-invalid', 'RPC payload must be a plain object'))

  const endpoint = legacyEndpoint(method)
  if (endpoint === undefined) return Promise.resolve(failureResult('gateway/method-unavailable', `unknown browser RPC method ${JSON.stringify(method)}`))

  const args = namedArguments(endpoint, value, method)
  if (args === undefined) return Promise.resolve(failureResult('gateway/arguments-invalid', `RPC payload for ${JSON.stringify(method)} must be a plain object`))
  return gateway.request(endpoint, args, signal)
}

/** Map the extension's dotted method names to rc.1 slash-separated endpoints. */
export function legacyEndpoint(method: string): string | undefined {
  if (method.includes('/')) return method
  const aliases: Record<string, string> = {
    'settings.openDocument': 'settings/openSettingsDocument',
    'settings.openSettingsDocument': 'settings/openSettingsDocument',
  }
  if (aliases[method] !== undefined) return aliases[method]
  const dot = method.indexOf('.')
  return dot <= 0 || dot === method.length - 1
    ? undefined
    : `${method.slice(0, dot)}/${method.slice(dot + 1)}`
}

/**
 * Build the exact named parameter object expected by the generated rc.1
 * descriptors.  Most session/workspace methods take one `request` argument;
 * settings, credentials, and LLM discovery expose named parameters.
 */
export function namedArguments(
  endpoint: string,
  payload: Record<string, unknown>,
  legacyMethod = endpoint,
): Readonly<Record<string, unknown>> | undefined {
  switch (endpoint) {
    case 'session/create':
    case 'session/follow':
    case 'session/attachment':
    case 'session/cancel':
    case 'session/fork':
    case 'session/openWorkspacePath':
    case 'session/page':
    case 'session/prompt':
    case 'session/rename':
    case 'session/search':
    case 'session/selectModel':
    case 'session/updateQueue':
    case 'workspace/archiveSession':
    case 'workspace/create':
    case 'workspace/delete':
    case 'workspace/insertBefore':
    case 'workspace/insertSessionBefore':
    case 'workspace/rename':
      return {
        request: endpoint === 'session/prompt'
          ? { ...payload, requestId: typeof payload.requestId === 'string' && payload.requestId !== '' ? payload.requestId : randomUUID() }
          : payload,
      }
    case 'session/list':
      return { _request: payload }
    case 'session/modelCatalog':
    case 'session/canOpenWorkspacePath':
    case 'settings/describe':
    case 'settings/openSettingsDocument':
    case 'settings/canOpenAgentPresetDirectory':
    case 'workspace/list':
      return {}
    case 'settings/mutate':
    case 'settings/replace':
    case 'settings/update':
      return payload
    case 'credentials/describe':
      return { refs: payload.refs }
    case 'credentials/set':
      return { ref: payload.ref, value: payload.value }
    case 'credentials/unset':
      return { ref: payload.ref }
    case 'llm/discoverModels': {
      const { settingsNs, ...request } = payload
      return typeof settingsNs === 'string' && settingsNs !== ''
        ? { settingsNs, request }
        : undefined
    }
    default:
      // Unknown slash endpoints are still accepted as a direct named-args
      // call.  The target Gateway remains the source of truth for its schema.
      if (legacyMethod !== endpoint && endpoint.includes('/')) return payload
      return payload
  }
}

function decodeRecord(record: unknown): SessionEvent[] {
  if (!isRecord(record)) return []
  if (record.type === 'event' && isRecord(record.event)) {
    return [record.event as unknown as SessionEvent]
  }
  if (record.type === 'chunks' && isRecord(record.event) && typeof record.event.type === 'string') {
    const rawTag = record.event.type.startsWith('chunkrow/')
      ? record.event.type.slice('chunkrow/'.length)
      : record.event.type
    const row = {
      type: rawTag,
      seq0: record.event.seq,
      time0: record.event.time,
      data: record.event.data,
    }
    return decodeStorageRecord(row)
  }
  return decodeStorageRecord(record)
}

/** Flatten target history records, including rc.1 packed chunk rows. */
export function eventsFromRecords(records: readonly unknown[]): Array<{ event: SessionEvent }> {
  const events: Array<{ event: SessionEvent }> = []
  for (const record of records) {
    for (const event of decodeRecord(record)) events.push({ event })
  }
  return events
}

/** Turn one target Session follow snapshot into the browser panel history shape. */
export function historyFromFrame(frame: unknown): Record<string, unknown> | undefined {
  if (!isRecord(frame) || frame.type !== 'snapshot' || !Array.isArray(frame.records)) return undefined
  const events = eventsFromRecords(frame.records)
  return {
    events,
    hasMore: frame.hasMore === true,
    ...(isRecord(frame.projections) ? { projections: frame.projections } : {}),
  }
}

/** Recognize one target live Session event frame. */
export function eventFromFollowFrame(value: unknown): SessionEvent | undefined {
  if (!isRecord(value) || value.type !== 'event' || !isRecord(value.event)) return undefined
  const event = value.event
  return typeof event.type === 'string' && typeof event.seq === 'number' && typeof event.time === 'number'
    ? event as unknown as SessionEvent
    : undefined
}

/** Convert an arbitrary target failure to the rc.1 Connection failure shape. */
export function asGatewayFailure(error: unknown): GatewayFailure {
  if (isRecord(error)) {
    const code = typeof error.code === 'string' ? error.code : 'internal'
    const message = typeof error.message === 'string' && error.message !== '' ? error.message : String(error)
    const details = isRecord(error.details) ? error.details : {}
    return { code, message, details }
  }
  return { code: 'internal', message: String(error), details: {} }
}

function failureResult(code: string, message: string): GatewayResult {
  return { ok: false, error: { code, message, details: {} } }
}

function splitEndpoint(endpoint: string): { namespace: string; method: string } | undefined {
  const slash = endpoint.indexOf('/')
  if (slash <= 0 || slash === endpoint.length - 1 || endpoint.indexOf('/', slash + 1) !== -1) return undefined
  return { namespace: endpoint.slice(0, slash), method: endpoint.slice(slash + 1) }
}

function recordPayload(payload: unknown): Record<string, unknown> | undefined {
  return isRecord(payload) ? payload : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readSessionHistory(
  gateway: BrowserGateway,
  args: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<GatewayResult> {
  const sessionId = args.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') return failureResult('gateway/arguments-invalid', 'sessionId must be a non-empty string')
  const frame = await firstStreamFrame(gateway, 'session/follow', {
    request: { address: { kind: 'session', sessionId: SessionId(sessionId) } },
  }, signal)
  if (!frame.ok) return frame
  const history = historyFromFrame(frame.value)
  return history === undefined
    ? failureResult('gateway/result-invalid', 'session/follow did not return a snapshot')
    : { ok: true, value: history }
}

async function readWorkspaceList(gateway: BrowserGateway, signal: AbortSignal): Promise<GatewayResult> {
  const frame = await firstStreamFrame(gateway, 'workspace/follow', {}, signal)
  if (!frame.ok) return frame
  if (!isRecord(frame.value) || frame.value.type !== 'baseline' || !isRecord(frame.value.value)) {
    return failureResult('gateway/result-invalid', 'workspace/follow did not return a baseline')
  }
  return { ok: true, value: frame.value.value }
}

async function firstStreamFrame(
  gateway: BrowserGateway,
  endpoint: string,
  args: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<GatewayResult<unknown>> {
  const local = new AbortController()
  const combined = AbortSignal.any([signal, local.signal])
  try {
    const stream = await gateway.open(endpoint, args, combined)
    for await (const frame of stream) return { ok: true, value: frame }
    return failureResult('gateway/result-invalid', `${endpoint} ended without a frame`)
  } catch (error: unknown) {
    return { ok: false, error: asGatewayFailure(error) }
  } finally {
    local.abort()
  }
}
