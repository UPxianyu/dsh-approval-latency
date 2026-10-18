import assert from 'node:assert/strict';
import test from 'node:test';

import {
	COLD_START_MS,
	DEFAULT_CEILING_MS,
	DEFAULT_FIXED_MS,
	DEFAULT_FLOOR_MS,
	DEFAULT_MIN_SAMPLES,
	DEFAULT_MULTIPLIER,
	DEFAULT_REJECTION_SCALE,
	buildNotice,
	configSchema,
	createLedger,
	createSampler,
	formatDuration,
	normalizeConfig,
	resolveThresholds,
	shouldReport,
} from '../lib/latency.js';

/**
 * Load schemastery the way a DSH host process would.
 *
 * Inside a DSH installation the Host resolves `@deepseek-ai/schemastery` for
 * profile plugins; in a bare checkout it does not, so those assertions are
 * skipped unless `SCHEMASTERY_PATH` names a module to import instead.
 */
async function loadSchemastery() {
	const candidates = ['@deepseek-ai/schemastery', process.env.SCHEMASTERY_PATH].filter(
		(candidate) => typeof candidate === 'string' && candidate.length > 0,
	);
	for (const candidate of candidates) {
		try {
			const module = await import(candidate);
			return module.default ?? module;
		} catch {
			/* try the next candidate */
		}
	}
	return undefined;
}

const z = await loadSchemastery();

test('normalizeConfig defaults to adaptive mode with a 30 s fixed fallback', () => {
	assert.deepEqual(normalizeConfig(undefined), {
		mode: 'auto',
		fixedMs: DEFAULT_FIXED_MS,
		floorMs: DEFAULT_FLOOR_MS,
		ceilingMs: DEFAULT_CEILING_MS,
		multiplier: DEFAULT_MULTIPLIER,
		minSamples: DEFAULT_MIN_SAMPLES,
		rejectionScale: DEFAULT_REJECTION_SCALE,
		reportDenials: true,
	});
	assert.equal(normalizeConfig({}).mode, 'auto');
	assert.ok(Object.isFrozen(normalizeConfig({})));
});

test('normalizeConfig accepts a fixed mode and every knob', () => {
	const settings = normalizeConfig({
		mode: 'fixed',
		fixedMs: 45_000,
		floorMs: 5_000,
		ceilingMs: 600_000,
		multiplier: 2,
		minSamples: 5,
		rejectionScale: 1,
		reportDenials: false,
	});
	assert.equal(settings.mode, 'fixed');
	assert.equal(settings.fixedMs, 45_000);
	assert.equal(settings.floorMs, 5_000);
	assert.equal(settings.ceilingMs, 600_000);
	assert.equal(settings.multiplier, 2);
	assert.equal(settings.minSamples, 5);
	assert.equal(settings.rejectionScale, 1);
	assert.equal(settings.reportDenials, false);
});

test('a supplied duration implies fixed mode; an explicit mode always wins', () => {
	assert.equal(normalizeConfig({ fixedMs: 45_000 }).mode, 'fixed', 'writing only a duration means fixed');
	assert.equal(normalizeConfig({ fixedMs: 45_000 }).fixedMs, 45_000);
	assert.equal(normalizeConfig({ thresholdMs: 45_000 }).mode, 'fixed', 'legacy alias behaves the same');
	assert.equal(normalizeConfig({ thresholdMs: 45_000 }).fixedMs, 45_000);
	assert.equal(normalizeConfig({ thresholdMs: null }).mode, 'auto', 'legacy null means adaptive');

	const explicitAuto = normalizeConfig({ mode: 'auto', fixedMs: 45_000 });
	assert.equal(explicitAuto.mode, 'auto', 'explicit mode wins over the implied one');
	assert.equal(explicitAuto.fixedMs, 45_000, 'the duration is kept, just unused');
	assert.equal(normalizeConfig({ mode: 'fixed' }).fixedMs, DEFAULT_FIXED_MS, 'fixed mode defaults to 30 s');
});

test('normalizeConfig rejects values it cannot honour', () => {
	assert.throws(() => normalizeConfig('nope'), TypeError);
	assert.throws(() => normalizeConfig([]), TypeError);
	assert.throws(() => normalizeConfig({ mode: 'adaptive' }), /mode/);
	assert.throws(() => normalizeConfig({ mode: 1 }), /mode/);
	assert.throws(() => normalizeConfig({ thresholdMs: -1 }), TypeError);
	assert.throws(() => normalizeConfig({ thresholdMs: Number.NaN }), TypeError);
	assert.throws(() => normalizeConfig({ thresholdMs: '30s' }), TypeError);
	assert.throws(() => normalizeConfig({ fixedMs: -1 }), /fixedMs/);
	assert.throws(() => normalizeConfig({ fixedMs: '30s' }), /fixedMs/);
	assert.throws(() => normalizeConfig({ floorMs: -1 }), TypeError);
	assert.throws(() => normalizeConfig({ floorMs: 60_000, ceilingMs: 30_000 }), TypeError);
	assert.throws(() => normalizeConfig({ multiplier: 0.5 }), TypeError);
	assert.throws(() => normalizeConfig({ minSamples: 0 }), TypeError);
	assert.throws(() => normalizeConfig({ minSamples: 2.5 }), TypeError);
	assert.throws(() => normalizeConfig({ rejectionScale: 0 }), TypeError);
	assert.throws(() => normalizeConfig({ rejectionScale: 1.5 }), TypeError);
	assert.throws(() => normalizeConfig({ reportDenials: 'yes' }), TypeError);
});

test('formatDuration stays readable at every scale', () => {
	assert.equal(formatDuration(850), '850ms');
	assert.equal(formatDuration(0), '0ms');
	assert.equal(formatDuration(42_000), '42s');
	assert.equal(formatDuration(60_000), '1m');
	assert.equal(formatDuration(366_000), '6m 6s');
	assert.equal(formatDuration(3_600_000), '1h');
	assert.equal(formatDuration(3_930_000), '1h 5m');
	assert.equal(formatDuration(187_200_000), '2d 4h');
	assert.throws(() => formatDuration(-1), TypeError);
});

test('buildNotice explains a grant without blaming the call', () => {
	const notice = buildNotice({ toolName: 'bash', waitedMs: 402_000, outcome: 'allowed-once' });
	assert.match(notice.text, /^Approval wait: "bash" ran 6m 42s/);
	assert.match(notice.text, /human latency/);
	assert.match(notice.text, /Judge only this result/);
	assert.equal(notice.summary, 'approval wait 6m 42s before bash ran');
});

test('buildNotice names every prompt when one call asked twice', () => {
	const notice = buildNotice({ toolName: 'bash', waitedMs: 90_000, outcome: 'allowed-once', prompts: 2 });
	assert.match(notice.text, /ran 1m 30s after the user approved it \(2 prompts\)/);
});

test('buildNotice treats a late rejection as possibly stale, not as a verdict', () => {
	const notice = buildNotice({ toolName: 'write', waitedMs: 250_000, outcome: 'rejected' });
	assert.match(notice.text, /rejected "write" after 4m 10s/);
	assert.match(notice.text, /may be stale/);
	assert.match(notice.text, /check it against what was asked/);
});

test('buildNotice separates a cancelled prompt from a decision', () => {
	const cancelled = buildNotice({ toolName: 'pwsh', waitedMs: 60_000, outcome: 'cancelled' });
	assert.match(cancelled.text, /never ran/);
	assert.match(cancelled.text, /not evidence about the code/);

	const unavailable = buildNotice({ toolName: 'pwsh', waitedMs: 60_000, outcome: 'unavailable' });
	assert.match(unavailable.text, /coordination gap/);
});

test('buildNotice bounds a very long tool name and summary', () => {
	const longName = `mcp__comfyui__${'x'.repeat(80)}`;
	const notice = buildNotice({ toolName: longName, waitedMs: 60_000, outcome: 'allowed-once' });
	assert.ok(notice.text.includes('…'), 'tool name is elided');
	assert.ok(notice.summary.length <= 120, `summary bounded, got ${notice.summary.length}`);
});

test('sampler reports the median of a moving window', () => {
	const sampler = createSampler({ window: 4, ceilingMs: 1_000_000 });
	assert.equal(sampler.size(), 0);
	assert.equal(sampler.median(), undefined);

	sampler.record(3_000);
	assert.equal(sampler.median(), 3_000);
	sampler.record(9_000);
	assert.equal(sampler.median(), 6_000, 'even count averages the middle two');
	sampler.record(4_000);
	assert.equal(sampler.median(), 4_000);
	assert.equal(sampler.size(), 3);

	sampler.record(1_000);
	sampler.record(2_000);
	assert.equal(sampler.size(), 4, 'window caps the sample count');
	assert.equal(sampler.median(), 3_000);
	sampler.reset();
	assert.equal(sampler.size(), 0);
});

test('sampler clamps samples and ignores junk', () => {
	const sampler = createSampler({ window: 10, ceilingMs: 60_000 });
	sampler.record(3_600_000);
	assert.equal(sampler.median(), 60_000, 'a three-hour absence cannot drag the baseline');
	sampler.record(-5);
	sampler.record(Number.NaN);
	sampler.record('nope');
	assert.equal(sampler.size(), 1);
});

test('resolveThresholds pins an explicit bar and derives the rejection bar', () => {
	const settings = normalizeConfig({ mode: 'fixed', fixedMs: 30_000 });
	const bars = resolveThresholds(settings, createSampler());
	assert.equal(bars.mode, 'fixed');
	assert.equal(bars.grantMs, 30_000);
	assert.equal(bars.rejectionMs, 15_000);
	assert.equal(bars.baselineMs, undefined);

	const sameBar = resolveThresholds(normalizeConfig({ mode: 'fixed', fixedMs: 30_000, rejectionScale: 1 }), createSampler());
	assert.equal(sameBar.rejectionMs, 30_000);
});

test('resolveThresholds honours a pinned bar below the floor', () => {
	const bars = resolveThresholds(normalizeConfig({ mode: 'fixed', fixedMs: 4_000, floorMs: 10_000 }), createSampler());
	assert.equal(bars.grantMs, 4_000);
	assert.equal(bars.rejectionMs, 4_000, 'the floor never lowers an explicit grant bar');
});

test('resolveThresholds uses the cold-start bar until enough answers exist', () => {
	const settings = normalizeConfig({ minSamples: 3 });
	const sampler = createSampler({ ceilingMs: settings.ceilingMs });
	sampler.record(1_000);
	sampler.record(1_000);

	const cold = resolveThresholds(settings, sampler);
	assert.equal(cold.mode, 'cold');
	assert.equal(cold.grantMs, COLD_START_MS);
	assert.equal(cold.rejectionMs, COLD_START_MS / 2);

	sampler.record(1_000);
	const learned = resolveThresholds(settings, sampler);
	assert.equal(learned.mode, 'learned');
	assert.equal(learned.baselineMs, 1_000);
	assert.equal(learned.grantMs, DEFAULT_FLOOR_MS, 'multiplier x median is raised by the floor');
});

test('resolveThresholds learns, then stays inside floor and ceiling', () => {
	const settings = normalizeConfig({ multiplier: 3 });

	const fast = createSampler({ ceilingMs: settings.ceilingMs });
	fast.record(3_000);
	fast.record(4_000);
	fast.record(5_000);
	const sensitive = resolveThresholds(settings, fast);
	assert.equal(sensitive.baselineMs, 4_000);
	assert.equal(sensitive.grantMs, 12_000);
	assert.equal(sensitive.rejectionMs, DEFAULT_FLOOR_MS, 'half of 12s is raised to the floor');

	const slow = createSampler({ ceilingMs: settings.ceilingMs });
	slow.record(90_000);
	slow.record(120_000);
	slow.record(200_000);
	const tolerant = resolveThresholds(settings, slow);
	assert.equal(tolerant.baselineMs, 120_000);
	assert.equal(tolerant.grantMs, 300_000, 'ceiling caps a drifting baseline');
	assert.equal(tolerant.rejectionMs, 150_000);

	const tight = resolveThresholds(normalizeConfig({ floorMs: 20_000, ceilingMs: 40_000, minSamples: 1 }), slow);
	assert.equal(tight.grantMs, 40_000, 'cold start is confined to the configured range');
});

test('shouldReport compares against the bar that matches the outcome', () => {
	const settings = normalizeConfig({ mode: 'fixed', fixedMs: 30_000 });
	const bars = resolveThresholds(settings, createSampler());

	assert.equal(shouldReport(settings, undefined, bars), false);
	assert.equal(shouldReport(settings, { outcome: 'allowed-once', waitedMs: 29_999 }, bars), false);
	assert.equal(shouldReport(settings, { outcome: 'allowed-once', waitedMs: 30_000 }, bars), true);
	assert.equal(shouldReport(settings, { outcome: 'rejected', waitedMs: 15_000 }, bars), true, 'rejection uses the lower bar');
	assert.equal(shouldReport(settings, { outcome: 'rejected', waitedMs: 14_999 }, bars), false);
	assert.equal(shouldReport(settings, { outcome: 'cancelled', waitedMs: 29_999 }, bars), false);
	assert.equal(shouldReport(settings, { outcome: 'cancelled', waitedMs: 30_000 }, bars), true);
	assert.equal(shouldReport(settings, { outcome: 'error', waitedMs: 60_000 }, bars), false);

	const quiet = normalizeConfig({ mode: 'fixed', fixedMs: 0, reportDenials: false });
	const quietBars = resolveThresholds(quiet, createSampler());
	assert.equal(shouldReport(quiet, { outcome: 'allowed-once', waitedMs: 0 }, quietBars), true);
	assert.equal(shouldReport(quiet, { outcome: 'rejected', waitedMs: 60_000 }, quietBars), false);
	assert.equal(shouldReport(quiet, { outcome: 'unavailable', waitedMs: 60_000 }, quietBars), false);
});

/** Build a ledger on a clock the test moves by hand. */
function clockedLedger(options = {}) {
	let current = 0;
	const ledger = createLedger({ now: () => current, ...options });
	return {
		ledger,
		advance: (ms) => {
			current += ms;
		},
	};
}

test('ledger pairs one approval with the call id that asked for it', () => {
	const { ledger, advance } = clockedLedger();
	const agent = {};
	const entry = ledger.begin({ agent, callId: 'call-1', toolName: 'bash' });
	advance(4_000);
	ledger.settle(entry, 'allowed-once');

	assert.equal(ledger.pending(agent), 1);
	const taken = ledger.take(agent, 'call-1', 'bash');
	assert.equal(taken.outcome, 'allowed-once');
	assert.equal(taken.waitedMs, 4_000);
	assert.equal(taken.prompts, 1);
	assert.equal(taken.toolName, 'bash');
	assert.equal(ledger.pending(agent), 0);
	assert.equal(ledger.take(agent, 'call-1', 'bash'), undefined, 'a record is consumed once');
});

test('ledger keeps concurrent calls apart', () => {
	const { ledger, advance } = clockedLedger();
	const agent = {};
	const first = ledger.begin({ agent, callId: 'call-a', toolName: 'bash' });
	advance(1_000);
	const second = ledger.begin({ agent, callId: 'call-b', toolName: 'write' });
	advance(2_000);
	ledger.settle(first, 'allowed-once');
	ledger.settle(second, 'allowed-once');

	assert.equal(ledger.take(agent, 'call-b', 'write').waitedMs, 2_000);
	assert.equal(ledger.take(agent, 'call-a', 'bash').waitedMs, 3_000);
});

test('ledger merges repeated approvals of one call', () => {
	const { ledger, advance } = clockedLedger();
	const agent = {};
	const first = ledger.begin({ agent, callId: 'call-1', toolName: 'pwsh' });
	advance(1_000);
	ledger.settle(first, 'allowed-once');
	const second = ledger.begin({ agent, callId: 'call-1', toolName: 'pwsh' });
	advance(500);
	ledger.settle(second, 'allowed-once');

	const taken = ledger.take(agent, 'call-1', 'pwsh');
	assert.equal(taken.prompts, 2);
	assert.equal(taken.waitedMs, 1_500);
});

test('ledger attributes a call-id-less approval only when unambiguous', () => {
	const { ledger, advance } = clockedLedger();
	const agent = {};
	const unique = ledger.begin({ agent, toolName: 'bash' });
	advance(2_000);
	ledger.settle(unique, 'allowed-once');
	assert.equal(ledger.take(agent, 'call-1', 'bash').waitedMs, 2_000);

	const first = ledger.begin({ agent, toolName: 'bash' });
	const second = ledger.begin({ agent, toolName: 'bash' });
	advance(1_000);
	ledger.settle(first, 'allowed-once');
	ledger.settle(second, 'allowed-once');
	assert.equal(ledger.take(agent, 'call-2', 'bash'), undefined, 'ambiguous records are never guessed');
	assert.equal(ledger.pending(agent), 2);
});

test('ledger ignores open records and foreign agents', () => {
	const { ledger, advance } = clockedLedger();
	const agent = {};
	const other = {};
	ledger.begin({ agent, callId: 'call-1', toolName: 'bash' });
	advance(5_000);

	assert.equal(ledger.take(agent, 'call-1', 'bash'), undefined, 'an unanswered prompt is not a wait to report');
	assert.equal(ledger.take(other, 'call-1', 'bash'), undefined);
	assert.equal(ledger.begin({ toolName: 'bash' }), undefined, 'a request without an agent is not tracked');
	assert.equal(ledger.take(undefined, 'call-1', 'bash'), undefined);
});

test('ledger forgets records no call ever claimed', () => {
	const { ledger, advance } = clockedLedger({ maxAgeMs: 10_000, maxRecords: 3 });
	const agent = {};
	const stale = ledger.begin({ agent, callId: 'old', toolName: 'bash' });
	ledger.settle(stale, 'allowed-once');
	advance(20_000);

	for (const callId of ['a', 'b', 'c', 'd']) {
		const entry = ledger.begin({ agent, callId, toolName: 'bash' });
		ledger.settle(entry, 'allowed-once');
	}
	assert.equal(ledger.pending(agent), 3, 'retention cap applies');
	assert.equal(ledger.take(agent, 'old', 'bash'), undefined, 'aged record was pruned');
	assert.equal(ledger.take(agent, 'a', 'bash'), undefined, 'oldest record was evicted');
});




if (z === undefined) {
	test('configSchema declares the live row fields', { skip: 'no @deepseek-ai/schemastery (set SCHEMASTERY_PATH)' }, () => {});
} else {
	test('configSchema declares every field live and applies the documented defaults', () => {
		const Config = configSchema(z);
		const resolved = Config({});
		assert.equal(resolved.mode.get(), 'auto');
		assert.equal(resolved.fixedMs.get(), DEFAULT_FIXED_MS);
		assert.equal(resolved.floorMs.get(), DEFAULT_FLOOR_MS);
		assert.equal(resolved.ceilingMs.get(), DEFAULT_CEILING_MS);
		assert.equal(resolved.multiplier.get(), DEFAULT_MULTIPLIER);
		assert.equal(resolved.minSamples.get(), DEFAULT_MIN_SAMPLES);
		assert.equal(resolved.rejectionScale.get(), DEFAULT_REJECTION_SCALE);
		assert.equal(resolved.reportDenials.get(), true);

		const explicit = Config({ mode: 'fixed', fixedMs: 45_000, reportDenials: false });
		assert.equal(explicit.mode.get(), 'fixed');
		assert.equal(explicit.fixedMs.get(), 45_000);
		assert.equal(explicit.reportDenials.get(), false);

		assert.throws(() => Config({ mode: 'adaptive' }), /mode/);
		assert.throws(() => Config({ fixedMs: -1 }), /fixedMs/);
		assert.throws(() => Config({ minSamples: 2.5 }), /minSamples/);
		assert.throws(() => Config({ rejectionScale: 2 }), /rejectionScale/);
		assert.throws(() => Config({ reportDenials: 'yes' }), /reportDenials/);
	});

	test('every declared field is volatile, so the settings page can edit it', () => {
		const Config = configSchema(z);
		for (const field of ['mode', 'fixedMs', 'floorMs', 'ceilingMs', 'multiplier', 'minSamples', 'rejectionScale', 'reportDenials']) {
			assert.equal(Config.dict[field].meta.volatile, true, `${field} must be volatile`);
		}
		// The deprecated alias stays a YAML-only escape hatch; no form shows it.
		assert.equal('thresholdMs' in Config.dict, false);
	});
}


test('every notice stays short enough to read as a flag, not a conversation', () => {
	const limits = { 'allowed-once': 200, rejected: 200, cancelled: 170, unavailable: 170 };
	for (const [outcome, limit] of Object.entries(limits)) {
		const notice = buildNotice({ toolName: 'pwsh', waitedMs: 402_000, outcome });
		assert.ok(
			notice.text.length <= limit,
			`${outcome} notice is ${notice.text.length} chars, over the ${limit} budget: ${notice.text}`,
		);
		assert.ok(notice.text.startsWith('Approval wait: '), `${outcome} notice must open with the tag`);
		assert.ok(notice.text.split('.').length <= 4, `${outcome} notice must stay at 3 sentences or fewer`);
	}
});
