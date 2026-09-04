# 加密跳过表头行及以上注释/标题行实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 加密时跳过表头行及以上的所有行（标题/注释行不加密），只加密表头以下的数据。

**Architecture:** 三条加密路径（xlsx/xls/csv）的跳过条件统一从 `行号 === selection.headerRow`
改为 `行号 <= selection.headerRow`；还原路径不变（仍按 `E2:` 前缀全文扫描，旧版本加密
的文件照常可还原）。

**Tech Stack:** Electron 主进程 + ExcelJS（xlsx）/ SheetJS（xls）/ fast-csv（csv），vitest。

Spec: `docs/superpowers/specs/2026-09-04-encrypt-skip-above-header-design.md`

## Global Constraints

- vitest node 环境，`*.test.ts` 与被测文件同目录；单文件聚焦：`pnpm exec vitest run electron/main/<file>`
- 提交信息为英文 conventional commits；直接在 main 分支提交
- 代码注释与文档文案为中文
- 还原逻辑一律不动：凡 `E2:` 前缀自动还原、与行/列位置无关（向后兼容旧版本加密的文件）
- 全量验证链：`pnpm exec vitest run && pnpm exec vue-tsc --noEmit && pnpm exec tsc --noEmit -p tsconfig.node.json && pnpm exec vite build`

---

### Task 1: xlsx 路径（processXlsx）

**Files:**
- Modify: `electron/main/sheet.ts:158-162`（processXlsx 的表头行跳过分支）
- Test: `electron/main/sheet.test.ts`（`describe('processXlsx 加密→还原往返')` 内新增用例）

**Interfaces:**
- Consumes: 现有 `processXlsx(filePath, mode, selections, outPath, ctx, onProgress)`、
  测试内 `buildFixture()`（第 1 行 A1 大标题「订单报表（导出）」，第 2 行表头，A5:B5 合并
  「合并备注」）、`isEncrypted()`
- Produces: 无新导出；`ProcessSelections` 结构不变，仅加密跳过范围语义变化

- [ ] **Step 1: 写失败测试**

在 `sheet.test.ts` 的 `describe('processXlsx 加密→还原往返')` 内、`密码错误` 用例之前插入：

```ts
  it('表头以上的标题/注释行不加密（选中列含第 1 列）', async () => {
    const src = path.join(dir, 'above-header.xlsx')
    await buildFixture(src)
    const enc = path.join(dir, 'above-header-enc.xlsx')
    // 选中列含第 1 列：A1 大标题落在选中列，但属于表头以上，不加密
    const summary = await processXlsx(
      src,
      'encrypt',
      { 订单: { headerRow: 2, cols: [1] } },
      enc,
      ctx,
      () => {},
    )
    expect(summary.processedCells).toBe(3) // A3/A4/A5（A5 合并主格，表头以下照常加密）

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(enc)
    const ws = wb.getWorksheet('订单')!
    expect(ws.getCell('A1').value).toBe('订单报表（导出）') // 表头以上的标题不加密
    expect(ws.getCell('A2').value).toBe('订单号') // 表头行不加密
    expect(isEncrypted(ws.getCell('A3').value)).toBe(true) // 表头以下数据加密
    expect(isEncrypted(ws.getCell('A4').value)).toBe(true)

    // 还原后与原文一致
    const dec = path.join(dir, 'above-header-dec.xlsx')
    await processXlsx(enc, 'decrypt', {}, dec, ctx, () => {})
    const dwb = new ExcelJS.Workbook()
    await dwb.xlsx.readFile(dec)
    const dws = dwb.getWorksheet('订单')!
    expect(dws.getCell('A3').value).toBe('A001')
    expect(dws.getCell('A5').value).toBe('合并备注')
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run electron/main/sheet.test.ts`
Expected: 新用例 FAIL（现状 A1 标题会被加密：`processedCells` 为 4 而非 3，
`A1` 断言同步失败）；其余用例不受影响

- [ ] **Step 3: 改跳过条件**

`electron/main/sheet.ts` 第 158-159 行：

```ts
      // 加密跳过表头行及以上行：表头列名与上方标题/注释都不是敏感数据，且保持已脱敏文件可再次分析
      if (mode === 'encrypt' && selection && row.number <= selection.headerRow) {
```

（唯一逻辑改动：`===` → `<=`；注释同步。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run electron/main/sheet.test.ts`
Expected: 全部 PASS（既有用例选中列不含第 1 列，计数与断言不变）

- [ ] **Step 5: Commit**

```bash
git add electron/main/sheet.ts electron/main/sheet.test.ts
git commit -m "fix(xlsx): skip rows at or above header row when encrypting"
```

---

### Task 2: xls 路径（processXls）

**Files:**
- Modify: `electron/main/xls.ts:124-128`（processXls 的表头行跳过分支）
- Test: `electron/main/xls.test.ts`（`describe('processXls 加密→还原往返')` 内新增用例）

**Interfaces:**
- Consumes: 现有 `processXls(...)`、测试内 `buildFixture()`（与 sheet.test.ts 同构：
  第 1 行 A1 大标题，第 2 行表头，A5 合并主格「合并备注」）、`readWb()` 读回辅助、
  `isEncrypted()`
- Produces: 无新导出

- [ ] **Step 1: 写失败测试**

在 `xls.test.ts` 的 `describe('processXls 加密→还原往返')` 内、`密码错误` 用例之前插入：

```ts
  it('表头以上的标题/注释行不加密（选中列含第 1 列）', async () => {
    const src = path.join(dir, 'above-header.xls')
    buildFixture(src)
    const enc = path.join(dir, 'above-header-enc.xls')
    // 选中列含第 1 列：A1 大标题落在选中列，但属于表头以上，不加密
    const summary = await processXls(
      src,
      'encrypt',
      { 订单: { headerRow: 2, cols: [1] } },
      enc,
      ctx,
      () => {},
    )
    expect(summary.processedCells).toBe(3) // A3/A4/A5（A5 合并主格，表头以下照常加密）

    const ws = readWb(enc).Sheets['订单']
    expect(ws['A1'].v).toBe('订单报表（导出）') // 表头以上的标题不加密
    expect(ws['A2'].v).toBe('订单号') // 表头行不加密
    expect(isEncrypted(ws['A3'].v)).toBe(true) // 表头以下数据加密
    expect(isEncrypted(ws['A4'].v)).toBe(true)

    // 还原后与原文一致
    const dec = path.join(dir, 'above-header-dec.xls')
    await processXls(enc, 'decrypt', {}, dec, ctx, () => {})
    const dws = readWb(dec).Sheets['订单']
    expect(dws['A3'].v).toBe('A001')
    expect(dws['A5'].v).toBe('合并备注')
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run electron/main/xls.test.ts`
Expected: 新用例 FAIL（现状 A1 标题会被加密：`processedCells` 为 4 而非 3）

- [ ] **Step 3: 改跳过条件**

`electron/main/xls.ts` 第 124-125 行：

```ts
      // 加密跳过表头行及以上行：表头列名与上方标题/注释都不是敏感数据，且保持已脱敏文件可再次分析
      if (mode === 'encrypt' && selection && r + 1 <= selection.headerRow) {
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run electron/main/xls.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add electron/main/xls.ts electron/main/xls.test.ts
git commit -m "fix(xls): skip rows at or above header row when encrypting"
```

---

### Task 3: csv 路径（processCsv）

**Files:**
- Modify: `electron/main/csv.ts:170-172`（processCsv 的表头行跳过分支）
- Test: `electron/main/csv.test.ts`（`describe('processCsv 加密→还原往返')` 内新增用例）

**Interfaces:**
- Consumes: 现有 `processCsv(filePath, mode, selection, outPath, ctx, onProgress)`、
  `isEncrypted()`
- Produces: 无新导出

- [ ] **Step 1: 写失败测试**

在 `csv.test.ts` 的 `describe('processCsv 加密→还原往返')` 内、`GBK 输入往返` 用例之前插入：

```ts
  it('表头以上的注释行不加密', async () => {
    const src = path.join(dir, 'comment.csv')
    const original = '订单报表（导出）\n订单号,姓名,手机号\nA001,张三,13800138000\n'
    fs.writeFileSync(src, original, 'utf8')
    const enc = path.join(dir, 'comment-enc.csv')
    const summary = await processCsv(
      src,
      'encrypt',
      { headerRow: 2, cols: [1, 2] },
      enc,
      ctx,
      () => {},
    )
    expect(summary.processedCells).toBe(2) // 第 3 行的 A001、张三（第 1、2 行跳过）

    const lines = fs.readFileSync(enc, 'utf8').slice(1).split('\r\n') // slice(1) 去 BOM
    expect(lines[0]).toBe('订单报表（导出）') // 表头以上注释行原样输出
    expect(lines[1]).toBe('订单号,姓名,手机号') // 表头行不动
    const cells = lines[2].split(',')
    expect(isEncrypted(cells[0])).toBe(true)
    expect(isEncrypted(cells[1])).toBe(true)

    // 还原后与原文一致
    const dec = path.join(dir, 'comment-dec.csv')
    await processCsv(enc, 'decrypt', undefined, dec, ctx, () => {})
    expect(fs.readFileSync(dec, 'utf8').slice(1).replace(/\r\n/g, '\n')).toBe(original)
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run electron/main/csv.test.ts`
Expected: 新用例 FAIL（现状第 1 行注释会被加密：`processedCells` 为 3 而非 2，
`lines[0]` 断言同步失败）

- [ ] **Step 3: 改跳过条件**

`electron/main/csv.ts` 第 170-171 行：

```ts
      if (mode === 'encrypt' && selection && rowNo <= selection.headerRow) {
        // 加密跳过表头行及以上行（与 xlsx 路径一致），照原样写出
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run electron/main/csv.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add electron/main/csv.ts electron/main/csv.test.ts
git commit -m "fix(csv): skip rows at or above header row when encrypting"
```

---

### Task 4: 类型注释与 spec 文档同步 + 全量验证

**Files:**
- Modify: `electron/shared/types.ts:30`（`SheetSelection.headerRow` 注释）
- Modify: `docs/superpowers/specs/2026-08-31-sheet-masking-design.md:95`（encrypt 行为描述）
- Modify: `docs/superpowers/specs/2026-09-03-xls-support-design.md:51`（加密跳过描述）

**Interfaces:**
- Consumes: Task 1-3 已完成的行为变更
- Produces: 无代码产物

- [ ] **Step 1: 更新 `types.ts` 注释**

第 30 行：

```ts
  /** 1-based 表头行：加密时跳过该行及以上所有行（表头列名与上方标题/注释都不是敏感数据，且保持已脱敏文件可再次分析） */
  headerRow: number
```

- [ ] **Step 2: 更新主 spec**

`2026-08-31-sheet-masking-design.md` 第 95 行：

```markdown
- encrypt：按 selections（每 sheet 独立的列号集合）加密字面量单元格；
  跳过表头行及以上所有行（标题/注释行不加密）
```

- [ ] **Step 3: 更新 xls spec**

`2026-09-03-xls-support-design.md` 第 51 行，`跳过表头行（\`selection.headerRow\`）`
改为 `跳过表头行及以上行（行号 ≤ \`selection.headerRow\`）`。

- [ ] **Step 4: 全量验证**

Run: `pnpm exec vitest run && pnpm exec vue-tsc --noEmit && pnpm exec tsc --noEmit -p tsconfig.node.json && pnpm exec vite build`
Expected: 全部通过（vite build 仅既有 daisyUI CSS 警告）

- [ ] **Step 5: Commit**

```bash
git add electron/shared/types.ts docs/superpowers/specs/2026-08-31-sheet-masking-design.md docs/superpowers/specs/2026-09-03-xls-support-design.md
git commit -m "docs: sync header-row skip semantics across types and specs"
```
