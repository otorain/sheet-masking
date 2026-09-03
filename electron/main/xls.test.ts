import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { defaultRulesConfig } from './rules.js'
import { kindFromPath } from './sheet.js'
import { analyzeXls } from './xls.js'

// 与 xls.ts 同理：xlsx 的 ESM 构建需手动注入 fs 才能 readFile/writeFile
XLSX.set_fs(fs)

const rules = defaultRulesConfig()

let dir: string
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xls-test-'))
})
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('kindFromPath', () => {
  it('识别 .xls / .XLS 为 xls', () => {
    expect(kindFromPath('/tmp/a.xls')).toBe('xls')
    expect(kindFromPath('/tmp/A.XLS')).toBe('xls')
  })
  it('不支持的扩展名报错且列出受支持格式', () => {
    expect(() => kindFromPath('/tmp/a.doc')).toThrow('仅支持 .xlsx / .xls / .csv')
  })
})

/** 与 sheet.test.ts 同构：第 1 行大标题、第 2 行真实表头、日期/数字格式/合并/列宽/隐藏 sheet。
 *  无公式格：SheetJS 写公式需要二进制 bf，CE 无法生成（公式退化由文档承载）。 */
function buildFixture(filePath: string): void {
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet([
    ['订单报表（导出）'],
    ['订单号', '姓名', '手机号', '金额', '入职日期'],
    ['A001', '张三', '13800138000', 100.5],
    ['A002', '李四', '13900139000', 200],
  ])
  ws['E3'] = { t: 'd', v: new Date('2026-01-15T00:00:00.000Z'), z: 'yyyy-mm-dd' }
  ws['D3'].z = '0.00'
  ws['A5'] = { t: 's', v: '合并备注' }
  ws['!merges'] = [XLSX.utils.decode_range('A5:B5')]
  ws['!cols'] = [{ wch: 20 }]
  XLSX.utils.book_append_sheet(wb, ws, '订单')

  const hiddenWs = XLSX.utils.aoa_to_sheet([
    ['卡号', '备注'],
    ['6222020200112233', '张三'],
  ])
  XLSX.utils.book_append_sheet(wb, hiddenWs, '隐藏表')
  wb.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 1 }] }

  XLSX.writeFile(wb, filePath, { bookType: 'biff8', bookSST: true })
}

describe('analyzeXls', () => {
  it('探测表头行、按规则自动勾选、隐藏 sheet 照常列出并标注', async () => {
    const file = path.join(dir, 'analyze.xls')
    buildFixture(file)
    const sheets = await analyzeXls(file, rules)
    expect(sheets.map((s) => s.name)).toEqual(['订单', '隐藏表'])

    const order = sheets[0]
    expect(order.hidden).toBe(false)
    expect(order.headerRow).toBe(2)
    expect(order.headers.map((h) => h.name)).toEqual(['订单号', '姓名', '手机号', '金额', '入职日期'])
    const byName = Object.fromEntries(order.headers.map((h) => [h.name, h]))
    expect(byName['姓名'].autoSelected).toBe(true)
    expect(byName['姓名'].matchedRules).toContain('表头关键词：姓名')
    expect(byName['手机号'].matchedRules).toContain('内容正则：手机号')
    expect(byName['订单号'].autoSelected).toBe(false)

    expect(sheets[1].hidden).toBe(true)
    expect(sheets[1].headerRow).toBe(1)
    expect(sheets[1].headers[0].autoSelected).toBe(true) // 卡号关键词 + 银行卡内容正则
  })

  it('表头行手动修正后重跑规则', async () => {
    const file = path.join(dir, 'override.xls')
    buildFixture(file)
    const sheets = await analyzeXls(file, rules, { 订单: 1 })
    expect(sheets[0].headerRow).toBe(1)
    expect(sheets[0].headers.map((h) => h.name)).toEqual(['订单报表（导出）'])
  })
})
