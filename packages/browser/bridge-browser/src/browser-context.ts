/**
 * Model-facing browser page context injected after an explicit tab handoff.
 *
 * The extension captures the page immediately after the user chooses to
 * follow it. A live Agent receives that snapshot at once; a deferred session
 * keeps only its newest snapshot until `agent/session-start` publishes the
 * Agent. Injection deliberately does not wake an idle Agent — the snapshot is
 * claimed together with the user's next message.
 *
 * Since dsh-tool-lazy-gate locks the browser capability per session until the
 * user explicitly invokes `/browser`, snapshots are additionally gated: when
 * the session's capability is still locked (or the Agent is not yet live) the
 * snapshot is only queued, and delivery waits for an `activate`/`flush` call
 * after the session unlocks. This keeps page content out of sessions whose
 * user never opted into browser control.
 *
 * @module
 */

import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'

/** Provenance key used for snapshot supersession and transcript presentation. */
export const BROWSER_CONTEXT_PLUGIN = '@yuxianglin/dsh-bridge-browser'

/** Bound orphaned provisional sessions while retaining normal recent tabs. */
const DEFAULT_MAX_PENDING = 32

/**
 * Optional capability gate consulted before delivering a snapshot: return
 * false while the target session's browser capability is locked. Consumers
 * without a gate (no lazy-gate installed) simply omit it — delivery then
 * behaves exactly like the un-gated extension handoff.
 */
export type BrowserContextGate = (agent: Agent) => boolean

/** Build one immutable context message from a captured browser snapshot. */
export function createBrowserSnapshotMessage(snapshot: string): UserMessage {
  const text = [
    'The user chose to follow the newly active browser tab. The browser page context was refreshed immediately after that choice.',
    'The following is an already completed browser_snapshot of the current page. Use its stable indices directly for the next request; do not take an immediate duplicate snapshot unless required context is missing.',
    snapshot,
  ].join('\n\n')
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: BROWSER_CONTEXT_PLUGIN,
      form: 'snapshot',
      sections: [{ name: 'browser-page', text }],
    },
  })
}

/** Deliver followed-page snapshots to live or not-yet-materialized Agents. */
export class BrowserContextInjector {
  private readonly pending = new Map<string, string>()

  constructor(
    private readonly agents: Pick<AgentRegistry, 'get'>,
    private readonly maxPending = DEFAULT_MAX_PENDING,
    private readonly gate: BrowserContextGate = () => true,
  ) {
    if (!Number.isInteger(maxPending) || maxPending < 1) {
      throw new Error('browser context maxPending must be a positive integer')
    }
  }

  /** Inject now when the Agent is live AND its gate is open; otherwise queue. */
  inject(sessionId: string, snapshot: string): 'injected' | 'queued' {
    const agent = this.agents.get(sessionId as Parameters<AgentRegistry['get']>[0])
    if (agent !== undefined && this.deliverable(agent)) {
      this.pending.delete(sessionId)
      agent.inject(createBrowserSnapshotMessage(snapshot))
      return 'injected'
    }
    return this.queue(sessionId, snapshot)
  }

  /** Keep only the newest snapshot for one session, bounded by {@link maxPending}. */
  private queue(sessionId: string, snapshot: string): 'queued' {
    // Refresh insertion order when the same session follows again.
    this.pending.delete(sessionId)
    while (this.pending.size >= this.maxPending) {
      const oldest = this.pending.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.pending.delete(oldest)
    }
    this.pending.set(sessionId, snapshot)
    return 'queued'
  }

  /**
   * Flush one session's queued snapshot at a supported delivery boundary
   * (`agent/session-start`, every pre-step, or an explicit unlock notice):
   * the snapshot is injected only once the Agent is live and the gate opens.
   */
  activate(agent: Agent): boolean {
    const sessionId = String(agent.id)
    const snapshot = this.pending.get(sessionId)
    if (snapshot === undefined || !this.deliverable(agent)) return false
    agent.inject(createBrowserSnapshotMessage(snapshot))
    this.pending.delete(sessionId)
    return true
  }

  /** Step-boundary alias of {@link activate} for pre-step delivery attempts. */
  flush(agent: Agent): boolean {
    return this.activate(agent)
  }

  private deliverable(agent: Agent): boolean {
    try {
      return this.gate(agent) !== false
    } catch {
      // A failing gate must not wedge delivery; fall back to un-gated behavior.
      return true
    }
  }
}
