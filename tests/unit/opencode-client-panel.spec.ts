/**
 * Jet Hub 客户端的 opencode 面板断言（源码文本层）。
 *
 * ⚠️ 本仓库的客户端是**无构建期类型检查**的裸 React.createElement 调用
 * （见 `plugin-src/client/jet-hub.js`），所以「传错的 prop 名」「引用了
 * 不存在的变量」这类错误编译期发现不了 —— 只能靠这里的文本断言 +
 * `pnpm build:client` 的语法检查兜住。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { descriptorOf } from '../../src/provider-registry.js'
import { PROVIDER_ICONS } from '../../plugin-src/client/provider-icons.js'
import { stripComments } from '../helpers/strip-comments.js'

const here = dirname(fileURLToPath(import.meta.url))
const hub = readFileSync(join(here, '../../plugin-src/client/jet-hub.js'), 'utf8')
const modal = readFileSync(join(here, '../../plugin-src/client/opencode-proxy-modal.js'), 'utf8')
const product = readFileSync(join(here, '../../src/opencode-product.ts'), 'utf8')

describe('PROVIDERS 登记', () => {
  it('含 opencode 条目', () => {
    // ⚠️ 2026-10-08 改：`PROVIDERS` 由 `src/provider-registry.ts` 派生，
    // 故读 registry 的**行为断言**，不再扫 `jet-hub.js` 的源码文本。
    expect(descriptorOf('opencode')).toBeDefined()
    expect(descriptorOf('opencode')?.label).toBe('OpenCode')
  })
  it('⚠️ label 与 OPENCODE.displayName 逐字一致（rail 宽度算式依赖它）', () => {
    const name = product.match(/displayName:\s*'([^']+)'/)?.[1]
    expect(name).toBe('OpenCode')
    expect(descriptorOf('opencode')?.label).toBe(name)
  })
  it('⚠️ label 长度不触发 rail 换行（≤ 12 字符，参照 raccoon 的约束）', () => {
    const label = descriptorOf('opencode')?.label ?? ''
    expect(label.length).toBeLessThanOrEqual(12)
  })
  it('图标常量已定义且是合法 base64 data URL', () => {
    // ⚠️ 2026-10-08：图标已从 `jet-hub.js` 抽到纯数据模块 `provider-icons.js`，
    // 故直接读该模块的实际值（行为断言）。
    const uri = PROVIDER_ICONS.opencode ?? ''
    const m = /^data:image\/svg\+xml;base64,(.+)$/.exec(uri)
    expect(m, '应定义 OPENCODE_ICON').not.toBeNull()
    const svg = Buffer.from(m![1]!, 'base64').toString('utf8')
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('</svg>')
  })
})

describe('账号行按钮', () => {
  it('有「代理」与「指纹」两个按钮', () => {
    expect(hub).toMatch(/'代理'/)
    expect(hub).toMatch(/'指纹'/)
  })
  it('⚠️ 两者都用 props 存在性开关（不是 provider 硬判断）', () => {
    // 硬判断 `provider === 'opencode'` 散在按钮区会让 AccountCard 依赖
    // provider 列表；props 开关则由 ProviderPanel 单点注入。
    expect(hub).toMatch(/onOpenProxy\s*\n?\s*\?\s*React\.createElement/)
    expect(hub).toMatch(/onRotateFingerprint\s*\n?\s*\?\s*React\.createElement/)
  })
  it('⚠️ AccountCard 的 props 里声明了这两个回调', () => {
    const sig = hub.slice(hub.indexOf('function AccountCard('), hub.indexOf('function AccountCard(') + 900)
    expect(sig).toContain('onOpenProxy')
    expect(sig).toContain('onRotateFingerprint')
  })
  it('只有 opencode 面板注入这两个回调', () => {
    expect(hub).toMatch(/\.\.\.\(?provider === 'opencode'/)
  })
  it('代理按钮的 tooltip 说明「不设置会怎样」', () => {
    expect(hub).toMatch(/共享本机出口 IP/)
  })
})

describe('代理 modal', () => {
  it('从 jet-hub.js 引入', () => {
    expect(hub).toMatch(/from '\.\/opencode-proxy-modal\.js'/)
  })
  it('支持三类输入（本地端口 / HTTP(S) / SOCKS5）', () => {
    expect(modal).toMatch(/127\.0\.0\.1/)
    expect(modal).toMatch(/socks5/)
    expect(modal).toMatch(/http:\/\/user:pass@host:port/)
  })
  it('提供「测试连接」与「清除代理」', () => {
    expect(modal).toMatch(/测试连接/)
    expect(modal).toMatch(/清除代理/)
  })
  it('⚠️ 含认证信息时用 password 类型（不裸显代理口令）', () => {
    expect(modal).toMatch(/type: url\.includes\('@'\) \? 'password' : 'text'/)
  })
  it('⚠️ 校验在宿主侧（前端不自己实现 URL 规则）', () => {
    // 合法性判断在 src/opencode.ts 的 normalizeProxy；
    // 前端只做形态便利（补 scheme、端口预设），避免两套规则漂移。
    expect(modal).toMatch(/opencode\.testProxy/)
    expect(modal).toMatch(/opencode\.setProxy/)
  })
  it('⚠️ 解释「多账号 ≠ 多额度」（按出口 IP 限流）', () => {
    expect(modal).toMatch(/按出口 IP 限流/)
  })
  it('清除按钮只在已配置时出现', () => {
    expect(modal).toMatch(/current \? React\.createElement/)
  })
  it('⚠️ 内容在 modalBody 里（否则弹窗过高时被裁掉）', () => {
    expect(modal).toMatch(/className: 'dim-jh-modalBody'/)
  })
})

describe('面板文案', () => {
  it('⚠️ 面板提示说明匿名通道可添加多条（口径 2026-10-02）', () => {
    // 旧文案是「未设代理的账号与匿名通道共享本机出口 IP」—— 那描述的是
    // 早期「匿名槽进程内合成、不可配置」的实现。现在匿名通道是池内条目，
    // 可以配代理，文案必须同步（否则用户以为匿名通道不能配代理）。
    expect(hub).toMatch(/匿名通道无需 key，可添加多条、各自配代理/)
  })
  it('说明免费模型轮换、收费模型仅账号通道', () => {
    expect(hub).toMatch(/免费模型在所有通道间自动轮换，收费模型仅「API key 账号」可用/)
  })
  it('⚠️ opencode 的新建是粘贴 key，不是浏览器登录（空态与创建流程都要改）', () => {
    expect(hub).toMatch(/opencode\.addAccount/)
    // ⚠️ 文案两种前缀都要提（IKPLRU：2026-10-22 起新 key 是 `oc_sk_…`，
    // 旧号仍是 `sk-…`）；生成地址是控制台账号页，旧的 `/auth` 已 302 到登录页。
    expect(hub).toMatch(/opencode\.ai\/console\/account 生成（旧 key 形如 sk-…，新 key 形如 oc_sk_…）/)
  })
  it('⚠️ 添加 key 走自绘弹窗：password 输入 + Enter 提交 + 错误留在弹窗内', () => {
    // 输入框在 modal 文件里（纯展示层），提交逻辑在 jet-hub.js（宿主交互）。
    expect(modal).toMatch(/type: 'password'/)
    expect(modal).toMatch(/placeholder: 'sk-… \/ oc_sk_…'/)
    expect(modal).toMatch(/e\.key === 'Enter'/)
    expect(hub).toMatch(/const \[keyModal, setKeyModal\] = React\.useState/)
    expect(hub).toMatch(/keyInputRef/)
    expect(hub).toMatch(/React\.createElement\(OpencodeKeyModal, \{/)
    // ⚠️ 不得用 setPhase('error')：那会把整个账号列表换成错误态，
    // 用户刚填的 key 与错误信息一起消失，只能刷新重试。
    // 只看**函数体**（到下一个顶层定义为止），否则会命中别处的 setPhase。
    const at = hub.indexOf('const submitOpencodeKey = async')
    expect(at).toBeGreaterThan(-1)
    const body = hub.slice(at, hub.indexOf('const createAccount = async', at))
    /**
     * ⚠️ 形态在 2026-11-02 变过一次（二审 D🔴-1）：原来写 `setKeyModal({ error })`，
     * 那会造出**只有 error、没有 provider** 的对象 ⇒ 渲染侧对所有 provider 的排除
     * 条件都为真 ⇒ 挂上 OpenCode 弹窗，别的渠道（如百智云）失败时会在「添加 OpenCode
     * 账号」里重试，key 就被落进 opencode 池了。现在必须是「保留 prev 全部字段」。
     */
    expect(body, '错误仍然要留在弹窗内（不能 setPhase）').toMatch(/setKeyModal\(/)
    expect(body, '必须保留 prev 的 provider，否则弹窗会退化成 OpenCode').toMatch(/setKeyModal\(\(prev\)/)
    expect(body, '不能再出现「裸对象只带 error」的写法').not.toMatch(/setKeyModal\(\{ error:/)
    expect(body).not.toMatch(/setPhase\('error'\)/)
  })
  it('⚠️ API key 不进 React state（用 ref + DOM 读值）', () => {
    expect(hub).toMatch(/const keyInputRef = React\.useRef\(null\)/)
  })

  it('⚠️ 添加弹窗提供「匿名通道」选项（无需 key 也能加身份）', () => {
    expect(modal).toMatch(/opencode-add-mode/)
    expect(modal).toMatch(/label: '匿名通道'/)
    expect(hub).toMatch(/onSubmitAnonymous: \(\) => void submitAnonymous\(\)/)
    expect(hub).toMatch(/opencode\.addAnonymous/)
  })

  it('⚠️⚠️ 面板与弹窗都说明「匿名按出口 IP 限额、代理才增加额度」', () => {
    // 不说清楚的话，用户加 5 条匿名通道却只看到一份额度，会以为功能坏了。
    expect(modal).toMatch(/额度按「出口 IP」计算/)
    expect(hub).toMatch(/额度按「出口 IP」计算/)
  })

  it('⚠️ 文案是**纯文本渲染**，不得夹带 markdown 星号（会原样显示给用户）', () => {
    // 真实缺陷：这两处文案曾写成 `额度按**出口 IP** 计算`。面板用
    // React.createElement('p', …, '…') 渲染纯文本，星号**不会被解析成加粗**，
    // 用户看到的就是「额度按**出口 IP** 计算」。强调请用 <strong> 元素或「」引号。
    //
    // ⚠️ 断言必须带上后半句「计算」：这两个文件里还有**注释**写着
    // 「额度按**出口 IP** 计。」（源码注释里的 markdown 是正常的），
    // 只匹配到「计」会把注释误判成缺陷 —— 本用例第一版就是这么假红的。
    expect(modal).not.toMatch(/额度按\*\*出口 IP\*\* 计算/)
    expect(hub).not.toMatch(/额度按\*\*出口 IP\*\* 计算/)
  })

  it('账号卡片标注匿名通道（用户需要知道它不是登录账号）', () => {
    expect(hub).toMatch(/function isAnonymousAccountId/)
    expect(hub).toMatch(/'匿名'/)
  })
})

describe('弹窗必须是 React 组件（hooks 规则，真实事故 2026-10-02）', () => {
  it('⚠️⚠️ 三个弹窗都导出为**组件**（大写命名），不是 render* 普通函数', () => {
    // 含 useState 的函数若被直接调用，其 hook 会算进调用方组件 ⇒
    // React #310「Rendered more hooks than during the previous render」⇒ 整页白屏。
    expect(modal).toMatch(/export function OpencodeProxyModal\(/)
    expect(modal).toMatch(/export function OpencodeKeyModal\(/)
    // ⚠️ 2026-10-18（Gitee IKLTZ2）：Gemini 也有账号出口代理弹窗
    // （`GeminiProxyModal`）。**同样必须**是组件 —— 它内部也有 useState。
    expect(modal).toMatch(/export function GeminiProxyModal\(/)
    expect(modal).not.toMatch(/export function renderOpencode/)
  })

  it('⚠️ 调用点一律用 React.createElement（不得直接函数调用）', () => {
    expect(hub).toMatch(/React\.createElement\(OpencodeKeyModal, \{/)
    // ⚠️ 2026-10-18：代理弹窗改成按 provider 三元选择
    // （`proxyModal.provider === 'gemini' ? GeminiProxyModal : OpencodeProxyModal`），
    // 逐字串 `React.createElement(OpencodeProxyModal, {` 因此消失。
    // ⇒ 断言改为「**createElement 的第一个实参是选择器**，且各家弹窗都在其中」
    // —— 这比逐字串更强：它同时锁住「用了 createElement」与「没漏掉任一弹窗」。
    //
    // ⚠️ 2026-10-24（MiniMax 国际站账号代理）：选择器抽成了 `proxyModalComponent(provider)`
    // 辅助函数（第三家弹窗加入后，内联三元在两处出现会漂移）。断言同步为
    // 「createElement 的第一个实参是该函数」，「各家弹窗都被该函数覆盖」
    // 的判据移到下面的 `proxyModalComponent` 用例（逐家点名配对）。
    expect(hub).toMatch(
      /React\.createElement\(\s*proxyModalComponent\(proxyModal\.provider\),\s*\{/,
    )
    // 直接调用形态必须消失
    expect(hub).not.toMatch(/\?\s*renderOpencode/)
    expect(hub).not.toMatch(/\?\s*(?:Opencode|Gemini|MinimaxIntl|Qoder)(?:Proxy|Key)Modal\(\{/)
  })

  it('⚠️ proxyModalComponent 必须四家齐全，且**每个 provider 映射到正确的弹窗**', () => {
    /**
     * ⚠️⚠️ **必须判「配对」而不是「各自出现过」**（PR !145 审计修法）。
     *
     * 初版三条 `toContain` 只要求「`provider === 'gemini'` 与
     * `provider === 'minimaxintl'` 都出现在函数体里」+「有 `return OpencodeProxyModal`」——
     * **完全不判哪个分支返回哪个组件**。实测两个变异全绿：
     *
     * ① `if (provider === 'minimaxintl') return OpencodeProxyModal;`
     *    （= 本用例标题说的「渲染错弹窗」，minimaxintl 的「代理」按钮会打开
     *     opencode 的弹窗并保存到 `opencode.setProxy` 端点）；
     * ② gemini 与 minimaxintl 的返回值互换（两家互相串端点）。
     *
     * ⇒ 改成**逐分支配对断言**：把每个 `if (provider === 'X') return Y;` 抽出来，
     * 判 `X → Y` 的映射，而不是判「两个字符串都在」。
     *
     * ⚠️ 2026-10-25（本 fork 的 Qoder 代理合入）：分支从 2 条变 4 条 ——
     * `qoder` 与 `qodercn` **各占一条 `if`**（都返回 `QoderProxyModal`）。
     * 两站分开写在 `proxyModalComponent` 里是刻意的：合并成 `||` 后，
     * 本用例的正则只能匹配到前一站，第二站从此**不设防**（把 `qodercn`
     * 那个分支改成返回别家，用例仍绿）—— 那正是上面 ② 号变异的老毛病。
     */
    // ⚠️ 先剥注释再匹配：本轮新增的注释里就含有 `return OpencodeProxyModal`
    //    这个字面量（六审 B 实测：原断言命中偏移 327、状态机判 inComment=true），
    //    不剥注释 = 把真正的 opencode 分支删掉也照样绿。
    const selector = stripComments(hub).match(/function proxyModalComponent\([\s\S]*?\n\}/)?.[0]
    expect(selector, '找不到 proxyModalComponent 函数体').toBeDefined()
    // 逐分支抽取 `provider === 'X'` → `return Y` 的配对。
    const pairs = [...selector!.matchAll(
      /provider === '([a-z]+)'\)\s*return\s+(\w+);/g,
    )].map((m) => [m[1]!, m[2]!] as const)
    expect(pairs.length, 'proxyModalComponent 的分支数不是 4 —— 判据会退化成同义反复')
      .toBe(4)
    // ⚠️ 映射必须**逐格正确**：错一格就是「该家按钮打开别家弹窗、保存到别家端点」。
    expect(pairs, 'provider → 弹窗 的映射错了（串端点）').toEqual([
      ['gemini', 'GeminiProxyModal'],
      ['minimaxintl', 'MinimaxIntlProxyModal'],
      ['qoder', 'QoderProxyModal'],
      ['qodercn', 'QoderProxyModal'],
    ])
    // 缺省必须是**封闭白名单**：只认 opencode，其余一律 `null`。
    //
    // ⚠️⚠️ 原来是 `expect(selector!).toContain('return OpencodeProxyModal')` ——
    //    而该字面量只存在于函数上方的**注释**里（六审 B 探针：偏移 327、
    //    判 inComment=true）⇒ 两个变异全绿：① 改成 `? GeminiProxyModal : null`；
    //    ② 整条三元删成 `return null;`。同变异下
    //    `credits-usage-and-redirect-guards.spec.ts` 的正向断言会变红，
    //    说明只有这条没牙。⇒ 改成**解构三元**（正向）+ 禁止 fail-open 兜底（反向）。
    expect(selector, '缺省分支必须显式点名 opencode（白名单，不是 fail-open）').toMatch(
      /return provider === 'opencode' \? OpencodeProxyModal : null;/,
    )
    expect(selector, '不许再出现「其余一律回落 opencode」的 fail-open 写法').not.toMatch(
      /\n\s{2}return OpencodeProxyModal;/,
    )
  })

  it('⚠️ Gemini 弹窗的宿主 facade 也由 props 传入（不得退回位置参数）', () => {
    expect(modal).toMatch(/export function GeminiProxyModal\(\{ ctx,/)
  })

  it('⚠️ 弹窗的宿主 facade 由 props 传入（不再是位置参数）', () => {
    // 组件只能收一个 props 对象；位置参数 `fn(ctx, props)` 是「普通函数」写法，
    // 正是导致本次事故的形态。
    expect(modal).toMatch(/export function OpencodeProxyModal\(\{ ctx,/)
  })

  it('基准：仓库既有弹窗都用 createElement（锁住「一致性」这条约定）', () => {
    for (const name of ['ModelListPanel', 'BackupPanel', 'ClineQuotaPanel']) {
      expect(hub, `${name} 应以 createElement 渲染`).toMatch(new RegExp(`React\\.createElement\\(${name},`))
    }
  })
})

describe('指纹轮换', () => {
  it('调 opencode.rotateFingerprint 并刷新列表', () => {
    expect(hub).toMatch(/opencode\.rotateFingerprint/)
  })
  it('⚠️ 有二次确认（它是预防性操作，不是修复按钮）', () => {
    const at = hub.indexOf('const rotateFingerprint = async')
    const body = hub.slice(at, at + 600)
    expect(body).toMatch(/confirm\(/)
  })
})
