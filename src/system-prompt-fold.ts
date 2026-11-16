/**
 * 把「请求体顶层的 `system`」折进 `messages[]`（OpenAI 兼容渠道的通用修法）。
 *
 * ## 为什么
 *
 * 这批渠道的网关**只从 `messages[]` 读系统提示词**，请求体顶层的 `system` 字段被
 * **静默忽略** —— 请求 200、正文正常、上游零报错，只是模型完全不知道 system 存在。
 *
 * 2026-11-17 真机三渠道实测（判据是「模型有没有收到我写的字面量」，不是 HTTP 码）：
 *
 * | 渠道 | 顶层 `system` | `messages[]`-system |
 * |---|---|---|
 * | marvis | 200 但**没收到指令** | 200 且收到 |
 * | modelscope | 200 但**没收到指令**（回复「Hi! How can I help you today?」） | 200 且收到 |
 * | qiniu | 未验证（本机无凭据；OpenAI 兼容 `/chat/completions`，同源风险） | 未验证 |
 *
 * ⚠️ **`baizhi` 不在修法范围内，那是误报**：`src/baizhi-messages.ts` 构造的是
 * **Anthropic Messages**（`max_tokens` 必填、`stop_sequences`、`tools[].input_schema`），
 * 而 Anthropic 协议里 `system` **本来就是顶层参数**。实测 baizhi 顶层 `system`
 * 模型确实收到了 —— 挪进 `messages[]` 反而会造出非法角色。**别把它「统一」进来。**
 *
 * ## 影响面
 *
 * 需要 system 的**辅助请求**（auto-review 风险评审、session-title）在这些渠道上拿不到
 * 策略：模型收不到「按要求输出 JSON」这类指令 ⇒ 输出散文 ⇒ 上层 `JSON.parse` 失败 ⇒
 * 评审 fail-closed 拒绝 ⇒ Auto 预设下所有工具调用无法执行（而且想关掉 auto-review
 * 也要过同一条评审，形成死锁）。
 *
 * ## 为什么是一个函数、而不是三份内联拷贝
 *
 * 仓库红线「同一判据只留一份实现」。三个 builder（marvis / modelscope / qiniu）
 * 各自内联一份 `{ system }` 的写法是这次缺陷的成因之一 —— 加一处、忘两处。
 *
 * ## 调用位置
 *
 * 必须写在**构造 payload 的函数里**（`build*Payload`），不是 adapter 里：
 * builder 才是把 `system` 写成 wire 字段的那一处。两边都写会出现第二份判据，
 * 删掉任一处都不红（本仓踩过同型的坑）。
 */

/** 折进去的那条 system 消息（与 OpenAI 的 `messages[]` 成员同形）。 */
export interface SystemMessageLike {
  role: 'system'
  content: string
}

/**
 * `system` 非空时，作为**第一条** `messages[]` 成员返回；否则原样返回入参。
 *
 * 刻意**不**去重、不合并：`options.system` 与 `messages[]` 里可能已存在的 system
 * 是两件不同的事（前者是本次辅助请求的策略，后者是对话历史的一部分），
 * 合并文本会改变语义。多条 system 是协议允许的。
 */
export function foldSystemIntoMessages<T extends Record<string, unknown>>(
  messages: ReadonlyArray<T>,
  system: string | undefined,
): ReadonlyArray<T | SystemMessageLike> {
  if (system === undefined || system.length === 0) return messages
  return [{ role: 'system', content: system }, ...messages]
}
