/**
 * 跨 IPC 传参前深解包：Vue 的 reactive/ref 值是 Proxy，contextBridge 的
 * structured clone 无法克隆（抛 "An object could not be cloned"）。
 * JSON 往返得到纯数据对象。仅用于纯 JSON 数据（selections / rules config）。
 */
export function deepUnwrap<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
