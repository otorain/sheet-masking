import { describe, expect, it } from 'vitest'
import { sortTerms } from './sort'

describe('sortTerms', () => {
  it('中文按拼音排序', () => {
    expect(sortTerms(['卡号', '工号', '电话'])).toEqual(['电话', '工号', '卡号'])
  })

  it('英文按字母排序', () => {
    expect(sortTerms(['ID', 'abc', 'Account'])).toEqual(['abc', 'Account', 'ID'])
  })

  it('中英文混合：汉字按拼音在前，拉丁字母在后（ICU zh 排序规则）', () => {
    expect(sortTerms(['abc', '卡号', '工号'])).toEqual(['工号', '卡号', 'abc'])
  })

  it('不改动原数组', () => {
    const src = ['b', 'a']
    const out = sortTerms(src)
    expect(src).toEqual(['b', 'a'])
    expect(out).toEqual(['a', 'b'])
    expect(out).not.toBe(src)
  })
})
