<!-- 搬自 AGENTS.md（2026-10-06 拆分：注入预算 65,536 B，超出部分每轮被截断永不可见）。
     内容逐字节原样保留；本文件按需阅读，不进每轮注入。 -->

## 项目概述

本项目是 DeepSeek Harness 的一个插件（`dsh-providers-hub`），提供华为云 CodeArts 浏览器登录与凭据管理功能。插件还附带 `buddy`（腾讯 CodeBuddy 中国版）、`workbuddy`（腾讯 WorkBuddy **国际版** / WorkBuddy AI）、`lobsterai`（有道 **LobsterAI** / 龙虾）、`qoder`（阿里系 **Qoder**）、`qodercn`（**Qoder 中国版**，与 `qoder` 同协议族、共用同一份 WASM）、`trae`（字节跳动 **TRAE**）、`cline`（**Cline** 桌面端 / Cline API）、`loomy`（讯飞 **Loomy** 办公助手）、`raccoon`（商汤 **Raccoon Work** / 小浣熊）、`minimax`（**MiniMax Code 中国版**，首个 **Anthropic Messages** 协议族）与 `minimaxintl`（**MiniMax Code 国际版**，与 `minimax` 同协议族、共用同一份实现，差异只在 `src/minimax-product.ts`）等 LLM provider 路由。

`buddy` 与 `workbuddy` 同源：共用同一 CLI 内核与同一认证协议，差异全部收敛在 `src/product.ts` 的产品配置中。关键差异是 **`endpoint`**：中国版为 `copilot.tencent.com`，国际版为 `www.workbuddy.ai`，两者返回不同模型池，因此 endpoint 必须随产品切换、不可当作全局常量。此外 `platform` 分别为 `ide` 与 `workbuddy-ai`，国际版登录 URL 还追加 `version` / `loginSessionId`。

`lobsterai` 与上述两者**完全不同源**：登录方式、请求头、续期载荷、签到流程、版本号来源都不一样，因此实现是独立一套 `src/lobsterai*.ts`。它只**共用架构模式**（产品配置驱动、账号池、限流切换、模型黑名单），**不共用 `BuddyProduct` 类型** —— 那里面 `apiDomain` / `productCode` / `attributionName` / `userAgentByModelFamily` / `appendSessionParams` 等字段对 LobsterAI 全部无意义。详见 README 的「LobsterAI provider」章节与 `docs/lobsterai-integration-plan.md`。

`qoder` 是**第五个、也是与其余四者都不同源**的协议族：**PKCE 设备码轮询**登录（不起本地监听端口）、续期请求体需带 **`machine_id`**、推理走**加密端点**（请求体由客户端内嵌 WASM 加密，响应套一层信封）。实现为独立一套 `src/qoder*.ts`（含 `qoder-wasm.ts` / `qoder-envelope.ts`），同样只共用架构模式。五个必须记住的点：

1. **两条推理路径认两套模型名，且 host 不同（最容易踩的坑）**：
   - **加密（本插件使用）**：`POST api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation`，请求体与签名头由 WASM 生成，**认模型目录 key**（`qfmodel` / `dmodel`）。
   - **公开**：`POST api2-v2.qoder.sh/model/v1/chat/completions`，**认通用名**（`qwen-flash` / `qwen-plus`），目录 key 一律 `Unsupported model`。
   ⚠️ `api2.qoder.sh` 与 `api2-v2.qoder.sh` **不是同一个 host**，混用 404。配置项见 `QoderProduct.inferBase` / `encryptedInferBase`。
   **真实缺陷**（用户报障）：「向 qwen3.8-flash 发消息后没收到回复就终止」—— 把目录 key 发给了公开端点；随后又误判为「目录 key 不可用」而把表换成通用名，结果拿到 Qwen3.5/2.5 而非 3.8 系列。
2. **加密推理用 `src/qoder-wasm.ts`**（复用客户端内嵌 WASM 生成加密体与签名头）。**不是「破解密码学」** —— WASM 自己导出了成对编解码函数，我们只是调用它。响应**无需解密**，只在每帧外套一层信封，由 `src/qoder-envelope.ts` 剥离。
   ⚠️ **签名头必须原样透传**，用普通 `Bearer <token>` 覆盖会被判签名无效。
   ⚠️ 改这个文件前先读 **不入库**的 `docs/qoder-encryption-notes.md`：里面有 glue 约定、请求体字段结构与三个已踩过的坑（写错会得到 Rust panic 或 `null pointer passed to rust`），重新实现代价很高。
3. **模型列表恒用静态表**（`src/qoder-product.ts` 的 `fallbackModels`）：远端 `GET /algo/api/v2/model/list` 需 **WASM 签名**，故 `listModels` **不发网络请求**。
   表里是**17 个目录 key**（全部可用），取自客户端下发的模型目录。
   ⚠️ **请求体必须带 `business` 字段**（`business: { type: 'agent' }`）—— 缺了服务端会把请求路由到**故障节点** `oa_qwen-plus-2025-04-28` 并返回 `[FAIL]node:... msg:Execution failed`。
   **真实缺陷**（2026-09-20 定位，极隐蔽）：`qfmodel`（Qwen3.8-Flash）因此「看起来不可用」，而**同一模型在 Qoder IDE 里完全正常**。
   ⚠️ **判据是「IDE 能否用同一模型」**：IDE 能用 → 是我们的请求缺东西，不是服务端故障。当时我错误地排除了 8 类假设（host / query / 明文体 / 模型配置字段 / 客户端版本 / 设备标识 / 会话类型 / 凭据字段），逐条记录见 `docs/qoder-encryption-notes.md` —— 别重复这条路。
   ⚠️ **其余模型恰好不受影响**，所以现象像「只有这一个模型坏」，极易误判为服务端故障。
   ⚠️ **展示名必须含模型名与版本，不能只写厂商**（用户报障：「看到的是 GLM、DeepSeek、MiniMax，只有厂商名字没有模型名字和版本」）。
   ⚠️ **改表必须逐个实发验证可推理**，不能只照抄目录 key。免费额度模型：`qmodel_38max` / `qfmodel`（e2e 探针默认用前者）。
   ⚠️ **错误帧必须能抛错**：Qoder 用独立 `event: error` 行 + 顶层 `{code,message,type}`，**不是** OpenAI 的 `{error:{message}}`。早期解析器只认后者 → 错误被静默当成「正常结束、无内容」，UI 表现为「干净地停止、无任何报错」。见 `src/openai-compat.ts` 的 `consumeOpenAiSse`。
4. **轮询的 `404` 表示「用户尚未完成授权」，必须继续轮询，不是错误**。实测依据：该端点返回 404 而任意不存在的路径返回 401，说明它被网关豁免认证、由业务层报「会话未就绪」。轮询 host 是 **`openapi.qoder.sh`**（`qoder.com` 的同名路径返回 401）。
5. **prod 的 `client_id` 是 `J_a`（`e883ade2-…`），不是 `G_a`**。源码 `client_id: i ? J_a : G_a`，而调用点 `loginWithDeviceFlow` 传的第 4 参是 **`isProd()`**（`$Oa(){return "prod"===db()}`）—— prod 为 `true` 故用 `J_a`；`G_a`（`e93fe488-…`）只在 daily/test 用。
   ⚠️ **真实缺陷**（用户报障）：初版把第 4 参误读成「useIdeClientId」，于是 prod 用了 `G_a`，GitHub 授权点击后页面报「**参数无效 / 你可以稍后前往 IDE 客户端并登录Qoder**」。根因是服务端在**授权回调阶段**才校验 client_id。
   ⚠️ **只靠入口 302 检查发现不了该错误**：`GET /device/selectAccounts` 对**任一** client_id（含全零 UUID）都返回 302。必须在源码层面核对第 4 参语义。见 `src/qoder-product.ts` 的 `clientId` / `testClientId` 字段注释。
6. **`options.tools` 必须真的下发到请求体顶层 `tools`，且工具历史要保留 `tool_calls` / `tool_call_id`**（**OpenAI 风格，不是 Anthropic 风格**）。
   客户端源码依据：`$Hc(A)` 把工具序列化成
   `{type:'function', function:{name, description?, parameters?}}`，写入请求体**顶层**
   `tools`（`A6e()`：`tools: o?.tools ?? []`）；assistant 的工具调用由 `t2c()` 转成
   `tool_calls:[{id, type:'function', index, function:{name, arguments}}]`；
   工具结果由 `A2c()` 产出 `{role:'tool', content, tool_call_id}`。
   ⚠️ **另有一条 Anthropic 风格分支**（`IOc()` 的 `input_schema` + `tool_use_id`），
   那是给 **Anthropic BYOK** 用的，加密端点**不吃那套** —— 别照它实现。
   ⚠️ **真实缺陷**（用户报障）：「使用本插件的 qoder 的 qwen3.8-flash，执行任务出现
   任务调用 xml 泄露任务终止」。两处根因：① `src/qoder-adapter.ts` **从不消费
   `options.tools`**（其余四个适配器都消费），`qoder-wasm.ts` 又把请求体的 `tools`
   **硬编码为 `[]`** → 模型在 wire 上拿不到任何函数 schema，只能用**正文里的 XML 文本**
   臆造工具调用，harness 认不出 → 任务终止；② 适配器的 history 过滤器写成
   「只留 `content` 为字符串的消息」，而 assistant 带工具调用时 `content` 是 **`null`**
   （OpenAI 规范）→ 整条被丢，且 `role:'tool'` 的 `tool_call_id` 也被丢 → 模型看不到
   自己调用过什么，反复重调同一工具或凭空编造结果（与 TRAE 那条同型缺陷一致）。
   ⚠️ **加密端点的请求体本地不可解**，无法靠抓包验证 —— 故把 payload 构造抽成纯函数
   `buildQoderInferPayload()`（`src/qoder-wasm.ts`），再由 `buildQoderTools()` /
   `buildQoderHistory()`（`src/qoder-adapter.ts`）单测锁死。
   排查脚本 `scripts/probe-qoder-tools.mjs`（只读，打印上述三个客户端函数的定义；
   ⚠️ 解码函数名与 XOR 密钥**随版本会变**，脚本会自行探测）。回归用例
   `tests/unit/qoder-tools.spec.ts`。

7. **图片必须走 `messages[].content` 的多模态数组，`chat_context.imageUrls` 是死的**
   —— **真实缺陷**（用户报障：「给 qodercn 的 qwen3.8-flash 发送图片，说没读到图片」）。
   ⚠️ 这不是配置问题，也不是「`imageUrls` 忘了填」：

   - 客户端官方实现 `Hyc()` **就把 `chat_context.imageUrls` 恒置 `null`**。
     obf 产物原文（`qoder-worker-runtime.obf.mjs`，明文可搜）：
     `function Hyc(A,e,t){return{text:A,features:[],extra:{…},chatPrompt:"",imageUrls:null}}`
     —— 我们 `src/qoder-wasm.ts` 里那行 `imageUrls: null` 是**忠实复刻，不是缺陷**。
     排查时**别再盯着这个字段**（我第一轮就盯错过）。
   - 图片的**正确通道是 `messages[].content` 的多模态数组**：客户端 `eQc()` 把
     `{type:'base64',media_type,data}` 转成
     `{type:'image_url',image_url:{url:'data:<media_type>;base64,<data>'}}`，
     `bJc()` 再转成 `{type:'input_image',…}`。
   - 真正的丢失点在 `buildQoderHistory`（`src/qoder-adapter.ts`）：它原先用
     `qoderContentText()` 把 content **压成纯文本**，而**上游
     `serializeMessages` 早已正确产出多模态数组** —— 图片是在这一跳被吃掉的。
   - 修法（`qoderContentParts()`）：**含图消息保留 content 数组**（逐字段只搬
     `type` / `text` / `image_url.url`（+ 可选 `detail`）），**纯文本仍输出字符串**
     （上游对字符串兼容性最好，且既有用例锁死了该形态）；
     判空必须把图片算作内容，否则「只发图不带字」的消息会被整条丢弃。
     ⚠️ 同时别忘了 `userText`（写进 `chat_context.text` / `originalContent`）：
     带图时 content 是数组，只判 `typeof === 'string'` 会让配文退化成空串。
   - ⚠️ **这是本文件第三个同型缺陷**（前两个：`tools` 不下发、工具历史丢
     `tool_calls`）—— 都是**序列化层没保留多模态结构**。改 Qoder 序列化时，
     把「tools / tool_calls / 图片」三者一起过一遍。
   - ⚠️ **两站同时受影响**：`qoder` 与 `qodercn` 共用同一个 `QoderAdapter` 类与
     同一个 `buildQoderHistory`，故国际版的图片此前同样是坏的（本次一并修好）。
   - 排查脚本 `scripts/probe-qoder-image-loss.mjs`（只读、离线、零额度：按
     `serializeMessages → buildQoderHistory → buildQoderInferPayload` 真实路径
     逐步打印，直接指出丢失点）。回归用例在 `tests/unit/qoder-tools.spec.ts`
     （5 条，含「纯图片消息不被丢弃」「纯文本仍输出字符串」「未知字段被剔除」）。
     ⚠️ 已做**反向验证**：让 `qoderContentParts` 恒返回 undefined（= 修复前行为）
     时其中 4 条会失败，故不是同义反复。

8. **排队错误（业务码 `10605`）必须识别、按服务端延迟等待，且与认证失败分开**
   —— **真实缺陷**（用户报障，2026-09-27）：国际版「排队 30 秒、5 次重试都没过」；
   中国版「一次重试就能成功却被当失败」。

   **四种 403 的语义互不相同，绝不能合并**（客户端 `rJc()` 就是分开映射的）：

   | 形态 | 判据 | 处理 |
   |---|---|---|
   | **排队** | 业务码 `10605`（客户端 `mRA`）→ `model_queued` | **内部按服务端延迟等待后重试**，不刷新凭据、不换账号 |
   | 认证失败 | 业务码 `105`（客户端 `MF`）→ `auth_error`，或 401 | 续期凭据后重试（**唯一**该走 refresh 的情形） |
   | 重复请求 | 客户端 `_TA="duplicate_request"` | 直接重发，**不**续期 |
   | 签名无效 | `Signature invalid (101)` | 见上文第 2 条（签名头被覆盖） |

   ⚠️ **排队信息藏在 `message` 里，且 `message` 是「一个 JSON 字符串」**：
   ```json
   {"code":"10605","message":"{\"isQueued\":true,…,\"retryAfterSeconds\":30,…}"}
   ```

   ⚠️⚠️ **排队有 TWO 种下发通道，第一版只修了一种（第二次回归，2026-09-27）**：

   | 通道 | 形态 | 识别位置 |
   |---|---|---|
   | **① HTTP 状态层** | HTTP **403** + 排队 JSON 体 | `qoder-adapter.ts` 的 `!response.ok && 401/403` 分支 |
   | **② SSE 流内** | HTTP **200** + 内嵌 `{code:"10605",…}` **帧** | `openai-compat.ts` 的 `consumeOpenAiSse` |

   用户第二次报障的症状（`重试延迟 7967ms` + `code=SERVER`）暴露了 ② 未被覆盖：
   `httpErrorCode(403)='AUTH'` 而日志里是 **`SERVER`** —— 后者**只能**来自 SSE
   消费器的三处 throw。**判据：错误码与状态码不一致时，去 SSE 层找。**
   会话证据：`~/.dsh/sessions/--D-jet-code-go-lilishop-go--/…/session.v4.jsonl.zstd`
   （用 `scripts/probe-qoder-queue-session.mjs` 解压检索，Node 内置
   `zstdDecompressSync`，Windows 无需装 zstd）。

   ⚠️ **修 SSE 通道时踩到的两个更深一层的坑**（都写进单测锁住了）：

   - **`unwrapQoderEnvelopeStream` 会「降级重组」错误帧**：它把内层
     `{code, message}` 转成 `{error:{message:"… (10605)"}}` —— **丢掉 `code`
     字段**并把后缀拼进 `message`。两个后果都极隐蔽：
     ① 下游排队识别（依赖顶层 `code === '10605'`）**永远不命中**；
     ② 后缀污染了 `message` 里那段**内层 JSON 字符串**，使二次解析失败 →
        拿不到 `retryAfterSeconds`，只能退回 1 秒兜底（写单测时实测到：
        期望 2000ms 实际 1000ms）。
     现在改为**保真转发** `{code?, message, type:'model_error'}`。
   - **`parseQueueError` 必须同时支持两种入参**：外层整体
     （`{code, message}`）**与内层消息**（`{isQueued:…}`，**没有 `code`**）。
     第一版要求「必须命中 `code`」，于是 SSE 路径传内层消息时被判 undefined
     —— 修复**静默失效**（探针显示 `sleep 次数 = 0`）。
     判据改为「命中 `code` **或**含排队标志」。
   - ⚠️ **瞬时排队是 `isQueued:false`**（`serviceAvailable:true, waitTime:0`）——
     用户报告「一次重试就能成功」正是这一形态。判据**不能要求
     `isQueued === true`**，否则它会落到 1 秒兜底而非服务端要求的 2 秒。
   - ⚠️ **网关形态（无 `code`，只有 `message` + `type`）也要认**：信封剥离后
     `statusCodeValue` 被吃掉，若只判 `statusCodeValue >= 400`，整帧会被
     **静默丢弃**（既识别不出排队、连报错都没有）。

   ⚠️ **两处等待逻辑必须共用同一实现**（`QoderAdapter.waitForQueue`）——
   否则会再次出现「只修了一条通道」的缺陷。

   ⚠️⚠️ **第三次回归（2026-09-27 13:15）：判据**不能**用顶层 `code` 当门禁**。
   用户贴出的后缀是 **`(403/model_error)`**，它由
   `[String(data.code), data.type].join('/')` 产出，据此反推消费器收到的帧：

   ```json
   { "code": 403,
     "message": "{\"code\":\"10605\",\"message\":\"{\\\"isQueued\\\":…}\"}",
     "type": "model_error" }
   ```

   **业务码嵌了两层**：顶层 `code` 是 **403**，`10605` 在 `message` 里。
   上一版写成 `if (isQueueBusinessCode(data.code))` —— 拿 403 比 10605
   **必然不命中**，于是又落到 `SERVER`（这就是「修了两次仍失败」的原因）。

   ✅ **正确判据：直接尝试 `parseQueueError(data.message)`**，用它是否返回
   信息来决定 —— 该函数递归遍历 `data`/`result`/`message`/`body` 并解析字符串，
   **嵌套几层都能穿透**，且不会误判（要求命中 `10605` 或出现排队标志）。
   ⚠️ 这个坑的教训具有普遍性：**外部错误体的嵌套深度不可假设**。
   用「先按某字段判门禁、再解析」的写法，一旦真实结构比预期深一层就静默失效；
   应让解析函数自己判定。

   ⚠️ **读用户给的后缀能直接定位抛错点**：本仓库错误消息的后缀是各分支自己拼的
   （`(10605)` = SSE 顶层 code 分支、`(403/model_error)` = 该分支的 `code/type`
   拼接、`(status=…)` = 网关分支）。**排障时先看后缀**，能省掉大量猜测 ——
   这次正是靠它一步定位到「顶层 `code` 是 403」。

   ⚠️ **延迟的取值优先序**（客户端 `kJa()`/`EV()`/`IRA()`）：
   `retry_after_ms` → `retryAfterMs` → `retryAfterSeconds × 1000`
   → 兜底 `Retry-After` 响应头（纯数字当**秒**，否则 HTTP 日期）。

   ⚠️ **用户定下的等待规则**（`qoderQueueDelayMs()`，**不要擅自改**）：
   - 服务端给的排队时间 **< 10 秒 → 按它的值**（如 2s → 等 2s，重试即成功）；
   - **≥ 10 秒 → 封顶 10 秒**（`QODER_QUEUE_MAX_DELAY_MS`）—— 避免一次阻塞
     30 秒让 UI 长期停在「运行中」且无法区分「排队」与「卡死」；
   - **最多 180 次**（`QODER_QUEUE_MAX_ATTEMPTS`，与 CodeArts 惯例一致）
     → 10s × 180 = 最长 30 分钟；总时长可用 `DSH_QODER_QUEUE_TIMEOUT_MS` 覆盖。
   - ⚠️ **超时判定必须先于次数判定**：反过来写会让「180 次空转」在绝大多数情况下
     先生效，使 `DSH_QODER_QUEUE_TIMEOUT_MS` **形同虚设**（写用例时实测到了）。
   - ⚠️ **该环境变量不能写成 `parseInt(…) || 默认值`**：`0` 是合法值（表示「不等」，
     单测靠它验证开关），而 `0` 是 falsy 会被 `||` 静默换成 30 分钟。

   ⚠️⚠️ **排队体验三档（2026-11-13，PR #63）**：`DSH_QODER_QUEUE_WAIT_MODE`
   = `wait`（默认，逐字节同旧行为）/ `visible`（等待切成心跳片、每片产出一帧空
   `text-delta`，并额外发一帧排队提示）/ `fast`（不等、立刻抛 `QUEUE`）；
   `DSH_QODER_QUEUE_HEARTBEAT_MS`（默认 **5000**，非正数/非数字归一成 5000）。
   - ⚠️⚠️ **提示帧必须是合法的 `StreamChunk` 成员**：宿主 `dsh-llm` 的
     `BlockAssembler.push` 与 `AssistantStreamAccumulator.push` 的 `default` 是
     `assertNever`，**任何联合外类型都会硬抛**（`unreachable variant in …`）。
     修法 = 「空 `text-delta`（`text: ''` + **`index: 0`**）+ 私有字段
     `qoderQueue`」：类型合法、宿主忽略未知字段、网关的 `consumeChunk` 再把它
     摘成 `qoder_queue`。⚠️ 缺 `index` 同样会抛（`text-delta index must be a
     non-negative safe integer`）—— **两个形状各自都能崩，不能只修一个**。
   - ⚠️ **`fast` 是终态，日志必须写在 `throw` 之前**：初版把 `warn` 放在早退
     之后 ⇒ `|| mode === 'fast'` 恒假 ⇒ 用户只看到一条 `QUEUE` 错误、日志零字。
   - ⚠️ **心跳片必须严格收敛**：`slice = Math.min(remaining, heartbeat)`，且
     `slice` 必须是**正数**（`<= 0` 会让 `remaining` 永不减少 ⇒ `visible` 档
     死循环，60s 挂死）；余数单独成片（2500ms / 1000ms ⇒ `[1000, 1000, 500]`），
     总时长与 `wait` 档**严格一致**。
   - ⚠️ **两条消费路径都要有守卫**：HTTP 403 形态与 SSE 内嵌 10605 帧各一处
     `for await (…) yield frame`；只测一条时另一条删掉仍全绿（2026-11-13 实测）。
   - ⚠️⚠️ **聚合调用一律按 `fast` 处理，无视环境变量（2026-11-14 生产故障）**：
     聚合只在候选**报错**时切换 ⇒ `wait` 档静默等待让聚合等不到错误，`visible`
     档的空 `text-delta` 被 `isVisibleContent` 判「已产出内容」⇒ 禁止切换，两者都把
     请求锁死在 qoder 上。判据是 `src/aggregate-dispatch-context.ts` 的
     `AsyncLocalStorage` 标记（聚合 `dispatch` 用 `bindAggregateDispatch` 包派发，
     qoder 用 `resolveEffectiveQueueWaitMode()` 读）。⚠️ 必须**逐次包 `next()`**：
     异步生成器在调用 `next()` 的上下文里恢复，只包创建会在第二个 chunk 起丢标记。
     ⚠️ 不走 `GenerateOptions` 私有字段：宿主 `adapterStream` 会重组 options，
     不保证透传。测试：`tests/unit/aggregate-qoder-queue.spec.ts`（真实
     `QoderAdapter` + 仿宿主嵌套生成器；去掉 `bindAggregateDispatch` 后 5 条变红）。
   ⚠️ **为什么不用 harness 的 `retryPolicy`**：它的 `DEFAULT_RETRYABLE_CODES` 是
   `[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]` **不含 `QUEUE`/`AUTH`**，
   且它的退避是**固定参数**（`initialDelayMs=500`、`maxDelayMs=10_000`、
   `maxRetries=5`），**没有 per-error「服务端指定延迟」的通道** ——
   500/1000/2000/4000/8000 共约 15.5 秒，永远等不到服务端要的 30 秒。
   故排队必须在**适配器内部**自己等（与 CodeArts 的 `QUEUE_RETRY_DELAY_MS` 同思路，
   但延迟**来自服务端**而非固定 10 秒）。

   ⚠️ **两站同时受益**：`qoder` 与 `qodercn` 共用同一个 `QoderAdapter`。

   排查脚本 `scripts/probe-qoder-queue-error.mjs`（只读、离线：按客户端算法
   解析两种真实错误并打印该等多久）。回归用例在 `tests/unit/qoder-adapter.spec.ts`
   的「排队错误（10605 model_queued）」段（16 条：纯函数解析/换算 + stream 行为，
   含「瞬时排队等 2s 即成功且**不刷新凭据**」「30s 压到 10s」「超上限抛错」
   「认证失败不误判为排队」）。sleep 可注入，全部毫秒级完成。
   ⚠️ 已做**反向验证**：把封顶改回 30s → 3 条失败；去掉二次解析 → 6 条失败。

9. **额度用尽（业务码 `110` `Billing daily count exceeded`）必须归为**
   **不可重试**，不能落在 `SERVER` —— **真实缺陷**（用户报障 2026-09-27，
   排队修好后继续自动执行目标时出现）：

   ```
   重试延迟：7220毫秒
   失败原因：qoder: Billing daily count exceeded (110/model_error)
   ```

   ⚠️ 后缀 **`(110/model_error)`** 与排队那次那个 `(403/model_error)` **同源**
   （都由「顶层 code + message」分支的 `[code, type].join('/')` 产出），
   即帧是 `{code:110, message:"Billing daily count exceeded", type:'model_error'}`。
   它原先归 **`SERVER`**，而 `SERVER` **在** harness 的 `DEFAULT_RETRYABLE_CODES`
   （`[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]`）里 ——
   于是「**今日额度已用尽**」这种**确定性**错误被**白重试 5 次**
   （500/1000/2000/4000/8000 ≈ 15.5 秒；用户看到的 `7220毫秒` 就是其中一步）。

   ⚠️ **这与排队是同一个病根**：**用错误码的默认归类代替了对业务语义的判断**。

   **客户端权威依据**（obf 产物原文，`scripts/probe-qoder-code-110b.mjs` 可复现）：
   ```js
   function vpt(e){
     let t = e === "authentication_failed" || e === "billing_error" ? "permission"
           : e === "rate_limit"      ? "rate_limited"
           : e === "invalid_request" ? "invalid_request"
           : "unavailable";
     return new Tt(t, `Qoder assistant failed: ${e}`)
   }
   ```
   **`billing_error` → `permission`（不可重试）**，与 **`rate_limit` →
   `rate_limited`（可重试）明确分开**。

   ⚠️ **语义差异是本质的**（两者的处理**必须不同**）：
   | | 排队 `10605` | 额度 `110` |
   |---|---|---|
   | 语义 | **暂时**受阻（等待可通过） | **当天耗尽**（等到明天） |
   | 客户端归类 | `rate_limited`（可重试） | `permission`（**不重试**） |
   | 我们的处理 | 内部按服务端延迟等待 | **立即失败**（抛 `QUOTA_EXCEEDED`） |

   ⇒ 实现：两条错误分支（顶层 `code` / 网关形态）都判
   `isBillingBusinessCode(data.code) || looksLikeBillingError(data.message)`
   → 抛 **`QUOTA_EXCEEDED`**。

   ⚠️ **必须带文案兜底**（`looksLikeBillingError`）：`110` 这个**码值在本地产物里
   没有硬编码**（探针搜 `X="110"` 与 `daily count exceeded` 均未命中），
   说明它由**服务端**下发 —— 若上游改用别的码值表达同一语义，只认码会漏判。
   ⚠️ 兜底关键词必须**窄**（只认 `billing daily count exceeded` /
   `daily count exceeded` / `billing_error`）：`balance` / `quota` 之类泛词会
   误伤正常内容（模型正文里恰好讨论「余额」就会被误判为额度错误）。

   ⚠️ **`QUOTA_EXCEEDED` 是既有惯例**（`buddy-adapter.ts` / `cline-adapter.ts` 同用），
   且**不在** harness 的可重试集合里 —— 这正是我们要的「立即失败」。
   验证脚本 `scripts/probe-dsh-retry-codes.mjs`（只读 harness 策略文件，断言
   `SERVER` 在集合中、`QUOTA_EXCEEDED` 与 `QUEUE` 不在）。

   回归用例在 `tests/unit/qoder-adapter.spec.ts` 的
   「额度用尽（110 billing）归为不可重试」段（3 条：SSE 帧的 110 抛
   `QUOTA_EXCEEDED` 且**不等待**、字符串 `"110"` 同样识别、
   客户端映射 `billing→permission ≠ rate_limit` 被锁死防被改回 `SERVER`）。
   ⚠️ 已做**反向验证**：移除该识别 → 2 条变红；还原后全绿。

   ⚠️⚠️ **额度受限还要「标记 + 切账号」**（用户要求，2026-09-27）：
   > qoder 碰到当日额度受限应该像 workbuddy/codebuddy 一样，设置一个模型受限时间
   > （他们是返回错误中带时间，qoder 和 qodercn **需要自己设置当日 24:00 受限**）
   > 然后切换账号池中的下一个可用模型

   **与 buddy/CodeArts 的关键差异**：它们的错误文案里**带重置时间**
   （`parseRateLimitError` 从中解析）；Qoder **不带** —— 故用
   `nextUtc8DayStartMs()` **自己算「UTC+8 当日 24:00」**。
   ⚠️ **不能复用 `parseRateLimitError`**：它解析不到时间时会退回「1 小时后」
   （`Date.now() + 3_600_000`），那对**按自然日**结算的额度是错的 ——
   标记会过早失效，用户 1 小时后再撞一次同样的墙。

   ⚠️ **时区必须写死 UTC+8**（`QODER_BILLING_UTC_OFFSET_MS`），**不取本机时区**：
   额度是**服务端**按自己的账期结算的。服务端其他每日语义已实测为 UTC+8
   （每日领取活动原文即「每日 10:00（UTC+8）刷新」）。取本机时区会在用户出差/
   改系统时区时算出**错的解禁时刻**：偏东则标记过早失效，偏西则白等几小时。
   ⚠️ 用**算术**而非 `Date.setHours`：后者按**本机时区**运算，在非 UTC+8 的机器上
   会得到错的时间。

   ⚠️ **只标记该模型**（`modelRateLimits[modelId]`），不标记账号全部模型：
   额度是「模型 + 账号」维度的，该账号在别的模型上仍可能可用。

   ⚠️⚠️ **切号时必须传 `tried` 集合给 `getAvailableAccount`**：池按「限流重置
   时间最早到期」排序，**刚失败的账号可能仍排第一**，不排除就会拿回同一个账号、
   命中 `tried.has` 而**立即放弃切换**（与 `buddy-adapter.ts` 的同款注释同因）。
   ⚠️ `tried` 必须**跨重试保留**（不能在每次迭代里新建），否则会在两个账号之间
   **无限来回**。

   ⚠️⚠️ **标记用的「当前账号」必须是局部可变状态，不能每次问
   `options.currentAccountId()` 回调**：那个回调返回「池当前的默认账号」，
   一旦切到下一个账号它**不会跟着变** —— 若用它标记，切到 B 后失败时会
   **再标记一次 A**，而 B 从未被标记，下次取号又把 B 选中，于是在 A/B 之间
   **反复空转**。写单测时实测到了这一点（标记记录是 `['acct-A','acct-A']`
   而非 `['acct-A','acct-B']`）。
   ⇒ 实现上 `activeAccountId` 是 `stream()` 里的局部变量，切号后与 `credential`
   一同更新；`options.currentAccountId` 只用于**首次**确定起点。
   ⚠️ 回调本身由 `index.ts` 的 `activeQoderAccountId`（`Map<providerId, accountId>`）
   提供 —— 在 `resolveCredential` 里记录**实际返回的那个账号**，因为池的选号是
   即时决策，与适配器本次拿到的凭据可能是两个账号（标错会误伤无辜账号）。

   ⚠️ **两处都要接**（HTTP 层 + SSE 层），且调用**同一个**
   `switchAccountOnQuota()`：Qoder 的额度错误实测走 SSE（HTTP 200），
   但若哪天改成 HTTP 状态码下发，只处理一条就会漏。

   回归用例在 `tests/unit/qoder-adapter.spec.ts` 的
   「额度受限：标记当日 24:00 + 切换账号」段（8 条：4 条日界纯函数 + 4 条行为，
   后者用桩账号池断言「标记了哪个账号/哪个模型/什么时间」「取号时传了 tried」
   「切到新账号后重发」「全部受限时如实抛错不无限切」）。
   ⚠️ 已做**反向验证**：日界改用非 UTC+8 → 4 条变红；不传 `tried` → 2 条变红。


⚠️ **`src/qoder-auth-wasm.wasm`（298 KB）随插件分发**，构建时由 `scripts/copy-assets.mjs` 复制到 `lib/`（`tsc` 不搬 `.wasm`）。`build:all` 已含该步骤。

⚠️ **WASM 提取自 Qoder `0.3.4`**（runtime `1.1.57`）。升级方式：

```
pnpm qoder:wasm            # 自动取 .qoder-versions 下版本号最高的
pnpm qoder:wasm 0.3.5      # 指定版本
pnpm build:assets          # 同步到 lib/
```

取 `.qoder-versions/<v>` 而非 `resources/` —— 后者可能是与 IDE **实际运行**不同的版本
（实测 IDE 跑 0.3.4）。刷新后**必须实测一次对话**（`qfmodel` / `qmodel_38max`）确认签名仍被接受。

它**积分余额与每日领取都有**（能力矩阵登记为 `{balance:true, dailyCheckin:true}`），并复用 `src/openai-compat.ts` 的 OpenAI 协议层共享实现（消息序列化 / SSE 消费 / 错误归类）。详见 README 的「Qoder provider」章节与 `docs/superpowers/specs/2026-09-19-qoder-provider-design.md`。

### ⚠️ Qoder **中国版**（`qodercn`）：同协议、异配置，五个必须记住的点

中国版与国际版**共用同一套 `src/qoder*.ts` 实现**（含**同一份 WASM**），差异全在
`src/qoder-product.ts` 的 `QODER_CN`；服务端 `src/jet-hub-rpc.ts` 里四处 Qoder 分支
通过 `qoderFamily` 注册表分派，两个产品共用同一组回调。
新增同族产品时**不要复制实现文件** —— 那会让上面记着的每一处缺陷修两遍。
取证见 `docs/superpowers/specs/2026-09-27-qodercn-provider-design.md`（证据编号 E1–E13）。

1. **`client_id` 与国际版不同，且不能靠探测验证**：CN 是
   `732aef47-9cf2-46a2-95fe-4cebb5d0d1fa`（取自 CN asar 的 `Vpe.authClientIds.prod`），
   国际版两个 id 在 CN asar 里**命中 0 次**。CN 的 `prod` 与 `test` **同值**，
   所以不存在国际版 `J_a`/`G_a` 读反的那类风险 —— 但**入口 302 依然不能证明
   id 正确**（对任一 client_id 都回 302），必须真实登录闭环。
   ✅ 已实测通过（2026-09-27，`scripts/verify-qodercn-live.mjs`）：授权成功，
   拿到 uid `01a0df0a-…`（与本机 `~/.qoder-cn/.models/` 目录名一致，交叉印证）。
2. **模型表不能沿用国际版**：CN 是 **14 条**，独有 `q37fmodel`(Qwen3.7-Flash) /
   `gm51model`(GLM-5.2)，**没有** `ultimate` / `performance` / `efficient` /
   `smodel` / `cmodel` 五条（沿用会让菜单出现 5 个 CN 端点根本不认的模型）；
   另有 5 条 `max_input_tokens` 不同、4 条思考标记不同、
   `mmodel` 在 CN 是 **MiniMax-M2.7** 不是 M3 且 `is_vl` 为 false。
   ⚠️ **但那 5 条「上下文窗口不同」是假差异 —— 已推翻**（2026-09-27 实测）。
   见下方第 2.1 条：`contextWindow` 要取 `context_config` 档位表的最大档，
   两个版本的档位表**几乎相同**（除 `mmodel` 外都是 `{200K, 400K, 1M}`）。
   ⚠️ 改表同样必须逐个实发验证，且 `qoder-product.spec.ts` 对 CN 有**逐条数值断言**。
   ⚠️ CN 目录条目的标识字段名是 **`key`**，国际版是 `model_key` —— 重新采集时
   两个名字都要认（`scripts/probe-qodercn-catalog.mjs` 已如此实现），
   否则会得到「0 个模型」的**假阴性**（首跑真踩过）。

### 2.1 ⚠️ 上下文窗口必须取 `context_config` 档位表，**不要**取 `max_input_tokens`

**用户报障**：Qoder 的上下文窗口「显示得比官方小很多」（CN `dmodel` 只有 96K）。

**根因**：目录里两个字段会自相矛盾 —— CN `dmodel` 的 `max_input_tokens` 是 **96000**，
但 `context_config` 档位表是 `{200K, 400K, 1M}`。旧表照抄了前者。

**官方客户端只认后者**（asar 证据，`qoder-worker-runtime.obf.mjs`）：

```js
function zX(A,e){let t=jiA(e);if(void 0===t)return!1;
  let i=Yai(A);if(i)return i.includes(t);          // ← 档位表存在就只查成员资格
  let n=jiA(A?.max_input_tokens??A?.maxInputTokens);return void 0===n||t<=n}  // ← 兜底分支
```

`isContextWindowSupportedByModel()` → `zX()`：**只要档位表存在，`max_input_tokens`
那条分支根本不执行**。`max_input_tokens` 仅在「模型没有档位表」时才作兜底
（`Mz()` 的默认值还是 1048576）。故它**不是**「这个模型只能吃这么多」的声明。

**实测**（2026-09-27，CN 加密端点，`scripts/probe-qoder-context-needle.mjs`；
针埋在提示**正中间**，命中即证明未被截断）：

| 事实 | 证据 |
|---|---|
| `max_input_tokens` **不构成**服务端约束 | 声明 96K 的 `dmodel` 完整收下 **852,951** |
| `parameters.context_length` **也不构成**约束 | 同一 400K 提示，声明 180K / 200K / 1M / **不发该字段** —— 四种都完整送达（`prompt_tokens` 一致） |
| ⚠️ 真实上限**因模型而异**，**不是**网关统一值 | `dfmodel` 通过到 **999,991**；`qfmodel` 通过到 **983,490**、990,000 越界且**服务端明确回** `Range of input length should be [1, 983616]` |
| `983,616`（`1M − 16K`）**只对报了它的模型成立** | `dfmodel` 实测 999,991 > 983,616，已证伪「全局上限」。引用时必须说明适用范围 |

**逐模型实测记录**（用户 2026-09-27 据此定表）：

| 模型 | 实测通过（目标 tokens） | 服务端实际计入 | 越界点 | 越界错误形态 | 表里填 |
|---|---|---|---|---|---|
| `dfmodel` | 938,000 | **999,991** | 939,000 起 | `Internal Server Error` | **1M** |
| `qfmodel` | 984,000 | **983,490** | 990,000 | 参数错误 + `Range … [1, 983616]` | **1M** |
| `dmodel` | 800,000 | **852,951** | 985,000 | `Internal Server Error`（**无区间**） | **1M** |

⚠️ **`dmodel` 的实测只到 852,951，却仍填 1M —— 这是有意的**，别当成笔误：
口径是「**档位表有 1M 档就填 1M**」（用户 2026-09-27 定）。它的天花板确实未探明
（985,000 越界后只回 `Internal Server Error`，**不像 `qfmodel` 那样给出区间**，
无法反推真限），但 1M × 0.8 = **800K** 的压缩阈值**低于 852,951 这个已证安全点**，
故 1M 在 DSH 侧安全。⚠️ **不要因为"实测没到 1M"就把它改小**（改小会让 DSH
远早于官方能力触发压缩，正是本次要修的缺陷）。
⚠️ 其余 CN 模型（`qmodel` / `gmodel` / `kmodel` 等 9 条）**未逐个探顶**，
沿用档位表最大档 1M。

**所以取值口径（用户 2026-09-27 定）**：**档位表有 1M 档就填 1M**。

- `qfmodel` / `dfmodel` / `dmodel` 等档位表含 1M 档者 → **1M**
  （前两条实测逼近 1M；`dmodel` 依据档位表 + 800K 阈值安全）；
- **其余未逐个探顶**者（`qmodel` / `gmodel` / `kmodel` 等 9 条）沿用档位表最大档 **1M**；
- `mmodel` 档位表**只有 200K 一档** → **200K**；`auto` 无档位表 → **200K**。

**取证脚本**（均可离线跑）：`scripts/probe-qoder-windows.mjs` 打印每个模型的
档位表与 `max_input_tokens` 对照；`scripts/probe-qoder-context-limits.mjs`
用一次越界请求逼出服务端硬上限（⚠️ 只对**回区间**的模型有效，回
`Internal Server Error` 的探不出来）；`scripts/verify-qoder-context-fix.mjs`
把兜底表与目录档位表逐条对账。

⚠️ **改了本表必须重跑**这些脚本对照，不要凭印象填。

### 2.2 ⚠️ 思考档位：此前**根本没声明**，现已按远端目录给出

**用户报障**：「qoder中国版可以设置思考档位，我们应该按照他的设置给出可设置的
档位选择」。根因是 `QoderAdapter.resolveModel()` **只声明 `context`，从不声明
`reasoning`** —— DSH 的思考强度选择器**只会**从 `resolveModel().reasoning` 渲染
（`dsh-client-ui-model-selection`：`reasoning === undefined ? [] : …reasoning.efforts`），
所以两个站点的档位选择器**从来没有出现过**，尽管目录早就下发了 `thinking_config`。

**远端确实给了**（三个站的截图与 5 个账号的 catalog 逐条吻合）。**取值口径四条**：

| 项 | 来源 | 规则 |
|---|---|---|
| `efforts` | 目录 `thinking_config.enabled.efforts` 的**键** | 按目录原序（客户端也按键序渲染） |
| `defaultEffort` | 该对象里 `is_default: true` 的键 | **必须落在 `efforts` 内**，否则不发 |
| `supportsDisable` | 目录存在 `thinking_config.disabled` 分支 | 为真时**追加** `none`（复刻客户端 `gU()`） |
| `contextWindow` | `context_config` 最大档 | 见 2.1 节 |

⚠️ **「关闭思考」不在 `efforts` 数组里，靠 `supportsDisable` 表达**。客户端是在
`gU()` 里追加的：`… || e.includes("none") ? e : [...e,"none"]`。两者是**独立维度** ——
实测 `gfmodel`/`gmodel`/`kmodel`/`smodel`/`cmodel` **有档位但不能关闭**（无 `disabled`
分支），而 CN 的 `qmodel`/`qmodel_latest` **没有档位但能关闭**。**不要**用一个标志表达两件事。

⚠️ **展示名必须用官方中文**（否则与 IDE 不一致）。权威来源是 **IDE 自己的 i18n**
（asar `settings.efforts`，`scripts/probe-qoder-effort-i18n2.mjs` 可取）：
```
none:关闭思考  minimal:最小  low:低  medium:中  high:高  xhigh:极高  max:最大
```
DSH 的档位选择器**直接渲染 `efforts[].name`**（不本地化、不查字典），故给中文即中文界面。

⚠️ **档位值必须在白名单内**，否则会被客户端**静默丢弃**。asar 常量：
- 白名单 `Qj = ['none','low','medium','high','xhigh','max']`；
- 别名 `_lc = { disabled: 'none', off: 'none' }`；
- 归一化器 `ao()`：先查别名，再看白名单，都不在则丢弃。

⚠️⚠️ **`qmodel` / `qmodel_latest` 只有「关闭思考」一项 —— 这是远端事实，不是遗漏**。
它们的 `thinking_config.enabled` **没有 `efforts` 键**，只有 `description` + `is_default`：
```json
{"disabled":{"description":"Disable thinking"},
 "enabled":{"description":"Enable thinking","is_default":true}}
```
用户 2026-09-28 明确：「上面两个没有思考档位就是关闭的意思」。
**不要**给它们补默认档位（我曾按截图猜「关/低/中/极高+默认中」，那是错的）。
同理 `auto` / `q37fmodel` / `mmodel` **连 `thinking_config` 都没有** → 不声明
`reasoning`，UI 显示「当前模型未提供推理等级」（对应 IDE 的「不支持」）。

⚠️ **两个站的档位表必须分别采集，不能互相套用**：同一个 key 的默认档可能不同 ——
`qmodel_38max` 在 **CN 是 `medium`、国际版是 `xhigh`**；国际版 `ultimate` 是
`xhigh/high/low/max/medium`（默认 high），CN 无此模型。

**取证脚本**（均离线、零额度）：
- `scripts/probe-qoder-effort-matrix.mjs`：逐模型打印档位/窗口/可关闭/默认；
- `scripts/probe-qoder-effort-fields.mjs`：按客户端 `$lc` + `Qj` **完整复刻**算法；
- `scripts/probe-qoder-effort-i18n2.mjs`：从 asar 取官方中文名；
- `scripts/verify-qoder-model-meta.mjs`：**兜底表 vs 目录实值逐条对账**
  （档位/默认档/可关闭/窗口 四项，当前 31 条全绿）——**改表后必须重跑**。

回归用例在 `tests/unit/qoder-adapter.spec.ts` 的「resolveModel 的思考档位」段
（7 条，含「官方中文名」「只有关闭思考的两个模型」「不提供关闭的模型不追加 none」
「无 thinking_config 的不声明 reasoning」「defaultEffort 必须落在 efforts 内」）。
⚠️ 已做**反向验证**：去掉 `dmodel.supportsDisable` → 1 条变红；给 `qmodel_latest`
补上猜测档位 → 1 条变红；`defaultEffort` 改成 `max`（不在 efforts 内）→ 1 条变红。
⚠️ **写用例时注意 `makeAdapter()` 默认用国际版表**（`QODER`）——测 CN 必须显式传
`product: QODER_CN`，否则会拿错默认档（我第一版就这么错过）。

⚠️ **端到端字段已验**（`scripts/verify-qoder-effort-wire.mjs`，离线）：
`reasoningEffort: 'max'` → `parameters.reasoning_effort='max'` + `enable_thinking=true`；
`'none'` → `enable_thinking=false`（真正关闭）；不发档位时两个字段都不写。

3. **CN 没有公开的 OpenAI 兼容端点**：`gateway.qoder.com.cn` 与
   `openapi.qoder.com.cn` 上的 `/model/v1/chat/completions` 实测都回 **503**。
   故 `QODER_CN.inferBase` 填成与 `encryptedInferBase` 同值，仅表示「无独立公开端点」，
   **不要**据此发请求。（`inferBase` 与 `QODER_CHAT_PATH` 在整个代码库里本就
   **无任何调用方** —— 是公开端点方案被加密端点取代后留下的死配置，
   删除属于越界重构故保留，但新增代码不得再依赖它。）
4. **machine 身份与产品无关，但目录要遍历两个**：实测两站 `runtime-info.exe`
   （**SHA256 相同**）在同一 `environment`（仍为 `'3'`）下返回**逐字节相同**的
   `machineType` / `machineCode`（`env=0` 则两站同为另一套值）—— 身份由
   「设备 + environment」决定，**与产品无关**。
   所以**不需要**按产品分别缓存（那只会多一次 3.8 秒的无意义 spawn），
   也**不要**把目录列表放进 `QoderProduct`（没人读它 = 死配置，且会让人误以为
   「一产品认一目录」）；它落在 `src/qoder-machine.ts` 的模块常量
   `QODER_DATA_DIR_NAMES = ['.qoder', '.qoder-cn']`。
   ⚠️ 原实现把 `~/.qoder/.bin` 写死，**只装了中国版**的用户因而找不到 exe →
   退到陈旧磁盘缓存 → 拿不到 machine 头 → 积分误报「今天已领」 ——
   这正是 2026-09-25 那次修复的**复发路径**（已修，反向验证过用例会红）。
5. **加密推理可共用那份 WASM，已实证**：用国际版（从 0.3.4 / runtime 1.1.57 提取）
   那份 `src/qoder-auth-wasm.wasm` ① 成功解密 CN（runtime 1.1.64）下发的
   `catalog-v6`；② 签出的推理请求被 `gateway.qoder.com.cn` 接受
   （**HTTP 200 + 15 个 SSE 帧**）。故**不分发第二份产物**，
   `scripts/copy-assets.mjs` 与 `scripts/extract-qoder-wasm.mjs` 均无需 CN 变体。
   ⚠️ 顺带纠正 `qoder-wasm.ts` 里「`session_type` 国内版是 `qoder_work`」那条注释：
   它**不适用于推理载荷** —— CN 实测接受默认值 `qodercli`；
   CN asar 里 `qoder_work` 的唯一命中属于 `integrationMode → --ide-type`，另一回事。
   ⚠️ `clientMetadata` 沿用国际版的 **CLI** 身份（`client_type:'5'`）在 CN 也可用，
   不必换成 CN 桌面端的 `Fh` 那组 —— 但仍**不要**把 `sashClientType`（`'10'`）
   与它合并，那仍是两个不同身份（见上文）。

积分链路（`/sash/`）在 CN **整套复用成立**，实测：余额 `total=400`
（套餐额度 300 + 资源包 100，多包累加口径与国际版一致）、
`active=true / todayCheckedIn=false / dailyCredit=100`、
真实领取 `claimed +100` 且余额 `400 → 500`。
CN asar 里同样是 `Fh = Object.freeze({ clientType: 10, … })`，
且 sash 请求头 UA 恒为 `"Qoder"`。

排查脚本（均只读、零额度）：`scripts/probe-qodercn-clientid.mjs`（asar 里的
`authClientIds` 与授权 URL 构造 `Sft()`）、`scripts/probe-qodercn-catalog.mjs`
（用**国际版** WASM 解 CN 目录并输出可粘贴的 TS 兜底表条目）、
`scripts/verify-qodercn-live.mjs`（一次性「登录→推理→积分」，**token 不落盘**）。
e2e：`pnpm test:e2e:qodercn`（只读）/ `:qodercn-chat` / `:qodercn-credits`。

### ⚠️ `scripts/` 里哪些入库、哪些**不入库**（容易误判）

`.gitignore` 有 `scripts` 一行，但**它只对未跟踪文件生效** —— 已被跟踪的文件
不会因该行而移出仓库。故现状是「部分入库、部分不入库」，**新增脚本前先看清**：

| 类别 | 入库 | 说明 |
|---|---|---|
| **构建必需** | ✅ | `copy-assets.mjs`（`pnpm build:assets` 用它把 `.wasm` 复制到 `lib/`）、`extract-qoder-wasm.mjs`（`pnpm qoder:wasm`）。**删了构建会坏** |
| **图标/产物提取** | ❌ | `extract-qodercn-icon.mjs` 等 —— 产物是提取自客户端安装目录的二进制，不入库 |
| **只读排查/取证** | ❌ | `probe-*.mjs` / `verify-*.mjs` —— 本文件大量引用它们作为「怎么复核这个结论」的指针，但**它们不在仓库里** |

⚠️ **因此 AGENTS.md 里 `scripts/xxx.mjs` 的引用是「本地指针」而非仓库文件**：
新克隆的仓库里**没有**这些脚本，需要时按本文件描述的思路自行重写
（多数脚本只做「解压/解析/打印」，几十行即可复现）。
⚠️ 引用它们**不代表它们存在** —— 别照着路径去 `import`（没有任何 `src/` 代码
依赖它们；注释里的提及仅作文档指针）。

⚠️ **不要把只读排查脚本 `git add -f` 进去**：`.gitignore` 的 `scripts` 行是
**有意为之**（研究工具仅本地保留）。`git add -f` 会绕过它，让仓库里出现
「本不该入库」的文件 —— 2026-09-27 真踩过（`probe-qoder-queue-error.mjs` 等
被强加进去，事后又得撤出）。


### ⚠️ Qoder 积分余额：路径在 `/sash/` 下，且只需 Bearer

`GET {openApiBase}/sash/api/v2/me/usage`（实现见 `src/qoder-credits.ts`），
请求头 `Authorization: Bearer` + **`Cosy-ClientType`**，**不需要** WASM 签名。

两个**真实踩过的坑**：

1. **只按 `/api/` 前缀搜端点会漏掉它** —— 它挂在 `/sash/` 下。早期据此误判
   「Qoder 无积分端点」并把能力登记成 `balance:false`（用户报障：
   「登录成功了，没有获取积分吗？现在应该是一个资源包 100 积分」）。
2. **余额不只在 `userQuota` 里** —— 实测 `userQuota.remaining=0` 而
   `addOnQuota.remaining=100`（资源包）。只读 `userQuota` 会显示 0。
   另有 `dedicatedResourcePackages` 需一并累加。

企业版（`displayMode:"enterprise"`）不下发额度数字、只给外部链接 →
返回 `null`（UI 显示「查询失败」）而非 `0`。

### ⚠️ Qoder 每日领取：端点由 **keylog 解密抓包** 解出（2026-09-21）

```
GET  {openApiBase}/sash/api/v1/me/campaigns
POST {openApiBase}/sash/api/v1/me/campaigns/{campaignId}/claim   ← body **空**
```

**请求头（`/sash/` 端点必需四项）**：`Authorization: Bearer` + `Cosy-ClientType: '10'`
+ **`Cosy-MachineToken` + `Cosy-MachineType`（成对）**，**无需签名**。

⚠️ **两个条件缺一不可，且是「必要但不充分」的叠加关系**（真实缺陷，
2026-09-25 定位并**端到端修复验证**：插件领取成功、余额 0→100）：

| 请求头 | `/sash/api/v1/me/campaigns` 响应 |
|---|---|
| `Cosy-ClientType: '5'`（CLI 身份） | `{"showCampaign":false,"claimable":false,"campaignUrl":"","campaigns":[]}` |
| `Cosy-ClientType: '10'` + 无 machine 头 | `showCampaign:true, claimable:false`，**1 条 `VIEW_DETAILS`** |
| `Cosy-ClientType: '10'` + MachineToken + MachineType | `claimable:true`，**2 条**，含 `CLAIM_BENEFIT/CLAIMABLE/amount:100` |
| ＋MachineToken/MachineType **去掉任一个** | ❌ 退回 1 条（**必须成对**） |
| 单独加 `Cosy-MachineId`/`Version`/`OS`/`Hostname`/`Code` | ❌ 均无效（**都不是必需项**） |

⚠️ **`'10'` 单独不够** —— 这是被 PR !11 的错误结论误导过的地方。它只让服务端
回一条 `VIEW_DETAILS`（`claimable:false`），**没有** `CLAIM_BENEFIT`，于是插件
筛出 0 个可领活动并误报「今天已领」。**真正决定下发可领活动的是成对的
machine 头**。实现见 `src/qoder-machine.ts`。

⚠️ **值的来源可自给自足，不需要抓包**：`%APPDATA%\Qoder\SharedClientCache\
cache\machine_token.json` 的 `token` → `Cosy-MachineToken`、`type` →
`Cosy-MachineType`。实测该文件即使 `updateAt` 很旧（179 天前）token 仍有效。
读不到时**保守降级**（不带这两个头，回到修复前行为）——纯插件登录、未装
Qoder 桌面端的用户没有该文件，不能让积分功能整体失败。

⚠️ **`'10'` 的来源是官方常量**，不是猜的：Qoder 桌面端 `app.asar` 里有
`Mh = Object.freeze({ clientType: 10, businessProduct: 'app', sessionType: 'app' })`，
native 另有 `rl = Object.freeze({ clientType: 10, businessProduct: 'app' })`。

⚠️ **不要合并两处 client_type**：`clientMetadata.client_type`（`'5'` + `cli`）
是**推理请求体**加密信封 `metadata` 用的（源码 `Fp()` 的 CLI 默认值），
与 `/sash/` 的 HTTP 头**是两个不同身份**。改动前先在 `qoder-adapter.ts`
确认用途，别把推理那条链路一起改掉。

⚠️ **用户症状是「插件报今日已领取、但官方能领」**：`campaigns:[]` 或只有
`VIEW_DETAILS` 会让 `claimableCampaigns()` 筛出 0 个 →
`claimQoderDailyCheckin` 返回 `already-claimed`，**把「服务端没下发数据」
误报成「今天已领」**。排查时**不要只看这个文案**，先确认上述四个头是否齐全。

⚠️ **「今天已领」的正确判据不是「列表为空」**（2026-09-21 抓包实测的
**领取前后对照**，这是该判据可靠性的直接证据）：

| 时刻 | `claimable` | 那条 `CLAIM_BENEFIT` 的 `claimStatus` | 列表 |
|---|---|---|---|
| 领取前 | `true` | `CLAIMABLE` | 非空 |
| 领取后 | `false` | `CLAIMED` | **仍非空** |

即**领取成功后服务端并不清空列表**，只是把该条改成 `CLAIMED`。故判据必须是
「存在 `CLAIM_BENEFIT` 且 `CLAIMED`」，而「列表为空 / 只有 `VIEW_DETAILS`」
应判**未领**。方向取保守：误报未领最多让用户多点一次（服务端幂等，回
`replayed:true`，无害）；误报已领会让其**真的错过当天积分**。

⚠️ **幂等判据是响应体的 `replayed`，不是 HTTP 状态码**：重复领取同样返回
**200**，但 `replayed:true`、**不含 `benefit`**，且 `claimedAt` 是**上一次
领取的旧时间**（实测请求发生在 09-21、而 `claimedAt` 是 09-18）。
只看状态码会把「今天已领」误报成「领取成功 +100」。

⚠️ **请求体必须是空串**（抓包实测 `content-length: 0`）。

⚠️ **只领 `actionType === 'CLAIM_BENEFIT' && claimStatus === 'CLAIMABLE'`** ——
实测还有 `VIEW_DETAILS` 型活动（如「Pro 首月翻倍」），对它发 claim 是错的。

⚠️ **为什么曾经误判「Qoder 无签到」**：`/sash/api/v1/me/campaigns` 当时返回
`{"showCampaign":false,"claimable":false,"campaigns":[]}`，据此下了结论。
真相是**那天已领** —— 活动**每日 10:00（UTC+8）刷新**（响应里
`description: "每日 10:00（UTC+8）刷新，领取后 30 天有效"`）。
**教训：「某次实测没看到」不能推广成「不存在」**，这与 TRAE「带 code 的
回调」那次是同一类错误。

⚠️ **`CheckinStatus.active` 必须恒为 `true`**（拿到响应即 true，不按
「列表非空」判）：服务端在活动不同阶段都可能回空列表（如请求头不全时），
若据此判 `active:false`，`collectClaimResults` 会先命中「活动未开启」分支，
把「今天已领」误报成「签到活动未开启」。

⚠️ **但「今天已领」不可反推成「列表为空」** —— 2026-09-21 抓包实测领取前后
对照显示：**领取成功后列表仍非空**，只是那条 `CLAIM_BENEFIT` 的
`claimStatus` 由 `CLAIMABLE` 变 `CLAIMED`、顶层 `claimable` 变 `false`。
正确判据见上「Qoder 每日领取」章节。

⚠️ **RPC 分支须传 `precheckStatus: false`** —— `claimQoderDailyCheckin`
自带活动列表查询，否则会重复发一次 GET（与 LobsterAI 传 false 同理）。

### ⚠️ `openai-compat.ts` 只服务 qoder，不要顺手重构既有适配器

`src/openai-compat.ts` 把「消息序列化 + SSE 消费」抽成共享实现给 **qoder 适配器**用。`buddy-adapter.ts` / `lobsterai-adapter.ts` **刻意不改用它** —— 那两份实现已被大量单测与线上流量验证，重构它们属于与本任务无关的高风险改动。若将来要统一，应作为独立任务并配以逐条对拍测试。

它承载的教训（改它时必须保留）：`delta.content` / `delta.reasoning_content` 会显式返回 **`null`**（必须 `typeof === 'string'` 判定）；孤儿工具调用须剔除（否则后端 400 且坏历史被反复重放）；`function.name` 只允许非空覆盖；残缺参数**不补 `{}`**（补了会让 harness 报 schema 错误而非重试）。

`trae` 同样**完全独立**（第五个脉系，独立一套 `src/trae*.ts`），且差异点与其他四者都不一样：认证用 **ExchangeToken 轮换 refreshToken**（不是轮询、也不是 authCode 交换）；鉴权头是 `Cloud-IDE-JWT <token>` 加十余个 `X-*` 身份头；**请求体需要从 OpenAI 格式转换为 SOLO 格式**（`function` / `config_name` / `tools.parameters` 序列化等）；**响应是 SOLO 自定义 SSE 事件**（`output` / `token_usage` / `done` / `error`），必须自行解析并转成 OpenAI chunk；凭据还必须持久化 `machine_id` 与 `device_id`（均为 **32 位 hex**，分别用作设备指纹与签到设备号，后者账号间必须互异）。**登录回调默认直接回传 token**（`auth_callback_url` 参数，老流程没有 `code`；但也并存 PKCE 新流程，两套都要认），详见下「TRAE 协议要点」。实现见 `docs/trae-integration-plan.md`。

Jet Hub 设置页（`plugin-src/client/jet-hub.js`）提供多账号管理与限流自动切换；「一键领取积分」按钮（每日签到）**CodeBuddy、LobsterAI、CodeArts、Qoder、Qoder 中国版与 TRAE 六个面板提供** —— 国际版 WorkBuddy 与 Cline 不提供（两者的后端都没有签到接口）。各面板是**互不相同的协议**（见下「积分领取」）。

⚠️ Qoder 国际版与中国版**共用同一组领取实现**（`src/qoder-credits.ts` 的函数一律
接收 `product` 参数），RPC 侧通过 `jet-hub-rpc.ts` 的 `qoderFamily` 注册表分派。
新增同族产品**不要**在四处分支各加一条平行 case —— 平行 case 越多，漏接概率越高
（`workbuddy` 的「刷新」按钮就是这么一直坏着的）。

- **包名**：`dsh-providers-hub`
- **入口**：`lib/index.js`（宿主侧）、`lib/client/jet-hub.js`（客户端 bundle）
- **构建**：`pnpm build:all`（`tsc` 编译宿主侧 + `esbuild` 打包客户端）
- **语言**：TypeScript
- **许可**：MIT

## ⚠️⚠️ 思考档位「默认取最强」（PR #70，2026-11-13）

**功能**：用户选完模型后，**默认**使用该模型声明的最强思考档（`max` / `xhigh` 等）；
可在设置弹窗的「思考强度」里关掉。关掉后**逐字节**回到改动前的行为。

### 为什么走「改适配器声明的 `defaultEffort`」这一条路（四条路线只有它可行）

| 路线 | 结局 |
|---|---|
| ① 请求期改写（`agent/request` 瀑布 / `prepareRequest`） | ❌ 宿主 `dsh-agent-loop/lib/index.js` 的 `prepareRequest` 有硬不变式：`proposedConfig.reasoningEffort !== selection.reasoningEffort` 就**直接抛错**（「use agent.model.select() before step preparation」），整轮对话起不来 |
| ② 逐个适配器改 `defaultEffort` 常量 | ❌ 二十余处，且 trae / buddy / zcode 等档位来自**远端目录**，不在常量里 ⇒ 必然漂移 |
| ③ 在 `stream()` 里补档位 | ❌ 界面标签不变、网关 `resolveCallWithInfo` 仍按声明校验、二十个适配器各写一份 |
| ④ **注册期包住 `resolveModel` / `prepareCall` 的返回值**（`src/reasoning-default.ts`） | ✅ 一处覆盖全部渠道，选择器 / 请求体 / 网关三端同时一致 |

### 三条不变式（改这个文件时不得破坏）

1. **选出的档位必须来自模型自己声明的 `efforts`** —— 否则宿主 `normalizeModelInfo`
   抛 `INVALID_MODEL_REASONING`、`resolveCallWithInfo` 抛 `UNSUPPORTED_REASONING_EFFORT`。
2. **无变化时原样返回入参（同一引用）** —— 下游有 `deepFreeze` 与函数/对象身份比较。
3. **模型没声明档位时一个字都不动**（`reasoning` 缺席 ⇒ 原样返回）。

另：封顶 `max`（不选 `ultra`）。`REASONING_EFFORT_RANK` 里 `ultra: 9 > max: 8`，
但本仓此前**没有任何渠道**把 `ultra` 当真实 wire 值（只为翻译存在）；聚合渠道声明了
8 个规范档，不封顶会让默认档变 `ultra`。只有模型**仅**声明了更强档时才退回。

### 两条腿缺一不可（只包一条 = 假绿）

- **腿 A（选择器/目录）**：宿主 `dsh-llm/lib/index.js:2119` 的 `resolveModelInfoFor`
  → `adapter.resolveModel(...)`，消费方是 `session.modelCatalog` → 模型选择器读
  `model.reasoning.defaultEffort`（`dsh-client-ui-model-selection/lib/client.js:1201`）。
- **腿 B（生产请求）**：`dsh-llm/lib/index.js:2225` 的 `prepareCall`
  → `adapter.prepareCall(...)`。基类默认实现**会**调 `resolveModel`，但动态适配器
  **可以覆盖掉**（源码注释逐字「Dynamic adapters override this」）⇒ 两条腿
  **不可互相替代**。只包 A = 「选择器显示 Max、请求仍按 high 发」。

### 开关：独立文件 + 只有显式 `false` 才算关闭

- 文件 `$DSH_HOME/jet-hub/reasoning-preferences.json`，`SCHEMA = 'dsh-codearts-auth/reasoning-preferences/v1'`。
- **不塞 `state.json`**：它是 home 级、多 profile 共享、**整体替换**语义 ⇒ 同机另一
  工作区的旧版本代码做任何整体写入都会把新字段静默抹掉（症状是「怎么又变回 high 了」）。
- `sanitizeStrongestReasoningEnabled(raw) = raw !== false` —— 只有显式 `false` 才关闭；
  字符串 `'false'` **不算**（脏数据不是用户意图）。与 `sanitizeNativeWebSearchEnabled` 同构。
- **读取失败按「开启」处理**（抛错当关闭会让功能无缘无故消失，且用户彻底失去自救路径）。
- 开关是**回调而非布尔**：`configureStrongestReasoningEnabled(() => store.load())`
  —— 每次请求都走 `prepareCall`，必须现读（缓存布尔值 = 「改了不生效要重启」）。
- 文件层有**模块级缓存**（`parsedCache`）：`session.modelCatalog` 会对**目录里每个模型**
  各调一次 `resolveModel`，实测单次 `load()` **102 µs**（500 个模型多 51 ms 同步阻塞）；
  `save()` 落盘后**必须**同步刷新缓存（写者与读者同进程）。单测用
  `resetReasoningPreferenceCache()` 模拟「重启后首次读」。

### 标题请求必须降档（Issue IKKVDH 的原始形态）

默认档被抬到 `max` 后，会话命名请求只给 **64 token** 思考预算 ⇒ 思考吃满、正文
0 字符。**只降档不改预算不够**（实测 `effort:low` + 64 token 同样吃满）；
**必须在开关开着时才降**（否则是白降，实测 153 思考 + 10 字正文）。
判据只有一处：`titleEffortWhenStrongest()`（内部判开关），`session-title.ts`
**不得**自己判开关、也不得直接用 `weakestThinkingEffort`。

### 代价（是功能本身，不是缺陷）

思考 token 计入 `completion_tokens`、与正文**共享额度** ⇒ 长回答更早撞 `length`、
首字更慢。设置弹窗里有一句 `.dim-jh-settingsNote` 讲这件事（不要删）。

### 两条容易误读的事实

- **「推翻四处既有决策」= 运行时覆盖，不是改常量**：`git diff --name-only` 里
  **没有** `trae-adapter.ts` / `loomy-adapter.ts` / `cline-product.ts` /
  `aggregate-adapter.ts` —— 它们的 `defaultEffort` 常量逐字节未动，只是开关**开着**
  时被覆盖；关掉即回到各自的值。
- **平局方向两侧相反**：`strongestDeclaredEffort` 同 rank 取「规范名更靠后」者
  （`high` 胜 `on`），`weakestThinkingEffort` 反之（`on` 胜 `high`）。因为
  `CANONICAL_REASONING_EFFORTS` 不含 `on`/`off`/`light`/`extra_high`
  ⇒ `canonicalIndex('on') = -1`。**不是缺陷**，但排障时看到标题请求实发
  `reasoning_effort: 'on'` 不要惊讶。

### `PROVIDERS_WITHOUT_REASONING` 当前是「测试契约」

`src/reasoning-default.ts` 的 `PROVIDERS_WITHOUT_REASONING` /
`providerWithoutReasoning` / `registeredChannelIds` 在 `src/` 与 `plugin-src/`
**零读取**（只有 `tests/unit/model-catalog-parity.spec.ts` 与
`tests/unit/reasoning-default.spec.ts` 用）。**不要**按旧注释去面板里找灰字提示
（不存在，面板渲染的是与 provider 无关的静态句）；将来若要渲染，**必须**消费这份
名单，不要在客户端再列一份。

**守卫**：`tests/unit/reasoning-default.spec.ts`（23 条，含「两条腿经真实
`registerAdapterIdempotent` 都生效」与私有字段/访问器透传）、
`tests/unit/reasoning-preferences.spec.ts`（7 条）、
`tests/unit/checkin-panel-wiring.spec.ts`（接线层 2 条，真渲染点中开关）。

## ⚠⚠️ Gemini 必须过墙而插件不读系统代理（Issue IKLTZ2，2026-10-18 修）

**症状**（用户报障形态）：浏览器**能**打开 Google 授权页并点「同意」，回到面板却
报授权失败、账号列表里始终没有 `gemini`。**极易被误判成 `client_secret` /
`redirect_uri` 问题** —— `gemini-oauth.ts` 文件头第 1 条注释描述的正是同一种现象，
而那个 bug 早已被修掉。

**根因**：`gemini` 全部端点（`oauth2.googleapis.com/token`、userinfo、
`cloudcode-pa.googleapis.com` 的 `loadCodeAssist` / `retrieveQuotaSummary` /
`streamGenerateContent`）都在墙外；插件走 Node 内置 `fetch`（undici），而它
**既不读 Windows WinINET 系统代理（浏览器读，所以浏览器能用）、也不读
`HTTP(S)_PROXY`**。

### 本机实测（Node 22.19 / 24.21 / 26.10，用假代理记录 CONNECT）

| Node | 仅设 `HTTPS_PROXY` | 再加 `NODE_USE_ENV_PROXY=1` |
|---|---|---|
| 22.19 | ❌ 不读 | ❌ 不读 |
| 24.21 | ❌ 不读 | ⚠️ 读，但失败后**无限重试**（假代理收到成千上万条 CONNECT），界面长时间无响应 |
| 26.10 | ❌ 不读 | ✅ `UND_ERR_PRX_CONN`（20ms，CONNECT 已命中） |

⚠️ 「Node 22 完全不读」这条**修正了 issue 原文**（它只测了 24 与自己的版本）。

### ⚠⚠️ 宿主已有一层全局代理，但它**不读系统代理**（决定了这不能算「issue 无效」）

DSH 启动器在**第一个插件加载前**调 `installProxyFromEnvironment`
（`@deepseek-ai/dsh` 的 `lib/profile-boot-*.js`），内部
`setGlobalDispatcher(agent)` 装一个按策略路由的 Agent ⇒ **Node 内置 fetch 解析的
正是它**。实测：调用它之后发**裸 fetch**，`CONNECT oauth2.googleapis.com:443`
确实命中假代理；`127.0.0.1` 被 loopback bypass 放行（未进代理）。

**但它只读环境变量**（`resolveProxyPolicy` 只查 `all_proxy` / `http_proxy` /
`https_proxy` / `no_proxy`，**全仓无 `winreg` / 注册表读取**）⇒
「只开了系统代理开关、没导出变量」的用户仍然 `source === 'none'`、全局直连，
**issue 原样复现**。本机实测正是这一格（`ProxyEnable=0`、`ProxyServer` 是残留键、
端口无监听、环境变量为空）。

⇒ 结论：宿主那层覆盖了「导出了变量」这一格，插件补的是**剩下那一格**（per-账号）。

### 修法与取舍

| 方案 | 评价 |
|---|---|
| **文档 + 可诊断性** | 性价比最高，已落地（README「出不去墙外服务」一节 + 四条腿的指路文案） |
| **per-账号代理** | 已落地。复用 `opencode-proxy.ts` 的 `proxyFetch`（**不**自己写第二份） |
| **插件装全局 dispatcher** | **不建议**：`opencode-proxy.ts` 模块头记着 opencode2dsh 的 R1 教训（抢全局槽位会互相短路整个路由层），且宿主已占用该职责 |

### ⚠⚠️ 四个极易漏的接线点（本次实做时踩全了）

1. **`gemini-adapter.ts` 的推理腿此前连 seam 都没有** —— `stream()` 里
   `streamGenerateContent` 是**写死的裸 `fetch`**。issue 建议说「接上已有的 seam」，
   **照字面实现会让推理主路径漏掉代理**，而它恰恰是用户唯一会卡住的那条路。
   ⇒ 新增 `fetchImpl`（推理）与既有的 `projectFetcher`（探测）**两个**字段，
   合成一个会让「只拦探测」的测试用例意外拦到推理。
2. **登录时凭据还没落盘**，只有池里的**占位条目**认得那个账号 ⇒
   `startLogin` 必须显式收 `accountId` 并传进 fetcher 解析器。
3. **适配器会换号**（限流 / 401 时 `getAvailableAccount`）⇒ fetcher 解析器
   **必须在循环内按 `currentAccountId` 现取**。固化在循环外的症状是
   「换了号还是超时」，且**零报错**。
4. **积分路径有两份表**（`src/index.ts` 的 `creditsTable` 与 `src/jet-hub-rpc.ts`
   的 `credits`），只接一处 ⇒ 「面板能刷新、聚合折算却失败」。这与 `minimaxXff`
   （issue IKMEVG）是**完全同型**的坑。

⚠️ `ProviderCallContext` 新增 `accountId` 的理由：账号 id 与 `credentialRef`
**没有可逆映射**（ref 由 RPC 随机生成），而按账号取出口必须知道 id。
⚠️ **两处消费点必须都透传**：`jet-hub-rpc.ts` 的 `collectCreditBalances`
（逐账号包装成**每账号一份** callContext —— 共享单例会让所有账号都查到
「最后一个」账号的代理）与 `index.ts` 的 `fetchBalanceReading`
（`entry.id` 就是 `accountId`）。

### ⚠️ 池字段**刻意分成两个**而不是复用 `opencodeProxy`

两者语义不同：opencode 的代理是「多账号要分份额度」，Gemini 的是「单账号能不能
连通」。共用一个字段 ⇒ 「清掉 Gemini 的代理」连带清掉 opencode 的出口配置。

### ⚠⚠️⚠️ 代理字段来自**用户可编辑的备份文件** ⇒ 读取侧必须过 `asProxyText`

**实测的真缺陷**（独立于两轮审计，由实现者自查发现）：
`sanitizeAccounts`（`src/jet-hub-store.ts`）对未知字段用 `{ ...candidate }`
**原样透传**、**不校验形状**（对照 `modelRateLimits`：那个已由 `isValidResetAtMs`
加固）。于是手编备份里的 `"geminiProxy": 12345` 会**原样进池**，而
`normalizeProxy` 第一句是 `input.trim()` ⇒ 抛
`TypeError: raw.trim is not a function` ⇒ **该账号永久不可用且无自愈**
（症状与「代理配错了」同形，排障者会去查代理配置，而真因是备份脏数据）。

⚠️ **opencode 同样中招**（`poolEntrySnapshot` 把 `proxy` 原样透传 →
`buildProxyDispatcher` 读 `proxy.url`）—— 这正是 `src/types.ts` 里 `expiresAt`
注释记的那句「**补了 A 格、漏了同族 B 格**」的又一次实例。

⇒ 修法 = `asProxyText(value)`（`account-pool.ts` 导出，**两个**读方法共用）：
只放行字符串，其余（数字/对象/数组/布尔/null/undefined）一律降级为空串（= 直连）。
⚠️ 刻意**不删键、不改盘**：读侧只保证「不崩、行为确定」，用户仍可在面板里
重新配一次覆盖掉它。
⚠️ 守卫必须**两个读方法都断**（只断 `setGeminiProxy` 的函数体是「改了一半」的
形态 —— 读取侧串成别的字段时写入侧完全看不出来；对抗审计 M21 实测过这条）。

### ⚠⚠️ 诊断函数的 `aborted` 形参一度是**死参数**（恒传字面量 `false`）

`geminiNetworkHint(error, aborted)` 的三处调用点**全传 `false`**，而其中两处
**恰恰自己 arm 了** `AbortSignal.timeout(GEMINI_OAUTH_TIMEOUT_MS)` ⇒ 墙外连接
超时（**不带** `UND_ERR_*` 码，正是 IKLTZ2 的主症状）反而拿不到提示。

⚠️ 这是「**写进去却没人读**」的形态，也是本仓库反复记的那类：形参存在、签名正确、
tsc 全绿，**没有任何机制**提醒它没被真正使用。
⇒ 三处改为真读 `signal.aborted`；`refreshCredential` 因此多一个 `onSignal`
回调把 signal 透给 catch（⚠️ **每账号各一个局部量**，共享会让 B 的日志引用
A 的 signal）。

⚠️ 可推广：**给函数加形参时，「所有调用点都传了值」不等于「那个值有意义」** ——
要问的是「调用点**为什么**该传这个值」，而不是「它有没有传」。

### ⚠⚠️ 重登 = 新造 id ⇒ 代理配置必然丢失（**死锁**，已修）

「refresh_token 失效 ⇒ 删号重登」是面板明示的既定动作，而 `account.create`
的 `id` 是**每次新造**的（`jet-hub-rpc.ts` 里**全仓仅此一处**生成）⇒ 旧号上的
代理配置必然丢。而换 token 那一步恰好发生在**凭据落盘之前**（只有池里的占位条目
认得这个账号）⇒ 不带代理就**登录恒失败**；用户又**没法给一个还不存在的账号配
代理**（面板的「代理」按钮按 `accountId` 打开）⇒ **死锁**，唯一出路是导出
`HTTPS_PROXY`。

⇒ 修法 = 占位条目落地时带代理，两级来源：① 载荷显式带（`RpcCreateAccountRequest
.geminiProxy`，为将来 UI 提供输入留口）；② **从同 provider 的已有账号继承** ——
只在**恰好一个**账号带代理时生效（多账号时无法判断该继承哪个，**宁可直连也不要
猜错出口**把凭据发到错误的代理上）。

⚠️ 全仓 0 处 `account.relogin` ⇒ 「保留 id 原地重登」这条路当时确实不存在
（审计实测 grep 确认），不是漏搜。

### ⚠️ 「测试连接」必须打 Google，**不能**打出口 IP 服务

opencode 的测试打 `ip-api.com`（能显示出口 IP 与地区）。Gemini 这里照抄会产生
**假阳性**：代理能通 `ip-api` 却被 Google 拒（DNS 污染 / 分流规则 / Google 侧封禁），
用户看到绿色以为配好了，面板依然失败。
⚠️ 也不能用 `https://www.google.com/` —— 它 302 跳地区域名、undici 会自动跟随，
「通」与「被墙」的响应差异不干净。选 `oauth2.googleapis.com/token`：`POST` 无参数
回 `400`，**拿到任何 HTTP 状态码即证明 TCP + TLS + 代理握手全通**，
且**不能判 `response.ok`**（400 也是通的，判了会让正确配置报红）。

### ⚠⚠️ 判据必须读 `cause` 链上的**错误码**，不能读 message

`fetch failed` 是 undici 把**所有**传输层失败压成的同一句话，真因只在 `cause`。
`refresh.ts` 原先的正则把它一律归成「1 分钟后重试的瞬时抖动」⇒
「墙外出不去」被当成抖动 ⇒ **永远静默重试**，面板零线索（issue 原话）。

⇒ **诊断**侧修法 = `isUnreachableNetworkError`（`src/refresh.ts`）读
`UND_ERR_CONNECT_TIMEOUT` / `EHOSTUNREACH` 等**码**（不读 message），供
`geminiNetworkHint` 给出带根因的指路文案。

### ⚠⚠️⚠️ 「拉长重试间隔」那一版已被推翻：它是净损害（两次独立审计）

第一版把 `refresh.ts` 的退避三元链改成三格（新增 `REFRESH_UNREACHABLE_RETRY_MS`
= 30 分钟）。**两次独立审计各自确认这是错的**，理由是**两条独立**的：

1. **对 gemini 自身零作用**：gemini **不使用** `RefreshScheduler`（全仓 7 处
   `new RefreshScheduler` 在 buddy / workbuddy / cline / qoder / trae /
   lobsterai / autoclaw，`gemini-auth.ts` **没有**）。gemini 走账号池 `refreshAll`，
   由 `MultiAccountRefreshScheduler` 驱动，那里间隔是**固定 30 分钟**、
   **没有任何错误分类** ⇒ 「1 分钟 → 30 分钟」对 gemini 一行都不生效
   （它本来就是 30 分钟），commit message 的说法与实现不符。
2. **误伤另外七个 provider**：它们与墙无关，把一次 DNS 抖动（`ENOTFOUND`，
   典型临时故障）从 60 秒拉长到 30 分钟，代价是「代理抽风一次，用户 30 分钟
   不能用」。

⇒ **判据仍有用（诊断），间隔不该动**。若将来 gemini 真要独立退避策略，该加在
`MultiAccountRefreshScheduler` 上（它目前无错误分类能力），**不能**在
`RefreshScheduler` 这条**七家共享**的链上动。

⚠️ 方法论可推广：**「给某个 provider 加一条全局策略」时，必须先确认它用的是
哪条策略链**。gemini 与其余十家走的根本不是同一个调度器 —— 而 commit message
里那句「1 分钟 → 30 分钟」读起来完全合理，正是因为**没人核对过 gemini 走哪条链**。

### ⚠⚠️⚠️ 探测路径刻意不挂 `accountPool` ⇒ 账号代理在探测上是**空接线**

**真实缺陷**（两轮独立审计各自查出，第一版「已修复」的说法是假的）：

- `account-probe.ts` **刻意不传 `accountPool`**（它的既定语义：只测这一个账号、
  且**不写**任何标记）⇒ `GeminiAdapter` 内「按 `access_token` 反查账号 id」
  那条路**根本不存在** ⇒ `currentAccountId` 恒为 `''` ⇒
- `gemini-proxy.ts` 的解析器按「空 id = 直连」处理 ⇒ **该账号的代理被完全绕过**。
- 症状与 issue 原话**同形**：墙外环境下「测试 / 重测」**恒失败**，而这个失败与
  「账号已失效」在 UI 上**完全同形** ⇒ 用户会去**误删好号**。

⇒ 修法 = 给 `GeminiAdapterOptions` 加 `accountIdOverride?: string`（**优先于**
反查），并让 `probeById.gemini` 的 `createProbeAdapter` **接下第三个形参 `entry`**
（原先形参只有 `(ref, credential)`，`entry` 被**直接丢弃** —— 对照 opencode 的
`(ref, credential, entry)`）。

⚠️ **为什么不给探测也挂池**：那会把探测接进换号/写标记的整套编排，而探测的既定
语义恰恰是「不写任何东西、只测这一个账号」。改 `account-probe.ts` 会破坏那套语义
并**波及十家适配器**。

⚠️ 这条同时暴露了原守卫的假绿：判据是
`/gemini: \{[\s\S]{0,600}fetchFor:\s*geminiFetchForAccount/` —— 它只证明**字面量在**，
不证明**那个 id 是对的**。两次审计实测的「删掉接线、字面量留在注释里」全绿。

## ⚠⚠️ 客户端**不得**注册 `settings.models.provider-card` 槽（Issue IKJLHQ）

**真实缺陷**（用户报障，Gitee issue IKJLHQ，2026-10-03）：本插件曾以
`key: 'llm-pi-ai'` 向官方「设置 → 模型 → 模型卡片」注册 ZCode 账号卡片，与
同样扩展 pi-ai 家族的 `@linxin666/dsh-client-ui-model-capabilities` **互斥**，
后者被**静默顶掉** —— 所有第三方 provider 卡片上的推理档位编辑面板消失，无任何报错。

**已修**（本分支）：整块移除 `plugin-src/client/zcode-card.js` 与该注册，
ZCode 账号管理**只在 Jet Hub 设置页**。回归用例在
`tests/unit/zcode-channel-dialog.spec.ts` 的「IKJLHQ」段（4 条 + 反向验证过）。

### 机制（依据官方包 `@deepseek-ai/dsh-client-ui-slots` / `-renderer` 0.2.0-rc.2）

| 事实 | 出处 |
|---|---|
| 该槽的 `key` 语义 = **那张卡片的 `settingsNs`** | 官方 `dsh-client-ui-settings-models/lib/client.js:2150`：`renderSlot('settings.models.provider-card', {...}, { entryKey: row.entry.settingsNs })` |
| 渲染侧按 `entryKey` **精确 find**，只渲染**一个** winner | `-renderer/lib/client.js:1154`：`entriesOfSlot(slot).find(e => e.options.key === opts.entryKey)` |
| `entriesOfSlot` 取 ledger 里每 cell 首个 live 条目；ledger 按 **`priority` 升序**（同 priority 才是注册顺序） | `-slots/lib/index.js:221` + `:285-290` |
| 同 key + 同 priority 的第二个 `register` **直接抛** `keyed slot "…" already has an entry for key "…"` | `-slots/lib/index.js:177-178` |
| `slots.inject` 的回调抛错 ⇒ `stop()` 掉整个 inject 并 `queueMicrotask(throw)` | `-renderer/lib/client.js:1375-1388` |

⇒ **同一个 `settingsNs` 上的第三方扩展是物理互斥的**，「换 key」与「换 priority」都
**不能**变成共存：

- 换独立 key（`llm-pi-ai-zcode`）⇒ 官方 `find()` 落空 ⇒ **我们自己的卡片永不渲染**；
- 换 priority ⇒ 两条都注册成功，但 winner 是 **`priority` 数值更小**的那条
  （错误提示里的 `lowest renders` 是字面为真的）；仍然**只有一个** winner ⇒ 依旧不是共存。
  即：想抢赢就得用更小的 `priority`，而那正是「挤掉对方」。

⚠ **zcode 没有自己的适配器家族**：`dsh-llm-pi-ai/lib/index.js:2492/2535` 把
**所有** route 目录行的 `settingsNs` 统一设成 `llm-pi-ai`，用户手工加的 `zcode`
route 也一样 ⇒ 想「就近」把账号 UI 塞进官方卡片，就只能抢那个 key。
⚠ 即使把 ZCode 恢复成独立家族也**治不了**：用户手工加的那条 `zcode` route
仍然 settingsNs = `llm-pi-ai`，照样撞。
⚠ 对照 `@mars-sea/dsh-commandcode-provider` 用 `llm-commandcode`「互不冲突」是**误解**：
它 `const NS = "llm-commandcode"`（`lib/index.js:9936`）**本身就是独立适配器家族**，
那个 key 恰是它卡片行的真实 `settingsNs`；不冲突只是因为整族都是自己的。
caps 插件的注释已经把话说明了：`/** The official adapter family this plugin
extends (the card slot's key). */ PI_AI_SETTINGS_NAMESPACE = 'llm-pi-ai'`。

⚠ **只有 zcode 撞是因为本仓库只有这一处 keyed 注册**；其余 11 个 provider 的账号
管理都在 Jet Hub 页，不碰官方卡片槽。任何新插件想给官方模型卡片加扩展，都会撞。

## ⚠️ dsh peer 范围必须**枚举并集**，不能用 `^0.1.2-rc.1` 或 `<0.3.0-0`（Issue IKIZ36）

**真实缺陷**（用户报障，Gitee issue !IKIZ36「peer 声明问题，建议版本要求改为左闭右开，
不会因为声明问题而无法在新版本安装」）：dsh 升到 `0.2.0-rc.1` 后插件装不上。

**根因是 semver 对 `0.x` 的 `^` 语义**：`^0.1.2-rc.1` 等价于 `>=0.1.2-rc.1 <0.2.0`
（0.x 的 `^` **只锁次版本**），所以 `0.2.0-rc.1` 判定为 **false**。

⚠️ **但「改成左闭右开」并不够 —— 有两个陷阱，只改一半仍会装不上或过度放行**：

**陷阱 1：dsh 门禁与 npm 默认语义不同，必须让两边都通过。**
dsh 的安装门禁 `evaluatePluginCompatibility`
（`packages/boot/app-boot/src/plugin-compatibility.ts`）用
`semver.satisfies(runtimeVersion, range, { includePrerelease: true })` —— **开了
`includePrerelease`**，故 prerelease 一律参与匹配；而 **npm/pnpm 默认语义更严**
（range 里必须出现**同 tuple** 的 prerelease 才允许匹配该 tuple）。实测：

| range | dsh 门禁（inclPre）对 `0.1.7-rc.2` | npm 默认对 `0.1.7-rc.2` |
|---|---|---|
| `^0.1.2-rc.1` | ✅ | ❌ |
| `>=0.1.2-rc.1 <0.3.0-0` | ✅ | ❌（`0.2.0-rc.1` 同样 ❌） |
| `^0.1.2-rc.1 \|\| ^0.1.7-rc.2 \|\| ^0.2.0-rc.1` | ✅ | ✅ |

⇒ 纯区间写法（`>=x <y`）在 npm 默认语义下**仍然装不上 prerelease**。**必须枚举出
每个要支持的 prerelease tuple**。

⚠️ **已用 `npm pack` 打的 tarball 实测证实**（`file:` 目录依赖会绕过 npm 的 peer
校验，**必须用 tarball 才测得出来** —— 我第一次用 `file:` 探针得到了假的「都通过」）：

| 插件 peer 声明 | `npm install` 装 `dsh-llm@0.2.0-rc.1` |
|---|---|
| `^0.1.2-rc.1`（旧，issue 报障形态） | ❌ `ERESOLVE` |
| `>=0.1.2-rc.1 <0.3.0-0`（**纯左闭右开**，即 issue 的建议） | ❌ `ERESOLVE` |
| `^0.1.2-rc.1 \|\| ^0.1.7-rc.2 \|\| ^0.2.0-rc.1`（**本次采用**） | ✅ 装上 |

⚠️ **所以 issue 里「改为左闭右开」的建议单独并不充分** —— 在 npm 下仍会
`ERESOLVE`。必须枚举 prerelease tuple。

**陷阱 2：`<0.3.0-0` 里的 `-0` 是必需的**（若要写区间）。`<0.3.0` 在
`includePrerelease` 下会**放进 `0.3.0-rc.1`** —— 那正是下一个不兼容的破坏性版本。
`-0` 后缀表示「低于该版本的任何 prerelease」，把 prerelease 挡在门外。

**当前采用的写法**（`package.json` 的 `peerDependencies` 与 `devDependencies`
**必须一致**，这是 dsh 的 package 不变式）：

```
"@deepseek-ai/dsh-llm": "^0.1.2-rc.1 || ^0.1.7-rc.2 || ^0.2.0-rc.1"
```

`@deepseek-ai/dsh-commands` / `@deepseek-ai/dsh-credentials` / `@deepseek-ai/dsh-llm`
三个 dsh 包同款。⚠️ `@deepseek-ai/cordis`（`^4.0.2`）与 `@deepseek-ai/schemastery`
（`^3.18.4`）**不参与该门禁**（门禁只校验 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*`
前缀），且它们本就在 0.2.0 里仍是 4.0.4 / 3.18.4，故维持 `^` 即可。

⚠️ **加新支持的 dsh 版本时，往并集里追加一条 `|| ^<新版本>`** ——
不要图省事换成 `*` 或 `>=0.1.2-rc.1`（后者会放行未来所有破坏性版本）。

**验证方式**（离线，别只靠肉眼看 range）：

```js
const s = require('semver')
const R = '^0.1.2-rc.1 || ^0.1.7-rc.2 || ^0.2.0-rc.1'
for (const v of ['0.1.2-rc.1', '0.1.7-rc.2', '0.2.0-rc.1']) {
  // dsh 门禁语义与 npm 默认语义都必须通过
  console.log(v, s.satisfies(v, R, { includePrerelease: true }), s.satisfies(v, R))
}
// 且不得放行下一破坏性版本
console.log('0.3.0-rc.1 must be false:', s.satisfies('0.3.0-rc.1', R, { includePrerelease: true }))
```

**0.2.0 的 API 兼容性已核对**（不只是改版本号）：0.2.0 把
`PreparedAdapterCall` 改名为 `AdapterPreparedCall`，但本仓库**从未引用**该类型
（八个适配器各自实现了 `prepareCall` 兼容层），故不受影响。
`registerConfigurableProviders` / `registerAdapter` / `credentialRef` /
`LlmAdapter` / `LlmError` / `ToolCallId` / `ReasoningEffortId` /
`EMPTY_RESPONSE_CODE` 在 0.2.0 中**均存在**。

## LobsterAI 模型列表（三个易踩的坑）

`GET /api/models/available` 有三个**各自独立、叠加生效**的坑，任一个都会让远端已上线的模型在面板里看不到或参数不对：

1. **响应是单层 `data` 数组**：真实形态是 `{code:0, message:'success', data:[{modelId,...}]}` —— `data` **直接是数组**（实测 2026-09-17，26 个模型）。**不能**复用 `parseLobsteraiEnvelope`：那个信封要求 `data` 必须是对象（用于把「凭据失效返回 `data:null`」判成失败），复用会让本端点恒判失败 → 空数组 → 适配器静默回退静态兜底表。解析走 `readLobsteraiModelArray`，**同时兼容**单层与双层（`data.data`）两种形状。
2. **必须带 `X-LobsterAI-Client-Capabilities` 头**：服务端按该头声明的能力**过滤模型集合**。不带时只返回 25 个且**没有 `kimi-k3`**；带 `kimi-k3-agentic-v1` 才返回 26 个。所以模型列表用 `lobsteraiModelsHeaders`（含两个 `X-LobsterAI-Client-*` 头，`Accept` 为 JSON），**不是**只有 4 个基础头的 `lobsteraiAuthHeaders`。
3. **能力声明还必须含 `thinking-level-control-v1`**：`reasoning_effort: "off"`（关闭思考）在**不带**该能力时服务端直接 HTTP 500；low/high/max/xhigh 不受影响。故 `LOBSTERAI_CLIENT_CAPABILITIES` 是**逗号分隔的两个值**，缺一不可 —— 这是「用户把档位调到 off 才炸」的隐蔽故障。

静态兜底表（`LOBSTERAI_FALLBACK_MODELS`，19 个）是 2026-08-06 抄的快照，**只在远端整体失败时顶替**；远端可用时完全采信远端（不做 buddy 那样的「以兜底表为准」裁剪）。它天然会逐渐过时（实测已缺 8 个新模型、多了 1 个已下架模型），排查「模型看不到」时**先确认远端到底返回了什么**，别直接看兜底表。

### 远端模型参数必须消费（不能只看 id/name）

远端每个模型还下发 `contextWindow`（实测多为 **1000000**，兜底表却统一写 131072）、`supportsImage`（26 个里 19 个为 true）、`supportsThinking`、`thinkingConfig`、`maxTokens`、`description`。这些是权威值，**兜底表只是估值**：

- `resolveModel` 的 `context` 取**远端优先、兜底表次之**；采信 131072 估值会让 DSH 远未用满 1M 窗口就触发压缩
- `inputModalities` 由远端 `supportsImage` 驱动（未声明时保守报 `text`）
- 可选字段缺失一律留 `undefined`，**绝不填 0/false**：「远端说不支持」与「远端没说」是两回事

### 思考档位的 wire 值是 `openclawLevel`，不是 `level`

`thinkingConfig.options[]` 每项有 `level`（**产品侧档位名**，含 `max`）与 `openclawLevel`（**发给服务端的 `reasoning_effort` 取值**，无 `max`）。远端把 `level: 'max'` 映射到 `openclawLevel: 'xhigh'`。

实测反证：直接发 `reasoning_effort: 'max'` 与不带参数**无差异**（走服务端默认），发 `'xhigh'` 才真正触发最高档。因此 `reasoningFor()` 用 `openclawLevel` 作 effort id，`defaultEffort` 也经 `options` 映射后再声明（必须落在 efforts 内，否则 DSH 会拿不存在的档位去请求）。

#### ⚠️ 但**展示名**必须用 `level`（Issue #IKHCZF）

**`id` 与 `name` 的来源不同，不能都取 `openclawLevel`**：

| 字段 | 来源 | 理由 |
|---|---|---|
| `efforts[].id` | **`openclawLevel`** | DSH 把它原样写进 `reasoning_effort`，必须是服务端认的取值（无 `max`） |
| `efforts[].name` | **`level`** | 纯展示；产品侧（IDE）显示的就是 `Max` |

**真实缺陷**（用户报障 / Issue #IKHCZF「最强思考档显示为 XHigh，与产品侧命名 Max
不一致」）：早期两处都用 `openclawLevel`，于是最强档显示 **XHigh** —— 用户按 IDE 里的
「Max」找，界面上却只有「XHigh」，以为缺了最高档。根因是把「wire 值」与「展示名」
当成同一个概念。

⚠️ `EFFORT_NAMES` 因此**必须同时登记 `max` 与 `xhigh`**（前者给 `level` 查，
后者给 `openclawLevel` 回退查）。对照 `buddy-adapter.ts` 的同类表：它同样两者都登记
—— buddy 无双字段（id 即 wire 值），故不存在这个坑。

实测（2026-09-20，真实凭据，28 个模型）：`level` 取值 `{off, high, max}`、
`openclawLevel` 取值 `{off, high, xhigh}`，8 个模型含 `max→xhigh`。
修复后 `id=xhigh / name=Max` —— **wire 行为不变，仅展示名纠正**。

### SSE 的 `delta.content` / `delta.reasoning_content` 会显式返回 `null`

真实形态（实测 335 帧）：一个模型要么走 content、要么走 reasoning_content，**另一侧恒为 `null`**（227 帧 `content=null`）。解析必须用 `typeof x === 'string'` 而非 `!== undefined` —— 只判 undefined 会让 `.length` 在 null 上崩溃，表现为**每轮对话第一帧就报 `Cannot read properties of null`**。

### 图片输入

远端声明 `supportsImage` 的模型**真的**接受图片：服务端收 OpenAI 兼容的 `{type:'image_url', image_url:{url}}` data URL（实测模型能正确识别图片内容）。**唯一**接受的形态就是它 —— `{type:'image'}` 与裸 base64 字符串都返回 HTTP 500。

- 能力按**模型**判定（`inputModalitiesFor`），不是按 provider 一刀切
- `stream()` 里 `ensureRemoteModels()` 必须在图片判定**之前**调用，否则 `remoteMeta` 尚空、会把支持图片的模型误判为不支持
- 工具结果内嵌图片（`read_image`）不能留在 `role:'tool'` 消息里（该角色 content 只能是字符串），须提升为**其后的独立 user 消息**；`userContentParts` 与 `collectImages` 必须**对称递归**，否则深层图片会被静默吞掉
- 只声明 `inputModalities` 而不实现比不声明**更糟**：DSH 在 `LlmRuntime` 里按它决定是否把图片投影成文本占位符，声明支持就必须真支持

## 「+ 新建账号」必须两步式返回 loginUrl（七个 provider 一致）

`account.create` 对**全部七个 provider** 都必须在**用户完成授权之前**返回
`loginUrl`，由前端立即 `window.open`，后台再异步等回调。

这不是风格偏好，而是浏览器硬约束：`window.open` 只在用户点击后的
**transient activation** 窗口（约 5 秒）内被允许。若 `account.create` 阻塞到
用户授权完成（数十秒），返回时手势已过期 → 弹窗被拦截返回 `null` → 前端若
兜底 `window.location.href = loginUrl` 就会把**整个设置页**导航走。
**真实缺陷**（用户报障）：「codearts 新建账号应该弹出新的页面，现在主页面直接
跳转过去了」正是此因。

- `buddy` / `workbuddy`：`runBuddyLoginFlow` 不 await，立即返回 URL
- `codearts`：`CodeArtsAuth.startLogin()`（`src/service.ts`），底层 `startOAuthFlow`（`src/login.ts`）
- `lobsterai`：`LobsteraiAuth.startLogin()`（`src/lobsterai-auth.ts`），底层 `startLobsteraiLoginFlow`（`src/lobsterai-oauth.ts`）
- `qoder`：`QoderAuth.startLogin()`（`src/qoder-auth.ts`），底层 `startQoderLoginFlow`（`src/qoder-oauth.ts`）—— 它是**设备码轮询**，不起本地回调服务器，故没有端口/超时收尾问题
- `qodercn`：**同一个 `QoderAuth.startLogin()`**，只是实例带 `product: QODER_CN`。
  RPC 侧由 `jet-hub-rpc.ts` 的 `qoderFamily` 注册表分派，`isQoderFamily(provider)`
  命中即走这一条 —— 故**不存在「中国版忘了接」的可能**（这正是改用注册表的目的：
  `workbuddy` 的「刷新」按钮当年就是因为漏接一条平行 case 而一直坏着）
- `trae`：`TraeAuth.startLogin()`（`src/trae-auth.ts`），底层 `startTraeLoginFlow`（`src/trae-oauth.ts`）。默认回调 `http://127.0.0.1:18080/authorize`；该端口被占用时**自动回退到随机端口**（`redirect_uri` 随之重算，服务端原样回跳，故功能不受影响）。登录 URL 需带 `client_id` / `machine_id` / `device_id`

要点：

- 阻塞式 `runOAuthFlow` / `runLobsteraiLoginFlow` / `runTraeLoginFlow` **保留**（CLI、e2e 仍用），
  但它们现在由 `start*` 实现，两条路径的落库逻辑共用 `persistLogin()` ——
  否则两步式会静默缺少续期武装或账号登记
- 两步式路径**没有外层 `try/finally`**，故超时与「结果落定即关闭回调服务器」
  都收在 `start*` 内部，避免泄漏监听端口
- 两步式下 `account.create` 返回时凭据还不存在，**必须**先登记占位账号条目，
  否则前端 `login.poll` 查不到该账号、永远 `done:false`
- 前端**不得**再出现 `window.location.href = loginUrl`：弹窗被拦截时改为展示
  可点击链接（`loginUrlForManual`）。`tests/unit/jet-hub-rpc.spec.ts` 有源码级
  断言锁死这条（剔除注释行后匹配，因注释里保留了该缺陷的叙述）

### 远程访问时「手动粘贴回调链接」（PR #8，2026-11-13）

**症状**：用户经反代 / 端口转发 / 远程桌面访问 DSH 时，浏览器在**用户本机**，
回调地址 `http://127.0.0.1:<port>/…` 指向用户自己的电脑 ⇒ 授权完成后浏览器报
「拒绝连接」，宿主永远收不到 `code` ⇒ 前端干等 5 分钟后报「登录超时」。
这是**网络拓扑问题**，不是任何 provider 的协议缺陷。

**修法**：用户在登录弹窗里把浏览器地址栏那条回调 URL **原样粘回来**，
**宿主自己**发一次 `GET`（宿主就在那台机器上，回调服务器正在监听）⇒ 各 provider
的 `createServer` 处理器**一行都不用改**（`code` / `secret` / `token`·`fingerprint`
三条分支全部自动支持）。新增 provider 自动支持，**不存在第二份要同步维护的清单**。

- **两条通道刻意分开**（不是历史包袱）：`codearts` / `trae` 走
  `account.submitCallback`（宿主侧有**专用解析器**，能给出「回调未携带
  refreshToken」「路径不是本次回调」这类精确原因）；其余回环渠道走
  `login.submitCallback`（宿主**盲发 GET**）。合并成一条会让前两家丢掉精确文案。
- **类型名必须分开**：`RpcSubmitCallbackRequest = { accountId, callbackUrl }` 与
  `RpcLoginSubmitCallbackRequest = { url }` **不能同名** —— TS 接口合并会并成
  「三个字段全必填」，编译期不报错、运行时两条通道互相污染。
- **`login.submitCallback` 的安全边界**（它是 SSRF 入口，不是通用 GET 代理）：
  只接受回环 hostname（`127.0.0.1` / `localhost` / `::1` / `[::1]`，**fail-closed**）、
  只接受 `http(s)`、`redirect: 'manual'`（`secret` 分支的 307 跳外网 portal 无意义，
  跟随只会掩盖真实状态码）、15 秒超时；404 与 `ECONNREFUSED` / `TimeoutError`
  给**不同**的可操作文案（前者=路径贴错，后者九成是本次登录已超时）。
- **`PROVIDERS_WITH_LOOPBACK_CALLBACK` 的判据是「是否真的开了 OAuth 回调端口」**，
  共 **6** 家（各家路径互不相同，别照抄任何一家）：codearts `/oauth/callback`
 （`src/oauth.ts` 的 `REDIRECT_PATH`，**只有它用这个常量**）、gemini `/oauth-callback`
 （host 是 `localhost`）、accio / lobsterai `/auth/callback`、autoclawintl
  `/auth/callback-zai`、trae `/authorize`。
  ⚠️⚠️ **两家必须排除**（否则是「假成功」，比明确报错更糟 —— 用户粘载体页地址、
  宿主盲发 GET 拿到 HTML 的 200、旧实现回 `ok:true`、客户端刻意不释放 `busy`
  ⇒ 按钮永久「提交中…」、5 分钟后报「登录超时」）：
  - **`astudio`**：确实 `listenOnRandomPort`，但开的是**登录载体页**，
    `ASTUDIO_CARRIER_PATHS` 里没有任何 OAuth 回调路径，登录结果由 `/astudio/poll`
    轮询交付。
  - **国内 `autoclaw`**（与 `autoclawintl` 分开）：只有短信 + 一键导入本机凭据
    （`autoclawSmsAvailable = provider === 'autoclaw'` /
    `autoclawZaiAvailable = provider === 'autoclawintl'`），而
    `src/autoclaw-oauth.ts:1386` 又用 `product.id !== AUTOCLAW_INTL.id` 把 Z.ai
    回调**限死为仅国际版** ⇒ 国内版粘任何地址都 404。
  ⚠️ `marvis`（CDP 拦截，无端口）、`loomy` / `raccoon`（本机载体页 + 上游轮询）、
  `qoder` 系 / `zcode` / `minimax` / `cline` / buddy 系（设备码）同样没有地址可粘。
- **粘贴提示不许写死具体路径**：七家路径各不相同，写死任一个都会让用户照抄拼错；
  文案只说「授权完成后浏览器地址栏里的完整地址，原样粘贴」。
- **非 2xx/3xx 必须 `ok:false`**（`jet-hub/callback-rejected`；`404` 保持 `bad-request`）：
  `400` = `state` 不匹配（过期地址）、`5xx` = 换凭据失败 —— 包成成功等于
  「错误归因 + 白烧一轮授权」，与 issue IKJOZA 红线同型。
- 守卫：`tests/unit/loopback-callback-providers.spec.ts`（该有的 6 家必须有粘贴框 +
  提交按钮、不该有的 6 家必须没有、两条通道不许互相串发）、
  `tests/unit/login-submit-callback.spec.ts`（服务端：SSRF 白名单 / 请求形态 /
  非 2xx 全失败 / 入参长度与 userinfo / 四类可操作失败文案）。

## ⚠️ 两条通用判据：一文件两套同义判据 / `String(undefined)`（PR !62 复审，2026-10-06）

这两条不是某个 provider 的局部知识，而是**在 buddy 成长任务复审里连撞两次**的
通用形态。它们共同的特征是「**静默失效**」：不报错、不崩溃、单测能过，
只是把「没做到」说成「做到了」。

### 1. 同一语义在同一文件里有**两套判据**时，必有一处是错的

**真实缺陷**（`src/buddy-growth.ts`，两处独立发生）：

| 位置 | 错误判据 | 后果 |
|---|---|---|
| `claimGrowthTaskReward` | `code !== undefined && code !== 0` → 失败 | **响应缺 `code` 时被当成成功**，网关错误体 `{msg:'Unauthorized'}` 被谎报成「已领取奖励（+0 积分）」并计入 `claimedCount` |
| `classifyGrowthWrite` | `if (code === 400) return no-object` | 与**自己的函数头注释**（「code 400 **+ msg 命中无对象文案**」）相反 ⇒ `task not completed` 被归成「已领奖」 |

而 `classifyGrowthWrite` 被作者注释为「写端点的**权威分类器**」—— 它与 claim
对同一问题给出**相反**答案（缺 `code`：前者归 -1 → failed，后者归 success）。

⚠️ **为什么这类缺陷特别难发现**：两套判据在**所有合法响应**上行为完全一致，
只在畸形响应上分叉。而测试通常只喂合法响应 ⇒ 全绿。

**排查手法**：搜同一文件里对**同一个字段**（此处 `code`）的所有判定，
把它们并排列出来对账。若两处结论不同，先假设其中一处是错的，再去问
「哪个是权威口径、另一处为什么不一致」。

⚠️ **与 Qoder 那条同源**（见下「排队错误」章）：那里的病根是「用错误码的默认
归类代替业务语义判断」（顶层 `code` 当门禁），这里是「同一字段两套判据」。
都是**判据本身没有被交叉验证过**。

**正确做法**：把判据**收进纯函数**（本例 `isNoObjectMessage()`），所有调用点共用；
且 `code 400` 的白名单必须**窄**（只认实测文案），白名单外一律判失败 ——
方向是**宁可漏判不可误伤**：漏判只让正常终态显示成失败（用户多点一次，无害），
误伤会把真失败谎报成成功。

### 2. `String(x)` **不会**对 `undefined` 报错 —— 它会拼出字面量 `"undefined"`

**真实缺陷**（contributor 在 !62 复审中指出，实测确认）：

```ts
// 反例：product.claimBase 缺失时
function claimBaseOf(product) { return String(product.claimBase).replace(/\/+$/, '') }
// ⇒ "undefined"，URL 拼成：
//    undefined/activity/growth/tasks/<code>/claim
```

```js
$ node -e "console.log(JSON.stringify(String(undefined)))"
"undefined"
```

⚠️ **危害在于「请求真的发得出去」**：它不是本地崩溃，而是一个合法形状的 URL
打向错误的 host ⇒ 失败现象看起来像服务端问题，真因（本插件缺配置）毫无线索。
**比崩溃更难查** —— 崩溃至少有栈。

⚠️ **同理的还有**：`String(null)` → `"null"`、模板串里的 `\`${obj.maybe}\``、
`Number('abc')` → `NaN`（而 `NaN > 0` 为 `false`，见本文件成长任务章的
`budgetMs` 守卫）。

**正确做法**：
- 取配置基址一律走**显式判类型**的取值器（`typeof x === 'string' ? x.trim() : ''`），
  再让调用点**发请求前判空**并返回**可读错误**（如
  `'产品配置缺少 claimBase，请检查 product.ts'`）；
- 回退链写成 `webBase → claimBase → ''`，**不要**让缺失值穿到 URL 拼接处；
- 反向验证时专门喂「字段缺失」的对象（本仓库的用例桩常常只填被测字段，
  这正好是构造该场景的现成手段）。

### 3. 本仓库对测试的两条既有红线（复审时再确认一次仍有价值）

- **同义反复用例比没有更危险**：!62 里有一条「cred 缺失 spec 的码不会让整轮崩溃」
  构造的是**有 spec** 的 `chat_5`，分支从未进入、唯一断言是
  `expect(r).toBeDefined()` ⇒ 任何不崩的实现都能过。实测（把 `chat_5` 的 spec
  真删掉）证明那句 `if (spec === undefined)` 防御分支**在正常运行下不可达**
  （上游已用 `!== undefined` 过滤）。改写成锁**真实可观测行为**后才有意义。
- **断言要能区分「哪条路径生效」**：另一条用例断言 `message` 含「未执行」，
  而逐项阶段与扫尾阶段**用同一个词** ⇒ 修掉任一处它都仍然绿。
  用词刻意分叉才能定位（本例中两处用词分叉又反过来导致实现/用例不一致 ——
  改文案时**同时**改实现与用例）。

⚠️ **反向验证是唯一能证伪「同义反复」的手段**，且它本身也会写错：
本轮有一条守卫用例的正则只匹配「同一行写法」，把闸门包进花括号块时
**照样通过** —— 是反向验证实测出「改坏了却不变红」才发现。
⇒ **写完反向验证要确认它真的变红了**，不能只改代码就当作验证过了。
## ⚠️ 包装适配器时必须包 `prepareCall`，不是 `stream`（PR !66 复审，2026-10-06）

**真实缺陷**：`src/dead-model-store.ts` 的 `withDeadModelPruning` 用 Proxy 包装
适配器，初版只拦 `listModels` / `listAllModels` / `stream` ⇒ **在生产环境完全不生效**
（42 条单测全绿，因为测试直接调 `proxy.stream`，绕过了真实路径）。

### 1. 生产路径**只走 `prepareCall`**，不直接调 `adapter.stream`

本仓库全部 14 个适配器都实现了：

```ts
async prepareCall(provider, model, signal) {
  return { model: await this.resolveModel(...), stream: (options) => this.stream(options) }
}
```

`prepareCall` 被 `value.bind(obj)` 绑到**原始对象**，故 `this` 是原对象，
`this.stream` 拿到的是**原始 stream** ⇒ **完全绕过 Proxy**。
而 dsh-llm 的两条运行时路径只调它：

- `node_modules/@deepseek-ai/dsh-llm/lib/index.js:1597` → `adapterCall.stream(options)`
- 同文件 `:1667` → `dispatch = (options) => adapterCall.stream(options)`

⇒ **只包 `stream` 是不够的**；而且只包 `prepareCall` 本身**也不够** ——
真实错误发生在 `call.stream(options)` 的**迭代过程中**
（`:1691` `iterator = dispatch(...)[Symbol.asyncIterator]()`，`:1701` `iterator.next()`），
必须包装 **`prepareCall` 返回的那个 `call.stream`**。

⚠️ 排查这类问题的通用手法：**别问「哪个成员被包了」，去 `node_modules` 里读
消费者的真实调用链**。本仓库已有先例（`prepareCall` shim 的注释记录了
`registration.adapter.prepareCall is not a function` 的报障）。

### 2. `registerXxxLlm` 返回的是**原始实例**，不是 Proxy

各 `registerXxxLlm` 里 `return adapter`（`new XxxAdapter(...)`），
只有 `registerAdapterIdempotent` 把**代理**注册进 `ctx.llm`。
于是 `src/index.ts` 的 `modelAdapters` 拿到的是 raw 实例 ⇒
Jet Hub 设置页的 `listAllModels` 完全看不到剔除效果。

⚠️ 更隐蔽的是 `jet-hub-rpc.ts` 的 `model.list` **两条路径**：
先 `await llm.listModels()`（走代理，已剔除），紧接着用
`modelAdapters[provider].listAllModels()`（走 raw，**未剔除**）**覆盖**回去。
⇒ `index.ts` 里两处必须**用同一个包装函数**，否则前功尽弃。

### 3. 剔除的东西**必须能恢复** —— 与 `disabledModels` 的既有约定对齐

失效模型被剔除后用户**选不到** ⇒ 不可能靠「再成功一次」自愈 ⇒ 记录永不自动清除
（只能等 30 天 TTL）。若设置页也不显示它，用户就**连开关都摸不着**，
一次误判 = 该模型被永久隐藏。

这正是 `jet-hub-rpc.ts` 里既有的、必须避免的根因（「用户再也无法重新打开」）。
⇒ `model.list` 必须把 dead 模型**补回目录**并带 `dead: true`，
客户端给「重新显示」按钮，走 `model.clearDead` 端点。
**能藏，但必须能找回。**

### 4. 判据的正则窗口**不能排除点号**

初版用 `[^.!?]{0,N}` 做窗口，而**本仓库几乎所有模型 id 都带小数点**
（`deepseek-v4.1-flash` / `gpt-5.6-astra` / 最长的
`cline-free/muse-spark-1.3-contributor` 37 字符）⇒ 英文路径对带点 id **全部漏判**。

⚠️ 初版那条注释「窗口要够宽」只对**中文分支**成立，英文分支**从未验证**。
⇒ 英文窗口只排除**句子终止符**（`!?` 与换行），**保留 `.`**，并放宽到 64。
⚠️ 判据里的注释**必须与实测一致**：拿一个样例验了中文路径就以为整体成立，
是这类缺陷的典型成因。

### 5. `not supported` / `not available` **不是**下架证据

初版把 `available` / `supported` 与 `found`/`exist` 并列，于是这 6 条
**换个套餐 / 换个地域就能恢复**的文案被当成下架：

```
cline: model not supported in this plan    ← 换套餐就好
model not available in your region         ← 换区就好
```

而误判后模型被藏 30 天且**用户无法自愈**。这与文件头「`unsupported` 单独出现不算」
的口径本来就矛盾 ⇒ **只认 `found` / `exist`**。

⚠️ 本仓库多处错误文案带 `model` 字样（`model "x" does not accept image input.`），
都靠 `IGNORED_CODES`（`UNSUPPORTED_CONTENT` 等）与排除词挡住 ——
**改判据时必须把这些真实文案一起重跑**，不能只看自己造的样例。

### 6. 排除词要带词边界

`expired` 无修饰会命中 `model expired-v3 does not exist`（模型名里含 expired）；
`quota` / `insufficient` 同理。中文排除词（额度 / 积分 / 余额）**不要**收紧 ——
它们的方向是「宁可漏判不可误伤」，符合本仓库总原则。

### 7. `resolveJetHubHome` 的 `ctx` **必须必传**

它是**所有**插件状态文档（`state.json` / `permanent-locks.json` /
`badge-preferences` / `auto-checkin` / `gemini-sigstore` / `dead-models`）的
**唯一** home 解析入口。PR !66 曾把它放宽成可选并传 `undefined` ——
那会**跳过优先级更高的 `profileContext.home`**，在 profile home 与 `$DSH_HOME`
不相等时把文档写到**另一个目录**，造成「账号池在 A、失效表在 B」的分裂，
正是 `permanent-lock-store.ts` 明确警告过必须避免的情况。

### 8. 单测要覆盖**真实调用链**，不是被包装的那一层

初版 42 条用例全绿却完全测不到生产路径。⇒ 包装类改动的回归用例必须：
① 造一个与真实适配器**同款形状**的替身（`prepareCall` 里 `this.stream`）；
② 经 `prepareCall` 走一遍；③ 做**反向验证**（把修复回退，用例必须变红）。
⚠️ 初版还有一条**同义反复**用例（注释声称构造了失败路径、实际什么都没构造），
任何不崩的实现都能过 —— 这种用例比没有更危险。

### 9. 客户端 CSS 的两条红线（都已有专门用例守着）

- **注释里禁止出现反引号**（样式是模板字符串，会提前闭合）——
  `zcode-channel-dialog.spec.ts` 守着。
- ⚠️ 新增带 `[data-dead]` 这类**属性选择器**的规则时，必须放在基础规则**之后**：
  `model-filter.spec.ts` 的 `ruleOf()` 按**源码顺序**取第一条匹配规则，
  写在前面会让它误取到新块、跳过基础规则（表现为「可收缩」断言假失败）。

---

## ⚠️ 包装适配器时必须包 `prepareCall`，不是 `stream`（PR !66 复审，2026-10-06）

**真实缺陷**：`src/dead-model-store.ts` 的 `withDeadModelPruning` 用 Proxy 包装
适配器，初版只拦 `listModels` / `listAllModels` / `stream` ⇒ **在生产环境完全不生效**
（42 条单测全绿，因为测试直接调 `proxy.stream`，绕过了真实路径）。

### 1. 生产路径**只走 `prepareCall`**，不直接调 `adapter.stream`

本仓库全部 14 个适配器都实现了：

```ts
async prepareCall(provider, model, signal) {
  return { model: await this.resolveModel(...), stream: (options) => this.stream(options) }
}
```

`prepareCall` 被 `value.bind(obj)` 绑到**原始对象**，故 `this` 是原对象，
`this.stream` 拿到的是**原始 stream** ⇒ **完全绕过 Proxy**。
而 dsh-llm 的两条运行时路径只调它：

- `node_modules/@deepseek-ai/dsh-llm/lib/index.js:1597` → `adapterCall.stream(options)`
- 同文件 `:1667` → `dispatch = (options) => adapterCall.stream(options)`

⇒ **只包 `stream` 是不够的**；而且只包 `prepareCall` 本身**也不够** ——
真实错误发生在 `call.stream(options)` 的**迭代过程中**
（`:1691` `iterator = dispatch(...)[Symbol.asyncIterator]()`，`:1701` `iterator.next()`），
必须包装 **`prepareCall` 返回的那个 `call.stream`**。

⚠️ 排查这类问题的通用手法：**别问「哪个成员被包了」，去 `node_modules` 里读
消费者的真实调用链**。本仓库已有先例（`prepareCall` shim 的注释记录了
`registration.adapter.prepareCall is not a function` 的报障）。

### 2. `registerXxxLlm` 返回的是**原始实例**，不是 Proxy

各 `registerXxxLlm` 里 `return adapter`（`new XxxAdapter(...)`），
只有 `registerAdapterIdempotent` 把**代理**注册进 `ctx.llm`。
于是 `src/index.ts` 的 `modelAdapters` 拿到的是 raw 实例 ⇒
Jet Hub 设置页的 `listAllModels` 完全看不到剔除效果。

⚠️ 更隐蔽的是 `jet-hub-rpc.ts` 的 `model.list` **两条路径**：
先 `await llm.listModels()`（走代理，已剔除），紧接着用
`modelAdapters[provider].listAllModels()`（走 raw，**未剔除**）**覆盖**回去。
⇒ `index.ts` 里两处必须**用同一个包装函数**，否则前功尽弃。

### 3. 剔除的东西**必须能恢复** —— 与 `disabledModels` 的既有约定对齐

失效模型被剔除后用户**选不到** ⇒ 不可能靠「再成功一次」自愈 ⇒ 记录永不自动清除
（只能等 30 天 TTL）。若设置页也不显示它，用户就**连开关都摸不着**，
一次误判 = 该模型被永久隐藏。

这正是 `jet-hub-rpc.ts` 里既有的、必须避免的根因（「用户再也无法重新打开」）。
⇒ `model.list` 必须把 dead 模型**补回目录**并带 `dead: true`，
客户端给「重新显示」按钮，走 `model.clearDead` 端点。
**能藏，但必须能找回。**

### 4. 判据的正则窗口**不能排除点号**

初版用 `[^.!?]{0,N}` 做窗口，而**本仓库几乎所有模型 id 都带小数点**
（`deepseek-v4.1-flash` / `gpt-5.6-astra` / 最长的
`cline-free/muse-spark-1.3-contributor` 37 字符）⇒ 英文路径对带点 id **全部漏判**。

⚠️ 初版那条注释「窗口要够宽」只对**中文分支**成立，英文分支**从未验证**。
⇒ 英文窗口只排除**句子终止符**（`!?` 与换行），**保留 `.`**，并放宽到 64。
⚠️ 判据里的注释**必须与实测一致**：拿一个样例验了中文路径就以为整体成立，
是这类缺陷的典型成因。

### 5. `not supported` / `not available` **不是**下架证据

初版把 `available` / `supported` 与 `found`/`exist` 并列，于是这 6 条
**换个套餐 / 换个地域就能恢复**的文案被当成下架：

```
cline: model not supported in this plan    ← 换套餐就好
model not available in your region         ← 换区就好
```

而误判后模型被藏 30 天且**用户无法自愈**。这与文件头「`unsupported` 单独出现不算」
的口径本来就矛盾 ⇒ **只认 `found` / `exist`**。

⚠️ 本仓库多处错误文案带 `model` 字样（`model "x" does not accept image input.`），
都靠 `IGNORED_CODES`（`UNSUPPORTED_CONTENT` 等）与排除词挡住 ——
**改判据时必须把这些真实文案一起重跑**，不能只看自己造的样例。

### 6. 排除词要带词边界

`expired` 无修饰会命中 `model expired-v3 does not exist`（模型名里含 expired）；
`quota` / `insufficient` 同理。中文排除词（额度 / 积分 / 余额）**不要**收紧 ——
它们的方向是「宁可漏判不可误伤」，符合本仓库总原则。

### 7. `resolveJetHubHome` 的 `ctx` **必须必传**

它是**所有**插件状态文档（`state.json` / `permanent-locks.json` /
`badge-preferences` / `auto-checkin` / `gemini-sigstore` / `dead-models`）的
**唯一** home 解析入口。PR !66 曾把它放宽成可选并传 `undefined` ——
那会**跳过优先级更高的 `profileContext.home`**，在 profile home 与 `$DSH_HOME`
不相等时把文档写到**另一个目录**，造成「账号池在 A、失效表在 B」的分裂，
正是 `permanent-lock-store.ts` 明确警告过必须避免的情况。

### 8. 单测要覆盖**真实调用链**，不是被包装的那一层

初版 42 条用例全绿却完全测不到生产路径。⇒ 包装类改动的回归用例必须：
① 造一个与真实适配器**同款形状**的替身（`prepareCall` 里 `this.stream`）；
② 经 `prepareCall` 走一遍；③ 做**反向验证**（把修复回退，用例必须变红）。
⚠️ 初版还有一条**同义反复**用例（注释声称构造了失败路径、实际什么都没构造），
任何不崩的实现都能过 —— 这种用例比没有更危险。

### 9. 客户端 CSS 的两条红线（都已有专门用例守着）

- **注释里禁止出现反引号**（样式是模板字符串，会提前闭合）——
  `zcode-channel-dialog.spec.ts` 守着。
- ⚠️ 新增带 `[data-dead]` 这类**属性选择器**的规则时，必须放在基础规则**之后**：
  `model-filter.spec.ts` 的 `ruleOf()` 按**源码顺序**取第一条匹配规则，
  写在前面会让它误取到新块、跳过基础规则（表现为「可收缩」断言假失败）。

---