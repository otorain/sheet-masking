import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateSalt, initCrypto, isEncrypted } from './crypto.js'
import { defaultRulesConfig } from './rules.js'
import { analyzeXlsx, detectHeaderRow, processXlsx } from './sheet.js'

const rules = defaultRulesConfig()
const ctx = initCrypto('test-password', generateSalt())

let dir: string
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-test-'))
})
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

/** 第 1 行大标题、第 2 行真实表头、含公式/日期/合并单元格；另有隐藏 sheet */
async function buildFixture(filePath: string): Promise<void> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('订单')
  ws.addRow(['订单报表（导出）'])
  ws.addRow(['订单号', '姓名', '手机号', '金额'])
  ws.addRow(['A001', '张三', '13800138000', 100.5])
  ws.addRow(['A002', '李四', '13900139000', 200])
  ws.getCell('E3').value = { formula: 'D3+D4', result: 300.5 }
  const dateCell = ws.getCell('F3')
  dateCell.value = new Date('2026-01-15T00:00:00.000Z')
  dateCell.numFmt = 'yyyy-mm-dd'
  ws.mergeCells('A5:B5')
  ws.getCell('A5').value = '合并备注'

  const hidden = wb.addWorksheet('隐藏表')
  hidden.state = 'hidden'
  hidden.addRow(['卡号', '备注'])
  hidden.addRow(['6222020200112233', '张三'])

  await wb.xlsx.writeFile(filePath)
}

describe('detectHeaderRow（纯函数）', () => {
  it('标题行+表头行：选非空最多且下一行有数据的行', () => {
    expect(
      detectHeaderRow([
        ['订单报表（导出）', ''],
        ['订单号', '姓名'],
        ['A001', '张三'],
      ]),
    ).toBe(2)
  })
  it('表头在第 1 行', () => {
    expect(
      detectHeaderRow([
        ['订单号', '姓名'],
        ['A001', '张三'],
      ]),
    ).toBe(1)
  })
  it('非空数相同取靠前的行', () => {
    expect(
      detectHeaderRow([
        ['a', 'b'],
        ['c', 'd'],
        ['e', 'f'],
      ]),
    ).toBe(1)
  })
  it('仅一行/空表回退为 1', () => {
    expect(detectHeaderRow([['仅一行']])).toBe(1)
    expect(detectHeaderRow([])).toBe(1)
  })
})

describe('analyzeXlsx', () => {
  it('探测表头行、按规则自动勾选、隐藏 sheet 照常列出并标注', async () => {
    const file = path.join(dir, 'analyze.xlsx')
    await buildFixture(file)
    const sheets = await analyzeXlsx(file, rules)
    expect(sheets.map((s) => s.name)).toEqual(['订单', '隐藏表'])

    const order = sheets[0]
    expect(order.hidden).toBe(false)
    expect(order.headerRow).toBe(2)
    expect(order.headers.map((h) => h.name)).toEqual(['订单号', '姓名', '手机号', '金额'])
    const byName = Object.fromEntries(order.headers.map((h) => [h.name, h]))
    expect(byName['姓名'].autoSelected).toBe(true)
    expect(byName['姓名'].matchedRules).toContain('表头关键词：姓名')
    expect(byName['手机号'].matchedRules).toContain('内容正则：手机号')
    expect(byName['订单号'].autoSelected).toBe(false)

    const hiddenSheet = sheets[1]
    expect(hiddenSheet.hidden).toBe(true)
    expect(hiddenSheet.headerRow).toBe(1)
    expect(hiddenSheet.headers[0].autoSelected).toBe(true) // 卡号关键词 + 银行卡内容正则
  })

  it('表头行手动修正后重跑规则', async () => {
    const file = path.join(dir, 'override.xlsx')
    await buildFixture(file)
    const sheets = await analyzeXlsx(file, rules, { 订单: 1 })
    expect(sheets[0].headerRow).toBe(1)
    expect(sheets[0].headers.map((h) => h.name)).toEqual(['订单报表（导出）'])
  })
})

describe('processXlsx 加密→还原往返', () => {
  it('加密选中列（跳过表头行）、跨 sheet/跨文件密文一致、还原后与原文逐格一致', async () => {
    const src = path.join(dir, 'roundtrip.xlsx')
    const src2 = path.join(dir, 'roundtrip2.xlsx')
    await buildFixture(src)
    await buildFixture(src2)
    const selections = {
      订单: { headerRow: 2, cols: [2, 3, 5, 6] },
      隐藏表: { headerRow: 1, cols: [1, 2] },
    }
    const enc1 = path.join(dir, 'enc1.xlsx')
    const enc2 = path.join(dir, 'enc2.xlsx')
    const progress: number[] = []

    // 计数：订单 sheet 表头行（第 2 行）跳过；数据格 B3/B4、C3/C4、F3 共 5 格，
    // E3 公式跳过；隐藏表表头行（第 1 行）跳过，A2/B2 共 2 格 → 合计 7
    const summary = await processXlsx(src, 'encrypt', selections, enc1, ctx, (p) =>
      progress.push(p),
    )
    expect(summary.processedCells).toBe(7)
    expect(summary.skippedFormulas).toBe(1)
    expect(progress[progress.length - 1]).toBe(100)

    await processXlsx(src2, 'encrypt', selections, enc2, ctx, () => {})

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(enc1)
    const ws = wb.getWorksheet('订单')!
    expect(ws.getCell('B2').value).toBe('姓名') // 表头行不加密
    expect(isEncrypted(ws.getCell('B3').value)).toBe(true)
    expect(isEncrypted(ws.getCell('C3').value)).toBe(true)
    expect(ws.getCell('A3').value).toBe('A001') // 未选列不动
    expect(ws.getCell('D3').value).toBe(100.5) // 金额列不变
    const formula = ws.getCell('E3').value as { formula: string }
    expect(formula.formula).toBe('D3+D4') // 公式保留
    expect(ws.getCell('B5').isMerged).toBe(true) // 合并单元格保留

    // 跨 sheet 与跨文件：同一明文密文完全相同
    const hiddenWs = wb.getWorksheet('隐藏表')!
    expect(hiddenWs.getCell('B2').value).toBe(ws.getCell('B3').value) // 张三 === 张三
    const wb2 = new ExcelJS.Workbook()
    await wb2.xlsx.readFile(enc2)
    expect(wb2.getWorksheet('订单')!.getCell('B3').value).toBe(ws.getCell('B3').value)

    // 重复加密防护：对已加密文件重跑，不再变化
    const re = await processXlsx(enc1, 'encrypt', selections, enc2, ctx, () => {})
    expect(re.processedCells).toBe(0)

    // 还原：与原文逐格一致（含类型）
    const dec = path.join(dir, 'dec.xlsx')
    const decSummary = await processXlsx(enc1, 'decrypt', {}, dec, ctx, () => {})
    expect(decSummary.failedCells).toEqual([])
    expect(decSummary.processedCells).toBe(7)
    const dwb = new ExcelJS.Workbook()
    await dwb.xlsx.readFile(dec)
    const dws = dwb.getWorksheet('订单')!
    expect(dws.getCell('B3').value).toBe('张三')
    expect(dws.getCell('C3').value).toBe('13800138000')
    expect(dws.getCell('F3').value).toEqual(new Date('2026-01-15T00:00:00.000Z'))
    expect(dwb.getWorksheet('隐藏表')!.getCell('A2').value).toBe('6222020200112233')
  })

  it('密码错误：第一个 ENC1 格即失败，整体中止', async () => {
    const src = path.join(dir, 'wrongpw.xlsx')
    const enc = path.join(dir, 'wrongpw-enc.xlsx')
    await buildFixture(src)
    await processXlsx(src, 'encrypt', { 订单: { headerRow: 2, cols: [2] } }, enc, ctx, () => {})
    const wrong = initCrypto('other-password', generateSalt())
    await expect(
      processXlsx(enc, 'decrypt', {}, path.join(dir, 'wrongpw-dec.xlsx'), wrong, () => {}),
    ).rejects.toThrow('密码不符或文件被篡改')
  })

  it('个别格损坏：记录地址、跳过并继续', async () => {
    const src = path.join(dir, 'partial.xlsx')
    const enc = path.join(dir, 'partial-enc.xlsx')
    await buildFixture(src)
    await processXlsx(src, 'encrypt', { 订单: { headerRow: 2, cols: [2, 3] } }, enc, ctx, () => {})
    // 篡改非首个 ENC1 格（C3；行优先扫描序上 B3 在前且完好）
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(enc)
    const ws = wb.getWorksheet('订单')!
    const encText = ws.getCell('C3').value as string
    const buf = Buffer.from(encText.slice('ENC1:'.length), 'base64')
    buf[buf.length - 1] ^= 1
    ws.getCell('C3').value = 'ENC1:' + buf.toString('base64')
    const tampered = path.join(dir, 'partial-tampered.xlsx')
    await wb.xlsx.writeFile(tampered)

    const summary = await processXlsx(
      tampered,
      'decrypt',
      {},
      path.join(dir, 'partial-dec.xlsx'),
      ctx,
      () => {},
    )
    expect(summary.failedCells).toEqual(['订单!C3'])
    expect(summary.processedCells).toBe(3) // B3、B4、C4 成功
  })
})
