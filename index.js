/**
 * Host half of the bundle.
 *
 * DSH shows a tool call's result to the model without saying how long the human
 * took to answer its approval prompt, while the runtime context reports the
 * elapsed wall-clock time between model-visible messages. A missed prompt
 * therefore looks exactly like a stalled or failing tool, and a model that reads
 * "Elapsed since the preceding model-visible message: 7m 12s" tends to re-audit
 * work that was never wrong.
 *
 * This entry owns three things and nothing else:
 *
 * 1. `Config` — the row's schema. Every field is volatile, so the Plugins page's
 *    row configuration (`./client`) can edit it and the change reaches the
 *    running fiber without a restart.
 * 2. The settings presentation policy: because this bundle ships its own page,
 *    it tells the Host not to auto-generate a form for the namespace.
 * 3. The runtime wiring, in `./lib/plugin.js`: time `approval/request`, then
 *    append one `additionalContexts` notice on `tools/post-execute`.
 */

import z from '@deepseek-ai/schemastery';
import { configSchema } from './lib/latency.js';
import { mountApprovalLatency } from './lib/plugin.js';

/** Settings namespace this row serves; the client page binds the same string. */
export const SETTINGS_NAMESPACE = 'approval-latency';

/** The row's live config: volatile fields, editable from its configuration page. */
export const Config = configSchema(z);

/**
 * Mount the plugin.
 *
 * @param ctx - the plugin's Cordis context; listeners are disposed with it.
 * @param config - the row's resolved config (volatile `.get()` refs).
 */
export function apply(ctx, config) {
	// This bundle also owns a configuration page, so the Host must not synthesize one.
	ctx.inject(['settings'], (child) => {
		child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
	});
	mountApprovalLatency(ctx, config);
}
