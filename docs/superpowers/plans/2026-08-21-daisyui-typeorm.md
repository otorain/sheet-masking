# daisyUI + TypeORM 集成实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 TypeORM v1（ActiveRecord 风格）全面接管主进程数据访问，并接入 daisyUI 5 重构演示界面。

**Architecture:** 主进程经 vite-plugin-electron `notBundle()` 逐文件 esbuild 转译，依赖保持外部引用。`electron/main/entities/Note.ts` 定义装饰器实体（全显式列类型），`electron/main/db.ts` 封装懒加载 DataSource（better-sqlite3 驱动），IPC 层改用 ActiveRecord 调用，通道与 `db:status` 返回形状不变。daisyUI 经 Tailwind v4 的 `@plugin` 指令接入，App.vue 新增 notes 卡片演示完整链路。

**Tech Stack:** Electron 42 / Vue 3 / Vite 8 / pnpm 11.3.0 / typeorm 1.1.0 / better-sqlite3 13.0.3 / daisyui 5.7.19 / Tailwind CSS v4

## Global Constraints

- 依赖已安装（2026-08-21）：`typeorm@1.1.0`、`daisyui@5.7.19`（dependencies），`@types/node@26.2.0`（devDependencies），外加误装待删的 `reflect-metadata`
- **不开** `emitDecoratorMetadata`（esbuild 不支持）；所有列显式声明 `type`
- `experimentalDecorators: true` 同时加到根 `tsconfig.json`（esbuild 转译 electron/ 用）和 `tsconfig.node.json`（类型检查用）
- IPC 通道名不变：`db:status` / `db:note:add`；`db:status` 返回形状不变：`{ sqliteVersion, notes }`
- `reflect-metadata` 不做显式依赖、不手动 import（typeorm v1 自身依赖它并在 `index.js` 内 `require("reflect-metadata")`）
- typeorm 声明 `better-sqlite3@^12` peer（optional），实测 v13.0.3 兼容；peer 警告良性，Task 1 冒烟脚本为最终判定
- 项目无测试框架、无 xvfb：验证 = `tsc`/`vue-tsc` 类型检查 + `vite build` + Node 数据层冒烟脚本
- 提交信息用英文 conventional commits（与 git log 现有风格一致）

---

### Task 1: TypeORM 接管数据层（ActiveRecord）

**Files:**
- Modify: `package.json`（移除误装的 reflect-metadata）
- Create: `electron/main/entities/Note.ts`
- Modify: `electron/main/db.ts`（整体重写）
- Modify: `electron/main/index.ts:6`（import）与 `electron/main/index.ts:89-113`（IPC 段）
- Modify: `tsconfig.json`（compilerOptions 加 experimentalDecorators）
- Modify: `tsconfig.node.json`（同上）

**Interfaces:**
- Consumes: 现有 `window.ipcRenderer.invoke('db:status'|'db:note:add', content)`（preload 不变）
- Produces:
  - `getDataSource(): Promise<DataSource>`（`electron/main/db.ts`，懒加载单例）
  - `closeDataSource(): Promise<void>`
  - `Note extends BaseEntity`：`{ id: number; content: string; createdAt: Date }`，表名 `notes`，列 `created_at`
  - IPC `db:status` → `{ sqliteVersion: string; notes: number }`；`db:note:add` → 保存后的 Note 实体（`{ id, content, createdAt }`）

- [ ] **Step 1: 移除误装的 reflect-metadata**

typeorm v1 自身依赖并在内部加载它，我们的代码不 import 它：

```bash
pnpm remove reflect-metadata
```

Expected: package.json dependencies 中不再有 reflect-metadata（typeorm/daisyui 保留）

- [ ] **Step 2: 两个 tsconfig 加 experimentalDecorators**

`tsconfig.json` — 在 `"target": "ESNext",` 后加一行：

```json
    "target": "ESNext",
    "experimentalDecorators": true,
```

`tsconfig.node.json` — 在 `"composite": true,` 后加一行：

```json
    "composite": true,
    "experimentalDecorators": true,
```

注意：**不要**加 `emitDecoratorMetadata`。

- [ ] **Step 3: 创建 Note 实体**

Create `electron/main/entities/Note.ts`：

```ts
import {
  BaseEntity,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm'

// NOTE: the main process is transpiled per-file by esbuild (vite-plugin-electron
// notBundle), which does not support emitDecoratorMetadata — every column type
// must therefore be declared explicitly.
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

- [ ] **Step 4: 重写 db.ts 为 DataSource 封装**

Replace entire `electron/main/db.ts`：

```ts
import { app } from 'electron'
import path from 'node:path'
import { DataSource } from 'typeorm'
import { Note } from './entities/Note.js'

let dataSource: DataSource | null = null

/**
 * Lazily creates and initializes the TypeORM DataSource backed by
 * better-sqlite3 (native module, main process only). The database file lives
 * in the app's `userData` directory; schema is auto-synchronized (demo) and
 * WAL mode is enabled via the driver's `enableWAL` option.
 */
export async function getDataSource(): Promise<DataSource> {
  if (!dataSource) {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: path.join(app.getPath('userData'), 'global-news.db'),
      entities: [Note],
      synchronize: true,
      enableWAL: true,
    })
    await dataSource.initialize()
  }
  return dataSource
}

export async function closeDataSource(): Promise<void> {
  await dataSource?.destroy()
  dataSource = null
}
```

- [ ] **Step 5: 改写 index.ts 的 import 与 IPC 段**

`electron/main/index.ts:6`：

```ts
// 旧
import { getDb, closeDb } from './db.js'
// 新
import { getDataSource, closeDataSource } from './db.js'
import { Note } from './entities/Note.js'
```

`electron/main/index.ts:89-113`（整段替换）：

```ts
// --------- TypeORM demo (main process only) ---------
// better-sqlite3 is a native module and lives in the main process; the
// renderer talks to it over IPC. Active Record style: Note extends BaseEntity.
ipcMain.handle('db:status', async () => {
  await getDataSource()
  const [{ sqliteVersion }] = (await Note.query(
    'SELECT sqlite_version() AS sqliteVersion',
  )) as { sqliteVersion: string }[]
  const notes = await Note.count()
  return { sqliteVersion, notes }
})

ipcMain.handle('db:note:add', async (_event, content: unknown) => {
  await getDataSource()
  return Note.create({ content: String(content) }).save()
})

app.on('will-quit', () => {
  void closeDataSource()
})
```

- [ ] **Step 6: 类型检查**

```bash
node_modules/.bin/tsc --noEmit -p tsconfig.node.json && node_modules/.bin/vue-tsc --noEmit
```

Expected: 均无输出、exit 0。常见错误对照：
- 报装饰器相关错误（提示需要启用 experimentalDecorators）→ 检查 Step 2 两个
  tsconfig 是否都加了该标志
- `Column type ... cannot be guessed` 是运行时错误，类型检查阶段不会出现

- [ ] **Step 7: 构建验证（esbuild 转译 legacy 装饰器）**

```bash
npx vite build
```

Expected: exit 0，且 `dist-electron/main/entities/Note.js` 存在：

```bash
ls dist-electron/main/entities/Note.js
```

- [ ] **Step 8: 数据层运行时冒烟（无 Electron、无 GUI）**

用构建产物 + 临时库文件直接验证：装饰器元数据、typeorm 1.1 与 better-sqlite3@13 兼容、enableWAL、ActiveRecord 增查：

```bash
rm -f /tmp/opencode/typeorm-smoke.db* && node --input-type=module -e "
import { DataSource } from 'typeorm'
import { Note } from './dist-electron/main/entities/Note.js'
const ds = new DataSource({
  type: 'better-sqlite3',
  database: '/tmp/opencode/typeorm-smoke.db',
  entities: [Note],
  synchronize: true,
  enableWAL: true,
})
await ds.initialize()
const note = await Note.create({ content: 'smoke' }).save()
const count = await Note.count()
const version = await Note.query('SELECT sqlite_version() AS v')
const wal = await Note.query('PRAGMA journal_mode')
console.log(JSON.stringify({ id: note.id, hasCreatedAt: note.createdAt != null, count, sqlite: version[0].v, journalMode: wal[0].journal_mode }))
await ds.destroy()
" && rm -f /tmp/opencode/typeorm-smoke.db*
```

Expected（判定标准）：输出 JSON 且 `"count":1`、`"journalMode":"wal"`、`"id":1`、`"hasCreatedAt":true`。
若报 `CannotDetermineGraphError` / 装饰器相关 / `better-sqlite3` 加载错误 → 停止并回查 Step 2/3/7，**不得**带着失败进入 Task 2。

- [ ] **Step 9: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json tsconfig.node.json electron/main/entities/Note.ts electron/main/db.ts electron/main/index.ts
git commit -m "feat: replace raw better-sqlite3 access with TypeORM (Active Record)"
```

注：package.json/pnpm-lock.yaml 在计划阶段已集中安装依赖（typeorm、daisyui、
@types/node），lockfile 无法按功能拆分，故全部依赖改动随本提交落地（提交正文
可附一句说明）；Task 2 的提交因此只含 src 文件。

---

### Task 2: daisyUI 接入 + 演示界面改造

**Files:**
- Modify: `src/style.css`
- Modify: `src/App.vue`（script 段 5-15 行与 template 段 35-36 行）

**Interfaces:**
- Consumes: Task 1 的 IPC `db:status` / `db:note:add`（形状见 Task 1 Produces）
- Produces: 无新接口；UI 消费 `{ sqliteVersion, notes }` 与 Note 实体的 `id`/`content`

- [ ] **Step 1: style.css 注册 daisyUI 插件**

Replace entire `src/style.css`：

```css
@import "tailwindcss";
@plugin "daisyui";
```

- [ ] **Step 2: 改造 App.vue**

`src/App.vue` script 段 — 替换 5-15 行（`// better-sqlite3 runs...` 到 `})`）：

```ts
// TypeORM (better-sqlite3) runs in the main process; the renderer talks to it
// over IPC (see electron/main/index.ts).
const dbStatus = ref('connecting…')
const newNote = ref('')
const lastAdded = ref('')

async function refreshStatus() {
  try {
    const status = await window.ipcRenderer.invoke('db:status')
    dbStatus.value = `SQLite ${status.sqliteVersion} · ${status.notes} notes in DB`
  } catch (error) {
    dbStatus.value = `DB error: ${(error as Error).message}`
  }
}

async function addNote() {
  const content = newNote.value.trim()
  if (!content) return
  try {
    const note = await window.ipcRenderer.invoke('db:note:add', content)
    lastAdded.value = `added #${note.id}: ${note.content}`
    newNote.value = ''
    await refreshStatus()
  } catch (error) {
    lastAdded.value = `add failed: ${(error as Error).message}`
  }
}

onMounted(refreshStatus)
```

`src/App.vue` template 段 — 替换 35-36 行（`<!-- Tailwind demo... -->` 与 `<p ...>{{ dbStatus }}</p>`）：

```html
  <!-- daisyUI demo: card + badge + input + button -->
  <div class="card mx-auto mt-8 w-full max-w-sm bg-base-200 shadow-xl">
    <div class="card-body items-center text-center">
      <h2 class="card-title">Notes</h2>
      <div class="badge badge-outline">{{ dbStatus }}</div>
      <div class="join mt-4 w-full">
        <input
          v-model="newNote"
          class="input input-bordered join-item w-full"
          placeholder="Write a note…"
          @keyup.enter="addNote"
        >
        <button class="btn btn-primary join-item" :disabled="!newNote.trim()" @click="addNote">Add</button>
      </div>
      <p v-if="lastAdded" class="mt-2 text-sm opacity-70">{{ lastAdded }}</p>
    </div>
  </div>
```

`<style>` 块（39-64 行）不动。

- [ ] **Step 3: 验证**

```bash
node_modules/.bin/vue-tsc --noEmit && npx vite build
```

Expected: exit 0；`dist/assets/*.css` 中包含 daisyUI 组件类（可 `grep -l "card-body" dist/assets/*.css` 确认生成）

- [ ] **Step 4: Commit**

```bash
git add src/style.css src/App.vue
git commit -m "feat: add daisyUI and rebuild the demo UI with its components"
```

（daisyui 依赖改动已随 Task 1 提交，此处只含两个 src 文件；用 `git status`
确认暂存内容后再提交。）

---

### Task 3: README 与 spec 文档更新

**Files:**
- Modify: `README.md`（33-43 行 Tailwind 一节、45-68 行 better-sqlite3 一节）

**Interfaces:**
- Consumes: Task 1/2 已验证的事实（含 peer 兼容结论、reflect-metadata 内置结论）
- Produces: 无

- [ ] **Step 1: 替换 README 的 Tailwind 一节（33-43 行）**

```md
## Tailwind CSS (v4) + daisyUI

Tailwind CSS v4 is wired up through the official Vite plugin:

- `tailwindcss` + `@tailwindcss/vite` are in `dependencies`
- the plugin is registered in `vite.config.ts`
- `src/style.css` only contains `@import "tailwindcss";` and
  `@plugin "daisyui";` — utilities, daisyUI components, the theme and the
  preflight reset are generated at build time

Start using utility classes directly in any Vue template, e.g.
`class="mt-8 text-slate-500 dark:text-slate-400"`. daisyUI adds semantic
component classes (`btn`, `card`, `badge`, `input`, …) with light and dark
themes out of the box — see `src/App.vue` for a demo.
```

- [ ] **Step 2: 替换 README 的 better-sqlite3 一节（45-68 行）**

```md
## TypeORM (better-sqlite3)

TypeORM runs in the **main process only** (its driver is a native module and
the renderer is sandboxed). The integration uses the Active Record pattern:

- `electron/main/entities/Note.ts` — the `Note` entity (`extends BaseEntity`)
  mapped to the `notes` table. Every column declares its `type` explicitly
  because the main process is transpiled by esbuild, which does not support
  `emitDecoratorMetadata`
- `electron/main/db.ts` — lazily initializes the `DataSource`
  (`better-sqlite3` driver, `global-news.db` in `userData`,
  `synchronize: true`, `enableWAL: true`) and destroys it on `will-quit`
- `electron/main/index.ts` — exposes two IPC handlers: `db:status` and
  `db:note:add`, implemented with Active Record calls (`Note.count()`,
  `Note.create(...).save()`)
- `src/App.vue` — renderer demo that calls both over IPC

Notes:

- better-sqlite3 v13 ships ABI-stable N-API prebuilds, so no source
  compilation is needed for Electron; `postinstall` still runs
  `electron-builder install-app-deps` to rebuild any future native modules
  against the Electron ABI. (typeorm 1.x declares a `better-sqlite3@^12`
  peer range; v13 is API-compatible — the peer warning is benign.)
- pnpm 11 denies dependency build scripts unless they are explicitly allowed;
  see `allowBuilds` in `pnpm-workspace.yaml`.
- `better-sqlite3` and `typeorm` must stay in `dependencies` (not
  `devDependencies`) so `electron-builder` packages them with the app.
  `reflect-metadata` needs no explicit entry: typeorm v1 depends on it and
  loads it internally.
- `experimentalDecorators: true` is set in both `tsconfig.json` (esbuild
  transpiles `electron/` per file and reads the nearest `tsconfig.json`) and
  `tsconfig.node.json` (type checking). `emitDecoratorMetadata` stays off.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: update README for TypeORM and daisyUI"
```
