# PR #171 合并审计（MonkeyCode 两站 + 百智云 + autoclawintl）

- **日期**：2026-11-03
- **PR**：Gitee `!171`（`feat(providers): 接入 MonkeyCode 两站与百智云`，13 commits / 75 files）
- **本地分支**：`pr-171-master`（`pr_171` + `origin/master`）
- **基线**：`39316c6`（master）／PR head `7ddd54b`
- **结论**：**修完 1 个 P0 + 4 个 P1 后可合入**；当前分支已包含修复与真机证据。

---

## 1. 合并结果

`git merge origin/master` 只有 **1 处冲突**：`plugin-src/client/jet-hub.js` 的 `AccountCard`
签名区。

- PR 基于旧版：`const rateLimits = account.modelRateLimits ? …`（内联判据）；
- master 已改成纯函数：`accountLimitActionState(account)`（issue IKS2MV），且下方
  `hasAnyLimit = limitState.canReset` 依赖它。

⇒ 保留 master 的 `limitState` 三行 + 保留 PR 新增的三个 props
（`onEditMonkeycodeKey` / `onEditBaizhiKey` / `onReadSession`）。
丢弃 `limitState` 会直接 TDZ 崩溃（下方引用它）。

其余文件自动合并；逐条核对未发现 master 逻辑被 PR 覆盖（红队独立复核 22 处删除）。

---

## 2. 双轨审计发现

### 2.1 功能审计（只读）

| 级别 | 问题 | 证据 |
|---|---|---|
| **P0** | **三家新 provider 的「+ 新建账号」不可用** ⇒ 0 账号时没有任何添加入口 | `plugin-src/client/jet-hub.js` 的 `createAccount()` 只有 opencode/modelscope/qiniu/magicrew/magicrewintl 五条分支；三家落到通用 `account.create`，载荷不带 `mode:'browser'` ⇒ 宿主回 `unknown provider` |
| P1 | 签到成功后汇总显示「MonkeyCode 无账号」 | `credit:0` + `formatClaimGains` 全零返回 `null` ⇒ `bits` 为空 ⇒ 兜底文案「无账号」 |
| P1 | 签到响应体整块被丢弃（第 4 步不解包） | `claimMonkeycodeDailyCheckin` 只判 `ok`，不读 `data` |
| P1 | PoW 计算量闸门可冻宿主数小时 | 每题 2000 万 × c≤500 ⇒ 最坏 100 亿次同步 SHA-256 |
| P1 | 三条链零真机证据；引用的 `SPEC-monkeycode-provider.md` 全仓不存在 | 单测自述「没有真实凭据可实测」 |
| P2 | 注释与实现分叉（百智云换 Key 端点、WIRED 豁免理由、未定义符号） | 见修复清单 |

### 2.2 对抗审计（变异实测）

**已打穿（无牙）** —— ⚠️ 以下 7 处在 2026-11-03 追加轮中**已补上行为级守卫**，
并逐条做了变异复验（见 §6）：

1. **两站 product 串号零守卫**：把 `provider-credits.ts` 的 `MONKEYCODE` 换成
   `MONKEYCODE_INTL`（及反向、claim）⇒ **433 passed 全绿**。根因：两站路径逐字节相同，
   而 parity 用例只比路径片段。
2. **客户端 5 个接线变异全绿**（45/34 passed）：`...MONKEYCODE_PROVIDER_IDS.includes` 改
   `...false`、`onEditBaizhiKey` 同法、按钮条件 `false &&`、弹窗分支 `false &&`、
   `onReadSession` 改 false —— 因为 `monkeycode-client-wiring.spec.ts` 全是
   `toContain` 源码文本断言（`if (false)` 旁路复发）。
3. `jet-hub-rpc.ts` 的 `baizhi.startSession` 分支零测试：改 `if (false && …)` ⇒ 30 绿。
4. `exchangeMonkeycodeSessionForKey` 的信封解包删掉 ⇒ 42 绿。
5. `success === false` 判据 ⇒ 16 绿；c/s/d 上限闸门 ⇒ 16 绿；
   `session-cookie.ts` 的 base64 判据 ⇒ 39 绿。

**未打穿**：`Math.imul`、`startsWith`、`ordinal=i+1`、三处解包、`/1000`、已签到早退、
缺 balance 不回落 0、SELF_HEAL 反向守卫等变异均变红。

**prng 的 `>>>0`**：18000 组独立预言机实测，5/6 处删除是**等价变异体**（0 差异），
只有第 3 行尾部（`toString(16)` 之前）承重且删它必红 ⇒ 注释「每步都要 `>>>0`」属过度声明。

---

## 3. 真机验收（2026-11-03，本机真实账号）

### 3.1 MonkeyCode 国内站（浏览器登录 → 换 Key → 钱包 → 签到）

| 步骤 | 结果 |
|---|---|
| 浏览器登录读 `monkeycode_ai_session` | ✅ 36 位 |
| `POST <apiKeysPath>` 换网关凭据 | ✅ `oma_…`(36) + `signing_secret`(48) |
| `GET /api/v1/users/wallet` | ✅ `balance: 0`，`daily_token_balance/limit: 10000000` |
| `GET /api/v1/users/subscription` | ✅ `plan: basic` |
| `GET /wallet/checkin`（签到前） | ✅ `checked_in: false` |
| `POST /public/captcha/challenge` | ✅ `{c:50, s:32, d:3}` |
| `solveChallenge`（PR 实现，lib 干净重建） | ✅ 216ms，50 题 |
| `POST /public/captcha/redeem` | ✅ **201 `success:true`** |
| `POST /wallet/checkin` | ✅ `{code:0, data:{checked_in:true}}` |
| 签到后钱包 | ✅ **`balance: 100`（0 → 100，即网页文案的「100 积分」）** |
| 再点签到（幂等） | ✅ `already-claimed`，**零写请求** |

> ⚠️ 首次真机跑出 `target=-6e` 的失败是**假故障**：`lib/` 恰好在对抗审计的变异窗口内
> 被编译过一次（`state ^ (state << 5)` 少了 `>>> 0`）。干净重建后同一算法 redeem 201。
> **教训**：真机探针前必须确认 lib 构建与工作树一致。

### 3.2 邀请链接（用户问的第二件事）

上游**有**邀请体系（从官网 bundle 逐字取证 + 真机接口验证）：

- 链接格式：`https://<站点>/?ic=<平台用户 id>`（参数名是 `ic`）
- 邀请记录：`GET /api/v1/users/invitations?page=1&size=20` → `{code:0,data:{count,items,page}}`
- 真机：`GET /api/v1/users/status` → `data.user.id = 01a19fa3-…`；
  邀请链接 `https://monkeycode-ai.com/?ic=01a19fa3-…`；邀请记录 `count: 0`

**PR 原本没有实现邀请链接**（全仓零 `invite/referral`）。本次已补：
`fetchMonkeycodeProfile()`（稳定用户 id）+ `monkeycodeInviteLink()`（拼链接，缺 id 时
返回 `undefined`，绝不拼空 `?ic=`）。**尚未接 RPC/UI**（见 §6）。

### 3.3 百智云（浏览器登录 → 积分）

| 步骤 | 结果 |
|---|---|
| 浏览器登录读控制台会话 | ✅ `sl-session`（88 位）+ `baizhi_session` |
| `GET /api/v1/user/wallet/balance` | ✅ `available 500 / permanent 500 / temporary 0 / frozen 0` |
| `GET /api/v1/user/wallet/usage?period=month` | ✅ 0 项（本月未用） |
| `GET /api/v1/user/profile` | ✅ `userId 188335791882309, name 水` |
| `POST <console>/api/console/api-keys` 换 `sk-` | ❌ **该账号下没有可用 `sk-`**（提示「请打开 …/console/keys 新建一把」）——**账号状态问题，不是代码缺陷**；提示可行动 |

> 结论：百智云的「登录 → 读积分」链路真机通过；「登录 → 自动拿推理 Key」依赖账号里
> 先有一把 `sk-`，错误文案已如实指路。

### 3.4 国际站

未真机验证（本机只有国内站账号）。静态：product 常量、cookie 域名判据、ref 前缀、
rpc 前缀均按站点分开；`monkeycodeintl.` 不会被 `monkeycode.` 吞（第 11 字符是 `i`）。

---

## 4. 已修（本次分支）

| # | 修复 | 文件 |
|---|---|---|
| 1 | **P0**：`createAccount()` 补 monkeycode / monkeycodeintl / baizhi 三条分支 → 开登录弹窗 | `plugin-src/client/jet-hub.js` |
| 2 | 签到奖励：先读响应字段，否则用**签到前后余额差**（真机 +100），两条都拿不到才回 0 + 说明 | `src/monkeycode-credits.ts` |
| 3 | 客户端：`credit === 0` 时不再渲染「+0积分」/「无账号」，改渲染 `delayedMessage` / 「N 个签到成功」 | `plugin-src/client/jet-hub.js` |
| 4 | **P1**：PoW 加**总预算** 500 万次 + 每解一题让出事件循环（`solveChallengeYielding`），上限从「数小时」降到 ≈7s | `src/monkeycode-credits.ts` |
| 5 | **稳定 `user_id`**：改用 `/users/status` 的 `data.user.id`；换 Key 响应的 `id` 改名 `keyId`（它每次兑换都变，用作身份会让同账号重复建卡） | `src/monkeycode-credits.ts` / `monkeycode-auth.ts` / `monkeycode.ts` / `monkeycode-product.ts` |
| 6 | 邀请链接原语 + 用户资料读取 | 同上 |
| 7 | `fnv1a32` 改为上游同款 **UTF-16 code unit** 输入（ASCII 结果不变，非 ASCII 才不漂） | `src/monkeycode-credits.ts` |
| 8 | 恢复路径 `refreshable: true` 硬编码 ⇒ 三家静态渠道恢复时不再误显「自动续期」 | `src/jet-hub-store.ts` |
| 9 | 修正 4 处与实现分叉的注释（百智云端点 / WIRED 豁免 / 未定义符号 / 代理弹窗末支） | 多处 |
| 10 | 测试补牙：新建账号行为级用例、签到余额差、profile/邀请链接、换 Key 信封、c/s/d 闸门、总预算、session-cookie base64 | `tests/unit/*` |

## 5. 验证命令

```bash
npx tsc -p tsconfig.json --noEmit
npx vitest run          # 见本轮结果
```

## 6. 追加轮：把 7 处「无牙」变成有牙（2026-11-03 下午）

| 原缺口 | 补的守卫 | 变异复验（必须变红） |
|---|---|---|
| 两站 product 串号（`provider-credits.ts` 换错站，433 条全绿） | `credits-runtime-parity.spec.ts` 新增「MonkeyCode 两站余额打各自 host」：断**完整 URL** = `platformBaseUrl + walletPath` | 把 `monkeycode` 条的 `MONKEYCODE` 换成 `MONKEYCODE_INTL` ⇒ **1 failed** ✅ |
| `baizhi.startSession` 分支零测试（改 `if (false &&)` 30 绿） | 新增 `baizhi-session-dispatch.spec.ts`：真起 RPC 端点 → 真调方法 → 等后台任务；并守「合并写回」（旧 `sk-` 不得被覆盖） | `if (false && method === 'baizhi.startSession')` ⇒ **2 failed** ✅ |
| 卡片 3 个入口全源码文本断言（改 `...false` 45/34 绿） | `jet-hub-panel-wiring.spec.ts` 新增「账号卡片三家入口」：真渲染（含 AccountCard）→ 真点按钮 → 断言弹窗状态 / `baizhi.startSession` RPC | 4 个变异（MonkeyCode 改 Key 门控、百智云改 Key 门控、登录按钮门控、AccountCard 分支永假）⇒ **各 1 failed** ✅ |
| `exchangeMonkeycodeSessionForKey` 信封解包 | `monkeycode-credits.spec.ts`：`code≠0` 判失败 / 裸对象可读 / 缺字段判失败 | 删解包 ⇒ 红 |
| `success === false` 判据 | 同文件：带 token 但 `success:false` 必须 failed | 删判据 ⇒ 红 |
| c/s/d 上限闸门 | 同文件：`c=100000` 必须拒绝且**不进入 redeem** | 删闸门 ⇒ 红 |
| base64 cookie 裸值 | 新增 `session-cookie.spec.ts`：双等号结尾的 base64 裸值（如 `YWJj==`）必须补 cookie 名 | 把 `!rest.startsWith('=')` 改 `rest.length>0` ⇒ 红 |

### 国际站（`monkeycode-ai.net`）只读可达性（2026-11-03，无账号）

| 探针 | 结果 |
|---|---|
| `GET /api/v1/users/wallet` | 401 `Unauthorized`（端点存在、要 cookie） |
| `GET /api/v1/users/status` | 401 `{"code":401,"message":"未授权…"}` |
| `GET /api/v1/users/wallet/checkin` | 401 |
| `POST /api/v1/public/captcha/challenge` | **201** `{c:50,s:32,d:3}`（与国内站逐字段相同） |
| 首页 | 与国内站**同一份 SPA**（同一 asset `index-0rgNk17_.js`） |

⇒ 「同一程序的两套部署」成立；**账号级**（cookie 名、换 Key、签到）仍未验证。

⚠️ **新发现的不确定**：国内站 bundle 里邀请链接是**字面硬编码**
`https://monkeycode-ai.com/?ic=…`，而 `.net` 首页引用同一个 asset 文件
（`.net` 的 bundle 拉取超时，未能逐字确认）。本仓库的 `monkeycodeInviteLink()`
按**站点域名**生成（`.net` 站给 `.net` 链接）——如果上游确认国际站也复用 `.com`
链接，只需改这一个常量的口径。

## 7. 仍未做 / 残留未知（如实登记）

1. **邀请链接还没有 UI/RPC 入口** —— 原语与数据已就绪（`monkeycodeInviteLink`），
   缺一个 `monkeycode.invite` 方法与账号卡片按钮。属功能缺口，不是错误。
2. 国际站**账号级**未真机验证（本机只有国内站账号）；cookie 名是否同为
   `monkeycode_ai_session` 未知（常量不随 product 变）。
3. `docs/superpowers/specs/SPEC-monkeycode-provider.md` 被多处引用但**不存在**。
4. 客户端 `新建账号` / 三家卡片入口已有行为守卫；其余源码文本断言（如
   `monkeycode-client-wiring.spec.ts` 的 23 条）仍在，属**弱守卫**，但不再是唯一防线。
