# 设置弹窗化 + 规则保存后重载表格 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把设置页改成弹窗（MainFlow 保持挂载），保存规则后立即用新规则重新分析当前已选择的表格，新命中列自动补勾、手动勾选保留。

**Architecture:** 纯渲染端改动。新组件 `SettingsDialog.vue`（内容搬自 `SettingsView.vue`，外壳 daisyUI 原生 `<dialog>`）保存规则成功且有变化时 emit `saved`；`App.vue` 收到后经 template ref 调 `MainFlow.reloadAnalysis()`（`defineExpose` 暴露），后者复用现有 `file:reanalyze` IPC（主进程 handler 每次调用重读磁盘规则，主进程零改动）；勾选合并用新纯函数 `mergeSelections`（新勾选 = 旧勾选 ∪ (新自动命中 − 旧自动命中)）。

**Tech Stack:** Vue 3 `<script setup>`、daisyUI 5（原生 `<dialog class="modal">`）、vitest（node 环境）。

**Spec:** `docs/superpowers/specs/2026-09-02-settings-dialog-design.md`

## Global Constraints

- 包管理用 **pnpm**（不是 npm）；验证命令：`pnpm exec vitest run`、`pnpm exec vue-tsc --noEmit`、`pnpm exec tsc --noEmit -p tsconfig.node.json`、`pnpm exec vite build`
- 无 pinia / vue-router：`analysis`/`selections` 状态归 `MainFlow.vue` 本地持有，不引入 store
- 主进程、IPC、共享类型（`electron/shared/types.ts`）**零改动**（`file:reanalyze` 现成够用）
- 跨 IPC 传参必须先过 `src/lib/serialize.ts` 的 `deepUnwrap()`（reactive Proxy 无法被 contextBridge 克隆）
- 弹窗模式照抄 `src/components/ResetPassword.vue`：`ref<HTMLDialogElement>` + `showModal()`/`close()` + `<form method="dialog" class="modal-backdrop">` 点击遮罩关闭
- 渲染端组件不进 vitest（项目既定）；只有 `src/lib/` 纯函数写单测，测试文件与被测文件同目录
- 界面与文档文案中文；提交信息英文 conventional commits；直接在 main 分支提交

---

### Task 1: 勾选合并纯函数 `mergeSelections`（TDD）

**Files:**
- Create: `src/lib/selections.ts`
- Test: `src/lib/selections.test.ts`

**Interfaces:**
- Consumes: `AnalyzeResult`、`ProcessSelections`（`import type ... from '../../electron/shared/types'`）
- Produces: `mergeSelections(prev: AnalyzeResult, next: AnalyzeResult, prevSelections: ProcessSelections): ProcessSelections` —— Task 3 的 `MainFlow.reloadAnalysis()` 调用

- [ ] **Step 1: 写失败测试**

创建 `src/lib/selections.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { mergeSelections } from './selections'
import type {
  AnalyzeResult,
  SheetAnalysis,
  SheetHeaderInfo,
} from '../../electron/shared/types'

function headers(list: Array<[number, string, boolean]>): SheetHeaderInfo[] {
  return list.map(([colIndex, name, autoSelected]) => ({
    colIndex,
    name,
    autoSelected,
    matchedRules: [],
  }))
}

function sheet(
  name: string,
  list: Array<[number, string, boolean]>,
  headerRow = 1,
): SheetAnalysis {
  return { name, hidden: false, headerRow, headers: headers(list) }
}

function analysis(sheets: SheetAnalysis[]): AnalyzeResult {
  return { filePath: '/tmp/a.xlsx', kind: 'xlsx', sheets }
}

describe('mergeSelections', () => {
  it('保留手动勾选，新命中列自动补勾', () => {
    const prev = analysis([
      sheet('订单', [
        [1, '日期', false],
        [2, '姓名', true],
        [3, '金额', false],
        [4, '备注', false],
      ]),
    ])
    // 用户手动加勾了 1、4，保留了自动命中的 2
    const prevSel = { 订单: { headerRow: 1, cols: [1, 2, 4] } }
    const next = analysis([
      sheet('订单', [
        [1, '日期', false],
        [2, '姓名', true],
        [3, '金额', true],
        [4, '备注', false],
      ]),
    ])

    const merged = mergeSelections(prev, next, prevSel)
    expect(merged.订单.cols).toEqual([1, 2, 4, 3])
  })

  it('手动取消的旧命中列不被重新勾上（只补真正新命中的列）', () => {
    const prev = analysis([
      sheet('订单', [
        [2, '姓名', true],
        [3, '金额', false],
      ]),
    ])
    // 用户手动取消了自动命中的 2
    const prevSel = { 订单: { headerRow: 1, cols: [] } }
    const next = analysis([
      sheet('订单', [
        [2, '姓名', true],
        [3, '金额', true],
      ]),
    ])

    const merged = mergeSelections(prev, next, prevSel)
    expect(merged.订单.cols).toEqual([3])
  })

  it('新 sheet 按自动命中全选；消失的 sheet 被丢弃；headerRow 取新分析值', () => {
    const prev = analysis([sheet('旧', [[1, 'a', true]])])
    const prevSel = { 旧: { headerRow: 1, cols: [1] } }
    const next = analysis([
      sheet(
        '新',
        [
          [1, 'x', true],
          [2, 'y', false],
        ],
        2,
      ),
    ])

    const merged = mergeSelections(prev, next, prevSel)
    expect(merged.旧).toBeUndefined()
    expect(merged.新).toEqual({ headerRow: 2, cols: [1] })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run src/lib/selections.test.ts`
Expected: FAIL（`Failed to resolve import "./selections"` 或类似模块不存在错误）

- [ ] **Step 3: 写最小实现**

创建 `src/lib/selections.ts`：

```ts
import type { AnalyzeResult, ProcessSelections } from '../../electron/shared/types'

/**
 * 规则变化后重载表格的勾选合并：新勾选 = 旧勾选 ∪ (新自动命中 − 旧自动命中)。
 * 手动勾选全保留、手动取消的不被重新勾上、仅新增真正「新命中」的列。
 * 结果以新 analysis 的 sheet 列表为准；headerRow 取新 analysis 的值
 * （重载时以当前 headerRow 作 override 传入，因此即用户修正后的表头行）。
 */
export function mergeSelections(
  prev: AnalyzeResult,
  next: AnalyzeResult,
  prevSelections: ProcessSelections,
): ProcessSelections {
  const prevByName = new Map(prev.sheets.map((s) => [s.name, s]))
  const map: ProcessSelections = {}
  for (const s of next.sheets) {
    const prevAuto = new Set(
      prevByName
        .get(s.name)
        ?.headers.filter((h) => h.autoSelected)
        .map((h) => h.colIndex) ?? [],
    )
    const newlyAuto = s.headers
      .filter((h) => h.autoSelected && !prevAuto.has(h.colIndex))
      .map((h) => h.colIndex)
    const prevCols = prevSelections[s.name]?.cols ?? []
    map[s.name] = {
      headerRow: s.headerRow,
      cols: [...new Set([...prevCols, ...newlyAuto])],
    }
  }
  return map
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run src/lib/selections.test.ts`
Expected: PASS（3 例）

- [ ] **Step 5: Commit**

```bash
git add src/lib/selections.ts src/lib/selections.test.ts
git commit -m "feat: add mergeSelections helper for rule-change reload"
```

---

### Task 2: `SettingsDialog.vue` 弹窗组件

**Files:**
- Create: `src/components/SettingsDialog.vue`（内容搬自 `SettingsView.vue`，本任务先不删旧文件）

**Interfaces:**
- Consumes: `ResetPassword.vue`（emit `reset`）、IPC `rules:get`/`rules:save`/`app:change-password`
- Produces: 组件暴露 `open(): Promise<void>`（`defineExpose`，Task 4 的 `App.vue` 经 template ref 调用）；emit `saved`（规则保存成功且有变化，Task 4 监听）；emit `reset`（确认重置密码后，Task 4 监听）

- [ ] **Step 1: 创建组件**

创建 `src/components/SettingsDialog.vue`（与 `SettingsView.vue` 的差异：外层 `<dialog>` 包裹、`open()` 时加载规则、保存有变化时 emit `saved`、重置密码先关弹窗再 emit `reset`）：

```vue
<script setup lang="ts">
import { reactive, ref } from 'vue'
import { deepUnwrap } from '../lib/serialize'
import ResetPassword from './ResetPassword.vue'
import type { BuiltinRule, RulesConfig } from '../../electron/shared/types'

const emit = defineEmits<{ saved: []; reset: [] }>()

const dialog = ref<HTMLDialogElement | null>(null)
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
/** 打开弹窗时按「保存输出格式」生成的配置快照，用于判断保存后规则是否真有变化 */
let savedSnapshot = ''

function currentConfig(): RulesConfig {
  return deepUnwrap({
    disabledBuiltins: builtins.value.filter((b) => !enabled[b.id]).map((b) => b.id),
    customKeywords: customKeywords.value,
    customPatterns: customPatterns.value,
  })
}

/** App 经 template ref 调用：打开弹窗并拉取最新规则（每次打开都拉，保证多次打开数据新鲜） */
async function open() {
  dialog.value?.showModal()
  loaded.value = false
  errorMsg.value = ''
  okMsg.value = ''
  try {
    const result = (await window.ipcRenderer.invoke('rules:get')) as {
      config: RulesConfig
      builtins: BuiltinRule[]
    }
    builtins.value = result.builtins
    for (const b of result.builtins) enabled[b.id] = !result.config.disabledBuiltins.includes(b.id)
    customKeywords.value = [...result.config.customKeywords]
    customPatterns.value = [...result.config.customPatterns]
    savedSnapshot = JSON.stringify(currentConfig())
    loaded.value = true
  } catch (err) {
    errorMsg.value = (err as Error).message
  }
}

defineExpose({ open })

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
    const config = currentConfig()
    await window.ipcRenderer.invoke('rules:save', config)
    okMsg.value = '规则已保存'
    if (JSON.stringify(config) !== savedSnapshot) {
      savedSnapshot = JSON.stringify(config)
      emit('saved')
    }
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

/** 确认重置密码：先关弹窗再通知 App 切回设置密码流程 */
function onReset() {
  dialog.value?.close()
  emit('reset')
}
</script>

<template>
  <dialog ref="dialog" class="modal">
    <div class="modal-box max-h-[85vh] max-w-2xl space-y-4 overflow-y-auto">
      <h3 class="text-lg font-bold">设置</h3>

      <div v-if="errorMsg" class="alert alert-error">{{ errorMsg }}</div>
      <div v-if="okMsg" class="alert alert-success">{{ okMsg }}</div>

      <template v-if="loaded">
        <div class="card bg-base-200">
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

        <div class="card bg-base-200">
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

        <div class="card bg-base-200">
          <div class="card-body">
            <h2 class="card-title">修改密码</h2>
            <div class="alert alert-warning text-sm">
              注意：修改密码后，此前用旧密码脱敏的所有文件将无法再还原。请先还原所有文件，再修改密码。
            </div>
            <input v-model="oldPassword" type="password" class="input input-bordered input-sm w-full" placeholder="原密码">
            <input v-model="newPassword" type="password" class="input input-bordered input-sm w-full" placeholder="新密码">
            <input v-model="newPassword2" type="password" class="input input-bordered input-sm w-full" placeholder="确认新密码">
            <div class="flex items-center justify-between">
              <button class="btn btn-warning btn-sm" @click="submitChangePassword">修改密码</button>
              <ResetPassword label="忘记原密码？重置" @reset="onReset" />
            </div>
          </div>
        </div>
      </template>
      <div v-else class="flex justify-center p-8">
        <span class="loading loading-spinner loading-lg" />
      </div>

      <div class="modal-action">
        <button class="btn" @click="dialog?.close()">关闭</button>
      </div>
    </div>
    <form method="dialog" class="modal-backdrop"><button>关闭</button></form>
  </dialog>
</template>
```

- [ ] **Step 2: 类型检查**

Run: `pnpm exec vue-tsc --noEmit`
Expected: PASS（此时 `App.vue` 仍引用 `SettingsView.vue`，两者并存不冲突）

- [ ] **Step 3: Commit**

```bash
git add src/components/SettingsDialog.vue
git commit -m "feat: add settings as modal dialog component"
```

---

### Task 3: `MainFlow.vue` 暴露 `reloadAnalysis()`

**Files:**
- Modify: `src/components/MainFlow.vue`（script setup 内加 import、新函数、defineExpose）

**Interfaces:**
- Consumes: `mergeSelections(prev, next, prevSelections)`（Task 1）、IPC `file:reanalyze`
- Produces: 组件暴露 `reloadAnalysis(): Promise<void>`（`defineExpose`，Task 4 的 `App.vue` 经 template ref 调用）

- [ ] **Step 1: 加 import**

`src/components/MainFlow.vue` 第 3 行 `import { deepUnwrap } from '../lib/serialize'` 之后加一行：

```ts
import { mergeSelections } from '../lib/selections'
```

- [ ] **Step 2: 加 `reloadAnalysis()` 并暴露**

在 `changeHeaderRow` 函数之后插入：

```ts
/** 规则保存后重载当前文件（新规则即时生效）；headerRow 以当前值作 override 保留用户修正 */
async function reloadAnalysis() {
  if (!analysis.value) return
  const overrides: Record<string, number> = {}
  for (const s of analysis.value.sheets) overrides[s.name] = s.headerRow
  busy.value = true
  errorMsg.value = ''
  summary.value = null
  try {
    const next = (await window.ipcRenderer.invoke(
      'file:reanalyze',
      analysis.value.filePath,
      overrides,
    )) as AnalyzeResult
    selections.value = mergeSelections(analysis.value, next, selections.value)
    analysis.value = next
  } catch (err) {
    errorMsg.value = (err as Error).message
  } finally {
    busy.value = false
  }
}

defineExpose({ reloadAnalysis })
```

- [ ] **Step 3: 类型检查**

Run: `pnpm exec vue-tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/components/MainFlow.vue
git commit -m "feat: expose reloadAnalysis to re-apply rules on current file"
```

---

### Task 4: `App.vue` 接线 + 删除 `SettingsView.vue`

**Files:**
- Modify: `src/App.vue`（整体重写，53 行小文件）
- Delete: `src/components/SettingsView.vue`

**Interfaces:**
- Consumes: `SettingsDialog` 的 `open()` / `@saved` / `@reset`（Task 2）；`MainFlow` 的 `reloadAnalysis()`（Task 3）
- Produces: 无（顶层组件，最终接线）

- [ ] **Step 1: 重写 App.vue**

`src/App.vue` 完整内容替换为：

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import PasswordGate from './components/PasswordGate.vue'
import MainFlow from './components/MainFlow.vue'
import SettingsDialog from './components/SettingsDialog.vue'

type View = 'loading' | 'gate-setup' | 'gate-unlock' | 'main'
const view = ref<View>('loading')
const errorMsg = ref('')
const settingsDialog = ref<InstanceType<typeof SettingsDialog> | null>(null)
const mainFlow = ref<InstanceType<typeof MainFlow> | null>(null)

onMounted(async () => {
  try {
    const state = (await window.ipcRenderer.invoke('app:state')) as string
    view.value = state === 'setup' ? 'gate-setup' : state === 'unlocked' ? 'main' : 'gate-unlock'
  } catch (err) {
    errorMsg.value = `初始化失败：${(err as Error).message}`
  }
})

function openSettings() {
  settingsDialog.value?.open()
}

/** 规则保存成功且有变化 → 用新规则重新分析当前已选文件（未选文件时 MainFlow 内部直接返回） */
function onRulesSaved() {
  mainFlow.value?.reloadAnalysis()
}
</script>

<template>
  <div class="min-h-screen bg-base-200 p-6">
    <div class="mx-auto max-w-4xl">
      <div class="mb-4 flex items-center justify-between">
        <h1 class="text-xl font-bold">报表脱敏工具</h1>
        <button v-if="view === 'main'" class="btn btn-sm" @click="openSettings">设置</button>
      </div>
      <div v-if="errorMsg" class="alert alert-error mb-4">{{ errorMsg }}</div>
      <PasswordGate v-if="view === 'gate-setup'" mode="setup" @ready="view = 'main'" />
      <PasswordGate
        v-else-if="view === 'gate-unlock'"
        mode="unlock"
        @ready="view = 'main'"
        @reset="view = 'gate-setup'"
      />
      <MainFlow v-else-if="view === 'main'" ref="mainFlow" />
      <div v-else class="flex justify-center p-12">
        <span class="loading loading-spinner loading-lg" />
      </div>
    </div>
    <SettingsDialog ref="settingsDialog" @saved="onRulesSaved" @reset="view = 'gate-setup'" />
  </div>
</template>
```

- [ ] **Step 2: 删除旧设置页组件**

```bash
git rm src/components/SettingsView.vue
```

- [ ] **Step 3: 确认无残留引用**

Run: `rg -n "SettingsView" src/ electron/`
Expected: 无输出（除 git 历史外无引用）

- [ ] **Step 4: 类型检查**

Run: `pnpm exec vue-tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/App.vue
git commit -m "feat: replace settings page with dialog and reload file on rules save"
```

---

### Task 5: README 更新 + 全量验证

**Files:**
- Modify: `README.md:15-16`（「设置页」描述改为「设置弹窗」+ 保存后自动重载说明）

**Interfaces:**
- Consumes: 无
- Produces: 无

- [ ] **Step 1: 更新 README**

`README.md` 第 15-16 行：

```
4. 设置页：启停内置规则、增删自定义关键词/正则、修改密码（**修改后旧密码
   脱敏的文件无法再还原，请先还原全部文件**）
```

替换为：

```
4. 设置弹窗：启停内置规则、增删自定义关键词/正则、修改密码（**修改后旧密码
   脱敏的文件无法再还原，请先还原全部文件**）；保存规则后自动按新规则重新
   分析已选文件，新命中列自动补勾（手动勾选保留）
```

- [ ] **Step 2: 全量验证**

Run:
```bash
pnpm exec vitest run && pnpm exec vue-tsc --noEmit && pnpm exec tsc --noEmit -p tsconfig.node.json && pnpm exec vite build
```
Expected: 全部 PASS（vitest 无回归、双 tsconfig 类型检查通过、构建成功）

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: update README for settings dialog and auto reload"
```

- [ ] **Step 4: 手动实测（`pnpm run dev`）**

1. 选择 .xlsx / .csv 文件 → 表头勾选表展示
2. 点「设置」→ 弹窗打开，表格状态保留在弹窗后
3. 加新关键词（如「工号」）→ 保存规则 → 弹窗显示「规则已保存」且不关闭
4. 关闭弹窗 → 表格已按新规则重载：新命中列自动补勾；之前手动取消的列不被重新勾上；手动加勾的列保留
5. 解锁界面「忘记密码？重置」与弹窗内「忘记原密码？重置」两条重置路径均正常
