<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { CircleAlert, Settings } from '@lucide/vue'
import PasswordGate from './components/PasswordGate.vue'
import MainFlow from './components/MainFlow.vue'
import SettingsDialog from './components/SettingsDialog.vue'

type View = 'loading' | 'gate-setup' | 'gate-unlock' | 'main'
const view = ref<View>('loading')
const errorMsg = ref('')
const settingsDialog = ref<InstanceType<typeof SettingsDialog> | null>(null)
const mainFlow = ref<InstanceType<typeof MainFlow> | null>(null)

onMounted(async () => {
  try {
    const state = (await window.ipcRenderer.invoke('app:state')) as string
    view.value = state === 'setup' ? 'gate-setup' : state === 'unlocked' ? 'main' : 'gate-unlock'
  } catch (err) {
    errorMsg.value = `初始化失败：${(err as Error).message}`
  }
})

function openSettings() {
  settingsDialog.value?.open()
}

/** 规则保存成功且有变化 → 用新规则重新分析当前已选文件（未选文件时 MainFlow 内部直接返回） */
function onRulesSaved() {
  mainFlow.value?.reloadAnalysis()
}
</script>

<template>
  <div class="min-h-screen bg-base-200 p-6">
    <div class="mx-auto max-w-4xl">
      <div class="mb-4 flex items-center justify-between">
        <h1 class="text-xl font-bold">报表脱敏工具</h1>
        <button v-if="view === 'main'" class="btn btn-sm" @click="openSettings">
          <Settings class="size-4" />
          设置
        </button>
      </div>
      <div v-if="errorMsg" class="alert alert-error mb-4">
        <CircleAlert class="size-5 shrink-0" />
        <span>{{ errorMsg }}</span>
      </div>
      <PasswordGate v-if="view === 'gate-setup'" mode="setup" @ready="view = 'main'" />
      <PasswordGate
        v-else-if="view === 'gate-unlock'"
        mode="unlock"
        @ready="view = 'main'"
        @reset="view = 'gate-setup'"
      />
      <MainFlow v-else-if="view === 'main'" ref="mainFlow" />
      <div v-else class="flex justify-center p-12">
        <span class="loading loading-spinner loading-lg" />
      </div>
    </div>
    <SettingsDialog ref="settingsDialog" @saved="onRulesSaved" @reset="view = 'gate-setup'" />
  </div>
</template>
