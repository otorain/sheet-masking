import { describe, expect, it } from 'vitest'
import {
  decryptPayload,
  encryptPayload,
  generateSalt,
  initCrypto,
  isEncrypted,
  payloadToValue,
  valueToPayload,
  type CellPayload,
} from './crypto.js'

const password = 'test-password-123'
const salt = generateSalt()
const ctx = initCrypto(password, salt)

describe('initCrypto', () => {
  it('同一密码+salt 派生的密钥一致（跨"文件"确定性）', () => {
    const a = initCrypto(password, salt)
    expect(a.encKey.equals(ctx.encKey)).toBe(true)
    expect(a.sivKey.equals(ctx.sivKey)).toBe(true)
  })

  it('不同密码派生不同密钥', () => {
    const other = initCrypto('other-password', salt)
    expect(other.encKey.equals(ctx.encKey)).toBe(false)
  })
})

describe('encryptPayload', () => {
  it('确定性：同一明文多次加密结果完全相同', () => {
    expect(encryptPayload(ctx, ['s', '张三'])).toBe(encryptPayload(ctx, ['s', '张三']))
  })

  it('不同明文密文不同，且带 ENC1: 前缀', () => {
    const a = encryptPayload(ctx, ['s', '张三'])
    const b = encryptPayload(ctx, ['s', '李四'])
    expect(a).not.toBe(b)
    expect(isEncrypted(a)).toBe(true)
  })

  it('isEncrypted 只认 ENC1: 前缀的字符串', () => {
    expect(isEncrypted('张三')).toBe(false)
    expect(isEncrypted(123)).toBe(false)
    expect(isEncrypted(null)).toBe(false)
    expect(isEncrypted(undefined)).toBe(false)
  })
})

describe('decryptPayload 往返', () => {
  // 注意不要用 it.each 传元组：数组行会被展开为多个参数。用普通 for 循环。
  const roundtrips: CellPayload[] = [
    ['s', '张三'],
    ['s', ''],
    ['n', 12345.67],
    ['n', 0],
    ['d', '2026-08-31T00:00:00.000Z'],
  ]
  for (const payload of roundtrips) {
    it(`payload 往返保真：${JSON.stringify(payload)}`, () => {
      expect(decryptPayload(ctx, encryptPayload(ctx, payload))).toEqual(payload)
    })
  }

  it('错误密码解密失败', () => {
    const enc = encryptPayload(ctx, ['s', '张三'])
    const wrong = initCrypto('wrong-password', salt)
    expect(() => decryptPayload(wrong, enc)).toThrow('密码不符或文件被篡改')
  })

  it('篡改 1 字节即解密失败（GCM tag 校验）', () => {
    const enc = encryptPayload(ctx, ['s', '张三'])
    const buf = Buffer.from(enc.slice('ENC1:'.length), 'base64')
    buf[buf.length - 1] ^= 1
    expect(() => decryptPayload(ctx, 'ENC1:' + buf.toString('base64'))).toThrow(
      '密码不符或文件被篡改',
    )
  })

  it('畸形密文抛错而非崩溃', () => {
    expect(() => decryptPayload(ctx, 'ENC1:')).toThrow('密码不符或文件被篡改')
    expect(() => decryptPayload(ctx, 'ENC1:not-valid-base64!!!')).toThrow(
      '密码不符或文件被篡改',
    )
    expect(() => decryptPayload(ctx, 'ENC1:aGVsbG8td29ybGQtdGhpcy1pcy10b28tc2hvcnQ=')).toThrow(
      '密码不符或文件被篡改',
    )
  })
})

describe('valueToPayload / payloadToValue', () => {
  it('string/number/Date 转 payload', () => {
    expect(valueToPayload('张三')).toEqual(['s', '张三'])
    expect(valueToPayload(42.5)).toEqual(['n', 42.5])
    expect(valueToPayload(new Date('2026-08-31T00:00:00.000Z'))).toEqual([
      'd',
      '2026-08-31T00:00:00.000Z',
    ])
  })

  it('其他类型返回 null（boolean/对象/null）', () => {
    expect(valueToPayload(true)).toBeNull()
    expect(valueToPayload({ formula: 'A1' })).toBeNull()
    expect(valueToPayload(null)).toBeNull()
  })

  it('payloadToValue 还原类型', () => {
    expect(payloadToValue(['s', '张三'])).toBe('张三')
    expect(payloadToValue(['n', 42.5])).toBe(42.5)
    expect(payloadToValue(['d', '2026-08-31T00:00:00.000Z'])).toEqual(
      new Date('2026-08-31T00:00:00.000Z'),
    )
  })
})
