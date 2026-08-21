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

- 主进程经 vite-plugin-electron（esbuild）打包；**esbuild 不支持 `emitDecoratorMetadata`**，
  也不读 `tsconfig.node.json`——esbuild 按目录向上查找的是 `tsconfig.json`。
  因此：
  - `experimentalDecorators: true` 必须加到**根 `tsconfig.json`**（esbuild 才会对
    `electron/` 下的实体类应用 legacy 装饰器语义）
  - 所有列**显式声明 `type`**，不依赖元数据推断
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

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date
}
```

- 表名显式 `notes`、列名 `created_at`，与现有表结构对应
- 全部显式类型；字段用 `!:` 断言（`strictPropertyInitialization` 下 TypeORM 实体的标准写法）

**`electron/main/db.ts`**（重写）

- `new DataSource({ type: 'better-sqlite3', database: <userData>/global-news.db, entities: [Note], synchronize: true })`
- 懒加载 `getDataSource()`（只 initialize 一次）；初始化后 `PRAGMA journal_mode = WAL`
  （用 `dataSource.query` 执行，驱动无关、行为与现状一致）
- `closeDataSource()`：`destroy()`

**`electron/main/index.ts`**（改）

- 顶部 `import 'reflect-metadata'`
- IPC 通道与 `db:status` 返回形状**不变**：`{ sqliteVersion, notes }`
  - `sqliteVersion`：`Note.query('SELECT sqlite_version() AS sqliteVersion')`
  - `notes`：`Note.count()`
- `db:note:add`：`Note.create({ content: String(content) }).save()`，返回保存后的实体
  （属性名为 `createdAt`，该通道目前无消费方，新 UI 直接消费新形状）
- `will-quit` → `closeDataSource()`

### ② 配置与依赖

- 根 `tsconfig.json`：`experimentalDecorators: true`（**不开** `emitDecoratorMetadata`）
- `dependencies` 新增：`typeorm`、`reflect-metadata`（运行时打包，规则同 better-sqlite3）、
  `daisyui`（与 tailwindcss 同类别，保持现有归类）
- `pnpm-workspace.yaml` 不动（typeorm/daisyui 无构建脚本）

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

- `node_modules/.bin/vue-tsc --noEmit`（含 electron 侧：必要时另跑
  `tsc --noEmit -p tsconfig.node.json`，注意 composite 约束，按实际情况调整）
- `vite build` 构建通过（主进程 bundling 含装饰器编译）
- 若环境有 xvfb 则 `xvfb-run` 冒烟启动 Electron；没有则以 build+typecheck 为准
- README：better-sqlite3 一节改写为 TypeORM（ActiveRecord、entities、DataSource、
  显式列类型原因），Tailwind 一节补 daisyUI

## 不做（YAGNI）

- migrations（保持 `synchronize: true` 演示行为）
- 仓储/DataMapper 风格、多层 Service 抽象
- daisyUI 自定义主题配置
- 新闻领域实体（Feed/Article，待后续需求）
