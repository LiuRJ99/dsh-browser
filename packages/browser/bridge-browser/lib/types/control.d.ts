/**
 * Authenticated loopback control route for local automation clients.
 *
 * The dsh-browser extension remains the only WebSocket client of BridgeServer.
 * Local callers use this route so requests are forwarded through the existing
 * BridgeServer.requestTool() connection and retain the extension's tab-affinity,
 * approval, privacy, and content-script behavior.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BRIDGE_CONTROL_PATH } from './protocol.ts';
import { type BridgeServer } from './server.ts';
export { BRIDGE_CONTROL_PATH };
export interface BrowserControlDeps {
    token: string;
    bridge: Pick<BridgeServer, 'requestTool'>;
    defaultTimeoutMs: number;
}
/** Serve one local browser-tool request through the already-connected extension. */
export declare function serveBrowserControl(req: IncomingMessage, res: ServerResponse, deps: BrowserControlDeps): Promise<void>;
//# sourceMappingURL=control.d.ts.map