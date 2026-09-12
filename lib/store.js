/**
 * 规则透镜 · rule-lens.json 持久化
 *
 * 双轨存储决策（规格 E 要求说明）：
 *   - settings.yaml（installSettingsSection 注册的 rule-lens 命名空间）是
 *     「全局开关」的权威存储：写回防护开关、白名单、预算上限。
 *     理由：settings 服务自带 schema 校验、落盘、live 生效与冲突检测，
 *     是 rc.6 上官方认证的编辑入口（dsh-permission-presets 同款用法）。
 *   - rule-lens.json 只存「按工作区的预热目录列表」这类状态数据
 *     （它不是用户偏好，而是工作区事实，进全局 settings.yaml 会污染命名空间）。
 * 两类数据重启都会自动读取：settings 由 settings-file provider 恢复，
 * rule-lens.json 由本模块在 apply 时同步加载。
 *
 * @module dsh-rule-lens/store
 */
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const STORE_VERSION = 1

/**
 * 创建 rule-lens.json 存储。
 * @param {string} dshHome 解析后的 DSH home 绝对路径。
 * @param {(level: string, message: string) => void} [notify]
 */
export function createStore(dshHome, notify) {
  const path = join(dshHome, 'rule-lens.json')
  /** @type {{version: number, workspaces: Record<string, {preheatDirs: string[]}>}} */
  let data = { version: STORE_VERSION, workspaces: {} }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.workspaces === 'object' && parsed.workspaces !== null) {
      data = { version: STORE_VERSION, workspaces: parsed.workspaces }
    }
  } catch {
    // 文件不存在或损坏：从空存储开始（损坏文件在第一次保存时被覆盖）
  }

  let writeTail = Promise.resolve()
  const save = () => {
    // 串行写 + tmp/rename，避免并发写坏 JSON
    writeTail = writeTail.then(async () => {
      try {
        await mkdir(dirname(path), { recursive: true })
        const tmp = `${path}.${process.pid}.tmp`
        await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
        await rename(tmp, path)
      } catch (error) {
        notify?.('warn', `[rule-lens] 保存 rule-lens.json 失败: ${error?.message ?? error}`)
      }
    })
    return writeTail
  }

  const workspaceEntry = (workspace) => {
    let entry = data.workspaces[workspace]
    if (entry === undefined) {
      entry = { preheatDirs: [] }
      data.workspaces[workspace] = entry
    }
    if (!Array.isArray(entry.preheatDirs)) entry.preheatDirs = []
    return entry
  }

  return {
    path,
    /**
     * 读某工作区的预热目录列表（工作区相对路径）。
     * @param {string} workspace
     * @returns {string[]}
     */
    getPreheatDirs(workspace) {
      const entry = data.workspaces[workspace]
      return entry !== undefined && Array.isArray(entry.preheatDirs) ? [...entry.preheatDirs] : []
    },
    /**
     * 设置某工作区某子目录的预热开关。
     * @param {string} workspace 工作区绝对路径。
     * @param {string} relDir 工作区相对的子目录。
     * @param {boolean} enabled
     */
    setPreheatDir(workspace, relDir, enabled) {
      const entry = workspaceEntry(workspace)
      const has = entry.preheatDirs.includes(relDir)
      if (enabled && !has) entry.preheatDirs.push(relDir)
      if (!enabled && has) entry.preheatDirs = entry.preheatDirs.filter((dir) => dir !== relDir)
      return save()
    },
    /** 面板展示用：完整快照。 */
    snapshot() {
      return JSON.parse(JSON.stringify(data))
    },
  }
}
