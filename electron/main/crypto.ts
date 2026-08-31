import crypto from 'node:crypto'

/**
 * 确定性可逆加密：
 * - scrypt(password, salt) 派生主密钥，HKDF-SHA256 分出 encKey / sivKey
 * - iv = HMAC-SHA256(sivKey, payload)[0:12]（同一明文任何文件任何时间密文相同；
 *   订单等数据需要跨表关联，用户已接受暴露值相等性与频率的代价）
 * - AES-256-GCM(encKey, iv, payload)，单元格写回 'ENC1:' + base64(iv ‖ 密文 ‖ tag)
 * 纯函数模块，不依赖 electron，可独立单测。
 */

const PREFIX = 'ENC1:'
const IV_LEN = 12
const TAG_LEN = 16
const KEY_LEN = 32
const HKDF_SALT = 'sheet-masking-v1'

export interface CryptoContext {
  encKey: Buffer
  sivKey: Buffer
}

/** 带类型单元格 payload：s=文本 n=数字 d=ISO 日期字符串（还原后类型不变） */
export type CellPayload = ['s', string] | ['n', number] | ['d', string]

export function generateSalt(): string {
  return crypto.randomBytes(16).toString('base64')
}

export function initCrypto(password: string, salt: string): CryptoContext {
  const master = crypto.scryptSync(password, Buffer.from(salt, 'base64'), KEY_LEN)
  return {
    encKey: Buffer.from(crypto.hkdfSync('sha256', master, HKDF_SALT, 'enc', KEY_LEN)),
    sivKey: Buffer.from(crypto.hkdfSync('sha256', master, HKDF_SALT, 'siv', KEY_LEN)),
  }
}

export function isEncrypted(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PREFIX)
}

export function encryptPayload(ctx: CryptoContext, payload: CellPayload): string {
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8')
  const iv = crypto.createHmac('sha256', ctx.sivKey).update(plaintext).digest().subarray(0, IV_LEN)
  const cipher = crypto.createCipheriv('aes-256-gcm', ctx.encKey, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return PREFIX + Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64')
}

export function decryptPayload(ctx: CryptoContext, value: string): CellPayload {
  const fail = (): never => {
    throw new Error('密码不符或文件被篡改')
  }
  if (!isEncrypted(value)) fail()
  const buf = Buffer.from(value.slice(PREFIX.length), 'base64')
  if (buf.length < IV_LEN + TAG_LEN + 1) fail()
  const iv = buf.subarray(0, IV_LEN)
  const ciphertext = buf.subarray(IV_LEN, buf.length - TAG_LEN)
  const tag = buf.subarray(buf.length - TAG_LEN)
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', ctx.encKey, iv)
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    const parsed = JSON.parse(plaintext.toString('utf8')) as unknown
    if (Array.isArray(parsed) && parsed.length === 2) {
      const [kind, val] = parsed as [unknown, unknown]
      if (kind === 's' && typeof val === 'string') return ['s', val]
      if (kind === 'n' && typeof val === 'number') return ['n', val]
      if (kind === 'd' && typeof val === 'string') return ['d', val]
    }
    return fail()
  } catch {
    return fail()
  }
}

/** 字面量单元格值 → payload；空值/公式/富文本/超链接/布尔/错误等返回 null（跳过） */
export function valueToPayload(value: unknown): CellPayload | null {
  if (typeof value === 'string') return ['s', value]
  if (typeof value === 'number') return ['n', value]
  if (value instanceof Date) return ['d', value.toISOString()]
  return null
}

export function payloadToValue(payload: CellPayload): string | number | Date {
  switch (payload[0]) {
    case 's':
      return payload[1]
    case 'n':
      return payload[1]
    case 'd':
      return new Date(payload[1])
  }
}
