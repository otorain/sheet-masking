import fs from 'node:fs'
import * as XLSX from 'xlsx'
import { MAX_READ_ROWS, buildAnalysis, detectHeaderRow } from './analysis.js'
import type { RulesConfig, SheetAnalysis } from '../shared/types.js'

// xlsx 的 ESM 构建（xlsx.mjs）不自动加载 node:fs，readFile/writeFile 前必须注入
XLSX.set_fs(fs)

/** analyze 用：SheetJS 原始单元格值 → 文本（不开 cellDates，日期以序列号数字出现，
 *  与 xlsx analyze（styles:'ignore'）行为一致，可接受） */
function cellText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

export async function analyzeXls(
  filePath: string,
  rules: RulesConfig,
  headerRowOverrides: Record<string, number> = {},
): Promise<SheetAnalysis[]> {
  const wb = XLSX.readFile(filePath, { sheetRows: MAX_READ_ROWS })
  return wb.SheetNames.map((name, i) => {
    const ws = wb.Sheets[name]
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: '' })
    const denseRows = rows.map((row) => {
      const out = row.map(cellText)
      // 去掉行尾空列（对齐 xlsx normalizeStreamRow；xls 的 range 常含格式残留空列）
      while (out.length > 0 && out[out.length - 1] === '') out.pop()
      return out
    })
    const hidden = (wb.Workbook?.Sheets?.[i]?.Hidden ?? 0) !== 0
    const headerRow = headerRowOverrides[name] ?? detectHeaderRow(denseRows)
    return buildAnalysis(name, hidden, headerRow, denseRows, rules)
  })
}
