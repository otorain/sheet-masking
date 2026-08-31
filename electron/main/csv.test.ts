import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import iconv from 'iconv-lite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateSalt, initCrypto, isEncrypted } from './crypto.js'
import { defaultRulesConfig } from './rules.js'
import { analyzeCsv, detectCsvEncoding, processCsv, readCsvHead } from './csv.js'

const rules = defaultRulesConfig()
const ctx = initCrypto('test-password', generateSalt())

let dir: string
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-test-'))
})
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const UTF8_CSV = '订单号,姓名,手机号\nA001,张三,13800138000\nA002,李四,13900139000\n'

describe('detectCsvEncoding / readCsvHead', () => {
  it('UTF-8（无 BOM）', async () => {
    const file = path.join(dir, 'utf8.csv')
    fs.writeFileSync(file, UTF8_CSV, 'utf8')
    expect(await detectCsvEncoding(file)).toBe('utf8')
    const rows = await readCsvHead(file, 'utf8', 10)
    expect(rows[0]).toEqual(['订单号', '姓名', '手机号'])
  })

  it('UTF-8 带 BOM：去 BOM 后表头干净', async () => {
    const file = path.join(dir, 'utf8-bom.csv')
    fs.writeFileSync(file, '\uFEFF' + UTF8_CSV, 'utf8')
    expect(await detectCsvEncoding(file)).toBe('utf8')
    const sheets = await analyzeCsv(file, rules)
    expect(sheets[0].headers.map((h) => h.name)).toEqual(['订单号', '姓名', '手机号'])
  })

  it('GBK：无 BOM 且 UTF-8 解码失败 → gbk，iconv 转 UTF-8', async () => {
    const file = path.join(dir, 'gbk.csv')
    fs.writeFileSync(file, iconv.encode('卡号,金额\n6222020200112233,100\n', 'gbk'))
    expect(await detectCsvEncoding(file)).toBe('gbk')
    const rows = await readCsvHead(file, 'gbk', 10)
    expect(rows[0]).toEqual(['卡号', '金额'])
  })

  it('readCsvHead 提前停止（不读完整文件）', async () => {
    const file = path.join(dir, 'head.csv')
    fs.writeFileSync(file, UTF8_CSV, 'utf8')
    const rows = await readCsvHead(file, 'utf8', 2)
    expect(rows).toHaveLength(2)
  })
})

describe('analyzeCsv', () => {
  it('单 sheet（basename）、规则自动勾选', async () => {
    const file = path.join(dir, 'analyze.csv')
    fs.writeFileSync(file, UTF8_CSV, 'utf8')
    const sheets = await analyzeCsv(file, rules)
    expect(sheets).toHaveLength(1)
    expect(sheets[0].name).toBe('analyze.csv')
    expect(sheets[0].hidden).toBe(false)
    expect(sheets[0].headerRow).toBe(1)
    expect(sheets[0].headers.map((h) => h.autoSelected)).toEqual([false, true, true])
  })
})

describe('processCsv 加密→还原往返', () => {
  it('选中列加密（跳过表头行）、输出 UTF-8 BOM + CRLF、还原一致', async () => {
    const src = path.join(dir, 'roundtrip.csv')
    fs.writeFileSync(src, UTF8_CSV, 'utf8')
    const enc = path.join(dir, 'roundtrip-enc.csv')
    const summary = await processCsv(
      src,
      'encrypt',
      { headerRow: 1, cols: [2, 3] },
      enc,
      ctx,
      () => {},
    )
    expect(summary.processedCells).toBe(4)

    const out = fs.readFileSync(enc)
    expect(out[0]).toBe(0xef) // BOM
    expect(out[1]).toBe(0xbb)
    expect(out[2]).toBe(0xbf)
    const text = out.toString('utf8')
    expect(text).toContain('\r\n')
    const lines = text.slice(1).split('\r\n') // slice(1) 去掉 BOM 字符
    expect(lines[0]).toBe('订单号,姓名,手机号') // 表头行不加密
    const cells1 = lines[1].split(',')
    expect(cells1[0]).toBe('A001')
    expect(isEncrypted(cells1[1])).toBe(true)
    expect(isEncrypted(cells1[2])).toBe(true)

    // 还原
    const dec = path.join(dir, 'roundtrip-dec.csv')
    const decSummary = await processCsv(enc, 'decrypt', undefined, dec, ctx, () => {})
    expect(decSummary.failedCells).toEqual([])
    expect(decSummary.processedCells).toBe(4)
    const decText = fs.readFileSync(dec, 'utf8').slice(1).replace(/\r\n/g, '\n')
    expect(decText).toBe(UTF8_CSV)
  })

  it('GBK 输入往返：输出统一为 UTF-8 BOM', async () => {
    const src = path.join(dir, 'gbk-rt.csv')
    const original = '卡号,备注\n6222020200112233,张三\n'
    fs.writeFileSync(src, iconv.encode(original, 'gbk'))
    const enc = path.join(dir, 'gbk-rt-enc.csv')
    await processCsv(src, 'encrypt', { headerRow: 1, cols: [1, 2] }, enc, ctx, () => {})
    const dec = path.join(dir, 'gbk-rt-dec.csv')
    await processCsv(enc, 'decrypt', undefined, dec, ctx, () => {})
    const decText = fs.readFileSync(dec, 'utf8').slice(1).replace(/\r\n/g, '\n')
    expect(decText).toBe(original)
  })

  it('密码错误：第一个 ENC1 格即失败，整体中止', async () => {
    const src = path.join(dir, 'wrongpw.csv')
    fs.writeFileSync(src, UTF8_CSV, 'utf8')
    const enc = path.join(dir, 'wrongpw-enc.csv')
    await processCsv(src, 'encrypt', { headerRow: 1, cols: [2] }, enc, ctx, () => {})
    const wrong = initCrypto('other-password', generateSalt())
    await expect(
      processCsv(enc, 'decrypt', undefined, path.join(dir, 'wrongpw-dec.csv'), wrong, () => {}),
    ).rejects.toThrow('密码不符或文件被篡改')
  })
})
