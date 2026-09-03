import type { RulesConfig } from '../shared/types.js'

/**
 * 脱敏列识别规则：
 * - 四类表头关键词：完全匹配 / 包含 / 开头 / 结尾（表头 trim 后比较，大小写敏感）
 * - 自定义内容正则（对前 50 个数据行抽样；命中任一样本即整列选中）
 * 全部词条用户在设置页增删，增删即生效；无内置预设规则。
 */

export const DEFAULT_EXACT_KEYWORDS = [
  '姓名',
  '身份证',
  '身份证号',
  '身份证号码',
  '证件号',
  '证件号码',
  '统一社会信用代码',
  '手机号',
  '手机号码',
  '电话',
  '联系电话',
  '电话号码',
  '银行卡',
  '银行卡号',
  '卡号',
  '账号',
  '银行账号',
  '开户行',
  '开户银行',
  '税号',
  '邮箱',
  '电子邮箱',
  '地址',
  '联系地址',
]

export function defaultRulesConfig(): RulesConfig {
  return {
    exact: [...DEFAULT_EXACT_KEYWORDS],
    contains: [],
    startsWith: [],
    endsWith: [],
    patterns: [],
  }
}

export interface ColumnMatch {
  autoSelected: boolean
  matchedRules: string[]
}

export function matchColumns(
  headers: string[],
  sampleRows: string[][],
  config: RulesConfig,
): ColumnMatch[] {
  const matchers: { label: string; test: (header: string) => boolean }[] = []
  for (const kw of config.exact) {
    const needle = kw.trim()
    if (needle) matchers.push({ label: `完全匹配：${needle}`, test: (h) => h === needle })
  }
  for (const kw of config.contains) {
    const needle = kw.trim()
    if (needle) matchers.push({ label: `包含：${needle}`, test: (h) => h.includes(needle) })
  }
  for (const kw of config.startsWith) {
    const needle = kw.trim()
    if (needle) matchers.push({ label: `开头：${needle}`, test: (h) => h.startsWith(needle) })
  }
  for (const kw of config.endsWith) {
    const needle = kw.trim()
    if (needle) matchers.push({ label: `结尾：${needle}`, test: (h) => h.endsWith(needle) })
  }

  const patterns: { label: string; re: RegExp }[] = []
  for (const src of config.patterns) {
    try {
      patterns.push({ label: `正则：${src}`, re: new RegExp(src) })
    } catch {
      // 保存时已校验；此处防御性跳过无效正则，不中断整列分析
    }
  }

  return headers.map((rawHeader, col) => {
    const header = rawHeader.trim()
    const matchedRules: string[] = []
    for (const { label, test } of matchers) {
      if (test(header)) matchedRules.push(label)
    }
    for (const row of sampleRows) {
      const value = row[col]
      if (!value) continue
      for (const { label, re } of patterns) {
        if (!matchedRules.includes(label) && re.test(value)) matchedRules.push(label)
      }
    }
    return { autoSelected: matchedRules.length > 0, matchedRules }
  })
}
