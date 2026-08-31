# 重置密码功能设计

日期：2026-08-31
状态：已与用户确认（解锁界面 + 设置页双入口；重置保留自定义规则）

## 背景

报表脱敏工具的主密码一旦忘记（或配置校验失败被锁在解锁界面），唯一的恢复手段是
手动删除 `userData/config.json`——普通用户无法完成。已有「修改密码」（设置页，
需原密码），缺少锁死场景下的逃生通道。

## 设计

**语义**：重置 = 清空密码字段 + 清内存派生密钥 → 应用回到「设置密码」流程。
自定义规则保留（重置只动密码）。**旧密码脱敏的所有文件无法再还原**，两个入口
都必须弹确认框明确警告。

### 主进程

- `electron/main/config.ts` 新增 `resetPassword(): void`：
  `ctx = null`，config.json 重写为 `{ salt:'', encPassword:'', verifier:'', rules: 原样保留 }`。
  缺 verifier 的配置经 `getAppState` 的旧格式识别逻辑自然落入 `setup` 态；
  下次 `setupPassword` 会重写全部密码字段并继续保留 rules。
- `electron/main/index.ts` 新增 `ipcMain.handle('app:reset-password', () => resetPassword())`。

### 渲染端

新组件 `src/components/ResetPassword.vue`（两处复用）：

- 链接受击 → daisyUI modal 确认弹窗，文案警告「重置后，此前用旧密码脱敏的所有
  文件将无法再还原」（自定义规则保留）→「确认重置」（btn-error）→ 调
  `app:reset-password` → emit `reset`
- 入口 1：解锁界面（`PasswordGate.vue` unlock 模式）主按钮下方「忘记密码？重置」
- 入口 2：设置页（`SettingsView.vue`）修改密码卡片底部「忘记原密码？重置」
- `App.vue` 对 PasswordGate 与 SettingsView 均监听 `@reset` → `view = 'gate-setup'`

### 错误处理

- IPC 失败（如配置目录不可写）→ 组件 catch → daisyUI alert 展示
- 重置后 PasswordGate setup 模式照常校验两次输入一致

### 测试

- config.ts/UI 无单测（项目既定：依赖 electron 的模块不进 vitest）
- 验证：`vitest run`（53 例不回归）+ `vue-tsc --noEmit` +
  `tsc --noEmit -p tsconfig.node.json` + `vite build`
- 用户实测流程：锁定界面 → 忘记密码？重置 → 确认 → 设置新密码 → 正常使用

## 不做（YAGNI）

- 重置前要求输入特定文字确认/二次密码等加强确认（单确认弹窗足够）
- 重置时同时清空自定义规则（选择保留）
- 审计日志
