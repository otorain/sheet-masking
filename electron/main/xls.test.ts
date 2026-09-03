import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { kindFromPath } from './sheet.js'

let dir: string
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xls-test-'))
})
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('kindFromPath', () => {
  it('识别 .xls / .XLS 为 xls', () => {
    expect(kindFromPath('/tmp/a.xls')).toBe('xls')
    expect(kindFromPath('/tmp/A.XLS')).toBe('xls')
  })
  it('不支持的扩展名报错且列出受支持格式', () => {
    expect(() => kindFromPath('/tmp/a.doc')).toThrow('仅支持 .xlsx / .xls / .csv')
  })
})
