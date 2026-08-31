import { once } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { finished } from 'node:stream/promises'
import iconv from 'iconv-lite'
import { format, parse } from 'fast-csv'
import {
  decryptPayload,
  encryptPayload,
  isEncrypted,
  type CryptoContext,
} from './crypto.js'
import {
  buildAnalysis,
  detectHeaderRow,
  HEADER_CANDIDATE_ROWS,
  SAMPLE_DATA_ROWS,
  YIELD_EVERY_ROWS,
} from './sheet.js'
import type {
  ProcessMode,
  ProcessSummary,
  RulesConfig,
  SheetAnalysis,
  SheetSelection,
} from '../shared/types.js'

/**
 * CSV 路径（天然单 sheet）：全程流式逐行，内存恒定。
 * - 读：检测 GBK（无 BOM 且 UTF-8 解码失败）→ iconv-lite 转 UTF-8
 * - 写：UTF-8 带 BOM + CRLF 行尾（Windows 版 Excel 直接双击不乱码）
 */

const MAX_READ_ROWS = HEADER_CANDIDATE_ROWS + SAMPLE_DATA_ROWS

export async function detectCsvEncoding(filePath: string): Promise<'utf8' | 'gbk'> {
  const handle = await fs.promises.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(65536)
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    const head = buf.subarray(0, bytesRead)
    if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return 'utf8'
    try {
      // stream: true 容忍块尾被截断的多字节序列；无效字节序列立即抛错
      new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true })
      return 'utf8'
    } catch {
      return 'gbk'
    }
  } finally {
    await handle.close()
  }
}

function openTextStream(
  filePath: string,
  encoding: 'utf8' | 'gbk',
): { raw: fs.ReadStream; text: NodeJS.ReadableStream } {
  const raw = fs.createReadStream(filePath)
  return { raw, text: encoding === 'gbk' ? raw.pipe(iconv.decodeStream('gbk')) : raw }
}

/** 流式读前 maxRows 行（行 = string[]，0-based 列） */
export async function readCsvHead(
  filePath: string,
  encoding: 'utf8' | 'gbk',
  maxRows: number,
): Promise<string[][]> {
  return new Promise((resolve, reject) => {
    const rows: string[][] = []
    const { raw, text } = openTextStream(filePath, encoding)
    const parser = text.pipe(parse({ headers: false }))
    raw.on('error', reject) // pipe 不转发错误，上游读失败也要 reject
    parser.on('error', reject)
    parser.on('data', (row: unknown) => {
      rows.push((row as unknown[]).map(String))
      if (rows.length >= maxRows) {
        parser.removeAllListeners('data')
        parser.unpipe() // 先断流再销毁，避免上游继续写入已销毁的 parser
        raw.destroy()
        parser.destroy()
        resolve(rows)
      }
    })
    parser.on('end', () => resolve(rows))
  })
}

function stripBom(row: string[]): void {
  if (row.length > 0) row[0] = row[0].replace(/^\uFEFF/, '')
}

export async function analyzeCsv(
  filePath: string,
  rules: RulesConfig,
  headerRowOverride?: number,
): Promise<SheetAnalysis[]> {
  const encoding = await detectCsvEncoding(filePath)
  const rows = await readCsvHead(filePath, encoding, MAX_READ_ROWS)
  if (rows.length > 0) stripBom(rows[0])
  const headerRow = headerRowOverride ?? detectHeaderRow(rows)
  return [buildAnalysis(path.basename(filePath), false, headerRow, rows, rules)]
}

export async function processCsv(
  filePath: string,
  mode: ProcessMode,
  selection: SheetSelection | undefined,
  outPath: string,
  ctx: CryptoContext,
  onProgress: (percent: number) => void,
): Promise<ProcessSummary> {
  const encoding = await detectCsvEncoding(filePath)
  const fileSize = Math.max(1, (await fs.promises.stat(filePath)).size)
  const raw = fs.createReadStream(filePath)
  const text = encoding === 'gbk' ? raw.pipe(iconv.decodeStream('gbk')) : raw
  const parser = text.pipe(parse({ headers: false }))
  const out = fs.createWriteStream(outPath)
  out.write('\uFEFF') // BOM
  // fast-csv 只在行间写 rowDelimiter，末行无行尾；end:false 保留 out 以便补末行 CRLF
  const writer = format({ rowDelimiter: '\r\n' })
  writer.pipe(out, { end: false })

  let processedCells = 0
  const failedCells: string[] = []
  let rowNo = 0
  let firstEncSeen = false
  const selectedCols = new Set(selection?.cols ?? [])

  const abort = (message: string): never => {
    parser.unpipe()
    raw.destroy()
    parser.destroy()
    writer.unpipe()
    writer.destroy()
    out.on('error', () => {}) // 中止路径：主错误已抛出，out 销毁衍生的 write 错误不再上抛
    out.destroy()
    throw new Error(message)
  }

  for await (const row of parser) {
    rowNo++
    const cells = (row as unknown[]).map(String)
    if (rowNo === 1) stripBom(cells)
    if (mode === 'encrypt' && selection && rowNo === selection.headerRow) {
      // 加密跳过表头行（与 xlsx 路径一致），照原样写出
    } else {
      for (let c = 0; c < cells.length; c++) {
        if (mode === 'encrypt') {
          if (!selectedCols.has(c + 1)) continue
          const value = cells[c]
          if (value === '' || isEncrypted(value)) continue // 空值/已加密跳过
          cells[c] = encryptPayload(ctx, ['s', value])
          processedCells++
        } else {
          if (!isEncrypted(cells[c])) continue
          const isFirst = !firstEncSeen
          firstEncSeen = true
          try {
            const payload = decryptPayload(ctx, cells[c])
            cells[c] = String(payload[1]) // CSV 一律还原为文本（xlsx 的 n/d 类型不在此出现）
            processedCells++
          } catch {
            if (isFirst) abort('密码不符或文件被篡改')
            failedCells.push(`行${rowNo}列${c + 1}`)
          }
        }
      }
    }
    if (!writer.write(cells)) await once(writer, 'drain')
    if (rowNo % YIELD_EVERY_ROWS === 0) {
      onProgress(Math.min(99, Math.round((raw.bytesRead / fileSize) * 100)))
    }
  }
  writer.end()
  await finished(writer) // 等 writer 把末行冲进 out 后再补末行 CRLF
  if (rowNo > 0) out.write('\r\n')
  out.end()
  await finished(out)
  onProgress(100)
  return { processedCells, skippedFormulas: 0, failedCells, outPath }
}
