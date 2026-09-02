/**
 * Authenticated loopback control route for local automation clients.
 *
 * The dsh-browser extension remains the only WebSocket client of BridgeServer.
 * Local callers use this route so requests are forwarded through the existing
 * BridgeServer.requestTool() connection and retain the extension's tab-affinity,
 * approval, privacy, and content-script behavior.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { BRIDGE_CONTROL_PATH } from './protocol.ts'
import { BridgeToolError, isLoopbackAddress, type BridgeServer } from './server.ts'
import { verifyToken } from './token.ts'
import { BROWSER_TOOL_NAMES } from './tools.ts'

export { BRIDGE_CONTROL_PATH }

const MAX_BODY_BYTES = 64 * 1024
const MAX_TIMEOUT_MS = 120_000
const CONTROL_TOOL_NAMES = new Set<string>(BROWSER_TOOL_NAMES.filter((name) => ![
  // These tools carry local files or potentially very large binary/network data.
  // The Apple runner does not need them; keep the control surface narrow.
  'browser_upload_file',
  'browser_screenshot',
  'browser_download_wait',
  'browser_network_capture',
].includes(name)))

export interface BrowserControlDeps {
  token: string
  bridge: Pick<BridgeServer, 'requestTool'>
  defaultTimeoutMs: number
}

interface BrowserControlRequest {
  name: string
  args: Record<string, unknown>
  timeoutMs: number
  sessionId?: string
}

/** Serve one local browser-tool request through the already-connected extension. */
export async function serveBrowserControl(
  req: IncomingMessage,
  res: ServerResponse,
  deps: BrowserControlDeps,
): Promise<void> {
  if (req.method !== 'POST') {
    json(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use POST.' } }, { allow: 'POST' })
    return
  }
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    json(res, 403, { ok: false, error: { code: 'loopback-required', message: 'Browser control is available only from loopback.' } })
    return
  }
  const token = bearerToken(req.headers.authorization)
  if (token === undefined || !verifyToken(deps.token, token)) {
    json(res, 401, { ok: false, error: { code: 'unauthorized', message: 'A valid browser bridge token is required.' } }, { 'www-authenticate': 'Bearer' })
    return
  }
  if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    json(res, 415, { ok: false, error: { code: 'json-required', message: 'Content-Type must be application/json.' } })
    return
  }

  let request: BrowserControlRequest
  try {
    request = parseRequest(JSON.parse(await readBody(req)), deps.defaultTimeoutMs)
  } catch (error) {
    json(res, 400, { ok: false, error: { code: 'invalid-request', message: error instanceof Error ? error.message : 'Invalid request.' } })
    return
  }

  const controller = new AbortController()
  const abortIfClientClosed = (): void => {
    if (!res.writableEnded) controller.abort()
  }
  req.once('aborted', abortIfClientClosed)
  res.once('close', abortIfClientClosed)
  try {
    const result = await deps.bridge.requestTool(
      request.name,
      request.args,
      controller.signal,
      request.timeoutMs,
      request.sessionId,
    )
    if (controller.signal.aborted || res.writableEnded) return
    json(res, 200, { ok: true, result })
  } catch (error) {
    if (controller.signal.aborted || res.writableEnded) return
    const code = error instanceof BridgeToolError ? error.code : 'internal'
    const status = code === 'timeout' ? 504 : code === 'bridge-closed' ? 409 : 502
    const message = error instanceof Error ? error.message : 'Browser tool request failed.'
    json(res, status, {
      ok: false,
      error: { code, message: message.replaceAll(deps.token, '[redacted]') },
    })
  } finally {
    req.removeListener('aborted', abortIfClientClosed)
    res.removeListener('close', abortIfClientClosed)
  }
}

function parseRequest(value: unknown, defaultTimeoutMs: number): BrowserControlRequest {
  if (!isRecord(value)) throw new Error('Request body must be a JSON object.')
  if (typeof value.name !== 'string' || !CONTROL_TOOL_NAMES.has(value.name)) {
    throw new Error(`Unsupported browser tool: ${String(value.name ?? '')}`)
  }
  if (value.args !== undefined && !isRecord(value.args)) throw new Error('args must be a JSON object.')
  const timeoutMs = value.timeoutMs === undefined ? defaultTimeoutMs : value.timeoutMs
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}.`)
  }
  if (value.sessionId !== undefined && (typeof value.sessionId !== 'string' || value.sessionId.trim() === '')) {
    throw new Error('sessionId must be a non-empty string when provided.')
  }
  return {
    name: value.name,
    args: value.args ?? {},
    timeoutMs,
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
  }
}

function bearerToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(value.trim())
  return match?.[1]?.trim() || undefined
}

async function readBody(req: IncomingMessage): Promise<string> {
  const contentLength = Number(req.headers['content-length'] ?? 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) throw new Error('Request body is too large.')
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > MAX_BODY_BYTES) throw new Error('Request body is too large.')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  res.end(JSON.stringify(body))
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
