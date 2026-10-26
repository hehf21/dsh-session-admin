/**
 * dsh-session-admin 宿主半边。
 *
 * 补上 DSH 缺失的一项能力：把「已归档」的会话真正删掉。
 * 核心库只提供 archiveSession（打标记），WorkspaceRegistry 没有 delete-session，
 * SessionPersistence 也只有 create/open/flush/stat/list —— 所以删除只能在文件层做：
 *
 *   1. 删 ~/.dsh/sessions/<bucket>/<id>/（session.v4.jsonl.zstd 等）
 *   2. 删 ~/.dsh/storages/session_projcache/sessions/<id>.json（投影缓存）
 *   3. 从 ~/.dsh/storages/workspace.json 的 global.archivedSessionIds 与各
 *      workspaces[*].sessionIds 里摘掉该 id（写前留 .bak）
 *
 * 两条硬闸门，宁可不删也不误删：
 *   - 只允许删已归档集合里的会话（未归档的一律拒绝，逼用户先归档）；
 *   - 任何仍被活动 Agent 持有的会话（含当前对话）一律拒绝。
 *
 * 暴露两条精确路由给浏览器半边用，不在 /api 前缀下，靠同源 + sec-fetch-site 把关。
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** 宿主半边在 Loader 里的标识；cordis.patch.yml 的 id 要与之对应。 */
export const name = 'sessionAdmin'

/** 依赖的服务：路由注册。agents 用 ctx.get 可选取，取不到就跳过活动会话检查。 */
export const inject = ['webServer']

/** 读状态：归档清单 + 磁盘占用。 */
const ROUTE_STATE = '/session-admin/state'
/** 删除：body { ids: string[] }。 */
const ROUTE_DELETE = '/session-admin/delete'

/** 会话 id 只允许这类字符，避免把 ../ 之类的东西送进 path.join。 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

/**
 * 解析 DSH 主目录。
 * @returns {string} 主目录绝对路径（进程环境优先，其次 ~/.dsh）。
 */
function defaultHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/**
 * 去掉 BOM 后解析 JSON。
 * @param {string} file - 文件路径。
 * @returns {Promise<any>} 解析结果。
 */
async function readJson(file) {
  const raw = await fsp.readFile(file)
  const text = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
    ? raw.subarray(3).toString('utf8')
    : raw.toString('utf8')
  return JSON.parse(text)
}

/**
 * 递归求目录大小。
 * @param {string} dir - 目录。
 * @returns {Promise<number>} 字节数；读不到按 0 算。
 */
async function dirSize(dir) {
  let total = 0
  const walk = async (current) => {
    let entries
    try {
      entries = await fsp.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile()) {
        try {
          total += (await fsp.stat(full)).size
        } catch {
          // 文件在扫描途中消失，忽略。
        }
      }
    }
  }
  await walk(dir)
  return total
}

/**
 * 造一套只依赖 home 的读写器，便于测试时换根目录。
 * @param {{ home?: string, agents?: any }} options - home 覆盖与活动 Agent 服务。
 * @returns {object} 状态查询与删除操作。
 */
export function createAdmin(options = {}) {
  const home = options.home ?? defaultHome()
  const agents = options.agents

  const paths = {
    sessions: path.join(home, 'sessions'),
    workspace: path.join(home, 'storages', 'workspace.json'),
    projCache: path.join(home, 'storages', 'session_projcache', 'sessions'),
  }

  /**
   * 扫磁盘上所有 bucket 下的会话目录。
   * @returns {Promise<Map<string, {bucket: string, dir: string}>>} id → 位置。
   */
  async function locateSessions() {
    const found = new Map()
    let buckets
    try {
      buckets = await fsp.readdir(paths.sessions, { withFileTypes: true })
    } catch {
      return found
    }
    for (const bucket of buckets) {
      if (!bucket.isDirectory()) continue
      const bucketDir = path.join(paths.sessions, bucket.name)
      let ids
      try {
        ids = await fsp.readdir(bucketDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const id of ids) {
        if (!id.isDirectory()) continue
        found.set(id.name, { bucket: bucket.name, dir: path.join(bucketDir, id.name) })
      }
    }
    return found
  }

  /**
   * 判断会话是否仍被活动 Agent 持有。
   * @param {string} id - 会话 id。
   * @returns {boolean} 有活着的 Agent 时为 true。
   */
  function isLive(id) {
    if (agents === undefined || typeof agents.get !== 'function') return false
    try {
      return agents.get(id) !== undefined
    } catch {
      return false
    }
  }

  /**
   * 归档会话清单（带大小、时间、是否还有数据）。
   * @returns {Promise<object>} 给浏览器半边的状态快照。
   */
  async function state() {
    let archived = []
    let workspaceError = null
    try {
      const data = await readJson(paths.workspace)
      archived = Array.isArray(data?.global?.archivedSessionIds) ? data.global.archivedSessionIds : []
    } catch (error) {
      workspaceError = error instanceof Error ? error.message : String(error)
    }
    const located = await locateSessions()
    const items = []
    for (const id of archived) {
      const hit = located.get(id)
      let bytes = 0
      let mtimeMs = null
      if (hit !== undefined) {
        bytes = await dirSize(hit.dir)
        try {
          mtimeMs = (await fsp.stat(hit.dir)).mtimeMs
        } catch {
          mtimeMs = null
        }
      }
      items.push({
        id,
        bucket: hit?.bucket ?? null,
        onDisk: hit !== undefined,
        bytes,
        mtimeMs,
        live: isLive(id),
      })
    }
    items.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))
    return {
      home,
      workspaceError,
      counts: {
        archived: items.length,
        onDisk: items.filter(item => item.onDisk).length,
        bytes: items.reduce((sum, item) => sum + item.bytes, 0),
      },
      items,
    }
  }

  /**
   * 删除指定会话：只认归档集合里的 id，活着的拒删。
   * @param {string[]} ids - 会话 id 列表。
   * @returns {Promise<object>} 每个 id 的处理结果与剩余归档数。
   */
  async function remove(ids) {
    const unique = [...new Set(ids)]
    for (const id of unique) {
      if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
        throw new Error(`非法会话 id：${String(id)}`)
      }
    }

    const data = await readJson(paths.workspace)
    const archived = new Set(Array.isArray(data?.global?.archivedSessionIds) ? data.global.archivedSessionIds : [])
    const located = await locateSessions()

    const deleted = []
    const skipped = []
    let freedBytes = 0

    for (const id of unique) {
      if (!archived.has(id)) {
        skipped.push({ id, reason: 'not-archived' })
        continue
      }
      if (isLive(id)) {
        skipped.push({ id, reason: 'live' })
        continue
      }
      const hit = located.get(id)
      if (hit === undefined) {
        // 数据早就没了，只剩标记：仍然放行，下面统一清标记。
        skipped.push({ id, reason: 'no-data' })
        continue
      }
      const bytes = await dirSize(hit.dir)
      await fsp.rm(hit.dir, { recursive: true, force: true })
      freedBytes += bytes
      for (const name of [id, id.startsWith('session-') ? id.slice(8) : id]) {
        await fsp.rm(path.join(paths.projCache, `${name}.json`), { force: true }).catch(() => {})
      }
      deleted.push(id)
    }
    // 标记清理：删除成功的 + 本来就没数据的，都从归档集合与工作区清单里摘掉。
    const gone = new Set([
      ...deleted,
      ...skipped.filter(entry => entry.reason === 'no-data').map(entry => entry.id),
    ])
    let backup = null
    let remainingArchived = archived.size
    if (gone.size > 0) {
      data.global.archivedSessionIds = (data.global.archivedSessionIds ?? []).filter(id => !gone.has(id))
      const workspaces = data?.tables?.workspaces ?? {}
      for (const workspace of Object.values(workspaces)) {
        if (Array.isArray(workspace.sessionIds)) {
          workspace.sessionIds = workspace.sessionIds.filter(id => !gone.has(id))
        }
      }
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
      backup = `${paths.workspace}.bak-session-admin-${stamp}`
      await fsp.copyFile(paths.workspace, backup)
      const tmp = `${paths.workspace}.tmp-session-admin`
      await fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
      await fsp.rename(tmp, paths.workspace)
      remainingArchived = data.global.archivedSessionIds.length
    }

    return {
      deleted,
      skipped,
      freedMB: Math.round((freedBytes / 1048576) * 100) / 100,
      freedBytes,
      remainingArchived,
      backup,
      // 宿主仍按内存里的旧集合渲染，回写时可能把标记写回来；重启后自动剪掉。
      needRestart: deleted.length > 0,
    }
  }

  return { state, remove, paths }
}

/**
 * 读请求体 JSON。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {Promise<any>} 解析后的 body（空体为 {}）。
 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 65536) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  return text === '' ? {} : JSON.parse(text)
}

/**
 * 装路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主根上下文。
 */
export function apply(ctx) {
  const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  const admin = createAdmin({ agents })

  /**
   * 同源校验：浏览器自带的 sec-fetch-site 是这里唯一稳的判据。
   * @param {import('node:http').IncomingMessage} req - 请求。
   * @param {import('node:http').ServerResponse} res - 响应。
   * @returns {boolean} 允许继续处理时为 true。
   */
  function allowed(req, res) {
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: 'forbidden' }))
      return false
    }
    return true
  }

  /**
   * 统一发 JSON。
   * @param {import('node:http').ServerResponse} res - 响应。
   * @param {number} status - 状态码。
   * @param {object} body - 响应体。
   */
  function send(res, status, body) {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
  }

  /** 状态路由（GET / HEAD）。 */
  async function handleState(req, res) {
    if (!allowed(req, res)) return
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }
    try {
      const snapshot = await admin.state()
      if (req.method === 'HEAD') {
        res.writeHead(200)
        res.end()
        return
      }
      send(res, 200, { ok: true, ...snapshot })
    } catch (error) {
      send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** 删除路由（POST JSON）。 */
  async function handleDelete(req, res) {
    if (!allowed(req, res)) return
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    try {
      const body = await readBody(req)
      const ids = Array.isArray(body?.ids) ? body.ids : []
      if (ids.length === 0) {
        send(res, 400, { ok: false, error: 'ids 为空' })
        return
      }
      if (ids.length > 500) {
        send(res, 400, { ok: false, error: '一次最多 500 个' })
        return
      }
      const result = await admin.remove(ids)
      send(res, 200, { ok: true, ...result })
    } catch (error) {
      send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE_STATE, handler: handleState }),
    'dsh-session-admin: state route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE_DELETE, handler: handleDelete }),
    'dsh-session-admin: delete route',
  )
}
