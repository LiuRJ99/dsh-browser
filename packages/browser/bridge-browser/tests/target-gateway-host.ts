import { randomUUID } from 'node:crypto'
import { emitAgentEvent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

type PlainRecord = Record<string, any>

interface TargetGatewayRequest {
  namespace: string
  method: string
  args: PlainRecord
  signal: AbortSignal
}

interface SessionState {
  session: any
  followers: Set<AsyncQueue<any>>
  agent?: any
  workspaceId?: string
}

interface PendingQuestion {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  next: () => Promise<unknown>
}

/**
 * A small target-shaped host used by the composition tests. It exercises the
 * bridge against rc.1's `typertGateway` and `connection` surfaces without
 * pulling the entire product profile into a focused plugin test.
 */
export const TargetGatewayHost = {
  name: 'target-gateway-host',
  inject: ['sessions', 'userQuestions', 'agents'],
  apply(ctx: Context, config: { cwd: string; driveAgents?: boolean }): void {
    const sessions = new Map<string, SessionState>()
    const workspacePaths = new Map<string, string>()
    const eventHub = new EventHub()
    const pendingQuestions = new Map<string, PendingQuestion>()

    const summary = (state: SessionState): PlainRecord => {
      const events = state.session.snapshotEvents() as readonly PlainRecord[]
      const last = events.at(-1)
      const hasMessage = events.some((event) => event.type === 'user/message' || event.type === 'assistant/message')
      return {
        sessionId: String(state.session.id),
        updatedAt: typeof last?.time === 'number' ? last.time : state.session.header.createdAt,
        running: state.agent?.status === 'running',
        blank: !hasMessage,
        ...(state.session.header.cwd === undefined ? {} : { cwd: state.session.header.cwd }),
      }
    }

    const pushSessionEvent = (sessionId: string, event: unknown): void => {
      const state = sessions.get(sessionId)
      if (state === undefined) return
      for (const follower of state.followers) follower.push({ type: 'event', event })
    }

    ctx.on('session/event', (session: any, event: unknown) => {
      pushSessionEvent(String(session.id), event)
      eventHub.push({ type: 'emit', event: 'api-session/activity', args: [String(session.id), (event as PlainRecord).time] })
    })
    ctx.on('session/created', (session: any) => {
      const state = sessions.get(String(session.id))
      if (state !== undefined) eventHub.push({ type: 'emit', event: 'api-session/added', args: [summary(state)] })
    })
    ctx.on('session/disposed', (session: any) => {
      const sessionId = String(session.id)
      sessions.delete(sessionId)
      eventHub.push({ type: 'emit', event: 'api-session/removed', args: [sessionId] })
    })
    ctx.on('agent/status', ({ agent, status }: PlainRecord) => {
      eventHub.push({ type: 'emit', event: 'api-session/status', args: [String(agent.id), status === 'running'] })
    })
    ctx.on('user-questions/request', (request: PlainRecord, next: () => Promise<unknown>) => {
      const agent = request.agent
      if (agent === undefined || typeof agent.id !== 'string') return next()
      const eventId = randomUUID()
      const pending = new Promise<unknown>((resolve, reject) => {
        pendingQuestions.set(eventId, { resolve, reject, next })
      })
      request.signal?.addEventListener('abort', () => {
        if (!pendingQuestions.delete(eventId)) return
        eventHub.push({ type: 'cancel', eventId })
      }, { once: true })
      eventHub.push({
        type: 'waterfall',
        event: 'user-questions/request',
        eventId,
        agentId: String(agent.id),
        request: { questions: request.questions },
      })
      return pending
    })

    const invoke = async ({ namespace, method, args, signal }: TargetGatewayRequest): Promise<unknown> => {
      signal.throwIfAborted()
      const endpoint = `${namespace}/${method}`
      switch (endpoint) {
        case 'workspace/create': {
          const request = record(args.request)
          const path = typeof request?.path === 'string' ? request.path : undefined
          if (path === undefined) throw new Error('workspace/create requires path')
          const registry = ctx.get('workspaceRegistry') as { create?: (path: string) => Promise<any> } | undefined
          const workspace = registry?.create === undefined
            ? { id: `workspace-${randomUUID()}`, path }
            : await registry.create(path)
          const workspaceId = String(workspace.id ?? workspace.workspaceId)
          workspacePaths.set(workspaceId, path)
          return { workspace: { workspaceId, path } }
        }
        case 'workspace/archiveSession': {
          const request = record(args.request)
          const registry = ctx.get('workspaceRegistry') as { archiveSession?: (id: any) => Promise<void> } | undefined
          if (registry?.archiveSession !== undefined && typeof request?.sessionId === 'string') {
            await registry.archiveSession(SessionId(request.sessionId))
          }
          return { accepted: true }
        }
        case 'session/create': {
          const request = record(args.request) ?? {}
          const sessionId = typeof request.sessionId === 'string' && request.sessionId !== ''
            ? request.sessionId
            : `session-${randomUUID()}`
          const existing = sessions.get(sessionId)
          if (existing !== undefined) return { sessionId }
          const workspaceId = typeof request.workspaceId === 'string' ? request.workspaceId : undefined
          const cwd = typeof request.cwd === 'string'
            ? request.cwd
            : workspaceId === undefined ? config.cwd : workspacePaths.get(workspaceId) ?? config.cwd
          const session = ctx.sessions.create(SessionId(sessionId), { meta: { cwd } })
          const state: SessionState = { session, followers: new Set(), ...(workspaceId === undefined ? {} : { workspaceId }) }
          sessions.set(sessionId, state)
          if (config.driveAgents === true) state.agent = registerTestAgent(ctx, state)
          return { sessionId }
        }
        case 'session/list': {
          const items = [...sessions.values()].map(summary)
          return { items, hasMore: false }
        }
        case 'session/prompt': {
          const request = record(args.request)
          const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : undefined
          const state = sessionId === undefined ? undefined : sessions.get(sessionId)
          if (state?.agent === undefined) throw new Error(`session ${String(sessionId)} has no live agent`)
          const content = Array.isArray(request.content) ? request.content : []
          const message = createUserMessage({
            content,
            source: {
              kind: 'user',
              rpcId: request.requestId,
              ...(typeof request.clientTimeZone === 'string' ? { clientTimeZone: request.clientTimeZone } : {}),
            },
          } as any)
          state.agent.followup(message)
          return { accepted: true }
        }
        case 'session/cancel': {
          const request = record(args.request)
          const state = typeof request?.sessionId === 'string' ? sessions.get(request.sessionId) : undefined
          state?.agent?.cancel?.({ kind: 'user' }, { keepInbox: true })
          return { accepted: true }
        }
        default:
          throw new Error(`target gateway test host does not implement ${endpoint}`)
      }
    }

    const stream = async ({ namespace, method, args, signal }: TargetGatewayRequest): Promise<AsyncIterable<unknown>> => {
      const endpoint = `${namespace}/${method}`
      if (endpoint === 'session/follow') {
        const request = record(args.request)
        const address = record(request?.address)
        const sessionId = typeof address?.sessionId === 'string' ? address.sessionId : undefined
        const state = sessionId === undefined ? undefined : sessions.get(sessionId)
        if (state === undefined) throw new Error(`unknown session ${String(sessionId)}`)
        return followSession(state, signal)
      }
      if (endpoint === 'workspace/follow') {
        return oneFrame({
          type: 'baseline',
          value: {
            archivedSessionIds: [...((ctx.get('workspaceRegistry') as { archivedSessionIds?: readonly unknown[] } | undefined)?.archivedSessionIds ?? [])],
          },
        }, signal)
      }
      throw new Error(`target gateway test host does not stream ${endpoint}`)
    }

    const connection = {
      createSharedFetchHandler: () => ({
        fetch: async (request: Request): Promise<Response> => {
          const body = await request.json() as PlainRecord
          const payload = record(body.payload)
          const args = record(payload?.args) ?? {}
          const outcome = record(args.outcome)
          const eventId = typeof args.eventId === 'string' ? args.eventId : undefined
          const result = eventId === undefined || outcome === undefined
            ? rejectedResult('gateway/arguments-invalid', 'invalid event result')
            : await resolveQuestion(pendingQuestions, eventId, outcome)
          return Response.json({
            type: 'server-response',
            rpcId: typeof body.rpcId === 'string' ? body.rpcId : randomUUID(),
            result,
          })
        },
      }),
    }
    const gateway = {
      invoke,
      stream,
      wireStream: { open: async (_endpoint: string, _payload: unknown, signal: AbortSignal) => eventHub.open(signal) },
    }
    ctx.provide('connection', connection)
    ctx.provide('typertGateway', gateway)
    ctx.effect(() => () => eventHub.close(), 'target-gateway-host: event hub')
  },
}

function registerTestAgent(ctx: Context, state: SessionState): any {
  let status: 'idle' | 'running' = 'idle'
  const inbox = {
    nextTurn: [] as any[],
    nextStep: [] as any[],
    get hasPending() { return this.nextTurn.length > 0 || this.nextStep.length > 0 },
    append(target: 'next-turn' | 'next-step', message: any) {
      this[target].push(message)
    },
    clear() {
      this.nextTurn.length = 0
      this.nextStep.length = 0
    },
  }
  const agent: any = {
    id: state.session.id,
    options: { provider: 'p', model: 'm' },
    session: state.session,
    inbox,
    ctx,
    get status() { return status },
    followup(message: any) {
      inbox.append('next-turn', message)
      emitAgentEvent(ctx, agent, 'agent/inbox/inserted', { message })
      status = 'running'
      emitAgentEvent(ctx, agent, 'agent/status', { status })
      state.session.append('user/message', message, { surfaceOp: 'append' })
      status = 'idle'
      emitAgentEvent(ctx, agent, 'agent/status', { status })
      inbox.clear()
    },
    cancel() {
      status = 'idle'
      emitAgentEvent(ctx, agent, 'agent/status', { status })
      inbox.clear()
    },
    whenIdle: async () => {},
    inject: () => {},
    steer: () => {},
    send: () => {},
  }
  ctx.agents.register(agent)
  return agent
}

async function followSession(state: SessionState, signal: AbortSignal): Promise<AsyncIterable<unknown>> {
  const queue = new AsyncQueue<any>()
  const snapshot = {
    type: 'snapshot',
    header: state.session.header,
    cursor: Math.max(-1, Number(state.session.seq) - 1),
    records: state.session.snapshotEvents(),
    hasMore: false,
    projections: { asOfSeq: Math.max(-1, Number(state.session.seq) - 1), values: {} },
  }
  state.followers.add(queue)
  return (async function* () {
    try {
      yield snapshot
      yield* queue.iterate(signal)
    } finally {
      state.followers.delete(queue)
    }
  })()
}

function oneFrame(frame: unknown, signal: AbortSignal): AsyncIterable<unknown> {
  return (async function* () {
    if (!signal.aborted) yield frame
  })()
}

async function resolveQuestion(
  pendingQuestions: Map<string, PendingQuestion>,
  eventId: string,
  outcome: PlainRecord,
): Promise<PlainRecord> {
  const pending = pendingQuestions.get(eventId)
  if (pending === undefined) return rejectedResult('gateway/event-not-pending', 'event is no longer pending')
  pendingQuestions.delete(eventId)
  if (outcome.kind === 'result') {
    pending.resolve(outcome.value)
  } else if (outcome.kind === 'next') {
    void pending.next().then(pending.resolve, pending.reject)
  } else if (outcome.kind === 'rejected') {
    const error = record(outcome.error) ?? {}
    const reason = Object.assign(new Error(String(error.message ?? 'question rejected')), {
      name: String(error.name ?? 'UserQuestionError'),
      code: String(error.code ?? 'ASK_CANCELLED'),
      details: error.details,
    })
    pending.reject(reason)
  } else {
    return rejectedResult('gateway/arguments-invalid', 'invalid event outcome')
  }
  return { ok: true, value: { accepted: true } }
}

function rejectedResult(code: string, message: string): PlainRecord {
  return { ok: false, error: { code, message, details: {} } }
}

function record(value: unknown): PlainRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as PlainRecord
    : undefined
}

class EventHub {
  private readonly subscribers = new Set<AsyncQueue<any>>()
  private readonly clientId = `test-client-${randomUUID()}`

  open(signal: AbortSignal): AsyncIterable<unknown> {
    const queue = new AsyncQueue<any>()
    this.subscribers.add(queue)
    queue.push({ type: 'ready', clientId: this.clientId })
    return (async function* (hub: EventHub) {
      try {
        yield* queue.iterate(signal)
      } finally {
        hub.subscribers.delete(queue)
      }
    })(this)
  }

  push(frame: unknown): void {
    for (const subscriber of this.subscribers) subscriber.push(frame)
  }

  close(): void {
    for (const subscriber of this.subscribers) subscriber.close()
    this.subscribers.clear()
  }
}

class AsyncQueue<T> {
  private readonly values: T[] = []
  private waiter?: (result: IteratorResult<T>) => void
  private ended = false

  push(value: T): void {
    if (this.ended) return
    if (this.waiter !== undefined) {
      const waiter = this.waiter
      this.waiter = undefined
      waiter({ value, done: false })
      return
    }
    this.values.push(value)
  }

  close(): void {
    this.ended = true
    this.waiter?.({ value: undefined as never, done: true })
    this.waiter = undefined
  }

  async *iterate(signal: AbortSignal): AsyncIterable<T> {
    while (!signal.aborted) {
      const next = await this.next(signal)
      if (next.done) return
      yield next.value
    }
  }

  private next(signal: AbortSignal): Promise<IteratorResult<T>> {
    if (this.values.length > 0) return Promise.resolve({ value: this.values.shift()!, done: false })
    if (this.ended || signal.aborted) return Promise.resolve({ value: undefined as never, done: true })
    return new Promise((resolve) => {
      const abort = () => {
        if (this.waiter !== resolve) return
        this.waiter = undefined
        resolve({ value: undefined as never, done: true })
      }
      signal.addEventListener('abort', abort, { once: true })
      this.waiter = (result) => {
        signal.removeEventListener('abort', abort)
        resolve(result)
      }
    })
  }
}
