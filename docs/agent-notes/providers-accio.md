# Accio（阿里巴巴国际站 AI 电商工作台）provider 接入实测笔记

> 2026-10-12 起登记。基线：**Accio Work 0.34.4**（`Accio-0.34.4-20261011-1654-win_a24e060a.exe`）。
> 本文件是**实测事实**的唯一登记处；设计文档在
> `docs/superpowers/specs/2026-10-12-accio-provider-design.md`（**不入库**，本地保留）。
> 关联 issue：[Gitee IKL47K](https://gitee.com/iJetLi/deepseek-harness-codearts/issues/IKL47K)。
> 参考实现：[tidys/dsh-connect-accio](https://github.com/tidys/dsh-connect-accio) v0.2.0。

## 0. 三条与参考实现相反的结论（最重要）

参考实现（`dsh-connect-accio`）做的是：读本机 `credentials.enc`（DPAPI 解密）
+ 用 Accio 自带的 `security_guard.node` 给每个 LLM 请求签名。**本次逐条实测推翻了它的两个前提**：

| # | 参考实现的前提 | 实测结论 | 证据 |
|---|---|---|---|
| 1 | 必须读本机凭据 | ❌ **有标准 OAuth 2.0 + PKCE，可完全脱离 IDE** | §2 |
| 2 | 必须带 SecurityGuard 签名 | ❌ **不必需**，不带 `pctb-x-*` 同样成功 | §4 |
| 3 | 「Accio 没有签到接口」（如实说明、不给按钮） | ⚠️ 半对：**没有签到端点**，但**登录会触发服务端按日发放** | §6 |

⇒ 本 provider **全平台、零本机依赖、零新增 npm 依赖**：不读 `credentials.enc`、
不用 DPAPI、**不碰 Accio 安装目录**、不需要那串阿里 DLL。

⚠️ **实施阶段（Task 6，真机）又推翻了本笔记初版的第四处**（与参考实现无关，是**我们
自己照搬「同族 = Gemini」的假设**）：**`system_instruction` 必须是字符串**，
对象形态恒回 HTTP 200 + 流内 400。详见 **§4.1.1**。

## 1. ⚠️⚠️ 真缺陷一：`cmd /c start` 会把授权 URL 截断

**本次最耗时的一个坑，症状极具误导性**（三个现象全部由这一个 bug 解释）。

### 错误写法（探针最初用的）

```js
execFile('cmd', ['/c', 'start', '', url])     // ❌
```

`cmd.exe` 把 URL 里的 **`&` 当命令分隔符**，URL 在第一个 `&` 处被截断：

```
地址栏实际得到：
https://www.accio-ai.com/login?return_url=http%3A%2F%2F127.0.0.1%3A<port>%2Fauth%2Fcallback
  %3Flogin_trace_id%3D…%26launcher_timestamp%3D<ts>
                                                            ↑ 到此为止
丢失：&state=…&code_challenge=…&code_challenge_method=S256&client_id=accio-work
```

⚠️ `<port>` / `<ts>` 是占位符：这里要展示的是**截断位置**，端口与时间戳属于
**某一次实测的本机痕迹**，没有教学价值，不入库。

### 观察到的三个现象与真因

| 现象 | 真因 |
|---|---|
| 弹「**请升级客户端**」modal | `code_challenge` 丢失 ⇒ 恰好命中登录页的 legacy 客户端门禁（见 §3）|
| 弹出一个**文件管理器**窗口 | 残余片段被 `explorer.exe` 当**路径**打开（探针为兜底也调了 explorer）|
| 回调日志**完全为空** | URL 截断后 `state` / `code_challenge` 全没了，流程走不完 |

### 正确写法（不经过任何 shell）

```js
execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url])   // ✅
```

⇒ **必须加源码级回归锁**：断言实现里出现 `rundll32` 且**不出现** `cmd` + `start` 组合。
已落地在 `tests/unit/accio-oauth.spec.ts` 的「★ 防回退锁：打开浏览器绝不能用
`cmd /c start`」段（它**先切出 `openBrowser` 函数体再断言**，并对 `indexOf` 结果
先断言 `>= 0` —— 否则 `-1 < 非负下标` 恒成立，删掉目标照样全绿）。
⚠️ 该段也**逐字锁住** `execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], () => {})`
里那个空回调：`execFile` 的失败是**异步 `'error'` 事件**，而**第三个参数的回调就是它的
消费者**（传了回调 Node 才代为挂 `'error'` 监听器）⇒ **删掉 `() => {}` 会变成未捕获异常
并打挂宿主**。这一条同样是实测结论，不是风格偏好。

## 2. 登录：标准 OAuth 2.0 + PKCE（S256）

逆向 `out/main/index.js` 的 `startLoginWithCallbackMode` **逐字**：

```js
const u = `${Md("web")}/login?return_url=${encodeURIComponent(this.pendingRedirectUri)}`
        + `&state=${encodeURIComponent(this.pendingState)}`
        + `&code_challenge=${encodeURIComponent(c)}`
        + `&code_challenge_method=S256`
        + `&client_id=${encodeURIComponent(eh)}`     // eh = "accio-work"
```

| 项 | 值 |
|---|---|
| 中国版授权页 | `https://www.accio-ai.com/login` |
| 国际版授权页 | `https://zh.accio.com/login` |
| `client_id` | **`accio-work`**（**公开客户端，无 `client_secret`**）|
| PKCE | `code_verifier` = 48 随机字节 base64url；`code_challenge` = `base64url(SHA-256(verifier))` |
| `state` | 32 随机字节 hex |
| 回调 | 桌面端用 `http://<local-gateway>/auth/callback` 或 `accio://`；**代码里对 `return_url` 无白名单校验** ⇒ 我们可用自己的 loopback |

**兑换**（逆向 `exchangeCodeForToken` 逐字，实测 HTTP 200 跑通）：

```
POST https://phoenix-gw.alibaba.com/api/oauth/token
body { code, codeVerifier, clientId: "accio-work", redirectUri }
→ {"success":true,"code":"200","data":{
     "accessToken":"<32 字符，不透明串>",
     "expiresAt":1794407698,          ← ⚠️ 秒
     "refreshToken":"<128 字符>",
     "sgcookie":"<base64 串，约 112 字符>"}}
```

⚠️ **示例里的值是脱敏后的形态**（`<…>` 是占位说明）：真实值**不得**抄进本文件 ——
`accessToken` / `refreshToken` / `sgcookie` 都是凭据本体，写进长期资产就是一次泄露。

⚠️ 官方客户端自己在这里做了 `1e3 * t.expiresAt` 归一化 —— 见 §5 的真缺陷二。

**续期**：`POST /api/auth/refresh_token` `{accessToken, refreshToken}`。
⚠️ **本笔记仍未实测该端点**（见 §10 U-A）：参考实现明确记录「刷新**会轮换**
refresh_token」，测它会**作废用户本机 IDE 当前的登录态**。
⇒ 已写好**带双闸门**的探针 `tests/e2e/accio-refresh-probe.e2e.spec.ts`
（`DSH_ACCIO_REFRESH_E2E=1` + `..._CONFIRM=yes`；它现场跑本插件自己的 PKCE 登录、
凭据只进内存、**从不读**桌面端数据与池里的 `ACCIO_ACCOUNT_*`），
但**尚未运行** ⇒ U-A 的答案仍是「未验证」，**不要**照参考实现当结论用。
实现侧已按「会轮换」的最坏假设做了防御（`accio-auth.ts` 的 per-ref `SerialQueue`、
判终态前重读凭据、判据读凭据而非池里的 `refreshable`）。

## 3. 登录页的「请升级客户端」门禁（legacy 客户端判据）

真源是登录页 bundle **`kiIt5C4K.js`**（`/login-csr.js` 的传递依赖；**不在 asar 里，在 CDN 上**）：

```js
const d = "/login/redirect"
const f = { "accio-work": {displayName:"Accio Work"}, wren_extension:{…}, ma:{…} }
const U = new Set(["127.0.0.1", "localhost"])
function m(r){ const n = new URL(r); return n.protocol==="http:" && U.has(n.hostname) }
function s(r){ return ["phoenix:","accio:"].includes(proto) || m(r) }   // 「本地回环」
function S(r){ return s(n.return_url) && !n.code_challenge }            // ← 弹窗判据
function b(r){ return known(client_id) && e ? 跳 `${origin}/login/redirect?${原query}` : q(r) }
```

⇒ 门禁拦的是**旧版客户端**（旧版不做 PKCE ⇒ `return_url` 指向本地却**没有** `code_challenge`）。
**带 `code_challenge` 的合法客户端不该被拦** —— 我们那次被拦，正是 §1 的 URL 截断造成的。

⚠️ **不要**把这个 modal 当成「Accio 不支持第三方登录」的证据。
它也不影响后端：用户删掉 modal 后点「继续」流程照样走完（服务端不校验版本）。

⚠️ 埋点名是 `legacy_client_upgrade_modal_shown` / `legacy_client_upgrade_prechecked` ——
搜「版本门禁」时用这两个词才找得到。

## 4. ★★ 推理端点：**不需要 SecurityGuard 签名**

### 4.1 权威请求形状

来源：`out/main/gateway-worker.js` 的 `streamGenerateContent`（逐字）。
⚠️ **`generateContent` 只在 gateway-worker 里，`index.js` 里 0 处命中** ——
搜实现时别只扫 `index.js`。

```
POST {gateway}/api/adk/llm/generateContent?sg_k={md5(requestId)}
  gateway = https://phoenix-gw.alibaba.com
  baseUrl = {gateway}/api/adk/llm                     // 常量 aee
  sg_k    = md5hex(requestId,'utf8')                  // Kt() 逐字
headers: Content-Type: application/json
         Accept: text/event-stream
         utdid:   <设备 id>
         version: <客户端版本>
         appKey:  'OneChat'                           // 常量，非产品名
```

**请求体**（Gemini 风格，键名 snake_case）：

```jsonc
{
  "model": "<modelCode>",
  "empid": "", "tenant": "", "iai_tag": "",      // ⚠️ 必须空串
  "request_id": "req-<ts>", "user_request_id": "req-<ts>",
  "contents": [{"role":"user","parts":[{"text":"hi"}]}],
  "system_instruction": "……",                    // ⚠️⚠️ **字符串**，不是 {parts:[…]}！见 §4.1.1
  "tools": [{ "name": "…", "description": "…", "parameters_json": "<JSON Schema 字符串>" }],
                                                 // ⚠️⚠️ **扁平形态**，不是 {function_declarations:[…]}！见 §4.1.2
  "temperature": 0, "max_output_tokens": 32, "stop_sequences": [],
  "properties": {"utdid":"…","version":"0.34.4","appKey":"OneChat","normalized_response":"true"},
  "token": "<accessToken>",                       // ★ 见 4.2
  "message_id": "<md5hex(requestId+random)>",     // ⚠️ 必填，缺则 400
  "incremental": true
}
```

#### 4.1.1 ⚠️⚠️ `system_instruction` 是**字符串**，不是 Gemini 的 `{parts:[…]}` 对象

**本笔记初版写错了这一格**（照搬 Gemini 的 `systemInstruction.parts` 形态），
Task 6 真机实测推翻：**对象形态恒回 `HTTP 200` + 流内 `400 Invalid request format`**。
（`src/accio-adapter.ts` 的 `buildAccioBody` 初版就是这么写的，commit `3034d03` 修正；
`tests/unit/accio-product.spec.ts` 同步锁定**字符串**形态。）

**权威证据**（官方 proto，`out/main/gateway-worker.js` 逐字）：

```js
systemInstruction: gt(e.systemInstruction) ? globalThis.String(e.systemInstruction)
                 : gt(e.system_instruction) ? globalThis.String(e.system_instruction) : ''
```

两处都用 **`String()`** 归一；诊断路径的判据同样是
`typeof t.system_instruction === 'string' ? t.system_instruction : ''`。

⇒ **Accio 与 Gemini 在这一格上不同形**。照搬 Gemini 会得到一个
「HTTP 200 但流内 400」的静默失败 —— 而 400 又会被误读成「参数错」而非「形状错」。

⚠️ **教训（可推广）**：本 provider 与 Gemini 同族的是**信封骨架**
（`contents` / `parts` / `thought` / `usage_metadata`），**不是每一个字段**。
「同族」只能作为**起点**，逐字段仍要拿官方 proto 核对 —— 否则会把
「相似」当成「相同」，而失败的形态恰好是最难查的那种（200 + 流内错误码）。

**响应帧**（实测）：

```json
{"content":{"role":"model","parts":[{"text":"The","thought":true}]},"partial":true,
 "raw_response_json":"{\"choices\":[{\"delta\":{\"reasoning_content\":\"The\"},…}]}"}
```

⚠️ **形状要点**：`content` / `usage_metadata` 在**顶层**（**不包在 `candidates[]` 里**），
与标准 Gemini 不同 ⇒ 需要一层**薄归一化**才能复用 `src/gemini-messages.ts` 的
`consumeGeminiSse`（那时 `content` 会被当作 `inner`，但它找的是 `inner.candidates` ⇒ 命中不了）。

#### 4.1.2 ⚠️⚠️ `tools` 是**扁平**形态，不是 `{function_declarations:[…]}`

**本笔记初版把这一格写成了包装形态**（`"tools": [{"function_declarations":[ … ]}]`，
那是照 Gemini 的形状推断的），**实测与实现都是扁平的**：

```jsonc
// ✅ 实测被上游接受的形状（`src/accio-messages.ts` 的 `toAccioTools` 产出，
//    经 `src/accio.ts` 的 `accioToSnake` 后键名变 snake）
"tools": [
  { "name": "read_file",
    "description": "Read a file from disk.",
    "parameters_json": "{\"type\":\"object\",\"properties\":{\"file_path\":{…}},\"required\":[\"file_path\"]}" }
]
```

**证据（间接，但成立）**：Task 6 的两支真机探针 `probe-tool-shards.mjs` /
`probe-tool-merge.mjs`（见 §9）用的**正是扁平形态**（`parametersJson` 字符串），
上游回的是真实 `function_call` 帧 —— `task-6-report.md` §4.2 逐字记录：

```
frame#8  {"function_call":{"id":"call_c3a3…","name":"read_file"}}                              ← 首帧无参数
frame#9  {"function_call":{"id":"call_c3a3…","name":"read_file","args_json":"{\"file_path\":…}"}}
frame#10 {"function_call":{"id":"call_c3a3…","name":"read_file","args_json":"{\"file_path\":…}"}}
```

上游**按我们下发的 `name` 回了一个同名工具调用、且参数键与 schema 里的 `file_path` 对得上**
⇒ 扁平形态**被接受且被正确理解**。⚠️ **探针本体在 `.tmp-accio/`（已 gitignore）且没有日志留存**，
故这条属「**已验证但证据未留存**」，不是「未验证」（§10 把两者分开登记）。

⚠️ **包装形态没有被实测过**（既没证伪也没证实）。**不要**因为「官方 proto 里是
`function_declarations`」就切过去：那是**官方客户端内部对象 → wire** 的转换结果，
wire 上真正被接受的是上面这个扁平形状。切换是**未验证的改动**，而且会顺带激活下面这个隐患。

##### ⚠️ 为什么参数名是安全的（这一条关掉了「包装形态」的隐患）

`toAccioTools` 把**整份 JSON Schema 序列化成字符串**放进 `parameters_json`：

```ts
parametersJson: JSON.stringify(fn.parameters ?? { type: 'object', properties: {} })
```

而 `accioToSnake`（`src/accio.ts`）**不下钻字符串** —— 它只对数组与对象递归，
字符串原样返回。⇒ **工具参数名（`filePath` / `oldString` …）是「数据」，不在改写路径上**，
无论驼峰还是下划线都**逐字节**送到上游，与模型据 schema 生成的 `args_json` 键天然一致。

⚠️⚠️ **反过来说：这正是「必须保持字符串化」的理由。** 若改成包装形态并把 schema 写成
**对象**（`{ function_declarations: [{ name, parameters: { properties: { filePath: … } } }] }`），
`accioToSnake` 就会**递归下钻到 schema 内部**，把参数名 `filePath` 静默改写成 `file_path` ——
模型看到的是 `file_path`、生成的 `args_json` 也是 `file_path`，但**其它任何按原 schema
消费这份定义的地方（含调用方自己的校验）会对不上**，且**没有任何报错**。
本仓库把这类缺陷登记为「同一份语义两处判据」，这里则是「**schema 被当协议字段改写**」。

⇒ `src/accio.ts` 的 `buildAccioBody` tools 区域已就地写下这条警告（改 schema 前先读它）。

### 4.2 ★ 两个变量各自独立验证过

**四格矩阵**（模型 `1Drift-N8kP2Q7wR5mX`，倍率 0.013，`max_output_tokens=32`）：

| # | 签名 | token 位置 | 结果 |
|---|---|---|---|
| 1 | ❌ | **body** | ✅ **HTTP 200 + 真实内容帧** |
| 2 | ❌ | `Authorization: Bearer` | ❌ 流内 `{"error_code":"402","error_message":"unauthorized"}` |
| 3 | ✅ | body | ✅ HTTP 200 + 内容帧 |
| 4 | ✅ | `Authorization: Bearer` | ❌ 同上 402 |

⇒ **签名不必需**（由「1 vs 3」这对干净对照支撑）；
**token 必须在 body 的 `token` 字段**（由「1 vs 2」支撑）。

⚠️ **`sgcookie` 的必需性是另一回事** —— 上面四格**全部带了** `sgcookie`
（探针把它写在公共路径上），故**那一轮不能回答它**。补做的干净对照
（唯一变量 = sgcookie，两者都不带签名、token 都在 body）：**带 ✅ / 不带 ✅**
⇒ `sgcookie` **也不必需**。

⚠️ **但设计仍保留并带上它**：保留零成本，删除是单向下注（上游哪天收紧就整体失效）。

⚠️ **教训（可推广）**：写对照矩阵时**必须检查每个变量是否真的独立** ——
把某个赋值写在公共路径上，会让「所有格子」共享它，从而**静默地**让该维度失去对照。
「四格都成功了」不等于「四个变量都被验证了」。

### 4.3 判「成功」的口径

⚠️ **不能只看 HTTP 200** —— 第 2/4 格就是 **HTTP 200 + 流内 `error_code: 402`**。
必须同时检查：

1. 有 `content.parts` **且**有 `text`；
2. **无** `error_code`。

漏掉第 2 条会把「认证失败」读成「模型返回空内容」。

### 4.4 SSE 与工具调用

- `data:` 单行 JSON 帧；`[DONE]` 或流结束收尾。
- 思维链：`parts[].thought === true` ⇒ 映射到 **`reasoning`**，**不得混入正文**。
- 工具调用：`parts[].function_call`；⚠️ **响应是 snake_case（`args_json`），
  请求是 camelCase（`argsJson`）** —— 参考实现记录「读 camelCase 名会静默得到 0 个工具调用」。
- ⚠️⚠️ **工具调用分片到达，且共享消费者 `consumeGeminiSse` 不合并**（Task 6 实测）：
  上游把**一次**调用拆成多帧（首帧 `{id,name}` 无参数，后续帧**重复完整的**
  `args_json`）。`consumeAccioSse` 对每个 `functionCall` part 各产出一个**独立**的
  tool-call 块 ⇒ 一次调用会变成 **N 个块**（首个参数 `{}`），harness 会**执行 N 次**。
  ⇒ **合并职责归适配器**（设计如此）：`accio-adapter.ts` 的
  `accioToolCallMergeTransform`。E2E 探针 `test:e2e:accio-tools` 专门断言
  「同一个 id **恰好一个块**且参数**非空**」。

### 4.4.0 ⚠️⚠️⚠️ 「思考一下就中断」：终帧被管线**双重丢失**（2026-10-13 深夜 wire 探针定罪）

> **用户报障「accio 思考一下就中断」（DSH 直连与 ZCode 双侧复现）的根因。**
> 症状：模型思考一段后轮次**显示正常完成**（`completed`），无正文、无工具调用、
> 无任何报错，usage 全零。用户反复发「继续」也救不回来。
> 第一轮修复（顶层 `function_call` / 无 `content` 终帧）上线后**仍复发**——
> wire 探针（`.tmp-accio/probe-wire-frames.mjs`，三格：无工具 / 1 工具 / 73 工具）
> 抓到原始帧才定罪：**工具帧与终帧其实都到了**，是管线内部把它们丢了。

#### wire 实测的真实帧形状（与此前所有推断的关键差异）

1. **`function_call` 在 `content.parts` 里**（不是顶层）——frame#13
   `{content:{parts:[{function_call:{id,name}}]}}`，frame#14 补 `args_json`。
   之前「顶层 function_call」的假设**不成立**（第一轮修的分支无害但非根因）。
2. **终帧把最后一个工具分片与元数据放在同一帧**：frame#14 =
   `{content:{parts:[{function_call:{…,args_json}}]}, turn_complete:true,
   usage_metadata:{…}, finish_reason:"STOP"}`。
3. **流没有 `[DONE]`**，终帧就是最后一行（带换行）。
4. 纯文本轮次的终帧是 `{content:{role:"model"}}`（**有 content 无 parts**）。

#### 双重丢失链（两处缺陷叠加）

> ⚠️ **本小节初版写「缺一都修不好」——该归因已被四格矩阵实测证伪，
> 见 §4.4.0.1「一条被证伪的 PR 声明」**：修复②是症状的必要且充分条件，
> 修复①只影响 usage 计量。两处都值得修，但别把它们写成同等的因。

```
终帧（最后一个分片 + usage/finish 同帧）
  → ① 合并层 accioToolCallMergeTransform：看到 function_call 就吸收进 pending，
    flush 只吐工具 part ⇒ usage/finish 元数据被吞（→ 用量恒归零）
  → ② 归一化层 consumeAccioSse 的 flush：合并层产物不带尾换行 ⇒ transform
    把尾行留在 buffer ⇒ flush 原样裸透（不归一化）⇒ consumeGeminiSse 收到
    无 candidates 的顶层帧 ⇒ 当纯 usageMetadata 帧 ⇒ 工具/usage/finish 全丢
  → 流里只剩思考 ⇒ mapGeminiFinish(undefined, 0) 兜底 stop ⇒ 轮次「正常完成」
```

#### 修法（两处必须一起改）

1. **合并层**：吸收工具 part 时把帧上的 `turn_complete`/`usage_metadata`/
   `finish_reason` 暂存（`frameMetaOf` 只抽这三键，不透传整帧——`raw_response_json`
   体积大且无关）；flush 时拼进合并帧（与上游原形一致）。多帧带元数据时后者覆盖
   （终帧 usage 是最终值，与消费侧「取最大 total」语义一致）。
2. **归一化层**：`flush` 的尾行必须走**同一条 `processLine` 归一化路径**，
   绝不裸透传。错误帧判据与归一化抽成 `processLine` 共享（transform 与 flush
   共用，`pendingError` 提到外层）。

#### 验证

- **真实 wire 帧驱动完整管线**（`.tmp-accio/wire-*.txt` 三格）：修复前
  工具 0 块 / usage 全零 / 兜底 stop；修复后 1 工具块 + 真实 usage
  （input 301 / output 36 / reasoning 13）+ `tool-calls`；纯文本两格拿到
  真实 usage + 正常 stop。
- 回归测试 `tests/unit/accio-messages.spec.ts`（「终帧与最后一个工具分片同帧 +
  流无 [DONE]」组 2 条）；反向验证：回退两处修复 ⇒ 恰好 2 条变红。
- 全量 323 文件 / 7909 passed。

#### ⚠️⚠️ 方法论教训（比第一轮的教训更狠）

- **「会话日志只存插件产出后的 StreamChunk」意味着：推断「帧没到」与「帧到了
  被丢」在日志里**同形**——必须抓 wire 帧才能分辨。第一轮修复基于「usage 全零
  ⇒ 终帧没到」的推断，方向就错了**一半**（终帧到了，死在合并缓冲里）。
- **修完必须用真实流量回归**：第一轮修复全量测试 7907 绿、反向验证过，
  但测试喂的都是**自造帧**（带 `[DONE]`、终帧不带工具分片）——真实形状
  （无 `[DONE]`、分片与元数据同帧）一条用例都没覆盖。**自造帧永远要对着
  wire 抓包核对一遍。**
- **TransformStream 的 flush 是独立代码路径**：transform 处理「完整行」，
  flush 处理「尾行」——两条路径必须跑**同一个**处理函数，否则尾行行为分叉
  （本例：尾行不归一化）。写任何行缓冲 TransformStream 时先问一句：
  「flush 里的尾行走的路径与 transform 一致吗？」

### 4.4.0.1 ⚠️⚠️⚠️ 双审计修正：**新增的改写分支自己犯了同一类错**（2026-10-13 深夜）

> 本节 §4.4.0 的修复方向正确（真实 wire 形状确实由它修好），但**新增的
> 「顶层 `function_call` 改写」自己引入了 9 处缺陷**，其中一处比原缺陷更坏。
> 由**常规审计 + 对抗性审计**两轮独立跑出，**逐条经父 agent 用 master/PR 同进程
> A/B 复核**（所有结论均为实测，不是读代码推断）。

#### 根因：改写跑在**错误判据之前**，且是**替换式**而非加性

`accioToolCallMergeTransform` 在 `consumeAccioSse` **之前**，而
`accioErrorFrame` 的判据在后者内部。初版改写**新造**了一个只含
`content.parts` 的帧 ⇒ 帧上其余顶层字段全丢 ⇒ 判据的**输入**被毁掉。

| # | 缺陷（初版） | 实测（PR 初版 vs master 基线） | 修法 |
|---|---|---|---|
| 1 | 错误帧被**吸收** ⇒ `error_code` 丢失 | `error_code:402` + 工具同帧：基线**抛 QUOTA_EXCEEDED**，初版**静默返回工具调用成功**（额度失败反转成成功） | 错误帧**原样透传**（复用 `isAccioErrorFrame`，判据只此一处） |
| 2 | `function_call:null` **裸 TypeError** | 基线 `text="甲乙丙"`；初版 `THREW TypeError` 且**同 chunk 已产出的正文全丢**（`transform` 抛在 `enqueue` 之前），且 TypeError 不是 `LlmError` ⇒ 不可重试 | `absorbCallParts` 加对象守卫（与 `normalizeAccioPart` 同口径） |
| 3 | 参数只认 snake `args_json` | camel `argsJson` / 对象 `args` ⇒ **静默清空为 `{}`**（模型以为执行了，实际空参数） | 抽出 `accioArgsTextOf`，三形态同口径 |
| 4 | `candidates` 帧被改写吞掉 | 基线 `text="标准正文"`；初版 `text=""`（两层判据不一致） | 加 `!Array.isArray(frame.candidates)` 守卫 |
| 5 | `content` 有值但**无 parts** 时漏判 | `{content:{role}}` + 顶层 call ⇒ 工具**静默丢弃**、`finish=stop`（= 「思考一下就中断」原症状；**PR 文档 §4.4.0 自己记录了该形状**） | 触发条件改为「`content.parts` 不是数组」 |
| 6 | `anon-${pending.size}` 键撞车 | 显式 `id:"anon-1"` + 无 id 调用 ⇒ **两个调用被误合并成一个**、参数串接成非法 JSON | `anonKey()` 跳过已占键 |
| 7 | usage **字段级后覆盖先** | 终帧 total 偏小（336→4）⇒ 取**偏小**值、`inputTokens`/`cacheReadTokens` 全丢；终帧 `{}` ⇒ usage 全零。**同一批数据走透传路径却键完整** ⇒ 合并路径比消费侧更弱 | `mergeFrameMeta` 取**最大 total**（与 `noteUsage` 同口径）+ 收敛到一个 usage 键 |
| 8 | `normalizeAccioFrame` 无名 call **连坐**丢 usage/finish | 同一个「无名 part + MAX_TOKENS + usage」：在 `content.parts` 里得 `max-tokens`，在**顶层**得 `stop` ⇒ **MAX_TOKENS 伪装成正常结束** | 丢调用后**继续走**下面的 usage/finish 分支 |
| 9 | 测试：`finish` 抽取**零守卫** | 删掉 `frameMetaOf` 的 `finish_reason` 抽取 ⇒ 118 条用例**全绿** | 补被测行为用例 |

#### 第二轮（对抗验证）又查出 2 处 —— 都是「注释自称同口径、代码不是」

| # | 缺陷 | 实测 | 修法 |
|---|---|---|---|
| 10 | `args_json: ""` **不回退**到 `args` 对象 | 空串是字符串 ⇒ `typeof raw === 'string'` 直接 return，**永不回退**；同一帧归一化层得 `{"file_path":"a.txt"}`、合并层得 `{}` ⇒ **两层判据不一致**，且正是「静默空参数」 | `&& raw !== ''` |
| 11 | `mergeFrameMeta` **首份双 usage 键**早退 | `prev === undefined` 时直接 `return {...next}` ⇒ 两个 usage 键**都被保留** ⇒ 归一化层恒取 snake ⇒ **陈旧小值胜出**（snake total=10 / camel total=3100 ⇒ 得 10） | 收敛逻辑覆盖首份，只留**单一** `usage_metadata` 键 |

⚠️ 另登记一处**刻意保留**的已知损失（不修，但要写准）：
被**吸收**的工具帧最终由 `flushPending` **重新合成** ⇒ 原帧 `content` 内的
**非 `parts`** 字段（上游附加键）不会出现在合成帧里。实测**不影响下游**
（消费侧只读 `content.parts` / `usageMetadata` / `finishReason`），故**刻意不为它
增加元数据通道**；若将来上游出现消费侧真正要读的 content 级字段，**必须**在此接上。

⚠️ 以及一处**刻意设计**（不是丢失）：错误帧**之后**跨 chunk 的帧不会交付
（下一层抛出后流即终止 = 「流内错误 ⇒ 整条流作废」）；与错误帧**同 chunk** 且
在其后的帧会交付，错误帧**之前**的帧一定交付。

#### ⚠️⚠️ 两条方法论教训

- **「修同一类缺陷」时要问：我的新代码是否犯了同一类错？** 本 PR 的叙事是
  「终帧语义不得被管线吞掉」，而它新增的改写层**第一件事就是吞掉帧上的语义**
  （`error_code`）。**修缺陷的代码必须接受与缺陷同等的审查强度。**
- **`master/PR` 同进程 A/B 是定性的唯一可靠手段**。只跑 PR 自己的用例会漏掉
  净回归：初版 118 条全绿，而同一输入在 master 上**行为正确**（会抛错）。
  ⇒ 判「是不是回归」必须**两侧都跑**，不能只看修复侧。

#### ⚠️ 一条被**证伪**的 PR 声明

PR 文档 §4.4.0 写「两处缺陷叠加，**缺一都修不好**」。四格矩阵实测
（A=PR+PR / B=旧合并层+PR消费层 / C=PR合并层+旧消费层 / D=都回退）：

```
A = calls=[get_current_time] usage={301,36,337,r13} finish=tool-calls
B = calls=[get_current_time] usage={0,0}            finish=tool-calls   ← 只缺①
C = calls=[]                 usage={0,0}            finish=stop         ← 只缺②
D = calls=[]                 usage={0,0}            finish=stop
```

⇒ **修复②（flush 不裸透）是「思考一下就中断」的必要且充分条件**；
**修复①只影响 usage 计量**（缺它时工具调用照常到达、轮次会正常继续，用户
看不到中断）。①确实修了「用量恒归零」这个真缺陷，但把它写成症状的必需条件
是**过度归因**。

#### 回归测试（本条新增 17 条，逐条反向验证）

`tests/unit/accio-messages.spec.ts` 三组：「错误帧绝不可被合并层吸收」4 条、
「畸形帧只跳过、参数三形态同口径」6 条、「漏判的帧形状与 usage 合并语义」7 条。

⚠️ **11 处修复逐条做了反向验证**（每处单独回退 ⇒ 各自 ≥1 条变红）：
M1=3 条、M2=1、M3=3、M4=2、M5=2、M6=1、M7=1、M8=1、M9=3、M10=1、M11=1。
⚠️ 其中 **M2 与 M8 的第一次尝试零红**：`content.parts` 内的 `null` 与
「无名顶层 call」两条路径**必须直测纯函数/对应入口**——走端到端时会被上层
（改写分支补 `id`、合并层补 `anon-N`）**遮蔽**，用例看着在测、实际测不到。
⇒ **「有守卫」必须用变异证明，不能靠用例标题**。
⚠️ 同名的两条「无名 call 不连坐」用例中，**端到端那条是回归锁而非防线**
（合并层会补 `id` ⇒ 命不中「无名」分支，变异下照绿）；真正守门的是**纯函数版**。
用例标题里已注明，避免下一个人误判。

⚠️ **两轮审计的定性口径不同，别混用**：第一轮（常规 + 对抗）的 9 处里只有
**修复 1、4、5** 是 PR **新引入的净回归**（master 上行为正确）；2、3、6、7
是**既有缺陷被新路径放大/暴露**；8 是**既有的同类残留**。判定「是不是回归」
必须 **master/PR 同进程 A/B**，只跑修复侧会漏判。

### 4.4.1 ⚠️⚠️ 档位**真实生效**，但思考**关不掉**（2026-10-13 大修）

> **本节原先的结论「四类字段全部无效 ⇒ 目录里不声明任何档位」已被推翻一半。**
> 原文（保留作对照）：`includeThoughts` / `thinkingBudget` / `thinkingLevel` /
> `reasoningEffort` 四类字段逐格实测「思考字符数一个都没变」。

#### 为什么旧结论不可靠（两个方法论错误）

1. **用的值是非法档位**：旧探针试的是 `off` / `none` / `minimal`，而远端下发的
   合法档位只有 `low` / `medium` / `high` / `xhigh` / `max`。**用非法值测出
   「无效」，不能推论合法值也无效**（`off` 回 505 正说明服务端**在校验**它）。
2. **拿「思考字符数」当判据**：实测同一档位内的字符数波动 **186 ~ 490**
   （信噪比太低），档位差异被噪声淹没 ⇒ 必然得到「看不出区别」。

#### 重做后的实测结论（用户要求「用远端真实下发的档位」）

用 **服务端权威计数** `thoughts_token_count`（`usage_metadata` 里），
对档位最多的 `Ultimate`（5 档）每档跑 5 次：

| 档位 | thoughts_token_count（5 次） | 中位 |
|---|---|---|
| `low` | 10, 33, 33, 34, 41 | **33** |
| `medium` | 18, 37, 40, 42, 49 | **40** |
| `high` | 22, 34, 41, 44, 44 | **41** |
| `xhigh` | 38, 40, 43, 44, 47 | **43** |
| `max` | 37, 41, 43, 48, 50 | **43** |

⇒ **中位数单调递增**（33→40→41→43→43）⇒ 档位**真实生效**。
⇒ 另外 `Standard`（2 档）的 `low`(中位 178) 与基线(284) 区间不重叠，交叉验证成立。

⚠️ 但仍然**关不掉**思考：即使 `low` 也有 33 个思考 token（不是 0）。
⇒ 「关不掉」这半边**依然成立**（会话命名仍走 `planSessionTitleThinking` 的抬预算兜底）。

#### 远端字段的真实形状（38 条全量探测）

| 形态 | 条数 | 处理 |
|---|---|---|
| `reasoningEfforts = null` | **31** | 见下 |
| 数组(2 档) | 4 | 全列 |
| 数组(3 档) | 2 | 全列 |
| 数组(5 档) | 1 | 全列 |

⚠️ **没有「只有一档的数组」** —— 但**有 6 条 `efforts=null` 却给了
`defaultReasoningEffort`**（`GLM-5.3`/`GLM-5.2`/`GLM 5.3 Flash` = `max`、
`DeepSeek V4.1 Flash`/`DeepSeek V4 Pro` = `high`、`MiniMax M3` = `adaptive`）。
实测**把这些值发过去服务端接受**（`max` 与 `adaptive` 都返回正常正文）
⇒ 它们就是**真实可用的单档**，正是用户要的「即使只有一档也要显示」。

⇒ 落地在 `accio-adapter.ts` 的 `accioReasoningOf`（三格判据）+ `toCatalogEntry`；
解析在 `accio-auth.ts` 的 `normalizeAccioModel`。9 个模型有档位、6 个如实留空。

#### ⚠️ 但两条**不受本次推翻影响**的旧结论（仍然有效）

1. **会话命名仍走 `planSessionTitleThinking` 的抬预算兜底**（issue IKKVDH）——
   因为「关不掉思考」这半边成立（`low` 也有 33 个思考 token）。声明档位**不改变**
   这一点：档位只调**多少**，不能调到 0。
2. **两个花钱的 E2E 探针的 `maxOutputTokens` 取 256 而非 64** —— 实测短回答的
   思考本身就要吃掉几十个 token，64 会让「有思考、没正文」的假失败混进来。

### 4.4.2 ⚠️⚠️ `utdid` 必需：不带会被**风控拦截**（HTTP 200 + HTML）

**本轮最意外的发现**，与档位探测同批测出。

| `utdid` 形态 | 结果 |
|---|---|
| 真实值（`properties.utdid` **且** header `utdid`） | ✅ 正常 |
| **自造随机值**（同上两处） | ✅ 正常（⇒ 生产兜底 `FALLBACK_UTDID` **安全**） |
| **完全不带** | 🚫 风控 |
| **只放 header、不放 `properties.utdid`** | 🚫 风控 |

⇒ **必须在 `properties`（body）里**；只放 header 不算。

**风控响应的形态**（⚠️ 极难发现）：

- **HTTP `200`**（不是 4xx）；
- `content-type: text/html;charset=UTF-8`；
- body 是跳转脚本：`<a id="a-link" href="https://bixi-intl.alicdn.com/punish/…">`
  + `window._config_ = {"action":"deny",…}` + `<!--rgv587_flag:sm-->`。

⚠️ **不给 `content-type` 校验的后果是静默的**：该 HTML 会被喂给 SSE 解析器
⇒ **零帧** ⇒ 最终报「模型未返回任何内容块」。用户看到「模型不回复」，
真因却是**风控**，排查方向完全错 —— **本轮探测就被它误导过一轮**
（「思考字符恒为 0」一度被读成「档位无效」）。
⇒ 已在 `accio-adapter.ts` 的 `stream()` 里加 `content-type` 校验，归 `SERVER`
（**不重试**：风控是身份/环境问题，原样重发只会再被拦）。

⚠️ **目录端点（`/api/llm/config/v2`）不带 `utdid` 也正常** ⇒ 该约束
**只在推理路径上**暴露，这正是它难被发现的原因。

### 4.5 为什么复用 `consumeGeminiSse` 而不是重写

Accio 与 Gemini 是**同一族协议**（信封 + `content.parts[]` + `thought` + `usage_metadata`）。
用户裁定：**复用 `consumeGeminiSse`，但不共用 gemini 的 provider 配置**。

⚠️ `consumeGeminiSse` 里的逻辑**全是踩坑换来的**，重写必然重新踩：

1. `readWithIdleTimeout` —— 裸 `reader.read()` 在上游长时间不 flush 时**无限期挂起**（「永远转圈」）；
2. 结束时**先 flush 解码器**、再把余量按整行走一遍 —— 否则**最后一条事件被丢弃**；
3. `noteUsage` 取**最大** `totalTokenCount` —— 上游多帧重复播报且早期帧偏小；
4. 工具调用**独占一块**、参数一次性发完；
5. **空响应必须抛错** —— 静默结束会让 harness 认为「正常回答但没内容」，**不会重试**；
6. 跳过注释行心跳（`:` 开头）。

⚠️ **不共用 provider 配置**：`gemini-messages.ts` 是**协议层**，不含 gemini 的
OAuth / 项目号 / 配额语义；accio 不 import `gemini-product.ts` / `gemini-auth.ts` /
`gemini-credits.ts`，也**不复用** `GEMINI_GENERATE_PATH`（那是 Cloud Code 的路径）。

⚠️ **Accio 与 Qoder 同属阿里但协议完全不同**（别照着 Qoder 写）：
Qoder 是 OpenAI 风格 + WASM **加密** body（`api2.qoder.sh`），
Accio 是 Gemini 风格**明文**（`phoenix-gw.alibaba.com`）。同属一个集团 ≠ 同协议。

### 4.6 ✅ 图片通路（2026-10-14 接线，issue IKLR7V）—— U-D 由此验证

**结论：上游原生收图**，且接线已完成。这一节是 U-D 那个「未验证项」的答案。

#### ① 上行形状（真机实测，四色全对）

图片放在 **Gemini 风格的 `parts[].inline_data = { mime_type, data }`**，与既有
`contents` 信封**同构**。本仓库产出 camelCase `inlineData`，由 `buildAccioBody` 的
`accioToSnake` 转成 `inline_data`（⚠️ **绝不能**把图塞进 `properties` 子树 ——
那棵子树刻意不参与 snake 转换）。

⚠️ 手写探针（**不经适配器**）与端到端探针（**经生产 `stream()` 全链路**）都跑了：
两者都是 HTTP 200、流内零错误帧、**四色全对（红/绿/蓝/白 4/4）**。

#### ② ⚠️⚠️ 最重要的实测结论：`multimodal:false` 的模型**不报错，而是静默忽略图片**

逐个模型对照（16×16 四象限色块图）：

| 目录声明 | 实测 |
|---|---|
| `multimodal: true`（Qwen 3.8 27B / Qwen 3.8 Flash / DeepSeek V4.1 Flash） | **3/3 四色全对** ⇒ 真收图 |
| `multimodal: false`（GLM 5.1 / GLM-5.3 / Qwen 3.5 A3B） | **3/3 未认图**：GLM-5.3 与 Qwen 3.5 A3B 明说「没看到图片」；**GLM 5.1 幻觉**出「黄色，红色，绿色，蓝色」 |

⇒ 这就是「`false` 必须写成 `['text']`（明确不支持）、**不能省略**」的依据：
省略 = 未知 ⇒ DSH 放行图片 ⇒ 上游**静默忽略** ⇒ 用户拿到一份**基于幻觉的、
看起来完全正常的回答**。写 `['text']` 则让 DSH 在**附件准入阶段**就拒掉。

⚠️ **同一条判据在适配器里还有第二处落点**（纵深防御）：`stream()` 里若
`supportsImage !== true` 就显式抛 `UNSUPPORTED_CONTENT`。两处**必须同向** ——
只改一处会退化成「准入放行、适配器再拒」这种**每次带图白撞一轮**的形态。

#### ③ `multimodal` 字段**可信**（issue 留的那个「仍需抽查」已抽查）

远端 38 条原始行、其中 15 条可见：**`multimodal` 从不缺失**（`Object.hasOwn` 全命中），
取值只有 `true`(10) / `false`(5)，无其它形态；且与兜底表的 `supportsImage`
**逐条 100% 一致**（0 条不一致）。

⚠️ 但**「从不缺失」是 2026-10-14 的快照**，不是协议保证：`normalizeAccioModel` 仍是
二值投影（`row.multimodal === true`），字段若某天缺失会落成 `false`
⇒ **退化成「明确不支持」而不是「未知」**。届时的症状是「图片能力被静默关掉」，
排查入口就是本节这张表。

#### ④ 落点（四处，缺一不可）

| 文件 | 改动 |
|---|---|
| `src/accio-messages.ts` | 新增 `accioUserParts`（含 `tool-result` **递归**）；`serializeAccioMessages` 增可选的 `images` 参数 |
| `src/accio-adapter.ts` | `toAccioWireMessages` **保留图片块**（顶层 + 工具结果内嵌**提升到 `role:'tool'` 之后**，同 trae 的 `flushToolImages` 范式）；`stream()` 由「发现即抛」改为「收集 → 能力门禁 → 读字节」；`toCatalogEntry` 按逐模型声明模态 |
| `src/index.ts` | 接上 `readImage` / `readImageRequest` |
| `ACCIO_IMAGE_PIXEL_BUDGET` | 由**死常量**变成真的生效（经 `projectRequestImage` 投影，拿不到才回退原图） |

⚠️ **工具结果内嵌图片不能就地并进 `functionResponse`**：它只吃 `responseJson`
（一个字符串），没有承载图的位置。沿用 trae 的范式挂到 `role:'tool'` **之后**
并带一句上下文说明（否则模型看到一张**没有来路**的图）。

#### ⑤ 连带解决：聚合带图时候选表里**不再缺 accio**

issue 把这一条描述为「本机给 accio 打了 `NO_IMAGE` 硬标记」，但**全仓搜 `NO_IMAGE`
零命中** —— 真实机制是：`inputModalities` 恒省略 ⇒ 聚合的 `capabilityOf` 里
`imageCapable = inputModalities?.includes('image') === true` 折算成 `false`
⇒ `imageTargets` 把每个模型都过滤掉。**效果等价，机制不同**。
接线后视觉模型自然进候选表（`tests/unit/accio-adapter.spec.ts` 有一条按聚合
**逐字同一表达式**求值的守卫），纯文本模型仍被剔。

#### ⑥ 反向验证（7 个变异，逐个被点名用例杀死）

| 变异 | 杀死它的用例数 |
|---|---|
| 序列化不产 `inlineData`（回到只推文本） | 6 |
| 杀掉 `tool-result` 递归 | **1**（判别用例） |
| `multimodal:false` 退回省略 | 1 |
| 未知 id 退回省略 | 2 |
| 删掉模型能力门禁 | 2 |
| 删掉附件服务门禁 | **1**（⚠️ 初版**假绿**：泛断言「附件服务」被下游另一条同词报错放行，已改为锚定「均未提供」） |
| 内嵌图不再提升 / 不用请求版本投影 | 2 / 1 |

## 5. ⚠️⚠️ 真缺陷二（未发生但极易发生）：`expires_at` 秒/毫秒混淆

上游 `expiresAt` 是**秒**（实测 `1794407698` ≈ 2026-11-11），官方客户端自己 `1e3 *` 归一化。

**若直接当毫秒用**：

```
new Date(1794407698) → 1970-01-21        ⇒ 判定「早已过期」
⇒ 每个请求都触发续期
⇒ 并发下反复消费 refresh_token
⇒ 最终 invalid_grant ⇒ 账号被标死，用户只能重新登录
```

这与本仓库 **codearts 的「续期单向门」事故同型**，且更隐蔽（错的是**时间量纲**，不是布尔）。

⇒ **归一化只做一次**（在 `accio-oauth.ts` 的兑换/续期返回处 → `accio.ts` 的
`accioExpiresAtMs`），并加防御分支：
`expiresAt > 1e12` 视为已是毫秒（容忍上游某天改单位），否则 `×1000`。
单测**必须做反向验证**：去掉 `×1000` ⇒ 用例必须变红
（已落地：`tests/unit/accio-oauth.spec.ts` 的「⚠️⚠️ 上游 expiresAt 是秒 ⇒ 必须 ×1000」，
断言的正是 `1_794_407_698 → 1_794_407_698_000` 与 `getFullYear() > 2025`）。

⚠️ **这一条是「预防」而不是「已发生」**：本 provider 从第一版实现起就带着归一化，
故它**没有**在真实账号上造成过标死。登记在此是因为它极易复发（新增 provider 时
照抄 `expires_at` 字段名却忘了量纲），而代价是**账号单向门**。

## 6. 积分：**没有签到端点**，但**登录会触发按日发放**

**只读端点**（全部实测 200）：

| 端点 | 方法 | token 位置 | 用途 |
|---|---|---|---|
| `/api/auth/userinfo` | **POST** | **body** | 身份：`userId` / `userName` / `routeRegion` / `userLevel` / `maskedMobile` |
| `/api/entitlement/currentSubscription` | **GET** | **query** | 三类桶：`daily` / `monthly` / `referral` |
| `/api/entitlement/quota` | GET | query | `usagePercent` / `refreshCountdownSeconds` |
| `/api/entitlement/listGrantRecords` | GET | query | 积分来源与有效期 |
| `/api/entitlement/listUserMessageBill` | GET | query | 最近逐条用量 |

⚠️ **传参方式不统一**：`userinfo` 必须 **POST + body**（GET 会 `405`），
其余 **GET + query**（缺 token 会 `400`）。用错即静默走偏。

⚠️ **实现只接线了上表的前三行**（`userinfo` / `currentSubscription` / `quota`）：
`listGrantRecords` / `listUserMessageBill` 是**取证时**实测过的端点，插件**不调用**
（前者只用来确认「登录触发发放」与 24 小时有效期，后者只用来确认逐条用量的形状）。
将来若要展示「积分来源明细」或「最近用量」，这两条已经验证过可用。

**实测 grant records**：

```
source=DAILY_GIFT  type=DAILY_REWARD        amount=200  reason=DAILY_GIFT
    effective=<登录时刻 ms>  expiry=effective+86400000      ← 差 86400000 ms = 24h
source=ACCIO_WORK  type=PHOENIX_FIRST_GIFT  amount=500  reason=ACCIO_FIRST_GIFT  （注册赠送，一次性）
```

⚠️ 时间戳写成**相对形态**（`effective` + 86400000）而不是抄实测的绝对值：
绝对值是**某次登录的本机痕迹**，而这条记录要说明的是「**差值恰好 24 小时**」这个事实。

- 每日 **200 积分**，**有效期恰好 24 小时、不累积**；`quota.refreshCountdownSeconds = 86400`。
- **那条 200 的 `effective` 正是登录时刻** ⇒ 证实「登录触发当日发放」
  （用户原话：「每日签到领取积分的操作是登录一次」）。
- ⇒ `dailyCheckin` **不登记**（显式写 `false`，如实：没有可调用的签到端点）。
- ⚠️ **「刷新每日额度」入口至今（2026-10-13 实施完成时）仍未实现**：它本质是
  **重新登录既有账号**，而现有 RPC 表面**没有**这个能力 —— 实测三条障碍：
  ① `account.create` **恒新建** id（`const id = \`${provider}-${shortId()}\``），
  且 `RpcCreateAccountRequest` **没有 `accountId` 字段** ⇒ 复用它会加一个幽灵账号，
  而**原账号的额度根本没刷新**（正是「骗人的按钮」）；
  ② 账号的 `region` **没有暴露给客户端**（不在 `ProviderAccountEntry` / 状态里）；
     ⚠️ **注意与 §9.1 ④ 区分**：④ 接的是「**新建账号时**选区域」（`account.create` 的入参，
     已落地）；本条说的是「**已登录账号的 region 读不回来**」（面板想展示/复用既有账号的
     区域时拿不到）—— 这是 `account.relogin` 那条 RPC 的障碍之一，**仍未解决**。
  ③ `login.poll` 对**已登录**账号立刻回 `done: true` ⇒ 会给出**假成功**。
  ⇒ 需要**宿主侧新增一条 RPC**（如 `account.relogin`）才能落地；
  在那之前面板**刻意不渲染该按钮**（不是忘了做），只如实说明「每日积分由服务端在
  登录时发放，有效期 24 小时、不累积；要刷新请删除该账号后重新登录一次」。
  ⚠️ **不要**把它接到 `credits.claim`（`dailyCheckin` 已是 false），
  也不要接到 `account.create`（那会造幽灵账号）。
  ⚠️ 由 `tests/unit/accio-client-panel.spec.ts` 的用例守着「不得渲染该死控件、
  也不得接 `account.create`」，且**守 registry 的注释不得再声称该入口已存在**
  （早先那里写过「面板另有一个 accio 专属入口」—— 那条承诺未兑现，已订正）。

## 7. 模型目录（实测 15 个可见模型）

`POST /api/llm/config/v2` `{token}` → `data[].modelList[]`，字段：
`modelCode` / `modelDisplayName` / `contextWindow` / `multimodal` / `effectiveMultiple` /
`reasoningEfforts` / `defaultReasoningEffort` / `visible` / `freeUse`。

| modelCode | 倍率 | 上下文 | 多模态 | 显示名 |
|---|---|---|---|---|
| `1Drift-N8kP2Q7wR5mX` | 0.013 | 512,000 | ✅ | Qwen 3.8 27B |
| `1Drift-F8hS3mK7pL2n` | 0.03 | 1,000,000 | ✅ | Qwen 3.8 Flash |
| `1Chronos-F53X9nQ3rT8w` | 0.03 | 1,000,000 | ✅ | GLM 5.3 Flash |
| `1Nova-Q3xM8vJ1rH6z` | 0.045 | 1,000,000 | ✅ | DeepSeek V4.1 Flash |
| `1Zenith-M27hS2SR5xQ2p` | 0.08 | 1,000,000 | ✅ | MiniMax M3 |
| `1Chronos-dX3cV9sA2mK7` | 0.12 | 200,000 | ❌ | GLM 5.1 |
| `1Nexus-R3wF8qJ5vB6h` | 0.13 | 1,000,000 | ✅ | Standard |
| `1Drift-A3bM5nK8pQ2w` | 0.13 | 256,000 | ❌ | Qwen 3.5 A3B |
| `1Synapse-G5aJ8wL1dV4s` | 0.14 | 256,000 | ✅ | Kimi K2.6 |
| `1Chronos-L53W8nP2qR6m` | 0.16 | 1,000,000 | ❌ | GLM-5.3 |
| `1Chronos-G5p2V9sA2mK7` | 0.16 | 1,000,000 | ❌ | GLM-5.2 |
| `1Nova-bW7yT4kL9pN2` | 0.17 | 1,000,000 | ❌ | DeepSeek V4 Pro |
| `1Drift-T3TB6WS9a23w` | 0.44 | 1,000,000 | ✅ | Qwen 3.8 Max |
| `1Orbit-I9eY4tK8bW1f` | 1 | 1,000,000 | ✅ | Professional |
| `1Orbit-Q7hN3xR6cP2m` | 2.8 | 1,000,000 | ✅ | Ultimate |

⚠️ **倍率必须进展示名**（`名称 · x倍率`）：跨度 0.013~2.8（**215 倍**），是选型时最重要的信号，
而 DSH 的模型信息没有承载它的字段。本仓库既有约定：**倍率写进 `name`，不是 `description`**。

⚠️ **上游 `modelCode` 非人类可读**（`1Drift-…`）⇒ 目录**必须动态拉取**，兜底表只作离线回退。
排序按倍率升序（便宜在前），无倍率的排最后。

### ⚠️⚠️ 对外 id 是「人话」slug，上行仍是 `modelCode`（2026-10-13，用户要求）

**用户追问原文**（附模型自报截图）：「为什么现在还是回复中的模型不是标准模型 id」。

#### 现象与根因

DSH 会把 **`CatalogEntry.id` 注入给模型当身份** —— 而 accio 原先的 `id` 就是上游
`modelCode`（`1Drift-N8kP2Q7wR5mX` 这类**故意不可读**的内部代号，真名只在
`modelDisplayName` 里）⇒ **模型只能自报一串乱码**，且它自己也无从知道那是什么基座。

⇒ 对外 id 改用**展示名归一后的 slug**（`qwen-3-8-flash`），由
`accio-adapter.ts` 的 `accioModelIdOf` 产出。归一**复用** `normalizeNameKey`
（`canonical-models.ts`）—— 与聚合的规范键**同一套规则**，两处各写一份必然漂移。

#### ⚠️⚠️ 关键不变式：**id 用 slug，上行用 `modelCode`**

| 流向 | 用什么 |
|---|---|
| `listModels` / `resolveModel` 的 `id`、注入给模型的身份 | **slug** |
| `POST /api/adk/llm/generateContent` 的 body `model` | **上游 `modelCode`**（服务端只认它） |

⇒ `stream()` 里必须经 `accioModelCodeOf` 反查（**未知 id 原样透传**，由上游报错）。
⚠️ **漏掉这一步的后果极具误导性**：请求体带上 slug、服务端不认，症状是
「**模型不回复**」而不是参数错误 —— 与本节其余几条坑同型。

#### ⚠️ 连带失效：`CANONICAL_OVERRIDES` 的索引键**也必须**改成 slug

补丁按 `realId` 查，而 `realId` 来自 `ctx.llm.listModels(provider)` 返回的 **`id`**
⇒ id 改成 slug 后，补丁若仍按 `modelCode` 索引就**恒不命中**，accio 会掉回
`qwen-3-8-flash` 孤例键 ⇒ **聚合轮换列表里又看不到它**（正是补丁要解决的症状），
且**没有任何报错**。⇒ 两处必须**同时**改。

### 聚合里的归并（与上面**同源**，但改的是键通道）

**用户诉求原文**：「accio 的 qwen3.8-flash，聚合当中的 qwen3.8-flash 轮换列表里要有」。

聚合按**规范键**把各家的同一个模型归成一个虚拟模型，而 accio 的 `1Drift-…` 对聚合
**毫无信息**：

| accio 在聚合里的通道 | Qwen 3.8 Flash 归到 | 与 loomy/trae/qoder 同键？ |
|---|---|---|
| `id`（默认） | `1drift-f8hs3mk7pl2n` | ❌ 各自成一个孤立虚拟模型 |
| `name`（**必须**） | `qwen-3-8-flash` → 补丁 → `qwen3-8-flash` | ✅ 同一个 |

⇒ 两处改动（都在 `src/canonical-models.ts`）：
1. **`PRIMARY_CHANNEL` 加 `accio: 'name'`** —— 与 `qoder` **完全同因**
   （它的 id 也是内部代号 `qfmodel`）；
2. **`CANONICAL_OVERRIDES.accio` 加 `qwen-3-8-flash → qwen3-8-flash`**
   （⚠️ 索引键是**对外 id（slug）**，见上一小节）—— 因为 accio 的展示名
   `Qwen 3.8 Flash` 里**有空格**，`normalizeNameKey` 转成连字符后得
   `qwen-3-8-flash`，而三家（loomy/trae/qoder）走 id 通道、id 是 `qwen3.8-flash`
   （无空格）⇒ 得 `qwen3-8-flash`（**无连字符**）。同一模型、键却不同 ⇒ 必须显式补丁。

⚠️ **只登记确知同模型的**（`Qwen 3.8 Flash`）：
- `Qwen 3.8 Max` **不需补丁** —— accio 得 `qwen-3-8-max`、loomy 也得 `qwen-3-8-max`，
  本来就一致；
- `Qwen 3.8 27B` / `Qwen 3.5 A3B` / `Standard` / `Professional` / `Ultimate`
  **不登记** —— 它们是独立模型，猜着并入 = **请求打到错的模型且无提示**。
  ⚠️ 27B 与 A3B 是两个不同模型，绝不能并进 `qwen3-8-flash`。

测试：
- `tests/unit/accio-adapter.spec.ts` 的「对外 id = slug，上行仍用 modelCode」7 条
  （含两条**行为级**：`listModels` 的 id 是 slug、请求体 `model` 是 `modelCode`）；
- `tests/unit/canonical-models.spec.ts` 的 4 条（name 通道 / 跨渠道同键 /
  Max 无需补丁 / 独有模型自成键）；
- 端到端：真实目录 15 条，id 全为人话且 `slug → modelCode` **回查 0 失败**。

**反向验证**（各自逐字节还原）：去掉上行映射 ⇒ 2 条红；id 退回 `modelCode` ⇒ 8 条红；
补丁索引退回 `modelCode` ⇒ 1 条红。

### ⚠️⚠️ 但**光有归一化补丁还不够**：候选表另有一道闸门（2026-10-13 合并审计实测）

**这是本节最容易误判的一处** —— 我当时只验到「规范键归并对了」（`canonicalKeyFor`
返回 `via: 'patch'` ⇒ `qwen3-8-flash`）就宣布「✅ 仍归并到一起」，
**但用户要的是「轮换列表里要有 accio」，而那是另一层**。

| 层 | 由什么决定 | 当时状态 |
|---|---|---|
| ① **模型层**：同名模型归成一个虚拟模型 | `PRIMARY_CHANNEL` + `CANONICAL_OVERRIDES` | ✅ 已对（补丁命中） |
| ② **候选层**：哪些渠道出现在该虚拟模型的候选表里 | **`WIRED_EXPIRY_PROVIDERS`** | ❌ **不在表里 ⇒ 被剔掉** |

`aggregate-adapter.ts` 有 **4 处**按 `WIRED_EXPIRY_PROVIDERS.includes(...)` 过滤
（探测 / 候选 / 虚拟模型 / 价格）。**只把它加进 `AGGREGATE_CHANNELS` 是无效接线**
—— 那只是「进聚合目录」，候选层仍会被剔。症状**完全静默**（无报错、无日志），
用户只会看到「聚合里选不到 accio」。

**实测证据**（审计方用真实适配器跑的）：`loomy + accio` 的候选表**只有 loomy**；
`prepareCall` 实际也只发往 loomy。而 `canonicalKeyFor('accio', …)` 同时返回
`via: 'patch'` ⇒ **两层结论相反**，只看一层必然误判。

⇒ 修法（两处**必须同改**，`expiry-runtime-parity.spec.ts` 真跑 `apply()` 锁一致）：
1. `aggregate-expiry.ts` 加 `accioExpiry`（与 **loomy 同形**：命名池、无逐包时间戳）；
2. `WIRED_EXPIRY_PROVIDERS` 加 `'accio'` + `provider-expiry.ts` 的
   `createProviderExpiry()` 加一条。

**`accioExpiry` 的三格判据**：有每日额度 ⇒ **当日 24:00**（24h 作废且不累积）；
只剩每月/推荐 ⇒ `NEVER`（上游**没有**下发它们的到期时间 ⇒ 不猜）；
全 0 / 查询失败 ⇒ `UNUSABLE`（**不是 NEVER** —— 把它当长期可用会把请求发到没额度的渠道）。

⚠️ **刻意不用 `quota.refreshCountdownSeconds` 当到期时间**：`accio-credits.ts` 已记录
「它只说**额度何时刷新**，与『这批积分何时作废』**未被实测为同一时刻**」⇒
写进 `deductionEndTime` 就是编造。本函数只在**有每日额度**时给「当日结束」这个
**保守上界**（排序要的是「今天就作废的排前面」，不是精确作废时刻）。

⚠️ **officeace 仍未接入**（同一次审计发现、**本轮刻意未做**）：它与 buddy 系同形
（有 `deductionEndTime`）⇒ **可接而未接**。接法同上，但需产品确认；
在那之前它同样**进不了聚合候选表** —— 注释已如实登记，别读成「已经能进」。

> ✅ **上面这段已于 2026-10-13 失效**（`026a7db` "feat(officeace): 接入聚合轮换"）：
> officeace 已进 `WIRED_EXPIRY_PROVIDERS` 与 `AGGREGATE_CHANNELS`，折算原语
> `officeaceExpiry` 也已接上（详见 `providers-officeace.md`）。
> 上面那段是**当时的记录**，别再照它办事 —— 原文保留只为留痕。

测试：`tests/unit/aggregate-expiry.spec.ts` 的 `★ accioExpiry` 4 条（当日 24:00 /
只剩月包 ⇒ NEVER / 全 0 ⇒ UNUSABLE / 未登录 ⇒ UNUSABLE）+
`expiry-runtime-parity.spec.ts` 的清单对拍。
**反向验证**：删掉白名单里的 accio ⇒ 2 条红；把「有每日额度」改成恒 NEVER ⇒ 1 条红；
删掉「全 0 ⇒ UNUSABLE」⇒ 1 条红。

## 8. 区域

- **gateway 同一个**（`phoenix-gw.alibaba.com`），与区域无关。
- 只有**登录页域名**不同：中国版 `www.accio-ai.com` / 国际版 `zh.accio.com`。
- 区域由服务端按账号下发（`userinfo.routeRegion`，实测 `CN`）。
- ⇒ **单 provider + product 配置收敛区域**（用户裁定），区域在登录时由用户选
  （采 zcode 的 `loginProvider` 模式），**不做成第二个 provider id**。
- ✅ **入口已落地**（2026-10-13 终审 I2）：客户端「+ 新建账号」弹窗里选区域，
  经 `account.create` 的 `accioRegion` 下发 → 宿主 `normalizeAccioRegion` 白名单 →
  `AccioAuth.startLogin` 的 `region` → `ACCIO.loginBaseUrlOf(region)` 选登录域，
  并写进凭据（续期与推理按它选域名）。落点与反向验证见 §9.1 ④。
- ⚠️ **区域不可事后纠正**：它写进凭据后，续期与推理都按它走；选错只能**删除账号重登**。

## 9. 相关文件（`.tmp-accio/`，已 gitignore，只读取证工具）

| 文件 | 用途 |
|---|---|
| `scan.mjs` / `grep-asar.mjs` / `dump.mjs` / `extract.mjs` | 解析 `app.asar` 目录表、按关键词定位、按偏移取出文件 |
| `probe2.mjs` | **PKCE 登录探针**（成功跑通；含 `rundll32` 修复后的浏览器打开） |
| `probe-cred.mjs` | 签名必要性四格对照（⚠️ 其 sgcookie 未隔离，见 §4.2） |
| `probe-sgcookie.mjs` | **sgcookie 必需性的干净对照**（§4.2） |
| `probe-credits.mjs` | 积分语义取证（§6） |
| `probe-tool-shards.mjs` / `probe-tool-merge.mjs` | **工具调用的分片到达**取证（§4.4）：上游把一次调用拆成多帧。⚠️ 这两支是 §4.1.2「扁平 `tools` 形状被接受」的**间接证据来源** —— 它们下发的就是扁平形态，上游回了真实 `function_call` 帧 |
| `loginjs*.mjs` / `findgate.mjs` / `kii.mjs` / `resolveae*.mjs` | 定位登录页 legacy 门禁真源（`kiIt5C4K.js`，§3） |

⚠️ 这些是**只读取证工具**，不入库；`src/` 不引用它们。

## 9.1 实施阶段（2026-10-13）新增的三条**接线**结论

不是协议事实，但同样是「漏了会静默失效」的判据，登记在此以免下次接 provider 重踩。

### ① ⚠️⚠️ 必须登记进 `SELF_HEAL_REFRESHABLE_PROVIDERS`（本 provider **真的漏过**）

`src/jet-hub-rpc.ts` 的 `SELF_HEAL_REFRESHABLE_PROVIDERS` 决定「积分查询前要不要
先按需续期」。accio **有** refresh 端点、池内 `expiresAt` 也确实会被写 ⇒
不属 loomy / zcode 那类「设计上无端点」的豁免。

**漏登记的后果**（Task 7 实际发生过）：过期账号在积分端点**永不自愈** ——
积分行报「未登录」而上游其实只需一次 refresh，症状与 issue IKKHL5 **逐字相同**，
且**日志零字**。

⚠️ 根因是**守卫只有单向**：`credits-balance-self-heal.spec.ts` 原先只锁
「本集合 ⊆ `JetHubAuths` 的键」（挡住假 id），**反向没有** ⇒ 新 provider 进了
`JetHubAuths` 却忘了登记到这里时**全绿**。现已补反向用例（逐键点名 + 显式豁免表
`SELF_HEAL_EXEMPT`，豁免必须带可核对理由），漏登记会**点名变红**。

### ② ✅ `rateLimit` 已于 2026-10-18 由 `false` 改回 `true`（issue IKM3ZV 修复）

**历史**（2026-10-13 实施期）：判据是本仓库 registry 自己的落地问法：「这个按钮点下去，
能不能让用户**少**受限一次？」当时 accio 两条都不满足：

- 适配器**不写** `modelRateLimits`（`provider-runtime-wiring.spec.ts` 的
  `WRITE_SITE_FILES` 把它登记为空，并有用例验证它确实无写点）⇒ 永远没有标记可清；
- `src/index.ts` 的 `probeById` **没有**它的条目 ⇒ 点「重测」时 `retestAccount` 走到
  `modelIds.length === 0` 处**提前返回**：零请求、零清除。

⇒ 面板级「重测所有 / 重置所有」与卡片级两个按钮**全部恒为惰性**（正是本仓库记录过的
报障形态「按钮响应这么快，是不是坏了」）。

⚠️ 当时留了伏笔：「将来接上请求级换号 + 冷却时，**这一行要一起改回 `true`**」。
**2026-10-18 已兑现**（见 §11）：接上换号 + 冷却后，① 真的写标记了（额度至 UTC+8 当日
24:00 / 限流 1h），② `probeById` 也登记了 ⇒ `rateLimit: true` 是**实打实可用**的入口。

⚠️ 与 loomy / gemini / officeace 各自的 `rateLimit: false` **理由不同**：那三家是
「真会限流、但按钮管辖不到 / 根本没有作用对象」；accio 现在是「真的会写标记且探测已登记」。
⚠️ 也与 modelscope 相反 —— 魔搭是「能力齐全但**用户刻意不要**这个按钮」（仍留在
`RATE_LIMIT_OFF_BY_CHOICE` 表里）。

⚠️⚠️ **接线四处必须同改**（本陷阱在本仓库已复发过多次，本轮是第 N 次）：

| # | 位置 | 漏掉的症状 |
|---|---|---|
| 1 | `src/provider-registry.ts` 的 `rateLimit` | 面板不渲染「重测 / 重置」按钮 |
| 2 | `src/index.ts` 的 `probeById` | 「重测」报「没有探测适配器」 |
| 3 | `tests/helpers/provider-sets.ts` 的 `WRITES_RATE_LIMIT_PROVIDERS` | 守卫双向比对变红 |
| 4 | `tests/unit/provider-runtime-wiring.spec.ts` 的 `WRITE_SITE_FILES` | 同上 |

由 3 + 4 的双向比对**自动**锁死 1 + 2 的漂移（前两者漏了会红，后两者漏了守卫不红 ⇒
第 4 条那道「文件维度」守卫才是真正的兜底）。

### ③ 其余「漏一处即静默失效」的接线点（同批已逐处接上）

| 位置 | 漏掉的症状 |
|---|---|
| `src/jet-hub-store.ts` 的 `ACCIO` 前缀表 | `state.json` 缺失时 `ACCIO_ACCOUNT_*` 的账号**静默消失**（同款坑第**四**次） |
| `src/aggregate-adapter.ts` 的参与渠道清单 | 聚合里**选不到** Accio 的模型（静默） |
| `src/provider-registry.ts`（纯数据）+ `provider-runtime.ts`（实现） | 能力声明与实现分叉；客户端能力表从前者派生 |
| `src/provider-credits.ts` 的 `accio` 分支 | 积分端点 `bad-request`，而客户端仍会发请求 |

### ④ ✅ 区域选择入口**已接上**（2026-10-13 终审 I2 修复）

`RpcCreateAccountRequest.accioRegion` 存在且过白名单（`normalizeAccioRegion`，未知值回落 `'cn'`）。
**客户端原本没有入口** ⇒ 宿主恒收到 `undefined` ⇒ 恒回落 `'cn'` ⇒ **国际账号根本登不进去**
（这是**功能缺口**，不是「少一个偏好」：登录页域名按区域分，而区域由服务端按账号下发、
登录前无从推断）。

现已在客户端接上，落点**三处必须同步**（前两处判据方向相反，见 `new-account.js` 的注释）：

| # | 位置 | 改动 |
|---|---|---|
| ① | `new-account.js` 的 `PROVIDERS_ASKING_OPTIONS`（**白名单**） | 加 `'accio'` |
| ② | `new-account.js` 的 `buildCreateAccountPayload`（**排除法**） | 第三个形参 `accioRegion`，`provider === 'accio'` 时下发 |
| ③ | `tests/unit/new-account-dialog.spec.ts` 的 `EXCLUSIVE_FIELDS` | 加 `'accioRegion'`（**第三处**，漏了它不变式会退化成只查旧字段） |

`plugin-src/client/jet-hub.js` 的弹窗按 `accioDialog = provider === 'accio'` 分支
（accio 问**登录区域**、zcode 问**登录渠道**），选项值 `'cn'` / `'global'` 与宿主白名单逐值对齐。

⚠️ **反向验证已做**（四个变异，各自点名变红）：只改白名单 / 只改载荷 / 调用点漏传第三个实参 /
弹窗不分支。⚠️ 其中「弹窗不分支」第一次写断言时**没抓住**（只断言 `accioDialog ?` 这个
**形态存在**，而变异 `const accioDialog = false` 让三元永远走 else 支）—— 已改为**钉住赋值**。

## 10. 未验证项（截至 2026-10-13 实施完成）

⚠️ **实施阶段没有运行任何 E2E 探针**（会开浏览器 / 花积分 / 轮换凭据）。
四个探针已写好并**全带闸门**（默认 skip），清单与运行方式见 `tests/e2e/README.md`。

⚠️⚠️ **本节刻意区分两种状态 —— 别把它们混成一句「未验证」**：

| 状态 | 含义 | 该做什么 |
|---|---|---|
| **未验证** | 从来没有跑过任何对照，结论**不存在** | 需要跑探针 / 做对照才能得到结论 |
| **已验证，但证据未留存** | **真机跑过并得到结论**，但探针在 `.tmp-accio/`（已 gitignore）、**没有日志或产物留在库里** | 结论**可以照用**；若要做成回归防线，需要**重跑并留存证据** |

⚠️ 把第二类写成第一类会让人**重做一遍已经做过的事**；把第一类写成第二类则是**编造结论**。
下表逐行标注属于哪一类。

| # | 状态 | 事项 | 为什么要紧 |
|---|---|---|---|
| U-A | **未验证** | **续期端点形状与轮换语义** | 参考实现记录「刷新会轮换 refresh_token」；三入口并发会标死账号（codearts 同型）。⚠️ 测它必须用**我们自己的**账号，不能拿用户的 IDE 会话试。⇒ 探针 `test:e2e:accio-refresh` **已就绪但尚未运行**，实现侧已按最坏假设做防御（见 §2） |
| U-A′ | **未验证** | ⚠️⚠️ **`refresh_token` 是「会话级」还是「账号级」？** | **探针结构上无法回答这个**：它只能证明「凭据由本插件现场 PKCE 登录写入」，**不能**排除「用户用**同一账号**也登录了 IDE」。若服务端是**账号级**轮换，则轮换会作废**同账号** IDE 的登录 —— 即使用的是我们自己的凭据。⇒ **跑续期探针前请先确认该账号没在 IDE 上登录**，或接受这个风险。这是 E2E 探针 `test:e2e:accio-refresh` 的**已知残余风险**（Task 9 复审指出） |
| U-B | ✅ **已兑现（2026-10-18，issue IKM3ZV）** | ~~`rateLimit` 是否该登记~~ | 2026-10-13 登记为 `false`（两个按钮恒为惰性）并留了「接上换号 + 冷却后改回 `true`」的伏笔。**本 issue 给 accio 接上请求级换号 + 冷却**（额度至 UTC+8 当日 24:00 / 限流 1h）并登记 `probeById` ⇒ 四处接线同改完毕，`rateLimit` 改回 `true`。见 §11 与 §9.1 ② |
| U-C | ✅ **已纳入（2026-10-13）** | 是否纳入**临期折算**（`ProviderRuntime.expiry`） | **已纳入**：`accioExpiry` + `WIRED_EXPIRY_PROVIDERS` + `provider-expiry.ts` 的 `createProviderExpiry()` 三处已同改（见上面「聚合里的归并」一节与 `tests/unit/aggregate-expiry.spec.ts` 的 `★ accioExpiry` 4 条）。⚠️ 判据是**三类语义桶**：有每日额度 ⇒ 当日 24:00；只剩每月/推荐 ⇒ `NEVER`（上游没下发作废时刻，不猜）；全 0 / 查询失败 ⇒ `UNUSABLE` |
| U-D | ✅ **已验证（2026-10-14，issue IKLR7V）** | 图片通路 | **上游原生收图**，形状 `parts[].inline_data = {mime_type,data}`（Gemini 同构）；四象限色块图**四色全对**。⚠️ **`multimodal` 字段可信**（15 条可见模型从不缺失、与兜底表 100% 一致），但 **`multimodal:false` 的模型不报错、而是静默忽略图片**（GLM 5.1 据此**幻觉**出答案）⇒ `inputModalities` 必须按逐模型声明，`false` 写 `['text']`。详见 §4.6 |
| U-E | **未验证** | 国际版账号能否用中国版登录页（反之） | 跨区域登录是否被拒。⚠️ 区域选择入口**已接上**（见 §9.1 ③），故现在**可以触发**这一条：选国际版登录域去登一个中国版账号（或反之）会得到什么。⇒ 探针 `test:e2e:accio` 未覆盖跨区域组合，仍待人工验证 |
| **U-F** | ⚠️ **已验证，但证据未留存** | **`tools` 的扁平形态被上游接受**（§4.1.2） | Task 6 的 `probe-tool-shards.mjs` / `probe-tool-merge.mjs` **真机跑过**并拿到真实 `function_call` 帧（`task-6-report.md` §4.2 逐字记录 frame#8/#9/#10），两支探针下发的**都是扁平 `parametersJson` 形态** ⇒ 「扁平可用」是**跑出来的结论**。⚠️ 但探针在 `.tmp-accio/`（gitignore）、**没有日志入库**，且 `tests/unit/accio-adapter.spec.ts` 那条只写「实测该形状可用」而**未注明来源** ⇒ 属**证据未留存**：结论照用，但**没有可复核的产物**。要做成回归防线须**重跑并留存**（例如把探针搬进 `tests/e2e/` 的闸门探针并落日志） |
| **U-G** | ⚠️ **已验证，但证据未留存** | **工具调用分片到达、后续帧重复完整参数**（§4.4） | 同上两支探针的结论（「有 args 的帧数=2，不同取值个数=1」）。已由适配器 `accioToolCallMergeTransform` 合并，且 `tests/unit/accio-adapter.spec.ts` 的 6 条用例锁住行为 —— 但**行为用例的输入是我们自造的帧**，上游真形状的**原始证据未留存**。⇒ 与 U-F 同批重跑即可一并补齐 |
| **U-H** | **未验证** | **请求级换号的真机行为**（§11） | ⚠️ §11 的 24 条用例全部是**注入 fetch 桩**的行为级验证（判别力在「第二发的 `body.token`」），**没有真机证据**。真机上可验的三件事：① 额度耗尽后是否真的切到第二个账号；② 冷却徽章上的重置时刻是否与上游实际恢复时刻吻合（`nextUtc8DayStartMs()` 是**推断**，本家 402 报文里没有重置字段）；③ 流内 402 的 `error_message` 是否恒为 `unauthorized`（若是别的文案，本家那套「只认 `error_code==='402'`」的判据可能不够）。 ⇒ 建议在 `tests/e2e/` 补一支带闸门的探针 |

## 11. ★ 请求级账号轮换（Gitee issue IKM3ZV，2026-10-18 接上）

### 11.1 issue 报的是什么

**症状**：账号池里两个启用账号（#1、#2），#1 额度耗尽后**#2 从未被尝试**，整轮直接失败 ——
「登录 N 个账号并没有带来 N 倍可用性」。流内 402（HTTP 200 + SSE `error_code:"402"`）
同样零换号。

**⚠️ issue 自己的证据有一条判据错了**（结论侥幸对了）：它写「`excludeAccountIds` 在
`src/*-adapter.ts` 里引用数为 0」，那是因为它 grep 的是**形参名**，而实际有 **15 处**调用点
传了这个**位置参数**（局部变量名叫 `tried` / `triedAuth` / `triedPolicy` /
`rateLimitTried` / `triedStreamAccounts`）。

⇒ **正确表述**：机制早已被 12 家使用，**accio / autoclaw / officeace 三家**未接；
不是「机制无人调用」。这会影响 issue 的建议 ④（做成公共包装）—— 仓库有
`credential-resolver.ts` 这一层抽象，但**换号循环本身仍是各家手写**（buddy 有 3 条
独立换号路径），抽象尚未落到这一层。

### 11.2 语义表

照 `minimax-adapter.ts` / `loomy-adapter.ts` 的类别→动作表逐格搬：

| 类别 | 判据（`error.code`） | 换号 | 写冷却 |
|---|---|---|---|
| `quota` | `QUOTA_EXCEEDED`（HTTP 402 / 流内 `error_code:402`） | ✅ | ✅ 至 **UTC+8 当日 24:00** |
| `rate` | `RATE_LIMIT`（HTTP 429） | ✅ | ✅ 1h |
| `auth` | `AUTH`（HTTP 401/403） | ✅ | ❌ **绝不写** |
| ⚠️ **网关拒绝页** | `PERMISSION_DENIED`（HTTP 403 **且** media-type 为 `text/html`） | ❌ **不换号** | ❌ **绝不写** |
| `other` | `INVALID_REQUEST` / `SERVER` / `EMPTY_RESPONSE` / … | ❌ | ❌ |

⚠️ **认证类只换号、绝不写冷却**是 2026-10-06「全池被封」事故换来的不变式
（网关对全池回 401 时，每个号都被写长冷却 ⇒ 一个请求封死整个 provider）。

⚠️ **本表刻意不扫报文文案**（与 minimax / loomy 的四通道判据不同）：本家两条通道已把类别
**穷尽**（`httpErrorCode` 按状态码 / `accioErrorFrame` 只认 `error_code === '402'`），
再加文案腿只会引入过宽判据（把 400 参数错判成额度 ⇒ 白封账号一天）。缺文案腿的代价是
「上游用文案而非状态码表达额度」时不换号 —— 那是**漏判**，与 minimax 那条
「宁可漏判不可误伤」同向。

### 11.2.1 ⚠️⚠️ 网关 HTML 拒绝页必须**在 `send()` 里**拦下（PR #76，2026-11-14）

**症状**（GitHub #75 真实报障）：上游网关对删除/封禁的账号回

```
HTTP/1.1 403 Forbidden
content-type: text/html; charset=UTF-8

<html>…rgv587_flag:sm…</html>
```

而 `send()` 当时**只看状态码**（`if (status === 401 || status === 403) return 'AUTH'`）
⇒ 整条链路把它当「凭据真失效」处理：

1. 先 `await this.options.refresh()` —— **白跑一次一次性的 `refresh_token`**；
2. 再 `rotate` 换下一个号 —— 拒绝页是**网关级**的，换号一样被拦 ⇒ **白烧整池**；
3. 每次重试都再烧一次。

点燃条件平常：任何一个被 WAF 拦截的账号。

**为什么必须拦在 `send()` 里**（而不是拦在调用方）：
`this.fetchImpl(` 全文**只有 1 处**（`:1997`），而 `this.send(` 有 **3 个调用点**
（`:1686` 首发 / `:1774` 续期后重发 / `:1820` 换号内重发）。
判据写在 `send()` 里，三条腿**全部经过**；写在调用方只挡得住第一条
（实测变异 M12：把判据挪出 `send()` 后，「续期重发」与「换号重发」
两条腿都绕过它 ⇒ 断言红在 `sentTokens` 上）。

**为什么归 `PERMISSION_DENIED` 而不是 `SERVER`**：
`SERVER` 恰在宿主的 `DEFAULT_RETRYABLE_CODES` 里（`EMPTY_RESPONSE / RATE_LIMIT / SERVER /
TIMEOUT / TRANSPORT`）⇒ 白重试 5 次。`PERMISSION_DENIED` 不在里面，且客户端
（`client.js:6036-6041`）对它**原样透传 message**（`AUTH` 会把 message 换成「API 密钥无效」，
与 `src/buddy-adapter.ts` 那段论证同源），且与 `src/cline-adapter.ts` 的地域限制分支同口径。

**判据必须只有一份**：`mediaTypeOf()`（拆 `;`、`trim`、`toLowerCase`）由
`isHtmlDenialMediaType()` 与 `assertEventStream()` **共用**。实测只自己写一份会逃逸三格：

| `content-type` | 少 `.toLowerCase()` | 少 `.trim()` |
|---|---|---|
| `TEXT/HTML` | ❌ 逃逸 | ✅ |
| `text/html ; charset=x` | ✅ | ❌ 逃逸 |
| `text/html;charset=UTF-8` | ✅ | ✅ |

⚠️⚠️ **一个极隐蔽的陷阱**：新文案把「服务端原文」拼进
`LlmError.message`（诊断用），而 `isTransportError()` 是**按 message 子串**判的
（`fetch failed` / `terminated` / `econnreset` / `epipe` / `socket hang up`），
而 WAF 页里这些字样**很常见**（它们本来就是「连接被中断」的描述）⇒
无守卫时，一个 403 网关拒绝会被**重包成可重试的 `TRANSPORT`**（比不修更糟）。
实测：`<html>connection terminated by WAF</html>` ⇒ 加守卫前 `code=TRANSPORT`、
加守卫后 `code=PERMISSION_DENIED`。修法 = `isTransportError()` 前置
`if (error instanceof LlmError) return false`（与 `buddy`/`codely`/`gemini` 三家的
`if (error instanceof LlmError) throw error` 同口径：**先让已分类的错误出去**）。

**守卫**（`tests/unit/accio-account-rotation.spec.ts`，6 条新增）：
`text/html` / `TEXT/HTML` / `text/html ; charset=x` 三种写法各一格、
诊断原文必须出现、传输字样不得重包为 `TRANSPORT`、
`402 + text/html` 必须仍归 `QUOTA_EXCEEDED`。**7/7 变异有牙**（无牙者如实登记：
旧版 `expect(pool.marks).toHaveLength(0)` 是**恒真**的 —— `recordsAccioRateLimit()`
只认 `quota|rate`，403 族无论有无补丁都不写标记 ⇒ 已删除并在
文件头写明「不要拿 `pool.marks` 当不换号的判据」）。

**未修已登记**（两份审计各自点到，均需独立全量回归）：

1. **`401 + text/html`** 仍走 `AUTH`（续期 + 换号）—— 而 401 恰恰是认证挑战最常见的状态码；
2. **`403` + 缺/空 `content-type`**、**`application/xhtml+xml`**、**`text/plain`** 四格同样仍烧
   `refresh_token`（探针实测 `refresh=1` / `fetch=2`）；
3. **`assertEventStream()` 的 `SERVER` 码**：同一张拒绝页包成 200 时仍归 `SERVER`
   ⇒ 白重试 5 次（该函数 JSDoc 原写「不重试」，**与事实相反**，已就地更正注释）。

**设计取舍**：403 + HTML 一律停下、**不再尝试其它账号** —— 拒绝页是网关级判定，
换号必定再被拦。代价是「万一只有这一个号被 WAF 误伤」时不会自动恢复（用户需重新登录）。

### 11.3 ⚠️⚠️ **一个循环、两段** —— 初版写成两个独立 `for` 被实测打穿三处

这是本实现**最关键的结构决定**。初版是「HTTP 层换号循环 + 流内换号循环」，三条用例
当场打穿（全部有牙）：

| 症状 | 根因 |
|---|---|
| 流内 402 换号后取回的账号**在 HTTP 层就失败** ⇒ 报「模型未返回任何内容块」 | 流内循环把 `!ok` 的响应直接塞回 `consumeOnce`，它于是去读一个 402 的 JSON 体当 SSE |
| 已产出内容后遇流内 402 ⇒ **连冷却都不记** | 同上：内容在错误分类前就被绕过了 |
| 坏凭据被跳过后**整池不再换号** | 两个循环各自计数，预算被重复消耗 |

⇒ 合并后 HTTP 失败与流内失败走**同一条**「记账 + 换号」路径，`round` 只有**一个**预算。
两条通道的差异只剩「错误码从哪来」。

### 11.4 五条与兄弟渠道同源的纪律（每条都有变异验证兜着）

1. **必须传真实 `modelId` 且传 `tried`**：传空串会让限流过滤整体短路
   （`if (modelId.length === 0) return true`），刚标记的账号立刻又被选中（trae 的
   真实用户报障）；不传 `tried` 会在 A/B 之间反复空转（qoder 踩过）。
2. **`currentAccountId` 必须是可变局部量**：`resolveCredential` 只在**首次**调用
   （返回「池当前会给出的那个」，换号后**不会跟着变**）⇒ 用常量会把冷却记到**无辜账号**
   头上（minimax / zcode 同款事故）。
3. **续期后必须重新反查账号 id**：接线层的 `refresh()` 走
   `pool.getAvailableAccount(id, '')`（**不带 `tried`**）⇒ 可能续期的是**另一个**账号。
4. **坏凭据（`{}`）判空后 `continue` 而非 `break`**：池的凭据是**裸 `JSON.parse`**
   （`getAvailableAccount` 不做形状校验）⇒ `access_token.length` 会抛 `TypeError`
   （非 `LlmError`）且一个坏号就把整池掐断（minimax 的同款修复）。
5. **已产出内容后不换号、但仍记账**：换号会**重放整次请求**、新的 `consumeAccioSse` 是
   全新生成器 ⇒ 用户看到两份内容被拼在一起、工具被执行两次（lobsterai 记过真实事故：
   `https://example.invalid` 真实被点了两次）。

⚠️ **冷却终点用 `nextUtc8DayStartMs()`**（UTC+8 当日 24:00），**不是**「现在 + 24h」——
后者是 IKL80H 记过的滑动窗口缺陷（0 点后用户仍看到「未到重置时间」）。

### 11.5 守卫网与两条无牙登记

`tests/unit/accio-account-rotation.spec.ts`（**24 条**，含 **5 条反向对照**）。

⚠️⚠️ **判别力一律在「第二发的 `body.token`」**：只断言「抛出的错误码对」是**恒真**的
（修复前后完全一致）。反向对照同样必要 —— 否则一个「凡错就换号」的实现也能全绿，
而那是白烧整池（buddy 的 11128 内容级拦截教训）。

**16 个变异实测结果**：15 个有牙（RED）、**1 个无牙已如实登记**：

| 变异 | 结果 |
|---|---|
| 漏传 `tried` / `other` 类也换号 / 预算放到 99 / 冷却写成 +24h / `currentAccountId` 不跟进 / HTTP 失败不 `continue` / 坏凭据 `break` / 不写回 `body.token` / 续期不反查 / 反查后不更新 `tried` / 已产出内容后不记账 / **`modelId` 传空串** | **全部 RED** |
| 删掉 `options.signal?.aborted` 那一格 | ⚠️ **无牙**，见下 |

⚠️⚠️ **两条无牙的如实登记**（本仓库纪律：无牙要如实登记，**绝不为它编恒真用例**）：

1. **`signal?.aborted` 那一格是防御性冗余**。删掉后全绿 —— 追查到的真实原因：
   `AbortSignal.abort()` 下抛的是 **`DOMException` / `name: 'AbortError'` / `code: 20`**
   （实测），它**不是 `LlmError`** ⇒ `error.code` 归成 `''` ⇒
   `shouldRotateAccioAccount('')` 判 `other` ⇒ 上面那条早退**已经**拦住。
   它只在上游把「中断」包成 `LlmError('QUOTA_EXCEEDED')` 时才生效（形变不可测，
   但删掉它会让那条路径变成「拿取消当额度耗尽换号」）。
2. ⚠️⚠️ **变异全绿不等于守卫有牙：本组的自检用例本身曾恒真**（2026-10-18 审计自查发现）。
   - 第一版自检只断言了 `limits.size === 0`（新建 Map 为空），**根本没碰到过滤腿** ⇒
     变异验证实测：把 `makePool` 里的限流过滤**整段删掉**，本组 24 条**全绿**。
     这正是本组自己警告过的失效模式（「替身缺一条真实实现里有的腿 ⇒
     对应变异全体无牙」），却**恰好落在自己写的自检上**。
   - 现在的自检**真去调池**并断言四格：⓪ 取到 acc-1 → ① 冷却它 → ② 再取**必须是 acc-2**
     （删掉过滤腿时这格返回 acc-1 ⇒ 红）→ ③ **空 modelId 短路**（与真实池同形）→
     ④ 排除集仍生效。
     ⚠️ ④ 必须断言池的**原始返回 `null`** 而非 `?.entry.id`（后者把 `null` 折成
     `undefined` ⇒ 分不出「池返回 null」与「池返回了个没 id 的条目」）。
   - 已重跑变异确认有牙：删掉过滤腿 ⇒ **RED，且精确指向该自检用例**。
   - ⚠️⚠️ **可推广的一条比「替身缺腿」更强**：**「守卫全绿」不足以证明它有牙** ——
     必须对所依赖的每一条腿做一次「删掉该腿」的变异。**本轮自查就是因为漏了这一步
     而误判「已补上自检」的。**

### 11.6 ⚠️ 顺带修的同型缺陷：CodeArts 的 HTTP 层换号漏传 `tried`

`src/llm-adapter.ts` 的 **HTTP 限流换号**格（现 `:1456`）原先是

```ts
const next = await this.options.accountPool.getAvailableAccount<CodeArtsCredential>('codearts', options.model)
```

**没传 `exclude`**，而同文件另两处（`:1331` 额度耗尽、`:1395`）都传了。后果与 2026-09-17
的 `81706da`（`excludeAccountIds` 的引入动机）逐字同构：池按用户手动顺序返回，刚标记的
账号若未命中模型级过滤仍可能排第一 ⇒ 拿回同一个 ⇒ 命中 `rateLimitTried.has` ⇒ 立即放弃换号
⇒ 报「所有账号均受限」而池里其实有可用账号。

⚠️ 该处是 `bf4b2d6`（2026-10-10）引入的；触发条件较窄（`:1456` 那一支前面刚写过
`updateModelRateLimit`，模型级过滤通常会生效），但这不改变它是同型缺陷的判定。

**可推广的纪律**：`AccountPool.getAvailableAccount` 的**第 3 参**是「换号」这条语义的
**承重件**，任何新增的换号调用点都必须传 —— 且「已试集合」的名字**必然**是 `tried`
之类的局部名，**源码级 grep `excludeAccountIds` 查不到**（这正是 issue 判据错的那一格）。

#### ⚠️⚠️ 审计补齐：同一格**还有第二处**漏（2026-10-18 两轮审计）

`llm-adapter.spec.ts:1451` 那一支原先是

```ts
if (currentAccountId) {
  await this.options.accountPool.updateModelRateLimit(...)
}                        // ⚠️ 这里**没有** rateLimitTried.add(currentAccountId)
```

**没把首号加进已试集** —— 而同文件 `:1323`（SSE 额度格）、`:1393`（HTTP 额度格）
**一直都有**这一行 ⇒ 本格是三格里唯一的例外。

⚠️ **两处缺一不可，且缺任一处症状相同**：首号不入集 ⇒ 传给池的第 3 参是空集 ⇒
池按手动顺序把刚失败的首号再返回一次 ⇒ 命中 `rateLimitTried.has` ⇒ 换号终止。

⚠️ **审计只报了「没传第 3 参」，没报「没加首号」** —— 后者是本轮复核时读代码
发现的。**可推广**：同型三格逐行对拍时，别只查「参数传了没」，也要查「**首号
有没有入集**」—— 后者是前者的**前提**。

⚠️ **该行修复有效但实测无守卫**（变异实测：删掉它 ⇒ 全绿）。真实原因已追查：
即便桩忽略 exclude，缺该行时 `!has()` 判真仍会换号 ⇒ 请求数与修复态相同 ⇒
现有断言分不出。⇒ 按纪律**登记为无牙、保留该行（与另两格对齐）**，
`llm-adapter.spec.ts` 里以 `it.skip` + 完整说明留档。

## 12. ★ 两轮 subagent 审计的结论（2026-10-18）

### 12.1 组织方式：prompt 约束**拦不住** agent，必须机制隔离

第一轮派了「常规审计」+「对抗审计」两个 agent，各自带详尽约束（禁 `git stash` /
`checkout` / `restore`、禁改主工作区、变异只放独立 worktree）—— **两个都没遵守**：
直接在主工作区注入 **6 处**变异且未还原，全量测试当场 12~20 条红。

⇒ 隔离方案的完整配方（含两个踩过的坑）见 `AGENTS.md`「派 subagent 做审计的三条实测教训」。
关键是：`git stash create`（**不动工作区**）+ `git worktree add --detach` +
**未跟踪文件要显式字节拷贝**（`stash create` 不含 untracked）+ `node_modules` 目录联接
+ **主工作区留 `Get-FileHash` 指纹**事后校验。第二轮实测**零污染**。

### 12.2 对抗审计：5 个发现（3 个已修、1 个既有、1 个待定）

| # | 发现 | 处置 |
|---|---|---|
| **P1-1** | `index.ts` 的 accio `refresh()` 用 `getAvailableAccount(id, '')`（空 modelId ⇒ 限流过滤短路），而 `resolveCredential` 走 resolver 的 `getAvailableAccount(id, modelId)` ⇒ **两条取号口径可指向不同账号** ⇒ 续期刷的不是正在用的那个 | **既有缺陷**（不在本 PR diff 里），但被本 PR **放大**（之前无换号、影响有限）。实测复核：acc-1 被限流时 resolver 给 acc-2、refresh 给 acc-1。⚠️ **本 PR 未修** —— 修法要改接线层签名（把当前账号透进 `refresh`），影响面超出本 issue 范围，建议单独立项 |
| **P1-2** | `sendOnce` 里 `credential = refreshed` **先于**反查赋值，反查失败被 `catch {}` 静默 ⇒ 冷却记到**无辜账号**、真凶漏记、同号重发 | ✅ **已修** + 3 条行为守卫。反查前移到赋值之前；反查失败时**整段放弃重发**（退回原 401 走换号）⇒ 发请求的账号与被记账的账号永远一致 |
| **P2-1** | `markCurrentAccount` / `rotate` / `refresh` 三处 `await` 无 `try` ⇒ 裸 `Error` 逃逸；**记账失败会掐断整个换号流程** | ✅ **已修**：三处各包 `try/catch` + `console.warn`。⚠️ 「失败不影响请求」原先只写在注释里未落实为代码 |
| **P2-2** | `probeById.accio` 的 no-op `refresh` ⇒「重测」拿不到解禁时刻 | ⚠️ **待定**（产品取舍，非缺陷）：`rateLimit: true` 的语义是「有可清标记的入口」，而非「重测能给倒计时」。是否补 `resetTimeMs` 回写应连同 UI 一起评估 |
| **P2-3** | 流内「模型未返回任何内容块」**不是 `LlmError`** ⇒ `code=''` 被当成「不换号」 | ✅ **已登记为无牙**（与 `signal.aborted` 那格同根因：非 `LlmError` ⇒ `code` 归 `''`）。真实形态（空 SSE / 非帧文本）确实零换号，但**归 `other` 是正确处置**（换号无益）⇒ 不修，只在 §11.5 登记 |

### 12.3 常规审计：4 个「守卫零覆盖」（3 个已补、1 个已登记）

| # | 发现 | 处置 |
|---|---|---|
| 1 | `llm-adapter.ts` 的 `rateLimitTried` 修复**零守卫**（退回修复前全套测试逐条相同） | ✅ 已补 1 条行为用例，变异实测 RED（2 条）。⚠️ 复核时又发现**同一格还漏了「加首号」**（§11.6 末），一并修 |
| 2 | `probeById.accio` 的工厂产出**零行为守卫**（凭据接空 / 误持池，两变异均全绿） | ✅ 已补（照 minimax 那条范式）。变异实测：两个都 RED |
| 3 | 流内路径的预算上限 `ACCIO_MAX_ROTATE` **零覆盖**（唯一那条预算用例只喂 HTTP 402） | ✅ 已修：那条预算用例改成 `it.each` 覆盖 HTTP / 流内两格 |
| 4 | 续期后换号**没有回报账本**（`rotate()` 有、`sendOnce()` 没有） | ✅ 已修：`sendOnce` 补 `reportLedgerAccount` |

### 12.4 ⚠️ 两条 subagent 共同暴露的方法论

1. ⚠️ **「守卫全绿」≠「有守卫」**：本轮三次实测到「变异全绿」，其中两次是**真的无牙**，
   一次是**变异根本没注入**（CRLF 上 `replace` 静默不生效）。
   ⇒ 每条「已补守卫」都必须当场跑一次变异确认，别信自己的直觉。
2. ⚠️ ⚠️ **同型多格要逐行对拍，不能只查一处**：`:1451` 那格与 `:1323`/`:1393`
   是同型三格，两家审计都只看到了「没传第 3 参」，**「没加首号」是复核时读代码发现的**。
