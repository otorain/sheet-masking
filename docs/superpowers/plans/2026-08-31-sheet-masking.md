# 表格脱敏工具实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 electron-vite-vue 模板改造为桌面报表脱敏工具：对 .xlsx/.csv 的敏感列做确定性 AES-256-GCM 加密，可用同一主密码完整还原。

**Architecture:** 一切文件/加密操作在主进程（渲染进程 sandbox，经 `window.ipcRenderer.invoke` 通信）。`crypto.ts`（scrypt+HKDF 派生密钥，HMAC 确定性 IV，AES-256-GCM，纯函数可单测）→ `rules.ts`（内置关键词/内容正则 + 自定义规则）→ `sheet.ts`/`csv.ts`（ExcelJS 全量保真处理 xlsx；fast-csv 流式处理 csv，GBK 检测、UTF-8 BOM+CRLF 输出）→ `config.ts`（safeStorage 存密码、verifier 校验回退解锁）→ `index.ts` IPC → Vue3+daisyUI 三视图。

**Tech Stack:** Electron 42 / Vue 3 / Vite 8 / pnpm 11.3.0 / exceljs 4.4.0 / fast-csv 5.0.7 / iconv-lite 0.7.3 / vitest 4 / Tailwind v4 + daisyUI 5

## Global Constraints

- 主进程经 vite-plugin-electron `notBundle()` 逐文件转译为 ESM（package.json `type: module`）：**相对 import 必须带 `.js` 后缀**；`exceljs`/`fast-csv`/`iconv-lite` 必须在 **dependencies**
- 渲染进程 sandbox（无 nodeIntegration）：文件/加密只在主进程；共享 IPC 类型集中在 `electron/shared/types.ts`（纯 interface，双方 `import type`）
- 密文格式：`'ENC1:' + base64(iv(12B) ‖ 密文 ‖ tag(16B))`；payload 为带类型 JSON `["s",string] | ["n",number] | ["d",ISO string]`
- 确定性加密：`iv = HMAC-SHA256(sivKey, payload)[0:12]`——同一明文任何文件任何时间密文相同
- 派生：`scrypt(password, salt)` 主密钥 → HKDF-SHA256（salt 固定为 `'sheet-masking-v1'`）分出 encKey/sivKey
- 主进程启动即 `app.commandLine.appendSwitch('js-flags', '--max-old-space-size=12288')`（ExcelJS 全量加载大文件）
- CSV：输入检测 GBK（无 BOM 且 UTF-8 解码失败）→ iconv-lite 转 UTF-8；输出一律 **UTF-8 带 BOM + CRLF**
- **加密时跳过每 sheet 的表头行**（selections 携带 headerRow）：表头列名不是敏感数据；若表头变密文，对已脱敏文件重跑 analyze 时列名不可读、规则无法命中
- 还原：按 `ENC1:` 前缀全文扫描（含表头行，与列位置无关）；第一个 ENC1 格校验失败 → 整体中止报「密码不符或文件被篡改」；后续个别失败 → 记录地址继续
- 跳过：空值、公式单元格（计入 skippedFormulas）、已有 `ENC1:` 前缀的值（防重复加密）、富文本/超链接/布尔/错误等非字面量格（避免破坏格式，不计数）
- ExcelJS 已知限制（首版接受）：图表/图片/数据透视表丢失；样式/公式/合并单元格/列宽保留
- 测试：vitest，`*.test.ts` 与被测模块同目录，`environment: 'node'`；`config.ts`/`index.ts` 依赖 electron **不进 vitest**，仅类型检查
- 验证命令：`pnpm exec vitest run`、`pnpm exec vue-tsc --noEmit`、`pnpm exec tsc --noEmit -p tsconfig.node.json`、`pnpm exec vite build`
- 提交信息用英文 conventional commits（与 git log 现有风格一致）

## 文件结构

- `electron/shared/types.ts`（新建）— IPC 共享类型：FileKind/SheetAnalysis/AnalyzeResult/ProcessSelections/ProcessSummary/RulesConfig/BuiltinRule/ProcessMode
- `electron/main/crypto.ts`（新建）— initCrypto/encryptPayload/decryptPayload/isEncrypted/valueToPayload/payloadToValue/generateSalt + `crypto.test.ts`
- `electron/main/rules.ts`（新建）— BUILTIN_RULES/defaultRulesConfig/matchColumns + `rules.test.ts`
- `electron/main/config.ts`（新建）— userData/config.json 读写、setup/unlock/changePassword、getCryptoContext、rules 持久化（无单测）
- `electron/main/sheet.ts`（新建）— kindFromPath/analyzeFile/processFile 分发 + xlsx 实现（analyzeXlsx/processXlsx）+ 共享辅助（detectHeaderRow/buildAnalysis）+ `sheet.test.ts`
- `electron/main/csv.ts`（新建）— detectCsvEncoding/readCsvHead/analyzeCsv/processCsv + `csv.test.ts`
- `electron/main/index.ts`（重写）— 窗口样板 + 全部 IPC handlers
- `electron/preload/index.ts`（改）— `on()` 返回取消订阅函数（修复原模板 off 无法移除包装监听的问题）
- `src/App.vue`（重写）、`src/components/PasswordGate.vue`、`MainFlow.vue`、`SettingsView.vue`（新建）
- 删除：`electron/main/db.ts`、`electron/main/entities/`、`src/demos/`、`src/components/HelloWorld.vue`

---

### Task 1: 清理 demo、换装依赖、vitest 与共享类型就位

**Files:**
- Modify: `package.json`（依赖换装 + `test` script）
- Modify: `pnpm-workspace.yaml`（allowBuilds 移除 better-sqlite3）
- Modify: `tsconfig.json:2`（删 `experimentalDecorators`）、`tsconfig.node.json:3`（删 `experimentalDecorators`，include 加 `vitest.config.ts`）
- Create: `vitest.config.ts`、`electron/shared/types.ts`
- Delete: `electron/main/db.ts`、`electron/main/entities/Note.ts`、`src/demos/ipc.ts`、`src/demos/node.ts`、`src/components/HelloWorld.vue`
- Modify: `electron/main/index.ts`（删 TypeORM/demo IPC，加 js-flags）
- Modify: `src/main.ts:6`（删 demos/ipc import）、`src/App.vue`（占位）

**Interfaces:**
- Consumes: 无（首个任务）
- Produces:
  - `electron/shared/types.ts` 全部共享类型（Task 2-8 依赖）：
    `FileKind = 'xlsx' | 'csv'`；`ProcessMode = 'encrypt' | 'decrypt'`；
    `SheetHeaderInfo { colIndex: number; name: string; autoSelected: boolean; matchedRules: string[] }`（colIndex 1-based）；
    `SheetAnalysis { name: string; hidden: boolean; headerRow: number; headers: SheetHeaderInfo[] }`；
    `AnalyzeResult { filePath: string; kind: FileKind; sheets: SheetAnalysis[] }`；
    `SheetSelection { headerRow: number; cols: number[] }`（headerRow 1-based，加密时跳过该行）；
    `ProcessSelections = Record<string, SheetSelection>`（key = sheet 名；csv 用文件 basename）；
    `ProcessSummary { processedCells: number; skippedFormulas: number; failedCells: string[]; outPath: string }`；
    `RulesConfig { disabledBuiltins: string[]; customKeywords: string[]; customPatterns: string[] }`；
    `BuiltinRule { id: string; label: string; kind: 'keyword' | 'pattern'; value: string }`

- [ ] **Step 1: 提交设计文档**

spec 已确认但尚未入库；本计划随代码一起跟踪：

```bash
git add docs/superpowers/specs/2026-08-31-sheet-masking-design.md docs/superpowers/plans/2026-08-31-sheet-masking.md
git commit -m "docs: sheet masking design spec and implementation plan"
```

- [ ] **Step 2: 卸载旧依赖、安装新依赖**

```bash
pnpm remove typeorm better-sqlite3
pnpm remove -D @types/better-sqlite3
pnpm add exceljs fast-csv iconv-lite
pnpm add -D vitest
```

Expected: package.json dependencies 含 `exceljs`/`fast-csv`/`iconv-lite`（保留 tailwind/daisyUI），devDependencies 含 `vitest`；不再有 typeorm/better-sqlite3/@types/better-sqlite3。

- [ ] **Step 3: package.json 加 test script**

在 `"preview": "vite preview",` 后加一行：

```json
    "test": "vitest run",
```

- [ ] **Step 4: pnpm-workspace.yaml 清理**

删除 `better-sqlite3: true` 行，最终 allowBuilds 只剩：

```yaml
allowBuilds:
  electron-winstaller: false
```

并同步上方注释（删掉 better-sqlite3 那条说明）。

- [ ] **Step 5: 两个 tsconfig 去掉 typeorm 遗留**

`tsconfig.json`：删除 `"experimentalDecorators": true,` 行（`useDefineForClassFields` 保留）。

`tsconfig.node.json`：删除 `"experimentalDecorators": true,` 行，并把 include 改为：

```json
  "include": ["electron", "vite.config.ts", "vitest.config.ts", "package.json"]
```

- [ ] **Step 6: 创建 vitest.config.ts**

独立配置（避免 vitest 加载 vite.config.ts 触发 electron 插件与 `rmSync dist-electron`）：

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['electron/**/*.test.ts'],
    passWithNoTests: true,
  },
})
```

- [ ] **Step 7: 创建共享类型 electron/shared/types.ts**

```ts
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
  /** 被禁用的内置规则 id 列表（默认全部启用） */
  disabledBuiltins: string[]
  customKeywords: string[]
  /** 正则 source 字符串；保存时已校验可编译 */
  customPatterns: string[]
}

export interface BuiltinRule {
  id: string
  label: string
  kind: 'keyword' | 'pattern'
  value: string
}
```

- [ ] **Step 8: 删除 demo 文件**

```bash
git rm electron/main/db.ts electron/main/entities/Note.ts src/demos/ipc.ts src/demos/node.ts src/components/HelloWorld.vue
```

- [ ] **Step 9: 重写 electron/main/index.ts（去 demo，加 js-flags）**

整体替换为（窗口样板保留，删除 db/open-win/main-process-message，IPC handlers 在 Task 7 再加）：

```ts
import { app, BrowserWindow, shell } from 'electron'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'

// ExcelJS 全量加载整个工作簿为对象图（50 万行 × 15 列 ≈ 4-8GB 堆），
// 32GB 机器直接把主进程堆上限提到 12GB。必须在 app ready 之前调用。
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=12288')

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The built directory structure
//
// ├─┬ dist-electron
// │ ├─┬ main
// │ │ └── index.js    > Electron-Main
// │ └─┬ preload
// │   └── index.mjs   > Preload-Scripts
// ├─┬ dist
// │ └── index.html    > Electron-Renderer
//
process.env.APP_ROOT = path.join(__dirname, '../..')

export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')
export const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

// Disable GPU Acceleration for Windows 7
if (process.platform === 'win32' && os.release().startsWith('6.1')) app.disableHardwareAcceleration()

// Set application name for Windows 10+ notifications
if (process.platform === 'win32') app.setAppUserModelId(app.getName())

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

let win: BrowserWindow | null = null
const preload = path.join(__dirname, '../preload/index.mjs')
const indexHtml = path.join(RENDERER_DIST, 'index.html')

async function createWindow() {
  win = new BrowserWindow({
    title: '报表脱敏工具',
    icon: path.join(process.env.VITE_PUBLIC, 'favicon.ico'),
    webPreferences: {
      preload,
      // 渲染进程保持 sandbox：无 nodeIntegration、contextIsolation 开启。
      // 一切文件/加密操作都在主进程，经 contextBridge 暴露的
      // window.ipcRenderer.invoke 通信。
    },
  })

  if (VITE_DEV_SERVER_URL) { // #298
    win.loadURL(VITE_DEV_SERVER_URL)
    // Open devTool if the app is not packaged
    win.webContents.openDevTools()
  } else {
    win.loadFile(indexHtml)
  }

  // Make all links open with the browser, not with the application
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  win = null
  if (process.platform !== 'darwin') app.quit()
})

app.on('second-instance', () => {
  if (win) {
    // Focus on the main window if the user tried to open another
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.on('activate', () => {
  const allWindows = BrowserWindow.getAllWindows()
  if (allWindows.length) {
    allWindows[0].focus()
  } else {
    createWindow()
  }
})

// IPC handlers 见 Task 7。
```

- [ ] **Step 10: 精简 src/main.ts 与 src/App.vue**

`src/main.ts` 删除 `import './demos/ipc'` 行及其上方注释，最终：

```ts
import { createApp } from 'vue'
import App from './App.vue'

import './style.css'

createApp(App)
  .mount('#app')
  .$nextTick(() => {
    postMessage({ payload: 'removeLoading' }, '*')
  })
```

`src/App.vue` 整体替换为占位（Task 8 重写为正式 UI）：

```vue
<template>
  <div class="flex min-h-screen items-center justify-center bg-base-200">
    <h1 class="text-xl font-bold">报表脱敏工具</h1>
  </div>
</template>
```

- [ ] **Step 11: 全量验证**

Run: `pnpm exec vitest run && pnpm exec vue-tsc --noEmit && pnpm exec tsc --noEmit -p tsconfig.node.json && pnpm exec vite build`
Expected: 全部通过（vitest 无测试但 passWithNoTests 退出码 0）

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "build: swap TypeORM/better-sqlite3 for exceljs/fast-csv/iconv-lite; drop demo code"
```

---

### Task 2: 加密模块 crypto.ts（TDD）

**Files:**
- Create: `electron/main/crypto.ts`
- Test: `electron/main/crypto.test.ts`

**Interfaces:**
- Consumes: 无（纯 node:crypto）
- Produces（Task 4/5/6 依赖）:
  - `CryptoContext { encKey: Buffer; sivKey: Buffer }`
  - `CellPayload = ['s', string] | ['n', number] | ['d', string]`
  - `generateSalt(): string`（16 字节随机，base64）
  - `initCrypto(password: string, salt: string): CryptoContext`
  - `isEncrypted(value: unknown): value is string`
  - `encryptPayload(ctx: CryptoContext, payload: CellPayload): string`
  - `decryptPayload(ctx: CryptoContext, value: string): CellPayload`（失败一律抛 `Error('密码不符或文件被篡改')`）
  - `valueToPayload(value: unknown): CellPayload | null`（string/number/Date → payload，其余 null）
  - `payloadToValue(payload: CellPayload): string | number | Date`

- [ ] **Step 1: 写失败测试**

Create `electron/main/crypto.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import {
  decryptPayload,
  encryptPayload,
  generateSalt,
  initCrypto,
  isEncrypted,
  payloadToValue,
  valueToPayload,
  type CellPayload,
} from './crypto.js'

const password = 'test-password-123'
const salt = generateSalt()
const ctx = initCrypto(password, salt)

describe('initCrypto', () => {
  it('同一密码+salt 派生的密钥一致（跨"文件"确定性）', () => {
    const a = initCrypto(password, salt)
    expect(a.encKey.equals(ctx.encKey)).toBe(true)
    expect(a.sivKey.equals(ctx.sivKey)).toBe(true)
  })

  it('不同密码派生不同密钥', () => {
    const other = initCrypto('other-password', salt)
    expect(other.encKey.equals(ctx.encKey)).toBe(false)
  })
})

describe('encryptPayload', () => {
  it('确定性：同一明文多次加密结果完全相同', () => {
    expect(encryptPayload(ctx, ['s', '张三'])).toBe(encryptPayload(ctx, ['s', '张三']))
  })

  it('不同明文密文不同，且带 ENC1: 前缀', () => {
    const a = encryptPayload(ctx, ['s', '张三'])
    const b = encryptPayload(ctx, ['s', '李四'])
    expect(a).not.toBe(b)
    expect(isEncrypted(a)).toBe(true)
  })

  it('isEncrypted 只认 ENC1: 前缀的字符串', () => {
    expect(isEncrypted('张三')).toBe(false)
    expect(isEncrypted(123)).toBe(false)
    expect(isEncrypted(null)).toBe(false)
    expect(isEncrypted(undefined)).toBe(false)
  })
})

describe('decryptPayload 往返', () => {
  // 注意不要用 it.each 传元组：数组行会被展开为多个参数。用普通 for 循环。
  const roundtrips: CellPayload[] = [
    ['s', '张三'],
    ['s', ''],
    ['n', 12345.67],
    ['n', 0],
    ['d', '2026-08-31T00:00:00.000Z'],
  ]
  for (const payload of roundtrips) {
    it(`payload 往返保真：${JSON.stringify(payload)}`, () => {
      expect(decryptPayload(ctx, encryptPayload(ctx, payload))).toEqual(payload)
    })
  }

  it('错误密码解密失败', () => {
    const enc = encryptPayload(ctx, ['s', '张三'])
    const wrong = initCrypto('wrong-password', salt)
    expect(() => decryptPayload(wrong, enc)).toThrow('密码不符或文件被篡改')
  })

  it('篡改 1 字节即解密失败（GCM tag 校验）', () => {
    const enc = encryptPayload(ctx, ['s', '张三'])
    const buf = Buffer.from(enc.slice('ENC1:'.length), 'base64')
    buf[buf.length - 1] ^= 1
    expect(() => decryptPayload(ctx, 'ENC1:' + buf.toString('base64'))).toThrow(
      '密码不符或文件被篡改',
    )
  })

  it('畸形密文抛错而非崩溃', () => {
    expect(() => decryptPayload(ctx, 'ENC1:')).toThrow('密码不符或文件被篡改')
    expect(() => decryptPayload(ctx, 'ENC1:not-valid-base64!!!')).toThrow(
      '密码不符或文件被篡改',
    )
    expect(() => decryptPayload(ctx, 'ENC1:aGVsbG8td29ybGQtdGhpcy1pcy10b28tc2hvcnQ=')).toThrow(
      '密码不符或文件被篡改',
    )
  })
})

describe('valueToPayload / payloadToValue', () => {
  it('string/number/Date 转 payload', () => {
    expect(valueToPayload('张三')).toEqual(['s', '张三'])
    expect(valueToPayload(42.5)).toEqual(['n', 42.5])
    expect(valueToPayload(new Date('2026-08-31T00:00:00.000Z'))).toEqual([
      'd',
      '2026-08-31T00:00:00.000Z',
    ])
  })

  it('其他类型返回 null（boolean/对象/null）', () => {
    expect(valueToPayload(true)).toBeNull()
    expect(valueToPayload({ formula: 'A1' })).toBeNull()
    expect(valueToPayload(null)).toBeNull()
  })

  it('payloadToValue 还原类型', () => {
    expect(payloadToValue(['s', '张三'])).toBe('张三')
    expect(payloadToValue(['n', 42.5])).toBe(42.5)
    expect(payloadToValue(['d', '2026-08-31T00:00:00.000Z'])).toEqual(
      new Date('2026-08-31T00:00:00.000Z'),
    )
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run electron/main/crypto.test.ts`
Expected: FAIL（`./crypto.js` 无法解析 / 无导出）

- [ ] **Step 3: 实现 crypto.ts**

Create `electron/main/crypto.ts`：

```ts
import crypto from 'node:crypto'

/**
 * 确定性可逆加密：
 * - scrypt(password, salt) 派生主密钥，HKDF-SHA256 分出 encKey / sivKey
 * - iv = HMAC-SHA256(sivKey, payload)[0:12]（同一明文任何文件任何时间密文相同；
 *   订单等数据需要跨表关联，用户已接受暴露值相等性与频率的代价）
 * - AES-256-GCM(encKey, iv, payload)，单元格写回 'ENC1:' + base64(iv ‖ 密文 ‖ tag)
 * 纯函数模块，不依赖 electron，可独立单测。
 */

const PREFIX = 'ENC1:'
const IV_LEN = 12
const TAG_LEN = 16
const KEY_LEN = 32
const HKDF_SALT = 'sheet-masking-v1'

export interface CryptoContext {
  encKey: Buffer
  sivKey: Buffer
}

/** 带类型单元格 payload：s=文本 n=数字 d=ISO 日期字符串（还原后类型不变） */
export type CellPayload = ['s', string] | ['n', number] | ['d', string]

export function generateSalt(): string {
  return crypto.randomBytes(16).toString('base64')
}

export function initCrypto(password: string, salt: string): CryptoContext {
  const master = crypto.scryptSync(password, Buffer.from(salt, 'base64'), KEY_LEN)
  return {
    encKey: Buffer.from(crypto.hkdfSync('sha256', master, HKDF_SALT, 'enc', KEY_LEN)),
    sivKey: Buffer.from(crypto.hkdfSync('sha256', master, HKDF_SALT, 'siv', KEY_LEN)),
  }
}

export function isEncrypted(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PREFIX)
}

export function encryptPayload(ctx: CryptoContext, payload: CellPayload): string {
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8')
  const iv = crypto.createHmac('sha256', ctx.sivKey).update(plaintext).digest().subarray(0, IV_LEN)
  const cipher = crypto.createCipheriv('aes-256-gcm', ctx.encKey, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return PREFIX + Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64')
}

export function decryptPayload(ctx: CryptoContext, value: string): CellPayload {
  const fail = (): never => {
    throw new Error('密码不符或文件被篡改')
  }
  if (!isEncrypted(value)) fail()
  const buf = Buffer.from(value.slice(PREFIX.length), 'base64')
  if (buf.length < IV_LEN + TAG_LEN + 1) fail()
  const iv = buf.subarray(0, IV_LEN)
  const ciphertext = buf.subarray(IV_LEN, buf.length - TAG_LEN)
  const tag = buf.subarray(buf.length - TAG_LEN)
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', ctx.encKey, iv)
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    const parsed = JSON.parse(plaintext.toString('utf8')) as unknown
    if (Array.isArray(parsed) && parsed.length === 2) {
      const [kind, val] = parsed as [unknown, unknown]
      if (kind === 's' && typeof val === 'string') return ['s', val]
      if (kind === 'n' && typeof val === 'number') return ['n', val]
      if (kind === 'd' && typeof val === 'string') return ['d', val]
    }
    return fail()
  } catch {
    return fail()
  }
}

/** 字面量单元格值 → payload；空值/公式/富文本/超链接/布尔/错误等返回 null（跳过） */
export function valueToPayload(value: unknown): CellPayload | null {
  if (typeof value === 'string') return ['s', value]
  if (typeof value === 'number') return ['n', value]
  if (value instanceof Date) return ['d', value.toISOString()]
  return null
}

export function payloadToValue(payload: CellPayload): string | number | Date {
  switch (payload[0]) {
    case 's':
      return payload[1]
    case 'n':
      return payload[1]
    case 'd':
      return new Date(payload[1])
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run electron/main/crypto.test.ts`
Expected: PASS（全部 13 个用例）

注：若 vitest 无法把 `./crypto.js` 解析到 `crypto.ts`（Vite 对 TS importer 的 `.js`→`.ts` 解析一般开箱即用），在 vitest.config.ts 加 `resolve: { alias: ... }` 之前先确认报错内容。

- [ ] **Step 5: 类型检查 + Commit**

Run: `pnpm exec tsc --noEmit -p tsconfig.node.json`
Expected: 通过

```bash
git add electron/main/crypto.ts electron/main/crypto.test.ts
git commit -m "feat: deterministic AES-256-GCM cell crypto module"
```

---

### Task 3: 规则模块 rules.ts（TDD）

**Files:**
- Create: `electron/main/rules.ts`
- Test: `electron/main/rules.test.ts`

**Interfaces:**
- Consumes: `RulesConfig`、`BuiltinRule`（`../shared/types.js`，Task 1）
- Produces（Task 4/5/7 依赖）:
  - `BUILTIN_RULES: BuiltinRule[]`（13 条表头关键词 + 4 条内容正则）
  - `defaultRulesConfig(): RulesConfig`（全部内置启用，无自定义）
  - `matchColumns(headers: string[], sampleRows: string[][], config: RulesConfig): ColumnMatch[]`，`ColumnMatch = { autoSelected: boolean; matchedRules: string[] }`；`sampleRows[r][col]` 0-based 与 headers 下标对齐；matchedRules 元素为规则 label

- [ ] **Step 1: 写失败测试**

Create `electron/main/rules.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { BUILTIN_RULES, defaultRulesConfig, matchColumns } from './rules.js'

const emptyRows: string[][] = []

describe('defaultRulesConfig', () => {
  it('默认全部内置启用、无自定义', () => {
    expect(defaultRulesConfig()).toEqual({
      disabledBuiltins: [],
      customKeywords: [],
      customPatterns: [],
    })
    expect(BUILTIN_RULES.length).toBeGreaterThanOrEqual(13)
  })
})

describe('matchColumns 内置规则', () => {
  const config = defaultRulesConfig()

  it('表头关键词命中（姓名/手机号），其余不命中', () => {
    const result = matchColumns(['订单号', '姓名', '手机号', '金额'], emptyRows, config)
    expect(result.map((r) => r.autoSelected)).toEqual([false, true, true, false])
    expect(result[1].matchedRules).toContain('表头关键词：姓名')
    expect(result[2].matchedRules).toContain('表头关键词：手机号')
  })

  it('内容正则命中：表头无关键词但抽样内容命中手机号', () => {
    const result = matchColumns(
      ['单号', '联系方式'],
      [
        ['A001', '13800138000'],
        ['A002', '13900139000'],
      ],
      config,
    )
    expect(result[1].autoSelected).toBe(true)
    expect(result[1].matchedRules).toContain('内容正则：手机号')
  })

  it('身份证/银行卡/邮箱内容正则', () => {
    const result = matchColumns(
      ['a', 'b', 'c'],
      [['110101199003071234', '6222020200112233', 'a@b.com']],
      config,
    )
    expect(result[0].matchedRules).toContain('内容正则：身份证（18 位）')
    expect(result[1].matchedRules).toContain('内容正则：银行卡号（16-19 位）')
    expect(result[2].matchedRules).toContain('内容正则：邮箱')
  })

  it('手机号正则不误伤长数字串内部', () => {
    const result = matchColumns(['x'], [['6222020200112233']], config)
    expect(result[0].matchedRules).not.toContain('内容正则：手机号')
  })

  it('禁用内置规则后不再命中', () => {
    const disabled = matchColumns(['姓名'], emptyRows, {
      ...config,
      disabledBuiltins: ['kw:姓名'],
    })
    expect(disabled[0].autoSelected).toBe(false)
    expect(disabled[0].matchedRules).toEqual([])
  })
})

describe('matchColumns 自定义规则', () => {
  it('自定义关键词命中表头', () => {
    const result = matchColumns(['工号'], emptyRows, {
      ...defaultRulesConfig(),
      customKeywords: ['工号'],
    })
    expect(result[0].autoSelected).toBe(true)
    expect(result[0].matchedRules).toContain('自定义关键词：工号')
  })

  it('自定义正则命中内容', () => {
    const result = matchColumns(['单号'], [['ORD-123'], ['ORD-456']], {
      ...defaultRulesConfig(),
      customPatterns: ['^ORD-\\d+$'],
    })
    expect(result[0].autoSelected).toBe(true)
    expect(result[0].matchedRules).toContain('自定义正则：^ORD-\\d+$')
  })

  it('无效自定义正则被跳过且不中断', () => {
    const result = matchColumns(['单号'], [['ORD-123']], {
      ...defaultRulesConfig(),
      customPatterns: ['(', '^ORD-\\d+$'],
    })
    expect(result[0].autoSelected).toBe(true)
  })

  it('无命中时 autoSelected=false 且 matchedRules 为空', () => {
    const result = matchColumns(['金额', '数量'], [['100', '3']], defaultRulesConfig())
    expect(result).toEqual([
      { autoSelected: false, matchedRules: [] },
      { autoSelected: false, matchedRules: [] },
    ])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run electron/main/rules.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 rules.ts**

Create `electron/main/rules.ts`：

```ts
import type { BuiltinRule, RulesConfig } from '../shared/types.js'

/**
 * 脱敏列识别规则：
 * - 内置表头关键词（includes 匹配）
 * - 内置内容正则（对前 50 个数据行抽样；命中任一样本即整列选中）
 * - 用户自定义关键词/正则；每条内置规则可启停（disabledBuiltins 存 id）
 */

export const BUILTIN_RULES: BuiltinRule[] = [
  { id: 'kw:姓名', label: '表头关键词：姓名', kind: 'keyword', value: '姓名' },
  { id: 'kw:身份证', label: '表头关键词：身份证', kind: 'keyword', value: '身份证' },
  { id: 'kw:证件', label: '表头关键词：证件', kind: 'keyword', value: '证件' },
  { id: 'kw:手机号', label: '表头关键词：手机号', kind: 'keyword', value: '手机号' },
  { id: 'kw:电话', label: '表头关键词：电话', kind: 'keyword', value: '电话' },
  { id: 'kw:银行卡', label: '表头关键词：银行卡', kind: 'keyword', value: '银行卡' },
  { id: 'kw:卡号', label: '表头关键词：卡号', kind: 'keyword', value: '卡号' },
  { id: 'kw:账号', label: '表头关键词：账号', kind: 'keyword', value: '账号' },
  { id: 'kw:开户行', label: '表头关键词：开户行', kind: 'keyword', value: '开户行' },
  { id: 'kw:税号', label: '表头关键词：税号', kind: 'keyword', value: '税号' },
  {
    id: 'kw:统一社会信用代码',
    label: '表头关键词：统一社会信用代码',
    kind: 'keyword',
    value: '统一社会信用代码',
  },
  { id: 'kw:邮箱', label: '表头关键词：邮箱', kind: 'keyword', value: '邮箱' },
  { id: 'kw:地址', label: '表头关键词：地址', kind: 'keyword', value: '地址' },
  // \b 对中文文本中的 ASCII 数字串同样有效（中文字符是非 word 字符）
  { id: 're:idcard', label: '内容正则：身份证（18 位）', kind: 'pattern', value: '\\b\\d{17}[\\dXx]\\b' },
  { id: 're:phone', label: '内容正则：手机号', kind: 'pattern', value: '\\b1[3-9]\\d{9}\\b' },
  { id: 're:bankcard', label: '内容正则：银行卡号（16-19 位）', kind: 'pattern', value: '\\b\\d{16,19}\\b' },
  { id: 're:email', label: '内容正则：邮箱', kind: 'pattern', value: '[\\w.+-]+@[\\w-]+\\.[\\w.]+' },
]

export function defaultRulesConfig(): RulesConfig {
  return { disabledBuiltins: [], customKeywords: [], customPatterns: [] }
}

export interface ColumnMatch {
  autoSelected: boolean
  matchedRules: string[]
}

export function matchColumns(
  headers: string[],
  sampleRows: string[][],
  config: RulesConfig,
): ColumnMatch[] {
  const disabled = new Set(config.disabledBuiltins)
  const keywords: { label: string; needle: string }[] = []
  const patterns: { label: string; re: RegExp }[] = []

  for (const rule of BUILTIN_RULES) {
    if (disabled.has(rule.id)) continue
    if (rule.kind === 'keyword') {
      keywords.push({ label: rule.label, needle: rule.value })
    } else {
      patterns.push({ label: rule.label, re: new RegExp(rule.value) })
    }
  }
  for (const kw of config.customKeywords) {
    const needle = kw.trim()
    if (needle) keywords.push({ label: `自定义关键词：${needle}`, needle })
  }
  for (const src of config.customPatterns) {
    try {
      patterns.push({ label: `自定义正则：${src}`, re: new RegExp(src) })
    } catch {
      // 保存时已校验；此处防御性跳过无效正则，不中断整列分析
    }
  }

  return headers.map((header, col) => {
    const matchedRules: string[] = []
    for (const { label, needle } of keywords) {
      if (header.includes(needle)) matchedRules.push(label)
    }
    for (const row of sampleRows) {
      const value = row[col]
      if (!value) continue
      for (const { label, re } of patterns) {
        if (!matchedRules.includes(label) && re.test(value)) matchedRules.push(label)
      }
    }
    return { autoSelected: matchedRules.length > 0, matchedRules }
  })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run electron/main/rules.test.ts`
Expected: PASS

- [ ] **Step 5: 类型检查 + Commit**

Run: `pnpm exec tsc --noEmit -p tsconfig.node.json`
Expected: 通过

```bash
git add electron/main/rules.ts electron/main/rules.test.ts
git commit -m "feat: masking rules (builtin keywords/patterns, custom rules, per-rule toggle)"
```

---

### Task 4: 配置与密码 config.ts

**Files:**
- Create: `electron/main/config.ts`

**Interfaces:**
- Consumes: `initCrypto/encryptPayload/decryptPayload/generateSalt/CryptoContext`（`./crypto.js`）；`defaultRulesConfig`（`./rules.js`）；`RulesConfig`（`../shared/types.js`）
- Produces（Task 7 依赖）:
  - `AppState = 'setup' | 'locked' | 'unlocked'`
  - `getAppState(): AppState`（无配置→setup；已解锁→unlocked；尝试 safeStorage 自动解锁，成功→unlocked 否则→locked）
  - `setupPassword(password: string): void`（生成新 salt/verifier/encPassword；保留已有 rules）
  - `unlockWithPassword(password: string): boolean`（verifier 校验，成功即解锁）
  - `changePassword(oldPassword, newPassword): boolean`
  - `getCryptoContext(): CryptoContext`（未解锁抛错）
  - `getRulesConfig(): RulesConfig`、`saveRulesConfig(config: RulesConfig): void`（校验 customPatterns 可编译）

**说明：** 本模块 import electron（safeStorage/app），不进 vitest（spec：单测只覆盖 crypto/rules/sheet/csv），由类型检查 + Task 7 的构建验证。spec 配置形状 `{ salt, encPassword, rules }` 之外**增加 `verifier` 字段**（用当前密钥加密固定明文的 ENC1 串）——回退解锁时必须能校验密码正确性，否则错密码会被静默接受导致文件密钥混乱。

- [ ] **Step 1: 实现 config.ts**

Create `electron/main/config.ts`：

```ts
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import {
  decryptPayload,
  encryptPayload,
  generateSalt,
  initCrypto,
  type CryptoContext,
} from './crypto.js'
import { defaultRulesConfig } from './rules.js'
import type { RulesConfig } from '../shared/types.js'

/**
 * userData/config.json：
 * {
 *   salt: string         // scrypt salt（base64，随机生成）
 *   encPassword: string  // safeStorage.encryptString(password) 的 base64；不明文落盘。
 *                        // safeStorage 不可用时空串（每次启动需手动解锁）
 *   verifier: string     // ENC1 加密的固定明文，用于回退流程校验密码正确性
 *   rules: RulesConfig
 * }
 * Windows 上 safeStorage 走 DPAPI（绑定当前系统用户；换机/换用户解不开 → 走
 * unlockWithPassword 回退）。
 */

const VERIFIER_PLAINTEXT = 'sheet-masking-verifier-v1'

interface StoredConfig {
  salt: string
  encPassword: string
  verifier: string
  rules: RulesConfig
}

export type AppState = 'setup' | 'locked' | 'unlocked'

/** 派生密钥驻留主进程内存，不落盘 */
let ctx: CryptoContext | null = null

function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json')
}

function readStored(): StoredConfig | null {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8')) as StoredConfig
  } catch {
    return null
  }
}

function writeStored(config: StoredConfig): void {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true })
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8')
}

export function getAppState(): AppState {
  const stored = readStored()
  if (!stored) return 'setup'
  if (ctx) return 'unlocked'
  if (stored.encPassword && safeStorage.isEncryptionAvailable()) {
    try {
      const password = safeStorage.decryptString(Buffer.from(stored.encPassword, 'base64'))
      ctx = initCrypto(password, stored.salt)
      return 'unlocked'
    } catch {
      return 'locked'
    }
  }
  return 'locked'
}

/** 首次设置/修改密码：生成新 salt 与 verifier，保留已有规则配置 */
export function setupPassword(password: string): void {
  const salt = generateSalt()
  const next = initCrypto(password, salt)
  const canStore = safeStorage.isEncryptionAvailable()
  writeStored({
    salt,
    encPassword: canStore ? safeStorage.encryptString(password).toString('base64') : '',
    verifier: encryptPayload(next, ['s', VERIFIER_PLAINTEXT]),
    rules: readStored()?.rules ?? defaultRulesConfig(),
  })
  ctx = next
}

/** 回退解锁：用存储 salt 派生密钥，解密 verifier 校验密码正确性 */
export function unlockWithPassword(password: string): boolean {
  const stored = readStored()
  if (!stored) return false
  const candidate = initCrypto(password, stored.salt)
  try {
    const payload = decryptPayload(candidate, stored.verifier)
    if (payload[0] === 's' && payload[1] === VERIFIER_PLAINTEXT) {
      ctx = candidate
      return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * 修改密码：校验旧密码后重新 setup（新 salt/verifier/encPassword）。
 * 注意：旧密码脱敏的文件将无法再还原，UI 必须先行警告。
 */
export function changePassword(oldPassword: string, newPassword: string): boolean {
  if (!unlockWithPassword(oldPassword)) return false
  setupPassword(newPassword)
  return true
}

export function getCryptoContext(): CryptoContext {
  if (!ctx) throw new Error('未解锁：请先设置或输入主密码')
  return ctx
}

export function getRulesConfig(): RulesConfig {
  return readStored()?.rules ?? defaultRulesConfig()
}

export function saveRulesConfig(config: RulesConfig): void {
  const stored = readStored()
  if (!stored) throw new Error('请先设置主密码')
  for (const src of config.customPatterns) {
    try {
      new RegExp(src)
    } catch {
      throw new Error(`无效正则：${src}`)
    }
  }
  writeStored({ ...stored, rules: config })
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm exec tsc --noEmit -p tsconfig.node.json`
Expected: 通过

- [ ] **Step 3: Commit**

```bash
git add electron/main/config.ts
git commit -m "feat: password config storage with safeStorage and verifier"
```

---

### Task 5: 表格引擎 sheet.ts（xlsx，TDD）

**Files:**
- Create: `electron/main/sheet.ts`
- Test: `electron/main/sheet.test.ts`

**Interfaces:**
- Consumes: `crypto.ts`（Task 2）、`rules.ts`（Task 3）、`csv.ts` 的 `analyzeCsv/processCsv`（Task 6——本任务先写 import 和分发，Task 6 补齐实现前 `analyzeFile/processFile` 对 csv 会抛错，测试只覆盖 xlsx 路径）
- Produces（Task 6/7 依赖）:
  - `HEADER_CANDIDATE_ROWS = 5`、`SAMPLE_DATA_ROWS = 50`、`YIELD_EVERY_ROWS = 500`
  - `kindFromPath(filePath): FileKind`
  - `analyzeFile(filePath, rules, headerRowOverrides?): Promise<AnalyzeResult>`
  - `processFile(filePath, mode, selections, outPath, ctx, onProgress): Promise<ProcessSummary>`
  - `detectHeaderRow(denseRows: string[][]): number`（纯函数，1-based；csv.ts 复用）
  - `buildAnalysis(name, hidden, headerRow, denseRows, rules): SheetAnalysis`（csv.ts 复用）
  - `analyzeXlsx(filePath, rules, headerRowOverrides?): Promise<SheetAnalysis[]>`
  - `processXlsx(filePath, mode, selections, outPath, ctx, onProgress): Promise<ProcessSummary>`（encrypt 跳过每 sheet 的 headerRow 行；decrypt 忽略 selections 全文扫描）
  - `onProgress(percent: number)`：0-100 整数，保证最后一次为 100

**ExcelJS 要点（已核源码）：** 流式 `Excel.stream.xlsx.WorkbookReader` 可 `for await` 迭代 sheet；`sheetReader.name`/`sheetReader.state` 运行时由 workbook.xml 赋值但 **d.ts 未声明**，需收窄类型；行迭代提前 `break` 后剩余 XML 由 zip entry 的 `autodrain()` 兜底，可继续下一 sheet（本任务测试覆盖多 sheet 提前中断）。`styles: 'ignore'` 时日期以原始数字读出（analyze 只做文本抽样，无影响）。

- [ ] **Step 1: 写失败测试**

Create `electron/main/sheet.test.ts`：

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateSalt, initCrypto, isEncrypted } from './crypto.js'
import { defaultRulesConfig } from './rules.js'
import { analyzeXlsx, detectHeaderRow, processXlsx } from './sheet.js'

const rules = defaultRulesConfig()
const ctx = initCrypto('test-password', generateSalt())

let dir: string
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-test-'))
})
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

/** 第 1 行大标题、第 2 行真实表头、含公式/日期/合并单元格；另有隐藏 sheet */
async function buildFixture(filePath: string): Promise<void> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('订单')
  ws.addRow(['订单报表（导出）'])
  ws.addRow(['订单号', '姓名', '手机号', '金额'])
  ws.addRow(['A001', '张三', '13800138000', 100.5])
  ws.addRow(['A002', '李四', '13900139000', 200])
  ws.getCell('E3').value = { formula: 'D3+D4', result: 300.5 }
  const dateCell = ws.getCell('F3')
  dateCell.value = new Date('2026-01-15T00:00:00.000Z')
  dateCell.numFmt = 'yyyy-mm-dd'
  ws.mergeCells('A5:B5')
  ws.getCell('A5').value = '合并备注'

  const hidden = wb.addWorksheet('隐藏表')
  hidden.state = 'hidden'
  hidden.addRow(['卡号', '备注'])
  hidden.addRow(['6222020200112233', '张三'])

  await wb.xlsx.writeFile(filePath)
}

describe('detectHeaderRow（纯函数）', () => {
  it('标题行+表头行：选非空最多且下一行有数据的行', () => {
    expect(
      detectHeaderRow([
        ['订单报表（导出）', ''],
        ['订单号', '姓名'],
        ['A001', '张三'],
      ]),
    ).toBe(2)
  })
  it('表头在第 1 行', () => {
    expect(
      detectHeaderRow([
        ['订单号', '姓名'],
        ['A001', '张三'],
      ]),
    ).toBe(1)
  })
  it('非空数相同取靠前的行', () => {
    expect(
      detectHeaderRow([
        ['a', 'b'],
        ['c', 'd'],
        ['e', 'f'],
      ]),
    ).toBe(1)
  })
  it('仅一行/空表回退为 1', () => {
    expect(detectHeaderRow([['仅一行']])).toBe(1)
    expect(detectHeaderRow([])).toBe(1)
  })
})

describe('analyzeXlsx', () => {
  it('探测表头行、按规则自动勾选、隐藏 sheet 照常列出并标注', async () => {
    const file = path.join(dir, 'analyze.xlsx')
    await buildFixture(file)
    const sheets = await analyzeXlsx(file, rules)
    expect(sheets.map((s) => s.name)).toEqual(['订单', '隐藏表'])

    const order = sheets[0]
    expect(order.hidden).toBe(false)
    expect(order.headerRow).toBe(2)
    expect(order.headers.map((h) => h.name)).toEqual(['订单号', '姓名', '手机号', '金额'])
    const byName = Object.fromEntries(order.headers.map((h) => [h.name, h]))
    expect(byName['姓名'].autoSelected).toBe(true)
    expect(byName['姓名'].matchedRules).toContain('表头关键词：姓名')
    expect(byName['手机号'].matchedRules).toContain('内容正则：手机号')
    expect(byName['订单号'].autoSelected).toBe(false)

    const hiddenSheet = sheets[1]
    expect(hiddenSheet.hidden).toBe(true)
    expect(hiddenSheet.headerRow).toBe(1)
    expect(hiddenSheet.headers[0].autoSelected).toBe(true) // 卡号关键词 + 银行卡内容正则
  })

  it('表头行手动修正后重跑规则', async () => {
    const file = path.join(dir, 'override.xlsx')
    await buildFixture(file)
    const sheets = await analyzeXlsx(file, rules, { 订单: 1 })
    expect(sheets[0].headerRow).toBe(1)
    expect(sheets[0].headers.map((h) => h.name)).toEqual(['订单报表（导出）'])
  })
})

describe('processXlsx 加密→还原往返', () => {
  it('加密选中列（跳过表头行）、跨 sheet/跨文件密文一致、还原后与原文逐格一致', async () => {
    const src = path.join(dir, 'roundtrip.xlsx')
    const src2 = path.join(dir, 'roundtrip2.xlsx')
    await buildFixture(src)
    await buildFixture(src2)
    const selections = {
      订单: { headerRow: 2, cols: [2, 3, 5, 6] },
      隐藏表: { headerRow: 1, cols: [1, 2] },
    }
    const enc1 = path.join(dir, 'enc1.xlsx')
    const enc2 = path.join(dir, 'enc2.xlsx')
    const progress: number[] = []

    // 计数：订单 sheet 表头行（第 2 行）跳过；数据格 B3/B4、C3/C4、F3 共 5 格，
    // E3 公式跳过；隐藏表表头行（第 1 行）跳过，A2/B2 共 2 格 → 合计 7
    const summary = await processXlsx(src, 'encrypt', selections, enc1, ctx, (p) =>
      progress.push(p),
    )
    expect(summary.processedCells).toBe(7)
    expect(summary.skippedFormulas).toBe(1)
    expect(progress[progress.length - 1]).toBe(100)

    await processXlsx(src2, 'encrypt', selections, enc2, ctx, () => {})

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(enc1)
    const ws = wb.getWorksheet('订单')!
    expect(ws.getCell('B2').value).toBe('姓名') // 表头行不加密
    expect(isEncrypted(ws.getCell('B3').value)).toBe(true)
    expect(isEncrypted(ws.getCell('C3').value)).toBe(true)
    expect(ws.getCell('A3').value).toBe('A001') // 未选列不动
    expect(ws.getCell('D3').value).toBe(100.5) // 金额列不变
    const formula = ws.getCell('E3').value as { formula: string }
    expect(formula.formula).toBe('D3+D4') // 公式保留
    expect(ws.getCell('B5').isMerged).toBe(true) // 合并单元格保留

    // 跨 sheet 与跨文件：同一明文密文完全相同
    const hiddenWs = wb.getWorksheet('隐藏表')!
    expect(hiddenWs.getCell('B2').value).toBe(ws.getCell('B3').value) // 张三 === 张三
    const wb2 = new ExcelJS.Workbook()
    await wb2.xlsx.readFile(enc2)
    expect(wb2.getWorksheet('订单')!.getCell('B3').value).toBe(ws.getCell('B3').value)

    // 重复加密防护：对已加密文件重跑，不再变化
    const re = await processXlsx(enc1, 'encrypt', selections, enc2, ctx, () => {})
    expect(re.processedCells).toBe(0)

    // 还原：与原文逐格一致（含类型）
    const dec = path.join(dir, 'dec.xlsx')
    const decSummary = await processXlsx(enc1, 'decrypt', {}, dec, ctx, () => {})
    expect(decSummary.failedCells).toEqual([])
    expect(decSummary.processedCells).toBe(7)
    const dwb = new ExcelJS.Workbook()
    await dwb.xlsx.readFile(dec)
    const dws = dwb.getWorksheet('订单')!
    expect(dws.getCell('B3').value).toBe('张三')
    expect(dws.getCell('C3').value).toBe('13800138000')
    expect(dws.getCell('F3').value).toEqual(new Date('2026-01-15T00:00:00.000Z'))
    expect(dwb.getWorksheet('隐藏表')!.getCell('A2').value).toBe('6222020200112233')
  })

  it('密码错误：第一个 ENC1 格即失败，整体中止', async () => {
    const src = path.join(dir, 'wrongpw.xlsx')
    const enc = path.join(dir, 'wrongpw-enc.xlsx')
    await buildFixture(src)
    await processXlsx(src, 'encrypt', { 订单: { headerRow: 2, cols: [2] } }, enc, ctx, () => {})
    const wrong = initCrypto('other-password', generateSalt())
    await expect(
      processXlsx(enc, 'decrypt', {}, path.join(dir, 'wrongpw-dec.xlsx'), wrong, () => {}),
    ).rejects.toThrow('密码不符或文件被篡改')
  })

  it('个别格损坏：记录地址、跳过并继续', async () => {
    const src = path.join(dir, 'partial.xlsx')
    const enc = path.join(dir, 'partial-enc.xlsx')
    await buildFixture(src)
    await processXlsx(src, 'encrypt', { 订单: { headerRow: 2, cols: [2, 3] } }, enc, ctx, () => {})
    // 篡改非首个 ENC1 格（C3；行优先扫描序上 B3 在前且完好）
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(enc)
    const ws = wb.getWorksheet('订单')!
    const encText = ws.getCell('C3').value as string
    const buf = Buffer.from(encText.slice('ENC1:'.length), 'base64')
    buf[buf.length - 1] ^= 1
    ws.getCell('C3').value = 'ENC1:' + buf.toString('base64')
    const tampered = path.join(dir, 'partial-tampered.xlsx')
    await wb.xlsx.writeFile(tampered)

    const summary = await processXlsx(
      tampered,
      'decrypt',
      {},
      path.join(dir, 'partial-dec.xlsx'),
      ctx,
      () => {},
    )
    expect(summary.failedCells).toEqual(['订单!C3'])
    expect(summary.processedCells).toBe(3) // B3、B4、C4 成功
  })
})
```

先创建占位 `electron/main/csv.ts`：

```ts
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
```

再创建 `electron/main/sheet.ts`：

```ts
import path from 'node:path'
import ExcelJS from 'exceljs'
import {
  decryptPayload,
  encryptPayload,
  isEncrypted,
  payloadToValue,
  valueToPayload,
  type CryptoContext,
} from './crypto.js'
import { matchColumns } from './rules.js'
import { analyzeCsv, processCsv } from './csv.js'
import type {
  AnalyzeResult,
  FileKind,
  ProcessMode,
  ProcessSelections,
  ProcessSummary,
  RulesConfig,
  SheetAnalysis,
} from '../shared/types.js'

/** 表头行探测窗口（前 5 行）与内容抽样行数（表头后 50 行） */
export const HEADER_CANDIDATE_ROWS = 5
export const SAMPLE_DATA_ROWS = 50
const MAX_READ_ROWS = HEADER_CANDIDATE_ROWS + SAMPLE_DATA_ROWS
/** 每处理 N 行让出一次事件循环并推送进度 */
export const YIELD_EVERY_ROWS = 500

export function kindFromPath(filePath: string): FileKind {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.xlsx') return 'xlsx'
  if (ext === '.csv') return 'csv'
  throw new Error(`不支持的文件格式：${ext || filePath}（仅支持 .xlsx / .csv）`)
}

export async function analyzeFile(
  filePath: string,
  rules: RulesConfig,
  headerRowOverrides: Record<string, number> = {},
): Promise<AnalyzeResult> {
  const kind = kindFromPath(filePath)
  const sheets =
    kind === 'xlsx'
      ? await analyzeXlsx(filePath, rules, headerRowOverrides)
      : await analyzeCsv(filePath, rules, headerRowOverrides[path.basename(filePath)])
  return { filePath, kind, sheets }
}

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
  return processCsv(filePath, mode, selections[path.basename(filePath)], outPath, ctx, onProgress)
}

/**
 * 表头行自动探测：前 5 行中取「文本单元格（非空且非纯数字）最多且下一行有数据」的行；
 * 计数相同取靠前的行；末行无下一行也允许参选。返回 1-based 行号。
 * （2026-08-31 实现期修正：spec 原文「非空单元格最多」会把全填满的数据行误判为表头，
 *  经用户确认采用「非空且非纯数字」口径。局限：数据行文本多于表头时仍会误判，UI 可手动修正。）
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

/** 由稠密行文本构造 SheetAnalysis（xlsx/csv 共用）：表头行 → headers，其后 50 行抽样跑规则 */
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

/** 流式读出的单元格值 → 文本（analyze 只用于表头与内容抽样；样式忽略时日期为原始数字，可接受） */
function streamCellText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    const v = value as { richText?: { text: string }[]; text?: string; result?: unknown }
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('')
    if (typeof v.text === 'string') return v.text
    if (v.result != null) return streamCellText(v.result)
  }
  return ''
}

/** row.values 为 1-based 稀疏数组；转 0-based 稠密文本并去掉行尾空列 */
function normalizeStreamRow(values: unknown[]): string[] {
  const out: string[] = []
  for (let i = 1; i < values.length; i++) out.push(streamCellText(values[i]))
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out
}

export async function analyzeXlsx(
  filePath: string,
  rules: RulesConfig,
  headerRowOverrides: Record<string, number> = {},
): Promise<SheetAnalysis[]> {
  const analyses: SheetAnalysis[] = []
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    worksheets: 'emit',
    sharedStrings: 'cache',
    hyperlinks: 'ignore',
    styles: 'ignore',
    entries: 'ignore',
  })
  for await (const sheetReader of reader) {
    // name/state 运行时由 workbook.xml 赋值，但 exceljs 的 d.ts 未声明
    const meta = sheetReader as unknown as { name?: string; state?: string }
    const name = meta.name ?? `Sheet${analyses.length + 1}`
    const sparseRows: string[][] = []
    for await (const row of sheetReader) {
      if (row.number > MAX_READ_ROWS) break // 每 sheet 只读前几行即停；剩余 XML 由 zip entry autodrain 兜底
      sparseRows[row.number - 1] = normalizeStreamRow(row.values as unknown[])
    }
    const denseRows: string[][] = []
    for (let i = 0; i < sparseRows.length; i++) denseRows.push(sparseRows[i] ?? [])
    const headerRow = headerRowOverrides[name] ?? detectHeaderRow(denseRows)
    const hidden = meta.state === 'hidden' || meta.state === 'veryHidden'
    analyses.push(buildAnalysis(name, hidden, headerRow, denseRows, rules))
  }
  return analyses
}

export async function processXlsx(
  filePath: string,
  mode: ProcessMode,
  selections: ProcessSelections,
  outPath: string,
  ctx: CryptoContext,
  onProgress: (percent: number) => void,
): Promise<ProcessSummary> {
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.readFile(filePath) // 全量加载保真（样式/公式/合并/列宽保留；图表/图片/透视表丢失为已知限制）
  } catch (err) {
    throw new Error(
      `无法读取工作簿（文件损坏、格式不支持或文件过大内存不足；如为超大文件请拆分后重试）：${(err as Error).message}`,
    )
  }

  let processedCells = 0
  let skippedFormulas = 0
  const failedCells: string[] = []
  let firstEncSeen = false
  const totalRows = Math.max(
    1,
    workbook.worksheets.reduce((sum, ws) => sum + ws.rowCount, 0),
  )
  let doneRows = 0

  for (const ws of workbook.worksheets) {
    const selection = mode === 'encrypt' ? selections[ws.name] : undefined
    const selectedCols = new Set(selection?.cols ?? [])
    if (mode === 'encrypt' && selectedCols.size === 0) {
      doneRows += ws.rowCount
      continue
    }
    // eachRow 回调是同步的，先收集行引用再逐行 await 让出事件循环
    const rows: ExcelJS.Row[] = []
    ws.eachRow({ includeEmpty: false }, (row) => rows.push(row))
    for (const row of rows) {
      // 加密跳过表头行：表头列名不是敏感数据，且保持已脱敏文件可再次分析
      if (mode === 'encrypt' && selection && row.number === selection.headerRow) {
        doneRows++
        continue
      }
      for (let c = 1; c <= row.cellCount; c++) {
        const cell = row.getCell(c)
        if (mode === 'encrypt') {
          if (!selectedCols.has(c)) continue
          if (cell.type === ExcelJS.ValueType.Formula) {
            skippedFormulas++
            continue
          }
          const value = cell.value
          if (isEncrypted(value)) continue // 防重复加密
          // 合并从格与主格共享存储（实测赋值从格会连带改主格），整格跳过
          if (cell.type === ExcelJS.ValueType.Merge) continue
          const payload = valueToPayload(value) // 空/富文本/超链接/布尔/错误 → null 跳过
          if (payload === null) continue
          cell.value = encryptPayload(ctx, payload)
          processedCells++
        } else {
          // 还原：凡 ENC1: 前缀自动还原，与列位置无关（增删列/调列序/另存均可还原）
          const value = cell.value
          if (!isEncrypted(value)) continue
          const isFirst = !firstEncSeen
          firstEncSeen = true
          try {
            cell.value = payloadToValue(decryptPayload(ctx, value))
            processedCells++
          } catch {
            // 第一个 ENC1 格即失败 → 密码错误，整体中止；个别失败 → 记录地址继续
            if (isFirst) throw new Error('密码不符或文件被篡改')
            failedCells.push(`${ws.name}!${cell.address}`)
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

  await workbook.xlsx.writeFile(outPath)
  onProgress(100)
  return { processedCells, skippedFormulas, failedCells, outPath }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run electron/main/sheet.test.ts`
Expected: PASS

- [ ] **Step 5: 类型检查 + Commit**

Run: `pnpm exec tsc --noEmit -p tsconfig.node.json`
Expected: 通过

```bash
git add electron/main/sheet.ts electron/main/csv.ts electron/main/sheet.test.ts
git commit -m "feat: xlsx analyze/process engine (ExcelJS full fidelity)"
```

---

### Task 6: CSV 引擎 csv.ts（TDD）

**Files:**
- Modify: `electron/main/csv.ts`（替换 Task 5 的占位为完整实现）
- Test: `electron/main/csv.test.ts`

**Interfaces:**
- Consumes: `crypto.ts`（Task 2）；`sheet.ts` 的 `detectHeaderRow/buildAnalysis/HEADER_CANDIDATE_ROWS/SAMPLE_DATA_ROWS/YIELD_EVERY_ROWS`（Task 5）
- Produces（实现 Task 5 已声明的签名）：
  - `detectCsvEncoding(filePath): Promise<'utf8' | 'gbk'>`
  - `readCsvHead(filePath, encoding, maxRows): Promise<string[][]>`
  - `analyzeCsv(filePath, rules, headerRowOverride?): Promise<SheetAnalysis[]>`（单 sheet，name = 文件 basename，hidden = false）
  - `processCsv(filePath, mode, selection: SheetSelection | undefined, outPath, ctx, onProgress): Promise<ProcessSummary>`（encrypt 用 selection.cols（1-based 列号）并跳过 selection.headerRow 行；decrypt 忽略 selection，全文扫描 ENC1:）

- [ ] **Step 1: 写失败测试**

Create `electron/main/csv.test.ts`：

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import iconv from 'iconv-lite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateSalt, initCrypto, isEncrypted } from './crypto.js'
import { defaultRulesConfig } from './rules.js'
import { analyzeCsv, detectCsvEncoding, processCsv, readCsvHead } from './csv.js'

const rules = defaultRulesConfig()
const ctx = initCrypto('test-password', generateSalt())

let dir: string
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-test-'))
})
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const UTF8_CSV = '订单号,姓名,手机号\nA001,张三,13800138000\nA002,李四,13900139000\n'

describe('detectCsvEncoding / readCsvHead', () => {
  it('UTF-8（无 BOM）', async () => {
    const file = path.join(dir, 'utf8.csv')
    fs.writeFileSync(file, UTF8_CSV, 'utf8')
    expect(await detectCsvEncoding(file)).toBe('utf8')
    const rows = await readCsvHead(file, 'utf8', 10)
    expect(rows[0]).toEqual(['订单号', '姓名', '手机号'])
  })

  it('UTF-8 带 BOM：去 BOM 后表头干净', async () => {
    const file = path.join(dir, 'utf8-bom.csv')
    fs.writeFileSync(file, '\uFEFF' + UTF8_CSV, 'utf8')
    expect(await detectCsvEncoding(file)).toBe('utf8')
    const sheets = await analyzeCsv(file, rules)
    expect(sheets[0].headers.map((h) => h.name)).toEqual(['订单号', '姓名', '手机号'])
  })

  it('GBK：无 BOM 且 UTF-8 解码失败 → gbk，iconv 转 UTF-8', async () => {
    const file = path.join(dir, 'gbk.csv')
    fs.writeFileSync(file, iconv.encode('卡号,金额\n6222020200112233,100\n', 'gbk'))
    expect(await detectCsvEncoding(file)).toBe('gbk')
    const rows = await readCsvHead(file, 'gbk', 10)
    expect(rows[0]).toEqual(['卡号', '金额'])
  })

  it('readCsvHead 提前停止（不读完整文件）', async () => {
    const file = path.join(dir, 'head.csv')
    fs.writeFileSync(file, UTF8_CSV, 'utf8')
    const rows = await readCsvHead(file, 'utf8', 2)
    expect(rows).toHaveLength(2)
  })
})

describe('analyzeCsv', () => {
  it('单 sheet（basename）、规则自动勾选', async () => {
    const file = path.join(dir, 'analyze.csv')
    fs.writeFileSync(file, UTF8_CSV, 'utf8')
    const sheets = await analyzeCsv(file, rules)
    expect(sheets).toHaveLength(1)
    expect(sheets[0].name).toBe('analyze.csv')
    expect(sheets[0].hidden).toBe(false)
    expect(sheets[0].headerRow).toBe(1)
    expect(sheets[0].headers.map((h) => h.autoSelected)).toEqual([false, true, true])
  })
})

describe('processCsv 加密→还原往返', () => {
  it('选中列加密（跳过表头行）、输出 UTF-8 BOM + CRLF、还原一致', async () => {
    const src = path.join(dir, 'roundtrip.csv')
    fs.writeFileSync(src, UTF8_CSV, 'utf8')
    const enc = path.join(dir, 'roundtrip-enc.csv')
    const summary = await processCsv(
      src,
      'encrypt',
      { headerRow: 1, cols: [2, 3] },
      enc,
      ctx,
      () => {},
    )
    expect(summary.processedCells).toBe(4)

    const out = fs.readFileSync(enc)
    expect(out[0]).toBe(0xef) // BOM
    expect(out[1]).toBe(0xbb)
    expect(out[2]).toBe(0xbf)
    const text = out.toString('utf8')
    expect(text).toContain('\r\n')
    const lines = text.slice(1).split('\r\n') // slice(1) 去掉 BOM 字符
    expect(lines[0]).toBe('订单号,姓名,手机号') // 表头行不加密
    const cells1 = lines[1].split(',')
    expect(cells1[0]).toBe('A001')
    expect(isEncrypted(cells1[1])).toBe(true)
    expect(isEncrypted(cells1[2])).toBe(true)

    // 还原
    const dec = path.join(dir, 'roundtrip-dec.csv')
    const decSummary = await processCsv(enc, 'decrypt', undefined, dec, ctx, () => {})
    expect(decSummary.failedCells).toEqual([])
    expect(decSummary.processedCells).toBe(4)
    const decText = fs.readFileSync(dec, 'utf8').slice(1).replace(/\r\n/g, '\n')
    expect(decText).toBe(UTF8_CSV)
  })

  it('GBK 输入往返：输出统一为 UTF-8 BOM', async () => {
    const src = path.join(dir, 'gbk-rt.csv')
    const original = '卡号,备注\n6222020200112233,张三\n'
    fs.writeFileSync(src, iconv.encode(original, 'gbk'))
    const enc = path.join(dir, 'gbk-rt-enc.csv')
    await processCsv(src, 'encrypt', { headerRow: 1, cols: [1, 2] }, enc, ctx, () => {})
    const dec = path.join(dir, 'gbk-rt-dec.csv')
    await processCsv(enc, 'decrypt', undefined, dec, ctx, () => {})
    const decText = fs.readFileSync(dec, 'utf8').slice(1).replace(/\r\n/g, '\n')
    expect(decText).toBe(original)
  })

  it('密码错误：第一个 ENC1 格即失败，整体中止', async () => {
    const src = path.join(dir, 'wrongpw.csv')
    fs.writeFileSync(src, UTF8_CSV, 'utf8')
    const enc = path.join(dir, 'wrongpw-enc.csv')
    await processCsv(src, 'encrypt', { headerRow: 1, cols: [2] }, enc, ctx, () => {})
    const wrong = initCrypto('other-password', generateSalt())
    await expect(
      processCsv(enc, 'decrypt', undefined, path.join(dir, 'wrongpw-dec.csv'), wrong, () => {}),
    ).rejects.toThrow('密码不符或文件被篡改')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run electron/main/csv.test.ts`
Expected: FAIL（占位实现抛「CSV 支持尚未实现」）

- [ ] **Step 3: 实现 csv.ts（整体替换占位）**

```ts
import { once } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { finished } from 'node:stream/promises'
import iconv from 'iconv-lite'
import { format, parse } from 'fast-csv'
import {
  decryptPayload,
  encryptPayload,
  isEncrypted,
  type CryptoContext,
} from './crypto.js'
import {
  buildAnalysis,
  detectHeaderRow,
  HEADER_CANDIDATE_ROWS,
  SAMPLE_DATA_ROWS,
  YIELD_EVERY_ROWS,
} from './sheet.js'
import type {
  ProcessMode,
  ProcessSummary,
  RulesConfig,
  SheetAnalysis,
  SheetSelection,
} from '../shared/types.js'

/**
 * CSV 路径（天然单 sheet）：全程流式逐行，内存恒定。
 * - 读：检测 GBK（无 BOM 且 UTF-8 解码失败）→ iconv-lite 转 UTF-8
 * - 写：UTF-8 带 BOM + CRLF 行尾（Windows 版 Excel 直接双击不乱码）
 */

const MAX_READ_ROWS = HEADER_CANDIDATE_ROWS + SAMPLE_DATA_ROWS

export async function detectCsvEncoding(filePath: string): Promise<'utf8' | 'gbk'> {
  const handle = await fs.promises.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(65536)
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    const head = buf.subarray(0, bytesRead)
    if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return 'utf8'
    try {
      // stream: true 容忍块尾被截断的多字节序列；无效字节序列立即抛错
      new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true })
      return 'utf8'
    } catch {
      return 'gbk'
    }
  } finally {
    await handle.close()
  }
}

function openTextStream(filePath: string, encoding: 'utf8' | 'gbk'): NodeJS.ReadableStream {
  const raw = fs.createReadStream(filePath)
  return encoding === 'gbk' ? raw.pipe(iconv.decodeStream('gbk')) : raw
}

/** 流式读前 maxRows 行（行 = string[]，0-based 列） */
export async function readCsvHead(
  filePath: string,
  encoding: 'utf8' | 'gbk',
  maxRows: number,
): Promise<string[][]> {
  return new Promise((resolve, reject) => {
    const rows: string[][] = []
    const parser = openTextStream(filePath, encoding).pipe(parse({ headers: false }))
    parser.on('error', reject)
    parser.on('data', (row: unknown) => {
      rows.push((row as unknown[]).map(String))
      if (rows.length >= maxRows) {
        parser.removeAllListeners('data')
        parser.destroy()
        resolve(rows)
      }
    })
    parser.on('end', () => resolve(rows))
  })
}

function stripBom(row: string[]): void {
  if (row.length > 0) row[0] = row[0].replace(/^\uFEFF/, '')
}

export async function analyzeCsv(
  filePath: string,
  rules: RulesConfig,
  headerRowOverride?: number,
): Promise<SheetAnalysis[]> {
  const encoding = await detectCsvEncoding(filePath)
  const rows = await readCsvHead(filePath, encoding, MAX_READ_ROWS)
  if (rows.length > 0) stripBom(rows[0])
  const headerRow = headerRowOverride ?? detectHeaderRow(rows)
  return [buildAnalysis(path.basename(filePath), false, headerRow, rows, rules)]
}

export async function processCsv(
  filePath: string,
  mode: ProcessMode,
  selection: SheetSelection | undefined,
  outPath: string,
  ctx: CryptoContext,
  onProgress: (percent: number) => void,
): Promise<ProcessSummary> {
  const encoding = await detectCsvEncoding(filePath)
  const fileSize = Math.max(1, (await fs.promises.stat(filePath)).size)
  const raw = fs.createReadStream(filePath)
  const text = encoding === 'gbk' ? raw.pipe(iconv.decodeStream('gbk')) : raw
  const parser = text.pipe(parse({ headers: false }))
  const out = fs.createWriteStream(outPath)
  out.write('\uFEFF') // BOM
  const writer = format({ rowDelimiter: '\r\n' })
  writer.pipe(out)

  let processedCells = 0
  const failedCells: string[] = []
  let rowNo = 0
  let firstEncSeen = false
  const selectedCols = new Set(selection?.cols ?? [])

  const abort = (message: string): never => {
    parser.destroy()
    writer.end()
    out.destroy()
    throw new Error(message)
  }

  for await (const row of parser) {
    rowNo++
    const cells = (row as unknown[]).map(String)
    if (rowNo === 1) stripBom(cells)
    if (mode === 'encrypt' && selection && rowNo === selection.headerRow) {
      // 加密跳过表头行（与 xlsx 路径一致），照原样写出
    } else {
      for (let c = 0; c < cells.length; c++) {
        if (mode === 'encrypt') {
          if (!selectedCols.has(c + 1)) continue
          const value = cells[c]
          if (value === '' || isEncrypted(value)) continue // 空值/已加密跳过
          cells[c] = encryptPayload(ctx, ['s', value])
          processedCells++
        } else {
          if (!isEncrypted(cells[c])) continue
          const isFirst = !firstEncSeen
          firstEncSeen = true
          try {
            const payload = decryptPayload(ctx, cells[c])
            cells[c] = String(payload[1]) // CSV 一律还原为文本（xlsx 的 n/d 类型不在此出现）
            processedCells++
          } catch {
            if (isFirst) abort('密码不符或文件被篡改')
            failedCells.push(`行${rowNo}列${c + 1}`)
          }
        }
      }
    }
    if (!writer.write(cells)) await once(writer, 'drain')
    if (rowNo % YIELD_EVERY_ROWS === 0) {
      onProgress(Math.min(99, Math.round((raw.bytesRead / fileSize) * 100)))
    }
  }
  writer.end()
  await finished(out)
  onProgress(100)
  return { processedCells, skippedFormulas: 0, failedCells, outPath }
}
```

注：BOM 一律用显式转义 `'\uFEFF'`（代码与测试中均已如此），不要依赖字面不可见字符。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run electron/main/csv.test.ts`
Expected: PASS

- [ ] **Step 5: 全量测试 + 类型检查 + Commit**

Run: `pnpm exec vitest run && pnpm exec tsc --noEmit -p tsconfig.node.json`
Expected: 全部通过

```bash
git add electron/main/csv.ts electron/main/csv.test.ts
git commit -m "feat: csv engine (fast-csv streaming, GBK detect, UTF-8 BOM + CRLF out)"
```

---

### Task 7: IPC 层（index.ts handlers + preload 修复）

**Files:**
- Modify: `electron/main/index.ts`（文件尾追加 IPC 段，头部 import 扩充）
- Modify: `electron/preload/index.ts:4-24`（`on()` 返回取消订阅函数）

**Interfaces:**
- Consumes: `config.ts`（Task 4）、`sheet.ts`（Task 5/6）、`rules.ts` 的 `BUILTIN_RULES`、`shared/types.ts`
- Produces（Task 8 渲染端依赖的 IPC 契约）:
  - `app:state` → `AppState`；`app:set-password(password)` → void（已设置则抛错）；`app:unlock(password)` → void（错误抛「密码错误」）；`app:change-password(old, next)` → void（旧密码错抛「原密码错误」）
  - `rules:get` → `{ config: RulesConfig, builtins: BuiltinRule[] }`；`rules:save(config)` → void（无效正则抛错）
  - `file:analyze` → `AnalyzeResult | null`（内嵌 showOpenDialog；取消返回 null）
  - `file:reanalyze(filePath, headerRowOverrides: Record<string, number>)` → `AnalyzeResult`
  - `file:process({ filePath, mode, selections })` → `ProcessSummary | null`（内嵌 showSaveDialog，默认名 `原名.已脱敏.扩展名` / `原名.已还原.扩展名`；取消返回 null）
  - 进度：`event.sender.send('file:progress', percent)`
  - preload：`window.ipcRenderer.on(channel, listener)` 返回 `() => void` 取消订阅函数

- [ ] **Step 1: 修改 preload 的 on()**

`electron/preload/index.ts` 的 `exposeInMainWorld` 段中，把 `on(...)` 改为返回取消订阅函数（原实现 off 无法移除包装监听，组件卸载会泄漏）：

```ts
contextBridge.exposeInMainWorld('ipcRenderer', {
  on(...args: Parameters<typeof ipcRenderer.on>) {
    const [channel, listener] = args
    const subscription = (event: Electron.IpcRendererEvent, ...rest: unknown[]) =>
      listener(event, ...rest)
    ipcRenderer.on(channel, subscription)
    return () => ipcRenderer.off(channel, subscription)
  },
  // off/send/invoke 保持不变
```

（`off`/`send`/`invoke` 维持原样；文件其余部分不动。）

- [ ] **Step 2: index.ts 头部 import 扩充**

把 `electron/main/index.ts` 第 1 行替换为：

```ts
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
```

并追加：

```ts
import {
  changePassword,
  getAppState,
  getCryptoContext,
  getRulesConfig,
  saveRulesConfig,
  setupPassword,
  unlockWithPassword,
} from './config.js'
import { analyzeFile, kindFromPath, processFile } from './sheet.js'
import { BUILTIN_RULES } from './rules.js'
import type { ProcessMode, ProcessSelections, RulesConfig } from '../shared/types.js'
```

- [ ] **Step 3: index.ts 尾部追加 IPC handlers**

把文件尾注释 `// IPC handlers 见 Task 7。` 替换为：

```ts
// --------- 报表脱敏工具 IPC（主进程唯一文件/加密入口） ---------
ipcMain.handle('app:state', () => getAppState())

ipcMain.handle('app:set-password', (_event, password: unknown) => {
  if (getAppState() !== 'setup') throw new Error('已设置过密码，请使用修改密码')
  setupPassword(String(password))
})

ipcMain.handle('app:unlock', (_event, password: unknown) => {
  if (!unlockWithPassword(String(password))) throw new Error('密码错误')
})

ipcMain.handle('app:change-password', (_event, oldPassword: unknown, newPassword: unknown) => {
  if (!changePassword(String(oldPassword), String(newPassword))) throw new Error('原密码错误')
})

ipcMain.handle('rules:get', () => ({ config: getRulesConfig(), builtins: BUILTIN_RULES }))

ipcMain.handle('rules:save', (_event, config: unknown) => {
  saveRulesConfig(config as RulesConfig)
})

ipcMain.handle('file:analyze', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showOpenDialog(win!, {
    properties: ['openFile'],
    filters: [{ name: '表格文件', extensions: ['xlsx', 'csv'] }],
  })
  if (result.canceled || !result.filePaths[0]) return null
  return analyzeFile(result.filePaths[0], getRulesConfig())
})

ipcMain.handle(
  'file:reanalyze',
  (_event, filePath: string, headerRowOverrides: Record<string, number>) =>
    analyzeFile(filePath, getRulesConfig(), headerRowOverrides),
)

ipcMain.handle(
  'file:process',
  async (
    event,
    req: { filePath: string; mode: ProcessMode; selections: ProcessSelections },
  ) => {
    const ctx = getCryptoContext() // 未解锁先抛错，不弹保存框
    const kind = kindFromPath(req.filePath)
    const ext = kind === 'xlsx' ? '.xlsx' : '.csv'
    const base = path.basename(req.filePath, ext)
    const suffix = req.mode === 'encrypt' ? '已脱敏' : '已还原'
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showSaveDialog(win!, {
      defaultPath: path.join(path.dirname(req.filePath), `${base}.${suffix}${ext}`),
    })
    if (result.canceled || !result.filePath) return null
    return processFile(req.filePath, req.mode, req.selections, result.filePath, ctx, (percent) =>
      event.sender.send('file:progress', percent),
    )
  },
)
```

- [ ] **Step 4: 类型检查 + 构建**

Run: `pnpm exec tsc --noEmit -p tsconfig.node.json && pnpm exec vite build`
Expected: 通过；`dist-electron/main/index.js` 与 `dist-electron/preload/index.mjs` 生成

- [ ] **Step 5: Commit**

```bash
git add electron/main/index.ts electron/preload/index.ts
git commit -m "feat: IPC handlers for password/rules/file flow"
```

---

### Task 8: 渲染进程 UI（三视图，daisyUI）

**Files:**
- Modify: `src/App.vue`（整体重写：视图切换 + 全局错误）
- Create: `src/components/PasswordGate.vue`、`src/components/MainFlow.vue`、`src/components/SettingsView.vue`

**Interfaces:**
- Consumes: Task 7 IPC 契约；`import type {...} from '../../electron/shared/types'`（纯类型，vite 构建时擦除）
- Produces: 无（叶子任务）

- [ ] **Step 1: 重写 src/App.vue**

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import PasswordGate from './components/PasswordGate.vue'
import MainFlow from './components/MainFlow.vue'
import SettingsView from './components/SettingsView.vue'

type View = 'loading' | 'gate-setup' | 'gate-unlock' | 'main' | 'settings'
const view = ref<View>('loading')
const errorMsg = ref('')

onMounted(async () => {
  try {
    const state = (await window.ipcRenderer.invoke('app:state')) as string
    view.value = state === 'setup' ? 'gate-setup' : state === 'unlocked' ? 'main' : 'gate-unlock'
  } catch (err) {
    errorMsg.value = `初始化失败：${(err as Error).message}`
  }
})
</script>

<template>
  <div class="min-h-screen bg-base-200 p-6">
    <div class="mx-auto max-w-4xl">
      <div class="mb-4 flex items-center justify-between">
        <h1 class="text-xl font-bold">报表脱敏工具</h1>
        <div v-if="view === 'main' || view === 'settings'" class="join">
          <button
            class="btn btn-sm join-item"
            :class="{ 'btn-active': view === 'main' }"
            @click="view = 'main'"
          >
            脱敏
          </button>
          <button
            class="btn btn-sm join-item"
            :class="{ 'btn-active': view === 'settings' }"
            @click="view = 'settings'"
          >
            设置
          </button>
        </div>
      </div>
      <div v-if="errorMsg" class="alert alert-error mb-4">{{ errorMsg }}</div>
      <PasswordGate v-if="view === 'gate-setup'" mode="setup" @ready="view = 'main'" />
      <PasswordGate v-else-if="view === 'gate-unlock'" mode="unlock" @ready="view = 'main'" />
      <MainFlow v-else-if="view === 'main'" />
      <SettingsView v-else-if="view === 'settings'" />
      <div v-else class="flex justify-center p-12">
        <span class="loading loading-spinner loading-lg" />
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 2: 创建 PasswordGate.vue（首次设置 / 回退解锁）**

```vue
<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{ mode: 'setup' | 'unlock' }>()
const emit = defineEmits<{ ready: [] }>()

const password = ref('')
const confirmPassword = ref('')
const errorMsg = ref('')
const busy = ref(false)

async function submit() {
  errorMsg.value = ''
  if (!password.value) {
    errorMsg.value = '请输入密码'
    return
  }
  if (props.mode === 'setup' && password.value !== confirmPassword.value) {
    errorMsg.value = '两次输入的密码不一致'
    return
  }
  busy.value = true
  try {
    if (props.mode === 'setup') {
      await window.ipcRenderer.invoke('app:set-password', password.value)
    } else {
      await window.ipcRenderer.invoke('app:unlock', password.value)
    }
    emit('ready')
  } catch (err) {
    errorMsg.value = (err as Error).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="card mx-auto max-w-sm bg-base-100 shadow-xl">
    <div class="card-body">
      <h2 class="card-title">{{ mode === 'setup' ? '首次使用：设置主密码' : '解锁' }}</h2>
      <p v-if="mode === 'setup'" class="text-sm opacity-70">
        该密码用于所有报表的脱敏与还原，请务必牢记。密码经系统安全存储（Windows DPAPI）保存，不明文落盘。
      </p>
      <p v-else class="text-sm opacity-70">
        无法从系统安全存储取回密码（可能更换了机器或系统用户），请重新输入主密码。
      </p>
      <input
        v-model="password"
        type="password"
        class="input input-bordered w-full"
        placeholder="密码"
        @keyup.enter="submit"
      >
      <input
        v-if="mode === 'setup'"
        v-model="confirmPassword"
        type="password"
        class="input input-bordered w-full"
        placeholder="确认密码"
        @keyup.enter="submit"
      >
      <div v-if="errorMsg" class="alert alert-error text-sm">{{ errorMsg }}</div>
      <button class="btn btn-primary" :disabled="busy" @click="submit">
        <span v-if="busy" class="loading loading-spinner loading-xs" />
        {{ mode === 'setup' ? '设置并进入' : '解锁' }}
      </button>
    </div>
  </div>
</template>
```

- [ ] **Step 3: 创建 MainFlow.vue（选文件 → 勾选 → 脱敏/还原 → 进度 → 摘要）**

```vue
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type {
  AnalyzeResult,
  ProcessMode,
  ProcessSelections,
  ProcessSummary,
  SheetAnalysis,
} from '../../electron/shared/types'

const analysis = ref<AnalyzeResult | null>(null)
/** sheet 名 → { headerRow, cols }（checkbox group 绑定 cols） */
const selections = ref<ProcessSelections>({})
const busy = ref(false)
const progress = ref<number | null>(null)
const summary = ref<ProcessSummary | null>(null)
const errorMsg = ref('')

const HEADER_ROW_OPTIONS = [1, 2, 3, 4, 5]

function autoSelections(sheets: SheetAnalysis[]): ProcessSelections {
  const map: ProcessSelections = {}
  for (const s of sheets) {
    map[s.name] = {
      headerRow: s.headerRow,
      cols: s.headers.filter((h) => h.autoSelected).map((h) => h.colIndex),
    }
  }
  return map
}

async function pickFile() {
  errorMsg.value = ''
  summary.value = null
  busy.value = true
  try {
    const result = (await window.ipcRenderer.invoke('file:analyze')) as AnalyzeResult | null
    if (!result) return
    analysis.value = result
    selections.value = autoSelections(result.sheets)
  } catch (err) {
    errorMsg.value = (err as Error).message
  } finally {
    busy.value = false
  }
}

/** 表头行下拉改选 → 重跑规则；仅重置该 sheet 的勾选，其他 sheet 保留用户手动调整 */
async function changeHeaderRow(sheetName: string, row: number) {
  if (!analysis.value) return
  const overrides: Record<string, number> = {}
  for (const s of analysis.value.sheets) overrides[s.name] = s.headerRow
  overrides[sheetName] = row
  busy.value = true
  errorMsg.value = ''
  try {
    const result = (await window.ipcRenderer.invoke(
      'file:reanalyze',
      analysis.value.filePath,
      overrides,
    )) as AnalyzeResult
    const prev = selections.value
    analysis.value = result
    const map: ProcessSelections = {}
    for (const s of result.sheets) {
      map[s.name] =
        s.name === sheetName
          ? {
              headerRow: s.headerRow,
              cols: s.headers.filter((h) => h.autoSelected).map((h) => h.colIndex),
            }
          : (prev[s.name] ?? { headerRow: s.headerRow, cols: [] })
    }
    selections.value = map
  } catch (err) {
    errorMsg.value = (err as Error).message
  } finally {
    busy.value = false
  }
}

function selectedCount(sheetName: string): number {
  return selections.value[sheetName]?.cols.length ?? 0
}

async function run(mode: ProcessMode) {
  if (!analysis.value) return
  busy.value = true
  progress.value = 0
  summary.value = null
  errorMsg.value = ''
  try {
    const result = (await window.ipcRenderer.invoke('file:process', {
      filePath: analysis.value.filePath,
      mode,
      selections: selections.value,
    })) as ProcessSummary | null
    if (result) summary.value = result // null = 用户取消了保存对话框
  } catch (err) {
    errorMsg.value = (err as Error).message
  } finally {
    busy.value = false
    progress.value = null
  }
}

let offProgress: (() => void) | null = null
onMounted(() => {
  offProgress = window.ipcRenderer.on('file:progress', (_event, percent) => {
    progress.value = percent as number
  }) as unknown as () => void
})
onBeforeUnmount(() => offProgress?.())
</script>

<template>
  <div class="space-y-4">
    <div class="card bg-base-100 shadow">
      <div class="card-body flex-row items-center gap-3">
        <button class="btn btn-primary" :disabled="busy" @click="pickFile">
          <span v-if="busy" class="loading loading-spinner loading-xs" />
          选择文件（.xlsx / .csv）
        </button>
        <span v-if="analysis" class="truncate text-sm opacity-70">{{ analysis.filePath }}</span>
      </div>
    </div>

    <div v-if="errorMsg" class="alert alert-error">{{ errorMsg }}</div>

    <template v-if="analysis">
      <div
        v-for="sheet in analysis.sheets"
        :key="sheet.name"
        class="collapse collapse-arrow bg-base-100 shadow"
      >
        <input type="checkbox" checked>
        <div class="collapse-title flex items-center gap-2 font-medium">
          {{ sheet.name }}
          <span v-if="sheet.hidden" class="badge badge-warning badge-sm">隐藏 sheet</span>
          <span class="badge badge-ghost badge-sm">
            已选 {{ selectedCount(sheet.name) }}/{{ sheet.headers.length }} 列
          </span>
        </div>
        <div class="collapse-content">
          <label class="mb-2 flex items-center gap-2 text-sm">
            表头行
            <select
              class="select select-bordered select-sm"
              :value="sheet.headerRow"
              :disabled="busy"
              @change="changeHeaderRow(sheet.name, Number(($event.target as HTMLSelectElement).value))"
            >
              <option v-for="r in HEADER_ROW_OPTIONS" :key="r" :value="r">第 {{ r }} 行</option>
            </select>
            <span class="opacity-60">（自动探测，可修正；改选后重跑规则）</span>
          </label>
          <table class="table table-zebra table-sm">
            <thead>
              <tr><th>脱敏</th><th>列</th><th>命中规则</th></tr>
            </thead>
            <tbody>
              <tr v-for="h in sheet.headers" :key="h.colIndex">
                <td>
                  <input
                    v-model="selections[sheet.name].cols"
                    type="checkbox"
                    class="checkbox checkbox-sm"
                    :value="h.colIndex"
                  >
                </td>
                <td>{{ h.name }}</td>
                <td>
                  <span
                    v-for="rule in h.matchedRules"
                    :key="rule"
                    class="badge badge-info badge-sm mr-1"
                  >{{ rule }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="flex items-center gap-3">
        <button class="btn btn-warning" :disabled="busy" @click="run('encrypt')">脱敏</button>
        <button class="btn btn-success" :disabled="busy" @click="run('decrypt')">还原</button>
        <template v-if="progress !== null">
          <progress class="progress progress-primary w-64" :value="progress" max="100" />
          <span class="text-sm">{{ progress }}%</span>
        </template>
      </div>

      <div v-if="summary" class="alert alert-success flex-col items-start">
        <div>
          完成：处理 {{ summary.processedCells }} 个单元格，跳过
          {{ summary.skippedFormulas }} 个公式单元格
        </div>
        <div class="text-sm">输出：{{ summary.outPath }}</div>
        <div v-if="summary.failedCells.length" class="text-sm">
          {{ summary.failedCells.length }} 个单元格还原失败（文件在加密后可能被编辑/损坏）：
          {{ summary.failedCells.join('、') }}
        </div>
      </div>
    </template>
  </div>
</template>
```

- [ ] **Step 4: 创建 SettingsView.vue（规则启停/自定义/修改密码）**

```vue
<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import type { BuiltinRule, RulesConfig } from '../../electron/shared/types'

const builtins = ref<BuiltinRule[]>([])
const enabled = reactive<Record<string, boolean>>({})
const customKeywords = ref<string[]>([])
const customPatterns = ref<string[]>([])
const newKeyword = ref('')
const newPattern = ref('')
const oldPassword = ref('')
const newPassword = ref('')
const newPassword2 = ref('')
const loaded = ref(false)
const errorMsg = ref('')
const okMsg = ref('')

onMounted(async () => {
  try {
    const result = (await window.ipcRenderer.invoke('rules:get')) as {
      config: RulesConfig
      builtins: BuiltinRule[]
    }
    builtins.value = result.builtins
    for (const b of result.builtins) enabled[b.id] = !result.config.disabledBuiltins.includes(b.id)
    customKeywords.value = [...result.config.customKeywords]
    customPatterns.value = [...result.config.customPatterns]
    loaded.value = true
  } catch (err) {
    errorMsg.value = (err as Error).message
  }
})

function addKeyword() {
  const v = newKeyword.value.trim()
  if (v && !customKeywords.value.includes(v)) customKeywords.value.push(v)
  newKeyword.value = ''
}

function addPattern() {
  const v = newPattern.value.trim()
  if (!v) return
  try {
    new RegExp(v)
  } catch {
    errorMsg.value = `无效正则：${v}`
    return
  }
  if (!customPatterns.value.includes(v)) customPatterns.value.push(v)
  newPattern.value = ''
}

async function saveRules() {
  errorMsg.value = ''
  okMsg.value = ''
  try {
    const config: RulesConfig = {
      disabledBuiltins: builtins.value.filter((b) => !enabled[b.id]).map((b) => b.id),
      customKeywords: customKeywords.value,
      customPatterns: customPatterns.value,
    }
    await window.ipcRenderer.invoke('rules:save', config)
    okMsg.value = '规则已保存'
  } catch (err) {
    errorMsg.value = (err as Error).message
  }
}

async function submitChangePassword() {
  errorMsg.value = ''
  okMsg.value = ''
  if (!oldPassword.value || !newPassword.value) {
    errorMsg.value = '请输入原密码和新密码'
    return
  }
  if (newPassword.value !== newPassword2.value) {
    errorMsg.value = '两次输入的新密码不一致'
    return
  }
  try {
    await window.ipcRenderer.invoke('app:change-password', oldPassword.value, newPassword.value)
    oldPassword.value = ''
    newPassword.value = ''
    newPassword2.value = ''
    okMsg.value = '密码已修改'
  } catch (err) {
    errorMsg.value = (err as Error).message
  }
}
</script>

<template>
  <div v-if="loaded" class="space-y-4">
    <div v-if="errorMsg" class="alert alert-error">{{ errorMsg }}</div>
    <div v-if="okMsg" class="alert alert-success">{{ okMsg }}</div>

    <div class="card bg-base-100 shadow">
      <div class="card-body">
        <h2 class="card-title">内置规则</h2>
        <div class="grid grid-cols-2 gap-1">
          <label v-for="b in builtins" :key="b.id" class="flex items-center gap-2 text-sm">
            <input v-model="enabled[b.id]" type="checkbox" class="checkbox checkbox-sm">
            {{ b.label }}
          </label>
        </div>
      </div>
    </div>

    <div class="card bg-base-100 shadow">
      <div class="card-body">
        <h2 class="card-title">自定义规则</h2>
        <div class="join w-full">
          <input
            v-model="newKeyword"
            class="input input-bordered input-sm join-item w-full"
            placeholder="自定义表头关键词（如：工号）"
            @keyup.enter="addKeyword"
          >
          <button class="btn btn-sm join-item" @click="addKeyword">加关键词</button>
        </div>
        <div class="join w-full">
          <input
            v-model="newPattern"
            class="input input-bordered input-sm join-item w-full font-mono"
            placeholder="自定义内容正则（如：^ORD-\d+$）"
            @keyup.enter="addPattern"
          >
          <button class="btn btn-sm join-item" @click="addPattern">加正则</button>
        </div>
        <div class="flex flex-wrap gap-1">
          <span v-for="(kw, i) in customKeywords" :key="'kw' + i" class="badge badge-outline gap-1">
            关键词：{{ kw }}
            <button class="text-error" @click="customKeywords.splice(i, 1)">✕</button>
          </span>
          <span v-for="(p, i) in customPatterns" :key="'re' + i" class="badge badge-outline gap-1 font-mono">
            正则：{{ p }}
            <button class="text-error" @click="customPatterns.splice(i, 1)">✕</button>
          </span>
        </div>
        <button class="btn btn-primary btn-sm self-end" @click="saveRules">保存规则</button>
      </div>
    </div>

    <div class="card bg-base-100 shadow">
      <div class="card-body">
        <h2 class="card-title">修改密码</h2>
        <div class="alert alert-warning text-sm">
          注意：修改密码后，此前用旧密码脱敏的所有文件将无法再还原。请先还原所有文件，再修改密码。
        </div>
        <input v-model="oldPassword" type="password" class="input input-bordered input-sm w-full" placeholder="原密码">
        <input v-model="newPassword" type="password" class="input input-bordered input-sm w-full" placeholder="新密码">
        <input v-model="newPassword2" type="password" class="input input-bordered input-sm w-full" placeholder="确认新密码">
        <button class="btn btn-warning btn-sm self-end" @click="submitChangePassword">修改密码</button>
      </div>
    </div>
  </div>
  <div v-else class="flex justify-center p-12">
    <span class="loading loading-spinner loading-lg" />
  </div>
</template>
```

- [ ] **Step 5: 类型检查 + 构建**

Run: `pnpm exec vue-tsc --noEmit && pnpm exec vite build`
Expected: 通过

- [ ] **Step 6: Commit**

```bash
git add src/App.vue src/components/PasswordGate.vue src/components/MainFlow.vue src/components/SettingsView.vue
git commit -m "feat: masking tool UI (password gate, main flow, settings)"
```

---

### Task 9: 全量验证 + README

**Files:**
- Modify: `README.md`（整体重写）
- Modify: `package.json`（name/productName 描述更新）

**Interfaces:**
- Consumes: 全部前序任务
- Produces: 无

- [ ] **Step 1: 全量验证**

Run: `pnpm exec vitest run && pnpm exec vue-tsc --noEmit && pnpm exec tsc --noEmit -p tsconfig.node.json && pnpm exec vite build`
Expected: 全部通过

- [ ] **Step 2: 冒烟启动（有 xvfb 则做，没有则跳过并在提交信息中注明）**

```bash
command -v xvfb-run && (xvfb-run -a pnpm exec vite & sleep 12 && pkill -f "vite" || true) || echo "no xvfb, skip smoke"
```

Expected: 有 xvfb 时 Electron 窗口进程启动无致命报错（主进程不崩溃）；无 xvfb 输出 "no xvfb, skip smoke"。

- [ ] **Step 3: package.json 元信息**

`"name"` 改为 `"sheet-masking"`，`"description"` 改为 `"财务报表可逆脱敏桌面工具（xlsx/csv，确定性 AES-256-GCM）"`。

- [ ] **Step 4: 重写 README.md**

整体替换为：

````markdown
# sheet-masking（报表脱敏工具）

对财务/公司数据报表（.xlsx / .csv）做**可逆脱敏**的桌面工具：加密敏感列，
事后可用同一主密码完整还原。基于 electron-vite-vue（Electron 42 + Vue 3 +
Vite 8 + Tailwind v4/daisyUI）。

## 用法

1. 首次启动设置主密码（经系统安全存储保存，Windows 为 DPAPI，不明文落盘；
   换机/换系统用户后需重新输入）
2. 选择 .xlsx / .csv 文件 → 按 sheet 展示表头勾选表（内置规则自动勾选敏感列，
   可手动调整；表头行自动探测，可下拉修正后重跑规则；隐藏 sheet 照常列出）
3. 「脱敏」生成 `原名.已脱敏.扩展名`；「还原」对任何含 ENC1 密文的文件全文
   扫描还原（与列位置无关，增删列/调列序/另存均可还原）
4. 设置页：启停内置规则、增删自定义关键词/正则、修改密码（**修改后旧密码
   脱敏的文件无法再还原，请先还原全部文件**）

## 加密格式

- 主密钥：`scrypt(password, salt)`，HKDF-SHA256 分出加密钥与 IV 钥
- 单元格：值序列化为带类型 JSON（`["s",文本]` / `["n",数字]` / `["d",ISO日期]`），
  `iv = HMAC-SHA256(sivKey, payload)[0:12]`，AES-256-GCM 加密，写回
  `'ENC1:' + base64(iv ‖ 密文 ‖ tag)`
- **确定性加密**：同一明文在任何文件、任何时间密文完全相同（订单等数据可
  跨表关联）；代价是密文暴露值相等性与频率
- 空值、公式单元格、已有 ENC1 前缀的值跳过；还原时第一个 ENC1 格校验失败
  即判为密码错误（"密码不符或文件被篡改"），个别格失败则记录地址继续
- CSV：输入自动检测 GBK 并转码；输出一律 UTF-8 带 BOM + CRLF（Windows 版
  Excel 双击不乱码）

## 已知限制

- ExcelJS 往返保真边界：样式/公式/合并单元格/列宽保留；**图表、图片、数据
  透视表会丢失**
- 极端大文件（50 万行以上）可能超出内存：主进程堆已提额至 12GB，仍失败时
  请拆分文件

## 开发

```sh
pnpm install
pnpm run dev       # 开发
pnpm test          # vitest 单测（crypto/rules/sheet/csv）
pnpm run build     # 类型检查 + 构建 + electron-builder 打包
```

Tailwind CSS v4 + daisyUI 经 `@tailwindcss/vite` 与 `@plugin "daisyui"` 接入
（见 `src/style.css`）。Windows NSIS 安装包需在 Windows 机器或 CI 构建
（Linux 交叉构建 rcedit 需 wine）。
````

- [ ] **Step 5: Commit**

```bash
git add README.md package.json pnpm-lock.yaml
git commit -m "docs: rewrite README for the sheet masking tool"
```

---

## Self-Review 记录（计划落盘前已完成）

- spec 覆盖：①crypto→Task 2；②config→Task 4（含 verifier 偏差说明）；③rules→Task 3；④sheet→Task 5（xlsx）+Task 6（csv）；⑤IPC/UI→Task 7/8；⑥清理→Task 1；⑦Windows→Global Constraints + Task 6（BOM/CRLF）+ README；错误处理→Task 5/6/7/8；验证→各任务 + Task 9
- 已知 spec 偏差（均已在对应任务注明）：config.json 增加 `verifier` 字段（回退解锁必需）；加密跳过表头行（selections 携带 headerRow，否则已脱敏文件重跑 analyze 时列名不可读）；`skippedFormulas` 只计公式格，富文本/超链接等跳过格不计数
- 类型一致性：CellPayload/CryptoContext（Task 2）→config（Task 4）→sheet/csv（Task 5/6）→index.ts（Task 7）签名逐级对齐；SheetAnalysis/SheetSelection/ProcessSummary/RulesConfig 以 Task 1 的 shared/types.ts 为唯一来源
