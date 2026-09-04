import fs from 'node:fs'
import * as XLSX from 'xlsx'
import {
  decryptPayload,
  encryptPayload,
  isEncrypted,
  payloadToValue,
  type CellPayload,
  type CryptoContext,
} from './crypto.js'
import { MAX_READ_ROWS, YIELD_EVERY_ROWS, buildAnalysis, detectHeaderRow } from './analysis.js'
import type {
  ProcessMode,
  ProcessSelections,
  ProcessSummary,
  RulesConfig,
  SheetAnalysis,
} from '../shared/types.js'

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

/** SheetJS 单元格 → 加密 payload；空/布尔/错误 → null（跳过，对齐 valueToPayload 语义）。
 *  公式格不跳过：biff8 写回公式必然退化为缓存值（spec 第 3 节），跳过会让选中列明文残留。 */
function xlsCellToPayload(cell: XLSX.CellObject): CellPayload | null {
  switch (cell.t) {
    case 's':
      return typeof cell.v === 'string' ? ['s', cell.v] : null
    case 'n':
      return typeof cell.v === 'number' ? ['n', cell.v] : null
    case 'd':
      return cell.v instanceof Date ? ['d', cell.v.toISOString()] : null
    default:
      return null
  }
}

/** SheetJS 0.20.3 的 CFB 属性集写出器只支持 VT_I4/R8/BOOL/FILETIME/LPWSTR/STRING，
 *  遇到 WPS 等写入的 VT_UI4 属性（Locale/Behavior）会抛
 *  "TypedPropertyValue unrecognized type 19 2052"；WPS 自定义属性字典解析失败
 *  还会产生名为 "undefined" 的伪属性（写出时撞上属性表无名条目同样抛错）。
 *  写前剔除这些不可写属性（仅影响文件元数据，不影响单元格数据）。 */
export function sanitizeXlsProps(wb: XLSX.WorkBook): void {
  for (const props of [wb.Props, wb.Custprops]) {
    if (!props) continue
    const bag = props as Record<string, unknown>
    delete bag.Locale
    delete bag.Behavior
    delete bag.undefined
  }
}

export async function processXls(
  filePath: string,
  mode: ProcessMode,
  selections: ProcessSelections,
  outPath: string,
  ctx: CryptoContext,
  onProgress: (percent: number) => void,
): Promise<ProcessSummary> {
  let wb: XLSX.WorkBook
  try {
    // cellStyles 是 biff8 解析 !cols 列宽的门控；cellNF 保留 cell.z 数字格式
    wb = XLSX.readFile(filePath, { cellDates: true, cellNF: true, cellStyles: true })
  } catch (err) {
    throw new Error(`无法读取工作簿（文件损坏或格式不支持）：${(err as Error).message}`)
  }

  let processedCells = 0
  const failedCells: string[] = []
  let firstEncSeen = false
  const ranges = wb.SheetNames.map((name) => {
    const ref = wb.Sheets[name]?.['!ref']
    return ref ? XLSX.utils.decode_range(ref) : null
  })
  const totalRows = Math.max(
    1,
    ranges.reduce((sum, r) => sum + (r ? r.e.r - r.s.r + 1 : 0), 0),
  )
  let doneRows = 0

  for (let si = 0; si < wb.SheetNames.length; si++) {
    const name = wb.SheetNames[si]
    const range = ranges[si]
    if (!range) continue
    const ws = wb.Sheets[name]
    const selection = mode === 'encrypt' ? selections[name] : undefined
    const selectedCols = new Set(selection?.cols ?? [])
    if (mode === 'encrypt' && selectedCols.size === 0) {
      doneRows += range.e.r - range.s.r + 1
      continue
    }
    for (let r = range.s.r; r <= range.e.r; r++) {
      // 加密跳过表头行：表头列名不是敏感数据，且保持已脱敏文件可再次分析
      if (mode === 'encrypt' && selection && r + 1 === selection.headerRow) {
        doneRows++
        continue
      }
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r, c })
        const cell = ws[addr] as XLSX.CellObject | undefined
        if (!cell) continue
        if (mode === 'encrypt') {
          if (!selectedCols.has(c + 1)) continue
          if (isEncrypted(cell.v)) continue // 防重复加密
          const payload = xlsCellToPayload(cell)
          if (payload === null) continue
          cell.v = encryptPayload(ctx, payload)
          cell.t = 's'
          delete cell.w // 格式化文本缓存随值失效；cell.z 数字格式保留
          processedCells++
        } else {
          // 还原：凡 E2: 前缀自动还原，与列位置无关（增删列/调列序/另存均可还原）
          if (!isEncrypted(cell.v)) continue
          const isFirst = !firstEncSeen
          firstEncSeen = true
          try {
            const value = payloadToValue(decryptPayload(ctx, cell.v))
            cell.v = value
            cell.t = value instanceof Date ? 'd' : typeof value === 'number' ? 'n' : 's'
            delete cell.w
            processedCells++
          } catch {
            // 第一个 E2 格即失败 → 密码错误，整体中止；个别失败 → 记录地址继续
            if (isFirst) throw new Error('密码不符或文件被篡改')
            failedCells.push(`${name}!${addr}`)
          }
        }
      }
      doneRows++
      if (doneRows % YIELD_EVERY_ROWS === 0) {
        onProgress(Math.min(99, Math.round((doneRows / totalRows) * 100)))
        await new Promise((resolve) => setImmediate(resolve))
      }
    }
  }

  // bookSST：默认 Label 记录把字符串截到 255 字符；SST 无长度限制（Excel 原生机制）
  sanitizeXlsProps(wb)
  XLSX.writeFile(wb, outPath, { bookType: 'biff8', bookSST: true })
  onProgress(100)
  // xls 无公式跳过（写回必然退化），skippedFormulas 恒 0，仅为 ProcessSummary 兼容
  return { processedCells, skippedFormulas: 0, failedCells, outPath }
}
