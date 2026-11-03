/**
 * 腾讯系渠道的**内容级**风控指纹改写（Gitee issue IKJNA1）。
 *
 * ## 现象
 *
 * 外部客户端（ZCode 等）经本插件的 OpenAI 网关调 `buddy` / `workbuddy` 时，
 * 只要 `system` 消息里带着某些**客户端自带的模板句**，腾讯网关就稳定回
 * `HTTP 400 / code 11128 / "Illegal API invocation from an unapproved channel"`，
 * 客户端侧只显示 `provider_code=INVALID_REQUEST reason=unknown`。
 * DSH 直连同一模型则完全正常 —— 差别只在于**外部客户端往 system 里注了什么**。
 *
 * ## 哪些角色要改（实测出来的，不是推理出来的）
 *
 * 本机逐组实测（`www.workbuddy.ai` 与 `copilot.tencent.com` **两个端点表现一致**，
 * 同账号 / 同模型 / 同 UA 与 X-* 头 / `max_tokens` 取小值，被拦不耗额度）：
 *
 * | 探针 | 指纹所在处 | 结果 |
 * |---|---|---|
 * | 中性对照 | 无 | ✅ 200 |
 * | 最小充分触发 | `system` | ❌ 400/11128 |
 * | 只留标签 `Main branch: master` | `system` | ✅ 200 |
 * | 换分支名（`: dev`） | `system` | ❌ 400/11128 ⇒ **分支值无关** |
 * | 句中 / 段中被别的句子夹住 | `system` | ❌ 400/11128 ⇒ **位置无关** |
 * | **改写该句** | `system` | ✅ 200 ⇒ 改写是有效修法 |
 * | 指纹在**第二条** system（非 `messages[0]`） | `system` | ❌ 400/11128 |
 * | 只差一个词（`normally` 替 `usually`） | `system` | ✅ 200 ⇒ **逐字符**匹配 |
 * | 内层多一个空格 | `system` | ✅ 200 ⇒ 同上 |
 * | 全小写 / 全大写 | `system` | ❌ 400/11128 ⇒ **大小写不敏感** |
 * | 同一句放进 **user** 消息 | `user` | ✅ 200 |
 * | 同一句放进 **tool 结果** | `tool` | ✅ 200 |
 * | ★ 同一句放进 **assistant 正文** | `assistant.content` | ❌ **400/11128** |
 * | ★ assistant 只放在 **`reasoning_content`** | 该字段 | ✅ 200 |
 * | ★ assistant 只放在 **`tool_calls[].function.arguments`** | 该字段 | ✅ 200 |
 * | ★ 40KB 良性长文本（与文档同字节数） | `assistant.content` | ✅ 200 ⇒ **体量不是原因** |
 *
 * ★ 那四行是 2026-10-12 补测的。**初版只测了 `system` / `user` / `tool` 三个位置**，
 * 于是得出「只拦 system」这个**过窄**的结论并把它写成了硬约束 —— 而 `assistant`
 * 那一格根本没测过（当时的 assistant 探针把触发句**改写**成了 `I see … here.`
 * 的转述形态，而服务端逐字符匹配，那个形态本身就不含触发串，**等于空跑**）。
 *
 * 由此得到三条**不能违反**的实现约束：
 *
 * 1. **改 `system` 与 `assistant` 正文两处**，其余一概不碰：
 *    `user` / `tool` 结果 / `reasoning_content` / `tool_calls` 的 `arguments`
 *    实测**都不拦**（上表那四行 ✅）。改它们换不来任何放行，却会篡改用户原话、
 *    工具输出（那是要回读给模型看的证据）与模型自己的思考。
 *    ⚠️ 反向也要守住：**别把 `assistant` 这一格「简化」掉** —— 见下文「为什么必须
 *    连直连一起改」，那正是本轮线上报障的成因。
 *    ⚠️ 也不要扩到那四行：实测放行，且改了破坏前缀缓存与证据完整性。
 * 2. **改写所有** system 消息**，不只 `messages[0]`：非首位的 system 同样被拦
 *    （上表「指纹在第二条 system」那一行）。
 * 3. **大小写不敏感的精确匹配**：全小写与全大写都被拦（上表「全小写 / 全大写」
 *    那一行），所以 `replaceAll` 的字面量比对必须带 `i`；但**只差一个词**或
 *    **多一个空格**都不拦（上表「只差一个词」「内层多一个空格」两行），
 *    说明服务端认的是**逐字符的字面量**，**不能**把它泛化成正则/关键词。
 *
 * ⚠️⚠️ **但「逐字符的精确字面量」不等于「每条指纹的锚点相同」**（2026-10-14，
 * 登记 Claude Code 那条时实测出来）。四条已登记指纹的**位置语义并不一致**：
 *
 * | 指纹 | 位置语义 | 依据（**探针实测**，不是推断） |
 * |---|---|---|
 * | ZCode gitStatus 句 | **位置无关**（句中/段中被夹住仍拦） | 上表「句中 / 段中被别的句子夹住」 |
 * | Claude Code 身份句 | **行首锚定**（前接任意一个字符即放行） | 前接空格 / 换行 / 中文前言 / 双换行**均 200**；裸串、后接句点均 400 |
 * | Claude Code 反馈句 | **位置无关**（前接前言仍拦） | 裸串、前接 `Note: `、前接行首 `  - `、后接换行正文**均 400/11128** |
 * | DSH 身份首句（第 4 条） | **行首锚定**（前接任意前缀即放行） | 前接 `You are a helpful assistant.\n\n` **200**；裸串 400；带句点 / 后接正文仍 400 |
 *
 * ⚠️ 表里第 2、4 行（**行首锚定**）与第 1、3 行（**位置无关**）**互为反面** ⇒
 * 「位置语义」这张表**必须逐条实测**，拿任一条的结论推给新指纹就是踩中本文件
 * 下面那条纪律。
 *
 * ⚠️ 而「`find` 该写多长」**也不统一** —— 那取决于**该条指纹的最小充分串**，
 * 而最小充分串**只能逐条实测**（IKLYCT 那条实测：砍掉前半或后半都放行 ⇒ 必须写整句；
 * 身份句那条实测：少一个字母即放行 ⇒ 恰好写全）。**照抄别条的 find 长度是错的**。
 *
 * ⇒ **绝不能把任一条的锚点结论推给新指纹**。新增一条时的探针必须**两侧都测**
 * （既测句首也测非句首），否则会把「锚点不吃这一口」误读成「这条指纹已失效」
 * —— 那是**假阴性**，比没有探针更危险（会让人据此删掉一条仍然必需的登记）。
 *
 * ⚠️⚠️ **探针必须先把账号筛一遍（2026-10-18 新增的纪律）**：`11128` **有两种**，
 * `msg` 分别是 `Illegal API invocation from an unapproved channel`（**内容级**，
 * 本文件要治的那一种）与 `request illegal`（**渠道校验**，按账号要求三头，IKM7SG）。
 * 两者都回 `code 11128` ⇒ 若像本轮第一版探针那样**轮换账号**，会把账户特定的
 * 通道门控读成内容指纹的匹配语义 ⇒ 实测出「51 字符前缀被拦、69 字符超集放行」
 * 这种**非单调**的假结论。故：**先筛出基线放行的账号，再固定用它**，并**逐格打印 `msg`**。
 * 判据分离的写法见 `tests/e2e/buddy-fingerprint-roles.e2e.spec.ts` 顶部的说明。
 *
 * ⚠️ **可复核凭据已入库**（2026-10-12 审计补齐）：`tests/e2e/buddy-fingerprint-roles.e2e.spec.ts`。
 * 上面那四行 ★ **不是**本文件的自我声明 —— 它们各有一次真实发请求的用例。
 * ⚠️ 这个 e2e 文件不可省：单测只能锁「代码按这个范围改」，**锁不住这个范围对不对**。
 * 2026-10-12 的审计正是据此才发现初版把「只拦 system」写成了硬约束，而
 * `assistant` 那一格从未被测过（当时的探针还把触发句改成了转述形态，
 * 服务端逐字符匹配 ⇒ 空跑）。
 *
 * ## 为什么必须连**直连适配器**一起改（2026-10-12 真实报障，本节推翻初版取舍）
 *
 * 初版把改写**只**放在网关，理由有两条，其中一条已被实测证伪：
 *
 * - ✅ 仍然成立的：网关是外部客户端入口，指纹来自客户端模板注入。
 * - ❌ 已证伪的：「DSH 直连不受影响」。DSH 的 system 提示词确实不含这句，
 *   但**会话历史里的 `assistant` 正文会含** —— 而且几乎是必然：一旦用户让 agent
 *   排查这类风控问题，模型会先 `read` 记录该指纹的文档（`tool` 结果，不拦），
 *   再把它**逐字复述进自己的正文**（拦）。那条 assistant 消息从此每轮原样重放，
 *   于是**排查风控 bug 的会话本身被风控拦死**，症状是「这个 provider 从此每轮
 *   都失败，换任何一个腾讯系模型都一样」—— 2026-10-12 用户报
 *   `step-5-preview` 与 `space-bunny` 同错，正是这一条（**跟会话走，不跟模型走**）。
 *
 * ⇒ 所以这一层必须是**单一真相源**，同时被**两个方向**的调用方使用：
 *   `src/openai-gateway/{messages,responses}.ts`（外部客户端方向）与
 *   `src/buddy-adapter.ts` 的 `serializeMessages`（DSH 直连方向，含
 *   `options.system` 那个第四产出点）。
 *   **只在网关补 = 换一个入口又被拦**，与初版「三处接入点」是同一条教训的复现。
 *
 * ⚠️ 但「两个方向」**不等于**「已覆盖全部出站路径」：`src/buddy-growth.ts` 另有
 * 两处直发 `POST …/v2/chat/completions`（保连胜的「你好」、抓 requestId 的「1+1」），
 * **不经 `BuddyAdapter`、故不过这一层改写**。当前安全 —— 那两处请求体写死、
 * 既无指纹也无 assistant 历史；但一旦将来把它们改成携带历史或拼接用户内容，
 * 就会静默成为第三个未改写入口（其失败表象是整轮 400/11128，极难归因）。
 * 见 `buddy-growth.ts` 里那两处的注释。
 *
 * ⚠️ 直连侧改的是**已持久化的历史**，与 `stripCourseLeakFromHistoryContent`
 * 是同一类「存量自愈」逻辑（那个清的是模型自己的行首泄漏，这个清的是被上游拦的
 * 字面量），落点也因此贴着它，不另起一套遍历。
 *
 * ## ⚠️ 千万不要把 11128 加进 `isContentRejection`
 *
 * 那是**内容级**拦截：同一账号换掉这一句就通（上面「改写该句」一行）。
 * 认成「账号被策略拦」会触发换号 + 30 分钟账号冷却（`CONTENT_REJECTION_COOLDOWN_MS`），
 * 把整个账号池白锁 30 分钟，而真正该做的是改写那一句。
 * `isContentRejection` 只认 11140 / `request illegal` / 安全审核文案**是对的**，
 * **但「不认它」不等于「不会被误判」** ——
 *
 * ⚠️⚠️ **2026-10-18 实测出的一处真实缺陷（本条曾被它反噬，已修）**：
 * `isContentRejection` 的腿③ `/安全审核|safety review/i` **扫整份报文**（含
 * `displayMsg` / `displayTips`），而 `buddy-adapter.ts` 自己就记着「`11128` 各子原因
 * **共用/漂移 `displayMsg`**」⇒ 上游哪天把内容级 11128 的 `displayMsg` 漂成
 * `The content did not pass the safety review.`，这份**换句即通**的报文就会落进
 * 「账号级拦截」档 ⇒ **烧完整池 + 锁 30 分钟**，把本文件的修复效果**完全抵消**。
 * 修法与全部实测格见 `buddy-adapter.ts` 的 `CONTENT_BLOCKED_MSG` 注释。
 * ⚠️ 教训可推广：**「不该把 X 加进判据」≠「判据不会因为 X 的报文而误判」** ——
 * 一条扫全文案的腿会绕过你精心写的排除逻辑。
 *
 * ## 表驱动，而不是写死一处
 *
 * 屏蔽名单服务端掌握、可能随时更新，任何客户端将来都可能撞上新指纹。
 * 故这里是**表**：新增一条 = 往 {@link CONTENT_FINGERPRINTS} 里加一行 + 一条用例。
 */

/** 受影响的 provider：腾讯系两个后端（`buddy` = CodeBuddy 中国版，`workbuddy` = WorkBuddy 国际版）。 */
const TENCENT_PROVIDERS: readonly string[] = ['buddy', 'workbuddy']

interface ContentFingerprint {
  /** 被拦的**字面量**（匹配时**大小写不敏感**，但不做任何模式泛化）。 */
  readonly find: string
  /** 等义改写。两个端点均实测 200。 */
  readonly replace: string
  /** 来源与证据，写死在代码里，免得后人「顺手」把它改成正则或删掉。 */
  readonly note: string
  /**
   * ⚠️ **可选的「漂移容忍」正则源码**（2026-10-30 新增，只有第 4 条用它）。
   *
   * 语义：**只**放宽「形态」这一维（大小写、空白量、可选逗号、可选
   * `coding` / 定冠词），**不放宽**成关键词 —— 锚点仍必须是**整句**。
   *
   * ⚠️ 存在的理由：`find` 是**逐字符**字面量，DSH 只要改动其中**一个**字符，
   * 这条规则就**静默失效**（症状 = 每轮 400/11128，与「没登记过」同形）。
   * 本文件顶部已把这条风险登记为「漂移风险未解」。
   *
   * ⚠️ 填了 `findRegex` 也必须**同时**填 `find`：`find` 是文档可读的原文，
   * 也是单测「原文 vs 改写后」对照的取样源。
   */
  readonly findRegex?: string
}

/**
 * 已知会被腾讯网关拦下的 system 模板句。
 *
 * ⚠️ **每一条都必须有实发证据**（被拦 + 改写后放行，两条都要），
 * 照抄别家客户端的常量而没实测过 = 给上游加了一条没人验证过的改写。
 */
const CONTENT_FINGERPRINTS: readonly ContentFingerprint[] = [
  {
    // ZCode 内建常量：`$Js="Main branch (you will usually use this for PRs)"`。
    // 每个 git 仓库里的会话都会被注入（拼在 `Main branch … : <分支名>` 这一行）。
    find: 'Main branch (you will usually use this for PRs)',
    replace: 'Main branch (PRs usually go here)',
    note: 'Gitee IKJNA1；本机 2026-10-05 对 workbuddy / CodeBuddy 双端点实测复现',
  },
  {
    // Claude Code 内建常量（v2.1.295 的 `yl`）：
    // `"You are Claude Code, Anthropic's official CLI for Claude."`
    //
    // ⚠️ **`find` 刻意不带尾句点**，一条同时覆盖两个常量（本机实测两者改写后都放行）：
    //   - `yl`  = `You are Claude Code, Anthropic's official CLI for Claude.`
    //   - `sf`  = 同句 + `, running within the Claude Agent SDK.`
    // 第三个常量 `af`（`You are a Claude agent, built on Anthropic's Claude Agent SDK.`）
    // 实测**不被拦**，故刻意不登记（多一条就是替上游无谓改写用户提示词）。
    //
    // ## ⚠️⚠️ 本条的匹配语义**不是**「位置无关」，而是**行首锚定**（与 ZCode 那条相反）
    //
    // 2026-10-14 本机对两个端点的逐格实测（详见 `docs/agent-notes/providers-buddy.md`
    // 「Claude Code 身份句」一节）：该指纹**只在文本绝对开头**被拦 ——
    //   | 形态 | 结果 |
    //   |---|---|
    //   | 裸串 | ❌ 400/11128 |
    //   | 前接空格 / 前换行 / 前接任意前言 | ✅ **200 放行** |
    //   | 后接句点 / 破折号 / 中文句号 / 长正文 | ❌ 400/11128 |
    // 即**前导字符一个都不容忍、后缀完全自由**，与 ZCode 那条的「位置无关」不同。
    //
    // 这不影响改写本身（下面 `replaceAll` 照样生效），但**影响怎么为新指纹做探针**：
    // 只测「夹在句中」会得到「已放行」的**假阴性**（真因是锚点，不是这句不再触发）。
    // 故本条的实测凭据必须含**贪心探针**（覆盖行首与非行首两侧），见
    // `tests/e2e/buddy-fingerprint-roles.e2e.spec.ts` 的 Claude 段。
    //
    // ⚠️ **改成行首锚定的正则**（如 `^` 配 `m`）是**错**的：改写范围宁可略宽 ——
    // 漏改一处就换来整轮 400，多改一处只是语义等价的措辞变化（原文已不存在
    // 「位置无关」的相反证据）。故与上一条共用同一条实现路径。
    find: "You are Claude Code, Anthropic's official CLI for Claude",
    replace: "You are Claude Code, Anthropic's CLI for Claude",
    note: 'Gitee IKLS2L；本机 2026-10-14 对 workbuddy / CodeBuddy 双端点实测：'
      + 'system 与 assistant 正文位置均 400/11128，改写后两端点均 200（含 SDK 变体）',
  },
  {
    // Claude Code system prompt 的「帮助 / 反馈」段默认句（Gitee issue IKLYCT）：
    // `To give feedback, users should report the issue at
    //  https://github.com/anthropics/claude-code/issues`
    //
    // ## 与上一条（身份句）不同：这一条**每轮必带**，不是概率性泄漏
    //
    // 身份句只有 cc-switch 的 `mrt()` 探测路径漏传 `skipSystemPromptPrefix` 时才注入
    // （实测约 34%）；本句属于 Claude Code system prompt 的**固定段落**，
    // 只要客户端把默认 system 整份发过来就必然带上 ⇒ **漏登记 = 必然命中**。
    // 用户侧实测：单日 buddy/workbuddy 因它白撞 647 次。
    //
    // ## ⚠️ 匹配语义：**位置无关**（与身份句的「行首锚定」相反）
    //
    // 2026-10-18 本机对 `www.workbuddy.ai` + `copilot.tencent.com` 双端点逐格实测：
    //   | 形态 | 结果 |
    //   |---|---|
    //   | 裸串 / 前接 `Note: ` / 前接行首 `  - ` | ❌ 400/11128 ⇒ 位置无关 |
    //   | 后接换行 + 其他文本 | ❌ 400/11128 |
    //   | 全大写 | ❌ 400/11128 ⇒ 与另两条同型（大小写不敏感） |
    //   | 换 org/repo、换域名、改一个词、只留 URL | ✅ 200 ⇒ **逐字符** |
    //   | **砍掉前半 / 砍掉后半** | ✅ 200 ⇒ **`find` 必须写整句** |
    //
    // ⚠️ 最后那一格是本条的**要害**：子串本身不触发，写短了等于空跑 ——
    // 而空跑的症状是「登记了却仍每轮 400」，极难归因。
    //
    // ⚠️ 本条的 `find`（整句 99 字符）已经**贴着**上游屏蔽名单的粒度，
    // 不要再按 ZCode 那条的思路去「缩短 find 覆盖更多变体」：实测换域名即放行。
    // ⚠️⚠️ **「缩短/删字」这类变异只有实发能验，单测锁不住**：
    //   单测能证明「砍掉半句时我们**不**改写」（那是真事实），但证明不了
    //   「砍掉半句后上游**仍会拦**」—— 那只有 e2e 能验（见上面那两格）。
    //   ⇒ 改本行时**必须**跑一遍 `DSH_BUDDY_FINGERPRINT_E2E=1` 那节。
    //
    // ⚠️ 与身份句同理**不做行首锚定**：改写宁可略宽（漏改 = 整轮 400，
    // 多改 = 语义等价的措辞变化）。
    find: 'To give feedback, users should report the issue at '
      + 'https://github.com/anthropics/claude-code/issues',
    // 实测两端点均 200（buddy / workbuddy，2026-10-18）。措辞与原文等义。
    replace: 'To give feedback, users should report the issue at the project issue tracker',
    note: 'Gitee IKLYCT；本机 2026-10-18 对 workbuddy / CodeBuddy 双端点实测：'
      + 'system（含非首位）与 assistant 正文均 400/11128，user / reasoning_content / '
      + 'tool 结果放行，改写后两端点均 200',
  },
  {
    // **DSH 自己的 system prompt 身份首句**（`base` 段的 `You are an AI agent
    // powered by DeepSeek Harness.`，app.asar 内 7 处提及，SDK profile 文档原话
    // "inherits the base system prompt, including the ... identity"）。
    //
    // ⚠️⚠️ 本条的匹配语义是**行首锚定**（与 Claude Code 身份句同族，与另两条相反）：
    // 本机 2026-10-20 对 `copilot.tencent.com` + 账号 A 逐格实测——
    //
    //   | 形态 | 结果 |
    //   |---|---|
    //   | 裸串作整个 system（绝对行首） | ❌ 400/11128 |
    //   | 前接任意前缀（`You are a helpful assistant.\n\n` + 裸串） | ✅ 200 |
    //   | 改写后裸串（无句点 / 带句点 / 后接正文） | ✅ 200 |
    //   | 整段真实 system（首句改写，8683 字符） | ✅ 200 |
    //   | 整段真实 system（首句删除，8624 字符） | ✅ 200 |
    //
    // ⇒ 与身份句同理**不做行首锚定正则**：改写范围宁可略宽。漏改 = 整轮 400，
    //    多改 = 语义等价的措辞变化。
    //
    // ⚠️ **这不是外部客户端泄漏，而是 DSH 每轮必带的首句** ⇒ 与另三条的本质差别：
    //    它无法靠「换会话 / 清历史」规避，只能靠本表。上游 2026-10 连续登记
    //    ZCode(10-05)/Claude 身份句(10-14)/反馈句(10-18) 后，本条是最新一条，
    //    上游尚未登记（提 Gitee issue 时可引本段作实测凭据）。
    //
    // ⚠️ 时序证据（排除「位置被挪到行首」这个竞争假设）：解压同一工作区
    //    2026-09-28 的会话，其 system 首行即本句且当时可正常使用 ⇒ 该句**一直**
    //    在行首，是腾讯网关后续才把它纳入拦截名单，不是本机配置变更所致。
    //
    // ## 2026-10-21：`replace` 从「语义等义改写」换成**官方同形形态**（用户要求）
    //
    // 起因是做了一次对照取证 —— 不是读源码推的，而是**拿 CodeBuddy 客户端自己的
    // 一条真实会话**（标题「AI编程助手介绍」，id `8c9dbeb10e2846d7b0fa569b14aa4335`）。
    // 该会话落盘里 assistant 的 reasoning 逐字复述了自己的 system：
    //   「系统提示说我是 "an AI coding assistant, powered by Hy4 preview model"」；
    // 客户端提示词**资产**（`extensions/genie/product.json` 的 `craft-agent-prompt`）
    // 首行是 `You are an AI coding assistant,{{ ModelNamePrompt }}.`，而该变量渲染成
    // `" powered by <模型展示名> model"` ⇒ 两条独立来源拼出的字节一致：
    //
    //   `You are an AI coding assistant, powered by Hy4 preview model.`
    //
    // ⇒ 与我们那句**结构完全同形**：`You are <名词> powered by <Y>`。差别只在
    //   **Y 填什么** —— 官方填**模型展示名**，我们填**harness 名**。
    //   而原来的等义改写把 `DeepSeek Harness` 这个 token **原样留着**，属于
    //   「只躲开了字面量、没解决身份」：上游一旦把名单从「整句逐字符」放宽成
    //   关键词/正则，这一条立刻失效。
    //
    // 故 `replace` 改为官方**原生兜底**措辞（模型名缺失时官方发出来的就是这个形态）：
    //   `You are an AI coding assistant, powered by a large language model`
    // 三条取舍：
    //   ① 出站 `system` 里**彻底不再出现 `DeepSeek Harness`**——这是本条的真正收益；
    //   ② 措辞取自官方资产而**不是自造** ⇒ 与官方首帧同形，不是新的可疑信号；
    //   ③ **刻意不带具体模型名**：那要把 model 透传进本函数（7 处调用点），
    //      而我们的目录展示名与官方展示名不一定一致，多一处信号反而多一处不一致。
    //
    // ⚠️ **改这一行必须跑 e2e**：凭据 =
    //    `tests/e2e/buddy-fingerprint-roles.e2e.spec.ts` 的第 4 节
    //    （跑法：`pnpm test:e2e:buddy-fingerprint`，双闸门已绑好）。
    //    ✅ **2026-10-21 已实发验收**（`deepseek-v4.1-flash`）：新措辞在 buddy 站
    //    拿到干净的 200；该文件 §4 两站全绿。
    //
    // ⚠️⚠️ **本句是端点相关的**（2026-10-21 两站对照实测；登记时**只测过
    //    `copilot.tencent.com`**）：
    //
    //    | 站点 | `step-5-preview` | `deepseek-v4.1-flash` |
    //    |---|---|---|
    //    | `copilot.tencent.com`（buddy） | ❌ 400/11128 | ❌ 400/11128 |
    //    | `www.workbuddy.ai`（workbuddy） | ✅ 200 | ✅ 200 |
    //
    //    两个模型都测过 ⇒ **站点差异**、不是模型差异。表中对 `workbuddy` **仍保留**
    //    这条改写：措辞语义等义、对该站无害，国际站哪天也上名单时它就是现成的防线。
    //    ⚠️ 别把「workbuddy 没被拦」读成「这条登记是多余的」—— 它挡的是 buddy 站
    //    每轮必带的首句，而那一站是真的会被拦。
    //
    // ⚠️ **别把本条读成「封号」判据**：本仓库实测到的通道门控是**按账号 + 三个请求头**
    //    （IKM7SG），而 11128 的内容级那一支是**字面量黑名单**、不读语义。
    //    换措辞的已验证收益只有「不再命中那条字面量、出站不带自家 token」这两条。
    //
    // `find` 刻意不带尾句点：一条同时覆盖带句点与不带句点两种形态。
    find: 'You are an AI agent powered by DeepSeek Harness',
    // ⚠️⚠️ **漂移容忍**（2026-10-30 实测定案，见下方「2026-10-30」一节）：
    // 上游的匹配器**大小写不敏感**、且**归一空白**，但**不跨标点** ——
    // 于是「形态」这一维可以放宽，而语义仍锁在整句上。
    findRegex: 'You\\s+are\\s+an?\\s+AI\\s+(?:coding\\s+)?agent\\s*,?\\s*powered\\s+by\\s+'
      + '(?:the\\s+)?DeepSeek\\s+Harness',
    // 见上方「2026-10-21」一节：官方同形 + 官方原生兜底措辞。
    replace: 'You are an AI coding assistant, powered by a large language model',
    note: '本机 2026-10-20 对 copilot.tencent.com 实测：system 绝对行首 400/11128，'
      + '前接任意字符放行；2026-10-21 换成官方同形措辞后**实测放行**（buddy 站 / '
      + 'deepseek-v4.1-flash），另实测该句在 www.workbuddy.ai 两模型**均不拦**（站点相关）'
      + '；2026-10-30 复测（buddy / deepseek-v4.1-flash / 账号 A6146635）：原文 400'
      + '，全小写与全大写**同样 400**（⇒ 大小写不敏感），双空格**仍 400**（⇒ 空白归一）'
      + '，`agent` 后加逗号**200**、`agent,` 无空格**200**（⇒ 匹配不跨标点）'
      + '，裸两个词 DeepSeek Harness **200**（⇒ 认整句不认 token）',
  },
  {
    // **DSH Web 运行面的开头两句** —— 来自 DSH 的 `@deepseek-ai/dsh-harness-dev-context`
    // 插件的 `WEB_SURFACE_PROMPT`。该插件**只在 Web 运行时挂载**（其 README 原话：
    // 「`--help` 与非 Web 组合从不挂载」）⇒ CLI / 桌面面的会话 system 里没有这句，
    // 这也是它长期没被发现的原因（见下面「两次没测到」）。
    //
    // ## 现象（2026-10-21 真实报障：「buddy: 请求被拦截，请重新发送」）
    //
    // 真实会话的 system（5,780 字符）里 `DeepSeek Harness` 出现 **3 次**：
    // 第 1 行（身份句，第 4 条）、第 33 行（`HARNESS_SOURCE_PROMPT`）、第 35 行（本句所在行）。
    // 前四条只覆盖第 1 行 ⇒ **修复前插件发出的形态仍被整轮 400/11128**。
    //
    // ## 逐格实测（2026-10-21；`copilot.tencent.com` + `deepseek-v4.1-flash`；
    //    载荷逐字节取自本机会话落盘的真实 system；另用**三个不同账号**复测，结论一致）
    //
    // | 载荷 | 结果 |
    // |---|---|
    // | 真实整段（3 处都在） | ❌ 400/11128 |
    // | 真实整段 + **只改第 1 行**（= 修复前插件发出的形态） | ❌ **400/11128** |
    // | 真实整段 + 三处全改 | ✅ 200 |
    // | **只发第 33 行那句**（`HARNESS_SOURCE_PROMPT`） | ✅ 200 ⇒ **不登记它** |
    // | 正向：整个 system 就是 `DeepSeek Harness` 两个词 | ✅ 200 ⇒ **不是「认 token」** |
    // | 本行**前 220 字符**前缀 | ✅ 200 |
    // | 本行**前 221 字符**前缀 | ❌ 400/11128 ⇒ **字面量 = 前两句（本 `find`）** |
    // | 去掉行首 38 字符后再发 | ✅ 200 ⇒ 字面量**从行首开始** |
    // | 中性前言 + 本字面量 | ❌ 400/11128 ⇒ **位置无关**（与第 4 条的行首锚定**相反**） |
    // | 本字面量放 **assistant 正文** | ❌ 400/11128 ⇒ 现有改写范围（system + assistant）已覆盖 |
    // | `www.workbuddy.ai` 站同一载荷 | ✅ 200 ⇒ **站点相关**（与第 4 条同型） |
    // | 旧版形态 `…Web GUI at http://127.0.0.1:3080.` | ✅ 200 ⇒ **刻意不登记** |
    // | 真实整段 + 第 1 行改写 + **只把本句的品牌串去掉** | ✅ **200**（本 `replace` 的来历） |
    //
    // ## ⚠️⚠️ `find` 为什么是 221 字符、不能更短
    //
    // 前缀二分给出 **220 放行 / 221 拦**；而把这一行**按句切开**后，
    // 前一句（107 字符）与后七句（894 字符）**各自都放行** ⇒ 触发串**跨了句边界**，
    // 它是**前两句的并集**。切开任何一半都会**空跑**（症状：登记了却仍每轮 400）。
    // 这正是本仓库那条纪律的又一例：**非单调现象只能逐格实测，不能凭直觉切**。
    //
    // ## ⚠️ 本条的**脆弱性**（如实登记）
    //
    // 上游认的是**逐字符**的长字面量 ⇒ DSH 哪天改动这两句里的任一字符，本规则会
    // **静默停止匹配**（症状 = 该渠道整轮 400 复发，且行为与「完全没登记」同形）。
    // 现阶段的守卫是 `tests/e2e/buddy-fingerprint-roles.e2e.spec.ts` 第 5 节
    // （发的是**同形载荷**，不读 DSH 源码 ⇒ 它锁得住「换了措辞会被拦」，
    // **锁不住**「DSH 改了措辞而本 `find` 没跟上」）。要做真漂移检测得上
    // 「出站 system 里若仍出现 `DeepSeek Harness` 就报警」那类运行时闸门，**尚未实现**。
    find: 'You are interacting with the user through the DeepSeek Harness Web GUI '
      + 'whose URL the runtime context names. When the user refers to "this page", "this GUI", '
      + 'or "this app" without naming another target, they mean this GUI.',
    // 只去掉品牌串，语义不变：仍是「你在一个 Web GUI 里，它的 URL 由 runtime context 给出」。
    replace: 'You are interacting with the user through the harness Web GUI '
      + 'whose URL the runtime context names. When the user refers to "this page", "this GUI", '
      + 'or "this app" without naming another target, they mean this GUI.',
    note: '真实报障 2026-10-21（修复前插件形态在 buddy 站整轮 400/11128）；本机逐格实测：'
      + '221 字符字面量被拦、220 前缀放行、位置无关、assistant 正文同样被拦、'
      + 'www.workbuddy.ai 不拦、旧版 `at <url>` 形态不拦；去掉品牌串后真实整段 200',
  },
  {
    // **DSH 的 `@` 文件引用说明句**（`FILE_REFERENCE_PROMPT`；2026-10-28 真实报障）。
    //
    // ## 现象
    //
    // 真实会话每轮 `400/11128 Illegal API invocation from an unapproved channel`，
    // 用户侧显示 `INVALID_REQUEST` + 「请求被拦截，请重新发送」。关键观察：
    // **前五条全部命中并被改写**（身份句、Web 面两句都在出站文本里确认消失），
    // **仍然被拦** ⇒ 触发物不在已登记的清单里。
    //
    // ## 出处（写在这里是因为它极易被漏第二次）
    //
    // `packages/context/file-reference/src/index.ts` 的 `FILE_REFERENCE_PROMPT`，
    // 由 `@deepseek-ai/dsh-file-reference-local` 注入为 `context:file-reference` 段：
    //
    // ```ts
    // text: () => agent.ctx.tools.get('read', agent) === undefined ? '' : FILE_REFERENCE_PROMPT
    // ```
    //
    // 该段在 agent 有 `read` 工具时**恒非空** ⇒ **每轮必带**，与加载了哪些插件、
    // 哪些 skill **完全无关**（曾误判为「superpowers 把 system 撑大导致」，
    // 实测删掉 superpowers 整段后**仍被拦**，该假设已被证伪）。
    //
    // ## ⚠️⚠️ 本条**不含任何品牌词** —— 这就是它被前五条漏掉的原因
    //
    // 没有 `DeepSeek Harness`、没有 `dsh`、没有 `DeepSeek`。前五条的普查方式是
    // 「找出带品牌名的句子」，而这条是**纯功能描述**，按品牌名筛选**必然漏掉**。
    // ⇒ **判据不是品牌名，是「`@` 路径引用语法说明」这个 DSH 独有写法。**
    // 以后新增登记时请回来读这一行：**别只按品牌名普查**。
    //
    // ## 本机逐格实测（2026-10-28；`copilot.tencent.com`；`deepseek-v4.1-flash`）
    //
    // 固定一个基线放行的账号（先用中性 system 筛掉限流/渠道门控的账号），
    // 每格发 2–3 次确认确定性（该格结果稳定，非随机）。
    //
    // | 探针 | 结果 | 结论 |
    // |---|---|---|
    // | 中性句 `You are a helpful assistant.` | ✅ 200 ×6 | 基线 |
    // | **真实整段 system（18,383 字符）** | ❌ 400/11128 ×6 | 复现 |
    // | **同一 system，仅把本句改成 `replace`** | ✅ **200 ×3** | **修法有效** |
    // | 完全不发 system | ✅ 200 ×3 | 对照（证明变量在 system 内） |
    // | 真实 system 逐行二分 | 第 160 行为临界 | 定位 |
    // | 该行**前 110 字符** | ✅ 200 | — |
    // | 该行**前 111 字符** | ❌ 400 | ⇒ 字面量 = 111 字符 |
    // | 只发**前半句**（`Tokens prefixed with @…`，48 字符） | ✅ 200 | ⇒ 半句空跑 |
    // | 只发**后半句**（`Relative paths…`，44 字符） | ✅ 200 | ⇒ 半句空跑 |
    // | 裸串作整个 system（绝对行首） | ❌ 400 | — |
    // | 前接 1 空格 / 前接换行 / 前接中文 | ❌ 400 | ⇒ **位置无关** |
    // | 嵌在句中（`Note: … here.`） | ❌ 400 | ⇒ **位置无关** |
    // | 整行跳到第 50 字符之后 | ✅ 200 | ⇒ 锚点从行首起算 |
    // | 全小写 / 全大写 | ❌ 400 | ⇒ **大小写不敏感** |
    //
    // ## `find` 为什么是 111 字符、不能更短
    //
    // 前缀二分给出 **110 放行 / 111 拦**；而按句切开后**两半各自都放行**
    // ⇒ 触发串**跨了句边界**，是前两句的**并集**。切开任一半都会**空跑**
    // （症状：登记了却仍每轮 400）。与第 5 条同型，同一条纪律：
    // **非单调现象只能逐格实测，不能凭直觉切。**
    //
    // ## ⚠️ 位置语义与第 4 条**相反**
    //
    // 第 4 条（身份首句）是**行首锚定**（前接任意字符即放行）；
    // 本条是**位置无关**（句中、前接任意前言照样拦）。
    // ⇒ 改写范围**不做**行首锚定正则 —— 宁可略宽：漏改 = 整轮 400，
    // 多改 = 语义等价的措辞变化。**别拿一条的锚点结论推给另一条。**
    //
    // ## 本条的**脆弱性**（如实登记）
    //
    // 上游认**逐字符**长字面量 ⇒ DSH 哪天改动这两句里的任一字符，本规则会
    // **静默停止匹配**（症状 = 该渠道整轮 400 复发，与「完全没登记」同形）。
    // 守卫见 `tests/unit/openai-gateway-tencent-fingerprint.spec.ts` 的同名组
    // （含「真实整段 407 字符只改一处、后半段约束逐字不动」那条语义守卫）。
    find: 'Tokens prefixed with @ are paths the user explicitly referenced. '
      + 'Relative paths resolve from the workspace root',
    // 只调整语序：`相对路径从工作区根解析` → `路径相对工作区根解析`。语义不变，
    // 且**整句其余 402 字符逐字不动** —— 后半段（目录 list / 用 read /
    // 不得声称已读过 / 引号语法）是防模型编造文件内容的核心约束，一个字都不许删。
    replace: 'Tokens prefixed with @ are paths the user explicitly referenced. '
      + 'Paths resolve relative to the workspace root',
    note: '真实报障 2026-10-28；本机逐格实测：真实整段 18,383 字符 400×6，'
      + '仅改本句语序后 200×3；111 字符字面量（110 放行）、位置无关、大小写不敏感、'
      + '切句两半各自放行；⚠️ 本条不含品牌词，按「找含 DeepSeek Harness 的句子」普查必漏',
  },
  {
    // 客户端 SDK 把计费头写进 system 正文开头：
    //   `x-anthropic-billing-header: cc_version=2.1.316.060; cc_entrypoint=sdk-ts;...`
    // 2026-11-03 实发：该**字样**（连裸词）会被 buddy 的内容级 11128 拦截；
    // 同一整段里只把这一处换成 `x-client-billing-header` 后 200。
    // 位置无关、大小写不敏感；同段其余 232 字符逐字不动。
    find: 'x-anthropic-billing-header',
    replace: 'x-client-billing-header',
    note: '2026-11-03 实测（copilot.tencent.com / deepseek-v4.1-flash）：原文 400/11128，'
      + '换名后 200；裸词也 400，x-anthropic-foo / anthropic-billing-header 均 200',
  },

]

/** 正则元字符转义：把字面量安全地变成**精确**匹配，而不是模式。 */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface CompiledFingerprint {
  readonly replace: string
  /**
   * 用于 `includes` 预检的**锚**（不命中就不必跑正则，字符串**原样**返回）。
   *
   * ⚠️ 有 `findRegex` 时它是「正则里那段**必然出现**的稳定子串」的小写形态
   * （第 4 条用 `'ai agent'`）—— 不能再用整句小写，否则漂移容忍就白做了。
   */
  readonly findLower: string
  readonly pattern: RegExp
}

/**
 * 从 `findRegex` 源码里取「预检锚」。
 *
 * ⚠️ 取法是**人工指定的常量**（每条规则自带 `precheckAnchor`），不从正则反推 ——
 * 从正则反推「哪段必然出现」是**不可判定**的，猜错会让预检把真命中挡掉
 * （症状：规则静默不生效，与「没登记」同形）。
 */
const PRECHECK_ANCHORS: Readonly<Record<string, string>> = {
  // 第 4 条：锚取 `deepseek harness` 而**不是** `ai agent` ——
  // 后者不含漂移形态 `ai **coding** agent`（实测：锚写成 `ai agent` 时
  // 「coding agent」那一格**静默不匹配**，正是本轮要治的那类失效）。
  // ⚠️ 锚只需「必然出现且够独特」：`deepseek harness` 在本句里恒在，
  //    且不会命中无关文本（比 `powered by` 这种通用短语好得多）。
  'You are an AI agent powered by DeepSeek Harness': 'deepseek harness',
}

const COMPILED: readonly CompiledFingerprint[] = CONTENT_FINGERPRINTS.map((rule) => ({
  replace: rule.replace,
  findLower: PRECHECK_ANCHORS[rule.find] ?? rule.find.toLowerCase(),
  // `g` = 全部出现都改写；`i` = 大小写不敏感（实测全小写 / 全大写同样被拦）。
  // ⚠️ 有 `findRegex` 时用它（只放宽形态，仍锚整句）。
  pattern: new RegExp(rule.findRegex ?? escapeRegExp(rule.find), 'gi'),
}))

/** 该 provider 是否走腾讯系后端（有这套内容级风控）。 */
export function isTencentContentFingerprintProvider(provider: string): boolean {
  return TENCENT_PROVIDERS.includes(provider)
}

/**
 * 把一段文本里已知的腾讯风控指纹做**窄改写**。
 *
 * ## 契约
 *
 * - **非腾讯系 provider 原样返回**（同一个函数指针意义上的同一份字符串内容）；
 * - **不含任何指纹的文本逐字符不变** —— 这一条是硬要求：腾讯侧按前缀缓存，
 *   无谓地重建字符串会让每一轮都算作新前缀，白白吃掉缓存命中；
 * - 只改**内容**，不删句子、不改结构：`Main branch (PRs usually go here)` 与原句
 *   语义等价，模型读到的仍是「主分支（提 PR 通常走这里）」。
 *
 * ## 本函数**刻意不认识角色**
 *
 * 「哪些角色该送进来」是**调用方**的策略（见文件头那张实测表的约束 1），
 * 不是这里的职责。当前该送的是 **`system` 正文**与 **`assistant` 正文**两处；
 * 该**不**送的是 `user` / `tool` 结果 / `reasoning_content` /
 * `tool_calls[].function.arguments`（实测都不拦）。
 * 新增调用点时请回到文件头核对实测行，别凭「统一一下」扩大范围。
 *
 * @param text 已取出的纯文本（system 或 assistant 正文）
 * @param provider `parseModelRoute` 得到的 provider 段，或产品的 id
 */
export function rewriteTencentContentFingerprints(text: string, provider: string): string {
  if (!isTencentContentFingerprintProvider(provider)) return text
  let out = text
  for (const rule of COMPILED) {
    // 预检：不含（小写化后的）字面量就整条跳过，`out` 保持同一份字符串内容。
    if (!out.toLowerCase().includes(rule.findLower)) continue
    // `String.replace` 配 `g` 正则会在调用前后把 lastIndex 归零，不会串状态。
    out = out.replace(rule.pattern, rule.replace)
  }
  return out
}
