/**
 * Publish a dynamic Desktop bridge URL on a stable loopback discovery port.
 * Adapted from omdsh-dev/dsh-browser#127 (dc8f9fddf623c9a3e2da54f66768bad7ef674833).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { BRIDGE_CONFIG_PATH, BRIDGE_PATH } from './protocol.ts'

export const DEFAULT_DISCOVERY_PORT = 43189
const LOOPBACK_HOST = '127.0.0.1'

export interface DiscoveryListenerOptions {
  /** Stable discovery port; 0 binds an ephemeral port for isolated tests. */
  port: number
  /** Read the actual Web port per request, including during Host startup. */
  webPort: () => number | undefined
  warn: (message: string) => void
}

/** This listener only publishes an address; it never proxies WebSocket or API calls. */
export function createDiscoveryHandler(
  webPort: () => number | undefined,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if ((req.url ?? '/').split('?')[0] !== BRIDGE_CONFIG_PATH) {
      res.writeHead(404).end()
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end()
      return
    }
    const port = webPort()
    if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
      res.writeHead(503, { 'cache-control': 'no-store' }).end()
      return
    }
    const body = JSON.stringify({ wsUrl: `ws://${LOOPBACK_HOST}:${port}${BRIDGE_PATH}` })
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'content-length': String(Buffer.byteLength(body)),
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  }
}

/** A busy discovery port must not prevent the Host or its existing bridge from starting. */
export async function startDiscoveryListener(options: DiscoveryListenerOptions): Promise<Server | undefined> {
  if (options.port !== 0 && options.port === options.webPort()) return undefined
  const server = createServer(createDiscoveryHandler(options.webPort))
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => { reject(error) }
      server.once('error', onError)
      server.listen(options.port, LOOPBACK_HOST, () => {
        server.off('error', onError)
        resolve()
      })
    })
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    options.warn(`bridge-browser: discovery port ${options.port} unavailable (${reason}); set the extension bridge address manually`)
    return undefined
  }
  server.on('error', (error: Error) => { options.warn(`bridge-browser: discovery listener failed (${error.message})`) })
  return server
}
