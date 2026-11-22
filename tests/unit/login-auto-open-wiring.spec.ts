/**
 * 「新建账号时自动打开浏览器授权页」开关的**接线守卫**（2026-11-23）。
 *
 * ## 为什么必须有本文件
 *
 * 这个功能横跨**四层**，每一层单独看都「看起来接好了」，断一层却是**静默**的：
 *
 * | 层 | 断掉的症状 |
 * | --- | --- |
 * | 宿主偏好 + 闸门（`login.ts` / `accio-oauth.ts` / raccoon 页） | 设置里关了，宿主仍开无痕窗 / 仍开授权页 |
 * | RPC（`jet-hub-rpc.ts`） | 设置页开关读不到、写不进（点了弹回去，零报错） |
 * | 客户端 store（`login-preferences-store.js`） | 设置页与 `createAccount` 各持一份值 ⇒ 改了不生效 |
 * | `createAccount` 分流 + 设置分区 | 关了仍自动开窗；或永远走手动（反向缺陷） |
 *
 * 行为级判据分别在 `login-preferences*.spec.ts`（store/RPC）、
 * `jet-hub-panel-wiring.spec.ts`（真渲染 `createAccount`）、
 * `raccoon-login-page.spec.ts`（`opened/autoOpen` 分支）。本文件只钉**接线**
 * （符号被改了名 / 被整体重写时最先从这里变红），并锁住**弹窗尺寸**这条
 * 用户明确要求过的 CSS 契约。
 *
 * ⚠️ 源码文本断言有已知旁路（`if (false)` 包住仍在文件里）。故凡是能行为级测的
 * 都在上面三个文件里测；这里刻意只做「跨文件接线 + 字面锚点」这一类。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const read = (relative: string): string => readFileSync(resolve(here, '../../', relative), 'utf8')

const rpcSource = read('src/jet-hub-rpc.ts')
const loginSource = read('src/login.ts')
const accioSource = read('src/accio-oauth.ts')
const raccoonPageSource = read('src/raccoon-login-page.ts')
const indexSource = read('src/index.ts')
const typesSource = read('src/types.ts')
const clientSource = read('plugin-src/client/jet-hub.js')
const storeSource = read('plugin-src/client/login-preferences-store.js')
const gatewayPanelSource = read('plugin-src/client/openai-gateway-panel.js')
const stylesSource = read('plugin-src/client/jet-hub-styles.js')

/** 截取两个锚点之间的源码片段（锚点不存在时返回空串，由断言报红）。 */
function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  if (start < 0) return ''
  const end = source.indexOf(endMarker, start + startMarker.length)
  return source.slice(start, end < 0 ? undefined : end)
}

describe('宿主闸门：三处「自动打开浏览器」都必须过同一个判据', () => {
  it('★ login.ts 的 openBrowser 入口先判开关（阻塞式路径的唯一出口）', () => {
    const body = sliceBetween(loginSource, 'export function openBrowser(url: string): void {', 'const CORS_HEADERS')
    expect(body, 'openBrowser 没接闸门 ⇒ 关了开关仍会 spawn 浏览器').toContain('autoOpenBrowserEnabled()')
    expect(body, '关闭时必须提前 return（不能走到 spawn）').toMatch(/if\s*\(!autoOpenBrowserEnabled\(\)\)\s*\{[\s\S]*return/)
  })

  it('★★ login.ts 的 openIncognitoWindow：测试断路器在前、闸门紧随其后', () => {
    const body = sliceBetween(
      loginSource,
      'export function openIncognitoWindow(url: string): boolean {',
      'function pickToken(',
    )
    const breakerAt = body.indexOf("process.env.NODE_ENV === 'test'")
    const gateAt = body.indexOf('autoOpenBrowserEnabled()')
    expect(breakerAt, '测试断路器丢了 ⇒ pnpm test 会真开窗').toBeGreaterThan(-1)
    expect(gateAt, '无痕窗没接闸门 ⇒ 关了开关仍会弹无痕窗（CodeArts/OfficeAce）').toBeGreaterThan(-1)
    expect(gateAt, '闸门必须在测试断路器之后（单测无论如何都不该走到开窗）').toBeGreaterThan(breakerAt)
  })

  it('★ accio-oauth.ts 自带的 openBrowser 也过闸门（同口径）', () => {
    const body = sliceBetween(accioSource, 'export function openBrowser(url: string): void {', 'export interface AccioTokenResult')
    expect(body).toContain('autoOpenBrowserEnabled()')
  })

  it('★★ index.ts 把偏好后端接到宿主闸门的判据来源上', () => {
    expect(indexSource, '没接线 ⇒ autoOpenBrowserEnabled() 恒为默认开，设置页开关对宿主无效')
      .toMatch(/configureAutoOpenBrowserEnabled\(\(\)\s*=>\s*[\w.]+\.load\(\)\)/)
    expect(indexSource).toContain('createLoginPreferenceStore')
  })
})

describe('RPC：两条 case + 类型', () => {
  it('★ getEnabled / setEnabled 都在 switch 里', () => {
    expect(rpcSource).toContain("case 'loginPreferences.getEnabled': {")
    expect(rpcSource).toContain("case 'loginPreferences.setEnabled': {")
  })

  it('★★ 非布尔 ⇒ bad-request（不许默认值猜测）', () => {
    const body = sliceBetween(rpcSource, "case 'loginPreferences.setEnabled': {", "case 'nativeSearch.getEnabled': {")
    expect(body).toContain("typeof req.enabled !== 'boolean'")
    expect(body).toContain("code: 'bad-request'")
  })

  it('★★ 响应回**落盘值**而不是入参', () => {
    const body = sliceBetween(rpcSource, "case 'loginPreferences.setEnabled': {", "case 'nativeSearch.getEnabled': {")
    expect(body).toMatch(/await\s+\w+\.save\(req\.enabled\)/)
    expect(body, '回读落盘值 ⇒ save 静默失败时能抓到；回传入参就是「用户以为改了」').toMatch(
      /enabled:\s*loginPreferences\.load\(\)/,
    )
  })

  it('★ 三个 RPC 类型都在 types.ts', () => {
    for (const name of [
      'RpcLoginPreferencesGetEnabledResponse',
      'RpcLoginPreferencesSetEnabledRequest',
      'RpcLoginPreferencesSetEnabledResponse',
    ]) {
      expect(typesSource, `缺 ${name}`).toContain(`export interface ${name}`)
    }
  })
})

describe('Raccoon 授权页：关闭时不自动开窗，改由页面复制', () => {
  it('★★ runAuthorizeRound 由注入的闸门决定是否 openAuthorizePage，并回报 opened/autoOpen', () => {
    const body = sliceBetween(
      raccoonPageSource,
      'async function runAuthorizeRound(',
      '/** 处理一次本地请求。 */',
    )
    expect(body).toContain('autoOpenBrowser: () => boolean')
    expect(body).toContain('const autoOpen = autoOpenBrowser() !== false')
    expect(body, '必须由 autoOpen 决定是否开窗').toMatch(/if\s*\(autoOpen\)\s*openAuthorizePage\(receiver\.authorizeUrl\)/)
    expect(body).toContain('opened: autoOpen')
  })

  it('★ authorizeStart 的响应必须带 opened 与 autoOpen（页面靠它分流文案）', () => {
    const body = sliceBetween(
      raccoonPageSource,
      'if (url.pathname === RACCOON_LOGIN_PAGE_PATHS.authorizeStart) {',
      'if (url.pathname === RACCOON_LOGIN_PAGE_PATHS.authorizeStatus) {',
    )
    expect(body).toContain('opened: round.opened')
    expect(body).toContain('autoOpen: round.autoOpen')
  })

  it('★★ 页面脚本：autoOpen === false 时给复制提示 + 复制按钮（失败可手动选中）', () => {
    expect(raccoonPageSource).toContain("data.autoOpen === false")
    expect(raccoonPageSource).toContain('id="copyAuthorize"')
    expect(raccoonPageSource).toContain('navigator.clipboard.writeText(authorizeUrlValue)')
    expect(raccoonPageSource).toContain("fallbackCopyAuthorize() ? '已复制 ✓' : '复制失败，请手动选中'")
  })
})

describe('客户端：设置分区 + createAccount 分流', () => {
  it('★ jet-hub.js 引入模块级 store（与设置页共用同一份值）', () => {
    expect(clientSource).toContain("from './login-preferences-store.js'")
    expect(clientSource).toContain('loadLoginAutoOpen(rpcCall)')
  })

  it('★★ 设置分区：标题「登录授权」+ 用户定稿的 D 方案长句 label', () => {
    const body = sliceBetween(clientSource, '①b 登录授权', '// ② 定时签到')
    expect(body).toContain("'登录授权'")
    expect(body).toContain('新建账号时自动打开浏览器授权页；关闭则把授权链接复制到剪贴板')
    // 用户 2026-11-23 明确要求不出现豆包/百智云那一行提示
    expect(body, '设置分区里不应再出现 CDP 渠道例外提示').not.toContain('不受此开关影响')
    expect(body).toContain('toggleLoginAutoOpen')
  })

  it('★★ 关闭态：走手动链接 + 自动复制 + 跳过原有开窗分支', () => {
    const body = sliceBetween(clientSource, 'if (!loginAutoOpenEnabled()) {', '} else if (res.incognitoOpened === true) {')
    expect(body).toContain('setLoginUrlForManual(manualUrl)')
    expect(body).toContain('setLoginManualMode(true)')
    expect(body).toContain('copyToClipboard(manualUrl, { silent: true })')
    expect(body).toContain('skipClientOpen = true')
    expect(body, '手动链接必须优先用 forcedLoginUrl（MiniMax 语义）').toContain('res.forcedLoginUrl')
  })

  it('★★ 原有开窗分支的字面形态必须原样保留（三条既有守卫的锚点）', () => {
    // codearts-incognito-login ④ / minimax-forced-login ④ / login-link-copy
    for (const anchor of [
      "window.open(loginUrl, '_blank'",
      'setLoginUrlForManual(loginUrl)',
      "window.open(forcedLoginUrl, '_blank'",
      'setLoginUrlForManual(forcedLoginUrl)',
      'res.incognitoOpened === true',
      'skipClientOpen',
      'if (!skipClientOpen)',
      'window.confirm(',
      'const logoutUrl = typeof res.logoutUrl',
    ]) {
      expect(clientSource, `既有守卫锚点被改掉：${anchor}`).toContain(anchor)
    }
  })

  it('★ 手动链接区块按 loginManualMode 分流文案', () => {
    expect(clientSource).toContain('loginManualMode')
    expect(clientSource).toContain('已关闭「自动打开浏览器」：授权链接已复制到剪贴板')
    expect(clientSource, 'CodeArts / OfficeAce 的无痕建议只在这两家出现').toContain(
      "provider === 'codearts' || provider === 'officeace'",
    )
  })

  it('★ 链接区块清理时同步复位手动模式（4 处出口：reused / 超时 / 失败 / 成功）', () => {
    const resets = clientSource.match(/setLoginManualMode\(false\);/g) ?? []
    expect(resets.length, '清理点少于 4 处 ⇒ 上一次的「手动模式」文案会串到下一次登录').toBeGreaterThanOrEqual(4)
  })

  it('★ 复制工具支持 silent（跳过通用复制面板，面板自己就是兜底）', () => {
    expect(gatewayPanelSource).toContain('export async function copyToClipboard(value, options)')
    expect(gatewayPanelSource).toContain('const silent = options?.silent === true')
    expect(gatewayPanelSource).toMatch(/if\s*\(silent\)\s*return false/)
  })
})

describe('设置弹窗尺寸：用户明确要求「加宽加高、不要下拉条」', () => {
  it('★ 宽度 840 / 高度上限 940，且保留视口兜底', () => {
    const rule = /\.dim-jh-settingsModal\s*\{([^}]*)\}/.exec(stylesSource)
    expect(rule, '找不到 .dim-jh-settingsModal 规则').not.toBeNull()
    const body = rule?.[1] ?? ''
    expect(body, '宽度必须从 560 抬到 840（2026-11-23 用户二次要求）').toMatch(/width:\s*min\(840px,\s*100%\)/)
    expect(body, '高度上限必须从 760 抬到 940').toMatch(/max-height:\s*min\(940px,\s*calc\(100vh - 48px\)\)/)
  })

  it('★★ 边界参考「档次窗口」：实边框 + 内描边（暗色/浅色主题下都看得见）', () => {
    const rule = /\.dim-jh-settingsModal\s*\{([^}]*)\}/.exec(stylesSource)
    const body = rule?.[1] ?? ''
    expect(body, '缺少实边框 ⇒ 深色主题下与背景几乎同色（用户报障形态）')
      .toMatch(/border:\s*1px solid var\(--dsw-alias-border-l2/)
    expect(body, '缺少内描边 ⇒ 浅色主题下边框太淡').toMatch(/inset\s+0\s+0\s+0\s+1px/)
  })

  it('★★ 分区间距保持原样（用户要求 8/10，不做紧凑化）', () => {
    expect(
      stylesSource,
      '设置弹窗内不应再覆盖 .dim-jh-settingsSection 的间距（用户要求保留 8/10）',
    ).not.toMatch(/\.dim-jh-settingsModal\s+\.dim-jh-settingsSection/)
  })

  it('★ 滚动兜底仍在（768p 笔记本要能滚到底部「完成」）', () => {
    expect(stylesSource).toMatch(/\.dim-jh-modalBody\s*\{[^}]*overflow-y:\s*auto/)
  })
})