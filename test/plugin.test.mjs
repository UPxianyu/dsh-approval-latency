import assert from 'node:assert/strict';
import test from 'node:test';

import { mountApprovalLatency } from '../lib/plugin.js';

/**
 * Mount the plugin on a fake Cordis context.
 *
 * Listener order mirrors the real bus: `prepend` lands at the front of the
 * chain, everything else is appended.
 */
function mount(config) {
	const handlers = { 'approval/request': [], 'tools/post-execute': [] };
	const warnings = [];
	const ctx = {
		logger: { warn: (text) => warnings.push(text) },
		on(name, listener, options) {
			assert.ok(name in handlers, `plugin listened to unexpected event ${name}`);
			if (options?.prepend === true) handlers[name].unshift(listener);
			else handlers[name].push(listener);
			return () => {};
		},
	};
	mountApprovalLatency(ctx, config);
	return { handlers, warnings };
}

/** Run one chain the way `ctx.waterfall` does: each listener is handed `next`. */
async function runChain(chain, args, innermost) {
	let index = 0;
	const next = () => {
		const listener = chain[index];
		index += 1;
		return listener === undefined ? innermost() : listener(...args, next);
	};
	return next();
}

/** Answer one approval request through the mounted chain. */
function answerApproval(handlers, request, answer) {
	return runChain(handlers['approval/request'], [request], answer);
}

/** Deliver one tool result through the mounted chain. */
function postExecute(handlers, exec, result, decision) {
	return runChain(handlers['tools/post-execute'], [exec, result], async () => decision);
}

const bashCall = { callId: 'call-1', name: 'bash', agent: { id: 'agent-1' } };

test('a long approval wait reaches the model as one appended notice', async () => {
	const { handlers } = mount({ mode: 'fixed', fixedMs: 0 });
	await answerApproval(handlers, { agent: bashCall.agent, callId: 'call-1', toolName: 'bash' }, async () => 'allowed-once');

	const content = [{ type: 'text', text: 'command output' }];
	const decision = await postExecute(handlers, bashCall, { isError: false, content }, { kind: 'accept', content });

	assert.equal(decision.kind, 'accept');
	assert.equal(decision.content, content, 'the tool result itself is never rewritten');
	assert.equal(decision.additionalContexts.length, 1);

	const [notice] = decision.additionalContexts;
	assert.equal(notice.role, 'user');
	assert.equal(typeof notice.id, 'string');
	assert.ok(notice.id.length > 0);
	assert.deepEqual(notice.source, {
		kind: 'approval-latency',
		form: 'notice',
		summary: notice.source.summary,
	});
	assert.equal(notice.content.length, 1);
	assert.equal(notice.content[0].type, 'text');
	assert.match(notice.content[0].text, /^Approval latency: "bash"/);
	assert.match(notice.content[0].text, /human response time/);
	assert.ok(notice.source.summary.length <= 120);
});

test('a wait under the threshold stays silent', async () => {
	const { handlers } = mount({ mode: 'fixed', fixedMs: 3_600_000 });
	await answerApproval(handlers, { agent: bashCall.agent, callId: 'call-1', toolName: 'bash' }, async () => 'allowed-once');

	const decision = await postExecute(handlers, bashCall, { isError: false, content: [] }, { kind: 'accept', content: [] });
	assert.equal(decision.additionalContexts, undefined);
});

test('a call that never asked for approval stays silent', async () => {
	const { handlers } = mount({ mode: 'fixed', fixedMs: 0 });
	const decision = await postExecute(handlers, bashCall, { isError: false, content: [] }, { kind: 'accept', content: [] });
	assert.equal(decision.additionalContexts, undefined);
});

test('a late rejection is reported as a possibly stale answer', async () => {
	const { handlers } = mount({ mode: 'fixed', fixedMs: 0 });
	await answerApproval(handlers, { agent: bashCall.agent, callId: 'call-1', toolName: 'bash' }, async () => 'rejected');

	const decision = await postExecute(
		handlers,
		bashCall,
		{ isError: true, content: [{ type: 'text', text: 'Error: the user rejected tool "bash"' }] },
		{ kind: 'accept', content: [{ type: 'text', text: 'Error: the user rejected tool "bash"' }] },
	);
	assert.equal(decision.additionalContexts.length, 1);
	assert.match(decision.additionalContexts[0].content[0].text, /stale or accidental answer/);
});

test('reportDenials: false keeps grants and drops denials', async () => {
	const { handlers } = mount({ mode: 'fixed', fixedMs: 0, reportDenials: false });
	await answerApproval(handlers, { agent: bashCall.agent, callId: 'call-1', toolName: 'bash' }, async () => 'cancelled');

	const decision = await postExecute(handlers, bashCall, { isError: true, content: [] }, { kind: 'accept', content: [] });
	assert.equal(decision.additionalContexts, undefined);

	await answerApproval(handlers, { agent: bashCall.agent, callId: 'call-2', toolName: 'bash' }, async () => 'allowed-once');
	const granted = await postExecute(
		handlers,
		{ ...bashCall, callId: 'call-2' },
		{ isError: false, content: [] },
		{ kind: 'accept', content: [] },
	);
	assert.equal(granted.additionalContexts.length, 1);
});

test('a blocked call keeps its feedback and gains the notice', async () => {
	const { handlers } = mount({ mode: 'fixed', fixedMs: 0 });
	await answerApproval(handlers, { agent: bashCall.agent, callId: 'call-1', toolName: 'bash' }, async () => 'allowed-once');

	const feedback = [{ type: 'text', text: 'blocked by policy' }];
	const decision = await postExecute(handlers, bashCall, { isError: false, content: [] }, { kind: 'block', feedback });

	assert.equal(decision.kind, 'block');
	assert.equal(decision.feedback, feedback);
	assert.equal(decision.additionalContexts.length, 1);
});

test('concurrent calls keep their own notices', async () => {
	const { handlers } = mount({ mode: 'fixed', fixedMs: 0 });
	const agent = {};
	const first = { callId: 'call-a', name: 'bash', agent };
	const second = { callId: 'call-b', name: 'write', agent };
	await answerApproval(handlers, { agent, callId: 'call-a', toolName: 'bash' }, async () => 'allowed-once');
	await answerApproval(handlers, { agent, callId: 'call-b', toolName: 'write' }, async () => 'allowed-once');

	const later = await postExecute(handlers, second, { isError: false, content: [] }, { kind: 'accept', content: [] });
	const earlier = await postExecute(handlers, first, { isError: false, content: [] }, { kind: 'accept', content: [] });

	assert.match(later.additionalContexts[0].content[0].text, /"write"/);
	assert.match(earlier.additionalContexts[0].content[0].text, /"bash"/);
});

test('an answerer failure records nothing and never breaks the chain', async () => {
	const { handlers } = mount({ mode: 'fixed', fixedMs: 0 });
	await assert.rejects(
		answerApproval(handlers, { agent: bashCall.agent, callId: 'call-1', toolName: 'bash' }, async () => {
			throw new Error('bridge down');
		}),
		/bridge down/,
	);
	const decision = await postExecute(handlers, bashCall, { isError: false, content: [] }, { kind: 'accept', content: [] });
	assert.equal(decision.additionalContexts, undefined);
});

test('the approval wrapper always delegates and returns the real outcome', async () => {
	const { handlers } = mount({ mode: 'fixed', fixedMs: 0 });
	let delegated = 0;
	const outcome = await answerApproval(
		handlers,
		{ agent: bashCall.agent, callId: 'call-1', toolName: 'bash' },
		async () => {
			delegated += 1;
			return 'allowed-once';
		},
	);
	assert.equal(delegated, 1);
	assert.equal(outcome, 'allowed-once');
});

test('a bad config value warns once per decision and never crashes the pipeline', async () => {
	// Bad values are rejected by the Loader row's schema; this is defence in depth
	// for a value that arrives from anywhere else (a stale patch, a hand edit).
	const { handlers, warnings } = mount({ mode: 'adaptive', floorMs: 60_000, ceilingMs: 30_000 });
	const agent = {};

	assert.equal(await roundtrip(handlers, agent, 'bad-config-1'), 0, 'defaults apply: 30 s cold start');
	assert.ok(
		warnings.some((line) => line.includes('settings ignored')),
		`expected a warn line, got ${JSON.stringify(warnings)}`,
	);
});

test('the bar is learned: cold start stays quiet, then this machine teaches it', async () => {
	const { handlers } = mount({
		mode: 'auto', // learned
		floorMs: 0,
		ceilingMs: 60_000,
		multiplier: 2,
		minSamples: 3,
	});
	const agent = {};

	/** One approval plus the post-execute that consumes it. */
	async function roundtrip(callId) {
		await answerApproval(handlers, { agent, callId, toolName: 'bash' }, async () => 'allowed-once');
		const decision = await postExecute(
			handlers,
			{ callId, name: 'bash', agent },
			{ isError: false, content: [] },
			{ kind: 'accept', content: [] },
		);
		return decision.additionalContexts?.length ?? 0;
	}

	// Cold start: the 30 s bar holds, even though every answer here is instant.
	assert.equal(await roundtrip('c1'), 0);
	assert.equal(await roundtrip('c2'), 0);
	assert.equal(await roundtrip('c3'), 0);
	// Three answered prompts are enough: the median is ~0, so a wait of ~0 is
	// now "unusually long for this machine" and gets reported.
	assert.equal(await roundtrip('c4'), 1);
});

test('a pinned threshold ignores everything the plugin has learned', async () => {
	const { handlers } = mount({ mode: 'fixed', fixedMs: 3_600_000 });
	const agent = {};
	for (let index = 0; index < 5; index += 1) {
		const callId = `pin-${index}`;
		await answerApproval(handlers, { agent, callId, toolName: 'bash' }, async () => 'allowed-once');
		const decision = await postExecute(
			handlers,
			{ callId, name: 'bash', agent },
			{ isError: false, content: [] },
			{ kind: 'accept', content: [] },
		);
		assert.equal(decision.additionalContexts, undefined);
	}
});

test('a legacy thresholdMs row still behaves as mode: fixed', async () => {
	const { handlers } = mount({ thresholdMs: 0 });
	await answerApproval(handlers, { agent: bashCall.agent, callId: 'legacy-1', toolName: 'bash' }, async () => 'allowed-once');
	const decision = await postExecute(
		handlers,
		{ ...bashCall, callId: 'legacy-1' },
		{ isError: false, content: [] },
		{ kind: 'accept', content: [] },
	);
	assert.equal(decision.additionalContexts.length, 1);
});

test('mode: fixed with no duration falls back to the 30 s default', async () => {
	const { handlers } = mount({ mode: 'fixed' });
	await answerApproval(handlers, { agent: bashCall.agent, callId: 'default-1', toolName: 'bash' }, async () => 'allowed-once');
	const decision = await postExecute(
		handlers,
		{ ...bashCall, callId: 'default-1' },
		{ isError: false, content: [] },
		{ kind: 'accept', content: [] },
	);
	assert.equal(decision.additionalContexts, undefined, 'an instant answer is far below 30 s');
});

/** A config shaped like the Host's: every field is a live `.get()` ref. */
function volatileConfig(initial) {
	const values = { ...initial };
	const config = {};
	for (const key of Object.keys(values)) config[key] = { get: () => values[key] };
	return {
		config,
		set(key, value) {
			values[key] = value;
		},
	};
}

/** One approval plus the post-execute that consumes it; returns the notice count. */
async function roundtrip(handlers, agent, callId) {
	await answerApproval(handlers, { agent, callId, toolName: 'bash' }, async () => 'allowed-once');
	const decision = await postExecute(
		handlers,
		{ callId, name: 'bash', agent },
		{ isError: false, content: [] },
		{ kind: 'accept', content: [] },
	);
	return decision.additionalContexts?.length ?? 0;
}

test('a settings-page change reaches the next approval without a remount', async () => {
	const live = volatileConfig({ mode: 'fixed', fixedMs: 3_600_000 });
	const { handlers } = mount(live.config);
	const agent = {};

	assert.equal(await roundtrip(handlers, agent, 'live-1'), 0, 'one hour is still above an instant wait');

	// What the settings page does: write the row's volatile field.
	live.set('fixedMs', 0);
	assert.equal(await roundtrip(handlers, agent, 'live-2'), 1, 'the live value is honoured on the next call');

	// And switching back to adaptive hides nothing about the fixed value.
	live.set('mode', 'auto');
	assert.equal(await roundtrip(handlers, agent, 'live-3'), 0, 'cold-start adaptive bar is 30 s again');
});

test('an unreadable live value keeps the last good settings and warns', async () => {
	const live = volatileConfig({ mode: 'fixed', fixedMs: 0 });
	const { handlers, warnings } = mount(live.config);
	const agent = {};

	assert.equal(await roundtrip(handlers, agent, 'bad-1'), 1);

	// The Host validates writes, so this is defence: a broken value must not
	// break the tool pipeline and must not silently change the bar.
	live.set('fixedMs', -1);
	assert.equal(await roundtrip(handlers, agent, 'bad-2'), 1, 'the previous bar still applies');
	assert.ok(
		warnings.some((line) => line.includes('settings ignored')),
		`expected a warn line, got ${JSON.stringify(warnings)}`,
	);
});


