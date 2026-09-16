# 界面图标补齐设计（@lucide/vue）

日期：2026-09-16
状态：已确认

## 背景与目标

`@lucide/vue` 是随词条列表化（2026-09-16 term-list-view）才引入的，此前实现的界面
元素（主流程按钮、密码门禁、各类 alert/badge）都没有图标。本次给操作按钮与状态
提示统一补上 Lucide 图标，提升可扫读性。

## 关键决策（用户已确认）

- 范围：**操作按钮 + 状态提示**（alert / 隐藏 sheet badge）。各级标题（应用标题、
  弹窗标题、卡片标题）、「取消」「关闭」等中性次要按钮、文字链接、命中规则/已选
  列数 badge 一律不加，保持安静
- 实现方式：各组件按需 `import { X } from '@lucide/vue'` 内联使用，沿用现有
  `Trash2` 模式；不做集中 re-export 或动态图标组件（YAGNI）
- 尺寸约定：按钮内 `size-4`（与现有 Trash2 一致）；alert 内 `size-5 shrink-0`；
  badge 内 `size-3`。图标均与文字伴生属纯装饰，沿用 Trash2 现状不加额外 aria 属性
- 带 loading 的按钮（选择文件、密码门禁提交、确认重置）：忙碌时 spinner **替换**
  图标（`v-if="busy"` spinner / `v-else` icon），不与图标同显

## 图标映射

| 位置 | 元素 | 图标 |
|---|---|---|
| App.vue | 「设置」按钮 | `Settings` |
| App.vue | 错误 alert | `CircleAlert` |
| PasswordGate.vue | 「设置并进入」按钮 | `KeyRound` |
| PasswordGate.vue | 「解锁」按钮 | `LockKeyholeOpen` |
| PasswordGate.vue | 错误 alert | `CircleAlert` |
| MainFlow.vue | 「选择文件」按钮 | `FolderOpen` |
| MainFlow.vue | 「脱敏」按钮 | `LockKeyhole` |
| MainFlow.vue | 「还原」按钮 | `LockKeyholeOpen` |
| MainFlow.vue | 错误 alert | `CircleAlert` |
| MainFlow.vue | 「隐藏 sheet」badge | `EyeOff`（badge 加 `gap-1`） |
| MainFlow.vue | 完成 alert-success | `CircleCheck`（alert 改默认横向：图标 + 原内容包一层 flex-col） |
| SettingsDialog.vue | 5 个「添加」按钮 | `Plus` |
| SettingsDialog.vue | 错误 / 成功 alert | `CircleAlert` / `CircleCheck` |
| SettingsDialog.vue | 修改密码警告 alert | `TriangleAlert` |
| SettingsDialog.vue | 「修改密码」按钮 | `KeyRound` |
| SettingsDialog.vue | 确认删除框「删除」按钮 | `Trash2`（复用） |
| ResetPassword.vue | 错误 alert | `CircleAlert` |
| ResetPassword.vue | 「确认重置」按钮 | `RotateCcw` |

以上图标名均已确认存在于 `@lucide/vue` 1.46.0 的 PascalCase 导出。

## 影响面与验证

- 只动渲染端模板：`src/App.vue`、`src/components/{PasswordGate, ResetPassword,
  MainFlow, SettingsDialog}.vue`；不动主进程、IPC、类型、测试
- 无新依赖；项目无组件测试惯例，纯展示改动不加测试
- 验证：`pnpm exec vitest run` + `pnpm exec vue-tsc --noEmit` +
  `pnpm exec tsc --noEmit -p tsconfig.node.json` + `pnpm exec vite build`
