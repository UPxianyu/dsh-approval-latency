/**
 * Browser half of the bundle: the settings page for this plugin's own row.
 *
 * The Host serves a settings namespace per profile row (`approval-latency`
 * here), exposes that row's volatile fields, validates every write and persists
 * it into the profile's Cordis patch. This half only draws the two controls the
 * row needs — the adaptive switch and the fixed duration — through
 * `ctx.configForms`, so the write path stays the Host's and nothing here talks
 * to storage, the network, or the tool pipeline.
 *
 * Registered into the Plugins page's `plugins.row.config` keyed slot
 * (`<package>#<row id>`), which is where a bundle's own configuration belongs:
 * the row gains a configure control and this page renders inside it.
 */
window.__ModuleLoader__.load({
  id: 'dsh-approval-latency',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Dictionary namespace owned by this plugin. */
    const NS = 'settings.approvalLatency';
    /** Host settings namespace: this row's Loader id. */
    const NAMESPACE = 'approval-latency';
    /** Key of the row on the Plugins page: `<package name>#<row id>`. */
    const ROW_KEY = 'dsh-approval-latency#approval-latency';
    /** Default of `fixedMs`, mirrored for a snapshot that has not arrived yet. */
    const DEFAULT_FIXED_SECONDS = 30;

    const zh = {
      summary: '审批等太久时，把「这段空档是人类在回答审批」回传给模型。',
      lead: '模型看到的长空档里，有一部分其实是在等你点审批；开启后它会收到一条说明，不再把延迟当成代码有问题。',
      adaptive: '自适应',
      adaptiveHint: '门槛跟着你回答审批的速度走：取最近几次回答的中位数翻几倍，并夹在一个上下限之间。',
      fixed: '固定时长',
      fixedHint: '每次都用这个时长：等待超过它才回传。',
      fixedIgnored: '自适应模式下不使用这个值。',
      seconds: '秒',
      effective: '当前生效',
      adaptiveValue: '自适应（按本机速度推）',
      overridden: '已覆盖',
      reset: '恢复默认',
      saved: '已保存',
      saving: '保存中…',
      rejected: '本部署没有接受这次修改，已保留原值。',
      invalid: '请填大于 0 的秒数。',
      readOnly: '本部署的设置为只读。',
      loading: '正在读取设置…',
      unavailable: '该插件当前未加载，暂时无法配置。',
    };

    const en = {
      summary: 'When a tool call waited for a human approval, tell the model that the gap was human latency.',
      lead: 'Part of the long gap the model sees is you answering an approval prompt. With this on, it gets one note saying so and stops treating the delay as broken code.',
      adaptive: 'Adaptive',
      adaptiveHint: 'The bar follows your own answering speed: a multiple of your recent median, kept between a floor and a ceiling.',
      fixed: 'Fixed duration',
      fixedHint: 'Always this duration: a wait longer than it is reported.',
      fixedIgnored: 'Unused while adaptive mode is on.',
      seconds: 's',
      effective: 'In effect',
      adaptiveValue: 'Adaptive (learned from this machine)',
      overridden: 'Overridden',
      reset: 'Reset to default',
      saved: 'Saved',
      saving: 'Saving…',
      rejected: 'This deployment did not accept the change; the previous value is still in effect.',
      invalid: 'Enter a number of seconds greater than 0.',
      readOnly: 'This deployment stores settings read-only.',
      loading: 'Reading settings…',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
    };

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 0 8px' },
      lead: { margin: 0, fontSize: '12px', lineHeight: 1.6, color: 'var(--dsw-alias-label-caption, #8a9099)' },
      row: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '16px',
        padding: '10px 0',
        borderTop: '1px solid var(--dsw-alias-border-l2, #e5e6eb)',
      },
      labelCol: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 },
      label: { fontSize: '13px', color: 'var(--dsw-alias-label-primary, #1f2329)' },
      caption: { fontSize: '11px', lineHeight: 1.5, color: 'var(--dsw-alias-label-caption, #8a9099)' },
      controlCol: { display: 'flex', alignItems: 'center', gap: '6px', flex: 'none' },
      input: {
        width: '84px',
        padding: '5px 8px',
        fontSize: '13px',
        textAlign: 'right',
        color: 'var(--dsw-alias-label-primary, #1f2329)',
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
        border: '1px solid var(--dsw-alias-border-l2, #e5e6eb)',
        borderRadius: '8px',
        outline: 'none',
      },
      unit: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #4e5969)' },
      footer: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' },
      status: { fontSize: '11px', color: 'var(--dsw-alias-label-caption, #8a9099)' },
      errorText: { color: 'var(--dsw-alias-state-error-primary, #d54941)' },
      okText: { color: 'var(--dsw-alias-state-success-primary, #1aa251)' },
      link: {
        padding: 0,
        fontSize: '12px',
        color: 'var(--dsw-alias-brand-primary, #4d6bfe)',
        background: 'none',
        border: 'none',
        cursor: 'pointer',
      },
      badge: {
        marginLeft: '6px',
        padding: '1px 6px',
        fontSize: '10px',
        color: 'var(--dsw-alias-brand-primary, #4d6bfe)',
        border: '1px solid var(--dsw-alias-brand-primary, #4d6bfe)',
        borderRadius: '999px',
      },
    };

    /** Track colour and knob position for the adaptive switch. */
    function switchParts(on, disabled) {
      return {
        track: {
          position: 'relative',
          width: '38px',
          height: '22px',
          flex: 'none',
          padding: 0,
          borderRadius: '999px',
          border: 'none',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          background: on
            ? 'var(--dsw-alias-brand-primary, #4d6bfe)'
            : 'var(--dsw-alias-border-l3, #c9cdd4)',
          transition: 'background 120ms ease',
        },
        knob: {
          position: 'absolute',
          top: '3px',
          left: on ? '19px' : '3px',
          width: '16px',
          height: '16px',
          borderRadius: '50%',
          background: '#fff',
          transition: 'left 120ms ease',
        },
      };
    }

    /**
     * The row's configuration page.
     *
     * `props.view === 'summary'` asks only for the one-liner the row shows before
     * the page is opened; anything else asks for the controls.
     *
     * @param props - `view` plus the scope, locale reader and context captured by `apply`.
     * @returns the one-liner, or the settings page.
     */
    function ApprovalLatencyPage(props) {
      const { scope, t, ctx } = props;
      const snapshot = React.useSyncExternalStore(
        React.useCallback((listener) => scope.subscribe(listener), [scope]),
        React.useCallback(() => scope.getSnapshot(), [scope]),
      );
      // Re-render when the active locale changes; this page owns no locale prop.
      const [, forceRender] = React.useReducer((count) => count + 1, 0);
      React.useEffect(() => ctx.locale.subscribe(forceRender), [ctx]);

      const [draftSeconds, setDraftSeconds] = React.useState(null);
      const [writeState, setWriteState] = React.useState('idle');

      if (props.view === 'summary') return t('summary');

      const status = snapshot.status;
      const writable = snapshot.writable === true;
      const ready = status === 'ready';
      const value = snapshot.value ?? {};
      const adaptive = value.mode !== 'fixed';
      const storedSeconds =
        typeof value.fixedMs === 'number' ? Math.max(0, value.fixedMs) / 1000 : DEFAULT_FIXED_SECONDS;
      const shownSeconds = draftSeconds ?? String(Math.round(storedSeconds * 100) / 100);
      const disabled = !ready || !writable;

      /** Queue one field write and remember whether the Host took it. */
      const commit = async (field, next) => {
        setWriteState('saving');
        try {
          setWriteState((await scope.set(field, next)) ? 'saved' : 'rejected');
        } catch {
          setWriteState('rejected');
        }
      };

      /** Flip between the learned bar and a fixed duration. */
      const onToggle = () => {
        if (disabled) return;
        void commit('mode', adaptive ? 'fixed' : 'auto');
      };

      /** Parse the seconds box; a blank or non-positive entry stays in the box. */
      const onCommitSeconds = () => {
        if (disabled || draftSeconds === null) return;
        const parsed = Number(draftSeconds);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          setWriteState('invalid');
          return;
        }
        setDraftSeconds(null);
        void commit('fixedMs', Math.round(parsed * 1000));
      };

      /** Drop this page's overrides and fall back to the deployment defaults. */
      const onReset = async () => {
        if (disabled) return;
        setDraftSeconds(null);
        setWriteState('saving');
        try {
          const mode = await scope.unset('mode');
          const fixed = await scope.unset('fixedMs');
          setWriteState(mode && fixed ? 'saved' : 'rejected');
        } catch {
          setWriteState('rejected');
        }
      };

      const overridden = snapshot.user?.mode !== undefined || snapshot.user?.fixedMs !== undefined;
      const parts = switchParts(adaptive, disabled);
      const statusText = () => {
        if (status === 'loading') return t('loading');
        if (status === 'unavailable') return t('unavailable');
        if (!writable) return t('readOnly');
        if (writeState === 'saving') return t('saving');
        if (writeState === 'saved') return t('saved');
        if (writeState === 'rejected') return t('rejected');
        if (writeState === 'invalid') return t('invalid');
        return '';
      };
      const statusIsBad = writeState === 'rejected' || writeState === 'invalid' || status === 'unavailable';
      const statusStyle = {
        ...styles.status,
        ...(statusIsBad ? styles.errorText : {}),
        ...(writeState === 'saved' ? styles.okText : {}),
      };

      return h(
        'div',
        { style: styles.root, 'data-approval-latency': 'settings' },
        h('p', { style: styles.lead }, t('lead')),

        h(
          'div',
          { style: { ...styles.row, borderTop: 'none' } },
          h(
            'div',
            { style: styles.labelCol },
            h(
              'span',
              { style: styles.label },
              t('adaptive'),
              overridden ? h('span', { style: styles.badge }, t('overridden')) : null,
            ),
            h('span', { style: styles.caption }, t('adaptiveHint')),
          ),
          h(
            'button',
            {
              type: 'button',
              role: 'switch',
              'aria-checked': adaptive,
              'aria-label': t('adaptive'),
              disabled,
              onClick: onToggle,
              style: parts.track,
            },
            h('span', { style: parts.knob }),
          ),
        ),

        h(
          'div',
          { style: styles.row },
          h(
            'div',
            { style: styles.labelCol },
            h('span', { style: styles.label }, t('fixed')),
            h('span', { style: styles.caption }, adaptive ? t('fixedIgnored') : t('fixedHint')),
          ),
          h(
            'div',
            { style: styles.controlCol },
            h('input', {
              type: 'number',
              min: 1,
              step: 1,
              inputMode: 'numeric',
              'aria-label': t('fixed'),
              value: shownSeconds,
              disabled: disabled || adaptive,
              onChange: (event) => setDraftSeconds(event.target.value),
              onBlur: onCommitSeconds,
              onKeyDown: (event) => {
                if (event.key === 'Enter') onCommitSeconds();
              },
              style: { ...styles.input, opacity: adaptive ? 0.5 : 1 },
            }),
            h('span', { style: styles.unit }, t('seconds')),
          ),
        ),

        h(
          'div',
          { style: styles.footer },
          h('span', { style: statusStyle }, statusText()),
          h('button', { type: 'button', style: styles.link, disabled, onClick: onReset }, t('reset')),
        ),

        h(
          'span',
          { style: styles.caption },
          `${t('effective')}: ${adaptive ? t('adaptiveValue') : `${shownSeconds} ${t('seconds')}`}`,
        ),
      );
    }

    const inject = ['slots', 'locale', 'configForms'];

    /**
     * Mount the row's configuration page while the Host serves its namespace.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'approval-latency: dictionaries');

      const scope = ctx.configForms.get(NAMESPACE);

      /** The page with its scope, locale reader and context baked in. */
      const Page = (props) => h(ApprovalLatencyPage, { ...props, scope, t, ctx });

      ctx.effect(
        () =>
          ctx.configForms.whileServed([NAMESPACE], () =>
            ctx.slots.inject('plugins.row.config', () =>
              ctx.slots.register({ name: 'plugins.row.config', key: ROW_KEY }, Page),
            ),
          ),
        'approval-latency: row page',
      );
    }

    return { NS, NAMESPACE, ROW_KEY, apply, inject };
  },
});
