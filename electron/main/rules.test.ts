import { describe, expect, it } from 'vitest'
import { DEFAULT_EXACT_KEYWORDS, defaultRulesConfig, matchColumns } from './rules.js'

const emptyRows: string[][] = []

describe('defaultRulesConfig', () => {
  it('exact 预填 24 个默认词，其余为空', () => {
    const config = defaultRulesConfig()
    expect(config.exact).toHaveLength(24)
    expect(config.exact).toContain('姓名')
    expect(config.exact).toContain('银行卡号')
    expect(config.contains).toEqual([])
    expect(config.startsWith).toEqual([])
    expect(config.endsWith).toEqual([])
    expect(config.patterns).toEqual([])
    expect(DEFAULT_EXACT_KEYWORDS).toHaveLength(24)
  })
})

describe('matchColumns 四类关键词', () => {
  it('完全匹配：表头恰好等于关键词才命中', () => {
    const result = matchColumns(['姓名', '姓名全称'], emptyRows, {
      ...defaultRulesConfig(),
      exact: ['姓名'],
    })
    expect(result[0].matchedRules).toEqual(['完全匹配：姓名'])
    expect(result[1].autoSelected).toBe(false)
  })

  it('包含：表头包含关键词即命中', () => {
    const result = matchColumns(['银行卡号', '金额'], emptyRows, {
      ...defaultRulesConfig(),
      exact: [],
      contains: ['卡号'],
    })
    expect(result[0].matchedRules).toEqual(['包含：卡号'])
    expect(result[1].autoSelected).toBe(false)
  })

  it('开头：表头以关键词开头才命中', () => {
    const result = matchColumns(['手机号', '号码'], emptyRows, {
      ...defaultRulesConfig(),
      exact: [],
      startsWith: ['手机'],
    })
    expect(result[0].matchedRules).toEqual(['开头：手机'])
    expect(result[1].autoSelected).toBe(false)
  })

  it('结尾：表头以关键词结尾才命中', () => {
    const result = matchColumns(['联系电话', '电话费'], emptyRows, {
      ...defaultRulesConfig(),
      exact: [],
      endsWith: ['电话'],
    })
    expect(result[0].matchedRules).toEqual(['结尾：电话'])
    expect(result[1].autoSelected).toBe(false)
  })

  it('表头首尾空白 trim 后参与匹配', () => {
    const result = matchColumns([' 姓名 '], emptyRows, defaultRulesConfig())
    expect(result[0].matchedRules).toContain('完全匹配：姓名')
  })

  it('空串与仅空白关键词被忽略', () => {
    const result = matchColumns(['a'], emptyRows, {
      ...defaultRulesConfig(),
      exact: ['', '   '],
      contains: [''],
    })
    expect(result[0].autoSelected).toBe(false)
  })

  it('同一关键词允许跨类存在，各自独立命中', () => {
    const result = matchColumns(['卡号'], emptyRows, {
      ...defaultRulesConfig(),
      exact: ['卡号'],
      contains: ['卡号'],
    })
    expect(result[0].matchedRules).toEqual(['完全匹配：卡号', '包含：卡号'])
  })
})

describe('matchColumns 内容正则', () => {
  it('自定义正则命中抽样内容', () => {
    const result = matchColumns(['单号'], [['ORD-123'], ['ORD-456']], {
      ...defaultRulesConfig(),
      exact: [],
      patterns: ['^ORD-\\d+$'],
    })
    expect(result[0].autoSelected).toBe(true)
    expect(result[0].matchedRules).toContain('正则：^ORD-\\d+$')
  })

  it('无效自定义正则被跳过且不中断', () => {
    const result = matchColumns(['单号'], [['ORD-123']], {
      ...defaultRulesConfig(),
      exact: [],
      patterns: ['(', '^ORD-\\d+$'],
    })
    expect(result[0].autoSelected).toBe(true)
  })

  it('无命中时 autoSelected=false 且 matchedRules 为空', () => {
    const result = matchColumns(['金额', '数量'], [['100', '3']], {
      ...defaultRulesConfig(),
      exact: [],
    })
    expect(result).toEqual([
      { autoSelected: false, matchedRules: [] },
      { autoSelected: false, matchedRules: [] },
    ])
  })
})
