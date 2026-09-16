<script setup lang="ts">
import { ref } from 'vue'
import { Trash2 } from '@lucide/vue'
import { deepUnwrap } from '../lib/serialize'
import { sortTerms } from '../lib/sort'
import ResetPassword from './ResetPassword.vue'
import type { RulesConfig } from '../../electron/shared/types'

const emit = defineEmits<{ saved: []; reset: [] }>()

type KeywordKind = 'exact' | 'contains' | 'startsWith' | 'endsWith'

const KEYWORD_SECTIONS: { kind: KeywordKind; title: string; placeholder: string }[] = [
  { kind: 'exact', title: '完全匹配', placeholder: '表头恰好等于该词才命中（如：工号）' },
  { kind: 'contains', title: '包含', placeholder: '表头包含该词即命中（如：卡号）' },
  { kind: 'startsWith', title: '以关键词开头', placeholder: '表头以该词开头（如：手机）' },
  { kind: 'endsWith', title: '以关键词结尾', placeholder: '表头以该词结尾（如：电话）' },
]

const dialog = ref<HTMLDialogElement | null>(null)
const confirmDialog = ref<HTMLDialogElement | null>(null)
const pendingDelete = ref<{ kind: KeywordKind | 'patterns'; value: string } | null>(null)
const config = ref<RulesConfig>({ exact: [], contains: [], startsWith: [], endsWith: [], patterns: [] })
const newKeyword = ref<Record<KeywordKind, string>>({
  exact: '',
  contains: '',
  startsWith: '',
  endsWith: '',
})
const newPattern = ref('')
const oldPassword = ref('')
const newPassword = ref('')
const newPassword2 = ref('')
const loaded = ref(false)
const errorMsg = ref('')
const okMsg = ref('')

/** App 经 template ref 调用：打开弹窗并拉取最新规则（每次打开都拉，保证多次打开数据新鲜） */
async function open() {
  dialog.value?.showModal()
  loaded.value = false
  errorMsg.value = ''
  okMsg.value = ''
  try {
    const result = (await window.ipcRenderer.invoke('rules:get')) as { config: RulesConfig }
    config.value = result.config
    loaded.value = true
  } catch (err) {
    errorMsg.value = (err as Error).message
  }
}

defineExpose({ open })

/** 增删即生效：保存到主进程并通知 App 重新分析；失败则回拉主进程真实配置同步 UI */
async function applyRules() {
  errorMsg.value = ''
  try {
    await window.ipcRenderer.invoke('rules:save', deepUnwrap(config.value))
    emit('saved')
  } catch (err) {
    errorMsg.value = (err as Error).message
    const result = (await window.ipcRenderer.invoke('rules:get')) as { config: RulesConfig }
    config.value = result.config
  }
}

function addKeyword(kind: KeywordKind) {
  const v = newKeyword.value[kind].trim()
  if (!v) return
  if (!config.value[kind].includes(v)) {
    config.value[kind].push(v)
    applyRules()
  }
  newKeyword.value[kind] = ''
}

/** 点删除不直接生效：先弹确认框 */
function askDelete(kind: KeywordKind | 'patterns', value: string) {
  pendingDelete.value = { kind, value }
  confirmDialog.value?.showModal()
}

/** 确认删除：按值从对应数组移除（列表经排序展示，索引与数组不对应，故按值定位；各类内已去重）并立即生效 */
function confirmDelete() {
  const target = pendingDelete.value
  if (target) {
    config.value[target.kind] = config.value[target.kind].filter((v) => v !== target.value)
    applyRules()
  }
  pendingDelete.value = null
  confirmDialog.value?.close()
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
  if (!config.value.patterns.includes(v)) {
    config.value.patterns.push(v)
    applyRules()
  }
  newPattern.value = ''
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

/** 确认重置密码：先关弹窗再通知 App 切回设置密码流程 */
function onReset() {
  dialog.value?.close()
  emit('reset')
}
</script>

<template>
  <dialog ref="dialog" class="modal">
    <div class="modal-box flex max-h-[85vh] max-w-2xl flex-col">
      <div class="shrink-0 space-y-4">
        <h3 class="text-lg font-bold">设置</h3>
        <div v-if="errorMsg" class="alert alert-error">{{ errorMsg }}</div>
        <div v-if="okMsg" class="alert alert-success">{{ okMsg }}</div>
      </div>

      <div class="mt-4 min-h-0 flex-1 space-y-4 overflow-y-auto">
        <template v-if="loaded">
          <div class="card bg-base-200">
            <div class="card-body">
              <h2 class="card-title">表头关键词</h2>
              <p class="text-xs opacity-60">增删立即生效，无需保存</p>
              <div v-for="section in KEYWORD_SECTIONS" :key="section.kind" class="space-y-1">
                <h3 class="text-sm font-semibold">{{ section.title }}</h3>
                <div class="join w-full">
                  <input
                    v-model="newKeyword[section.kind]"
                    class="input input-bordered input-sm join-item w-full"
                    :placeholder="section.placeholder"
                    @keyup.enter="addKeyword(section.kind)"
                  >
                  <button class="btn btn-soft btn-sm join-item" @click="addKeyword(section.kind)">添加</button>
                </div>
                <div
                  class="max-h-40 overflow-y-auto rounded-box border border-base-300 bg-base-100"
                >
                  <div v-if="!config[section.kind].length" class="px-3 py-2 text-sm opacity-50">
                    暂无
                  </div>
                  <div
                    v-for="kw in sortTerms(config[section.kind])"
                    :key="kw"
                    class="group flex items-center justify-between gap-2 px-3 py-1 hover:bg-base-200"
                  >
                    <span class="truncate">{{ kw }}</span>
                    <button
                      class="btn btn-ghost btn-xs shrink-0 text-error opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                      :aria-label="`删除关键词 ${kw}`"
                      @click="askDelete(section.kind, kw)"
                    >
                      <Trash2 class="size-4" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="card bg-base-200">
            <div class="card-body">
              <h2 class="card-title">内容正则（高级）</h2>
              <p class="text-xs opacity-60">对每列前 50 行内容抽样匹配，命中即整列自动勾选</p>
              <div class="join w-full">
                <input
                  v-model="newPattern"
                  class="input input-bordered input-sm join-item w-full font-mono"
                  placeholder="如：^ORD-\d+$"
                  @keyup.enter="addPattern"
                >
                <button class="btn btn-soft btn-sm join-item" @click="addPattern">添加</button>
              </div>
              <div class="max-h-40 overflow-y-auto rounded-box border border-base-300 bg-base-100">
                <div v-if="!config.patterns.length" class="px-3 py-2 text-sm opacity-50">
                  暂无
                </div>
                <div
                  v-for="p in sortTerms(config.patterns)"
                  :key="p"
                  class="group flex items-center justify-between gap-2 px-3 py-1 hover:bg-base-200"
                >
                  <span class="truncate font-mono">{{ p }}</span>
                  <button
                    class="btn btn-ghost btn-xs shrink-0 text-error opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                    :aria-label="`删除正则 ${p}`"
                    @click="askDelete('patterns', p)"
                  >
                    <Trash2 class="size-4" />
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div class="card bg-base-200">
            <div class="card-body">
              <h2 class="card-title">修改密码</h2>
              <div class="alert alert-warning text-sm">
                注意：修改密码后，此前用旧密码脱敏的所有文件将无法再还原。请先还原所有文件，再修改密码。
              </div>
              <input v-model="oldPassword" type="password" class="input input-bordered input-sm w-full" placeholder="原密码">
              <input v-model="newPassword" type="password" class="input input-bordered input-sm w-full" placeholder="新密码">
              <input v-model="newPassword2" type="password" class="input input-bordered input-sm w-full" placeholder="确认新密码">
              <div class="flex items-center justify-between">
                <button class="btn btn-warning btn-sm" @click="submitChangePassword">修改密码</button>
                <ResetPassword label="忘记原密码？重置" @reset="onReset" />
              </div>
            </div>
          </div>
        </template>
        <div v-else class="flex justify-center p-8">
          <span class="loading loading-spinner loading-lg" />
        </div>
      </div>

      <div class="modal-action shrink-0">
        <button class="btn" @click="dialog?.close()">关闭</button>
      </div>
    </div>
  </dialog>

  <dialog ref="confirmDialog" class="modal">
    <div class="modal-box">
      <h3 class="text-lg font-bold">确认删除</h3>
      <p class="py-4">
        确认删除{{ pendingDelete?.kind === 'patterns' ? '正则' : '关键词' }}「{{ pendingDelete?.value }}」？
      </p>
      <div class="modal-action">
        <button class="btn" @click="confirmDialog?.close()">取消</button>
        <button class="btn btn-error" @click="confirmDelete()">删除</button>
      </div>
    </div>
    <form method="dialog" class="modal-backdrop"><button>取消</button></form>
  </dialog>
</template>
