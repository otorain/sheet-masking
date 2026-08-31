# ENC2 紧凑加密格式实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把单元格加密格式从 ENC1（JSON payload + 12B IV + 16B tag）替换为 E2 紧凑格式（二进制 payload + 8B IV + 8B tag + 去 padding），密文缩短约 45%，降低下游 LLM token 消耗。

**Architecture:** 只改 `electron/main/crypto.ts` 内部实现，对外签名（`initCrypto`/`encryptPayload`/`decryptPayload`/`isEncrypted`/`valueToPayload`/`payloadToValue`/`CryptoContext`/`CellPayload`）全部不变，`sheet.ts`/`csv.ts`/IPC/UI 零改动。不保留 ENC1 兼容（用户确认无历史数据）。

**Tech Stack:** Node crypto（scrypt/HKDF-SHA256/AES-256-GCM）/ vitest 4 / TypeScript

## Global Constraints

- 新格式：`'E2:' ‖ base64nopad( iv(8B) ‖ 密文 ‖ tag(8B) )`；前缀 `E2:`（3 字符）是还原扫描与防重复加密的唯一标记
- payload 二进制：`0x01 ‖ utf8`（文本）/ `0x02 ‖ float64 BE`（数字）/ `0x03 ‖ float64 BE`（日期毫秒时间戳）；`CellPayload` 元组接口不变，ISO↔ms 互转在加解密内部完成
- `iv = HMAC-SHA256(sivKey, payload)[0:8]`（确定性，同文同密）；AES-256-GCM `authTagLength: 8`
- 解密失败（前缀不符/长度不足/tag 校验失败/payload 结构非法）一律抛 `Error('密码不符或文件被篡改')`
- **移除** ENC1 全部读写路径（`PREFIX = 'ENC1:'`、JSON payload 分支），不留兼容代码
- 密钥派生不变：scrypt(password, salt) → HKDF-SHA256（salt 固定 `'sheet-masking-v1'`）分 encKey/sivKey
- 主进程相对 import 带 `.js` 后缀；提交信息英文 conventional commits
- 验证命令：`pnpm exec vitest run`、`pnpm exec vue-tsc --noEmit`、`pnpm exec tsc --noEmit -p tsconfig.node.json`、`pnpm exec vite build`

---

### Task 1: crypto.ts E2 重写（TDD）

**Files:**
- Modify: `electron/main/crypto.ts`（整体重写）
- Test: `electron/main/crypto.test.ts`（整体重写）

**Interfaces:**
- Consumes: 无
- Produces（全部与现状一致，sheet.ts/csv.ts 无需改动）:
  - `CryptoContext { encKey: Buffer; sivKey: Buffer }`
  - `CellPayload = ['s', string] | ['n', number] | ['d', string]`（'d' 为 ISO 字符串）
  - `generateSalt(): string`、`initCrypto(password, salt): CryptoContext`
  - `isEncrypted(value: unknown): value is string`（只认 `E2:` 前缀）
  - `encryptPayload(ctx, payload): string`、`decryptPayload(ctx, value): CellPayload`
  - `valueToPayload(value: unknown): CellPayload | null`、`payloadToValue(payload): string | number | Date`

- [ ] **Step 1: 整体重写失败测试**

Replace entire `electron/main/crypto.test.ts`：

```ts
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
  it('同一密码+salt 派生的密钥一致（跨文件确定性）', () => {
    const a = initCrypto(password, salt)
    expect(a.encKey.equals(ctx.encKey)).toBe(true)
    expect(a.sivKey.equals(ctx.sivKey)).toBe(true)
  })

  it('不同密码派生不同密钥', () => {
    const other = initCrypto('other-password', salt)
    expect(other.encKey.equals(ctx.encKey)).toBe(false)
  })
})

describe('encryptPayload（E2 紧凑格式）', () => {
  it('确定性：同一明文多次加密结果完全相同', () => {
    expect(encryptPayload(ctx, ['s', '张三'])).toBe(encryptPayload(ctx, ['s', '张三']))
  })

  it('不同明文密文不同，且带 E2: 前缀', () => {
    const a = encryptPayload(ctx, ['s', '张三'])
    const b = encryptPayload(ctx, ['s', '李四'])
    expect(a).not.toBe(b)
    expect(a.startsWith('E2:')).toBe(true)
    expect(isEncrypted(a)).toBe(true)
  })

  it('紧凑性：短值密文显著短于 ENC1 时代（61 字符）', () => {
    // 张三 = 6B utf8：3 + base64nopad(8+7+8=23B → 31) = 34 字符
    expect(encryptPayload(ctx, ['s', '张三'])).toHaveLength(34)
    // 手机号 11B：3 + base64nopad(8+12+8=28B → 38) = 41 字符
    expect(encryptPayload(ctx, ['s', '13800138000'])).toHaveLength(41)
  })

  it('isEncrypted 只认 E2: 前缀的字符串', () => {
    expect(isEncrypted('张三')).toBe(false)
    expect(isEncrypted('ENC1:AAAA')).toBe(false) // 旧格式不再识别
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
    ['n', NaN],
    ['n', Infinity],
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
    const buf = Buffer.from(enc.slice(enc.indexOf(':') + 1), 'base64')
    buf[buf.length - 1] ^= 1
    expect(() => decryptPayload(ctx, 'E2:' + buf.toString('base64'))).toThrow(
      '密码不符或文件被篡改',
    )
  })

  it('畸形密文抛错而非崩溃', () => {
    expect(() => decryptPayload(ctx, 'E2:')).toThrow('密码不符或文件被篡改')
    expect(() => decryptPayload(ctx, 'E2:not-valid-base64!!!')).toThrow(
      '密码不符或文件被篡改',
    )
    expect(() => decryptPayload(ctx, 'E2:aGVsbG8td29ybGQtdGhpcy1pcy10b28tc2hvcnQ=')).toThrow(
      '密码不符或文件被篡改',
    )
    // 长度够但类型字节非法（0x09 不是 01/02/03）
    const badType = Buffer.concat([Buffer.alloc(8), Buffer.from([0x09, 0x41]), Buffer.alloc(8)])
    expect(() => decryptPayload(ctx, 'E2:' + badType.toString('base64'))).toThrow(
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run electron/main/crypto.test.ts`
Expected: FAIL（E2 前缀/长度断言失败——现实现产出 ENC1 格式）

- [ ] **Step 3: 整体重写 crypto.ts**

Replace entire `electron/main/crypto.ts`：

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run electron/main/crypto.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: 类型检查 + Commit**

Run: `pnpm exec tsc --noEmit -p tsconfig.node.json`
Expected: 通过

```bash
git add electron/main/crypto.ts electron/main/crypto.test.ts
git commit -m "feat: E2 compact cell format (binary payload, 8B IV/tag, ~45% shorter)"
```

---

### Task 2: sheet/csv 测试适配 + README + 全量验证

**Files:**
- Modify: `electron/main/sheet.test.ts`（篡改用例的 ENC1 前缀切片）
- Modify: `electron/main/csv.test.ts`（同上）
- Modify: `README.md`（加密格式一节）

**Interfaces:**
- Consumes: Task 1 的 E2 格式（`E2:` 前缀）
- Produces: 无（收尾任务）

- [ ] **Step 1: 跑全量测试确认当前失败点**

Run: `pnpm exec vitest run`
Expected: `sheet.test.ts`「个别格损坏」与 `csv.test.ts`「第二档失败」两个篡改用例失败（它们按 `'ENC1:'.length` 切片/定位，E2 密文上前缀偏移错误）；其余用例（isEncrypted 语义不变）应仍通过。

- [ ] **Step 2: 适配 sheet.test.ts 篡改用例**

`electron/main/sheet.test.ts` 个别格损坏用例中（约 213-216 行）：

```ts
    const encText = ws.getCell('C3').value as string
    const buf = Buffer.from(encText.slice('ENC1:'.length), 'base64')
    buf[buf.length - 1] ^= 1
    ws.getCell('C3').value = 'ENC1:' + buf.toString('base64')
```

改为（按冒号动态定位前缀，与格式解耦）：

```ts
    const encText = ws.getCell('C3').value as string
    const prefix = encText.slice(0, encText.indexOf(':') + 1)
    const buf = Buffer.from(encText.slice(prefix.length), 'base64')
    buf[buf.length - 1] ^= 1
    ws.getCell('C3').value = prefix + buf.toString('base64')
```

- [ ] **Step 3: 适配 csv.test.ts 篡改用例**

`electron/main/csv.test.ts` 第二档失败用例中（约 158-162 行）：

```ts
    // 篡改第 3 行第 2 列（非首个 ENC1 格）：翻转密文区一个字符，保留 ENC1: 前缀
    const mid = 10 // 'ENC1:'.length + 5，落在 base64 密文区
    cells[1] = cells[1].slice(0, mid) + (cells[1][mid] === 'A' ? 'B' : 'A') + cells[1].slice(mid + 1)
```

改为：

```ts
    // 篡改第 3 行第 2 列（非首个 E2 格）：翻转密文区一个字符，保留前缀
    const mid = cells[1].indexOf(':') + 6 // 前缀之后落入 base64 密文区
    cells[1] = cells[1].slice(0, mid) + (cells[1][mid] === 'A' ? 'B' : 'A') + cells[1].slice(mid + 1)
```

- [ ] **Step 4: 跑全量测试确认通过**

Run: `pnpm exec vitest run`
Expected: 50/50 PASS（含 Task 1 新 crypto 用例；sheet/csv 语义断言不变全绿）

- [ ] **Step 5: 更新 README 加密格式一节**

`README.md` 的「## 加密格式」下，把这两条：

```markdown
- 单元格：值序列化为带类型 JSON（`["s",文本]` / `["n",数字]` / `["d",ISO日期]`），
  `iv = HMAC-SHA256(sivKey, payload)[0:12]`，AES-256-GCM 加密，写回
  `'ENC1:' + base64(iv ‖ 密文 ‖ tag)`
```

替换为：

```markdown
- 单元格（E2 紧凑格式）：值编码为二进制 payload（1 字节类型 + 原内容：文本=utf8、
  数字/日期=float64），`iv = HMAC-SHA256(sivKey, payload)[0:8]`，AES-256-GCM
  （tag 8B）加密，写回 `'E2:' + base64nopad(iv ‖ 密文 ‖ tag)`——比常见逐格
  base64 格式短约 45%，脱敏文件发给 LLM 处理时显著省 token
```

同节中「空值、公式单元格、已有 ENC1 前缀的值跳过；还原时第一个 ENC1 格校验失败…」一条里的两处 `ENC1` 改为 `E2`。

- [ ] **Step 6: 全量验证**

Run: `pnpm exec vitest run && pnpm exec vue-tsc --noEmit && pnpm exec tsc --noEmit -p tsconfig.node.json && pnpm exec vite build`
Expected: 全部通过

- [ ] **Step 7: Commit**

```bash
git add electron/main/sheet.test.ts electron/main/csv.test.ts README.md
git commit -m "test: adapt tamper cases to E2 prefix; docs: README for E2 format"
```

---

## Self-Review 记录（计划落盘前已完成）

- spec 覆盖：二进制 payload/8B IV/8B tag/nopad/E2 前缀 → Task 1；移除 ENC1 → Task 1 整体重写天然覆盖；接口不变 → Produces 逐字列明；sheet/csv 测试适配 + README → Task 2；验证命令 → 两任务各自 Step
- 占位符扫描：无 TBD/TODO；所有代码与测试用例完整给出
- 类型一致性：`CellPayload`/`CryptoContext`/函数签名与盘上现状逐字一致（仅内部格式变化）；测试中的长度断言（34/41）已按 23B/28B 二进制布局手工复核
- 长度断言推导：张三 payload 7B → iv8+ct7+tag8=23B → base64nopad 31 字符 + 前缀 3 = 34；手机号 payload 12B → 28B → 38 + 3 = 41
