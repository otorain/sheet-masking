# .xls 文件支持设计

日期：2026-09-03
状态：已与用户确认（方案 A：SheetJS CDN 依赖；加解密 .xls 输出仍为 .xls 格式不变；不做 spike）

## 背景

工具当前支持 .xlsx（ExcelJS）与 .csv（fast-csv + iconv-lite）。需增加老二进制格式 .xls
（BIFF5/BIFF8）。ExcelJS 不支持 .xls；JS 生态中唯一能自持读写 .xls 的库是 SheetJS（`xlsx` 包）。

两项已确认决策：

- **依赖来源（方案 A）**：SheetJS 官方 CDN tarball
  `"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"`。npm registry 上的
  `xlsx@0.18.5`（2022 年）有未修复的 CVE-2023-30533（原型污染）/ CVE-2024-22363（ReDoS），
  SheetJS 官方新版只发自己 CDN；本工具解析外部来源文件，需修复版。
- **输出格式**：加密 .xls 输出仍为 .xls，解密对称输出 .xls，往返格式不变。
  代价：SheetJS 社区版写文件不保留单元格样式（字体/填充/边框丢失），用户已接受。

## 设计

### 1. 依赖

- `package.json` dependencies 加 `"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"`
  （必须在 dependencies：electron-builder 只打包运行时依赖；xlsx 无构建脚本，
  无需动 `pnpm-workspace.yaml` 的 allowBuilds）。
- 主进程 `import * as XLSX from 'xlsx'`（exceljs/fast-csv 之外的第三条文件通道）。

### 2. 新模块 `electron/main/xls.ts`

与 `csv.ts` 平级，导出 `analyzeXls` / `processXls`，复用 `sheet.ts` 已导出的
`detectHeaderRow` / `buildAnalysis` / `HEADER_CANDIDATE_ROWS` / `SAMPLE_DATA_ROWS` /
`YIELD_EVERY_ROWS` 与 `crypto.ts` 全套 payload 函数。

**analyzeXls(filePath, rules, headerRowOverrides)**：

- `XLSX.readFile(path, { sheetRows: HEADER_CANDIDATE_ROWS + SAMPLE_DATA_ROWS })`
  每 sheet 限量解析（对齐 xlsx analyze 只读前 55 行的行为）。
- 每个 sheet：`XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' })`
  得稠密行，值归一化为文本（Date→ISO 字符串、number/boolean→String、其余→''，
  与 xlsx analyze 的 `streamCellText` 语义一致；日期以原始数字出现可接受）。
- 隐藏 sheet：`wb.Workbook?.Sheets?.[i]?.Hidden` 为 1 或 2 → `hidden: true`。
- 表头行：`headerRowOverrides[sheetName] ?? detectHeaderRow(denseRows)`，然后 `buildAnalysis`。

**processXls(filePath, mode, selections, outPath, ctx, onProgress)**：

- `XLSX.readFile(path, { cellDates: true, cellNF: true, cellStyles: true })` 全量读入
  （.xls 上限 65536 行 × 256 列，内存风险远低于 xlsx，全量可接受；读失败包装为中文错误，
  对齐 `processXlsx` 风格；`cellStyles` 是 biff8 解析 `!cols` 列宽的门控，见第 3 节）。
- 逐 sheet 遍历 range（`XLSX.utils.decode_range(ws['!ref'])`，空 sheet 无 `!ref` 跳过）：
  - **加密**：跳过表头行及以上行（行号 ≤ `selection.headerRow`）、已有 `E2:` 前缀格、
    非 文本/数字/日期 格（布尔 `t:'b'`、错误 `t:'e'`、空 `t:'z'` 跳过，
    对齐 `valueToPayload` 语义）。**公式格不跳过**（见第 3 节：公式写回必然退化，
    跳过会让选中列的缓存值明文残留），按缓存值类型照常加密，`skippedFormulas`
    对 xls 恒 0。命中格：`cell.v = encryptPayload(...)`、`cell.t = 's'`、
    删 `cell.w`（格式化文本缓存），保留 `cell.z`（数字格式）。
  - **解密**：全 range 扫 `E2:` 前缀，与列位置无关；第一个密文格校验失败 →
    抛「密码不符或文件被篡改」整体中止；个别失败记录 `sheet名!A1` 地址进
    `failedCells` 继续（对齐 `processXlsx`）。
  - 还原写回：`'s'`→`t:'s'`；`'n'`→`t:'n'`；`'d'`→`t:'d'` + Date 对象（保留原 `cell.z`
    日期格式），同样删 `cell.w`。
- 合并单元格 `!merges`、列宽 `!cols` 等在 workbook 对象上原样不动，写回自然保留。
- 进度：按已处理行数 `onProgress`，每 `YIELD_EVERY_ROWS` 行 `setImmediate` 让出事件循环。
- 写回：`XLSX.writeFile(wb, outPath, { bookType: 'biff8', bookSST: true })`
  （BIFF5 及更老文件读入后统一写成 BIFF8；`bookSST: true` 见第 3 节）。

### 3. SheetJS 0.20.3 源码勘察结论（实施前已确认）

直接阅读 xlsx.mjs 源码确认的硬性事实，设计据此调整：

- **公式不可保留**：解析 .xls 公式只产出 `cell.f` 字符串，从不保留二进制 `cell.bf`；
  而 biff8 写回（`write_ws_biff8_cell`）只认 `cell.bf`，无 bf 的公式格被写成静态缓存值。
  CE 无公式编译 API，**xls 往返公式必然退化为缓存值**。因此 xls 路径不跳过公式格，
  按缓存值照常加密（安全优先：跳过会让选中列敏感值明文残留）。
- **字符串长度**：biff8 默认写 Label 记录并 `.slice(0, 255)` 截断；`bookSST: true`
  改用 LabelSst + 共享字符串表（Excel 原生机制，无长度限制）。中文写入安全
  （Label/SST 均为 UTF-16LE）。
- **ESM 构建不自动加载 fs**：`readFile`/`writeFile` 依赖 `XLSX.set_fs(fs)` 注入
  （`import * as XLSX from 'xlsx'`，ESM 命名导出与 d.ts 一致，运行时/类型两侧都稳）。
- **已验证可保留**：`!cols` 列宽（COLINFO；**biff8 解析它被 `cellStyles` 选项门控**，
  读入必须带 `cellStyles: true`）、`!merges` 合并单元格（MergeCells，解析无门控）、
  sheet 隐藏状态（BoundSheet8 的 Hidden 位）、`cell.z` 数字格式（`cellNF` 读入后随
  XF 写回）。均由往返单测固化。

### 4. 触点改动

- `electron/shared/types.ts`：`FileKind` 加 `'xls'`。
- `electron/main/sheet.ts`：`kindFromPath` 认 `.xls`（报错文案改「仅支持 .xlsx / .xls / .csv」）；
  `analyzeFile` / `processFile` 加 xls 分支（selections 仍按 sheet 名索引，与 xlsx 一致）。
- `electron/main/index.ts`：打开 dialog filters 加 `xls`；输出扩展名由 kind 推导（`'.' + kind`，
  xlsx/xls/csv 一一对应）。
- `src/components/MainFlow.vue`：按钮文案「选择文件（.xlsx / .csv）」加 `.xls`。其余零改动
  （UI 无 kind 分支）。

### 5. 已知限制（README 补充）

- .xls 经 SheetJS 读写：**单元格样式（字体/填充/边框）丢失**（社区版不写样式）；
  **公式退化为静态缓存值**（选中列的缓存值照常脱敏）；图表/图片/透视表丢失
  （与 xlsx 现状一致）；BIFF5 及更老格式统一写成 BIFF8。
- 列宽/合并单元格/数字格式保留（workbook 对象不动，由往返单测固化验证）。
- 文件元数据中的 `Locale`/`Behavior` 属性（VT_UI4，WPS 文件常见）及名为
  `undefined` 的伪属性（WPS 自定义属性字典解析产物）在写回前剔除：SheetJS 的
  CFB 属性写出器不支持这些类型，不剔除会抛 `TypedPropertyValue unrecognized type`。
  仅影响文件属性面板元数据，不影响单元格数据。

## 不做（YAGNI）

- .xlsb / .ods 等 SheetJS 顺带可读的其他格式（只放通 .xls）。
- 样式保留（SheetJS 社区版能力边界；Pro 版为付费软件）。
- 保真 spike（用户明确跳过；保真边界由单测直接验证并固化）。
- 流式处理 .xls（行上限 65536，全量加载足够）。

## 测试

新增 `electron/main/xls.test.ts`，用 SheetJS 在临时目录写真 .xls fixture
（`XLSX.writeFile(bookType: 'biff8')`），对齐 `sheet.test.ts` 场景子集：

- analyze：表头自动探测、headerRowOverrides、隐藏 sheet 标注
- 加密→还原往返：文本/数字/日期类型不变、非选中列不动、表头行不动
- 确定性：同明文两次加密密文相同
- 错误密码首格即抛「密码不符或文件被篡改」；篡改密文记录 failedCells
- 空列选择整 sheet 跳过；超长文本（>255 字符）往返不截断（验证 `bookSST`）
- 保真断言：合并单元格、列宽、数字格式（如 `0.00`）往返保留
- WPS 属性兼容：手搓含 VT_UI4 `Locale` 属性的 SummaryInformation 流注入 fixture，
  加密→还原全流程成功；`sanitizeXlsProps` 单测固化剔除清单
- 无公式测试 fixture：SheetJS 写不出公式记录（无 `bf`），公式退化由文档承载
- `kindFromPath` 补 `.xls` 用例（含大小写 `.XLS`）

## 验证

`pnpm exec vitest run` + `pnpm exec vue-tsc --noEmit` +
`pnpm exec tsc --noEmit -p tsconfig.node.json` + `pnpm exec vite build` 全绿。
