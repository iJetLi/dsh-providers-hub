import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { LlmError } from '@deepseek-ai/dsh-llm'

const MIN_REQUEST_GAP_MS = 400
const accounts = new Map<string, { active: boolean; lastDispatch: number }>()

/**
 * **名额已满**的**结构化标记**（GitHub issue #117）。
 *
 * ## 为什么是 Symbol 而不是 `error.message.includes('并发已满')`
 *
 * 报障者在 issue 里明确警告：**不要匹配中文文案** ——「文案改词/换语言就会静默失效，
 * 那一刻症状精确退回缺陷原样」。所以标记挂在错误对象上，判定只认这个 Symbol。
 *
 * ## 为什么用 `Symbol.for` 而不是模块内 `Symbol()`
 *
 * `Symbol.for` 走全局注册表 ⇒ 即使模块被重复加载（两份 lib / 不同 realm），
 * 键仍然相等。模块内 `Symbol()` 在那种场景下会**静默不相等** ⇒ 换号永不触发。
 */
const SLOT_BUSY = Symbol.for('dsh.qoder.traffic.slot-busy')

/**
 * 这个错误是不是「**名额被占**」？（{@link SLOT_BUSY} 的结构化判定）
 *
 * ⚠️ 只认自家抛的那个对象：`instanceof LlmError` + Symbol 标记双判，避免把
 * 上游随便一个带同名属性的错误当成名额冲突。
 */
export function isQoderSlotBusy(error: unknown): boolean {
  return error instanceof LlmError
    && (error as unknown as Record<symbol, unknown>)[SLOT_BUSY] === true
}

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
  if (account.active) {
    /**
     * ⚠️ **文案与错误码逐字保持不变**（issue #117 的硬要求）：用户看到的仍是
     * 「本地账号并发已满 / `QUEUE`」；新增的只是**给适配器看的**结构化标记，
     * 让它能把这一步接到**既有的换号通路**上（`switchAccountOnQuota`）。
     */
    const busy = new LlmError(`${provider}: 本地账号并发已满，请稍后重试`, 'QUEUE')
    Object.defineProperty(busy, SLOT_BUSY, { value: true, enumerable: false })
    throw busy
  }

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
