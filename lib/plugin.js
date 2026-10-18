/**
 * The wiring half: everything the plugin does at runtime, with no schemastery
 * import so it stays testable in a plain Node process.
 *
 * The plugin entry (`../index.js`) owns the Loader row's `Config` schema and
 * hands the resolved config here. Config fields are volatile, so this module
 * re-reads them on every decision instead of snapshotting them at activation:
 * a change made on the Web settings page takes effect on the next approval.
 */

import { randomUUID } from 'node:crypto';
import {
	CONFIG_FIELDS,
	buildNotice,
	createLedger,
	createSampler,
	isAnswerOutcome,
	normalizeConfig,
	resolveThresholds,
	shouldReport,
} from './latency.js';

/** Source kind this plugin owns for the messages it injects. */
const SOURCE_KIND = 'approval-latency';

/**
 * Read one config value, unwrapping the Host's volatile `.get()` ref.
 * @param node - a plain value or a volatile ref.
 * @returns the current plain value, or `undefined`.
 */
function unwrap(node) {
	if (node === undefined || node === null) return undefined;
	if (typeof node === 'object' && typeof node.get === 'function') return node.get();
	return node;
}

/**
 * Project a resolved (volatile) config onto the fields this plugin reads.
 * @param config - the Loader row's resolved config.
 * @returns plain values, ready for {@link normalizeConfig}.
 */
function plainConfig(config) {
	const plain = {};
	for (const field of CONFIG_FIELDS) {
		const value = unwrap(config?.[field]);
		if (value !== undefined) plain[field] = value;
	}
	return plain;
}

/**
 * Mount the approval timer and the post-execute notice on one Cordis context.
 *
 * `approval/request` is wrapped `prepend`, so it sits outside whatever answerer
 * the deployment composes (the Web bridge, ACP, a headless policy). The wrapper
 * only times the decision and always delegates with `next()`; it never answers a
 * request. `tools/post-execute` then runs for the same call id and appends one
 * `additionalContexts` entry when the wait crossed the bar.
 *
 * @param ctx - the plugin's Cordis context; listeners are disposed with it.
 * @param config - the row's resolved config, plain values or volatile refs.
 */
export function mountApprovalLatency(ctx, config) {
	const ledger = createLedger();
	const sampler = createSampler();
	let lastGood = normalizeConfig(undefined);

	/**
	 * The effective settings right now, re-read so a settings-page change lands
	 * on the next approval. A rejected read keeps the last good values: the Host
	 * validates writes, so this is defence against an unreadable row, not policy.
	 */
	const settingsNow = () => {
		try {
			lastGood = normalizeConfig(plainConfig(config));
		} catch (error) {
			warn(ctx, `settings ignored, keeping the previous values: ${errorMessage(error)}`);
		}
		return lastGood;
	};

	ctx.on(
		'approval/request',
		async (request, next) => {
			const entry = ledger.begin(request);
			let outcome;
			try {
				outcome = await next();
			} catch (error) {
				// The chain failed; the outcome is not a decision, so never report it.
				ledger.settle(entry, 'error');
				throw error;
			}
			if (typeof outcome === 'string') ledger.settle(entry, outcome);
			return outcome;
		},
		{ prepend: true },
	);

	ctx.on('tools/post-execute', async (exec, result, next) => {
		const decision = await next();
		let message;
		try {
			message = noticeFor(ctx, exec, ledger, sampler, settingsNow);
		} catch (error) {
			warn(ctx, `notice skipped for "${String(exec?.name)}": ${errorMessage(error)}`);
			return decision;
		}
		if (message === undefined) return decision;
		return withContext(decision, message);
	});
}

/**
 * Build the model-facing message for one finishing call, consuming its record.
 *
 * The bars are resolved from history *before* this call's own wait is sampled,
 * so a single long absence can never justify itself.
 *
 * @param ctx - plugin context, for the debug line only.
 * @param exec - the tool execution that just produced a result.
 * @param ledger - the approval ledger.
 * @param sampler - answered-wait history, still excluding this call.
 * @param settingsNow - reads the effective settings.
 * @returns the message to inject, or `undefined` when this call is not worth one.
 */
function noticeFor(ctx, exec, ledger, sampler, settingsNow) {
	if (exec === undefined || exec === null) return undefined;
	const entry = ledger.take(exec.agent, exec.callId, exec.name);
	if (entry === undefined) return undefined;

	const settings = settingsNow();
	const thresholds = resolveThresholds(settings, sampler);
	const reportable = shouldReport(settings, entry, thresholds);
	if (isAnswerOutcome(entry.outcome)) sampler.record(entry.waitedMs, settings.ceilingMs);
	if (!reportable) return undefined;

	debug(ctx, describe(thresholds, entry));
	return noticeMessage(buildNotice(entry));
}

/**
 * Wrap one notice in the user-message shape the loop accepts as context.
 * @param notice - text and bounded summary.
 * @returns a frozen user message carrying the plugin-owned source kind.
 */
function noticeMessage(notice) {
	return Object.freeze({
		id: randomUUID(),
		role: 'user',
		content: Object.freeze([Object.freeze({ type: 'text', text: notice.text })]),
		source: Object.freeze({ kind: SOURCE_KIND, form: 'notice', summary: notice.summary }),
	});
}

/**
 * Append the notice to a post-execute decision that can carry contexts.
 *
 * Both accepted variants and a block keep their own payload; only the context
 * array grows, which is why a later listener's blocking feedback still wins.
 *
 * @param decision - the downstream `PostToolDecision`.
 * @param message - the notice message to append.
 * @returns the enriched decision, or the original when it carries no contexts.
 */
function withContext(decision, message) {
	if (decision === null || typeof decision !== 'object') return decision;
	if (decision.kind !== 'accept' && decision.kind !== 'block') return decision;
	const additionalContexts = [...(decision.additionalContexts ?? []), message];
	return { ...decision, additionalContexts };
}

/** One-line account of the bars behind a notice, so tuning needs no guesswork. */
function describe(thresholds, entry) {
	const baseline = thresholds.baselineMs === undefined ? 'n/a' : `${Math.round(thresholds.baselineMs)}ms`;
	return (
		`notice for "${String(entry.toolName)}": mode=${thresholds.mode} ` +
		`grant=${thresholds.grantMs}ms rejection=${thresholds.rejectionMs}ms ` +
		`baseline=${baseline} samples=${thresholds.samples} ` +
		`waited=${Math.round(entry.waitedMs)}ms outcome=${String(entry.outcome)}`
	);
}

/** Report one swallowed internal failure without letting the host call fail. */
export function warn(ctx, text) {
	try {
		ctx.logger?.warn?.(`approval-latency: ${text}`);
	} catch {
		/* a broken logger must not break the tool pipeline */
	}
}

/** Write one debug line; a broken logger must never break the pipeline. */
function debug(ctx, text) {
	try {
		ctx.logger?.debug?.(`approval-latency: ${text}`);
	} catch {
		/* ignore */
	}
}

/** Read a message out of an unknown thrown value. */
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
