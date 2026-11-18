# AgnesCode（`agnescode` / `agnescodeintl`，2026-11-19，issue #125）

> ⚠️ 先分清两条腿：本家接的是 **AgnesCode 桌面客户端的 BFF**（`api-agnes-code.agnes-ai.cn`
> / `api-agnes-code.agnes-ai.com`），**不是** `api.agnes-ai.cn` 那个 OpenAI 兼容的
> 「AgnesAI API」产品。后者与本案协议、凭据来源、余额口径**全都不同**。

## 1. 凭据来源：读 Windows 桌面客户端的登录态（不是扫码、不是 API Key）

- 目录：`%APPDATA%\AgnesCode`；文件名家族 `^code-auth-session[^/\\]*\.v1$`
  （国内 `code-auth-session.cn.v1`、国际 `code-auth-session.v1`），兄弟文件 `Local State`。
- `Local State` 的 `os_crypt.encrypted_key` = base64(`"DPAPI"` + 密文)；
  DPAPI（`CryptUnprotectData`）解开后是 **32 字节 AES key**。
- 会话 blob = `v10` 前缀 + AES-256-GCM（12B nonce、尾 16B tag）。
- 解密后 JSON 含 `accessToken`（约 28 天 JWT）、`userInfo.{id,username}`、
  以及 **`bffPublicBaseUrl`**。
- ⚠️⚠️ **`bffPublicBaseUrl` 每账号下发、绝不硬编码**；且必须先钉扎 `https` +
  `*.agnes-ai.cn` / `*.agnes-ai.com` 的**域名边界**（`trustAgnescodeBffBase`），
  才允许往上挂 `Authorization` —— 否则一个被改写的会话文件就能把 token 送到任意主机。
  实测反例：`api.agnes-ai.cn.evil.example` 必须被拒。
- ⚠️ DPAPI 解密走 `powershell.exe -NoProfile -NonInteractive` 子进程，**必须剥掉
  `AGNESCODE_ACCESS_TOKEN` / `AGNESCODE_CREDENTIAL` 环境变量**（那是我们自己给
  e2e 用的注入口，不能泄漏给子进程）。
- 非 Windows ⇒ 如实报 `UNSUPPORTED_PLATFORM`，**不要**假装登录。

## 2. 三个端点（形态各不相同）

| 用途 | 请求 | 要点 |
|---|---|---|
| 目录 | `GET {apiRoot}/v2/models` | 必须带 `X-App-Id: 1` + `X-Platform: 1`；**`/v1/models` 是另一个目录**（无倍率、不按账号裁剪）；`data` 是**数组**（不套信封）；`auto` 是路由别名要剔除；`model_type` 非 `text` 的条目（图/视频种子）也要剔除 |
| 余额 | `GET {apiRoot}/api/v2/subscription/credits-balance` | **不在 `/v1` 下**；信封 `code` 是**字符串** `"000000"`（不是 0）；字段 `total_balance` / `time_sensitive_balance` / `permanent_balance` |
| 推理 | `POST {bffBase}/chat/completions` | 纯 OpenAI 兼容；`stream:true` 恒真 |

## 3. 目录**完全账号级下发**，且**刻意没有静态兜底表**

- 依据本仓红线「静态兜底表必然腐坏」（Qoder 那次：上游改了倍率/改名，表没跟上，
  界面长期显示错价）。
- 因此 `AGNESCODE_FALLBACK_MODELS = []` 是**刻意的空表**，不是漏配。
- ⚠️⚠️ **代价（如实登记，不是已解决）**：
  - `listAllModels()` 是**同步**方法 ⇒ 冷缓存（从未调过 `listModels`）结构上只能为空；
  - `model-catalog-parity.spec.ts` 的「冷缓存非空」那一格对这两家**改判据豁免**
    （仍断言返回数组、且随后的 `listModels` 必须非空），理由写在用例里；
  - 新装 / 未登录 / 登录后首轮预热前的窗口里，设置页可能读到 `total = 0`
    ⇒ 显示「未关闭」而不是「已关闭」（`closed` 判据要求 `total > 0`），不会误伤开关。
- `refresh-targets-derived.spec.ts` ⑧ 的 `NO_ACCOUNT_SCOPED_CATALOG` 豁免是**同一个原因**
  （`provider.status` 对它们报 `total=0`）。两处豁免必须一起读。

## 4. 余额 → 积分（`agnescode-credits.ts`）

- 只映射**两个桶**：`permanent_balance`（永久）、`time_sensitive_balance`（限时）。
- ⚠️ **限时桶必须置 `expiryUnknown: true`**：接口**没有任何逐笔日期**，
  而「到期未知」渲染成「永久」会废掉临期桶的救命功能（红线 IKTLMX）。
  **也不许反推日期**（「剩余/100 = N 天」只在每天都领时成立）。
- `used: 0` / `expiredTotal: 0` / `totalKnown: false` —— 本家不报「已用」。
- **无签到**（`claim` 刻意不接）。

## 5. 两站 = 两个 provider id

- 账池不互通、域名族不同 ⇒ `agnescode` / `agnescodeintl` 各一个 id，
  实现 100% 共用，只在 `AgnescodeProduct` 上分叉（会话文件名 / 域名族 / fallback base）。
- ⚠️ 折算、探针、ref 前缀、`WRITES_RATE_LIMIT_PROVIDERS`、`SELF_HEAL` 表**每处都要两站到位**，
  漏一处静默失效（本仓已复发 7 次的坑）。

## 6. 临期折算

- `agnescodeExpiry` 走 `sharedPackageExpiry`：有 `active && remaining > 0` 的包 ⇒ `NEVER`，
  否则 `UNUSABLE`；`balance: null`（查不到）⇒ `UNUSABLE`。
- ⚠️ 三处必须同改：`WIRED_EXPIRY_PROVIDERS` + `createProviderExpiry()` + `AGGREGATE_CHANNELS`
  （只改后者的症状：模型进得来、候选层被静默剔掉，用户在聚合轮换里永远看不到它）。

## 7. 思考档位

- 目录条目**没有任何档位字段** ⇒ 两站都登记进 `PROVIDERS_WITHOUT_REASONING`，
  否则面板会对用户承诺一个不会发生的「默认最强档」。

## 8. 已登记未做

- 扫码设备码 + 本地回环回调（跨平台登录，参考实现有 `docs/AGNESCODE-SCAN-LOGIN.md`）：
  **未进本 PR**。当前 `account.create` 只做 Windows 本地导入。
- 图标：先用自制占位（圆角 `#0F766E` + 白「A」base64），官方 SVG 暂无来源
  （网页端根路径实测 403 维护页）。
