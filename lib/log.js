/**
 * 规则透镜 · JSONL 日志
 *
 * 两个日志文件（都在 <DSH_HOME>/rule-lens/ 下）：
 *   log.jsonl        注入日志：{ts, sessionId, layer, path, bytes, mode, evicted}
 *   compliance.jsonl 遵守率数据：拦截事件 {ts, type:'block', sessionId, kind, tool, path, rule?}
 *                    与会话小结 {ts, type:'session-summary', sessionId, writeGuardBlocks, forbidBlocks}
 *
 * @module dsh-rule-lens/log
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 创建日志器。
 * @param {string} dir 日志目录（<DSH_HOME>/rule-lens）。
 * @param {(level: string, message: string) => void} [notify] 宿主日志回调（可选）。
 */
export function createJsonlLog(dir, notify) {
  const logPath = join(dir, 'log.jsonl')
  const compliancePath = join(dir, 'compliance.jsonl')
  let dirReady = false

  const ensureDir = async () => {
    if (dirReady) return
    await mkdir(dir, { recursive: true })
    dirReady = true
  }

  const append = async (path, record) => {
    try {
      await ensureDir()
      await appendFile(path, JSON.stringify(record) + '\n', 'utf8')
    } catch (error) {
      notify?.('warn', `[rule-lens] 写日志失败 ${path}: ${error?.message ?? error}`)
    }
  }

  return {
    logPath,
    compliancePath,
    /**
     * 记一条注入日志。
     * @param {object} entry {sessionId, layer, path, bytes, mode: 'startup'|'preheat'|'ondemand', evicted}
     */
    logInjection(entry) {
      return append(logPath, { ts: new Date().toISOString(), ...entry })
    },
    /** 记一条遵守率数据（拦截事件或会话小结）。 */
    logCompliance(entry) {
      return append(compliancePath, { ts: new Date().toISOString(), ...entry })
    },
    /**
     * 读 JSONL 尾部若干行（面板摘要用）。
     * @param {'log'|'compliance'} which
     * @param {number} [maxLines]
     * @returns {Promise<Array<object>>}
     */
    async readTail(which, maxLines = 500) {
      const path = which === 'log' ? logPath : compliancePath
      let text
      try {
        text = await readFile(path, 'utf8')
      } catch {
        return []
      }
      return text
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .slice(-maxLines)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        })
        .filter((entry) => entry !== null)
    },
  }
}
