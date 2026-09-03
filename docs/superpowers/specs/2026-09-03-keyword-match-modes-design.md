# 四类关键词匹配重构设计

日期：2026-09-03
状态：已确认
分支：keyword-match-modes

## 背景与目标

当前设置页的规则分两部分：预设规则（内置表头关键词 + 内置内容正则，可开关）和用户
自定义规则（关键词 + 正则），需点击「保存规则」生效。交互不友好：

- 预设/自定义两套概念并存，用户需要理解「禁用内置」与「新增自定义」的区别
- 预设关键词实为 includes 匹配，但 UI 上没有体现匹配方式
- 必须点保存按钮才生效，容易忘

重构为按匹配方式分四类关键词，全部用户可增删，增删立即生效：

1. 完全匹配关键词
2. 包含关键词
3. 以关键词开头
4. 以关键词结尾

同时去掉全部预设规则（关键词与内容正则）：普通用户不理解正则，有经验的用户可自行
添加。原预设关键词改为「完全匹配」类的默认词条；原内容正则覆盖的敏感数据类型
（身份证、手机号、银行卡、邮箱）通过扩充默认完全匹配词来覆盖典型完整表头。

## 关键决策（用户已确认）

- 预设词进「完全匹配」而非「包含」，并补充「银行卡号」等典型完整表头词
- 预设内容正则全部删除，不保留开关；自定义正则功能保留（无预设）
- 旧配置不迁移：检测到旧格式直接重置为默认配置
- UI 采用「四小节卡片」布局

## 数据模型

`electron/shared/types.ts`：

```ts
export interface RulesConfig {
  /** 完全匹配（表头 trim 后 === 关键词） */
  exact: string[]
  /** 包含（表头 includes 关键词） */
  contains: string[]
  /** 以关键词开头 */
  startsWith: string[]
  /** 以关键词结尾 */
  endsWith: string[]
  /** 自定义内容正则 source；保存时已校验可编译。无预设 */
  patterns: string[]
}
```

- 删除 `BuiltinRule` 接口
- 删除 `disabledBuiltins` 概念

### 默认配置

`defaultRulesConfig()` 返回：`exact` 预填 24 个词，其余四类为空数组：

```
姓名、身份证、身份证号、身份证号码、证件号、证件号码、统一社会信用代码、
手机号、手机号码、电话、联系电话、电话号码、
银行卡、银行卡号、卡号、账号、银行账号、开户行、开户银行、
税号、
邮箱、电子邮箱、
地址、联系地址
```

### 旧配置处理

`config.ts` 的 `getRulesConfig()`：读取到的 `rules` 缺少 `exact` 数组字段即视为旧
格式，直接返回 `defaultRulesConfig()`。不写字段级迁移代码，旧配置中的自定义内容
丢弃（用户已确认）。

## 匹配逻辑（electron/main/rules.ts）

- 删除 `BUILTIN_RULES` 常量
- `matchColumns(headers, sampleRows, config)`：
  - 表头先 `trim` 再参与四种关键词匹配
  - 四种模式：`exact` 用 `===`，`contains` 用 `includes`，`startsWith` 用
    `startsWith`，`endsWith` 用 `endsWith`
  - `patterns` 仍对前 50 个数据行抽样，命中任一样本即整列选中（逻辑不变）；
    无效正则防御性跳过（保存时已校验）
  - 关键词统一 `trim`，空串忽略；每类内部去重（添加时保证）；同一关键词允许
    同时出现在多个类中（各类独立匹配）
  - 匹配大小写敏感（针对中文表头，与现行为一致）
- `matchedRules` 标签格式：
  - `完全匹配：X` / `包含：X` / `开头：X` / `结尾：X` / `正则：X`
  - 该标签直接显示在 MainFlow 的「命中规则」列

## IPC 与持久化

- `rules:get` 返回 `{ config: RulesConfig }`（不再返回 `builtins`）
- `rules:save` 不变：仍校验所有 `patterns` 可编译，原子写 config.json
- `electron/main/index.ts` 相应简化（不再 import `BUILTIN_RULES`）

## 设置界面（src/components/SettingsDialog.vue）

- **「表头关键词」卡片**：四个小节（完全匹配 / 包含 / 以关键词开头 / 以关键词
  结尾）。每节：
  - 一个输入框 + 添加按钮（Enter 也可添加），placeholder 给出该类示例
    （如完全匹配「如：工号」、包含「如：号」）
  - 该类词条徽章列表，每个徽章带 ✕ 删除
- **「内容正则（高级）」卡片**：单个输入框（添加前 `new RegExp` 校验，无效则提示
  且不添加）+ 徽章列表
- **无保存按钮**：每次增删操作：
  1. 本地校验（非空、类内去重、正则可编译）
  2. `deepUnwrap` 当前配置 → `invoke('rules:save')`
  3. 成功后 `emit('saved')` → App.vue `reloadAnalysis()` 重新分析当前文件
  4. 失败则显示错误信息，并重新 `rules:get` 拉取主进程真实状态同步 UI
- 打开弹窗时仍每次 `rules:get` 拉最新配置（现有行为保留）
- 「修改密码」卡片不动

## 测试

- `electron/main/rules.test.ts` 重写：
  - 默认配置形状（`exact` 24 词，其余空）
  - 四种匹配模式各自命中/不命中用例
  - 表头 trim 行为
  - 自定义正则命中内容、无效正则跳过
- `electron/main/sheet.test.ts`：更新标签断言（`表头关键词：姓名` →
  `完全匹配：姓名`）；隐藏 sheet 用例原本靠内置「银行卡」内容正则命中，预设正则
  删除后需调整该用例（改由默认完全匹配词命中或调整 fixture 表头）
- `src/lib/selections.test.ts`、`src/lib/serialize.test.ts`：如引用旧字段名
  （`customKeywords` 等）同步更新
- `electron/main/csv.test.ts` 使用 `defaultRulesConfig()`，断言如涉及内置正则
  命中需同步调整

## 影响面

- 改动文件：`electron/shared/types.ts`、`electron/main/rules.ts`、
  `electron/main/config.ts`、`electron/main/index.ts`、
  `src/components/SettingsDialog.vue`（主体重写规则区）、上述测试文件
- 不改：加密格式、密码流程、MainFlow 主体、preload
- README 如涉及规则设置说明需同步更新
