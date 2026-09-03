import path from 'node:path'
import ExcelJS from 'exceljs'
import {
  decryptPayload,
  encryptPayload,
  isEncrypted,
  payloadToValue,
  valueToPayload,
  type CryptoContext,
} from './crypto.js'
import { matchColumns } from './rules.js'
import { analyzeCsv, processCsv } from './csv.js'
import type {
  AnalyzeResult,
  FileKind,
  ProcessMode,
  ProcessSelections,
  ProcessSummary,
  RulesConfig,
  SheetAnalysis,
} from '../shared/types.js'

/** 表头行探测窗口（前 5 行）与内容抽样行数（表头后 50 行） */
export const HEADER_CANDIDATE_ROWS = 5
export const SAMPLE_DATA_ROWS = 50
const MAX_READ_ROWS = HEADER_CANDIDATE_ROWS + SAMPLE_DATA_ROWS
/** 每处理 N 行让出一次事件循环并推送进度 */
export const YIELD_EVERY_ROWS = 500

export function kindFromPath(filePath: string): FileKind {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.xlsx') return 'xlsx'
  if (ext === '.xls') return 'xls'
  if (ext === '.csv') return 'csv'
  throw new Error(`不支持的文件格式：${ext || filePath}（仅支持 .xlsx / .xls / .csv）`)
}

export async function analyzeFile(
  filePath: string,
  rules: RulesConfig,
  headerRowOverrides: Record<string, number> = {},
): Promise<AnalyzeResult> {
  const kind = kindFromPath(filePath)
  const sheets =
    kind === 'xlsx'
      ? await analyzeXlsx(filePath, rules, headerRowOverrides)
      : await analyzeCsv(filePath, rules, headerRowOverrides[path.basename(filePath)])
  return { filePath, kind, sheets }
}

export async function processFile(
  filePath: string,
  mode: ProcessMode,
  selections: ProcessSelections,
  outPath: string,
  ctx: CryptoContext,
  onProgress: (percent: number) => void,
): Promise<ProcessSummary> {
  const kind = kindFromPath(filePath)
  if (kind === 'xlsx') return processXlsx(filePath, mode, selections, outPath, ctx, onProgress)
  return processCsv(filePath, mode, selections[path.basename(filePath)], outPath, ctx, onProgress)
}

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

/** 由稠密行文本构造 SheetAnalysis（xlsx/csv 共用）：表头行 → headers，其后 50 行抽样跑规则 */
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

/** 流式读出的单元格值 → 文本（analyze 只用于表头与内容抽样；样式忽略时日期为原始数字，可接受） */
function streamCellText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    const v = value as { richText?: { text: string }[]; text?: string; result?: unknown }
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('')
    if (typeof v.text === 'string') return v.text
    if (v.result != null) return streamCellText(v.result)
  }
  return ''
}

/** row.values 为 1-based 稀疏数组；转 0-based 稠密文本并去掉行尾空列 */
function normalizeStreamRow(values: unknown[]): string[] {
  const out: string[] = []
  for (let i = 1; i < values.length; i++) out.push(streamCellText(values[i]))
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out
}

export async function analyzeXlsx(
  filePath: string,
  rules: RulesConfig,
  headerRowOverrides: Record<string, number> = {},
): Promise<SheetAnalysis[]> {
  const analyses: SheetAnalysis[] = []
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    worksheets: 'emit',
    sharedStrings: 'cache',
    hyperlinks: 'ignore',
    styles: 'ignore',
    entries: 'ignore',
  })
  for await (const sheetReader of reader) {
    // name/state 运行时由 workbook.xml 赋值，但 exceljs 的 d.ts 未声明
    const meta = sheetReader as unknown as { name?: string; state?: string }
    const name = meta.name ?? `Sheet${analyses.length + 1}`
    const sparseRows: string[][] = []
    for await (const row of sheetReader) {
      if (row.number > MAX_READ_ROWS) break // 每 sheet 只读前几行即停；剩余 XML 由 zip entry autodrain 兜底
      sparseRows[row.number - 1] = normalizeStreamRow(row.values as unknown[])
    }
    const denseRows: string[][] = []
    for (let i = 0; i < sparseRows.length; i++) denseRows.push(sparseRows[i] ?? [])
    const headerRow = headerRowOverrides[name] ?? detectHeaderRow(denseRows)
    const hidden = meta.state === 'hidden' || meta.state === 'veryHidden'
    analyses.push(buildAnalysis(name, hidden, headerRow, denseRows, rules))
  }
  return analyses
}

export async function processXlsx(
  filePath: string,
  mode: ProcessMode,
  selections: ProcessSelections,
  outPath: string,
  ctx: CryptoContext,
  onProgress: (percent: number) => void,
): Promise<ProcessSummary> {
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.readFile(filePath) // 全量加载保真（样式/公式/合并/列宽保留；图表/图片/透视表丢失为已知限制）
  } catch (err) {
    throw new Error(
      `无法读取工作簿（文件损坏、格式不支持或文件过大内存不足；如为超大文件请拆分后重试）：${(err as Error).message}`,
    )
  }

  let processedCells = 0
  let skippedFormulas = 0
  const failedCells: string[] = []
  let firstEncSeen = false
  const totalRows = Math.max(
    1,
    workbook.worksheets.reduce((sum, ws) => sum + ws.rowCount, 0),
  )
  let doneRows = 0

  for (const ws of workbook.worksheets) {
    const selection = mode === 'encrypt' ? selections[ws.name] : undefined
    const selectedCols = new Set(selection?.cols ?? [])
    if (mode === 'encrypt' && selectedCols.size === 0) {
      doneRows += ws.rowCount
      continue
    }
    // eachRow 回调是同步的，先收集行引用再逐行 await 让出事件循环
    const rows: ExcelJS.Row[] = []
    ws.eachRow({ includeEmpty: false }, (row) => rows.push(row))
    for (const row of rows) {
      // 加密跳过表头行：表头列名不是敏感数据，且保持已脱敏文件可再次分析
      if (mode === 'encrypt' && selection && row.number === selection.headerRow) {
        doneRows++
        continue
      }
      for (let c = 1; c <= row.cellCount; c++) {
        const cell = row.getCell(c)
        if (mode === 'encrypt') {
          if (!selectedCols.has(c)) continue
          if (cell.type === ExcelJS.ValueType.Formula) {
            skippedFormulas++
            continue
          }
          // 合并从格与主格共享存储，写入会连带改主格，必须跳过
          if (cell.type === ExcelJS.ValueType.Merge) continue
          const value = cell.value
          if (isEncrypted(value)) continue // 防重复加密
          const payload = valueToPayload(value) // 空/富文本/超链接/布尔/错误 → null 跳过
          if (payload === null) continue
          cell.value = encryptPayload(ctx, payload)
          processedCells++
        } else {
          // 还原：凡 ENC1: 前缀自动还原，与列位置无关（增删列/调列序/另存均可还原）
          const value = cell.value
          if (!isEncrypted(value)) continue
          const isFirst = !firstEncSeen
          firstEncSeen = true
          try {
            cell.value = payloadToValue(decryptPayload(ctx, value))
            processedCells++
          } catch {
            // 第一个 ENC1 格即失败 → 密码错误，整体中止；个别失败 → 记录地址继续
            if (isFirst) throw new Error('密码不符或文件被篡改')
            failedCells.push(`${ws.name}!${cell.address}`)
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

  await workbook.xlsx.writeFile(outPath)
  onProgress(100)
  return { processedCells, skippedFormulas, failedCells, outPath }
}
