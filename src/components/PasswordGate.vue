<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{ mode: 'setup' | 'unlock' }>()
const emit = defineEmits<{ ready: [] }>()

const password = ref('')
const confirmPassword = ref('')
const errorMsg = ref('')
const busy = ref(false)

async function submit() {
  errorMsg.value = ''
  if (!password.value) {
    errorMsg.value = '请输入密码'
    return
  }
  if (props.mode === 'setup' && password.value !== confirmPassword.value) {
    errorMsg.value = '两次输入的密码不一致'
    return
  }
  busy.value = true
  try {
    if (props.mode === 'setup') {
      await window.ipcRenderer.invoke('app:set-password', password.value)
    } else {
      await window.ipcRenderer.invoke('app:unlock', password.value)
    }
    emit('ready')
  } catch (err) {
    errorMsg.value = (err as Error).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="card mx-auto max-w-sm bg-base-100 shadow-xl">
    <div class="card-body">
      <h2 class="card-title">{{ mode === 'setup' ? '首次使用：设置主密码' : '解锁' }}</h2>
      <p v-if="mode === 'setup'" class="text-sm opacity-70">
        该密码用于所有报表的脱敏与还原，请务必牢记。密码经系统安全存储（Windows DPAPI）保存，不明文落盘。
      </p>
      <p v-else class="text-sm opacity-70">
        无法从系统安全存储取回密码（可能更换了机器或系统用户），请重新输入主密码。
      </p>
      <input
        v-model="password"
        type="password"
        class="input input-bordered w-full"
        placeholder="密码"
        @keyup.enter="submit"
      >
      <input
        v-if="mode === 'setup'"
        v-model="confirmPassword"
        type="password"
        class="input input-bordered w-full"
        placeholder="确认密码"
        @keyup.enter="submit"
      >
      <div v-if="errorMsg" class="alert alert-error text-sm">{{ errorMsg }}</div>
      <button class="btn btn-primary" :disabled="busy" @click="submit">
        <span v-if="busy" class="loading loading-spinner loading-xs" />
        {{ mode === 'setup' ? '设置并进入' : '解锁' }}
      </button>
    </div>
  </div>
</template>
