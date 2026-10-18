/**
 * Pure helpers behind the approval-latency notice.
 *
 * Nothing here touches Cordis, the filesystem, the network, or a clock beyond
 * the one injected into {@link createLedger}: the plugin entry wires these
 * functions to `approval/request` and `tools/post-execute`, and the unit tests
 * drive them directly.
 */

/**
 * Default bar for `mode: fixed` — 30 s, the point where a click stops looking
 * like a click and the model's elapsed line starts inviting the wrong story.
 */
export const DEFAULT_FIXED_MS = 30_000;

/** Cold-start bar, used by `mode: auto` until this machine has answered `minSamples` approvals. */
export const COLD_START_MS = DEFAULT_FIXED_MS;

/** Never report below this: a wait shorter than a glance is not news. */
export const DEFAULT_FLOOR_MS = 10_000;

/** Never demand more than this: the learned baseline may not drift out of reach. */
export const DEFAULT_CEILING_MS = 300_000;

/** "Unusually long" means `multiplier` times this machine's median answer. */
export const DEFAULT_MULTIPLIER = 3;

/** Samples needed before the learned baseline replaces the cold-start bar. */
export const DEFAULT_MIN_SAMPLES = 3;

/** A late rejection costs more thought than a late grant, so it is reported at a lower bar. */
export const DEFAULT_REJECTION_SCALE = 0.5;

/** How many recent answers the median is computed over. */
export const SAMPLE_WINDOW = 20;

/** Every config field this plugin reads, in the order the schemas declare them. */
export const CONFIG_FIELDS = Object.freeze([
	'mode',
	'fixedMs',
	'floorMs',
	'ceilingMs',
	'multiplier',
	'minSamples',
	'rejectionScale',
	'reportDenials',
	'thresholdMs',
]);

/** Cap one agent's pending approvals so a record no post-execute ever claims cannot grow the ledger. */
export const DEFAULT_MAX_RECORDS = 64;

/** Drop records older than this; an approval whose call never reached post-execute is not worth reporting. */
export const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** Bound for a `notice` summary, mirroring the durable-log convention. */
export const MAX_SUMMARY_CHARS = 120;

const GRANT = 'allowed-once';
const REJECTION = 'rejected';
const UNANSWERED = new Set(['cancelled', 'unavailable']);
const MODES = new Set(['auto', 'fixed']);

/** Read one optional numeric field or fail with the field's own name. */
function numberField(input, name, fallback) {
	const value = input[name] ?? fallback;
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		throw new TypeError(
			`dsh-approval-latency: "${name}" must be a finite number >= 0 (got ${JSON.stringify(input[name])})`,
		);
	}
	return value;
}

/**
 * Read the row's `config`, applying defaults and failing loudly on nonsense.
 *
 * The bundle exports no schemastery `Config` on purpose (zero runtime
 * dependencies), so this function is the single validator for the row.
 *
 * `mode` picks the bar outright:
 *
 * - `auto` — learn it from this machine's own answered approvals (the default).
 * - `fixed` — always use `fixedMs`, ignoring what has been learned.
 *
 * The mode is implied when it is omitted so that writing only a duration still
 * does what it says: `fixedMs: 45000` (or the legacy `thresholdMs`) means
 * `mode: fixed`. An explicit `mode` always wins; under `mode: auto` a supplied
 * `fixedMs` is simply unused, exactly like `floorMs` under `mode: fixed`.
 *
 * @param config - the raw `config` of this plugin's loader row.
 * @returns the frozen effective settings.
 * @throws {TypeError} when a field is present but cannot be honoured.
 */
export function normalizeConfig(config) {
	if (config !== undefined && config !== null && (typeof config !== 'object' || Array.isArray(config))) {
		throw new TypeError('dsh-approval-latency: config must be an object');
	}
	const input = config ?? {};

	// Deprecated alias kept so a row written against 0.2.0 keeps working.
	const legacyFixedMs = input.thresholdMs;
	if (
		legacyFixedMs !== undefined &&
		legacyFixedMs !== null &&
		(typeof legacyFixedMs !== 'number' || !Number.isFinite(legacyFixedMs) || legacyFixedMs < 0)
	) {
		throw new TypeError(
			`dsh-approval-latency: "thresholdMs" (deprecated alias of "fixedMs") must be null or a finite number >= 0 (got ${JSON.stringify(legacyFixedMs)})`,
		);
	}

	const suppliedFixedMs = input.fixedMs !== undefined ? input.fixedMs : legacyFixedMs;
	const impliesFixed = suppliedFixedMs !== undefined && suppliedFixedMs !== null;

	const mode = input.mode ?? (impliesFixed ? 'fixed' : 'auto');
	if (typeof mode !== 'string' || !MODES.has(mode)) {
		throw new TypeError(
			`dsh-approval-latency: "mode" must be "auto" or "fixed" (got ${JSON.stringify(input.mode)})`,
		);
	}

	const fixedMs = numberField(input, 'fixedMs', suppliedFixedMs ?? DEFAULT_FIXED_MS);

	const floorMs = numberField(input, 'floorMs', DEFAULT_FLOOR_MS);
	const ceilingMs = numberField(input, 'ceilingMs', DEFAULT_CEILING_MS);
	if (ceilingMs < floorMs) {
		throw new TypeError(
			`dsh-approval-latency: "ceilingMs" (${ceilingMs}) must be >= "floorMs" (${floorMs})`,
		);
	}

	const multiplier = numberField(input, 'multiplier', DEFAULT_MULTIPLIER);
	if (multiplier < 1) {
		throw new TypeError(`dsh-approval-latency: "multiplier" must be >= 1 (got ${multiplier})`);
	}

	const minSamples = input.minSamples ?? DEFAULT_MIN_SAMPLES;
	if (!Number.isInteger(minSamples) || minSamples < 1) {
		throw new TypeError(`dsh-approval-latency: "minSamples" must be an integer >= 1 (got ${JSON.stringify(input.minSamples)})`);
	}

	const rejectionScale = input.rejectionScale ?? DEFAULT_REJECTION_SCALE;
	if (typeof rejectionScale !== 'number' || !Number.isFinite(rejectionScale) || rejectionScale <= 0 || rejectionScale > 1) {
		throw new TypeError(
			`dsh-approval-latency: "rejectionScale" must be a number in (0, 1] (got ${JSON.stringify(input.rejectionScale)})`,
		);
	}

	const reportDenials = input.reportDenials ?? true;
	if (typeof reportDenials !== 'boolean') {
		throw new TypeError('dsh-approval-latency: "reportDenials" must be a boolean');
	}

	return Object.freeze({
		mode,
		fixedMs,
		floorMs,
		ceilingMs,
		multiplier,
		minSamples,
		rejectionScale,
		reportDenials,
	});
}

/** Confine one value to a closed range. */
function clamp(value, low, high) {
	return Math.min(high, Math.max(low, value));
}

/**
 * The Loader row's Config schema.
 *
 * Every field is `volatile()`, which is what makes it editable from the Web
 * settings page: `@deepseek-ai/dsh-settings` serves a namespace per profile row
 * and exposes exactly the volatile fields, and a volatile-only change is applied
 * to the running fiber in place (the Host wraps each one in a `.get()` ref) so
 * the new value takes effect without a restart.
 *
 * The schema is a parameter so this module stays free of the schemastery import;
 * only the plugin entry binds it.
 *
 * @param z - the schemastery module (`@deepseek-ai/schemastery`).
 * @returns the Config schema for this plugin's Loader row.
 */
export function configSchema(z) {
	return z.object({
		mode: z.union(['auto', 'fixed']).default('auto').volatile(),
		fixedMs: z.number().min(0).default(DEFAULT_FIXED_MS).volatile(),
		floorMs: z.number().min(0).default(DEFAULT_FLOOR_MS).volatile(),
		ceilingMs: z.number().min(0).default(DEFAULT_CEILING_MS).volatile(),
		multiplier: z.number().min(1).default(DEFAULT_MULTIPLIER).volatile(),
		minSamples: z.number().step(1).min(1).default(DEFAULT_MIN_SAMPLES).volatile(),
		rejectionScale: z.number().min(0.1).max(1).default(DEFAULT_REJECTION_SCALE).volatile(),
		reportDenials: z.boolean().default(true).volatile(),
	});
}

/**
 * Learn how long this human normally takes to answer an approval.
 *
 * Only real answers are sampled — a granted or rejected prompt, never an
 * abandonment — and each sample is clamped to the ceiling so one hour-long
 * absence cannot drag the baseline out of reach. The median keeps a few
 * outliers from moving the estimate at all.
 *
 * @param options - window size and the default clamp applied to each sample.
 * @returns a sampler with `record`, `median`, `size`, and `reset`.
 */
export function createSampler({ window = SAMPLE_WINDOW, ceilingMs = DEFAULT_CEILING_MS } = {}) {
	const samples = [];
	return {
		/**
		 * Add one answered wait.
		 * @param ms - how long the prompt stayed open before it was answered.
		 * @param ceiling - clamp for this sample; the live `ceilingMs` when mounted.
		 */
		record(ms, ceiling = ceilingMs) {
			if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return;
			samples.push(Math.min(ms, ceiling));
			if (samples.length > window) samples.shift();
		},
		/** @returns how many answers are currently remembered. */
		size() {
			return samples.length;
		},
		/** @returns the median answered wait, or `undefined` with no samples. */
		median() {
			if (samples.length === 0) return undefined;
			const sorted = [...samples].sort((a, b) => a - b);
			const middle = sorted.length >> 1;
			return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
		},
		/** Forget every sample (diagnostics and tests). */
		reset() {
			samples.length = 0;
		},
	};
}

/**
 * Resolve the bars for one notice decision.
 *
 * `mode: fixed` uses `fixedMs` outright and never learns. `mode: auto` uses
 * `multiplier` × the learned median, confined to floor..ceiling, and falls back
 * to {@link COLD_START_MS} until `minSamples` answers exist. Either way the
 * rejection bar is `rejectionScale` of the grant bar, never below the floor.
 *
 * @param settings - result of {@link normalizeConfig}.
 * @param sampler - the answer-latency sampler; must not include the wait being judged.
 * @returns the bars plus the inputs that produced them, for logs and tests.
 */
export function resolveThresholds(settings, sampler) {
	const samples = sampler?.size?.() ?? 0;
	let mode = 'fixed';
	let grantMs;
	let baselineMs;

	if (settings.mode === 'fixed') {
		grantMs = settings.fixedMs;
	} else if (samples < settings.minSamples) {
		mode = 'cold';
		grantMs = clamp(COLD_START_MS, settings.floorMs, settings.ceilingMs);
	} else {
		mode = 'learned';
		baselineMs = sampler.median();
		grantMs = clamp(Math.round(baselineMs * settings.multiplier), settings.floorMs, settings.ceilingMs);
	}

	// In fixed mode an explicit bar below the floor is honoured, so the floor
	// only ever raises the rejection bar, never lowers the grant bar.
	const lowerBound = Math.min(settings.floorMs, grantMs);
	const rejectionMs = Math.min(grantMs, Math.max(lowerBound, Math.round(grantMs * settings.rejectionScale)));

	return Object.freeze({ mode, grantMs, rejectionMs, baselineMs, samples });
}

/**
 * Render a duration the way a model reads it fastest.
 *
 * @param ms - non-negative milliseconds.
 * @returns `850ms`, `42s`, `6m 6s`, `1h 5m`, `2d 4h`.
 */
export function formatDuration(ms) {
	if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
		throw new TypeError(`dsh-approval-latency: duration must be a finite number >= 0 (got ${JSON.stringify(ms)})`);
	}
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		const rest = seconds % 60;
		return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		const rest = minutes % 60;
		return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
	}
	const days = Math.floor(hours / 24);
	const rest = hours % 24;
	return rest === 0 ? `${days}d` : `${days}d ${rest}h`;
}

/** Keep a tool name inside the notice without letting an MCP-qualified name dominate it. */
function shortToolName(toolName) {
	const name = typeof toolName === 'string' && toolName.length > 0 ? toolName : 'this tool';
	return name.length <= 64 ? name : `${name.slice(0, 63)}…`;
}

/** Bound one-line summary to the durable-log convention. */
function boundSummary(summary) {
	return summary.length <= MAX_SUMMARY_CHARS ? summary : `${summary.slice(0, MAX_SUMMARY_CHARS - 1)}…`;
}

/**
 * Build the model-facing notice for one consumed approval record.
 *
 * Every variant states the wait, attributes it to the human, and separates it
 * from any judgement about the call or the code the call touched — the whole
 * point of the plugin.
 *
 * @param entry - one merged record: tool, total wait, outcome, prompt count.
 * @returns the text to inject and its bounded notice summary.
 */
export function buildNotice({ toolName, waitedMs, outcome, prompts = 1 }) {
	const waited = formatDuration(waitedMs);
	const promptsText = prompts > 1 ? ` across ${prompts} approval prompts` : '';
	const tool = shortToolName(toolName);

	if (outcome === GRANT) {
		return {
			text:
				`Approval latency: "${tool}" waited ${waited}${promptsText} for the user to answer its approval prompt before it could run. ` +
				'That gap is human response time — not a tool failure, a timeout, or evidence that this call, its arguments, or your earlier findings were wrong. ' +
				'Judge this result on its own content, and do not reopen earlier work merely because time passed.',
			summary: boundSummary(`approval wait ${waited} before ${tool} ran`),
		};
	}
	if (outcome === 'rejected') {
		return {
			text:
				`Approval latency: the user answered the approval prompt for "${tool}" after ${waited}${promptsText} and rejected the call. ` +
				'A "no" this late can be a stale or accidental answer rather than a verdict on the call: if the rejection contradicts what the user asked for, ' +
				'ask them before reworking the approach, and do not conclude that the call itself was wrong.',
			summary: boundSummary(`approval wait ${waited}, then ${tool} rejected`),
		};
	}
	if (outcome === 'cancelled') {
		return {
			text:
				`Approval latency: the approval prompt for "${tool}" stayed open for ${waited}${promptsText} and ended without an answer, so the call never ran. ` +
				'That gap is human or scheduling latency — not evidence about the call or the code it touches.',
			summary: boundSummary(`approval wait ${waited}, then ${tool} cancelled`),
		};
	}
	return {
		text:
			`Approval latency: "${tool}" needed an approval that stayed outstanding for ${waited}${promptsText} and ended without an available answerer, so the call did not run. ` +
			'Treat the gap as a coordination problem, not as evidence that the call or the code it touches is wrong.',
		summary: boundSummary(`approval wait ${waited}, then no answerer for ${tool}`),
	};
}

/**
 * Whether one outcome is an answer this machine's baseline should learn from.
 *
 * Only granted and rejected prompts are answers; an abandoned prompt says
 * nothing about how fast this human replies.
 *
 * @param outcome - one approval outcome string.
 * @returns whether to sample the wait.
 */
export function isAnswerOutcome(outcome) {
	return outcome === GRANT || outcome === REJECTION;
}

/**
 * Decide whether one consumed record is worth a notice.
 *
 * A rejection is judged against the (lower) rejection bar because a late "no"
 * is the misunderstanding that costs the most; cancellations and unavailable
 * channels use the grant bar, since neither is a judgement about the call.
 *
 * @param settings - result of {@link normalizeConfig}.
 * @param entry - merged record, or `undefined` when nothing was tracked.
 * @param thresholds - result of {@link resolveThresholds} for this decision.
 * @returns whether to attach a notice.
 */
export function shouldReport(settings, entry, thresholds) {
	if (entry === undefined) return false;
	const outcome = entry.outcome;
	const rejected = outcome === REJECTION;
	const reportedOutcome = outcome === GRANT || rejected || UNANSWERED.has(outcome);
	if (!reportedOutcome) return false;
	if (!settings.reportDenials && (rejected || UNANSWERED.has(outcome))) return false;
	return entry.waitedMs >= (rejected ? thresholds.rejectionMs : thresholds.grantMs);
}

/**
 * Track approval waits per agent until the owning call reaches post-execute.
 *
 * Records are keyed by the model's tool-call id, so concurrent calls never
 * borrow each other's wait. An approval request that arrives without a call id
 * is still matched, but only when exactly one same-tool record is pending —
 * ambiguity is resolved by reporting nothing rather than by guessing.
 *
 * @param options - clock and retention bounds; tests inject a clock.
 * @returns a ledger with `begin`, `settle`, `take`, and `pending`.
 */
export function createLedger({
	now = () => performance.now(),
	maxRecords = DEFAULT_MAX_RECORDS,
	maxAgeMs = DEFAULT_MAX_AGE_MS,
} = {}) {
	const perAgent = new WeakMap();

	const bucketFor = (agent) => {
		let bucket = perAgent.get(agent);
		if (bucket === undefined) {
			bucket = [];
			perAgent.set(agent, bucket);
		}
		return bucket;
	};

	const prune = (bucket) => {
		const cutoff = now() - maxAgeMs;
		while (bucket.length > 0 && (bucket[0].endedAt ?? bucket[0].startedAt) < cutoff) bucket.shift();
		while (bucket.length > maxRecords) bucket.shift();
	};

	return {
		/**
		 * Start timing one approval request.
		 * @param request - the `approval/request` payload.
		 * @returns the open record, or `undefined` when it carries no agent.
		 */
		begin(request) {
			const agent = request?.agent;
			if (agent === undefined || agent === null) return undefined;
			const entry = {
				callId: typeof request.callId === 'string' ? request.callId : undefined,
				toolName: typeof request.toolName === 'string' ? request.toolName : 'this tool',
				startedAt: now(),
				endedAt: undefined,
				outcome: undefined,
			};
			const bucket = bucketFor(agent);
			bucket.push(entry);
			prune(bucket);
			return entry;
		},

		/**
		 * Close one record with the outcome the answerer produced.
		 * @param entry - the record from {@link begin}.
		 * @param outcome - one approval outcome string.
		 * @returns the same record, or the input when already closed.
		 */
		settle(entry, outcome) {
			if (entry === undefined || entry.endedAt !== undefined) return entry;
			entry.endedAt = now();
			entry.outcome = outcome;
			return entry;
		},

		/**
		 * Claim every closed record belonging to one finishing call.
		 * @param agent - the execution's agent.
		 * @param callId - the model tool-call id, when the execution has one.
		 * @param toolName - fallback attribution key.
		 * @returns the merged record, or `undefined` when this call waited for nothing.
		 */
		take(agent, callId, toolName) {
			if (agent === undefined || agent === null) return undefined;
			const bucket = perAgent.get(agent);
			if (bucket === undefined) return undefined;
			prune(bucket);
			const closed = bucket.filter((entry) => entry.endedAt !== undefined);
			let matches = typeof callId === 'string' ? closed.filter((entry) => entry.callId === callId) : [];
			if (matches.length === 0) {
				const sameTool = closed.filter((entry) => entry.callId === undefined && entry.toolName === toolName);
				if (sameTool.length === 1) matches = sameTool;
			}
			if (matches.length === 0) return undefined;
			for (const match of matches) bucket.splice(bucket.indexOf(match), 1);
			const waitedMs = matches.reduce((total, entry) => total + (entry.endedAt - entry.startedAt), 0);
			const last = matches[matches.length - 1];
			return Object.freeze({
				toolName: last.toolName,
				outcome: last.outcome,
				waitedMs,
				prompts: matches.length,
			});
		},

		/**
		 * Number of records still held for one agent (diagnostics and tests).
		 * @param agent - the agent whose bucket is counted.
		 * @returns how many records are pending consumption.
		 */
		pending(agent) {
			return perAgent.get(agent)?.length ?? 0;
		},
	};
}
