# sheet-masking（报表脱敏工具）

对财务/公司数据报表（.xlsx / .xls / .csv）做**可逆脱敏**的桌面工具：加密敏感列，
事后可用同一主密码完整还原。基于 electron-vite-vue（Electron 42 + Vue 3 +
Vite 8 + Tailwind v4/daisyUI）。

## 用法

1. 首次启动设置主密码（经系统安全存储保存，Windows 为 DPAPI，不明文落盘；
   换机/换系统用户后需重新输入）
2. 选择 .xlsx / .xls / .csv 文件 → 按 sheet 展示表头勾选表（关键词规则自动勾选敏感列，
   可手动调整；表头行自动探测，可下拉修正后重跑规则；隐藏 sheet 照常列出）
3. 「脱敏」生成 `原名.已脱敏.扩展名`；「还原」对任何含 E2 密文的文件全文
   扫描还原（与列位置无关，增删列/调列序/另存均可还原）
4. 设置弹窗：增删四类匹配关键词（完全匹配/包含/开头/结尾）与自定义内容正则，
   增删立即生效并自动按新规则重新分析已选文件（新命中列自动补勾，手动勾选保留）；
   修改密码（**修改后旧密码脱敏的文件无法再还原，请先还原全部文件**）

## 加密格式

- 主密钥：`scrypt(password, salt)`，HKDF-SHA256 分出加密钥与 IV 钥
- 单元格（E2 紧凑格式）：值编码为二进制 payload（1 字节类型 + 原内容：文本=utf8、
  数字/日期=float64），`iv = HMAC-SHA256(sivKey, payload)[0:8]`，AES-256-GCM
  （tag 8B）加密，写回 `'E2:' + base64nopad(iv ‖ 密文 ‖ tag)`——比常见逐格
  base64 格式短约 45%，脱敏文件发给 LLM 处理时显著省 token
- **确定性加密**：同一明文在任何文件、任何时间密文完全相同（订单等数据可
  跨表关联）；代价是密文暴露值相等性与频率
- 空值、公式单元格（.xls 除外，见已知限制）、已有 E2 前缀的值跳过；还原时第一个 E2 格校验失败
  即判为密码错误（"密码不符或文件被篡改"），个别格失败则记录地址继续
- CSV：输入自动检测 GBK 并转码；输出一律 UTF-8 带 BOM + CRLF（Windows 版
  Excel 双击不乱码）

## 已知限制

- ExcelJS 往返保真边界：样式/公式/合并单元格/列宽保留；**图表、图片、数据
  透视表会丢失**
- 极端大文件（50 万行以上）可能超出内存：主进程堆已提额至 12GB，仍失败时
  请拆分文件
- CSV 编码检测只区分 UTF-8/GBK，UTF-16 编码的 CSV 会被误判为 GBK 产生乱码
  （请先另存为 UTF-8）
- .xls 经 SheetJS 读写：**单元格样式（字体/填充/边框）与公式丢失**——公式退化
  为静态缓存值（选中列的缓存值照常脱敏）；BIFF5 及更老格式统一写成 BIFF8；
  列宽/合并单元格/数字格式保留

## 开发

```sh
pnpm install
pnpm run dev       # 开发
pnpm test          # vitest 单测（crypto/rules/sheet/xls/csv）
pnpm run build     # 类型检查 + 构建 + electron-builder 打包
```

Tailwind CSS v4 + daisyUI 经 `@tailwindcss/vite` 与 `@plugin "daisyui"` 接入
（见 `src/style.css`）。Windows NSIS 安装包需在 Windows 机器或 CI 构建
（Linux 交叉构建 rcedit 需 wine）。
