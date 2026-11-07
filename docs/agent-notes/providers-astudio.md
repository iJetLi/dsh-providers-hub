# AStudio（讯飞 AstronStudio / `cn.xfyun.acode`）Provider 接入实测笔记

> 2026-10-15 ~ 2026-10-17 期间实测登记。基线版本：**AStudio 0.2.14**。
> 本文件是**实测事实与工程落地约定**的唯一登记处。

---

## 0. 架构与双域分离（核心结论）

AStudio 后端采用**推理网关**与**账号控制面**严格分离的双域架构：

| 域 | 基础地址 | 鉴权方式 | 承载能力 |
|---|---|---|---|
| **推理网关** | `https://maas-api.cn-huabei-1.xf-yun.com/v1`（2026-11-07 起；旧 `astronstudio-api-volces-prod.xf-yun.com/model-gateway/v1` 已下线） | `Authorization: Bearer <modelBearerToken>` + `X-Account-Id` | `/chat/completions`、`/responses` 模型推理对话 |
| **账号控制面** | `https://agent.xfyun.cn/xingchen-studio` | `Cookie: ssoSessionId=<sid>` | 额度查询（`points/balance`、`points/summary`）、每日签到（`client-popups`）、凭据轮换 |
| **SSO 认证** | `https://sso.xfyun.cn/SSOService/wx/scanlogin` | 随机 Session `fd` 参数 | 微信扫码授权、UID/会话轮询 |

**核心规则**：
1. **凭据双轨制**：推理端点不消费 Cookie；账号面端点不消费 Bearer Token。
2. **凭据自愈链**：当推理返回 `401 / no_valid_authorization` 时，使用存活的 `ssoSessionId` 请求控制面 `/bot/models/configs` 即可无感刷新换取最新 `modelBearerToken`。

### 0.1 推理网关迁移（2026-11-07 真机复测）

症状：会话内所有 AStudio 请求立即失败 `HTTP 404 API endpoint not found`（`INVALID_REQUEST`），
客户端看起来「模型不回复」。**不是** token 过期、**不是**模型下架。

| 探测 | 结果 |
|---|---|
| `POST https://astronstudio-api-volces-prod.xf-yun.com/model-gateway/v1/chat/completions`（真 token） | **404** `{"error":{"message":"API endpoint not found","type":"not_found_error"}}` |
| 同上但**假 token** | **401** `{"message":"HMAC signature cannot be verified: apikey not found"}` ⇒ 网关先验鉴权，404 发生在路由阶段 |
| `GET https://astronstudio-api-volces-prod.xf-yun.com/api/v1/model-manager/models`（同一 token） | **200** `code:0`，7 个模型，含 `xopdsv4flash0731in` ⇒ 凭据有效 |
| `POST https://maas-api.cn-huabei-1.xf-yun.com/v1/chat/completions`（同一 token） | **200**，普通与 SSE 流均正常出字，`reasoning_effort:high` 也被接受 |
| `POST https://maas-api.cn-huabei-1.xf-yun.com/v1/models` | **405** `method not allowed` ⇒ 目录仍走旧域的 `/api/v1/model-manager/models` |
| 新基址 + 不存在的模型 | **400** `{"error":{"code":10404,"message":"no category route found","type":"invalid_request_error"}}` |

结论：推理基址搬到 `https://maas-api.cn-huabei-1.xf-yun.com/v1`，**目录基址未变**。
该值来自 AStudio 客户端 bundle（与 `AStudio2API` 从客户端提取的 `DefaultUpstreamBase` 一致），
并经上表真机 200 验证。旧前缀不会恢复 —— 它现在对任何路径都返回同一句 404。

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
