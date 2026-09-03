# 删除关键词确认弹窗实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 设置页删除关键词/正则前弹出确认对话框，确认后才删除并立即生效。

**Architecture:** 仅改 `src/components/SettingsDialog.vue`：新增 `pendingDelete` 状态与第二个 `<dialog>` 确认框；徽章 ✕ 改为打开确认框；确认回调执行 splice + 现有 `applyRules()`。

**Tech Stack:** Vue 3 `<script setup>` + daisyUI modal。

Spec: `docs/superpowers/specs/2026-09-03-delete-confirmation-design.md`

## Global Constraints

- 渲染进程向 IPC 传参前必须过 `deepUnwrap()`
- 界面文案为中文；提交信息为英文 conventional commits
- 无组件测试设施（既定决策）：验证 = `pnpm exec vue-tsc --noEmit` + `pnpm exec vitest run` + `pnpm exec vite build`
- 直接在 main 分支开发提交
- 只改 `SettingsDialog.vue`；不动主进程、IPC、匹配引擎、类型

---

### Task 1: 删除确认弹窗

**Files:**
- Modify: `src/components/SettingsDialog.vue`（script 第 74-98 行区域；template 第 154-157、177-180 行徽章按钮；末尾新增确认 dialog）

**Interfaces:**
- Consumes: 现有 `config`（`ref<RulesConfig>`）、`applyRules()`、`KeywordKind` 类型
- Produces: 无新导出；`defineExpose({ open })` 与 emits 不变

- [ ] **Step 1: script — 新增确认状态与函数**

在 `const dialog = ref<...>` 附近新增：

```ts
const confirmDialog = ref<HTMLDialogElement | null>(null)
const pendingDelete = ref<{ kind: KeywordKind | 'patterns'; index: number; value: string } | null>(null)
```

新增两个函数，并**删除**现有 `removeKeyword`（第 74-77 行）与 `removePattern`（第 95-98 行）：

```ts
/** 点 ✕ 不直接删除：先弹确认框 */
function askDelete(kind: KeywordKind | 'patterns', index: number, value: string) {
  pendingDelete.value = { kind, index, value }
  confirmDialog.value?.showModal()
}

/** 确认删除：从对应数组移除并立即生效 */
function confirmDelete() {
  const target = pendingDelete.value
  if (target) {
    config.value[target.kind].splice(target.index, 1)
    applyRules()
  }
  pendingDelete.value = null
  confirmDialog.value?.close()
}
```

（`config.value[target.kind]` 在 `RulesConfig` 五个字段均为 `string[]` 下类型成立）

- [ ] **Step 2: template — 徽章 ✕ 改为打开确认框**

关键词徽章按钮（第 156 行）：

```html
                  <button class="text-error" @click="askDelete(section.kind, i, kw)">✕</button>
```

正则徽章按钮（第 179 行）：

```html
                <button class="text-error" @click="askDelete('patterns', i, p)">✕</button>
```

- [ ] **Step 3: template — 末尾新增确认对话框**

在主 `</dialog>` 之后新增第二个根节点（Vue 3 支持多根）：

```html
  <dialog ref="confirmDialog" class="modal">
    <div class="modal-box">
      <h3 class="text-lg font-bold">确认删除</h3>
      <p class="py-4">
        确认删除{{ pendingDelete?.kind === 'patterns' ? '正则' : '关键词' }}「{{ pendingDelete?.value }}」？
      </p>
      <div class="modal-action">
        <button class="btn" @click="confirmDialog?.close()">取消</button>
        <button class="btn btn-error" @click="confirmDelete()">删除</button>
      </div>
    </div>
    <form method="dialog" class="modal-backdrop"><button>取消</button></form>
  </dialog>
```

（Esc 关闭由原生 dialog cancel 行为提供；取消/背板点击只关闭、不清状态——`pendingDelete` 会被下一次 `askDelete` 覆盖，`confirmDelete` 只由「删除」按钮触发，无风险）

- [ ] **Step 4: 验证**

Run: `pnpm exec vue-tsc --noEmit && pnpm exec vitest run && pnpm exec vite build`
Expected: 全部通过（vitest 7 文件 66 用例；vite build 仅既有 daisyUI CSS 警告）

- [ ] **Step 5: Commit**

```bash
git add src/components/SettingsDialog.vue
git commit -m "feat: confirm dialog before deleting keywords or patterns"
```
