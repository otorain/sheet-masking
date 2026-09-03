import type { AnalyzeResult, ProcessSelections } from '../../electron/shared/types'

/**
 * 规则变化后重载表格的勾选合并：
 * 新勾选 = (旧勾选 − 旧自动命中) ∪ (新自动命中 − 旧自动命中里被手动取消的列)。
 * 手动勾选全保留、手动取消的不被重新勾上、
 * 不再自动命中的旧勾选（如关键词被移除）自动取消勾选。
 * 结果以新 analysis 的 sheet 列表为准；headerRow 取新 analysis 的值
 * （重载时以当前 headerRow 作 override 传入，因此即用户修正后的表头行）。
 */
export function mergeSelections(
  prev: AnalyzeResult,
  next: AnalyzeResult,
  prevSelections: ProcessSelections,
): ProcessSelections {
  const prevByName = new Map(prev.sheets.map((s) => [s.name, s]))
  const map: ProcessSelections = {}
  for (const s of next.sheets) {
    const prevAuto = new Set(
      prevByName
        .get(s.name)
        ?.headers.filter((h) => h.autoSelected)
        .map((h) => h.colIndex) ?? [],
    )
    const prevCols = prevSelections[s.name]?.cols ?? []
    const prevColsSet = new Set(prevCols)
    // 旧勾选里的手动部分（非自动命中）原样保留
    const manual = prevCols.filter((c) => !prevAuto.has(c))
    // 旧自动命中里被用户手动取消的列，即使新规则仍命中也不重新勾上
    const manuallyUnchecked = new Set([...prevAuto].filter((c) => !prevColsSet.has(c)))
    const auto = s.headers
      .filter((h) => h.autoSelected && !manuallyUnchecked.has(h.colIndex))
      .map((h) => h.colIndex)
    map[s.name] = {
      headerRow: s.headerRow,
      cols: [...new Set([...manual, ...auto])].sort((a, b) => a - b),
    }
  }
  return map
}
