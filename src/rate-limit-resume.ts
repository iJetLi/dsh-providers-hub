/**
 * 会话因**限流 / 额度**被中断后，等到解禁时刻**自动继续**。
 *
 * ## 它替用户做的那一步
 *
 * 号池里某个模型的号全被限流时，providers-hub 会把这一轮以 `QUOTA_EXCEEDED`
 * 收尾（`throwIfAllAccountsRateLimited`，十几个适配器同型），并在文案里写清
 * 「最近一个将于 X 解禁」。过去这一步只能由**人**在解禁后补一句「继续」——
 * 而解禁常在几十分钟到几小时后，人不会守着。
 *
 * ## 与 `dsh-providers-hub-enhance` 那版补丁的三处分歧（都是实测逼出来的）
 *
 * 1. **解禁时刻必须**在**记录那一刻**算出来，不能留到开火时才算。补丁只读
 *    `providerRetryAfterMs`，而本机实测 **61/61** 条真实限流失败**都没有这个
 *    字段**（`LlmFailure` 的可选字段，providers-hub 从不填）⇒ 它一律退到
 *    「1 小时后」，于是「18 分钟后解禁」的那次被排到 1 小时后，用户等不到就
 *    自己补了「继续」，钩子随之被丢弃 —— 表现正是「按钮有、就是不继续」。
 *    这里改成三条来源取**最早**的一条：① 服务端 `providerRetryAfterMs`；
 *    ② **失败文案里的解禁时刻**（「将于 2026/11/19 18:25:51 解禁」，实测
 *    57/61 条都带）；③ 账号池里该模型的限流标记（`modelRateLimits`）。
 * 2. **没有 live agent 不得丢钩子**。补丁遇到 `no-live-agent` 立刻放弃 ——
 *    而「等一小时」几乎必然跨越宿主重启 / 切走会话，那时会话不在内存里，
 *    钩子就被静默删掉。这里改成：保留钩子、按 {@link RETRY_MS} 重试，并在
 *    `agent/created` 时立刻补发（用户一打开那个会话就续上）。
 * 3. **只有人类输入才撤钩子**。补丁把**任何** `user/message` 都当成「用户
 *    手动发言」，而 DSH 里 `runtime-context` / `dsh-memory` / `skill-catalog`
 *    / `agent-instructions` 等**全部以 user/message 落盘**（实测一个会话里
 *    这类注入有几百条）⇒ 钩子随时被无关注入清掉。这里只认
 *    `source.kind === 'user'`（宿主对「直接人类输入」的证明）。
 *
 * ## 为什么续跑消息**不能**标成 `source.kind === 'user'`
 *
 * 与 `loop-recovery.ts` 完全同一个理由（那边有完整论述）：`'user'` 是宿主对
 * 「直接人类输入」的**证明**，`tool-goal` 的增删改都据此授权；伪造成 user
 * 等于让自动续跑**冒用人类授权**。这里用自己的来源标识，如实署名。
 *
 * ## 状态为什么落盘
 *
 * 「等一小时」必然跨宿主重启。钩子写 `$DSH_HOME/jet-hub/rate-limit-resume.json`
 * （tmp + rename 原子写），启动时恢复。⚠️ 兼容 `dsh-providers-hub-enhance`
 * 写过的同名文档（只是 schema 字段不同），升级不会把在等的钩子弄丢。
 *
 * @module rate-limit-resume
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { allAccountsRateLimitedForModel, type AccountPool } from './account-pool.js'
import { resolveJetHubHome } from './jet-hub-store.js'

/** 续跑消息**自有**的来源标识（理由见模块头）。 */
export const RATE_LIMIT_RESUME_SOURCE_KIND = 'rate-limit-resume'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * 「限流解禁后自动继续」投出的续跑指令。
     *
     * ⚠️ 它不是人类输入 —— `tool-goal` 的人类授权判据（`source.kind === 'user'`）
     * 因此**不会**被它命中，这正是本标识存在的意义。
     */
    'rate-limit-resume': { readonly kind: 'rate-limit-resume' }
  }
}

/**
 * 续跑消息正文（模型可见、会落盘）。
 *
 * 按「给模型的指令」写：说清 ① 继续未完成的任务；② 上一轮为什么停了
 * （限流，**不是**任务做完）；③ 不要重复已完成的部分。不写 harness 内部
 * 词汇（「钩子」「解禁时刻」）—— 那是给用户看的诊断。
 */
export const RATE_LIMIT_RESUME_PROMPT = '继续未完成的任务。上一轮因为服务端限流/额度限制被中断，'
  + '现在已经解禁 —— 请接着刚才的进度推进，不要重复已经完成的部分。'

/** 落盘文件名（与 `ui-preferences.json` 同目录）。 */
export const RATE_LIMIT_RESUME_FILE = 'rate-limit-resume.json'
const SCHEMA = 'dsh-providers-hub/rate-limit-resume/v1'

/**
 * 总开关环境变量。
 *
 * 与 `DSH_RATE_LIMIT_SINK` 同一约定：**默认开启**，只有显式写
 * `0` / `false` / `off` / `no` 才算关（`Boolean(env[...])` 会把「未设置」判成
 * 关闭 —— 那是本仓库反复登记的同类坑）。设置页里那个开关用的是同一份语义，
 * 两边**都关**才真的不续跑：环境变量是「这个宿主根本不要这个功能」，
 * 落盘值是「用户在界面上关过」。
 *
 * @param env - 环境变量来源，默认 `process.env`（单测注入用）。
 * @returns 是否允许自动继续。
 */
export function rateLimitResumeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.DSH_RATE_LIMIT_RESUME
  if (typeof raw !== 'string') return true
  const value = raw.trim().toLowerCase()
  if (value.length === 0) return true
  return !(value === '0' || value === 'false' || value === 'off' || value === 'no')
}

/** 失败类别：限流（429 / RATE_LIMIT / 号池全限流）。 */
export type RateLimitResumeClass = 'rate' | 'quota'

/** 解禁时刻三条来源都拿不到时的兜底等待（1 小时，与 providers-hub 的 429 冷却同档）。 */
export const FALLBACK_WAIT_MS = 60 * 60 * 1000
/** 最早多久之后才允许续跑（防「解禁时刻已过去」时在同一轮里连打）。 */
const MIN_FIRE_DELAY_MS = 5 * 1000
/** 单次定时器上限（`setTimeout` 超过 2^31-1 会给 1ms 警告并立刻触发）。 */
const MAX_WAIT_MS = 24 * 60 * 60 * 1000
/** 同一钩子最多推迟/重试多少次，超过就放弃。 */
const MAX_DEFERRALS = 48

/**
 * **每个会话**被自动续跑的**总次数**上限（2026-11-21 对抗审计 P0）。
 *
 * ## 为什么 `MAX_DEFERRALS` 挡不住「限流 → 解禁 → 继续 → 又限流」
 *
 * 那个 48 只在**单个钩子内部**对「投递失败 / 号池顺延」计数，而**成功投递会
 * `drop(hook)`** ⇒ 下一轮再被限流时 {@link noteInterruption} 建的是**新钩子**、
 * `deferrals` 从 0 重来 ⇒ 循环**没有任何寿命上限**。
 *
 * 审计实测（engine 级）：连续 100 轮限流/解禁，`deliver` 被调 **100 次**，
 * 每轮 `deferrals` 都是 0；接线级 10 轮 = 10 次 followup，且
 * `MIN_FIRE_DELAY_MS=5s` ⇒ 最快 **12 次/分钟**。
 * `quota`（积分耗尽、等多久都不会好）同样每小时重试一次、**永不放弃**。
 *
 * ## 上限取值的理由
 *
 * - `rate`（429）：给 3 次 —— 一次正常续跑之后仍连续被限流，说明这个渠道
 *   当前就是不可用，再自动重试只是烧额度；3 次足够覆盖「抖动」。
 * - `quota`（积分耗尽）：**只给 1 次** —— 额度不会因为等待而恢复
 *   （要等的是计费周期），多次自动续跑是纯浪费。
 *
 * ⚠️ **用户手动发消息会重置计数**（见 `noteUserMessage`）：那是「用户回来了、
 *    重新开始」的语义，不是继续消耗自动额度。
 * ⚠️ 计数**落盘、跨重启生效** —— 否则重启就是绕过上限的后门。
 */
const MAX_RESUMES_BY_KIND: Record<RateLimitResumeClass, number> = { rate: 3, quota: 1 }
/** 投递失败（会话不在内存 / agents 未就绪）后的重试间隔。 */
const RETRY_MS = 2 * 60 * 1000
/** 同时挂着的钩子上限（正常使用远达不到，纯防异常增长）。 */
const MAX_HOOKS = 64
/** 决策流水最多留多少条（只进内存，供面板诊断）。 */
const MAX_RECENT = 20

/**
 * 「限流」的自然语言兜底。
 *
 * ⚠️ **必须收「限流 / 受限 / 解禁」这几个字**：providers-hub 自己的文案写的是
 * 「均在限流中」「所有账号均受限」「XX 将于 … 解禁」，早期版本只写了
 * 「频率限制 / 请求过于频繁」这类**同义词** ⇒ 一条真实的限流报错在结构化码与
 * 文案两处双双落空（教训：兜底正则要照真机原文写）。
 */
const RATE_TEXT = /限流|受限|解禁|频率限制|频率超出|使用量已超出|请求过于频繁|too\s+many\s+requests|rate[\s_-]?limit|frequency\s+limit|usage\s+exceeds|throttl/i

/** 「额度真的耗尽」的兜底（**不是**限流，等到解禁也不会好）。 */
const QUOTA_TEXT = /14018|credits?\s+exhausted|配额|额度|积分(不足|耗尽|用尽)|余额(不足|耗尽)|insufficient\s+(quota|balance|credits?)|quota\s+(exceeded|exhausted)|out\s+of\s+credits?/i

/**
 * 结构化码里**确定是限流**的那些。
 *
 * ⚠️ `QUOTA_EXCEEDED` **不在**这里：providers-hub 把「号池里该模型全被限流」
 * 报成这个码，但 trae 的「积分不足」、accio 的「额度或认证失败」用的是同一个码。
 * ⇒ 它只作线索，最终由文案分流（命中限流文案 ⇒ `rate`，否则 ⇒ `quota`）。
 */
const RATE_CODES: ReadonlySet<string> = new Set(['RATE_LIMIT', 'RATE_LIMITED', 'TOO_MANY_REQUESTS'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 判一次失败是不是「限流 / 额度」造成的。
 *
 * @param failure - `turn/end` 的 `reason.error`（未知形状按「不是」处理）。
 * @returns `'rate'` / `'quota'`；不是这类失败时 `undefined`。
 */
export function classifyRateLimitFailure(failure: unknown): RateLimitResumeClass | undefined {
  if (!isRecord(failure)) return undefined
  const code = typeof failure.code === 'string' ? failure.code : undefined
  const status = typeof failure.status === 'number' ? failure.status : undefined
  if (code !== undefined && RATE_CODES.has(code)) return 'rate'
  if (status === 429) return 'rate'
  const text = [typeof failure.message === 'string' ? failure.message : '', code ?? '']
    .filter(part => part !== '')
    .join(' ')
  // 文案优先于「额度类结构化码」：真机那条 `QUOTA_EXCEEDED` 正是靠「限流」二字
  // 才被认出来的。
  if (RATE_TEXT.test(text)) return 'rate'
  if (code === 'QUOTA' || code === 'ACCOUNT_QUOTA' || code === 'QUOTA_EXCEEDED') return 'quota'
  if (QUOTA_TEXT.test(text)) return 'quota'
  return undefined
}

/**
 * 从失败文案里读「解禁时刻」。
 *
 * 真机原文：`… 的可用账号均在限流中，最近一个将于 2026/11/19 18:25:51 解禁。…`
 * （实测 57/61 条限流失败带这句话）。时间按**本地时区**理解 —— 文案是给人看的，
 * 宿主 `toLocaleString` 产出的就是本地时间。
 *
 * ⚠️ 解析必须**锚定整句**（`将于` + `解禁` 夹住时间），只认时间戳会把文案里
 * 别的日期（例如资源包到期日）吃进来，排出一个毫无意义的远未来时刻。
 *
 * @param text - 失败文案。
 * @returns 绝对时刻（ms）；文案里没有解禁时刻时 `undefined`。
 */
export function unlockAtFromText(text: string): number | undefined {
  if (text.length === 0) return undefined
  const match = /将于\s*(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*解禁/.exec(text)
  if (match === null) return undefined
  const [, y, mo, d, h, mi, s] = match
  const at = new Date(
    Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? '0'), 0,
  ).getTime()
  return Number.isFinite(at) ? at : undefined
}

/**
 * 解析**这一次中断**应当等到什么时候。
 *
 * 三条来源取**最早**：越早到点越安全 —— 到点会先复核号池，仍受限就顺延；
 * 反过来（取最晚）会让用户在本可续跑的时刻干等。
 *
 * @param input.failure - `turn/end` 的 `reason.error`。
 * @param input.now - 当前时刻。
 * @param input.poolResetAt - 号池给出的解禁时刻（可选）。
 * @returns 绝对时刻（ms），永远有值（最差是 `now + FALLBACK_WAIT_MS`）。
 */
export function resolveUnlockAt(input: {
  readonly failure: unknown
  readonly now: number
  readonly poolResetAt?: number | undefined
}): { at: number; source: 'retry-after' | 'text' | 'pool' | 'fallback' } {
  const candidates: Array<{ at: number; source: 'retry-after' | 'text' | 'pool' }> = []
  const failure = input.failure
  if (isRecord(failure)) {
    const retryAfter = failure.providerRetryAfterMs
    if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0) {
      candidates.push({ at: input.now + retryAfter, source: 'retry-after' })
    }
    const fromText = unlockAtFromText(typeof failure.message === 'string' ? failure.message : '')
    if (fromText !== undefined && fromText > input.now) candidates.push({ at: fromText, source: 'text' })
  }
  if (typeof input.poolResetAt === 'number' && Number.isFinite(input.poolResetAt) && input.poolResetAt > input.now) {
    candidates.push({ at: input.poolResetAt, source: 'pool' })
  }
  if (candidates.length === 0) return { at: input.now + FALLBACK_WAIT_MS, source: 'fallback' }
  candidates.sort((left, right) => left.at - right.at)
  return candidates[0]!
}

/** 一条待续跑记录（落盘与 RPC 共用同一形状）。 */
export interface RateLimitResumeHook {
  readonly sessionId: string
  readonly turn: number
  readonly provider: string
  readonly model: string
  readonly kind: RateLimitResumeClass
  /** 解禁时刻（面板展示、`noteAgentLive` 判「该不该抢跑」都读它）。 */
  readonly unlockAtMs: number
  /** 下一次尝试时刻（解禁前 = 解禁时刻；投递失败后 = 现在 + 重试间隔）。 */
  readonly resetAtMs: number
  readonly armed: boolean
  readonly deferrals: number
}

/** 一条决策流水（面板诊断用；只进内存）。 */
export interface RateLimitResumeDecision {
  readonly at: number
  readonly sessionId: string
  readonly message: string
}

/** 引擎对外的可注入副作用（单测据此完整驱动「中断 → 等待 → 解禁 → 续跑」）。 */
export interface RateLimitResumeEngineOptions {
  readonly now?: () => number
  readonly schedule?: (task: () => void, delayMs: number) => unknown
  readonly cancel?: (handle: unknown) => void
  /**
   * 落盘回调。
   *
   * ⚠️ 第三个参数 `resumes`（`sessionId → 已自动续跑次数`）**必须一起落盘**：
   * 那是跨钩子的寿命上限的计数，只存内存的话**重启就是绕过上限的后门**
   * （2026-11-21 对抗审计 P0 的配套要求）。
   */
  readonly persist?: (
    hooks: readonly RateLimitResumeHook[],
    enabled: boolean,
    resumes: Readonly<Record<string, number>>,
  ) => void
  readonly readPoolReset?: (provider: string, model: string) => number | undefined
  readonly deliver?: (hook: RateLimitResumeHook) => { ok: true } | { ok: false; reason: string }
  readonly note?: (decision: RateLimitResumeDecision) => void
  readonly enabled?: boolean
  readonly maxHooks?: number
}

/**
 * 引擎内部的钩子（比公开快照多两个**可变**字段）。
 *
 * ⚠️ 刻意**不** `extends RateLimitResumeHook`：公开快照的字段全是 `readonly`
 * （RPC / 落盘不该被别人改），而引擎自己要就地推进 `resetAtMs` / `deferrals`。
 * 用独立声明把这两个世界分开，比 `as` 或 `-readonly` 断言干净。
 */
interface InternalHook {
  readonly sessionId: string
  readonly turn: number
  readonly provider: string
  readonly model: string
  readonly kind: RateLimitResumeClass
  armed: boolean
  unlockAtMs: number
  resetAtMs: number
  deferrals: number
  timer: unknown
}

/**
 * 创建引擎（纯逻辑，不依赖 cordis）。
 *
 * @param options - 注入的副作用；省略即真实时钟 / `setTimeout`。
 * @returns 引擎。
 */
export function createRateLimitResumeEngine(options: RateLimitResumeEngineOptions = {}) {
  const now = options.now ?? (() => Date.now())
  const schedule = options.schedule ?? ((task, delayMs) => setTimeout(task, delayMs))
  const cancel = options.cancel ?? ((handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>) })
  const persist = options.persist ?? (() => {})
  const readPoolReset = options.readPoolReset ?? (() => undefined)
  const deliver = options.deliver
  const note = options.note ?? (() => {})
  const maxHooks = options.maxHooks !== undefined && options.maxHooks > 0 ? options.maxHooks : MAX_HOOKS

  const hooks = new Map<string, InternalHook>()
  /**
   * **跨钩子**的续跑计数（`sessionId → 已自动续跑次数`）。
   *
   * ⚠️ 必须与 `hooks` 分开：后者是「当前这次中断」，成功投递就 `drop`；
   * 本表记的是「这个会话一共被我们自动拉起来过几次」，只在
   * ①成功投递 +1 ②用户手动发言清零 ③用户从面板移除时清零。
   */
  const resumes = new Map<string, number>()
  const recent: RateLimitResumeDecision[] = []
  let enabled = options.enabled !== false
  let disposed = false

  function snapshot(hook: InternalHook): RateLimitResumeHook {
    return {
      sessionId: hook.sessionId,
      turn: hook.turn,
      provider: hook.provider,
      model: hook.model,
      kind: hook.kind,
      unlockAtMs: hook.unlockAtMs,
      resetAtMs: hook.resetAtMs,
      armed: hook.armed,
      deferrals: hook.deferrals,
    }
  }

  function save(): void {
    persist([...hooks.values()].map(snapshot), enabled, Object.fromEntries(resumes))
  }

  function record(sessionId: string, message: string): void {
    const decision: RateLimitResumeDecision = { at: now(), sessionId, message }
    recent.push(decision)
    if (recent.length > MAX_RECENT) recent.shift()
    note(decision)
  }

  function drop(hook: InternalHook, reason: string): void {
    if (hooks.get(hook.sessionId) !== hook) return
    hooks.delete(hook.sessionId)
    if (hook.timer !== undefined) {
      cancel(hook.timer)
      hook.timer = undefined
    }
    record(hook.sessionId, `放弃待续跑（${reason}）`)
    save()
  }

  function armTimer(hook: InternalHook): void {
    if (hook.timer !== undefined) {
      cancel(hook.timer)
      hook.timer = undefined
    }
    if (disposed || !hook.armed) return
    const raw = hook.resetAtMs - now()
    if (!Number.isFinite(raw)) return
    const delay = Math.min(Math.max(raw, MIN_FIRE_DELAY_MS), MAX_WAIT_MS)
    hook.timer = schedule(() => {
      hook.timer = undefined
      attempt(hook)
    }, delay)
  }

  /** 到点：先复核号池，再投递；投递不成按 {@link RETRY_MS} 重试（**不丢钩子**）。 */
  function attempt(hook: InternalHook): void {
    if (disposed || hooks.get(hook.sessionId) !== hook || !hook.armed) return
    const current = now()
    if (current < hook.unlockAtMs - 1000) {
      // 被提前唤醒（时钟跳变 / 注入的假调度器 / 重试间隔早于解禁时刻）：
      // 解禁时刻还没到，照实重排，别抢跑去撞一次必然失败的墙。
      hook.resetAtMs = hook.unlockAtMs
      armTimer(hook)
      return
    }
    const stillLimitedAt = readPoolReset(hook.provider, hook.model)
    if (typeof stillLimitedAt === 'number' && stillLimitedAt > current) {
      hook.deferrals += 1
      if (hook.deferrals > MAX_DEFERRALS) {
        drop(hook, '解禁时刻被反复推后')
        return
      }
      // 解禁时刻本身被推后：两个时刻一起改（面板要显示新的那个）。
      hook.unlockAtMs = stillLimitedAt
      hook.resetAtMs = stillLimitedAt
      armTimer(hook)
      save()
      record(hook.sessionId, `号池仍受限，顺延到 ${new Date(stillLimitedAt).toISOString()}`)
      return
    }
    if (deliver === undefined) {
      retry(hook, '投递通道未就绪')
      return
    }
    let result: { ok: true } | { ok: false; reason: string }
    try {
      result = deliver(hook)
    } catch (error) {
      result = { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
    if (result.ok) {
      // ★ 成功投递 ⇒ 记一次「已自动续跑」（跨钩子计数，见 MAX_RESUMES_BY_KIND）。
      resumes.set(hook.sessionId, (resumes.get(hook.sessionId) ?? 0) + 1)
      save()
      drop(hook, '已自动继续')
      return
    }
    retry(hook, result.reason)
  }

  function retry(hook: InternalHook, reason: string): void {
    hook.deferrals += 1
    if (hook.deferrals > MAX_DEFERRALS) {
      drop(hook, `重试 ${hook.deferrals} 次仍投不出去：${reason}`)
      return
    }
    // ⚠️ 关键分歧（见模块头第 2 条）：会话不在内存里**不丢钩子**。
    //    解禁常跨越宿主重启 / 用户切走会话；把钩子留着，`agent/created`
    //    或下一次重试就能补上。
    // ⚠️ 只改 `resetAtMs`（下一次尝试），**不动** `unlockAtMs` ——
    //    后者是「号池什么时候真的解禁」，重试间隔不该把它推后。
    hook.resetAtMs = Math.max(now() + RETRY_MS, hook.unlockAtMs)
    armTimer(hook)
    save()
    record(hook.sessionId, `投递未成（${reason}），${Math.round(RETRY_MS / 1000)}s 后重试`)
  }

  return {
    /**
     * 记录一次限流中断。
     *
     * @param input - 失败载荷、账号池给出的解禁时刻与目标会话。
     * @returns 新建的钩子快照；无法记录时 `undefined`。
     */
    noteInterruption(input: {
      readonly sessionId: string
      readonly turn: number
      readonly provider: string
      readonly model: string
      readonly kind: RateLimitResumeClass
      readonly failure: unknown
      readonly poolResetAt?: number | undefined
    }): RateLimitResumeHook | undefined {
      if (disposed) return undefined
      const sessionId = typeof input.sessionId === 'string' ? input.sessionId : ''
      if (sessionId === '') return undefined
      const previous = hooks.get(sessionId)
      if (previous !== undefined) drop(previous, '同一会话又出现新的中断')
      /**
       * ★ **跨钩子的寿命上限**（对抗审计 P0，见 {@link MAX_RESUMES_BY_KIND}）。
       * 少了这一格，「限流 → 解禁 → 继续 → 又限流」会无限循环。
       */
      const used = resumes.get(sessionId) ?? 0
      const cap = MAX_RESUMES_BY_KIND[input.kind]
      if (used >= cap) {
        record(
          sessionId,
          `该会话已自动续跑 ${used} 次（${input.kind} 类上限 ${cap}），本次不再自动继续`
          + ' —— 请手动发送消息，之后计数会重置',
        )
        return undefined
      }
      if (hooks.size >= maxHooks) {
        const oldest = [...hooks.values()].sort((left, right) => left.resetAtMs - right.resetAtMs)[0]
        if (oldest !== undefined) drop(oldest, '待续跑记录过多，淘汰最早的一条')
      }
      const current = now()
      // ⚠️ **就地**算解禁时刻（模块头第 1 条）：这是「按钮有但不继续」的真根因。
      const resolved = resolveUnlockAt({
        failure: input.failure,
        now: current,
        poolResetAt: input.poolResetAt,
      })
      const hook: InternalHook = {
        sessionId,
        turn: Number.isInteger(input.turn) && input.turn > 0 ? input.turn : 0,
        provider: input.provider,
        model: input.model,
        kind: input.kind,
        unlockAtMs: resolved.at,
        resetAtMs: resolved.at,
        armed: enabled,
        deferrals: 0,
        timer: undefined,
      }
      hooks.set(sessionId, hook)
      armTimer(hook)
      save()
      record(
        sessionId,
        `记录限流中断（${resolved.source}：${new Date(resolved.at).toISOString()}，`
        + `${hook.armed ? '将自动继续' : '已关闭自动继续'}）`,
      )
      return snapshot(hook)
    },
    /**
     * 会话真的开了新回合 ⇒ 这个中断已经没人在等，撤掉。
     *
     * ⚠️ 只由「非本次投递」的 `turn/start` 调用（接线层自己判）。
     */
    noteTurnStart(sessionId: string): void {
      const hook = hooks.get(sessionId)
      if (hook !== undefined) drop(hook, '宿主已开启新回合')
    },
    /** 人类亲手发了消息 ⇒ 用户已经自己接了手，撤掉。 */
    noteUserMessage(sessionId: string): void {
      const hook = hooks.get(sessionId)
      if (hook !== undefined) drop(hook, '用户手动发送了消息')
      /**
       * ★ **用户回来了 ⇒ 自动续跑计数清零**（对抗审计 P0 配套）。
       * 不清零的话，用户正常聊了几轮之后再撞一次限流就会被「上限已到」拒绝，
       * 而那与「连续被限流」完全不是一回事。
       */
      if (resumes.delete(sessionId)) save()
    },
    /** 某个会话的 agent 真的被销毁：**不撤钩子**（见模块头第 2 条），只记一笔。 */
    noteAgentGone(sessionId: string): void {
      const hook = hooks.get(sessionId)
      if (hook !== undefined) record(sessionId, '会话当前不在内存，等它回来再继续')
    },
    /** 会话重新变成 live ⇒ 立刻补一次投递（用户一打开就续上）。 */
    noteAgentLive(sessionId: string): void {
      const hook = hooks.get(sessionId)
      if (hook === undefined || disposed || !hook.armed) return
      // 解禁时刻还没到就别抢跑 —— 重排到解禁时刻即可。
      // ⚠️ 判据读 `unlockAtMs`（不是 `resetAtMs`）：后者可能因为上一次投递失败被推到
      //    「现在 + 2 分钟」，而那和解禁没关系。用户刚打开会话这一刻正是补发的时机。
      if (now() < hook.unlockAtMs - 1000) {
        hook.resetAtMs = hook.unlockAtMs
        armTimer(hook)
        return
      }
      if (hook.timer !== undefined) {
        cancel(hook.timer)
        hook.timer = undefined
      }
      attempt(hook)
    },
    /**
     * 切换某个会话的 armed。
     *
     * @returns 更新后的快照；没有待续跑记录时 `undefined`（客户端据此收按钮）。
     */
    setArmed(sessionId: string, armed: boolean): RateLimitResumeHook | undefined {
      const hook = hooks.get(sessionId)
      if (hook === undefined) return undefined
      hook.armed = armed === true
      if (hook.armed) armTimer(hook)
      else if (hook.timer !== undefined) {
        cancel(hook.timer)
        hook.timer = undefined
      }
      save()
      record(sessionId, hook.armed ? '用户打开「解禁后自动继续」' : '用户关闭「解禁后自动继续」')
      return snapshot(hook)
    },
    /** 立刻试一次（面板上的「立即继续」）。 */
    fireNow(sessionId: string): { ok: boolean; reason: string } {
      const hook = hooks.get(sessionId)
      if (hook === undefined) return { ok: false, reason: '该会话没有待续跑记录' }
      if (deliver === undefined) return { ok: false, reason: '投递通道未就绪' }
      let result: { ok: true } | { ok: false; reason: string }
      try {
        result = deliver(hook)
      } catch (error) {
        result = { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
      if (result.ok) {
        drop(hook, '手动「立即继续」成功')
        return { ok: true, reason: '' }
      }
      record(sessionId, `手动「立即继续」失败：${result.reason}`)
      return { ok: false, reason: result.reason }
    },
    /** 改全局默认（只影响**之后**的中断）。 */
    setEnabled(value: boolean): boolean {
      enabled = value === true
      /**
       * ★ **必须追溯已挂着的钩子**（2026-11-21 对抗审计 P1）。
       *
       * 原实现只改 `enabled` 一个布尔就 `save()` ⇒ 用户**当下**关掉开关之后，
       * 已经挂上定时器的那些钩子**照样会到点投递**（审计实测：关掉后仍 fired=1）。
       * 这不是「下次生效」的问题 —— 用户的意思是「现在别动我的会话」。
       *
       * ⇒ 关：逐个取消武装 + 取消定时器（`armTimer` 见到 `!hook.armed` 会自己
       *    清掉 timer 且不重排）；开：把落盘里仍 `armed` 的钩子重新武装回来。
       * ⚠️ 不 `drop` 它们 —— 钩子本身是「待续跑」的事实，开关只管「要不要自动做」。
       */
      for (const hook of hooks.values()) {
        hook.armed = enabled
        armTimer(hook)
      }
      save()
      return enabled
    },
    /** 读当前状态（RPC 与持久化都走它）。 */
    status(): {
      enabled: boolean
      hooks: readonly RateLimitResumeHook[]
      recent: readonly RateLimitResumeDecision[]
    } {
      return {
        enabled,
        hooks: [...hooks.values()]
          .map(snapshot)
          .sort((left, right) => left.resetAtMs - right.resetAtMs),
        recent: [...recent],
      }
    },
    /** 按各自解禁时刻重排全部定时器（agents 就绪 / 宿主启动恢复后调用）。 */
    rearm(): void {
      for (const hook of hooks.values()) armTimer(hook)
    },
    /** 从持久化文档恢复。 */
    restore(list: unknown, savedResumes?: unknown): void {
      /**
       * ★ 恢复**跨钩子续跑计数**（对抗审计 P0 配套）。先于 hooks 恢复，
       * 因为下面「跳过已过期记录」不该影响计数 —— 计数反映的是**历史**，
       * 与那条钩子还在不在无关（否则关一次宿主就能绕过上限）。
       */
      if (isRecord(savedResumes)) {
        for (const [sessionId, value] of Object.entries(savedResumes)) {
          if (sessionId === '') continue
          if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) continue
          resumes.set(sessionId, value)
        }
      }
      if (!Array.isArray(list)) return
      const current = now()
      for (const raw of list) {
        if (!isRecord(raw)) continue
        const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : ''
        if (sessionId === '' || hooks.has(sessionId)) continue
        const resetAtMs = typeof raw.resetAtMs === 'number' && Number.isFinite(raw.resetAtMs)
          ? raw.resetAtMs
          : undefined
        if (resetAtMs === undefined) continue
        // 早于「现在 - 最长等待」的记录已经毫无意义（宿主可能关了很多天）。
        if (resetAtMs < current - MAX_WAIT_MS) continue
        const unlockAtMs = typeof raw.unlockAtMs === 'number' && Number.isFinite(raw.unlockAtMs)
          ? raw.unlockAtMs
          : resetAtMs
        hooks.set(sessionId, {
          sessionId,
          turn: typeof raw.turn === 'number' && Number.isInteger(raw.turn) && raw.turn > 0 ? raw.turn : 0,
          provider: typeof raw.provider === 'string' ? raw.provider : '',
          model: typeof raw.model === 'string' ? raw.model : '',
          kind: raw.kind === 'quota' ? 'quota' : 'rate',
          unlockAtMs,
          resetAtMs,
          /**
           * ★ **全局开关必须管住落盘的已武装钩子**（对抗审计 P1）。
           *
           * 原实现是 `armed: raw.armed !== false` ⇒ 用户明确设了
           * `DSH_RATE_LIMIT_RESUME=0`（或界面上关掉）之后，重启时**落盘里
           * `armed: true` 的钩子照样被武装**、到点照样发请求。
           * 审计实测：env=0 + 落盘 armed:true ⇒ 仍然 followup。
           * ⇒ 只有引擎**整体启用**时才继承落盘的 armed。
           */
          armed: enabled && raw.armed !== false,
          deferrals: typeof raw.deferrals === 'number' && Number.isInteger(raw.deferrals) && raw.deferrals >= 0
            ? Math.min(raw.deferrals, MAX_DEFERRALS)
            : 0,
          timer: undefined,
        })
        record(sessionId, '从落盘记录恢复待续跑')
      }
      for (const hook of hooks.values()) armTimer(hook)
      save()
    },
    /** 丢掉某个会话的钩子（面板「移除」用）。 */
    forget(sessionId: string): void {
      const hook = hooks.get(sessionId)
      if (hook !== undefined) drop(hook, '用户移除')
      if (resumes.delete(sessionId)) save()
    },
    /** 关闭引擎：清掉全部定时器（fiber 卸载时调用，必须幂等且不抛错）。 */
    dispose(): void {
      disposed = true
      for (const hook of hooks.values()) {
        if (hook.timer !== undefined) {
          cancel(hook.timer)
          hook.timer = undefined
        }
      }
      hooks.clear()
    },
  }
}

/** 引擎类型（install 与 RPC 共用）。 */
export type RateLimitResumeEngine = ReturnType<typeof createRateLimitResumeEngine>

/** 模块级单例：RPC 侧与宿主监听器共用同一个引擎。 */
let controller: RateLimitResumeEngine | undefined

/** 读 RPC 状态（客户端按钮与设置开关都走它）。 */
export function readRateLimitResumeState(sessionId?: string): {
  enabled: boolean
  available: boolean
  hooks: readonly RateLimitResumeHook[]
  recent: readonly RateLimitResumeDecision[]
} {
  const engine = controller
  if (engine === undefined) return { enabled: true, available: false, hooks: [], recent: [] }
  const status = engine.status()
  const hooks = typeof sessionId === 'string' && sessionId !== ''
    ? status.hooks.filter(hook => hook.sessionId === sessionId)
    : status.hooks
  return { enabled: status.enabled, available: true, hooks, recent: status.recent }
}

/** 切换某个会话的 armed（RPC 用）。 */
export function setRateLimitResumeArmed(sessionId: string, armed: boolean): RateLimitResumeHook | undefined {
  return controller?.setArmed(sessionId, armed)
}

/** 改全局默认（RPC 用）。 */
export function setRateLimitResumeEnabled(enabled: boolean): boolean | undefined {
  return controller?.setEnabled(enabled)
}

/** 立刻续跑一次（RPC 用）。 */
export function fireRateLimitResumeNow(sessionId: string): { ok: boolean; reason: string } {
  return controller?.fireNow(sessionId) ?? { ok: false, reason: '功能未装到宿主' }
}

/** 移除某个会话的待续跑（RPC 用）。 */
export function forgetRateLimitResume(sessionId: string): void {
  controller?.forget(sessionId)
}

/** 会话在 `session/event` 里出现的最小面（结构类型，避免依赖 dsh-session 的导出）。 */
interface ObservedSession {
  readonly id?: unknown
  requestHeader?: () => unknown
}

/** `session/event` 载荷的最小面。 */
interface ObservedEvent {
  readonly type?: unknown
  readonly data?: unknown
}

/** agent 的最小面（续跑只需要「id / 会话状态 / 排队一条 followup」）。 */
interface ResumeAgent {
  readonly id: string
  readonly status?: string
  followup(message: UserMessage): void
}

/** agents 作用域的最小面。 */
interface AgentsScope {
  readonly agents: {
    get(id: string): ResumeAgent | undefined
    withoutInitiator?: <T>(operation: () => T) => T
  }
  on(event: string, listener: (payload: { agent: ResumeAgent }) => void): () => void
}

/**
 * 读 `session/event` 里的 provider / model（`request/header` 折叠值）。
 */
function targetOf(session: ObservedSession): { provider: string; model: string } {
  let header: unknown
  try {
    header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
  } catch {
    header = undefined
  }
  const config = isRecord(header) ? header.config : undefined
  return {
    provider: isRecord(config) && typeof config.provider === 'string' ? config.provider : '',
    model: isRecord(config) && typeof config.model === 'string' ? config.model : '',
  }
}

/** 读 `turn/end` 的失败载荷（不是 error 收尾时 `undefined`）。 */
function failureOf(event: ObservedEvent): unknown {
  const data = event.data
  if (!isRecord(data)) return undefined
  const reason = data.reason
  if (!isRecord(reason)) return undefined
  if (reason.kind !== 'error') return undefined
  return reason.error
}

/** 落盘 / 读盘的文档形状。 */
interface PersistedDocument {
  enabled: boolean
  hooks: unknown
  /** `sessionId → 已自动续跑次数`（跨钩子寿命上限的计数，必须落盘）。 */
  resumes: unknown
}

/**
 * 装上「限流中断后解禁再继续」。
 *
 * ⚠️ `agents` 用 `ctx.inject(['agents'], …)` 而**不**写进静态 `inject`：没有
 * agent-loop 的 profile 里静态 inject 会让本插件永久 pending、整个 profile
 * 起不来（与 `index.ts` 的 `inject` 注释同因）。缺席时只是投不出去。
 *
 * @param ctx - 插件上下文。
 * @param pool - 账号池（读限流标记；可选）。
 */
export function installRateLimitResume(ctx: Context, pool: AccountPool): void {
  if (controller !== undefined) {
    // fiber 重启时旧实例可能还没 dispose：先撤旧的，再把新的挂上。
    try { controller.dispose() } catch { /* 旧实例已坏也无所谓 */ }
    controller = undefined
  }

  const home = resolveJetHubHome(ctx)
  const file = home === undefined ? undefined : join(home, 'jet-hub', RATE_LIMIT_RESUME_FILE)

  function load(): PersistedDocument {
    if (file === undefined || !existsSync(file)) return { enabled: true, hooks: [], resumes: {} }
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'))
      if (!isRecord(parsed)) return { enabled: true, hooks: [], resumes: {} }
      return { enabled: parsed.enabled !== false, hooks: parsed.hooks, resumes: parsed.resumes }
    } catch (error) {
      ctx.logger?.warn?.(`[jet-hub] 读取 ${file} 失败，限流续跑按默认（开启）处理: ${String(error)}`)
      return { enabled: true, hooks: [], resumes: {} }
    }
  }

  function save(
    hooks: readonly RateLimitResumeHook[],
    enabled: boolean,
    resumes: Readonly<Record<string, number>>,
  ): void {
    if (file === undefined) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, `${JSON.stringify({ schema: SCHEMA, enabled, hooks, resumes }, null, 2)}\n`, 'utf-8')
      renameSync(tmp, file)
    } catch (error) {
      ctx.logger?.warn?.(`[jet-hub] 写入 ${file} 失败: ${String(error)}`)
    }
  }

  const loaded = load()
  let agentsScope: AgentsScope | undefined
  /** 本次投递出去的会话集合：用于区分「我们自己的 user/message / turn/start」。 */
  const delivering = new Set<string>()

  const engine = createRateLimitResumeEngine({
    // ⚠️ 两份开关是**与**关系：环境变量是「这个宿主根本不要这个功能」，落盘值是
    //    「用户在界面上关过」。先把落盘值写进引擎（设置页读它），再让环境变量
    //    直接把默认值压成 false。
    enabled: loaded.enabled && rateLimitResumeEnabled(),
    persist: (hooks, enabled, resumes) => save(hooks, enabled, resumes),
    note: (decision) => {
      ctx.logger?.info?.(`[jet-hub] 限流续跑 ${decision.sessionId}: ${decision.message}`)
    },
    readPoolReset: (provider, model) => {
      try {
        if (provider === '' || model === '') return undefined
        const limited = allAccountsRateLimitedForModel(
          pool.listAccountsByProvider(provider).filter(account => account.enabled),
          model,
          Date.now(),
        )
        return limited?.resetAtMs
      } catch (error) {
        ctx.logger?.warn?.(`[jet-hub] 读限流标记失败（${provider}/${model}）: ${String(error)}`)
        return undefined
      }
    },
    deliver: (hook) => {
      const scope = agentsScope
      if (scope === undefined) return { ok: false, reason: 'agents 未就绪' }
      const agent = scope.agents.get(hook.sessionId)
      if (agent === undefined) return { ok: false, reason: '会话不在内存（会在它回来时再试）' }
      let message: UserMessage
      try {
        message = createUserMessage({
          content: [{ type: 'text', text: RATE_LIMIT_RESUME_PROMPT }],
          // ⚠️⚠️ **自有来源标识，绝不伪造成 `'user'`**（理由见模块头）。
          source: { kind: RATE_LIMIT_RESUME_SOURCE_KIND },
        })
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
      const run = (): void => {
        delivering.add(hook.sessionId)
        try {
          agent.followup(message)
        } finally {
          // followup 会同步派发 user/message；下一个宏任务前一直算「我们在投递」。
          setTimeout(() => { delivering.delete(hook.sessionId) }, 0)
        }
      }
      const withoutInitiator = scope.agents.withoutInitiator
      if (typeof withoutInitiator === 'function') withoutInitiator.call(scope.agents, run)
      else run()
      return { ok: true }
    },
  })

  const disposers: Array<() => void> = []
  const onSessionEvent = (session: ObservedSession, event: ObservedEvent): void => {
    const sessionId = typeof session.id === 'string' ? session.id : ''
    if (sessionId === '' || !isRecord(event)) return
    if (event.type === 'turn/start') {
      // ⚠️ 我们自己投递引发的 turn/start 不能撤钩子（那时钩子已经在投递成功时删掉了，
      //    这里只是防御：投递期间的重入）。
      if (delivering.has(sessionId)) return
      engine.noteTurnStart(sessionId)
      return
    }
    if (event.type === 'user/message') {
      // ⚠️ 只有**人类**输入才撤（模块头第 3 条）：`runtime-context` /
      //    `dsh-memory` / `skill-catalog` 等注入也以 user/message 落盘。
      const source = isRecord(event.data) ? event.data.source : undefined
      if (isRecord(source) && source.kind === 'user') engine.noteUserMessage(sessionId)
      return
    }
    if (event.type !== 'turn/end') return
    const failure = failureOf(event)
    if (failure === undefined) {
      // 这一轮正常收尾 ⇒ 之前那个中断当然不该再续。
      engine.noteTurnStart(sessionId)
      return
    }
    const kind = classifyRateLimitFailure(failure)
    if (kind === undefined) return
    const target = targetOf(session)
    const data = isRecord(event.data) ? event.data : {}
    // 记录那一刻就把号池里的解禁时刻取出来（模块头第 1 条）。
    let poolResetAt: number | undefined
    try {
      if (target.provider !== '' && target.model !== '') {
        poolResetAt = allAccountsRateLimitedForModel(
          pool.listAccountsByProvider(target.provider).filter(account => account.enabled),
          target.model,
          Date.now(),
        )?.resetAtMs
      }
    } catch {
      poolResetAt = undefined
    }
    engine.noteInterruption({
      sessionId,
      turn: typeof data.turn === 'number' ? data.turn : 0,
      provider: target.provider,
      model: target.model,
      kind,
      failure,
      poolResetAt,
    })
  }

  if (typeof ctx.on === 'function') {
    // ⚠️ 事件名走 `as never`：`session/event` 的声明由 `@deepseek-ai/dsh-session`
    //    提供，而它不在本包的依赖表里（本模块刻意只依赖 dsh-llm 的运行时）。
    const dispose = (ctx.on as unknown as (
      name: string,
      listener: (session: ObservedSession, event: ObservedEvent) => void,
    ) => () => void)('session/event', onSessionEvent)
    if (typeof dispose === 'function') disposers.push(dispose)
  }

  controller = engine
  engine.restore(loaded.hooks, loaded.resumes)

  ctx.inject(['agents'], (scope) => {
    const typed = scope as unknown as AgentsScope
    agentsScope = typed
    // agents 到位后按原解禁时刻重排一遍（可能因为缺通道被推迟过）。
    engine.rearm()
    // 会话重新变成 live ⇒ 立刻补一次投递（用户一打开那个会话就续上）。
    const offCreated = typed.on('agent/created', ({ agent }) => { engine.noteAgentLive(agent.id) })
    if (typeof offCreated === 'function') disposers.push(offCreated)
    const offDisposed = typed.on('agent/disposed', ({ agent }) => { engine.noteAgentGone(agent.id) })
    if (typeof offDisposed === 'function') disposers.push(offDisposed)
  })

  ctx.effect(() => () => {
    agentsScope = undefined
    if (controller === engine) controller = undefined
    for (const dispose of disposers) {
      try { dispose() } catch { /* 幂等 */ }
    }
    try { engine.dispose() } catch { /* 幂等 */ }
  }, 'jet-hub: rate-limit resume')
}
