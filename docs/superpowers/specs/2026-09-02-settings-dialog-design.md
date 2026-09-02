# 设置弹窗化 + 规则保存后重载表格设计

日期：2026-09-02
状态：已与用户确认（保留手动勾选 + 并入新命中；保存后立即重载、弹窗不关）

## 背景

当前「设置」是顶层视图（`App.vue` 的 `view = 'settings'`），与 `MainFlow` 互斥挂载——打开设置会销毁已加载的
表格状态，用户改完关键词回来后表格消失，需重新选文件。且规则保存后即便重新选文件，也要手动
再次分析才能让新关键词生效。需求：设置改为弹窗（MainFlow 保持挂载），保存规则后立即用新规则
重新分析当前已选择的表格，新命中的列自动勾选，手动调整不丢失。

## 设计

### 1. 设置页改弹窗

- `App.vue`：`View` 类型删除 `'settings'`；解锁后 `MainFlow` 始终挂载。顶部 `join` 按钮组简化为单个
  「设置」按钮（仅解锁后可见），点击打开弹窗。
- 新组件 `src/components/SettingsDialog.vue`：内容整体搬自 `SettingsView.vue`（内置规则 / 自定义规则 /
  修改密码三块不变），外壳用 daisyUI 原生 `<dialog class="modal">`，沿用 `ResetPassword.vue` 既有模式：
  `showModal()`/`close()`/`modal-backdrop` 点击遮罩关闭。
- 弹窗每次打开时重新 `rules:get` 拉取最新规则（而非仅组件挂载时），保证多次打开数据新鲜。
- 「重置密码」流程保留：确认重置后先 `close()` 弹窗，再 emit `reset` → App 切 `gate-setup`。

### 2. 保存规则后重载已选表格

- `SettingsDialog` 点「保存规则」`rules:save` 成功后：显示「规则已保存」；若规则相对打开时有变化（序列化比较
  `RulesConfig` 快照）→ emit `saved`。
- `App.vue` 监听 `@saved` → `mainFlowRef.value?.reloadAnalysis()`（MainFlow `defineExpose` 暴露该方法）。
- `MainFlow.reloadAnalysis()`：调 `file:reanalyze`（传当前各 sheet `headerRow` 为 overrides 保留用户修正过的表头行），
  主进程 handler 本就每次重读磁盘规则，无需改主进程。
- 勾选合并策略：**新勾选 = 旧勾选 ∪ （新自动命中 − 旧自动命中）**——手动勾选全保留、手动取消的不被重新勾上、
  仅新增真正「新命中」的列。
- `busy` 置位期间脱敏/还原按钮自动禁用；失败错误显示在 `MainFlow.errorMsg`（如文件已被删除/移动），
  弹窗保持打开。

### 3. 勾选合并实现

合并逻辑抽为纯函数（`src/lib/`），入参：旧 analysis、新 analysis、旧 selections；
出参：新 selections。可单测。

### 不做（YAGNI）

- 主进程 / IPC / 共享类型改动（`file:reanalyze` 现成够用）
- 引入 store 或事件总线（`defineExpose` + emit 转发足够）
- 弹窗内展示重载进度/结果（重载只读各 sheet 前 55 行，足够快）

### 测试

- 合并纯函数单测（`src/lib/` 新增，vitest）
- 验证：`vitest run` 不回归 + `vue-tsc --noEmit` + `tsc --noEmit -p tsconfig.node.json` + `vite build`
- 实测：选择文件 → 打开设置弹窗 → 加关键词 → 保存 → 弹窗不关，表格按新规则重载，新命中列自动补勾、
  手动取消的列不被重新勾上
