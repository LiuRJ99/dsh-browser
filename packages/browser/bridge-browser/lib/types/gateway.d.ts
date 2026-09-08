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
import type { Context } from '@deepseek-ai/cordis';
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client';
import { type SessionEvent } from '@deepseek-ai/dsh-session';
/** One rc.1 Connection business result. */
export type GatewayResult<T = unknown> = ConnectionRpcResult<T>;
/** Transport-independent target Gateway used by the bridge and its wrappers. */
export interface BrowserGateway {
    /** Invoke one canonical rc.1 Remote endpoint with named arguments. */
    request(endpoint: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<GatewayResult>;
    /** Open one canonical rc.1 Remote stream, or one Gateway-owned stream. */
    open(endpoint: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<AsyncIterable<unknown>>;
    /** Submit one Gateway-owned forwarded-event outcome through `/api`. */
    respondEvent(clientId: string, eventId: string, outcome: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<GatewayResult>;
}
/** Host event frame consumed by BridgeServer; independent of any old DSH API. */
export interface BridgeEventFrame {
    rpcId: string;
    method: string;
    payload: unknown;
}
/** Target Gateway failure projected to a JSON-safe Connection result. */
export interface GatewayFailure {
    code: string;
    message: string;
    details: object;
}
/**
 * Construct a direct rc.1 Gateway adapter.  Unary calls use `invoke`; stream
 * calls use `stream`, except for `$events`, which is owned by the Gateway's
 * forwarded-event carrier and therefore uses `wireStream.open`.
 */
export declare function createBrowserGateway(ctx: Context): BrowserGateway;
/**
 * Translate one extension RPC to rc.1 named Remote arguments.  This keeps the
 * extension's own protocol stable while removing every dependency on the
 * pre-rc.1 host-apiproxy transport.
 */
export declare function dispatchBrowserRpc(gateway: BrowserGateway, method: string, payload: unknown, signal: AbortSignal): Promise<GatewayResult>;
/** Map the extension's dotted method names to rc.1 slash-separated endpoints. */
export declare function legacyEndpoint(method: string): string | undefined;
/**
 * Build the exact named parameter object expected by the generated rc.1
 * descriptors.  Most session/workspace methods take one `request` argument;
 * settings, credentials, and LLM discovery expose named parameters.
 */
export declare function namedArguments(endpoint: string, payload: Record<string, unknown>, legacyMethod?: string): Readonly<Record<string, unknown>> | undefined;
/** Flatten target history records, including rc.1 packed chunk rows. */
export declare function eventsFromRecords(records: readonly unknown[]): Array<{
    event: SessionEvent;
}>;
/** Turn one target Session follow snapshot into the browser panel history shape. */
export declare function historyFromFrame(frame: unknown): Record<string, unknown> | undefined;
/** Recognize one target live Session event frame. */
export declare function eventFromFollowFrame(value: unknown): SessionEvent | undefined;
/** Convert an arbitrary target failure to the rc.1 Connection failure shape. */
export declare function asGatewayFailure(error: unknown): GatewayFailure;
//# sourceMappingURL=gateway.d.ts.map