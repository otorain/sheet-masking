# 加密跳过表头行及以上注释/标题行设计

日期：2026-09-04
状态：已确认

## 背景与目标

当前三条加密路径（xlsx/xls/csv）只跳过表头行本身（`行号 === selection.headerRow`）。
当表格在表头之上有注释/标题/说明行（如第 1 行大标题「订单报表（导出）」、导出时间
等备注文字）时，这些行若落在选中列会被一并加密，注释变成密文。

目标：加密只作用于表头以下的数据行；表头行及以上所有行一律不加密。

## 关键决策（用户已确认）

- 固定行为，不加配置开关：加密无条件跳过表头行及以上所有行
- 表头以下的所有行（含数据尾部备注行）仍照常加密
- 还原路径不变：仍按 `E2:` 前缀全文扫描、与行位置无关，旧版本加密的文件
  （注释行已被加密）照常可还原，向后兼容
- 被否决的备选：「从第 N 行起加密」可配置项（YAGNI）；分析阶段单独标记
  「数据起始行」（本质即 headerRow+1，重复状态）

## 实现要点

跳过条件由「等于表头行」改为「小于等于表头行」，三条路径一致：

| 文件 | 位置 | 改动 |
|---|---|---|
| `electron/main/sheet.ts` | `processXlsx` | `row.number === selection.headerRow` → `row.number <= selection.headerRow` |
| `electron/main/xls.ts` | `processXls` | `r + 1 === selection.headerRow` → `r + 1 <= selection.headerRow` |
| `electron/main/csv.ts` | `processCsv` | `rowNo === selection.headerRow` → `rowNo <= selection.headerRow` |

表头行来源不变：自动探测 + UI 手动修正（下拉后重跑规则，selections 携带修正后的
headerRow），跳过范围自动跟随用户修正值。三处代码注释同步更新。

## 边界情况

- `headerRow = 1`（表头在第 1 行、无注释行）：只跳过第 1 行，行为与现状完全一致
- 手动把表头行改大（如 1→3）：第 1–3 行全跳过，符合「表头及以上不加密」语义
- 表头以上的合并单元格大标题：整行跳过，不触碰合并主格
- 表头以下尾部备注行：照常加密（用户已确认）

## 测试

- `sheet.test.ts` / `xls.test.ts`：现有 fixture 第 1 行 A1 即大标题。新增用例选中列
  含第 1 列，断言 A1 标题保持明文、表头以下 A 列数据被加密
- `csv.test.ts`：fixture 在表头上方加一行注释，`headerRow: 2`，断言第 1 行原样输出、
  表头行不动、数据行加密
- 既有用例选中列不含注释行所在列，计数不变，仅同步注释措辞

## 文档同步

- `electron/shared/types.ts` `SheetSelection.headerRow` 注释：「跳过该行」→「跳过该行及以上行」
- 主 spec `2026-08-31-sheet-masking-design.md` 与 `2026-09-03-xls-support-design.md`
  中「跳过表头行」表述同步更新

## 影响面与验证

- 只改 `electron/main/{sheet,xls,csv}.ts` 三处条件与注释、`types.ts` 注释、三处测试、
  两份 spec；不动 IPC、UI、分析/还原逻辑
- 验证：`pnpm exec vitest run` + `pnpm exec vue-tsc --noEmit` +
  `pnpm exec tsc --noEmit -p tsconfig.node.json`
