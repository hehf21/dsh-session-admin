/**
 * dsh-session-admin 宿主逻辑的自测：用临时目录造一套假 DSH_HOME，
 * 覆盖「删归档会话 / 拒删未归档 / 拒删运行中 / 清无数据标记」四条路径。
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createAdmin } from '../index.js'

const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-session-admin-'))

async function seed() {
  const bucket = path.join(home, 'sessions', '--D-demo--')
  for (const id of ['session-a', 'session-b', 'session-live']) {
    await fsp.mkdir(path.join(bucket, id), { recursive: true })
    await fsp.writeFile(path.join(bucket, id, 'session.v4.jsonl.zstd'), 'x'.repeat(2048))
  }
  const cache = path.join(home, 'storages', 'session_projcache', 'sessions')
  await fsp.mkdir(cache, { recursive: true })
  for (const id of ['session-a', 'session-b', 'session-live']) {
    await fsp.writeFile(path.join(cache, `${id}.json`), '{}')
  }
  const workspace = {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      workspaceIds: ['w1'],
      archivedSessionIds: ['session-a', 'session-b', 'session-live', 'session-gone'],
      pinnedSessionIds: [],
    },
    tables: {
      workspaces: {
        w1: { path: 'D:\\demo', title: 'demo', sessionIds: ['session-a', 'session-b', 'session-live', 'keep-me'] },
      },
    },
  }
  await fsp.mkdir(path.join(home, 'storages'), { recursive: true })
  await fsp.writeFile(path.join(home, 'storages', 'workspace.json'), JSON.stringify(workspace, null, 2))
}

await seed()

// 假装 session-live 仍被活动 Agent 持有。
const fakeAgents = { get: (id) => (id === 'session-live' ? { id } : undefined) }
const admin = createAdmin({ home, agents: fakeAgents })

const before = await admin.state()
assert.equal(before.counts.archived, 4)
assert.equal(before.counts.onDisk, 3)
assert.equal(before.items.find(item => item.id === 'session-gone').onDisk, false)
assert.equal(before.items.find(item => item.id === 'session-live').live, true)
console.log('state ok:', before.counts)

const result = await admin.remove(['session-a', 'session-b', 'session-live', 'session-gone', 'keep-me'])
console.log('remove ok:', JSON.stringify(result))

assert.deepEqual(result.deleted.sort(), ['session-a', 'session-b'])
assert.deepEqual(
  result.skipped.sort((a, b) => a.id.localeCompare(b.id)),
  [
    { id: 'keep-me', reason: 'not-archived' },
    { id: 'session-gone', reason: 'no-data' },
    { id: 'session-live', reason: 'live' },
  ].sort((a, b) => a.id.localeCompare(b.id)),
)
assert.equal(result.remainingArchived, 1, '只有仍活着的那条留作归档')

const stored = JSON.parse(await fsp.readFile(path.join(home, 'storages', 'workspace.json'), 'utf8'))
assert.deepEqual(stored.global.archivedSessionIds, ['session-live'])
assert.deepEqual(stored.tables.workspaces.w1.sessionIds, ['session-live', 'keep-me'])

const bucket = path.join(home, 'sessions', '--D-demo--')
assert.deepEqual((await fsp.readdir(bucket)).sort(), ['session-live'])
assert.deepEqual((await fsp.readdir(path.join(home, 'storages', 'session_projcache', 'sessions'))).sort(), ['session-live.json'])
assert.ok(result.backup !== null, '写前应留备份')
assert.ok((await fsp.stat(result.backup)).size > 0)

// 非法 id 必须直接抛错，不进 path.join。
await assert.rejects(() => admin.remove(['../escape']), /非法会话 id/)

const after = await admin.state()
assert.equal(after.counts.archived, 1)
console.log('after:', after.counts)

await fsp.rm(home, { recursive: true, force: true })
console.log('ALL PASS')
