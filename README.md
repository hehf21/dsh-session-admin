# dsh-session-admin

补上 DSH 缺的那一刀：**把已归档的会话真正删掉**。

DSH 核心只提供 `archiveSession`（打标记），`WorkspaceRegistry` 没有 delete-session，`SessionPersistence` 也只有 create/open/flush/stat/list，所以界面里删不掉会话。本插件在宿主注册两条精确路由，把「删日志文件 + 删投影缓存 + 摘归档标记」这套原本要手写脚本的活固化成接口，并在侧栏底部给一个入口。

## 界面

侧栏底部（设置上方）多一行「🧹 会话清理」，点开是面板：

- 列出全部已归档会话：id、占用大小、最后活动时间、是否有数据、是否正在运行；
- 勾选后「删除选中」，或「全部删除」；
- 删除前弹二次确认；执行完显示释放了多少、剩多少归档，并提示刷新页面同步侧栏。

## 两条硬闸门

1. **只删已归档会话**：不在 `global.archivedSessionIds` 里的 id 一律拒绝（返回 `not-archived`）。要删常用会话，先在侧栏归档。
2. **活着的拒删**：`ctx.agents.get(id)` 能拿到的会话（含当前对话）一律拒绝（返回 `live`）。

另外路由只接受同源请求（`sec-fetch-site` 判据）、删除必须是 POST、单次最多 500 个 id、id 走 `^[A-Za-z0-9_-]{1,128}$` 白名单后才进文件路径。

## 路由

```text
GET  /session-admin/state
  → { ok, home, counts:{archived,onDisk,bytes}, items:[{id,bucket,onDisk,bytes,mtimeMs,live}] }

POST /session-admin/delete   body: { ids: string[] }
  → { ok, deleted:[], skipped:[{id,reason}], freedBytes, freedMB, remainingArchived, backup, needRestart }
```

`reason` 取值：`not-archived`（未归档）、`live`（运行中）、`no-data`（只剩标记，数据早没了；此时仍会顺手清标记）。

## 删除到底动了什么

1. `~/.dsh/sessions/<bucket>/<id>/`（`session.v4.jsonl.zstd` 等）整目录移除；
2. `~/.dsh/storages/session_projcache/sessions/<id>.json` 投影缓存移除；
3. `~/.dsh/storages/workspace.json`：从 `global.archivedSessionIds` 与各 `workspaces[*].sessionIds` 里摘掉该 id，写前留 `.bak-session-admin-<时间戳>`。

已知行为：宿主进程仍按内存里的旧集合渲染，之后若有其它操作触发它回写 `workspace.json`，标记可能被写回；此时会话数据已不在，重启后启动期会把这些"指向不存在会话"的标记自动剪掉。面板里的「刷新页面」用于让侧栏立刻同步。

## 安装（本机）

```powershell
dsh plugin --profile desktop add 'link:D:/大龙虾/dsh-plugins/dsh-session-admin'
```

`dsh plugin` 会同时把包名写进 profile `package.json` 的 `dependencies` 与 `dsh.profile.bundles`，并在 `node_modules` 建 junction。装完**重启一次 DSH 桌面**（宿主半边是进程内插件，不重启不生效），浏览器侧刷新页面即可看到侧栏入口。

回滚：

```powershell
dsh plugin --profile desktop remove dsh-session-admin
```

（必要时把 profile 的 `package.json.bak-session-admin-20261026`、`pnpm-lock.yaml.bak-session-admin-20261026` 覆盖回去。）

## 自测

`tests/` 下三个脚本都不依赖真实 DSH 运行（临时 DSH_HOME、桩 Context、无 React 的最小 hook 运行时）：

```powershell
node tests/session-admin-test.mjs         # 删除核心逻辑（临时 DSH_HOME）
node tests/session-admin-route-test.mjs   # 桩 Context 打两条路由
node tests/session-admin-client-test.mjs  # 最小 hook 运行时渲面板并点删除
```

## 许可

MIT

