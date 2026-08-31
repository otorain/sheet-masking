import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import {
  decryptPayload,
  encryptPayload,
  generateSalt,
  initCrypto,
  type CryptoContext,
} from './crypto.js'
import { defaultRulesConfig } from './rules.js'
import type { RulesConfig } from '../shared/types.js'

/**
 * userData/config.json：
 * {
 *   salt: string         // scrypt salt（base64，随机生成）
 *   encPassword: string  // safeStorage.encryptString(password) 的 base64；不明文落盘。
 *                        // safeStorage 不可用时空串（每次启动需手动解锁）
 *   verifier: string     // ENC1 加密的固定明文，用于回退流程校验密码正确性
 *   rules: RulesConfig
 * }
 * Windows 上 safeStorage 走 DPAPI（绑定当前系统用户；换机/换用户解不开 → 走
 * unlockWithPassword 回退）。
 */

const VERIFIER_PLAINTEXT = 'sheet-masking-verifier-v1'

interface StoredConfig {
  salt: string
  encPassword: string
  verifier: string
  rules: RulesConfig
}

export type AppState = 'setup' | 'locked' | 'unlocked'

/** 派生密钥驻留主进程内存，不落盘 */
let ctx: CryptoContext | null = null

function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json')
}

function readStored(): StoredConfig | null {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8')) as StoredConfig
  } catch {
    return null
  }
}

function writeStored(config: StoredConfig): void {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true })
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8')
}

export function getAppState(): AppState {
  const stored = readStored()
  if (!stored) return 'setup'
  if (ctx) return 'unlocked'
  if (stored.encPassword && safeStorage.isEncryptionAvailable()) {
    try {
      const password = safeStorage.decryptString(Buffer.from(stored.encPassword, 'base64'))
      ctx = initCrypto(password, stored.salt)
      return 'unlocked'
    } catch {
      return 'locked'
    }
  }
  return 'locked'
}

/** 首次设置/修改密码：生成新 salt 与 verifier，保留已有规则配置 */
export function setupPassword(password: string): void {
  const salt = generateSalt()
  const next = initCrypto(password, salt)
  const canStore = safeStorage.isEncryptionAvailable()
  writeStored({
    salt,
    encPassword: canStore ? safeStorage.encryptString(password).toString('base64') : '',
    verifier: encryptPayload(next, ['s', VERIFIER_PLAINTEXT]),
    rules: readStored()?.rules ?? defaultRulesConfig(),
  })
  ctx = next
}

/** 回退解锁：用存储 salt 派生密钥，解密 verifier 校验密码正确性 */
export function unlockWithPassword(password: string): boolean {
  const stored = readStored()
  if (!stored) return false
  const candidate = initCrypto(password, stored.salt)
  try {
    const payload = decryptPayload(candidate, stored.verifier)
    if (payload[0] === 's' && payload[1] === VERIFIER_PLAINTEXT) {
      ctx = candidate
      return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * 修改密码：校验旧密码后重新 setup（新 salt/verifier/encPassword）。
 * 注意：旧密码脱敏的文件将无法再还原，UI 必须先行警告。
 */
export function changePassword(oldPassword: string, newPassword: string): boolean {
  if (!unlockWithPassword(oldPassword)) return false
  setupPassword(newPassword)
  return true
}

export function getCryptoContext(): CryptoContext {
  if (!ctx) throw new Error('未解锁：请先设置或输入主密码')
  return ctx
}

export function getRulesConfig(): RulesConfig {
  return readStored()?.rules ?? defaultRulesConfig()
}

export function saveRulesConfig(config: RulesConfig): void {
  const stored = readStored()
  if (!stored) throw new Error('请先设置主密码')
  for (const src of config.customPatterns) {
    try {
      new RegExp(src)
    } catch {
      throw new Error(`无效正则：${src}`)
    }
  }
  writeStored({ ...stored, rules: config })
}
