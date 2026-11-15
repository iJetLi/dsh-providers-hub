# WorkBuddy 国际版每日奖励：签到 + 活跃链（2026-11-15）

> 结论先行：**国际版有签到**。本仓此前「国际版后端没有签到接口」的结论是**误判**，
> 错因是只搜了 CLI 内核字面量 —— 而签到端点是 IDE / 网页**前端**直接调的。
> 本文记录实证来源、协议细节，以及本仓的移植改动。

## 一、GitHub 上的同类实现（移植依据）

| 项目 | 覆盖范围 | 与本仓的关系 |
| --- | --- | --- |
| [L0NE-6/WorkBuddy-Daily](https://github.com/L0NE-6/WorkBuddy-Daily) 的 `workbuddy_intl_daily.py` | **国际版**每日奖励全链路（探测 / 领取 / 活跃 / 连登回读），青龙 + Actions | **本次移植的蓝本**（后端协议逐字取自它） |
| [SIMON-WORLD/workbuddy-daily-credit](https://github.com/SIMON-WORLD/workbuddy-daily-credit) | **国内版**（copilot.tencent.com）同名两端点，读本机登录态文件 | 交叉印证：两个产品端点**同形**，只有 baseURL 不同 |
| dsh 插件 `dsh-workbuddy-daily-credits` / `dsh-checkin-workbuddy` | 宿主插件形态（面板卡片 + 一键签到） | 印证「同一账号体系下这条链路可长期稳定跑」 |
| SkillHub `workbuddy-daily-checkin` | 桌面端 token 解密 + 幂等签到脚本 | 印证幂等语义（同日重复领取不重复加分） |

蓝本脚本自己写清了国际版与国内版的**语义差异**：

> 国际版的每日奖励不是普通签到，而是一条「活跃任务」链：探测活动是否开放、
> 今天是否已领（`/billing/meter/checkin-activity-status`）→ 开放且未领时领取
> 每日奖励（`/v2/billing/meter/daily-checkin`）→ 上报活跃 / 建网页会话完成
> 「当日活跃」。

## 二、协议（实证字段）

全部请求都带产品身份头：`Authorization: Bearer <access_token>`、`X-Domain`
（必须与 baseURL 同区）、`X-Product: SaaS`、`X-Product-Code: workbuddy`、
`X-User-Id: <credential.user_id>`、`User-Agent: WorkBuddy/5.9.4 …`。

| 用途 | 方法与路径 | body | 关键响应字段 |
| --- | --- | --- | --- |
| 状态（权威源） | `POST /v2/billing/meter/checkin-activity-status` | `{}` | `data.active`、`data.today_checked_in`、`streak_days`、`daily_credit` |
| 领取每日奖励 | `POST /v2/billing/meter/daily-checkin` | `{}` | `data.credit`、`streak_days`、`is_streak_day` |
| 活跃上报（点亮连登） | `POST /v2/report` | **数组**，一条 `chat_request_send` 事件 | `code:0` 即接受；`userId` 必填，缺了**静默丢弃** |
| 连登回读 | `GET /activity/growth/streak` | — | `data.streak.days` |
| 网页会话（「当日活跃」计数只认这一发） | `POST /console/as/conversations/` | `{prompt, model, conversationOrigin:'workbuddy-app', plugins}` | `data.id` 非空即建成 |

业务码（国际版与国内版**不是同一套**）：

| 码 | 含义 | 本仓处理 |
| --- | --- | --- |
| `0` | 成功 | `claimed` |
| `10001` / `1001` | 今日已领（国内版实测幂等码） | `already-claimed` |
| `1002` / `1003` | 无资格 / 活动结束 | `inactive` |
| `41000` | **活动未开始或已结束**（国际版） | `inactive`（**不是**失败，勿重试） |
| `40901` | 任务暂不可领取（国际版） | `inactive` |
| `11140` | 账号被限制（风控） | 失败，需人工处理 |
| `11-128` | 渠道指纹被拒 | 失败，多为请求头/UA 不像客户端 |

## 三、为什么本仓曾判定「没有签到」

三条历史依据（README、`AGENTS.md` 能力表、客户端能力表）**同源**：都来自「扫 CLI
内核字面量，只找到 `get-dosage-notify`」。而余额端点
（`/v2/billing/meter/get-user-resource`）当年也踩过同一个坑 —— `credits.ts` 里
留着那条教训：「该端点不在 CLI 内核里，是 IDE 前端直接调用的，静态搜索必然找不到，
只能用真实凭据实测发现」。签到端点是同一种情况，这次被同一块石头绊了第二次。

## 四、改动清单

| 文件 | 改动 |
| --- | --- |
| `src/provider-registry.ts` | `workbuddy.credits.dailyCheckin`：`false` → `true`（客户端「一键签到」按钮与自动签到的遍历范围都由本表派生） |
| `src/provider-credits.ts` | `workbuddy` 分支：删掉 `claimUnavailableReason`，改为 `claim` + `afterClaimNote`（活跃上报） |
| `src/workbuddy-intl-activity.ts` | **新增**：`/v2/report` 上报 + 连登回读 + 网页会话（`DSH_WORKBUDDY_INTL_WEB_SESSION=1` 才发） |
| `src/credits.ts` | 补国际版业务码 `41000` / `40901` → `inactive`；未知码上的「已签/已领/already」文案兜底 |
| `plugin-src/client/*` | 能力表注释与签到按钮文案不再声称国际版无签到 |
| `tests/unit/*` | 6 处断言由「workbuddy 被拒」翻转为「workbuddy 可签」；新增一条端到端（`fetch` 桩）用例 |

**没有移植**蓝本里的 `POST /v2/chat/completions` 保活对话：它只维持「账号有调用」，
既不进「当日活跃」计数，又要烧模型额度 —— 对一个网关来说不划算。

⚠️ 自动签到的**逐渠道水位线**不用改：它靠 `claimAll` 返回的 `coversToday` 记账，
`41000` 归入 `inactive` 后不会被当成「今天已处理」，下一个时段会自然重试。

## 五、验证

```bash
# 1) 离线单测（能力表 / 领取原语 / 端到端桩，均不发真实请求）
pnpm vitest run tests/unit/credits-capabilities.spec.ts tests/unit/claim-runtime-parity.spec.ts

# 2) 真实账号端到端（会真的领取，今天领过就没了；双重闸门已内置在脚本里）
pnpm test:e2e:workbuddy-claim

# 3) 只看不领（手动 curl，凭据从面板导出）
curl -sS -X POST https://www.workbuddy.ai/v2/billing/meter/checkin-activity-status \
  -H "Authorization: Bearer $WB_TOKEN" -H "X-Domain: www.workbuddy.ai" \
  -H "X-Product: SaaS" -H "X-Product-Code: workbuddy" -H "X-User-Id: $WB_UID" \
  -H 'Content-Type: application/json' -d '{}'
```

预期：`{"code":0,"data":{"active":true,"today_checked_in":false,…}}`。

## 六、边界与风险（务必读）

1. **自动签到默认开启**，合入后每天两个时段（`09:00` / `21:00`）会真的
   对账号池里的国际版账号发领取请求。不想跑就在面板状态灯上关掉自动签到。
2. **活动是否开放由上游决定**：`41000` 是正常状态，本仓归入 `inactive`，不会重试。
   活动没开的日子，到账靠活跃链（上报点亮连登；若上游按「当日活跃」发分，还需
   `DSH_WORKBUDDY_INTL_WEB_SESSION=1` 建一次网页会话）。
3. **网页会话是可见副作用**（账号里会多一个标题为 `Hi` 的会话），故默认关闭。
4. **风控**：账号受限（`11140`）与渠道指纹被拒（`11-128`）都会让这条链路失败；
   后者通常意味着请求头/UA 与真实客户端差得太远，不要靠删头去「绕过」。
5. **合规**：脚本化操作账号可能触及平台条款，风险自负；本仓不代管任何凭据，
   令牌只存在上游自己的凭据存储里。
