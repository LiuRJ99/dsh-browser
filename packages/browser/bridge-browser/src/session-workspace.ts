/**
 * Best-effort workspace grouping for browser-created Sessions.
 *
 * This is a small adapter over the rc.1 Gateway. It changes only implicit
 * `session/create` requests; explicit workspace choices and all other calls
 * pass through unchanged.
 *
 * @module
 */

import { mkdir } from 'node:fs/promises'
import type { BrowserGateway } from './gateway.ts'

type Warn = (message: string) => void

/**
 * Add one cached Workspace registration to implicit Session creation.
 *
 * @param gateway - canonical rc.1 Gateway adapter.
 * @param workspacePath - dedicated directory, or empty to opt out.
 * @param warn - logger called once when grouping cannot be established.
 */
export function withSessionWorkspace(
  gateway: BrowserGateway,
  workspacePath: string,
  warn: Warn,
): BrowserGateway {
  if (workspacePath === '') return gateway

  let workspacePromise: Promise<string | undefined> | undefined
  const ensureWorkspace = (signal: AbortSignal): Promise<string | undefined> => {
    if (workspacePromise !== undefined) return workspacePromise
    workspacePromise = (async () => {
      try {
        await mkdir(workspacePath, { recursive: true })
        const response = await gateway.request('workspace/create', { request: { path: workspacePath } }, signal)
        if (!response.ok) {
          warn(
            `browser bridge: workspace/create failed for "${workspacePath}" `
            + `(${response.error.code}: ${response.error.message}); sessions will remain ungrouped`,
          )
          return undefined
        }
        const workspace = plainRecord(response.value)?.workspace
        const workspaceId = plainRecord(workspace)?.workspaceId
        if (typeof workspaceId !== 'string' || workspaceId === '') {
          warn('browser bridge: workspace/create returned no workspace id; sessions will remain ungrouped')
          return undefined
        }
        return workspaceId
      } catch (error: unknown) {
        warn(
          `browser bridge: could not prepare session workspace "${workspacePath}": `
          + `${String(error)}; sessions will remain ungrouped`,
        )
        return undefined
      }
    })()
    return workspacePromise
  }

  return {
    request: async (endpoint, args, signal) => {
      if (endpoint !== 'session/create') return gateway.request(endpoint, args, signal)
      const request = plainRecord(args.request)
      if (request === undefined || request.workspaceId !== undefined) return gateway.request(endpoint, args, signal)
      const workspaceId = await ensureWorkspace(signal)
      if (workspaceId === undefined) return gateway.request(endpoint, args, signal)
      const grouped: Record<string, unknown> = { ...request, workspaceId }
      delete grouped.cwd
      return gateway.request(endpoint, { request: grouped }, signal)
    },
    open: (endpoint, args, signal) => gateway.open(endpoint, args, signal),
    respondEvent: (clientId, eventId, outcome, signal) => gateway.respondEvent(clientId, eventId, outcome, signal),
  }
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
