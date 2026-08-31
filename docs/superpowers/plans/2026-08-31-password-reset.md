# 重置密码功能实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 加「重置密码」逃生通道：忘记密码/锁死时，经确认后清空密码字段并回到设置密码流程（保留自定义规则；旧密码脱敏文件不可再还原，弹窗警告）。

**Architecture:** 主进程 `config.ts` 加 `resetPassword()`（写回缺 verifier 的配置 → `getAppState` 旧格式识别逻辑自然落入 setup 态），IPC 加 `app:reset-password`；渲染端新增共用组件 `ResetPassword.vue`（链接 + 确认 modal），接入解锁界面与设置页两个入口，`App.vue` 监听 `@reset` 切到 `gate-setup`。

**Tech Stack:** Electron 42 / Vue 3 / daisyUI 5 / TypeScript

## Global Constraints

- spec：`docs/superpowers/specs/2026-08-31-password-reset-design.md`
- 重置**保留自定义规则**；`resetPassword` 不重生成 salt——只清空，由后续 setupPassword 重建
- 确认弹窗文案必须包含「此前用旧密码脱敏的所有文件将无法再还原」与「自定义规则会保留」
- 主进程相对 import 带 `.js` 后缀；提交信息英文 conventional commits
- 验证：`pnpm exec vitest run`（53 例不回归）、`pnpm exec vue-tsc --noEmit`、`pnpm exec tsc --noEmit -p tsconfig.node.json`、`pnpm exec vite build`

---

### Task 1: 重置密码（主进程 + IPC + 双入口 UI）

**Files:**
- Modify: `electron/main/config.ts`（`changePassword` 之后追加 `resetPassword`）
- Modify: `electron/main/index.ts`（import + handler）
- Create: `src/components/ResetPassword.vue`
- Modify: `src/components/PasswordGate.vue`（unlock 模式入口 + `reset` emit）
- Modify: `src/components/SettingsView.vue`（设置页入口 + `reset` emit）
- Modify: `src/App.vue`（`@reset` 接线）

**Interfaces:**
- Consumes: 现有 `getAppState`（缺 verifier 配置 → `'setup'`，已实现）、`window.ipcRenderer.invoke`
- Produces:
  - `resetPassword(): void`（config.ts）
  - IPC `app:reset-password` → void
  - `ResetPassword.vue`：props `{ label: string }`，emits `{ reset: [] }`

- [ ] **Step 1: config.ts 加 resetPassword**

`electron/main/config.ts` 在 `changePassword` 函数之后追加：

```ts
/**
 * 重置密码（锁死逃生通道）：清空密码字段与内存派生密钥，保留自定义规则。
 * 缺 verifier 的配置会被 getAppState 视为 setup → 用户重新设置密码。
 * 旧密码脱敏的所有文件无法再还原（UI 已先行警告确认）。
 */
export function resetPassword(): void {
  ctx = null
  const stored = readStored()
  if (!stored) return
  writeStored({ salt: '', encPassword: '', verifier: '', rules: stored.rules })
}
```

- [ ] **Step 2: index.ts 加 IPC handler**

`electron/main/index.ts` 的 config.js import 块中加 `resetPassword`（按字母序插在 `getRulesConfig()` 之后）：

```ts
import {
  changePassword,
  getAppState,
  getCryptoContext,
  getRulesConfig,
  resetPassword,
  saveRulesConfig,
  setupPassword,
  unlockWithPassword,
} from './config.js'
```

在 `app:change-password` handler 之后追加：

```ts
ipcMain.handle('app:reset-password', () => {
  resetPassword()
})
```

- [ ] **Step 3: 创建 ResetPassword.vue（链接 + 确认 modal）**

Create `src/components/ResetPassword.vue`：

```vue
<script setup lang="ts">
import { ref } from 'vue'

defineProps<{ label: string }>()
const emit = defineEmits<{ reset: [] }>()

const dialog = ref<HTMLDialogElement | null>(null)
const busy = ref(false)
const errorMsg = ref('')

async function confirmReset() {
  busy.value = true
  errorMsg.value = ''
  try {
    await window.ipcRenderer.invoke('app:reset-password')
    dialog.value?.close()
    emit('reset')
  } catch (err) {
    errorMsg.value = (err as Error).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <button type="button" class="link link-hover text-sm opacity-70" @click="dialog?.showModal()">
    {{ label }}
  </button>
  <dialog ref="dialog" class="modal">
    <div class="modal-box">
      <h3 class="text-lg font-bold">确认重置密码？</h3>
      <p class="py-4 text-sm">
        重置后需要重新设置主密码。<span class="font-semibold text-error">此前用旧密码脱敏的所有文件将无法再还原。</span>自定义规则会保留。
      </p>
      <div v-if="errorMsg" class="alert alert-error mb-3 text-sm">{{ errorMsg }}</div>
      <div class="modal-action">
        <button class="btn btn-ghost" :disabled="busy" @click="dialog?.close()">取消</button>
        <button class="btn btn-error" :disabled="busy" @click="confirmReset">
          <span v-if="busy" class="loading loading-spinner loading-xs" />
          确认重置
        </button>
      </div>
    </div>
    <form method="dialog" class="modal-backdrop">
      <button>关闭</button>
    </form>
  </dialog>
</template>
```

- [ ] **Step 4: PasswordGate.vue 接入（unlock 模式）**

`src/components/PasswordGate.vue`：

script 中——import 组件，emits 加 `reset`：

```ts
import { ref } from 'vue'
import ResetPassword from './ResetPassword.vue'

const props = defineProps<{ mode: 'setup' | 'unlock' }>()
const emit = defineEmits<{ ready: []; reset: [] }>()
```

template 中——submit 按钮之后、`</div></div>` 收尾之前追加（仅 unlock 模式显示）：

```vue
      <ResetPassword v-if="mode === 'unlock'" label="忘记密码？重置" @reset="emit('reset')" />
```

- [ ] **Step 5: SettingsView.vue 接入（修改密码卡片底部）**

`src/components/SettingsView.vue`：

script 中——import 组件并声明 emit（文件现有 `onMounted, reactive, ref` import 与 `deepUnwrap` import 保持不变）：

```ts
import ResetPassword from './ResetPassword.vue'

const emit = defineEmits<{ reset: [] }>()
```

template 中——修改密码卡片的「修改密码」按钮之后追加：

```vue
        <div class="flex items-center justify-between">
          <button class="btn btn-warning btn-sm" @click="submitChangePassword">修改密码</button>
          <ResetPassword label="忘记原密码？重置" @reset="emit('reset')" />
        </div>
```

（替换原有的 `<button class="btn btn-warning btn-sm self-end" @click="submitChangePassword">修改密码</button>` 单行。）

- [ ] **Step 6: App.vue 接线 @reset**

`src/App.vue` 模板中：

```vue
      <PasswordGate v-else-if="view === 'gate-unlock'" mode="unlock" @ready="view = 'main'" @reset="view = 'gate-setup'" />
```

（在 unlock 门上加 `@reset`；setup 门不需要。）

SettingsView 改为：

```vue
      <SettingsView v-else-if="view === 'settings'" @reset="view = 'gate-setup'" />
```

- [ ] **Step 7: 全量验证**

Run: `pnpm exec vitest run && pnpm exec vue-tsc --noEmit && pnpm exec tsc --noEmit -p tsconfig.node.json && pnpm exec vite build`
Expected: 53/53 通过；类型检查与构建通过

- [ ] **Step 8: Commit**

```bash
git add electron/main/config.ts electron/main/index.ts src/components/ResetPassword.vue src/components/PasswordGate.vue src/components/SettingsView.vue src/App.vue
git commit -m "feat: password reset escape hatch (unlock screen + settings, rules preserved)"
```

---

## Self-Review 记录（计划落盘前已完成）

- spec 覆盖：resetPassword（保 rules 清空密码字段）→ Step 1；IPC → Step 2；共用组件 + 确认弹窗文案（两处必备警告别漏）→ Step 3；双入口 → Step 4/5；视图切换 → Step 6；验证 → Step 7
- 类型一致性：`ResetPassword` props/emit 与两个父组件用法一致；`defineEmits<{ ready: []; reset: [] }>` 为 Vue 3.3+ 元组语法（项目 PasswordGate 现有 `{ ready: [] }` 同款）
- 依赖前提：`getAppState` 的旧格式识别（缺 verifier → setup）已在 commit 2711c7d 落地，盘上确认存在
