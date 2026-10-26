/**
 * dsh-session-admin 浏览器半边：侧栏底部的「会话清理」入口。
 *
 * 侧栏列表行没有可扩展的右键菜单（ui-workspace 没有 context-menu 插槽），所以这里
 * 改用自己的一块面板：点按钮 → 拉宿主 /session-admin/state → 勾选 → 调
 * /session-admin/delete。面板只认已归档会话，未归档的宿主也会拒。
 *
 * 用 React.createElement 手写，不引任何客户端 UI 包，样式走 --dsw-alias-* 令牌，
 * 跟随宿主主题切换。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-admin',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 宿主路由：归档清单。 */
    const STATE_URL = '/session-admin/state'
    /** 宿主路由：删除。 */
    const DELETE_URL = '/session-admin/delete'

    /** 主题令牌。 */
    const C = {
      text: 'var(--dsw-alias-label-primary, #e6e6e6)',
      sub: 'var(--dsw-alias-label-secondary, #a8a8a8)',
      faint: 'var(--dsw-alias-label-tertiary, #808080)',
      line: 'var(--dsw-alias-border-l, rgba(255,255,255,.12))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08))',
      base: 'var(--dsw-alias-bg-base, #1b1b1b)',
      danger: 'var(--dsw-alias-state-error-primary, #e05a5a)',
      warn: 'var(--dsw-alias-state-warn-primary, #d9a13b)',
    }

    const S = {
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '6px 10px',
        border: 'none',
        borderRadius: 8,
        background: 'transparent',
        color: C.sub,
        font: 'inherit',
        fontSize: 13,
        cursor: 'pointer',
        textAlign: 'left',
      },
      overlay: {
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,.45)',
      },
      panel: {
        width: 'min(560px, 92vw)',
        maxHeight: '78vh',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 16,
        borderRadius: 12,
        background: C.base,
        border: `1px solid ${C.line}`,
        boxShadow: '0 18px 48px rgba(0,0,0,.45)',
        color: C.text,
        fontSize: 13,
      },
      head: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
      title: { fontSize: 14, fontWeight: 600, color: C.text },
      meta: { color: C.faint, fontSize: 12 },
      list: {
        flex: 1,
        minHeight: 80,
        maxHeight: '46vh',
        overflowY: 'auto',
        border: `1px solid ${C.line}`,
        borderRadius: 8,
      },
      item: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        borderBottom: `1px solid ${C.line}`,
        cursor: 'pointer',
      },
      id: {
        fontFamily: 'ui-monospace, Consolas, monospace',
        color: C.text,
        fontSize: 12,
        flex: 1,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      nums: { color: C.faint, fontSize: 12, whiteSpace: 'nowrap' },
      foot: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      btn: {
        padding: '5px 10px',
        borderRadius: 8,
        border: `1px solid ${C.line}`,
        background: 'transparent',
        color: C.text,
        font: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
      },
      btnDanger: {
        padding: '5px 10px',
        borderRadius: 8,
        border: `1px solid ${C.danger}`,
        background: 'transparent',
        color: C.danger,
        font: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
      },
      grow: { flex: 1 },
      note: { color: C.warn, fontSize: 12, lineHeight: 1.5 },
      empty: { padding: 18, color: C.faint, textAlign: 'center' },
    }

    /**
     * 把字节数写成人类可读的大小。
     * @param {number} bytes - 字节数。
     * @returns {string} 例如 "820 KB" / "12.4 MB"。
     */
    function sizeText(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB'
      if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
      return `${Math.round((bytes / 1048576) * 10) / 10} MB`
    }

    /**
     * 把字节时间转成「几天前」。
     * @param {number | null} ms - 毫秒时间戳。
     * @returns {string} 相对时间文案。
     */
    function agoText(ms) {
      if (ms === null || ms === undefined) return '无数据'
      const diff = Date.now() - ms
      const mins = Math.round(diff / 60000)
      if (mins < 60) return `${Math.max(1, mins)} 分钟前`
      const hours = Math.round(mins / 60)
      if (hours < 48) return `${hours} 小时前`
      const days = Math.round(hours / 24)
      return `${days} 天前`
    }

    /** 取状态。 */
    async function loadState() {
      const response = await fetch(STATE_URL, { headers: { accept: 'application/json' } })
      const body = await response.json()
      if (!response.ok || body.ok !== true) throw new Error(body.error ?? `HTTP ${response.status}`)
      return body
    }

    /** 提交删除。 */
    async function submitDelete(ids) {
      const response = await fetch(DELETE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      const body = await response.json()
      if (!response.ok || body.ok !== true) throw new Error(body.error ?? `HTTP ${response.status}`)
      return body
    }

    /**
     * 清理面板。
     * @param {{ onClose: () => void }} props - 关闭回调。
     */
    function CleanupPanel(props) {
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [picked, setPicked] = React.useState(() => new Set())
      const [busy, setBusy] = React.useState(false)
      const [report, setReport] = React.useState(null)

      const refresh = React.useCallback(async () => {
        setError(null)
        try {
          const next = await loadState()
          setState(next)
          setPicked(prev => {
            const alive = new Set(next.items.map(item => item.id))
            return new Set([...prev].filter(id => alive.has(id)))
          })
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }, [])

      React.useEffect(() => { void refresh() }, [refresh])

      const items = state?.items ?? []
      const deletable = items.filter(item => item.onDisk && !item.live)
      const pickedDeletable = [...picked].filter(id => deletable.some(item => item.id === id))

      /**
       * 执行删除。
       * @param {string[]} ids - 目标会话。
       * @param {string} label - 确认框里的说明。
       */
      async function run(ids, label) {
        if (ids.length === 0) return
        if (!window.confirm(`确认删除 ${ids.length} 个${label}？会话日志会从磁盘移除，不可恢复。`)) return
        setBusy(true)
        setError(null)
        setReport(null)
        try {
          const result = await submitDelete(ids)
          setReport({
            freedBytes: result.freedBytes ?? 0,
            deleted: result.deleted?.length ?? 0,
            skipped: result.skipped ?? [],
            remaining: result.remainingArchived ?? 0,
            needRestart: result.needRestart === true,
          })
          await refresh()
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }

      const toggle = (id) => {
        setPicked(prev => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }

      const rows = items.length === 0
        ? h('div', { style: S.empty }, state === null ? '正在读取…' : '没有已归档的会话')
        : items.map(item => h(
          'label',
          { key: item.id, style: { ...S.item, opacity: item.onDisk && !item.live ? 1 : 0.55 } },
          h('input', {
            type: 'checkbox',
            disabled: !item.onDisk || item.live,
            checked: picked.has(item.id),
            onChange: () => toggle(item.id),
          }),
          h('span', { style: S.id, title: item.id }, item.id),
          h('span', { style: S.nums }, item.live ? '运行中·跳过' : (item.onDisk ? sizeText(item.bytes) : '无数据')),
          h('span', { style: S.nums }, agoText(item.mtimeMs)),
        ))

      return h(
        'div',
        { style: S.overlay, onMouseDown: (event) => { if (event.target === event.currentTarget) props.onClose() } },
        h(
          'div',
          { style: S.panel, role: 'dialog', 'aria-label': '会话清理' },
          h(
            'div',
            { style: S.head },
            h('span', { style: S.title }, '会话清理（已归档）'),
            h('span', { style: S.meta }, state === null
              ? ''
              : `共 ${state.counts.archived} 个 · 有数据 ${state.counts.onDisk} 个 · ${sizeText(state.counts.bytes)}`),
          ),
          h('div', { style: S.meta }, '只能删除已归档的会话；要删常用会话，先在侧栏把它归档。删除会同时清掉日志文件、投影缓存和归档标记。'),
          error !== null ? h('div', { style: { ...S.note, color: C.danger } }, `出错：${error}`) : null,
          report !== null
            ? h('div', { style: S.note }, `已删 ${report.deleted} 个，释放 ${sizeText(report.freedBytes)}，剩余归档 ${report.remaining} 个`
              + (report.skipped.length > 0 ? `（跳过 ${report.skipped.length} 个）` : '')
              + '。侧栏若仍显示旧条目，点「刷新页面」即可同步。')
            : null,
          h('div', { style: S.list }, rows),
          h(
            'div',
            { style: S.foot },
            h('button', {
              type: 'button',
              style: S.btn,
              disabled: busy,
              onClick: () => setPicked(new Set(deletable.map(item => item.id))),
            }, '全选'),
            h('button', {
              type: 'button',
              style: S.btn,
              disabled: busy,
              onClick: () => setPicked(new Set()),
            }, '清空选择'),
            h('span', { style: S.grow }),
            h('button', {
              type: 'button',
              style: S.btn,
              disabled: busy,
              onClick: () => void refresh(),
            }, '刷新'),
            h('button', {
              type: 'button',
              style: S.btn,
              disabled: busy,
              onClick: () => window.location.reload(),
            }, '刷新页面'),
            h('button', {
              type: 'button',
              style: S.btnDanger,
              disabled: busy || pickedDeletable.length === 0,
              onClick: () => void run(pickedDeletable, '选中会话'),
            }, `删除选中${pickedDeletable.length > 0 ? `(${pickedDeletable.length})` : ''}`),
            h('button', {
              type: 'button',
              style: S.btnDanger,
              disabled: busy || deletable.length === 0,
              onClick: () => void run(deletable.map(item => item.id), '已归档会话'),
            }, `全部删除(${deletable.length})`),
            h('button', { type: 'button', style: S.btn, onClick: props.onClose }, '关闭'),
          ),
        ),
      )
    }

    /**
     * 侧栏底部入口。
     * @param {{ wide?: boolean }} props - 侧栏宽度标记。
     */
    function Entry(props) {
      const [open, setOpen] = React.useState(false)
      return h(
        'div',
        { style: { display: 'contents' } },
        h(
          'button',
          {
            type: 'button',
            style: S.row,
            title: '清理已归档的会话',
            onClick: () => setOpen(true),
            onMouseEnter: (event) => { event.currentTarget.style.background = C.hover },
            onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' },
          },
          h('span', { 'aria-hidden': true, style: { fontSize: 14 } }, '🧹'),
          props.wide === false ? null : h('span', null, '会话清理'),
        ),
        open ? h(CleanupPanel, { onClose: () => setOpen(false) }) : null,
      )
    }

    return {
      name: 'sessionAdmin',
      inject: ['slots'],
      /**
       * 注册侧栏底部动作。
       * @param {object} ctx - 客户端上下文。
       */
      apply(ctx) {
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'session-admin', order: 40 },
          Entry,
        ))
      },
    }
  },
})
