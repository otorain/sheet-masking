# 词条列表化展示设计（固定高度 + 垃圾桶删除 + 排序）

日期：2026-09-16
状态：已确认

## 背景与目标

设置页四类关键词与内容正则的已有词条以徽章（badge）平铺 + ✕ 展示，词条一多就难以
扫读定位。改为固定高度列表 + 垃圾桶删除图标，并按字母/拼音排序，方便查看。

## 关键决策（用户已确认）

- 范围：四类关键词小节**和**内容正则卡片都改，整个设置弹窗视觉统一
- 高度行为：`max-h-40`（约 5 行），条目不足时收缩，超出出现纵向滚动条
- 删除图标：lucide 垃圾桶（`@lucide/vue` 的 `Trash2`；`lucide-vue-next` 已被官方
  废弃并迁移到 `@lucide/vue`，占位包 1.0.0 不可用）。**仅行悬停时显现**
  （`opacity-0 group-hover:opacity-100`，保留 `focus-visible:opacity-100` 保证键盘
  可达），平时隐藏减少视觉干扰；按钮始终占位，隐现不引起布局跳动
- 空列表占位文案统一为「暂无」（不用「暂无关键词」/「暂无正则」，减少视觉干扰）
- 「添加」按钮用 `btn-soft` 浅色填充：daisyUI 5 裸 `btn` 是中性色实心，与
  `input-bordered` 描边输入框拼成 `join` 后一轻一重；join 结构保留不动
- 排序：`localeCompare(b, 'zh-Hans-CN')`——中文按拼音、英文按字母；ICU zh 排序规则
  下汉字在前、拉丁字母在后。**仅显示层排序**，存储数组顺序不变（匹配引擎与顺序无关）

## 实现要点

- 新增 `src/lib/sort.ts`：`sortTerms(list)` 返回排序副本，不改原数组；
  同目录 `sort.test.ts` 覆盖拼音序/英文序/混合序/不可变性
- `SettingsDialog.vue` 模板：5 处徽章平铺替换为
  `max-h-40 overflow-y-auto rounded-box border border-base-300 bg-base-100` 列表，
  行内左侧词条（`truncate`，正则行 `font-mono`），右侧 `btn-ghost btn-xs text-error`
  垃圾桶按钮（悬停显现）；空列表占位文案「暂无」；「添加」按钮 `btn-soft`
- 删除定位从索引改为按值：列表排序后显示索引与数组索引不再对应；各类词条添加时已
  去重，按值删除安全。`pendingDelete` 去掉 `index`，`confirmDelete` 用 `filter` 移除
- 删除确认弹窗逻辑与文案不变

## 影响面与验证

- 只动渲染端：新增 `src/lib/sort.ts`、`src/lib/sort.test.ts`，改
  `src/components/SettingsDialog.vue`；不动主进程、IPC、匹配引擎、类型
- 新增 devDependency `@lucide/vue`（渲染端经 vite 打包，无需进 dependencies）
- 验证：`pnpm exec vitest run` + `pnpm exec vue-tsc --noEmit` +
  `pnpm exec tsc --noEmit -p tsconfig.node.json` + `pnpm exec vite build`
