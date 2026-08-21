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

## Tailwind CSS (v4)

Tailwind CSS v4 is wired up through the official Vite plugin:

- `tailwindcss` + `@tailwindcss/vite` are in `dependencies`
- the plugin is registered in `vite.config.ts`
- `src/style.css` only contains `@import "tailwindcss";` — utilities, the
  theme and the preflight reset are generated at build time

Start using utility classes directly in any Vue template, e.g.
`class="mt-8 text-slate-500 dark:text-slate-400"`.

## better-sqlite3

`better-sqlite3` runs in the **main process only** (it is a native module and
the renderer is sandboxed). The integration is:

- `electron/main/db.ts` — lazily opens `global-news.db` in the app's
  `userData` directory and creates a `notes` table (WAL mode)
- `electron/main/index.ts` — exposes two IPC handlers: `db:status` and
  `db:note:add`; the database is closed on `will-quit`
- `src/App.vue` — renderer demo that calls `db:status` over IPC

Notes:

- better-sqlite3 v13 ships ABI-stable N-API prebuilds, so no source
  compilation is needed for Electron; `postinstall` still runs
  `electron-builder install-app-deps` to rebuild any future native modules
  against the Electron ABI.
- pnpm 11 denies dependency build scripts unless they are explicitly allowed;
  see `allowBuilds` in `pnpm-workspace.yaml`.
- `better-sqlite3` must stay in `dependencies` (not `devDependencies`) so
  `electron-builder` packages it with the app.

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
