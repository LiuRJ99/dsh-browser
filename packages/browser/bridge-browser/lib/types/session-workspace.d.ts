/**
 * Best-effort workspace grouping for browser-created Sessions.
 *
 * This is a small adapter over the rc.1 Gateway. It changes only implicit
 * `session/create` requests; explicit workspace choices and all other calls
 * pass through unchanged.
 *
 * @module
 */
import type { BrowserGateway } from './gateway.ts';
type Warn = (message: string) => void;
/**
 * Add one cached Workspace registration to implicit Session creation.
 *
 * @param gateway - canonical rc.1 Gateway adapter.
 * @param workspacePath - dedicated directory, or empty to opt out.
 * @param warn - logger called once when grouping cannot be established.
 */
export declare function withSessionWorkspace(gateway: BrowserGateway, workspacePath: string, warn: Warn): BrowserGateway;
export {};
//# sourceMappingURL=session-workspace.d.ts.map