import type {
  ProcessMode,
  ProcessSummary,
  RulesConfig,
  SheetAnalysis,
  SheetSelection,
} from '../shared/types.js'
import type { CryptoContext } from './crypto.js'

// Task 6 实现 CSV 引擎；本文件先占位使 sheet.ts 的分发可通过类型检查。
export async function analyzeCsv(
  _filePath: string,
  _rules: RulesConfig,
  _headerRowOverride?: number,
): Promise<SheetAnalysis[]> {
  throw new Error('CSV 支持尚未实现（Task 6）')
}

export async function processCsv(
  _filePath: string,
  _mode: ProcessMode,
  _selection: SheetSelection | undefined,
  _outPath: string,
  _ctx: CryptoContext,
  _onProgress: (percent: number) => void,
): Promise<ProcessSummary> {
  throw new Error('CSV 支持尚未实现（Task 6）')
}
