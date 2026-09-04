import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { generateSalt, initCrypto, isEncrypted } from './crypto.js'
import { defaultRulesConfig } from './rules.js'
import { kindFromPath } from './sheet.js'
import { analyzeXls, processXls, sanitizeXlsProps } from './xls.js'

// 与 xls.ts 同理：xlsx 的 ESM 构建需手动注入 fs 才能 readFile/writeFile
XLSX.set_fs(fs)

const rules = defaultRulesConfig()
const ctx = initCrypto('test-password', generateSalt())

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
    // A5 合并主格须进 aoa：aoa_to_sheet 之后手动赋值不会更新 !ref，
    // SheetJS 写文件按 !ref 取格，范围外的单元格会被静默丢弃
    ['合并备注'],
  ])
  ws['E3'] = { t: 'd', v: new Date('2026-01-15T00:00:00.000Z'), z: 'yyyy-mm-dd' }
  ws['D3'].z = '0.00'
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
    expect(byName['姓名'].matchedRules).toContain('完全匹配：姓名')
    expect(byName['手机号'].matchedRules).toContain('完全匹配：手机号')
    expect(byName['订单号'].autoSelected).toBe(false)

    expect(sheets[1].hidden).toBe(true)
    expect(sheets[1].headerRow).toBe(1)
    expect(sheets[1].headers[0].autoSelected).toBe(true) // 卡号完全匹配关键词
  })

  it('表头行手动修正后重跑规则', async () => {
    const file = path.join(dir, 'override.xls')
    buildFixture(file)
    const sheets = await analyzeXls(file, rules, { 订单: 1 })
    expect(sheets[0].headerRow).toBe(1)
    expect(sheets[0].headers.map((h) => h.name)).toEqual(['订单报表（导出）'])
  })
})

/** 读回 xls（cellNF 取数字格式、cellStyles 是 biff8 解析 !cols 的门控） */
function readWb(filePath: string): XLSX.WorkBook {
  return XLSX.readFile(filePath, { cellDates: true, cellNF: true, cellStyles: true })
}

describe('processXls 加密→还原往返', () => {
  it('加密选中列（跳过表头行）、跨 sheet/跨文件密文一致、还原后与原文逐格一致、保真', async () => {
    const src = path.join(dir, 'roundtrip.xls')
    const src2 = path.join(dir, 'roundtrip2.xls')
    buildFixture(src)
    buildFixture(src2)
    const selections = {
      订单: { headerRow: 2, cols: [2, 3, 5] },
      隐藏表: { headerRow: 1, cols: [1, 2] },
    }
    const enc1 = path.join(dir, 'enc1.xls')
    const enc2 = path.join(dir, 'enc2.xls')
    const progress: number[] = []

    // 订单表头行（第 2 行）跳过；B3/B4、C3/C4、E3 共 5 格；隐藏表表头行跳过，A2/B2 共 2 格 → 合计 7
    const summary = await processXls(src, 'encrypt', selections, enc1, ctx, (p) =>
      progress.push(p),
    )
    expect(summary.processedCells).toBe(7)
    expect(summary.skippedFormulas).toBe(0)
    expect(progress[progress.length - 1]).toBe(100)

    await processXls(src2, 'encrypt', selections, enc2, ctx, () => {})

    const wb = readWb(enc1)
    const ws = wb.Sheets['订单']
    expect(ws['B2'].v).toBe('姓名') // 表头行不加密
    expect(isEncrypted(ws['B3'].v)).toBe(true)
    expect(isEncrypted(ws['C3'].v)).toBe(true)
    expect(ws['A3'].v).toBe('A001') // 未选列不动
    expect(ws['D3'].v).toBe(100.5) // 金额列不变

    // 跨 sheet 与跨文件：同一明文密文完全相同
    expect(wb.Sheets['隐藏表']['B2'].v).toBe(ws['B3'].v) // 张三 === 张三
    expect(readWb(enc2).Sheets['订单']['B3'].v).toBe(ws['B3'].v)

    // 重复加密防护：对已加密文件重跑，不再变化
    const re = await processXls(enc1, 'encrypt', selections, enc2, ctx, () => {})
    expect(re.processedCells).toBe(0)

    // 还原：与原文逐格一致（含类型）
    const dec = path.join(dir, 'dec.xls')
    const decSummary = await processXls(enc1, 'decrypt', {}, dec, ctx, () => {})
    expect(decSummary.failedCells).toEqual([])
    expect(decSummary.processedCells).toBe(7)
    const dwb = readWb(dec)
    const dws = dwb.Sheets['订单']
    expect(dws['B3'].v).toBe('张三')
    expect(dws['B3'].t).toBe('s')
    expect(dws['C3'].v).toBe('13800138000')
    expect(dws['E3'].t).toBe('d')
    expect(dws['E3'].v).toEqual(new Date('2026-01-15T00:00:00.000Z'))
    expect(dwb.Sheets['隐藏表']['A2'].v).toBe('6222020200112233')

    // 保真：数字格式/合并/列宽与原文件一致（同一读写链，深度相等即未丢）
    const sws = readWb(src).Sheets['订单']
    expect(dws['D3'].z).toBe('0.00')
    expect(dws['E3'].z).toBe('yyyy-mm-dd') // 被加解密格本身的数字格式同样保留
    expect(dws['!merges']).toEqual(sws['!merges'])
    expect(dws['!cols']).toEqual(sws['!cols'])
    expect(dwb.Workbook?.Sheets?.[1]?.Hidden).toBe(1) // 隐藏状态往返保留
  })

  it('表头以上的标题/注释行不加密（选中列含第 1 列）', async () => {
    const src = path.join(dir, 'above-header.xls')
    buildFixture(src)
    const enc = path.join(dir, 'above-header-enc.xls')
    // 选中列含第 1 列：A1 大标题落在选中列，但属于表头以上，不加密
    const summary = await processXls(
      src,
      'encrypt',
      { 订单: { headerRow: 2, cols: [1] } },
      enc,
      ctx,
      () => {},
    )
    expect(summary.processedCells).toBe(3) // A3/A4/A5（A5 合并主格，表头以下照常加密）

    const ws = readWb(enc).Sheets['订单']
    expect(ws['A1'].v).toBe('订单报表（导出）') // 表头以上的标题不加密
    expect(ws['A2'].v).toBe('订单号') // 表头行不加密
    expect(isEncrypted(ws['A3'].v)).toBe(true) // 表头以下数据加密
    expect(isEncrypted(ws['A4'].v)).toBe(true)

    // 还原后与原文一致
    const dec = path.join(dir, 'above-header-dec.xls')
    await processXls(enc, 'decrypt', {}, dec, ctx, () => {})
    const dws = readWb(dec).Sheets['订单']
    expect(dws['A3'].v).toBe('A001')
    expect(dws['A5'].v).toBe('合并备注')
  })

  it('密码错误：第一个 E2 格即失败，整体中止', async () => {
    const src = path.join(dir, 'wrongpw.xls')
    const enc = path.join(dir, 'wrongpw-enc.xls')
    buildFixture(src)
    await processXls(src, 'encrypt', { 订单: { headerRow: 2, cols: [2] } }, enc, ctx, () => {})
    const wrong = initCrypto('other-password', generateSalt())
    await expect(
      processXls(enc, 'decrypt', {}, path.join(dir, 'wrongpw-dec.xls'), wrong, () => {}),
    ).rejects.toThrow('密码不符或文件被篡改')
  })

  it('个别格损坏：记录地址、跳过并继续', async () => {
    const src = path.join(dir, 'partial.xls')
    const enc = path.join(dir, 'partial-enc.xls')
    buildFixture(src)
    await processXls(src, 'encrypt', { 订单: { headerRow: 2, cols: [2, 3] } }, enc, ctx, () => {})
    // 篡改非首个 E2 格（C3；行优先扫描序上 B3 在前且完好）
    const wb = readWb(enc)
    const cell = wb.Sheets['订单']['C3']
    const encText = cell.v as string
    const buf = Buffer.from(encText.slice(3), 'base64')
    buf[buf.length - 1] ^= 1
    cell.v = 'E2:' + buf.toString('base64').replace(/=+$/, '')
    const tampered = path.join(dir, 'partial-tampered.xls')
    XLSX.writeFile(wb, tampered, { bookType: 'biff8', bookSST: true })

    const summary = await processXls(
      tampered,
      'decrypt',
      {},
      path.join(dir, 'partial-dec.xls'),
      ctx,
      () => {},
    )
    expect(summary.failedCells).toEqual(['订单!C3'])
    expect(summary.processedCells).toBe(3) // B3、B4、C4 成功
  })

  it('空列选择整 sheet 跳过；超长文本（>255 字符）往返不截断', async () => {
    const wb = XLSX.utils.book_new()
    const longText = '长'.repeat(300)
    const ws = XLSX.utils.aoa_to_sheet([
      ['姓名', '备注'],
      ['张三', longText],
    ])
    XLSX.utils.book_append_sheet(wb, ws, '备注表')
    const src = path.join(dir, 'long.xls')
    XLSX.writeFile(wb, src, { bookType: 'biff8', bookSST: true })

    // 空列选择 → 整 sheet 跳过，文件照写但内容不变
    const enc = path.join(dir, 'long-enc.xls')
    const empty = await processXls(
      src,
      'encrypt',
      { 备注表: { headerRow: 1, cols: [] } },
      enc,
      ctx,
      () => {},
    )
    expect(empty.processedCells).toBe(0)
    expect(readWb(enc).Sheets['备注表']['A2'].v).toBe('张三')

    // 长文本加密→还原不截断（bookSST: Label 记录会截到 255 字符）
    const enc2 = path.join(dir, 'long-enc2.xls')
    const dec = path.join(dir, 'long-dec.xls')
    await processXls(src, 'encrypt', { 备注表: { headerRow: 1, cols: [1, 2] } }, enc2, ctx, () => {})
    expect(isEncrypted(readWb(enc2).Sheets['备注表']['B2'].v)).toBe(true)
    await processXls(enc2, 'decrypt', {}, dec, ctx, () => {})
    expect(readWb(dec).Sheets['备注表']['B2'].v).toBe(longText)
  })
})

describe('sanitizeXlsProps', () => {
  it('剔除写出器不支持的属性（Locale/Behavior/undefined），保留其余元数据', () => {
    const wb = XLSX.utils.book_new()
    wb.Props = {
      Title: '报表',
      Author: 'hope',
      Locale: 2052,
      Behavior: 1,
    } as XLSX.Properties
    ;(wb.Props as Record<string, unknown>)['undefined'] = 2052
    wb.Custprops = { Locale: 2052 } as unknown as XLSX.FullProperties

    sanitizeXlsProps(wb)

    expect(wb.Props).toEqual({ Title: '报表', Author: 'hope' })
    expect(wb.Custprops).toEqual({})
  })

  it('Props/Custprops 缺失时不报错', () => {
    expect(() => sanitizeXlsProps(XLSX.utils.book_new())).not.toThrow()
  })
})

describe('processXls 兼容 WPS 文件属性', () => {
  /** 手搓 SummaryInformation 属性流（CodePage=1200 + Locale(VT_UI4)=2052），
   *  模拟 WPS 文件：SheetJS 读取后 Props.Locale 为 VT_UI4 数字，
   *  其 CFB 写出器不支持该类型，不剔除会在 writeFile 抛
   *  "TypedPropertyValue unrecognized type 19 2052" */
  function buildWpsPropsFixture(filePath: string): void {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['姓名', '手机号'],
        ['张三', '13800138000'],
      ]),
      '订单',
    )
    const plain = XLSX.write(wb, { bookType: 'biff8', bookSST: true, type: 'buffer' }) as Buffer

    const si = Buffer.alloc(48 + 40)
    let o = 0
    si.writeUInt16LE(0xfffe, o); o += 2 // byte order
    si.writeUInt16LE(0, o); o += 2 // version
    o += 4 // SystemIdentifier
    o += 16 // CLSID（全零 HEADER_CLSID，解析放行）
    si.writeUInt32LE(1, o); o += 4 // NumSets
    o += 16 // FMTID0（解析只记录不校验）
    si.writeUInt32LE(48, o); o += 4 // Offset0
    si.writeUInt32LE(40, o); o += 4 // PropertySet size
    si.writeUInt32LE(2, o); o += 4 // NumProps
    si.writeUInt32LE(1, o); o += 4 // PID 1 = CodePage
    si.writeUInt32LE(24, o); o += 4
    si.writeUInt32LE(0x80000000, o); o += 4 // PID Locale
    si.writeUInt32LE(32, o); o += 4
    si.writeUInt16LE(0x02, o); o += 2 // VT_I2
    si.writeUInt16LE(0, o); o += 2
    si.writeUInt16LE(1200, o); o += 2
    si.writeUInt16LE(0, o); o += 2
    si.writeUInt16LE(0x13, o); o += 2 // VT_UI4
    si.writeUInt16LE(0, o); o += 2
    si.writeUInt32LE(2052, o); o += 4

    const cfb = XLSX.CFB.read(plain, { type: 'buffer' })
    XLSX.CFB.utils.cfb_add(cfb, '/SummaryInformation', si)
    fs.writeFileSync(filePath, XLSX.CFB.write(cfb, { type: 'buffer' }))
  }

  it('带 VT_UI4 Locale 属性的文件加密→还原全流程成功', async () => {
    const src = path.join(dir, 'wps-props.xls')
    buildWpsPropsFixture(src)
    // 前置条件：fixture 读取后确带 Locale 属性（否则测试没覆盖到崩溃路径）
    expect((XLSX.readFile(src).Props as Record<string, unknown>)?.Locale).toBe(2052)

    const enc = path.join(dir, 'wps-props-enc.xls')
    const dec = path.join(dir, 'wps-props-dec.xls')
    const summary = await processXls(
      src,
      'encrypt',
      { 订单: { headerRow: 1, cols: [1, 2] } },
      enc,
      ctx,
      () => {},
    )
    expect(summary.processedCells).toBe(2)
    expect(isEncrypted(readWb(enc).Sheets['订单']['A2'].v)).toBe(true)

    await processXls(enc, 'decrypt', {}, dec, ctx, () => {})
    const dws = readWb(dec).Sheets['订单']
    expect(dws['A2'].v).toBe('张三')
    expect(dws['B2'].v).toBe('13800138000')
  })
})
