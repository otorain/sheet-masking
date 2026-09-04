# 表格脱敏工具设计（财务/公司数据报表）

日期：2026-08-31
状态：已与用户确认（方案 A：主进程 ExcelJS + Node crypto 确定性加密）

## 背景

electron-vite-vue 模板项目（Electron 42 + Vue 3 + Vite 8，pnpm 11.3.0），现有
Tailwind v4 + daisyUI + TypeORM/better-sqlite3 演示代码。目标：改造为桌面工具，
对财务/公司数据报表（.xlsx / .csv）做**可逆脱敏**：加密敏感列，事后可用同一
密码完整还原。

已确认的需求决策：

- 格式：.xlsx + .csv；单文件精细处理（不做文件夹批量）
- 不做数据预览；脱敏前仅展示**表头勾选界面**（规则自动勾选 + 手动调整）
- **确定性加密**：同一明文在任何文件、任何时间加密结果完全相同（订单等数据
  需跨表关联）；用户已接受其固有代价（密文暴露值相等性与频率）
- 一个固定主密码，`safeStorage` 加密后存本地（不明文落盘）
- 规则：内置 + 用户自定义（关键词/正则）
- 数据量：订单表达数十万行；硬件 8C16T + 32GB + NVMe；**保真优先，接受慢**，
  不做 spike 基准、不做 SheetJS 降级
- 多 sheet：每 sheet 独立分析/勾选；隐藏 sheet 必须照常处理（防漏脱敏）
- 表头行：每 sheet 独立**自动探测 + 手动修正**
- Windows 为一等平台（safeStorage 走 DPAPI；输出 CSV 需防 Excel 乱码）

## 关键约束

- 主进程经 vite-plugin-electron 构建，`notBundle()`：包依赖外部化，运行时从
  node_modules 解析。`exceljs`/`iconv-lite` 必须在 **dependencies**
- 渲染进程 sandbox（无 nodeIntegration，contextIsolation 开启），一切文件/加密
  操作只能在主进程，经 `contextBridge` 暴露的 `window.ipcRenderer.invoke` 通信
- ExcelJS 全量加载整个工作簿为对象图，内存约每单元格数百字节～1KB：
  50 万行 × 15 列 ≈ 4–8GB 堆 → 主进程启动 `app.commandLine.appendSwitch(
  'js-flags', '--max-old-space-size=12288')`（32GB 机器无压力）
- ExcelJS 往返保真边界：保留样式/公式/合并单元格/列宽；**图表、图片、数据透视表
  会丢失**——已向用户告知，为首版已知限制
- 加密计算量：90 万单元格（30 万行 × 3 列）约 10–30 秒单核 CPU，无需
  worker_threads

## 设计

### ① 加密模块 `electron/main/crypto.ts`（纯函数，可独立单测）

- `initCrypto(password, salt)`：`scrypt(password, salt)` 派生主密钥，再 HKDF 分出
  `encKey` / `sivKey`，驻留主进程内存
- 单元格值序列化为带类型 JSON：`["s","张三"]` / `["n",12345]` /
  `["d","2026-08-31T00:00:00.000Z"]`（数字/日期还原后类型不变，金额列不变文本）
- 加密：`iv = HMAC-SHA256(sivKey, payload)[0:12]` → AES-256-GCM(encKey, iv,
  payload) → 写回单元格 `'ENC1:' + base64(iv ‖ 密文 ‖ tag)`
- 解密：识别 `ENC1:` 前缀 → base64 解码 → GCM 校验 tag（失败即报"密码不符或文件
  被篡改"）→ 还原类型
- 跳过：空值、公式单元格、已有 `ENC1:` 前缀的值（防重复加密）

### ② 配置 `electron/main/config.ts`

`userData/config.json`：`{ salt, encPassword, rules }`

- 首次启动：引导设置密码 → 生成随机 salt → `safeStorage.encryptString(password)`
  存 `encPassword`
- 之后启动：safeStorage 解密取回密码（Windows=DPAPI，绑定当前系统用户；换机/换
  用户解不开 → 回退到重新输入密码流程）→ `initCrypto`
- 规则配置同文件持久化

### ③ 规则 `electron/main/rules.ts`

- 内置表头关键词：姓名、身份证、证件、手机号、电话、银行卡、卡号、账号、开户行、
  税号、统一社会信用代码、邮箱、地址 等
- 内置内容抽样正则（抽样前 50 数据行）：身份证 18 位、`1[3-9]\d{9}` 手机号、
  16–19 位银行卡号、邮箱
- 用户自定义：关键词列表 + 正则列表；每条内置规则可启停
- 命中表头关键词或内容正则 → 该列 `autoSelected = true` 并记录 `matchedRules`

### ④ 表格引擎 `electron/main/sheet.ts`（ExcelJS）

**analyze(filePath)** — 流式 `Excel.stream.xlsx.WorkbookReader`：

- 逐 sheet 迭代，每 sheet 只读前几行即停（表头行探测 + 前 50 数据行抽样）
- 表头行自动探测：前 5 行中取"非空单元格最多且下一行有数据"的行；UI 可下拉
  改选行号后重跑规则（每 sheet 独立）
- 返回：

```ts
interface SheetAnalysis {
  name: string
  hidden: boolean        // 隐藏 sheet 照常列出并标注
  headerRow: number      // 探测结果，可手动修正
  headers: { colIndex: number; name: string; autoSelected: boolean; matchedRules: string[] }[]
}
```

**process(filePath, mode, selections, outPath, onProgress)**：

- `mode: 'encrypt' | 'decrypt'`；xlsx 全量加载（保真），遍历所有 worksheet
- encrypt：按 selections（每 sheet 独立的列号集合）加密字面量单元格；
  跳过表头行及以上所有行（标题/注释行不加密）
- decrypt：扫描全部 sheet，凡 `ENC1:` 前缀自动还原，无需逐列勾选
- 按已处理行数 `onProgress(percent)` 推送；每 N 行 `setImmediate` 让出事件循环
- 极端文件 OOM → 捕获并明确报错，建议用户拆分文件（不做降级引擎）

**CSV 路径**（天然单 sheet，UI 退化为单组；流式用 fast-csv 解析/格式化）：

- 读：检测 GBK（无 BOM 且 UTF-8 解码失败）→ iconv-lite 转 UTF-8
- 全程流式逐行：读一行 → 加密/解密目标列 → 写一行，内存恒定
- 写：**UTF-8 带 BOM + CRLF 行尾**（Windows 版 Excel 直接双击不乱码）

### ⑤ IPC 与 UI

IPC handlers（主进程 `index.ts`）：

- `app:needs-password-setup` / `app:set-password` / `app:unlock`（回退用）
- `file:analyze`（内嵌 showOpenDialog，filters: xlsx/csv）
- `file:process`（showSaveDialog，默认名 `原名.已脱敏.xlsx` / `原名.已还原.xlsx`），
  返回摘要 `{ processedCells, skippedFormulas, outPath }`
- `rules:get` / `rules:save`
- 进度：`webContents.send('file:progress', percent)`

渲染进程（Vue3 + daisyUI，三视图，单窗口内切换）：

1. **密码引导/解锁**：首次设置；或 safeStorage 失效时重新输入
2. **主流程**：选文件 → 按 sheet 分组（页签/折叠面板，隐藏标注）展示表头勾选表
   （命中规则标记）+ 表头行下拉 → 「脱敏」/「还原」→ 进度条 → 完成摘要
   （处理 N 单元格、跳过 M 公式、输出路径）
3. **设置**：修改密码、启停内置规则、增删自定义关键词/正则

### ⑥ 清理

删除：`electron/main/db.ts`、`electron/main/entities/Note.ts`、`src/demos/`、
`src/components/HelloWorld.vue` 及相关 IPC/demo 引用。
卸载 `typeorm`、`better-sqlite3`、`@types/better-sqlite3`；
新增 dependencies `exceljs`、`fast-csv`（CSV 流式）、`iconv-lite`，
devDependencies `vitest`；`pnpm-workspace.yaml` 的 allowBuilds 同步清理。

### ⑦ Windows 平台

- safeStorage→DPAPI（绑定当前 Windows 用户，换机需重输密码）
- 输出 CSV：UTF-8 BOM + CRLF
- NSIS 安装包在 Windows 机器或 CI 构建（Linux 交叉构建 rcedit 需 wine）

## 错误处理

- 密码未设置/解锁失败 → 引导或重输界面
- 文件损坏/非表格 → IPC 抛错，UI 提示
- 还原 tag 校验失败分两档：**第一个** `ENC1:` 格即失败 → 判为密码错误，整体中止
  报"密码不符或文件被篡改"；**个别**格失败（文件在加密后被编辑/损坏）→ 记录
  单元格地址、跳过并继续，完成摘要列出失败清单
- 加密单元格自包含（IV 随格），还原按 `ENC1:` 前缀全文扫描，**与列位置无关**：
  加密后的文件被增删列、调列序、Excel 另存均可正常还原；重跑脱敏只加密新增
  明文格（防重复加密）
- 公式单元格跳过，计入完成摘要
- OOM → 明确报错建议拆分文件
- 渲染端统一 try/catch IPC 调用，daisyUI alert 展示

## 验证

- vitest 单测：
  - `crypto`：确定性（同文同密、跨"文件"一致）、往返还原、类型保真（数字/日期/
    文本）、篡改检测（改 1 字节 → 抛错）、重复加密防护
  - `rules`：内置关键词/正则命中、自定义规则、启停
  - `sheet` fixtures：内存构造 xlsx（多 sheet/隐藏 sheet/公式/合并单元格）与 csv
    → 加密 → 密文一致 → 解密 → 与原文逐格一致；GBK csv 往返
- `vue-tsc --noEmit` + `tsc --noEmit -p tsconfig.node.json`
- `vite build` 通过；有 xvfb 则冒烟启动
- README 更新（移除 TypeORM 章节，写工具用法与加密格式说明）

## 不做（YAGNI）

- spike 基准验证（用户明确不做；堆提额 + 保真路线直接落地）
- SheetJS 降级引擎、worker_threads 并行加密
- 文件夹批量处理、数据预览、多密码档案
- 图表/图片/透视表保真（ExcelJS 固有限制，首版接受）
- migrations / SQLite 配置存储
