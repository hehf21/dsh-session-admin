/**
 * dsh-session-admin 浏览器半边冒烟：没有真实 React，就用一套最小 hook 运行时把
 * Entry / CleanupPanel 亲手渲两遍（初始 + 点开后），验证：
 *   1. 插件注册到 sidebar.footer.action；
 *   2. 点按钮能展开面板，面板按宿主返回的清单渲染行；
 *   3. 勾选后点「删除选中」会把正确的 id 送到 POST /session-admin/delete。
 */
import assert from 'node:assert/strict'

// —— 最小 hook 运行时 ——
const components = new Map()
let current = null
let schedule = null

function slot(fn) {
  if (!components.has(fn)) components.set(fn, { states: [], cursor: 0, effects: [] })
  return components.get(fn)
}

const React = {
  createElement(tag, props, ...children) {
    return { tag, props: props ?? {}, children: children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false) }
  },
  useState(init) {
    const box = slot(current)
    const index = box.cursor++
    if (!(index in box.states)) box.states[index] = typeof init === 'function' ? init() : init
    return [box.states[index], (next) => {
      box.states[index] = typeof next === 'function' ? next(box.states[index]) : next
      schedule?.()
    }]
  },
  useCallback(fn) {
    slot(current).cursor++
    return fn
  },
  useEffect(fn) {
    slot(current).effects.push(fn)
  },
}

/** 找到树里满足条件的第一个节点。 */
function find(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate)
      if (hit !== null) return hit
    }
    return null
  }
  if (predicate(node)) return node
  return find(node.children, predicate)
}

/** 收集所有文本。 */
function texts(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out)
    return out
  }
  texts(node.children, out)
  return out
}

/**
 * 渲一次，并把子组件与 effect 都展开、状态变化引发的重渲也跑掉。
 * @param {Function} Component - 组件。
 * @param {object} props - 属性。
 * @returns {Promise<object>} 最终树。
 */
async function render(Component, props) {
  let tree = null
  let pending = true
  schedule = () => { pending = true }
  for (let round = 0; round < 12 && pending; round += 1) {
    pending = false
    tree = expand({ tag: Component, props, children: [] })
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  return tree
}

/**
 * 把函数组件就地展开成它的输出树（含嵌套组件）。
 * @param {object} node - 元素节点。
 * @returns {object | null} 展开后的树。
 */
function expand(node) {
  if (node === null || node === undefined) return null
  if (Array.isArray(node)) return node.map(expand).filter(child => child !== null)
  if (typeof node !== 'object') return node
  if (typeof node.tag === 'function') {
    const Component = node.tag
    const parent = current
    current = Component
    const box = slot(Component)
    box.cursor = 0
    box.effects = []
    let output
    try {
      output = Component(node.props ?? {})
    } finally {
      current = parent
    }
    const expanded = expand(output)
    for (const effect of box.effects) effect()
    return expanded
  }
  return { tag: node.tag, props: node.props, children: expand(node.children) }
}

// —— 桩浏览器环境与取数 ——
const calls = []
const fixture = {
  ok: true,
  counts: { archived: 3, onDisk: 2, bytes: 3 * 1048576 },
  items: [
    { id: 'session-alpha', bucket: '--D-demo--', onDisk: true, bytes: 2097152, mtimeMs: Date.now() - 3600000, live: false },
    { id: 'session-beta', bucket: '--D-demo--', onDisk: true, bytes: 1048576, mtimeMs: Date.now() - 86400000 * 2, live: false },
    { id: 'session-ghost', bucket: null, onDisk: false, bytes: 0, mtimeMs: null, live: false },
  ],
}
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url, options })
  if (url.includes('/session-admin/delete')) {
    const ids = JSON.parse(options.body).ids
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, deleted: ids, skipped: [], freedMB: 3, freedBytes: 3 * 1048576, remainingArchived: 0, needRestart: true }),
    }
  }
  return { ok: true, status: 200, json: async () => fixture }
}
let confirmed = 0
globalThis.window = {
  confirm: () => { confirmed += 1; return true },
  location: { reload: () => {} },
  __ModuleLoader__: { load: (record) => { window.__MODULE__ = record } },
}
globalThis.document = { createElement: () => ({ style: {} }) }

// —— 加载浏览器半边 ——
const module = await import('../client.js')
assert.equal(window.__MODULE__.id, 'dsh-session-admin')
const plugin = window.__MODULE__.factory((name) => {
  assert.equal(name, 'react')
  return React
})
assert.equal(plugin.name, 'sessionAdmin')
assert.deepEqual(plugin.inject, ['slots'])

let registered = null
const ctx = {
  slots: {
    inject(name, factory) {
      assert.equal(name, 'sidebar.footer.action')
      return factory()
    },
    register(options, Component) {
      registered = { options, Component }
      return () => {}
    },
  },
}
plugin.apply(ctx)
assert.equal(registered.options.name, 'sidebar.footer.action')
assert.equal(registered.options.id, 'session-admin')

// —— 初始渲染：只有按钮，没有面板 ——
const Entry = registered.Component
let tree = await render(Entry, { wide: true })
let allText = texts(tree).join(' ')
assert.ok(allText.includes('会话清理'), '入口按钮应有文案')
assert.equal(find(tree, node => node.props?.role === 'dialog'), null, '未点击时不该有面板')

// —— 点开：面板出现，并按清单渲染行 ——
const trigger = find(tree, node => node.tag === 'button' && texts(node).join(' ').includes('会话清理'))
assert.ok(trigger !== null, '应能找到入口按钮')
trigger.props.onClick()
tree = await render(Entry, { wide: true })
const dialog = find(tree, node => node.props?.role === 'dialog')
assert.ok(dialog !== null, '点击后应出现面板')
const dialogText = texts(dialog).join(' ')
assert.ok(dialogText.includes('共 3 个'), `面板应显示统计，实际：${dialogText.slice(0, 120)}`)
assert.ok(dialogText.includes('session-alpha'), '应列出归档会话')
assert.ok(dialogText.includes('无数据'), '僵尸标记应标为无数据')
assert.ok(dialogText.includes('2 MB'), '大小应按 MB 呈现')

// —— 全选后删除：POST 里应是两条有数据的 id ——
const selectAll = find(dialog, node => node.tag === 'button' && texts(node).join(' ') === '全选')
assert.ok(selectAll !== null, '应有全选按钮')
selectAll.props.onClick()
tree = await render(Entry, { wide: true })
const dialog2 = find(tree, node => node.props?.role === 'dialog')
const deleteBtn = find(dialog2, node => node.tag === 'button' && texts(node).join(' ').startsWith('删除选中'))
assert.ok(deleteBtn !== null, '应有删除选中按钮')
assert.ok(texts(deleteBtn).join('').includes('(2)'), '只应选中两个有数据的会话')
deleteBtn.props.onClick()
tree = await render(Entry, { wide: true })

const post = calls.find(call => call.url.includes('/session-admin/delete'))
assert.ok(post !== undefined, '应发出删除请求')
assert.deepEqual(JSON.parse(post.options.body).ids.sort(), ['session-alpha', 'session-beta'])
assert.equal(confirmed, 1, '应弹一次确认')

const finalText = texts(tree).join(' ')
assert.ok(finalText.includes('已删'), `删除后应有回执文案，实际：${finalText.slice(0, 160)}`)

console.log('CLIENT SMOKE PASS')
