# e2e 测试说明（重要：部分用例会消耗真实积分）

本目录下的用例会访问**真实线上后端**。请务必按下表理解每个文件的行为，
不要用「一把梭跑整个目录」的方式运行。

## ⚠️ 会消耗模型积分（发真实 chat/completions 请求）

| 文件 | 闸门 | 说明 |
|------|------|------|
| `buddy-models.e2e.spec.ts` | `DSH_BUDDY_E2E=1` + `DSH_BUDDY_E2E_CONFIRM=yes` | 用适配器拉取 CodeBuddy 模型并逐个发一次对话 |
| `buddy-cache-probe.e2e.spec.ts` | `DSH_BUDDY_E2E=1` + `DSH_BUDDY_E2E_CONFIRM=yes` | 直连 `/v2/chat/completions`，发 3 组前缀做缓存对比 |
| `buddy-pool-probe.e2e.spec.ts` | `DSH_BUDDY_POOL_E2E=1` + `DSH_BUDDY_POOL_E2E_CONFIRM=yes` | 用账号池凭据走完整 LLM 链路 |
| `buddy-ratelimit-probe.e2e.spec.ts` | `DSH_BUDDY_RATELIMIT_E2E=1` + `DSH_BUDDY_RATELIMIT_E2E_CONFIRM=yes` | 对记录「限额重置」的账号实发一次请求，**判定是否真限流** |
| `trae-channels-probe.e2e.spec.ts` | `DSH_TRAE_E2E=1` | 拉真实多通道目录，并用**真实适配器**对 `glm-5.1`（agent 通道）与 `glm-5-turbo`（work 通道）各发一条最短消息 —— **验证「模型只在列出它的通道里可调用」**。消耗 2 次极小额度 |
| `cline-chat-probe.e2e.spec.ts` | `DSH_CLINE_CHAT_E2E=1` + `DSH_CLINE_CHAT_E2E_CONFIRM=yes` | **默认只请求 `cline-free/mimo-v2.6-flash`**（用户指定的日常验证模型）。其余免费模型需 `DSH_CLINE_CHAT_E2E_ALL_FREE=1` 才遍历。**付费模型一律拒绝请求**（见下「Cline 探针的付费保护」） |
| `image-burst-cross-provider.e2e.spec.ts`（`pnpm test:e2e:image-burst`） | `DSH_IMAGE_BURST_E2E=1` + `DSH_IMAGE_BURST_E2E_CONFIRM=yes` | **issue !IKITT9 的图片压力探测**（跨 provider）。腾讯两站各一组：原图 15 张必须报 `prompt is too long` 且归成 `CONTEXT_WINDOW_EXCEEDED`、缩放后同张数必须过、且**缩到 1011×632 后模型仍读得出截图地址栏**（这条是预算档位的正当性来源）。另含 qoder / cline / lobsterai / raccoon / trae / loomy 各一组。⚠️ 单次请求带十几张图，**消耗明显**（全跑约 8 分钟）；缺 fixture 时整体跳过（见下） |
| `image-limit-bisect.e2e.spec.ts`（`pnpm test:e2e:image-bisect`） | `DSH_IMAGE_BISECT_E2E=1` + `DSH_IMAGE_BISECT_E2E_CONFIRM=yes` | **loomy / trae 的边界二分复测**（Gitee issue IKKX0T）。⚠️ 比上面那个**贵得多**（二分每步都是一整轮十几张图）。用途是复核两条**已被第三方实测质疑**的既有结论：loomy「24 张全过、无约束」、trae「未探到边界」。**二分出边界后才能定 `imageMaxBytes`**（本仓库规矩：拿不到阈值就不定值）。文件内含一条**离线判据用例**（零额度，不受闸门约束） |
| `buddy-fingerprint-roles.e2e.spec.ts`（`pnpm test:e2e:buddy-fingerprint`） | `DSH_BUDDY_FINGERPRINT_E2E=1` + `DSH_BUDDY_FINGERPRINT_E2E_CONFIRM=yes` | **腾讯系内容级风控的「角色矩阵」实测凭据**（每例 `max_tokens=16`，被拒不耗额度）。断言 `system` 与 **`assistant` 正文**含指纹会被 400/11128，而 `user` / `tool` 结果 / `reasoning_content` / `tool_calls.arguments` **放行**。⚠️ **不可省**：那四行结论已被写进 `src/openai-gateway/tencent-fingerprint.ts` 的**实现约束**（决定改写范围），单测只能锁「代码按那个范围做」，**锁不住那个范围本身对不对**。2026-10-12 的翻车正是「`assistant` 那一格从未测过」。⚠️ 另含 **IKLS2L 的 Claude Code 身份句**一节：两站分别实测「被拦 → 改写后放行」，并**两侧都测锚点**（该指纹是**行首锚定**，前接任意字符即放行 —— 与 ZCode 那条「位置无关」**相反**），以及「第三个常量 `af` 实测放行 ⇒ 刻意不登记」的反向断言。⚠️ **第三条指纹（IKLYCT 的 Claude Code 反馈句）**：该句属于 Claude Code system 的**固定段落** ⇒ **每轮必带**（身份句只约 34% 窗口靠漏传前缀）；本节**两站各测一遍**（结清 issue 的「workbuddy 未验证」项），并实测「砍掉前半/后半 ⇒ 放行」以定死 `find` 必须写整句、锚点**位置无关**（与身份句相反）。⚠️⚠️ **探针必须先把账号筛一遍**：`11128` 有两个同码子原因（`unapproved channel` = 内容级 / `request illegal` = **按账号**的渠道门控 IKM7SG），轮换账号会把后者读成内容指纹的匹配语义 ⇒ 实测出「短前缀被拦、长超集放行」的**非单调**假结论。⚠️ 探针**必须带 `stream:true`**：两站对非流式请求都回 `11101 Non-stream chat request is currently not supported`，不带它会把「不支持非流式」**误读成风控拦截**。⚠️ **第四节 = 第四条指纹（DSH 自己的 `base` 身份首句）**：`buddy` 站裸串仍 `400/11128`、换成官方同形措辞后拿到**干净 200**（那是**换措辞的验收条件**）；⚠️⚠️ **该句是端点相关的** —— `www.workbuddy.ai` 对同一句**两模型实测均不拦**（登记时只测过 copilot 站 ⇒ 本节第一版照抄邻节的「两站都测」写法，把没测过的那格当成已知，实测当场红）。⚠️ 本节顺带修了**四个探针缺陷 + 一条既有夹具缺陷**（都会让「跑不通」看起来像「指纹结论」）：按站取凭据（原先两站共用一个 CodeBuddy 账号 ⇒ 国际版恒 401）、复用 `image-probe-shared.ts` 的 `credentialFor()`（YAML 单引号标量会**折行** ⇒ 按行正则读不到任何 workbuddy 凭据）、头全部由 `src/product.ts` 现算（原先两站硬编码同一套 CodeBuddy 头值 ⇒ 国际版恒 `11128/request illegal`）、**落地「先筛基线放行的账号再固定用它」**（原先钉第一个账号 ⇒ 第一个被限流时每条断言都红在 429）、以及 `loadTriggerLine()` 取到的文档行含 `$Js="…"` 双引号 ⇒ 替换进 JSON 文本会抛 `Expected ',' or '}'`（角色矩阵两条用例根本跑不起来）。2026-10-21 全文件 **45/45** 通过（`deepseek-v4.1-flash`，两轮一致）。⚠️⚠️ **第五节 = 第五条指纹「DSH Web 运行面那两句」**（`dsh-harness-dev-context` 的 `WEB_SURFACE_PROMPT` 前两句，221 字符；该插件**只在 Web 运行时挂载** ⇒ CLI / 桌面面的「真实整段」测不到它）：2026-10-21 真实报障「只改第 1 行仍被拦」的**真凶** —— 它**单独就能拦**且**位置无关**，而裸 token `DeepSeek Harness` **放行**（不是「认 token」）；`find` 必须写这 221 字符（**220 前缀放行、切句两半各自也放行** ⇒ 写短 / 写散都**空跑**）。本节含那条**要害格** `★★`：**多出现位置** —— 只改第 1 行 ⇒ 仍被拦（报障现场）、两处都改 ⇒ 放行；这正是「**只测单句的用例永远抓不到这一格**」那句话的落点。⚠️ 载荷是**同形文字**（与 DSH 源码解耦）：它锁得住「换措辞会被拦」，**锁不住**「DSH 改了那两句而 find 没跟上」—— 后者由单测里那条**读本机会话落盘**的漂移守卫管（CI 上会 skip）。 |
| `buddy-conversation-headers.e2e.spec.ts`（`pnpm test:e2e:buddy-conv`） | `DSH_BUDDY_CONV_E2E=1` + `DSH_BUDDY_CONV_E2E_CONFIRM=yes` | **`X-Conversation-*` 三头准入必要性的真机对照凭据**（IKM73W + **IKM7SG**）。⚠️ **不可省**：三头的必要性是「**按账号**」的 —— 维护者约 90 次复测在**一个账号**上证伪了「缺任一即 400/11128」，而 **IKM7SG 只换 `WB_REF`** 就在**另一个账号**（`66E05E7C`）上复现了「三枚缺一即 400」⇒ **两批都对，差的是账号**。判据 = 「三枚 Conv 头同时存在且非空」，不校验值语义、**逐请求**判定（`200→400→200`）。**单测锁不住这些** —— 它们是「范围本身」⇒ 只能靠本文件固定。两组：① 逐枚消融（含三枚全删）；② 发 `X-Conversation-ID: abc123…` 断言回包 `id` 含该标记。⚠️ 已按 IKM7SG 改为**逐账号**跑 + **按归因分类**：`account-gated`（该账号要求三头 ⇒ 跳过，**不是**上游行为变更）/ `no-verdict`（额度耗尽 / 用错模型 ⇒ 跳过并说「本轮无判据」）/ `other` 才红。⚠️ `DSH_BUDDY_CONV_E2E_FIRST_ONLY=1` 可退回只跑池里第一个账号（省额度）。⚠️ `WB_MODEL` 默认 `fast-model`，**别用 `deep-model`**（实测 11102 `service info not found`，会掩盖判据） |
| `buddy-first-message-role.e2e.spec.ts` | `DSH_BUDDY_FIRSTMSG_E2E=1` + `DSH_BUDDY_FIRSTMSG_E2E_CONFIRM=yes` | **「wire 首条角色」实测凭据**。断言 `space-bunny` 在「首条是带 tool_calls 的 assistant」时回 400/**11148**（`displayMsg.zh`=「工具记录不完整，请新建任务」），而 `step-5-preview` **容忍同一形状**。⚠️ 「换个模型就好」是假解法。该判据写死在 `buddy-adapter.ts` 的 `stream()` 里，且 2026-10-12 的审计在**判据本身上**抓到一个真缺陷（初版写 `=== 'assistant'`，漏掉 user-first / tool-first） |
| `accio-chat-probe.e2e.spec.ts` | `DSH_ACCIO_CHAT_E2E=1` + `DSH_ACCIO_CHAT_E2E_CONFIRM=yes` | 发一条极小请求。**默认用全目录最低倍率模型** `1Drift-N8kP2Q7wR5mX`（x0.013，实测最低）。可用 `ACCIO_PROBE_MODEL` 覆盖，⚠️ **未知 id 直接拒绝**、倍率超 x0.2 需 `ACCIO_PROBE_ALLOW_EXPENSIVE=1` |
| `accio-tools-probe.e2e.spec.ts` | `DSH_ACCIO_TOOLS_E2E=1` + `DSH_ACCIO_TOOLS_E2E_CONFIRM=yes` | 工具调用**往返**（带 tools → 结构化 `tool-call` → 回传结果 → 最终正文）+ **思考链分离逐字对账**。⚠️ 另断言 `accioToolCallMergeTransform` 真的生效：同一个 id **恰好一个块**且参数**非空**（未合并会变成「N 个块 + 首块 `{}`」⇒ harness 把同一工具执行 N 次） |
| `accio-image-probe.e2e.spec.ts`（`pnpm test:e2e:accio-image`） | `DSH_ACCIO_IMAGE_E2E=1` + `DSH_ACCIO_IMAGE_E2E_CONFIRM=yes` | **图片通路**（issue IKLR7V 的验收与**证据留存**，见下）。经**生产适配器全链路**发一张**现场生成**的 16×16 四象限纯色 PNG（左上红/右上绿/左下蓝/右下白），判据三条同时成立：**没抛错 + 字节桥接真被调用 + 四色全对**。另含纯文本对照，以及 ⚠️⚠️ 「`multimodal:false` 的模型带图必须被**本地拒绝**」——实测上游对它是**静默忽略图片**（GLM 5.1 会据此**幻觉**出四个颜色），这条是本家 `inputModalities` 写 `['text']` 的**唯一依据**，单测锁不住 |

## ⚠️ 图片探针的 fixture 不入库

`tests/fixtures/test.png`（2560×1600）被 `.gitignore` 忽略 —— 它是**真人桌面截图**
（含浏览器标签页用户名、搜索框检索词、整屏热搜），而本仓库公开，
一旦 commit 就**永久留在 git 历史**里，事后删文件/改写历史都清不干净。

要跑这些探针：自备一张 **≥2000×1200 且不含个人信息**的截图放到该路径。
尺寸决定撞墙张数（每图面积 ÷ ≈617 = 视觉 token），内容只用来验证
「缩放后还认不认得出小字」。缺文件时探针**整体跳过**并打印指引（不会 ENOENT 崩）。


## ⚠️ 图片探针的四条硬规矩（重测前必读）

1. **必须先跑 0 张基线**。第一版探针直接上 15 张，qoder 报 `TRANSPORT`、
   raccoon 报 `AUTH 200003`（那账号缺 `office_identity`）—— 两个都**不是**图片
   问题，却被读成「撞墙了」。`image-probe-shared.ts` 的 `PROBE_COUNTS` 首位是 0，
   且 `classifyFailure` 会把 `transport` / `auth` 与 `overflow` 分开，
   **只有 `overflow` 才算图片预算**。别为了省时间把基线删掉。
2. **要逐个账号验号**。实测本机 8 个 qoder 账号里 4 个 `refresh_token` 已失效、
   3 个当日额度耗尽，只有 1 个可用。⚠️ 且**不能强制续期才肯用**
   （第一版的真实 bug）：刚登录的新号续期反被拒 → 被跳过 → 落到一个签名有效
   但额度耗尽的旧号上，于是把「探测做不了」误报成「网关没有上限」。
   判据是「**先看是否过期**，未过期直接用；再用一次无图请求验号」。
3. **张数必须用互不相同的 `attachmentId`**（`imageBlocks()` 已如此实现）。
   `collectImages` 按 id 去重，复用同一 id 会把 15 张压成 1 张 ——
   探针「顺利跑完」却一点图片压力都没造出来，是最难发现的空测。
4. **断言结果之前，先断言「缩放真被调用了」**（`makeScaleBridge(...).stats.length > 0`）。
   本轮真踩到：e2e 里把 `makeScaleBridge(fixture)`（`{bridge, stats}` 包装对象）
   误当函数注入 `readImageRequest`，适配器一调用就抛错，而
   `projectRequestImage` 的 `try/catch` 把异常兜成「**回退原图**」——
   症状于是是「**缩放后照样 413**」，看起来像字节目标定小了，**实际是根本没缩放**，
   白跑一轮 90 秒真机探测并得出错误结论。
   ⇒ 凡是「失败就回退到旧行为」的兜底，旁边都必须有一条
   「兜底是否被触发」的可观测证据；否则接线错误会伪装成产品缺陷。

## 各家已实测的图片边界（fixture 2560×1600 ≈6,639 token/张）

⚠️ **表里必须带「什么时候、哪个账号」**：下面 trae 那格就是**被下一轮推翻**的例子。

| provider | 原图边界 | 缩放后 | 撞的是什么 |
|---|---|---|---|
| buddy / workbuddy | ⚠️ **区间 `(8,15]`**（本仓库固定序列首挂于 15；issue IKKX0T 二分到 `(10,12]`，落在本区间**内部**） | 通过 | **图片视觉 token 预算**（⚠️ 报文里的 `100001` 是**常量哨兵** = limit+1，**不能**拿它反推 token 数） |
| raccoon | **4 张** | **24 张全过** | **请求体字节**（10 MB 硬限） |
| qoder | 8 过 / **15 张**（≈57 MiB） | **24 张全过** | 请求体体积 |
| lobsterai | 12 过 / **13 张**（≈50 MiB，`SERVER code=500`） | **24 张全过** | 请求体体积（500 不是准入报文） |
| cline | 24 全过 / **32 张**（≈122 MiB） | **32 张全过** | 请求体体积 |
| loomy | ⚠️ **本仓库记「24 张全过」，但该结论已被 issue IKKX0T 质疑** | 未测（无必要？**不再成立**） | **请求体体积** —— 本仓库 24 张 = **91.8 MiB**，恰落在 issue（3.45 MiB/张）的 87.4~96.6 MiB 区间**内** ⇒「全过」很可能是**侥幸通过** |
| trae | ⚠️ **本仓库记「未探到边界」；issue IKKX0T 实测 (21,24] 张** | 24 张全过（探索性） | **请求体体积**（`code=4006 content is too large`；该码的**归类已修**，见 `docs/agent-notes/providers-trae.md`）|

⚠️ **trae 那一格是本文件最该记住的教训**：上一轮同一账号对 `deepseek-v4.1-flash`
与 `glm-5.3-flash` 都回 `4001 param is invalid`（适配器诊断「仅可见但不可调用」），
于是登记成「探测无效」。**本轮同一账号、同一模型，1 张直接成功、缩放后 24 张也全过**
—— 说明那是**账号/服务端的临时状态**，不是模型的固有属性。
⇒ 与 Qoder「无签到」误判同型：**「某次实测没看到」不能推广成「不存在」**。
引用否定性结论时必须带上当时条件，下次探测**先重验这条结论本身**。
但**也不要因此给 trae 定预算值** —— 它的原图边界仍未探，「拿不到阈值就不定值」不变。

> 结论与预算取值记在 AGENTS.md 的「图片必须按像素预算发请求版本」一节。
> ⚠️ 只有腾讯系真有「图片 token 预算」；其余撞的是体积。**两种约束都只能靠缩放解决，
> 但旋钮不同**（token 看像素、体积看编码字节），所以各家阈值**不能互相套用**。
> ⚠️ 腾讯两站**共用同一个 `BuddyAdapter` 类**，但走不同 endpoint ——
> 「buddy 过了」**推不出** workbuddy 也过，本表两站已分别实测。



> LobsterAI **没有**发 chat 请求的 e2e —— 它的对话链路可在 Jet Hub 里人工验证
> （选一个模型发一句话即可），单独写探针的边际价值低于维护成本。
> 认证与签到已有只读探针（见下表）。

## 不消耗模型积分

| 文件 | 闸门 | 说明 |
|------|------|------|
| `qoder-chat-probe.e2e.spec.ts` | `DSH_QODER_CHAT_E2E=1` + `DSH_QODER_CHAT_E2E_CONFIRM=yes` | 发一次推理请求验证 SSE，并**验证续期接受本插件生成的 `machine_id`**。默认模型 `qmodel_38max`（**免费额度**）；设 `DSH_QODER_MODEL` 可换付费模型（那时会消耗积分） |
| `v4-models.e2e.spec.ts` | `DSH_CODEARTS_E2E=1` | deepseek-v4-flash / pro（**每日 1000 万免费 Tokens**） |
| `v4-large-write.e2e.spec.ts` | `DSH_CODEARTS_E2E=1` | deepseek-v4-flash 大文件写入（同上，免费额度） |
| `login.e2e.spec.ts` | `DSH_CODEARTS_E2E=1` | 只走 CodeArts 浏览器登录与凭据换取 |
| `buddy-login-probe.e2e.spec.ts` | `DSH_BUDDY_PROBE=1` | 只打印登录流程原始响应，不发模型请求 |
| `workbuddy-claim-probe.e2e.spec.ts` | `DSH_WORKBUDDY_CLAIM_E2E=1` + `DSH_WORKBUDDY_CLAIM_E2E_CONFIRM=yes` | 真实领取积分（不改模型额度，但会改动账号当日签到状态） |
| `lobsterai-probe.e2e.spec.ts` | `DSH_LOBSTERAI_E2E=1` | **只读**：凭据结构、客户端版本号动态解析、签到槽位/上下文、积分余额。**不签到、不发模型请求** |
| `lobsterai-claim-probe.e2e.spec.ts` | `DSH_LOBSTERAI_E2E=1` + `DSH_LOBSTERAI_CLAIM_E2E_CONFIRM=yes` | 真实签到（会改动当日签到状态；**不消耗模型积分**，且重复运行幂等） |
| `codearts-credits-probe.e2e.spec.ts` | `DSH_CODEARTS_E2E=1` | **只读**：凭据结构、**账户类型检测**（`is_credit_package`）、积分余额、活动列表。**绝不领取** |
| `codearts-claim-probe.e2e.spec.ts` | `DSH_CODEARTS_E2E=1` + `DSH_CODEARTS_CLAIM_E2E_CONFIRM=yes` | 真实领取积分（会改动当日领取状态；**不消耗模型积分**，重复运行幂等） |
| `zcode-identity-probe.e2e.spec.ts` | `DSH_ZCODE_E2E=1` | **ZCode 3012 的「版本 × 身份块同代」真机准入**（Issue #45）：用**生产配置**（`buildZcodeHeaders` 的门槛版本 + `buildZcodeSystemBlocks` 的 3 块 + 首轮日期块）发 1 发，断言**不是** `405 + 3012`。⚠️ 判据是「不是 3012」而不是「HTTP 200」—— 免费额度耗尽回 `200 + 1005`，那说明**准入已过**（用 `=== 200` 会把「额度用完」误报成「身份块过时」）。单测锁不住「这一对过不过上游」 |
| `codearts-ua-probe.e2e.spec.ts` | `DSH_CODEARTS_E2E=1` | **华为 WAF 的 UA 前缀查验**（2026-11-05）：断言 chat 请求的 `user-agent` 逐字等于官方 IDE 的 `codearts/1.0.0-1147257973136832`，且上游真出流。⚠️ WAF 拒发 `deepseek-harness/` 前缀（403 `TM.00000001`）⇒ 客户端把 `AUTH` 换成「API 密钥无效」。单测锁不住「那个 UA 过不过 WAF」（上游策略），只能靠本文件。消耗 1 次极小额度 |
| `qoder-probe.e2e.spec.ts` | `DSH_QODER_E2E=1` | **只读**：凭据结构（含 `machine_id`）、令牌对 `/api/v1/userinfo` 的有效性、静态兜底模型表。**不发模型请求、不续期** |
| `qoder-credits-probe.e2e.spec.ts` | `DSH_QODER_E2E=1` | **只读**：**逐账号**签到状态（`dailyCredit` / `todayCheckedIn` / 活动 key），并校验**设备身份（`Cosy-MachineToken` + `Cosy-MachineType`）确实生效**。**绝不领取**。⚠️ 覆盖「多账号下第二个账号看不到可领活动」这一缺陷 —— 单测配置刻意禁用了 `runtime-info.exe`（见下「Qoder 设备身份为何只能在 e2e 里验证」），故它唯一的自动化回归就在这里 |
| `trae-probe.e2e.spec.ts` | `DSH_TRAE_E2E=1` | **只读**：凭据结构（含 machine_id / device_id）、积分余额、签到状态、远端模型列表。**不签到、不发模型请求** |
| `trae-claim-probe.e2e.spec.ts` | `DSH_TRAE_E2E=1` + `DSH_TRAE_CLAIM_E2E_CONFIRM=yes` | 真实签到（会改动当日签到状态；**不消耗模型积分**，且重复运行幂等） |
| `cline-probe.e2e.spec.ts` | `DSH_CLINE_E2E=1` | **只读**：凭据结构（含 `account_id` 与 `workos:` 前缀）、**前缀不可剥的现场证据**（带前缀 200 / 剥掉 401）、积分余额（打印原始值供核对单位）、远端 `free` 集合与 `/models` 目录。**不发模型请求、不续期** |
| `minimax-probe.e2e.spec.ts` | `DSH_MINIMAX_E2E=1` | **只读**：远端模型目录（4 个模型 + 只有 M3.1 有档位）、签到状态、积分余额。**绝不领取**（`claim` 会消耗当天唯一一次机会）。⚠️ 读的是 **MiniMax Code 客户端自己的登录态**（`~/.minimax/auth/prod/cn/mcode-public/auth.json`），**不是**本插件的凭据存储 —— 该 provider 尚未在任何机器上完成过插件登录。⚠️ **token 过期时自动 skip 并打印指引**，**不代客户端续期**（代续期若遇服务端轮换 refresh_token 就会弄坏用户客户端登录态，详见 `minimax-credential.ts` 的长注释） |
| `minimax-chat-probe.e2e.spec.ts` | `DSH_MINIMAX_CHAT_E2E=1` + `DSH_MINIMAX_CHAT_E2E_CONFIRM=yes` | 发一次 Anthropic Messages 推理请求。⚠️ **本轮该链路未端到端验证**：本机账号 `insufficient_balance_error`（HTTP 402）。保留探针是为了充值后一条命令验证，并把「未验证」留在代码里。⚠️ 该文件头如实标注了 `thinking.type=adaptive` 的**证据强度**（客户端取证支持 adaptive 形态，但「非 adaptive 会 400」目前只有计划文档声称、无服务端证据） |
| `minimaxintl-probe.e2e.spec.ts` | `DSH_MINIMAXINTL_E2E=1` | **只读**：MiniMax Code **国际版**（`minimaxintl`）的模型目录（`region=en`）、签到状态、积分余额。**绝不领取**。⚠️ 与国内站探针**不同**：它读的是**插件自己的** `MINIMAXINTL_*` 凭据（国际站没有可读的本机客户端）⇒ 前置条件是先在 Jet Hub「MiniMax Code (国际版)」面板登录一个账号。⚠️⚠️ **2026-10-15 真机验证通过**：模型目录（4 条）、签到状态、积分余额、推理（200 + 真实 SSE）**全部可用**，认证只需 `Authorization: Bearer`。⚠️ **本行曾一度写着「国际站端点要求阿里云 ALB 网关签名、不可用」—— 那是把一次上游故障窗口当成了设计，已被证伪**（决定性证据：官方 mcode 客户端自己也连不上，`Code: 50112` = 官方枚举 `LLM_AUTH_ERROR`；故障恢复后同样的请求全部 200）。**仍然成立**的判据只有一条：目录端点**当前是公开的**（无 token 也 200）⇒「目录能读到」**不构成**凭据有效的证据（这是最易误判的一格），凭据证据看签到/积分/推理三处。详见 `src/minimax-product.ts` 文件头。本探针的判据只到「请求发出去了、拿到可解读响应」，实际内容**打印**给人核对 |
| `minimaxintl-claim-probe.e2e.spec.ts` | `DSH_MINIMAXINTL_E2E=1` + `DSH_MINIMAXINTL_CLAIM_E2E_CONFIRM=yes` | ⚠️ **真实领取** MiniMax 国际站当日积分（消耗账号当天唯一一次机会）。先查状态：`todayCheckedIn` 为真则**跳过 claim**；`claim_result` 是幂等判据（1=真领、2=已领过），**不是** HTTP 状态码。⚠️ 签到状态读到 `null` 时**不执行 claim**（先确认凭据有效、再怀疑上游故障）—— 该端点形态**已实测可用**（2026-10-15），别把一次查询失败读成「端点不可用」而白烧当天机会 |
| `officeace-abandoned-login.e2e.spec.ts`（`pnpm test:e2e:officeace-abandoned`） | `DSH_OFFICEACE_E2E=1` | **IKM741：新登录账号的完整生命周期**（⚠️ **会真开无痕窗口**）。① `account.create` 后占位条目就位 + **零凭据** + 无痕窗口真拉起（人工确认落在华为云登录页）；② 用户**没完成授权就关窗** ⇒ 刷新账号列表时幽灵占位条目被**收口**；③ 收口**不波及**其它渠道；④ ⚠️ **成功登录后即使 TTL 已过也绝不能被收口**（删除不可逆 —— 这条是安全闸）；⑤ 无痕窗口独立验证；⑥ 落库途中删卡片 ⇒ **孤儿凭据被回收**（B 档）；⑦ ⑥ 的对照组（不删卡片 ⇒ 凭据保留）。②③④ 用 `DSH_OFFICEACE_PENDING_TTL_MS=0` + 假造时钟把「已中止」变成**确定事实**，无需等真实 20 分钟 |
| `accio-probe.e2e.spec.ts` | `DSH_ACCIO_E2E=1` | **只读**：登录（池里有凭据则直接用，否则现场 PKCE 登录，**人工在浏览器授权**）→ 模型目录（倍率来自 `effectiveMultiple` 且按升序；兜底表**不许腐坏**）→ 账号身份（`userinfo`，token 在 **body**）→ 三类积分桶 + 重置倒计时（`currentSubscription` / `quota`，token 在 **query**）。**不发模型请求、不续期、不写任何存储**（登录产物只进内存凭据提供者） |
| `accio-refresh-probe.e2e.spec.ts` | `DSH_ACCIO_REFRESH_E2E=1` + `DSH_ACCIO_REFRESH_E2E_CONFIRM=yes` | ⚠️⚠️ **续期端点的轮换语义**（`docs/agent-notes/providers-accio.md` §10 U-A）。回答三问：①是否轮换 `refresh_token`；②旧的轮换后是否**立即失效**；③是否顺带触发当日额度发放。**只读订阅**（不发模型请求），但**真实消费一次 `refresh_token`** |

> CodeArts deepseek-v4 系列使用华为云免费福利额度（每日 1000 万免费 Tokens），
> 不产生额外费用，因此 `DSH_CODEARTS_E2E=1` 不需要确认变量。
> glm-5.3-flash 等其他 benefit 模型不在本测试集内。如有添加务必标注消耗情况。

## 运行方式

**永远显式指定文件**，不要运行整个目录：

```bash
# 只做认证（安全）
pnpm test:e2e:login

# ⚠️ 会真开无痕窗口：OfficeAce 换账号登录 + IKM741 的登录中止收口（人工确认登录页）
pnpm test:e2e:officeace-abandoned

# 登录流程原始响应探针（安全，不发模型请求）
pnpm test:e2e:buddy-probe

# ⚠️ 会消耗 CodeBuddy 积分
pnpm test:e2e:buddy

# ⚠️ 判定「限额重置」徽章是否属实（默认测 deepseek-v4.1-flash）
pnpm test:e2e:buddy-ratelimit

# ⚠️ 会消耗 CodeArts 积分
pnpm test:e2e:codearts

# ⚠️ 会真实领取积分（改动当日签到状态）
pnpm test:e2e:workbuddy-claim

# 安全：LobsterAI 只读探针（凭据/版本号/签到槽位/余额，不签到）
pnpm test:e2e:lobsterai

# ⚠️ 会真实签到（改动当日签到状态；不消耗模型积分，重复运行幂等）
pnpm test:e2e:lobsterai-claim

# 安全：CodeArts 只读探针（凭据/账户类型/积分余额/活动列表，绝不领取）
pnpm test:e2e:codearts-credits

# ⚠️ 会真实领取积分（改动当日领取状态；不消耗模型积分，重复运行幂等）
pnpm test:e2e:codearts-claim

# 安全：Qoder 只读探针（凭据结构/令牌有效性/模型表，不发模型请求、不续期）
pnpm test:e2e:qoder

# 安全：Qoder 积分只读探针（逐账号签到状态 + 设备身份是否生效；绝不领取）
pnpm test:e2e:qoder-credits

# ⚠️ 发一次 Qoder 推理请求（默认 qmodel_38max（Qwen3.8-Max）**免费**，不消耗积分）
pnpm test:e2e:qoder-chat

# 安全：TRAE 只读探针（凭据/余额/签到状态/远端模型列表，不签到）
pnpm test:e2e:trae

# ⚠️ 会真实签到（改动当日签到状态；不消耗模型积分，重复运行幂等）
pnpm test:e2e:trae-claim

# ⚠️ 会消耗极小额度：验证多通道目录与「按模型路由通道」
pnpm test:e2e:trae-channels

# ⚠️ 会消耗明显额度：loomy / trae 的图片边界**二分**复测（Issue IKKX0T）
#    比 image-burst 贵得多（二分每步一整轮十几张图）。定 imageMaxBytes 前跑它。
pnpm test:e2e:image-bisect

# 安全：Cline 只读探针（凭据/前缀证据/余额/免费集合，不发模型请求、不续期）
pnpm test:e2e:cline

# ⚠️ 发一次 Cline 推理请求（**默认只发 cline-free/mimo-v2.6-flash**，免费模型）
pnpm test:e2e:cline-chat

# 安全：MiniMax 只读探针（模型目录/签到状态/余额，**绝不领取**）
pnpm test:e2e:minimax

# ⚠️ 发一次 MiniMax 推理请求（**本轮必然失败：账号无余额 402**；充值后才有意义）
pnpm test:e2e:minimax-chat

# 安全：Accio 只读探针（登录 + 模型目录 + 账号 + 积分；不发模型请求、不续期、不落盘）
pnpm test:e2e:accio

# ⚠️ 会消耗 Accio 积分：发一条极小请求（**默认全目录最低倍率 x0.013** 的模型）
pnpm test:e2e:accio-chat

# ⚠️ 会消耗 Accio 积分：工具调用往返 + 思考链分离（默认同上，最低倍率）
pnpm test:e2e:accio-tools

# ⚠️⚠️ Accio 续期**轮换语义**（会真实消费一次 refresh_token）
#    只碰**本插件自己现场登录的**凭据（只进内存）；无法证明归属时**整体 skip**
pnpm test:e2e:accio-refresh

# ⚠️ 会消耗 Accio 积分：**图片通路**（四象限色块图四色全对 + multimodal:false 必须被拒）
pnpm test:e2e:accio-image
```

## ⚠️ Accio 图片探针：为什么它必须存在，以及两个账号来源

**存在理由**：`docs/agent-notes/providers-accio.md` §10 的 U-D（图片通路）由它给出答案，
而同一份笔记的 U-F / U-G 记着一条教训 —— **「真机跑过，但证据没留在库里」等于下次没人敢信**
（结论照用，却没有可复核的产物）。本探针就是**把 U-D 的证据留存下来**。

它的核心判据（⚠️ **不能只看 HTTP 200**，与其余 accio 探针同口径）：

| 判据 | 为什么必须 |
|---|---|
| 没抛错 | HTTP 200 也可能是风控 HTML 或流内 `error_code` 非 `'200'` 的业务失败 |
| **字节桥接真被调用**（`readCalls > 0`） | 否则是「静默丢图」的假成功 —— 模型答「我没看到图」时，**失败原因会被误读成「上游不支持图片」**（本文件末尾有一条源码级守卫钉住这两条断言必须同时存在） |
| **四色全对** | 这才证明图片**真的被模型读到了**（实测真收图的模型 3/3 全对；忽略图的模型 0/4） |

**账号来源（两个，优先级明确）**：

```
DSH_ACCIO_IMAGE_E2E_CREDENTIAL_JSON='{"access_token":"…","refresh_token":"…","region":"cn"}'   # 可选，显式指定
DSH_ACCIO_IMAGE_E2E_ANY_ACCOUNT=1                                                              # 可选，放宽到「任意账号」
```

⚠️ 与 `accio-chat` / `accio-tools` **刻意不同**：那两家只认**启用**账号
（`enabledAccountRef`），而本机实测 5 个 accio 账号**全是 `enabled: false`**
⇒ 只认启用账号会让本探针在本机**永远跑不起来**，U-D 的证据就又留不下来。
故本探针支持 `DSH_ACCIO_IMAGE_E2E_ANY_ACCOUNT=1` 放宽到任意账号 ——
**但必须显式 opt-in**，且日志会**点名用了哪个 ref**：放宽是有代价的
（会消耗一个**用户已停用**账号的额度），默认行为**仍是只认启用账号**。

## ⚠️ Cline 探针的付费保护（请勿削弱）

Cline 的免费资格是**服务端动态下发的营销状态**（`GET /api/v1/ai/cline/recommended-models`
的 `free` 数组），**随时可能被撤销或改为计费**。因此若探针无条件遍历
「远端此刻说是免费」的那批模型，某天某个模型转为计费后，一次 e2e 就会
**按付费价刷掉真实 token**。

三重闸门（`tests/e2e/cline-chat-probe.e2e.spec.ts`）：

```
DSH_CLINE_CHAT_E2E=1                必需
DSH_CLINE_CHAT_E2E_CONFIRM=yes      必需（防误跑）
DSH_CLINE_CHAT_E2E_ALL_FREE=1       可选：才遍历其余免费模型
```

默认行为：**只请求 `cline-free/mimo-v2.6-flash`**（用户指定的日常验证模型）。

⚠️ 默认模型换过一次：原为 `cline-free/deepseek-v4.1-flash`，2026-10-05 被上游下架
（移出远端 `free` 数组、直连回 `404 {"error":"model not found"}`）故改用现模型。
判定「某个免费模型是否已被下架」的探针是 `pnpm test:e2e:cline`（只读，零额度）。

另有 `assertFreeModel()` 作为**安全边界**：任何 `isFree === false` 的模型
（无论来自 `DSH_CLINE_MODEL` 环境变量还是远端列表）都会**直接抛错、不发请求**。
`DSH_CLINE_MODEL` 指向付费模型同样会被拒绝 —— 这是刻意设计，不要为了
「临时测一下」而绕过它。

⚠️ 遍历分支里还做了**逐个二次确认**：即使模型在目录里标着免费，
若它已不在**当前**远端 `free` 集合中，也会跳过（避免用过期快照去请求）。

> **CodeArts 凭据必须新鲜**：其 `refresh_token` 是**一次性轮换**的（用一次即
> 作废，服务端回 `STS5.1806 the refresh token has been used`）。两个 CodeArts
> 积分探针都**只读凭据、不刷新**，因此凭据过期时会如实报签名请求失败 ——
> 此时请在 Jet Hub 重新登录，或等续期调度跑过一轮，**不要**为此给探针加刷新逻辑。

> **Qoder 探针要先看续期**：`qoder-chat-probe` 里「续期」用例比「推理」更重要。
> Qoder 官方客户端用**硬件指纹**派生 `machine_id`，而本插件用**随机 UUID**
> （见设计文档 §8）。若续期返回 4xx（非 401），说明服务端校验了设备标识，
> 该假设被推翻 —— 此时必须改用硬件指纹派生，否则用户每天都要重新登录。

## ⚠️ Accio 探针的三条硬规矩（请勿削弱）

### 1. 判「成功」**不能只看 HTTP 200**

实测：把 token 放进 `Authorization` 头而不是 body 的 `token` 字段时，上游**恒**回

```
HTTP 200
data: {"turn_complete":true,"error_code":"402","error_message":"unauthorized"}
```

⇒ 只看状态码会把**认证 / 额度失败**读成「成功但模型没吐字」，而且 harness 也
不会按额度类重试。四个 Accio 探针因此都**至少两条判据同时成立**才算通过：

| 探针 | 判据 |
|---|---|
| `accio-probe`（三个只读端点） | 信封 `success !== false` **且** 拿到了 `data` 对象 |
| `accio-chat-probe` / `accio-tools-probe` | 原始帧里**有** `content.parts[].text` **且没有**非 `'200'` 的 `error_code`（`'200'` 是成功哨兵，实测正常帧也带） |

⚠️ 两个流式探针**刻意不 catch** `consumeAccioSse` 抛出的 `LlmError`：流内 402 抛的是
**字面量码 `'QUOTA_EXCEEDED'`**（不是 harness 的 `QUOTA_EXCEEDED_CODE`，其字面值是
`'QUOTA'`，会被客户端换成固定文案）。吞掉它就等于把「额度/认证失败」降级成
「模型没返回内容」—— 那正是 `src/accio-messages.ts` 修过的真实缺陷。

### 2. ⚠️⚠️ 续期探针**只碰我们自己的凭据**

参考实现明确记录「**刷新会轮换 `refresh_token`**」。若拿**用户 Accio 桌面端**的
会话去试，轮换后那份即失效 ⇒ **用户桌面端的登录被弄坏**。

`accio-refresh-probe.e2e.spec.ts` 因此：

- **从不读** Accio 桌面端数据（`credentials.enc` / DPAPI），也**从不读**账号池里的
  `ACCIO_ACCOUNT_*`（那可能是用户在 Jet Hub 登录的真实账号，轮换掉同样会打断它）；
- **现场跑一次自己的 PKCE 登录**，凭据只写进**内存**凭据提供者，**一个字节都不落盘**
  —— 轮换掉它不破坏任何东西；
- 归属门禁 `ownershipFailureOf()` 有**三条判据，缺一不可**：
  ① `DSH_ACCIO_REFRESH_E2E_CREDENTIAL_JSON` **未设置**（环境变量里的凭据**结构上
  无法证明**归属）；② 凭据带 `region`（只有本插件的 `finishLogin` 会写它）；
  ③ `refresh_token` 非空。
  任一不成立就 **`ctx.skip()` 并打印原因** —— 宁可什么都不测，也不赌一把。

该文件里还有一条**离线用例**（零网络、零额度）逐条变异验证这三条判据各自能拦住
（含正例），别把它当噪音删掉。

### 3. 对话 / 工具探针**必须用最低倍率模型**

实测全目录最低倍率是 `1Drift-N8kP2Q7wR5mX`（**x0.013**，即
`ACCIO.fallbackModels[0]`），最高的是 x2.8 —— **215 倍**价差。两个会花钱的探针因此：

- 默认取 `ACCIO.fallbackModels[0]`（上游 `modelCode`，`1Drift-N8kP2Q7wR5mX`）；
- 可用 `ACCIO_PROBE_MODEL` 覆盖，**两种写法都接受**（2026-10-13 起）：
  **对外 id（slug，如 `qwen-3-8-27b`）**或**上游 `modelCode`**。
  ⚠️ 为什么两种都认：对外 id 已改成 slug（模型选择器里显示的就是它），
  而探针**自己发裸 fetch**、上行必须用 `modelCode` ⇒ 照选择器写进来的 slug
  若被拒会让人以为「模型不存在」；
- **未知 id 直接拒绝**（不是静默回落）：写错会得到一个与账号无关的 404，
  把「模型名不对」与「账号不可用」混成同一条报错，而两者倍率可能差 200 倍；
- 倍率高于 **x0.2** 的模型需要**额外显式 opt-in**（`ACCIO_PROBE_ALLOW_EXPENSIVE=1`）
  —— 沿用 Cline 探针的「付费保护」形态。

⚠️ `accio-probe`（只读）里有一条联动断言钉住这个前提：**最便宜的那个必须仍是
`ACCIO.fallbackModels[0]`**。上游改了倍率排序，那两个花钱的探针会立刻变红而不是
悄悄按新价刷额度。

> ⚠️ **`maxOutputTokens` 为什么是 256 而不是 64**：Accio **关不掉思考**
> （`includeThoughts` / `thinkingBudget` / `thinkingLevel` / `reasoningEffort`
> 四类字段实测全部无效，见 `src/accio-adapter.ts` 文件头）。实测短回答的思考约
> 150 token ⇒ 预算 64 会被思考**吃满**、正文零产出，得到的是**假阴性**
> （`src/session-title.ts` 记录的同型缺陷）。256 是「思考够用 + 正文几个字」的实用下限。

## Qoder 设备身份为何只能在 e2e 里验证

Qoder 的 `/sash/` 端点要求一对待定的设备身份头
（`Cosy-MachineToken` + `Cosy-MachineType`，**缺一即失效**），
由桌面端的 `runtime-info.exe` **实时生成**。

⚠️ **单测刻意禁用了这个可执行文件**：`vitest.config.ts` 把 `QODER_RUNTIME_INFO`
指向不存在的路径。理由有三 ——

1. 单次 spawn 实测约 **3.8 秒**，不禁用会让整个单测套件明显变慢；
2. 用例结果会随「开发机是否装了 Qoder 桌面端」而变；
3. 断言会拿到**实时身份**而非用例准备的 fixture，从而假失败。

代价是：**「实时生成身份」这条主路径在单测里根本不执行**。
所以下面两件事**只能**在 e2e 里验证（`vitest.e2e.config.ts` 不设该变量）：

- 实时生成的身份能否让服务端**下发可领活动**（`CLAIM_BENEFIT`）；
- **多账号**场景下每个账号是否都能拿到（历史缺陷②：初版读陈旧的
  `machine_token.json` 缓存，导致第二个账号在一键领取里被报
  「当前没有可领取的活动」，而 IDE 里可领）。

因此 `qoder-credits-probe.e2e.spec.ts` 的**逐账号**断言不可改成只测第一个账号
—— 那正是缺陷②唯一会漏网的地方。

> 单账号时该缺陷**不可能**被覆盖：探针会打印提示而不 fail（单账号是合法状态），
> 别把提示当噪音删掉。

## 限流真实性判定

`buddy-ratelimit-probe.e2e.spec.ts` 回答一个运维问题：Jet Hub 账号卡片显示
「限额重置」时，**该账号此刻到底还受不受限**。

徽章只比较 `modelRateLimits[model] > Date.now()`，是**历史事件的快照**，
不代表此刻的真实可用性。用例把两件事分开测，以定位差异来源：

- **A. 直连** `/v2/chat/completions`（绕过适配器与账号池）→ 服务端的真实答复；
- **B. 适配器链路** → 插件实际会发生什么。

判定：A 返回 200 且有正文即**未真限流**（徽章记录已失效）；A 返回
429/6004 且含「频率限制」即**确实受限**。可设 `DSH_BUDDY_MODEL` 换被测模型。

本地记录的重置时间取自信道错误体里的「将在 … UTC+8 重置」。服务端在重置
时间到达前提前放行是常见的，因此**徽章显示超额使用、实际仍能正常回复**
并不矛盾。

## 设置页的「测试 / 重测 / 重置」

同一套判定也提供在设置页（Jet Hub）上，无需跑 e2e：

| 按钮 | 行为 | 是否发请求 |
|------|------|-----------|
| **测试**（每个账号） | **无条件**实发一条最小消息，只回报「这一发成功了吗」 | 是（消耗额度） |
| **重测**（每个账号） | 对该账号每个限流标记的模型实发一条最小消息，正常返回才清除该标记 | 是（消耗额度） |
| **重测所有**（面板标题） | 对全部账号（**含已停用**）执行上述重测，顺序逐个执行 | 是（消耗额度） |
| **重置**（每个账号） | 直接清除该账号的全部限流标记 | 否 |
| **重置所有**（面板标题） | 直接清除全部账号（含已停用）的限流标记 | 否 |

实现见 `src/account-probe.ts`，RPC 端点为
`account.test` / `account.retest` / `account.retestAll` / `account.reset` / `account.resetAll`。
探测复用真实适配器（BuddyAdapter / CodeArtsAdapter / GeminiAdapter）走完整请求链路，且
**不传 accountPool**——避免「重测 A 账号」顺带污染其他账号的标记。

### 「测试」与「重测」的区别

两者都是真发请求，区别在**触发条件**与**存储副作用**：

- **重测**只测「已有 `modelRateLimits` 标记」的模型；账号没有历史 429 时它在
  `modelIds.length === 0` 处**提前返回，一次请求都不发**（真实报障：「重测按钮
  你确认过会发请求吗，为什么响应这么快？」）。它**会**清除通过验证的标记、
  **会**写回上游给的新重置时刻。
- **测试**不看标记，无条件发一次，且**一个字节都不写存储**。它补齐的正是
  「账号从未 429 过，因此没有任何手动探活入口」这个缺口。

两者因此各用一个独立的能力开关，**不能绑在一起**：Gemini 登记了测试、没登记
重测（它的限流是服务端配额窗口制，清本地标记毫无意义），绑同一个开关会让其中一个
按钮消失。当前只有 Gemini 登记了「测试」（未登记的渠道一律不渲染该按钮）。

被测模型由 `pickTestModel` 按「调用方显式指定 > 已有的限流标记 > 全量目录第一个」
决定；三者都拿不到时**如实报错而不猜一个模型名**（猜错会得到与账号无关的 404，
把「账号不可用」与「模型名不对」混成同一条报错）。

## 单元测试

`pnpm test`（默认）只跑 `tests/unit/**`，**全部使用桩函数，不发起任何网络请求**，
可以放心频繁运行。

## 为什么默认全部 skip

e2e 用例在未设置闸门时通过 `describe.skip` 整体跳过，报告里显示为
`skipped`，不会产生任何网络调用。这样做是为了防止：

- CI 或其他开发者误跑而消耗配额；
- CodeBuddy 的 14 天免费试用期结束后（2026-09-10 止）在付费账号上产生真实费用。
