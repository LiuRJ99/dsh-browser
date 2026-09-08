/**
 * Model-facing browser tools. Every tool executes by dispatching a `tool.call`
 * over the bridge to the connected extension, which performs the action in the
 * user's explicitly controlled tab and returns a pure-text result.
 *
 * The whole surface is text-only by design (DeepSeek models have no vision):
 * `browser_snapshot` renders the page as structured text with a numbered
 * interactive inventory, and every other tool addresses elements by that
 * inventory's stable index. Results are single `{ text }` objects rendered as
 * one text ContentBlock.
 *
 * The extension also exposes background-level tools (`browser_screenshot`,
 * `browser_network_capture`, `browser_list_tabs`, `browser_download_wait`)
 * that never touch the content script. `browser_screenshot` is the one
 * exception to the pure-text contract: it captures a PNG/JPEG in the extension
 * via `chrome.debugger`, returns the base64 payload over the bridge, and the
 * plugin writes it to disk so the model gets back a file path instead of the
 * raw image (the model still sees no pixels).
 *
 * @module
 */
import type { Context } from '@deepseek-ai/cordis';
import { type BridgeServer } from './server.ts';
/** Options resolved from plugin config before tool registration. */
export interface BrowserToolsOptions {
    /** Per-tool-call budget in ms (also the bridge's default). */
    toolTimeoutMs: number;
    /** Upper bound on one snapshot's rendered characters. */
    snapshotMaxChars: number;
    /** Upper bound on interactive inventory items per snapshot. */
    maxInteractiveItems: number;
    /** Directory where `browser_screenshot` writes captured images. Defaults under the dsh home. */
    screenshotDir?: string;
}
/** Maximum size of one local file accepted by browser_upload_file. */
export declare const MAX_UPLOAD_FILE_BYTES: number;
/** Extensions accepted by the local-file validation gate (case-insensitive). */
export declare const UPLOAD_FILE_EXTENSIONS: Set<string>;
/** The keys the extension accepts as wire action names (tool name == action name). */
export declare const BROWSER_TOOL_NAMES: readonly ["browser_snapshot", "browser_click", "browser_type", "browser_upload_file", "browser_press", "browser_scroll", "browser_navigate", "browser_open_tab", "browser_list_tabs", "browser_follow_tab", "browser_close_tab", "browser_back", "browser_forward", "browser_reload", "browser_get_text", "browser_wait", "browser_screenshot", "browser_click_text", "browser_wait_for", "browser_get_table", "browser_eval", "browser_download_wait", "browser_network_capture", "browser_attach_tab"];
/**
 * Register the browser tools on `ctx.tools`. Disposers are returned for the
 * caller's effect to own; each tool's cooperative timeout budget is declared
 * so `@deepseek-ai/dsh-timeout-policy` can enforce it, and every execute
 * forwards `exec.signal` into the bridge call (abort settles it).
 *
 * @param ctx - Cordis context with the tools service.
 * @param bridge - the authenticated bridge server.
 * @param options - resolved tool budgets.
 * @returns disposers keyed by tool name.
 */
export declare function registerBrowserTools(ctx: Context, bridge: BridgeServer, options: BrowserToolsOptions): Map<string, () => void>;
//# sourceMappingURL=tools.d.ts.map