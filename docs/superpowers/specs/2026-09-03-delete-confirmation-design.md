# 删除关键词确认弹窗设计

日期：2026-09-03
状态：已确认

## 背景与目标

四类关键词重构后，设置页词条徽章上的 ✕ 点击即删除并立即生效，有误触风险。
为删除操作增加确认弹窗。

## 关键决策（用户已确认）

- 确认范围：四类关键词**和**内容正则的删除都需确认，交互一致
- 形式：模态确认对话框（用户原话「确认弹窗」）
- 直接在 main 分支开发（项目约定无 PR 流程），不开 worktree

## 交互流程

1. 点击词条徽章的 ✕ → 不删除，弹出确认对话框：
   - 关键词：「确认删除关键词『卡号』？」
   - 正则：「确认删除正则『^ORD-\d+$』？」
2. 点「删除」（`btn-error`）→ 执行删除并走现有 `applyRules()` 立即生效；
   点「取消」、Esc 或点击背板 → 关闭弹窗，无任何操作
3. 设置弹窗保持打开，流程不中断

## 实现要点（仅 src/components/SettingsDialog.vue）

- 新增状态：

  ```ts
  const pendingDelete = ref<{
    kind: KeywordKind | 'patterns'
    index: number
    value: string
  } | null>(null)
  ```

- 新增第二个 `<dialog class="modal">`（与主设置弹窗并列，各自 `showModal()`；
  Chrome/Electron 支持模态对话框叠加）
- 徽章 ✕ 按钮改为：设置 `pendingDelete` 并打开确认框（`askDelete(kind, index, value)`）
- 确认按钮回调：按 `pendingDelete.kind` 从对应数组 `splice(index, 1)`，调用
  `applyRules()`，关闭确认框并清空 `pendingDelete`
- 现有 `removeKeyword`/`removePattern` 合并为确认回调 `confirmDelete()`
- 文案按类型区分（关键词/正则）

## 影响面与验证

- 只改 `SettingsDialog.vue`；不动主进程、IPC、匹配引擎、类型
- 无组件测试设施（既定决策）：验证 = `pnpm exec vue-tsc --noEmit` +
  `pnpm exec vitest run` + `pnpm exec vite build`
