import type { AnalyzeResult, ProcessSelections } from '../../electron/shared/types'

/**
 * 规则变化后重载表格的勾选合并：新勾选 = 旧勾选 ∪ (新自动命中 − 旧自动命中)。
 * 手动勾选全保留、手动取消的不被重新勾上、仅新增真正「新命中」的列。
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
    const newlyAuto = s.headers
      .filter((h) => h.autoSelected && !prevAuto.has(h.colIndex))
      .map((h) => h.colIndex)
    const prevCols = prevSelections[s.name]?.cols ?? []
    map[s.name] = {
      headerRow: s.headerRow,
      cols: [...new Set([...prevCols, ...newlyAuto])],
    }
  }
  return map
}
