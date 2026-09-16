/**
 * 词条展示排序：中文按拼音、英文按字母（locale zh-Hans-CN）。
 * 仅用于设置页列表展示，返回新数组，不改动入参（存储顺序保持不变）。
 */
export function sortTerms(list: string[]): string[] {
  return [...list].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}
