# AStudio（讯飞 AstronStudio / `cn.xfyun.acode`）Provider 接入实测笔记

> 2026-10-15 ~ 2026-10-17 期间实测登记。基线版本：**AStudio 0.2.14**。
> 本文件是**实测事实与工程落地约定**的唯一登记处。

---

## 0. 架构与双域分离（核心结论）

AStudio 后端采用**推理网关**与**账号控制面**严格分离的双域架构：

| 域 | 基础地址 | 鉴权方式 | 承载能力 |
|---|---|---|---|
| **推理网关** | `https://astronstudio-api-volces-prod.xf-yun.com/model-gateway/v1`（**Responses 协议**：`POST /responses`） | `Authorization: Bearer <modelBearerToken>` + `X-Account-Id` | 模型推理（**只走 `/responses`**；`/chat/completions` 恒 404）。⚠️ MaaS 域 `maas-api.cn-huabei-1.xf-yun.com/v1` 只认 `api_key`，本机账号在那套账本里无生效订单 ⇒ 403 `11200` |
| **账号控制面** | `https://agent.xfyun.cn/xingchen-studio` | `Cookie: ssoSessionId=<sid>` | 额度查询（`points/balance`、`points/summary`）、每日签到（`client-popups`）、凭据轮换 |
| **SSO 认证** | `https://sso.xfyun.cn/SSOService/wx/scanlogin` | 随机 Session `fd` 参数 | 微信扫码授权、UID/会话轮询 |

**核心规则**：
1. **凭据双轨制**：推理端点不消费 Cookie；账号面端点不消费 Bearer Token。
2. **凭据自愈链**：当推理返回 `401 / no_valid_authorization` 时，使用存活的 `ssoSessionId` 请求控制面 `/bot/models/configs` 即可无感刷新换取最新 `modelBearerToken`。

### 0.1 推理网关：**「前缀下线」是错判，它只提供 `/responses`**（2026-11-16 订正 2026-11-07 的结论）

症状（2026-11-07 首次报障）：会话内所有 AStudio 请求立即失败
`HTTP 404 API endpoint not found`（`INVALID_REQUEST`），客户端看起来「模型不回复」。
**不是** token 过期、**不是**模型下架。

2026-11-07 的处置是「把基址搬到 MaaS 域」，理由是「旧前缀对任何路径都回 404」。
⚠️⚠️ **那条推断只验了 `/chat/completions` 一条路径**，结论过宽。2026-11-16 用同一
真实账号做了完整对照：

| 探测（同一会话 JWT / 同一账号） | 结果 |
|---|---|
| `POST …/model-gateway/v1/responses`（7 个目录模型逐个发） | **200**，`response.created → output_text.delta → completed`，usage 正常；tools / `reasoning.effort` 均被接受 |
| `POST …/model-gateway/v1/chat/completions` | **404** `API endpoint not found`（**只有这一条路是死的**） |
| `POST maas-api…/v1/chat/completions`（同一 JWT） | **401** `HMAC signature cannot be verified: apikey not found` ⇒ MaaS 不认 JWT |
| `POST maas-api…/v1/chat/completions`（`api_key`，来自 `bot/models/configs`） | **403** `{"error":{"code":11200,"message":"no valid authorization: the account lacks an active order, has insufficient quota, or the order is invalid"}}` |
| `GET …/api/v1/model-manager/models`（同一 JWT） | **200** `code:0`，7 个模型（`slug` / `visibility` / `input_modalities` / `context_window` 齐全） |

⇒ **正确结论**：推理基址仍是 `https://astronstudio-api-volces-prod.xf-yun.com/model-gateway/v1`，
但**只有 `/responses`（OpenAI Responses 协议）**；目录基址未变。
AStudio 客户端 3.6.4 的 `maasBaseUrl` 也仍指这个值、调的也是 `/responses`。

⚠️ **两个账本不要混**：积分 / 签到走 `agent.xfyun.cn/xingchen-studio`（Cookie），
它一直是 200 ⇒ **面板有积分 ≠ 有 MaaS 订单权限**；MaaS 是另一套商品目录。
「403 / 11200」是**订单缺失**，不是 token 过期，也不是积分用尽。

⚠️ 方法论教训（可推广）：**「一个路径 404」不能推出「整个前缀下线」**。
迁移/下线这类结论必须**分路径**验证（本仓库同型教训：qoder 的 `dfmodel` 与
`qmodel` 分别属于两套端点）。

### 0.2 Responses 与 Chat Completions 的字段差异（照抄会 400/静默丢字段）

| 维度 | Chat Completions | Responses（本家真实通路） |
|---|---|---|
| system | 一条 `role:'system'` 消息 | 顶层 `instructions`（字符串） |
| 历史正文 | `content` 字符串 | `input[]` 条目：`{role:'user',content:[{type:'input_text'}]}` / `{role:'assistant',content:[{type:'output_text'}]}` |
| 工具定义 | `{type:'function',function:{name,…}}` | **扁平** `{type:'function',name,description,parameters}` |
| 工具调用回传 | `tool_calls[]` + `role:'tool'` | `{type:'function_call',call_id,name,arguments}` + `{type:'function_call_output',call_id,output}` |
| 思考档位 | `reasoning_effort` | `reasoning:{effort}` |
| 输出上限 | `max_tokens` | `max_output_tokens` |
| 正文位置（非流式） | `choices[0].message.content` | `output[]` 里 `type:'message'` 条目的 `content[0].text`（**没有**顶层 `output_text` 便捷字段） |

⚠️⚠️ **`reasoning.effort:'none'` 必须显式发出去、不能省键**（实测 `spark-x2.6`）：
省略 `reasoning` ⇒ `reasoning_tokens=49`（照开思考）；`{effort:'none'}` ⇒
`reasoning_tokens=0`、只出一个 `message` 条目。把 `none` 改成「不发」= 用户选了
「关闭思考」却照付思考 token（静默失效）。

SSE 事件（逐帧实测顺序）：
`response.created` → `in_progress` → `output_item.added`（`reasoning` / `message` /
`function_call`）→ `reasoning_summary_text.delta` / `output_text.delta` /
`function_call_arguments.delta` → 各自 `.done` → `output_item.done` →
`response.completed`（带 `usage`）。
⚠️ `function_call_arguments.delta` 的 **`item_id` 是空串**，只能用 `output_index`
归并到工具槽位（`.done` 才带 `item_id` 与完整 `arguments`）。
⚠️ 撞输出上限时终态是 **`response.incomplete`**（不是 `completed`）：实测
`max_output_tokens:40` 时 reasoning 就吃掉 41 token、正文 0 字 ⇒ 必须映射成
`finish: length`，否则 harness 把「被截断」当正常结束。

---

## 0.3 目录**按客户端版本下发**：`studioVersion` 是模型闸门（2026-11-16 实测）

同一 token、同一目录端点 `GET /api/v1/model-manager/models`，只改请求头：

| 请求头 | 目录条数 | 多出来的是谁 |
|---|---|---|
| 不带 `clientType` / `studioVersion` | **7** | — |
| `clientType:21` + `studioVersion:3.5.2`（本插件**旧值**） | **7** | — |
| `clientType:21` + `studioVersion:3.6.4`（本机 `AStudio.exe` 真实 `FileVersion`） | **8** | **`xdeepseek-flash-in` = `DeepSeek-V4.1-Flash`** |

⇒⚠️⚠️ 把 `studioVersion` 当「随便填的可选头」是**错的**：它决定服务端下发哪些模型。
旧值 `3.5.2` 下 `DeepSeek-V4.1-Flash` **永远不会出现在面板里**，而且**零报错** ——
症状与「上游没这个模型」逐字同形。这与 qoder 的 `COSY_VERSION`、
zcode 的「版本 × 身份块同代」是同族问题：**版本串是服务端下发内容的判据**。

⚠️ 版本闸门只作用于**目录**，不作用于鉴权/推理：三个变体的推理请求都 200，
401/403 与它无关（本家 403 是 MaaS 订单，见 §0.1）。

`xdeepseek-flash-in` 的目录声明（8 条那份）：

| 字段 | 值 |
|---|---|
| `display_name` | DeepSeek-V4.1-Flash |
| `context_window` | 1,048,576 |
| `max_output_tokens` | 100,000 |
| `supported_reasoning_levels` | `none`（关闭思考）/ `high`（高强度）/ `max`（最大强度） |
| `default_reasoning_level` | `high` |
| `input_modalities` | `['text']` |

真机会话取证（本机 DSH 实跑，`~/.dsh/jet-hub/token-ledger.json`）：
`direct|astudio|astudio-e5cc3cbc|xdeepseek-flash-in` ⇒ `req=1 / err=0 /
in=309128 / out=1470 / reasoning=1072` —— 既证推理通路，也证 usage 三格都回传。

---

## 1. 模型上下文窗口与输出上限（真网压力探测定案）
此前曾有误以为“各模型上下文只有 10 万”的疑问，经真实构造超长 Prompt（4k ~ 1100k tokens）向上游直接施压探测，结果坐实如下：

### 实测上限与行为一览

| 模型 ID | 模型显示名称 | 标称上下文 (`context_window`) | 真网实测上下文硬上限 | 最大单次输出 (`max_output_tokens`) | 超限上游行为 |
|---|---|---|---|---|---|
| **`xopglm52`** | GLM-5.2 | 1,000,000 (100万) | **1,024,000 (102.4万 / 1M)** | 128,000 (12.8万) | 报 502 `InvalidParameter` |
| **`xopdsv4flash0731in`** | DeepSeek-V4-Flash | 1,000,000 (100万) | **1,024,000 (102.4万 / 1M)** | 384,000 (38.4万) | 报 502 `InvalidParameter` |
| **`xopdeepseekv4pro0813`** | DeepSeek-V4-Pro | 1,000,000 (100万) | **1,024,000 (102.4万 / 1M)** | 384,000 (38.4万) | 报 502 `InvalidParameter` |
| **`astronclaw-auto`** | Auto 自适应 | 1,000,000 (100万) | **1,024,000 (102.4万 / 1M)** | 384,000 (38.4万) | 报 502 `InvalidParameter` |
| **`spark-x2.5`** | Spark-X2.5 | 262,144 (26.2万) | **262,144 (256k)** | 256,000 (25.6万) | 自动截断至 262,144 正常返回 |
| **`spark-x2.6-preview`** | Spark-X2.6 | 262,144 (26.2万) | **262,144 (256k)** | 256,000 (25.6万) | 自动截断至 262,144 正常返回 |

### 误解成因
1. **中英文计数进制混淆**：官方返回 `context_window: 1000000`（6 个 0），即英文 1M / 1000k Tokens，在中文中为 **100 万** Tokens，易粗略误读为 5 个 0 的“10 万”。
2. **最大输出混淆**：GLM-5.2 的最大输出生成上限恰好为 128,000（约 12.8 万）Tokens。

---

## 2. 微信扫码登录全链路（SSO 协议定案）

AStudio 桌面端原生采用微信带参二维码扫码授权机制，链路如下：

1. **获取二维码**：
   * `GET https://sso.xfyun.cn/SSOService/wx/scanlogin/qrcode?fd={fd}`
   * `fd` 为客户端本地生成的 8 位随机字母数字串（如 `randomBytes(4).toString('hex')`）。
   * 成功返回 `code: 0` 及微信 ticket 地址 `https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=...`。
2. **轮询扫码状态**：
   * `GET https://sso.xfyun.cn/SSOService/wx/scanlogin/uids?fd={fd}`
   * 未扫码返回 `code: -1`（“未扫码”）；
   * 扫码且确认后返回 `code: 0`，包含 `uid`、`ssoSessionId` 等。
3. **绑定与初始化（Complete Login）**：
   * `GET https://sso.xfyun.cn/SSOService/wx/scanlogin/bind?fd={fd}`；
   * 使用获得的 `Cookie: ssoSessionId=...` 依次调用：
     * `POST https://agent.xfyun.cn/xingchen-studio/tenant-app/v2/init-app`
     * `GET https://agent.xfyun.cn/xingchen-studio/userInfo`
     * `GET https://agent.xfyun.cn/xingchen-studio/bot/models/configs`：解析默认或生效的 `api_key` 作为 `modelBearerToken`，组装为完整的 `AstudioCredential`。

---

## 3. 每日签到与积分奖励（Popups & Rewards）

推翻早期“AStudio 无签到端点”的推论，官方每日签到逻辑挂载于弹窗奖励体系：

1. **检查待领弹窗**：
   * `GET https://agent.xfyun.cn/xingchen-studio/client-popups/pending`（带 Cookie `ssoSessionId`）。
   * 若存在未领取的每日奖励，数组中包含 `type === 'DAILY_REWARD_DIALOG'` 元素，含 `popupId` 与 `instanceKey`；
   * 若今日已领取或无弹窗，返回 `code: 0, data: []`。
2. **提交领取**：
   * `POST https://agent.xfyun.cn/xingchen-studio/client-popups/complete`
   * Body: `{"popupId": <id>, "instanceKey": "<key>"}`
   * 成功返回 `code: 0, flag: true`。
3. **自动签到（Auto Check-in）集成**：
   * 在 `provider-registry.ts` 中声明 `credits: { balance: true, dailyCheckin: true }`；
   * 在 `src/provider-credits.ts` 中实现 `claimDaily: async (cred) => await claimDaily(cred)`；
   * 因 `auto-checkin.ts` 按注册表与 `credits.claimAll` 动态派发且 `astudio` 并不在代价排除表中，插件启动后每日将自动触发 AStudio 签到。
