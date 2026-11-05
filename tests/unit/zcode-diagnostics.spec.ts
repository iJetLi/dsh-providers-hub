/**
 * ZCode `3012` 可观测诊断的回归用例（Gitee issue IKJI0Y）。
 *
 * ## 这组用例在钉什么
 *
 * issue 的诉求是「把账号池序号、计数、身份块字符数等写进错误文案」。
 * 它同时带来一条**必须成立**的红线：**文案里不得出现任何凭据** ——
 * 否则就是把排障信息写进了用户截图会连带泄露的东西。
 *
 * ⇒ 下面有一条专门的「反例用例」：把 accountId 换成看起来最像凭据的串，
 * 断言它的**每一个子串**都不出现在渲染结果里。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  accountOrdinal,
  describeZcodeRequestShape,
  extractZcodeLogId,
  formatZcodeDiagnostic,
  noteZcodeRequestFailed,
  noteZcodeRequestOk,
  noteZcodeRequestSent,
  resetZcodeDiagnostics,
} from '../../src/zcode-diagnostics.js'
import { buildZcodeSystemBlocks, withCallerSystem, withContextPrefix } from '../../src/zcode-identity.js'
import { describeUpstreamError, httpErrorCodeForZcode } from '../../src/zcode-adapter.js'

/** 源码接线断言用（与 `zcode-captcha-upfront.spec.ts` 同一套定位法）。 */
const HERE = dirname(fileURLToPath(import.meta.url))

/** 剥注释后再断言：只改注释不该让接线「看起来」还在。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** 走真实构造路径拿一份请求体形态（与 `stream()` 里用的是同一批函数）。 */
function realShape(): ReturnType<typeof describeZcodeRequestShape> {
  const system = buildZcodeSystemBlocks({
    cwd: process.cwd(),
    provider: 'zcode',
    model: 'GLM-5.3-Flash',
  })
  // ⚠ 调用方 system 注入 messages（不进 system 数组）—— 2026-10-25 实测修复。
  const messages = withCallerSystem(
    withContextPrefix([{ role: 'user', content: '你好' }]),
    'You are DSH, a coding agent.',
  )
  return describeZcodeRequestShape(system, messages)
}

describe('ZCode 3012 可观测诊断（issue IKJI0Y）', () => {
  beforeEach(() => {
    resetZcodeDiagnostics()
  })

  describe('请求形态实测', () => {
    it('★ 身份块字符数读的是**实际构造出来的 system**，不是常量', () => {
      const shape = realShape()
      // 2643 = cliPrefix(35) + stable(2608)，官方 3.17.x 版实测（2026-11-05）。
      // ⚠ 官方再改身份块结构时这里要跟着动（见 src/zcode-identity.ts 的提取记录）。
      expect(shape.identityChars).toBe(2643)
      expect(shape.identityBlockChars).toEqual([35, 2608])
      expect(shape.cliPrefixChars).toBe(35)
      expect(shape.systemBlocks).toBeGreaterThanOrEqual(3)
    })

    it('★ 真实请求体形态的诊断行包含 issue 要的每一项', () => {
      const shape = realShape()
      const line = formatZcodeDiagnostic({
        accountId: 'zcode-1a2b3c4d',
        sentAt: 1_000_000,
        status: 405,
        shape,
        now: 1_000_000,
      })
      expect(line).toContain('账号#')
      expect(line).toContain('本进程 成功')
      expect(line).toContain('最近成功')
      expect(line).toContain('距上条')
      expect(line).toContain('身份块 2643 字符(35+2608)')
      expect(line).toContain('日期块 有')
      expect(line).toContain('HTTP 405')
    })

    /**
     * ★★ 版本号必须出现在诊断行（Issue #45）。
     *
     * 3012 的判据是「**版本号与身份块同代**」，而改前诊断行只有身份块字符数 ⇒
     * 报障者（与维护者）都看不出「版本 3.17.2 + 3.16 身份块」这种跨代组合，
     * 于是只能去怀疑账号/频率（方向全错）。
     *
     * ⚠ 判据刻意写成**字面量 3.17.1**：它必须与 `zcode-upstream.ts` 的推理版本
     * 门槛同代，改一处漏一处就是「全量用户 3012」。
     */
    it('★★ 诊断行渲染实际发出的客户端版本（与身份块相邻，便于一眼看同代）', () => {
      const shape = realShape()
      const line = formatZcodeDiagnostic({
        accountId: 'zcode-1a2b3c4d',
        sentAt: 1_000_000,
        status: 405,
        shape,
        appVersion: '3.17.1',
        now: 1_000_000,
      })
      expect(line).toContain('版本 3.17.1')
      // 相邻：身份块 → 版本 → 日期块（顺序即「一眼看同代」）
      expect(line).toMatch(/身份块 2643 字符\(35\+2608\) · 版本 3\.17\.1 · 日期块/)
    })

    it('★ 未提供版本时整项省略（不编造、也不留空壳）', () => {
      const line = formatZcodeDiagnostic({
        accountId: 'zcode-1a2b3c4d',
        sentAt: 1_000_000,
        status: 405,
        shape: realShape(),
        now: 1_000_000,
      })
      expect(line).not.toContain('版本 ')
    })

    /**
     * ★ 反向验证：常量说 2643，但如果真出现「身份块没进请求体」，
     * 诊断必须**如实显示 0** —— 读实际值才做得到这一点。
     */
    it('★ 身份块缺失时如实报 0 字符（读实际值，不是读常量）', () => {
      const shape = describeZcodeRequestShape('You are DSH.', [{ role: 'user', content: 'hi' }])
      expect(shape.systemBlocks).toBe(0)
      expect(shape.identityChars).toBe(0)
      const line = formatZcodeDiagnostic({
        accountId: 'a', sentAt: 1, status: 405, shape, now: 1,
      })
      expect(line).toContain('身份块 0 字符(无)')
      expect(line).not.toContain('2643')
    })

    it('日期块有无被如实识别（去掉日期块即报「无」）', () => {
      const without = describeZcodeRequestShape(
        buildZcodeSystemBlocks({ cwd: '.' }),
        [{ role: 'user', content: '裸文本' }],
      )
      expect(without.hasDateBlock).toBe(false)
      const line = formatZcodeDiagnostic({
        accountId: 'a', sentAt: 1, status: 405, shape: without, now: 1,
      })
      expect(line).toContain('日期块 无')
    })
  })

  describe('账号画像', () => {
    it('★ 同一账号多次拿到**同一序号**（否则跨请求无法对比）', () => {
      const first = accountOrdinal('acct-A')
      expect(accountOrdinal('acct-A')).toBe(first)
      expect(accountOrdinal('acct-B')).not.toBe(first)
    })

    it('★ 成功/失败计数与「最近成功」如实累计', () => {
      noteZcodeRequestSent('acct-A', 1_000)
      noteZcodeRequestOk('acct-A', 1_100)
      noteZcodeRequestSent('acct-A', 2_000)
      noteZcodeRequestOk('acct-A', 2_100)
      noteZcodeRequestSent('acct-A', 3_000)
      noteZcodeRequestFailed('acct-A')
      const line = formatZcodeDiagnostic({
        accountId: 'acct-A',
        sentAt: 3_000,
        status: 405,
        shape: realShape(),
        now: 5_100,
      })
      expect(line).toContain('本进程 成功 2/失败 1')
      expect(line).toContain('最近成功 3.0s前')
    })

    it('从未成功过的账号写「从未成功过」而不是 0（不谎报）', () => {
      const line = formatZcodeDiagnostic({
        accountId: 'acct-C', sentAt: 1, status: 405, shape: realShape(), now: 999_999,
      })
      expect(line).toContain('最近成功 从未成功过')
    })

    /**
     * ★「距上条」必须按**适配器的真实调用顺序**测：先 `noteZcodeRequestSent`
     * 记下**本次**出发时刻，再诊断 —— 而不是「记一条旧的、直接诊断一条新的」。
     *
     * ⚠ 这个顺序正是本条存在的理由：首版按后者写，全绿；
     * 但适配器实际是前者，而后者在实现里会把 `lastSentAt` 覆盖成**本次**，
     * 算出来恒为 `0ms`（端到端脚本真的打印出过 `距上条 0ms`）。
     * ⚠ 下面紧跟一条**反向验证**专测这个覆盖。
     */
    it('★「距上条」算的是**上一条**请求，且按适配器的真实调用顺序', () => {
      const T = 1_000_000
      noteZcodeRequestSent('acct-A', T - 90_000)     // 上一条
      noteZcodeRequestOk('acct-A', T - 89_500)
      noteZcodeRequestSent('acct-A', T)             // ★ 本次：先记
      noteZcodeRequestFailed('acct-A')              // ★ 再诊断（适配器的顺序）
      const line = formatZcodeDiagnostic({
        accountId: 'acct-A',
        sentAt: T,
        status: 405,
        shape: realShape(),
        now: T,
      })
      expect(line).toContain('距上条 1分30秒')
      expect(line).not.toContain('距上条 0ms')
    })

    /**
     * ★ 分钟/小时档的换算（真实缺陷，逐字复现）。
     *
     * 初版把分钟档写成 `${Math.floor(seconds % 60)}分…` —— 分位取的是**秒的
     * 余数**，于是 90 秒渲染成「30分30秒」。该错误是在**真实探针输出**里
     * 发现的（「最近成功 29分29秒前」），纯函数单测当时没覆盖 ≥60 秒的区间。
     */
    it('★ 分钟/小时档换算正确（90 秒 ≠ 30 分 30 秒）', () => {
      const T = 10_000_000
      /**
       * 每个断言用**独立账号**：复用同一个会让上一条断言留下的
       * `previousSentAt` 变成下一条的分母（诊断量的是「上一条」）。
       */
      const gapAt = (n: number, sincePrev: number) => {
        const id = `acct-G${n}`
        const sentAt = T - n * 1_000
        noteZcodeRequestSent(id, sentAt - sincePrev)   // 铺一条「上一条」
        noteZcodeRequestSent(id, sentAt)               // 本次
        noteZcodeRequestFailed(id)
        return formatZcodeDiagnostic({
          accountId: id, sentAt, status: 405, shape: realShape(), now: sentAt,
        })
      }
      expect(gapAt(1, 90_000)).toContain('距上条 1分30秒')
      expect(gapAt(2, 3_600_000)).toContain('距上条 1小时')
      expect(gapAt(3, 5_400_000)).toContain('距上条 1小时30分')
      expect(gapAt(4, 120_000)).toContain('距上条 2分')
    })

    it('★ 本次记录不得把自己的间隔抹成 0（连续两发的分母是上一条）', () => {
      const T = 2_000_000
      noteZcodeRequestSent('acct-A', T - 5_000)
      noteZcodeRequestSent('acct-A', T - 2_400)      // 本次与上一条隔 2.6 秒
      noteZcodeRequestFailed('acct-A')
      const line = formatZcodeDiagnostic({
        accountId: 'acct-A', sentAt: T - 2_400, status: 405, shape: realShape(), now: T - 2_400,
      })
      expect(line).toContain('距上条 2.6s')
    })

    it('首次请求没有「上一条」时写破折号而不是 0', () => {
      const line = formatZcodeDiagnostic({
        accountId: 'acct-D', sentAt: 5_000, status: 405, shape: realShape(), now: 5_000,
      })
      expect(line).toContain('距上条 —')
    })
  })

  /**
   * ★★ `logid` 必须进诊断行（2026-10-12）。
   *
   * ## 为什么（issue IKJI0Y 的原始记录 + 本机一手实测）
   *
   * 笔记原话：「响应体还带 **`logid`** —— 向用户索取现场时**优先要它**
   * （上游侧排障凭据）」。但**此前它从未被解析过**（全仓 grep `logid` 零命中），
   * 于是用户报障时我们只能拿到「账号#1 · 身份块 2898 字符 · HTTP 405」，
   * **没有一样是上游能据以查日志的东西**。
   *
   * ## 本机实测（`scripts/probe-zcode-logid-shape.mjs`，只发 GET）
   *
   * 四个端点（`client/configs` / `billing/preview` / `billing/balance` /
   * `event/report`）全部**同时**带：
   *
   * ```
   * [header] x-request-id = 20261012145652694e8f48d3614ae49634
   * [body]   logid        = 20261012145652694e8f48d3614ae49634   ← ★ 逐字相同
   * ```
   *
   * ⇒ 两者是**同一个值**。故判据取**双来源**：
   * ① 响应体顶层 `logid`（业务错误的主路）；
   * ② HTTP 头 `x-request-id`（**边缘 HTML 页也有它** —— 而那种响应体里没有 `logid`，
   *    正是 3012 之外另一类高频故障，少了这条就查不到）。
   */
  describe('★ logid 现场（上游排障的唯一凭据）', () => {
    it('从响应体顶层 `logid` 取到（业务错误的主路）', () => {
      expect(extractZcodeLogId(
        '{"code":3012,"msg":"request has been blocked due to unusual activity.","logid":"abc123"}',
      )).toBe('abc123')
    })

    it('★ 响应体没有 `logid` 时回退到 HTTP 头 `x-request-id`（边缘 HTML 页走这条）', () => {
      // 边缘页形态：正文是 HTML，body 里解析不出 logid —— 但 header 有。
      expect(extractZcodeLogId('<html><body>502 Bad Gateway</body></html>', {
        'x-request-id': 'hdr-999',
      })).toBe('hdr-999')
    })

    it('★ 响应体优先于 header（两者都在时取 body 的业务值）', () => {
      expect(extractZcodeLogId('{"logid":"from-body"}', { 'x-request-id': 'from-header' }))
        .toBe('from-body')
    })

    it('header 名大小写不敏感（HTTP 头本就大小写不敏感）', () => {
      expect(extractZcodeLogId('{}', { 'X-Request-Id': 'upper-1' })).toBe('upper-1')
    })

    it('取不到时返回 undefined（**不编造**、不留空壳）', () => {
      expect(extractZcodeLogId('{"code":3012}')).toBeUndefined()
      expect(extractZcodeLogId('')).toBeUndefined()
      expect(extractZcodeLogId('<html></html>', {})).toBeUndefined()
      // 空白值等同没有（`"logid":""` / `"  "` 都不算现场）
      expect(extractZcodeLogId('{"logid":""}')).toBeUndefined()
      expect(extractZcodeLogId('{"logid":"   "}')).toBeUndefined()
    })

    it('非字符串 logid（数字/对象）不得被 stringify 出来（形状防御）', () => {
      expect(extractZcodeLogId('{"logid":12345}')).toBeUndefined()
      expect(extractZcodeLogId('{"logid":{"a":1}}')).toBeUndefined()
    })

    it('★ 诊断行带上 logid（让用户能直接把现场报回上游）', () => {
      const line = formatZcodeDiagnostic({
        accountId: 'acct-L',
        sentAt: 1_000,
        status: 405,
        shape: realShape(),
        logId: '20261012145652694e8f48d3614ae49634',
        now: 1_000,
      })
      expect(line).toContain('logid 20261012145652694e8f48d3614ae49634')
    })

    it('★ 没有 logid 时**整项省略**（不留「logid 」空壳，与 shape 缺省同款纪律）', () => {
      const line = formatZcodeDiagnostic({
        accountId: 'acct-L2', sentAt: 1_000, status: 405, shape: realShape(), now: 1_000,
      })
      expect(line).not.toContain('logid')
    })

    /**
     * ★★ **接线守卫**：原语写好了必须真的接上。
     *
     * 本仓库历史上**多次**栽在「原语写好了但没接上」（`zcode-upstream.ts` 的
     * `fetchImpl` 曾是**死参数**；`catalogIdsOf` 改名后 85 条用例全绿而生产退化）。
     * 上面那几条只证明 `formatZcodeDiagnostic` **能**渲染 logid，
     * **不证明**两条真实路径真的把值传进去了 —— 少了本段，
     * 「`logId:` 那一行被删掉」会让全部单测继续绿，而线上永远看不到 logid。
     */
    it('★ 接线：推理路径与领取路径都必须把 logId 传进诊断', () => {
      const adapterSrc = readFileSync(resolve(HERE, '../../src/zcode-adapter.ts'), 'utf8')
      const authSrc = readFileSync(resolve(HERE, '../../src/zcode-auth.ts'), 'utf8')
      // 剥注释：本仓库记过「把接线改成注释后源码正则仍全绿」那类假绿。
      const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

      // 推理路径：从**真实响应**取（体 + 头），不是凭空造一个值。
      expect(strip(adapterSrc)).toMatch(/logId:\s*extractZcodeLogId\(text,\s*response\.headers\)/)
      // 领取路径：读上游 outcome 带上来的那个。
      expect(strip(authSrc)).toMatch(/logId:\s*outcome\.logId/)
    })

    it('★ 接线：领取侧必须在**持有 response 的那一层**提取（下游已无 header）', () => {
      const src = stripComments(readFileSync(resolve(HERE, '../../src/zcode-upstream.ts'), 'utf8'))
      // `claimZcodePlan` 里提取并落到返回值 —— 那是唯一同时有 response 与完整 text 的地方。
      expect(src).toMatch(/const\s+logId\s*=\s*extractZcodeLogId\(text,\s*response\.headers\)/)
      expect(src).toMatch(/\.\.\.logId\s*===\s*undefined\s*\?\s*\{\}\s*:\s*\{\s*logId\s*\}/)
    })
  })

  describe('红线：诊断行不得含任何凭据', () => {
    it('★ accountId 的每个子串都不得出现在诊断行里', () => {
      const accountId = 'zcode-1a2b3c4d'
      noteZcodeRequestSent(accountId, 1_000)
      noteZcodeRequestOk(accountId, 1_100)
      const line = formatZcodeDiagnostic({
        accountId,
        sentAt: 2_000,
        status: 405,
        shape: realShape(),
        now: 2_000,
      })
      expect(line).not.toContain(accountId)
      // 逐个子串也排除（防止将来改成「取前 8 位」这类半截输出）
      for (const token of ['1a2b', 'b3c4', '1a2b3c4d', 'zcode-']) {
        expect(line).not.toContain(token)
      }
    })

    it('JWT / device_mid 不进诊断（诊断只看序号与计数）', () => {
      // 账号 id 哪怕长得像 JWT，也只会变成一个序号
      const jwtish = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjo0NTQ0MTc3fQ.sig'
      const line = formatZcodeDiagnostic({
        accountId: jwtish, sentAt: 1, status: 405, shape: realShape(), now: 1,
      })
      expect(line).not.toContain(jwtish)
      expect(line).not.toContain('eyJ')
    })
  })

  describe('文案接线', () => {
    it('★ 3012 文案带上诊断行', () => {
      noteZcodeRequestSent('acct-A', 1_000)
      noteZcodeRequestFailed('acct-A')
      const diag = formatZcodeDiagnostic({
        accountId: 'acct-A', sentAt: 1_000, status: 405, shape: realShape(), now: 1_000,
      })
      const text = describeUpstreamError(405, '{"code":3012,"msg":"blocked"}', diag)
      expect(text).toContain('本机诊断：')
      expect(text).toContain('账号#1')
      expect(text).toContain('身份块 2643 字符')
    })

    it('★ 不给诊断时行为与原来**逐字一致**（旧调用点不受影响）', () => {
      const text = describeUpstreamError(405, '{"code":3012,"msg":"blocked"}')
      expect(text).not.toContain('本机诊断')
      expect(text).toContain('原始响应：blocked')
    })

    it('★ 诊断只是**加了一行**，不改变 3012 的可重试性', () => {
      const diag = formatZcodeDiagnostic({
        accountId: 'acct-A', sentAt: 1, status: 405, shape: realShape(), now: 1,
      })
      const code = httpErrorCodeForZcode(405, '{"code":3012}')
      expect(code).toBe('PERMISSION')
      expect(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']).not.toContain(code)
      expect(describeUpstreamError(405, '{"code":3012}', diag)).toContain('3012')
    })

    it('非 3012 的错误**不附**诊断（那些文案本身已说明原因）', () => {
      // 适配器只在 `text.includes('3012')` 时传诊断；这里验证纯函数侧：
      // 即使误传，3007/1005 的固定文案仍以自己的说明开头。
      const diag = '账号#1 · 身份块 2643 字符'
      expect(describeUpstreamError(400, '{"code":3007}', diag)).toContain('阿里云 captcha 校验失败')
      expect(describeUpstreamError(429, '{"code":1005}', diag)).toContain('额度用尽')
    })
  })
})
