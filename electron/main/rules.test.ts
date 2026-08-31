import { describe, expect, it } from 'vitest'
import { BUILTIN_RULES, defaultRulesConfig, matchColumns } from './rules.js'

const emptyRows: string[][] = []

describe('defaultRulesConfig', () => {
  it('默认全部内置启用、无自定义', () => {
    expect(defaultRulesConfig()).toEqual({
      disabledBuiltins: [],
      customKeywords: [],
      customPatterns: [],
    })
    expect(BUILTIN_RULES.length).toBeGreaterThanOrEqual(13)
  })
})

describe('matchColumns 内置规则', () => {
  const config = defaultRulesConfig()

  it('表头关键词命中（姓名/手机号），其余不命中', () => {
    const result = matchColumns(['订单号', '姓名', '手机号', '金额'], emptyRows, config)
    expect(result.map((r) => r.autoSelected)).toEqual([false, true, true, false])
    expect(result[1].matchedRules).toContain('表头关键词：姓名')
    expect(result[2].matchedRules).toContain('表头关键词：手机号')
  })

  it('内容正则命中：表头无关键词但抽样内容命中手机号', () => {
    const result = matchColumns(
      ['单号', '联系方式'],
      [
        ['A001', '13800138000'],
        ['A002', '13900139000'],
      ],
      config,
    )
    expect(result[1].autoSelected).toBe(true)
    expect(result[1].matchedRules).toContain('内容正则：手机号')
  })

  it('身份证/银行卡/邮箱内容正则', () => {
    const result = matchColumns(
      ['a', 'b', 'c'],
      [['110101199003071234', '6222020200112233', 'a@b.com']],
      config,
    )
    expect(result[0].matchedRules).toContain('内容正则：身份证（18 位）')
    expect(result[1].matchedRules).toContain('内容正则：银行卡号（16-19 位）')
    expect(result[2].matchedRules).toContain('内容正则：邮箱')
  })

  it('手机号正则不误伤长数字串内部', () => {
    const result = matchColumns(['x'], [['6222020200112233']], config)
    expect(result[0].matchedRules).not.toContain('内容正则：手机号')
  })

  it('禁用内置规则后不再命中', () => {
    const disabled = matchColumns(['姓名'], emptyRows, {
      ...config,
      disabledBuiltins: ['kw:姓名'],
    })
    expect(disabled[0].autoSelected).toBe(false)
    expect(disabled[0].matchedRules).toEqual([])
  })
})

describe('matchColumns 自定义规则', () => {
  it('自定义关键词命中表头', () => {
    const result = matchColumns(['工号'], emptyRows, {
      ...defaultRulesConfig(),
      customKeywords: ['工号'],
    })
    expect(result[0].autoSelected).toBe(true)
    expect(result[0].matchedRules).toContain('自定义关键词：工号')
  })

  it('自定义正则命中内容', () => {
    const result = matchColumns(['单号'], [['ORD-123'], ['ORD-456']], {
      ...defaultRulesConfig(),
      customPatterns: ['^ORD-\\d+$'],
    })
    expect(result[0].autoSelected).toBe(true)
    expect(result[0].matchedRules).toContain('自定义正则：^ORD-\\d+$')
  })

  it('无效自定义正则被跳过且不中断', () => {
    const result = matchColumns(['单号'], [['ORD-123']], {
      ...defaultRulesConfig(),
      customPatterns: ['(', '^ORD-\\d+$'],
    })
    expect(result[0].autoSelected).toBe(true)
  })

  it('无命中时 autoSelected=false 且 matchedRules 为空', () => {
    const result = matchColumns(['金额', '数量'], [['100', '3']], defaultRulesConfig())
    expect(result).toEqual([
      { autoSelected: false, matchedRules: [] },
      { autoSelected: false, matchedRules: [] },
    ])
  })
})
