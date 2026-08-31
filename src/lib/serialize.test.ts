import { reactive, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { deepUnwrap } from './serialize'

describe('deepUnwrap', () => {
  it('reactive Proxy 深解包为可 structuredClone 的普通对象', () => {
    const selections = reactive({ '账单.csv': { headerRow: 1, cols: [2, 3] } })
    // 前置条件：reactive Proxy 直接跨 IPC 克隆会抛 "An object could not be cloned"
    expect(() => structuredClone(selections)).toThrow()

    const plain = deepUnwrap(selections)
    expect(plain).toEqual({ '账单.csv': { headerRow: 1, cols: [2, 3] } })
    expect(() => structuredClone(plain)).not.toThrow()
  })

  it('嵌套 reactive 数组同样解包', () => {
    const keywords = ref(['工号', '户名'])
    const plain = deepUnwrap({ customKeywords: keywords.value })
    expect(plain).toEqual({ customKeywords: ['工号', '户名'] })
    expect(() => structuredClone(plain)).not.toThrow()
  })

  it('普通对象原样通过', () => {
    const obj = { a: 1, b: ['x'], c: { d: true } }
    expect(deepUnwrap(obj)).toEqual(obj)
  })
})
