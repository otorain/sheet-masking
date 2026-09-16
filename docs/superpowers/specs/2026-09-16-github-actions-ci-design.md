# GitHub Actions CI/CD 设计

日期：2026-09-16
状态：已确认

## 背景与目标

现有 `.github/workflows/build.yml` 是 electron-vite-vue 模板遗留：用 `npm install`
（本项目是 pnpm 11，lockfile 只有 pnpm-lock.yaml，CI 必败）、不跑任何测试与类型
检查、push main 即三平台全量打包。重写为与本地工具链一致的「校验 + 发布」流水线。

## 关键决策（用户已确认）

- 用途：**校验 + 发布打包**。push main / PR / 手动触发只跑校验；推 `v*` tag 时
  校验通过后打包并自动建 GitHub Release
- 打包平台：**Windows（NSIS）+ Linux（AppImage）**。GitHub Windows runner 原生
  支持 NSIS，不需要本机的 wine shim；mac 未签名 dmg 实用性有限，不打
- 产物去向：`softprops/action-gh-release` 附件到 tag 对应的 GitHub Release，
  另以 workflow artifact 形式保留 5 天
- 单 workflow 文件（沿用 `.github/workflows/build.yml` 文件名重写），不拆
  ci/release 两个文件（避免 workflow_run 链式触发的复杂度）

## 工作流结构

`name: CI`，三个 job：

### verify（ubuntu-latest；push main、`v*` tag、PR、手动触发都跑）

1. `actions/checkout@v7`（`persist-credentials: false`）
2. `pnpm/action-setup@v6`（不传 version，自动读 package.json 的
   `packageManager: pnpm@11.3.0`）
3. `actions/setup-node@v7`：node 22 + `cache: pnpm`（必须在 pnpm 安装之后）
4. `pnpm install --frozen-lockfile`
5. `pnpm test`（vitest）
6. `pnpm exec vue-tsc --noEmit && pnpm exec tsc --noEmit -p tsconfig.node.json`
7. `pnpm exec vite build`（只验证构建，不打包）

### package（`needs: verify`，`if: startsWith(github.ref, 'refs/tags/v')`）

矩阵 `windows-latest` + `ubuntu-latest`：

1. 同 verify 的 checkout / pnpm / node / install 四步
2. 显式链 `pnpm exec vue-tsc --noEmit && pnpm exec tsc --noEmit -p
   tsconfig.node.json && pnpm exec vite build && pnpm exec electron-builder
   --publish never`（单行 &&，兼容 Windows pwsh）。**不用 `pnpm run build`**：
   electron-builder v26 在 CI 上检测到 tag 时默认 publish=onTag（v27 移除），
   发布必须由下方 release job 统一负责；且 `pnpm run` 追加参数会被 sh -c 吞成
   位置参数（见 AGENTS.md 打包一节）
3. `actions/upload-artifact@v7`：name `release-${{ matrix.os }}`，路径只收
   `release/*/*.exe` + `release/*/*.AppImage`，`if-no-files-found: error`，
   保留 5 天。**不能整个传 `release/`**：`release/${version}/` 里还有
   `win-unpacked/`（含 400MB+ 原始 `sheet-masking.exe`，会被 release 的
   `**/*.exe` glob 误挂到 Release）、`linux-unpacked/`、blockmap、
   `latest*.yml` 等

### release（`needs: package`，ubuntu-latest，`permissions: contents: write`）

1. `actions/download-artifact@v8`：`pattern: release-*` + `merge-multiple: true`
   下载到 `artifacts/`（两平台产物汇入同一 `artifacts/${version}/`）
2. `softprops/action-gh-release@v3`：`generate_release_notes: true` +
   `fail_on_unmatched_files: true`（防产物布局漂移导致空 Release 变绿），
   files 只挂 `artifacts/**/*.exe` 与 `artifacts/**/*.AppImage`
   （`latest*.yml`/blockmap 无自动更新用途，不挂）；纯 API 操作，无需 checkout

顶层 `permissions: contents: read`，仅 release job 提权。不使用
`paths-ignore`（避免 tag 推送的路径过滤边界情况导致发布被跳过）。

## 风险与对策

- pnpm 11 默认拒绝依赖构建脚本（实测未列入 `allowBuilds` 的包会使 install 以
  ERR_PNPM_IGNORED_BUILDS 退出 1）。已用项目真实 package.json + lockfile +
  pnpm-workspace.yaml 在空目录模拟 CI 全新安装验证通过：全图只有
  electron-winstaller 带构建脚本且已显式 `false`；electron 42 已无 postinstall
  （二进制改为首次运行时由 @electron/get 下载），electron-builder 打包时自行下载
  官方 zip，均不依赖 node_modules 里的 electron 二进制
- **electron-builder v26 在 CI 上检测到 tag 时默认 publish=onTag**（源码
  PublishManager 实证，v27 移除）：无 GH_TOKEN 时静默空转，一旦有人给打包 job
  注入 GITHUB_TOKEN 就会与 release job 双发布竞态。对策：打包显式
  `--publish never`，发布只走 action-gh-release
- **`release/${version}/` 含 `*-unpacked/` 目录**（win-unpacked 有 400MB+ 原始
  exe）：artifact 上传与 Release 附件必须用窄 glob 排除，已在 package/release
  job 落实
- AppImage 构建无 FUSE 依赖：electron-builder v26 自带 mksquashfs 工具链拼装，
  不执行 appimagetool（源码实证），ubuntu-latest 无需装 libfuse2
- xlsx 走 CDN tarball，`pnpm install` 需可达 cdn.sheetjs.com（GitHub runner
  网络无问题）
- 产物均未签名（Windows SmartScreen 提示），与本地打包一致，属已知接受项
- tag 与 package.json `version` 的一致性不做 CI 强校验（YAGNI）

## 验证

- 本地用 YAML 解析器校验语法；`pnpm install --frozen-lockfile` 本地复跑确认与
  CI 安装行为一致
- 真实校验链只能合并后跑一次 tag 发布验证（首次发布如失败按「风险与对策」修）
