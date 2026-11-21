# 限流中断后「解禁自动继续」（2026-11-20）

> 结论先行：**报错行有按钮、到点却什么都不发生**，根因不在客户端、也不在「解禁时刻算错」，
> 而在**解禁时刻只剩一条来源可用**，而那一条在本仓**从来没人填**。
> 本文记录实测取证、三条判据的分歧，以及为什么现在把它做进宿主而不是继续用外部补丁。

## 一、缺陷：按钮在，钩子却永远用不上

### 症状

会话因「可用账号均在限流中，最近一个将于 X 解禁」中断后，报错行尾的「解禁后自动继续」
按钮**渲染正常、点得动、状态也存得住**，但到了文案里写的那个解禁时刻**没有任何动静**。
用户最后都是自己补一句「继续」。

### 取证（本机 209 个会话，逐帧解 zstd 后统计）

| 观测 | 数值 | 含义 |
| --- | --- | --- |
| 真实限流失败数（`turn/end` + 限流类） | **61** | 样本足够 |
| 其中带 `providerRetryAfterMs` | **0** | 唯一的「机器通道」在本仓从未被填过 |
| 其中文案带「将于 … 解禁」 | **57** | 真正的解禁时刻就在这段人话里 |
| `rate-limit-resume.json` 里 `hooks` | 恒 `[]` | 说明「记下钩子」这步从没留下过东西 |
| 会话日志里 `source.kind === 'rate-limit-resume'` 的投递 | **0** | **一次都没成功续跑过** |

⚠️ 最后两条是关键：它把「偶发的时机问题」排除掉了 —— 这个功能在本机**从未生效过一次**，
只是界面看起来是好的。

### 三条判据分歧（都是补丁版与真机的差距）

1. **解禁时刻只读 `providerRetryAfterMs`**。该字段是 `LlmFailure` 的**可选**字段
   （`> 0` 才允许出现），而 providers-hub 的适配器**没有一个填它**（实测 0/61）。
   于是解禁时刻恒退到「1 小时后」兜底 —— 而文案里写的是「18 分钟后」。
   1 小时后那次，用户早已自己补了「继续」，钩子被「用户手动发言」撤掉 ⇒ **永远不触发**。
2. **`no-live-agent` 直接放弃钩子**。而「等一小时」几乎必然跨越宿主重启 / 用户切走会话，
   那时会话不在内存里 ⇒ 钩子在解禁那一刻被静默删掉。
3. **任何 `user/message` 都当成人发言**。DSH 里 `runtime-context` / `dsh-memory` /
   `skill-catalog` / `agent-instructions` / `tool-jobs` / `plugin:repeat-guard` 等
   **全部以 `user/message` 落盘**（实测一个会话里这类注入有几百条）⇒ 钩子随时被
   无关注入清掉。

## 二、修法

### 解禁时刻：三条来源取最早

| 来源 | 判据 | 本机命中 |
| --- | --- | --- |
| ① `providerRetryAfterMs` | `LlmFailure` 的机器通道 | 0/61 |
| ② 文案「将于 YYYY/M/D HH:MM[:SS] 解禁」 | **必须锚定整句**（`将于` + `解禁` 夹住时间） | 57/61 |
| ③ 号池 `modelRateLimits`（`allAccountsRateLimitedForModel`） | 与选号侧同口径（只看启用账号、取 min、只认未来） | 取决于池状态 |
| 兜底 | 1 小时 | 三条都无 |

⚠️ **取最早，不是取最晚**：到点会先复核号池，仍受限就顺延；反过来会让用户在本可续跑
的时刻干等。这与 `allAccountsRateLimitedForModel` 取 `min` 是同一个理由。

⚠️ 解析**必须锚定整句**：只认时间戳会把文案里别的日期（例如资源包到期日）吃进来，
排出一个毫无意义的远未来时刻。用例里有一条专门拿「将于 2027/01/02 03:04:05 到期」证伪它。

### 会话不在内存：留钩子，等它回来

- 投递失败（`no-live-agent` / agents 未就绪）⇒ 保留钩子，按 **2 分钟**重试，上限 48 次。
- 监听 `agent/created`：会话重新变成 live 的那一瞬**立刻补一次投递**。
  ⚠️ 判「该不该抢跑」读 `unlockAtMs`（真解禁时刻），**不是** `resetAtMs`（下一次重试时刻）——
  后者在投递失败后会被推成「现在 + 2 分钟」，与解禁无关。

### 撤钩子：只认人类输入

只认 `source.kind === 'user'`（宿主对「直接人类输入」的**证明**）。另外：
- 会话开了新回合（`turn/start`，且不是我们这次投递引发的）⇒ 撤；
- 该轮**正常收尾** ⇒ 撤；
- `agent/disposed` ⇒ **不撤**（只记一笔），理由同上面「会话不在内存」。

### 续跑消息的来源标识

带自有 `source.kind === 'rate-limit-resume'`，**绝不伪造成 `user`** —— 与
`loop-recovery.ts` 的 `LOOP_RESUME_SOURCE_KIND` 完全同一个理由：`'user'` 是宿主对
「直接人类输入」的证明，`tool-goal` 的 create / edit / pause / resume 都据此授权；
伪造成 user 等于让自动续跑**冒用人类授权**。

## 三、落点与接口

| 位置 | 内容 |
| --- | --- |
| `src/rate-limit-resume.ts` | 引擎（纯逻辑 + 可注入副作用）、`session/event` 与 `agent/created\|disposed` 接线、落盘 |
| `src/jet-hub-rpc.ts` | `resume.getState` / `setArmed` / `setEnabled` / `fireNow` / `forget` |
| `src/index.ts` | `installRateLimitResume(ctx, pool)`，与 `installLoopResume` 并列 |
| `plugin-src/client/rate-limit-resume.js` | 报错行行尾两态图标按钮（原生 DOM + MutationObserver）＋ 设置页「限流续跑」段 |
| `$DSH_HOME/jet-hub/rate-limit-resume.json` | 待续跑记录（跨宿主重启恢复） |

⚠️ **五条 RPC 的状体全在模块级单例上，没有给 `registerJetHubRpc` 加位置形参** ——
那边的派生式不变量明令禁止（可选的**位置**形参会静默把表落进错位置，本仓复发 6 次）。

⚠️ **`RATE_LIMIT_RESUME_*` 的两个时刻要分开展示**：面板与按钮 title 显示
`unlockAtMs`（真解禁时刻），`resetAtMs` 只是「下一次尝试」。

## 四、为什么做进宿主，不再用外部补丁

`dsh-providers-hub-enhance` 那套是**改 `node_modules` 里的已编译产物**：上游一升级就
整目录被覆盖，而且它的三条判据都是「按想象写」的（见上面第一节）。做进 `src/` 之后：
判据与本仓的 `allAccountsRateLimitedForModel` / `AccountPool` 同源、有单测、
`pnpm build:all` 就走同一条构建链。

## 五、守卫

`tests/unit/rate-limit-resume.spec.ts`（22 条），其中三条是**真缺陷回归**，
都能在旧实现上精确变红：

| 用例 | 旧实现的表现 |
| --- | --- |
| 文案里的解禁时刻优先于 1 小时兜底 | 排到 1 小时后 ⇒ 红 |
| 会话不在内存 ⇒ 留钩子并重试 | 钩子被删 ⇒ 红 |
| 5 类注入来源逐个对照不撤钩子 | 第一条注入就撤掉 ⇒ 红 |

另含：定时器边界（解禁前不抢跑 / 号池推后就顺延）、落盘 → 恢复、env 开关的
「只有显式假值才算关」。

## 六、未做（如实登记）

- **不与 `dsh-client-auto-continue` 合并**：那个按「冷却间隔」重试、不看号池解禁时刻，
  合并会丢掉「等到真正解禁再续」这条语义。
- **不做「解禁前主动换号」**：那是选号层的职责（`rateLimitSinkEnabled` / 沉底），
  与「这一轮怎么收尾」是两件事。
