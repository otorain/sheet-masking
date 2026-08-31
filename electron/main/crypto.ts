import crypto from 'node:crypto'

/**
 * 确定性可逆加密（E2 紧凑格式）：
 * - scrypt(password, salt) 派生主密钥，HKDF-SHA256 分出 encKey / sivKey
 * - payload 二进制化：1 字节类型 + 原内容（文本=utf8，数字/日期=float64 BE）
 * - iv = HMAC-SHA256(sivKey, payload)[0:8]（同一明文任何文件任何时间密文相同；
 *   订单等数据需要跨表关联，用户已接受暴露值相等性与频率的代价）
 * - AES-256-GCM（authTagLength 8），单元格写回
 *   'E2:' + base64nopad(iv(8B) ‖ 密文 ‖ tag(8B))——比 ENC1 短约 45%，
 *   降低下游 LLM token 消耗
 * 纯函数模块，不依赖 electron，可独立单测。
 */

const PREFIX = 'E2:'
const IV_LEN = 8
const TAG_LEN = 8
const KEY_LEN = 32
const HKDF_SALT = 'sheet-masking-v1'

const TYPE_STRING = 0x01
const TYPE_NUMBER = 0x02
const TYPE_DATE = 0x03

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

/** CellPayload → 二进制：0x01‖utf8 / 0x02‖float64BE / 0x03‖float64BE(ms) */
function encodePayload(payload: CellPayload): Buffer {
  switch (payload[0]) {
    case 's':
      return Buffer.concat([Buffer.from([TYPE_STRING]), Buffer.from(payload[1], 'utf8')])
    case 'n': {
      const buf = Buffer.alloc(9)
      buf[0] = TYPE_NUMBER
      buf.writeDoubleBE(payload[1], 1)
      return buf
    }
    case 'd': {
      const buf = Buffer.alloc(9)
      buf[0] = TYPE_DATE
      buf.writeDoubleBE(new Date(payload[1]).getTime(), 1)
      return buf
    }
  }
}

/** 二进制 → CellPayload；结构非法返回 null */
function decodePayload(buf: Buffer): CellPayload | null {
  if (buf.length < 1) return null
  const type = buf[0]
  const body = buf.subarray(1)
  switch (type) {
    case TYPE_STRING:
      return ['s', body.toString('utf8')]
    case TYPE_NUMBER:
      return body.length === 8 ? ['n', body.readDoubleBE(0)] : null
    case TYPE_DATE:
      return body.length === 8 ? ['d', new Date(body.readDoubleBE(0)).toISOString()] : null
    default:
      return null
  }
}

export function encryptPayload(ctx: CryptoContext, payload: CellPayload): string {
  const plaintext = encodePayload(payload)
  const iv = crypto.createHmac('sha256', ctx.sivKey).update(plaintext).digest().subarray(0, IV_LEN)
  const cipher = crypto.createCipheriv('aes-256-gcm', ctx.encKey, iv, {
    authTagLength: TAG_LEN,
  })
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return (
    PREFIX +
    Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64').replace(/=+$/, '')
  )
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
    const decipher = crypto.createDecipheriv('aes-256-gcm', ctx.encKey, iv, {
      authTagLength: TAG_LEN,
    })
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    const payload = decodePayload(plaintext)
    if (payload === null) return fail()
    return payload
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
