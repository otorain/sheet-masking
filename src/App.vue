<script setup lang="ts">
import { onMounted, ref } from 'vue'
import HelloWorld from './components/HelloWorld.vue'

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
</script>

<template>
  <div>
    <a href="https://www.electronjs.org/" target="_blank">
      <img src="./assets/electron.svg" class="logo electron" alt="Electron logo" />
    </a>
    <a href="https://vitejs.dev/" target="_blank">
      <img src="./assets/vite.svg" class="logo" alt="Vite logo" />
    </a>
    <a href="https://vuejs.org/" target="_blank">
      <img src="./assets/vue.svg" class="logo vue" alt="Vue logo" />
    </a>
  </div>
  <HelloWorld msg="Electron + Vite + Vue" />
  <div class="flex-center">
    Place static files into the <code>/public</code> folder
    <img style="width: 2.4em; margin-left: .4em;" src="/logo.svg" alt="Logo">
  </div>
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
</template>

<style>
.flex-center {
  display: flex;
  align-items: center;
  justify-content: center;
}

.logo {
  height: 6em;
  padding: 1.5em;
  will-change: filter;
  transition: filter 300ms;
}

.logo.electron:hover {
  filter: drop-shadow(0 0 2em #9FEAF9);
}

.logo:hover {
  filter: drop-shadow(0 0 2em #646cffaa);
}

.logo.vue:hover {
  filter: drop-shadow(0 0 2em #42b883aa);
}
</style>
