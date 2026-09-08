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
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent';
import { type UserMessage } from '@deepseek-ai/dsh-llm';
/** Provenance key used for snapshot supersession and transcript presentation. */
export declare const BROWSER_CONTEXT_PLUGIN = "@yuxianglin/dsh-bridge-browser";
/**
 * Optional capability gate consulted before delivering a snapshot: return
 * false while the target session's browser capability is locked. Consumers
 * without a gate (no lazy-gate installed) simply omit it — delivery then
 * behaves exactly like the un-gated extension handoff.
 */
export type BrowserContextGate = (agent: Agent) => boolean;
/** Build one immutable context message from a captured browser snapshot. */
export declare function createBrowserSnapshotMessage(snapshot: string): UserMessage;
/** Deliver followed-page snapshots to live or not-yet-materialized Agents. */
export declare class BrowserContextInjector {
    private readonly agents;
    private readonly maxPending;
    private readonly gate;
    private readonly pending;
    constructor(agents: Pick<AgentRegistry, 'get'>, maxPending?: number, gate?: BrowserContextGate);
    /** Inject now when the Agent is live AND its gate is open; otherwise queue. */
    inject(sessionId: string, snapshot: string): 'injected' | 'queued';
    /** Keep only the newest snapshot for one session, bounded by {@link maxPending}. */
    private queue;
    /**
     * Flush one session's queued snapshot at a supported delivery boundary
     * (`agent/session-start`, every pre-step, or an explicit unlock notice):
     * the snapshot is injected only once the Agent is live and the gate opens.
     */
    activate(agent: Agent): boolean;
    /** Step-boundary alias of {@link activate} for pre-step delivery attempts. */
    flush(agent: Agent): boolean;
    private deliverable;
}
//# sourceMappingURL=browser-context.d.ts.map