# dsh-approval-latency

Tells the model **when a tool call sat waiting for a human approval**, so a late answer is
not mistaken for broken code:

> If a call waited 6m 42s on its approval prompt, the model receives one context message in
> the next request stating that the gap was **human response time** — not a tool failure, not
> a timeout, and no evidence that its previous work was wrong.

[中文](README.md) · MIT · host-only, no network, no filesystem, never changes an approval
decision · repo <https://github.com/UPxianyu/dsh-approval-latency>

---

## 1. The problem

DSH's runtime context reports wall-clock time:

```markdown
Elapsed since the preceding model-visible message: 6m 42s
```

(from `@deepseek-ai/dsh-time-context`.) Approvals are the everyday reason that number
suddenly jumps: you stepped away, came back, and clicked "allow once". The model only sees
"previous message" and "now", so it invents a cause — a hung command, an unstable
environment, or "the user rejected me, so my change must be wrong" — and burns attention
re-auditing work that was never at fault.

This plugin closes that gap. When a call waited at least its bar (`mode: auto` learns it,
`mode: fixed` pins it — see section 4), it appends one
context message **right after that step's tool results**, saying the wait was approval
latency and must not be read as evidence about the call or the code.

## 2. Behavior

| Situation | Result |
|---|---|
| Wait ≥ the **grant bar**, granted | Notice: how long, human latency, do not reopen earlier work |
| Wait ≥ the **rejection bar** (half the grant bar by default), rejected | Notice: a "no" this late may be stale or accidental; ask before reworking |
| Wait ≥ the grant bar, cancelled / no answerer | Notice: the call never ran, so the gap says nothing about the code |
| Wait below its bar | Nothing (normal click speed must stay quiet) |
| No approval on this call | Nothing |
| `reportDenials: false` | Only granted waits are reported |

"No so long" is **measured, not assumed** (see section 4): by default the bar comes from this
machine's own answered approvals.

The tool result itself is never rewritten — the audited `tool/result` event keeps the tool's
own output — and a later listener's `block` feedback still wins.

The three model-facing texts. Each is **one line with three facts**: how long the wait was, that
it is human latency rather than a failure or a hint about the code, and that this result is all
there is to judge. Explanations were cut deliberately — a paragraph about time invites the model
to reason about time, which is the drift this exists to prevent, and it costs twice the tokens.

Granted (154 chars ≈ **41 tokens**):

```markdown
Approval wait: "bash" ran 2m 8s after the user approved it — human latency, not a tool failure,
and not evidence about earlier work. Judge only this result.
```

Rejected (154 chars ≈ 41 tokens; note there is no "go ask the user" step, only the fact):

```markdown
Approval wait: the user rejected "write" after 4m 10s. A "no" that late may be stale rather than
a verdict on your approach — check it against what was asked.
```

Cancelled / no answerer (127 / 116 chars ≈ 33 / 31 tokens):

```markdown
Approval wait: "pwsh" stayed unapproved for 1m 0s and was cancelled, so it never ran.
Human latency, not evidence about the code.
```

> The length budget is enforced: `test/latency.test.mjs` asserts each variant stays under
> 200 / 200 / 170 / 170 characters, within three sentences, and opens with `Approval wait: `.
## 3. Install

```sh
dsh plugin --profile desktop add /path/to/dsh-approval-latency
# or
dsh plugin --profile desktop add github:UPxianyu/dsh-approval-latency
```

Restart `dsh web` (or the desktop app).

```sh
dsh plugin --profile desktop remove dsh-approval-latency
```

### 3.1 Configure it on the settings page (recommended)

**Settings → Plugins → `dsh-approval-latency` → the `approval-latency` row's "Configure"**:

| Control | Effect |
|---|---|
| **Adaptive** switch | On (default): the bar follows your own answering speed (section 4.2). Off: use the fixed duration below. |
| **Fixed duration** box | Seconds, default **30**. Written on Enter or blur; a `0` or non-number is refused with a hint and never stored. |
| **Reset to default** | Drops this page's override and falls back to the bundle defaults. |

The Host persists the write into the profile's Cordis patch (the same layer a hand-edited YAML
uses) and applies it to the running plugin **without a restart**, because these fields are
`volatile`. The "Overridden" badge means the page wrote that field.

The page cannot show the learned baseline — that number lives in the Host's memory and only
reaches the debug log. The page's job is the two controls.

## 4. Configuring the threshold

This section is the **YAML spelling** of the same config (for scripts, teams, CI). Both modes
are also switchable from the settings page (section 3.1); the definitions and the maths are
identical.

Override them in the **profile** `cordis.patch.yml` with the same row id (a same-id override
replaces the whole `config`, so write only what you change — everything else falls back to its
default):

| What you write | What takes effect |
|---|---|
| nothing | `mode: auto` (learned) |
| `mode: auto` | Learned from this machine; `fixedMs` is not used |
| `mode: fixed` | Always `fixedMs`, default **30000 (30 s)** |
| only `fixedMs: 45000` | Implied `mode: fixed` (a duration you wrote should take effect) |
| only `thresholdMs: 45000` (0.2.0 spelling) | Same, as a deprecated alias |

An explicit `mode` always wins: `mode: auto` next to a `fixedMs` is not a conflict, the value
is simply unused — the same way `floorMs` is unused under `mode: fixed`.

### 4.1 Fixed duration (the two shortest forms)

```yaml
# profile/cordis.patch.yml
- id: approval-latency
  name: dsh-approval-latency
  config:
    mode: fixed          # fixedMs omitted -> the 30000 ms default
```

```yaml
- id: approval-latency
  name: dsh-approval-latency
  config:
    mode: fixed
    fixedMs: 45000       # 45 s
```

**Why the default is 30 s**: below that it is still normal clicking, and a notice would just be
noise; at 30 s and beyond the model's `Elapsed since the preceding model-visible message` line
is large enough to make it doubt itself, which is exactly when one sentence pays for itself.

### 4.2 How `auto` resolves the bar

```
grant bar = clamp( multiplier × median(last 20 real answers), floorMs, ceilingMs )
```

- **Samples** are real answers only — `allowed-once` and `rejected`. Cancelled or unanswered
  prompts say nothing about how fast the human replies.
- **Each sample is clamped to `ceilingMs`** first, so one three-hour absence cannot drag the
  baseline away.
- **Median, not mean**: a few outliers do not move it.
- **Below `minSamples` (default 3) the bar is the 30 s cold start** — a placeholder, not a rule.
- **The wait being judged never feeds its own baseline**: the bar is resolved from history
  first, and only then is this answer sampled.
- `floorMs` (10 s) keeps a fast answer quiet; `ceilingMs` (5 min) keeps the baseline from
  drifting out of reach.

A 4-second clicker gets a 12-second bar; a 90-second clicker gets 5 minutes (the ceiling).
Different machine, different human — different number, which is the point.

### 4.3 Split by outcome (both modes)

```
rejection bar = clamp( grant bar × rejectionScale, min(floorMs, grant bar), grant bar )
```

A late "no" is the costliest misreading (the model rewrites working code), so it is reported
at half the bar by default. `rejectionScale: 1` makes both bars equal. Cancellations and
unanswered prompts use the grant bar — they were never a judgement about the call.

### 4.4 Switch

`reportDenials: false` reports granted waits only.

### 4.5 Every field

The bundle's patch ships these defaults:

```yaml
- id: approval-latency
  name: dsh-approval-latency
  config:
    mode: auto             # auto = learned; fixed = always fixedMs
    fixedMs: 30000         # fixed-mode bar in ms (implies mode: fixed when mode is omitted)
    floorMs: 10000         # auto: lower bound
    ceilingMs: 300000      # auto: upper bound, and the clamp on each sample
    multiplier: 3          # auto: "unusually long" = this many times the median
    minSamples: 3          # auto: answers needed before the learned bar applies
    rejectionScale: 0.5    # rejection bar = grant bar × this factor, in (0, 1]
    reportDenials: true    # also report rejected / cancelled / unavailable waits
```

| Field | Default | Meaning |
|---|---|---|
| `mode` | `auto` | `auto` learns this machine's speed; `fixed` always uses `fixedMs`. |
| `fixedMs` | `30000` | Fixed-mode bar in ms. `0` reports every approval (debugging). |
| `floorMs` | `10000` | Lower bound for the learned bar: waits below it are never reported. |
| `ceilingMs` | `300000` | Upper bound, and the clamp applied to each sample. |
| `multiplier` | `3` | "Unusually long" = this many times this machine's median. Lower is more sensitive. |
| `minSamples` | `3` | Answers needed before the learned bar replaces the cold start. |
| `rejectionScale` | `0.5` | Rejection bar = grant bar × this factor, in (0, 1]. |
| `reportDenials` | `true` | Also report waits that ended rejected / cancelled / unavailable. |
| `thresholdMs` | — | **Deprecated**: alias of `fixedMs`; supplying it implies `mode: fixed`. |

### 4.6 Common recipes

| Want | Change |
|---|---|
| Deterministic, ignore history | `mode: fixed` (30 s) or `mode: fixed` + `fixedMs` |
| More sensitive (flag a 10 s away) | `floorMs: 5000`, `multiplier: 2` |
| Quieter (only clear absences) | `multiplier: 5`, `ceilingMs: 600000` |
| Fewer rejection notices | `rejectionScale: 1` or `reportDenials: false` |
| See it working right away | `mode: fixed`, `fixedMs: 0` |

Every emitted notice writes one debug line with `mode` (`cold` / `learned` / `fixed`), both
bars, the baseline median and the sample count, so tuning never needs guesswork.

The Loader row's schema rejects an unknown `mode`, a negative or non-numeric duration, a
non-integer `minSamples` and an out-of-range `rejectionScale` when the row is composed, and the
settings page refuses the same values before sending anything. A value that slips through from
elsewhere (`ceilingMs < floorMs`, say) never crashes a tool call: it is logged, and the last good
settings stay in effect.

### 4.7 Signals deliberately not used

| Alternative | Why not |
|---|---|
| The tool's own runtime | Unrelated to whether the human is at the keyboard; a 10-minute build is not approval latency. |
| The runtime context's elapsed value | That is the thing being explained — using it as the trigger would reinforce itself. |
| Time of day / calendar | Needs history the plugin does not have, and stores an activity profile for little gain. |
| Keyboard/mouse idle, window focus | Unavailable host-side, and privacy-relevant; "how fast you answer" already expresses it. |
| Per-tool bars | One human answers prompts at one speed regardless of which tool asked; it only adds config surface. |
| Asking the model to report it was confused | Unreliable, and the notice must arrive before the model starts reasoning. |

## 5. What it refuses to do

- Never answers an approval: the `approval/request` listener always delegates via `next()`.
- Never rewrites the tool result: it only appends to `additionalContexts`, so the audited
  `tool/result` event and any later `block` feedback stay intact.
- Never infers a cause: it reports the wait and that it is not evidence about the code.
- No network, no filesystem, no credentials, and the settings page touches no storage: it submits
  field reads and writes through `ctx.configForms`, so validation, persistence and conflict
  detection stay in the Host's settings service.
- Swallows its own failures (one warn log) so a bug here cannot fail a tool call.
- Bounded bookkeeping: at most 64 pending records per agent, dropped after 6 hours, matched
  by tool-call id only — ambiguous records are reported as nothing rather than guessed.

## 6. How it works

```
approval/request  ──(prepend wrapper)──▶  the real answerer (web panel / ACP / policy)
        │  records startedAt / endedAt / outcome, keyed by agent + call id
        ▼
tools/post-execute  ──(await next() first)──▶  append one additionalContexts entry
        │
        ▼
agent loop injects it as a user/message right after this step's tool results
```

Verified against the packaged 0.2.1-rc.2 sources:

1. `ctx.on('approval/request', fn, { prepend: true })` lands **outside** the answerer —
   Cordis links waterfall listeners in registration order and `prepend` is `unshift`.
   Registered inside it, the listener would never run (the answerer does not call `next()`).
2. `additionalContexts` are collected into the loop's `next-step` inbox and appended after
   this step's tool results.
3. The message's `source.kind` is plugin-owned (`approval-latency`, `form: 'notice'`), which
   is exactly what session format v4 asks for.
4. The settings namespace is the **Loader row id** (`dsh-settings` keys namespaces by
   `entry.id` and serves only volatile fields); `ui-theme`'s namespace constant is its row id.
5. The `plugins.row.config` key is dispatched by the Host as `` `${package}#${rowId}` ``
   (`ui-plugin-manager`'s `rowConfigKey`), and its owner props are `{view: 'summary'|'page'}`.

Durations use `performance.now()` so a system clock change cannot produce nonsense.

The bar is bookkept on the same path:

```
approval/request times the wait → tools/post-execute takes it back →
resolve the bar from history → decide → only then sample this answer
```

Deciding before sampling is deliberate: a wait must not help raise the bar that judges it.

## 7. Compatibility

- Verified against **DSH 0.2.1-rc.2** (Windows desktop build); 52 tests cover the pure helpers,
  the mount wiring, the plugin entry and the browser half (`npm run test:inprocess`; the two
  schema assertions skip themselves outside a DSH installation, where `@deepseek-ai/schemastery`
  is not resolvable).
- Also exercised the real `@deepseek-ai/cordis` 4.0.5 and `@deepseek-ai/schemastery` 3.18.5 from
  the same build: the prepended listener runs outside the answerer, `next()` reaches it and
  returns its outcome unchanged, a 30 ms wait is measured as 30 ms, a sub-threshold wait adds
  nothing, `fiber.dispose()` removes the listeners, and `index.js` mounts with its real `Config`
  in all four shapes (adaptive cold start / fixed 0 / fixed 30 s / learned).
- The browser half is exercised against a fake loader, fake React hooks and a fake client
  context: slot key, both dictionaries, the summary view, the switch writing `mode: fixed`, the
  duration box writing `fixedMs` in milliseconds, a refused `0`, reset via `unset`, and the
  read-only and unavailable states. **Real browser rendering is not verified** — install the
  bundle and follow section 8 for that.
- `engines.dsh` is `>=0.2.1-rc.2 <0.3.0-0`: `@deepseek-ai/dsh-app-boot`
  (`evaluatePluginCompatibility`) reads that top-level field only — a satisfying range admits
  the bundle, an unsatisfying one skips it at boot. Not `dsh.engines.dsh`, and not
  `dsh.compatibility`: neither is read at boot in 0.2.1-rc.2.
- The Host half declares **a peer, not a dependency**: `@deepseek-ai/schemastery` sits in
  `peerDependencies`. That is load-bearing — for a `link:`-installed plugin, DSH's resolution
  router (`dsh-app-boot`'s `ResolutionRouter`) intercepts a bare specifier to the installation's
  copy **only when the plugin's manifest lists it as a peer** (it reads `peerDependencies`);
  without it the import falls through to native resolution and fails. The profile sets
  `autoInstallPeers: false`, so declaring the peer fetches nothing; installed plugins such as
  `dsh-context` do exactly the same.
- If upstream changes either event's shape, the worst case is **no notice** (back to today's
  behaviour); if it changes the settings slot contract, the worst case is **no settings page**
  (YAML still configures it). Neither can approve, reject, or alter a result.

## 8. Self-test

Settings page first:

1. After a restart open **Settings → Plugins**: the `dsh-approval-latency` card lists the
   `approval-latency` row with a configure control, and that page shows the **Adaptive** switch
   and the **Fixed duration** box.
2. Turn the switch off → "Saved" and an "Overridden" badge appear; type `120`, press Enter.
3. Back in a session, trigger an approval and allow it at once → **no** notice (far below 120 s).
   Set the duration to `1` second and repeat → the notice appears.
4. Click **Reset to default** → the badge disappears and adaptive mode is back.

Then the notice itself:

5. Trigger an approval, switch to another window, wait 40+ seconds, then click "allow once".
6. After that step's tool result there should be one `Approval wait: ...` message whose
   duration matches your wait.
7. Repeat and click "reject" → the "possibly stale" variant appears (lower bar).
8. Answer three approvals instantly, then wait 40 s on a fourth → still reported, but the
   debug line now says `mode=learned` with a baseline close to your instant answers.
9. Run a call that needs no approval → no notice.
10. Cancel a turn while its approval is pending → the "never ran" variant, and the call itself
    is unaffected.

## 9. Limits

- Only approvals are explained. Other causes of a large elapsed gap (you interrupted and did
  something else, machine sleep, model queueing) are out of scope and stay unexplained.
- Only approvals this process sees; a wait inside a subprocess/subagent with no call id
  correlation is not reported.
- The baseline lives in memory: a restart relearns from the 30 s cold start, usually within a
  few approvals. That is deliberate — no file writes, no persisted activity profile.
- The baseline drifts with you: a week of slow answers raises the bar (up to `ceilingMs`).
  Pin `mode: fixed` (plus `fixedMs` if 30 s is not what you want) if you want it fixed.
- The notice stays in history once injected (append-only; reusable KV-cache prefixes survive).

## 10. Security

See [SECURITY.md](SECURITY.md): two event listeners, one warn log, no network, no files, no
credentials, no say in any approval.

## 11. License

[MIT](LICENSE)




