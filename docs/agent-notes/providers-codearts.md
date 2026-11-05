<!-- 新建（2026-10-21）：本仓库的主 provider 一直没有专属笔记，这条缺陷史与取证方式
     都是「改之前必须先读」的，故单独成文件。按需阅读，不进每轮注入。 -->

## CodeArts 的上下文窗口：**上游不下发**，且缺它会让用户的占用条整条消失

### ⚠️⚠️ 真实报障（2026-10-21）

用户原话：「codearts 对话后，DSH 下方本该显示上下文窗口占用比的地方没有显示」，
并补充「好像是 glm-5.3 文本对话有这个问题」。**不是**配置项问题，也**不是**
「我们没解析后端返回的字段」。

### 判据链（宿主侧，**不在本仓**，改之前先照抄这几行去核对版本）

`dsh-client-ui-conversation/lib/client.js`：

```js
function contextOccupancy(pressure) {
  const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens
  if (usedTokens === void 0 || pressure?.contextWindow === void 0) return null
  return { percent: Math.min(100, Math.round(usedTokens / pressure.contextWindow * 100)), ... }
}
// ContextMeter 里：
if (context === null) return null
```

⇒ **缺任一个输入 ⇒ 环 + 百分比 + 弹层整条不渲染**（不是显示 0%，是根本不出现）。

| 输入 | 来源 | 本家状态 |
|---|---|---|
| `usedTokens`（分子） | `dsh-token-meter` 读 `assistant/message.usage`，`pressureFrom = inputTokens + cacheReadTokens + cacheWriteTokens` | ✅ **一直是好的**（实测 glm-5.3 上报 `inputTokens:37482, cacheReadTokens:448`） |
| `contextWindow`（分母） | `dsh-agent-loop` 写 `request/context` 事件，值 = 适配器 `resolveModel()` 的 `context.contextWindow` | ❌ **本家唯一会出错的地方** |

⚠️ 顺带记：**`assistant/attempt` 的 `usage` 不可靠**（实测常常 `undefined`、
`stream: []`）—— 但 token-meter 有 `assistant/message.usage` 这条腿，故分子不受影响。
排查时**不要**看到 `assistant/attempt.usage === undefined` 就以为「usage 没上报」。

### 落盘铁证：同一会话内切模型，条就消失

`~/.dsh/sessions/<workspace>/session-<id>/session.v4.jsonl.zstd` 里逐行对照：

```
model/selection:  {"provider":"codearts","model":"deepseek-v4.1-flash"}
request/context:  {"provider":"codearts","model":"deepseek-v4.1-flash","contextWindow":1000000}   ← 有 ⇒ 条在
model/selection:  {"provider":"codearts","model":"glm-5.3"}
request/context:  {"provider":"codearts","model":"glm-5.3"}                                        ← 无 ⇒ 条消失
```

复核脚本（解 zstd、抽 `request/context`）见会话 `session-fd3e2786` 的取证方式；
**判据是 `request/context` 事件里有没有 `contextWindow` 键**，不是看 UI。

### ⚠️⚠️ 两个目录端点不下发窗口，但**第三个端点下**（2026-10-29 修正）

- `snap-access /v1/model/builtin` 的条目**键全集**：
  `channel_source, credit, display_enabled, enable, intervals, model_category,
   model_desc, model_id, model_name, model_sku, provider, supports_images, time_slots`
  ⇒ **无任何 context/window/length/token 类字段**（8 条模型逐条核对）。
- `opengw gateway/config`：本机 4 个账号**全回** `4000 invalid channel, group not found`
  （所以别指望从它取窗口；也不要因为它 4000 就以为凭据坏了 ——
  `/v1/model/builtin` 用同一个账号是 200）。
- ⚠️ 探测脚本必须**遍历账号池**：本机第一份凭据（`CODEARTS_ACCESS_TOKEN`）已 401，
  只试它一个会得出「上游不可达」的**假结论**。

⇒ **上面这两条仍然成立，但「窗口只能靠 IDE 配置」的结论已被 2026-10-29 推翻**：
还有第三个端点 **AgentCenter** 下发窗口，而且是动态权威源（详见下节）。
旧结论的原因很简单 —— 当时只探了 builtin 与 gateway/config 两个端点，
AgentCenter 当时还没被当作目录源（codearts2api 那时也只用它取模型列表）。

### ✅ AgentCenter：动态窗口权威源（2026-10-29 接入）

⚠️⚠️ **2026-10-30 四路审计（2 正向 + 2 对抗，60+ 变异）后的修订** —— 本节
记录了 3 个真缺陷与它们的修法（**代码已改、守卫已补**）：

| # | 缺陷 | 修法 |
|---|---|---|
| **P1-1** | **`maxTokens` 出口污染宿主的上下文预留** —— `CatalogEntry.maxTokens` ⇒ `defaultMaxTokens` ⇒ 宿主 `dsh-compaction-basic` 的 `reservedCompletionTokens` 把它**从窗口里扣掉** ⇒ GLM-5.2 压缩触发点 162,201→109,772、压力预算 137,216→71,680；窗口 131,072 的模型 ⇒ **抛 `TargetPressureConfigError`** | **撤掉该落键**（照 `src/opencode-adapter.ts:392-413` 的先例：「上限 ≠ 合理默认预算」）+ 守卫⑦ |
| **P1-2** | **AgentCenter 独有模型无倍率 ⇒ 聚合定价恒 `Infinity`** ⇒ codearts 在聚合里**永远排最后** | **`windowOnly`**：只作窗口源、**不进目录** + 守卫⑨⑩⑪⑫ |
| **P2 D1** | **`canonicalQueryOf` 往返会改字节**（`+`/裸 `%`/`=`）⇒ 可能与服务端口径分叉 ⇒ 静默 401 | 加 `isSignedQueryValueSafe` 闸门（**安全集外不发请求**） |
| **P2 D3** | **`detail` 一步的路由头零守卫** ⇒ 上游从严则 detail 恒 400 ⇒ 核心功能静默失效 | 守卫改**普查**（两次请求都要带） |
| **P3 D6** | **动态腿在「手填 id」场景不可达**（`unknownModelContextWindow` 只在 `entry===undefined` 时被调，而旧实现查 `remoteModels` ⇒ 二者等价） | 动态窗口收进**独立的表**（`remoteContextWindows`）+ 守卫⑧ |

⚠️⚠️ **2026-10-30 第二轮四路审计（2 正向 + 2 对抗，31 变异）后的修订** ——
第一轮的修复**方向全部正确**，但「修法」本身暴露了 3 个新的承重处：

| # | 缺陷 | 修法 |
|---|---|---|
| **P1 N-1** | **`windowOnly` 只在「远端拉取成功」时生效** —— 兜底路径 `DEFAULT_MODELS` **含 `kimi-k3`** ⇒ 冷缓存（首启 / 远端失败 / 上游抖动）下它**裸名**进目录 ⇒ 第一轮 P1-2 的症状**原样复发** | ① 把 `kimi-k3` **从 `DEFAULT_MODELS` 移除**（它的**窗口**仍可用：`CONTEXT_WINDOWS` + `remoteContextWindows`）② 判据改成**独立 id 集合**（`windowOnlyIds`）⇒ 两条路径口径一致 + 守卫⑪⑫ |
| **P1 N-2** | **代码页判据把 ja/ko/zh-TW 误判成 GBK** —— 它们的 OEMCP 分别是 932(SJIS)/949/**950(Big5)**，**都不是 GB18030 的子集** ⇒ 那三类系统上路径被解坏 ⇒ 存在性过滤筛掉 ⇒ 整条注册表腿静默失效 | 改读**权威的 `OEMCP`**（`HKLM\SYSTEM\CurrentControlSet\Control\Nls\CodePage` 的 `OEMCP` 值）+ 解码**兜底重试**（首选解出 U+FFFD **或**与备选不同 ⇒ 换编码） |
| **P1 N-3** | **安全集闸门只盖 4 条带 query 的签名 GET 里的 1 条** ⇒ 同一个 signer **两条腿两套防护口径** | 判据**下沉到 `signRequestHuawei`**（唯一入口、覆盖全部签名请求）；`models.ts` 那层保留只为**脱敏日志** |
| **P2** | **`Agent-Type` 签名口径三条腿两套**（大小写 + 是否签名），分岔依据**零注释登记** | **已登记**（见 `src/models.ts` 的 `signedExtras` 注释里的矩阵）⇒ 修法需**真实上游**逐端点验证 |
| **P3** | 安全集漏了 `encodeURIComponent` 的不编码字符（`! * ' ( )`）⇒ 用户手填带 `!` 的模型 id ⇒ `queue/status` 请求被**静默丢弃** | 安全集扩到 `encodeURIComponent` 的**完整**不编码集 + `%XX`（**且要求大写十六进制**：`%2b` 往返会变 `%2B`） |

⚠️ **三条「结论」的更正**（审计发现原文过度归纳）：
① 「10-21 那次不是上游永久上调而是**临时值/灰度**」—— 从 3 个数据点推出的
**过度归纳**（按**账号**灰度同样解释得通，未验证）。⇒ 改为事实陈述 +
登记「若上游按账号灰度 ⇒ 静态表对部分账号仍错」。
② 「`kimi-k3` 进目录的唯一途径是 AgentCenter」—— **不成立**（它改前就在
`DEFAULT_MODELS` 里）。

两步 GET，签名与本仓 `signRequestHuawei` 兼容，**额外的两个头必须参与签名**：

| 步骤 | 端点 | 关键返回 |
|---|---|---|
| ① | `/v1/agent-center/agents/useragents?offset=0&limit=100` | `agents[]`，取 `is_primary_agent` 那条（缺省第一条） |
| ② | `/v1/agent-center/agents/detail?agent_id={id}` | `gpts.models[]` 含 `model_parameters.{context_window,max_tokens,supports_images}`（⚠️ 2026-10-30 起本仓**只取 `context_window`** —— `max_tokens` 刻意不取，见上表 P1-1 的后果说明） |

必须带 `agent-type: AgentCenter` + `x-language: zh-cn`（**进签名**）：
- 缺 `x-language` ⇒ `400 TM.00001001`（「未找到合法可路由 api」—— 看着像路由问题，其实是头不全）；
- 缺 `agent-type` ⇒ 同上；带错（如 `PromptCenter`）⇒ 同样 400。

⚠️⚠️ **query 必须按 key 排序参与签名**（2026-10-29 真机 2×2 定案）：
`useragents` 的 wire 顺序是 `offset,limit`（**非**字典序），而服务端按自己收到的参数
**排序后**重算 canonical ⇒ 直接照搬 wire 顺序签名会得 `401 verify ak sk signature fail`，
改成签名内排序即 200（wire URL 顺序无关，四轮 4/4 确定性）。
落在 `src/sign.ts` 的 `canonicalQueryOf()`，**只改签名侧、wire URL 原样**。

真机数据（harness 自己的 STS 凭据，primary agent `9f0e5cb6…`）8 个模型全带窗口，
与 IDE `/cag` 权威**逐值一致**：`GLM-5.2=202_752 / glm-5.2-sft-harmony=202_752 /
openpangu-*=524_288 / glm-5.3=1_048_576 / ds-v4.1-flash=1_048_576 /
kimi-k3=1_048_576 / ds-v4.1-flash-1017=1_048_576`。

⇒ **现在的层次**：AgentCenter 动态值（`RemoteModel.contextWindow`）> 静态表 >
具名兜底。静态表退化为**冷缓存兜底**，但每条数值仍被取证注释钉住
（上游再漂移时不必手改表，下次目录刷新即自动跟上）。
另：`kimi-k3` **只在 AgentCenter 出现**（builtin 漏发）⇒ 它**只能从 AgentCenter
拿到窗口**。
⚠️⚠️ **更正**（2026-10-30 四路审计 P3 D9 修）：原文写「这也是它**进目录**的
唯一途径」——**不成立**：`kimi-k3` **改前就在 `DEFAULT_MODELS` 里**
（`src/llm-adapter.ts` 的静态兜底目录，master 第 339 行）⇒ **冷缓存下它一直
在目录里**，不是「可用性缺口」。
⚠️⚠️ **且 2026-10-30 起它更不该进目录**（审计 P1-2 修）：AgentCenter
**不下发倍率** ⇒ 它进目录就是**裸名** ⇒ `priceFactorFromName` 恒 `Infinity`
⇒ 聚合候选**恒排最后、永不被挑中**（静默）。
⇒ 现在它**只作窗口源**（`RemoteModel.windowOnly`）：**不进目录**，但**手填
id 时的分母取 AgentCenter 的权威值**（动态窗口表与目录可见性解耦）。

### 权威取值：IDE 内核日志的 `limit.context`

位置：`~/.codeartsdoer/codearts-data/log/kernel-*.log`，搜
`provider models replace body is` / `global config models`：

```json
"provider":{"inferhub-provider":{"models":{
  "GLM-5.2":{"id":"GLM-5.2","limit":{"input":1044480,"output":65536,"context":202752}},
  "glm-5.3":{"id":"glm-5.3","limit":{"input":1044480,"output":65536,"context":1048576}},
  "glm-5.2-sft-harmony":{"id":"...","limit":{"input":196608,"output":131072,"context":202752}},
  "openpangu-2.0-pro":{"id":"...","limit":{"input":512000,"output":131072,"context":524288}},
  "deepseek-v4.1-flash":{"id":"...","limit":{"input":1044480,"output":65536,"context":1048576}}
}}}
```

⚠️⚠️ **上表的 `GLM-5.2` 已按 2026-10-29 双源复测改为 `202752`**（2026-10-30
四路审计 P2-2 修）：原文此处写的是 `1048576`，而**同一文档**的漂移表
（下一节）与代码（`src/llm-adapter.ts` 的 `CONTEXT_WINDOWS`）都是 `202752`
⇒ 文档里**最像原始证据**的那一格停在改前的值 ⇒ 读者会拿到自相矛盾的两份
「权威」。⚠️ 这段 JSON 是**历史内核日志的摘录**（按 2026-10-29 复测值校准），
不是「某一天的原始日志」⇒ 已在上面标注校准来源。

⚠️ **这个值会变，而且变过**（本机 42 份日志，2026-09-11~10-21 按日期收敛；
2026-10-29 又用 IDE 0.2.6 抓包 + AgentCenter 双源复测）：

| 模型 | 历史 |
|---|---|
| `GLM-5.2` | 09-11~10-20 = `202_752` ⇒ 10-21 一度 `1_048_576` ⇒ **10-29 复测回到 `202_752`** |
| `glm-5.3` | 10-17 起出现，先 `202_752` ⇒ **10-21 起 = `1_048_576`** |
| `glm-5.2-sft-harmony` | 全期 `202_752` |
| `openpangu-2.0-flash` / `-pro` | 全期 `524_288` |
| `deepseek-v4.1-flash` | 全期 `1_048_576`（本仓曾写 `1_000_000`，**是错的**） |
| `kimi-k3` | `1_048_576`（**窗口只由 AgentCenter 下发**，builtin 目录里没有它；⚠️ 2026-10-30 起它**只作窗口源、不进目录** —— 见上节 `windowOnly`） |

⚠️⚠️ **`GLM-5.2` 的三次漂移是本条的活教材**：10-21 那次 `202_752 → 1M` 当时被当成
「上游永久上调」（守卫文本还专门写了「不得退回 202_752」），而 10-29 双源复测证明
那只是**临时值/灰度**。教训不是「该不该改表」，而是 **表本身不应该是唯一权威** ——
所以本次把 AgentCenter 接成动态源；静态表只做冷缓存兜底，且改它的人必须带取证。

⚠️ **两个方向的后果不对称，但都真实**（与 `officeace-product.ts`
「估值偏小 5.3 倍」**逐字同因**）：
- 表值**偏小**（如 202_752 而真实 1M）：占用比封顶 100%、压缩阈值降到 `0.8 × 202_752
  ≈ 162K` ⇒ **1M 的能力永远吃不到**；
- 表值**偏大**（如 1M 而真实 202_752）：压缩阈值 ≈ 838K 永不到达 ⇒ **先撞上游溢出**，
  一轮对话报废。
⇒ 校准窗口时**两个出口一起想**（占用条的分母 + 压缩阈值），别只看 UI。

### 修法（四条腿，缺一条就会复发）

0. **动态源**（2026-10-29 新增，最重要）：`fetchAgentCenterWindows()` 把
   AgentCenter 的 `context_window` 挂到 `RemoteModel.contextWindow`，
   `toCatalogEntry` 优先读它 ⇒ 上游一改，下次目录刷新自动跟上。
   ⚠️ **它不进 `isRemoteCatalogComplete`** —— 窗口缺失只是退化（走静态表/兜底），
   拿它当「目录不完整」的判据会让整个目录被拒，因果不成比例。
1. **静态表** `src/llm-adapter.ts` 的 `CONTEXT_WINDOWS` 逐模型校准（写来源+日期）；
2. **具名兜底** `CODEARTS_FALLBACK_CONTEXT_WINDOW = 524_288`（用户 2026-10-21 选定：
   取当前目录**最小真实窗口**；偏小 ⇒ 偏早压缩不报错，偏大 ⇒ 未知模型可能
   **上游溢出报错**一轮对话报废 ⇒ 取偏小一侧）。纪律与
   `aggregate-adapter` 的 `AGGREGATE_COLD_CONTEXT_WINDOW` 同型：**宁给具名兜底、不省略**；
3. **骨架回调** `ModelCatalogConfig.unknownModelContextWindow?(modelId)`
   —— **可选**，只有声明它的家生效（当前**仅 codearts**）。其余 12 家行为逐字不变。

### ⚠️⚠️ 两条踩过的坑（都实测过，别再犯）

1. **回调必须传 `modelId`**：第一版写成无参、直接返回常数兜底 ⇒ `glm-5.3` 在
   窗口表里是 1M，却**不在静态兜底目录 `DEFAULT_MODELS` 里** ⇒ 离线/首次启动
   时它算「目录外 id」⇒ 拿到 `524_288`（**分母错 2 倍**），而它正是报障模型。
   ⇒ 实现必须是 `codeartsContextWindow(modelId)`「**表内优先、查不到才兜底**」。
   ⚠️ 这是**全量测试**（10191 条里的 1 条红）抓出来的，不是审计想出来的。
2. **`listModels` 的返回值里没有 `contextWindow`**：DSH 契约
   `LlmModelInfo`（`dsh-llm/lib/types/types.d.ts`）**只有**
   `provider/id/name/description/inputModalities`；`context?: {contextWindow}`
   只存在于 **`LlmResolvedModelInfo`**（`resolveModel` 的形状）。
   ⇒ 守卫**不能**断言 `listModels` 带窗口（我第一版就这么写，恒红）。
   **契约形状写错会让守卫「假红」，与假绿一样有害**。

### 守卫与变异验证（`tests/unit/codearts-context-window.spec.ts`）

| 变异 | 结果 |
|---|---|
| 目录条目改回 `...cond ? {...} : {}`（缺陷原形） | ①② 红，点名 `glm-5.3` / `GLM-5.2` |
| `unknownModelContextWindow` 改回无参常数 | ③ 红 + 跨家不变式 g 红 |
| 骨架对未知 id 普遍给 `200_000` | **17 条红，逐家点名**（证明其余各家仍受约束） |
| 回调改回 `() => CODEARTS_FALLBACK_CONTEXT_WINDOW` | ③c 红（精确复现上面那个缺陷） |
| `toCatalogEntry` 忽略 `model.contextWindow`（只认静态表） | **⑥ 红**（动态源唯一有牙的守卫，2026-10-29 补） |

跨家不变式 (g)「未知 id 不得编造 context」在 `model-catalog-parity.spec.ts`，
现为「**默认禁止 + codearts 具名例外**」；例外**改判据**（必须等于具名常量），
**不是** `if (id !== 'codearts')` 跳过断言 —— 后者会让 codearts 这条完全无牙。
⚠️ 该不变式此前对 **15 家全部有牙**（文件头注有反向验证记录），改它时要保住这一点。

## ⚠️⚠️ 图片输入：只有 VL 模型能收图，且 DSH 会按模态把图**投影成文字**

### 报障与结论（2026-10-21）

用户：「codearts 发送图片后端模型不支持图片，发送带图的信息会直接跳出提示阻止发送，
但 CodeArts IDE 发送识图任务是支持识图的」。

**结论：IDE 不是让文本模型收图，而是两段式** —— 先用 VL 模型看图、把结果变成文字，
再交给主模型。判据来自本机 IDE 内核日志：

```
builtin-model-service  "[fetchMultimodalModelId] Response: {...8 个模型...}"
builtin-model-service  "[fetchMultimodalModelId] Success, selected multimodal model: kimi-k2.6-vl,
                        candidates: kimi-k2.6-vl, Qwen3-VL-235B"     ← 11 次采样恒定选它
provider-models-plugin "global config multimodalModels:" 0=... 2=kimi-k2.6-vl
```

`analyzeImage` 是 IDE 的一个**工具**（描述原文：*Analyse image or images by ID, file path,
or base64 data and extract information such as OCR text, objects, layout, colors…*；
参数 `imageId`/`imagePath`/`imageBase64` 三选一，*Data is processed in memory only*）。

### 谁能收图（`/v1/model/builtin` 的 `supports_images`，8 条逐条实测）

| 模型 | `supports_images` | `model_category` |
|---|---|---|
| `kimi-k2.6-vl` / `Qwen3-VL-235B` | **true** | **图片理解** |
| `glm-5.3` / `GLM-5.2` / `glm-5.2-sft-harmony` / `openpangu-2.0-flash` / `-pro` / `deepseek-v4.1-flash` | false | 文本生成 |

### ⚠️⚠️ wire 形态**四选一**，只有一种被接受（实测）

对两个 VL 模型各发一张 8×8 纯色 PNG、问颜色：

| 形态 | 结果 |
|---|---|
| **`{type:'image_url', image_url:{url:'data:…'}}`** | **200，答对颜色** ✅ |
| `{type:'image_url', image_url:'data:…'}`（字符串） | 406 `InferHub.001001046` |
| `{type:'image', source:{type:'base64',…}}` | 400 `ModelArts.81001` unsupported content type |
| `{type:'input_image', image_url:…}` | 406 `InferHub.001001046` |

反向对照：同一形态发给 `glm-5.3` 得
`InferHub.001001020.406 The request model is not multimodal` ⇒ 判据有判别力。

⚠️ 本机 IDE 日志里 `image_url` **零命中** —— IDE 走自家内部通道，没留下 wire 形态，
所以这一格**只能实测**，不能从日志抄。

### ⚠️⚠️ DSH 侧：模态声明是**唯一开关**，它决定图会不会被换成文字

`dsh-llm/lib/index.js:2337`（dispatch 前）：

```js
if (modelInfo.inputModalities !== void 0
    && !modelInfo.inputModalities.includes('image')
    && projectedMessages.some(m => contentHasImage(m.content)))
  projectedMessages = projectImagesForTextModel(projectedMessages)
// → 每张图被替换成 textOnlyImageText(ref)：
//   "[image omitted because this model accepts text only; attachment sha256:…]"
```

⇒ **声明里没有 `image`，图根本到不了适配器**（在宿主就被换成一行占位文字）。
官方 `read_image` 的 `assertImageCapableRoute` 用的也是同一个判据。

### 三条接线（本次改动）

1. `CODEARTS_VL_MODELS` + `codeartsAcceptsImage()`：**逐模型**判能力（大小写不敏感）；
2. `toCatalogEntry` 与 **`unknownModelInputModalities(modelId)`** 都要按 id 判 ——
   ⚠️⚠️ VL 模型**刻意不在对话目录里**（上下文小、不支持工具调用），所以
   `resolveModel('kimi-k2.6-vl')` 走的是**「目录外」分支**，只有后者生效。
   第一版只改了 `toCatalogEntry`，实测恒红（真缺陷，见守卫 ①）；
3. `serializeMessages` 改用共享实现（`openai-compat.ts`），配 `readImage` 桥接 +
   `codeartsImagePart()` 产出唯一被接受的形态。

### ⚠️ 两条踩过的坑

1. **`prepareCall` 里原有一行硬覆盖**：`{ ...await resolveModel(...), inputModalities: ['text'] }`
   ⇒ 只要目录开始按模型区分模态，这行就**静默抹平**它。症状是「VL 模型明明声明了
   image，发图仍被拒」，且两处代码各自看都对。守卫 ④ 钉住「两者必须一致」。
2. **本家原有一份只处理文本的私有 `serializeMessages`**（注释还写着「图片被丢弃」）。
   在它上面加图片腿 = 同一语义两套实现 ⇒ 改为复用共享实现，并**删掉**原来那条
   「CodeArts 与 openai-compat 互相对拍」的用例（合并后 `f(x)===f(x)` 恒真，
   属同义反复，本仓纪律不允许留着充数）。

### 验证

- 单测：`codearts-image-input.spec.ts` 7 条（模态正/反向、VL 不在目录、prepareCall
  一致、大小写、wire 形态、识图模型选择）；变异验证两处均精确变红（回调恒 false →
  ① 红；prepareCall 加回硬覆盖 → ④ 红）。
- 真实端到端（2026-10-21，第三个账号）：发**蓝色** 8×8 PNG 给 `kimi-k2.6-vl`，
  回答「蓝色（我实际看到的是一张1x1像素的纯蓝色图片，RGB值为(0,0,255)）」⇒
  图真的到了上游。
- ⚠️ 排查时的坑：反复开流式会话却不消费完响应体会**占满并发槽**，后续请求回
  `TM.00001041 并发会话数已达上限(3个)`（甚至以 404 形式出现）—— 那不是代码缺陷，
  **等槽位释放或换账号**即可。

### ⚠️⚠️ `analyzeImage` 真机验收抓出的真缺陷：已拼好的 `image_url` 被**静默丢弃**

**症状**（极具误导性）：`analyzeImage` 工具返回「我无法看到您提到的图片」。
HTTP 200、正文正常、上游零报错 —— 因为**图根本没发出去**。

**成因（两处同因的门禁，必须同修）**：

1. `openai-compat.ts` 的 `userContentParts()` **只认 harness 原生**
   `{type:'image', attachment}`（拿 `imageUrls` 表查字节），对
   **已拼好的** `{type:'image_url', image_url:{url}}` **零命中** ⇒ 该块被丢弃。
   ⚠️ 而 `analyzeImage` 的识图请求是**插件自己构造**的（不是 harness 派生历史），
   它正是把图直接拼成目标形态后交给 `adapter.stream()`。
2. `serializeMessages()` 里 `imageUrls === undefined` 时**整段跳过**
   `userContentParts` ⇒ 即使第 1 条修好，识图请求（**不传** `imageUrls`）
   也走不到那里。⇒ 判据改成「有映射表 **或** 内容里本来就带 `image_url` 块」。

**为什么原有用例没抓到**：它们只测 `{type:'image', attachment}` 那条路
（配 `imageUrls` 表）。「已拼好的块」是**另一条入口**，零断言 ⇒ 从缝里漏过。
守卫 ⑪~⑬（`codearts-analyze-image.spec.ts`）补上，两处改动**各自都有牙**
（分别撤掉任一处，⑪ 都精确变红）。

**⚠️ 排查过程里的两个坑（都真实踩到）**：

1. **`fetchImpl: async () => new Response('nope', {status: 404})` 会把所有请求拦掉**
   —— 我的 e2e 脚本里留了这个桩，于是看到「HTTP 404」并误以为是上游问题，
   还据此怀疑过并发槽。**桩必须在真机验收时移除**，否则验的是桩。
2. **变异验证「全绿」先怀疑变异没注入**（本仓已登记过同款）：该文件是 **CRLF**，
   而我的脚本用 LF 匹配多行锚点 ⇒ `replace` 静默不生效 ⇒ 误判「改动无判别力」。
   ⚠️ **跨行锚点在 CRLF 文件上必须用单行锚点或做行尾归一**，并且**先打印
   `锚点存在: True/False` 自证**，未命中要报「未注入」而不是「无牙」。

**真机验收（2026-10-22）**：16×16 纯绿 PNG，`glm-5.3`（文本模型）经工具识图，
返回「整个画面为**亮绿色**（近似荧光绿，RGB 可能接近 #00FF00）… 图片中没有任何文字」
⇒ 图真的到了上游，且描述准确。

## ⚠️⚠️ bili 压缩代理的「拒发改写请求」（Gitee IKQ7AP，2026-10-25 修）

长会话触发上下文压缩后，请求体被改写，而 SDK-HMAC-SHA256 签名**覆盖正文** ⇒
本机压缩代理 bili（billion-context）按 compress-or-refuse contract **拒发**，
回 HTTP 403 + `{"error":{"type":"signed_request_requires_resign",
"code":"bili_resign_unavailable","message":"bili refused to forward this
sdk-hmac-sha256 …-signed request: the signature covers the request body, and any
rewrite (context compression) would invalidate it upstream (401 APIG.0301 /
SignatureDoesNotMatch). No re-sign credential was available for this scheme."}}`

**修复前的连锁反应**（`src/llm-adapter.ts`）：

1. `isTransientSignatureFailure` 只认 `body hash mismatch` ⇒ bili 不命中；
2. `isAuthError` 对 401/403 恒真 ⇒ **白刷一次 refresh**（真实 STS 网络往返）；
3. 重试仍被拒 ⇒ `httpErrorCode` 归 `AUTH` ⇒ 客户端把 message 整条换成
   「API 密钥无效」⇒ 唯一指路的「No re-sign credential」丢失。
4. 实测四格：code=AUTH / refresh 1 次 / message 只剩
   `codearts: model request failed with HTTP 403` / `bili_resign_unavailable` 不可搜。

**修法**：新增 `isProxyResignRefusal`（只认 bili **三个独有 marker**）+
`PROXY_REFUSED_SIGNED` 独立码 + `proxyResignRefusalFailure`（文案带两条可执行
出路）+ **三处接线**（`isAuthError` 排除 / `httpErrorCode` 单列 / chat 循环**独立
早退**：不刷新、不重发、不换号）。

### ⚠️ 判据刻意**不认** `APIG.0301` / `SignatureDoesNotMatch`

bili 的 message 里**恰好引用**了这两个词（描述它为什么拒发）⇒ 按它们放宽会把
**真凭据问题**误判成代理拒发。只认三个 bili 独有串。

### ⚠️ 为什么「不换号」是对的

bili 拦的是 fetch 层**改写后的请求**；改写（压缩）与账号无关，且判据
（`isProxyResignRefusal`）只看 status+body、账号 id 根本不入参 ⇒ 账号 B 同样被拒
⇒ 换号必然再撞。早退抛错时 `rateLimitTried` 只有 1 个账号（三处 `add` 都在早退
之后），且早退**不调** `updateModelRateLimit` ⇒ issue 附言里「另一插件把账号
永久禁用」的教训**没有重演**。

### ⚠️ 变异验证的教训：单删早退**前面**的腿是全绿的

`isAuthError` 排除腿 / `httpErrorCode` 单列腿单独删 ⇒ **全绿**（早退在两者之前，
不可达）。必须用**组合变异**（删早退 + 删其中一腿，模拟「重构把早退挪走」）
才有牙（各 4 红）。⇒ **防御性冗余的腿要靠组合变异验证**，单删会误判「无牙」。

### ⚠️ 登记未修：bili 若改用 HTTP 200 下发拒发（无本机证据，不修）

| 形态 | 现实现落点 |
|---|---|
| 200 + SSE 嵌套 `error{}` | 不可见（`consumeSse` 只读顶层 `error_code`）⇒ `EMPTY_RESPONSE` |
| 200 + SSE 顶层 `error_code` | `INVALID_REQUEST`（message 含原文但码错） |
| 200 + 裸 JSON | 同第一行 ⇒ `EMPTY_RESPONSE` |

**不修的三条理由**：① bili 是本机代理，拒发发生在 fetch 建连阶段，契约下只能是
HTTP 层拒绝，200 **无本机证据**（bili 未装、文档不可得）；② 任务建议的
「放宽状态闸门」实测**打在不存在的调用点上**（`consumeSse` 的 `error_code` 分流
不调 `isProxyResignRefusal`），真要修须**新建通道**（嵌套 `error.code` 解析）；
③ 误判面已实测：agent 正常回答若引用这三个 marker（本仓库源码自身含 13 次），
200 通道版判据**全部 TRUE** ⇒ 把正常回答变成硬失败，还会给出「重新登录无用」的
**假指路**。收益/风险不对称，按仓库「不据构造的报文改分类」的纪律仅登记。

---

## ⚠️⚠️ 目录 id 语义 / 续期终态类型 / 「已下架」判据（2026-10-28，PR #159 合入 master 后）

三件事都来自 PR #159（`fix/codearts-renew-and-catalog`）与 master 的合并复核
（合并提交 `82219c5`、缺陷修正在其后）。**动这三处前先读本节。**

### ① 目录 id：对外**一律用原始 `model_id`**，不存在「剥日期后缀」的裁剪刀

- master `3f0f48c` 已修 IKQY27（`deepseek-v4.1-flash-1017` 被静默吞掉）：
  `parseModelInfo` 的**对外 id / `seen` 去重键 / 展示名**全部改用**原始** `model_id`
  （`/v1/model/builtin` 同时下发 `deepseek-v4.1-flash` 与 `-1017` 两个独立条目，
  两者 `model_type` 都是 `admin`、`context` 都是 `1048576`）。
  `normalizeModelId` 只保留两处**内部**用途：gateway 分支判断「该 id 是否带日期
  后缀」（决定是否记为 benefit）、`model_name` 缺失时的兜底 id。
- ⚠️ PR159 首版的「父 id 不存在才剥后缀」（`resolveModelIds` / `modelIdSuffixCandidate`）
  **已删除**：它依据的前提「chat 端点只认不带后缀的 id」在本仓 2026-09-23 已被实测
  推翻 —— `-0731` 回 `404 not registered` 的真因是**缺 `maas_type: benefit` 头**，
  而 `deepseek-v4-flash-0731` 与无后缀是后端**两个独立注册的模型，不能互相替代**。
  守卫：`tests/unit/models.spec.ts` 的「带版本后缀的 id 必须原样暴露、不得归一成无后缀」。
- 目录表校准（真机逐条实测）：`DEFAULT_MODELS` 删 `GLM-5` / `glm-5.3-flash` /
  `deepseek-v4-pro`（均 404），补 `glm-5.3` / `glm-5.2-sft-harmony` /
  `deepseek-v4.1-flash-1017` / `kimi-k3`。
- ⚠️⚠️ **`CONTEXT_WINDOWS` 必须补 `deepseek-v4.1-flash-1017 = 1_048_576`，否则只是半修**：
  master 已让 1017 在列表里可见，但窗口会落到 `524_288` 具名兜底 ⇒ 占用比分母
  **小 2 倍**、压缩阈值偏早（实测 `codeartsContextWindow('deepseek-v4.1-flash-1017')
  === 524288`，父 id 为 `1048576`）。守卫：`tests/unit/llm-adapter.spec.ts` 的
  `listModels` 断言 + `tests/unit/codearts-context-window.spec.ts`。

### ② 续期「兑换成功但落盘失败」⇒ 终态，且**终态错误的类型由调用方注入**

- 事实：`refresh()` 成功 = 服务端**已消耗**一次性 refresh_token 并签发新的；
  此时 `save()` 失败 ⇒ 新凭据只剩内存引用 ⇒ 本地永久停在死 token 上。旧实现让异常
  冒泡，各家 `refreshAll` 当**非终态**处理：只记 warn、不写 `refreshable:false`、
  面板照常显示「自动续期」⇒ 静默死号（2026-10-27 两次真实事故）。
- 修法：`refreshAccountWithReconcile` 新增**必填**参数
  `makeTerminalError: (message) => Error`。
- ⚠️⚠️ **不得复用别家 provider 的错误类**（PR159 首版即如此，注释声称「九家同时
  受益」）：每家 `refreshAll` 判的是**自己那个同名类**（buddy / trae / qoder /
  cline / lobsterai 各自定义、gemini 是 `GeminiRefreshTokenExpiredError`、minimax 是
  `MinimaxRefreshTokenExpiredError`、accio 是 `AccioRefreshTokenExpiredError`）
  ⇒ 跨模块 `instanceof` **恒为 false**，另外 8 家仍按非终态处理 = 照样静默死。
  ⇒ 10 处调用点（九家，gemini 两处）各给自己的类；参数**必填**，漏接线在
  `tsc --noEmit` 就红（不靠人记得）。
- 守卫（双向都做过）：
  - `tests/unit/expiry-sync.spec.ts` 注入独有的 `MarkerTerminalError`，断言抛出的
    就是它、且**不是**别家的类（先 RED：`expected RefreshTokenExpiredError … to be an
    instance of MarkerTerminalError`）；
  - `tests/unit/buddy-auth.spec.ts` 在本 provider 上真跑 `refreshAll`（只让
    `credentials.set` 失败）⇒ 必须写 `refreshable:false`。变异：把共享模块改回借用
    codearts 的类 ⇒ 该用例**变红**（共享模块自己的替身单测抓不到这处接线）。
- ⚠️ 关联：master 另有中立的续期失败分类器 `src/refresh-failure.ts`
  （`isTerminalRefreshFailure`），当前只接在 autoclaw / minimax 两家；本处**不**用它，
  因为它的输入形状是「上游响应」，而这里是「本地存储写失败」。

### ③ 「已下架模型不补回设置页」的判据必须**确认拿到全量目录**

- 病：`model.list` 会把「不在全量目录里」的黑名单条目判成已下架、**不补回**设置页
  （否则上游已下架、用户曾关掉的模型会永久灰显在那儿、点开必然
  `InferHub.002002009.404`）。
- ⚠️⚠️ 但 `listAllModels()` 在**冷缓存 / 远端降级**下返回的是各家**编译期兜底表**，
  而那是远端目录的**子集**（Issue IKJW33 实测：`cline` 冷缓存 3 条 vs 远端 460 条）
  ⇒ 拿它当在售集合，用户关掉的**在售**模型（例如只存在于远端的新模型 `glm-5.3`）
  会被判「已下架」⇒ **从设置页彻底消失、再也打不开**（窗口很实在：远端拉取失败、
  离线启动、刚重启还没拉到目录时都会命中）。
- 修法：适配器自报钩子 `ModelCatalogSource.catalogConfirmedRemote?()`（**可选**；
  当前只有 codearts 实现 = `remoteModels !== undefined && remoteComplete`，即
  「至少成功读到过一次远端**且**两个目录端点都取全」）。只有它返回 `true` 时
  `model.list` 才允许隐藏；**未实现 / false / 抛错一律放弃判据**（照旧补回）——
  其余 14 家不实现该钩子 ⇒ 行为与加判据之前**逐字节一致**。
  在售集合取 `listModels ∪ listAllModels`（与 `fullCatalogIds` 同口径）。
- 守卫：`tests/unit/jet-hub-rpc.spec.ts`「目录未经确认远端时不得据残缺（兜底子集）
  判已下架」（先 RED）；`tests/unit/llm-adapter.spec.ts` 三态（冷启动 / 完整 / 残缺）；
  `tests/unit/dead-model-store.spec.ts`「经 `withDeadModelPruning` 包装后仍可调用」
  （⚠️ 包装层若吞掉该成员，判据会**静默放弃**、PR159 那半个修复无声失效）。
  变异验证：去掉 `confirmedRemote === true` 门槛 / 丢掉 `remoteComplete` 腿 /
  让 Proxy 吞掉该成员 ⇒ 三条用例各自变红。

---

## ⚠️⚠️ 出站字段集：按 IDE 抓包对齐（2026-10-30）

### 取证方式

Reqable 抓包拿到 **4 条真实 IDE 聊天请求**（`agent-kernel.exe` →
`POST /api/v2/chat/completions`，233~257 条消息、16 个工具、body 590~630 KB），
**顶层键集 4/4 完全一致**（11 个）：

```
enable_thinking, max_tokens, messages, model, stream, stream_options,
temperature, tool_choice, tool_stream, tools, user_prompt
```

### 插件此前的偏移（已全部修正）

| 字段 | 旧插件 | IDE | 处置 |
|---|---|---|---|
| `include` | 发 `["reasoning.encrypted_content"]` | **不发** | 移除（本仓无消费者） |
| `reasoning_summary` | 发 `"auto"` | **不发** | 移除（同上） |
| `enable_thinking` | 不发 | `true` | **新增** |
| `stream_options` | 不发 | `{include_usage:true}` | **新增** |
| `temperature` | 不发 | `0` | **新增** |
| `tool_choice` | 不发 | `'auto'` | **新增**（仅真带工具时） |
| `user_prompt` | 不发 | 用户原话 | **新增** |
| `prompt_cache_key` | 发会话 id | **不发** | **刻意保留**（见下） |
| `max_tokens` | 64000 | **32000** | 默认值降级到 32000 |

### ⚠️⚠️ `enable_thinking` 才是真正生效的思考开关（**旧结论被推翻**）

旧笔记断言「本网关唯一生效的思考控制是顶层 `thinking.type`」，据此插件关思考时发
`thinking:{type:'disabled'}`、开思考时**不发**。2026-10-30 用 `reasoning_tokens`
做判据重测（题目「17×23 step by step」）：

| 请求 | `reasoning_tokens` | reasoning 字符 |
|---|---|---|
| `enable_thinking: true` | **34** | 129 |
| `enable_thinking: false` | **n/a（无该字段）** | **0** |
| 不发该字段（服务端默认） | 45 | 175 |

⇒ `true` / `false` **双向都生效**；旧结论「开启 = 不发字段」**不成立**（不发只是走默认）。
`enable_thinking:false` 与 `thinking:{type:'disabled'}` 实测**等价**（都归零）
⇒ 与 IDE 对齐后**只留前者**，`thinking` 字段**不再发**（同一语义不发两份）。

### ⚠️ `prompt_cache_key` 是唯一有意偏离 IDE 的字段

IDE 不发它也能吃到自动前缀缓存（实测 `cached_tokens 148480/148949`，99.7% 命中）。
插件仍发会话 id，理由是会话级亲和让多轮/并发落同一后端实例。2026-10-30 真机 A/B：
带它 200 且 `cached=256`、不带也 200 且同样 `cached=256` ⇒ **无害**。
⚠️ 若将来要**完全**对齐 IDE，删它也不会有功能损失（但要同步改这条注释与用例）。

### ⚠️ `max_tokens` 为什么拆成两个常量

| 常量 | 语义 | 值 |
|---|---|---|
| `CODEARTS_MAX_OUTPUT_TOKENS` | 上游**最多接受多少**（钳制上界） | 65_536 |
| `CODEARTS_DEFAULT_MAX_OUTPUT_TOKENS` | **没人指定时发多少**（默认预算） | 32_000 |

IDE 的 32000 是**客户端默认预算**（AgentCenter 给该模型的上限是 65536，4/4 请求恒 32000）。
⚠️ **不能**把上界直接改成 32000：那会静默削掉调用方明确要求的长输出，而长输出正是
`tool_stream` 存在的理由（大文件 write 的参数 JSON 需数万 token，截断产出非法 JSON）。

### ⚠️ `user_prompt` 的取值语义（一个易写错的陷阱）

必须是**最后一条真正的用户发言**的纯文本，且**从原始 `options.messages` 取**，
不能从 `serializeMessages` 之后的 wire 数组取 —— 后者把工具结果展平成 `role:'tool'`，
而 harness 原始消息里工具结果**搭载在 user 消息中** ⇒ 从 wire 数组回找会命中
工具结果（几百 KB 的文件内容），与 IDE「用户一句话」的语义完全相反。
末尾是工具结果时**回退**到上一条真正的用户发言；取不到就**省略该键**（不发空串）。

### 与 IDE 仍然不同的地方（**不算缺陷**）

1. **签名头集**：IDE 只签 `host;x-sdk-date;x-security-token`（3 个）且不签 content-type，
   还重复发两次 `x-auth-token`；插件签 6 个。两种都被服务端接受（A/B 实测 200）。
2. **遥测头**：IDE 有 20+ 个 `x-ot-*` / `traceid` / `user-msg-id` 等；插件不伪造这些
   （伪造别人的遥测 ID 只会污染上游统计）。
3. **DSML 模型（`deepseek-v4-*`）不发 `tools`/`tool_choice`**：工具 schema 改注入
   system 提示（为规避 APIG 60s 空闲断连）。IDE 对 `-1017` 用标准 tools 路径，
   而插件对 `-1017` **也是**标准路径（正则不匹配它）⇒ 该模型与 IDE 一致。
4. **`user_prompt` 之外的 `thought_signature` 一类字段**：IDE 未下发，不臆造。

## ⚠️⚠️ 华为 WAF 按 `User-Agent` 前缀拒发：「API 密钥无效」的真因不是凭据（2026-11-05 真机）

### 报障原话

> 有人反应 codearts 模型用不了，需要改 user-agent：jethub 插件 codearts 出现提示
> **api 密钥无效**，可以把请求的 UA 改成 vscode 的就能用。

### 实测结论：**UA 是唯一变量**

同账号、同签名（`signRequestHuawei` 的入参逐字节相同）、同 body，只改 `User-Agent`：

| `User-Agent` | 结果 |
|---|---|
| `deepseek-harness/0.2.1-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)`（宿主 `attributionHeaders()` 默认值） | **403 `{"error_code":"TM.00000001","error_msg":"网络繁忙，请稍后重试"}`** |
| `deepseek-harness/0.2.1`（去掉 url 段） | **403 同一码** |
| `deepseek-harness/0.2` / `deepseek-harness/1.0.0` / `deepseek-harness/1.2.3` | **403** |
| `deepseek-harness`（**无** `/版本`）、`deepseek-harness-x/1.0`、`DEEPSEEK-HARNESS/1.0` | 200 |
| `foo/1.0 deepseek-harness/2.0`（不在行首） | 200 |
| `VSCode/1.95.3` / `Mozilla/5.0 …` / `curl/8.4.0` | 200 |
| `claude-code/1.0.0` / `opencode/1.0.0` / `cline/3.0.0` | 200（**不是**「拦所有 AI 客户端」） |

⇒ 判据是**大小写敏感的行首前缀 `deepseek-harness/`**。4 个账号全部一致，
交替顺序 3 轮可复现（排除瞬时抖动/账号差异）。

### 拒发方是 **WAF**，不是 APIG 验签

403 响应头：`server: CW`、`set-cookie: HWWAFSESID=…` / `HWWAFSESTIME=…`、
`lubanops-*`、`x-request-id: …`，body 是 WAF 的 `TM.00000001 网络繁忙`
（**不是** APIG 的 `APIG.0301`）。

⚠️ **UA 不参与 SDK-HMAC-SHA256 签名**（`signRequestHuawei` 只签
`host` / `x-sdk-date` / `x-sdk-content-sha256` / `x-security-token` /
`content-type` / 显式 `extraHeaders`）⇒ 覆盖它**不会**打破验签（实测改后 200）。

### 症状链（为什么「API 密钥无效」极具误导性）

1. WAF 403 ⇒ `httpErrorCode()` 的 `if (status === 401 || status === 403) return 'AUTH'`；
2. 客户端把 `AUTH` 的 message **整条替换**成「API 密钥无效」
   （`dsh-client-ui-chat/lib/client.js` 的 `"message.failure.auth": "API 密钥无效"`）
   ⇒ 用户看到的是**假原因**，真实报文（`TM.00000001 网络繁忙`）被吞掉；
3. 且 `isAuthError` 对 403 恒真 ⇒ 每次失败**白跑一次凭据续期**
   （实测 `stream()` 内 `refresh()` 1 次、`fetch` 6 次）；
   而 CodeArts 的 `refresh_token` 是**一次性轮换**的（见
   `tests/e2e/codearts-credential.ts` 注释）⇒ 这不是无害副作用。

### 修法（`src/llm-adapter.ts`）

`CODEARTS_USER_AGENT = 'codearts/1.0.0-1147257973136832'`，在 chat 请求构造处
**覆盖**宿主的 `user-agent`。取值逐字取自本机 CodeArts Agent 内核的启动参数
（`~/.codeartsdoer/codearts-data/log/kernel_error_*.log`：
`Args: "…AgentKernel_Vscode_….exe" "--user-agent=codearts/1.0.0-1147257973136832"`）
⇒ 与真实客户端同形（WAF 只拒 `deepseek-harness/`，版本尾段只影响指纹相似度）。

⚠️ **只改推理路径**：目录（`fetchSignedGet`）/ 积分 / 签到三条腿**不显式设置 UA**
—— 实测 Node 的 `fetch` 会补 `user-agent: node`（本机 `http.createServer` 抓头验证），
而 WAF 只拒 `deepseek-harness/` 前缀 ⇒ 本来就过 WAF，无需改动。这也正是「模型列表正常、一发消息就『API 密钥无效』」这一报障形态的由来。

### 守卫

- 单测 `tests/unit/codearts-user-agent.spec.ts`：① chat 请求 UA **逐字等于**
  `codearts/1.0.0-1147257973136832`（**字面量**，写常量会成同义反复）；
  ② **任何**出站请求都不得带 `deepseek-harness/` 前缀（逐请求点名）；
  ③ 反向对照：排队状态 GET 不带 UA 也算过（判据只拦前缀）。
  变异验证：删覆盖行 / 把常量换回宿主默认值 ⇒ 各 **2 条精确变红**。
- e2e `tests/e2e/codearts-ua-probe.e2e.spec.ts`（`pnpm test:e2e:codearts`）：
  真机断言「头 = 官方 IDE UA」+「上游真出流」，2026-11-05 通过。
  ⚠️ 单测锁不住「那个 UA 过不过 WAF」（上游策略），这条只能靠 e2e。

## ⚠️⚠️ 三个「非凭据问题」业务码：`TM.00000001` / `TM.00001041` / `TM.000010051`（2026-11-05）

### 为什么单列（Gitee PR #175 评审 + 本仓库 UA 修复的兜底）

`httpErrorCode()` 对 **401/403 恒归 `AUTH`**（铁律：先按状态码判），而客户端会把
`AUTH` 的 message **整条替换**成「API 密钥无效」（`dsh-client-ui-chat` 的
`message.failure.auth`）⇒ 三个**与凭据无关**的上游业务码全被说成「密钥无效」，
用户去重登/换 token，方向全错。且 `isAuthError(403)` 恒真 ⇒ 每次失败**白跑一次**
一次性轮换的 STS 续期。

| 业务码 | 成因 | 重试有效？ | 宿主码 | 出路 |
|---|---|---|---|---|
| `TM.00000001` | 华为 WAF 按 UA 首 product token 拒发（**不是真的繁忙**） | **否**（同 UA 恒 403） | `PERMISSION`（不可重试） | 升级插件（UA 已覆盖官方 IDE 身份，`378ffd7`） |
| `TM.00001041` | 账号级并发上限（实测每账号同时最多 3 个请求） | **是**（等 1~2 分钟即好；换账号立即解除） | `RATE_LIMIT`（可重试） | 等 / 换号 |
| `TM.000010051` | 模型未在本租户开通 | **否** | `PERMISSION` | 换模型 / 换账号 |

⚠️ **三条的码必须不同**：把 `TM.00000001` 也归 `RATE_LIMIT` 是错的 ——
宿主 `DEFAULT_RETRYABLE_CODES` 含 `RATE_LIMIT`（`maxRetries 5`）⇒ 确定性失败
白退避重试 5 次，每次打上游一次 403（与 qoder 那条「网关 5xx 白重试」同型，
只是方向相反）。

### 判据：**精确业务码 + 数字边界**（`hasBusinessCode`）

业务码是**纯数字后缀** ⇒ `body.includes('TM.00000001')` 会命中 `TM.000000011`。
本仓库已踩过同型坑（`isSseQueueErrorCode` 的 `429` 命中 `InferHub.4291.200`）⇒
现用 `new RegExp(`${code}(?![0-9])`)` 断开，且**大小写敏感**（上游恒为大写 `TM.`）。

### 边界：400 形态的排队自愈**逐字节未动**

`TM.00001041` 在 **400** 形态下仍走 `isQueueError` 的排队重试（10s × 180 次）；
新分支全部位于 `if (!isQueueError(...))` **之内** ⇒ 只作用于 **403** 出口。
⚠️ 本仓库既有 4 条用例锁着「撞上限后自动重试即成功」这条自愈能力
（`llm-adapter.spec.ts` 的 `retries the chat request after a queue error even when
the queue status is working`）—— 故本节的单测**刻意不重复**那一条
（重复只会让全量测试白慢 10 秒，守卫强度不变）。

### ⚠️ SSE 流内**不动**（PR #175 的那条改动是回归）

PR #175 把「SSE 流内 `TM.00001041`」从「进入 10s 重试自愈」改成「立即抛错」，
与它自己宣称的边界（不动自愈）矛盾：流内命中时槽位同样会在 1~2 分钟内释放，
重试是**有效**的，改成立即失败只是把自愈换成手动重发。⇒ 本仓库**不采纳**该改动。

### 守卫

- 单测 `tests/unit/codearts-gateway-classification.spec.ts`（10 条）：三条码的
  「专用文案 + 专用码 + refresh 0 次 + 不重发」；反向对照（`APIG.0602` 真凭据失效
  **仍**归 `AUTH` 且**续期一次**）；边界（`TM.000000011` 不命中 ⇒ 落回 `AUTH`）；
  互不串味；空串/非字符串不抛错。
- 变异验证（**6/6 有牙**）：删 gatewayBusy 分支 ⇒ 1 红；码改 `RATE_LIMIT` ⇒ 1 红；
  删 concurrency 分支 ⇒ 1 红；删 tenant 分支 ⇒ 1 红；删 `isAuthError` 排除 ⇒ **3 红**；
  去掉数字边界 ⇒ **2 红**。
