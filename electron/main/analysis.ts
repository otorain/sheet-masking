import { matchColumns } from './rules.js'
import type { RulesConfig, SheetAnalysis } from '../shared/types.js'

/** 表头行探测窗口（前 5 行）与内容抽样行数（表头后 50 行） */
export const HEADER_CANDIDATE_ROWS = 5
export const SAMPLE_DATA_ROWS = 50
export const MAX_READ_ROWS = HEADER_CANDIDATE_ROWS + SAMPLE_DATA_ROWS
/** 每处理 N 行让出一次事件循环并推送进度 */
export const YIELD_EVERY_ROWS = 500

/**
 * 表头行自动探测：表头是文字而数据多为数字，故前 5 行中取「非空且非纯数字单元格最多
 * 且下一行有数据」的行；数量相同取靠前的行；末行无下一行也允许参选。返回 1-based 行号。
 */
export function detectHeaderRow(denseRows: string[][]): number {
  const isText = (v: string): boolean => v !== '' && !Number.isFinite(Number(v))
  let best = 0
  let bestCount = -1
  const limit = Math.min(denseRows.length, HEADER_CANDIDATE_ROWS)
  for (let i = 0; i < limit; i++) {
    if (i + 1 < denseRows.length && !denseRows[i + 1].some((v) => v !== '')) continue
    const count = denseRows[i].filter(isText).length
    if (count > bestCount) {
      bestCount = count
      best = i
    }
  }
  return best + 1
}

/** 由稠密行文本构造 SheetAnalysis（xlsx/xls/csv 共用）：表头行 → headers，其后 50 行抽样跑规则 */
export function buildAnalysis(
  name: string,
  hidden: boolean,
  headerRow: number,
  denseRows: string[][],
  rules: RulesConfig,
): SheetAnalysis {
  const headerValues = (denseRows[headerRow - 1] ?? []).map((v) => v.trim())
  const width = headerValues.length
  const sampleRows = denseRows.slice(headerRow, headerRow + SAMPLE_DATA_ROWS).map((row) => {
    const padded = row.slice(0, width)
    while (padded.length < width) padded.push('')
    return padded
  })
  const matches = matchColumns(headerValues, sampleRows, rules)
  return {
    name,
    hidden,
    headerRow,
    headers: headerValues.map((value, i) => ({
      colIndex: i + 1,
      name: value || `(列 ${i + 1})`,
      autoSelected: matches[i].autoSelected,
      matchedRules: matches[i].matchedRules,
    })),
  }
}
