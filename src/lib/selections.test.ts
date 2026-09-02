import { describe, expect, it } from 'vitest'
import { mergeSelections } from './selections'
import type {
  AnalyzeResult,
  SheetAnalysis,
  SheetHeaderInfo,
} from '../../electron/shared/types'

function headers(list: Array<[number, string, boolean]>): SheetHeaderInfo[] {
  return list.map(([colIndex, name, autoSelected]) => ({
    colIndex,
    name,
    autoSelected,
    matchedRules: [],
  }))
}

function sheet(
  name: string,
  list: Array<[number, string, boolean]>,
  headerRow = 1,
): SheetAnalysis {
  return { name, hidden: false, headerRow, headers: headers(list) }
}

function analysis(sheets: SheetAnalysis[]): AnalyzeResult {
  return { filePath: '/tmp/a.xlsx', kind: 'xlsx', sheets }
}

describe('mergeSelections', () => {
  it('保留手动勾选，新命中列自动补勾', () => {
    const prev = analysis([
      sheet('订单', [
        [1, '日期', false],
        [2, '姓名', true],
        [3, '金额', false],
        [4, '备注', false],
      ]),
    ])
    // 用户手动加勾了 1、4，保留了自动命中的 2
    const prevSel = { 订单: { headerRow: 1, cols: [1, 2, 4] } }
    const next = analysis([
      sheet('订单', [
        [1, '日期', false],
        [2, '姓名', true],
        [3, '金额', true],
        [4, '备注', false],
      ]),
    ])

    const merged = mergeSelections(prev, next, prevSel)
    expect(merged.订单.cols).toEqual([1, 2, 4, 3])
  })

  it('手动取消的旧命中列不被重新勾上（只补真正新命中的列）', () => {
    const prev = analysis([
      sheet('订单', [
        [2, '姓名', true],
        [3, '金额', false],
      ]),
    ])
    // 用户手动取消了自动命中的 2
    const prevSel = { 订单: { headerRow: 1, cols: [] } }
    const next = analysis([
      sheet('订单', [
        [2, '姓名', true],
        [3, '金额', true],
      ]),
    ])

    const merged = mergeSelections(prev, next, prevSel)
    expect(merged.订单.cols).toEqual([3])
  })

  it('新 sheet 按自动命中全选；消失的 sheet 被丢弃；headerRow 取新分析值', () => {
    const prev = analysis([sheet('旧', [[1, 'a', true]])])
    const prevSel = { 旧: { headerRow: 1, cols: [1] } }
    const next = analysis([
      sheet(
        '新',
        [
          [1, 'x', true],
          [2, 'y', false],
        ],
        2,
      ),
    ])

    const merged = mergeSelections(prev, next, prevSel)
    expect(merged.旧).toBeUndefined()
    expect(merged.新).toEqual({ headerRow: 2, cols: [1] })
  })
})
