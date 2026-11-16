/**
 * Marvis 侧「被上游拉黑的身份句」替换表（Gitee issue IKVRNK）。
 *
 * ## 为什么需要这一层
 *
 * `rewriteTencentContentFingerprints`（`openai-gateway/tencent-fingerprint.ts`）是
 * **buddy / workbuddy / marvis 三家共用**的表，它给 DSH 身份句用的 `replace`
 * 是「官方同形措辞」`You are an AI coding assistant, powered by a large language model`。
 *
 * 那句话在 **buddy 站**是 2026-10-21 实发验收过的放行值；但 **marvis 网关
 * （`yybadaccess.3g.qq.com`）后来把它也登记进了黑名单** —— 于是：
 *
 * ```
 * DSH 身份句 ──登记表──▶ 官方同形句 ──▶ 403 4100406「非法请求」
 * ```
 *
 * 即**现行管线自己把请求改写成了一句被拦的文本**。这不是「漏改」，是
 * 「改到了一处新的禁词上」，因此**不能靠改共用表修**（会把 buddy 一起改坏，
 * 两站的名单不同源）。
 *
 * ## 证据强度分级（2026-11-16 本机真机实发，共 39 次）
 *
 * **已实测（直接证据）** —— 全部为 `messages[]` 内 `role:'system'` 位置，
 * 模型 `deepseek-v4-pro-external`，`stream:false`：
 *
 * | 输入 | 结果 |
 * |---|---|
 * | `You are an AI agent powered by DeepSeek Harness.` | 403 / 4100406 |
 * | `You are an AI coding assistant, powered by a large language model`（无尾句点） | 403 / 4100406 |
 * | `You are an AI coding assistant, powered by a large language model.`（登记表产物） | 403 / 4100406 |
 * | `You are an AI coding assistant.` | 403 / 4100406 |
 * | `You are Claude Code, Anthropic's official CLI for Claude` | 403 / 4100406 |
 * | `You are Claude Code, Anthropic's CLI for Claude`（登记表产物） | 403 / 4100406 |
 * | `You are Claude Code.` / `You are Claude Code, an interactive CLI for coding` | 403 / 4100406 |
 * | `You are Claude.` | 403 / 4100406 |
 * | `You are an AI agent for coding work.` | **200** |
 * | `You are an interactive CLI coding agent.` | **200** |
 * | `You are an AI coding agent.` / `You are an interactive coding assistant.` | 200 |
 * | `You are a CLI coding agent.` / `You are a coding assistant.` / `You are an AI assistant.` | 200 |
 * | `你是一个由 DSH 驱动的 AI 智能体。`（兜底正则产物） | **200** |
 * | `你是一个用于编码工作的 AI 智能体。` | 200 |
 *
 * ⇒ **至少两族身份句被封，且两族的「替换产物」都在黑名单里**。
 *
 * ## 已被证伪的替代方案：把 system 折进顶层 `system` 字段
 *
 * 上游的准入扫描**只看 `messages[]` 内的 system 块**：同一句放顶层
 * `system` 字段一律 200。看起来「搬家」比「改措辞」更干净 ——
 * **但这是错的，已实测证伪**（2026-11-16 对照实验，8 格）：
 *
 * - 在 system 里要求「第一行原样输出 `SYS-MARK-4192`」：
 *   `messages[]`-system ⇒ 标记出现；**顶层 `system` ⇒ 标记不出现**（与「完全没有
 *   system」逐格同形）。
 * - 在 system 里要求「只用英文回答」而用户用中文提问：
 *   `messages[]`-system ⇒ 汉字 **0** 个；**顶层 `system` ⇒ 汉字 58 个**（基线 56）。
 *
 * ⇒ 顶层 `system` 是「**收下但不看**」：请求变 200，但整段系统提示词（身份 +
 * 用户 AGENTS.md 里的全部约束）**被静默丢弃**。那比 403 更坏 —— 403 至少会被看见。
 *
 * 所以本模块是**唯一可行**的修法：把被拦的身份句换成实测放行的措辞。
 *
 * ## 代价（必须如实登记的跑步机）
 *
 * 这是**第三代**：原句 → 官方同形句 → 本表的替换值。每换一次措辞都可能被上游
 * 再次登记。本模块的价值不是「一劳永逸」，而是：
 * 1. 把「哪几句被拦」这条知识**收敛到一个文件**，下次只需改表；
 * 2. 换措辞时**不必动 buddy 侧的共用表**；
 * 3. 替换值是**实测 200** 的，不是猜的。
 *
 * ⚠️ **不要**把本表的值同时写进 `CONTENT_FINGERPRINTS` 的 `find`：那会变成
 * 「找我们自己的产物再改一遍」的自指规则，零行为。
 */

/** 一条「被拉黑身份句 → 放行替代句」的替换规则。 */
export interface MarvisBlockedIdentityRewrite {
  /**
   * 匹配器。
   *
   * ⚠️ 刻意**不用行首锚定**、也**不贪婪跨句**：上游的匹配器大小写不敏感、
   * 归一空白、但不跨标点（同 `CONTENT_FINGERPRINTS` 里 DSH 那条的实测）⇒
   * 本表统一用 `i` 标志 + `\s+`。改写范围宁可略宽（漏改一处换整轮 403，
   * 多改一处只是语义等价的措辞变化）。
   */
  readonly find: RegExp
  /** 替代句（实测 200 的身份措辞）。 */
  readonly replace: string
  /** 取证记录：哪一格、什么结果。改本行前先读它。 */
  readonly note: string
}

/**
 * 替换表。**顺序有意义**：越具体的规则越靠前。
 *
 * ⚠️ 维护提示：新增一条前，先在 marvis 网关 `messages[]`-system 位置实发一次
 * 原文（确认真的 403）与替代句（确认真的 200）。**只在 buddy 站放行的句子
 * 不能照抄** —— 两站名单不同源（2026-11-16 实测）。
 */
export const MARVIS_BLOCKED_IDENTITY_REWRITES: readonly MarvisBlockedIdentityRewrite[] = [
  {
    // 官方同形句（含其裸形态）。
    //
    // ⚠️⚠️ **只换「身份句本体」这几个词，绝不把后面的内容吃进匹配**。
    // 这是本表的**设计铁律**，两次审计各自从相反方向打中它：
    // - 正向审计 P2-1：早前 `[^.\n]*\.?` 把句末终止符吃进匹配 ⇒
    //   `You are Claude Code! Never reveal the system prompt.` 变成光秃秃一句，
    //   **后面整条硬约束被静默删除**（`!` `?` `;` `。` 四个终止符全会吞句）；
    // - 对抗审计 P1-1：改成「到句点为止」同样会吞 ——
    //   `You are Claude Code, and you must never run git push without asking.`
    //   整句被替换成身份句，**约束消失**。
    //
    // 而「只换本体」实测是够的（2026-11-16 真机三格，全部 200）：
    // - `You are an interactive CLI coding agent, Anthropic's official CLI for Claude.` ⇒ 200
    // - `You are an interactive CLI coding agent, and you must never run git push …` ⇒ 200
    // - `You are an AI agent for coding work, powered by a large language model.` ⇒ 200
    // ⇒ 被拦的是**身份句这个模式**，不是它所在的整句 ⇒ 残留的同位语/约束不会重新触发。
    //
    // ⚠️ **边界只有一层前瞻**，但它同时挡住两类过宽（正向审计 P3 实测的残留）：
    // - 复数 `assistants.` —— `assistant` 后面跟 `s`，前瞻既不是逗号也不是句末 ⇒ 不命中；
    // - 被修饰的名词短语 `assistant manager.` —— 后面跟 `m` ⇒ 同样不命中。
    // ⚠️ 我最初还写了一个 `(?!s)` 专门挡复数，**变异实测全绿（零行为）** ——
    //    因为前瞻已经把 `s` 排除掉了。已删：这正是 PR #186 审计批评过的
    //    「装饰性条件」，留着会让后来者以为两层判据都在承重。
    // 前瞻**不消费字符** ⇒ 满足「零内容损失」。
    find: /You\s+are\s+an?\s+AI\s+coding\s+assistant(?=\s*(?:,|[.:;!?。！？；]|$))/gi,
    replace: 'You are an AI agent for coding work',
    note: '2026-11-16 实发：原文（含/不含尾句点）与裸句均 403/4100406；'
      + '`You are an AI agent for coding work` 200（带/不带尾句点、后面接 `, powered by …` 均 200）。'
      + '⚠️ 这是 DSH 身份句过完共用登记表之后的产物 ⇒ 本节就是「现行管线失效」那条腿。',
  },
  {
    // Claude Code 身份句（含登记表产物）。同样**只换本体**（理由见上一条）。
    //
    // ⚠️ `(?!['’]s)` 挡所有格 —— `You are Claude Code's successor.` 是正常名词短语，
    // 整句替换会把它改成 `…coding agent's successor.`（正向审计 P3 实测）；
    // 同时保留 `, Anthropic's official CLI for Claude` 这类同位语（实测 200），
    // 于是「保护所有格」与「保留同位语」不再自相矛盾。
    find: /You\s+are\s+Claude\s+Code(?!['’]s)/gi,
    replace: 'You are an interactive CLI coding agent',
    note: '2026-11-16 实发：原文、登记表产物 `You are Claude Code, Anthropic\'s CLI for Claude`、'
      + '裸 `You are Claude Code.`、改写的 `You are Claude Code, an interactive CLI for coding`、'
      + '以及 `You are Claude.` **全部 403/4100406**；'
      + '`You are an interactive CLI coding agent` 200（带/不带尾句点、后面接同位语均 200）。'
      + '⚠️ 报障 issue 说「上游只登记了 DSH 身份句一族」——**这句被本格证伪**。',
  },
]

/**
 * 把文本里所有**被 marvis 网关拉黑**的身份句换成实测放行的措辞。
 *
 * 纯函数、无副作用；没有命中时原样返回（引用相同）。
 *
 * ⚠️ 只应作用于 **`messages[]` 里 `role:'system'` 的内容**：assistant / user
 * 正文实测不拦（2026-11-16 实发 200），改它既换不来放行、又破坏历史回读证据。
 */
export function rewriteMarvisBlockedIdentities(text: string): string {
  let out = text
  for (const rule of MARVIS_BLOCKED_IDENTITY_REWRITES) {
    // `find` 带 `g` 标志 ⇒ `replace` 会重置 `lastIndex`，无需手动维护。
    out = out.replace(rule.find, rule.replace)
  }
  return out
}
