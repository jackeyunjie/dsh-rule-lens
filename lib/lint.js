/**
 * 规则透镜 · 规则 Lint
 *
 * 对每个规则文件做四项体检：
 *   1. 超 100 行 → 警告（规则文件应保持简短，长文应进文档而非规则）
 *   2. 全文无禁令词（不要/禁止/不得/严禁/never/must not/do not）→ 警告（可能没有硬约束）
 *   3. 含教程特征词（教程/什么是/introduction/tutorial/what is/入门）→ 警告（规则不应写成教程）
 *   4. 两文件内容重复（trim 后 sha1 相同）→ 警告
 *
 * @module dsh-rule-lens/lint
 */
import { createHash } from 'node:crypto'

const MAX_RULE_LINES = 100

/** 禁令词表（中英，小写匹配）。 */
const PROHIBITION_WORDS = ['不要', '禁止', '不得', '严禁', '绝不', 'never', 'must not', "mustn't", 'do not', "don't"]

/** 教程特征词表（中英，小写匹配）。 */
const TUTORIAL_WORDS = ['教程', '什么是', '入门', 'introduction', 'tutorial', 'what is', 'getting started']

function contentDigest(content) {
  return createHash('sha1').update(content.trim()).digest('hex')
}

/**
 * 对一批规则文件跑 Lint。
 * @param {Array<{path: string, displayPath?: string, content: string}>} files
 * @returns {Array<{path: string, displayPath: string, warnings: string[]}>} 只返回有警告的文件。
 */
export function lintRuleFiles(files) {
  const results = files.map((file) => {
    const warnings = []
    const content = file.content
    const lower = content.toLowerCase()
    const lines = content.split('\n').length
    if (lines > MAX_RULE_LINES) {
      warnings.push(`超过 ${MAX_RULE_LINES} 行（实际 ${lines} 行）：规则文件应保持简短，长篇说明请挪到文档`)
    }
    if (!PROHIBITION_WORDS.some((word) => lower.includes(word.toLowerCase()))) {
      warnings.push('全文未检测到禁令词（不要/禁止/不得/never 等）：规则可能缺少硬约束，模型容易当作建议忽略')
    }
    const tutorialHits = TUTORIAL_WORDS.filter((word) => lower.includes(word.toLowerCase()))
    if (tutorialHits.length > 0) {
      warnings.push(`含教程特征词（${tutorialHits.join('、')}）：规则文件不应写成教程，只留约束本身`)
    }
    return { path: file.path, displayPath: file.displayPath ?? file.path, warnings, digest: contentDigest(content) }
  })
  // 内容重复检测：同 digest 的文件互相点名
  const byDigest = new Map()
  for (const item of results) {
    const group = byDigest.get(item.digest)
    if (group === undefined) byDigest.set(item.digest, [item])
    else group.push(item)
  }
  for (const group of byDigest.values()) {
    if (group.length < 2) continue
    const names = group.map((item) => item.displayPath).join('、')
    for (const item of group) item.warnings.push(`内容与其他规则文件完全重复：${names}`)
  }
  return results
    .filter((item) => item.warnings.length > 0)
    .map(({ path, displayPath, warnings }) => ({ path, displayPath, warnings }))
}
