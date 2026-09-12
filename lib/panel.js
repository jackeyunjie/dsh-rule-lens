/**
 * 规则透镜 · /rule-lens 面板（webServer 路由 + 单文件 HTML）
 *
 * 降级方案的落地（规格 C）：自定义 settings client UI 在 rc.6 需要构建链产物的
 * React 组件注册进 settings.plugin.item 槽位，零构建不可靠；因此面板走
 * ctx.webServer.register，与 dsh-global-rules 式做法一致。
 *
 * 路由：
 *   GET  /rule-lens                 面板页（自包含 HTML，零外部依赖）
 *   GET  /rule-lens/api/state       状态快照 JSON
 *   POST /rule-lens/api/config      改全局开关（写 settings.yaml，经 schema 校验）
 *   POST /rule-lens/api/preheat     改某工作区某 L5 目录的预热开关（写 rule-lens.json）
 *   GET  /rule-lens/api/export?file=log|compliance  下载 JSONL
 *
 * @module dsh-rule-lens/panel
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { discoverStartupRules, probeOfficialLayers, scanWorkspaceRuleDirs, subdirRules } from './rules.js'
import { lintRuleFiles } from './lint.js'

/** 读 POST JSON body（上限 64KB，够用即可）。 */
function readJsonBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 65536) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value, null, 2)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

/**
 * 组装面板状态快照。
 * @param {object} ctx 宿主插件上下文。
 * @param {object} rt createRuntime 产物。
 */
async function buildState(ctx, rt) {
  const cfg = rt.getConfig()
  const sessionList = [...rt.sessions.values()]
  // 面板聚焦「最近活跃会话」的工作区；无会话时退化为进程 cwd
  const active = sessionList.filter((st) => !st.disposed).at(-1) ?? sessionList.at(-1)
  const workspace = active?.cwd ?? process.cwd()

  // 插件管理的规则位置（含内容，供 lint 复用）
  const startupFiles = await discoverStartupRules({ workspace, whitelistDirs: cfg.whitelistDirs ?? [] })
  const official = await probeOfficialLayers({ dshHome: rt.dshHome, workspace })
  const l5Dirs = await scanWorkspaceRuleDirs(workspace, { whitelistDirs: cfg.whitelistDirs ?? [] })
  const preheatDirs = rt.store.getPreheatDirs(workspace)
  const workspaceSessions = sessionList.filter((st) => st.cwd === workspace)
  const injectedDirSet = new Set(workspaceSessions.flatMap((st) => [...st.injectedDirs]))

  // L5 目录内容（lint 用），有界：只对扫描到且存在的目录读内容
  const l5Files = []
  for (const dir of l5Dirs.slice(0, 50)) {
    const files = await subdirRules(dir.dir)
    if (files !== null) l5Files.push(...files)
  }
  const lint = lintRuleFiles([...startupFiles, ...l5Files])

  // 遵守率摘要：内存中的会话计数 + compliance.jsonl 历史聚合
  const complianceHistory = await rt.log.readTail('compliance', 500)
  const historyBlocks = complianceHistory.filter((e) => e.type === 'block')
  const historySummaries = complianceHistory.filter((e) => e.type === 'session-summary')

  const injectedThisWorkspace = workspaceSessions.flatMap((st) => st.injected)
  return {
    generatedAt: new Date().toISOString(),
    config: {
      budgetBytes: cfg.budgetBytes,
      writeGuard: cfg.writeGuard !== false,
      whitelistDirs: cfg.whitelistDirs ?? [],
    },
    settingsWritable: ctx.get('settings')?.writable === true,
    paths: {
      dshHome: rt.dshHome,
      log: rt.log.logPath,
      compliance: rt.log.compliancePath,
      store: rt.store.path,
      settingsHint: '~/.dsh/settings.yaml 的 rule-lens 节',
    },
    workspace,
    budget: {
      limit: cfg.budgetBytes,
      usedBytes: workspaceSessions.reduce((sum, st) => sum + st.usedBytes, 0),
      loadedDirs: injectedDirSet.size,
      evicted: injectedThisWorkspace.filter((e) => e.evicted),
    },
    official,
    pluginFiles: startupFiles.map((f) => ({
      layer: f.layer,
      path: f.displayPath,
      bytes: f.bytes,
      injected: injectedThisWorkspace.some((e) => e.path === f.displayPath && !e.evicted),
      evicted: injectedThisWorkspace.some((e) => e.path === f.displayPath && e.evicted),
    })),
    l5: l5Dirs.map((dir) => ({
      rel: dir.rel,
      fileCount: dir.fileCount,
      bytes: dir.bytes,
      preheat: preheatDirs.includes(dir.rel),
      injected: injectedDirSet.has(resolve(workspace, dir.rel)),
    })),
    sessions: sessionList.map((st) => ({
      id: st.id,
      cwd: st.cwd,
      createdAt: st.createdAt,
      disposed: st.disposed,
      startupDone: st.startupDone,
      usedBytes: st.usedBytes,
      injected: st.injected,
      guardBlocks: st.guardBlocks,
      forbidBlocks: st.forbidBlocks,
    })),
    lint,
    compliance: {
      sessionBlocks: sessionList.reduce((sum, st) => sum + st.guardBlocks + st.forbidBlocks, 0),
      historyBlockCount: historyBlocks.length,
      recentBlocks: historyBlocks.slice(-20).reverse(),
      recentSummaries: historySummaries.slice(-10).reverse(),
    },
  }
}

/**
 * 挂面板路由。
 * @param {object} ctx 宿主插件上下文（用于读 settings 服务）。
 * @param {object} rt createRuntime 产物。
 * @param {object} webServer dsh-host-webserver 服务。
 * @param {string} ns 设置命名空间（写回 settings.yaml 用）。
 */
export function installPanel(ctx, rt, webServer, ns) {
  webServer.register({
    kind: 'exact',
    path: '/rule-lens',
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(PANEL_HTML)
    },
  })

  webServer.register({
    kind: 'prefix',
    path: '/rule-lens/api',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const sub = url.pathname.slice('/rule-lens/api'.length)
      try {
        if (sub === '/state' && req.method === 'GET') {
          sendJson(res, 200, await buildState(ctx, rt))
          return
        }
        if (sub === '/config' && req.method === 'POST') {
          const settings = ctx.get('settings')
          if (settings === undefined || settings.writable !== true) {
            sendJson(res, 503, { error: 'settings 服务不可写，请直接编辑 ~/.dsh/settings.yaml 的 rule-lens 节' })
            return
          }
          const body = await readJsonBody(req)
          const patch = {}
          if (typeof body.writeGuard === 'boolean') patch.writeGuard = body.writeGuard
          if (typeof body.budgetBytes === 'number') patch.budgetBytes = body.budgetBytes
          if (Array.isArray(body.whitelistDirs)) patch.whitelistDirs = body.whitelistDirs.filter((d) => typeof d === 'string')
          await settings.update(ns, patch)
          sendJson(res, 200, { ok: true })
          return
        }
        if (sub === '/preheat' && req.method === 'POST') {
          const body = await readJsonBody(req)
          if (typeof body.workspace !== 'string' || typeof body.dir !== 'string' || typeof body.enabled !== 'boolean') {
            sendJson(res, 400, { error: '需要 {workspace, dir, enabled}' })
            return
          }
          await rt.store.setPreheatDir(body.workspace, body.dir, body.enabled)
          // 若该工作区有活着的会话，立即挂起注入（下一步生效），不必等重启
          if (body.enabled) {
            const dir = resolve(body.workspace, body.dir)
            for (const st of rt.sessions.values()) {
              if (st.cwd !== body.workspace || st.disposed || !st.startupDone) continue
              if (st.injectedDirs.has(dir) || st.pendingDirs.has(dir)) continue
              const files = await subdirRules(dir)
              if (files !== null) {
                st.pendingDirs.set(dir, { files, mode: 'preheat' })
                st.injectedDirs.add(dir)
              }
            }
          }
          sendJson(res, 200, { ok: true })
          return
        }
        if (sub === '/export' && req.method === 'GET') {
          const which = url.searchParams.get('file')
          const path = which === 'log' ? rt.log.logPath : which === 'compliance' ? rt.log.compliancePath : undefined
          if (path === undefined) {
            sendJson(res, 400, { error: 'file 参数只支持 log / compliance' })
            return
          }
          let content
          try {
            content = await readFile(path, 'utf8')
          } catch {
            content = ''
          }
          res.writeHead(200, {
            'content-type': 'application/x-ndjson; charset=utf-8',
            'content-disposition': `attachment; filename="rule-lens-${which}.jsonl"`,
          })
          res.end(content)
          return
        }
        sendJson(res, 404, { error: 'unknown endpoint' })
      } catch (error) {
        sendJson(res, 500, { error: String(error?.message ?? error) })
      }
    },
  })
  ctx.logger.info('[rule-lens] 面板已挂载：/rule-lens')
}

/** 面板页：自包含 HTML，无外部依赖，数据全部 fetch 自 /rule-lens/api/state。 */
const PANEL_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>规则透镜 · dsh-rule-lens</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: -apple-system, "PingFang SC", sans-serif; background: #14161a; color: #d7dbe0; margin: 0; padding: 24px; max-width: 1080px; margin-inline: auto; }
  h1 { font-size: 20px; } h2 { font-size: 15px; margin-top: 28px; border-bottom: 1px solid #2c313a; padding-bottom: 6px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  td, th { border-bottom: 1px solid #242830; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { color: #8b929e; font-weight: 500; }
  code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .tag { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 11px; margin-right: 4px; }
  .t-official { background: #2d3a52; color: #9db8e8; }
  .t-plugin { background: #24473a; color: #8fdcb4; }
  .t-on { background: #1f5138; color: #7fe0a8; }
  .t-off { background: #3a3f47; color: #9aa1ab; }
  .t-warn { background: #54402a; color: #f0c581; }
  .bar { background: #242830; border-radius: 6px; height: 14px; overflow: hidden; margin: 6px 0; }
  .bar > div { height: 100%; background: #3f8cff; }
  .bar.over > div { background: #e0635c; }
  button { background: #2c313a; color: #d7dbe0; border: 1px solid #3a4150; border-radius: 6px; padding: 4px 12px; cursor: pointer; font-size: 12px; }
  button:hover { background: #363c47; }
  input[type=text], input[type=number] { background: #1c1f24; border: 1px solid #3a4150; color: #d7dbe0; border-radius: 6px; padding: 4px 8px; font-size: 12px; }
  .muted { color: #8b929e; font-size: 12px; }
  .warn-row { color: #f0c581; }
  .card { background: #1a1d22; border: 1px solid #262b33; border-radius: 10px; padding: 14px 16px; margin-top: 10px; }
  a { color: #7fb4ff; }
</style>
</head>
<body>
<h1>🔍 规则透镜 <span class="muted">dsh-rule-lens</span></h1>
<div id="app" class="muted">加载中…</div>
<script>
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }
function fmtBytes(n) { return n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B' }
function post(url, body) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(function (r) { return r.json() })
}
function layerStatus(row) {
  if (row.evicted) return '<span class="tag t-warn">已淘汰</span>'
  if (row.injected) return '<span class="tag t-on">已注入</span>'
  return '<span class="tag t-off">已启用（存在会加载）</span>'
}
function render(s) {
  var html = ''
  // 概览 + 预算条
  var pct = s.budget.limit > 0 ? Math.min(100, Math.round(100 * s.budget.usedBytes / s.budget.limit)) : 0
  var over = s.budget.usedBytes > s.budget.limit
  html += '<h2>概览</h2><div class="card">'
  html += '<div>工作区：<code>' + esc(s.workspace) + '</code></div>'
  html += '<div class="muted">注入预算（本会话工作区累计）' + fmtBytes(s.budget.usedBytes) + ' / ' + fmtBytes(s.budget.limit) + '，已加载 L5 目录 ' + s.budget.loadedDirs + ' 个</div>'
  html += '<div class="bar' + (over ? ' over' : '') + '"><div style="width:' + pct + '%"></div></div>'
  if (s.budget.evicted.length > 0) {
    html += '<div class="warn-row">⚠ 有淘汰：' + s.budget.evicted.map(function (e) { return esc(e.path) }).join('、') + '</div>'
  }
  html += '</div>'
  // 规则位置表
  html += '<h2>规则位置</h2><table><tr><th>位置</th><th>责任方</th><th>状态</th><th>大小</th></tr>'
  s.official.forEach(function (o) {
    html += '<tr><td class="mono">' + esc(o.label) + '</td><td><span class="tag t-official">官方</span></td><td>'
      + (o.exists ? '<span class="tag t-on">存在（官方注入）</span>' : '<span class="tag t-off">不存在</span>') + '</td><td></td></tr>'
  })
  s.pluginFiles.forEach(function (f) {
    html += '<tr><td class="mono">' + esc(f.path) + '</td><td><span class="tag t-plugin">插件</span> ' + esc(f.layer) + '</td><td>'
      + layerStatus(f) + '</td><td class="mono">' + fmtBytes(f.bytes) + '</td></tr>'
  })
  html += '</table>'
  // L5 预热开关
  html += '<h2>L5 子目录规则（按需注入 / 预热开关）</h2>'
  if (s.l5.length === 0) html += '<div class="muted">当前工作区未发现含 rules/*.md 的子目录</div>'
  else {
    html += '<table><tr><th>目录</th><th>文件数</th><th>大小</th><th>状态</th><th>预热</th></tr>'
    s.l5.forEach(function (d) {
      html += '<tr><td class="mono">' + esc(d.rel) + '/rules/</td><td>' + d.fileCount + '</td><td class="mono">' + fmtBytes(d.bytes) + '</td><td>'
        + (d.injected ? '<span class="tag t-on">已注入</span>' : '<span class="tag t-off">待触达</span>') + '</td><td>'
        + '<button data-preheat="' + esc(d.rel) + '" data-enabled="' + (d.preheat ? '0' : '1') + '">' + (d.preheat ? '关闭预热' : '开启预热') + '</button></td></tr>'
    })
    html += '</table><div class="muted">预热 = 会话启动即注入，不必等子目录被触达；开启后对当前活会话下一步即生效。</div>'
  }
  // 设置
  html += '<h2>设置</h2><div class="card">'
  html += '<div>写回防护：<button id="toggleGuard">' + (s.config.writeGuard ? '已开启（点击关闭）' : '已关闭（点击开启）') + '</button></div>'
  html += '<div style="margin-top:8px">预算上限（字节）：<input type="number" id="budgetInput" value="' + s.config.budgetBytes + '" min="1024" step="1024"> <button id="saveBudget">保存</button></div>'
  html += '<div style="margin-top:8px">白名单目录（逗号分隔，如 .cursor）：<input type="text" id="whitelistInput" value="' + esc(s.config.whitelistDirs.join(',')) + '" size="30"> <button id="saveWhitelist">保存</button></div>'
  html += '<div class="muted" style="margin-top:8px">写入 ' + esc(s.paths.settingsHint) + (s.settingsWritable ? '' : '（settings 服务不可写，请手改 YAML）') + '</div>'
  html += '</div>'
  // Lint
  html += '<h2>规则 Lint</h2>'
  if (s.lint.length === 0) html += '<div class="muted">✅ 全部规则文件通过体检</div>'
  else {
    html += '<table><tr><th>文件</th><th>警告</th></tr>'
    s.lint.forEach(function (f) {
      html += '<tr><td class="mono">' + esc(f.displayPath) + '</td><td class="warn-row">' + f.warnings.map(esc).join('<br>') + '</td></tr>'
    })
    html += '</table>'
  }
  // 遵守率
  html += '<h2>遵守率（拦截 = 兜底成功）</h2><div class="card">'
  html += '<div>本会话集拦截 <b>' + s.compliance.sessionBlocks + '</b> 次；历史记录共 ' + s.compliance.historyBlockCount + ' 次</div>'
  s.compliance.recentSummaries.forEach(function (m) {
    html += '<div class="muted">' + esc(m.ts) + ' 会话 ' + esc(String(m.sessionId).slice(0, 8)) + '：注入 ' + m.injectedFiles + ' 文件 / 淘汰 ' + m.evictedFiles + ' / 写回防护 ' + m.writeGuardBlocks + ' / FORBID ' + m.forbidBlocks + '</div>'
  })
  s.compliance.recentBlocks.forEach(function (b) {
    html += '<div>' + esc(b.ts) + ' <span class="tag t-warn">' + esc(b.kind) + '</span> <code>' + esc(b.tool) + '</code> ' + esc(b.path) + (b.rule ? '（' + esc(b.rule) + '）' : '') + '</div>'
  })
  html += '</div>'
  // 日志导出
  html += '<h2>日志导出</h2><div class="card">'
  html += '<div class="mono">' + esc(s.paths.log) + '<br>' + esc(s.paths.compliance) + '<br>' + esc(s.paths.store) + '</div>'
  html += '<div style="margin-top:8px"><a href="/rule-lens/api/export?file=log"><button>下载 log.jsonl</button></a> '
  html += '<a href="/rule-lens/api/export?file=compliance"><button>下载 compliance.jsonl</button></a></div>'
  html += '</div>'
  document.getElementById('app').innerHTML = html
  bind(s)
}
function bind(s) {
  document.querySelectorAll('[data-preheat]').forEach(function (btn) {
    btn.onclick = function () {
      post('/rule-lens/api/preheat', { workspace: s.workspace, dir: btn.getAttribute('data-preheat'), enabled: btn.getAttribute('data-enabled') === '1' }).then(load)
    }
  })
  var guard = document.getElementById('toggleGuard')
  if (guard) guard.onclick = function () { post('/rule-lens/api/config', { writeGuard: !s.config.writeGuard }).then(load) }
  var budget = document.getElementById('saveBudget')
  if (budget) budget.onclick = function () {
    post('/rule-lens/api/config', { budgetBytes: Number(document.getElementById('budgetInput').value) }).then(load)
  }
  var wl = document.getElementById('saveWhitelist')
  if (wl) wl.onclick = function () {
    var dirs = document.getElementById('whitelistInput').value.split(',').map(function (x) { return x.trim() }).filter(Boolean)
    post('/rule-lens/api/config', { whitelistDirs: dirs }).then(load)
  }
}
function load() {
  fetch('/rule-lens/api/state').then(function (r) { return r.json() }).then(render).catch(function (e) {
    document.getElementById('app').textContent = '加载失败：' + e
  })
}
load()
</script>
</body>
</html>
`
