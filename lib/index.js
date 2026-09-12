/**
 * 规则透镜（dsh-rule-lens）· 宿主入口
 *
 * 注入通道选型说明（规格 A 要求）：
 *   rc.6 上候选通道有三：systemPrompt.section provider、scoped section、agent/pre-step 消息注入。
 *   前两者是「全局/预设作用域」的组装期通道，无法表达「本会话已注入哪些目录」这种
 *   每会话状态，也无法在会话中途（子目录第一次被触达时）追加注入。
 *   官方对标实现 dsh-agent-instructions 在 rc.6 用的就是 agent/pre-step 瀑布 +
 *   用户角色消息（createUserMessage，source.kind='plugin'），消息进会话持久日志、
 *   可审计、可回放。本插件照搬该通道，仅做大幅简化（不做文件变更 reconcile）。
 *
 * 面板通道选型说明（规格 C 要求）：
 *   rc.6 的设置页自定义槽位（settings.plugin.item）要求浏览器半侧用 React 组件注册，
 *   官方全部经构建链产出 client.js；零构建纯 ESM 手写 React 槽位在本版本不可靠，
 *   故按规格降级方案：schemastery 字段设置（installSettingsSection → settings.yaml）
 *   + ctx.webServer.register 挂 /rule-lens 面板页。
 *
 * @module dsh-rule-lens
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { appendFileSync, mkdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import {
  DEFAULT_BUDGET_BYTES,
  descendantDirsBetween,
  discoverStartupRules,
  probeOfficialLayers,
  renderInjection,
  reservedRuleDirs,
  subdirRules,
} from './rules.js'
import { createPreExecuteGuard, parseForbidRules } from './guard.js'
import { lintRuleFiles } from './lint.js'
import { createJsonlLog } from './log.js'
import { createStore } from './store.js'
import { installPanel } from './panel.js'

export const name = 'rule-lens'

/** 设置命名空间（settings.yaml 里的 section 名）。 */
export const NS = settingsNamespace('rule-lens')

/** 插件配置 schema：同时是 cordis 行配置校验与 settings 命名空间 schema。 */
export const Config = z.object({
  dshHome: z.string().description('DSH home 覆盖（默认 $DSH_HOME 或 ~/.dsh）；仅插件行配置生效，运行中改它不会迁移已有数据'),
  budgetBytes: z.number().min(1024).default(DEFAULT_BUDGET_BYTES).description('规则注入总预算（字节），超限时从作用域最宽的规则开始淘汰'),
  writeGuard: z.boolean().default(true).description('写回防护：拦截对工作区内既有 .md 文件的全文覆写'),
  whitelistDirs: z.array(z.string()).default([]).description('额外读取的规则目录名（如 .cursor），只读 ~/<dir>/rules 与 <工作区>/<dir>/rules 两个位置'),
})

/** L5 触发工具：read/write/edit 触达 + str_replace_editor（edit 类等价物）。 */
const TOUCH_TOOL_NAMES = new Set(['read', 'write', 'edit', 'str_replace_editor'])

/** 从 exec 提取触达路径（file_path / path）。 */
function touchedPathOf(exec) {
  if (!TOUCH_TOOL_NAMES.has(exec.name)) return undefined
  const args = exec.arguments
  if (typeof args !== 'object' || args === null) return undefined
  const value = args.file_path ?? args.path
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** 从 exec 推工作区：会话 header.cwd 为准，无 agent 时退化为进程 cwd。 */
function workspaceOfExec(exec) {
  return exec.agent?.session?.header?.cwd ?? process.cwd()
}

/**
 * 面板与设置共用的运行时状态工厂：把 apply 的闭包依赖打包成可测的对象。
 * @returns {object}
 */
function createRuntime(ctx, config) {
  const dshHome = resolveDshHome(config?.dshHome)
  const log = createJsonlLog(join(dshHome, 'rule-lens'), (level, message) => ctx.logger[level]?.(message))
  const store = createStore(dshHome, (level, message) => ctx.logger[level]?.(message))

  /** settings 双轨：setSource 给的是 thunk，必须存 thunk（规格要求）。 */
  let configSource = () => config
  const getConfig = () => {
    try {
      return configSource()
    } catch {
      return config
    }
  }

  /** 每会话状态：sessionId → SessionLens。 */
  const sessions = new Map()

  const sessionState = (session) => {
    const id = String(session.id)
    let st = sessions.get(id)
    if (st === undefined) {
      st = {
        id,
        cwd: session.header?.cwd ?? process.cwd(),
        createdAt: new Date().toISOString(),
        disposed: false,
        startupDone: false,
        usedBytes: 0,
        injected: [], // {layer, path, bytes, mode, evicted}
        injectedDirs: new Set(), // 已注入的 L5 目录（绝对路径）
        pendingDirs: new Map(), // dir → {files, mode}
        forbidRules: [], // 本会话已加载规则文件里解析出的 FORBID
        guardBlocks: 0,
        forbidBlocks: 0,
      }
      sessions.set(id, st)
    }
    return st
  }

  const recordRender = (st, rendered, mode) => {
    // file.preheat === true 的预热文件按 'preheat' 记账，其余按本次渲染模式
    const modeOf = (file) => (file.preheat === true ? 'preheat' : mode)
    for (const file of rendered.included) {
      st.injected.push({ layer: file.layer, path: file.displayPath, bytes: file.bytes, mode: modeOf(file), evicted: false })
      void log.logInjection({ sessionId: st.id, layer: file.layer, path: file.displayPath, bytes: file.bytes, mode: modeOf(file), evicted: false })
    }
    for (const file of rendered.evicted) {
      st.injected.push({ layer: file.layer, path: file.displayPath, bytes: file.bytes, mode: modeOf(file), evicted: true })
      void log.logInjection({ sessionId: st.id, layer: file.layer, path: file.displayPath, bytes: file.bytes, mode: modeOf(file), evicted: true })
    }
    if (rendered.evicted.length > 0) {
      ctx.logger.warn('[rule-lens] 规则预算超限，淘汰了 %d 个宽作用域文件：%s', rendered.evicted.length, rendered.evicted.map((f) => f.displayPath).join(', '))
    }
    st.usedBytes += rendered.bytes
  }

  /** 把渲染结果包成一条用户角色注入消息（官方 agent-instructions 同款通道）。 */
  const toMessage = (text) => createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: name, form: 'instructions' },
  })

  /**
   * 组装本步待注入内容：启动基线（L1/L2/白名单/L4 + 预热 L5）或按需 L5。
   * @returns {Promise<object|undefined>} UserMessage 或 undefined。
   */
  const composePending = async (st) => {
    const cfg = getConfig()
    if (!st.startupDone) {
      st.startupDone = true
      const files = await discoverStartupRules({ workspace: st.cwd, whitelistDirs: cfg.whitelistDirs })
      // 预热目录：rule-lens.json 里登记的 L5 目录随启动一起注入（tag 标记以便按 preheat 记账）
      const preheat = store.getPreheatDirs(st.cwd)
      for (const rel of preheat) {
        const dir = resolve(st.cwd, rel)
        const found = await subdirRules(dir)
        if (found !== null && !st.injectedDirs.has(dir)) {
          st.injectedDirs.add(dir)
          for (const f of found) f.preheat = true
          files.push(...found)
        }
      }
      // FORBID 解析：启动层文件 + 官方 AGENTS.md 链（让 FORBID 不依赖插件规则目录也能用）
      const forbidSources = [...files]
      for (const official of await probeOfficialLayers({ dshHome, workspace: st.cwd })) {
        if (!official.exists) continue
        try {
          const { readFile } = await import('node:fs/promises')
          forbidSources.push({ path: official.path, displayPath: official.label, content: await readFile(official.path, 'utf8') })
        } catch { /* 读失败跳过 */ }
      }
      st.forbidRules = forbidSources.flatMap((f) => parseForbidRules(f.content, f.displayPath ?? f.path))
      if (files.length === 0) return undefined
      const rendered = renderInjection(files, { budgetBytes: cfg.budgetBytes, mode: 'startup' })
      recordRender(st, rendered, 'startup') // 预热文件在 recordRender 内按 file.preheat 标为 preheat
      return toMessage(rendered.text)
    }
    if (st.pendingDirs.size === 0) return undefined
    const pending = [...st.pendingDirs.values()]
    st.pendingDirs.clear()
    const files = pending.flatMap((p) => p.files)
    const rendered = renderInjection(files, { budgetBytes: cfg.budgetBytes, alreadyUsedBytes: st.usedBytes, mode: 'ondemand' })
    recordRender(st, rendered, 'ondemand')
    for (const p of pending) for (const f of p.files) st.forbidRules.push(...parseForbidRules(f.content, f.displayPath))
    if (rendered.overBudget) {
      ctx.logger.warn('[rule-lens] 会话累计注入 %d 字节，已超出预算 %d（L5 窄规则不淘汰旧内容，仅告警）', st.usedBytes, cfg.budgetBytes)
    }
    return toMessage(rendered.text)
  }

  return { dshHome, log, store, getConfig, sessions, sessionState, composePending, setConfigSource: (thunk) => { configSource = thunk } }
}

/**
 * 插件入口。
 * @param {object} ctx cordis 插件上下文。
 * @param {object} config 行配置（已被 Config schema 解析过）。
 */
export function apply(ctx, config) {
  const rt = createRuntime(ctx, config ?? {})

  // ── 设置双轨：settings.yaml 为全局开关权威存储，rule-lens.json 为工作区状态存储 ──
  installSettingsSection(ctx, NS, Config, config ?? {}, {
    setSource: (current) => rt.setConfigSource(current),
    onChange: () => ctx.logger.info('[rule-lens] 配置已更新并生效'),
    validate: (value) => {
      for (const dir of value.whitelistDirs ?? []) {
        if (dir.includes('/') || dir.includes('\\')) throw new Error(`[rule-lens] 白名单目录必须是单段目录名：${dir}`)
      }
    },
  })

  // ── 注入通道：agent/pre-step 瀑布（官方 agent-instructions 同款） ──
  ctx.on('agent/pre-step', async ({ agent, step }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    // 首步无消息时返回 enter 会凭空造出一个模型步：照搬官方做法，留待下一步再注入
    if (step === 1 && decision.messages.length === 0) return decision
    const st = rt.sessionState(agent.session)
    try {
      const message = await rt.composePending(st)
      if (message === undefined) return decision
      return { kind: 'enter', messages: [...decision.messages, message] }
    } catch (error) {
      ctx.logger.warn('[rule-lens] 注入组装失败（本步跳过）: %o', error)
      return decision
    }
  })

  // ── L5 按需发现：read/write/edit 触达子目录后挂起注入（每目录每会话一次） ──
  ctx.on('tools/result', (exec, result) => {
    if (result.isError || exec.agent === undefined || exec.signal.aborted) return
    const touched = touchedPathOf(exec)
    if (touched === undefined) return
    const st = rt.sessionState(exec.agent.session)
    if (!st.startupDone) return // 启动注入尚未发生，触达目录会在首步后自然被发现
    const abs = isAbsolute(touched) ? resolve(touched) : resolve(st.cwd, touched)
    // 保留目录（.agents / 白名单目录）的 rules/ 已由启动层注入，不能当 L5 再注入一次
    const reserved = reservedRuleDirs(st.cwd, rt.getConfig().whitelistDirs)
    for (const dir of descendantDirsBetween(st.cwd, abs)) {
      if (reserved.has(dir)) continue
      if (st.injectedDirs.has(dir) || st.pendingDirs.has(dir)) continue
      st.pendingDirs.set(dir, { files: [], mode: 'ondemand' }) // 先占位，防并发重复读
      void subdirRules(dir).then((files) => {
        if (files === null) st.pendingDirs.delete(dir)
        else {
          st.pendingDirs.set(dir, { files, mode: 'ondemand' })
          st.injectedDirs.add(dir)
        }
      }).catch((error) => {
        st.pendingDirs.delete(dir)
        ctx.logger.warn('[rule-lens] 读取子目录规则失败 %s: %o', dir, error)
      })
    }
  })

  // ── 写回防护 + FORBID 硬规则（prepend 占瀑布首位） ──
  const onBlock = (record) => {
    const session = record.exec?.agent?.session
    const st = session === undefined ? undefined : rt.sessionState(session)
    if (st !== undefined) {
      if (record.kind === 'write-guard') st.guardBlocks += 1
      else st.forbidBlocks += 1
    }
    ctx.logger.warn('[rule-lens] 拦截 %s：%s %s', record.kind, record.tool, record.path)
    void rt.log.logCompliance({
      type: 'block',
      sessionId: st?.id ?? '',
      kind: record.kind,
      tool: record.tool,
      path: record.path,
      ...(record.rule !== undefined ? { rule: record.rule } : {}),
    })
  }
  const guard = createPreExecuteGuard({
    getConfig: rt.getConfig,
    workspaceOf: workspaceOfExec,
    forbidRulesOf: (exec) => {
      const session = exec.agent?.session
      return session === undefined ? [] : rt.sessionState(session).forbidRules
    },
    onBlock,
  })
  ctx.on('tools/pre-execute', guard, { prepend: true })

  // ── 会话结束：遵守率小结落 compliance.jsonl ──
  const flushSession = (st) => {
    if (st.guardBlocks === 0 && st.forbidBlocks === 0 && st.injected.length === 0) return
    void rt.log.logCompliance({
      type: 'session-summary',
      sessionId: st.id,
      cwd: st.cwd,
      injectedFiles: st.injected.filter((e) => !e.evicted).length,
      evictedFiles: st.injected.filter((e) => e.evicted).length,
      usedBytes: st.usedBytes,
      writeGuardBlocks: st.guardBlocks,
      forbidBlocks: st.forbidBlocks,
    })
  }
  ctx.on('session/disposed', (session) => {
    const st = rt.sessions.get(String(session.id))
    if (st === undefined) return
    st.disposed = true
    flushSession(st)
  })
  ctx.effect(() => () => {
    for (const st of rt.sessions.values()) if (!st.disposed) flushSession(st)
  }, 'rule-lens.finalFlush')

  // ── 面板：web profile 下挂 /rule-lens ──
  // 注意（rc.6 实测）：loader 并发启动各行，apply 时 webServer 的 fiber 尚未进入
  // active 态，ctx.get('webServer') 严格模式恒为 undefined（boot.log 实证）。
  // 官方惯例是声明 inject 等服务就绪（dsh-client-hmr / dsh-host-frontend-static 同款）；
  // 用嵌套 ctx.inject 而不是插件级 inject，是因为终端 profile 没有 webServer——
  // pending 的 inject fiber 停在 INACTIVE，不阻塞启动，注入/防护/日志照常工作。
  const trace = (record) => {
    try {
      mkdirSync(join(rt.dshHome, 'rule-lens'), { recursive: true })
      appendFileSync(join(rt.dshHome, 'rule-lens', 'boot.log'), JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n')
    } catch { /* 启动痕迹写失败不影响主流程 */ }
  }
  trace({ event: 'apply', panel: 'waiting-webServer' })
  ctx.inject(['webServer'], (webCtx) => {
    installPanel(webCtx, rt, webCtx.webServer, NS)
    trace({ event: 'panel-mounted', port: webCtx.webServer.port })
  })

  ctx.logger.info('[rule-lens] 规则透镜已挂载：数据目录 %s', join(rt.dshHome, 'rule-lens'))
}
