/**
 * dsh-session-admin 宿主半边端到端冒烟：桩一个 cordis Context，把 apply() 真跑起来，
 * 再用假的 req/res 打两条路由，确认路由注册、同源闸门、JSON 收发、删除动作都通。
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-session-admin-route-'))
process.env.DSH_HOME = home

// —— 造数据 ——
const bucket = path.join(home, 'sessions', '--D-demo--')
for (const id of ['session-del', 'session-keep']) {
  await fsp.mkdir(path.join(bucket, id), { recursive: true })
  await fsp.writeFile(path.join(bucket, id, 'session.v4.jsonl.zstd'), 'y'.repeat(4096))
}
await fsp.mkdir(path.join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
await fsp.writeFile(path.join(home, 'storages', 'session_projcache', 'sessions', 'session-del.json'), '{}')
await fsp.writeFile(path.join(home, 'storages', 'workspace.json'), JSON.stringify({
  unit: { name: 'workspace', version: 2 },
  global: { initialized: true, workspaceIds: ['w1'], archivedSessionIds: ['session-del'], pinnedSessionIds: [] },
  tables: { workspaces: { w1: { path: 'D:\\demo', title: 'demo', sessionIds: ['session-del', 'session-keep'] } } },
}, null, 2))

const { apply } = await import('../index.js')

// —— 桩 ctx ——
const routes = new Map()
const ctx = {
  effect(fn) { const dispose = fn(); assert.equal(typeof dispose, 'function'); return dispose },
  get() { return undefined },
  webServer: {
    register({ path: p, handler }) { routes.set(p, handler); return () => { routes.delete(p) } },
  },
}
apply(ctx)
assert.deepEqual([...routes.keys()].sort(), ['/session-admin/delete', '/session-admin/state'])

/** 造一个假请求。 */
function makeReq(method, { body, headers = {} } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    headers,
    async* [Symbol.asyncIterator]() { yield* chunks },
  }
}

/** 造一个假响应，收集状态码与响应体。 */
function makeRes() {
  const state = { status: 0, body: '' }
  return {
    state,
    writeHead(status) { state.status = status },
    end(chunk) { if (chunk !== undefined) state.body += chunk.toString() },
  }
}

/** 打一次请求。 */
async function call(route, req) {
  const res = makeRes()
  await routes.get(route)(req, res)
  return { status: res.state.status, json: res.state.body === '' ? null : JSON.parse(res.state.body) }
}

// 1) 读状态
const state = await call('/session-admin/state', makeReq('GET'))
assert.equal(state.status, 200)
assert.equal(state.json.ok, true)
assert.equal(state.json.counts.archived, 1)
assert.equal(state.json.counts.onDisk, 1)
assert.equal(state.json.items[0].bytes, 4096)

// 2) 跨站直接拒
const cross = await call('/session-admin/state', makeReq('GET', { headers: { 'sec-fetch-site': 'cross-site' } }))
assert.equal(cross.status, 403)

// 3) 方法不对
const wrongMethod = await call('/session-admin/delete', makeReq('GET'))
assert.equal(wrongMethod.status, 405)

// 4) 空 ids
const empty = await call('/session-admin/delete', makeReq('POST', { body: { ids: [] } }))
assert.equal(empty.status, 400)

// 5) 未归档的删不掉
const denied = await call('/session-admin/delete', makeReq('POST', { body: { ids: ['session-keep'] } }))
assert.equal(denied.status, 200)
assert.deepEqual(denied.json.skipped, [{ id: 'session-keep', reason: 'not-archived' }])
assert.ok(await fsp.stat(path.join(bucket, 'session-keep')))

// 6) 正常删除
const removed = await call('/session-admin/delete', makeReq('POST', { body: { ids: ['session-del'] } }))
assert.equal(removed.status, 200)
assert.deepEqual(removed.json.deleted, ['session-del'])
assert.equal(removed.json.freedBytes, 4096)
assert.equal(removed.json.remainingArchived, 0)
assert.ok(removed.json.backup !== null)
await assert.rejects(() => fsp.stat(path.join(bucket, 'session-del')))
await assert.rejects(() => fsp.stat(path.join(home, 'storages', 'session_projcache', 'sessions', 'session-del.json')))

const stored = JSON.parse(await fsp.readFile(path.join(home, 'storages', 'workspace.json'), 'utf8'))
assert.deepEqual(stored.global.archivedSessionIds, [])
assert.deepEqual(stored.tables.workspaces.w1.sessionIds, ['session-keep'])

await fsp.rm(home, { recursive: true, force: true })
console.log('ROUTE SMOKE PASS')
