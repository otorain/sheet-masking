import type { BuiltinRule, RulesConfig } from '../shared/types.js'

/**
 * 脱敏列识别规则：
 * - 内置表头关键词（includes 匹配）
 * - 内置内容正则（对前 50 个数据行抽样；命中任一样本即整列选中）
 * - 用户自定义关键词/正则；每条内置规则可启停（disabledBuiltins 存 id）
 */

export const BUILTIN_RULES: BuiltinRule[] = [
  { id: 'kw:姓名', label: '表头关键词：姓名', kind: 'keyword', value: '姓名' },
  { id: 'kw:身份证', label: '表头关键词：身份证', kind: 'keyword', value: '身份证' },
  { id: 'kw:证件', label: '表头关键词：证件', kind: 'keyword', value: '证件' },
  { id: 'kw:手机号', label: '表头关键词：手机号', kind: 'keyword', value: '手机号' },
  { id: 'kw:电话', label: '表头关键词：电话', kind: 'keyword', value: '电话' },
  { id: 'kw:银行卡', label: '表头关键词：银行卡', kind: 'keyword', value: '银行卡' },
  { id: 'kw:卡号', label: '表头关键词：卡号', kind: 'keyword', value: '卡号' },
  { id: 'kw:账号', label: '表头关键词：账号', kind: 'keyword', value: '账号' },
  { id: 'kw:开户行', label: '表头关键词：开户行', kind: 'keyword', value: '开户行' },
  { id: 'kw:税号', label: '表头关键词：税号', kind: 'keyword', value: '税号' },
  {
    id: 'kw:统一社会信用代码',
    label: '表头关键词：统一社会信用代码',
    kind: 'keyword',
    value: '统一社会信用代码',
  },
  { id: 'kw:邮箱', label: '表头关键词：邮箱', kind: 'keyword', value: '邮箱' },
  { id: 'kw:地址', label: '表头关键词：地址', kind: 'keyword', value: '地址' },
  // \b 对中文文本中的 ASCII 数字串同样有效（中文字符是非 word 字符）
  { id: 're:idcard', label: '内容正则：身份证（18 位）', kind: 'pattern', value: '\\b\\d{17}[\\dXx]\\b' },
  { id: 're:phone', label: '内容正则：手机号', kind: 'pattern', value: '\\b1[3-9]\\d{9}\\b' },
  { id: 're:bankcard', label: '内容正则：银行卡号（16-19 位）', kind: 'pattern', value: '\\b\\d{16,19}\\b' },
  { id: 're:email', label: '内容正则：邮箱', kind: 'pattern', value: '[\\w.+-]+@[\\w-]+\\.[\\w.]+' },
]

export function defaultRulesConfig(): RulesConfig {
  return { disabledBuiltins: [], customKeywords: [], customPatterns: [] }
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
  const disabled = new Set(config.disabledBuiltins)
  const keywords: { label: string; needle: string }[] = []
  const patterns: { label: string; re: RegExp }[] = []

  for (const rule of BUILTIN_RULES) {
    if (disabled.has(rule.id)) continue
    if (rule.kind === 'keyword') {
      keywords.push({ label: rule.label, needle: rule.value })
    } else {
      patterns.push({ label: rule.label, re: new RegExp(rule.value) })
    }
  }
  for (const kw of config.customKeywords) {
    const needle = kw.trim()
    if (needle) keywords.push({ label: `自定义关键词：${needle}`, needle })
  }
  for (const src of config.customPatterns) {
    try {
      patterns.push({ label: `自定义正则：${src}`, re: new RegExp(src) })
    } catch {
      // 保存时已校验；此处防御性跳过无效正则，不中断整列分析
    }
  }

  return headers.map((header, col) => {
    const matchedRules: string[] = []
    for (const { label, needle } of keywords) {
      if (header.includes(needle)) matchedRules.push(label)
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
