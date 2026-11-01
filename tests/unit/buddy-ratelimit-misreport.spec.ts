/**
 * 回归：**全部启用账号都被目标模型限流**时，必须报「限流 + 解禁时刻」，
 * 而不是误导性的 `no usable credential; log in from the Jet Hub panel first`。
 *
 * ## 原始症状（真实缺陷，2026-10-03）
 *
 * 用户 `/compact` 连续四次失败，UI 只显示通用文案
 * 「Compaction could not produce a useful summary」；解出会话日志后发现
 * `compaction/end` 携带的真实错误是
 * `buddy: no usable credential; log in from the Jet Hub panel first`。
 *
 * 而当时 Jet Hub 里 buddy 账号**已登录、已启用**，凭据完全可用 —— 真实原因
 * 是它被 `deepseek-v4.1-flash` 的模型级限流标记挡住（解禁时刻就存在
 * `modelRateLimits` 里，插件却一个字都没往外报）。用户被指去「重新登录」，
 * 方向完全错。
 *
 * ## 链路
 *
 * 唯一启用账号被限流 → 候选筛成空集 →
 * `select()` 回笼统的 `exhausted`（未锁定时 `reason` 被丢弃）→ 退到单凭据
 * ref `BUDDY_ACCESS_TOKEN`（Jet Hub 登录只写 `*_ACCOUNT_XXX`，该 ref 不存在）
 * → 适配器抛 `MISSING_CREDENTIAL`。
 *
 * ⚠️ 候选筛原先实现在 `src/index.ts` 里那个**已被删除**的 buddy 系编排闭包中
 * （名字见 git 历史 `d35d9e3`）；Task 6 起收敛到 `src/credential-resolver.ts`
 * 的 buddy 分支。此处**不复写那个已删符号名** —— 它是「锚点已消失」核对会 grep
 * 的字符串（同 `raccoon-wiring.spec.ts` 的约定）。
 *
 * ## 与既有用例的关系
 *
 * 与 `buddy-wiring.spec.ts` / `buddy-free-model-lock.spec.ts` 同款：既做
 * **行为级**验证（判据必须对），也做**源码级**接线断言（接线不能断）。
 * 后者刻意用「剥注释后的源码」判定，避免因注释里提到某符号而误判。
 *
 * ⚠️ 本补丁**只改错误语义，不改可用性**：没有账号可用就是没有，压缩该失败
 * 仍然失败。因此用例同时锁死「不绕过限流标记」「不静默换模型」两条红线。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { allAccountsRateLimitedForModel } from '../../src/account-pool.js'
import type { ProviderAccountEntry } from '../../src/types.js'

const here = dirname(fileURLToPath(import.meta.url))
const indexSource = readFileSync(resolve(here, '../../src/index.ts'), 'utf8').replace(/\r\n/g, '\n')
const poolSource = readFileSync(resolve(here, '../../src/account-pool.ts'), 'utf8').replace(/\r\n/g, '\n')

/** 剥掉注释后的源码。⚠️ 接线断言必须只看代码，不能因「注释里提到某符号」而误判。 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const indexCode = codeOnly(indexSource)
const poolCode = codeOnly(poolSource)

/**
 * 取**一次 `createCredentialResolver(...)` 调用**的完整源码（**括号配平**切片）。
 *
 * ## ⚠️ 为什么必须配平，不能用固定长度窗口（2026-10-08 复审修正）
 *
 * 原先用「从 `product: ZCODE,` 往后 1500 字符」这种**定长窗口**。实测该窗口
 * 越过配置块 **1333 字符**，把后面的 `refresh:`（`zcode.refreshAll(pool)`）与
 * `mintCaptcha` 段一起圈了进来 —— 于是
 *
 * - 「块内不得出现 `throwIfAllRateLimited`」实际上在守**别的代码段**；
 * - 将来谁在 `refresh` / `mintCaptcha` 里写了同名字符串，本用例会**假红**；
 * - 反过来，配置块**缩小**到窗口之内时判据也仍然成立 —— 判据与它声称守的东西
 *   之间的对应关系是靠**距离**维系的，而距离会随任何无关编辑漂移。
 *
 * ⇒ 改为按括号配平取「这次调用本身」：与 `source-scope.ts` 的 AST 取函数体同一
 * 取向（那里记了字符串切片的两次同型事故），只是这里切的是**调用表达式**而非声明。
 *
 * @param source - 已剥注释的源码。
 * @param callStart - `createCredentialResolver(` 在源码里的起始下标。
 */
function factoryCallAt(source: string, callStart: number): string {
  const open = source.indexOf('(', callStart)
  if (open < 0) throw new Error('createCredentialResolver 后面没有左括号')
  let depth = 0
  for (let i = open; i < source.length; i++) {
    const ch = source[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return source.slice(callStart, i + 1)
    }
  }
  throw new Error('createCredentialResolver 的括号没有配平（源码被截断？）')
}

const NOW = 1_791_009_000_000

/** 构造一个启用账号，可带某模型的限流时刻。 */
function account(
  id: string,
  modelRateLimits?: Record<string, number>,
  enabled = true,
): ProviderAccountEntry {
  return {
    id,
    provider: 'buddy',
    nickname: id,
    enabled,
    credentialRef: `BUDDY_ACCOUNT_${id.toUpperCase()}`,
    createdAt: 0,
    refreshable: true,
    ...modelRateLimits === undefined ? {} : { modelRateLimits },
  }
}

describe('全部账号被模型限流时，报限流而非「未登录」', () => {
  describe('判据（行为级）', () => {
    it('唯一启用账号被该模型限流 → 命中，并给出解禁时刻', () => {
      const reset = NOW + 3_600_000
      const got = allAccountsRateLimitedForModel(
        [account('a', { 'deepseek-v4.1-flash': reset })],
        'deepseek-v4.1-flash',
        NOW,
      )
      expect(got).toEqual({ resetAtMs: reset, accountCount: 1 })
    })

    it('多个账号全被限流 → 取**最早**解禁时刻（用户最该等的那一个）', () => {
      const got = allAccountsRateLimitedForModel(
        [
          account('a', { m: NOW + 9_000_000 }),
          account('b', { m: NOW + 1_000_000 }),
          account('c', { m: NOW + 5_000_000 }),
        ],
        'm',
        NOW,
      )
      expect(got).toEqual({ resetAtMs: NOW + 1_000_000, accountCount: 3 })
    })

    it('只要有一个账号不受该模型限制，整体就不成立（候选非空，轮不到本函数）', () => {
      expect(allAccountsRateLimitedForModel(
        [account('a', { m: NOW + 1000 }), account('b')],
        'm',
        NOW,
      )).toBeUndefined()
    })

    it('账号限制的是**别的**模型时不算命中（限流是「账号 × 模型」维度）', () => {
      expect(allAccountsRateLimitedForModel(
        [account('a', { 'other-model': NOW + 1000 })],
        'm',
        NOW,
      )).toBeUndefined()
    })

    it('解禁时刻已过（now >= resetAt）不算命中', () => {
      expect(allAccountsRateLimitedForModel(
        [account('a', { m: NOW })],
        'm',
        NOW,
      )).toBeUndefined()
      expect(allAccountsRateLimitedForModel(
        [account('a', { m: NOW - 1 })],
        'm',
        NOW,
      )).toBeUndefined()
    })

    it('resetAt 为 0 视为「不受限」（与选号侧判据一致）', () => {
      expect(allAccountsRateLimitedForModel(
        [account('a', { m: 0 })],
        'm',
        NOW,
      )).toBeUndefined()
    })

    it('空 modelId 直接不判定 —— 否则会把「未登录」误报成「限流」', () => {
      // 选号侧约定：空 modelId 不做限流过滤（`if (modelId.length === 0) return true`）。
      // 本函数必须同口径，否则「没有传模型」这种普通情形会被误报。
      expect(allAccountsRateLimitedForModel(
        [account('a', { m: NOW + 1000 })],
        '',
        NOW,
      )).toBeUndefined()
    })

    it('存在 modelRateLimits[""] 脏键时，空 modelId 仍不判定（守卫不能省）', () => {
      // ⚠️ 这条才真正锁住 `modelId.length === 0` 早退：`updateModelRateLimit`
      // **不校验** modelId，理论上可落下空串键。没有该守卫时，下面这组数据会
      // 被判成「全部限流」并上报给用户（反向验证：删掉守卫 → 本用例变红）。
      expect(allAccountsRateLimitedForModel(
        [account('a', { '': NOW + 1000 })],
        '',
        NOW,
      )).toBeUndefined()
    })

    it('没有启用账号时不判定（那是「未登录」，不是「限流」）', () => {
      // ℹ️ 本条与「循环不执行 → earliest 保持 undefined」同义，属**边界说明**
      // 而非可区分的回归保护（反向验证：删掉早退守卫它照样通过）。
      // 保留是为了锁死对外行为：空列表绝不能报成「全部限流」。
      expect(allAccountsRateLimitedForModel([], 'm', NOW)).toBeUndefined()
    })
  })

  describe('接线（源码级）', () => {
    it('两个 provider 都接了限流判定（传的是同一个共享助手）', () => {
      // ⚠️ 2026-10-08 改（Task 6）：原先断言的是源码里的**调用点文本**
      //    （逐 provider 点名把限流助手交给编排，原文见 git 历史 `d35d9e3`）。
      //    Task 6 把 12 个 `resolveCredential` 闭包收敛进
      //    `createCredentialResolver` 之后，判定变成工厂里的**一次**调用
      //    （实参是 `config.product`），那些点名文本消失了。
      //    ⇒ 改锁「两个 provider 的注册项都把同一个共享助手传给了工厂」。
      //    ⚠️ 注释里**不复写**那些调用点原文 —— 它们是「锚点已消失」核对会 grep
      //    的字符串（同 `raccoon-wiring.spec.ts` 的约定）。
      //    ⚠️ 锚点必须用「`product: <CONST>,` 紧跟 `readCredential:`」—— 只用
      //    `product: <CONST>,` 会命中更早的**选择器定义**（写用例时实测到）。
      //    「它真的在正确的位置生效（先问池、再判限流）」由下面的
      //    `ratelimit-misreport-behavior.spec.ts` 真跑 `apply()` 断言 ——
      //    那条比文本断言强，且不受重构影响。
      //
      // ⚠️⚠️ **切片必须是有界的 `factoryCallAt`**（2026-10-08 二次复审修复）：
      //    这里原先写的是「从 `product: X,` 那一行起 **slice 到文件末尾**」，
      //    实测块长 29918 / 28590 字符 —— 于是「块内含
      //    `throwIfAllRateLimited: throwIfAllAccountsRateLimited`」这条断言**恒真**：
      //    文件尾部还有 10 份同样的注册项文本，删掉 CODEBUDDY 自己那一行它照样通过。
      //    同型的 CLINE 那条（现由 `it.each(WIRING)` 覆盖）当时也一样是空洞的。
      //    ⇒ 统一改为「括号配平取**这一次** `createCredentialResolver(...)` 调用」。
      for (const product of ['CODEBUDDY', 'WORKBUDDY']) {
        const at = indexCode.search(new RegExp(`product: ${product},\\n\\s*readCredential:`))
        expect(at, `${product} 的工厂配置项没找到`).toBeGreaterThan(-1)
        const callStart = indexCode.lastIndexOf('createCredentialResolver', at)
        expect(callStart, `${product} 的 createCredentialResolver 调用没找到`).toBeGreaterThan(-1)
        const block = factoryCallAt(indexCode, callStart)
        expect(block, `${product} 必须把 throwIfAllAccountsRateLimited 交给工厂`).toContain(
          'throwIfAllRateLimited: throwIfAllAccountsRateLimited',
        )
      }
    })

    it('判定放在 getAvailableAccount 兜底**之后**（池里还有号时不该报限流）', () => {
      // ⚠️ 这条从「源码顺序」改为「工厂内的顺序」：判定必须在池调用**之后**。
      // 锚点用 `credential-resolver.ts`（判定所在的唯一实现）。
      const resolverSource = readFileSync(resolve(here, '../../src/credential-resolver.ts'), 'utf8')
        .replace(/\r\n/g, '\n')
      const resolverCode = codeOnly(resolverSource)
      const poolCall = resolverCode.indexOf('await deps.pool.getAvailableAccount(')
      expect(poolCall, '工厂里找不到池取号调用').toBeGreaterThan(-1)
      // ⚠️ **必须从池调用处往后找**：工厂里 `throwIfAllRateLimited` 有**两处**
      // 调用（loomy 分支在池调用之前、池兜底分支在之后）。全文搜会命中 loomy
      // 那处、把顺序判反（写用例时实测到：5386 < 5271 假红）。
      const check = resolverCode.indexOf('config.throwIfAllRateLimited?.(config.product, modelId)', poolCall)
      expect(check, '工厂里池兜底之后找不到限流判定').toBeGreaterThan(-1)
      // 先问池 → 池也没号 → 才判限流。
      expect(poolCall).toBeLessThan(check)
    })

    it('只统计**启用**账号 —— 停用账号不参与自动选号，算进来会误报', () => {
      const fnStart = indexCode.indexOf('const throwIfAllAccountsRateLimited')
      const fnBody = indexCode.slice(fnStart)
      const end = fnBody.indexOf('\n  }')
      expect(fnBody.slice(0, end)).toContain('.filter(a => a.enabled)')
    })

    it('抛的是 QUOTA_EXCEEDED，而不是让它继续降级成 MISSING_CREDENTIAL', () => {
      const fnStart = indexCode.indexOf('const throwIfAllAccountsRateLimited')
      const fnBody = indexCode.slice(fnStart)
      const end = fnBody.indexOf('\n  }')
      expect(fnBody.slice(0, end)).toContain("'QUOTA_EXCEEDED'")
      expect(fnBody.slice(0, end)).toContain('new LlmError(')
    })

    it('文案里带解禁时刻与「无需重新登录」，否则用户仍会去重登', () => {
      const fnStart = indexCode.indexOf('const throwIfAllAccountsRateLimited')
      const fnBody = indexCode.slice(fnStart)
      const end = fnBody.indexOf('\n  }')
      const block = fnBody.slice(0, end)
      expect(block).toContain('toLocaleString')
      expect(block).toContain('无需重新登录')
    })

    it('判据复用 account-pool 的纯函数，不在 index.ts 里重写一遍', () => {
      expect(indexCode).toContain('allAccountsRateLimitedForModel')
      expect(poolCode).toMatch(/export function allAccountsRateLimitedForModel\(/)
    })
  })

  describe('不削弱既有语义（回归保护）', () => {
    it('判据与选号侧同口径：缺标记 / 0 / 已过期都算不受限', () => {
      const fnStart = poolCode.indexOf('export function allAccountsRateLimitedForModel')
      expect(fnStart).toBeGreaterThan(-1)
      const body = poolCode.slice(fnStart, fnStart + 2000)
      expect(body).toContain('resetAt === undefined')
      expect(body).toContain('resetAt === 0')
      expect(body).toContain('now >= resetAt')
    })

    it('限流标记仍然照常写入 —— 本补丁只读标记，不删不改', () => {
      // 红线：绝不能让「报错更清楚」演变成「绕开限流」。写标记的路径必须原样保留。
      expect(poolCode).toContain('async updateModelRateLimit(')
      const adapterSource = readFileSync(resolve(here, '../../src/buddy-adapter.ts'), 'utf8')
      expect(adapterSource).toContain('updateModelRateLimit')
    })

    it('未命中判定时静默返回，原有的 MISSING_CREDENTIAL 路径保持可用', () => {
      const fnStart = indexCode.indexOf('const throwIfAllAccountsRateLimited')
      const fnBody = indexCode.slice(fnStart)
      const end = fnBody.indexOf('\n  }')
      expect(fnBody.slice(0, end)).toContain('if (limited === undefined) return')
      // 单凭据兜底仍在（老数据兼容路径），只是排到判定之后。
      // ⚠️ 2026-10-08 改（Task 6）：兜底已下沉到工厂，故锚点跟着搬到
      // `credential-resolver.ts`；断言的是**语义**（工厂真的会退单凭据），
      // 而不是某个文件的文本。
      const resolverSource = readFileSync(resolve(here, '../../src/credential-resolver.ts'), 'utf8')
        .replace(/\r\n/g, '\n')
      expect(codeOnly(resolverSource)).toContain('await config.readCredential(config.fallback.refName)')
    })
  })

  /**
   * **cline 也接上了这条**（2026-10-03 用户报障，同型缺陷）。
   *
   * 症状与 buddy 那次**一模一样但报错文案不同**：用户等完限流倒计时再连，得到的是
   * `cline: no usable credential; log in first` —— 凭据明明在、账号也登录着，
   * 只是被 `cline-free/deepseek-v4.1-flash` 的模型级限流标记挡住。
   *
   * ⚠️ cline 的取号调用**不带 `tried`**（它只有一个显式回退路径），故它的接线
   * 断言与 buddy 那组**分开写**，不照抄（照抄会永远红）。
   *
   * ⚠️ 2026-10-08 改（Task 6）：判定已下沉到 `createCredentialResolver` 的
   * **唯一一处**实现里，故原先三条「源码文本 + 顺序」断言改为：
   * ① 注册项把共享助手交给了工厂；② 工厂里判定恰好两处（loomy 分支 + 池兜底分支）；
   * ③ 助手签名仍只要求 `{ id, displayName }`（cline 与 buddy 是两个类型）。
   * 「先问池、再判限流」的顺序由 buddy 那组 + `ratelimit-misreport-behavior.spec.ts`
   * 真跑 `apply()` 覆盖。
   */
  describe('接线（源码级）：cline 同型缺陷', () => {
    it('cline 也接了限流判定（与 buddy 系同一个共享助手）', () => {
      // ⚠️ 锚点同 buddy 那组：`product: CLINE,` 紧跟 `readCredential:`。
      // ⚠️⚠️ 切片**必须**用有界的 `factoryCallAt`（2026-10-08 二次复审修复）：
      //    这里原先与 buddy 那组一样「slice 到文件末尾」（实测 21046 字符），
      //    文件尾部还有 4 份同样的注册项文本 ⇒ 删掉 CLINE 自己那一行它照样通过。
      //    该形态与本文件 `it.each(WIRING)` 覆盖 CLINE 的那条**重复**，但保留它
      //    仍有价值：它是**逐条点名**的最短路径，且现在真的有判别力。
      const at = indexCode.search(/product: CLINE,\n\s*readCredential:/)
      expect(at, 'CLINE 的工厂配置项没找到').toBeGreaterThan(-1)
      const callStart = indexCode.lastIndexOf('createCredentialResolver', at)
      expect(callStart, 'CLINE 的 createCredentialResolver 调用没找到').toBeGreaterThan(-1)
      const block = factoryCallAt(indexCode, callStart)
      expect(block, 'CLINE 必须把 throwIfAllAccountsRateLimited 交给工厂').toContain(
        'throwIfAllRateLimited: throwIfAllAccountsRateLimited',
      )
    })

    it('限流判定的调用点集中在工厂里（不是每个 provider 各写一遍）', () => {
      const resolverSource = readFileSync(resolve(here, '../../src/credential-resolver.ts'), 'utf8')
        .replace(/\r\n/g, '\n')
      const resolverCode = codeOnly(resolverSource)

      /**
       * ⚠️ 判据已从「恰好 2 处」改为「**只出现在本文件**」（2026-10-13）。
       *
       * 原判据是数量断言（`toBe(2)`：loomy 分支 + 池兜底分支）。它在
       * 2026-10-13 的锁定分支修复里**先红了** —— 而那次修复恰恰是**同一处实现
       * 里新增一个分支**，不是「又开了第二个实现」。数量断言分不清这两者，
       * 于是它守的东西（防止第二处实现）与它实际测的东西（分支总数）脱钩，
       * 改一次无关分支就得改它一次，最后没人敢动。
       *
       * ⇒ 换成**直接测原意**：`src/` 下除本文件外，任何地方都不得出现
       * `throwIfAllRateLimited?.(` 调用。这既挡住了「第二个实现」，也允许
       * 本文件按需增删分支。
       *
       * ⚠️ 用 `readdirSync` 递归扫**全部** `.ts`（含 `client/` 子目录），
       * 而不是只点名几个文件 —— 后者会漏掉将来新加的模块。
       */
      const srcRoot = resolve(here, '../../src')
      const offenders: string[] = []
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name)
          if (entry.isDirectory()) { walk(full); continue }
          if (!entry.name.endsWith('.ts')) continue
          if (resolve(full) === resolve(here, '../../src/credential-resolver.ts')) continue
          const source = codeOnly(readFileSync(full, 'utf8').replace(/\r\n/g, '\n'))
          if (source.includes('throwIfAllRateLimited?.(')) offenders.push(entry.name)
        }
      }
      walk(srcRoot)
      expect(offenders, '限流判定只该在 credential-resolver.ts 里调用，别处又开了一份实现').toEqual([])

      // 本文件内的三处调用**按分支点名**（顺序即代码顺序），而不是数个数：
      // 锁定分支（2026-10-13 新增）→ loomy 分支 → 池兜底分支。
      const occurrences = [...resolverCode.matchAll(/throwIfAllRateLimited\?\.\(/g)]
      expect(occurrences.length, '至少要有 loomy 分支 + 池兜底分支两处').toBeGreaterThanOrEqual(2)
      // ⚠️ 锁定分支那一处必须**在** `if (picked.kind === 'locked')` 与紧随的
      // `throw plan.lockedError` **之间** —— 放到 throw 之后就成了死代码
      //（永远执行不到），而数量断言对这种事完全无感。
      const lockedAt = resolverCode.indexOf("if (picked.kind === 'locked')")
      expect(lockedAt, '锁定分支没找到').toBeGreaterThan(-1)
      const lockedThrowAt = resolverCode.indexOf('throw plan.lockedError', lockedAt)
      const lockedCallAt = resolverCode.indexOf('throwIfAllRateLimited?.(', lockedAt)
      expect(lockedCallAt, '锁定分支里应有一处限流判定').toBeGreaterThan(-1)
      expect(lockedCallAt, '锁定分支的限流判定必须排在 throw plan.lockedError **之前**')
        .toBeLessThan(lockedThrowAt)
      // 且必须带 `candidates.length === 0` 守卫：候选非空时余额分档已经跑过，
      // 此时再判限流会把「凭据全坏」误报成「限流」（有用例锁死）。
      expect(resolverCode.slice(lockedAt, lockedThrowAt)).toContain('candidates.length === 0')
    })

    it('助手的 product 参数只要求 id / displayName（cline 与 buddy 是两个类型）', () => {
      // 写死 `product: BuddyProduct` 会让 cline 无法复用；断言签名已放宽。
      // ⚠️ 不能按「第一个 `{`」切签名——类型字面量自己就带 `{`，会切在 `product: ` 上
      // （写用例时实测到）。取固定长度的窗口。
      const fnStart = indexCode.indexOf('const throwIfAllAccountsRateLimited')
      const signature = indexCode.slice(fnStart, fnStart + 400)
      expect(signature).toContain('{ id: string; displayName: string }')
      expect(signature).not.toContain('BuddyProduct')
    })
  })

  /**
   * **其余 9 个 provider 同型缺陷**（Gitee issue IKJOZ9，2026-10-05）。
   *
   * ## 症状
   *
   * 用户的 qoder 单账号撞上**当日额度用尽**，第一次请求报
   * `Billing daily count exceeded`（正确），标记落下后**第二次请求**却报：
   *
   * ```
   * qoder: no usable credential; log in first     ← 把用户指向「重新登录」
   * ```
   *
   * 而凭据是好的、账号是登录着的 —— 真实原因是那个模型被**模型级限流**挡住。
   * 用户据此重新登录，问题照旧（根因是限流），白跑一趟。
   *
   * ## 为什么这次是「九个一起漏」
   *
   * 判定助手 `throwIfAllAccountsRateLimited` 自 2026-10-03 起只接了
   * buddy / workbuddy / cline 三家，新增的 provider **谁都没接**。这不是九个
   * 独立缺陷，而是**同一条接线约定没有被强制**——所以下面的断言是
   * **按 provider 逐个点名**，而不是「断言至少存在若干处调用」：
   * 后者对新增 provider 恒成立，挡不住下一个同类回归。
   *
   * ⚠️ **codearts 刻意不在名单里**：它取号时传的是**空 modelId**
   * （`getAvailableAccount('codearts', '')`），模型级限流**压根不参与筛选**，
   * 因此既不会误报「限流」、也不会误报「未登录」。给它接判定属于改变
   * 既有行为，超出本 issue 范围；此处的名单必须与事实一致，不能图省事全列上。
   */
  describe('接线：其余 provider 同型缺陷（IKJOZ9）', () => {
    /**
     * 每个 provider 的**注册项**锚点（`product: <CONST>,`）。
     *
     * ⚠️ 2026-10-08 改（Task 6）：原先这张表是「池取号调用 → 判定 → 单凭据兜底」
     * 三个**源码文本**锚点，逐条比对先后顺序。Task 6 把那三段收敛进
     * `createCredentialResolver` 之后：
     *
     * - `getAvailableAccount(X.id, modelId ?? '', picked.tried)` 的文本形消失
     *   （工厂里只剩一次 `deps.pool.getAvailableAccount(providerId, …)`）；
     * - `throwIfAllAccountsRateLimited(X, modelId)` 的**逐个点名**也消失了
     *   （工厂里只有一处 `config.throwIfAllRateLimited?.(config.product, modelId)`）。
     *
     * ⇒ 改为断言**注册项有没有把共享助手交给工厂**。这仍然是**逐个 provider 点名**
     *（不是「至少存在若干处」），故对新增 provider 不恒真 —— 保持了原判据的
     * 探测力。而「它真的在正确的位置生效（先问池、再判限流、最后回退）」由
     * `ratelimit-misreport-behavior.spec.ts` 真跑 `apply()` 逐 provider 断言，
     * 那条比文本断言强，且不受重构影响。
     */
    const WIRING: readonly string[] = [
      'CODEBUDDY', 'WORKBUDDY', 'LOBSTERAI', 'QODER', 'QODER_CN',
      'TRAE', 'CLINE', 'LOOMY', 'RACCOON', 'MINIMAX', 'GEMINI',
      // ⚠️ **ACCIO 必须在内**：它的兜底是**固定 ref**（`ACCIO_ACCESS_TOKEN`），
      // 而 Jet Hub 登录只写 `ACCIO_ACCOUNT_XXX` ⇒ 与上面 11 家是**同一形态**的
      // 受害者（池被筛空时报误导性的「请先登录」）。见下方
      // 「accio 走固定 ref 兜底，故必须接判定」。
      'ACCIO',
      // ⚠️ **MINIMAX_INTL 必须在内**（2026-10-15）：它是 MiniMax Code 国际版，
      // 与 `MINIMAX` **同一形态**（固定 ref 兜底 `MINIMAXINTL_ACCESS_TOKEN`、
      // 池被筛空时会误报「请先登录」）。本名单是**被测对象**，漏登记会让
      // 下面那条自动派生用例点名变红。
      'MINIMAX_INTL',
      // ⚠️ **AUTOCLAW 必须在内**（2026-10-17）：它与 accio 同形 —— 兜底是
      // 固定 ref（`AUTOCLAW_ACCESS_TOKEN`），而 Jet Hub 登录只写
      // `AUTOCLAW_ACCOUNT_XXX` ⇒ 池被筛空时会误报「请先登录」。
      'AUTOCLAW',
      // ⚠️ **AUTOCLAW_INTL 必须在内**（2026-10-20）：它是 AutoClaw 国际版，
      // 与 `AUTOCLAW` **同一形态**（同一份适配器工厂、固定 ref 兜底
      // `AUTOCLAWINTL_ACCESS_TOKEN`、池被筛空时会误报「请先登录」）。
      // ⚠️ 常量名带下划线，与 `src/index.ts` 里的 `product: AUTOCLAW_INTL,`
      //    **逐字相同**（本用例按该字段匹配工厂配置块，写成 `AUTOCLAWINTL`
      //    会「找不到块」而不是「少一家」—— 两种红的原因不同，别混淆）。
      'AUTOCLAW_INTL',
      // ⚠️ **ASTUDIO 必须在内**（2026-10-20）：同形 —— 兜底是固定 ref
      // （`ASTUDIO.defaultCredentialRef`），Jet Hub 导入本机会话只写
      // `ASTUDIO_ACCOUNT_XXX` ⇒ 池被筛空时会误报「请先登录」。
      'ASTUDIO',
      // ⚠️ **MAGICREW 必须在内**（2026-10-29）：与 accio 同形 —— 兜底是固定 ref
      //    （`MAGICREW_ACCESS_TOKEN`），而 Jet Hub 登录只写 `MAGICREW_ACCOUNT_*`
      //    ⇒ 池被筛空时会误报误导性的「请先登录」。且它的 `mgw_` key 只活 2 小时，
      //    该误报会让用户去重登一个本来没问题的号。
      'MAGICREW',
      // ⚠️ **MAGICREW_INTL 必须在内**（2026-11-01）：MagiCrew 国际版，与 `MAGICREW`
      //    **同一形态**（同一份适配器工厂、固定 ref 兜底
      //    `MAGICREWINTL_ACCESS_TOKEN`、池被筛空时会误报「请先登录」）。
      // ⚠️ 常量名带下划线，与 `src/index.ts` 里的 `product: MAGICREW_INTL,`
      //    **逐字相同**（本用例按该字段匹配工厂配置块，写成 `MAGICREWINTL`
      //    会「找不到块」而不是「少一家」—— 两种红的原因不同，别混淆）。
      'MAGICREW_INTL',
      // ⚠️ **刻意不含 ZCODE** —— 它是唯一「不接判定也算对」的一家，
      // 见下方「zcode 同型缺陷判定」段。
    ]

    /**
     * 每个 provider 的**工厂配置块**（`product: <CONST>, …`）。
     *
     * ⚠️ 锚点不能只用 `product: <CONST>,`：那个形在**选择器定义**里也出现
     *（`new BuddyBalanceSelector({ product: CODEBUDDY, … })`）且在文件里更早，
     * `indexOf` 会命中它 ⇒ 窗口里当然没有工厂字段（写本用例时实测到：
     * 11 个 provider 全部失配）。
     *
     * 正确做法：以**工厂调用** `createCredentialResolver(` 为唯一起点，取它之后
     * 最近的那个 `product: <CONST>,`，并以**下一个工厂调用**为终点 ——
     * 无论中间夹多少注释、字段顺序如何调整都能正确配对。
     */
    function factoryBlocks(): Map<string, string> {
      const blocks = new Map<string, string>()
      const calls = [...indexCode.matchAll(/createCredentialResolver(?:<[^>]*>)?\(/g)].map(m => m.index)
      calls.forEach((at, i) => {
        const end = calls[i + 1] ?? indexCode.length
        const block = indexCode.slice(at, end)
        // ⚠️ 归属判据是「块内**第一个** `product: <CONST>,`」：工厂配置项里
        // `product` 永远是首字段。不能用「块内是否出现 `product: X,`」——
        // 下一个 provider 的**选择器定义**恰好夹在两段之间，会被算进上一块
        //（写用例时实测到：CLINE 的块里含 `product: LOOMY,`）。
        const productMatch = /product: (\w+),/.exec(block)
        expect(productMatch, `第 ${i + 1} 个工厂调用里找不到 product 字段`).not.toBeNull()
        blocks.set(productMatch![1]!, block)
      })
      return blocks
    }

    it.each(WIRING)('$product：注册项把共享限流判定交给了工厂', (product) => {
      const block = factoryBlocks().get(product)
      expect(block, `${product} 的工厂配置块没找到（改名了要同步改本用例）`).toBeDefined()
      expect(
        block,
        `${product} 未接限流判定（池被筛空时会误报「请先登录」）`,
      ).toContain('throwIfAllRateLimited: throwIfAllAccountsRateLimited')
    })

    /**
     * ★★ **工厂的兜底 `refName` 必须来自块内那个 `product` 常量**（2026-11-01 二审）。
     *
     * 实测：把 `src/index.ts` 里 `magicrewIntlResolver` 的
     * `fallback: { kind: 'ref', refName: MAGICREW_INTL.defaultCredentialRef }`
     * 改成 `MAGICREW.defaultCredentialRef`，**491 条相关用例全绿** ——
     * 而生产后果是：账号池被限流/关闭筛空时，国际站适配器回落到
     * **国内站的固定 ref**（`MAGICREW_ACCESS_TOKEN`）⇒ 拿国内 JWT 打国际 host，
     * 或误报「请先登录」。
     *
     * ⚠️ 判据从**源码形态派生**：工厂块的 `product: <CONST>` 与
     * `refName: <CONST>.defaultCredentialRef` 必须是**同一个常量**。
     * `fallback` 为 `kind: 'custom'` 的渠道（zcode）不适用本判据。
     */
    it.each(WIRING)('$product：兜底 refName 不得指向**另一个** provider 的常量', (product) => {
      const all = factoryBlocks()
      const block = all.get(product)
      expect(block, `${product} 的工厂配置块没找到`).toBeDefined()
      if (block === undefined) return
      // `custom` 兜底（zcode）没有 refName，跳过。
      if (block.includes("kind: 'custom'")) return
      const refMatch = /refName: (\w+(?:\.\w+)*)/.exec(block)
      expect(refMatch, `${product} 的工厂块里找不到 refName（形态变了要同步改本用例）`).not.toBeNull()
      const refExpr = refMatch![1]!
      /**
       * ⚠️ **只判「指向另一个 product 常量」**（2026-11-01 二审）。
       *
       * 不能要求 `refName === '<product 常量>.defaultCredentialRef'`：本仓有一批渠道
       * 用的是**独立的 ref 常量**（`BUDDY_CREDENTIAL_REF` / `CODECARTS_…`），
       * 那些与 product 常量无派生关系，硬套会让 12 家全红。
       *
       * 真正的缺陷形态是「A 站的块里写了 B 站的 defaultCredentialRef」——
       * 因为只有 product 常量带 `.defaultCredentialRef`，所以判据是：
       * **refName 的宿主若是（别的）product 常量 ⇒ 红**。
       */
      const owner = refExpr.endsWith('.defaultCredentialRef')
        ? refExpr.slice(0, -'.defaultCredentialRef'.length)
        : undefined
      if (owner === undefined) return
      const productConsts = new Set(all.keys())
      if (!productConsts.has(owner)) return
      expect(
        owner,
        `${product} 的 fallback.refName 指向 ${owner}.defaultCredentialRef，`
        + '那是**另一个站**的固定凭据 ⇒ 池被筛空时会拿它兜底（或误报「请先登录」）',
      ).toBe(product)
    })

    it('名单覆盖全部走工厂取号的 provider（新增 provider 记得加进来）', () => {
      // ⚠️ **判据与 Task 6 之后的源码形态对齐**：每个 provider 的注册项都以
      // `product: <CONST>,` 开头、且必然带 `readCredential:`（工厂的必填项）。
      // 故「有 `product: X,` 且其后紧跟 `readCredential:`」= 「该 provider 走了工厂」。
      //
      // ⚠️ 反向自检（下面第二条断言）不可省：正则失效时 `seen` 会是空集，
      // `missing` 也随之恒为空 —— 那正是「守卫不守」的形态。
      const guarded = new Set(WIRING)
      const EXEMPT = new Set([
        // zcode 是**唯一「不接判定也算对」**的一家：它的兜底
        // `fallback: { kind: 'custom', resolve: … zcode.current() }` 会**再读一次
        // 账号池**且不看 `enabled`/限流 ⇒ 池被筛空时仍返回凭据，根本不会误报
        // 「未登录」（IKJOZ9 的症状在它身上不存在）。
        // 加判定反而会收窄可用性 —— 见下一段「zcode 同型缺陷判定」。
        'ZCODE',
      ])
      const seen = [...indexCode.matchAll(/product: (\w+),\n\s*readCredential:/g)].map(m => m[1]!)
      const missing = [...new Set(seen)].filter(p => !guarded.has(p) && !EXEMPT.has(p))
      expect(missing, '这些 provider 走了工厂，却没接限流判定').toEqual([])
      // 反向自检：判据必须真的扫到了名单里的成员（正则失效即红）。
      expect(
        seen.filter(p => guarded.has(p)).length,
        '判据没扫到任何已知 provider，说明正则已失效',
      ).toBeGreaterThan(0)
      // 且必须扫到的**恰好**是「走了工厂」的那些（不多不少）。
      expect(new Set(seen).size, '扫到的 provider 数与名单不符（名单或正则需同步）')
        .toBe(WIRING.length + EXEMPT.size)
    })
    /**
     * **锁死「opencode 不需要接线」这个结论**（2026-10-06 审计建议）。
     *
     * 之前它只是「不在名单里」—— 一个**否定性事实**，没有任何断言守着。将来若有人
     * 给 `PoolEntrySnapshot` 加上 `modelRateLimits` 并让 `listIdentitySlots` 据此
     * 过滤槽位，opencode 就会**静默**变成第 13 个受害者：候选筛空 → 报「未登录」，
     * 而没有任何一条用例会红。
     */
    it('opencode 仍是槽制：没有 resolveCredential，且槽位快照不携带 modelRateLimits', () => {
      const opencodeAuthSource = readFileSync(resolve(here, '../../src/opencode-auth.ts'), 'utf8')
        .replace(/\r\n/g, '\n')
      // ① 注册项里没有 resolveCredential（opencode 走 identitySlots 槽制）
      const registration = indexCode.slice(indexCode.indexOf('const opencodeAdapter = registerOpencodeLlm('))
      const registrationEnd = registration.indexOf('\n  })')
      const block = registration.slice(0, registrationEnd)
      expect(block, 'opencode 注册项出现了 resolveCredential —— 它不再是槽制，需重新评估').not.toContain('resolveCredential')
      // ② 槽位快照的类型定义里不携带模型级限流。
      // ⚠️ 锚点必须用 `export interface PoolEntrySnapshot`（定义处），不能
      // 只搜类型名 —— 名字在 import / 注释里更早出现，按名字切会落到无关代码上
      // （写用例时实测到：切出来是 `nextFingerprintGeneration`）。
      const snapshotStart = opencodeAuthSource.indexOf('export interface PoolEntrySnapshot')
      expect(snapshotStart, 'PoolEntrySnapshot 的定义没找到，检查类型是否被移动或改名').toBeGreaterThan(-1)
      const snapshotType = opencodeAuthSource.slice(snapshotStart, opencodeAuthSource.indexOf('\n}', snapshotStart))
      expect(snapshotType, 'PoolEntrySnapshot 携带了 modelRateLimits —— opencode 已进入本 issue 的形态').not.toContain('modelRateLimits')
      // ③ 槽位列举只按 enabled 过滤，不看模型级限流
      const listSlots = opencodeAuthSource.slice(opencodeAuthSource.indexOf('function listIdentitySlots'))
      expect(listSlots, 'listIdentitySlots 开始处没找到').not.toContain('modelRateLimits')
    })

    /**
     * **zcode 是唯一「不接判定也算对」的一家**（2026-10-06 对抗性审计推翻了我最初的接线）。
     *
     * 我最初把 zcode 也接上了，理由是「池取不到号就该判限流」。审计指出这会收窄
     * 可用性，我用临时探针（真实 `apply()` + 真账号池）实测确认**审计是对的**：
     * `zcode.current()` 的兜底会**再读一次账号池**（`readStoredCredential` →
     * `readCredentialFromPool`），且既不看 `enabled`、也不看 `modelRateLimits`：
     *
     * | 场景（账号池状态） | `zcode.current()` 返回 |
     * |---|---|
     * | 唯一启用账号被该模型限流、凭据合法 | **那份凭据** ⇒ 不会误报「未登录」 |
     * | 池里另有「停用但健康」账号且排在前面 | **那个停用账号的凭据** ⇒ 请求能跑通 |
     *
     * ⇒ ① IKJOZ9 的症状在 zcode 身上**不存在**（它不报「未登录」）；② 加判定会把
     * 上表第二行那发**能跑通的请求变成硬失败**。故 zcode 刻意不接 —— 这条断言
     * 防止后来者「看到别人都接了，顺手也给 zcode 补上」。
     */
    it('zcode 刻意不接限流判定：它的兜底会再读池，本就不会误报「未登录」', () => {
      // ⚠️ 2026-10-08 改（Task 6）：原先搜「逐个点名 ZCODE 的那个调用点文本」
      // （恒应为 -1；原文见 git 历史 `d35d9e3`）。工厂化之后它本就不存在了
      // ⇒ 那条**恒真**，属于「守卫不守」。改为断言 zcode 的**注册项本身**
      // 没有 `throwIfAllRateLimited`：这才是有判别力的判据（有人给它补上就会红）。
      // ⚠️ 此处**不复写**那条旧锚点原文（核对「锚点已消失」时会 grep 它）。
      const at = indexCode.search(/product: ZCODE,\n\s*readCredential:/)
      expect(at, 'zcode 的工厂配置项没找到（改名了要同步改本用例）').toBeGreaterThan(-1)
      // ⚠️ 结构性切片（括号配平取这次调用本身）—— 见 `factoryCallAt` 的说明：
      //    原先的定长窗口实测越界 1333 字符，圈进了 refresh / mintCaptcha。
      const callStart = indexCode.lastIndexOf('createCredentialResolver', at)
      expect(callStart, 'zcode 的 createCredentialResolver 调用没找到').toBeGreaterThan(-1)
      const block = factoryCallAt(indexCode, callStart)
      expect(
        block,
        'zcode 又被接上判定了 —— 它的兜底 current() 会再读池，加判定会收窄可用性（见本用例注释）',
      ).not.toContain('throwIfAllRateLimited')
      // 且必须确认 zcode 的兜底形态仍在（否则这条会因为「整段被删」而假绿）。
      expect(block, 'zcode 的兜底应仍是 zcode.current()').toContain('await zcode.current()')
      expect(block, 'zcode 的兜底应是 custom 形态（不是读某个固定 ref）').toContain("kind: 'custom'")
    })

    /**
     * **accio 与 zcode 恰好相反**：它走**固定 ref** 兜底，故**必须**接判定。
     *
     * ⚠️ 这条与上一条是**一对**：两条一起把「兜底形态 → 是否该接判定」这个
     * 判据钉死。只看名单（`WIRING`）会漏掉「有人把 accio 的兜底改成 custom」
     * 或「有人照着 zcode 的样子把 accio 的判定删掉」两种形态。
     *
     * ⚠️ 今天这层判定是**恒不命中的**（accio 适配器不写 `modelRateLimits`，
     * 见 `provider-runtime-wiring.spec.ts` 的 `WRITE_SITE_FILES` 里 accio 那条
     * 空登记 + 「登记为不写标记的 adapter 确实没有写点」用例）。**这不是冗余**：
     * 判据是「兜底形态会不会让池被筛空时报错」而不是「今天有没有标记」——
     * 将来接上请求级换号（如 minimax 在 IKJW32 那样）时守卫已在位。
     */
    it('★ accio 走固定 ref 兜底，故必须接判定（与 zcode 的 custom 兜底相反）', () => {
      const at = indexCode.search(/product: ACCIO,\n\s*readCredential:/)
      expect(at, 'accio 的工厂配置项没找到（改名了要同步改本用例）').toBeGreaterThan(-1)
      const callStart = indexCode.lastIndexOf('createCredentialResolver', at)
      expect(callStart, 'accio 的 createCredentialResolver 调用没找到').toBeGreaterThan(-1)
      const block = factoryCallAt(indexCode, callStart)
      // ① 兜底形态确实是固定 ref（若改成 custom，判据就该跟着改）。
      expect(block, 'accio 的兜底不再是固定 ref —— 本用例的判据前提已失效').toContain("kind: 'ref'")
      // ② 故判定必须接着（删掉它会让池被筛空时报「请先登录」）。
      expect(
        block,
        'accio 的固定 ref 兜底没接限流判定 —— 池被筛空时会误报「请先登录」（IKJOZ9 形态）',
      ).toContain('throwIfAllRateLimited: throwIfAllAccountsRateLimited')
    })
  })
})
