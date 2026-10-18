import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * Browser-half tests.
 *
 * `client.js` is a `window.__ModuleLoader__` bundle that draws the settings page
 * with React. These tests evaluate it against a fake loader, a fake client
 * context and a tiny function-component renderer, so the controls, the writes
 * they queue and the slot registration are all exercised in a plain Node
 * process — no browser, no React install.
 */

/** Minimal React: element objects and hooks backed by the render's slot array. */
function createFakeReact() {
	const createSlots = () => ({ cursor: 0, values: [], effects: [], subscriptions: [] });
	/** Take the next hook slot of the render currently in progress. */
	const takeSlot = () => {
		const slots = api.__slots;
		if (slots === undefined) throw new Error('hook called outside a render');
		const index = slots.cursor;
		slots.cursor += 1;
		return { slots, index };
	};
	const api = {
		createSlots,
		__slots: undefined,
		createElement(type, props, ...children) {
			return { type, props: { ...(props ?? {}), ...(children.length === 0 ? {} : { children }) } };
		},
		useState(initial) {
			const { slots, index } = takeSlot();
			if (!(index in slots.values)) slots.values[index] = initial;
			return [
				slots.values[index],
				(next) => {
					const value = typeof next === 'function' ? next(slots.values[index]) : next;
					if (!Object.is(value, slots.values[index])) slots.values[index] = value;
				},
			];
		},
		useReducer(reducer, initial) {
			const { slots, index } = takeSlot();
			if (!(index in slots.values)) slots.values[index] = initial;
			return [
				slots.values[index],
				(action) => {
					slots.values[index] = reducer(slots.values[index], action);
				},
			];
		},
		useCallback(fn) {
			takeSlot();
			return fn;
		},
		useEffect(effect) {
			const { slots } = takeSlot();
			slots.effects.push(effect);
		},
		useSyncExternalStore(subscribe, getSnapshot) {
			const { slots } = takeSlot();
			slots.subscriptions.push(subscribe);
			return getSnapshot();
		},
	};
	return api;
}

/** Load `client.js` against the fake loader and return the module it exported. */
function loadClient() {
	const React = createFakeReact();
	let exported;
	globalThis.window = {
		__ModuleLoader__: {
			load({ id, factory }) {
				assert.equal(id, 'dsh-approval-latency', 'bundle id must be the package name');
				exported = factory((specifier) => {
					assert.equal(specifier, 'react', `unexpected require(${JSON.stringify(specifier)})`);
					return React;
				});
			},
		},
	};
	const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
	// eslint-disable-next-line no-new-func -- the bundle is a browser script, not a module
	new Function(source)();
	assert.ok(exported !== undefined, 'the bundle registered itself');
	return { exported, React };
}

const { exported, React } = loadClient();

/** Render a function-component tree, keeping hook state between renders. */
function createRenderer(element) {
	const slots = React.createSlots();
	const renderTree = (node) => {
		if (node === null || node === undefined || typeof node !== 'object') return node;
		if (Array.isArray(node)) return node.map(renderTree);
		if (typeof node.type === 'function') {
			const previous = React.__slots;
			React.__slots = slots;
			try {
				return renderTree(node.type(node.props));
			} finally {
				React.__slots = previous;
			}
		}
		return { type: node.type, props: { ...node.props, children: renderTree(node.props?.children) } };
	};
	return {
		render() {
			slots.cursor = 0;
			slots.effects = [];
			React.__slots = slots;
			try {
				const tree = renderTree(element);
				for (const effect of slots.effects) effect();
				return tree;
			} finally {
				React.__slots = undefined;
			}
		},
	};
}

/** Walk an element tree and collect every element matching a predicate. */
function findAll(tree, predicate, found = []) {
	if (tree === null || tree === undefined || typeof tree !== 'object') return found;
	if (Array.isArray(tree)) {
		for (const child of tree) findAll(child, predicate, found);
		return found;
	}
	if (predicate(tree)) found.push(tree);
	findAll(tree.props?.children, predicate, found);
	return found;
}

/** All text inside one element tree. */
function textOf(tree) {
	if (tree === null || tree === undefined) return '';
	if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
	if (Array.isArray(tree)) return tree.map(textOf).join('');
	return textOf(tree.props?.children);
}

/** The button whose label matches a pattern. */
function button(tree, pattern) {
	const [found] = findAll(tree, (node) => node.type === 'button' && pattern.test(textOf(node)));
	return found;
}

/** A controller double: records writes and mirrors the accepted value back. */
function fakeScope(initial, { writable = true } = {}) {
	let snapshot = { status: 'ready', writable, value: initial, base: initial, user: {}, revision: 1 };
	const writes = [];
	return {
		getSnapshot: () => snapshot,
		subscribe: () => () => {},
		async set(field, value) {
			writes.push(['set', field, value]);
			snapshot = {
				...snapshot,
				value: { ...snapshot.value, [field]: value },
				user: { ...snapshot.user, [field]: value },
				revision: snapshot.revision + 1,
			};
			return true;
		},
		async unset(field) {
			writes.push(['unset', field]);
			return true;
		},
		writes,
	};
}

/** Mount the browser half on a fake client context and capture its registration. */
function mountClient(scope) {
	const registrations = [];
	const dictionaries = new Map();
	const ctx = {
		effect: (effect) => effect(),
		locale: {
			bind: (ns) => (key) => `${ns}:${key}`,
			register: (ns, dict) => {
				dictionaries.set(ns, dict);
				return () => dictionaries.delete(ns);
			},
			subscribe: () => () => {},
			getSnapshot: () => ({ revision: 0 }),
		},
		configForms: {
			get: (namespace) => {
				assert.equal(namespace, 'approval-latency', 'the page binds its own row namespace');
				return scope;
			},
			whileServed: (namespaces, register) => {
				assert.deepEqual(namespaces, ['approval-latency']);
				return register(new Set(namespaces));
			},
		},
		slots: {
			inject: (name, register) => {
				assert.equal(name, 'plugins.row.config');
				return register();
			},
			register: (options, Component) => {
				registrations.push({ options, Component });
				return () => {};
			},
		},
	};
	exported.apply(ctx);
	return { registrations, dictionaries };
}

/** Mount the page for one scope and render it in the given view. */
function mountPage(scope, view = 'page') {
	const { registrations } = mountClient(scope);
	assert.equal(registrations.length, 1, 'exactly one row page is registered');
	const renderer = createRenderer({ type: registrations[0].Component, props: { view } });
	return renderer.render();
}

test('the bundle exports the services it needs and a stable namespace', () => {
	assert.deepEqual(exported.inject, ['slots', 'locale', 'configForms']);
	assert.equal(exported.NS, 'settings.approvalLatency');
	assert.equal(exported.NAMESPACE, 'approval-latency');
	assert.equal(exported.ROW_KEY, 'dsh-approval-latency#approval-latency');
});

test('it registers its page on the row key and its dictionaries', () => {
	const scope = fakeScope({ mode: 'auto', fixedMs: 30000 });
	const { registrations, dictionaries } = mountClient(scope);

	assert.equal(registrations.length, 1);
	assert.deepEqual(registrations[0].options, {
		name: 'plugins.row.config',
		key: 'dsh-approval-latency#approval-latency',
	});

	const dict = dictionaries.get(exported.NS);
	assert.ok(dict?.zh && dict?.en, 'both locales are registered');
	assert.ok(dict.zh.summary.length > 0);
	assert.ok(dict.en.summary.length > 0);
	for (const key of Object.keys(dict.zh)) {
		assert.equal(typeof dict.en[key], 'string', `en is missing "${key}"`);
	}
});

test('the summary view is the row one-liner only', () => {
	const tree = mountPage(fakeScope({ mode: 'auto', fixedMs: 30000 }), 'summary');
	assert.equal(tree, `${exported.NS}:summary`);
});

test('adaptive mode shows a lit switch and a disabled duration box', () => {
	const tree = mountPage(fakeScope({ mode: 'auto', fixedMs: 30000 }));

	const [toggle] = findAll(tree, (node) => node.props?.role === 'switch');
	assert.ok(toggle, 'a role=switch control exists');
	assert.equal(toggle.props['aria-checked'], true);

	const [input] = findAll(tree, (node) => node.type === 'input');
	assert.equal(input.props.value, '30');
	assert.equal(input.props.disabled, true, 'the fixed duration is unused while adaptive');
	assert.match(textOf(tree), /fixedIgnored/);
});

test('flipping the switch writes mode: fixed through the transport', async () => {
	const scope = fakeScope({ mode: 'auto', fixedMs: 30000 });
	const tree = mountPage(scope);
	const [toggle] = findAll(tree, (node) => node.props?.role === 'switch');

	await toggle.props.onClick();
	assert.deepEqual(scope.writes, [['set', 'mode', 'fixed']]);
});

test('fixed mode enables the box and committing it writes milliseconds', () => {
	const scope = fakeScope({ mode: 'fixed', fixedMs: 45000 });
	const renderer = createRenderer({
		type: mountClient(scope).registrations[0].Component,
		props: { view: 'page' },
	});

	let tree = renderer.render();
	const [input] = findAll(tree, (node) => node.type === 'input');
	assert.equal(input.props.value, '45');
	assert.equal(input.props.disabled, false);
	assert.match(textOf(tree), /fixedHint/);

	// Type "90", re-render like React would, then blur to commit.
	input.props.onChange({ target: { value: '90' } });
	tree = renderer.render();
	const [typed] = findAll(tree, (node) => node.type === 'input');
	assert.equal(typed.props.value, '90');
	typed.props.onBlur();
	assert.deepEqual(scope.writes, [['set', 'fixedMs', 90000]]);
});

test('a non-positive duration is rejected locally and never sent', () => {
	const scope = fakeScope({ mode: 'fixed', fixedMs: 30000 });
	const renderer = createRenderer({
		type: mountClient(scope).registrations[0].Component,
		props: { view: 'page' },
	});

	let tree = renderer.render();
	const [input] = findAll(tree, (node) => node.type === 'input');
	input.props.onChange({ target: { value: '0' } });
	tree = renderer.render();
	const [typed] = findAll(tree, (node) => node.type === 'input');
	typed.props.onBlur();
	tree = renderer.render();

	assert.deepEqual(scope.writes, [], 'nothing was written');
	assert.match(textOf(tree), /invalid/);
});

test('reset clears both fields instead of writing defaults', async () => {
	const scope = fakeScope({ mode: 'fixed', fixedMs: 45000 });
	const tree = mountPage(scope);

	await button(tree, /reset$/).props.onClick();
	assert.deepEqual(scope.writes, [
		['unset', 'mode'],
		['unset', 'fixedMs'],
	]);
});

test('an overridden row is marked as such', () => {
	const scope = fakeScope({ mode: 'fixed', fixedMs: 45000 });
	scope.getSnapshot().user = { fixedMs: 45000 };
	const tree = mountPage(scope);
	assert.match(textOf(tree), /overridden/);
});

test('a read-only deployment disables every control and says so', () => {
	const tree = mountPage(fakeScope({ mode: 'auto', fixedMs: 30000 }, { writable: false }));

	const [toggle] = findAll(tree, (node) => node.props?.role === 'switch');
	assert.equal(toggle.props.disabled, true);
	const [input] = findAll(tree, (node) => node.type === 'input');
	assert.equal(input.props.disabled, true);
	assert.match(textOf(tree), /readOnly/);
});

test('a namespace the Host has not served keeps controls inert', () => {
	const scope = fakeScope({ mode: 'auto', fixedMs: 30000 });
	scope.getSnapshot().status = 'unavailable';
	const tree = mountPage(scope);

	const [toggle] = findAll(tree, (node) => node.props?.role === 'switch');
	assert.equal(toggle.props.disabled, true);
	assert.match(textOf(tree), /unavailable/);
});
