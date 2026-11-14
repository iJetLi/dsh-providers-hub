import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { LlmError } from '@deepseek-ai/dsh-llm'

const MIN_REQUEST_GAP_MS = 400
const accounts = new Map<string, { active: boolean; lastDispatch: number }>()

export type QoderTrafficProvider = 'qoder' | 'qodercn'

/** 未在面板设置时的默认值。 */
export function qoderTrafficGuardEnabled(): boolean {
  return !/^(0|off|false)$/i.test(process.env.DSH_QODER_TRAFFIC_GUARD?.trim() ?? '')
}

/** 预留整个流的并发名额。账号忙时直接报告本地排队，避免积压请求。 */
export async function acquireQoderRequest(
  provider: string,
  uid: string,
  signal?: AbortSignal,
): Promise<Disposable> {
  signal?.throwIfAborted()
  const now = performance.now()
  for (const [key, account] of accounts) {
    if (!account.active && now - account.lastDispatch >= MIN_REQUEST_GAP_MS) accounts.delete(key)
  }

  const key = `${provider}:${uid}`
  const account = accounts.get(key) ?? { active: false, lastDispatch: -Infinity }
  if (account.active) throw new LlmError(`${provider}: 本地账号并发已满，请稍后重试`, 'QUEUE')

  account.active = true
  accounts.set(key, account)
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    account.active = false
  }
  try {
    const delay = account.lastDispatch + MIN_REQUEST_GAP_MS - performance.now()
    if (delay > 0) await sleep(Math.ceil(delay), undefined, { signal })
    signal?.throwIfAborted()
    account.lastDispatch = performance.now()
    return { [Symbol.dispose]: release }
  } catch (error) {
    release()
    throw error
  }
}
