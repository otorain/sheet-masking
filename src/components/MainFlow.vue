<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import {
  CircleAlert,
  CircleCheck,
  EyeOff,
  FolderOpen,
  LockKeyhole,
  LockKeyholeOpen,
} from '@lucide/vue'
import { deepUnwrap } from '../lib/serialize'
import { mergeSelections } from '../lib/selections'
import type {
  AnalyzeResult,
  ProcessMode,
  ProcessSelections,
  ProcessSummary,
  SheetAnalysis,
} from '../../electron/shared/types'

const analysis = ref<AnalyzeResult | null>(null)
/** sheet 名 → { headerRow, cols }（checkbox group 绑定 cols） */
const selections = ref<ProcessSelections>({})
const busy = ref(false)
const progress = ref<number | null>(null)
const summary = ref<ProcessSummary | null>(null)
const errorMsg = ref('')

const HEADER_ROW_OPTIONS = [1, 2, 3, 4, 5]

function autoSelections(sheets: SheetAnalysis[]): ProcessSelections {
  const map: ProcessSelections = {}
  for (const s of sheets) {
    map[s.name] = {
      headerRow: s.headerRow,
      cols: s.headers.filter((h) => h.autoSelected).map((h) => h.colIndex),
    }
  }
  return map
}

async function pickFile() {
  errorMsg.value = ''
  summary.value = null
  busy.value = true
  try {
    const result = (await window.ipcRenderer.invoke('file:analyze')) as AnalyzeResult | null
    if (!result) return
    analysis.value = result
    selections.value = autoSelections(result.sheets)
  } catch (err) {
    errorMsg.value = (err as Error).message
  } finally {
    busy.value = false
  }
}

/** 表头行下拉改选 → 重跑规则；仅重置该 sheet 的勾选，其他 sheet 保留用户手动调整 */
async function changeHeaderRow(sheetName: string, row: number) {
  if (!analysis.value) return
  const overrides: Record<string, number> = {}
  for (const s of analysis.value.sheets) overrides[s.name] = s.headerRow
  overrides[sheetName] = row
  busy.value = true
  errorMsg.value = ''
  try {
    const result = (await window.ipcRenderer.invoke(
      'file:reanalyze',
      analysis.value.filePath,
      overrides,
    )) as AnalyzeResult
    const prev = selections.value
    analysis.value = result
    const map: ProcessSelections = {}
    for (const s of result.sheets) {
      map[s.name] =
        s.name === sheetName
          ? {
              headerRow: s.headerRow,
              cols: s.headers.filter((h) => h.autoSelected).map((h) => h.colIndex),
            }
          : (prev[s.name] ?? { headerRow: s.headerRow, cols: [] })
    }
    selections.value = map
  } catch (err) {
    errorMsg.value = (err as Error).message
  } finally {
    busy.value = false
  }
}

/** 规则保存后重载当前文件（新规则即时生效）；headerRow 以当前值作 override 保留用户修正 */
async function reloadAnalysis() {
  if (!analysis.value) return
  const overrides: Record<string, number> = {}
  for (const s of analysis.value.sheets) overrides[s.name] = s.headerRow
  busy.value = true
  errorMsg.value = ''
  summary.value = null
  try {
    const next = (await window.ipcRenderer.invoke(
      'file:reanalyze',
      analysis.value.filePath,
      overrides,
    )) as AnalyzeResult
    selections.value = mergeSelections(analysis.value, next, selections.value)
    analysis.value = next
  } catch (err) {
    errorMsg.value = (err as Error).message
  } finally {
    busy.value = false
  }
}

defineExpose({ reloadAnalysis })

function selectedCount(sheetName: string): number {
  return selections.value[sheetName]?.cols.length ?? 0
}

async function run(mode: ProcessMode) {
  if (!analysis.value) return
  busy.value = true
  progress.value = 0
  summary.value = null
  errorMsg.value = ''
  try {
    const result = (await window.ipcRenderer.invoke('file:process', {
      filePath: analysis.value.filePath,
      mode,
      // selections.value 是 reactive Proxy，contextBridge 无法克隆，需深解包
      selections: deepUnwrap(selections.value),
    })) as ProcessSummary | null
    // null = 用户取消了保存对话框：什么都不发生，保留工作区状态
    if (result) {
      summary.value = result
      // 处理成功后清空工作区（文件与列勾选），只留完成提示
      analysis.value = null
      selections.value = {}
    }
  } catch (err) {
    errorMsg.value = (err as Error).message
  } finally {
    busy.value = false
    progress.value = null
  }
}

let offProgress: (() => void) | null = null
onMounted(() => {
  offProgress = window.ipcRenderer.on('file:progress', (_event, percent) => {
    progress.value = percent as number
  }) as unknown as () => void
})
onBeforeUnmount(() => offProgress?.())
</script>

<template>
  <div class="space-y-4">
    <div class="card bg-base-100 shadow">
      <div class="card-body flex-row items-center gap-3">
        <button class="btn btn-primary" :disabled="busy" @click="pickFile">
          <span v-if="busy" class="loading loading-spinner loading-xs" />
          <FolderOpen v-else class="size-4" />
          选择文件（.xlsx / .xls / .csv）
        </button>
        <span v-if="analysis" class="truncate text-sm opacity-70">{{ analysis.filePath }}</span>
      </div>
    </div>

    <div v-if="errorMsg" class="alert alert-error">
      <CircleAlert class="size-5 shrink-0" />
      <span>{{ errorMsg }}</span>
    </div>

    <!-- 处理完成后工作区已清空，提示须独立于 analysis 展示 -->
    <div v-if="summary" class="alert alert-success">
      <CircleCheck class="size-5 shrink-0" />
      <div class="flex flex-col items-start">
        <div>
          完成：处理 {{ summary.processedCells }} 个单元格，跳过
          {{ summary.skippedFormulas }} 个公式单元格
        </div>
        <div class="text-sm">输出：{{ summary.outPath }}</div>
        <div v-if="summary.failedCells.length" class="text-sm">
          {{ summary.failedCells.length }} 个单元格还原失败（文件在加密后可能被编辑/损坏）：
          {{ summary.failedCells.join('、') }}
        </div>
      </div>
    </div>

    <template v-if="analysis">
      <div
        v-for="sheet in analysis.sheets"
        :key="sheet.name"
        class="collapse collapse-arrow bg-base-100 shadow"
      >
        <input type="checkbox" checked>
        <div class="collapse-title flex items-center gap-2 font-medium">
          {{ sheet.name }}
          <span v-if="sheet.hidden" class="badge badge-warning badge-sm gap-1">
            <EyeOff class="size-3" />
            隐藏 sheet
          </span>
          <span class="badge badge-ghost badge-sm">
            已选 {{ selectedCount(sheet.name) }}/{{ sheet.headers.length }} 列
          </span>
        </div>
        <div class="collapse-content">
          <label class="mb-2 flex items-center gap-2 text-sm">
            表头行
            <select
              class="select select-bordered select-sm"
              :value="sheet.headerRow"
              :disabled="busy"
              @change="changeHeaderRow(sheet.name, Number(($event.target as HTMLSelectElement).value))"
            >
              <option v-for="r in HEADER_ROW_OPTIONS" :key="r" :value="r">第 {{ r }} 行</option>
            </select>
            <span class="opacity-60">（自动探测，可修正；改选后重跑规则）</span>
          </label>
          <table class="table table-zebra table-sm">
            <thead>
              <tr><th>脱敏</th><th>列</th><th>命中规则</th></tr>
            </thead>
            <tbody>
              <tr v-for="h in sheet.headers" :key="h.colIndex">
                <td>
                  <input
                    v-model="selections[sheet.name].cols"
                    type="checkbox"
                    class="checkbox checkbox-sm"
                    :value="h.colIndex"
                  >
                </td>
                <td>{{ h.name }}</td>
                <td>
                  <span
                    v-for="rule in h.matchedRules"
                    :key="rule"
                    class="badge badge-info badge-sm mr-1"
                  >{{ rule }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="flex items-center gap-3">
        <button class="btn btn-warning" :disabled="busy" @click="run('encrypt')">
          <LockKeyhole class="size-4" />
          脱敏
        </button>
        <button class="btn btn-success" :disabled="busy" @click="run('decrypt')">
          <LockKeyholeOpen class="size-4" />
          还原
        </button>
        <template v-if="progress !== null">
          <progress class="progress progress-primary w-64" :value="progress" max="100" />
          <span class="text-sm">{{ progress }}%</span>
        </template>
      </div>
    </template>
  </div>
</template>
