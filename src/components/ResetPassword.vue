<script setup lang="ts">
import { ref } from 'vue'

defineProps<{ label: string }>()
const emit = defineEmits<{ reset: [] }>()

const dialog = ref<HTMLDialogElement | null>(null)
const busy = ref(false)
const errorMsg = ref('')

async function confirmReset() {
  busy.value = true
  errorMsg.value = ''
  try {
    await window.ipcRenderer.invoke('app:reset-password')
    dialog.value?.close()
    emit('reset')
  } catch (err) {
    errorMsg.value = (err as Error).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <button type="button" class="link link-hover text-sm opacity-70" @click="dialog?.showModal()">
    {{ label }}
  </button>
  <dialog ref="dialog" class="modal">
    <div class="modal-box">
      <h3 class="text-lg font-bold">确认重置密码？</h3>
      <p class="py-4 text-sm">
        重置后需要重新设置主密码。<span class="font-semibold text-error">此前用旧密码脱敏的所有文件将无法再还原。</span>自定义规则会保留。
      </p>
      <div v-if="errorMsg" class="alert alert-error mb-3 text-sm">{{ errorMsg }}</div>
      <div class="modal-action">
        <button class="btn btn-ghost" :disabled="busy" @click="dialog?.close()">取消</button>
        <button class="btn btn-error" :disabled="busy" @click="confirmReset">
          <span v-if="busy" class="loading loading-spinner loading-xs" />
          确认重置
        </button>
      </div>
    </div>
    <form method="dialog" class="modal-backdrop">
      <button>关闭</button>
    </form>
  </dialog>
</template>
