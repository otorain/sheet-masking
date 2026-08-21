# electron-vite-vue

🥳 Really simple `Electron` + `Vue` + `Vite` boilerplate.

[![GitHub Build](https://github.com/electron-vite/electron-vite-vue/actions/workflows/build.yml/badge.svg)](https://github.com/electron-vite/electron-vite-vue/actions/workflows/build.yml)
[![GitHub Discord](https://img.shields.io/badge/chat-discord-blue?logo=discord)](https://discord.gg/sRqjYpEAUK)

## Features

📦 Out of the box
🎯 Based on the official [template-vue-ts](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-vue-ts), less invasive
🌱 Extensible, really simple directory structure
💪 Support using Node.js API in Electron-Renderer
🔩 Support C/C++ native addons
🖥 It's easy to implement multiple windows

## Quick Setup

```sh
# clone the project
git clone https://github.com/electron-vite/electron-vite-vue.git

# enter the project directory
cd electron-vite-vue

# install dependency (pnpm is the package manager; pnpm-lock.yaml is committed)
pnpm install

# develop
pnpm run dev
```

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

## TypeORM (better-sqlite3)

TypeORM runs in the **main process only** (its driver is a native module and
the renderer is sandboxed). The integration uses the Active Record pattern:

- `electron/main/entities/Note.ts` — the `Note` entity (`extends BaseEntity`)
  mapped to the `notes` table. Every column declares its `type` explicitly
  because the main process is bundled by the Vite build (vite-plugin-electron),
  which does not support `emitDecoratorMetadata`
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
- `experimentalDecorators: true` is set in both `tsconfig.json` (the Vite
  build reads the nearest `tsconfig.json` when transpiling `electron/`) and
  `tsconfig.node.json` (type checking). `emitDecoratorMetadata` stays off.

## Debug

![electron-vite-react-debug.gif](https://github.com/electron-vite/electron-vite-react/blob/main/electron-vite-react-debug.gif?raw=true)

## Directory

```diff
+ ├─┬ electron
+ │ ├─┬ main
+ │ │ └── index.ts    entry of Electron-Main
+ │ └─┬ preload
+ │   └── index.ts    entry of Preload-Scripts
  ├─┬ src
  │ └── main.ts       entry of Electron-Renderer
  ├── index.html
  ├── package.json
  └── vite.config.ts
```

## Security Note

The `renderer: {}` preset in `vite.config.ts` is only a Vite adapter that polyfills Electron, Node.js APIs and native modules for the renderer process. It is not the same as enabling Node integration. If you want direct Node.js access in the renderer, enable `nodeIntegration` in the `BrowserWindow` webPreferences in the main process and review the security impact carefully.

## FAQ

- [C/C++ addons, Node.js modules - Pre-Bundling](https://github.com/electron-vite/vite-plugin-electron-renderer#dependency-pre-bundling)
- [dependencies vs devDependencies](https://github.com/electron-vite/vite-plugin-electron-renderer#dependencies-vs-devdependencies)
