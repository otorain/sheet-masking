# 词条列表化展示实现计划

**Goal:** 设置页四类关键词与内容正则的已有词条从徽章平铺改为固定高度列表，垃圾桶图标删除，按拼音/字母排序展示。

**Architecture:** 新增纯函数 `src/lib/sort.ts`（`sortTerms`，locale zh-Hans-CN 排序，可单测）；`SettingsDialog.vue` 五处列表模板统一替换；删除从按索引改为按值。

**Tech Stack:** Vue 3 `<script setup>` + daisyUI + `@lucide/vue`（Trash2）。

Spec: `docs/superpowers/specs/2026-09-16-term-list-view-design.md`

## Global Constraints

- 界面文案为中文；提交信息为英文 conventional commits；直接在 main 分支开发
- 排序仅显示层，不改存储数组；匹配引擎（`electron/main/rules.ts`）不动
- 组件不进 vitest（既定决策）：排序逻辑抽 `src/lib/sort.ts` 保证可测

---

### Task 1: 依赖与排序工具

**Files:**
- Create: `src/lib/sort.ts`、`src/lib/sort.test.ts`
- Modify: `package.json`（devDependencies 加 `@lucide/vue`）

- [x] Step 1: `pnpm add -D @lucide/vue`（注意：官方已废弃 `lucide-vue-next`，迁移到 `@lucide/vue`）
- [x] Step 2: 写 `sort.ts` + `sort.test.ts`（拼音序/英文序/混合序——汉字在前拉丁在后/不改原数组）
- [x] Step 3: `pnpm exec vitest run src/lib/sort.test.ts` 通过

### Task 2: SettingsDialog.vue 改造

**Files:**
- Modify: `src/components/SettingsDialog.vue`

- [x] Step 1: script——import `Trash2`、`sortTerms`；`pendingDelete` 去掉 `index`；`askDelete(kind, value)`；`confirmDelete` 按值 `filter` 移除
- [x] Step 2: template——四类关键词小节与正则卡片的徽章平铺替换为 `max-h-40 overflow-y-auto` 列表（行高约 32px，恰 5 行；`btn-ghost btn-xs` + `<Trash2 class="size-4" />`，`opacity-0 group-hover:opacity-100 focus-visible:opacity-100` 悬停显现；空列表占位「暂无」；「添加」按钮 `btn-soft`）
- [x] Step 3: `pnpm exec vitest run && pnpm exec vue-tsc --noEmit && pnpm exec tsc --noEmit -p tsconfig.node.json && pnpm exec vite build` 全绿

### Task 3: 提交

```bash
git add package.json pnpm-lock.yaml src/lib/sort.ts src/lib/sort.test.ts \
  src/components/SettingsDialog.vue docs/superpowers/specs/2026-09-16-term-list-view-design.md \
  docs/superpowers/plans/2026-09-16-term-list-view.md
git commit -m "feat: list-based term view in settings with sorted order and trash icons"
```
