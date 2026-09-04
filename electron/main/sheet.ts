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
import {
  MAX_READ_ROWS,
  YIELD_EVERY_ROWS,
  buildAnalysis,
  detectHeaderRow,
} from './analysis.js'
import { analyzeCsv, processCsv } from './csv.js'
import { analyzeXls, processXls } from './xls.js'
import type {
  AnalyzeResult,
  FileKind,
  ProcessMode,
  ProcessSelections,
  ProcessSummary,
  RulesConfig,
  SheetAnalysis,
} from '../shared/types.js'

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
      : kind === 'xls'
        ? await analyzeXls(filePath, rules, headerRowOverrides)
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
  if (kind === 'xls') return processXls(filePath, mode, selections, outPath, ctx, onProgress)
  return processCsv(filePath, mode, selections[path.basename(filePath)], outPath, ctx, onProgress)
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
      // 加密跳过表头行及以上行：表头列名与上方标题/注释都不是敏感数据，且保持已脱敏文件可再次分析
      if (mode === 'encrypt' && selection && row.number <= selection.headerRow) {
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
