import { describe, expect, it } from 'vitest'
import { toGenerateOptions } from '../../src/openai-gateway/messages.js'
import { toResponsesGenerateOptions } from '../../src/openai-gateway/responses.js'
import {
  isTencentContentFingerprintProvider,
  rewriteTencentContentFingerprints,
} from '../../src/openai-gateway/tencent-fingerprint.js'

/**
 * 腾讯系内容级风控指纹改写 —— Gitee issue IKJNA1。
 *
 * ## 现象（用户报障，2026-10-04）
 *
 * ZCode 经本插件的 OpenAI 网关调 `workbuddy/deepseek-v4.1-flash` 稳定失败，
 * 客户端横幅只显示 `provider_code=INVALID_REQUEST reason=unknown`，
 * 网关侧原始报错是：
 * ```
 * workbuddy: 请求被安全策略拦截… Illegal API invocation from an unapproved channel
 * ```
 * 而 DSH 直连同一模型完全正常。
 *
 * ## 根因（本机 2026-10-05 对 `www.workbuddy.ai` + `copilot.tencent.com` 双端点实测）
 *
 * 腾讯网关按**请求内容指纹**拦截，与账号、凭据、请求头、tools 全无关。
 * 最小充分触发串是 ZCode 内建的 gitStatus 模板句常量
 * （`$Js="Main branch (you will usually use this for PRs)"`）。
 *
 * 逐组实测（`max_tokens=16`，被拦不耗额度）给出的**判据**，全部锁进下面的用例：
 *
 * | 探针 | 结果 | 结论 |
 * |---|---|---|
 * | 中性 system | ✅ 200 | 基线 |
 * | `Main branch (you will usually use this for PRs): master` | ❌ 400/11128 | 最小充分触发 |
 * | `Main branch: master` | ✅ 200 | 不是泛关键词 |
 * | 换分支名（`dev`） | ❌ 400 | 分支值无关 |
 * | 只差一个词（`normally`） | ✅ 200 | **逐字符**匹配，不能泛化 |
 * | 内层多一个空格 | ✅ 200 | 同上 |
 * | 全小写 / 全大写 | ❌ 400 | **大小写不敏感** |
 * | 同一句在 **user** 消息 | ✅ 200 | 该角色不拦 |
 * | 同一句在 **tool** 消息 | ✅ 200 | 同上 |
 * | 指纹在**第二条** system（非 `messages[0]`） | ❌ 400 | 所有 system 都要改 |
 * | 改写该句 | ✅ 200 | 修法有效 |
 * | ★ 同一句在 **assistant 正文** | ❌ **400** | **assistant 也要改**（下注） |
 * | ★ 同一句只在 `reasoning_content` | ✅ 200 | 该字段不扫 |
 * | ★ 同一句只在 `tool_calls[].arguments` | ✅ 200 | 该字段不扫 |
 * | ★ 与文档同字节数的良性长文本 | ✅ 200 | **体量不是原因** |
 *
 * ★ 那四行是 2026-10-12 补测的，**可复核凭据已入库**：
 * `tests/e2e/buddy-fingerprint-roles.e2e.spec.ts`（双闸门、默认 skip）。
 * ⚠️ 那个文件不是可选的补充 —— 「assistant 正文 ❌拦、其余四格 ✅放行」已被写进
 * `tencent-fingerprint.ts` 的**实现约束**（决定改写范围），而单测只能锁「代码按
 * 那个范围做」，**锁不住那个范围本身对不对**。当初翻车正是在这里：
 * **初版只测了 system / user / tool 三个位置**，
 * 于是把「只拦 system」写成了硬约束，而 `assistant` 那一格从未测过 ——
 * 当时那条 assistant 探针还把触发句改写成了转述形态（`I see … here.`），
 * 而服务端是**逐字符**匹配，那个形态本身不含触发串，**等于空跑**。
 * 真实报障是「排查这个风控 bug 的会话」把那句复述进了 assistant 正文，
 * 于是该会话从此每轮被拦、且**换任何腾讯系模型都一样**（跟会话走，不跟模型走）。
 *
 * ⚠️ 因此这套改写有**两类**调用方，缺一即复发：
 * `src/openai-gateway/{messages,responses}.ts`（外部客户端方向）与
 * `src/buddy-adapter.ts` 的 `serializeMessages` + `options.system`（DSH 直连方向）。
 */
const TRIGGER = 'Main branch (you will usually use this for PRs)'
const REWRITE = 'Main branch (PRs usually go here)'

/**
 * 第二条指纹：**Claude Code 的身份句**（Gitee issue IKLS2L，2026-10-14 本机实测）。
 *
 * ⚠️ 本文件里留了这句字面量（与 ZCode 那条一样）——它已不再有自指污染风险：
 * 改写覆盖 `system` 与 `assistant` 正文两处（见下面「assistant 正文要改」用例），
 * 而这正是 2026-10-12 那次「排查风控的会话把自己拦死」的修法。
 */
const CLAUDE_TRIGGER = "You are Claude Code, Anthropic's official CLI for Claude"
const CLAUDE_REWRITE = "You are Claude Code, Anthropic's CLI for Claude"
/**
 * Claude Code v2.1.295 里的另外两个内建常量（issue 从二进制读出；本机实发复核过）。
 *
 * - `sf` = 身份句 + `, running within the Claude Agent SDK.` ⇒ **也被拦**，
 *   且因为 `find` 不带尾句点，这一条**顺带把它也覆盖了**（下面有用例钉住）。
 * - `af` = `You are a Claude agent, built on Anthropic's Claude Agent SDK.`
 *   ⇒ 实测**放行**，故**刻意不登记**（下面有用例钉住「不许顺手多登记一行」）。
 */
const CLAUDE_SDK_VARIANT = `${CLAUDE_TRIGGER}, running within the Claude Agent SDK.`
const CLAUDE_AGENT_VARIANT = "You are a Claude agent, built on Anthropic's Claude Agent SDK."

/** ZCode 真实的 gitStatus 注入块形态（issue 报障现场）。 */
const ZCODE_GITSTATUS = [
  '<git_status>',
  'On branch master',
  `${TRIGGER}: master`,
  "Your branch is up to date with 'origin/master'.",
  '',
  'Changes not staged for commit:',
  '  modified: src/index.ts',
  '</git_status>',
].join('\n')

function abort(): AbortSignal {
  return new AbortController().signal
}

/**
 * 取出 DSH 消息里全部文本（含 `tool-result` 内层）的纯文本。
 *
 * 工具结果被包成 `{type:'tool-result', content:[…]}`，只扫顶层会漏掉它 ——
 * 而「tool 消息不得被改写」正是要断言的那一条。
 */
function textsOf(messages: ReadonlyArray<{ content: unknown }>): string[] {
  const out: string[] = []
  const walk = (blocks: unknown): void => {
    if (!Array.isArray(blocks)) return
    for (const block of blocks) {
      if (typeof block !== 'object' || block === null) continue
      const typed = block as { type?: unknown; text?: unknown; content?: unknown }
      if (typed.type === 'text' && typeof typed.text === 'string') out.push(typed.text)
      if (typed.type === 'tool-result') walk(typed.content)
    }
  }
  for (const message of messages) walk(message.content)
  return out
}

describe('腾讯系内容级风控指纹改写（IKJNA1）：纯函数', () => {
  it('★ 只对腾讯系两个 provider 生效', () => {
    // qoder / trae / codearts 等后端没有这个过滤器；误伤它们等于替别的上游
    // 改写用户原话，而收益为零。
    expect(isTencentContentFingerprintProvider('buddy')).toBe(true)
    expect(isTencentContentFingerprintProvider('workbuddy')).toBe(true)
    for (const other of ['qoder', 'qodercn', 'trae', 'codearts', 'lobsterai', 'zcode', 'BUDDY', '']) {
      expect(isTencentContentFingerprintProvider(other)).toBe(false)
    }
  })

  it('★ 腾讯系：system 里的模板句被改写，语义保持等价', () => {
    expect(rewriteTencentContentFingerprints(`${TRIGGER}: master`, 'workbuddy'))
      .toBe(`${REWRITE}: master`)
    // CodeBuddy 中国版同一套（实测两端点表现一致）
    expect(rewriteTencentContentFingerprints(`${TRIGGER}: dev`, 'buddy'))
      .toBe(`${REWRITE}: dev`)
  })

  it('★ 非腾讯系：逐字节不变', () => {
    for (const provider of ['qoder', 'trae', 'codearts', 'lobsterai']) {
      expect(rewriteTencentContentFingerprints(ZCODE_GITSTATUS, provider)).toBe(ZCODE_GITSTATUS)
    }
  })

  it('★ 腾讯系但不含指纹：逐字节不变（不能破坏上游的前缀缓存）', () => {
    // 判据是**内容**：没有指纹就必须原样返回。若这里返回一份「等价但新」的字符串，
    // 腾讯侧按前缀缓存就会每一轮都算新前缀。
    const neutral = 'You are a helpful assistant.\n\nWorking directory: D:\\repo\nBe concise.'
    expect(rewriteTencentContentFingerprints(neutral, 'workbuddy')).toBe(neutral)
    // 只留标签、没有模板句 —— 实测放行，**不能**多改
    const label = 'Main branch: master'
    expect(rewriteTencentContentFingerprints(label, 'workbuddy')).toBe(label)
    expect(rewriteTencentContentFingerprints(label, 'buddy')).toBe(label)
  })

  it('★ 大小写不敏感：全小写与全大写同样被拦，因此同样要改', () => {
    // 实测：全小写 / 全大写都回 400/11128。若只做大小写敏感的 replaceAll，
    // 一个把模板句改成小写的客户端就会**继续**被拦。
    expect(rewriteTencentContentFingerprints(`main branch (you will usually use this for PRs)`, 'workbuddy'))
      .toBe(REWRITE)
    expect(rewriteTencentContentFingerprints(`MAIN BRANCH (YOU WILL USUALLY USE THIS FOR PRS)`, 'workbuddy'))
      .toBe(REWRITE)
    expect(rewriteTencentContentFingerprints(`Main Branch (You Will Usually Use This For PRs)`, 'workbuddy'))
      .toBe(REWRITE)
  })

  it('★ 绝不泛化：只差一个词 / 多一个空格都**不动**（服务端认的是逐字符字面量）', () => {
    // 这两条是「不要图省事改成正则 / 关键词黑名单」的判据：服务端放行它们，
    // 我们若也改，就是替上游改写了用户的正常提示词。
    const oneWordOff = 'Main branch (you will normally use this for PRs)'
    const extraSpace = 'Main branch  (you will usually use this for PRs)'
    const noParens = 'Main branch: you will usually use this for PRs'
    for (const text of [oneWordOff, extraSpace, noParens]) {
      expect(rewriteTencentContentFingerprints(text, 'workbuddy')).toBe(text)
    }
  })

  it('★ 一次出现多处时全部改写（客户端可能把同一模板注入多行）', () => {
    const twice = `${TRIGGER}: master\n${TRIGGER}: master`
    expect(rewriteTencentContentFingerprints(twice, 'workbuddy'))
      .toBe(`${REWRITE}: master\n${REWRITE}: master`)
  })

  it('★ 真实 git_status 块：只改那一句，其余行逐字节不变', () => {
    const out = rewriteTencentContentFingerprints(ZCODE_GITSTATUS, 'workbuddy')
    expect(out).not.toContain(TRIGGER)
    expect(out).toContain(`${REWRITE}: master`)
    expect(out).toContain('<git_status>')
    expect(out).toContain("Your branch is up to date with 'origin/master'.")
    expect(out).toContain('  modified: src/index.ts')
    expect(out.split('\n')).toHaveLength(ZCODE_GITSTATUS.split('\n').length)
  })

  it('多条规则之间不互相污染（预检不会把 lastIndex 带进下一条）', () => {
    // `g` 正则的 lastIndex 若被带过去，第二条规则会漏改开头那段 —— 这里用
    // 「同一条规则连续调用」+「先长后短」两种顺序都验一遍。
    const text = `${TRIGGER}\n${TRIGGER}`
    expect(rewriteTencentContentFingerprints(text, 'workbuddy')).toBe(`${REWRITE}\n${REWRITE}`)
    // 第一次调用后再调一次，结果必须与第一次一致（无状态残留）。
    expect(rewriteTencentContentFingerprints(text, 'workbuddy'))
      .toBe(rewriteTencentContentFingerprints(text, 'workbuddy'))
  })

  it('空串与纯空白不受影响', () => {
    expect(rewriteTencentContentFingerprints('', 'workbuddy')).toBe('')
    expect(rewriteTencentContentFingerprints('   \n\t ', 'workbuddy')).toBe('   \n\t ')
  })
})

/**
 * 第二条指纹：Claude Code 身份句（Gitee issue IKLS2L）。
 *
 * ## 上游事实（2026-10-14 本机对 `www.workbuddy.ai` + `copilot.tencent.com` 双端点实发）
 *
 * Claude Desktop 的「Code」页（内置 Claude Code v2.1.295）经 cc-switch →
 * 本机网关调腾讯系时，**`mrt()` 的 `[model-check]` 探测路径漏传
 * `skipSystemPromptPrefix`** ⇒ 每次都把身份句注入 system ⇒ 每次都 400/11128。
 * 实测窗口 277 次尝试 / 94 次失败（约 34%），日志累计 187 次。
 *
 * | 探针（`max_tokens=16` / 非流式会被 11101 先拒，故必须 `stream:true`） | workbuddy | buddy |
 * |---|---|---|
 * | 中性 system | ✅ 200 | ✅ 200 |
 * | `You are Claude Code, Anthropic's official CLI for Claude` | ❌ 400/11128 | ❌ 400/11128 |
 * | 同句 + 尾句点 / + SDK 后缀 | ❌ 400/11128 | ❌ 400/11128 |
 * | 少一个字母（`…for Claud`） | ✅ 200 | ✅ 200 |
 * | **多**一个字母（`…for ClaudeX`） | ❌ 400/11128 | ❌ 400/11128 |
 * | 拆成前半句 / 后半句**单独**发 | ✅ 200 | ✅ 200 |
 * | **assistant 正文**放同一句 | ❌ 400/11128 | ❌ 400/11128 |
 * | 同一句放 `user` | ✅ 200 | ✅ 200 |
 * | **候选替换串**（`…Anthropic's CLI for Claude.`） | ✅ 200 | ✅ 200 |
 *
 * ## ⚠️⚠️ 锚点与 ZCode 那条**相反**：该指纹**行首锚定**，不是位置无关
 *
 * 这是本轮实测**推翻** issue 描述的一格（issue 按 IKJNA1 同构写成了「子串精确匹配」）：
 *
 * | 形态 | 结果 |
 * |---|---|
 * | 裸串（在绝对开头） | ❌ 400/11128 |
 * | **前接空格 / 前换行 / 前接任意前言 / 双换行包裹** | ✅ **200 放行** |
 * | 后接句点 / 破折号 / 中文句号 / 一长段正文 | ❌ 400/11128 |
 *
 * ⇒ 语义是「**前导字符一个都不容忍、后缀完全自由**」。
 *
 * ⚠️ 这条对**将来加新指纹的人**是硬提醒：拿「夹在句中放行」当判据会得到**假阴性**
 * （真因是锚点，不是这句不再触发），据此删掉一条仍然必需的登记就重新打开这个 bug。
 * 下面 `find` 的正则**刻意不做行首锚定** —— 改写宁可略宽（漏改 = 整轮 400，
 * 多改 = 语义等价的措辞变化）。
 */
describe('腾讯系内容级风控指纹改写（IKLS2L）：Claude Code 身份句', () => {
  it('★ 身份句被改写为等义形态（实测替换后两端点均 200）', () => {
    expect(rewriteTencentContentFingerprints(CLAUDE_TRIGGER, 'workbuddy')).toBe(CLAUDE_REWRITE)
    expect(rewriteTencentContentFingerprints(`${CLAUDE_TRIGGER}.`, 'buddy')).toBe(`${CLAUDE_REWRITE}.`)
  })

  it('★ `find` 不带尾句点 ⇒ 同一行**顺带覆盖** SDK 变体（少一个尾句点是有意的）', () => {
    // 若有人「补全」成带尾句点，这条就会红 —— 那个变更会让 SDK 变体漏改写，
    // 而它是 Claude Code 三个常量之一（`Qno` 会按条件选它注入）。
    expect(rewriteTencentContentFingerprints(CLAUDE_SDK_VARIANT, 'workbuddy'))
      .toBe(`${CLAUDE_REWRITE}, running within the Claude Agent SDK.`)
    // 反向：改写后的文本**不得**再含原触发串（否则等于没改）。
    expect(rewriteTencentContentFingerprints(CLAUDE_SDK_VARIANT, 'buddy')).not.toContain(CLAUDE_TRIGGER)
  })

  it('★ 第三个常量（`Claude agent`）实测放行 ⇒ **刻意不登记**，逐字节不变', () => {
    // 「表就是为此设计的」不等于「能加的都加上」：多登记一条 = 替上游无谓改写
    // 用户提示词，且会破坏前缀缓存。判据是**实测**（该串两端点均 200）。
    for (const provider of ['buddy', 'workbuddy']) {
      expect(rewriteTencentContentFingerprints(CLAUDE_AGENT_VARIANT, provider)).toBe(CLAUDE_AGENT_VARIANT)
    }
  })

  it('★ 非腾讯系：身份句逐字节不变（别替别家上游改写用户提示词）', () => {
    for (const provider of ['qoder', 'qodercn', 'trae', 'codearts', 'lobsterai', '']) {
      expect(rewriteTencentContentFingerprints(CLAUDE_TRIGGER, provider)).toBe(CLAUDE_TRIGGER)
    }
  })

  it('★ 大小写不敏感（实测全大写同样被拦），且不泛化成关键词', () => {
    // ⚠️ 替换串**固定**为 `replace` 的字面量形态（大小写不保留）—— 与 ZCode 那条
    // 同一行为（`main branch (…)` → `Main branch (PRs usually go here)`）。
    // 若将来改成保留大小写，这条与上面 ZCode 那条会同时红，是**有意的**：
    // 替换串是**我们**的等义措辞，不是用户原文的变形。
    expect(rewriteTencentContentFingerprints(CLAUDE_TRIGGER.toUpperCase(), 'workbuddy'))
      .toBe(CLAUDE_REWRITE)
    // 拆开的两半单独发实测放行 ⇒ 它们**不**单独触发，不能各自登记一条。
    // （`find` 是整串，故这两半本来就命中不了；这里钉的是「别改成关键词表」。）
    for (const half of ['You are Claude Code', "Anthropic's official CLI for Claude"]) {
      expect(rewriteTencentContentFingerprints(half, 'workbuddy')).toBe(half)
    }
  })

  it('★ 真实 Claude Code system 提示词：只改身份句那一行，其余段落逐字节不变', () => {
    // 现场形状：身份句是最前一行，后面跟真正的行为约定（这些**不能**被碰）。
    const realSystem = [
      `${CLAUDE_TRIGGER}.`,
      '',
      'You are an interactive CLI tool that helps users with software engineering tasks.',
      '',
      '# Tone and style',
      '- Be concise and direct.',
    ].join('\n')
    const out = rewriteTencentContentFingerprints(realSystem, 'workbuddy')
    expect(out).not.toContain(CLAUDE_TRIGGER)
    expect(out).toContain(`${CLAUDE_REWRITE}.`)
    expect(out).toContain('You are an interactive CLI tool that helps users with software engineering tasks.')
    expect(out).toContain('# Tone and style')
    expect(out).toContain('- Be concise and direct.')
    expect(out.split('\n')).toHaveLength(realSystem.split('\n').length)
  })

  it('★ 两条指纹互不干扰（Claude 条不影响 ZCode 条，反之亦然）', () => {
    expect(rewriteTencentContentFingerprints(`${TRIGGER}: master`, 'workbuddy'))
      .toBe(`${REWRITE}: master`)
    expect(rewriteTencentContentFingerprints(`${TRIGGER}: master\n${CLAUDE_TRIGGER}`, 'workbuddy'))
      .toBe(`${REWRITE}: master\n${CLAUDE_REWRITE}`)
    // 连续两次调用结果一致（`g` 正则的 lastIndex 不留状态）。
    const mixed = `${CLAUDE_TRIGGER}\n${TRIGGER}`
    expect(rewriteTencentContentFingerprints(mixed, 'workbuddy'))
      .toBe(rewriteTencentContentFingerprints(mixed, 'workbuddy'))
  })
})

/**
 * 第三条指纹：Claude Code system prompt 的**反馈句**（Gitee issue IKLYCT，2026-10-18 本机实测）。
 *
 * ## 为什么它比身份句（第二条）更严重
 *
 * 身份句只有 cc-switch 的 `mrt()` 探测路径漏传前缀时才注入（实测约 34% 的窗口）；
 * 而本句属于 Claude Code system prompt 的**固定段落** —— 客户端把默认 system 整份
 * 过来就**必然**带上 ⇒ **漏登记 = 必然命中**。用户侧实测单日白撞 647 次。
 *
 * ## ⚠️ 本条的锚点语义与身份句**相反**：它**位置无关**
 *
 * 前接 `Note: ` / 前接行首 `  - ` 都仍被拦 —— 与 ZCode 那条同型，与身份句（行首锚定）相反。
 * 「锚点结论不可跨条推用」那条纪律在这里又得到一次印证。
 *
 * ## ⚠️ `find` 必须写**整句**：砍掉前半或砍掉后半都放行
 *
 * 这一格决定 `find` 的长度。照抄别条的 find 长度（更短/更长）都会漏改写，
 * 而漏改写的症状是「登记了却仍每轮 400」，极难归因。
 */
const FEEDBACK_TRIGGER = 'To give feedback, users should report the issue at '
  + 'https://github.com/anthropics/claude-code/issues'
const FEEDBACK_REWRITE = 'To give feedback, users should report the issue at the project issue tracker'

/**
 * 第四条指纹：**DSH 宿主自己的 harness 身份句**（2026-10-20 晚腾讯网关新登记）。
 *
 * `dsh-system-prompt` 的 `harness:identity` 段（`includeHarnessIdentity` 默认开启）
 * ⇒ **每个 DSH 直连会话 system 的首句**：
 * `You are an AI agent powered by DeepSeek Harness.`
 *
 * ⚠️ 与前三条的**本质区别**：前三条都来自外部客户端注入（ZCode / Claude Code），
 * DSH 直连不含它们；本条是 DSH 自己的 system 首句 ⇒ 上游一旦登记，
 * **所有 DSH 直连 buddy/workbuddy 请求首轮即拒**，换号/换模型/重登全无效。
 * 真实报障现场：同一会话 23:10 成功、23:25 起全拒（15 分钟内网关侧生效），
 * 换新账号 + 干净会话（无历史）首轮仍被拒 ⇒ 内容级、非账号级。
 *
 * 锚点语义：**行首锚定**（与 Claude 身份句同型，与反馈句相反）——
 * 前接空格/换行/前言均放行，裸句与后接正文均拦。逐格实测见
 * `docs/agent-notes/providers-buddy.md` 的「DSH harness 身份句」一节。
 */
const DSH_TRIGGER = 'You are an AI agent powered by DeepSeek Harness'
const DSH_REWRITE = 'You are an AI agent running inside DeepSeek Harness'

describe('腾讯系内容级风控指纹改写（IKLYCT）：Claude Code 反馈句', () => {
  it('★ 整句被改写为等义形态（实测两端点均 200）', () => {
    expect(rewriteTencentContentFingerprints(FEEDBACK_TRIGGER, 'workbuddy')).toBe(FEEDBACK_REWRITE)
    // CodeBuddy 中国版同一套（实测两端点表现一致）
    expect(rewriteTencentContentFingerprints(FEEDBACK_TRIGGER, 'buddy')).toBe(FEEDBACK_REWRITE)
  })

  it('★ 位置无关：前接前言 / 前接行首装饰**仍要改**（锚点与身份句相反）', () => {
    // 实测这三格都 400/11128。若照身份句那条「只在文本开头触发」的结论，
    // 就会在这里留下漏改写 ⇒ 整轮 400。
    for (const text of [`Note: ${FEEDBACK_TRIGGER}`, `  - ${FEEDBACK_TRIGGER}`, `${FEEDBACK_TRIGGER}\n后接文本`]) {
      expect(rewriteTencentContentFingerprints(text, 'workbuddy'))
        .not.toContain(FEEDBACK_TRIGGER)
      expect(rewriteTencentContentFingerprints(text, 'workbuddy')).toContain(FEEDBACK_REWRITE)
    }
  })

  it('★ `find` 必须写整句：砍掉前半 / 砍掉后一半**实测放行** ⇒ 不触发，故只登记整句', () => {
    // 这一格是 `find` 长度的判据。若有人「顺手缩短」或「拆成两条」，
    // 这里会红 —— 因为缩短/拆分之后，这些子串本来就不触发，改写它们是多余的。
    const halves = [
      'users should report the issue at https://github.com/anthropics/claude-code/issues',
      'To give feedback, users should report the issue',
    ]
    for (const half of halves) {
      expect(rewriteTencentContentFingerprints(half, 'workbuddy')).toBe(half)
      expect(rewriteTencentContentFingerprints(half, 'buddy')).toBe(half)
    }
    // 反向：整句必须真的被改掉（否则上面的「不动」就是空跑）
    expect(rewriteTencentContentFingerprints(FEEDBACK_TRIGGER, 'workbuddy'))
      .not.toContain('github.com/anthropics/claude-code/issues')
  })

  it('★ 逐字符：换域名 / 换 org / 改一个词**不动**（实测放行，别泛化）', () => {
    // 照抄 ZCode 那条「分支值无关」的思路去泛化这条是错的：实测换域名即放行。
    // 多改 = 替上游无谓改写用户提示词，并破坏前缀缓存。
    const cases = [
      FEEDBACK_TRIGGER.replace('anthropics/claude-code', 'other/repo'),
      FEEDBACK_TRIGGER.replace('anthropics/claude-code', 'example/project'),
      FEEDBACK_TRIGGER.replace('report the issue', 'file the issue'),
      'https://github.com/anthropics/claude-code/issues',
    ]
    for (const text of cases) {
      expect(rewriteTencentContentFingerprints(text, 'workbuddy')).toBe(text)
      expect(rewriteTencentContentFingerprints(text, 'buddy')).toBe(text)
    }
  })

  it('★ 一次出现多处时全部改写（客户端可能把同一句注入多段）', () => {
    const twice = `${FEEDBACK_TRIGGER}\n${FEEDBACK_TRIGGER}`
    expect(rewriteTencentContentFingerprints(twice, 'workbuddy'))
      .toBe(`${FEEDBACK_REWRITE}\n${FEEDBACK_REWRITE}`)
  })

  it('★ 大小写不敏感（实测全大写同样被拦）', () => {
    expect(rewriteTencentContentFingerprints(FEEDBACK_TRIGGER.toUpperCase(), 'workbuddy'))
      .toBe(FEEDBACK_REWRITE)
    expect(rewriteTencentContentFingerprints(FEEDBACK_TRIGGER.toLowerCase(), 'workbuddy'))
      .toBe(FEEDBACK_REWRITE)
  })

  it('★ 非腾讯系：逐字节不变（别替别家上游改写用户提示词）', () => {
    for (const provider of ['qoder', 'qodercn', 'trae', 'codearts', 'lobsterai', '']) {
      expect(rewriteTencentContentFingerprints(FEEDBACK_TRIGGER, provider)).toBe(FEEDBACK_TRIGGER)
    }
  })

  it('★ 三条指纹互不干扰（任一条的 find 变更都会在这里露出来）', () => {
    const all = `${TRIGGER}: master\n${CLAUDE_TRIGGER}\n${FEEDBACK_TRIGGER}`
    const out = rewriteTencentContentFingerprints(all, 'workbuddy')
    expect(out).toBe(`${REWRITE}: master\n${CLAUDE_REWRITE}\n${FEEDBACK_REWRITE}`)
    // 无状态残留：连续两次调用结果一致
    expect(rewriteTencentContentFingerprints(all, 'workbuddy')).toBe(out)
  })

  it('★ 四条指纹互不干扰（含 DSH 身份句；任一条的 find 变更都会在这里露出来）', () => {
    const all = `${TRIGGER}: master\n${CLAUDE_TRIGGER}\n${FEEDBACK_TRIGGER}\n${DSH_TRIGGER}`
    const out = rewriteTencentContentFingerprints(all, 'buddy')
    expect(out).toBe(`${REWRITE}: master\n${CLAUDE_REWRITE}\n${FEEDBACK_REWRITE}\n${DSH_REWRITE}`)
    expect(rewriteTencentContentFingerprints(all, 'buddy')).toBe(out)
  })

  it('★ 真实 Claude Code system：只改反馈句那一行，其余段落与行数逐字节不变', () => {
    // 现场形状（issue 的 19,056 字符 system 形态）：反馈句前带 `  - ` 列表装饰，
    // 后面跟着真正有用的帮助段落 —— 这些**不能**被碰。
    const realSystem = [
      '# Tone and style',
      '- Be concise and direct.',
      '',
      '# Help',
      '  - /help: show help',
      `  - ${FEEDBACK_TRIGGER}`,
      '',
      '# Executing actions with care',
      'Do not take destructive actions without confirmation.',
    ].join('\n')
    const out = rewriteTencentContentFingerprints(realSystem, 'workbuddy')
    expect(out).not.toContain(FEEDBACK_TRIGGER)
    expect(out).toContain(`  - ${FEEDBACK_REWRITE}`)
    expect(out).toContain('# Executing actions with care')
    expect(out).toContain('- /help: show help')
    expect(out.split('\n')).toHaveLength(realSystem.split('\n').length)
  })
})

describe('腾讯系内容级风控指纹改写（2026-10-20 报障）：DSH harness 身份句', () => {
  it('★ 整句被改写为等义形态（实测 copilot.tencent.com 200）', () => {
    expect(rewriteTencentContentFingerprints(DSH_TRIGGER, 'buddy')).toBe(DSH_REWRITE)
    expect(rewriteTencentContentFingerprints(`${DSH_TRIGGER}.`, 'buddy')).toBe(`${DSH_REWRITE}.`)
    // workbuddy 国际端点当时未同步该条，但按两端点同表先例同样改写
    expect(rewriteTencentContentFingerprints(DSH_TRIGGER, 'workbuddy')).toBe(DSH_REWRITE)
  })

  it('★ 真实报障形态：DSH 直连 system 首句命中即改，其余段落与行数逐字节不变', () => {
    // 现场形状：身份句是 15,305 字符 system 的第 0 行，其后是 preset 正文。
    const realSystem = [
      `${DSH_TRIGGER}.`,
      '',
      'You are a coding agent powered by the deepseek-v4.1-flash model.',
      '',
      'Agent Teams is available in this session',
      'The Team Lead and all teammates share the same working directory.',
    ].join('\n')
    const out = rewriteTencentContentFingerprints(realSystem, 'buddy')
    expect(out.split('\n')[0]).toBe(`${DSH_REWRITE}.`)
    expect(out.split('\n')).toHaveLength(realSystem.split('\n').length)
    expect(out).toContain('You are a coding agent powered by the deepseek-v4.1-flash model.')
  })

  it('★ 行首锚定（上游事实）：改写刻意不做行首锚定 —— 前接前言的形态**同样要改**', () => {
    // 上游只在「文本绝对开头」拦（前接空格/换行/前言实测放行，锚点与 Claude
    // 身份句同型、与反馈句相反）。但实现**刻意不照锚点收窄**：漏改一处 =
    // 整轮 400，多改 = 语义等价的措辞变化 —— 与 Claude 身份句同一条实现路径。
    // ⚠️ 若有人把本条改成行首锚定正则（`^` + `m`），这里会红 —— 那个「优化」
    // 恰好是漏改的来源。
    const cases = [
      ` ${DSH_TRIGGER}`,
      `\n${DSH_TRIGGER}`,
      `Note the following. ${DSH_TRIGGER}`,
      `Intro sentence.\nSecond line.\n${DSH_TRIGGER}\nTrailing line.`,
    ]
    for (const text of cases) {
      expect(rewriteTencentContentFingerprints(text, 'buddy')).not.toContain(DSH_TRIGGER)
    }
    // 反向钉住：非行首的改写形态本身不再含触发串
    expect(rewriteTencentContentFingerprints(`前言。${DSH_TRIGGER}`, 'buddy'))
      .toBe(`前言。${DSH_REWRITE}`)
  })

  it('★ 逐字符：砍掉任一词 / 换厂商名**实测放行** ⇒ 不改写（find 必须整句）', () => {
    // 砍掉任一词都放行 ⇒ find 写整句是判据；照抄别条的 find 长度是错的。
    const cases = [
      'AI agent powered by DeepSeek Harness',
      'You are an AI agent powered by',
      'You are an AI agent powered by DeepSeek',
      'You are powered by DeepSeek Harness',
      'You are an AI agent',
      'You are an AI agent powered by AcmeCorp Harness',
      'You are an AI assistant powered by ExampleCorp Harness',
      'You are a coding agent powered by the deepseek-v4.1-flash model.',
    ]
    for (const text of cases) {
      expect(rewriteTencentContentFingerprints(text, 'buddy')).toBe(text)
      expect(rewriteTencentContentFingerprints(text, 'workbuddy')).toBe(text)
    }
  })

  it('★ 大小写不敏感（实测全大写同样被拦）', () => {
    expect(rewriteTencentContentFingerprints(DSH_TRIGGER.toUpperCase(), 'buddy'))
      .toBe(DSH_REWRITE)
    expect(rewriteTencentContentFingerprints(DSH_TRIGGER.toLowerCase(), 'buddy'))
      .toBe(DSH_REWRITE)
  })

  it('★ 一次出现多处时全部改写（历史里可能复述多次）', () => {
    const twice = `${DSH_TRIGGER}\n${DSH_TRIGGER}`
    expect(rewriteTencentContentFingerprints(twice, 'buddy'))
      .toBe(`${DSH_REWRITE}\n${DSH_REWRITE}`)
  })

  it('★ 非腾讯系：逐字节不变（别替别家上游改写用户提示词）', () => {
    for (const provider of ['qoder', 'qodercn', 'trae', 'codearts', 'lobsterai', '']) {
      expect(rewriteTencentContentFingerprints(DSH_TRIGGER, provider)).toBe(DSH_TRIGGER)
    }
  })
})

describe('OpenAI 网关 Chat 路径：改 system 与 assistant 正文，其余角色一概不碰', () => {
  it('★ workbuddy：system 被改写', async () => {
    const options = await toGenerateOptions({
      model: 'workbuddy/deepseek-v4.1-flash',
      messages: [
        { role: 'system', content: ZCODE_GITSTATUS },
        { role: 'user', content: '改一下 README' },
      ],
    }, abort())
    expect(textsOf(options.messages)[0]).not.toContain(TRIGGER)
    expect(textsOf(options.messages)[0]).toContain(REWRITE)
  })

  it('★ 非首位的 system 同样要改（实测非 messages[0] 的 system 也被拦）', async () => {
    const options = await toGenerateOptions({
      model: 'workbuddy/deepseek-v4.1-flash',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: '继续' },
        { role: 'system', content: `${TRIGGER}: master` },
      ],
    }, abort())
    const systems = options.messages
      .filter((message) => message.role === 'system')
      .flatMap(message => textsOf([message]))
    expect(systems).toEqual(['You are a helpful assistant.', `${REWRITE}: master`])
  })

  it('★ assistant **正文**要改（实测该位置 400/11128），user / tool 仍原样保留', async () => {
    // 分角色对待的依据全在 `tencent-fingerprint.ts` 那张实测表里：
    // - `user` / `tool` 结果 / `reasoning_content` / `tool_calls.arguments`
    //   实测**不拦** ⇒ 改它们换不来放行，却会篡改用户原话与工具输出
    //   （工具输出往往是要回读给模型看的证据）；
    // - `assistant` 正文实测**拦** ⇒ 必须改，否则一句进了历史的坏话
    //   会让整个会话从此每轮报废（2026-10-12 用户报 `step-5-preview` /
    //   `space-bunny` 同错即此）。
    // ⚠️ 本用例**以前**断言的是「assistant 原样保留」——那是初版只测了
    // system/user/tool 三个位置得出的**过窄**结论，已由 2026-10-12 的
    // 补测（`tests/e2e/buddy-fingerprint-roles.e2e.spec.ts`）证伪并翻案。
    const options = await toGenerateOptions({
      model: 'workbuddy/deepseek-v4.1-flash',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: `看看这句：${TRIGGER}` },
        { role: 'assistant', content: `好的：${TRIGGER}`, tool_calls: [
          { id: 'call-1', type: 'function', function: { name: 'read', arguments: `{"q":"${TRIGGER}"}` } },
        ] },
        { role: 'tool', tool_call_id: 'call-1', content: `${TRIGGER}: master` },
      ],
    }, abort())
    const all = textsOf(options.messages)
    // assistant 正文：已改写
    expect(all).toContain(`好的：${REWRITE}`)
    expect(all.some((text) => text.startsWith('好的：') && text.includes(TRIGGER))).toBe(false)
    // user 与 tool 结果：逐字不变（两处各含一次触发串）
    expect(all).toContain(`看看这句：${TRIGGER}`)
    expect(all).toContain(`${TRIGGER}: master`)
    // 改写只发生在 assistant 正文这一处 ⇒ 全文只剩 user/tool 两处含原句
    expect(all.filter((text) => text.includes(TRIGGER))).toHaveLength(2)
    // 非文本通道不在本函数的管辖内（网关不产 reasoning，工具参数须原样）
    const toolCall = options.messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .find((block) => (block as { type?: unknown }).type === 'tool-call') as
        { arguments?: unknown } | undefined
    expect(String(toolCall?.arguments)).toContain(TRIGGER)
  })

  it('★ 非腾讯系 provider：整条请求逐字节不变', async () => {
    const options = await toGenerateOptions({
      model: 'qoder/qfmodel',
      messages: [
        { role: 'system', content: ZCODE_GITSTATUS },
        { role: 'user', content: 'hi' },
      ],
    }, abort())
    expect(textsOf(options.messages)[0]).toBe(ZCODE_GITSTATUS)
  })

  it('★ IKLS2L：Claude Code 的 system 身份句在网关路径被改写（外部客户端入口）', async () => {
    // 现场链路：Claude Desktop「Code」页 → cc-switch（Anthropic→Responses 转换）
    // → 本机网关。system 里带的是 Claude Code 自己的身份句常量。
    const options = await toGenerateOptions({
      model: 'workbuddy/deepseek-v4.1-flash',
      messages: [
        { role: 'system', content: `${CLAUDE_TRIGGER}.` },
        { role: 'user', content: '说：OK' },
      ],
    }, abort())
    const system = textsOf(options.messages)[0]
    expect(system).not.toContain(CLAUDE_TRIGGER)
    expect(system).toContain(CLAUDE_REWRITE)
    // 非腾讯系客户端（如 qoder）不得被改写。
    const other = await toGenerateOptions({
      model: 'qoder/qfmodel',
      messages: [{ role: 'system', content: `${CLAUDE_TRIGGER}.` }, { role: 'user', content: 'hi' }],
    }, abort())
    expect(textsOf(other.messages)[0]).toBe(`${CLAUDE_TRIGGER}.`)
  })

  it('★ IKLYCT：反馈句在 Chat 网关路径被改写（system 与 assistant 正文两处）', async () => {
    const options = await toGenerateOptions({
      model: 'workbuddy/deepseek-v4.1-flash',
      messages: [
        { role: 'system', content: `  - ${FEEDBACK_TRIGGER}` },
        { role: 'user', content: '看这句：' + FEEDBACK_TRIGGER },
        { role: 'assistant', content: `我记下：${FEEDBACK_TRIGGER}` },
        { role: 'user', content: 'OK' },
      ],
    }, abort())
    const all = textsOf(options.messages)
    // system 与 assistant 正文：已改写
    expect(all).toContain(`  - ${FEEDBACK_REWRITE}`)
    expect(all).toContain(`我记下：${FEEDBACK_REWRITE}`)
    // user 原话：实测放行 ⇒ 刻意不碰（改了就是篡改用户输入）
    expect(all).toContain('看这句：' + FEEDBACK_TRIGGER)
    // 全文只剩 user 一处含原句
    expect(all.filter((text) => text.includes(FEEDBACK_TRIGGER))).toHaveLength(1)
  })
})

describe('OpenAI 网关 Responses 路径：与 Chat 同一判据', () => {
  it('★ instructions 走改写（Responses 端唯一的 system 通道）', async () => {
    const options = await toResponsesGenerateOptions({
      model: 'workbuddy/deepseek-v4.1-flash',
      instructions: ZCODE_GITSTATUS,
      input: 'hi',
    }, abort())
    expect(textsOf(options.messages)[0]).not.toContain(TRIGGER)
    expect(textsOf(options.messages)[0]).toContain(REWRITE)
  })

  it('★ input 里的 system / developer 消息也走改写', async () => {
    const options = await toResponsesGenerateOptions({
      model: 'workbuddy/deepseek-v4.1-flash',
      input: [
        { type: 'message', role: 'system', content: `${TRIGGER}: master` },
        { type: 'message', role: 'developer', content: `also ${TRIGGER}` },
        { type: 'message', role: 'user', content: `keep ${TRIGGER}` },
      ],
    }, abort())
    const texts = textsOf(options.messages)
    expect(texts[0]).toBe(`${REWRITE}: master`)
    expect(texts[1]).toBe(`also ${REWRITE}`)
    // user 消息不碰
    expect(texts).toContain(`keep ${TRIGGER}`)
  })

  it('★ input 里的 assistant 正文也走改写（与 Chat 端**同判据**）', async () => {
    // 两端判据不一致时，症状是「同一份历史在 /v1/chat/completions 放行、
    // 在 /v1/responses 被拦」——排查时会误判成端点差异，实际是漏了一个接入点。
    const options = await toResponsesGenerateOptions({
      model: 'workbuddy/deepseek-v4.1-flash',
      input: [
        { type: 'message', role: 'assistant', content: `上一轮我说过：${TRIGGER}` },
        { type: 'message', role: 'user', content: `用户原话：${TRIGGER}` },
      ],
    }, abort())
    const texts = textsOf(options.messages)
    expect(texts).toContain(`上一轮我说过：${REWRITE}`)
    // user 不碰
    expect(texts).toContain(`用户原话：${TRIGGER}`)
  })

  it('★ 非腾讯系 provider：instructions 逐字节不变', async () => {
    const options = await toResponsesGenerateOptions({
      model: 'qoder/qfmodel',
      instructions: ZCODE_GITSTATUS,
      input: 'hi',
    }, abort())
    expect(textsOf(options.messages)[0]).toBe(ZCODE_GITSTATUS)
  })

  it('★ IKLS2L：`instructions` 里的 Claude 身份句被改写（Responses 端唯一 system 通道）', async () => {
    // issue 的现场就是 `/v1/responses`：cc-switch 把 Anthropic 的 system 转成
    // `instructions`。漏掉这一格等于「该端点没修」。
    const options = await toResponsesGenerateOptions({
      model: 'workbuddy/deepseek-v4.1-flash',
      instructions: `${CLAUDE_TRIGGER}.`,
      input: 'hi',
    }, abort())
    const text = textsOf(options.messages)[0]
    expect(text).not.toContain(CLAUDE_TRIGGER)
    expect(text).toContain(CLAUDE_REWRITE)
  })

  it('★ IKLS2L：input 里的 assistant 正文放 Claude 身份句也走改写（历史重放路径）', async () => {
    // 与 ZCode 那条同型：一旦这句进了 assistant 历史就会每轮原样重放，
    // 排查这个风控 bug 的会话本身会被拦死（2026-10-12 报障的机制）。
    const options = await toResponsesGenerateOptions({
      model: 'workbuddy/deepseek-v4.1-flash',
      input: [
        { type: 'message', role: 'assistant', content: `我记录到这一句：${CLAUDE_TRIGGER}` },
        { type: 'message', role: 'user', content: `这是用户原话：${CLAUDE_TRIGGER}` },
      ],
    }, abort())
    const texts = textsOf(options.messages)
    expect(texts).toContain(`我记录到这一句：${CLAUDE_REWRITE}`)
    // user 不碰（实测该角色放行，改它只是篡改用户原话）。
    expect(texts).toContain(`这是用户原话：${CLAUDE_TRIGGER}`)
  })

  it('★ IKLYCT：`instructions` 里的反馈句被改写（issue 的现场端点就是 `/v1/responses`）', async () => {
    // IKLYCT 的复现入径明确是 `/v1/responses`：cc-switch 把 Claude Desktop 的
    // system 整份转成 `instructions` ⇒ 这条句**每轮必带**（不像身份句那样靠漏传前缀）。
    // 漏掉这一格 = 该端点根本没修。
    const options = await toResponsesGenerateOptions({
      model: 'workbuddy/deepseek-v4.1-flash',
      instructions: `# Help\n  - ${FEEDBACK_TRIGGER}\n\n# Tone\nBe concise.`,
      input: 'hi',
    }, abort())
    const text = textsOf(options.messages)[0]
    expect(text).not.toContain(FEEDBACK_TRIGGER)
    expect(text).toContain(`  - ${FEEDBACK_REWRITE}`)
    expect(text).toContain('# Tone')
  })

  it('★ IKLYCT：input 里的 assistant 正文放反馈句也走改写（历史重放路径）', async () => {
    const options = await toResponsesGenerateOptions({
      model: 'workbuddy/deepseek-v4.1-flash',
      input: [
        { type: 'message', role: 'assistant', content: `我记录到这一句：${FEEDBACK_TRIGGER}` },
        { type: 'message', role: 'user', content: `这是用户原话：${FEEDBACK_TRIGGER}` },
      ],
    }, abort())
    const texts = textsOf(options.messages)
    expect(texts).toContain(`我记录到这一句：${FEEDBACK_REWRITE}`)
    expect(texts).toContain(`这是用户原话：${FEEDBACK_TRIGGER}`)
  })

  it('★ IKLYCT：input 里的 system / developer 消息也走改写（与 `instructions` 是**两处**）', async () => {
    // ⚠️ 这条守的是 `responses.ts` 里**另一处**调用点（input 的 system/developer），
    // 与上面 `instructions` 那条**不是同一格** —— 只测 `instructions` 时，
    // 把这一处改掉是**改坏不红**的。
    const options = await toResponsesGenerateOptions({
      model: 'workbuddy/deepseek-v4.1-flash',
      input: [
        { type: 'message', role: 'system', content: FEEDBACK_TRIGGER },
        { type: 'message', role: 'developer', content: `also ${FEEDBACK_TRIGGER}` },
        { type: 'message', role: 'user', content: `keep ${FEEDBACK_TRIGGER}` },
      ],
    }, abort())
    const texts = textsOf(options.messages)
    expect(texts).toContain(FEEDBACK_REWRITE)
    expect(texts).toContain(`also ${FEEDBACK_REWRITE}`)
    // user 不碰
    expect(texts).toContain(`keep ${FEEDBACK_TRIGGER}`)
  })
})
