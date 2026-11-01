import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CREDITS_CAPABILITIES, RATE_LIMIT_CAPABILITIES, supportsRateLimit } from '../../plugin-src/client/credits-capabilities.js'
import { descriptorOf } from '../../src/provider-registry.js'

const here = dirname(fileURLToPath(import.meta.url))
const hubSource = readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')

/**
 * 客户端源码级回归。
 *
 * UI 组件无法在单测里渲染（react 不在本仓库依赖内），
 * 故与既有 `credits-capabilities.spec.ts` 同法：用源码断言锁死关键守卫。
 */
describe('Loomy 客户端接线', () => {
  it('PROVIDERS 里登记了 loomy', () => {
    // ⚠️ 2026-10-08 改：`PROVIDERS` 由 `src/provider-registry.ts` 派生，
    // 故改为读 registry 的**行为断言**，不再扫 `jet-hub.js` 的源码文本。
    expect(descriptorOf('loomy')?.label).toBe('Loomy (讯飞)')
  })

  it('Loomy 走统一的「弹窗 + 轮询」路径（与其他 provider 一致）', () => {
    // 不再有 loginMode/sms 分支：account.create 直接返回本地弹窗 loginUrl
    expect(hubSource).not.toContain("loginMode === 'sms'")
    expect(hubSource).not.toContain('SmsLoginForm')
    // 走既有的 window.open + login.poll
    expect(hubSource).toContain("'login.poll'")
    expect(hubSource).toContain('window.open(loginUrl')
  })

  /**
   * ⚠️ **真实缺陷回归**（用户报障「新建账号失败：Loomy 短信登录需要手机号」）：
   * 早期前端有个「短信表单」分支，表单要等 `account.create` 返回才渲染、
   * 而 `account.create` 又要求先有手机号 —— **顺序死锁**。
   * 改用微信扫码后该分支已删除。
   */
  it('account.create 调用不再传 phone（顺序死锁回归）', () => {
    /**
     * ⚠️ 定位必须锚在 **`buildCreateAccountPayload(`**（Loomy 走的那条通用载荷），
     * 不能用「第一次出现 `rpcCall('account.create'` 后 200 字符」——
     * 2026-10-29 加了 Magicrew 的「手机号 + 密码」分支（它**合法地**带 `phone`），
     * 而那条分支的文本可能落进前 200 字符 ⇒ 误报。
     * ⚠️ 判据本身不变（通用载荷里**不得**有 phone），只是把锚点收紧。
     */
    const start = hubSource.indexOf('buildCreateAccountPayload(provider')
    expect(start, '找不到 Loomy 的通用载荷调用（改写了要同步改本用例）').toBeGreaterThan(-1)
    const body = hubSource.slice(start, start + 200)
    expect(body).not.toContain('phone')
  })

  it('新手任务按钮按能力渲染（onboardingTasks）', () => {
    expect(hubSource).toContain('supportsOnboardingTasks')
    expect(hubSource).toContain("'onboarding.claim'")
  })

  /**
   * ⚠️ **真实缺陷**（用户报障「新手任务按钮溢出了，文字有点长」）：
   * `.dim-jh-accountActions` 是 `flex-wrap: nowrap`，行内已有 5 个文字按钮，
   * 再加「领取新手任务」会被挤出容器。
   *
   * 修法：压成**纯礼物图标按钮**，文案移到 `title` tooltip。
   * 本用例锁死「不再有文字标签」+「图标与 tooltip 都在」。
   */
  it('新手任务按钮是纯图标 + tooltip（不再用长文字，避免溢出）', () => {
    // 用「礼物图标」这一唯一特征定位按钮体，再取到该按钮表达式结束
    // （下一个按钮 = 重测按钮的 RETEST_HELP）。不依赖缩进/换行形态。
    const iconAt = hubSource.indexOf('dim-jh-iconBtn')
    expect(iconAt).toBeGreaterThan(-1)
    const start = hubSource.lastIndexOf('onClaimOnboarding', iconAt)
    expect(start).toBeGreaterThan(-1)
    const end = hubSource.indexOf('RETEST_HELP', start)
    expect(end).toBeGreaterThan(start)
    const body = hubSource.slice(start, end)

    // ① 图标按钮类名（正方形，不撑宽）
    expect(body).toContain('dim-jh-iconBtn')
    // ② 礼物图标：svg + 盒身矩形
    expect(body).toContain("createElement('svg'")
    expect(body).toContain("createElement('rect'")
    // ③ tooltip 说明用途与「一次性」
    expect(body).toContain('title:')
    /**
     * ⚠️ **tooltip 不得写死金额**（2026-11-01 二审修）。
     *
     * 该按钮对**所有** `onboardingTasks: true` 的渠道渲染
     *（loomy / raccoon / magicrew / magicrewintl），而原先这里断言
     * 「`新手任务` 后 40 字符内出现 `10000`」—— 那是把 **Loomy 一家**的总额
     * 固化成了通用文案的期望值，与 `src/magicrew-checkin.ts` 那条
     * 「0 项不得报已全部完成」的纪律正相反（国际站恒 0 项、raccoon 3000）。
     * ⇒ 改成断言「说明用途 + 一次性」，金额交给领取结果面板（那里是实测值）。
     */
    expect(body).toMatch(/新手任务/)
    expect(body).toMatch(/一次性/)
    expect(body, 'tooltip 写死了金额 —— 对各渠道都显示错的数字').not.toMatch(/合计 \d+ 积分/)
    expect(body).toMatch(/仅能领取一次|只能领取一次/)
    // ④ 无障碍标签（图标按钮必需，否则屏幕阅读器读不出用途）
    expect(body).toContain("'aria-label'")
    // ⑤ **不再**把长文案作为按钮子节点
    expect(body).not.toMatch(/\}, '领取新手任务'\)/)
  })

  it('图标按钮有正方形样式（不依赖内容宽度）', () => {
    const styles = readFileSync(
      resolve(here, '../../plugin-src/client/jet-hub-styles.js'), 'utf8',
    )
    expect(styles).toContain('.dim-jh-iconBtn')
    // 左右 padding 与上下一致 → 正方形
    expect(styles).toMatch(/\.dim-jh-iconBtn \{[^}]*padding:\s*4px 8px/)
  })

  /**
   * ⚠️ **Loomy 不返回限流错误**（用户报障「这个 provider 好像没发现模型限流，
   * 把重置所有按钮删掉」）：积分耗尽时静默降级为扣永久积分，故
   * 「重测 / 重置」对它毫无意义 —— 重测永远测不出限流、还会白烧积分。
   */
  it('Loomy 不渲染「重测所有 / 重置所有」与卡片级「重测 / 重置」', () => {
    // 面板级：两个按钮都被 supportsRateLimit 门控
    expect(hubSource).toContain('supportsRateLimit(provider)')
    // 卡片级：新增 showRateLimitActions 开关
    expect(hubSource).toContain('showRateLimitActions')
    expect(hubSource).toContain('showRateLimitActions: supportsRateLimit(provider)')
  })

  it('能力矩阵里 loomy 显式登记为「无限流」，且默认视为有限流', () => {
    // ⚠️ 2026-10-08 改：限流表由 registry 派生，故改为**行为断言**
    //（原先正则扫 `credits-capabilities.js` 的 `loomy: Object.freeze({ rateLimit: false })`）。
    // Loomy 显式 false
    expect(supportsRateLimit('loomy')).toBe(false)
    expect(RATE_LIMIT_CAPABILITIES.loomy).toEqual({ rateLimit: false })
    // ⚠️ 默认必须是 true（未登记视为有限流），否则新增 provider 会凭空失去按钮
    expect(supportsRateLimit('codearts')).toBe(true)
    expect(supportsRateLimit('未登记的 provider')).toBe(true)
  })

  /**
   * ⚠️ **锁定永久积分**（用户需求）：面板级一个开关，Loomy 锁定后只消耗今日额度。
   *
   * 端点已通用化为 `credits.permanentLock`（CodeBuddy / WorkBuddy 共用），
   * 故这里断言的是「带 provider 的通用调用」而不是老的裸端点名 ——
   * ⚠️ **漏传 provider 会锁错对象**（三个 provider 各有一份状态）。
   *
   * ⚠️ 2026-10-26 用户要求「解锁/锁定永久积分改为图标+永久积分」：按钮上的文字
   * 已**固定**为「永久积分」，锁定/解锁的差别只剩图标形态与 `data-kind`。
   * 因此下面断言的不再是「按钮文字随状态切换」，而是：
   * ① 文字固定（不能有人把状态又塞回文字里，那会与图标重复且宽度跳动）；
   * ② `aria-label` 必须**说动作**（读屏用户看不到图标，只念「永久积分」等于没信息）；
   * ③ 两个动作字面量都得在（它们就是 aria-label 的取值，缺一个等于某状态无标签）。
   */
  it('Loomy 渲染「锁定 / 解锁永久积分」按钮并走通用 credits.permanentLock', () => {
    expect(hubSource).toContain('supportsPermanentLock')
    expect(hubSource).toContain("'credits.permanentLock'")
    expect(hubSource).toMatch(/rpcCall\('credits\.permanentLock', \{ provider \}\)/)
    expect(hubSource).toMatch(/rpcCall\('credits\.permanentLock', \{ provider, locked: next \}\)/)
    // 两个动作字面量都在（= aria-label 的两种取值）
    expect(hubSource).toContain("'解锁永久积分'")
    expect(hubSource).toContain("'锁定永久积分'")
    // 按钮文字固定为「永久积分」，不再随状态切换
    expect(hubSource).toContain("lockBusy ? '处理中…' : '永久积分'")
    // ⚠️ 不能用 not.toContain("permanentLocked ? '解锁永久积分' : '锁定永久积分'")
    //    —— aria-label 用的就是这个三元，那样写会打到它自己。
    //    正确的判据是**次数**：两个动作字面量各只允许出现一次（都在 aria-label 上），
    //    文字子节点若又长出三元就会变成两次。
    expect((hubSource.match(/'解锁永久积分'/g) ?? []).length, '「解锁永久积分」只允许出现在 aria-label 里一次')
      .toBe(1)
    expect((hubSource.match(/'锁定永久积分'/g) ?? []).length, '「锁定永久积分」只允许出现在 aria-label 里一次')
      .toBe(1)
  })

  it('锁定状态在面板挂载时读取一次（且只对支持的 provider 发请求）', () => {
    expect(hubSource).toMatch(/if \(!canLockPermanent\) return undefined/)
    expect(hubSource).toMatch(/rpcCall\('credits\.permanentLock', \{ provider \}\)/)
  })

  /**
   * ⚠️ 文案必须**按 provider 取**：把 Loomy 的「每日赠送额度」套到两个 buddy 上，
   * 用户会以为锁上后每天有新的额度可烧 —— 而它们拿到的其实是 14/30 天后到期的包。
   *
   * ⚠️ 还要带**后端回传的窗口天数**：窗口可被环境变量覆盖，前端写死数字就会出现
   * 「提示说只烧 15 天内的、实际按 31 天筛号」。
   */
  it('锁定文案走 permanentLockCopy(provider, windowDays)，不在面板里写死说法', () => {
    expect(hubSource).toContain('permanentLockCopy')
    expect(hubSource).toMatch(/const lockCopy = permanentLockCopy\(provider, expiryWindowDays\)/)
    expect(hubSource).toMatch(/title: permanentLocked \? lockCopy\.lockedTitle : lockCopy\.lockTitle/)
    expect(hubSource).toMatch(/text: next \? lockCopy\.lockedNotice : lockCopy\.unlockedNotice/)
    // 三处都要存窗口天数：余额查询、锁定读取、锁定切换（与积分行共用同一个 state）
    expect(hubSource.match(/setExpiryWindowDays\(res\?\.windowDays \?\? null\)/g)).toHaveLength(3)
  })

  /**
   * ⚠️ 客户端**不调用** `onboarding.status`：领取动作（`onboarding.claim`）
   * 的响应已带回 `earned`/`total`/逐任务明细，足以渲染进度，
   * 再发一次只读查询纯属多余请求。该端点保留给将来的面板级进度展示。
   */
  it('客户端不调用 onboarding.status（claim 的响应已含进度）', () => {
    expect(hubSource).not.toContain("'onboarding.status'")
  })

  it('新手任务不被混进「一键签到」（否则每天发 8 个必然 alreadyCompleted 的请求）', () => {
    // claimCredits 只调 credits.claimAll，不得调用 onboarding.claim
    const start = hubSource.indexOf('const claimCredits = async')
    expect(start).toBeGreaterThan(-1)
    const end = hubSource.indexOf('\n  };', start)
    const body = hubSource.slice(start, end > start ? end : start + 3000)
    expect(body).toContain("'credits.claimAll'")
    expect(body).not.toContain('onboarding.claim')
  })

  it('能力矩阵含 loomy 且三项齐全', () => {
    expect(CREDITS_CAPABILITIES.loomy)
      .toEqual({ balance: true, dailyCheckin: true, onboardingTasks: true })
  })

  /**
   * ⚠️ 两池必须**分开显示**（用户明确要求）：永久积分与每日赠送是两个
   * 分开计算的池，只显示合计会丢失这一信息。
   *
   * ⚠️ 判据已从「硬编码 loomy 的两个池名」改成通用的 `formatPoolSplitLine`
   * （用户 2026-09-29 要求 Raccoon 的「每日积分」也按 loomy 那样显示）——
   * 故这里断言的是**走那条通用函数**，而不是文件里出现两个池名字面量。
   */
  it('账号卡片走通用的当日池分桶（Loomy 与 Raccoon 共用）', () => {
    expect(hubSource).toContain('formatPoolSplitLine')
    expect(hubSource).toMatch(/formatPoolSplitLine\([\s\S]{0,200}provider === 'loomy' \? '永久' : '长期'/)
  })

  /**
   * 短信登录（备用路径）现在**完全在宿主侧**（`login.sendSms` / `login.submitSms`），
   * 客户端不再有对应表单 —— 主路径是微信扫码弹窗。
   */
  it('客户端不再包含短信表单（已改为宿主侧备用路径）', () => {
    expect(hubSource).not.toContain("'login.sendSms'")
    expect(hubSource).not.toContain("'login.submitSms'")
  })
})
