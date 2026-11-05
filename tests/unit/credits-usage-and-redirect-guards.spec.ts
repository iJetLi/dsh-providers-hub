/**
 * 四审 G / H 两处修复的**源码级闸门**（2026-11-02）。
 *
 * ## 为什么是源码级而不是行为级
 *
 * 两处修复的承重件都在**闭包内部**，外面没有可注入的接缝：
 *
 * 1. `loginMergedRedirect` 的 TTL / 上限（四审 G 建议、H🟢 同型）：表、常量、
 *    `rememberLoginMergedRedirect` / `takeFreshLoginMergedRedirect` 全在
 *    `createJetHubRpc()` 的闭包里，不可导出、也不能从 `login.poll` 之外触达
 *    ⇒ 行为级要造「两次浏览器登录被判重 + 时钟推进 30 分钟」，成本远大于收益。
 * 2. 客户端 `balance.usage` 渲染（F🟡-8 的落地端）：`plugin-src/client/*.js`
 *    不是 TS 模块、也没有 render 测试底座 ⇒ 只能读文件断言。
 *
 * ⚠️ 源码级断言的经典失效形态是「锚点漂移后仍然绿」：
 *    - 本文件所有 `indexOf` 锚点都**先断言命中**（`>= 0`），命中不到直接失败；
 *    - 涉及「不许再出现」的反向断言与正向断言**成对**出现，只删一半会红。
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

function read(relative: string): string {
  return readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')
}

const rpcSource = read('src/jet-hub-rpc.ts')
const clientSource = read('plugin-src/client/jet-hub.js')
const stylesSource = read('plugin-src/client/jet-hub-styles.js')
const baizhiCreditsSource = read('src/baizhi-credits.ts')

describe('loginMergedRedirect 必须有 TTL 与容量上限（四审 G/H）', () => {
  it('常量存在且是「30 分钟 / 200 条」', () => {
    expect(rpcSource, '必须有 30 分钟的 TTL 常量').toContain(
      'const LOGIN_MERGED_REDIRECT_TTL_MS = 30 * 60_000',
    )
    expect(rpcSource, '必须有 200 条的容量上限').toContain(
      'const LOGIN_MERGED_REDIRECT_LIMIT = 200',
    )
  })

  it('写入与读取都走封装函数（不许绕过 TTL 直接操作 Map）', () => {
    const rememberAt = rpcSource.indexOf('function rememberLoginMergedRedirect(')
    const takeAt = rpcSource.indexOf('function takeFreshLoginMergedRedirect(')
    expect(rememberAt, 'rememberLoginMergedRedirect 不见了').toBeGreaterThanOrEqual(0)
    expect(takeAt, 'takeFreshLoginMergedRedirect 不见了').toBeGreaterThanOrEqual(0)

    // 写入函数体内必须做「过期清理」+「超限淘汰」两件事。
    const rememberBody = rpcSource.slice(rememberAt, takeAt)
    expect(rememberBody, '写入前必须清过期项').toContain('loginMergedRedirect.delete(key)')
    expect(rememberBody, '超限必须淘汰最旧项').toContain(
      'while (loginMergedRedirect.size >= LOGIN_MERGED_REDIRECT_LIMIT)',
    )

    // `login.poll` 的读取点必须用 take（它负责删过期项），不能裸 get。
    expect(rpcSource).toContain('const merged = takeFreshLoginMergedRedirect(req.accountId)')
    expect(rpcSource, '不允许再出现裸 get（它不判 TTL）').not.toContain(
      'loginMergedRedirect.get(req.accountId)',
    )
  })
})

describe('客户端的「本月消耗」走 usage 字段，不许混进资源包（F🟡-8 / H 校验）', () => {
  it('宿主侧不再把用量塞进 packages', () => {
    expect(baizhiCreditsSource, '必须产出 usage 字段').toContain('usage: { label: \'本月消耗\'')
    expect(
      baizhiCreditsSource,
      '不许再 push 一个 active:false 的假资源包（会被渲染成「已失效」）',
    ).not.toMatch(/packages\.push\(\{[\s\S]{0,300}?本月消耗/)
  })

  it('客户端渲染 usage，且有对应样式类', () => {
    const usageAt = clientSource.indexOf("balance.usage ? React.createElement('span'")
    expect(usageAt, '面板没有渲染 balance.usage ⇒ 本月消耗会静默消失').toBeGreaterThanOrEqual(0)
    const usageChunk = clientSource.slice(usageAt, usageAt + 200)
    /**
     * ⚠️ **2026-11-02 五审 J🟡-4：这里原来用 `toContain('dim-jh-creditUsage')`**，
     * 而 `toContain` 是**子串包含** ⇒ 把类名改成 `dim-jh-creditUsageRetired` 仍然绿
     * （实测），判别力等于零。类名断言必须精确到 `className: '<名字>'` 这一整段，
     * 样式表那一侧则要求 `.名字 {` 真的存在（不是子串）。
     */
    expect(usageChunk, 'className 必须精确等于 dim-jh-creditUsage').toContain(
      "className: 'dim-jh-creditUsage'",
    )
    expect(usageChunk, '不许出现 dim-jh-creditUsage 的衍生类名').not.toMatch(
      /dim-jh-creditUsage[A-Za-z0-9_-]/,
    )
    expect(stylesSource, '样式表里必须有 `.dim-jh-creditUsage {` 这条规则').toMatch(
      /\.dim-jh-creditUsage\s*\{/,
    )
  })

  it('usage 不参与「N/M 个资源包有效」的计数（它不是包）', () => {
    /**
     * ⚠️ **2026-11-02 五审 J🟡-2：原用例是恒真的。**
     * 它用 `/balance\.packages\.filter\([^)]*\)\.length/g` 收集命中，再
     * `expect(matches.length).toBeGreaterThanOrEqual(0)` —— 而全仓**根本没有**
     * 这种写法（真实代码是 `const all = balance?.packages || []` 再 `all.filter(...)`）
     * ⇒ matches 恒为空数组、循环空转、`>= 0` 恒真。反证：把 `activeCount` 改成
     * `all.filter((p) => p.active || balance.usage !== undefined).length`
     * （正是它声称要守的回归）实测仍然 7 passed 全绿。
     * ⇒ 现在直接盯真实的那两行：包列表只来自 packages、计数只读 all。
     */
    const allAt = clientSource.indexOf('const all = balance?.packages || [];')
    expect(allAt, '包列表必须只来自 balance.packages').toBeGreaterThanOrEqual(0)
    const countAt = clientSource.indexOf('const activeCount = ', allAt)
    expect(countAt, '找不到 activeCount 的声明').toBeGreaterThan(allAt)
    /**
     * ⚠⚠ 六审 A🟡-3：窗口原本只取「`countAt` 到**第一个换行**」，
     * 而下两种真回归恰恰落在窗口外（实测全绿）：
     *
     * - C5：`const activeCount = all.filter((p) => p.active)` **下一行** 接
     *   `.length + (balance.usage ? 1 : 0)`；
     * - C6：`activeCount` 行原样，紧接着 `if (balance?.usage) all.push(...)` ——
     *   而 `all` 同一数组还被 `formatQuotaLine` / `splitCreditsByExpiry` /
     *   `exclusivePoolRemainingOf` 三处消费，污染面很宽。
     *
     * ⇒ 窗口扩到「计数行 → `const quotaText`」整段：只要中间出现 `usage` 就红。
     */
    const quotaAt = clientSource.indexOf('const quotaText = ', countAt)
    expect(quotaAt, '找不到 quotaText（计数窗口的终点）').toBeGreaterThan(countAt)
    const countWindow = clientSource.slice(countAt, quotaAt)
    expect(countWindow, '计数只能读 all（= packages）').toMatch(/all\.filter\(\(?p\)? => p\.active\)/)
    expect(countWindow, '计数窗口里混进了 usage（跳行掺入、往 all 里 push 都算）')
      .not.toContain('usage')
    const between = clientSource.slice(allAt, countAt)
    expect(between, '取包列表到计数之间不许出现 usage').not.toContain('usage')
  })
})

describe('三条弹窗渲染链都必须是白名单，不许有兜底式默认值（五审收口）', () => {
  /**
   * 三条链是同一个毛病：兜底式默认值把「provider 字段错了/缺了」也当成某一家
   * ⇒ 渲染别家弹窗、保存到别家端点。
   * - `keyModal` 链：三审 E🔴-2 已改白名单（`monkeycode-client-wiring.spec.ts` 守）。
   * - `credentialModal` 链：四审 H-1 已改（本文件守）。
   * - `proxyModalComponent`：四审 H🟢 指出 `return OpencodeProxyModal` 是 fail-open，
   *   五审改成 `return provider === 'opencode' ? OpencodeProxyModal : null`（本文件守）。
   */

  it('credentialModal 链末支必须显式点名 magicrew 两家', () => {
    const at = clientSource.indexOf("credentialModal && credentialModal.provider === 'baizhi'")
    expect(at, '找不到 credentialModal 链的起点').toBeGreaterThanOrEqual(0)
    const chain = clientSource.slice(at, at + 2600)
    expect(chain, 'magicrew 国内站必须挂在白名单上').toContain(
      "credentialModal && (credentialModal.provider === 'magicrew' || credentialModal.provider === 'magicrewintl') ? React.createElement(MagicrewImportModal",
    )
  })

  it('proxyModalComponent 只认 opencode，其余返回 null（不 fail-open）', () => {
    const at = clientSource.indexOf('function proxyModalComponent(provider) {')
    expect(at, '找不到 proxyModalComponent').toBeGreaterThanOrEqual(0)
    const body = clientSource.slice(at, clientSource.indexOf('\n}', at) + 2)
    expect(body, '必须显式点名 opencode').toContain(
      "return provider === 'opencode' ? OpencodeProxyModal : null;",
    )
    expect(body, '不许再用兜底 return（会把缺字段的 provider 当成 opencode）')
      .not.toMatch(/\n {2}return OpencodeProxyModal;/)

    // 渲染侧必须判空，否则返回 null 会 React.createElement(null) 直接崩。
    expect(clientSource).toContain(
      'proxyModal && proxyModalComponent(proxyModal.provider) ? React.createElement(proxyModalComponent(proxyModal.provider), {',
    )
  })

  /**
   * 六审 B🟡-6：`keyEditModal` / `qiniuKeyEditModal` 两条弹窗链只判 truthy。
   *
   * 它们靠「写入点唯一」保安全（`setKeyEditModal` 只在 modelscope 分支写），
   * 当前不可达 —— 但与三审/四审收口的 keyModal / credentialModal 同型：
   * 一次误写入就能把别家的弹窗挂上来。⇒ 也给它们加 provider 判据。
   */
  it('两条编辑弹窗链也必须带 provider 判据（不能只判 truthy）', () => {
    expect(
      clientSource,
      'modelscope 编辑弹窗只能在 modelscope 面板挂',
    ).toContain(
      "keyEditModal && provider === 'modelscope' ? React.createElement(ModelscopeKeyEditModal,",
    )
    expect(
      clientSource,
      'qiniu 编辑弹窗只能在 qiniu 面板挂',
    ).toContain(
      "qiniuKeyEditModal && provider === 'qiniu' ? React.createElement(QiniuKeyEditModal,",
    )
  })

  /**
   * 六审 B🟡-7：`submitMonkeycodeKey` 在「空 Key 且不是『编辑态 + secret/cookie』」时
   * 原来是**静默 return** —— 新建模式只填 session cookie 点确定，界面零反馈。
   * 与本轮「失败必须落到用户可见处」的宗旨同型。
   */
  it('MonkeyCode 空 Key 必须有明确回执（不许静默 return）', () => {
    const fnAt = clientSource.indexOf(
      "const submitMonkeycodeKey = async (value, provider = 'monkeycode') => {",
    )
    expect(fnAt, '找不到 submitMonkeycodeKey').toBeGreaterThanOrEqual(0)
    const emptyAt = clientSource.indexOf("if (apiKey === '') {", fnAt)
    const payloadAt = clientSource.indexOf('const payload = { apiKey };', emptyAt)
    expect(emptyAt, '找不到空 Key 分支').toBeGreaterThanOrEqual(0)
    expect(payloadAt, '找不到空 Key 分支的出口').toBeGreaterThan(emptyAt)
    const branch = clientSource.slice(emptyAt, payloadAt)
    expect(branch, '空 Key 分支必须给出内联错误').toContain(
      "API Key 不能为空。若只是给已有账号补网页登录态",
    )
  })
})
