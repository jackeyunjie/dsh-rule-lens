/**
 * 规则透镜 · 写回防护 + FORBID 硬规则拦截
 *
 * 两条防线都挂在 tools/pre-execute 瀑布（{ prepend: true } 占首位）：
 *   1. 写回防护：write 类工具（全量覆写）目标是工作区内「已存在」的 .md 文件 → deny。
 *      不拦：新建文件、非 .md、edit 类工具、工作区外文件。可在设置中关闭。
 *   2. FORBID 硬规则：规则文件里声明 `FORBID: <工具名glob> <路径glob>` 的行
 *      （如 `FORBID: write *.env`），命中即 deny。
 * 每次拦截都通过 onBlock 回调记入遵守率数据（拦截即兜底成功）。
 *
 * @module dsh-rule-lens/guard
 */
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** 写回防护 deny 理由的法定结尾（规格要求逐字）。 */
export const WRITE_GUARD_SUFFIX = '若确实需要全文重写，请先向用户说明理由并取得同意'

/** FORBID 行格式：FORBID: <工具名glob> <路径glob>（路径 glob 允许含空格，取到行尾）。 */
const FORBID_LINE = /^\s*FORBID:\s+(\S+)\s+(.+?)\s*$/

/** 提取路径参数时识别的参数字段（read/write/edit 用 file_path，str_replace_editor 用 path）。 */
const PATH_ARG_KEYS = ['file_path', 'path']

/**
 * 把 glob 转成 RegExp：* 匹配任意非 / 字符，** 匹配任意字符，? 匹配单个非 / 字符。
 * anyMode 下 * 也跨 /（用于 bash 命令串这类无路径语义的目标）。
 * @param {string} glob
 * @param {boolean} [anyMode]
 * @returns {RegExp}
 */
export function globToRegExp(glob, anyMode = false) {
  let source = ''
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        source += '.*'
        i += 1
      } else {
        source += anyMode ? '.*' : '[^/]*'
      }
    } else if (c === '?') {
      source += anyMode ? '.' : '[^/]'
    } else {
      source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

/**
 * 从规则文本中解析 FORBID 硬规则行。
 * @param {string} content 规则文件内容。
 * @param {string} source 来源文件（用于 deny 理由与面板展示）。
 * @returns {Array<{tool: string, path: string, source: string, toolRe: RegExp, pathRe: RegExp}>}
 */
export function parseForbidRules(content, source) {
  const rules = []
  for (const line of content.split('\n')) {
    const match = FORBID_LINE.exec(line)
    if (match === null) continue
    rules.push({
      tool: match[1],
      path: match[2],
      source,
      toolRe: globToRegExp(match[1]),
      pathRe: match[2] === '*' ? null : globToRegExp(match[2]),
      anyRe: match[2] === '*' ? null : globToRegExp(match[2], true),
    })
  }
  return rules
}

/**
 * 提取工具调用的「目标字符串」：文件工具取路径参数，bash 取命令串。
 * @param {object} exec ToolExecution。
 * @returns {string|undefined}
 */
export function extractTarget(exec) {
  const args = exec.arguments
  if (typeof args !== 'object' || args === null) return undefined
  for (const key of PATH_ARG_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  if (exec.name === 'bash' && typeof args.command === 'string') return args.command
  return undefined
}

/** 目标是否在工作区内（含工作区根本身）。 */
export function insideWorkspace(absPath, workspace) {
  const root = resolve(workspace)
  return absPath === root || absPath.startsWith(root + sep)
}

/**
 * 创建 tools/pre-execute 处理器。
 * @param {object} deps
 * @param {() => object} deps.getConfig 当前生效配置（settings 双轨解析后的值）。
 * @param {(exec: object) => string} deps.workspaceOf 从 exec 推工作区。
 * @param {(exec: object) => Array} deps.forbidRulesOf 从 exec 推当前会话已加载的 FORBID 规则。
 * @param {(record: object) => void} deps.onBlock 拦截记账回调。
 * @returns {(exec: object, next: () => Promise<object>) => Promise<object>}
 */
export function createPreExecuteGuard(deps) {
  return async function preExecuteGuard(exec, next) {
    const config = deps.getConfig()
    const workspace = deps.workspaceOf(exec)
    const target = extractTarget(exec)

    // ── 防线 1：写回防护 ────────────────────────────────────────────────
    // write 是唯一全量覆写工具；edit / str_replace_editor 是定向修改，不拦。
    if (config.writeGuard !== false && exec.name === 'write' && target !== undefined && target.toLowerCase().endsWith('.md')) {
      const abs = isAbsolute(target) ? resolve(target) : resolve(workspace, target)
      if (insideWorkspace(abs, workspace)) {
        let exists = false
        try {
          exists = (await stat(abs)).isFile()
        } catch {
          exists = false // 新建文件不拦
        }
        if (exists) {
          const rel = relative(resolve(workspace), abs)
          const reason = `[规则透镜·写回防护] 已拦截对既有 Markdown 文件的全文覆写：${rel}。`
            + '规则与文档文件应使用 edit 工具做定向修改，避免整文覆写造成静默丢失。'
            + WRITE_GUARD_SUFFIX
          deps.onBlock({ kind: 'write-guard', tool: exec.name, path: abs, reason, exec })
          return { kind: 'deny', reason }
        }
      }
    }

    // ── 防线 2：FORBID 硬规则 ──────────────────────────────────────────
    const rules = deps.forbidRulesOf(exec)
    if (rules.length > 0) {
      const abs = target !== undefined && exec.name !== 'bash'
        ? (isAbsolute(target) ? resolve(target) : resolve(workspace, target))
        : undefined
      const home = homedir()
      for (const rule of rules) {
        if (!rule.toolRe.test(exec.name)) continue
        let hit = false
        if (rule.pathRe === null) {
          hit = true // 路径 glob 为 *：任何目标（含无目标工具）都命中
        } else if (exec.name === 'bash' && target !== undefined) {
          hit = rule.anyRe.test(target) // 命令串无路径语义，* 可跨 /
        } else if (target !== undefined) {
          const candidates = [target]
          if (abs !== undefined) {
            candidates.push(abs)
            const rel = relative(resolve(workspace), abs)
            if (rel.length > 0 && !rel.startsWith('..')) candidates.push(rel.split(sep).join('/'))
            if (abs.startsWith(home + sep)) candidates.push('~' + abs.slice(home.length).split(sep).join('/'))
          }
          hit = candidates.some((candidate) => rule.pathRe.test(candidate))
        }
        if (!hit) continue
        const reason = `[规则透镜·硬规则] 命中规则「FORBID: ${rule.tool} ${rule.path}」（来源：${rule.source}），`
          + `已拦截 ${exec.name}。若确实需要执行此操作，请先向用户说明理由并取得同意。`
        deps.onBlock({ kind: 'forbid', tool: exec.name, path: abs ?? target ?? '', rule: `FORBID: ${rule.tool} ${rule.path}`, reason, exec })
        return { kind: 'deny', reason }
      }
    }

    return next()
  }
}
