# AGENTS.md

报表脱敏工具：Electron 42 + Vue 3 + Vite 8 桌面应用，对 .xlsx/.csv 敏感列做确定性
AES-256-GCM 可逆加密。从 electron-vite-vue 模板改造，pnpm 11.3.0 管理。

## 常用命令

- `pnpm run dev` — 开发（vite + electron 热重启）
- `pnpm test` / `pnpm exec vitest run <path>` — 全部测试 / 单文件聚焦
- `pnpm run build` — 完整链：vue-tsc + **tsc -p tsconfig.node.json** + vite build + electron-builder
- 快速验证（不打包）：`pnpm exec vitest run && pnpm exec vue-tsc --noEmit && pnpm exec tsc --noEmit -p tsconfig.node.json && pnpm exec vite build`

## 打包（本机是 Linux）

- `pnpm run build` 末尾的 electron-builder **只打宿主机平台**（Linux AppImage）。
  给脚本追加平台参数无效：`pnpm run build -- --win --x64` 的参数会被 `sh -c`
  吞成位置参数，到不了 electron-builder。打 Windows 包必须显式：
  `pnpm exec vite build && pnpm exec electron-builder --win --x64`
- NSIS 需要 wine（rcedit 编辑 exe 元数据/签名），本机未装。可行方案：docker
  镜像 `electronuserland/builder:wine` 做 wine shim 放到 PATH 最前再跑上面的命令
  （shim 要点：`$HOME` 同路径挂载使绝对路径可用、以宿主 uid 运行避免产物变
  root 属主、挂持久 WINEPREFIX 目录；本机 docker 免 sudo）
- 未配置签名证书：安装包未签名（SmartScreen 会提示）；win/linux 图标已配置
  （`build/icon.ico` / `build/icon.png`）

## 架构要点（不看代码容易踩的坑）

- **主进程 `notBundle()` 逐文件转译为 ESM**（package.json `type: module`）：
  `electron/` 内相对 import **必须带 `.js` 后缀**；运行时依赖（exceljs、fast-csv、
  iconv-lite）必须在 **dependencies**，不能进 devDependencies（electron-builder 只打包前者）
- **渲染进程 sandbox**：无 nodeIntegration。文件/加密只在主进程，渲染端经
  `window.ipcRenderer.invoke`；`electron/main/index.ts` 是唯一 IPC 入口
- **共享类型在 `electron/shared/types.ts`**（纯 interface）：主进程
  `import type ... from '../shared/types.js'`，渲染端 `import type ... from
  '../../electron/shared/types'`，转译后无运行时产物
- **双 tsconfig 且无 project reference**（references 被刻意移除：跨边界 import
  复合项目会报 TS6305）。根 tsconfig（include: src + electron/shared）由 vue-tsc
  检查；tsconfig.node.json（include: electron + 两个 config）由 tsc 检查。
  改动共享文件位置时两个 include 都要顾
- 主进程启动即 `--max-old-space-size=12288`（ExcelJS 全量加载大工作簿）

## 测试约定

- vitest，node 环境，`*.test.ts` 与被测文件同目录（`electron/**`、`src/**`）
- `config.ts`/`index.ts` 依赖 electron，**不进 vitest**（既定决策，只过类型检查）
- sheet/csv 测试用 ExcelJS/临时目录在内存构造真实 fixture 做加密→还原往返断言

## 已知坑（都真实踩过）

- **Vue reactive Proxy 不能过 contextBridge**：invoke 传参会抛
  `An object could not be cloned`——先过 `src/lib/serialize.ts` 的 `deepUnwrap()`
- preload `on()` 返回退订函数；`off()` 摘不掉包装监听，组件卸载必须用返回值退订
- pnpm 11 默认拒绝依赖构建脚本：放行清单在 `pnpm-workspace.yaml` 的 `allowBuilds`
- 密文格式为 `E2:` 前缀自包含单元格（README「加密格式」一节有完整说明）；
  **与 2026-08-31 之前的 ENC1 格式不兼容**，无历史数据故未留兼容代码
- `app.getPath('userData')` 跟随 package.json `name`（sheet-masking）；改 name
  会整体搬迁配置目录
- CI（`.github/workflows/build.yml`）是模板遗留，用 `npm install` 而非 pnpm；
  本地一律用 pnpm

## 工作流约定

- 设计文档 → `docs/superpowers/specs/`，实现计划 → `docs/superpowers/plans/`，
  两者随代码提交；加密格式等重大行为变更以 spec 为准
- 提交信息：英文 conventional commits；直接在 main 分支提交（用户明确要求，无 PR 流程）
- 界面与文档文案为中文
