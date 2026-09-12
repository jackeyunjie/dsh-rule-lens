/**
 * 规则透镜 · 规则发现 / 分层 / 预算 / 拼接
 *
 * 层模型（窄覆盖宽，注入顺序 L1 → L2 → L4 → L5，白名单夹在中间）：
 *   L1      ~/.agents/AGENTS.md              总是（会话启动注入）
 *   L2      ~/.agents/rules/*.md             总是
 *   WL-HOME ~/<白名单目录>/rules/*.{md,mdc}   总是（如 .cursor）
 *   L4      <工作区>/.agents/rules/*.md       总是
 *   WL-WS   <工作区>/<白名单目录>/rules/*.{md,mdc} 总是
 *   L5      <子目录>/rules/*.md              按需：该子目录第一次被 read/write/edit 触达后注入
 *
 * 官方机制（~/.dsh/AGENTS.md、<库根>/AGENTS.md、<子目录>/AGENTS.md）由
 * dsh-agent-instructions 负责注入，本模块只提供「是否存在」的探测用于面板展示，
 * 绝不重复注入。
 *
 * @module dsh-rule-lens/rules
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** 层宽度：数字越小作用域越宽，预算超限时从最小的开始淘汰（L1 先淘汰）。 */
export const LAYER_WIDTH = { L1: 0, L2: 1, 'WL-HOME': 2, L4: 3, 'WL-WS': 4, L5: 5 }

export const LAYER_LABEL = {
  L1: 'L1 用户全局 ~/.agents/AGENTS.md',
  L2: 'L2 用户规则 ~/.agents/rules/',
  'WL-HOME': '白名单 用户目录',
  L4: 'L4 工作区规则 .agents/rules/',
  'WL-WS': '白名单 工作区目录',
  L5: 'L5 子目录规则 rules/',
}

/** 注入预算默认值：64KB。 */
export const DEFAULT_BUDGET_BYTES = 65536

/** 单文件体积上限：超过则跳过（防止误把整本书当规则）。 */
export const MAX_SOURCE_BYTES = 1048576

const RULE_FILE_EXTS = new Set(['.md', '.mdc'])

/** UTF-8 字节数。 */
export function byteLength(text) {
  return Buffer.byteLength(text, 'utf8')
}

/** 展示用路径：把 home 前缀折叠成 ~。 */
export function displayPath(absPath) {
  const home = homedir()
  if (absPath === home) return '~'
  if (absPath.startsWith(home + sep)) return '~' + absPath.slice(home.length)
  return absPath
}

/**
 * 数字前缀排序：00-*.md 排在 01-*.md 前；无数字前缀的文件按名字排在数字组之后。
 * @param {string[]} names 文件名列表。
 * @returns {string[]} 排序后的新数组。
 */
export function sortRuleFileNames(names) {
  const key = (name) => {
    const match = /^(\d+)/.exec(name)
    return { num: match === null ? Number.MAX_SAFE_INTEGER : Number(match[1]), name }
  }
  return [...names].sort((a, b) => {
    const ka = key(a)
    const kb = key(b)
    if (ka.num !== kb.num) return ka.num - kb.num
    return ka.name < kb.name ? -1 : ka.name > kb.name ? 1 : 0
  })
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * 读取一个规则目录下的全部规则文件（数字前缀排序，有上限保护）。
 * @param {string} dir 绝对目录。
 * @param {object} [options]
 * @param {Set<string>} [options.exts] 允许的扩展名（默认 .md/.mdc）。
 * @returns {Promise<Array<{path: string, name: string, content: string, bytes: number}>>}
 */
export async function readRulesDir(dir, options = {}) {
  const exts = options.exts ?? RULE_FILE_EXTS
  let names
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const files = []
  for (const name of sortRuleFileNames(names)) {
    const dot = name.lastIndexOf('.')
    if (dot < 0 || !exts.has(name.slice(dot).toLowerCase())) continue
    const path = join(dir, name)
    try {
      const info = await stat(path)
      if (!info.isFile() || info.size > MAX_SOURCE_BYTES) continue
      const content = await readFile(path, 'utf8')
      files.push({ path, name, content, bytes: byteLength(content) })
    } catch {
      // 读不了的文件静默跳过（与官方 discover 的 absent/unavailable 语义一致）
    }
  }
  return files
}

function tagFiles(layer, files) {
  return files.map((file) => ({
    layer,
    width: LAYER_WIDTH[layer],
    path: file.path,
    name: file.name,
    displayPath: displayPath(file.path),
    content: file.content,
    bytes: file.bytes,
  }))
}

/**
 * 插件「保留」的规则目录：这些目录的 rules/ 已由启动层（L4/白名单）注入，
 * 扫描 L5 候选与按需触达时都必须排除，否则 L4 内容会被当成 L5 重复注入。
 * @param {string} workspace 工作区绝对路径。
 * @param {string[]} [whitelistDirs] 白名单目录名。
 * @returns {Set<string>} 保留目录的绝对路径集合。
 */
export function reservedRuleDirs(workspace, whitelistDirs = []) {
  const root = resolve(workspace)
  const reserved = new Set([join(root, '.agents')])
  for (const dir of whitelistDirs) if (typeof dir === 'string' && dir.length > 0) reserved.add(join(root, dir))
  return reserved
}

/**
 * 发现「启动即注入」的全部规则文件（L1/L2/白名单/L4），宽在前窄在后。
 * @param {object} options
 * @param {string} options.workspace 会话工作区绝对路径。
 * @param {string[]} [options.whitelistDirs] 白名单目录名（如 ['.cursor']）。
 * @returns {Promise<Array>} 带层标签的规则文件列表。
 */
export async function discoverStartupRules(options) {
  const home = homedir()
  const workspace = resolve(options.workspace)
  const whitelist = (options.whitelistDirs ?? []).filter((d) => typeof d === 'string' && d.length > 0)
  const out = []

  // L1：用户全局单文件
  const l1 = join(home, '.agents', 'AGENTS.md')
  if (await isFile(l1)) {
    try {
      const content = await readFile(l1, 'utf8')
      out.push(...tagFiles('L1', [{ path: l1, name: 'AGENTS.md', content, bytes: byteLength(content) }]))
    } catch { /* 读失败按不存在处理 */ }
  }

  // L2：用户规则目录
  out.push(...tagFiles('L2', await readRulesDir(join(home, '.agents', 'rules'))))

  // 白名单（用户侧）：只进 ~/<dir>/rules/ 这一个位置
  for (const dir of whitelist) {
    out.push(...tagFiles('WL-HOME', await readRulesDir(join(home, dir, 'rules'))))
  }

  // L4：工作区规则目录
  out.push(...tagFiles('L4', await readRulesDir(join(workspace, '.agents', 'rules'))))

  // 白名单（工作区侧）：只进 <ws>/<dir>/rules/ 这一个位置，不进子文件夹
  for (const dir of whitelist) {
    out.push(...tagFiles('WL-WS', await readRulesDir(join(workspace, dir, 'rules'))))
  }

  return out
}

/**
 * 计算被触达路径涉及的子目录链（不含工作区本身，浅在前深在后）。
 * 与 dsh-agent-instructions 的 descendantDirsBetween 同一语义。
 * @param {string} workspace 会话工作区绝对路径。
 * @param {string} touchedPath 绝对或相对工作区的触达路径。
 * @returns {string[]} 子目录绝对路径列表。
 */
export function descendantDirsBetween(workspace, touchedPath) {
  const root = resolve(workspace)
  const targetDir = dirname(isAbsolute(touchedPath) ? resolve(touchedPath) : resolve(root, touchedPath))
  const rel = relative(root, targetDir)
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return []
  const chain = []
  let current = targetDir
  while (current !== root) {
    chain.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return chain.reverse()
}

/**
 * 检查一个子目录是否有 rules/*.md（L5 候选）。
 * @param {string} dir 子目录绝对路径。
 * @returns {Promise<Array|null>} 有规则则返回打标文件列表，否则 null。
 */
export async function subdirRules(dir) {
  const files = await readRulesDir(join(dir, 'rules'), { exts: new Set(['.md']) })
  return files.length === 0 ? null : tagFiles('L5', files)
}

/** 扫描工作区时跳过的目录。 */
const SCAN_SKIP_DIRS = new Set(['node_modules', '.git', '.dsh', 'dist', 'build', 'out', '.next', '.cache', 'coverage'])

/**
 * 扫描工作区内所有含 rules/*.md 的子目录（供面板的 L5 预热开关列表）。
 * 有界扫描：默认最深 4 层、最多 200 个候选目录。
 * @param {string} workspace 工作区绝对路径。
 * @param {object} [options]
 * @param {number} [options.maxDepth]
 * @param {number} [options.maxDirs]
 * @param {string[]} [options.whitelistDirs] 白名单目录（其 rules/ 属保留层，不进 L5 列表）。
 * @returns {Promise<Array<{dir: string, rel: string, fileCount: number, bytes: number}>>}
 */
export async function scanWorkspaceRuleDirs(workspace, options = {}) {
  const maxDepth = options.maxDepth ?? 4
  const maxDirs = options.maxDirs ?? 200
  const root = resolve(workspace)
  const reserved = reservedRuleDirs(root, options.whitelistDirs)
  const found = []
  const walk = async (dir, depth) => {
    if (depth > maxDepth || found.length >= maxDirs) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (dir !== root && !reserved.has(dir) && entries.some((e) => e.isDirectory() && e.name === 'rules')) {
      const files = await readRulesDir(join(dir, 'rules'), { exts: new Set(['.md']) })
      if (files.length > 0) {
        found.push({
          dir,
          rel: relative(root, dir),
          fileCount: files.length,
          bytes: files.reduce((sum, f) => sum + f.bytes, 0),
        })
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SCAN_SKIP_DIRS.has(entry.name)) continue
      await walk(join(dir, entry.name), depth + 1)
    }
  }
  await walk(root, 0)
  return found
}

/**
 * 探测官方机制（dsh-agent-instructions）管理的规则位置是否存在，仅用于面板展示。
 * @param {object} options
 * @param {string} options.dshHome 解析后的 DSH home。
 * @param {string} options.workspace 会话工作区。
 * @returns {Promise<Array<{label: string, path: string, exists: boolean}>>}
 */
export async function probeOfficialLayers(options) {
  const spots = [
    { label: '~/.dsh/AGENTS.md（用户全局，官方）', path: join(options.dshHome, 'AGENTS.md') },
  ]
  // <库根>/AGENTS.md 与 <子目录>/AGENTS.md 链：从工作区向上找 .git 作为库根
  let root = resolve(options.workspace)
  for (;;) {
    if (await isDirectory(join(root, '.git'))) break
    const parent = dirname(root)
    if (parent === root) {
      root = resolve(options.workspace)
      break
    }
    root = parent
  }
  const chain = []
  let current = resolve(options.workspace)
  while (current !== root) {
    chain.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  chain.push(root)
  chain.reverse()
  for (const dir of chain) {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const path = join(dir, name)
      spots.push({ label: `${displayPath(path)}（官方）`, path })
    }
  }
  const out = []
  for (const spot of spots) out.push({ ...spot, exists: await isFile(spot.path) })
  return out
}

const FRAME_OPEN = '<system-reminder>'
const FRAME_CLOSE = '</system-reminder>'

/** 内容里若自带 </system-reminder> 必须转义，防止提前闭合框架（照搬官方实现的做法）。 */
function escapeFrameBody(body) {
  return body.replaceAll(FRAME_CLOSE, '<\\/system-reminder>')
}

function fileBlock(file) {
  return `Rules from: ${file.displayPath} [${file.layer}]\n\n${file.content}`
}

function buildText(files, evicted, budgetBytes, mode) {
  const marker = evicted.length === 0
    ? ''
    : `规则预算 ${budgetBytes} 字节超限，以下作用域更宽的规则文件本次未注入：${evicted.map((f) => f.displayPath).join(', ')}`
  const intro = mode === 'startup'
    ? '以下规则由 dsh-rule-lens（规则透镜）在会话启动时注入。作用域更窄的规则优先于更宽的规则（L1→L2→L4→L5）；它们不覆盖系统、开发者或用户的直接指示。'
    : '以下子目录规则由 dsh-rule-lens（规则透镜）按需注入：你刚触达了这些目录，它们的规则从现在起生效。窄规则优先；不覆盖系统、开发者或用户的直接指示。'
  return [
    FRAME_OPEN,
    escapeFrameBody([marker, intro, ...files.map(fileBlock)].filter((s) => s.length > 0).join('\n\n')),
    FRAME_CLOSE,
  ].join('\n')
}

/**
 * 在预算内渲染一组规则文件（宽在前窄在后），超限时从作用域最宽的开始淘汰。
 * 官方原始设计是「静默丢弃」，这里把淘汰名单显式返回，交由日志与面板展示。
 * @param {Array} files discoverStartupRules / subdirRules 的打标文件，宽在前。
 * @param {object} options
 * @param {number} options.budgetBytes 总预算。
 * @param {number} [options.alreadyUsedBytes] 本会话此前已注入的字节数（L5 追加时传入）。
 * @param {'startup'|'preheat'|'ondemand'} options.mode 注入模式（决定文案）。
 * @returns {{text: string, included: Array, evicted: Array, bytes: number, overBudget: boolean}}
 */
export function renderInjection(files, options) {
  const budget = options.budgetBytes
  const alreadyUsed = options.alreadyUsedBytes ?? 0
  if (files.length === 0) return { text: '', included: [], evicted: [], bytes: 0, overBudget: false }

  // 从宽到窄逐个淘汰，直到文本放得下；最窄的一层永远保留（哪怕它自己超预算）
  let included = [...files]
  let evicted = []
  let text = buildText(included, [], budget, options.mode)
  while (included.length > 1 && alreadyUsed + byteLength(text) > budget) {
    evicted.push(included.shift())
    text = buildText(included, evicted, budget, options.mode)
  }
  const bytes = byteLength(text)
  return { text, included, evicted, bytes, overBudget: alreadyUsed + bytes > budget }
}
