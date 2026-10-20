<!-- 搬自 AGENTS.md（2026-10-06 拆分：注入预算 65,536 B，超出部分每轮被截断永不可见）。
     内容逐字节原样保留；本文件按需阅读，不进每轮注入。 -->

## 模型计费倍率与同名模型（必须写进 `name`，不是 `description`）

**倍率必须拼进 `name`。** 这是被用户报障纠正过的结论：

- composer 的**模型切换菜单只渲染 `name`** —— `dsh-client-ui-model-selection`
  的 ModelSelect 里只有 `title: model.name` 与 `children: model.name`，
  **完全不读 `description`**。
- `description` 只在 **`/model` 弹窗**里用（`optionsOf` 的 `detail`，渲染成
  `提供方 · description`）。

**真实缺陷**（用户报障）：「消耗倍率没有显示在切换模型列表的后面」——
早期版本把倍率放进 `description`（因为误以为那是"唯一的展示位"），
结果在切换菜单里根本不可见。

安全性：`name` **纯属展示**，DSH 的选择与持久化只用 `id`
（`selectionOf` 返回 `model: model.id`），故附加价格不会污染会话历史。

展示形态：`Deepseek-V4.1-Flash · x0.03`；有促销时 `GLM-5.3 · x0.79→x0.50`
（箭头比「（促销 …）」短，适合窄菜单）。

三套远端的倍率字段**形态互不相同**，绝不可共用解析：

| provider | 字段 | 真实形态 | 归一化 |
|---|---|---|---|
| `buddy` / `workbuddy` | `data.models[].credits` | **字符串 `"x0.29"`**（x 在前），早期带 `"x0.03 credits"` 后缀，可为空串 | `normalizeCreditsRate` |
| `buddy` / `workbuddy` | `modelPromotions[].discount.discountedCredits` | **字符串 `"0.50x"`（x 在后！）**，已结束占位为 `"0x"` | `normalizeDiscountedRate` |
| `lobsterai` | `data[].costMultiplier` | **裸数字 `0.05`** | `displayNameFor` 里拼 `x${n}` |
| `qoder` | 目录 `chat[].price_factor` | **裸数字**，`0` = **免费**，另有 `original_price_factor` + `promotion` | `qoderDisplayName` |
| `trae` | `display_contact_config.consumption_rate.data.rate`（**该字段本身是 JSON 字符串，须二次 `JSON.parse`**） | **裸数字** `0.08`；`0` = 免费；`enable:false` = 无倍率 | `traeDisplayName`（活动期拼 `x原价→x折后价`） |
| `codearts` | 无 | 两个目录端点都不含计费字段 | — |

要点与坑：

- ⚠️ **`credits` 与 `discountedCredits` 的 x 位置相反**（`"x0.29"` vs `"0.50x"`）。
  早期版本只认前缀写法，导致**促销价全部静默丢失** —— 单测直接暴露了它。
  两个 `normalize*` 函数各自接受两种写法（对上游格式变更更鲁棒）
- ⚠️ **两个端点下发的模型 id 集合不同，必须取并集**（实测 2026-09-21，
  账号 `3C656A62`）：
  ```
  scoped     → hy4-preview, hy4-preview-x   （30 个模型）
  /v3/config → hy4-preview-f                （22 个模型）
  促销 modelIds → ["hy4-preview-f"]         ← 只挂在 v3/config 独有的那个 id 上
  ```
  而 `hy4-preview-f`（新用户限时免费变体）**被 craft/ask/plan 三个 agent 引用**
  —— 服务端明确说它可选。早期只返回 scoped，于是该促销永远对不上，
  界面显示 `x0.29` 而 IDE 显示免费（用户报障「hy4 preview 现在 ide 是免费
  我们还是 0.29」）。**不同账号下发的变体 id 也不同**（另一账号两端都是
  `hy4-preview`，所以它没暴露这个问题）—— 排查时**必须多账号对照**
- ⚠️ **`reconcileWithFallback` 是白名单式重建，会丢弃不在兜底表的 id** ——
  上面那个 `hy4-preview-f` 正因此被丢掉。判据用 **`agentReferenced`**
  （服务端自己的「可选」信号，由 `parseModelsFromConfig` 收集**全部** agent
  的引用），**不要猜 id 后缀**：`-f` / `-x` / `-sg` / `-ioa` 含义各异，
  猜错会放进不可用的模型。追加时放在**末尾**，不打乱兜底表顺序。
  ⚠️ `auto` 与 **`default`** 是同类内部别名（都不被 agent 引用），
  由 `isAutoSelectAlias` 过滤；但**不要前缀匹配** —— 会误伤国际版
  被 craft 引用的 `default-model` / `fast-model` 等抽象别名
- ⚠️ **促销只由 `/v3/config` 下发，企业模型端点（scoped）没有**（实测 2026-09-21：
  scoped 的 25948 字符响应里 `discount` / `promo` / `0.50x` 出现 **0 次**）。
  而 scoped 被**优先返回** → 早期实现直接 `return scoped`，于是**促销永远不显示**
  （用户报障「codebuddy 的倍率显示也是没折扣的，GLM-5.2 是 0.5，现在显示 0.79」）。
  现补一次 `/v3/config` 并**同时取它的模型与促销表**（失败不影响列表）
- ⚠️ **必须按 `schedule` 本地推算此刻是否生效，不能只看 `enabled`**：
  实测 `glm-5.2` 有两条**互补**活动（夜间 `23:00–7:50` 带 `0.50x`、
  白天 `7:50–23:00` 只带角标）。不看时段就按 priority 恒定取夜间那条 →
  **白天也显示折扣价**，用户按折扣价预期却被按原价计费。
  时段字段是 `schedule.daily[].{start,end}`（`HH:MM`，**小时可能不补零**如 `7:50`）
  + `schedule.timezone`（用 `Intl` 换算，别硬编码 +8）+ `validFrom`/`validUntil`。
  时区不可解析时**不误杀**（宁可多显示一次折扣）
- ⚠️ **`factor: 0` 是「免费」，不是「活动已结束」**：实测 `hy4-preview` 的夜间活动
  是 `{discountedCredits: "0x", displayMode: "replace", factor: 0}` —— 它**真的免费**。
  早期把 `0x` 一律当哨兵丢弃，于是「夜间免费」永远不显示
  （用户报障「hy4 preview 夜间 0，现在显示 0.29」）。**「已结束」由有效期表达**。
  防御：**无任何时间窗口**的 `factor: 0` 仍按占位跳过（免费额度必然限时）
- ⚠️ `modelPromotions` 是**数组**（不是对象），且用 `modelIds[]` **按模型关联**
  （不是全局折扣）；同模型命中多个活动时取 `priority` 最高者
- ⚠️ **`/v3/config` 有 UA 校验**：UA 不对返回 `{"code":12403,"msg":"check ua,
  get coding copilot version error"}`（**HTTP 200**，极易误判为「该端点没有促销」）。
  必须带产品的 `userAgent`（CodeBuddy 实测 `CodeBuddyIDE/1.106.1`）
- ⚠️ **LobsterAI 的 `description` 可能已自带倍率文案**（实测 DeepSeek-V4.1-Flash
  写着「分时计价：当前空闲时段 x0.05…」）。前置倍率前必须 `includes` 判重，
  否则出现「x0.05 · …x0.05…」重复
- `reconcileWithFallback` 是**白名单式重建**：新增的远端字段不在此显式搬运就会
  被静默丢弃（`creditsRate` / `discountedCreditsRate` 已加）

### ⚠️ TRAE 思考档位：多通道合并**不得**用空档位条目覆盖有档位的条目（Issue IKI7WT/IKILR7）

**真实缺陷**（用户报障「模型缺少思考强度」）：`parseTraeBatchModelList` 用
**无条件「后面的覆盖前面的」**合并同名模型，其注释假设「后面的条目带着更完整的
配置」——**该假设与真实数据正好相反**。上游把**空档位**的 `solo_work_lite` /
`solo_design_remote` 等条目排在**最后**，于是信息更全的条目被覆盖成了更空的条目。
UI 表现为 `TraeAdapter.reasoningFor` 返回 `undefined` → 不声明 `reasoning` →
「当前模型未提供推理等级」。

实测（2026-09-26，`scripts/probe-trae-reasoning-order.ts`）：**13 个模型**丢掉档位
（`deepseek-v4.1-flash` / `glm-5.2` / `glm-5.3` / `kimi-k3` / `qwen3.8-max` /
`DeepSeek-V4-Flash-Official` / `DeepSeek-V4-Pro-Official` …）。修复后目录里
**有档位的模型从 5 个恢复到 15 个**。

同一模型在不同通道的档位**不一致**（这正是「后覆盖前」出事的原因）：

| 通道 | `deepseek-v4.1-flash` 的 `reasoning_effort_config` | 顺序 |
|---|---|---|
| `chat_v3` | `{default:high, options:[light,high,extra_high], support_thinking:true}` | 早 |
| `solo_agent` | 同上，且 `max_tokens` 32000 / `context_window.max` 1000000 / `max_mode:true` | 中 |
| `solo_agent_remote` / `solo_agent_lite` | 同上 | 中 |
| `solo_work_remote` / **`solo_work_lite`** | `{options:[], support_thinking:false}` | **最后** |

修正后的合并规则（三条，见 `parseTraeBatchModelList` 注释）：

1. **空档位不得覆盖有档位**（已选有档位 + 候选无档位 → 保留已选）；
2. **两侧都有档位时按 `channelPriority` 取更靠前者**（默认 `TRAE_CHANNELS`，
   「顺序即优先级」，故通常落到 `solo_agent`）；
3. **其余情形（含两侧都无档位）保持既有「后覆盖前」**，避免与本缺陷无关的
   通道迁移 —— 这条保证 `glm-5.1` / `qwen-3.5` 等无档位模型行为**逐字节不变**。

四个必须记住的点：

- ⚠️ **档位必须与 `function` 同源，整条择优**：发档位的通道必须正是声明支持它的
  通道。**不要**只把 `reasoningConfig` 单独搬运到另一条条目上（例如保留
  `solo_work_lite` 的 `function` 却声明档位）——那是在一个自称
  `support_thinking:false` 的通道上宣布档位。
- ⚠️ **判据必须与 `TraeAdapter.reasoningFor` 完全一致**：配置存在 **且**
  `support_thinking !== false` **且** `options` 非空（`declaresReasoningOptions`）。
  只判「配置存在」会选中 `{support_thinking:false, options:['high']}` 这种
  适配器里仍返回 `undefined` 的条目，**等于没修**。两处改动必须同步。
- ⚠️ **可调用性不受影响**：候选始终只来自**列出了该模型的通道**，故无论选中哪条
  都不会路由到「未列出该模型」的通道（那才会回流内 4001）。已实测：
  `deepseek-v4.1-flash` 通道从 `solo_work_lite` 迁到 `solo_agent` 后，
  不带档位与 `reasoning_effort=extra_high` **各发一次均 HTTP 200、正常返回**。
- ⚠️ **`DeepSeek-V4-Flash` / `DeepSeek-V4-Pro`（无后缀）修好后仍然无档位** ——
  它们**所有**带档位的通道条目都被 `is_invisible_to_user=true` 剔除（官方隐藏），
  只剩 `solo_coder` / `chat` 的可见条目。这是官方可见性，**不是**合并缺陷；
  带 `-Official` 后缀的那两个已正常恢复。

排查/回归：

- `scripts/probe-trae-reasoning-order.ts` —— 按上游顺序回放「后覆盖前」，列出被吃掉的
  模型与修复后的目录（只读，零额度）
- `scripts/probe-trae-merge-replay.ts <模型 id…>` —— 打印指定模型在**全部通道**的条目
  （含三条硬过滤的 DROP 原因、`max_tokens` / `context_window` / `max_mode` 差异）
  与最终合并结果
- `tests/unit/trae.spec.ts` 的「档位不被空档位条目覆盖」段（7 条）—— ⚠️ 已做**反向
  验证**：临时退回「无条件后覆盖前」时其中 4 条会失败，故不是同义反复
- `tests/e2e/trae-reasoning-probe.e2e.spec.ts`（`pnpm test:e2e:trae-reasoning`，**消耗
  额度**，双闸门 `DSH_TRAE_REASONING_E2E=1` + `…_CONFIRM=yes`）—— 真实目录档位断言
  + `resolveModel` 真声明出 `efforts` + 新通道真实收发两次

### ⚠️ TRAE 账号展示名：`ScreenName` 是自动生成的默认名，必须用脱敏手机号

**真实缺陷**（用户报障 2026-09-27）：「用 trae provider 登录后用户名字显示无法区分
各个用户，有其他名字昵称或者手机尾号之类的信息可以区分吗？」

根因：`GetUserInfo` 的 **`ScreenName` 是字节 passport 按 uid 自动生成的默认名**
（`用户` + uid 片段）。实测四个账号：

形态完全雷同，一屏列出来认不出谁是谁 —— 与 Raccoon 的 `RaccoonAva`
（`buildRaccoonNickname`）是**同一类问题**。

实测可用字段（2026-09-27，四个真实账号逐个调 `GetUserInfo` 核对）：

| 字段 | 值 | 可区分性 |
|---|---|---|
| `ScreenName` | `用户<uid片段>` 等 | ❌ 自动生成、形态雷同 |
| **`NonPlainTextMobile`** | `130******00` | ✅ **末两位互异** |
| `NonPlainTextEmail` | 四个**全为空**（`LastLoginType` 均为 `sms`） | ⚠️ 仅邮箱登录有值 |
| `Description` | 全为空 | ❌ |
| `AvatarUrl` | 每人独立 hash | ⚠️ 可区分但不可读 |
| `RegisterTime` | `2026-03-28` / `2026-09-27` / `2026-08-19` ×2 | ⚠️ 有两个撞车 |
| `UserID` | `4051111222220009` 等 | ⚠️ 可区分但过长不可读 |

要点：

- ⚠️ **字段名是 `NonPlainTextMobile`**（不是 `Mobile` / `Phone`），且是**脱敏**形态
  （中间 6 位打码）。展示就照原样用，**不要试图还原或截取后四位** ——
  `130******00` 整体已足够短且可辨认
- ⚠️ **`NonPlainTextEmail` 实测为空**，别因为「有手机号就以为邮箱也有」而写死依赖；
  它只是邮箱登录账号的兜底
- 取值顺序（`traeDisplayNickname`）：**手机号 → 脱敏邮箱 → `ScreenName` → 账号 id**
- ⚠️ **手机号必须写回凭据**（不只写账号条目）：账号条目会随 Jet Hub 的账号操作
  整体重写，凭据里存一份才能在续期后稳定拿到。`applyTraeRefresh` 用 `...previous`
  展开，故自动保留 `phone` / `email` —— 改它时别把这两个字段丢掉
- ⚠️ **回调的 `userInfo` 参数不含手机号 / 邮箱**（实测只有 `UserID` / `ScreenName` /
  `TenantID`），**只在 `GetUserInfo` 响应里** —— 故 `exchangeTraeCallback` 必须真发
  那次 `GetUserInfo` 才能拿到，不能只依赖回调
- ⚠️ **老账号必须主动回填**：光改代码只影响新登录的账号。`TraeAuth.repairAccountNicknames`
  （`src/index.ts` 启动时调用，仿 `RaccoonAuth.repairAccountNicknames`）在启动时补一次
- ⚠️ **拿不到真实标识时不得改写昵称**：`Jet Hub` 允许用户手动改昵称
  （`account.update`），若退回去用凭据里的 `ScreenName` 重算，会把用户改过的名字
  覆盖成服务端默认名 —— 属无谓且有害的写入。故 `fetchUserContact` 在两者皆空时
  返回 `undefined`，调用方**直接 `continue`**
- ⚠️ **只在昵称确实变化时落盘**：`updateAccount` 是整体 replace，每次启动都写会
  平白触发一次文档写

排查 / 验证：

- `scripts/probe-trae-userinfo.mjs` —— 打印每个 TRAE 账号 `GetUserInfo` 的
  **完整响应**（只读，零模型额度）
- `scripts/verify-trae-nickname.mjs` —— 用真实账号跑一遍 `repairAccountNicknames`
  并打印修复前后昵称（⚠️ **会写真实账号池昵称**，这正是修复效果本身）
- `tests/unit/trae.spec.ts` 的「TRAE 账号展示名」段（6 条，含四个真实手机号
  互不相同的断言）、`tests/unit/trae-auth.spec.ts` 的「repairAccountNicknames
  老账号回填」段（7 条，含「无标识不改写昵称」「幂等不重复请求」）

### ⚠️ LobsterAI 账号展示名：服务端把**手机号本身**当昵称下发（露 4 位）

**用户要求**（2026-09-27）：「lobsterai 的用户名字显示的手机号尾号漏出 4 位，
现在也改为只漏出 2 位」。

⚠️ **关键事实：`130****1100` 是服务端下发的 `user.nickname` 原值，不是本插件
截取的**。`buildLobsteraiCredential` 只做 `nickname: payload.nickname ?? ''` 照抄。
实测四个真实账号的登录响应即为此形态：

故修法是**归一化掩码**（`maskLobsteraiPhoneTail`，`src/lobsterai.ts`）而非改
某个 `slice(-4)` —— 那会是个找不到的假想目标。

要点：

- ⚠️ **两种输入都收敛到同一形态，因此幂等**：完整 11 位（`13011111100`，
  `profile-summary` 返回的就是完整号码）与已脱敏的露 4 位形态，输出都是
  `130******00`。幂等意味着老账号无需重新登录、重复运行不产生新写入
- ⚠️ **判据只认「像手机号」的形态**：`/^1\d{10}$/`（完整）或
  `/^\d{3}\*+\d+$/`（已脱敏）。**绝不能泛化到任意字符串** —— 那会把真实昵称
  （`用户<uid片段>` / `<自定义昵称>` / 邮箱形态）一起打掉。单测有专门一条守这个
- ⚠️ **星号个数按原串总长推算**（`总长 - 3 - 2`），长度保持不变；
  故对非 11 位的号码也自洽
- ⚠️ **末 2 位必须仍可区分**：四个真实账号掩码后为
  掩码把区分度也抹掉就失去意义了（单测断言 `Set.size === 4`）
- ⚠️ **老账号必须主动回填**：`LobsteraiAuth.repairAccountNicknames`
  （`src/index.ts` 启动时调用，与 `RaccoonAuth` / `TraeAuth` 同名方法同一模式）
- ⚠️ **纯本地、零网络**：掩码只依赖凭据里的昵称（与 TRAE 那条需要发
  `GetUserInfo` 不同）。单测断言 `fetcher` 未被调用
- ⚠️ **只在昵称确实变化时落盘**：`updateAccount` 是整体 replace

排查 / 验证：

- `scripts/probe-lobsterai-profile.mjs` —— 打印 `profile-summary` 的完整响应
  （**发现 `nickname` 在这里是完整号码 `13011111100`**，与登录响应的脱敏形态不同）
- `scripts/verify-lobsterai-nickname.mjs` —— 用真实账号跑一遍
  `repairAccountNicknames` 并打印修复前后昵称（⚠️ **会写真实账号池昵称**）
- `tests/unit/lobsterai.spec.ts` 的「手机号掩码（只露末 2 位）」段（8 条，
  含「非手机号形态原样返回」「末两位仍可区分」）、
  `tests/unit/lobsterai-auth.spec.ts` 的「老账号展示名回填」段（7 条，
  含「纯本地不发请求」「幂等」）

### ⚠️ 改昵称类修复必须**重启宿主**才生效，且旧进程会覆盖你的写入

**这是本轮实操踩到的坑**（2026-09-27）：用脚本把 `state.json` 的昵称改对之后，
**几分钟内又变回了旧值**（TRAE 的 `用户<uid片段>` 复活）。

根因：**当时有一个 1 小时前启动的 DSH 宿主进程仍在运行**（PID 9616，监听 3080）。
它加载的是**旧代码**（没有 `repairAccountNicknames`），内存里的账号池是旧昵称；
而 `AccountPool` 的写入是**整体 replace**（限流标记、续期回写等都会触发落盘），
于是它的下一次写盘就把脚本的修改**原样盖回去**。

两条必须记住的推论：

- ⚠️ **`repairAccountNicknames` 是「启动时」逻辑**：改完代码必须**重启 DSH**
  才会执行。不重启的话，无论脚本改多少次，旧进程都会覆盖
- ⚠️ **手工改 `state.json` 前先确认没有宿主在跑**（`Get-NetTCPConnection -LocalPort 3080`
  或看 node 进程），否则改动会被静默回滚 —— 症状是「明明改对了，过一会儿又变回去」，
  极易误判为「修复没生效 / 代码写错了」
- ⚠️ 验证修复是否真的生效，**唯一可靠方式是重启宿主**，然后看启动日志里有没有
  `[jet-hub] 已修正 N 个 … 账号的显示名`。脚本验证只能证明「逻辑正确」，
  不能证明「线上已生效」

### TRAE 倍率（藏在 `display_contact_config` 里，且该字段是** JSON 字符串**）

⚠️ **最大的坑**：`display_contact_config` 的值是**一个字符串**，里面才是 JSON。
直接读 `entry.display_contact_config.consumption_rate` 永远得到 `undefined` ——
必须 `JSON.parse` 两次（外层响应一次、这个字段再一次）。解析函数
`readConsumptionRate` / `readActivityDiscount`（`src/trae.ts`）。

```json
{ "consumption_rate": { "enable": true, "data": { "rate": 0.08 } },
  "activity_discount": { "enable": true, "subKey": "limited_discount",
    "data": { "current": { "discount_type": "limited",
                          "before_consumption_rate": 0.8,
                          "consumption_rate": 0.08, "discount": 10 },
              "limited": { "end_at": 1790265540 } } } }
```

- 倍率是 **裸数字**（`0.08`），既不是 buddy 的字符串 `"x0.29"`，也不是
  LobsterAI 的 `costMultiplier`
- ⚠️ **`rate: 0` 是「免费」，是合法值** —— 与 Qoder 的 `price_factor: 0` 同类，
  用 `> 0` 过滤会恰好漏掉免费模型；展示为「免费」而非 `x0`
- ⚠️ **`consumption_rate.enable === false` 视为「无倍率」**，不是「倍率 0」

#### ⚠️ `activity_discount.enable === true` **不等于**当前有折扣

**实测陷阱**（2026-09-20，与 Qoder 的 `promotion` 同类：**标志为真不等于当前生效**）：
`off_peak` 型条目形如

```json
{ "type": "none", "before_consumption_rate": 0.13,
  "after_consumption_rate": 0.13, "discount": 100 }
```

`enable` 是 `true`，但 `discount_type` 为 **`"none"`**、`before === after`
（`discount: 100` 是百分比制下的「无折扣」）。**照显会得到 `x0.13→x0.13`**，
让用户以为有活动。三条判据缺一不可（`readActivityDiscount`）：

1. `enable !== false`；
2. `data.current.discount_type` 存在且**不是 `"none"`**；
3. `before_consumption_rate` 为正，且**严格大于** `consumption_rate`。

另外 ⚠️ **`end_at`（Unix 秒）仅 `limited` 型带**（`subsidy` / `off_peak` 没有）。
**已过期必须整个不展示折扣** —— 否则用户按折扣价预期、实际被按原价计费。

展示形态由 `traeDisplayName`（`src/trae-adapter.ts`）拼装：
常态 `Qwen3.8-Flash · x0.08`；活动期 `Seed-2.1-Pro · x0.8→x0.08`。
`resolveModel` 的 `name` **不带**倍率（与 Qoder 一致）。兜底表路径**不显示倍率**
（兜底表无该字段，不猜价格）。

实测参考值（2026-09-20，`solo_agent` 可见集）：`glm-5.3-flash` x0.06、
`qwen3.8-flash` x0.08、`deepseek-v4.1-flash` x0.13、`glm-5.2` x0.78、
`qwen3.8-max` x1.5、`kimi-k3` x1.83；同一模型在三个通道的 `rate` **一致**。

### Qoder 倍率（`price_factor`，与腾讯系语义不同）

模型目录来自本机加密缓存 `~/.qoder/.models/{uid}/catalog-v6`
（`chat` 场景 17 个模型），倍率字段是 **`price_factor`**：

- ⚠️ **不是 `cost_multiplier`** —— 那是 LobsterAI 的字段名，两者易混
- ⚠️ **`price_factor: 0` 是「免费」**（实测 `qfmodel` / Qwen3.8-Flash），
  **0 是合法值**，不能用 `> 0` 过滤，否则恰好漏掉用户最关心的免费模型。
  展示为「免费」而非 `x0`
- 另有 `original_price_factor`（如 `qfmodel` 的 0.1 = 免费前的原价）
- ⚠️ **`price_factor` 是「采集时刻的生效价」，不是恒定原价** ——
  错峰窗口内它是折后价、窗口外是原价。故展示时**必须结合窗口本地推算**，
  不能直接照搬（照搬的后果：窗口一切换，界面价格就与真实计费不符）
- ⚠️ **错峰判据用 `windowStart`/`windowEnd` 本地推算（`promotionActiveNow`），
  *不*采信 `promotion.active`** —— 后者是目录下发那一刻的快照，
  客户端长时间不重启就会与真实时段脱节。窗口字段缺失时才回退到 `active`。
  生效价 = `beforePromotionPriceFactor × discountFactor`（实测三条全部吻合），
  窗口外则用原价。窗口统一 22:00–08:00（UTC+8），支持跨零点
- ⚠️ **折扣形态三个 provider 必须统一为「原价→折后价」**（TRAE `x0.4→x0.2`、
  buddy `x0.79→x0.50`、Qoder `x0.5→x0.2`）。Qoder 早期是「只有折后价 +
  中文角标」（`x0.2 错峰 4 折`），两个问题：① 看不出原价与折扣幅度；
  ② 角标与数字**冗余**（0.2/0.5 本就是 4 折）。用户要求对齐 TRAE。
  `promotion.badgeZh` 因此**不再参与展示**（字段保留，目录原始数据仍可对照）
- ⚠️ **本表的倍率数值必须逐条对照 catalog，不要凭印象填**：
  早期版本多处是手工估值，与真实值大范围不符（**14 个模型有偏差**：
  `smodel` 写 3.2 实际 8、`qmodel_38max` 写 0.5 实际 0.2、`auto` 写 1 实际 0.5 …），
  用户报障「qwen3.8-max 是 0.5 打折到 0.2，界面显示的是 0.5」。
  ⚠️ 而当时的单测**只断言了 id 列表**，所以价格漂移长期未被发现 ——
  改这张表时必须同步更新数值断言（`qoder-product.spec.ts`）
- `resolveModel` 的 `name` **不带**倍率后缀（价格只属于选择列表语境）

**解密该缓存**（`decryptModelCatalog`，`src/qoder-wasm.ts`）：

⚠️ **第二个参数是 `uid`，不是 `machine_id`**。两个官方调用点容易读反：
目录缓存的 `readSharedCacheSnapshot(A)` 传 uid，BYOK 的
`model_cache_decrypt(i, n)` 传 machineId。传错会得到
`AES-GCM decrypt failed: aead::Error` —— 看着像密文损坏，实为参数错。
调试脚本：`scripts/probe-qoder-catalog-debug.mjs`（两个候选都试）、
`scripts/probe-qoder-pricing.mjs`（打印 17 个模型的计费字段全貌）

### 同名模型必须消歧（`buildDisplayNames`）

远端会给**不同 id 配同一个 `name`**，而 DSH 按 `name` 展示 → 列表里出现
两个完全一样的条目。实测三组：

| 组 | 远端 name | 区别 |
|---|---|---|
| `deepseek-v4.1-flash` / `-sg` | 都是 `Deepseek-V4.1-Flash` | 新加坡区，`credits` x0.00 vs x0.03 |
| `hy3` / `hy3-x` | 都是 `Hy3` | — |
| `hy4-preview-f` / `hy4-preview` | 都是 `Hy4 preview` | — |

**用户报障**：「workbuddy 国际版同时显示 2 个 ds v4.1 flash，IDE 只有一个」。
IDE 按 name 归并，我们按 id 列出。二者是**不同区域的独立计费实体**，
不能靠丢弃其一来回避。

- 算法：对每组同名 id 求**公共前缀**，剩余段作为变体标记追加
  （`Deepseek-V4.1-Flash · x0.03 SG`、`Hy3 · x0.05 X`），空剩余段者不加标记
- ⚠️ **不要硬编码 `-sg`**：撞车组随服务端上新变化，本次实测三组里只有一组是
  `-sg`；也不要「取 id 最后一段」（会把 `gpt-5.6-sol` 的 `sol` 当变体）。
  公共前缀只在**确实撞车时**才切分
- ⚠️ **倍率与变体标记都只在 `name` 里出现一次**：初版两处都写，
  端到端实测出现重复文案与「计费 x0.00 · 」这种孤立分隔符
- LobsterAI **实测无同名**（28 个模型，0 组重名），故它不做消歧；
  兜底表路径也**不显示倍率**（兜底表无该字段，不猜价格）

排查脚本（全部只读 GET，零模型额度）：`scripts/probe-pricing.mjs`（各 provider
计费字段）、`scripts/probe-promotions.mjs`（`credits` 全量与促销结构）、
`scripts/probe-lobsterai-cost.mjs`（LobsterAI 倍率归属）、
`scripts/probe-lobsterai-dupes.mjs`（LobsterAI 同名检查）、
`scripts/probe-codearts-benefit.mjs`（CodeArts benefit 集合与判定）、
`scripts/verify-description.mjs`（端到端打印**切换菜单实际渲染的 name**）

## ⚠️ CodeArts benefit（免费额度）模型：集合必须动态判定，不能硬编码模型名

CodeArts 的 `snap-access/api/v2/chat/completions` 上有**两套模型注册**：benefit
（免费额度）与非 benefit。**benefit 模型的 chat 请求必须带 `maas_type: benefit`
请求头，且该头必须参与 SDK-HMAC-SHA256 签名**，否则后端返回
`InferHub.002002009.404 The model is not registered`（HTTP 200 + SSE 内嵌错误）。
反过来，给**非** benefit 模型带该头会被拒（`unsupported model`）。

**真实缺陷**（用户报障，2026-09-23）：用 `deepseek-v4.1-flash` 发消息后失败
（`Insufficient Balance` / `QUOTA`）。根因是 `src/llm-adapter.ts` 早期把 benefit
集合**硬编码**为 `new Set(['glm-5.3-flash'])` —— `deepseek-v4.1-flash` 是
2026-09 新增的 benefit 模型，因此从不带该头，后端按非 benefit 通道处理它。

实证矩阵（2026-09-23，对齐 deveco-code-rust `fb1b4a2`）：

| 模型 id | 来源 | 不带 maas_type | 带 maas_type |
|---|---|---|---|
| `glm-5.3-flash` | gateway/config | 404 未注册 | ✓ 成功 |
| `deepseek-v4.1-flash` | gateway/config | 404 未注册 | ✓ 成功 |
| `deepseek-v4-flash-0731` | gateway/config | 404 未注册 | ✓ 成功 |
| `deepseek-v4-pro-0813` | gateway/config | 404 未注册 | ✓ 成功 |
| `deepseek-v4-flash`（无后缀） | 静态表 / 归一化结果 | ✓ 成功 | ✗ unsupported |
| `deepseek-v4-pro`（无后缀） | 静态表 / 归一化结果 | ✓ 成功 | ✗ unsupported |
| `GLM-5.2` | model/builtin | ✓ 成功 | ✗ unsupported |

结论：**`gateway/config` 返回的模型即 benefit 集合**，无需靠模型名硬编码。

要点：

- 判定 `isCodeArtsBenefitModel`（`src/models.ts`）：远端拉取并缓存的集合
  （`~/.cache/deveco/codearts_benefit_models.json`）∪ 静态兜底
  `CODEARTS_BENEFIT_FALLBACK`（`glm-5.3-flash` / `deepseek-v4.1-flash`）。
  远端集合优先，后端新增 benefit 模型**无需改代码**
- ⚠️ **只记录「归一化未改写」的 id**：gateway 下发的是
  `deepseek-v4-flash-0731`，而 `normalizeModelId` 会把它改写成
  `deepseek-v4-flash` —— 两者在后端是**不同模型、benefit 属性相反**，
  记录改写后的 id 会让无后缀模型多带 `maas_type` 而失败
- ⚠️ **判定必须在 `stream()` 的重试循环外算一次**（要读缓存文件，不宜每轮 IO）
- ⚠️ **缓存读写必须用顶层 `import { … } from 'node:fs'`，不能用 `require`** ——
  本包是 ESM（`package.json` 的 `"type": "module"`），`require` 未定义、抛
  ReferenceError 后被 `catch` 静默吞掉，表现为「写不进也读不回」（`loadModelsCache`
  的模型列表磁盘缓存曾因此长期失效）
- `deepseek-v4.1-flash` 的上下文窗口按 IDE 下发的 inferhub-provider 配置声明为
  **1000000**（与无后缀 v4-flash/pro 的 1048576 不同）
- 回归用例：`tests/unit/models.spec.ts`（集合判定 / 落盘不含改写 id / 缓存往返）、
  `tests/unit/llm-adapter.spec.ts`（v4.1 带 `maas_type` 且参与签名、无后缀
  v4-flash 不带）、`tests/e2e/v4-models.e2e.spec.ts`（真实收发，需闸门）

### ⚠️⚠️ `InferHub.4004.200` 有**两条下发通道**，只接一条 = 两套判据（Issue IKLBSH A6）

同一个上游条件（该账号没有 benefit 包）走两条通道，**修复前只接了 SSE 那条**：

| 通道 | 形态 | 修复前 |
|---|---|---|
| SSE | HTTP **200** + `{error_code:"InferHub.4004.200",…}` | ✅ `consumeSse` 抛 `BENEFIT_NOT_FOUND_CODE` → 去头重试 |
| HTTP | **4xx** + 同一码 | ❌ **未接** → 径直落 `httpErrorCode` 归 `INVALID_REQUEST` 抛出，**去头一次也不试** |

症状：**同一条件下 SSE 能自愈、4xx 却硬报错** —— 即「同一语义两套判据」。

⚠️ **该缺陷由既有分支显式锁定过**：`origin/issue/IKJOF7-benefit-diagnostics`
（2026-10-05，Gitee IKJOF7 取证提交）用 `it.fails` 写了
「HTTP 4xx + 正文含 `InferHub.4004.200` 时也应当去头重试」，当时的结论是
**「已确认，但本分支不修」**（该提交只做了可观测性）。现已补上那一半。

**修法**：`isBenefitNotFoundBody(body)`（`src/llm-adapter.ts`）在 4xx 分支里
**复用同一个码值常量**与**同一个 `benefitHeaderDropped` 门禁**（只去头一次）——
两条通道共享标记，故叠加也**不会**放大成两轮请求。

⚠️ **不去采纳 issue 建议的「1s / 2s / 3s 递增退避重试最多 3 次」**：issue 给的
证据是「去掉请求头后密集取样 9 次全部 200」—— 那证明的正是**去头即通**，
而不是「需要多次退避」；且 `benefitHeaderDropped` 的既有语义写明「只试一次，
避免与真实失败互相掩盖」。**按证据改，不按建议改。**

⚠️ **4xx 分支的处理顺序不能挪**（`stream()` 的 HTTP 非 2xx 分支）：
鉴权刷新 → **额度** → **benefit 4xx** → 限流换号 → 排队探测 → `httpErrorCode`。
benefit 那条必须排在**限流之前**（否则被 `isRateLimited` 截走当可重试），
且必须在**额度判据之后**（`4004` 与 `4291` 是两个码，互不混淆但顺序仍锚定）。

回归用例：`tests/unit/llm-adapter.spec.ts` 的
「★ benefit 去头重试必须接上 4xx 通道」（4 条：主用例 + 非 benefit 模型对照 +
报文不含该码对照 + SSE 通道既有行为不变）。

## ⚠⚠️ 腾讯系内容级风控：system 里的客户端模板句会被**整轮拦死**（Issue IKJNA1）

**用户报障**（Gitee issue IKJNA1，2026-10-04）：ZCode 经本机 OpenAI 网关调
`workbuddy/deepseek-v4.1-flash` 稳定失败，ZCode 侧只显示
`provider_code=INVALID_REQUEST reason=unknown`；网关侧原始报错是

```text
workbuddy: 请求被安全策略拦截，请稍后重试或联系支持。 Illegal API invocation from an unapproved channel
```

DSH 直连同一模型正常 ⇒ 差别只在**外部客户端往 system 里注了什么**。

### 根因（本机 2026-10-05 实测复现，`www.workbuddy.ai` 与 `copilot.tencent.com` **两端点一致**）

腾讯网关按**请求内容指纹**拦截，与账号、凭据、请求头、tools 全无关。最小充分
触发串是 ZCode 内建的 gitStatus 模板句常量
（`$Js="Main branch (you will usually use this for PRs)"`，拼在
`Main branch … : <分支名>` 那一行，每个 git 仓库里的会话必然注入）。

| 探针（`max_tokens=16`，被拦不耗额度） | 结果 |
|---|---|
| 中性 system | ✅ 200 |
| `Main branch (you will usually use this for PRs): master` | ❌ 400 `code:11128` |
| `Main branch: master`（只留标签） | ✅ 200 |
| 换分支名（`dev`） | ❌ 400 ⇒ **分支值无关** |
| 句中 / 段中被别的句子夹住 | ❌ 400 ⇒ **位置无关** |
| **改写该句**为 `Main branch (PRs usually go here)` | ✅ 200 |
| 同一句放进 **user** 消息 | ✅ 200 ⇒ **只拦 system** |
| 同一句放进 **tool** 消息 | ✅ 200 ⇒ 同上 |
| 指纹在**第二条** system（非 `messages[0]`） | ❌ 400 ⇒ **所有 system 都要改** |
| 只差一个词（`normally` 替 `usually`） | ✅ 200 ⇒ **逐字符**匹配 |
| 内层多一个空格 | ✅ 200 ⇒ 同上 |
| **全小写 / 全大写** | ❌ 400 ⇒ **大小写不敏感** |

⚠️ **本机客户端侧对不上号**：本地装的是 ZCode **3.14.3**，其 asar 里
`Main branch` / `you will usually use this for PRs` **命中 0 次**（issue 报障用的是
3.14.4）。取证脚本 `scripts/probe-zcode-gitstatus-fingerprint.mjs`（按字节流找，
⚠️ **不能用 rg**：asar 是 297MB 单行二进制，rg 的行长上限会静默漏报 ——
`-o ".{200}Current branch:.{300}"` 返回 0 而 `-c "Current branch"` 返回 1）。
⇒ 「客户端一定注入这一句」这条来自 issue 报告者的 3.14.4，**服务端那一半已本机实测**。

### 修法：网关出站方向的**表驱动**窄改写

`src/openai-gateway/tencent-fingerprint.ts`，只对 `buddy` / `workbuddy`，
只改 **system** 消息，三处接入点（**改一处漏两处 = 换一个端点又被拦**）：

| 端点 | 接入点 |
|---|---|
| `/v1/chat/completions` | `messages.ts` 的 `convertMessage`（`role==='system'` 分支） |
| `/v1/responses` | `responses.ts` 的 `toMessages`（input 里的 `system` / `developer`） |
| `/v1/responses` | `responses.ts` 的 `toResponsesGenerateOptions`（**`instructions`** —— Responses 端唯一的 system 通道，客户端常把整份系统提示词放这里） |

四条实现约束（每条都对应上表一行实测，改动时别把它们「简化」掉）：

1. **只动 system**：`user` / `assistant` / `tool` 一概不碰（改它们没有收益，
   却会篡改用户原话与工具输出）。
2. **所有** system 消息都改，不只 `messages[0]`。
3. **大小写不敏感的精确字面量**（`new RegExp(escapeRegExp(find), 'gi')`）：
   `i` 是必需的（全小写 / 全大写都被拦），但**不能**泛化成正则/关键词黑名单
   （只差一个词、多一个空格服务端都放行）。
4. **不含指纹的文本逐字节不变**：腾讯侧按前缀缓存，无谓地重建字符串会让每轮
   都算新前缀、白吃缓存命中 ⇒ 实现里有一次 `toLowerCase().includes()` 预检。

⚠️ **表驱动而不是写死一处**：屏蔽名单服务端掌握、可能随时更新，任何客户端将来
都可能撞上新指纹。新增一条 = 表里加一行 + 一条用例。

### ⚠️⚠️ 千万不要把 `11128` 加进 `isContentRejection`

`buddy-adapter.ts` 的 `isContentRejection`（11140 / `request illegal` /
`安全审核|safety review`）**维持现状是正确的**：认成账号级会走
`markPolicyBlockedAccount` → **30 分钟账号冷却**（`policyBlockResetAtMs`），
把一次请求级拒绝放大成「整个账号池半小时不可用」。

#### ⚠️ 但「11128 = 内容级拦截」这个定性**不准确**，别照着它判断原因

`11128` 是**一个共用业务码**，至少四族成因，`msg` 字段各不相同 —— **只有看 `msg`
才能定位**。写死成「内容级」会把排查引向「找哪句话触发了风控」，方向完全错：

| `msg` | 族 | 换账号/换模型有用？ | 正确出路 |
|---|---|---|---|
| `Illegal API invocation from an unapproved channel` | 渠道级 | ❌ | 走网关的指纹改写链路（见本节上文） |
| `first message is not system prompt` | 消息形状级 | ❌ | 补首位 system（`LEADING_SYSTEM_PLACEHOLDER`） |
| 含风控指纹字面量（`displayMsg.zh`=「请求被安全策略拦截」） | **内容级** | ❌（11140 实测：同一份请求体 7 个账号 → 2 通 / 4 拦 / 1 限流 ⇒ 换号**有用**） | 改写 `system` / `assistant` 正文 |
| **`conversation id missing` / `request illegal`** | ⚠️ **已定位到字段级**：「三枚 Conv 头同时存在且非空」——**但按账号生效**（IKM7SG；⚠️ 真实 `msg` 实测是 `request illegal`，见下节） | ✅ **换号有效**（多数账号上三头非必需；少数要求，本实现已满足） | 本档「按账号换号」已实现且**不写冷却**（逐请求判定，实测 `200→400→200`）；⚠️ 别按「内容」方向排查 |

⚠️ 前两族「改内容就 200」成立（各有一字不改就不通的实测用例）。**第三族**
（内容指纹）实测时是**单账号**探针 ⇒ 「换账号有用/无用」这一格**只在 11140 那族
有逐账号对照**（2 通 / 4 拦 / 1 限流 ⇒ 腾讯风控**可以**是账号级的）。

⚠️⚠️ **「第四族至今未能复现」是已过期的结论**（2026-10-17 更正）：第四族现已**实测
稳定复现**，且**按账号生效**（本机 2/5）。⚠️ 它连 `displayTips` 都在说「这次调用没通过
渠道校验，**可能不是官方客户端发出的**」，很容易被顺理成章地归到「少发了什么头」——
**那个归类恰好是对的，但当时的推理链是错的**（当时以为是「按内容判」）。完整实测与
两处真实缺陷见下一节。

#### 🔴 `conversation id missing`：三头准入必要性是「**按账号**」的（IKM73W + IKM7SG，2026-10-16）

issue IKM73W 曾断言「三头缺任一即 400/11128」，PR #104 据此给聊天主链路补了三枚头。
随后维护者用真实凭据（约 90 次请求）**在该账号上**推翻了它。
**IKM7SG 用本仓库自己的 e2e（`pnpm test:e2e:buddy-conv`）、只换 `WB_REF`，把边界
定位到了「账号」这个控制变量** —— **两批结论都对，差的是账号**：

| `WB_REF` | 基线（全头） | 删任一枚 | 三枚全删 |
|---|---|---|---|
| `D87606B1` | ✅ 200 | ✅ 200 | ✅ 200 |
| **`66E05E7C`** | ✅ 200 | ❌ **400/11128** | ❌ **400/11128** |

⇒ 准确表述：**「在多数账号上三头非必需；在特定账号上必需」**。

下表是维护者那批复测的结果，**只在参与实验的那个账号上成立**（别再加「全局」二字）：

| 实验 | 规模 | 结果（**在参与实验的那个账号上**） |
|---|---|---|
| 适配器 A/B（剥三头 vs 带三头） | 5 模型 × 各 5 次 | 剥三头 **15/15 成功**，两组**完全一致** |
| **逐枚消融 14 枚头** | 每枚单独删一次 | **14/14 全部仍 200**（含三枚 `X-Conversation-*`） |
| 裸 fetch 头形态矩阵 | 5 种头形态 × 2 种 system × 3 次 | 干净 system **全 200**；带指纹 system **全 400** ⇒ **变量是 system，不是头** |
| 真模型线 × 请求形状 | 6 模型 × 4 形状 = 48 格 | 三头与响应状态**零关联** |
| 逐级剥头阶梯 | 8 级（末级连 UA / 鉴权头 / 身份头都不发） | **全 200** |

⇒ **在该账号上，同一份请求连鉴权头、身份头、UA 全删掉，上游照样回 200。**
`conversation id missing` 在**那批**实验里**零次复现**，而同批实测**复现了**
另两句（`first message is not system prompt`、`Illegal API invocation from an
unapproved channel`）⇒ 说明那批请求确实打到了能报 11128 的网关，不是打错了地方。

⚠️⚠️ **IKM7SG 在「要求三头」那个账号上穷举出的判据**：
`X-User-Id`/`X-Session-ID`/`X-Agent-Intent`/`X-Request-Id`/`X-Trace-Id`/
`X-Client-Platform` **全 400**（都不是判据）；**仅补一枚** Conv 头仍 400；
**三枚同值 / 各自不同 / 填 `abc-123`** 全 200（**不校验值语义、不要求三者一致**）；
**三枚填空串** 400；带三头 → 紧接无头 `200→400` ⇒ **逐请求**判定
（**非账号封禁、非状态粘性**）；换 system / 换最简 body 仍 400（**内容无关**）。
⇒ 判据 = 「**三枚 Conv 头同时存在且非空**」，**但只对该账号生效**。

⚠️ **为什么只有那个账号：IKM7SG 明确未定论。** 唯一可观测差异是该账号 token 缺
`name`/`family_name`/`given_name`（1321 vs 1414 字符，即一次未走完整 profile 流程的
凭据）—— **n=1、无因果证据、仅作线索**。别据此写断言。

#### 🔴🔴 `msg` 的真实形态是 `request illegal`，**不是** `conversation id missing`（2026-10-17 独立复验）

**这一节是 IKM7SG 复验中最重要的发现，它推翻了本节标题里的那句 `msg`。**

维护者用本仓库 e2e 独立复跑了 IKM7SG 的全部实验，**判据本身完全复现**
（三枚同值/异值/`abc-123` 全 200、空串 400、删任一枚 400、逐请求可切、内容无关），
**但报文的 `msg` 字段对不上**：

```json
{"code":11128,"msg":"request illegal","requestId":"…",
 "displayMsg":{"zh":"请求被拦截，请重新发送"},
 "displayTips":{"zh":"这次调用没通过渠道校验，可能不是官方客户端发出的。请用官方版本重新发送。"},
 "actions":["EDIT_INPUT","SUBMIT_FEEDBACK"]}
```

⚠️ `conversation id missing` 这句在本机**从未出现过**（5 个 workbuddy 账号 ×
数十次请求，跨多个时段，零命中）；两个**不同**账号上稳定拿到的是 `request illegal`。

⚠️ **独立第三方复现**（issue 报障者 ThinkofRain1213，2026-10-17 22:59，PR !113）：
在**他自己那个账号**（`66E05E7C`）上连打三次，**三次全是** `msg="request illegal"`、
`conversation id missing` 零命中 ⇒ 与本仓观测**双向独立一致**。他并明确承认
「我 10-16 那批记录里它是稳定措辞，但**把它当成稳定契约是我错了**」。

##### ⚠️⚠️「只是措辞变了，判据没变」—— 这条对照是关键（**别只测 msg**）

⚠️ 仅比对 `msg` 字面**不足以定论**：「上游改了措辞」与「这是全新的一类拒绝」
在现象上无法区分。**必须有一组「同账号、同时刻、只切请求形态」的对照**才能排除后者。
报障者补上了这一环（PR !113 评论），本机复现结论完全一致：

| 形态（同账号 `66E05E7C` / 同一时刻） | 结果 |
|---|---|
| **无三头** | ❌ 400 `code=11128 msg="request illegal"` |
| **带三头**（uuid32 同值） | ✅ 200 |
| 带三头 + 换 system 文案 | ✅ 200（内容无关） |
| 带三头 + `abc-123` | ✅ 200（不校验值语义） |
| 带三头 + **空串** | ❌ 400 `request illegal` |
| 无三头（复测） | ❌ 400（稳定） |

⇒ 判据与 10-16 记录**逐条一致**，**只有 `msg` 的字面换了**。
**决定性的一条是「带上三头就通」** —— 它排除了「`request illegal` 是另一类拒绝
（例如 11140 那种账号级内容拦截）」这一解释：若是另一类，加三头也过不去。
⇒ 本仓「并入渠道校验档、换号但**不写冷却**」的处置方向由此得到**跨账号的独立佐证**
（不止本机 2 个账号，而是两个互不相干的账号池上各复现一次）。

⚠️ 另记该对照的**方法论价值**：本仓此前的复现全部只做了「消融」（逐枚删头），
**没做过「同账号同时刻的正反对照」** —— 后者才能把「措辞变」与「性质变」分开。
⚠️ 这是本仓取证方法的一个**缺口**，下次换 provider 时应补上。

##### ⚠️⚠️ 判据已在**编译产物 `lib/`** 上独立验证（不只是源码层）

报障者在装 `e0eb802` 后，从 `lib/buddy-adapter.js` **提取正则**（不手抄）跑真实报文，
5/5 判定正确 ⇒ **两轮审计整改后的形态在用户机器上真正跑的那份代码里同样成立**。

⚠️ 这条正好补上本仓 AGENTS.md 记着的那类缺口（**源码断言 ≠ 产物断言**）：
`pnpm test` 全部读**源码**，单测全绿**不能证明** `tsc` 产物里那份是对的。
本仓此前对判据类改动的验收**止于源码层** —— 本条是外部贡献者补上的，建议
**今后判据类改动加一次「从 `lib/` 提取实现再跑一遍」**（可用 grep 抽正则后对
真实报文批量比对，成本极低）。

⚠️⚠️ **这不是「换个措辞」的小事** —— PR #104/#105 的渠道校验判据正是按
`conversation id missing` 写的，于是这份真实报文**恒不命中**，整条链路掉进
`isContentRejection` 的 `/request illegal/i` 腿（11140 账号级拦截那一档）：

| 环节 | 实测到的错误处置 |
|---|---|
| 归属 | `isContentRejection`（安全策略拦截） |
| 处置 | 换号 + **写 30 分钟冷却**（`updateModelRateLimit`） |
| 出口文案 | 「全部账号均被服务端安全策略拦截…请在 Jet Hub **停用或更换**被拦账号」 |
| 错误码 | `PERMISSION_DENIED` |

而该账号**带上三头立刻 200** ⇒ 这正是「**不可**写冷却」的那一档。用户照提示停用它，
账号更少、渠道更不可用。**症状与 PR #105 明确要避免的失败形态逐字同形**，
只是入口判据认错了报文。

##### ⚠️ `request illegal` 与 11140 **共用**，所以两条判据必须**同时**按 `code` 收窄

实测 11140 的报文是 `{"code":11140,"msg":"request illegal"}` —— **同一句措辞**。
⇒ 只放宽渠道校验档（会被 11140 档先吃掉，无效）；
只收窄 11140 档（没人认领，直接抛，无效）。**两处必须同改**。

⚠️⚠️ **判据不能用 `displayTips` 的「渠道校验 / channel verification」**：
实测 11128 的**各个子原因共用逐字相同的 `displayTips`** —— 本机同时抓到
`msg:"request illegal"` 与 `msg:"Illegal API invocation from an unapproved channel"`
两份报文，二者的 `displayTips` **逐字节相同**；且它与 11140 族那句
「安全策略拦截 / blocked by security policy」也高度相近。
用它会把**内容级**的 `Illegal API invocation…` 拖进换号，而那一句换号**完全无效**
（腾讯指纹改写链路处理、每个账号都被拦在同一句上）⇒ 整池被白烧。

⚠️ **右边界是 `(?![\d.])`、不是 `(?![0-9])`**（自引入缺陷，单测实测）：
JSON 允许非整数码，`JSON.stringify({code:11128.5})` 写出 `11128.5`，`.` 不在
`[0-9]` 里 ⇒ 只挡数字的写法会**放行小数**并误命中。

⚠️⚠️ **别用 `name` claim 那条线索做判据**：本轮 5 个账号的 claim **键集完全相同**
（`acr/allowed-origins/aud/auth_time/azp/email/email_verified/exp/iat/iss/jti/
preferred_username/realm_access/resource_access/scope/sid/sub/typ`），
两个受限账号**互不相同**、也与不受限账号无稳定差异 ⇒ **本机 n=5 上零证据**，
IKM7SG 那条「缺 `name`」线索在本次复验中**未获支持**（不是被证伪，只是无支持）。

##### ⚠️⚠️⚠️ 那个 P0 只修了一半：**腿①/腿② 的排除从未被修**（2026-10-18 独立审计实测）

上表那个 **P0** 的结论是「排除必须覆盖 `isContentRejection` 的**全部**腿」，
修法是函数开头**一次早退排除**。⚠️ **但那次排除用的判据只认腿③**：

| | 2026-10-17 的 P0 修完后 | 2026-10-18 本轮修完 |
|---|---|---|
| 排除用的判据 | `isChannelVerificationIllegalBody` = `ILLEGAL_CODE` + `ILLEGAL_MSG` | `isChannelVerificationBody` = `ILLEGAL_CODE` + `CHANNEL_VERIFICATION_PHRASE` |
| 腿③ `request illegal` | ✅ 已排除 | ✅ 仍排除 |
| **腿①/② `conversation id missing`** | ❌ **完全没排除** | ✅ 已排除 |

⇒ 「那个 P0 只修了一半」：**它修的是「排除写在三条腿中的哪一条」，
没修「排除覆盖了渠道校验档的几条腿」** —— 后者才是 P0 结论本身。

**触发形态**（真实可达，仓库自己就是证据）：

```json
{"code":11128,"msg":"conversation id missing",
 "displayMsg":{"zh":"内容未通过安全审核，请调整后重试。"}}
```

`displayMsg.zh` 那句正是**本文件上文**记录的 11140 真报文措辞，而「11128 各子原因
共用/漂移 `displayMsg`」本仓**已有先例**（腿③ 的注释就把它列为可达形态）。

| 环节 | 修复前 | 现版 |
|---|---|---|
| 归属 | 落 `isContentRejection`（11140 档） | 落渠道校验档 |
| 处置 | 换号 + **写 30 分钟账号冷却** | 换号、**不写冷却** |
| 出口文案 | 「…请停用或更换被拦账号」 | 「未通过渠道校验…重发无效」 |

⚠️ 症状与本档明确写「**不可**」写账号级冷却的那件事**逐字同形**：可用账号被
凭空封 30 分钟、UI 显示「限额重置」、并建议用户停用它 —— 而该账号带上三头
立刻 200（IKM7SG 实测）。

⚠️⚠️ **为什么 2026-10-17 那批守卫全绿**：它们的 `msg` **全是 `request illegal`
（腿③）** ⇒ 早退排除生效 ⇒ 腿①形态**完全不在观测范围内**。⇒ 补法与本文件上方
「只有这条腿能认领」那条判别法**完全同款**：另造**腿①形态**的夹具。

⚠️⚠️ **修法必须保持「`code` 精确等于 11128」这道闸门**，**不得**简写成
`CHANNEL_VERIFICATION_MSG_FIELD.test(body)` —— 腿① 那条腿**不带 `code` 判据**
（它刻意要覆盖「报文里带这句话的一切形态」），单独拿它排除会让
`{"code":11140,"msg":"conversation id missing"}` 被放行 ⇒ **真 11140 反被剥掉
冷却** ⇒ 每轮重撞同一坏账号（本轮有反向守卫锁这一格）。

⚠️ **本轮变异验证（4 有牙 / 1 零牙如实登记）**：

| 变异 | 结果 |
|---|---|
| M1 恢复旧实现（排除只用腿③） | ✅ **3 红** |
| M2 `CHANNEL_VERIFICATION_PHRASE` 窗口 `{0,200}` → `*` | ❌ **零牙**（见下） |
| M3 排除**去掉 `code` 闸门**（只认措辞） | ✅ **26 红** |
| M4 去掉 `ILLEGAL_CODE` 的右边界 `(?![\d.])` | ✅ **2 红** |
| M5 `msg` 值位锚点去掉（裸扫全文） | ✅ **2 红** |

⚠️ **M2 无牙，如实登记、不补伪用例**：`[^"]{0,200}?` 里的 `[^"]` 语义本就是
「吃到闭合引号为止」，对 `msg` 的**值位**已经构成硬上界 ⇒ `{0,200}` 与 `*` 在
值位语义上**等价**，无差异可观测。⚠️ 这与上面那个 M9 零牙**不是同一原因**：
M9 是「差异存在但外部观测量恒相同」，M2 是「差异在语义上根本不存在」。

⚠️ 另记一条**本轮新踩**的过程教训：变异注入后必须**打印实际片段**确认命中。
M2 初版用 `replace` 注入，若锚点因 CRLF 未命中会**静默不生效** ⇒ 「全绿」的
其实是没被注入的基线。本轮已按此纪律逐个打印确认（本文件上方亦记有同款教训）。

⚠️ **残留缺口（如实登记，**不是**本轮引入）**：三条腿的值位窗口都是 `[^"]{0,200}?`，
遇 JSON **转义引号 `\"`** 会截断 ⇒ 措辞若在转义引号**之后**就漏认。实测三条腿
（腿① / 腿③ / 本轮新增那条）在 `{"code":11128,"msg":"say \"hi\" then request illegal"}`
上**全部返回 false** ⇒ **既有**同型缺口。
⚠️ 本轮**刻意不修**：修它要写 JSON 感知的字符串扫描，且三条腿**必须一并**改
（改一处会留下「腿① 认、腿③ 不认」的漂移）；实测报文的 `msg` 恒为短句
（不含引号）⇒ 无实测可达性。

##### ⚠️⚠️ 对抗审计纠正了我自己的**一处注释撒谎**（2026-10-18）

我第一版注释写的是「排除必须覆盖渠道校验档的**全部三条腿**」——
**这句是字面错误**：腿②（`CHANNEL_VERIFICATION_BARE`，HTML/纯文本裸子串兜底）
按定义锚的是「压根不是结构化报文」⇒ **没有 `code` 键** ⇒ `ILLEGAL_CODE` 恒 false
⇒ **结构上不可能**被本排除覆盖。而排除又**必须**锚 `code`（否则真 11140 被剥冷却）
⇒ **二者不可兼得**。

⇒ 精确表述已改为「覆盖**全部带 `msg`/`message` 措辞**的形态（腿① + 腿③）」，
并登记后果：`<html>… conversation id missing … 安全审核 …</html>` + 400 仍落
11140 档、写冷却（**预先存在**、无实测可达性 ⇒ 不修）。
⚠️ **教训**：注释撒谎比没有注释更危险 —— 它是下一个审计拿来当契约的东西。

##### ⚠️ 另一个残留缺口：`ILLEGAL_CODE` 扫全文，**不锚顶层**（对抗审计指出）

```json
{"code":11140,"msg":"boom","inner":{"code":11128,"msg":"request illegal"}}
```

⇒ 外层真 11140、内嵌 11128 ⇒ 排除触发 ⇒ 真 11140 **不写冷却**。

⚠️ **归属要记准**（实测）：该缺口在**腿③ 形态上上一版就有**（旧实现对同一条报文
同样排除）⇒ 非本轮引入；**本轮新增腿① 让它多了一个触发面**（内层是
`conversation id missing` 时旧实现不排除、现版排除）—— 这才是本轮的净增量。

⚠️ **本轮刻意不修**，三条理由：
1. 锚顶层的常规写法**不可行**：`^\s*\{\s*"code"` 会打红「`msg` 排在 `code` 之前
   必须仍被认领」那条 P1 守卫（JSON 键序无保证）；
2. 正解是 `JSON.parse` 取顶层 `code`（实测 8/8 形态正确），但它把**格式错误报文
   从 fail-open 改成 fail-closed**（BOM / 尾随逗号解析失败 ⇒ 不再认领），
   属**方向性变更**，必须单独评估；
3. 无实测可达性（真实错误体是**单层** JSON 对象）。

##### ⚠️ e2e `judge()` 与实现侧有 **4 格漂移**（对抗审计确认，本轮**登记不修**）

| 报文形态 | 实现侧 | e2e `judge()` |
|---|---|---|
| `{"code":"11128",…}`（`code` 是字符串） | ✅ 认 | ❌ `other` |
| `{"code":11128,"message":…}`（键名 `message`） | ✅ 认 | ❌ `other` |
| `{"code":11128,"msg":"request  illegal"}`（多空格） | ✅ 认 | ❌ `other` |
| `{"code":11128,"msg":"Request-Illegal"}` | ✅ 认 | ❌ `other` |

⚠️ 后果是**假红 + 误导性文案**：落 `other` ⇒ e2e 断言会输出「且**不是** IKM7SG
记录的 account-gated」⇒ 把人指向「**上游行为已变**」—— 这正是 issue 评论里
点名要消除的那种误导。
⚠️ **不修**的三条理由：① 生产爆炸半径 0（`judge()` 只在 `tests/e2e/`，
`pnpm test` 不执行）；② 修它要**两份同步改**（e2e + `tests/unit/buddy-conv-judge.spec.ts`
镜像），本身是漂移风险面，不宜夹进 P0 热修的 diff；③ 该漂移的根因是
**抽取方式**（正则抽字段 vs 结构化匹配），而这个差异**刻意存在**。
⚠️ 但 `buddy-conv-judge.spec.ts` 里那句「两份的取值范围是相同的」**已按实更正**
（对上面 4 格不成立）—— 否则下一个审计会拿它当契约。

##### ⚠️⚠️ P1：限流换号循环的 ②/③ 顺序会把 403 形态的渠道校验**短路**（2026-10-18 独立审计实测，本轮修）

**这一条与上面那个 P0 无关，是独立审计另外查出的。**

上游对渠道校验**同时用 400 与 403**，而限流换号循环里
「②认证类 `if (401||403) continue`」排在「③渠道校验」**之前**
⇒ **403 形态被 ② 全部短路**，③ 一次都不执行，`sawChannelVerification` 置不了位。

⚠️⚠️ **触发条件必须从「限流」进来，否则复现不了**（我第一版就搞错了，这里记准）：

| 入口 | 循环内 | 修复前出口 |
|---|---|---|
| 渠道校验（400/403） | 任意 | ✅ 已正确（`sawChannelVerification` **由入口值初始化**为 true） |
| 渠道校验（400/403） | 混合 400/403 | ✅ 已正确（同上）—— ⚠️ **我第一版按这个复现，全部通过** |
| **429 限流** | AT2/AT3 = **400** 渠道校验 | ✅ `PERMISSION_DENIED` |
| **429 限流** | AT2/AT3 = **403** 渠道校验 | ❌ **`QUOTA_EXCEEDED`**「所有账号均受限，请稍后再试」 |

⚠️ 关键在入口那一行：
```ts
if (this.options.accountPool && (isRateLimited(errorText, response.status) || channelRejected)) {
```
只有入口命中才进这个循环。若入口**本身就是**渠道校验，`channelRejected` 为 true
⇒ `sawChannelVerification` 已由入口值初始化 ⇒ ③ 一次不跑也照样出口正确
⇒ **这就是「混合 400/403 池」复现不出问题的原因**（与本文件上方 M5b 那条
「必须用入口值初始化」是**同一条纪律**的两面）。

**后果**（正是本节写「必须先于 QUOTA_EXCEEDED」要消灭的形态）：用户看到
「模型 X 所有账号均受限，请稍后再试」⇒ 以为在限额、**白等一个根本不存在的
重置时刻**；而真实出路是「换号 / 停用该账号 / 换 provider」。

**修法**：把 ③ 提到 ② 之前。⚠️ **顺序纪律与 400 路径那条换号循环对齐** ——
那里把 `isContentRejection` 放在 401/403 腿**之前**（可观察的纪律），
限流路径原先却相反 ⇒ **两条路径判据同型、顺序相反**。本轮对齐。

**变异验证**：把顺序还原成缺陷态 ⇒ **该用例精确变红、其余 279 条全绿** ✅ 有牙。

##### ⚠️⚠️ P1-1：排除的窗口必须与**归属**判据同宽（2026-10-18 对抗审计实测，**我自己引入的**）

排除判据 `CHANNEL_VERIFICATION_PHRASE` 初版用 `[^"]{0,200}?`（有界，对齐腿③），
而归属判据**腿①** `CHANNEL_VERIFICATION_MSG_FIELD` 用 `[^"]*`（**无界**）⇒
**「属不属于渠道校验」判得比「要不要写冷却」更宽** ⇒ 两者**不再互斥**。

| 措辞距 `msg` 值开头 | 排除 | 归属 | |
|---|---|---|---|
| 0 / 180 / 195 / 199 | ✅ | ✅ | 互斥，正确 |
| **205 / 260 / 500** | ❌ | ✅ | 🔴 落 **11140 档 ⇒ 写 30 分钟冷却** |

⚠️ **方向恰好与修复目的相反**：修复 A 是为消灭「可用账号被凭空封 30 分钟」，
这个不对称**制造了一条同类的新触发面**（端到端实测：403 与流内 200 两条通道都写冷却）。

⇒ **改为 `[^"]*` 与腿① 对齐**。⚠️ 「有界 vs 无界」此处**不是取舍而是一致性约束**：
排除必须**至少**覆盖归属判据认得的一切。⚠️ 反向不成立：把腿① 收窄成有界会让
「长 `msg` 里写着渠道校验措辞」的报文**两档都不认领** ⇒ 直接抛裸错误，
比写冷却更差（丢掉了「换号 + 不写冷却」这条唯一出路）⇒ **只能向排除侧放宽**。

⚠️ **这同时补全了上面 M2 的零牙**：M2（`{0,200}` → `*`）之所以零牙，正是因为
既有夹具的 `msg` 全是短句 —— **零牙源于夹具没覆盖边界，不是该变异无害**。
补上长 `msg` 夹具后实测**精确 3 红**（199 绿 / 205、260、500 红）⇒ 转为有牙。

##### ⚠️ P2-1：腿① 不锚 `code` ⇒ 任意 `code` 值都被认领（**预先存在**，暴露面被本轮放大）

`{"code":9999|14003|6004,"msg":"conversation id missing"}` 一律 CV 命中
（腿① **刻意**不设码域闸门，理由见实现侧注释的「强证据」论证）。
⚠️ 后果：一个 `429 + conversation id missing` 的报文会让入口 `channelRejected=true`
⇒ 进入换号循环 ⇒ **限流被报成 `PERMISSION_DENIED`「未通过渠道校验」**，
而真实出路是「等重置」。
⚠️ **预先存在**（腿① 早于本轮），但本轮把 `isChannelVerificationRejection` 推成
出口的核心判据（修复 B）⇒ **暴露面被放大**。
**如实登记、不修**：是否有实测可达性取决于上游会不会在 429 报文里用这句话，
本仓**无实测**；而给腿① 加码域闸门会破坏它「跨状态码认领」的既有设计。

##### 「按账号生效」在本机复现为 **2/5**

| 账号（池内顺序） | 不带三头 |
|---|---|
| `WORKBUDDY_ACCOUNT_80E83BC0` / `8B9BDC8F` / `66258C6C` | ✅ 200 |
| **`WORKBUDDY_ACCOUNT_8FC80606` / `05839E73`** | ❌ **400/11128 `request illegal`** |

⚠️ 两个受限账号占 5 个里的 2 个 ⇒ **不能**按「极少数边缘账号」估计影响面。

##### ⚠️⚠️ 第一版修复的**两处真实缺陷**（两轮审计查出，**都不是自查发现的**）

| # | 缺陷 | 症状 | 修法 |
|---|---|---|---|
| **P0** | `isContentRejection` 的排除**只加在三条腿中的一条**（`/request illegal/i`）上，**第三条腿（`安全审核\|safety review`）没排除** | B 族报文只要 `displayMsg` 漂到安全审核措辞 ⇒ 落 11140 档 ⇒ **写 30 分钟冷却** ⇒ **本次要修的缺陷原样复现** | 排除改成函数开头**一次早退**，覆盖全部腿 |
| **P1** | 新判据用 `[^{}]*` 把 `code` 与 `msg` **串起来** ⇒ 引入 **JSON 字段顺序依赖** | `msg` 排在 `code` 之前 / 中间夹嵌套对象 / `code` 是字符串 ⇒ **漏判** ⇒ 回落 11140 档 ⇒ 写冷却 | 两个条件改成**独立**前瞻断言（各自有界窗口 `{0,200}`） |

⚠️ **P0 的可达性不是假想**：`displayMsg.en` 那句
`The content did not pass the safety review.` 正是**本文件上方**记录的 11140 真报文措辞
（zh=「内容未通过安全审核」），而 11128 各子原因**共用/漂移 `displayMsg`** 本仓已有先例。

⚠️ **P1 的现网风险**：`msg` 紧跟 `code` 是**当前**恰好成立的键序；**JSON 对象键序无任何
保证**，网关重排字段就静默漏判。

⚠️⚠️ **方法论教训**（本条最该记住）：我第一版自查时**把「给三条腿各加一次排除」当成了
「一次排除」，把「`code` 在前 `msg` 在后」当成了报文不变式**。两处都是**把当前形态
当成了契约**。判据类改动应问的是「**哪些形态会漏**」，而不是「当前这份报文长什么样」。

##### 变异验证（审计前6 个 + 审计后补 2 个，其中 **1 个实测零牙**）

| 变异 | 结果 |
|---|---|
| M1 删掉腿③ | ✅ 6 红 |
| M2 `isContentRejection` 不再排除 | ✅ 3 红 |
| M3 右边界只挡数字不挡小数 | ✅ 1 红 |
| M4 **判据放宽成只按 msg 判** | ❌ **零牙（全绿）** |
| M5 分隔符 `+` 改 `*` | ✅ 1 红 |
| M6 收窄成只认 `msg` 键 + 单空格 | ✅ 4 红 |
| **M7 只排除第二条腿、第三条不排除（= P0）** | ✅ **8 红** |
| **M8 `code` 与 `msg` 用 `[^{}]*` 串联（= P1）** | ✅ **5 红** |
| M9 `msg` 窗口改成无界（`[^"]*?`） | ❌ 零牙（见下） |
| M10 删掉「安全审核」那条腿 | ✅ **4 红**（审计指出后补守卫） |
| M11 删掉 `"code":11140` 那条腿 | ✅ **3 红**（审计指出后补守卫） |

⚠️ **M4 无牙，如实登记、且不补伪用例**：判据层面它确实有差异（实测 5 格报文上
严格/放宽命中不同），但**行为上不可观测** —— 能区分两档的报文都含
`request illegal`，会**同时**被 `isContentRejection` 的裸腿认领，两档的外部观测量
（都换号、都写冷却）在这些格子上**完全相同**。曾试图用裸文本报文（无 `code`/`msg` 键）
构造「渠道校验是唯一认领者」的场景，实测**仍全绿**：严格判据不认领它，但
`/request illegal/i` 裸腿照样把它收进 11140 档 ⇒ 两档结论一致 ⇒ 无差异可观测。
⇒ **判据本身是正确的，缺的是「能把两档分开的观测量」**，需要上游改报文形态才有解。
（对抗审计复核确认这条解释成立，并实测到「把排除腿换成复用整个
`isChannelVerificationRejection(body,400)`」同样零牙 —— 那是因为 HTML 裸文本报文里
也可能同时出现两句，属**既有的复合报文**，非本次引入。）

⚠️ 另记一条过程教训：变异**编译失败**会让验证假绿 —— M4 初版注入的正则漏了 `u` 标志，
`tsc` 报 TS1530，但 vitest 仍用旧模块跑 ⇒ 「全绿」的其实是**没被注入的基线**。
本轮所有变异均已加**编译校验**后才判读（`pnpm build` 有 `error TS` 即作废该变异）。

⚠️ **两条审计补出来的零牙，及「零牙不等于有洞」的判别法**：M10（删掉安全审核腿）
与 M11（删掉 `11140` 那条腿）在补守卫**之前**都是全绿 —— 原因是**能用现有夹具区分
两档的报文不存在**：既有夹具要么被更早的腿认领、要么被 B 族早退排除。⇒ 补法是
**构造「只有这一条腿能认领」的报文**：
- M10 ⇒ `code` 不是 11140、`msg` 不含 `request illegal`、只有安全审核措辞；
- M11 ⇒ `code` 是 11140、`msg` 中性、无任何安全审核措辞。
⚠️ **M9 仍零牙，如实登记**：`msg` 窗口从 `{0,200}` 放宽到无界，其差异只存在于
`isChannelVerificationRejection` **内部**（是否认领），而外部观测量要经过
`isContentRejection` 的早退排除才体现 ⇒ 两档结论恒相同 ⇒ 无差异可观测。
⇒ 不补伪用例。

⚠️ **一条可推广的判别法**（本轮两轮审计各踩一次）：给判据加守卫时，
**「用现有夹具跑得红」不等于「有牙」** —— 必须问「**这条变异会让哪个观测量变化**」，
并构造**只有该判据能认领**的报文；否则新加的用例很可能与被审计的判据**正交**。

##### ⚠️ 两处**如实登记但不修**的边界（对抗审计指出，均为**既有问题**）

1. **单账号 + 不注册 `accountPool` + HTTP 400 ⇒ 本档不生效**：`stream()` 的 400 早退
   分支在无池时直接抛 `INVALID_REQUEST`（原始 detail 透传），不换号、不给本档文案。
   实测 master 的 `conversation id missing` 同形态**同样**如此 ⇒ **不是本次引入**。
   有池时（本插件的正常形态）走换号循环、本档生效。修它要改 400 早退分支的**整体口径**，
   超出本 PR 范围。
2. **「逐请求判定」排除不了「同账号 + 同一 Conv 头值重复用」的状态粘性**：
   实测每轮 `200→400→200` 里三枚头都是**新值**，从未复用过同一个值 ⇒ 该形态**未测**。
   本仓每次 `send()` 都 `crypto.randomUUID()`（逐请求换新值）⇒ 现状恒不触发。
   ⚠️ **但本档「不写冷却」的结论依赖这个前提**：若有人改成会话级复用同一个 Conv 头值，
   前提消失，且症状（每轮 400、换号无益）**与账号封禁同形**。届时须重新评估并补
   「同值连发 N 次」的 e2e。本轮不补：它是上游行为的未知面，现状恒不触发。

### ✅ 可向上游升级的**具体凭据**（IKM7SG 第二次取证，2026-10-16 19:23）

⚠️ 本仓库纪律是「若用户再看到这句：**先取失败报文的 `requestId`**，它是唯一定位手段」。
下面就是把那条纪律**执行到底**的产物 —— **四个新鲜 `requestId`**，可直接交付上游：
模型 `deepseek-v4.1-flash`，账号为「要求三头」的那个（`WB_REF` 见下表口径）：

| 头形态 | HTTP | `code`/`msg` | `requestId` |
|---|---|---|---|
| 带三头（基线） | 200 | — | （无） |
| **无三头** | **400** | 11128 `conversation id missing` | `e9ddbadc-8a2a-45b1-9ee5-25374490f57a` |
| **仅** `X-Conversation-ID` | **400** | 同上 | `48a02add-a007-4b8c-828b-3adba1e6d202` |
| **仅** `X-Conversation-Request-ID` | **400** | 同上 | `20c1e310-4bbc-4a09-a211-5d8592e0f379` |
| **仅** `X-Conversation-Message-ID` | **400** | 同上 | `c0942bd4-55db-4378-957b-712e0de8675a` |

同一时刻另两个账号（`D87606B1` / `D3238B4E`）**五种形态（含三枚全删）全部 200**，无 `requestId`。

⚠️ **这批凭据的第二个用途：排除「时点快照 / 短时灰度」**。同一账号的同一现象已**跨约 7 小时**
稳定复现（均为**不带**三头的同一形态）：

| 时刻 | 观测 |
|---|---|
| 12:26–12:31 | ❌ 8/8 全 400 |
| 12:45 | ❌ 400 |
| 13:32–13:33 | ❌ **删任一枚** Conv 头即 400 |
| **19:23** | ❌ **400**（上表那四个新鲜 `requestId`） |

⇒ **不是单次观测、也不是短时灰度** ⇒ 「可能只是上游抖动」这一解释**已被排除**。
⚠️ 但「**为什么只有该账号**」仍**未定论**（上面那条 n=1 线索不足以定因果）——
「稳定复现」与「成因已知」是**两件事**，别把前者读成后者。

⚠️ 凭据来源与归属：上述表格与时刻表来自 **IKM7SG**（原作者在 PR #105 的
第二次取证评论），本仓库**未独立复跑**这四发（无该账号凭据）。

**上游对三枚头的用法是「回显」**：三轮连发，回包 `"id"` 的前缀 **3/3 命中**
所发值；填 `abc-123` 时上游直接回 `"id":"abc-123"`。⚠️ 但 IKM7SG 实测到**在那个
账号上「回显」与「准入判据」并存** ⇒ 「只当种子、不作判据」这句**对多数账号成立、
对那个账号不成立**。

**那为什么三头仍在代码里**（理由已按 IKM7SG 更新，不再只是「形态一致」）：
① **对「要求三头」的账号是硬需求**（三枚齐全才 200）；② 对多数账号无害；
③ 贴近官方客户端形态；④ 三条出站路径统一。
⚠️ ⇒ **删任何一枚都是错的** —— 那批 14/14 消融数据**不能**用来论证「可以删」，
它只在**不要求三头**的账号上取得。（本实现三条出站路径都发三枚非空头，即满足判据。）

✅ **可复核凭据**：`tests/e2e/buddy-conversation-headers.e2e.spec.ts`
（`pnpm test:e2e:buddy-conv`，双闸门 + 每例 `max_tokens=8`，被拒不耗额度）。
⚠️ 该文件已按 IKM7SG 改为**逐账号**跑、并**按归因分类**：
`account-gated`（该账号要求三头 ⇒ 跳过，**不是**上游行为变更）、
`no-verdict`（额度耗尽 / 用错模型 ⇒ 跳过并明确说「本轮无判据」）、
`other` ⇒ 才红。**原先只跑一个账号 + 裸断言 `status == 200`**，会把额度问题与
「该账号要求三头」都读成「三头是准入必需」（即证实了那条已被推翻的旧结论）。

**若用户再看到这句**：触发条件**已定位到字段级**（见上），**先取失败报文的
`requestId`**（本插件出口已带上它），并**优先核对「那个账号」**；
⚠️ **不要按「内容」方向排查**（实测内容无关）。

**为什么这仍然支持「不加进 `isContentRejection`」**：

⚠️ 原先的理由（「四族**全部**是请求级」）是**未经证实的推理**，已撤回 —— 代码里
判不出来（`isContentRejection` 只看 body），也没有逐账号对照支撑；而仓库里有
**反向证据**：11140 的逐账号实测是「同一份请求体 → 7 个账号 2 通 / 4 拦 / 1 限流」
⇒ **腾讯风控本身可以是账号级的**，不能默认 11128 族也是。

✅ **可验证的理由**（有代码与用例支撑）：实测的 HTTP 400 形态在适配器里走
「非法请求」早退，**根本进不到换号 / 冷却分支**；冷却只在**流内**通道
（HTTP 200 + 无 `choices` 的错误帧）生效。⇒ 对 400 而言，认成账号级纯属空转。

⚠️⚠️ **但上面这条理由的前提已被 2026-10-16 的后续改动删除**（见本节末尾
「PR #105：新增按账号换号档」）：现在 400 形态**会**进入换号循环，只是走的是
**新档**（不写冷却），而不是 `isContentRejection`。⇒ 引用这段时**只能**用它论证
「不要把 11128 加进 `isContentRejection`」，**不能**再用它论证「400 进不到换号分支」。

#### 回归用例现状

⚠️⚠️ **下面这条「400 走不到该判据」的前提已于 2026-10-16 作废**（见本节
「上面这条理由的前提已被删除」那段）：现在 400 **会**进换号循环，只是走**新档**。
本段其余内容（流内那条通道的守卫位置、反向验证方式）**仍然有效** —— 它讲的是
`isContentRejection` 自己的覆盖面，与新增的渠道校验档是两件事。

⚠️ **实测的 HTTP 400 形态根本走不到那个判据**（400 在适配器里是「非法请求」早退）——
所以这层保护真正生效的地方是**流内**那条通道（HTTP 200 + 无 `choices` 的错误帧，
`buddy-adapter.ts` 里 `data.choices === undefined && isContentRejection(payload)`
那一处 —— ⚠️ 刻意不写行号，本文件历史上记的行号已多次因改动漂移）。
`buddy-adapter.spec.ts` 的「内容级风控（11128）」段**流内那条才会红**（已做反向
验证：把 `11128` 加进 `isContentRejection` → 该用例红；400 那条不红，别拿它当判据）。

⚠️ 该段的 `unapprovedChannelBody` 报文用的是 `Illegal API invocation from an
unapproved channel`（**渠道级**那条），不是内容指纹那条 —— 引用它论证「内容级」
是错位的。三头的守卫在 `buddy-adapter.spec.ts` 与 `buddy-growth.spec.ts` 的
`X-Conversation-*` 用例组 —— ⚠️ 那组只断言**我们确实发出三头**（守卫只防误删），
**锁不住「上游在该账号上要求三头」那条外部事实**（它由 IKM7SG 的 e2e 固定）。

### ⚠️⚠️ PR #105：新增「按账号换号档」（其登记的证据冲突**已由 IKM7SG 结清**）

代码新增 `isChannelVerificationRejection`（**独立于** `isContentRejection`）：
命中 `conversation id missing` 时进换号循环、且**刻意不写 30 分钟冷却**。
**它不看 `code`**（同码多族子原因），故不违反本节「不要把 11128 加进
`isContentRejection`」。

⚠️ **2026-10-17 修正**：上一句「它不看 `code`」**只对 `conversation id missing`
那一腿成立，对后来新增的 `request illegal` 那腿已不成立** —— 该腿**确实看 `code`
且要求精确等于 11128**（因为那句措辞与 11140 共用，不看 `code` 就无法区分）。
这**不违反**上面那条禁令：禁令是「不要把 11128 **整体**加进 `isContentRejection`」，
而新腿认的是「`code` 精确 11128 **且** `msg` 是 `request illegal`」这一个子形态，
其余四族 11128 子原因仍然进不了换号（单测逐条锁死）。

✅ **原先登记的「证据等级冲突」现已结清**（本档曾写「两份记录互相否证、至少一份是
错的、都没有第三方独立复核」—— 那三句**均已作废**）：
**IKM7SG 证明两份都对，差的是「账号」这个控制变量** —— 90 次复测用的账号不要求三头
（故零复现），而 `66E05E7C` 要求（故本档稳定复现）。复核已用**本仓库自己的 e2e**
完成。完整对照表见本节上文的 IKM7SG 表。

⚠️ 因此「**不写冷却**」这个决定的依据也**从「据未复核记录」升级为「已复核」**：
IKM7SG 实测 `带三头 200 → 无头 400 → 再带 200` ⇒ 判据是**逐请求**的
（非封禁、非粘性）⇒ 该账号**并非坏账号**，写 30 分钟账号冷却会误封一个
「请求形态凑齐就能用」的账号。

⚠️⚠️ **【反向要求】那批 14/14 消融数据不能用来论证「可以删三头」** ——
它只在**不要求三头**的账号上取得。本实现三条出站路径**都发三枚非空头**，
对「要求三头」的账号正好满足判据。

⚠️ 另外两处已被 2026-10-16 审计修正的实现问题（**若看到旧行为请对照**）：
- **单账号池**曾误报 `QUOTA_EXCEEDED`「所有账号均受限」（首发被拒未计入
  `sawChannelVerification`）⇒ 已改为用入口值初始化；
- **流内 200 + 内嵌 `conversation id missing` 帧**曾不换号、并退化成本节
  上文那种「静默/`EMPTY_RESPONSE`」⇒ 已并列接入同一判据（仍不重发）。

### 端到端实发验证（已通过）

`scripts/verify-workbuddy-gitstatus-e2e.ts`（`npx tsx`）走**插件真实链路**：
ZCode 形状的 OpenAI 请求体 → `toGenerateOptions`（含改写）→ **真实** `BuddyAdapter`
（真实 fetch / 凭据 / 产品配置）→ 腾讯线上。对照组是同一份请求体**绕过**网关转换。

```text
provider = workbuddy   model = deepseek-v4.1-flash
① 修复前（绕过网关转换，system 原样）
   ❌ INVALID_REQUEST  Illegal API invocation from an unapproved channel
② 修复后（走网关转换）
   ✅ 正文："1+1 等于 2。"  [block-start,reasoning-delta,text-delta,usage,block-end,finish]
```

`--cn` 换 CodeBuddy 中国版同样通过（`① ❌ / ② ✅`）。

只读探针 `scripts/probe-workbuddy-gitstatus-fingerprint.mjs`（绕开适配器、逐账号发
同一条对照请求；`--cn` 切 CodeBuddy）可随时重跑复核上表。

### ⚠️⚠️ 第二条指纹：**Claude Code 的身份句**，且它的锚点与上一条**相反**（Issue IKLS2L，2026-10-14）

**用户报障**（Gitee issue IKLS2L）：Claude Desktop 的「Code」页（内置 Claude Code
v2.1.295）经 cc-switch（Anthropic→Responses 转换）→ 本机网关 `127.0.0.1:8326/v1/responses`
调 `hub/hub-deepseek-v4.1-flash`（聚合，12 条候选）时稳定失败：

```text
HTTP 400 / code 11128 / Illegal API invocation from an unapproved channel
```

实测窗口 **277 次尝试 / 94 次失败**（约 34%），日志累计 187 次该错误。可用性不坏
（hub 会自动切到 officeace 等），但**每次白撞一次往返**，且 `markRecentFailure` 会把
workbuddy（链上第 2 位、`x0.00` 免费的渠道）标成「近期失败过」而被并发请求避开。

**成因（Claude Code 侧，不在本仓库内）**：`mrt()` 的 `[model-check]` 探测路径调用
`Qno({...})` 时**漏传 `skipSystemPromptPrefix`** ⇒ 每次都注入身份句；主请求路径
`aF()` 传了，故多数请求正常。这正是「同一会话里成功与失败交替」的来源。

**本仓库的修法**：`CONTENT_FINGERPRINTS` 补一行（表就是为此设计的）。`find` **刻意不带
尾句点**，一条同时覆盖 `yl` 与 `sf` 两个常量；`af` 实测放行故**不登记**。

| 探针（`max_tokens=16`；⚠️ **必须 `stream:true`**） | workbuddy | buddy |
|---|---|---|
| 中性 system | ✅ 200 | ✅ 200 |
| `You are Claude Code, Anthropic's official CLI for Claude` | ❌ 400/11128 | ❌ 400/11128 |
| 同句 + 尾句点 / + `, running within the Claude Agent SDK.` | ❌ 400/11128 | ❌ 400/11128 |
| `You are a Claude agent, built on Anthropic's Claude Agent SDK.` | ✅ 200 | ✅ 200 |
| 少一个字母（`…for Claud`） | ✅ 200 | ✅ 200 |
| **多**一个字母（`…for ClaudeX`） | ❌ 400/11128 | ❌ 400/11128 |
| 拆成前半句 / 后半句**单独**发 | ✅ 200 | ✅ 200 |
| **assistant 正文**放同一句 | ❌ 400/11128 | ❌ 400/11128 |
| 同一句放 `user` | ✅ 200 | ✅ 200 |
| **改写后**（`…Anthropic's CLI for Claude.`） | ✅ 200 | ✅ 200 |

⚠️⚠️ **该指纹的锚点是「行首」的，与上一条「位置无关」相反** —— 这是本轮实测推翻
issue 描述的一格（issue 按 IKJNA1 同构写成了「子串精确匹配、位置无关」）：

| 形态 | 结果 |
|---|---|
| 裸串（在文本**绝对开头**） | ❌ 400/11128 |
| **前接空格 / 前换行 / 前接任意前言 / 双换行包裹** | ✅ **200 放行** |
| 后接句点 / 破折号 / 中文句号 / 一长段正文 | ❌ 400/11128 |

⇒ 语义是「**前导字符一个都不容忍、后缀完全自由**」。**这条对将来加新指纹的人是硬提醒**：
拿「夹在句中放行」当判据会得到**假阴性**（真因是锚点，不是这句不再触发），据此删掉一条
仍然必需的登记就重新打开这个 bug。故 `tencent-fingerprint.ts` 里 **`find` 刻意不做行首锚定**
—— 改写宁可略宽（漏改 = 整轮 400；多改 = 语义等价的措辞变化）。

⚠️ **非流式请求会被更早地拒掉**：两端点对不带 `stream:true` 的请求都回
`HTTP 400 / code 11101 Non-stream chat request is currently not supported` —— 探针若不带它，
会把「不支持非流式」**误读成风控拦截**（本轮探针第一版就踩了，八个格子全报 400）。

**可复核凭据**：`tests/e2e/buddy-fingerprint-roles.e2e.spec.ts` 的
「Claude Code 身份句（IKLS2L 实测依据）」一节 —— 含**贪心探针**（行首/非行首**两侧都测**）
与「`af` 刻意不登记」的反向断言。⚠️ 与 ZCode 那条不同，这句字面量**可以**写在源码里：
改写已覆盖 `system` 与 `assistant` 正文两处，排查这个风控 bug 的会话不会再拦死自己。

回归用例在 `tests/unit/openai-gateway-tencent-fingerprint.spec.ts`（17 条）。
⚠️ 已做**反向验证**：正则去掉 `i` → 大小写用例红；`instructions` 那处改回原样 →
Responses 端用例红。

### ⚠️⚠️ 第三条指纹：Claude Code 的**反馈句**（Issue IKLYCT，2026-10-18）

```text
To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues
```

**用户报障**（Gitee issue IKLYCT）：Claude Desktop → CC Switch（`openai_responses`）→
本机网关 `127.0.0.1:8326/v1/responses`（`model=hub/hub-deepseek-v4.1-flash`）→ 聚合器 →
`buddy/deepseek-v4.1-flash`，稳定 `HTTP 400 / code 11128 / Illegal API invocation from an
unapproved channel`。可用性不坏（切下一候选即成功），但每次白撞约 1 秒，且连续三次触发
调用方 10 分钟熔断。本机统计：**10-14 单日因此白撞 647 次**。

**为什么这一条比身份句更严重**：身份句只有 cc-switch 的 `mrt()` 探测路径漏传
`skipSystemPromptPrefix` 时才注入（实测约 34% 的窗口）；**本句属于 Claude Code system
prompt 的固定段落** —— 客户端把默认 system 整份发过来就**必然**带上
⇒ **漏登记 = 必然命中**，不是概率性泄漏。

**取证方法**：从 Claude Desktop Code 会话的 `prompt_snapshot.systemPrompt`（**19,056 字符**、
112 行）原样发往腾讯端点 ⇒ 400/11128；再**逐行**单独送检 ⇒ **唯一触发行**就是上面那句
（第 28–112 行整段 200）。

**本仓库的修法**：`CONTENT_FINGERPRINTS` 补第三行。

#### 本机 2026-10-18 逐格实测（两端点**各测一遍**）

| 探针（`max_tokens=16`；必须 `stream:true`） | workbuddy | buddy |
|---|---|---|
| 中性 system（基线） | ✅ 200 | ✅ 200 |
| **整句裸串** | ❌ 400/11128 | ❌ 400/11128 |
| 前接 `Note: ` | ❌ 400/11128 | ❌ 400/11128 |
| 前接行首 `  - ` | ❌ 400/11128 | ❌ 400/11128 |
| 后接换行 + 无关文本 | ❌ 400/11128 | — |
| **全大写** | ❌ 400/11128 | ❌ 400/11128 |
| **第二条 system**（非 `messages[0]`） | ❌ 400/11128 | ❌ 400/11128 |
| **assistant 正文** | ❌ 400/11128 | ❌ 400/11128 |
| 同一句放 `user` | ✅ 200 | ✅ 200 |
| 只放 `reasoning_content` | ✅ 200 | ✅ 200 |
| 只放 tool 结果 | ✅ 200 | ✅ 200 |
| **砍掉前半**（`users should report the issue at …`） | ✅ 200 | ✅ 200 |
| **砍掉后半**（`To give feedback, users should report the issue`） | ✅ 200 | ✅ 200 |
| 只留 URL | ✅ 200 | ✅ 200 |
| 换 org/repo · 换域名 · 改一个词 | ✅ 200 | ✅ 200 |
| **改写后**（`… at the project issue tracker`） | ✅ 200 | ✅ 200 |

⇒ **锚点是「位置无关」**（与身份句的**行首锚定相反**，与 ZCode 那条同型）；
⇒ **逐字符 + 大小写不敏感**（三条同型）；
⇒ **`find` 必须写整句 99 字符** —— 砍掉任一半都放行 ⇒ 子串本身不触发，
**写短了等于空跑**，而空跑的症状是「登记了却仍每轮 400」，极难归因。

⚠️ **`find` 的长度不可跨条照抄**：身份句那条实测「少一个字母即放行」⇒ 恰好写全；
本条实测「砍掉半句仍放行」⇒ 必须写全。**只能逐条实测**。
⚠️ 本条的 `find`（99 字符）已经**贴着**上游屏蔽名单的粒度，不要再按 ZCode 那条的思路
去「缩短 find 覆盖更多变体」——实测换域名即放行。

**两处刻意不做的事**（与文件头既有约束一致）：
① **不加行首锚定**（实测位置无关，加了反而漏改）；
② **不加进 `isContentRejection`** —— 它是内容级拦截，换句即通，
认成「账号被策略拦」会白锁账号池 30 分钟。

#### ⚠️⚠️ 本轮实测出的**新纪律**：`11128` 有两个同码子原因，探针必须先筛账号

| `msg` | 含义 | 归类 |
|---|---|---|
| `Illegal API invocation from an unapproved channel` | **内容级**（本文件要治的） | 内容 |
| `request illegal` | **渠道校验**（按账号要求三头，IKM7SG） | **换号，不冷却** |

两者 `code` **都是** `11128`。⚠️ 取证第一版探针**轮换账号**，于是把账户特定的通道门控
读成了内容指纹的匹配语义，实测出「**51 字符前缀被拦、69 字符超集反而放行**」这种
**非单调**的假结论 —— 照它定 `find` 长度就会登记一条覆盖不全的规则（症状：仍有变体被拦）。

⇒ **纪律：① 先筛出基线放行的账号，之后固定用它；② 逐格打印 `msg`；③ 两类 11128 分开计数。**
本机 workbuddy 8 个凭据条目里 **2 个**（5 个 `WORKBUDDY_ACCOUNT_*`）基线就报
`request illegal`；buddy 8 个条目里 **2 个** 401、**2 个**限流 6004 ⇒ 只有 1 个可用
—— 比例不低，轮换账号几乎必然踩到。

**可复核凭据**：`tests/e2e/buddy-fingerprint-roles.e2e.spec.ts` 的
「Claude Code 反馈句（IKLYCT 实测依据）」一节 —— **两端点各跑一遍**（结清 issue 的
「workbuddy 未验证」项）、锚点两侧都测、「砍掉半句放行」那六格（定 `find` 长度）、
以及 `user` / `reasoning_content` / tool 结果三格放行（不该改写的反向断言）。
⚠️ 本句字面量**可以**写进源码与用例：改写已覆盖 `system` 与 `assistant` 正文两处，
排查这个 bug 的会话不会再拦死自己。

回归用例：`tests/unit/openai-gateway-tencent-fingerprint.spec.ts` 的
「IKLYCT：Claude Code 反馈句」一节（纯函数 9 条 + 网关 Chat 2 条 + Responses 3 条）
与 `tests/unit/buddy-adapter.spec.ts` 的直连一条（`system` 与 assistant 两处，
且断言 `user` **逐字保留**）。

#### 变异验证结论（2026-10-18，审计实测 19 条）

13 条确认有牙，覆盖 4 个接入点（`options.system` / `serializeMessages` 两处 /
网关 Chat 两处 / 网关 Responses 三处）与 provider 判断。**一处如实登记为无牙**：
把 `escapeRegExp` 对**本条**短路（只跳过第三条）⇒ **313 条全绿**，真因是本条 `find`
**零正则元字符** ⇒ 变异态与修复态**逐字节等价**，不是守卫失效。
（完整短路 `escapeRegExp` 仍红 16 条，红因全在前两条。）

⚠️⚠️ **一条变异方法论（审计踩到，已记）**：「把 `find` 置空」看起来是最干净的
「漏登记」模拟，实际**最脏** —— `new RegExp('', 'gi')` 匹配**每个空位**，
会连带把**前两条**也炸掉（43 条红），红因与被测变异无关。**必须**换成
「永不可能命中的假指纹」才是干净证据（此时 10 条红）。与本仓已有的教训同型：
「用例变红」**不自动等于**「红因是被测变异」。

⚠️⚠️ **`find` 的长度只有实发能验**：单测能证明「砍掉半句时我们**不**改写」（真事实），
但证明不了「砍掉半句后上游**仍会拦**」—— 单测对「上游屏蔽名单的粒度」无能为力。
改本条 `find` 时**必须**跑 `DSH_BUDDY_FINGERPRINT_E2E=1` + `_CONFIRM=yes`。

#### ⚠️⚠️ 对抗审计打穿的一条**阻断级**缺陷：改写修好了，分类判据却在背后拆台

本条**每轮必带** ⇒ 一定命中 400/11128 ⇒ 若那一刻分类判据把它当成「账号级拦截」，
用户看到的就是「整池账号被锁 30 分钟、还被建议去停用账号」，而不是「一次白撞」。
本轮实测：**这条路径当时真的通着**（2026-10-18，对抗审计打穿，已修）。

| 腿（`isContentRejection`） | 内容级 11128 报文 | 命中？ |
|---|---|---|
| 腿① `"code":11140` | code 是 11128 | ❌ |
| 腿② `/request illegal/i` | msg 是 `Illegal API invocation…` | ❌ |
| 早退（渠道校验排除） | 它要 `request illegal` | ❌ |
| ⚠️ **腿③ `/安全审核\|safety review/i`** | **扫整份报文（含 `displayMsg`/`displayTips`）** | ✅ **命中** |

⇒ 上游只要把这份 11128 的 `displayMsg` 漂成 `The content did not pass the safety
review.`（**11128 各子原因共用/漂移 `displayMsg` 本仓已有先例**，见 `buddy-adapter.ts`
的既有注释），就落进「账号级拦截」档 ⇒ **烧完整池 + 每账号锁 30 分钟**。

**修法**：`isContentRejection` 里再加**一条同型早退** `isContentBlockedIllegalBody`
（只认结构化 `code` 精确 `11128` + `msg` 是内容级那一句，**绝不扫** `displayMsg`/
`displayTips`/正文），与既有的渠道校验排除**各管一个子原因**。真实 11140 **仍被三条腿
全部命中**，未被削弱。

⚠️⚠️ **一条可推广的教训**：**「不该把 X 加进判据」≠「判据不会因为 X 的报文而误判」** ——
一条扫**全文案**的腿会**绕过**你精心写的排除逻辑。`tencent-fingerprint.ts` 的文件头
那句「维持现状是正确的」因此是**错的**，已改成事故史。

⚠️ **原守卫是空断言**：既有用例 `★ 11128 报文里出现「安全审核 / safety review」字样`
只对**夹具字面量**做 `toContain`/`toMatch`，**根本没调用判据** ⇒ `displayMsg` 一漂照样绿。
新守卫改为**真发请求**（HTTP 400 与流内 SSE 两条通道 × 三种漂移形态）。

⚠️ **反向护栏的一个实测坑（变异验证）**：只写「真实 11140 必须写冷却」**锁不住**
「排除写得太宽」—— 把 `isContentBlockedIllegalBody` 改成「只按 code 11128」时，
11140 的 code 是 11140（根本不匹配）⇒ 排除不触发 ⇒ 腿① 照常命中 ⇒ **本条仍绿**。
真正的分界是「**同码 11128 但 msg 是第三种子原因**（`first message is not system prompt`）
的报文不得被顺手放跑」—— 补上那一格后该变异**确实变红**。

⚠️⚠️ **随之而来的一处行为变更（已登记）**：既有 IKM7SG 复验组里有一格
「`request illegal` 出现在 displayTips 而 msg 是内容级子原因」**原先断言「有冷却」**
—— 它锁的恰恰是缺陷本身。已改为断言**零冷却**，并补一格「msg 是其它 11128 子原因」
来保住该组原本要验的「渠道校验判据不得靠 `displayTips` 认领」。

### ⚠️⚠️ 第四条指纹：DSH 宿主自己的 harness 身份句（2026-10-20 晚报障）

```text
You are an AI agent powered by DeepSeek Harness
```

**这条与前三条有本质区别**：前三条都来自**外部客户端**（ZCode / Claude Code）注入的
模板句，DSH 直连不含它们；本句是 `dsh-system-prompt` 的 `harness:identity` 段
（`includeHarnessIdentity` 默认开启）⇒ **每个 DSH 直连会话 system 的首句** ⇒
上游一旦登记，**所有 DSH 直连 buddy/workbuddy 请求首轮即拒**，换号/换模型/重登全无效。

**报障现场（2026-10-20 晚，同一用户、同一账号、同一份 system）**：

- 23:10 的 turn 完整跑完（多步工具调用，正常 completed）；
- 23:25 起同会话同账号每轮 `400/11128`，换模型（`deepseek-v4.1-flash` /
  `glm-5.3-flash`）无效；
- 23:45 重新登录换**新账号**，**干净会话**（无任何历史）首轮仍被拒
  （`llmMs=0`，无任何输出）⇒ 内容级、非账号级、非会话状态；
- ⏇ **结论：腾讯网关在 23:15~23:25 之间新登记了这条指纹**（15 分钟窗口内生效）。

**实测判据（2026-10-21 本机逐格探针，`max_tokens=16`，被拒不耗额度）**：

| 探针 | 结果 |
|---|---|
| 裸句（带/不带尾句点） | ❌ 400/11128 |
| 前接空格 / 换行 / 任意前言 | ✅ 200 ⇒ **行首锚定**（与 Claude 身份句同型） |
| 后接正文 | ❌ 400/11128 |
| 全小写 / 全大写 | ❌ 400/11128 |
| 砍掉任一词（`You are an` / `DeepSeek Harness` / `Harness` / `powered by …`） | ✅ 200 ⇒ **逐字符，find 整句** |
| 换成 `AcmeCorp` / `ExampleCorp` Harness | ✅ 200 ⇒ **专指 DeepSeek Harness** |
| 同句放 `user` / `reasoning_content` | ✅ 200 |
| 同句放 assistant 正文 / 非首位 system | ❌ 400/11128 |
| 改写（`running inside` 等任一等义变体） | ✅ 200 |

**排障陷阱（本轮亲自踩的）**：经本插件 OpenAI 网关发探针**是通的**（自造中性 system
不含本句），极易把方向带偏成「网关好的、直连坏的 ⇒ 以为是直连路径的问题」。判别法：
拿失败会话的**真实 system 原文**做探针即可立刻复现（本机 15,305 字符原文稳定复现）。

**workbuddy 国际站当时未同步**（2026-10-21 实测裸句 200）：按「两端点同表」先例仍
登记（改写对未拦端点是无害等义措辞），e2e 对 workbuddy 的上游断言因此只保留实现断言。

**可复核凭据**：`tests/e2e/buddy-fingerprint-roles.e2e.spec.ts` 的
「DSH harness 身份句（2026-10-20 报障实测依据）」一节（17 格：核心依据、锚点两侧、
逐字符五格、assistant 正文、非首位 system、user/reasoning_content 放行、
真实 system 原文端到端、workbuddy 实现断言）。回归用例在
`tests/unit/openai-gateway-tencent-fingerprint.spec.ts` 的
「DSH harness 身份句」一节（纯函数 7 条 + 四条互不干扰 1 条）。

#### ⚠️⚠️ 同轮顺手修复的三个 e2e 存量缺陷（不修则新指纹无法复核）

干净 master 上该 e2e 文件 **38/38 全红**（本机凭据形态下 `firstCredential` 一行都找不到）
——「每条指纹必须有可复核凭据」在折叠 YAML 机器上根本跑不起来：

1. **`firstCredential` 单行正则匹配不到多行折叠的 YAML 单引号标量**：凭据里
   `scope` 字段是多行折叠形态 ⇒ 逐行正则恒 miss ⇒ 全部用例在取凭据处抛错。
   按 `buddy-conversation-headers.e2e.spec.ts` 的 `credentialFor` 同款扫描闭合单引号。
2. **`loadTriggerLine` 返回整行**：文档首次命中行是 YAML 常量展示行（带 `"` 双引号），
   注进 JSON 后 `JSON.parse` 直接炸（角色矩阵的 reasoning_content / tool_calls 两格）。
   改为只提取纯字面量子串。
3. **workbuddy 站用 buddy 中国站 token ⇒ 恒 401**；且探针 `headersOf` **不发三枚
   Conv 头** ⇒ 在「要求三头」账号（IKM7SG 族）上得到的是 `msg=request illegal`
   的渠道校验拒绝，污染全部断言。改为按站点选凭据 ref 前缀 + 补齐三枚 Conv 头
   （对齐生产适配器出站形态）。修后 **55/55 全绿**。

## 模型计费倍率与同名模型（必须写进 `name`，不是 `description`）

**倍率必须拼进 `name`。** 这是被用户报障纠正过的结论：

- composer 的**模型切换菜单只渲染 `name`** —— `dsh-client-ui-model-selection`
  的 ModelSelect 里只有 `title: model.name` 与 `children: model.name`，
  **完全不读 `description`**。
- `description` 只在 **`/model` 弹窗**里用（`optionsOf` 的 `detail`，渲染成
  `提供方 · description`）。

**真实缺陷**（用户报障）：「消耗倍率没有显示在切换模型列表的后面」——
早期版本把倍率放进 `description`（因为误以为那是"唯一的展示位"），
结果在切换菜单里根本不可见。

安全性：`name` **纯属展示**，DSH 的选择与持久化只用 `id`
（`selectionOf` 返回 `model: model.id`），故附加价格不会污染会话历史。

展示形态：`Deepseek-V4.1-Flash · x0.03`；有促销时 `GLM-5.3 · x0.79→x0.50`
（箭头比「（促销 …）」短，适合窄菜单）。

三套远端的倍率字段**形态互不相同**，绝不可共用解析：

| provider | 字段 | 真实形态 | 归一化 |
|---|---|---|---|
| `buddy` / `workbuddy` | `data.models[].credits` | **字符串 `"x0.29"`**（x 在前），早期带 `"x0.03 credits"` 后缀，可为空串 | `normalizeCreditsRate` |
| `buddy` / `workbuddy` | `modelPromotions[].discount.discountedCredits` | **字符串 `"0.50x"`（x 在后！）**，已结束占位为 `"0x"` | `normalizeDiscountedRate` |
| `lobsterai` | `data[].costMultiplier` | **裸数字 `0.05`** | `displayNameFor` 里拼 `x${n}` |
| `qoder` | 目录 `chat[].price_factor` | **裸数字**，`0` = **免费**，另有 `original_price_factor` + `promotion` | `qoderDisplayName` |
| `trae` | `display_contact_config.consumption_rate.data.rate`（**该字段本身是 JSON 字符串，须二次 `JSON.parse`**） | **裸数字** `0.08`；`0` = 免费；`enable:false` = 无倍率 | `traeDisplayName`（活动期拼 `x原价→x折后价`） |
| `codearts` | 无 | 两个目录端点都不含计费字段 | — |

要点与坑：

- ⚠️ **`credits` 与 `discountedCredits` 的 x 位置相反**（`"x0.29"` vs `"0.50x"`）。
  早期版本只认前缀写法，导致**促销价全部静默丢失** —— 单测直接暴露了它。
  两个 `normalize*` 函数各自接受两种写法（对上游格式变更更鲁棒）
- ⚠️ **两个端点下发的模型 id 集合不同，必须取并集**（实测 2026-09-21，
  账号 `3C656A62`）：
  ```
  scoped     → hy4-preview, hy4-preview-x   （30 个模型）
  /v3/config → hy4-preview-f                （22 个模型）
  促销 modelIds → ["hy4-preview-f"]         ← 只挂在 v3/config 独有的那个 id 上
  ```
  而 `hy4-preview-f`（新用户限时免费变体）**被 craft/ask/plan 三个 agent 引用**
  —— 服务端明确说它可选。早期只返回 scoped，于是该促销永远对不上，
  界面显示 `x0.29` 而 IDE 显示免费（用户报障「hy4 preview 现在 ide 是免费
  我们还是 0.29」）。**不同账号下发的变体 id 也不同**（另一账号两端都是
  `hy4-preview`，所以它没暴露这个问题）—— 排查时**必须多账号对照**
- ⚠️ **`reconcileWithFallback` 是白名单式重建，会丢弃不在兜底表的 id** ——
  上面那个 `hy4-preview-f` 正因此被丢掉。判据用 **`agentReferenced`**
  （服务端自己的「可选」信号，由 `parseModelsFromConfig` 收集**全部** agent
  的引用），**不要猜 id 后缀**：`-f` / `-x` / `-sg` / `-ioa` 含义各异，
  猜错会放进不可用的模型。追加时放在**末尾**，不打乱兜底表顺序。
  ⚠️ `auto` 与 **`default`** 是同类内部别名（都不被 agent 引用），
  由 `isAutoSelectAlias` 过滤；但**不要前缀匹配** —— 会误伤国际版
  被 craft 引用的 `default-model` / `fast-model` 等抽象别名
- ⚠️ **促销只由 `/v3/config` 下发，企业模型端点（scoped）没有**（实测 2026-09-21：
  scoped 的 25948 字符响应里 `discount` / `promo` / `0.50x` 出现 **0 次**）。
  而 scoped 被**优先返回** → 早期实现直接 `return scoped`，于是**促销永远不显示**
  （用户报障「codebuddy 的倍率显示也是没折扣的，GLM-5.2 是 0.5，现在显示 0.79」）。
  现补一次 `/v3/config` 并**同时取它的模型与促销表**（失败不影响列表）
- ⚠️ **必须按 `schedule` 本地推算此刻是否生效，不能只看 `enabled`**：
  实测 `glm-5.2` 有两条**互补**活动（夜间 `23:00–7:50` 带 `0.50x`、
  白天 `7:50–23:00` 只带角标）。不看时段就按 priority 恒定取夜间那条 →
  **白天也显示折扣价**，用户按折扣价预期却被按原价计费。
  时段字段是 `schedule.daily[].{start,end}`（`HH:MM`，**小时可能不补零**如 `7:50`）
  + `schedule.timezone`（用 `Intl` 换算，别硬编码 +8）+ `validFrom`/`validUntil`。
  时区不可解析时**不误杀**（宁可多显示一次折扣）
- ⚠️ **`factor: 0` 是「免费」，不是「活动已结束」**：实测 `hy4-preview` 的夜间活动
  是 `{discountedCredits: "0x", displayMode: "replace", factor: 0}` —— 它**真的免费**。
  早期把 `0x` 一律当哨兵丢弃，于是「夜间免费」永远不显示
  （用户报障「hy4 preview 夜间 0，现在显示 0.29」）。**「已结束」由有效期表达**。
  防御：**无任何时间窗口**的 `factor: 0` 仍按占位跳过（免费额度必然限时）
- ⚠️ `modelPromotions` 是**数组**（不是对象），且用 `modelIds[]` **按模型关联**
  （不是全局折扣）；同模型命中多个活动时取 `priority` 最高者
- ⚠️ **`/v3/config` 有 UA 校验**：UA 不对返回 `{"code":12403,"msg":"check ua,
  get coding copilot version error"}`（**HTTP 200**，极易误判为「该端点没有促销」）。
  必须带产品的 `userAgent`（CodeBuddy 实测 `CodeBuddyIDE/1.106.1`）
- ⚠️ **LobsterAI 的 `description` 可能已自带倍率文案**（实测 DeepSeek-V4.1-Flash
  写着「分时计价：当前空闲时段 x0.05…」）。前置倍率前必须 `includes` 判重，
  否则出现「x0.05 · …x0.05…」重复
- `reconcileWithFallback` 是**白名单式重建**：新增的远端字段不在此显式搬运就会
  被静默丢弃（`creditsRate` / `discountedCreditsRate` 已加）

### ⚠️ TRAE 思考档位：多通道合并**不得**用空档位条目覆盖有档位的条目（Issue IKI7WT/IKILR7）

**真实缺陷**（用户报障「模型缺少思考强度」）：`parseTraeBatchModelList` 用
**无条件「后面的覆盖前面的」**合并同名模型，其注释假设「后面的条目带着更完整的
配置」——**该假设与真实数据正好相反**。上游把**空档位**的 `solo_work_lite` /
`solo_design_remote` 等条目排在**最后**，于是信息更全的条目被覆盖成了更空的条目。
UI 表现为 `TraeAdapter.reasoningFor` 返回 `undefined` → 不声明 `reasoning` →
「当前模型未提供推理等级」。

实测（2026-09-26，`scripts/probe-trae-reasoning-order.ts`）：**13 个模型**丢掉档位
（`deepseek-v4.1-flash` / `glm-5.2` / `glm-5.3` / `kimi-k3` / `qwen3.8-max` /
`DeepSeek-V4-Flash-Official` / `DeepSeek-V4-Pro-Official` …）。修复后目录里
**有档位的模型从 5 个恢复到 15 个**。

同一模型在不同通道的档位**不一致**（这正是「后覆盖前」出事的原因）：

| 通道 | `deepseek-v4.1-flash` 的 `reasoning_effort_config` | 顺序 |
|---|---|---|
| `chat_v3` | `{default:high, options:[light,high,extra_high], support_thinking:true}` | 早 |
| `solo_agent` | 同上，且 `max_tokens` 32000 / `context_window.max` 1000000 / `max_mode:true` | 中 |
| `solo_agent_remote` / `solo_agent_lite` | 同上 | 中 |
| `solo_work_remote` / **`solo_work_lite`** | `{options:[], support_thinking:false}` | **最后** |

修正后的合并规则（三条，见 `parseTraeBatchModelList` 注释）：

1. **空档位不得覆盖有档位**（已选有档位 + 候选无档位 → 保留已选）；
2. **两侧都有档位时按 `channelPriority` 取更靠前者**（默认 `TRAE_CHANNELS`，
   「顺序即优先级」，故通常落到 `solo_agent`）；
3. **其余情形（含两侧都无档位）保持既有「后覆盖前」**，避免与本缺陷无关的
   通道迁移 —— 这条保证 `glm-5.1` / `qwen-3.5` 等无档位模型行为**逐字节不变**。

四个必须记住的点：

- ⚠️ **档位必须与 `function` 同源，整条择优**：发档位的通道必须正是声明支持它的
  通道。**不要**只把 `reasoningConfig` 单独搬运到另一条条目上（例如保留
  `solo_work_lite` 的 `function` 却声明档位）——那是在一个自称
  `support_thinking:false` 的通道上宣布档位。
- ⚠️ **判据必须与 `TraeAdapter.reasoningFor` 完全一致**：配置存在 **且**
  `support_thinking !== false` **且** `options` 非空（`declaresReasoningOptions`）。
  只判「配置存在」会选中 `{support_thinking:false, options:['high']}` 这种
  适配器里仍返回 `undefined` 的条目，**等于没修**。两处改动必须同步。
- ⚠️ **可调用性不受影响**：候选始终只来自**列出了该模型的通道**，故无论选中哪条
  都不会路由到「未列出该模型」的通道（那才会回流内 4001）。已实测：
  `deepseek-v4.1-flash` 通道从 `solo_work_lite` 迁到 `solo_agent` 后，
  不带档位与 `reasoning_effort=extra_high` **各发一次均 HTTP 200、正常返回**。
- ⚠️ **`DeepSeek-V4-Flash` / `DeepSeek-V4-Pro`（无后缀）修好后仍然无档位** ——
  它们**所有**带档位的通道条目都被 `is_invisible_to_user=true` 剔除（官方隐藏），
  只剩 `solo_coder` / `chat` 的可见条目。这是官方可见性，**不是**合并缺陷；
  带 `-Official` 后缀的那两个已正常恢复。

排查/回归：

- `scripts/probe-trae-reasoning-order.ts` —— 按上游顺序回放「后覆盖前」，列出被吃掉的
  模型与修复后的目录（只读，零额度）
- `scripts/probe-trae-merge-replay.ts <模型 id…>` —— 打印指定模型在**全部通道**的条目
  （含三条硬过滤的 DROP 原因、`max_tokens` / `context_window` / `max_mode` 差异）
  与最终合并结果
- `tests/unit/trae.spec.ts` 的「档位不被空档位条目覆盖」段（7 条）—— ⚠️ 已做**反向
  验证**：临时退回「无条件后覆盖前」时其中 4 条会失败，故不是同义反复
- `tests/e2e/trae-reasoning-probe.e2e.spec.ts`（`pnpm test:e2e:trae-reasoning`，**消耗
  额度**，双闸门 `DSH_TRAE_REASONING_E2E=1` + `…_CONFIRM=yes`）—— 真实目录档位断言
  + `resolveModel` 真声明出 `efforts` + 新通道真实收发两次

### ⚠️ TRAE 账号展示名：`ScreenName` 是自动生成的默认名，必须用脱敏手机号

**真实缺陷**（用户报障 2026-09-27）：「用 trae provider 登录后用户名字显示无法区分
各个用户，有其他名字昵称或者手机尾号之类的信息可以区分吗？」

根因：`GetUserInfo` 的 **`ScreenName` 是字节 passport 按 uid 自动生成的默认名**
（`用户` + uid 片段）。实测四个账号：

形态完全雷同，一屏列出来认不出谁是谁 —— 与 Raccoon 的 `RaccoonAva`
（`buildRaccoonNickname`）是**同一类问题**。

实测可用字段（2026-09-27，四个真实账号逐个调 `GetUserInfo` 核对）：

| 字段 | 值 | 可区分性 |
|---|---|---|
| `ScreenName` | `用户<uid片段>` 等 | ❌ 自动生成、形态雷同 |
| **`NonPlainTextMobile`** | `130******00` | ✅ **末两位互异** |
| `NonPlainTextEmail` | 四个**全为空**（`LastLoginType` 均为 `sms`） | ⚠️ 仅邮箱登录有值 |
| `Description` | 全为空 | ❌ |
| `AvatarUrl` | 每人独立 hash | ⚠️ 可区分但不可读 |
| `RegisterTime` | `2026-03-28` / `2026-09-27` / `2026-08-19` ×2 | ⚠️ 有两个撞车 |
| `UserID` | `4051111222220009` 等 | ⚠️ 可区分但过长不可读 |

要点：

- ⚠️ **字段名是 `NonPlainTextMobile`**（不是 `Mobile` / `Phone`），且是**脱敏**形态
  （中间 6 位打码）。展示就照原样用，**不要试图还原或截取后四位** ——
  `130******00` 整体已足够短且可辨认
- ⚠️ **`NonPlainTextEmail` 实测为空**，别因为「有手机号就以为邮箱也有」而写死依赖；
  它只是邮箱登录账号的兜底
- 取值顺序（`traeDisplayNickname`）：**手机号 → 脱敏邮箱 → `ScreenName` → 账号 id**
- ⚠️ **手机号必须写回凭据**（不只写账号条目）：账号条目会随 Jet Hub 的账号操作
  整体重写，凭据里存一份才能在续期后稳定拿到。`applyTraeRefresh` 用 `...previous`
  展开，故自动保留 `phone` / `email` —— 改它时别把这两个字段丢掉
- ⚠️ **回调的 `userInfo` 参数不含手机号 / 邮箱**（实测只有 `UserID` / `ScreenName` /
  `TenantID`），**只在 `GetUserInfo` 响应里** —— 故 `exchangeTraeCallback` 必须真发
  那次 `GetUserInfo` 才能拿到，不能只依赖回调
- ⚠️ **老账号必须主动回填**：光改代码只影响新登录的账号。`TraeAuth.repairAccountNicknames`
  （`src/index.ts` 启动时调用，仿 `RaccoonAuth.repairAccountNicknames`）在启动时补一次
- ⚠️ **拿不到真实标识时不得改写昵称**：`Jet Hub` 允许用户手动改昵称
  （`account.update`），若退回去用凭据里的 `ScreenName` 重算，会把用户改过的名字
  覆盖成服务端默认名 —— 属无谓且有害的写入。故 `fetchUserContact` 在两者皆空时
  返回 `undefined`，调用方**直接 `continue`**
- ⚠️ **只在昵称确实变化时落盘**：`updateAccount` 是整体 replace，每次启动都写会
  平白触发一次文档写

排查 / 验证：

- `scripts/probe-trae-userinfo.mjs` —— 打印每个 TRAE 账号 `GetUserInfo` 的
  **完整响应**（只读，零模型额度）
- `scripts/verify-trae-nickname.mjs` —— 用真实账号跑一遍 `repairAccountNicknames`
  并打印修复前后昵称（⚠️ **会写真实账号池昵称**，这正是修复效果本身）
- `tests/unit/trae.spec.ts` 的「TRAE 账号展示名」段（6 条，含四个真实手机号
  互不相同的断言）、`tests/unit/trae-auth.spec.ts` 的「repairAccountNicknames
  老账号回填」段（7 条，含「无标识不改写昵称」「幂等不重复请求」）

### ⚠️ LobsterAI 账号展示名：服务端把**手机号本身**当昵称下发（露 4 位）

**用户要求**（2026-09-27）：「lobsterai 的用户名字显示的手机号尾号漏出 4 位，
现在也改为只漏出 2 位」。

⚠️ **关键事实：`130****1100` 是服务端下发的 `user.nickname` 原值，不是本插件
截取的**。`buildLobsteraiCredential` 只做 `nickname: payload.nickname ?? ''` 照抄。
实测四个真实账号的登录响应即为此形态：

故修法是**归一化掩码**（`maskLobsteraiPhoneTail`，`src/lobsterai.ts`）而非改
某个 `slice(-4)` —— 那会是个找不到的假想目标。

要点：

- ⚠️ **两种输入都收敛到同一形态，因此幂等**：完整 11 位（`13011111100`，
  `profile-summary` 返回的就是完整号码）与已脱敏的露 4 位形态，输出都是
  `130******00`。幂等意味着老账号无需重新登录、重复运行不产生新写入
- ⚠️ **判据只认「像手机号」的形态**：`/^1\d{10}$/`（完整）或
  `/^\d{3}\*+\d+$/`（已脱敏）。**绝不能泛化到任意字符串** —— 那会把真实昵称
  （`用户<uid片段>` / `<自定义昵称>` / 邮箱形态）一起打掉。单测有专门一条守这个
- ⚠️ **星号个数按原串总长推算**（`总长 - 3 - 2`），长度保持不变；
  故对非 11 位的号码也自洽
- ⚠️ **末 2 位必须仍可区分**：四个真实账号掩码后为
  掩码把区分度也抹掉就失去意义了（单测断言 `Set.size === 4`）
- ⚠️ **老账号必须主动回填**：`LobsteraiAuth.repairAccountNicknames`
  （`src/index.ts` 启动时调用，与 `RaccoonAuth` / `TraeAuth` 同名方法同一模式）
- ⚠️ **纯本地、零网络**：掩码只依赖凭据里的昵称（与 TRAE 那条需要发
  `GetUserInfo` 不同）。单测断言 `fetcher` 未被调用
- ⚠️ **只在昵称确实变化时落盘**：`updateAccount` 是整体 replace

排查 / 验证：

- `scripts/probe-lobsterai-profile.mjs` —— 打印 `profile-summary` 的完整响应
  （**发现 `nickname` 在这里是完整号码 `13011111100`**，与登录响应的脱敏形态不同）
- `scripts/verify-lobsterai-nickname.mjs` —— 用真实账号跑一遍
  `repairAccountNicknames` 并打印修复前后昵称（⚠️ **会写真实账号池昵称**）
- `tests/unit/lobsterai.spec.ts` 的「手机号掩码（只露末 2 位）」段（8 条，
  含「非手机号形态原样返回」「末两位仍可区分」）、
  `tests/unit/lobsterai-auth.spec.ts` 的「老账号展示名回填」段（7 条，
  含「纯本地不发请求」「幂等」）

### ⚠️ 改昵称类修复必须**重启宿主**才生效，且旧进程会覆盖你的写入

**这是本轮实操踩到的坑**（2026-09-27）：用脚本把 `state.json` 的昵称改对之后，
**几分钟内又变回了旧值**（TRAE 的 `用户<uid片段>` 复活）。

根因：**当时有一个 1 小时前启动的 DSH 宿主进程仍在运行**（PID 9616，监听 3080）。
它加载的是**旧代码**（没有 `repairAccountNicknames`），内存里的账号池是旧昵称；
而 `AccountPool` 的写入是**整体 replace**（限流标记、续期回写等都会触发落盘），
于是它的下一次写盘就把脚本的修改**原样盖回去**。

两条必须记住的推论：

- ⚠️ **`repairAccountNicknames` 是「启动时」逻辑**：改完代码必须**重启 DSH**
  才会执行。不重启的话，无论脚本改多少次，旧进程都会覆盖
- ⚠️ **手工改 `state.json` 前先确认没有宿主在跑**（`Get-NetTCPConnection -LocalPort 3080`
  或看 node 进程），否则改动会被静默回滚 —— 症状是「明明改对了，过一会儿又变回去」，
  极易误判为「修复没生效 / 代码写错了」
- ⚠️ 验证修复是否真的生效，**唯一可靠方式是重启宿主**，然后看启动日志里有没有
  `[jet-hub] 已修正 N 个 … 账号的显示名`。脚本验证只能证明「逻辑正确」，
  不能证明「线上已生效」

### TRAE 倍率（藏在 `display_contact_config` 里，且该字段是** JSON 字符串**）

⚠️ **最大的坑**：`display_contact_config` 的值是**一个字符串**，里面才是 JSON。
直接读 `entry.display_contact_config.consumption_rate` 永远得到 `undefined` ——
必须 `JSON.parse` 两次（外层响应一次、这个字段再一次）。解析函数
`readConsumptionRate` / `readActivityDiscount`（`src/trae.ts`）。

```json
{ "consumption_rate": { "enable": true, "data": { "rate": 0.08 } },
  "activity_discount": { "enable": true, "subKey": "limited_discount",
    "data": { "current": { "discount_type": "limited",
                          "before_consumption_rate": 0.8,
                          "consumption_rate": 0.08, "discount": 10 },
              "limited": { "end_at": 1790265540 } } } }
```

- 倍率是 **裸数字**（`0.08`），既不是 buddy 的字符串 `"x0.29"`，也不是
  LobsterAI 的 `costMultiplier`
- ⚠️ **`rate: 0` 是「免费」，是合法值** —— 与 Qoder 的 `price_factor: 0` 同类，
  用 `> 0` 过滤会恰好漏掉免费模型；展示为「免费」而非 `x0`
- ⚠️ **`consumption_rate.enable === false` 视为「无倍率」**，不是「倍率 0」

#### ⚠️ `activity_discount.enable === true` **不等于**当前有折扣

**实测陷阱**（2026-09-20，与 Qoder 的 `promotion` 同类：**标志为真不等于当前生效**）：
`off_peak` 型条目形如

```json
{ "type": "none", "before_consumption_rate": 0.13,
  "after_consumption_rate": 0.13, "discount": 100 }
```

`enable` 是 `true`，但 `discount_type` 为 **`"none"`**、`before === after`
（`discount: 100` 是百分比制下的「无折扣」）。**照显会得到 `x0.13→x0.13`**，
让用户以为有活动。三条判据缺一不可（`readActivityDiscount`）：

1. `enable !== false`；
2. `data.current.discount_type` 存在且**不是 `"none"`**；
3. `before_consumption_rate` 为正，且**严格大于** `consumption_rate`。

另外 ⚠️ **`end_at`（Unix 秒）仅 `limited` 型带**（`subsidy` / `off_peak` 没有）。
**已过期必须整个不展示折扣** —— 否则用户按折扣价预期、实际被按原价计费。

展示形态由 `traeDisplayName`（`src/trae-adapter.ts`）拼装：
常态 `Qwen3.8-Flash · x0.08`；活动期 `Seed-2.1-Pro · x0.8→x0.08`。
`resolveModel` 的 `name` **不带**倍率（与 Qoder 一致）。兜底表路径**不显示倍率**
（兜底表无该字段，不猜价格）。

实测参考值（2026-09-20，`solo_agent` 可见集）：`glm-5.3-flash` x0.06、
`qwen3.8-flash` x0.08、`deepseek-v4.1-flash` x0.13、`glm-5.2` x0.78、
`qwen3.8-max` x1.5、`kimi-k3` x1.83；同一模型在三个通道的 `rate` **一致**。

### Qoder 倍率（`price_factor`，与腾讯系语义不同）

模型目录来自本机加密缓存 `~/.qoder/.models/{uid}/catalog-v6`
（`chat` 场景 17 个模型），倍率字段是 **`price_factor`**：

- ⚠️ **不是 `cost_multiplier`** —— 那是 LobsterAI 的字段名，两者易混
- ⚠️ **`price_factor: 0` 是「免费」**（实测 `qfmodel` / Qwen3.8-Flash），
  **0 是合法值**，不能用 `> 0` 过滤，否则恰好漏掉用户最关心的免费模型。
  展示为「免费」而非 `x0`
- 另有 `original_price_factor`（如 `qfmodel` 的 0.1 = 免费前的原价）
- ⚠️ **`price_factor` 是「采集时刻的生效价」，不是恒定原价** ——
  错峰窗口内它是折后价、窗口外是原价。故展示时**必须结合窗口本地推算**，
  不能直接照搬（照搬的后果：窗口一切换，界面价格就与真实计费不符）
- ⚠️ **错峰判据用 `windowStart`/`windowEnd` 本地推算（`promotionActiveNow`），
  *不*采信 `promotion.active`** —— 后者是目录下发那一刻的快照，
  客户端长时间不重启就会与真实时段脱节。窗口字段缺失时才回退到 `active`。
  生效价 = `beforePromotionPriceFactor × discountFactor`（实测三条全部吻合），
  窗口外则用原价。窗口统一 22:00–08:00（UTC+8），支持跨零点
- ⚠️ **折扣形态三个 provider 必须统一为「原价→折后价」**（TRAE `x0.4→x0.2`、
  buddy `x0.79→x0.50`、Qoder `x0.5→x0.2`）。Qoder 早期是「只有折后价 +
  中文角标」（`x0.2 错峰 4 折`），两个问题：① 看不出原价与折扣幅度；
  ② 角标与数字**冗余**（0.2/0.5 本就是 4 折）。用户要求对齐 TRAE。
  `promotion.badgeZh` 因此**不再参与展示**（字段保留，目录原始数据仍可对照）
- ⚠️ **本表的倍率数值必须逐条对照 catalog，不要凭印象填**：
  早期版本多处是手工估值，与真实值大范围不符（**14 个模型有偏差**：
  `smodel` 写 3.2 实际 8、`qmodel_38max` 写 0.5 实际 0.2、`auto` 写 1 实际 0.5 …），
  用户报障「qwen3.8-max 是 0.5 打折到 0.2，界面显示的是 0.5」。
  ⚠️ 而当时的单测**只断言了 id 列表**，所以价格漂移长期未被发现 ——
  改这张表时必须同步更新数值断言（`qoder-product.spec.ts`）
- `resolveModel` 的 `name` **不带**倍率后缀（价格只属于选择列表语境）

**解密该缓存**（`decryptModelCatalog`，`src/qoder-wasm.ts`）：

⚠️ **第二个参数是 `uid`，不是 `machine_id`**。两个官方调用点容易读反：
目录缓存的 `readSharedCacheSnapshot(A)` 传 uid，BYOK 的
`model_cache_decrypt(i, n)` 传 machineId。传错会得到
`AES-GCM decrypt failed: aead::Error` —— 看着像密文损坏，实为参数错。
调试脚本：`scripts/probe-qoder-catalog-debug.mjs`（两个候选都试）、
`scripts/probe-qoder-pricing.mjs`（打印 17 个模型的计费字段全貌）

### 同名模型必须消歧（`buildDisplayNames`）

远端会给**不同 id 配同一个 `name`**，而 DSH 按 `name` 展示 → 列表里出现
两个完全一样的条目。实测三组：

| 组 | 远端 name | 区别 |
|---|---|---|
| `deepseek-v4.1-flash` / `-sg` | 都是 `Deepseek-V4.1-Flash` | 新加坡区，`credits` x0.00 vs x0.03 |
| `hy3` / `hy3-x` | 都是 `Hy3` | — |
| `hy4-preview-f` / `hy4-preview` | 都是 `Hy4 preview` | — |

**用户报障**：「workbuddy 国际版同时显示 2 个 ds v4.1 flash，IDE 只有一个」。
IDE 按 name 归并，我们按 id 列出。二者是**不同区域的独立计费实体**，
不能靠丢弃其一来回避。

- 算法：对每组同名 id 求**公共前缀**，剩余段作为变体标记追加
  （`Deepseek-V4.1-Flash · x0.03 SG`、`Hy3 · x0.05 X`），空剩余段者不加标记
- ⚠️ **不要硬编码 `-sg`**：撞车组随服务端上新变化，本次实测三组里只有一组是
  `-sg`；也不要「取 id 最后一段」（会把 `gpt-5.6-sol` 的 `sol` 当变体）。
  公共前缀只在**确实撞车时**才切分
- ⚠️ **倍率与变体标记都只在 `name` 里出现一次**：初版两处都写，
  端到端实测出现重复文案与「计费 x0.00 · 」这种孤立分隔符
- LobsterAI **实测无同名**（28 个模型，0 组重名），故它不做消歧；
  兜底表路径也**不显示倍率**（兜底表无该字段，不猜价格）

排查脚本（全部只读 GET，零模型额度）：`scripts/probe-pricing.mjs`（各 provider
计费字段）、`scripts/probe-promotions.mjs`（`credits` 全量与促销结构）、
`scripts/probe-lobsterai-cost.mjs`（LobsterAI 倍率归属）、
`scripts/probe-lobsterai-dupes.mjs`（LobsterAI 同名检查）、
`scripts/probe-codearts-benefit.mjs`（CodeArts benefit 集合与判定）、
`scripts/verify-description.mjs`（端到端打印**切换菜单实际渲染的 name**）

## ⚠️ CodeArts benefit（免费额度）模型：集合必须动态判定，不能硬编码模型名

CodeArts 的 `snap-access/api/v2/chat/completions` 上有**两套模型注册**：benefit
（免费额度）与非 benefit。**benefit 模型的 chat 请求必须带 `maas_type: benefit`
请求头，且该头必须参与 SDK-HMAC-SHA256 签名**，否则后端返回
`InferHub.002002009.404 The model is not registered`（HTTP 200 + SSE 内嵌错误）。
反过来，给**非** benefit 模型带该头会被拒（`unsupported model`）。

**真实缺陷**（用户报障，2026-09-23）：用 `deepseek-v4.1-flash` 发消息后失败
（`Insufficient Balance` / `QUOTA`）。根因是 `src/llm-adapter.ts` 早期把 benefit
集合**硬编码**为 `new Set(['glm-5.3-flash'])` —— `deepseek-v4.1-flash` 是
2026-09 新增的 benefit 模型，因此从不带该头，后端按非 benefit 通道处理它。

实证矩阵（2026-09-23，对齐 deveco-code-rust `fb1b4a2`）：

| 模型 id | 来源 | 不带 maas_type | 带 maas_type |
|---|---|---|---|
| `glm-5.3-flash` | gateway/config | 404 未注册 | ✓ 成功 |
| `deepseek-v4.1-flash` | gateway/config | 404 未注册 | ✓ 成功 |
| `deepseek-v4-flash-0731` | gateway/config | 404 未注册 | ✓ 成功 |
| `deepseek-v4-pro-0813` | gateway/config | 404 未注册 | ✓ 成功 |
| `deepseek-v4-flash`（无后缀） | 静态表 / 归一化结果 | ✓ 成功 | ✗ unsupported |
| `deepseek-v4-pro`（无后缀） | 静态表 / 归一化结果 | ✓ 成功 | ✗ unsupported |
| `GLM-5.2` | model/builtin | ✓ 成功 | ✗ unsupported |

结论：**`gateway/config` 返回的模型即 benefit 集合**，无需靠模型名硬编码。

要点：

- 判定 `isCodeArtsBenefitModel`（`src/models.ts`）：远端拉取并缓存的集合
  （`~/.cache/deveco/codearts_benefit_models.json`）∪ 静态兜底
  `CODEARTS_BENEFIT_FALLBACK`（`glm-5.3-flash` / `deepseek-v4.1-flash`）。
  远端集合优先，后端新增 benefit 模型**无需改代码**
- ⚠️ **只记录「归一化未改写」的 id**：gateway 下发的是
  `deepseek-v4-flash-0731`，而 `normalizeModelId` 会把它改写成
  `deepseek-v4-flash` —— 两者在后端是**不同模型、benefit 属性相反**，
  记录改写后的 id 会让无后缀模型多带 `maas_type` 而失败
- ⚠️ **判定必须在 `stream()` 的重试循环外算一次**（要读缓存文件，不宜每轮 IO）
- ⚠️ **缓存读写必须用顶层 `import { … } from 'node:fs'`，不能用 `require`** ——
  本包是 ESM（`package.json` 的 `"type": "module"`），`require` 未定义、抛
  ReferenceError 后被 `catch` 静默吞掉，表现为「写不进也读不回」（`loadModelsCache`
  的模型列表磁盘缓存曾因此长期失效）
- `deepseek-v4.1-flash` 的上下文窗口按 IDE 下发的 inferhub-provider 配置声明为
  **1000000**（与无后缀 v4-flash/pro 的 1048576 不同）
- 回归用例：`tests/unit/models.spec.ts`（集合判定 / 落盘不含改写 id / 缓存往返）、
  `tests/unit/llm-adapter.spec.ts`（v4.1 带 `maas_type` 且参与签名、无后缀
  v4-flash 不带）、`tests/e2e/v4-models.e2e.spec.ts`（真实收发，需闸门）

## ⚠️⚠️ 更正：腾讯风控**也拦 `assistant` 正文**，且直连路径必须一起改（2026-10-12）

上面「腾讯系内容级风控」一节的「只动 system，`user` / `assistant` / `tool` 一概不碰」**已被实测推翻**，
以本节为准。补测矩阵（真实登录态直打 `copilot.tencent.com`，触发串取磁盘原文逐字）：

| 触发串位置 | 结果 |
|---|---|
| `system`（含非首位） | ❌ 400/11128（已知） |
| `user` | ✅ 200 |
| `tool` 结果 | ✅ 200 |
| **`assistant` 正文 `content`** | ❌ **400/11128 ← 新格** |
| `assistant` 的 `reasoning_content` | ✅ 200 |
| `tool_calls[].function.arguments` | ✅ 200 |
| 与文档同字节数的良性长文本 | ✅ 200 ⇒ **体量不是原因** |

**为什么初版漏了这格**：那条 assistant 探针把触发句改写成了转述形态（`I see … here.`），
而服务端是**逐字符**匹配 —— 那个形态本身不含触发串，**等于空跑**，却得出了「assistant 放行」的结论。

**已落地的修法**（四处产出点，缺一即复发）：

- `src/openai-gateway/messages.ts` 的 `assistant` 分支（原来只有 `system`）；
- `src/openai-gateway/responses.ts` 的 `assistant` 分支（与 Chat 同判据）；
- `src/buddy-adapter.ts` 的 `serializeMessages`：**`assistant` 正文 + `system`**（DSH **直连**方向，
  原先**完全没有任何改写**）；
- `src/buddy-adapter.ts` 的 `stream()` 里 `options.system` 那一条 —— 它**绕过** `serializeMessages`，
  是最容易漏的第四个点。

`user` / `tool` 结果 / `reasoning_content` / `arguments` **刻意不改**：实测不拦，
改它们换不来放行，却会篡改用户原话与要回读给模型看的证据，并白吃腾讯侧前缀缓存。
用例把「该改的改了」与「不该改的一字没动」**两侧**都锁住
（`tests/unit/buddy-adapter.spec.ts` 的「直连路径的腾讯风控指纹改写」段）。

**真实报障机制（自指污染）**：排查这个风控 bug 的会话会先 `read` 记录该指纹的文档
（`providers-buddy.md` 自己就逐字写着那句 —— tool 结果，不拦），模型随后把它**逐字复述进
自己的正文**（拦）。那句一旦进了历史就每轮原样重放 ⇒ 会话从此报废，且
**换任何腾讯系模型都一样** —— 用户当时报的 `step-5-preview` 与 `space-bunny` 同一个错，
正是「症状跟会话走、不跟模型走」。

**取证 / 验收脚本**（⚠️ 均在 `scripts/` 下，而**该目录被 `.gitignore` 忽略**，
属本机一次性工具、**不入库**，故以下名字在仓库里查不到，别当假指路）：
`probe-buddy-role-matrix.mjs`（角色矩阵）、`probe-buddy-assistant-bisect.mjs`
（二分定位到单行 + 体量对照，写在另一份 checkout `dsh-codearts/scripts/`）、
`verify-buddy-fingerprint-fix.mts`（同一份被拦历史：裸 fetch ❌11128 /
打过补丁的真实 `BuddyAdapter` ✅）。要长期保留就得把它们挪进版本控制内的目录。

ℹ️ 验收时还暴露过一个「`space-bunny` 报 `tool calls and tool results do not match`」的
现象 —— **已在下一小节解决**（真因不是工具配对，而是 wire 首条角色）。

### 已修：上面那个「尚未修」的独立问题，真因**不是**工具配对（2026-10-12 同日）

末节登记的 `space-bunny` 报 `tool calls and tool results do not match`，取证后结论是
**报错文案在骗人**：

1. 先逐格核对真实适配器产出的 wire（`dump-buddy-tool-count.mts`）：**无孤儿、无重复 id、
   每条 assistant 的调用都被紧随的结果完整覆盖** ⇒ 配对根本没坏；
2. 再做单变量实验（`probe-spacebunny-firstmsg.mjs`）：同一份请求体，**只把开头的
   system 去掉、让首条变成「带 tool_calls 的 assistant」**——
   `space-bunny` → 400/**11148**（`displayMsg.zh`=「工具记录不完整，请新建任务」），
   `step-5-preview` → **200**。补回一条 system，两个模型都 200。

⇒ 真正的判据是 **wire 的首条角色**，与工具配对无关。上游那句文案是误导性的。
（另注：`11101 Unmarshal chat params failed` 是另一类 —— 那是 `arguments` 传了**对象**
而非 JSON 字符串，Go 侧反序列化失败。）

**修法**：`buddy-adapter.ts` 的 `stream()` 在序列化后检查「首条是不是 assistant」，
是则补一条最小中性 system（`LEADING_SYSTEM_PLACEHOLDER`）。该文本刻意不含任何
风控指纹字面量 —— 否则这条兜底自己会把会话送进 11128。

生产里确实可触发：会话历史被压缩/截断到把开头的 system 与首条 user 一起削掉时，
剩下的历史就以 assistant 开头。与既有的「WorkBuddy 网关强制 `messages[0]` 是 system」
是同族约束，只是 CodeBuddy 侧只在「首条是带 tool_calls 的 assistant」时发作。

⚠️ 有一条**既有**用例 `sends assistant reasoning_content and null content for tool-only
turns` 原先按**下标**断言 `messages[0]` 是 assistant —— 那正是把旧形状当契约的地方，
已改为按角色取。教训：wire 的位置断言在上游补位时会整体平移，别用下标锁角色。

用例：`tests/unit/buddy-adapter.spec.ts` 的「wire 首条不得是 assistant」段（3 条：
补位且不破坏配对、正常历史不多塞、`options.system` 已就位时不重复补）。
验收：同一份被拦历史走真实适配器，`step-5-preview` 与 `space-bunny` **都 ✅**。

### ⚠️ 2026-10-12 子代理审计抓到两个**真缺陷**（均已修）

对上面两个提交跑了一轮 subagent 驱动的审计 + 对抗性审计（两个独立视角并行：
功能面 / 测试面，各自做了变异验证）。抓到的东西按严重度：

**① 补位判据过窄（真缺陷，我第一版就写错了）**
判据写成 `role === 'assistant'`，只覆盖 assistant-first。**user-first / tool-first 照样原样发出** ——
而本仓库 `account-probe.ts` 的 `PROBE_SYSTEM` 注释里早有 2026-09-25 的双端点对照实测：
**WorkBuddy 网关强制 `messages[0]` 是 system，否则 400 + 11128**。
⇒ 真正的判据是 **`!== 'system'`**。与 `PROBE_SYSTEM` 那段「无条件给所有 provider
都带 system，判据不该依赖另一个产品碰巧不校验」的取舍一致。

**② `this.product.id` 零覆盖（测试盲区，实测存活变异）**
`serializeMessages(…, this.product.id)` 改成 `serializeMessages(…, 'buddy')`
（完全忽略产品配置）⇒ **163 条用例全绿**。原因：`buddy` 与 `workbuddy` **都在**
`TENCENT_PROVIDERS` 那张表里，「喂 WORKBUDDY 也能改写」那条用例**结构上无法区分**
这两个实现 —— 是同义反复。
修法：**反向**用例（喂非腾讯系产品，断言 wire 逐字节不变）。已验证它能抓住该变异。

⚠️ 两条的**共同教训**：「按文案/按当前观察写死判据」会漏掉相邻形态。真实判据往往是
「X 必须满足」，而不是「我实测到的那种坏法」—— 后者永远漏其余分支。

**③ 实测凭据从 `scripts/` 挪进 `tests/e2e/`（悬空引用）**
上面那张角色表与「首条角色」那条判据，原先只以**脚本**形式存在于被 gitignore 的
`scripts/`（另一份 checkout），注释指向它们 ⇒ 后人无法复核。现各入库一个带双闸门的
e2e 规格（`buddy-fingerprint-roles.e2e.spec.ts` / `buddy-first-message-role.e2e.spec.ts`）。
⚠️ 这两个文件**不可省**：单测只能锁「代码按那个范围做」，**锁不住那个范围本身对不对**。

**④ `buddy-growth.ts` 是第三条旁路（当前无害，已加路标）**
它有两处直发 `POST …/v2/chat/completions`，**不经 `BuddyAdapter`、故不过改写**。
当前安全（请求体写死「你好」/「1+1等于几」，无指纹也无 assistant 历史），
但那条安全性依赖「请求体写死」这个易碎前提 ⇒ 已在其注释里写明将来要接上。

**⑤ 未采纳**：一条 `toLowerCase()` 预检的性能优化建议（5.4×，属优化非正确性，
且实测非命中时 `String.replace` 返回**同一对象**、前缀缓存没被破坏）—— 留待需要时再做。

## ⚠️⚠️ `reasoning_effort` 就是 buddy 系 deepseek 的**思考开关** —— IKLMIY 已撤回（2026-10-15）

**结论先行**：buddy/workbuddy 的 `deepseek-*` 上，`reasoning_effort` **不是**可选的
「强度微调」，而是**思考的存在性开关**。任何「为了保住正文而不发它」的修法都等于
**关掉该渠道的思考**。**别再加第二遍**（IKLMIY 就是这么来的）。

### 时间线

| 日期 | 事件 |
|---|---|
| 2026-09 | 实测：裸请求 → `reasoning_content` 恒 0；仅 `reasoning_effort:high` → 返回思考；`thinking:{type:'enabled'}` **单独无效** |
| 2026-10-14 | `8bb1035`（IKLMIY）：实测「下发该字段 ⇒ 工具调用前的正文前言被吞」，判据 `suppressesProseWhenEffortSent()` ⇒ **workbuddy 一律不发该字段**，注释里写明代价「等于完全关闭思考，为保住正文自愿付出」 |
| 2026-10-14 | `46ed99d` 合并该分支 |
| 2026-10-15 | **用户报障「调用 workbuddy 的 ds v4.1 flash 没有思考了」**，并定取舍：**思考优先于前言**（「宁可使用有思考输出的」）⇒ `e261cd6` **纯 revert**（原提交保留在历史里，可对照重评） |

### 撤回后真机复测（2026-10-15）

> **复现配方**（探针脚本本身**不入库** —— `scripts/` 在 `.gitignore` 里，与
> `probe-workbuddy-gitstatus-fingerprint.mjs` 等同命；下面是自包含描述，照它重建即可）：
> `POST {product.endpoint}/v2/chat/completions`，头部按 `BuddyAdapter.send()`
> （`Authorization: Bearer <access_token>` / `X-Domain=www.workbuddy.ai` /
> `X-Product-Code` / `X-Agent-Purpose: conversation` / `X-IDE-*` / `X-Product` /
> `resolveUserAgent(product, model)`），凭据从 `~/.dsh/.credentials.yaml` 的
> `WORKBUDDY_ACCOUNT_*` 解析（YAML 折行要还原成一个空格再 `JSON.parse`）。
> body = `{model, messages, tools, stream:true, max_tokens:800, prompt_cache_key}` 再按格
> 叠加 `thinking` / `reasoning_effort`；tools 两份（`read_file` / `list_dir`），
> user 问「读 package.json 告诉我 name」。解析 SSE 只累加三个量：
> `delta.reasoning_content` / `delta.content` / `delta.tool_calls`，外加
> `usage.reasoning_tokens`。

真实凭据、`www.workbuddy.ai`、`deepseek-v4.1-flash`、**带 2 个 tools**；
同一请求体只切换「发不发 `reasoning_effort`」，每格 5 样本，两种 system 提示词对照：

| 请求形态 | 有思考 | 有正文 |
|---|---|---|
| 发 `reasoning_effort:high` + `thinking:{type:'enabled'}`（**撤回后 = 现状**） | 3/5（preamble）/ 1/5（terse） | 5/5 / 4/5 |
| 不发该字段 + `thinking:{type:'enabled'}`（**= IKLMIY 形态**） | **0/5 / 0/5** | 5/5 / 5/5 |
| 裸请求（两个字段都不发，2026-09 的「关思考」形态） | 0/5 / 0/5 | 5/5 / 3/5 |

判据取**服务端权威计数** `usage.reasoning_tokens`，不只数思考字符：

1. **病因确证**：不发该字段的两格，`reasoning_tokens` **10/10 全为 0** ⇒ 它确实是开关，
   与用户「没有思考了」逐字吻合。
2. **撤回有效**：发档位后思考恢复（`reasoning_tokens` 0/6/45/46/47 等）。
   ⚠️ 但**不是每次都思考**（3/5、1/5）—— 该模型对「读个 package.json」这种小任务
   常常不起思考；「开档位」是**允许**思考，不是**强制**思考。
3. ⚠️⚠️ **IKLMIY 的「吞正文」在本探针形态下未能复现**（发档位时正文 5/5、4/5）。
   **不得据此宣布原结论被证伪**：原报告用的是**真实失败会话**（23 步、宿主全套 tools）
   的固定 messages，这里是 2 个工具的新会话 —— 正文被吞很可能是**形态相关**
   （历史长度 / tools 数量）。唯一与「两者互斥」相符的一格是 terse A#4：它是发档位那组里
   **唯一真思考的一次**（220 字），其正文恰好为 0（n=1，远远不够定论）。

### ⚠️ 一条方法论教训（差点又一次误判）

探针**第一版只跑了一个 system 提示词**，里面写着「调用工具之前，用一句中文说明你打算做什么」
—— 那句**把「有正文」这个可观测量钉死了**（5/5、3/3），于是差一点得出「原结论是错的」这种
反向误判。**判据被提示词支配 = 变量不独立**（本仓库在 accio 的 `sgcookie` 那轮踩过同款坑），
故脚本里**必须保留两套 system 对照**（`--prompt=all`）。

### 随 revert 一并删除、但**仍然成立**的旁证：OfficeAce

原提交在 `src/officeace-adapter.ts` 留了 28 行**纯注释**（行为无变化），记的是同一问题的
另一渠道复测，实测量不变，故登记在此，别丢：

- OfficeAce（华为 MaaS）也吞正文（不下发该字段 1/10 有正文），但 **workbuddy 的修法在此无效**
  —— 该渠道**关不掉**思考：不下发时服务端 `reasoning_tokens` **8/8 无一次为 0**（中位 172）。
- 它真正的可用性风险是同源的 `MAX_TOKENS_FLOOR`（小预算被思考烧光）。
- 错误码两套：OfficeAce `ModelArts.81001`，workbuddy `11150`。
