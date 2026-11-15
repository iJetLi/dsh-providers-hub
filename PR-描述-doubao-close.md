# fix(doubao): 供应商开关关不掉 —— 「没有模型腿」的渠道不再被拒绝（真机两轮返工）

> ## ⚠️⚠️ 先读这段：这条缺陷在真机上是**两层**，第一层修完还报第二句
>
> | 轮次 | 真机看到的 | 命中的判据 | 本 PR 的处置 |
> |---|---|---|---|
> | ① | 开关**灰显点不动**，hover 只有「该供应商没有可关闭的模型」 | 客户端 `providerSwitchState()` 的 `models.total === 0 ⇒ disabled`；宿主 `provider.setEnabled` 的 `ids.length === 0 ⇒ bad-request` | 两处都翻（见 §2） |
> | ② | 开关**可点**了，但弹「豆包 (字节) 操作失败：没有可关闭的模型：读取模型列表失败：`no adapter registered for provider "doubao"`」 | 宿主 `provider.setEnabled` 的**第一条**拒绝（`remoteError`）—— 它先于 `ids.length === 0` 触发 | `noModelLeg` 短路（见 §3） |
>
> 两层的共同根因是同一个认知错误：**把「这条渠道没有模型」当成「这条渠道不能关闭」**。
> 而豆包 `channel: false`、`modelAdapters` 里没有它 —— 模型这条腿**根本不存在**，
> 不是「读失败」。
>
> 分支：`fix/doubao-provider-close`（基于 `master@91435df`）
> 文件：5 个（1 宿主 1 客户端 2 用例 1 笔记）

## 1. 缺陷与影响

豆包是**纯签到渠道**（`src/provider-registry.ts` 的 `channel: false`，没有模型目录 /
适配器 / auth 服务）。用户点「供应商开关」想停掉它的账号，结果：

- 第一轮：开关置灰，**点不动**（`aria-disabled` + `onClick` 早退）；
- 第二轮（第一轮修完）：点得动了，服务端**拒绝**并回上面那句；
- 净效果：「关闭供应商」在这个渠道上**永远不可能成功** ⇒ 分组永远留在「已打开」、
  豆包账号永远 `enabled: true`（签到链路照跑），而 UI 给的理由指向一个**根本不存在**的模型列表。

## 2. 第一轮修法：空目录不再等于「拒绝」

### 2.1 客户端 `plugin-src/client/provider-toggle.js`

删掉 `models.total <= 0 ⇒ { checked: true, disabled: true, reason: '该供应商没有可关闭的模型' }`
这条分支（`total` 局部变量随之删除）。**判据顺序不变**：`closed === true` 仍排最前
（Gitee issue IKP8OF：已关闭必须永远可点开）。

### 2.2 宿主 `src/jet-hub-rpc.ts` → `provider.setEnabled`

`catalog.ids.length === 0` 的**拒绝**改为继续走
`pool.writeModelsWithProviderClosed(provider, [], true)`：
空数组分支本就不深拷贝 `modelCache`、**只落关闭意图**，且与黑名单同一次落盘
（IKP8OF 的原子性约定不破）。

关闭的语义始终是三件事：**停用账号 + 关掉目录里的全部模型 + 落关闭意图**。
目录为空时中间那条腿是**空操作**，账号与意图两件照样成立 —— 与打开方向对称
（`provider.setEnabled(true)` 根本不读目录，纯本地清黑名单 + 清意图）。

## 3. 第二轮修法：`noModelLeg` 短路（**本 PR 的核心**）

真机第二轮证明：`fullCatalogIds(id)` 会 `ctx.llm.listModels(id)`，而 dsh 的 llm
**没有豆包的 adapter** ⇒ 读一次抛一次 ⇒ 命中 `remoteError` 拒绝。

```ts
const noModelLeg = !req.enabled
  && descriptorOf(req.provider)?.channel === false   // ① 自报不是模型渠道
  && modelAdapters?.[req.provider] === undefined     // ② 本仓库也没有目录来源
if (noModelLeg) {
  await pool.writeModelsWithProviderClosed(req.provider, [], true)  // 只落意图
  modelCount = 0
} else if (req.enabled) { …打开… } else { …原有远端核实，两条拒绝原样保留… }
```

### ⚠️ 判据为什么必须**两条同时成立**

| 只用其中一条 | 会踩的坑 |
|---|---|
| 只判 `channel === false` | `codely` 同为 `channel: false`，但它有 `codely-adapter.ts` **目录来源** ⇒ 跳过模型腿会让「关闭 provider 后模型仍可选」的旧缺陷（IKJW33）复活 |
| 只判「无适配器」 | 外部/旧适配器装机形态（`channel` 仍为 `true`，只是本仓库没有 adapter）⇒ 必须继续远端核实，否则会拿兜底子集写黑名单 |

`remoteError` / `notReady` 两条拒绝**一行未改**：它们约束的是「目录还没读准」，
此时落意图会重新打开「关闭后仍可选」的窗口。

## 4. 验证

| 项 | 结果 |
|---|---|
| `tests/unit/provider-toggle.spec.ts` | **130 passed**（空目录 / 计数缺失 / 非法计数 ⇒ 均可点关闭；`closed:true` 仍可点开） |
| `tests/unit/jet-hub-rpc.spec.ts` | **282 passed**（含新增两条豆包用例） |
| 其余 10 个引用同一判据的 spec | **197 passed**（`ikp8of-provider-closed` / `model-center-panel` / `qiniu-wiring` / `opencode-catalog` / `modelscope-wiring` / `checkin-panel-wiring` / `marvis-adapter` …） |
| `tsc --noEmit` | 本 PR 触及的 `src/jet-hub-rpc.ts` **0 错**（全仓 126 条既有错在 `trae/zcode/index` 等未改文件，属本机 `@deepseek-ai/dsh-llm` 版本漂移） |
| `node plugin-src/client/build.mjs` | 构建成功（`lib/` 不入库） |
| 产物级校验（对安装副本） | 去注释后执行序 `noModelLeg = → if (noModelLeg) → else if (req.enabled) → fullCatalogIds → setAccountsEnabled`，即短路在读目录**之前** |

### 新增回归锚点

1. `⚠️ 目录为空 → 仍可关闭（停用账号 + 落意图；不再是拒绝）`
2. `⚠️ 远端为空且适配器缺失 → 仍可关闭（落意图 + 停用账号，status 联动报 closed）`
3. `⚠️ doubao（channel:false 且无适配器）→ 不读目录，关闭成功` ——
   把 `llm.listModels` 设成「一读就抛」，**锁死「压根没调用 listModels」**这条行为

## 5. 行为对照（豆包）

| 时刻 | `provider.status` | 开关 | 豆包账号 |
|---|---|---|---|
| 修复前 | `total:0, closed:false` | 灰显 / 点了报 no adapter | 永远 `enabled:true` |
| 关闭后 | `total:0, closed:true`（**意图腿**） | 「已关闭」且可点开 | 全部停用 |
| 再打开 | 清意图 + 清黑名单（单次落盘） | 「已启用」 | 恢复启用 |

## 6. 影响面与回滚

- 只动 5 个文件；`lib/` 是构建产物（已 gitignore）。
- 其它 27 家渠道：`channel === true` ⇒ `noModelLeg` 恒 false ⇒ **路径逐字节不变**。
- 回滚：`git revert` 本提交即可；真机侧备份见 `docs/agent-notes/providers-doubao.md` §3/§4。

## 7. 遗留

- §3 的修复已在 §4 的用例与本机安装副本上验证，**真机 15205 尚未验证**（该进程从未重启，跑的是旧内存映像）。
- 若真机仍报同一句，则属第三层形态，需按现场日志（`journalctl -u dsh-web-15206` / `[jet-hub]` 行）继续定位。
