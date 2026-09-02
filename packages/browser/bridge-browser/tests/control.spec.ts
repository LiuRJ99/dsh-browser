import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_CONTROL_PATH } from '../src/control.ts'
import { serveBrowserControl } from '../src/control.ts'

const TOKEN = 'deadbeefdeadbeefdeadbeefdeadbeef'
const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

function requestToolMock() {
  return vi.fn(async (name: string, args: Record<string, unknown>, _signal: AbortSignal, timeoutMs: number, sessionId?: string) => ({
    text: JSON.stringify({ name, args, timeoutMs, sessionId }),
  }))
}

async function start(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): Promise<string> {
  const server = createServer((req, res) => { void handler(req, res) })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}${BRIDGE_CONTROL_PATH}`
}

describe('browser control route', () => {
  it('forwards an authenticated request through the existing bridge connection', async () => {
    const requestTool = requestToolMock()
    const url = await start((req, res) => serveBrowserControl(req, res, { token: TOKEN, bridge: { requestTool }, defaultTimeoutMs: 90000 }))
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'browser_snapshot', args: {}, sessionId: 'apple-sniper' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, result: { text: JSON.stringify({ name: 'browser_snapshot', args: {}, timeoutMs: 90000, sessionId: 'apple-sniper' }) } })
    expect(requestTool).toHaveBeenCalledWith('browser_snapshot', {}, expect.any(AbortSignal), 90000, 'apple-sniper')
  })

  it('rejects unauthenticated and non-browser tool requests', async () => {
    const requestTool = requestToolMock()
    const url = await start((req, res) => serveBrowserControl(req, res, { token: TOKEN, bridge: { requestTool }, defaultTimeoutMs: 90000 }))
    const unauthorized = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'browser_snapshot' }) })
    expect(unauthorized.status).toBe(401)
    const invalid = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'browser_upload_file', args: {} }),
    })
    expect(invalid.status).toBe(400)
    expect(requestTool).not.toHaveBeenCalled()
  })

  it('rejects invalid methods and malformed requests', async () => {
    const requestTool = requestToolMock()
    const url = await start((req, res) => serveBrowserControl(req, res, { token: TOKEN, bridge: { requestTool }, defaultTimeoutMs: 90000 }))
    const get = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(get.status).toBe(405)
    const malformed = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: '{',
    })
    expect(malformed.status).toBe(400)
    expect(requestTool).not.toHaveBeenCalled()
  })

  it('returns bridge failures without leaking the token', async () => {
    const requestTool = vi.fn(async () => { throw new Error(`bridge failed ${TOKEN}`) })
    const url = await start((req, res) => serveBrowserControl(req, res, { token: TOKEN, bridge: { requestTool }, defaultTimeoutMs: 90000 }))
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'browser_snapshot' }),
    })
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain(TOKEN)
  })
})
