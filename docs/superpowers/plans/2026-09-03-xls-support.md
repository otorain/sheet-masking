# .xls 文件支持实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让报表脱敏工具支持 .xls（BIFF）文件的解析、脱敏与还原，输出仍为 .xls。

**Architecture:** 新增 `electron/main/xls.ts`（SheetJS 读写 .xls，与 `csv.ts` 平级）；
把 `sheet.ts` 中 xlsx/csv 共用的表头探测/分析构造函数抽到 `electron/main/analysis.ts`
（避免 sheet.ts ↔ xls.ts 循环 import）；`sheet.ts` 的 `kindFromPath`/`analyzeFile`/
`processFile` 加 xls 分支；IPC 入口与 UI 文案放行 .xls。

**Tech Stack:** SheetJS `xlsx@0.20.3`（官方 CDN tarball）、vitest、Electron 主进程 ESM。

**Spec:** `docs/superpowers/specs/2026-09-03-xls-support-design.md`（含第 3 节 SheetJS
源码勘察结论：公式退化、bookSST、set_fs，实施前必读）。

**Worktree:** 所有工作在 `/home/ian/data/src/tries/2026-08-31-encoding-sheet/sheet-masking/.worktrees/feat-xls-support`（分支 `feat-xls-support`）进行并提交。

## Global Constraints

- `electron/` 内相对 import **必须带 `.js` 后缀**（主进程 notBundle 逐文件转译 ESM）。
- SheetJS 固定用法：`import * as XLSX from 'xlsx'`，且模块顶部 `XLSX.set_fs(fs)`
  （ESM 构建不自动加载 node:fs，否则 readFile/writeFile 不可用）。
- .xls 写回固定 `XLSX.writeFile(wb, outPath, { bookType: 'biff8', bookSST: true })`
  （缺 bookSST 时字符串按 Label 记录写，>255 字符被截断）。
- processXls 读入选项固定 `{ cellDates: true, cellNF: true, cellStyles: true }`
  （cellStyles 是 biff8 解析 `!cols` 列宽的门控；cellNF 保留 `cell.z` 数字格式）。
- **xls 不跳过公式格**：SheetJS 写回必然丢失公式（只认二进制 `cell.bf`，解析不产生），
  公式格按缓存值类型照常加密，防止选中列敏感值明文残留；`skippedFormulas` 对 xls 恒 0。
- 测试：vitest node 环境，`*.test.ts` 与被测文件同目录；用 SheetJS 在临时目录写真实
  .xls fixture 做加密→还原往返断言。
- 提交信息：英文 conventional commits，在 worktree 的 `feat-xls-support` 分支提交。
- 界面与文档文案为中文。
- 聚焦验证命令：`pnpm exec vitest run electron/main/xls.test.ts`；全量验证链（Task 5 用）：
  `pnpm exec vitest run && pnpm exec vue-tsc --noEmit && pnpm exec tsc --noEmit -p tsconfig.node.json && pnpm exec vite build`

---

### Task 1: 安装 SheetJS 依赖 + FileKind/kindFromPath 支持 .xls

**Files:**
- Modify: `package.json`（dependencies 加 xlsx；经 pnpm add 完成）
- Modify: `pnpm-lock.yaml`（pnpm add 自动更新）
- Modify: `electron/shared/types.ts:3`（FileKind）
- Modify: `electron/main/sheet.ts:30-35`（kindFromPath）
- Test: `electron/main/xls.test.ts`（新建，先只放 kindFromPath 用例）

**Interfaces:**
- Produces: `FileKind = 'xlsx' | 'xls' | 'csv'`；`kindFromPath('/a.xls') === 'xls'`（大小写不敏感）。
  后续任务与 `index.ts` 依赖此。

- [ ] **Step 1: 安装依赖**

```bash
pnpm add "xlsx@https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"
```

预期：package.json dependencies 出现
`"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"`。xlsx 无 install 钩子，
`pnpm-workspace.yaml` 的 allowBuilds 不需要改。

- [ ] **Step 2: 写失败测试**

新建 `electron/main/xls.test.ts`：

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { kindFromPath } from './sheet.js'

let dir: string
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xls-test-'))
})
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('kindFromPath', () => {
  it('识别 .xls / .XLS 为 xls', () => {
    expect(kindFromPath('/tmp/a.xls')).toBe('xls')
    expect(kindFromPath('/tmp/A.XLS')).toBe('xls')
  })
  it('不支持的扩展名报错且列出受支持格式', () => {
    expect(() => kindFromPath('/tmp/a.doc')).toThrow('仅支持 .xlsx / .xls / .csv')
  })
})
```

- [ ] **Step 3: 跑测试确认红**

Run: `pnpm exec vitest run electron/main/xls.test.ts`
Expected: FAIL（`.xls` 当前抛「不支持的文件格式」）

- [ ] **Step 4: 实现**

`electron/shared/types.ts:3`：

```ts
export type FileKind = 'xlsx' | 'xls' | 'csv'
```

`electron/main/sheet.ts` 的 `kindFromPath`：

```ts
export function kindFromPath(filePath: string): FileKind {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.xlsx') return 'xlsx'
  if (ext === '.xls') return 'xls'
  if (ext === '.csv') return 'csv'
  throw new Error(`不支持的文件格式：${ext || filePath}（仅支持 .xlsx / .xls / .csv）`)
}
```

- [ ] **Step 5: 跑测试确认绿 + 全量不回归**

Run: `pnpm exec vitest run electron/main/xls.test.ts && pnpm exec vitest run`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml electron/shared/types.ts electron/main/sheet.ts electron/main/xls.test.ts
git commit -m "feat: recognize .xls file kind and add SheetJS dependency"
```

---

### Task 2: 抽取共享分析 helpers 到 analysis.ts（纯重构，不改行为）

xls.ts 需要复用 `sheet.ts` 的 `detectHeaderRow`/`buildAnalysis`/常量；若 xls.ts 直接
import sheet.ts 而 sheet.ts 的 dispatch 又 import xls.ts，会形成 ESM 循环依赖
（sheet.js 先求值 → xls.js 顶层读 sheet.js 的 const 触发 TDZ）。抽到独立模块消除环。

**Files:**
- Create: `electron/main/analysis.ts`
- Modify: `electron/main/sheet.ts`（删 helpers，改 import）
- Modify: `electron/main/csv.ts:13-19,34`（import 来源 + 删本地 MAX_READ_ROWS）
- Modify: `electron/main/sheet.test.ts:8`（detectHeaderRow 改从 analysis.js 导入）

**Interfaces:**
- Consumes: 现有 `sheet.ts` 中被移动的全部符号。
- Produces: `analysis.ts` 导出 `HEADER_CANDIDATE_ROWS`、`SAMPLE_DATA_ROWS`、
  `MAX_READ_ROWS`（新导出）、`YIELD_EVERY_ROWS`、`detectHeaderRow`、`buildAnalysis`——
  签名与现状完全一致。`sheet.ts` 不再导出这些符号（csv.ts/sheet.test.ts 同步改导入）。

- [ ] **Step 1: 创建 `electron/main/analysis.ts`**

```ts
import { matchColumns } from './rules.js'
import type { RulesConfig, SheetAnalysis } from '../shared/types.js'

/** 表头行探测窗口（前 5 行）与内容抽样行数（表头后 50 行） */
export const HEADER_CANDIDATE_ROWS = 5
export const SAMPLE_DATA_ROWS = 50
export const MAX_READ_ROWS = HEADER_CANDIDATE_ROWS + SAMPLE_DATA_ROWS
/** 每处理 N 行让出一次事件循环并推送进度 */
export const YIELD_EVERY_ROWS = 500

/**
 * 表头行自动探测：表头是文字而数据多为数字，故前 5 行中取「非空且非纯数字单元格最多
 * 且下一行有数据」的行；数量相同取靠前的行；末行无下一行也允许参选。返回 1-based 行号。
 */
export function detectHeaderRow(denseRows: string[][]): number {
  const isText = (v: string): boolean => v !== '' && !Number.isFinite(Number(v))
  let best = 0
  let bestCount = -1
  const limit = Math.min(denseRows.length, HEADER_CANDIDATE_ROWS)
  for (let i = 0; i < limit; i++) {
    if (i + 1 < denseRows.length && !denseRows[i + 1].some((v) => v !== '')) continue
    const count = denseRows[i].filter(isText).length
    if (count > bestCount) {
      bestCount = count
      best = i
    }
  }
  return best + 1
}

/** 由稠密行文本构造 SheetAnalysis（xlsx/xls/csv 共用）：表头行 → headers，其后 50 行抽样跑规则 */
export function buildAnalysis(
  name: string,
  hidden: boolean,
  headerRow: number,
  denseRows: string[][],
  rules: RulesConfig,
): SheetAnalysis {
  const headerValues = (denseRows[headerRow - 1] ?? []).map((v) => v.trim())
  const width = headerValues.length
  const sampleRows = denseRows.slice(headerRow, headerRow + SAMPLE_DATA_ROWS).map((row) => {
    const padded = row.slice(0, width)
    while (padded.length < width) padded.push('')
    return padded
  })
  const matches = matchColumns(headerValues, sampleRows, rules)
  return {
    name,
    hidden,
    headerRow,
    headers: headerValues.map((value, i) => ({
      colIndex: i + 1,
      name: value || `(列 ${i + 1})`,
      autoSelected: matches[i].autoSelected,
      matchedRules: matches[i].matchedRules,
    })),
  }
}
```

- [ ] **Step 2: 改 `sheet.ts`**

删除：`HEADER_CANDIDATE_ROWS`/`SAMPLE_DATA_ROWS`/`MAX_READ_ROWS`/`YIELD_EVERY_ROWS`
常量块（23-28 行）、`detectHeaderRow` 与 `buildAnalysis` 两个函数整体、以及
`import { matchColumns } from './rules.js'`（sheet.ts 不再使用）。

新增 import（放在 crypto.js import 之后）：

```ts
import {
  MAX_READ_ROWS,
  YIELD_EVERY_ROWS,
  buildAnalysis,
  detectHeaderRow,
} from './analysis.js'
```

`sheet.ts` 保留：`kindFromPath`、`analyzeFile`、`processFile`、`streamCellText`、
`normalizeStreamRow`、`analyzeXlsx`、`processXlsx`。

- [ ] **Step 3: 改 `csv.ts`**

13-19 行的 import 改为（删 HEADER_CANDIDATE_ROWS/SAMPLE_DATA_ROWS，加 MAX_READ_ROWS，来源改 analysis.js）：

```ts
import {
  MAX_READ_ROWS,
  YIELD_EVERY_ROWS,
  buildAnalysis,
  detectHeaderRow,
} from './analysis.js'
```

删除 34 行的本地定义 `const MAX_READ_ROWS = HEADER_CANDIDATE_ROWS + SAMPLE_DATA_ROWS`。

- [ ] **Step 4: 改 `sheet.test.ts:8`**

```ts
import { detectHeaderRow } from './analysis.js'
import { analyzeXlsx, processXlsx } from './sheet.js'
```

- [ ] **Step 5: 全量测试 + 类型检查**

Run: `pnpm exec vitest run && pnpm exec tsc --noEmit -p tsconfig.node.json`
Expected: 全部 PASS（行为零变化，现有用例即验证）

- [ ] **Step 6: Commit**

```bash
git add electron/main/analysis.ts electron/main/sheet.ts electron/main/csv.ts electron/main/sheet.test.ts
git commit -m "refactor: extract shared sheet analysis helpers into analysis.ts"
```

---

### Task 3: analyzeXls + analyzeFile dispatch

**Files:**
- Create: `electron/main/xls.ts`
- Modify: `electron/main/sheet.ts`（import analyzeXls；analyzeFile 加分支）
- Test: `electron/main/xls.test.ts`（追加 fixture + analyzeXls 用例）

**Interfaces:**
- Consumes: Task 2 的 `analysis.ts`；`rules.ts` 的 `RulesConfig`。
- Produces: `analyzeXls(filePath: string, rules: RulesConfig, headerRowOverrides?: Record<string, number>): Promise<SheetAnalysis[]>`
  —— 与 `analyzeXlsx` 签名一致，`sheet.ts` 的 `analyzeFile` 按 kind 分发到它。

- [ ] **Step 1: 追加失败测试**

`xls.test.ts` 顶部 import 区追加：

```ts
import * as XLSX from 'xlsx'
import { defaultRulesConfig } from './rules.js'
import { analyzeXls } from './xls.js'

// 与 xls.ts 同理：xlsx 的 ESM 构建需手动注入 fs 才能 readFile/writeFile
XLSX.set_fs(fs)

const rules = defaultRulesConfig()
```

fixture 与用例追加到文件尾：

```ts
/** 与 sheet.test.ts 同构：第 1 行大标题、第 2 行真实表头、日期/数字格式/合并/列宽/隐藏 sheet。
 *  无公式格：SheetJS 写公式需要二进制 bf，CE 无法生成（公式退化由文档承载）。 */
function buildFixture(filePath: string): void {
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet([
    ['订单报表（导出）'],
    ['订单号', '姓名', '手机号', '金额', '入职日期'],
    ['A001', '张三', '13800138000', 100.5],
    ['A002', '李四', '13900139000', 200],
  ])
  ws['E3'] = { t: 'd', v: new Date('2026-01-15T00:00:00.000Z'), z: 'yyyy-mm-dd' }
  ws['D3'].z = '0.00'
  ws['A5'] = { t: 's', v: '合并备注' }
  ws['!merges'] = [XLSX.utils.decode_range('A5:B5')]
  ws['!cols'] = [{ wch: 20 }]
  XLSX.utils.book_append_sheet(wb, ws, '订单')

  const hiddenWs = XLSX.utils.aoa_to_sheet([
    ['卡号', '备注'],
    ['6222020200112233', '张三'],
  ])
  XLSX.utils.book_append_sheet(wb, hiddenWs, '隐藏表')
  wb.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 1 }] }

  XLSX.writeFile(wb, filePath, { bookType: 'biff8', bookSST: true })
}

describe('analyzeXls', () => {
  it('探测表头行、按规则自动勾选、隐藏 sheet 照常列出并标注', async () => {
    const file = path.join(dir, 'analyze.xls')
    buildFixture(file)
    const sheets = await analyzeXls(file, rules)
    expect(sheets.map((s) => s.name)).toEqual(['订单', '隐藏表'])

    const order = sheets[0]
    expect(order.hidden).toBe(false)
    expect(order.headerRow).toBe(2)
    expect(order.headers.map((h) => h.name)).toEqual(['订单号', '姓名', '手机号', '金额', '入职日期'])
    const byName = Object.fromEntries(order.headers.map((h) => [h.name, h]))
    expect(byName['姓名'].autoSelected).toBe(true)
    expect(byName['姓名'].matchedRules).toContain('表头关键词：姓名')
    expect(byName['手机号'].matchedRules).toContain('内容正则：手机号')
    expect(byName['订单号'].autoSelected).toBe(false)

    expect(sheets[1].hidden).toBe(true)
    expect(sheets[1].headerRow).toBe(1)
    expect(sheets[1].headers[0].autoSelected).toBe(true) // 卡号关键词 + 银行卡内容正则
  })

  it('表头行手动修正后重跑规则', async () => {
    const file = path.join(dir, 'override.xls')
    buildFixture(file)
    const sheets = await analyzeXls(file, rules, { 订单: 1 })
    expect(sheets[0].headerRow).toBe(1)
    expect(sheets[0].headers.map((h) => h.name)).toEqual(['订单报表（导出）'])
  })
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `pnpm exec vitest run electron/main/xls.test.ts`
Expected: FAIL（`./xls.js` 模块不存在）

- [ ] **Step 3: 创建 `electron/main/xls.ts`（先只含 analyze）**

```ts
import fs from 'node:fs'
import * as XLSX from 'xlsx'
import { MAX_READ_ROWS, buildAnalysis, detectHeaderRow } from './analysis.js'
import type { RulesConfig, SheetAnalysis } from '../shared/types.js'

// xlsx 的 ESM 构建（xlsx.mjs）不自动加载 node:fs，readFile/writeFile 前必须注入
XLSX.set_fs(fs)

/** analyze 用：SheetJS 原始单元格值 → 文本（不开 cellDates，日期以序列号数字出现，
 *  与 xlsx analyze（styles:'ignore'）行为一致，可接受） */
function cellText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

export async function analyzeXls(
  filePath: string,
  rules: RulesConfig,
  headerRowOverrides: Record<string, number> = {},
): Promise<SheetAnalysis[]> {
  const wb = XLSX.readFile(filePath, { sheetRows: MAX_READ_ROWS })
  return wb.SheetNames.map((name, i) => {
    const ws = wb.Sheets[name]
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: '' })
    const denseRows = rows.map((row) => {
      const out = row.map(cellText)
      // 去掉行尾空列（对齐 xlsx normalizeStreamRow；xls 的 range 常含格式残留空列）
      while (out.length > 0 && out[out.length - 1] === '') out.pop()
      return out
    })
    const hidden = (wb.Workbook?.Sheets?.[i]?.Hidden ?? 0) !== 0
    const headerRow = headerRowOverrides[name] ?? detectHeaderRow(denseRows)
    return buildAnalysis(name, hidden, headerRow, denseRows, rules)
  })
}
```

- [ ] **Step 4: `sheet.ts` 加 analyze 分发**

import 区加：

```ts
import { analyzeXls } from './xls.js'
```

`analyzeFile` 改为：

```ts
export async function analyzeFile(
  filePath: string,
  rules: RulesConfig,
  headerRowOverrides: Record<string, number> = {},
): Promise<AnalyzeResult> {
  const kind = kindFromPath(filePath)
  const sheets =
    kind === 'xlsx'
      ? await analyzeXlsx(filePath, rules, headerRowOverrides)
      : kind === 'xls'
        ? await analyzeXls(filePath, rules, headerRowOverrides)
        : await analyzeCsv(filePath, rules, headerRowOverrides[path.basename(filePath)])
  return { filePath, kind, sheets }
}
```

- [ ] **Step 5: 跑测试确认绿 + 全量不回归**

Run: `pnpm exec vitest run electron/main/xls.test.ts && pnpm exec vitest run && pnpm exec tsc --noEmit -p tsconfig.node.json`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add electron/main/xls.ts electron/main/xls.test.ts electron/main/sheet.ts
git commit -m "feat: analyze .xls files via SheetJS"
```

---

### Task 4: processXls + processFile dispatch

**Files:**
- Modify: `electron/main/xls.ts`（追加 xlsCellToPayload + processXls，扩 import）
- Modify: `electron/main/sheet.ts`（import processXls；processFile 加分支）
- Test: `electron/main/xls.test.ts`（追加 processXls 用例）

**Interfaces:**
- Consumes: `crypto.ts` 的 `encryptPayload`/`decryptPayload`/`isEncrypted`/
  `payloadToValue`/`CryptoContext`/`CellPayload`；`analysis.ts` 的 `YIELD_EVERY_ROWS`。
- Produces: `processXls(filePath: string, mode: ProcessMode, selections: ProcessSelections, outPath: string, ctx: CryptoContext, onProgress: (percent: number) => void): Promise<ProcessSummary>`
  —— 与 `processXlsx` 签名一致，`processFile` 按 kind 分发到它。selections 按 sheet 名索引。

- [ ] **Step 1: 追加失败测试**

`xls.test.ts` import 区：追加 crypto 导入，并把 `import { analyzeXls } from './xls.js'` 改为
`import { analyzeXls, processXls } from './xls.js'`：

```ts
import { generateSalt, initCrypto, isEncrypted } from './crypto.js'
import { analyzeXls, processXls } from './xls.js'
```

在 `const rules = defaultRulesConfig()` 后追加一行：

```ts
const ctx = initCrypto('test-password', generateSalt())
```

再加读回 helper 与用例（文件尾）：

```ts
/** 读回 xls（cellNF 取数字格式、cellStyles 是 biff8 解析 !cols 的门控） */
function readWb(filePath: string): XLSX.WorkBook {
  return XLSX.readFile(filePath, { cellDates: true, cellNF: true, cellStyles: true })
}

describe('processXls 加密→还原往返', () => {
  it('加密选中列（跳过表头行）、跨 sheet/跨文件密文一致、还原后与原文逐格一致、保真', async () => {
    const src = path.join(dir, 'roundtrip.xls')
    const src2 = path.join(dir, 'roundtrip2.xls')
    buildFixture(src)
    buildFixture(src2)
    const selections = {
      订单: { headerRow: 2, cols: [2, 3, 5] },
      隐藏表: { headerRow: 1, cols: [1, 2] },
    }
    const enc1 = path.join(dir, 'enc1.xls')
    const enc2 = path.join(dir, 'enc2.xls')
    const progress: number[] = []

    // 订单表头行（第 2 行）跳过；B3/B4、C3/C4、E3 共 5 格；隐藏表表头行跳过，A2/B2 共 2 格 → 合计 7
    const summary = await processXls(src, 'encrypt', selections, enc1, ctx, (p) =>
      progress.push(p),
    )
    expect(summary.processedCells).toBe(7)
    expect(summary.skippedFormulas).toBe(0)
    expect(progress[progress.length - 1]).toBe(100)

    await processXls(src2, 'encrypt', selections, enc2, ctx, () => {})

    const wb = readWb(enc1)
    const ws = wb.Sheets['订单']
    expect(ws['B2'].v).toBe('姓名') // 表头行不加密
    expect(isEncrypted(ws['B3'].v)).toBe(true)
    expect(isEncrypted(ws['C3'].v)).toBe(true)
    expect(ws['A3'].v).toBe('A001') // 未选列不动
    expect(ws['D3'].v).toBe(100.5) // 金额列不变

    // 跨 sheet 与跨文件：同一明文密文完全相同
    expect(wb.Sheets['隐藏表']['B2'].v).toBe(ws['B3'].v) // 张三 === 张三
    expect(readWb(enc2).Sheets['订单']['B3'].v).toBe(ws['B3'].v)

    // 重复加密防护：对已加密文件重跑，不再变化
    const re = await processXls(enc1, 'encrypt', selections, enc2, ctx, () => {})
    expect(re.processedCells).toBe(0)

    // 还原：与原文逐格一致（含类型）
    const dec = path.join(dir, 'dec.xls')
    const decSummary = await processXls(enc1, 'decrypt', {}, dec, ctx, () => {})
    expect(decSummary.failedCells).toEqual([])
    expect(decSummary.processedCells).toBe(7)
    const dwb = readWb(dec)
    const dws = dwb.Sheets['订单']
    expect(dws['B3'].v).toBe('张三')
    expect(dws['B3'].t).toBe('s')
    expect(dws['C3'].v).toBe('13800138000')
    expect(dws['E3'].t).toBe('d')
    expect(dws['E3'].v).toEqual(new Date('2026-01-15T00:00:00.000Z'))
    expect(dwb.Sheets['隐藏表']['A2'].v).toBe('6222020200112233')

    // 保真：数字格式/合并/列宽与原文件一致（同一读写链，深度相等即未丢）
    const sws = readWb(src).Sheets['订单']
    expect(dws['D3'].z).toBe('0.00')
    expect(dws['!merges']).toEqual(sws['!merges'])
    expect(dws['!cols']).toEqual(sws['!cols'])
  })

  it('密码错误：第一个 E2 格即失败，整体中止', async () => {
    const src = path.join(dir, 'wrongpw.xls')
    const enc = path.join(dir, 'wrongpw-enc.xls')
    buildFixture(src)
    await processXls(src, 'encrypt', { 订单: { headerRow: 2, cols: [2] } }, enc, ctx, () => {})
    const wrong = initCrypto('other-password', generateSalt())
    await expect(
      processXls(enc, 'decrypt', {}, path.join(dir, 'wrongpw-dec.xls'), wrong, () => {}),
    ).rejects.toThrow('密码不符或文件被篡改')
  })

  it('个别格损坏：记录地址、跳过并继续', async () => {
    const src = path.join(dir, 'partial.xls')
    const enc = path.join(dir, 'partial-enc.xls')
    buildFixture(src)
    await processXls(src, 'encrypt', { 订单: { headerRow: 2, cols: [2, 3] } }, enc, ctx, () => {})
    // 篡改非首个 E2 格（C3；行优先扫描序上 B3 在前且完好）
    const wb = readWb(enc)
    const cell = wb.Sheets['订单']['C3']
    const encText = cell.v as string
    const buf = Buffer.from(encText.slice(3), 'base64')
    buf[buf.length - 1] ^= 1
    cell.v = 'E2:' + buf.toString('base64').replace(/=+$/, '')
    const tampered = path.join(dir, 'partial-tampered.xls')
    XLSX.writeFile(wb, tampered, { bookType: 'biff8', bookSST: true })

    const summary = await processXls(
      tampered,
      'decrypt',
      {},
      path.join(dir, 'partial-dec.xls'),
      ctx,
      () => {},
    )
    expect(summary.failedCells).toEqual(['订单!C3'])
    expect(summary.processedCells).toBe(3) // B3、B4、C4 成功
  })

  it('空列选择整 sheet 跳过；超长文本（>255 字符）往返不截断', async () => {
    const wb = XLSX.utils.book_new()
    const longText = '长'.repeat(300)
    const ws = XLSX.utils.aoa_to_sheet([
      ['姓名', '备注'],
      ['张三', longText],
    ])
    XLSX.utils.book_append_sheet(wb, ws, '备注表')
    const src = path.join(dir, 'long.xls')
    XLSX.writeFile(wb, src, { bookType: 'biff8', bookSST: true })

    // 空列选择 → 整 sheet 跳过，文件照写但内容不变
    const enc = path.join(dir, 'long-enc.xls')
    const empty = await processXls(
      src,
      'encrypt',
      { 备注表: { headerRow: 1, cols: [] } },
      enc,
      ctx,
      () => {},
    )
    expect(empty.processedCells).toBe(0)
    expect(readWb(enc).Sheets['备注表']['A2'].v).toBe('张三')

    // 长文本加密→还原不截断（bookSST: Label 记录会截到 255 字符）
    const enc2 = path.join(dir, 'long-enc2.xls')
    const dec = path.join(dir, 'long-dec.xls')
    await processXls(src, 'encrypt', { 备注表: { headerRow: 1, cols: [1, 2] } }, enc2, ctx, () => {})
    expect(isEncrypted(readWb(enc2).Sheets['备注表']['B2'].v)).toBe(true)
    await processXls(enc2, 'decrypt', {}, dec, ctx, () => {})
    expect(readWb(dec).Sheets['备注表']['B2'].v).toBe(longText)
  })
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `pnpm exec vitest run electron/main/xls.test.ts`
Expected: FAIL（`processXls` 未导出）

- [ ] **Step 3: 实现 processXls**

`xls.ts` import 区扩为：

```ts
import fs from 'node:fs'
import * as XLSX from 'xlsx'
import {
  decryptPayload,
  encryptPayload,
  isEncrypted,
  payloadToValue,
  type CellPayload,
  type CryptoContext,
} from './crypto.js'
import { MAX_READ_ROWS, YIELD_EVERY_ROWS, buildAnalysis, detectHeaderRow } from './analysis.js'
import type {
  ProcessMode,
  ProcessSelections,
  ProcessSummary,
  RulesConfig,
  SheetAnalysis,
} from '../shared/types.js'
```

文件尾追加：

```ts
/** SheetJS 单元格 → 加密 payload；空/布尔/错误 → null（跳过，对齐 valueToPayload 语义）。
 *  公式格不跳过：biff8 写回公式必然退化为缓存值（spec 第 3 节），跳过会让选中列明文残留。 */
function xlsCellToPayload(cell: XLSX.CellObject): CellPayload | null {
  switch (cell.t) {
    case 's':
      return typeof cell.v === 'string' ? ['s', cell.v] : null
    case 'n':
      return typeof cell.v === 'number' ? ['n', cell.v] : null
    case 'd':
      return cell.v instanceof Date ? ['d', cell.v.toISOString()] : null
    default:
      return null
  }
}

export async function processXls(
  filePath: string,
  mode: ProcessMode,
  selections: ProcessSelections,
  outPath: string,
  ctx: CryptoContext,
  onProgress: (percent: number) => void,
): Promise<ProcessSummary> {
  let wb: XLSX.WorkBook
  try {
    // cellStyles 是 biff8 解析 !cols 列宽的门控；cellNF 保留 cell.z 数字格式
    wb = XLSX.readFile(filePath, { cellDates: true, cellNF: true, cellStyles: true })
  } catch (err) {
    throw new Error(`无法读取工作簿（文件损坏或格式不支持）：${(err as Error).message}`)
  }

  let processedCells = 0
  const failedCells: string[] = []
  let firstEncSeen = false
  const ranges = wb.SheetNames.map((name) => {
    const ref = wb.Sheets[name]?.['!ref']
    return ref ? XLSX.utils.decode_range(ref) : null
  })
  const totalRows = Math.max(
    1,
    ranges.reduce((sum, r) => sum + (r ? r.e.r - r.s.r + 1 : 0), 0),
  )
  let doneRows = 0

  for (let si = 0; si < wb.SheetNames.length; si++) {
    const name = wb.SheetNames[si]
    const range = ranges[si]
    if (!range) continue
    const ws = wb.Sheets[name]
    const selection = mode === 'encrypt' ? selections[name] : undefined
    const selectedCols = new Set(selection?.cols ?? [])
    if (mode === 'encrypt' && selectedCols.size === 0) {
      doneRows += range.e.r - range.s.r + 1
      continue
    }
    for (let r = range.s.r; r <= range.e.r; r++) {
      // 加密跳过表头行：表头列名不是敏感数据，且保持已脱敏文件可再次分析
      if (mode === 'encrypt' && selection && r + 1 === selection.headerRow) {
        doneRows++
        continue
      }
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r, c })
        const cell = ws[addr] as XLSX.CellObject | undefined
        if (!cell) continue
        if (mode === 'encrypt') {
          if (!selectedCols.has(c + 1)) continue
          if (isEncrypted(cell.v)) continue // 防重复加密
          const payload = xlsCellToPayload(cell)
          if (payload === null) continue
          cell.v = encryptPayload(ctx, payload)
          cell.t = 's'
          delete cell.w // 格式化文本缓存随值失效；cell.z 数字格式保留
          processedCells++
        } else {
          // 还原：凡 E2: 前缀自动还原，与列位置无关（增删列/调列序/另存均可还原）
          if (!isEncrypted(cell.v)) continue
          const isFirst = !firstEncSeen
          firstEncSeen = true
          try {
            const value = payloadToValue(decryptPayload(ctx, cell.v))
            cell.v = value
            cell.t = value instanceof Date ? 'd' : typeof value === 'number' ? 'n' : 's'
            delete cell.w
            processedCells++
          } catch {
            // 第一个 E2 格即失败 → 密码错误，整体中止；个别失败 → 记录地址继续
            if (isFirst) throw new Error('密码不符或文件被篡改')
            failedCells.push(`${name}!${addr}`)
          }
        }
      }
      doneRows++
      if (doneRows % YIELD_EVERY_ROWS === 0) {
        onProgress(Math.min(99, Math.round((doneRows / totalRows) * 100)))
        await new Promise((resolve) => setImmediate(resolve))
      }
    }
  }

  // bookSST：默认 Label 记录把字符串截到 255 字符；SST 无长度限制（Excel 原生机制）
  XLSX.writeFile(wb, outPath, { bookType: 'biff8', bookSST: true })
  onProgress(100)
  // xls 无公式跳过（写回必然退化），skippedFormulas 恒 0，仅为 ProcessSummary 兼容
  return { processedCells, skippedFormulas: 0, failedCells, outPath }
}
```

- [ ] **Step 4: `sheet.ts` 加 process 分发**

import 行改为 `import { analyzeXls, processXls } from './xls.js'`，`processFile` 改为：

```ts
export async function processFile(
  filePath: string,
  mode: ProcessMode,
  selections: ProcessSelections,
  outPath: string,
  ctx: CryptoContext,
  onProgress: (percent: number) => void,
): Promise<ProcessSummary> {
  const kind = kindFromPath(filePath)
  if (kind === 'xlsx') return processXlsx(filePath, mode, selections, outPath, ctx, onProgress)
  if (kind === 'xls') return processXls(filePath, mode, selections, outPath, ctx, onProgress)
  return processCsv(filePath, mode, selections[path.basename(filePath)], outPath, ctx, onProgress)
}
```

- [ ] **Step 5: 跑测试确认绿 + 全量不回归**

Run: `pnpm exec vitest run electron/main/xls.test.ts && pnpm exec vitest run && pnpm exec tsc --noEmit -p tsconfig.node.json`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add electron/main/xls.ts electron/main/xls.test.ts electron/main/sheet.ts
git commit -m "feat: process .xls files via SheetJS"
```

---

### Task 5: IPC/UI 触点 + 文档 + 全量验证

**Files:**
- Modify: `electron/main/index.ts:146,166`（dialog filters、输出扩展名）
- Modify: `src/components/MainFlow.vue:150`（按钮文案）
- Modify: `package.json:5,11`（description、keywords）
- Modify: `README.md`（支持格式、已知限制）
- Modify: `AGENTS.md`（简介、运行时依赖清单、已知坑）

**Interfaces:**
- Consumes: Task 1-4 的全部产物。`FileKind` 三态与扩展名一一对应，`index.ts` 输出扩展名
  由 kind 直接推导。

- [ ] **Step 1: `index.ts`**

146 行 filters 改为：

```ts
    filters: [{ name: '表格文件', extensions: ['xlsx', 'xls', 'csv'] }],
```

166 行扩展名推导改为：

```ts
    const ext = `.${kind}`
```

- [ ] **Step 2: `MainFlow.vue:150`**

`选择文件（.xlsx / .csv）` → `选择文件（.xlsx / .xls / .csv）`

- [ ] **Step 3: `package.json`**

description 改为 `财务报表可逆脱敏桌面工具（xlsx/xls/csv，确定性 AES-256-GCM）`；
keywords 数组加 `"xls"`（跟在 `"xlsx"` 后）。

- [ ] **Step 4: `README.md`**

两处「.xlsx / .csv」改为「.xlsx / .xls / .csv」（开头简介与「用法」第 2 条）。
「已知限制」一节追加：

```markdown
- .xls 经 SheetJS 读写：**单元格样式（字体/填充/边框）与公式丢失**——公式退化
  为静态缓存值（选中列的缓存值照常脱敏）；BIFF5 及更老格式统一写成 BIFF8；
  列宽/合并单元格/数字格式保留
```

- [ ] **Step 5: `AGENTS.md`**

- 首行简介「.xlsx/.csv」→「.xlsx/.xls/.csv」。
- 架构要点第一条的运行时依赖清单「exceljs、fast-csv、iconv-lite」加「、xlsx」。
- 已知坑追加一条：

```markdown
- SheetJS（xlsx 包）走 CDN tarball 依赖（npm registry 的 0.18.5 有未修 CVE，官方新版
  只发 cdn.sheetjs.com，install 需可达）；其 ESM 构建不自动加载 node:fs，
  readFile/writeFile 前必须 `XLSX.set_fs(fs)`；biff8 写回不保留公式与样式，
  且必须带 `bookSST: true` 否则字符串按 255 字符截断
```

- [ ] **Step 6: 全量验证链**

Run: `pnpm exec vitest run && pnpm exec vue-tsc --noEmit && pnpm exec tsc --noEmit -p tsconfig.node.json && pnpm exec vite build`
Expected: 全绿（测试、两侧类型检查、构建）

- [ ] **Step 7: Commit**

```bash
git add electron/main/index.ts src/components/MainFlow.vue package.json README.md AGENTS.md
git commit -m "feat: accept .xls in file dialog and update docs"
```
