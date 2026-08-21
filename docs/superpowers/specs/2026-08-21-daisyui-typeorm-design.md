# daisyUI + TypeORM 集成设计

日期：2026-08-21
状态：已与用户确认（方案 A + ActiveRecord 风格 + daisyUI 改造演示界面）

## 背景

electron-vite-vue 模板项目（Electron 42 + Vue 3 + Vite 8，pnpm 11.3.0）。现状：

- Tailwind CSS v4 经 `@tailwindcss/vite` 接入，`src/style.css` 只有 `@import "tailwindcss";`
- `electron/main/db.ts` 用原生 better-sqlite3 维护 `userData/global-news.db` 的 `notes` 表（WAL）
- 主进程暴露 `db:status` / `db:note:add` 两个 IPC handler；`App.vue` 调 `db:status` 展示状态

目标：集成 daisyUI 5 和 TypeORM（ActiveRecord 风格，全面接管数据库访问，取代原生 SQL）。

## 关键约束

- 主进程经 vite-plugin-electron 构建：包依赖外部化，本地模块由 Vite 8（rolldown）
  打包进单文件 `dist-electron/main/index.js`；转译**不支持 `emitDecoratorMetadata`**，
  且按目录向上只查找 `tsconfig.json`。
  因此：
  - `experimentalDecorators: true` 加到**根 `tsconfig.json`**（构建转译用），
    `tsconfig.node.json` 同样要加（tsc/vue-tsc 类型检查用）
  - 所有列**显式声明 `type`**（含 `@CreateDateColumn({ type: 'datetime' })`），
    不依赖元数据推断
- TypeORM 0.3.x 使用 legacy 装饰器，与上一条匹配
- `better-sqlite3` 已在 dependencies 且经 postinstall 重构建，直接复用为 TypeORM 驱动

## 设计

### ① 主进程数据层（ActiveRecord 风格）

**`electron/main/entities/Note.ts`**（新）

```ts
import { BaseEntity, Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm'

@Entity('notes')
export class Note extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number

  @Column({ type: 'text' })
  content!: string

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt!: Date
}
```

- 表名显式 `notes`、列名 `created_at`，与现有表结构对应
- 全部显式类型；字段用 `!:` 断言（`strictPropertyInitialization` 下 TypeORM 实体的标准写法）

**`electron/main/db.ts`**（重写）

- `new DataSource({ type: 'better-sqlite3', database: <userData>/global-news.db, entities: [Note], synchronize: true, enableWAL: true })`
  - WAL 用驱动原生选项 `enableWAL`（context7 核对的官方 API），不再手动执行 PRAGMA
- 懒加载 `getDataSource()`（只 initialize 一次）
- `closeDataSource()`：`destroy()`

**`electron/main/index.ts`**（改）

- IPC 通道与 `db:status` 返回形状**不变**：`{ sqliteVersion, notes }`
  - `sqliteVersion`：`Note.query('SELECT sqlite_version() AS sqliteVersion')`
  - `notes`：`Note.count()`
- `db:note:add`：`Note.create({ content: String(content) }).save()`，返回保存后的实体
  （属性名为 `createdAt`，该通道目前无消费方，新 UI 直接消费新形状）
- `will-quit` → `closeDataSource()`

### ② 配置与依赖

- 根 `tsconfig.json` 加 `experimentalDecorators: true`——主进程经 vite-plugin-electron
  构建（Vite 8/rolldown），转译器按目录向上只找 `tsconfig.json`
- `tsconfig.node.json` 也加 `experimentalDecorators: true`——供 tsc/vue-tsc 类型检查
  `electron/` 下的 legacy 装饰器
- 两者均**不开** `emitDecoratorMetadata`（构建转译链不支持；所有列显式类型兜底）
- `dependencies` 新增：`typeorm`（实际安装 1.1.0；v1 自身依赖 reflect-metadata 并在
  `index.js` 内部 `require("reflect-metadata")`，**无需**显式依赖或手动 import）、
  `daisyui`（与 tailwindcss 同类别，保持现有归类）
- `devDependencies` 新增：`@types/node`（让 `tsc --noEmit -p tsconfig.node.json`
  可独立检查 electron 侧，此前因缺 node 类型报 TS2688）
- `pnpm-workspace.yaml` 不动（typeorm/daisyui 无构建脚本；typeorm 的
  `better-sqlite3@^12` peer 声明与实测 v13.0.3 兼容，peer 警告为良性，冒烟脚本验证）

### ③ daisyUI

- `src/style.css`：

```css
@import "tailwindcss";
@plugin "daisyui";
```

- 默认 light/dark 主题（dark 跟随 `prefers-color-scheme`），与现有 `dark:` 工具类兼容
- `App.vue`：保留 boilerplate 内容，新增 daisyUI `card`：
  - `badge` 显示 SQLite 版本与 notes 数（来自 `db:status`）
  - `input` + `btn` 调用 `db:note:add`，成功后刷新状态；失败用现有 catch 展示错误

### ④ 错误处理

DataSource 初始化失败沿 IPC 抛回渲染端，App.vue 现有 try/catch 展示，不新增机制。

### ⑤ 验证

- 依赖已安装并实测（2026-08-21）：typeorm 1.1.0（v1 API 已核对：BaseEntity
  静态方法、`enableWAL`、`datetime` 列类型均存在）、daisyui 5.7.19、
  reflect-metadata 0.2.2（typeorm 传递依赖）、@types/node 26.2.0
- `node_modules/.bin/vue-tsc --noEmit`（含 electron 侧：必要时另跑
  `tsc --noEmit -p tsconfig.node.json`，注意 composite 约束，按实际情况调整）
- `vite build` 构建通过（主进程转译含 legacy 装饰器）
- 若环境有 xvfb 则 `xvfb-run` 冒烟启动 Electron；没有则以 build+typecheck 为准
- 已知可接受行为：现有 notes 表的 `created_at` 为 `TEXT DEFAULT (datetime('now'))`，
  与实体定义（`datetime DEFAULT CURRENT_TIMESTAMP`）有差异，首次启动时
  `synchronize` 会重建表并保留数据（演示库可接受）
- README：better-sqlite3 一节改写为 TypeORM（ActiveRecord、entities、DataSource、
  显式列类型原因），Tailwind 一节补 daisyUI

## 不做（YAGNI）

- migrations（保持 `synchronize: true` 演示行为）
- 仓储/DataMapper 风格、多层 Service 抽象
- daisyUI 自定义主题配置
- 新闻领域实体（Feed/Article，待后续需求）
