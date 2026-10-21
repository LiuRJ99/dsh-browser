import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDiscoveryHandler, startDiscoveryListener } from '../src/discovery.ts'

const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
})

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  servers.push(server)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP listener')
  return address.port
}

describe('Desktop bridge discovery', () => {
  it('publishes only the live bridge address and does not cache an old Web port', async () => {
    let webPort = 49966
    const port = await listen(createServer(createDiscoveryHandler(() => webPort)))
    const url = `http://127.0.0.1:${port}/ext/bridge-config`
    const first = await fetch(url)
    expect(first.headers.get('cache-control')).toBe('no-store')
    expect(await first.json()).toEqual({ wsUrl: 'ws://127.0.0.1:49966/ext/bridge' })

    webPort = 61967
    expect(await (await fetch(url)).json()).toEqual({ wsUrl: 'ws://127.0.0.1:61967/ext/bridge' })
  })

  it('returns unavailable until the Host has bound a real Web port', async () => {
    let webPort: number | undefined
    const port = await listen(createServer(createDiscoveryHandler(() => webPort)))
    const url = `http://127.0.0.1:${port}/ext/bridge-config`
    expect((await fetch(url)).status).toBe(503)
    webPort = 0
    expect((await fetch(url)).status).toBe(503)
    webPort = 61967
    expect(await (await fetch(url)).json()).toEqual({ wsUrl: 'ws://127.0.0.1:61967/ext/bridge' })
  })

  it('allows GET and HEAD on the discovery route without proxying API or WebSocket routes', async () => {
    const port = await listen(createServer(createDiscoveryHandler(() => 61967)))
    const base = `http://127.0.0.1:${port}`
    const head = await fetch(`${base}/ext/bridge-config`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    const post = await fetch(`${base}/ext/bridge-config`, { method: 'POST' })
    expect(post.status).toBe(405)
    expect(post.headers.get('allow')).toBe('GET, HEAD')
    expect((await fetch(`${base}/ext/bridge`)).status).toBe(404)
    expect((await fetch(`${base}/api`)).status).toBe(404)
  })

  it('binds only to loopback and releases the discovery port on close', async () => {
    const warn = vi.fn()
    const server = await startDiscoveryListener({ port: 0, webPort: () => 61967, warn })
    if (server === undefined) throw new Error('expected discovery to start')
    servers.push(server)
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('expected TCP')
    expect(address.address).toBe('127.0.0.1')
    const url = `http://127.0.0.1:${address.port}/ext/bridge-config`
    expect(await (await fetch(url)).json()).toEqual({ wsUrl: 'ws://127.0.0.1:61967/ext/bridge' })
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    servers.splice(servers.indexOf(server), 1)
    const replacement = await startDiscoveryListener({ port: address.port, webPort: () => 62000, warn })
    if (replacement === undefined) throw new Error('discovery port was not released')
    servers.push(replacement)
    expect(await (await fetch(url)).json()).toEqual({ wsUrl: 'ws://127.0.0.1:62000/ext/bridge' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('uses the ordinary discovery route when the Host already owns that port', async () => {
    const warn = vi.fn()
    const listener = await startDiscoveryListener({ port: 43189, webPort: () => 43189, warn })
    expect(listener).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns once and keeps the Host usable if another process owns the discovery port', async () => {
    const port = await listen(createServer((_req, res) => { res.writeHead(204).end() }))
    const warn = vi.fn()
    const listener = await startDiscoveryListener({ port, webPort: () => 61967, warn })
    expect(listener).toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unavailable'))
    expect((await fetch(`http://127.0.0.1:${port}`)).status).toBe(204)
  })
})
