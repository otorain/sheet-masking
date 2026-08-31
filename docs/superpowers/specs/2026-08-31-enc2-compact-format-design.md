# ENC2 紧凑加密格式设计

日期：2026-08-31
状态：已与用户确认（方案 B：紧凑自包含格式；**不保留旧 ENC1 兼容**）

## 背景

报表脱敏工具（参见 `2026-08-31-sheet-masking-design.md`）已上线 ENC1 格式：
`'ENC1:' + base64(iv(12B) ‖ 密文 ‖ tag(16B))`，payload 为带类型 JSON。密文较长
（`张三` → 61 字符，手机号 → 69 字符）。

用户实际使用场景：脱敏后的表格发给 LLM 处理。base64 长乱码对 tokenizer 极不
友好（每格 ~25-30 token，90 万格 ≈ 2700 万 token）。需要在**不改变自包含
逐格加密架构**的前提下压缩密文长度。（令牌化+映射表方案可再降一个数量级，
但引入 map 文件管理成本，用户已明确拒绝；FPE 不适用文本列，已排除。）

用户确认：**无历史数据需要兼容**，直接替换 ENC1，不保留旧格式读取路径。

## 设计

### 格式

```
单元格值 = 'E2:' ‖ base64nopad( iv(8B) ‖ 密文 ‖ tag(8B) )
```

- **payload 二进制化**（取代带类型 JSON）：
  - 文本：`0x01 ‖ utf8 字节`
  - 数字：`0x02 ‖ float64 BE`（JS number 精确往返；NaN/Infinity 也可编码）
  - 日期：`0x03 ‖ float64 BE`（毫秒时间戳，Date.getTime()）
- **IV = HMAC-SHA256(sivKey, payload)[0:8]**：确定性 SIV 构造下，IV 碰撞仅发生
  于同明文（本来即要求同文同密），8 字节充分
- **AES-256-GCM，`authTagLength: 8`**：64 位防伪，对离线文件场景充足
- base64 去掉 padding；前缀 `E2:`（3 字符，兼作还原扫描与防重复加密标记）

长度对比：张三 61→34 字符，手机号 69→41，约省 45%（LLM token 消耗同比）。

### 密钥

沿用现有 `initCrypto`：scrypt(password, salt) → HKDF-SHA256 分 encKey/sivKey，
不变。

### 接口（crypto.ts 对外签名不变）

- `encryptPayload(ctx, payload): string` — 输出 E2 格式
- `decryptPayload(ctx, value): CellPayload` — 只认 `E2:` 前缀；篡改/错密码仍抛
  `Error('密码不符或文件被篡改')`
- `isEncrypted(value)` — 匹配 `E2:` 前缀
- `CellPayload = ['s',string] | ['n',number] | ['d',string]`、`valueToPayload`/
  `payloadToValue` 不变（'d' 的 ISO 字符串与二进制 ms 互转在加解密内部完成）

`sheet.ts` / `csv.ts` / IPC / UI **零改动**（接口与两档失败语义不变）。

### 移除

- ENC1 全部读写路径、`PREFIX = 'ENC1:'` 常量、JSON payload 序列化分支
- 相关测试中 ENC1 字面量（篡改测试的 `slice('ENC1:'.length)` 改为按 `:` 动态定位）

## 验证

- `crypto.test.ts` 全量改写：确定性、E2 前缀、往返保真（文本/空串/数字/0/
  浮点/日期/NaN）、篡改 1 字节抛错、错密码抛错、畸形密文抛错、payload 非法
  类型抛错
- `sheet.test.ts` / `csv.test.ts`：仅适配前缀切片，语义断言不变，应全绿
- `pnpm exec vitest run` + `vue-tsc --noEmit` + `tsc --noEmit -p tsconfig.node.json`
  + `vite build`
- README「加密格式」一节改写为 E2 格式说明（含长度对比与 token 友好性）

## 不做（YAGNI）

- ENC1 兼容读取（用户确认无历史数据）
- 令牌化映射表、FPE 保格式加密（均已排除）
- 格式版本协商/混合加密 UI 开关
