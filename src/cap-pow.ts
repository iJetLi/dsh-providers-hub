/**
 * Cap 验证码的 **proof-of-work 求解器**（MonkeyCode / 百智云共用）。
 *
 * 两家的签到接口都要求先过同一套「挑战 → 本地求解 → 兑换」的人机验证：
 *
 *     POST /api/v1/public/captcha/challenge  → { token, challenge: { c, s, d } }
 *     （本地求解 c 道题）
 *     POST /api/v1/public/captcha/redeem     → { token: '<8hex>:<15hex>', success }
 *
 * 求解算法见 {@link solveChallenge}（与平台前端逐字节同构，`fnv1a32` 派生 PRNG +
 * SHA-256 前缀碰撞）。⚠️ 这里是**纯计算**，没有任何规避行为：题目就是让你算的，
 * 网页版也是浏览器里算。
 *
 * ## 为什么抽成独立模块（2026-11-03）
 *
 * 该算法先在 `monkeycode-credits.ts` 里落地并经真机验证（redeem 200）。百智云的
 * 签到接的是**同一套 Cap 协议**（同一家平台的两个站），若复制一份实现，任何
 * 一处（`i+1` 的 1-based 题号、hex 前缀比较、xorshift 的 `>>> 0`）漂移都会
 * 让另一家**必然签到失败**，而失败文案只会说「验证失败」。与
 * `session-cookie.ts` 的抽取同因：同一份协议只留一份实现。
 *
 * @module src/cap-pow.ts
 */

import { createHash } from 'node:crypto'

/** 平台下发的 PoW 挑战。 */
export interface CapChallenge {
  /** 题目数（实测 50）。 */
  readonly count: number
  /** 每题 salt 的十六进制长度（实测 32）。 */
  readonly saltLength: number
  /** 每题 target 的十六进制长度（实测 3 ⇒ 期望 4096 次尝试/题）。 */
  readonly targetLength: number
}

/** 每题尝试次数上限（防上游形态变化导致死循环）。 */
const MAX_POW_ATTEMPTS_PER_QUESTION = 20_000_000

/**
 * 一次签到的**总**尝试预算（所有题合计）。
 *
 * ⚠️⚠️ 2026-11-03 合并审计 P1：原先只有「每题 2000 万次」的上限，而上游下发的
 * `c` 最大允许 500、`d` 最大允许 16 ⇒ 理论最坏 `500 × 2000 万 = 100 亿`次
 * SHA-256（本机实测约 73 万次/秒 ⇒ **数小时**同步阻塞）。这不是假设：`d` 是
 * **服务端下发**的，上游一旦调难度或报文被篡改，宿主的事件循环会被整条冻住，
 * 所有 provider 调度与面板心跳一起停摆。
 *
 * 现网实测 `c=50, s=32, d=3`（50 题合计约 0.2s）。这里留 500 万次（≈7s）的
 * 总量：比真实形态宽 20 倍以上，又不可能把宿主冻住数小时。超限时**抛错并说清
 * 楚**，绝不静默降级成「签到失败」。
 */
const MAX_POW_ATTEMPTS_TOTAL = 5_000_000

/**
 * FNV-1a 32 位哈希（与上游 cap.js 前端**逐字符同构**）。
 *
 * 上游（`@cap.js/core` 的 `fnv1a`，2026-11-03 从 `index-0rgNk17_.js` 逐行取证）是：
 *
 * ```js
 * let f = 2166136261
 * for (let g = 0; g < p.length; g++) {
 *   f ^= p.charCodeAt(g)
 *   f += (f << 1) + (f << 4) + (f << 7) + (f << 8) + (f << 24)
 * }
 * return f >>> 0
 * ```
 *
 * ⚠️ 三点与「教科书 FNV-1a」不同，改任一处都会让**全部签到失败**：
 * 1. 输入是 **UTF-16 code unit**（`charCodeAt`），不是 UTF-8 字节；
 * 2. 乘法写成**五次移位相加**，且中间值不 `>>> 0`（依赖 JS 的 ToInt32 截断）；
 * 3. 只有返回时才 `>>> 0`。
 *
 * ⚠️ 这里用 `Math.imul` 代替「移位相加」是**数学等价**的：移位相加的值等于
 * `f * 16777619`，而 `Math.imul` 正是「32 位整数乘法取低 32 位」；只要输入是
 * code unit，两者对全部 2^32 输入逐值相同。**但不要顺手改成 UTF-8 字节**——
 * 那对非 ASCII 的 seed（含中文的 token）会漂。2026-11-03 真机 redeem 200 验证。
 */
function fnv1a32(data: string): number {
  let hash = 2166136261
  for (let index = 0; index < data.length; index += 1) {
    hash ^= data.charCodeAt(index)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash >>> 0
}

/**
 * 由 seed 派生 `length` 位十六进制串（平台的 xorshift32 变体）。
 *
 * 每轮产出 8 位十六进制（`state` 的补零形式），拼够长度后**截断** ——
 * 与平台前端的 `out.push(f"{state:08x}")` + `"".join(out)[:length]` 同义。
 */
export function prng(seed: string, length: number): string {
  let state = fnv1a32(seed)
  let out = ''
  while (out.length < length) {
    // 三次移位异或：13 左、17 右、5 左。每步都要 `>>> 0`，因为 JS 的位运算
    // 结果是**有符号** 32 位整数（最高位为 1 时变负数），不转无符号会让后续
    // `toString(16)` 带负号、与前端的 `& 0xFFFFFFFF` 不一致。
    state = (state ^ ((state << 13) >>> 0)) >>> 0
    state = (state ^ (state >>> 17)) >>> 0
    state = (state ^ ((state << 5) >>> 0)) >>> 0
    out += state.toString(16).padStart(8, '0')
  }
  return out.slice(0, length)
}

/**
 * 解一道题：找最小的 `n`，使 `sha256(salt + n)` 的十六进制前缀等于 `target`。
 *
 * 期望尝试次数 = `16 ** targetLength`（d=3 ⇒ 4096 次），实测 50 题合计约 0.2s。
 *
 * ⚠️ 比较口径是**十六进制前缀**（`digest.startsWith(target)`），不是「前
 * `target.length/2` 个字节」。上游浏览器走 WASM 求解器（`solve_pow`），它与
 * 这句 JS 同口径；前端那份**字节比较**的 fallback 只在 WASM 不可用时生效，
 * 且对奇数 `d` 会少比较半个字节 —— 不要照抄它（2026-11-03 实测：按字节比较
 * 会被 redeem 判 `invalid solutions`，按 hex 前缀则 200）。
 */
function solveOne(salt: string, target: string, budget: { remaining: number }): number {
  for (let n = 0; n < MAX_POW_ATTEMPTS_PER_QUESTION; n += 1) {
    budget.remaining -= 1
    if (budget.remaining < 0) {
      throw new Error(
        `签到验证题累计求解超过 ${MAX_POW_ATTEMPTS_TOTAL} 次（target=${target}，`
        + '上游可能提高了难度）—— 已放弃本次签到，请稍后重试',
      )
    }
    const digest = createHash('sha256').update(salt + String(n)).digest('hex')
    if (digest.startsWith(target)) return n
  }
  throw new Error(
    `签到验证题求解超过 ${MAX_POW_ATTEMPTS_PER_QUESTION} 次仍未命中（target=${target}，`
    + '上游可能提高了难度）—— 已放弃本次签到，请稍后重试',
  )
}

/**
 * 解整个挑战：返回 `count` 个解（数组顺序与题号一致，**不能排序或去重**）。
 *
 * 第 `i` 题（从 0 开始）的两个派生种子是：
 * - `target = prng(token + (i+1) + 'd', targetLength)`
 * - `salt   = prng(token + (i+1),        saltLength)`
 *
 * ⚠️ `i+1` 是**题号从 1 开始**，与前端一致；写成 `i` 会让 redeem 必然失败
 *（服务端按 1-based 校验），而失败文案只会说「验证失败」，极难反推。
 *
 * ⚠️ 本函数是**同步**的（纯计算，便于单测与固定向量）。生产路径请用
 * {@link solveChallengeYielding}：它每解完一题让出一次事件循环，且共用
 * {@link MAX_POW_ATTEMPTS_TOTAL} 预算。
 */
export function solveChallenge(
  token: string,
  challenge: CapChallenge,
  budget: { remaining: number } = { remaining: MAX_POW_ATTEMPTS_TOTAL },
): number[] {
  const solutions: number[] = []
  for (let index = 0; index < challenge.count; index += 1) {
    const ordinal = index + 1
    const target = prng(`${token}${ordinal}d`, challenge.targetLength)
    const salt = prng(`${token}${ordinal}`, challenge.saltLength)
    solutions.push(solveOne(salt, target, budget))
  }
  return solutions
}

/**
 * 与 {@link solveChallenge} 同算法，但**每解完一题 `await` 一次**。
 *
 * ⚠️ 目的是**不让宿主的单条事件循环被 PoW 独占**：现网 50 题约 0.2s，一次同步
 * 跑完通常无感；但「上游调高难度 / 报文被篡改」时同步版本会冻结数秒到数小时
 * （见 {@link MAX_POW_ATTEMPTS_TOTAL} 的推导）。分片后即使命中总预算上限，
 * 期间其余 provider 的调度与面板心跳仍能推进。
 */
export async function solveChallengeYielding(
  token: string,
  challenge: CapChallenge,
  budget: { remaining: number } = { remaining: MAX_POW_ATTEMPTS_TOTAL },
): Promise<number[]> {
  const solutions: number[] = []
  for (let index = 0; index < challenge.count; index += 1) {
    const ordinal = index + 1
    const target = prng(`${token}${ordinal}d`, challenge.targetLength)
    const salt = prng(`${token}${ordinal}`, challenge.saltLength)
    solutions.push(solveOne(salt, target, budget))
    // 让出事件循环：`setImmediate` 在 Node 里每轮只排一次，不会把定时器饿死。
    await new Promise<void>((resolve) => { setImmediate(resolve) })
  }
  return solutions
}

/** 安全读数字。 */
function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 读挑战报文（`{ token, challenge: { c, s, d } }`，**已解包**后的业务对象）。
 *
 * ⚠️ 调用方必须先剥掉 `{ code, data }` 信封 —— 直接把原始报文传进来会被判成
 * 「没有 token」，签到永远失败且文案指向「上游改版」。
 */
export function readCapChallenge(data: unknown): { token: string; challenge: CapChallenge } | { error: string } {
  if (data === null || typeof data !== 'object') {
    return { error: '签到验证题报文不是对象（上游形态可能已变）' }
  }
  const raw = data as { token?: unknown, challenge?: unknown }
  const token = typeof raw.token === 'string' ? raw.token.trim() : ''
  if (token.length === 0) return { error: '签到验证题报文里没有 token（上游形态可能已变）' }
  const challenge = raw.challenge
  if (challenge === null || typeof challenge !== 'object') {
    return { error: '签到验证题报文里没有 challenge（上游形态可能已变）' }
  }
  const { c, s, d } = challenge as { c?: unknown, s?: unknown, d?: unknown }
  const count = readNumber(c)
  const saltLength = readNumber(s)
  const targetLength = readNumber(d)
  if (count === undefined || saltLength === undefined || targetLength === undefined) {
    return { error: '签到验证题的 c/s/d 字段缺失或不是数字（上游形态可能已变）' }
  }
  // 防御性上限：这些数字直接决定本地计算量，上游一旦给错（例如 c=10^9），
  // 不加闸门就是一次卡死整个宿主的事件循环的长任务。
  if (count < 1 || count > 500 || saltLength < 1 || saltLength > 256
    || targetLength < 1 || targetLength > 16) {
    return { error: `签到验证题参数超出合理范围（c=${count}, s=${saltLength}, d=${targetLength}）` }
  }
  return { token, challenge: { count: Math.floor(count), saltLength: Math.floor(saltLength), targetLength: Math.floor(targetLength) } }
}

/** 从 redeem 响应里取验证 token（形如 `<8hex>:<15hex>`，**已解包**后的业务对象）。 */
export function readCapToken(data: unknown): string | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const raw = data as { token?: unknown, success?: unknown }
  if (raw.success === false) return undefined
  const token = typeof raw.token === 'string' ? raw.token.trim() : ''
  return token.length === 0 ? undefined : token
}
