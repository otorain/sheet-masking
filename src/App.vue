<script setup lang="ts">
import { onMounted, ref } from 'vue'
import PasswordGate from './components/PasswordGate.vue'
import MainFlow from './components/MainFlow.vue'
import SettingsView from './components/SettingsView.vue'

type View = 'loading' | 'gate-setup' | 'gate-unlock' | 'main' | 'settings'
const view = ref<View>('loading')
const errorMsg = ref('')

onMounted(async () => {
  try {
    const state = (await window.ipcRenderer.invoke('app:state')) as string
    view.value = state === 'setup' ? 'gate-setup' : state === 'unlocked' ? 'main' : 'gate-unlock'
  } catch (err) {
    errorMsg.value = `初始化失败：${(err as Error).message}`
  }
})
</script>

<template>
  <div class="min-h-screen bg-base-200 p-6">
    <div class="mx-auto max-w-4xl">
      <div class="mb-4 flex items-center justify-between">
        <h1 class="text-xl font-bold">报表脱敏工具</h1>
        <div v-if="view === 'main' || view === 'settings'" class="join">
          <button
            class="btn btn-sm join-item"
            :class="{ 'btn-active': view === 'main' }"
            @click="view = 'main'"
          >
            脱敏
          </button>
          <button
            class="btn btn-sm join-item"
            :class="{ 'btn-active': view === 'settings' }"
            @click="view = 'settings'"
          >
            设置
          </button>
        </div>
      </div>
      <div v-if="errorMsg" class="alert alert-error mb-4">{{ errorMsg }}</div>
      <PasswordGate v-if="view === 'gate-setup'" mode="setup" @ready="view = 'main'" />
      <PasswordGate v-else-if="view === 'gate-unlock'" mode="unlock" @ready="view = 'main'" @reset="view = 'gate-setup'" />
      <MainFlow v-else-if="view === 'main'" />
      <SettingsView v-else-if="view === 'settings'" @reset="view = 'gate-setup'" />
      <div v-else class="flex justify-center p-12">
        <span class="loading loading-spinner loading-lg" />
      </div>
    </div>
  </div>
</template>
