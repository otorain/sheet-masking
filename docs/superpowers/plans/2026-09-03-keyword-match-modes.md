# 四类关键词匹配重构实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把设置页的「预设规则（可开关）+ 自定义关键词/正则（需保存）」重构为四类匹配关键词（完全匹配/包含/开头/结尾）+ 无预设自定义正则，全部增删即生效。

**Architecture:** 匹配引擎 `electron/main/rules.ts` 删除 `BUILTIN_RULES`，改为读 `RulesConfig` 的四个关键词数组 + 正则数组；旧格式配置不迁移、读取时直接重置为默认；设置弹窗重写为四小节卡片，每次增删直接 `rules:save` 并触发重新分析。

**Tech Stack:** Electron 42（主进程 node）、Vue 3 `<script setup>`、vitest（node 环境）、daisyUI。

Spec: `docs/superpowers/specs/2026-09-03-keyword-match-modes-design.md`

## Global Constraints

- `electron/` 内相对 import **必须带 `.js` 后缀**；渲染进程引共享类型用
  `import type ... from '../../electron/shared/types'`（无后缀）
- 界面与文档文案为中文；提交信息为英文 conventional commits
- `config.ts` / `index.ts` 依赖 electron，**不进 vitest**，只过类型检查
- 渲染进程向 IPC 传参前必须过 `src/lib/serialize.ts` 的 `deepUnwrap()`
- 每个 task 结束跑 `pnpm exec vitest run` 保持全绿再提交
- 匹配大小写敏感；表头 trim 后比较；关键词 trim、空串忽略、类内去重、允许跨类重复

---

### Task 1: 共享类型与匹配引擎重构

**Files:**
- Modify: `electron/shared/types.ts:47-60`
- Modify: `electron/main/rules.ts`（整体重写）
- Test: `electron/main/rules.test.ts`（整体重写）
- Modify: `electron/main/sheet.test.ts:90-91,97`（标签断言）
- Modify: `src/lib/serialize.test.ts:17-19`（示例字段名）

**Interfaces:**
- Produces:
  - `RulesConfig = { exact: string[]; contains: string[]; startsWith: string[]; endsWith: string[]; patterns: string[] }`（types.ts）
  - `DEFAULT_EXACT_KEYWORDS: string[]`（24 个默认词，rules.ts）
  - `defaultRulesConfig(): RulesConfig`（exact 为默认词副本，其余空数组）
  - `matchColumns(headers: string[], sampleRows: string[][], config: RulesConfig): ColumnMatch[]`（签名不变）
  - `matchedRules` 标签格式：`完全匹配：X` / `包含：X` / `开头：X` / `结尾：X` / `正则：X`
- Consumes: 无（本 task 是后续 task 的基础）
- 删除：`BuiltinRule` 接口、`BUILTIN_RULES` 常量、`disabledBuiltins` 字段

- [ ] **Step 1: 重写 `electron/main/rules.test.ts` 为失败测试**

整体替换为：

```ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_EXACT_KEYWORDS, defaultRulesConfig, matchColumns } from './rules.js'

const emptyRows: string[][] = []

describe('defaultRulesConfig', () => {
  it('exact 预填 24 个默认词，其余为空', () => {
    const config = defaultRulesConfig()
    expect(config.exact).toHaveLength(24)
    expect(config.exact).toContain('姓名')
    expect(config.exact).toContain('银行卡号')
    expect(config.contains).toEqual([])
    expect(config.startsWith).toEqual([])
    expect(config.endsWith).toEqual([])
    expect(config.patterns).toEqual([])
    expect(DEFAULT_EXACT_KEYWORDS).toHaveLength(24)
  })
})

describe('matchColumns 四类关键词', () => {
  it('完全匹配：表头恰好等于关键词才命中', () => {
    const result = matchColumns(['姓名', '姓名全称'], emptyRows, {
      ...defaultRulesConfig(),
      exact: ['姓名'],
    })
    expect(result[0].matchedRules).toEqual(['完全匹配：姓名'])
    expect(result[1].autoSelected).toBe(false)
  })

  it('包含：表头包含关键词即命中', () => {
    const result = matchColumns(['银行卡号', '金额'], emptyRows, {
      ...defaultRulesConfig(),
      exact: [],
      contains: ['卡号'],
    })
    expect(result[0].matchedRules).toEqual(['包含：卡号'])
    expect(result[1].autoSelected).toBe(false)
  })

  it('开头：表头以关键词开头才命中', () => {
    const result = matchColumns(['手机号', '号码'], emptyRows, {
      ...defaultRulesConfig(),
      exact: [],
      startsWith: ['手机'],
    })
    expect(result[0].matchedRules).toEqual(['开头：手机'])
    expect(result[1].autoSelected).toBe(false)
  })

  it('结尾：表头以关键词结尾才命中', () => {
    const result = matchColumns(['联系电话', '电话费'], emptyRows, {
      ...defaultRulesConfig(),
      exact: [],
      endsWith: ['电话'],
    })
    expect(result[0].matchedRules).toEqual(['结尾：电话'])
    expect(result[1].autoSelected).toBe(false)
  })

  it('表头首尾空白 trim 后参与匹配', () => {
    const result = matchColumns([' 姓名 '], emptyRows, defaultRulesConfig())
    expect(result[0].matchedRules).toContain('完全匹配：姓名')
  })

  it('空串与仅空白关键词被忽略', () => {
    const result = matchColumns(['a'], emptyRows, {
      ...defaultRulesConfig(),
      exact: ['', '   '],
      contains: [''],
    })
    expect(result[0].autoSelected).toBe(false)
  })

  it('同一关键词允许跨类存在，各自独立命中', () => {
    const result = matchColumns(['卡号'], emptyRows, {
      ...defaultRulesConfig(),
      exact: ['卡号'],
      contains: ['卡号'],
    })
    expect(result[0].matchedRules).toEqual(['完全匹配：卡号', '包含：卡号'])
  })
})

describe('matchColumns 内容正则', () => {
  it('自定义正则命中抽样内容', () => {
    const result = matchColumns(['单号'], [['ORD-123'], ['ORD-456']], {
      ...defaultRulesConfig(),
      exact: [],
      patterns: ['^ORD-\\d+$'],
    })
    expect(result[0].autoSelected).toBe(true)
    expect(result[0].matchedRules).toContain('正则：^ORD-\\d+$')
  })

  it('无效自定义正则被跳过且不中断', () => {
    const result = matchColumns(['单号'], [['ORD-123']], {
      ...defaultRulesConfig(),
      exact: [],
      patterns: ['(', '^ORD-\\d+$'],
    })
    expect(result[0].autoSelected).toBe(true)
  })

  it('无命中时 autoSelected=false 且 matchedRules 为空', () => {
    const result = matchColumns(['金额', '数量'], [['100', '3']], {
      ...defaultRulesConfig(),
      exact: [],
    })
    expect(result).toEqual([
      { autoSelected: false, matchedRules: [] },
      { autoSelected: false, matchedRules: [] },
    ])
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run electron/main/rules.test.ts`
Expected: FAIL（`DEFAULT_EXACT_KEYWORDS` 不存在 / 类型错误）

- [ ] **Step 3: 改 `electron/shared/types.ts`（第 47-60 行整体替换）**

```ts
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
```

同时**删除** `BuiltinRule` 接口（第 55-60 行）。

- [ ] **Step 4: 整体重写 `electron/main/rules.ts`**

```ts
import type { RulesConfig } from '../shared/types.js'

/**
 * 脱敏列识别规则：
 * - 四类表头关键词：完全匹配 / 包含 / 开头 / 结尾（表头 trim 后比较，大小写敏感）
 * - 自定义内容正则（对前 50 个数据行抽样；命中任一样本即整列选中）
 * 全部词条用户在设置页增删，增删即生效；无内置预设规则。
 */

export const DEFAULT_EXACT_KEYWORDS = [
  '姓名',
  '身份证',
  '身份证号',
  '身份证号码',
  '证件号',
  '证件号码',
  '统一社会信用代码',
  '手机号',
  '手机号码',
  '电话',
  '联系电话',
  '电话号码',
  '银行卡',
  '银行卡号',
  '卡号',
  '账号',
  '银行账号',
  '开户行',
  '开户银行',
  '税号',
  '邮箱',
  '电子邮箱',
  '地址',
  '联系地址',
]

export function defaultRulesConfig(): RulesConfig {
  return {
    exact: [...DEFAULT_EXACT_KEYWORDS],
    contains: [],
    startsWith: [],
    endsWith: [],
    patterns: [],
  }
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
  const matchers: { label: string; test: (header: string) => boolean }[] = []
  for (const kw of config.exact) {
    const needle = kw.trim()
    if (needle) matchers.push({ label: `完全匹配：${needle}`, test: (h) => h === needle })
  }
  for (const kw of config.contains) {
    const needle = kw.trim()
    if (needle) matchers.push({ label: `包含：${needle}`, test: (h) => h.includes(needle) })
  }
  for (const kw of config.startsWith) {
    const needle = kw.trim()
    if (needle) matchers.push({ label: `开头：${needle}`, test: (h) => h.startsWith(needle) })
  }
  for (const kw of config.endsWith) {
    const needle = kw.trim()
    if (needle) matchers.push({ label: `结尾：${needle}`, test: (h) => h.endsWith(needle) })
  }

  const patterns: { label: string; re: RegExp }[] = []
  for (const src of config.patterns) {
    try {
      patterns.push({ label: `正则：${src}`, re: new RegExp(src) })
    } catch {
      // 保存时已校验；此处防御性跳过无效正则，不中断整列分析
    }
  }

  return headers.map((rawHeader, col) => {
    const header = rawHeader.trim()
    const matchedRules: string[] = []
    for (const { label, test } of matchers) {
      if (test(header)) matchedRules.push(label)
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

- [ ] **Step 5: 运行 rules.test.ts 确认通过**

Run: `pnpm exec vitest run electron/main/rules.test.ts`
Expected: PASS（11 个用例）

- [ ] **Step 6: 更新 `electron/main/sheet.test.ts` 标签断言**

第 90-91 行：

```ts
    expect(byName['姓名'].matchedRules).toContain('完全匹配：姓名')
    expect(byName['手机号'].matchedRules).toContain('完全匹配：手机号')
```

第 97 行注释改为：

```ts
    expect(hiddenSheet.headers[0].autoSelected).toBe(true) // 卡号完全匹配关键词
```

（fixture 表头 `姓名`/`手机号`/`卡号` 均恰好等于默认词，完全匹配命中；其余断言不变）

- [ ] **Step 7: 更新 `src/lib/serialize.test.ts` 示例字段名（第 17-19 行）**

```ts
    const keywords = ref(['工号', '户名'])
    const plain = deepUnwrap({ exact: keywords.value })
    expect(plain).toEqual({ exact: ['工号', '户名'] })
```

- [ ] **Step 8: 全量测试 + 类型检查**

Run: `pnpm exec vitest run && pnpm exec vue-tsc --noEmit`
Expected: 测试全绿（csv.test.ts 无需改动：表头 `姓名`/`手机号` 恰好命中默认完全匹配词）；vue-tsc 此时只剩 SettingsDialog.vue / index.ts / config.ts 的报错（下一 task 处理）——若有报错属预期，仅确认 rules/sheet/csv/serialize 相关测试与类型无误。

- [ ] **Step 9: Commit**

```bash
git add electron/shared/types.ts electron/main/rules.ts electron/main/rules.test.ts electron/main/sheet.test.ts src/lib/serialize.test.ts
git commit -m "feat: replace builtin rules with four keyword match modes"
```

---

### Task 2: 配置持久化旧格式重置 + IPC 简化

**Files:**
- Modify: `electron/main/config.ts:152-167`
- Modify: `electron/main/index.ts:10-12,136`

**Interfaces:**
- Consumes: Task 1 的 `RulesConfig`、`defaultRulesConfig()`
- Produces:
  - `getRulesConfig(): RulesConfig` — 旧格式（无 `exact` 数组）直接返回默认配置
  - IPC `rules:get` 返回 `{ config: RulesConfig }`（不再有 `builtins` 字段）
  - IPC `rules:save` 行为不变（校验 `patterns` 可编译）

注：本 task 两个文件按项目约定不进 vitest，验证靠 `tsc -p tsconfig.node.json`。

- [ ] **Step 1: 改 `electron/main/config.ts` 的 `getRulesConfig`**

```ts
export function getRulesConfig(): RulesConfig {
  const rules = readStored()?.rules
  // 旧格式（disabledBuiltins/customKeywords 时代）无 exact 字段：不迁移，直接重置为默认
  if (!rules || !Array.isArray(rules.exact)) return defaultRulesConfig()
  return rules
}
```

`saveRulesConfig` 中 `config.customPatterns` 的校验循环改为 `config.patterns`：

```ts
export function saveRulesConfig(config: RulesConfig): void {
  const stored = readStored()
  if (!stored) throw new Error('请先设置主密码')
  for (const src of config.patterns) {
    try {
      new RegExp(src)
    } catch {
      throw new Error(`无效正则：${src}`)
    }
  }
  writeStored({ ...stored, rules: config })
}
```

- [ ] **Step 2: 改 `electron/main/index.ts`**

`rules:get` 处理器（第 136 行）改为：

```ts
ipcMain.handle('rules:get', () => ({ config: getRulesConfig() }))
```

从 `./rules.js` 的 import 中移除 `BUILTIN_RULES`（该常量已不存在，留着会编译错）。

- [ ] **Step 3: 类型检查（node 侧）**

Run: `pnpm exec tsc --noEmit -p tsconfig.node.json`
Expected: PASS（index.ts/config.ts 不再有对已删除符号的引用）

- [ ] **Step 4: 回归测试**

Run: `pnpm exec vitest run`
Expected: PASS（全部 6 个测试文件）

- [ ] **Step 5: Commit**

```bash
git add electron/main/config.ts electron/main/index.ts
git commit -m "feat: reset legacy rules config to defaults and simplify rules:get IPC"
```

---

### Task 3: SettingsDialog 界面重写（四小节 + 增删即生效）

**Files:**
- Modify: `src/components/SettingsDialog.vue`（规则区整体重写；密码卡片不动）

**Interfaces:**
- Consumes: IPC `rules:get` → `{ config: RulesConfig }`；IPC `rules:save` 接受 `RulesConfig`；`deepUnwrap`（serialize.ts）；`emit('saved')` → App.vue `reloadAnalysis()`
- Produces: 无新导出；`defineExpose({ open })` 与 emits `saved`/`reset` 不变（App.vue 无需改动）

行为要点（spec）：
- 无保存按钮；每次增删 → 本地校验（非空/类内去重/正则可编译）→ `deepUnwrap` →
  `rules:save` → 成功 `emit('saved')`；失败显示错误并重新 `rules:get` 同步 UI
- 「修改密码」卡片逻辑保持原样（仍用 `okMsg` 提示）

- [ ] **Step 1: 重写 `src/components/SettingsDialog.vue` 的 `<script setup>`**

保留密码相关函数，规则部分整体替换：

```ts
<script setup lang="ts">
import { ref } from 'vue'
import { deepUnwrap } from '../lib/serialize'
import ResetPassword from './ResetPassword.vue'
import type { RulesConfig } from '../../electron/shared/types'

const emit = defineEmits<{ saved: []; reset: [] }>()

type KeywordKind = 'exact' | 'contains' | 'startsWith' | 'endsWith'

const KEYWORD_SECTIONS: { kind: KeywordKind; title: string; placeholder: string }[] = [
  { kind: 'exact', title: '完全匹配', placeholder: '表头恰好等于该词才命中（如：工号）' },
  { kind: 'contains', title: '包含', placeholder: '表头包含该词即命中（如：卡号）' },
  { kind: 'startsWith', title: '以关键词开头', placeholder: '表头以该词开头（如：手机）' },
  { kind: 'endsWith', title: '以关键词结尾', placeholder: '表头以该词结尾（如：电话）' },
]

const dialog = ref<HTMLDialogElement | null>(null)
const config = ref<RulesConfig>({ exact: [], contains: [], startsWith: [], endsWith: [], patterns: [] })
const newKeyword = ref<Record<KeywordKind, string>>({
  exact: '',
  contains: '',
  startsWith: '',
  endsWith: '',
})
const newPattern = ref('')
const oldPassword = ref('')
const newPassword = ref('')
const newPassword2 = ref('')
const loaded = ref(false)
const errorMsg = ref('')
const okMsg = ref('')

/** App 经 template ref 调用：打开弹窗并拉取最新规则（每次打开都拉，保证多次打开数据新鲜） */
async function open() {
  dialog.value?.showModal()
  loaded.value = false
  errorMsg.value = ''
  okMsg.value = ''
  try {
    const result = (await window.ipcRenderer.invoke('rules:get')) as { config: RulesConfig }
    config.value = result.config
    loaded.value = true
  } catch (err) {
    errorMsg.value = (err as Error).message
  }
}

defineExpose({ open })

/** 增删即生效：保存到主进程并通知 App 重新分析；失败则回拉主进程真实配置同步 UI */
async function applyRules() {
  errorMsg.value = ''
  try {
    await window.ipcRenderer.invoke('rules:save', deepUnwrap(config.value))
    emit('saved')
  } catch (err) {
    errorMsg.value = (err as Error).message
    const result = (await window.ipcRenderer.invoke('rules:get')) as { config: RulesConfig }
    config.value = result.config
  }
}

function addKeyword(kind: KeywordKind) {
  const v = newKeyword.value[kind].trim()
  if (!v) return
  if (!config.value[kind].includes(v)) {
    config.value[kind].push(v)
    applyRules()
  }
  newKeyword.value[kind] = ''
}

function removeKeyword(kind: KeywordKind, index: number) {
  config.value[kind].splice(index, 1)
  applyRules()
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
  if (!config.value.patterns.includes(v)) {
    config.value.patterns.push(v)
    applyRules()
  }
  newPattern.value = ''
}

function removePattern(index: number) {
  config.value.patterns.splice(index, 1)
  applyRules()
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

/** 确认重置密码：先关弹窗再通知 App 切回设置密码流程 */
function onReset() {
  dialog.value?.close()
  emit('reset')
}
</script>
```

- [ ] **Step 2: 重写模板中的规则区（两个「内置规则」「自定义规则」卡片整体替换）**

```html
        <div class="card bg-base-200">
          <div class="card-body">
            <h2 class="card-title">表头关键词</h2>
            <p class="text-xs opacity-60">增删立即生效，无需保存</p>
            <div v-for="section in KEYWORD_SECTIONS" :key="section.kind" class="space-y-1">
              <h3 class="text-sm font-semibold">{{ section.title }}</h3>
              <div class="join w-full">
                <input
                  v-model="newKeyword[section.kind]"
                  class="input input-bordered input-sm join-item w-full"
                  :placeholder="section.placeholder"
                  @keyup.enter="addKeyword(section.kind)"
                >
                <button class="btn btn-sm join-item" @click="addKeyword(section.kind)">添加</button>
              </div>
              <div class="flex flex-wrap gap-1">
                <span v-for="(kw, i) in config[section.kind]" :key="kw" class="badge badge-outline gap-1">
                  {{ kw }}
                  <button class="text-error" @click="removeKeyword(section.kind, i)">✕</button>
                </span>
              </div>
            </div>
          </div>
        </div>

        <div class="card bg-base-200">
          <div class="card-body">
            <h2 class="card-title">内容正则（高级）</h2>
            <p class="text-xs opacity-60">对每列前 50 行内容抽样匹配，命中即整列自动勾选</p>
            <div class="join w-full">
              <input
                v-model="newPattern"
                class="input input-bordered input-sm join-item w-full font-mono"
                placeholder="如：^ORD-\d+$"
                @keyup.enter="addPattern"
              >
              <button class="btn btn-sm join-item" @click="addPattern">添加</button>
            </div>
            <div class="flex flex-wrap gap-1">
              <span v-for="(p, i) in config.patterns" :key="p" class="badge badge-outline gap-1 font-mono">
                {{ p }}
                <button class="text-error" @click="removePattern(i)">✕</button>
              </div>
            </div>
          </div>
        </div>
```

（「修改密码」卡片与弹窗外壳保持原样；每个列表内关键词去重由 add 保证，故可用 `:key="kw"`）

- [ ] **Step 3: 类型检查 + 构建**

Run: `pnpm exec vue-tsc --noEmit && pnpm exec vite build`
Expected: PASS

- [ ] **Step 4: 回归测试**

Run: `pnpm exec vitest run`
Expected: PASS（UI 无组件测试，靠类型检查与构建验证；逻辑测试在 Task 1 已覆盖）

- [ ] **Step 5: Commit**

```bash
git add src/components/SettingsDialog.vue
git commit -m "feat: settings dialog with four keyword sections and auto-apply"
```

---

### Task 4: README 更新 + 全量验证

**Files:**
- Modify: `README.md:11-17`

**Interfaces:**
- Consumes: 全部前序 task
- Produces: 无代码接口

- [ ] **Step 1: 更新 `README.md` 用法第 2、4 条**

第 11-12 行「内置规则自动勾选敏感列」改为「关键词规则自动勾选敏感列」；第 15-17 行改为：

```
4. 设置弹窗：增删四类匹配关键词（完全匹配/包含/开头/结尾）与自定义内容正则，
   增删立即生效并自动按新规则重新分析已选文件（新命中列自动补勾，手动勾选保留）；
   修改密码（**修改后旧密码脱敏的文件无法再还原，请先还原全部文件**）
```

- [ ] **Step 2: 全量验证链**

Run: `pnpm exec vitest run && pnpm exec vue-tsc --noEmit && pnpm exec tsc --noEmit -p tsconfig.node.json && pnpm exec vite build`
Expected: 全部 PASS

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: update README for keyword match modes"
```
