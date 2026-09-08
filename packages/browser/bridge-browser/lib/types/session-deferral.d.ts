/**
 * Defer real Session creation until the first prompt.
 *
 * The panel opens a provisional session immediately. This adapter keeps that
 * id entirely in memory and only forwards `session/create` when the first
 * `session/prompt` arrives. It wraps the rc.1 Gateway adapter directly; no
 * legacy host-apiproxy request or response type is involved.
 *
 * @module
 */
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment';
import type { BrowserGateway } from './gateway.ts';
/**
 * Wrap the Gateway with in-memory session creation deferral.
 *
 * @param gateway - canonical rc.1 Gateway adapter.
 * @param enabled - whether deferral is active.
 * @param imageLimits - optional image projection exposed by provisional history.
 */
export declare function withSessionDeferral(gateway: BrowserGateway, enabled: boolean, imageLimits?: ImageAttachmentLimits): BrowserGateway;
//# sourceMappingURL=session-deferral.d.ts.map