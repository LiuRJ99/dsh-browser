import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserGateway, GatewayResult } from '../src/gateway.ts'
import { withSessionWorkspace } from '../src/session-workspace.ts'

const SESSION_ID = 'session-browser'
const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function tempWorkspacePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-browser-workspace-'))
  dirs.push(root)
  return join(root, 'browser-sessions')
}

function sessionRequest(request: Record<string, unknown> = {}): Readonly<Record<string, unknown>> {
  return { request }
}

function apiHarness(options: {
  workspace?: (args: Readonly<Record<string, unknown>>) => Promise<GatewayResult>
} = {}) {
  const sessionCreate = vi.fn(async (args: Readonly<Record<string, unknown>>): Promise<GatewayResult> => ({
    ok: true,
    value: { sessionId: SESSION_ID, args },
  }))
  const request = vi.fn(async (endpoint: string, args: Readonly<Record<string, unknown>>): Promise<GatewayResult> => {
    if (endpoint === 'workspace/create' && options.workspace !== undefined) return options.workspace(args)
    if (endpoint === 'session/create') return sessionCreate(args)
    return { ok: true, value: {} }
  })
  const api: BrowserGateway = {
    request,
    open: vi.fn(async () => ({ async *[Symbol.asyncIterator]() {} })),
    respondEvent: vi.fn(async () => ({ ok: true, value: undefined })),
  }
  return { api, sessionCreate, request }
}

function workspaceSuccess(inspect?: (path: string) => Promise<void>) {
  return vi.fn(async (args: Readonly<Record<string, unknown>>): Promise<GatewayResult> => {
    const request = args.request as { path: string }
    await inspect?.(request.path)
    return {
      ok: true,
      value: {
        created: true,
        workspace: {
          workspaceId: 'workspace-browser',
          path: request.path,
          title: 'browser-sessions',
          sessionIds: [],
          createdAt: '2026-08-06T00:00:00.000Z',
          updatedAt: '2026-08-06T00:00:00.000Z',
        },
      },
    }
  })
}

describe('withSessionWorkspace', () => {
  it('creates the directory before one cached workspace registration and injects its id', async () => {
    const workspacePath = await tempWorkspacePath()
    const workspaceCreate = workspaceSuccess(async (path) => {
      expect((await stat(path)).isDirectory()).toBe(true)
    })
    const { api, sessionCreate } = apiHarness({ workspace: workspaceCreate })
    const warn = vi.fn()
    const wrapped = withSessionWorkspace(api, workspacePath, warn)

    await Promise.all([
      wrapped.request('session/create', sessionRequest({ cwd: '/ignored', sessionId: 'session-chosen' }), new AbortController().signal),
      wrapped.request('session/create', sessionRequest(), new AbortController().signal),
    ])

    expect(workspaceCreate).toHaveBeenCalledTimes(1)
    expect(workspaceCreate).toHaveBeenCalledWith({ request: { path: workspacePath } })
    expect(sessionCreate).toHaveBeenNthCalledWith(1, {
      request: { sessionId: 'session-chosen', workspaceId: 'workspace-browser' },
    })
    expect(sessionCreate).toHaveBeenNthCalledWith(2, {
      request: { workspaceId: 'workspace-browser' },
    })
    expect(warn).not.toHaveBeenCalled()
  })

  it('passes an explicit workspace id through without preparing the configured workspace', async () => {
    const workspacePath = await tempWorkspacePath()
    const workspaceCreate = workspaceSuccess()
    const { api, sessionCreate } = apiHarness({ workspace: workspaceCreate })
    const wrapped = withSessionWorkspace(api, workspacePath, vi.fn())
    const request = sessionRequest({ workspaceId: 'workspace-explicit' })

    await wrapped.request('session/create', request, new AbortController().signal)

    expect(sessionCreate).toHaveBeenCalledWith(request)
    expect(workspaceCreate).not.toHaveBeenCalled()
    await expect(stat(workspacePath)).rejects.toThrow()
  })

  it('returns the original Gateway when grouping is opted out', () => {
    const { api } = apiHarness({ workspace: workspaceSuccess() })
    expect(withSessionWorkspace(api, '', vi.fn())).toBe(api)
  })

  it('caches a missing workspace domain and falls through to plain session creation', async () => {
    const workspacePath = await tempWorkspacePath()
    const { api, sessionCreate } = apiHarness()
    const warn = vi.fn()
    const wrapped = withSessionWorkspace(api, workspacePath, warn)
    const request = sessionRequest({ cwd: '/original' })

    await wrapped.request('session/create', request, new AbortController().signal)
    await wrapped.request('session/create', request, new AbortController().signal)

    expect(sessionCreate).toHaveBeenCalledTimes(2)
    expect(sessionCreate).toHaveBeenNthCalledWith(1, request)
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('workspace/create'))
  })

  it('caches a workspace.create business failure and preserves session creation', async () => {
    const workspacePath = await tempWorkspacePath()
    const workspaceCreate = vi.fn(async (): Promise<GatewayResult> => ({
      ok: false,
      error: { code: 'internal', message: 'workspace service missing', details: {} },
    }))
    const { api, sessionCreate } = apiHarness({ workspace: workspaceCreate })
    const warn = vi.fn()
    const wrapped = withSessionWorkspace(api, workspacePath, warn)
    const request = sessionRequest()

    await wrapped.request('session/create', request, new AbortController().signal)
    await wrapped.request('session/create', request, new AbortController().signal)

    expect(workspaceCreate).toHaveBeenCalledOnce()
    expect(sessionCreate).toHaveBeenCalledTimes(2)
    expect(sessionCreate).toHaveBeenNthCalledWith(1, request)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('workspace/create failed'))
  })

  it('catches a thrown workspace failure and preserves session creation', async () => {
    const workspacePath = await tempWorkspacePath()
    const workspaceCreate = vi.fn(async (): Promise<GatewayResult> => { throw new Error('domain unavailable') })
    const { api, sessionCreate } = apiHarness({ workspace: workspaceCreate })
    const warn = vi.fn()
    const wrapped = withSessionWorkspace(api, workspacePath, warn)
    const request = sessionRequest({ cwd: '/original' })

    await wrapped.request('session/create', request, new AbortController().signal)

    expect(sessionCreate).toHaveBeenCalledWith(request)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('domain unavailable'))
  })
})
