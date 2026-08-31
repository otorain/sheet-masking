<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import type { BuiltinRule, RulesConfig } from '../../electron/shared/types'

const builtins = ref<BuiltinRule[]>([])
const enabled = reactive<Record<string, boolean>>({})
const customKeywords = ref<string[]>([])
const customPatterns = ref<string[]>([])
const newKeyword = ref('')
const newPattern = ref('')
const oldPassword = ref('')
const newPassword = ref('')
const newPassword2 = ref('')
const loaded = ref(false)
const errorMsg = ref('')
const okMsg = ref('')

onMounted(async () => {
  try {
    const result = (await window.ipcRenderer.invoke('rules:get')) as {
      config: RulesConfig
      builtins: BuiltinRule[]
    }
    builtins.value = result.builtins
    for (const b of result.builtins) enabled[b.id] = !result.config.disabledBuiltins.includes(b.id)
    customKeywords.value = [...result.config.customKeywords]
    customPatterns.value = [...result.config.customPatterns]
    loaded.value = true
  } catch (err) {
    errorMsg.value = (err as Error).message
  }
})

function addKeyword() {
  const v = newKeyword.value.trim()
  if (v && !customKeywords.value.includes(v)) customKeywords.value.push(v)
  newKeyword.value = ''
}

function addPattern() {
  const v = newPattern.value.trim()
  if (!v) return
  try {
    new RegExp(v)
  } catch {
    errorMsg.value = `无效正则：${v}`
    return
  }
  if (!customPatterns.value.includes(v)) customPatterns.value.push(v)
  newPattern.value = ''
}

async function saveRules() {
  errorMsg.value = ''
  okMsg.value = ''
  try {
    const config: RulesConfig = {
      disabledBuiltins: builtins.value.filter((b) => !enabled[b.id]).map((b) => b.id),
      customKeywords: customKeywords.value,
      customPatterns: customPatterns.value,
    }
    await window.ipcRenderer.invoke('rules:save', config)
    okMsg.value = '规则已保存'
  } catch (err) {
    errorMsg.value = (err as Error).message
  }
}

async function submitChangePassword() {
  errorMsg.value = ''
  okMsg.value = ''
  if (!oldPassword.value || !newPassword.value) {
    errorMsg.value = '请输入原密码和新密码'
    return
  }
  if (newPassword.value !== newPassword2.value) {
    errorMsg.value = '两次输入的新密码不一致'
    return
  }
  try {
    await window.ipcRenderer.invoke('app:change-password', oldPassword.value, newPassword.value)
    oldPassword.value = ''
    newPassword.value = ''
    newPassword2.value = ''
    okMsg.value = '密码已修改'
  } catch (err) {
    errorMsg.value = (err as Error).message
  }
}
</script>

<template>
  <div v-if="loaded" class="space-y-4">
    <div v-if="errorMsg" class="alert alert-error">{{ errorMsg }}</div>
    <div v-if="okMsg" class="alert alert-success">{{ okMsg }}</div>

    <div class="card bg-base-100 shadow">
      <div class="card-body">
        <h2 class="card-title">内置规则</h2>
        <div class="grid grid-cols-2 gap-1">
          <label v-for="b in builtins" :key="b.id" class="flex items-center gap-2 text-sm">
            <input v-model="enabled[b.id]" type="checkbox" class="checkbox checkbox-sm">
            {{ b.label }}
          </label>
        </div>
      </div>
    </div>

    <div class="card bg-base-100 shadow">
      <div class="card-body">
        <h2 class="card-title">自定义规则</h2>
        <div class="join w-full">
          <input
            v-model="newKeyword"
            class="input input-bordered input-sm join-item w-full"
            placeholder="自定义表头关键词（如：工号）"
            @keyup.enter="addKeyword"
          >
          <button class="btn btn-sm join-item" @click="addKeyword">加关键词</button>
        </div>
        <div class="join w-full">
          <input
            v-model="newPattern"
            class="input input-bordered input-sm join-item w-full font-mono"
            placeholder="自定义内容正则（如：^ORD-\d+$）"
            @keyup.enter="addPattern"
          >
          <button class="btn btn-sm join-item" @click="addPattern">加正则</button>
        </div>
        <div class="flex flex-wrap gap-1">
          <span v-for="(kw, i) in customKeywords" :key="'kw' + i" class="badge badge-outline gap-1">
            关键词：{{ kw }}
            <button class="text-error" @click="customKeywords.splice(i, 1)">✕</button>
          </span>
          <span v-for="(p, i) in customPatterns" :key="'re' + i" class="badge badge-outline gap-1 font-mono">
            正则：{{ p }}
            <button class="text-error" @click="customPatterns.splice(i, 1)">✕</button>
          </span>
        </div>
        <button class="btn btn-primary btn-sm self-end" @click="saveRules">保存规则</button>
      </div>
    </div>

    <div class="card bg-base-100 shadow">
      <div class="card-body">
        <h2 class="card-title">修改密码</h2>
        <div class="alert alert-warning text-sm">
          注意：修改密码后，此前用旧密码脱敏的所有文件将无法再还原。请先还原所有文件，再修改密码。
        </div>
        <input v-model="oldPassword" type="password" class="input input-bordered input-sm w-full" placeholder="原密码">
        <input v-model="newPassword" type="password" class="input input-bordered input-sm w-full" placeholder="新密码">
        <input v-model="newPassword2" type="password" class="input input-bordered input-sm w-full" placeholder="确认新密码">
        <button class="btn btn-warning btn-sm self-end" @click="submitChangePassword">修改密码</button>
      </div>
    </div>
  </div>
  <div v-else class="flex justify-center p-12">
    <span class="loading loading-spinner loading-lg" />
  </div>
</template>
