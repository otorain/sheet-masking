// 主进程与渲染进程共享的 IPC 类型。纯 interface/type，双方都用 `import type` 引用，
// 转译后无运行时产物（vite-plugin-electron 逐文件转译，不会生成此文件）。
export type FileKind = 'xlsx' | 'csv'
export type ProcessMode = 'encrypt' | 'decrypt'

export interface SheetHeaderInfo {
  /** 1-based 列号 */
  colIndex: number
  name: string
  autoSelected: boolean
  matchedRules: string[]
}

export interface SheetAnalysis {
  name: string
  /** 隐藏 sheet 照常列出并标注，必须照常参与脱敏 */
  hidden: boolean
  /** 1-based 表头行号（自动探测，可手动修正后重跑规则） */
  headerRow: number
  headers: SheetHeaderInfo[]
}

export interface AnalyzeResult {
  filePath: string
  kind: FileKind
  sheets: SheetAnalysis[]
}

export interface SheetSelection {
  /** 1-based 表头行：加密时跳过该行（表头列名不是敏感数据，且保持已脱敏文件可再次分析） */
  headerRow: number
  /** 选中列（1-based 列号） */
  cols: number[]
}

/** key = sheet 名（csv 为文件 basename） */
export type ProcessSelections = Record<string, SheetSelection>

export interface ProcessSummary {
  processedCells: number
  skippedFormulas: number
  /** 还原时个别单元格校验失败的地址清单（如 "订单!B4"、"行3列2"） */
  failedCells: string[]
  outPath: string
}

export interface RulesConfig {
  /** 完全匹配：表头 trim 后 === 关键词 */
  exact: string[]
  /** 包含：表头 includes 关键词 */
  contains: string[]
  /** 以关键词开头 */
  startsWith: string[]
  /** 以关键词结尾 */
  endsWith: string[]
  /** 自定义内容正则 source（无预设）；保存时已校验可编译 */
  patterns: string[]
}
