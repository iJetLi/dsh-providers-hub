# 项目指令：dsh-providers-hub

> 本包原名 `dsh-codearts-auth`（`0.2.0-rc.11` 起改名）。**包名 = 插件身份**：
> `package.json` 的 `name`、`cordis.patch.yml` 加载行 `name:`、`build.mjs` 产物注册 id、
> `jet-hub-styles.js` 的 `PLUGIN_ID` **四处必须逐字相同**，缺一处都是静默失效（Issue IKLUME）。
> 老用户 profile 的迁移见 README「⚠️ 从旧包名 `dsh-codearts-auth` 升级」；
> 文档正文里出现的旧名多半是**历史实测记录**（带日期），不要跟着改。
## 深细节索引（按需读，不进每轮注入）

以下主题的**事故史与逐项规则**已搬到 `docs/agent-notes/`（每节逐字节原样保留）。
**触发条件命中时才读对应文件**——改某 provider 前先读它的笔记；做 UI 前读 client-ui；
动协议/网关/积分前读 protocol-wire。别凭印象改：这里的每一条都是踩过坑的。

- `docs/agent-notes/dev-tasks.md`：「常见开发任务」的**调试与协议排障**细节（主文件只留导航表）
- `docs/agent-notes/misc.md`（8 节）：⚠️ 两条通用判据：一文件两套同义判据 / `String(undefined)`（PR !62）；⚠️ 包装适配器时必须包 `prepareCall`，不是 `stream`（PR !66）；项目概述（十个 provider 的协议源流与差异总览）；⚠⚠️ 客户端**不得**注册 `settings.models.provi；⚠️ dsh peer 范围必须**枚举并集**，不能用 `^0.1.2-r；LobsterAI 模型列表（三个易踩的坑）；…
- `docs/agent-notes/providers-qoder.md`（7 节）：⚠️⚠️ **出口代理与失败分类（2026-10-25 审计 3 域合规 + 2 域对抗 / 67 次变异）**：⚠️⚠️ **网关 5xx 原先不换号，而它才是实测主导形态** —— 扫本机**全部 1374 会话 / 163 条真实失败**按形态计数：`504 Gateway Time-out`（HTML）**74 次** + `First Token Timeout`**6 次**都落 `other` ⇒ 不换号，且终态 `SERVER` 在宿主 `DEFAULT_RETRYABLE_CODES` 里 ⇒ **白重试 5 次**；而本 PR 原以为的核心目标 `provider_error` 只有 **16 次**；⚠️⚠️ **折算路径没接 per-账号代理 ⇒ 墙外环境下该渠道从聚合轮换里静默消失**（本 PR 接了四条腿、漏了折算；`index.ts` 明写「credits 与 expiry 两条腿缺一不可」，`minimaxIntlFetchFor` 的注释逐字点了同一个症状）；⚠️⚠️ **非法代理字符串会让账号永久不可用，且入口 UI 可达**（`backup.import` 真跑实测 `ftp://host:21` ⇒ ok:true + 落池 + 此后每次取 fetcher 都抛）；⚠️ **代理口令的泄漏面：去向决定定级**（对抗轮实测宿主 logger 0 命中 / 客户端 console 零命中 / 不落盘 / 不进会话历史 ⇒ 由 P0 降 P2，因为**没有一条后果链能到达「用户以外的人」**）—— 但仍修了两处（`testProxy` 文案不再自拆台、四家日志统一走中立 `proxy-mask.ts` 脱敏）；⚠️ 两处**未修已登记**（401/403 把额度判在认证之前 = 结构可达零实测且 A1 的修法会丢上游原文；`auth` 行的「换号」也没实现 ⇒ 池里第二个号永不被尝试，且 `'AUTH'` 永不入参 ⇒ 那格是死代码）；⚠️ 安装（git 插件）的 allowBuilds 键在 pnpm 10 / 11 语义**互不兼容**（Issue IKJCOC）；⚠️ 额度类业务码**不是一个值，是一条链** —— 只认 `110` 会让换号静默失效（Issue IKKJFH，码值腿 + 文案腿必须同时在）；⚠️⚠️ **静态兜底表必然腐坏 ⇒ 已改走远端 `/api/v2/model/list?Encode=1`**（2026-10-20 用户报障：上游 `dfmodel` 已 `price_factor=0`+`is_free`、IDE 显示 `0.1×`划掉`0×`，插件还写 0.1；同批 `mmodel` 已改名 `MiniMax-M3.1-Flash`）：`Encode=1` **不保证响应加密**（两站实测都回明文，官方 `rb()` 是「失败即明文」）、WASM 自己补 `/algo` 前缀、响应是 `{场景:[模型]}` 取 `chat`；⚠️⚠️ **`fast` 拿不到是版本闸门不是缺陷**（`minimal_version` 按**自称的客户端类型**选命名空间：cli 需 ≥1.1.70 / app 需 ≥1.1.66，IDE 是 app+1.1.69，我们是 cli+`COSY_VERSION=1.1.49`）—— 刻意**不抬 `COSY_VERSION`**（它同时被推理签名使用）；⚠️ **目录按账号下发**（实测一个免费号只给 2 条），缓存是「上次成功那个账号的目录」；⚠️ **取数必须在 auth 服务里只读池**（`QoderAuth.fetchModels(pool)`），走 `resolveCredential` 会把「本次实际使用的账号」改写成目录用的账号 ⇒ 额度标记落错号；⚠️⚠️ **该端点对伪造凭据也回 200**（中途一版让单测真发 HTTPS 并拿到上游真表，4 条用例静默变随机真值）⇒ 适配器改为注入式取数、单测默认不接线；⚠️ 既有的 `qodercn` e2e「续期」用例**是写操作**（轮换 `refresh_token` 且不落盘）已加二次确认闸门；⚠️「1017」版本串**不在模型列表里**（在 IDE 遥控文案 `/ide-text/latest`）；⚠️⚠️ **审计补记（2026-10-20 subagent 一轮审计 + 对抗审计）**：①**真缺陷** —— 远端目录是**按账号**下发的，把 `inputModalitiesFor()`/`stream()` 的元数据判据改成「只查远端」后，目录里没有的模型被**硬拒图片**且 name/context/reasoning/请求体元数据一并退化 ⇒ 修法是**能力与元数据取「远端 ∪ 静态表」、菜单仍远端独占**（`resolveModel` 用「静态表专用的第二个骨架实例」做回退，别在适配器里重写装配）；②`isFree` 从未透出（Jet Hub 免费桶只认它）；③**六条假绿**实测（`refresh()` 空转仍 49 passed / `supportsDisable` 恒真 175 passed / `parseEfforts` 排序 175 passed / `readString` 去非空 175 passed / 删池读 `.catch` 111 passed / 兜底表置空 9 passed —— 后者是 `toBe(fallbackModels.length)` 同义反复）；④解析口径按官方产物对齐（白名单 `k3` **6 值无 `minimal`**、`efforts` 认**数组/字符串/对象**、`available_reasoning_effort` 是**thinking_config 对象要包一层**且按短路语义只在「条目自身无档位也无 `disabled`」时读、顶层 `default_effort`、`isDefault` 驼峰、顶层 `supports_disabled`）；⑤**三条过程教训**：「守卫有牙」≠「取值域正确」（缺陷 ① 就是从这缝里漏的）、**新写的守卫自己可能是假绿**（我的图片用例没先把远端目录读进缓存 ⇒ 变异打不中）、变异锚点必须先自证（CRLF + 缩进变化 ⇒ 报 `PATCH-NOT-APPLIED` 而不是「无牙」）；⑥未修已登记：折扣展示口径与官方 `yo0()` 分叉（官方**不做 `before×discount` 乘法**）、`refresh()` 失败后 TTL 上界丢失、真加密分支零覆盖、黑名单 ⊃ 收缩目录 ⇒ provider 被隐藏
- `docs/agent-notes/client-ui.md`（26 节）：⚠⚠️ **`notice` 类状态必须是对象形状；接线层守卫只能靠行为级**（2026-10-22 白屏 + 2026-10-25 审计：三条源码文本断言各有一个真实旁路 —— 三元字面量 / `['length']` / `if (false)` 包归一化，三者同时注入时 41 条相关用例**全绿**而代码**确实抛** `TypeError`；⚠️⚠️ 那个「`jet-hub.js` 根本 import 不了」的前提**是错的**，被仓库自己的 `jet-hub-tdz.spec.ts:99` 证伪 ⇒ 真守卫是 `tests/unit/jet-hub-panel-wiring.spec.ts`（真渲染 + 真调用 `useCallback` 回调）；⚠️⚠️ 宿主 `SlotErrorBoundary` **从 `0.1.0-rc.8` 起就有** ⇒「插件内没有边界 ⇒ 整页清空」**归因不成立**，插件边界的价值是可读文案 + **可恢复**（宿主 abdicate 对非 chain 槽永久、失败记录只在插件重载时清除）；⚠️「不必重启」**成立**（关掉设置再打开即恢复，宿主 `open && <SettingsPanel>`），真缺陷是**恢复路径不可发现**）；⚠⚠️ **包名 = 插件身份** —— `package.json.name` / `cordis.patch.yml` 加载行 `name:` / `build.mjs` 产物注册 id / `jet-hub-styles.js` 的 `PLUGIN_ID` **四处必须逐字相同**，漏一处启动即 `N entry did not activate` 并被自动禁用（Issue IKLUME；含「闸门必须写在 build.mjs 里，`pnpm add git+…` 不跑 vitest」「判据必须打在行为上，源码正则有假红假绿」「第三条腿在用户 profile 的 `dependencies` + `dsh.profile.bundles`，失败全静默」）；⚠⚠️ 注入的 `<style>` **必须署名 `data-plugin`**，否则被别的插件认领后连带删除（Issue IKK764）；⚠⚠️ **源码文本断言的共同弱点：`if (false)` 短路禁用**（2026-10-16 对抗审计实测 5 条全绿：`setData` / `commitOrder` / `onSortByExpiry` / `onDragEnd` / 指纹 —— 字面量在死分支里照样存在）⇒ 修法是「常量假条件检测 + 缩进级无条件调用检测」，且**两条过程教训**：①判据没抓住先怀疑判据本身（我的启发式找到了**相邻**语句的 `if`）②**变异「全绿」可能是变异根本没注入**（CRLF 上 `replace` 静默不生效 ⇒ 必须打印实际片段确认，锚点未命中要报 `PATCH-NOT-APPLIED` 而非「无牙」）；⚠⚠️ 一键签到的汇总**必须按单位分列**，不得跨单位求和（2026-10-04）；⚠ 「通用面板」里的按钮与弹窗**必须按 provider 分支**（Iss；账号池与多账号（含模型饱和 14003 不许换号）；模型黑名单（Jet Hub「显示列表」开关）；⚠⚠️ **判「某个 id 在不在目录里」时两个目录来源（`listModels` / `listAllModels`）必须取并集**（Issue IKJW33：只用任一个都被实测证伪 —— 冷缓存下 `listAllModels` 是编译期兜底**子集**（cline 实测 3/460）⇒ 误报；而 `opencode` 的 `listAllModels` 恒兜底表 + `listModels` 匿名身份只给免费模型 ⇒ 反向误报 13/13；另含「黑名单必须在 `await` 之后读」与「源码级断言必须锚定片段、并列断言必须用计数」两条测试教训）；⚠⚠️ **「关闭全部/关闭供应商」写黑名单前必须取同一份并集，且「远端读到但为空」也要判**（同一个 `fullCatalogIds` 缺陷的另一入口：远端 `[]` + 兜底表 1 条 ⇒ 只关那 1 条却返回成功 ⇒ 供应商**显示已关闭而模型仍可选**；判据**已按端点分道**（2026-08 修订，别再统一成 `complete`）：`provider.setEnabled` 判 `remoteError`（读到但为空要照常关闭，否则无账号供应商永远关不掉）、`model.setAllDisabled` 判 `complete` 但**并集已全在黑名单时幂等成功**（「全部已关闭」会让 `listModels` 被过滤成 `[]`、与「无账号」同形，不幂等就会误报「没有可关闭的模型」），`account.test` 是刻意例外「尽力而为」不得改拒绝）；目录门控：没有已登录账号就隐藏整个 provider；⚠⚠️ **额度错误的码不得被客户端替换**（Issue IKJVCW：harness 常量 `QUOTA_EXCEEDED_CODE` 的字面值就是 `'QUOTA'`，客户端会丢掉 message 换成「当前请求的额度已用尽」；额度须用字面量 `'QUOTA_EXCEEDED'`，四处产出点缺一不可，含 `httpErrorCode` 的 401/403 短路；⚠️ **不要给 codearts 加「地域封锁」判据** —— 141 个真实会话零命中，那套 marker 是从 cline 照搬的，已撤回）；⚠⚠️ **`AUTH` 码会连 message 一起吞掉，这不是孤例而是复发形态**（Issue IKLBSH：opencode 的 `FreeTierError` 曾抛 `AUTH` ⇒ 用户只看到「API 密钥无效」而「根因是 session id 形状」这句**唯一指路文案**连同报文一起消失；**真实报文取证**于会话 `session-d7c80d34`。凡「文案本身就是出路」的错误（形状门禁 / 账号级拦截 / 需要用户做非登录动作的）码一律避开 `AUTH` / `QUOTA` / `ACCOUNT_QUOTA`，判据可复用 `dead-model-store` 的 `IGNORED_CODES`）；⚠️ **`errorDetail` 要认 `detail` 字段，但展示出口与分类出口必须分开**（IKLBSH A1 + 真实净回归，两轮审计独立确证：本仓库 6 份同义 `errorDetail` ⇒ 该腿只留一份实现 `openai-compat.ts` 的 `detailFieldText`；**但** `httpErrorCode` 拿它的**产物**跑 `isQuotaExceededError` ⇒ 无条件加 detail 腿会**翻转错误码**（detail 含 `out of credits` 时 `INVALID_REQUEST` → `QUOTA_EXCEEDED`；含超限措辞时 → `CONTEXT_WINDOW_EXCEEDED` 并**触发溢出压缩**）⇒ 两条出口 `errorDetail`（展示，含 detail）／`errorDetailForClassify`（分类，不含），分类点只有 `llm-adapter.ts` 两处；⚠️ 证据强度如实标注：868 会话真实失败面零命中，旁证「harness 也产出该字段」**已被审计证伪** ⇒ 「结构上可达、零实测」）；…
- `docs/agent-notes/protocol-wire.md`（17 节）：⚠⚠ RPC 的 `catch` **不得**把失败包成 `ok:true`（Issue IKJOZA）；⚠️⚠️ **网关监听地址**：容器/端口映射下默认 `127.0.0.1` 使映射**永不可达**（Issue IKL7UN），修法是 `DSH_OPENAI_GATEWAY_HOST` 可配 + **拒绝通配地址**；⚠️⚠️ 通配判据**绝不能交给 `new URL()` 规范化**（初版如此、注释自称「无假阴性」，被两轮独立审计实测证伪：`::%eth0` / `::\u200b` / `[::]:8326` 等 14 条 fail-open），而**修法本身也被后两轮各证伪过一次** —— 不可见字符**必须按 Unicode 类别**（`\p{Cf}\p{Cc}\p{Cs}\p{Mn}\p{Me}\p{Zs}\p{Zl}\p{Zp}`）**+ NFKC**，**枚举码点必漏**（`Cf` 有 160+ 个，且 `\u034f` CGJ 是 `Mn` 不是 `Cf`；实测 25 条可绕）；⚠️⚠️⚠️ 更关键的是**「认不出来就放行」这条路线本身必须废弃**（fail-closed）—— 内核把 **`U+3002` 表意句号**（`Po`，NFKC 不折）当 `.`，实测 `0。0。0。0` **真绑全部网卡**；最终修法是加 `isLegalHostText` 只放行 `[A-Za-z0-9.:%_-]`，**先字符闸门（fail-closed）→ 再通配识别（放行未知）**；且**「判据串」与「listen 串」必须分两个函数**（判据剥 zone id、返回值保留 —— 剥了会让 Linux link-local `fe80::1%eth0` 绑不上）；IPv4 还要兼容 `inet_aton` 紧凑写法（`0`/`0x0`/`00`/`0.0.0.0.` 在 Linux 上都是 `0.0.0.0`）；且**必须同步改四处把 127.0.0.1 当常量的 UI/日志文案**（客户端回环判据必须**复用宿主侧实现**，自己写正则会立刻漂移成假阳性）；⚠️ 网关请求体超限**必须是 413、不能是断连**（Issue IKKUBJ：销毁 socket 让 413 发不出去 ⇒ 客户端只看到连接重置、会话永久不可用；上限还须与自家图片声明自洽、`keepAliveTimeout` 必须显式设置）；⚠️ 图片必须按像素预算发**请求版本**，不能恒发原图（Issue !IK；⚠️⚠️ 该节的两条**已实测边界**（Issue IKKX0T）：**报文里的 `100001` 是常量哨兵 = `limit+1`，与张数无关**（12/15/20 三档报的都是它）⇒ **不能拿它反推每张 token**（「15 张估算 99,579、差 0.4%」那条是**巧合式吻合**，已删除）；且 **`617 px/token` 只在小图上成立**（1721×997 → 601~618；2560×1600 → 410~492 px/token，面积涨 2.39× 而 token 涨 3.25×）⇒ `DEFAULT_IMAGE_PIXEL_BUDGET` 的「约 96 张」是**乐观端**（悲观端约 64 张），引用余量必须带区间；buddy 边界应读作**区间 `(8,15]`** 而非「= 15」；单次输出上限（`maxOutputTokens`）必须下发，不能只用来过滤；⚠️ 持久化：DSH 0.1.7 移除 `settings.register；⚠️ 「锁定永久积分」三家**共用一张表与一个端点**，但判据必须各算；⚠️⚠️ **`login.poll` 的失败终态**（Issue IKLI7J，真实报障）：`done:true` **只在成功时下发** ⇒ 其余 provider 失败后删占位条目，与「用户还没授权完」**同形**，而 OfficeAce 唯一那句 `{done:false, error}` 又被前端 `if (!pollRes?.done) return;` 丢掉 ⇒ **任何 provider 的登录失败都只剩静默转圈 5 分钟**（5 分钟是**客户端自己的**轮询上限、不是服务端超时；云侧其实已用 `200 + subscription:null` 讲清原因）；修法 = 三态契约 `{done:true, success:false, error}` + 十余处后台失败统一走 `failLogin()` 记终态（**读后不删**、TTL **读写两侧都判**、终态查询必须在查账号池**之前**、客户端「先判 `success===false` 再判 `done`」顺序不能反、**不得**把「占位条目在但凭据未写」判成失败）——⚠️⚠️ **两轮独立审计各自打穿了第一版修法**，两处都是**用户数据被销毁**、都已修：① OfficeAce 分支原把「交换/落库/回填」罩在一个 `try` 里 ⇒ 落库后回填抛错、或客户端两拍重叠（`setInterval` 无 in-flight 闸门）都会**删掉刚登好的账号与凭据**（改为**三段式 + 单飞表**）；② `failLogin` 把「登录失败」与「登录**成功后的记账失败**」混为一谈 ⇒ 各 provider 的 `pool.updateAccount` 排在凭据落盘之后、落盘失败会抛错 ⇒ 报「登录失败」并删号（改为先判 **`loginCredentialLanded`：凭据在 ⇒ 就是成了**）；另记：**删除不可逆 ⇒ 「读不到池」绝不当成「没有」**（`poolEntryOf()` 返回 `'unknown'` 时只记终态不删号），且计数守卫必须**剥注释 + 两类收尾分开计数**（否则一行注释诱饵、或把 `failLogin` 换成 `recordLoginFailure` 都能配平）；⚠️⚠️ **`reasoning.efforts` 的数组顺序 = 强度序（弱 → 强），不是「默认档排第一」**（Issue IKLIDV）：DSH 把它当**展示顺序**（`dsh-llm` 类型注释 `adapter-preferred display order`）且官方客户端**直接 `map` 不排序** ⇒ 默认档排首位只在**纵向**列表成立，铺成**横向档位轴**就变成「左强右弱」（「开启」贴最左）；强度序权威是 `REASONING_EFFORT_RANK`，三处**我们自己构造**的两档已统一为 `关闭 → 开启`（`llm-adapter.ts` 的 `CODEARTS_REASONING_EFFORTS`＝**唯一定义处** —— 同一文件原先写了**两份**同义数组，只改一份会让用户手填模型 id 时档位轴反向；另两处 `raccoon-product.ts`、`minimax-adapter.ts` 的 switchable 追加档）；⚠️ **`defaultEffort` 与数组位置是两件事，且不得用 `array[0]` 反推默认档** —— raccoon 那处曾如此，顺序一改就会静默把默认档翻成「关闭」（该分支不可达 ⇒ **恒真断言抓不到**，我第一版就写成同义反复、被反向验证当场证伪；改为入参化纯函数 `raccoonDefaultEffort` 才测得动）；⚠️ **Qoder 刻意不重排**：其乱序是上游目录原样（实测 8 个账号键序**完全一致**），重排会让 `verify-qoder-model-meta.mjs` 对账全失效，**排序责任在渲染方**；⚠️⚠️ **网关是最后一道防线：空名工具调用必须「剔除」而不是 400**（Issue IKLRIK：客户端把 `{name:""}` 的 `function_call` 每轮原样重放 ⇒ /v1/responses 与 /v1/chat/completions 两条入口都硬 400、**整条会话永久报废**，而下游九个适配器的 `resolveToolPairing` 对同一份数据都是「剔除并继续」⇒ 同一仓库两套口径且更严的一套在最外层）；判据**可推广**：网关的消费者是「把历史全部回传」的客户端（Codex / Claude 系）**没法自愈** ⇒ 凡「下游会剔除」的坏数据网关不得比下游更严；修法四条缺一不可（入站两端口径共用 `hasUsableToolName` 且**只放宽 name 这一格**、`id`/`arguments` 缺失仍 400；**两处都要预扫并剔除配对的工具结果**否则留孤儿；出站三处 `name` 覆盖加非空守卫——空串**不是** `undefined`；**名字始终不可用的 `function_call` 一个事件都不发**，`added` 发了就改不了 `name`）；⚠️⚠️ 响应向**帧类型与已开项 kind 不符**时旧代码会用**该既有项的 id** 发事件（实测三方向：A `reasoning`+`tool-call-delta` 用 `rs_…` id 发增量=**本次报废会话的起点**、B `function_call`+`text-delta` 正文**静默丢失**，两者**有牙**；C `block-end` 撞已开项**无牙**——`closeItem`/`outputItemJson` 仍按 `item.kind` 输出、`output` 逐字节相同 ⇒ **刻意不写用例**，保留只为「流式与非流式同口径」）；⚠️⚠️ **`closeItem` 判据必须读「名字现在是否可用」，不能读「曾经发过 added（`announced`）」**——`block-end` 才是名字的**权威来源**（适配器在收尾循环补发），以 `announced` 为判据会把「名字与参数都齐全」的真实调用**整条丢弃**（比改前更糟，我第一版就写错了）；⚠️⚠️ **两条由独立审计打穿的真回归**（都在本修法内、且**全量测试全绿** ⇒ 只有盯不变式的审计才抓得到）：① **非流式 `output[]` 顺序被翻转**（`output_index` 语义＝**开项顺序**，而各适配器收尾顺序**相反**；我让流式在「名字可用」占号、非流式在「收尾」占号 ⇒ 三工具收尾逆序实测 `["cC","cB","cA"]` vs 流式 `["cA","cB","cC"]`；修法＝两条路径共用**同一时刻**的幂等 `assignOutputIndex`；⚠️ 原有用例锁不住——「顺序正确的单工具」是**恒真**的，判据必须写成「两条路径给出相同顺序」且输入含**并行工具+收尾逆序**）；② **坏块会话产出「空 assistant 消息」把 400 挪到上游**（剔除坏调用后该 assistant 留成空 content、成为 wire 开头发言且无 user ⇒ `model_param_invalid`；修法＝`tool_calls` 全剔光**且**正文为空时整条剔除，⚠️ **正文非空者必须保留**——那是模型真实发言）；⚠️⚠️ **方法论**：变异验证有一处**实测无牙**（非流式新建时急躁占号——该变异态与修复态**逐字节相同**）⇒ **无牙要如实登记，绝不为它编恒真用例**；且用跨模块副本做变异时 `instanceof` 断言会因**类身份不同**而**假红** ⇒「用例变红」**不自动等于**红因是被测变异；⚠️ 另：本守卫与权威实现 `BlockAssembler` **语义有分歧**（它对异类 `block-end` 是**采纳**、我是**忽略**，实测两方向各丢一个完整工具调用）——**已核实**且**有意保留**（采纳在流式**不可行**：`added` 已发就改不了类型，非流式单独采纳会让两路径分叉），代价已如实登记…
- `docs/agent-notes/providers-buddy.md`（6 节）：模型计费倍率与同名模型（必须写进 `name`，不是 `descriptio；⚠️ CodeArts benefit（免费额度）模型：集合必须动态判定，不；⚠⚠️ 腾讯系内容级风控：system 里的客户端模板句会被**整轮拦死**；⚠️⚠️ 第二条指纹（Claude Code 身份句，Issue IKLS2L）的锚点与第一条**相反** —— 该句是**行首锚定**（前接任意一个字符即放行），故新增指纹的探针必须**两侧都测**，只测「夹在句中」会得到**假阴性**；⚠️⚠️ 第三条指纹（Claude Code 反馈句，Issue IKLYCT）**每轮必带**且位置无关、`find` **必须写整句**（砍掉任一半即放行 ⇒ 写短了等于空跑）；⚠️⚠️ **第四条指纹 = DSH 自己的身份首句**（`You are an AI agent powered by DeepSeek Harness`，**每轮必带**、行首锚定），2026-10-21 起 `replace` 换成**官方同形**措辞 `You are an AI coding assistant, powered by a large language model`（取证：CodeBuddy 会话 `8c9dbeb1…` 的 reasoning 复述 + 客户端 `product.json` 提示词资产两条独立来源一致 ⇒ 官方首句是 `You are an AI coding assistant, powered by <模型展示名> model.`，**与本句同形、只差 Y 填模型名还是 harness 名**；旧 `replace` 把 `DeepSeek Harness` token 原样留着 = 只躲字面量不解决身份）—— ✅ 2026-10-21 实发验收通过（buddy 站新措辞干净 200，`pnpm test:e2e:buddy-fingerprint` 全文件 45/45、ds-v4.1-flash、两轮一致），⚠️⚠️ 且该句**端点相关**：`www.workbuddy.ai` 对同一句**两模型实测均不拦**，只有 `copilot.tencent.com` 拦（登记时只测过后者的账号）；⚠️⚠️⚠️ **第五条指纹 = DSH Web 运行面那两句**（`dsh-harness-dev-context` 的 `WEB_SURFACE_PROMPT` 前两句、221 字符，**只在 Web 运行时挂载** ⇒ CLI / 桌面面的「真实整段」测不到它）：2026-10-21 真实报障「只改第 1 行仍被拦」的**真凶** —— 该字面量**单独就能拦**且**位置无关**，而裸 token `DeepSeek Harness` **放行**（**不是**「认 token」）；`find` 就是这 221 字符（220 前缀放行、**切句两半各自也放行** ⇒ 写短 / 写散都**空跑**）；`www.workbuddy.ai` **不拦**；已补单测（含本机**漂移守卫**：读会话落盘的真实 system，往 find 注入一个空格即**精确变红**）+ e2e 第 5 节（含 `★★` **多出现位置**那一格）；⚠️ **漂移风险未解**（DSH 改这两句任一字符即静默失效）；⚠️⚠️ **`11128` 有两个同码子原因**（`unapproved channel`=内容级 / `request illegal`=**按账号**的渠道门控）⇒ 探针**必须先筛基线放行的账号再固定用它**，轮换账号会实测出「短前缀被拦、长超集放行」的**非单调假结论**；⚠️⚠️ **「不该把 11128 加进 `isContentRejection`」≠「判据不会因它误判」** —— 腿③ 扫**全文案**会绕过排除逻辑，2026-10-18 实测真会把内容级 11128 判成账号级⇒烧整池+锁 30 分钟（已加 `isContentBlockedIllegalBody` 同型早退）；且腾讯两站对**非流式**请求回 `11101`，探针不带 `stream:true` 会把「不支持非流式」误读成风控拦截；⚠️⚠️ **`reasoning_effort` 是 buddy 系 deepseek 的「思考开关」，不是可选强度** —— IKLMIY「为保住正文而不发它」已**撤回**（`e261cd6`，用户取舍「思考优先于前言」；复测：不发该字段 `reasoning_tokens` **10/10 恒为 0**，`thinking:{type:'enabled'}` 单独无效）
- `docs/agent-notes/providers-cline.md`（5 节）：⚠️ Cline provider：`workos:` 前缀不可剥、免费集合；⚠️ Cline 限流：倒计时用**报文里的人类可读时长**，402 不许倒；⚠⚠️ **模型目录构建的 O(N²)**（Issue IKL3YH：`remoteModels.find` 热点 + `resolveModel` 每次整份重建目录；N=471 实测 312ms → 1.5ms；缓存失效判据必须按**数组身份**不能按长度，兜底表还须记忆化否则缓存被架空）
- `docs/agent-notes/providers-trae.md`（2 节）：TRAE（字节跳动）协议要点（五个易踩的坑）；⚠️ 流内 `code=4006`（体积超限）**不得**归 `SERVER`（Issue IKKX0T：原先落 `SERVER` ⇒ 巨型请求体被**原样重发 5 次**；修法是抽出 `streamErrorCode()` 逐格表，4006 → `CONTEXT_WINDOW_EXCEEDED` 以**兼得「不重试」与「触发溢出压缩」**；⚠️ 4001 与 4006 不可合并、`502+HTML` 刻意不动）
- `docs/agent-notes/providers-codearts.md`（4 节）：⚠️⚠️ **三个「非凭据问题」业务码必须各自单列（2026-11-05，Gitee PR #175 评审 + UA 修复兜底）**：`TM.00000001`（WAF 按 UA 首 product token 拒发，重试无效 → `PERMISSION`）/ `TM.00001041`（账号并发上限 3，等 1~2 分钟即好 → `RATE_LIMIT`）/ `TM.000010051`（模型未在本租户开通 → `PERMISSION`）—— **三码不可合并**，把 `TM.00000001` 归 `RATE_LIMIT` 会让确定性失败白重试 5 次（宿主 `DEFAULT_RETRYABLE_CODES` 含它）；判据必须「精确业务码 + 数字边界 + 大小写敏感」（`TM.00000001` 是 `TM.000000011` 的前缀，同 `429`/`4291` 那格）；⚠️ 只作用于 **403** 出口（400 形态的排队自愈逐字节未动），⚠️ **SSE 流内不动**（PR #175 把流内该码改成立即抛错 = 拿掉自愈，是回归）；守卫 `tests/unit/codearts-gateway-classification.spec.ts` 10 条 + 变异 6/6 有牙（删 `isAuthError` 排除 ⇒ 3 红、去数字边界 ⇒ 2 红）；⚠️⚠️ **华为 WAF 按 UA 前缀拒发（2026-11-05 真机）**：宿主默认 UA `deepseek-harness/<ver> (+url)` 被 WAF 回 **403 `TM.00000001 网络繁忙`**（判据 = **行首前缀 `deepseek-harness/`**、大小写敏感；裸 `deepseek-harness` / `deepseek-harness-x/` / `DEEPSEEK-HARNESS/` / `VSCode/` / `Mozilla/` / `curl/` / `claude-code` / `opencode` / `cline` 全部 200 ⇒ 不是「拦所有 AI 客户端」）⇒ 403 落 `AUTH` ⇒ 客户端把报文**整条换成「API 密钥无效」**（假原因）+ 每次失败白跑一次**一次性轮换**的 `refresh_token`；修法 = 推理请求覆盖成官方 IDE UA（`codearts/1.0.0-1147257973136832`，逐字取自内核 `--user-agent=` 启动参数；**UA 不参与签名** ⇒ 覆盖不破验签）；⚠️ **只改推理腿** —— 目录（`fetchSignedGet`）/ 积分 / 签到**不显式设置 UA**（Node 的 `fetch` 会补 `user-agent: node`，实测放行），这正是「模型列表正常、一发消息就报密钥无效」的由来；⚠️⚠️ **上下文窗口：上游两个目录端点都不下发**（`/v1/model/builtin` 条目键全集实测无任何 context/window 字段；`gateway/config` 本机 4 账号全回 `4000 invalid channel`），权威来源是 **IDE 内核日志 `~/.codeartsdoer/codearts-data/log` 的 `provider["inferhub-provider"].models[*].limit.context`**，且**该值会变**（`GLM-5.2` 10-21 起由 `202_752` 改 `1_048_576`）；⚠️⚠️ **缺窗口的真实后果不是「显示 0%」而是占用条整条不渲染** —— `dsh-client-ui-conversation` 的 `contextOccupancy()` 在 `contextWindow === undefined` 时返回 `null`、`ContextMeter` 随之 `return null`（分子来自 `assistant/message.usage`，本家一直正常；**分母**才是唯一会错的地方，落盘判据看 `request/context` 事件有没有 `contextWindow` 键）；⚠️ 修法三条腿（静态表校准 + 具名兜底 `CODEARTS_FALLBACK_CONTEXT_WINDOW = 524_288` + 骨架可选回调 `unknownModelContextWindow?(modelId)` 仅 codearts 声明），⚠️⚠️ 两条踩过的坑：**回调必须传 `modelId`**（第一版无参返回常数 ⇒ `glm-5.3` 不在静态兜底目录里 ⇒ 离线拿到兜底值、分母错 2 倍，全量测试抓出），**`listModels` 的返回值里没有 `contextWindow`**（`LlmModelInfo` 没这个字段，只有 `LlmResolvedModelInfo` 有 ⇒ 断言写错会「假红」）；⚠️⚠️ **图片输入：只有 VL 模型（`kimi-k2.6-vl` / `Qwen3-VL-235B`）能收图**（`supports_images` 实测），IDE 是**两段式**（VL 模型看图→文字→主模型，`analyzeImage` 工具 + `fetchMultimodalModelId` 恒定选 `kimi-k2.6-vl`）；⚠️ wire 形态**四选一只有 `{type:'image_url',image_url:{url}}` 被接受**（字符串形态 406 / `{type:'image'}` 400 / `input_image` 406），而本机 IDE 日志里 `image_url` **零命中** ⇒ 只能实测；⚠️⚠️ **模态声明是唯一开关**：`dsh-llm` 在 dispatch 前对「声明不含 image」的模型把图替换成 `[image omitted…]` 占位文字，图**根本到不了适配器**；⚠️⚠️ 两条踩过的坑：`prepareCall` 里原有的 `inputModalities: ['text']` **硬覆盖**会静默抹平目录算出的模态、VL 模型**刻意不在目录里**所以必须改 `unknownModelInputModalities(modelId)`（只改 `toCatalogEntry` 恒无效）；⚠️⚠️ **`analyzeImage` 真机验收抓出的真缺陷：已拼好的 `image_url` 块被静默丢弃**（`userContentParts` 只认 harness 原生 `{type:'image',attachment}`；且 `serializeMessages` 在 `imageUrls === undefined` 时整段跳过 ⇒ 识图请求不传该表 ⇒ 两处同因，必须同修；症状是 HTTP 200 + 正文正常 + 上游零报错，只有答案是「我看不到图片」）；⚠️ 排查两坑：**`fetchImpl` 的 404 桩会把所有请求拦掉**（真机验收必须移除）、**CRLF 文件上跨行锚点的变异会静默不生效** ⇒ 先打印「锚点存在: True/False」自证
- `docs/agent-notes/providers-loomy-raccoon-minimax.md`（3 节）：⚠️ Loomy（讯飞）provider：七个不能凭直觉改的点（第 6 条 = **图片能力覆盖表**：远端对 `qwen-3.8-max` 漏报 `input_modalities`，2026-10-14 实测能读图 ⇒ 远端与兜底两条路径都必须过 `loomySupportsImage`；第 7 条 = **额度冷却终点是 UTC+8 当日 24:00，不是「撞墙 +24h」** —— 滑动窗口让 23:50 烧光的号被封到**次日 23:50**，用户看到「0 点后上游已能用、插件仍说没到重置时间」（Gitee **IKL80H**，2026-10-15 修；判据抽在 `loomyCooldownResetAtMs`，⚠️ **别照抄 raccoon 的 +24h** —— 两家的**分类表**必须逐格同构，**冷却时长**刻意分开））；⚠️ Raccoon Work（商汤小浣熊）provider：不能凭直觉改的；⚠️ MiniMax Code（中国版 + **国际版**）provider：不能凭直觉改的点（§0 = **双站点用两个 provider id**（`minimax`/`minimaxintl`，只差 6 个字段、其余共用全部实现）—— 为什么不走「单 id + 站点落凭据」：**模型目录按 provider 缓存一份**，单 id 下另一站的模型要么不进列表、要么被静默回退成本站模型（MiniMax 对不存在的模型名回 **HTTP 200 + 静默回退**）；⚠️ 两站共用适配器类 ⇒ `probeById`/`WRITES_RATE_LIMIT_PROVIDERS`/`SELF_HEAL`/ref 前缀表/积分表**每处都要两站到位**，漏一处静默失效；✅ **2026-10-15 真机验证通过**（推理/签到/积分全部 200，与国内站同形、认证同为 `Authorization: Bearer`；官方 mcode 探针实测的推理头也只有它）；⚠️⚠️ **传输级重试已补齐**（`fetch failed` 真实缺陷：环境 HTTPS 检查代理约 50% 概率打断到本家的请求，插件的推理/目录/签到三处**共用同一份** `minimaxFetchWithRetry`，实测裸 fetch 5/10 → 10/10；四条边界：「只重试传输错误」「abort 不重试」「必须沿 cause 链找真因」「重试耗尽抛原错误保住 cause」）；⚠️⚠️ **但中途一段「国际站要求阿里云 ALB 网关签名、不可用」的结论已被证伪**（那是把上游故障窗口当成了设计；决定性证据是官方 mcode 自己也连不上、`Code: 50112` = 官方枚举 `LLM_AUTH_ERROR`）—— 教训：**区分客户端 bug 与服务端故障时先让官方/参考实现复现**，且**诊断脚本绝不该对真实凭据发起 refresh**（我因此烧掉了用户两个账号的 token）；⚠️ 另记仍然成立的判据：**国际站目录端点当前是公开的（无 token 也 200）⇒「目录能读到」不构成凭据有效的证据**；核验入口 `pnpm test:e2e:minimaxintl`；§8.7 = **请求级换号 + 冷却**与真机实测的错误报文形状，Issue IKJW32；⚠️ 该家写标记后**必须**同时在 `probeById` 与 `WRITES_RATE_LIMIT_PROVIDERS` 里，否则标记清不掉）
- `docs/agent-notes/backup.md`（7 节）：⚠️ **账号备份**：三种「只加不覆盖」的语义边界（选账号导出 / 合并导入 / 第三方转换）；裁剪必须在**发请求之前**且要裁三处；合并导入的判重是**三层**（第 2 层身份字段是关键，含 `IDENTITY_FIELDS` 候选表）；`AccountPool.mergeAccounts` 只调 `writeAccounts`；与「永久积分锁定表」的交叉点；与 `pruneAccountsWithForeignDomain` 的交叉点（残余风险）；测试与反向验证表
- `docs/agent-notes/providers-opencode.md`（7 节）：⚠️⚠️ **key 形状闸不得绑死前缀（Issue IKPLRU）** —— 上游 2026-10-22 起签发 `oc_sk_…`，而形状闸写的是 `^sk-` ⇒ **新 key 被全数拒绝**，用户一个账号都加不进来；判据改为与上游命名无关的共性「≥20 位 + 无空白 + `[A-Za-z0-9_.-]`」，且**旧 `sk-` 必须继续可用**（也**不得**反过来只认新前缀）；同批挖出 `slotNamesOf` 把含 `-`/`.` 的 key 尾段原样拼进 `credentialRef()` 会抛 `TypeError`（`credential ref "…" must match …`，账号写不进去）⇒ **只在尾段不合法时**归一化 + key 短哈希（合法尾段逐字节不变 ⇒ 存量凭据引用不动；纯替换会让 `…ab-cd` 与 `…ab_cd` 撞成同一 ref、后者覆盖前者凭据）；生成地址从已 302 的 `/auth` 更正为 `/console/account`；⚠️⚠️ OpenCode 出口代理：dispatcher 与 fetch **必须同源**（Issue IKK4BY）—— 外部 undici 的 dispatcher 配全局 fetch 会在 Node 22/24 上恒抛 `UND_ERR_INVALID_ARG`（内置 6/7 与外部 8 的 handler 契约不同源），必须走 `proxyFetch`；`fetch failed` 的真因在 `cause` 里；⚠️⚠️ **可达性判据必须走远端 `provider.api`、不能硬编码（Issue IKM9LR）** —— 兜底表曾同时吃「兜底目录」与「协议白名单」两份职责 ⇒ Zen 新上线的 `deepseek-v4.1-flash-free` / `glm-5.3-flash-free` **远端明明下发却被本地表挡掉**（症状与「上游没这模型」同形）；models.dev 的 `provider.api` 才是权威（实测 openai/v1 56 条 ✅、anthropic 17 ❌、google 8 ❌、无字段 4 ⇒**退回本地表而非判死**）；⚠️⚠️ **免费判定是同源的第二个 bug**（只看本地表 ⇒ 远端 `cost=0` 的新模型被判收费），且 ⚠️ **`listModels` 里必须先读能力表再取目录**（两张远端表是读能力表那一刻才注入的，顺序颠倒 ⇒ 冷启动首帧必然退化）；⚠️ 这道闸管不了地域封锁 / 上游 429 / 上游废弃（只能靠运行时错误分类）；⚠️⚠️ **`FreeTierError` 是逐请求随机的（与模型无关），单次探测判不了任何能力**（我据此作废过一轮图片结论）；⚠️⚠️ models.dev 直读收敛到**全仓唯一直读点** `src/models-dev-cache.ts`（用户要求；改前 opencode 与 cline 各直连一次同一个 5 MB 站点）——三级降级（内存 → `cache/models-dev.json` → 本地表）**任何一级都不回退网络**、超时 90s + **重试 3 次**（指数 2s→4s）、周期 3h；⚠️⚠️ 三个耦合点各有守卫：死锁阈值 **480s 必须 > 单轮最坏 276s**（否则正常重试被误判卡死而再起一个）、⚠️ **只缓存白名单 provider**（整份落盘 2.6 MB 会让启动路径的 `readFileSync` 变成 2026-10-02 那次事故的同型，白名单后 50.4 KB）、失败日志必须写「已重试 N 次」；⚠️ **OpenRouter 不能当备份源**（实测 470 条**无 `provider.api`**、id 命名空间与 opencode 零重叠 ⇒ 并进来会让可达性判据带歪）；另含 `officeace-inflight-guard` flaky 的根因（TTL=0 把判据退化成 `>0` ⇒ 同毫秒时幽灵条目留下）与 20 次对照验证
- `docs/agent-notes/providers-zcode.md`（7 节）：⚠️⚠️ **3012 的「版本号 × 身份块同代」不变式（Issue #45，2026-11-05 真机 2×2）**：上游把 `X-ZCode-App-Version` 与 `system` 身份块文本当**同一代**校验，**跨代即 405 + `3012 unusual activity`**（同账号交叉验证排除「账号级风控」与频率：`acct 0` 3.17.2+3.17文本 200 → 3.16.3+3.17文本 405；`acct 2` 反向；连续两发间隔 1s 同为 200）；插件发 `max(凭据 app_version, 门槛)` ⇒ 官方升级后**重新登录过**的凭据（3.17.2）配 3.16 身份块 = **全量 3012**（「从未成功过一次」），而**只改身份块不改门槛**同样 3012（两处**必须同改**）；3.17 文本差异：cliPrefix `You are ZCode, an interactive coding agent`(42) → `…interactive agent`(35)、identity 首句换成「用自己判断推进目标」、`# Harness` 每项**多一个前导空格**、desktop 段逐字未变，合计 **2632 → 2643**；⚠️ 身份块在 `resources/glm/zcode.cjs`**不在** `app.asar`（报障者据此误判「官方删了」）；修法＝identity 重提 + 门槛 `3.17.1` + 诊断行新增「版本 X」（此前只看得到身份块字符数）+ 自检脚本 `scripts/verify-zcode-identity.mjs`（可从本机 bundle 现提并打印第一处差异）+ e2e `pnpm test:e2e:zcode-identity`；⚠️ **不做**「按账号熔断 3012」—— 同码多因（配置跨代是确定性的），记到账号头上会在插件自己配置错时**冤枉整个账号池**；⚠️ ZCode（智谱）provider：「卡住 + 停止按钮无效」的两个根；⚠️ ZCode 上游节流三件套（吸收自 `dsh-free-glm`，20；⚠️⚠️ `3012` 的 HTTP 状态码是 **405**（不是 403；⚠️ ZCode captcha 的真实形状（2026-10-01，3.14；⚠️⚠️ **额度按模型分桶**（8M = 3M `glm-5.3` + 5M `glm-5.3-flash`，判据是上游下发的 `capabilities: ["model:<小写 id>"]`）——折算层据此写池的按模型标记；四个最易写错的格（通用桶必须参与 / 证据不足不得判死 / 查不到不得判死 / 写标记**不得沉底**）与大小写陷阱（上游小写 vs 目录大写）；⚠️⚠️ **独立审计（53 个变异）查出的两个真缺陷**：① **死锁** —— 折算取号按 `probeModel` 过滤，而它恰是被标记的模型时账号被筛空 ⇒ **折算根本不跑** ⇒ 标记永不清除 ⇒ 整条渠道消失（修法：取号传空 `modelId`）；② **误封整天** —— 额度下发成字符串时 `num()` 判 0 ⇒ 写持久标记锁死账号（修法：`unreadableBuckets` 守卫）；另含「接线零守卫（删掉 158 条全绿）」「abort 被 `catch` 吞掉」与三条审计纪律；⚠️⚠️ **营销投放（`/api/v1/marketing/touch`）是签到的第二个 plan 来源**（2026-10-23，用户报障「1024 程序员节 5 亿 token 领不到」）：1024 活动**不在** `billing/preview`（实测该账号 preview 与 balance 全空）而只在营销横幅的按钮 `claim_zcode_plan{plan_id}` 里 ⇒ 只查 preview 时它与「今天没活动」**同形**（`plans: []`）；⚠️⚠️ **该端点按客户端版本投放** —— 同一账号同一套头，`X-ZCode-App-Version: 3.14.3`（我们凭据里记的）回 `deliveries: []`、`3.16.3` 才有 ⇒ 必须**按请求覆盖**版本（不许改凭据、不许全局抬 fallback）；⚠️⚠️ **`claim` 端点受同一个门控**（真机一发定音：同一账号其余头相同，`3.14.3` → **`400/1004 no permission`**、`3.16.2` → **`200/code 0`** + `data.plan`）⇒ **只抬投放版本会「看得到、领不到」**，而 `1004` 的官方文案「客户端版本不满足领取条件」极易被误读成「账号没资格」；⚠️ 逆向时「官方显式 headers 里没有 `X-Device-Mid`」是**假象**（那层公共头由 `Fa(apiClient,…)` 注入、片段里看不见）⇒ 照抄会回 `3001 parameter error`；✅ **真机验收（生产路径 `claimDailyFor` + 注水 captcha）**：`{"kind":"claimed","credit":500000000,"unit":"token"}`（5 亿，与截图一致）；⚠️ 领取后服务端**自己**会撤下该 campaign ⇒ 别拿「投放变 0」当 `confirm` 生效的证据；⚠️ 领取成功须回报 `POST /marketing/touch/action`（`confirm`），否则服务端反复投放 ⇒ 每轮签到白烧一个设备级 captcha，但**失败时绝不回报**（用户会白丢一次机会）；⚠️ 额度必须**求和** `entitlements[]`（3 亿 + 2 亿 = 5 亿，只取第一条会少报 2 亿）；⚠️ 一条方法论：`action.type` 判据的第一版用例**无牙**（`close` 的 `args` 是 `null`，被 plan_id 那条腿顺带挡住）⇒ 判据的用例必须让**其它腿都不足以挡住它**；⚠️⚠️ **「领取成功但额度仍是 0」是上游的 `effective_at`（实测 23:00），不是缺陷**（2026-10-23 21:19 报障）—— 上游 `balances` 桶为空、`plans[].status:"active"` 里额度已锁定 ⇒ **桶要等生效时刻才建** ⇒ 插件新增 `pendingPlans` 把它**单独显示成「待生效」包**（`remaining/total` 给 0、`cycleStartTime` 携带生效时刻）；⚠️⚠️ **绝不能并进 `remaining`/`total`** —— `zcodeExpiry` 判据是 `remaining > 0` ⇒ 并进去会让折算层在生效前**把 zcode 派发出去**（必然失败）；⚠️⚠️ **国际版（`zai`）同样能领**（实测 4 账号含 2 个国际版都拿到同一个 1024 计划）⇒ 服务端**不按 OAuth 渠道区分**，「只有中国版有」是官方**奖励中心分站**（`/cn/rewards` vs `/en/rewards`）的**入口**差异 ⇒ 插件**不做渠道特判**；⚠️ 补一条反直觉实测：用**渠道 token** 当 Bearer 查 `billing/balance` ⇒ **401**（该端点只认 `zcode_jwt`）
- `docs/agent-notes/providers-kukuai.md`（7 节）：⚠️ 库库AI（百度 GenFlowPro）provider 的**实测**事实，**与 `docs/superpowers/specs/...-design.md` §1.5/§4 冲突时以它为准**：登录态**全明文**（`encrypted_value` 长度全 0，不需要 DPAPI）；`freepoint/homenew` 必需的**常量** query（`clienttype=400&app_id=123971023&web=1&channel=chunlei&version=1.6.8`，缺则 `errno=2 params error`，而源码里传的是空对象 `{}`）；**余额不在 `homenew`** 而在 `/bizapi/gfpro/getgfvipremain`（取 `data.list` 里 `assetType===1`，`totalPoint` 是**字符串**）；**领积分是写操作**（`POST freepoint/rewardClaim`，参数放 **query** 且请求键是 `period_id` 而值取响应的 `period_no`）—— design doc 说的「服务端自动发放」与「`autoClaim` 自动领取」**均已被实测推翻**；IDE 是 **cookie 登录不是 OAuth**，且三步都不依赖 IDE
- `docs/agent-notes/providers-accio.md`（14 节）：⚠️⚠️ **图片通路已接通（2026-10-14，issue IKLR7V）**：上游原生收图（`parts[].inline_data` 四色全对）⇒ U-D 未验证项关闭；⚠️⚠️ **但 `multimodal:false` 的模型不报错、而是静默忽略图片**（GLM 5.1 实测据此**幻觉**出答案）⇒ `inputModalities` 的 `false` 必须写 `['text']` 而非省略（省略 = 未知 = 放行 = 幻觉），且适配器 `stream()` 里有**同向**的第二处门禁；⚠️ `multimodal` 字段可信（15 条可见模型从不缺失、与兜底表 100% 一致）但**「从不缺失」只是快照**；⚠️ issue 说的「本机 NO_IMAGE 硬标记」**全仓零命中** —— 真实机制是「省略模态 ⇒ 聚合 `capabilityOf` 折算成 `imageCapable:false`」，效果等价；⚠️⚠️ **Accio（阿里）provider 的三条「与参考实现相反」的实测结论**：**有标准 OAuth 2.0 + PKCE（`client_id='accio-work'`，公开客户端）⇒ 可完全脱离 IDE**（不需要读本机 `credentials.enc`、不需要 DPAPI）；⚠️⚠️ **推理请求不需要 SecurityGuard 签名**（不带 `pctb-x-*` 同样 200 ⇒ 不需要 `security_guard.node` 与那串阿里 DLL，参考实现把它当必需是过度设计）；⚠️ 但 **token 必须放 body 的 `token` 字段**，放 `Authorization` 头恒**流内 402**（HTTP 仍是 200 ⇒ 不看流内 `error_code` 会误判成「成功但没内容」）。⚠️⚠️ **两个真缺陷**：① **`cmd /c start` 会把授权 URL 在第一个 `&` 处截断**（cmd 把 `&` 当命令分隔符）⇒ 症状极具误导性：登录页误弹「请升级客户端」+ `explorer` 弹出**文件管理器**窗口 + 回调永不到达；必须用 `rundll32 url.dll,FileProtocolHandler`；② **`expires_at` 秒/毫秒混淆**（上游给**秒**，当毫秒用会判定「永久过期」⇒ 每请求续期 ⇒ 烧掉 refresh_token ⇒ 账号被标死，与 codearts 单向门同型；归一化只在兑换/续期返回处做**一次** + `> 1e12` 防御分支）。⚠️⚠️ **实施阶段真机推翻设计的一条**：**`system_instruction` 必须是字符串，不是 Gemini 的 `{parts:[…]}` 对象** —— 对象形态恒回 **HTTP 200 + 流内 400**（最难看的一种失败），官方 proto 两处都用 `String()` 归一；**教训可推广：「同族」只共享信封骨架，不共享每个字段的形状，逐字段仍要拿官方 proto 核对**。⚠️⚠️ **接线陷阱（新 provider 通用）**：新注册的 provider **必须**同时进 `src/jet-hub-rpc.ts` 的 `SELF_HEAL_REFRESHABLE_PROVIDERS`（除非设计上无 refresh 端点，那要在 `credits-balance-self-heal.spec.ts` 的显式豁免表写明理由）—— **漏登记则过期账号在积分端点永不自愈**（症状与 issue IKKHL5 逐字相同：积分行报「未登录」而上游只需一次 refresh），且**日志零字**；该守卫原本只有正向、反向缺失，**accio 就是这么漏掉的**，现已补反向用例逐键点名。⚠️ 同理 `src/jet-hub-store.ts` 的 `ACCIO_ACCOUNT_*` 前缀表、`src/aggregate-adapter.ts` 的参与渠道清单、`src/provider-registry.ts` + `provider-runtime.ts` 两张注册表**缺一处都是静默失效**。⚠️ **`rateLimit: false` 的判据**：该渠道**根本不写 `modelRateLimits`、也不在 `probeById` 里** ⇒「重测 / 重置」点下去**零请求、零清除**（恒惰性），与 loomy/gemini「真会限流但按钮管辖不到」**理由不同**；⚠️ 「省略 = true 以免老用户失去按钮」那条**不适用于全新 provider**（无存量用户，无功能回退可言），将来接上请求级换号 + 冷却时**本行要一起改回 true**。⚠️ **「刷新每日额度」入口尚未实现**（面板刻意不渲染该按钮）：它本质是重新登录**既有**账号，需宿主侧**新增一条 RPC**（如 `account.relogin`）—— 现有 `account.create` 恒新造 id 与凭据 ref（拿它重登会造**幽灵账号**而原账号额度一点没刷新）、账号 `region` 没下发给客户端、`login.poll` 对已登录账号立刻回 `done: true`（假成功）⇒ 三条障碍；在那之前面板只做诚实展示（三类积分桶 + 重置倒计时 + 「删除该账号后重新登录」这条手动路径），文案**不得**写死每日额度数字（上游一调整就自相矛盾）。⚠️ 一条**方法论**教训：写对照矩阵时**必须检查每个变量是否真的独立** —— 把赋值写在公共路径上会让**所有格子共享它**，「四格都成功」≠「四个变量都被验证」（`sgcookie` 就这么被漏掉一轮，补做的干净对照才证明它也不必需）。另含：登录页 legacy 门禁真源（CDN 上的 `kiIt5C4K.js`，**不在 asar 里**）、积分「没有签到端点但**登录触发**按日发放」（`DAILY_REWARD 200`，24h、不累积）、15 个模型与倍率（0.013~2.8，**倍率必须进 `name`**）、工具调用**分片到达且共享消费者不合并**（须由适配器合并，否则 harness 把同一工具执行 N 次）、**思考关不掉但档位生效**（⚠️ 2026-10-13 修订：旧结论「四类字段实测全部无效 ⇒ 不声明档位」**已推翻**——旧探针用的是**非法值**且拿**思考字符数**当判据；重测见下）、与 Qoder **同属阿里但协议完全不同**（别照 Qoder 写）；⚠️⚠️ **但聚合渠道里必须把它当 Qoder 那样处理**（用户 2026-10-13 要求「聚合当中的 qwen3.8-flash 轮换列表里要有」）：accio 的 `modelCode` 是 `1Drift-…` 内部代号，**与 qoder 的 `qfmodel` 完全同因** ⇒ ① `canonical-models.ts` 的 `PRIMARY_CHANNEL` 必须加 `accio: 'name'`（否则它的每个模型各成一个孤立虚拟模型、跨渠道聚合**完全不发生**，症状**静默**：它只是不在候选表里）；② 同时需 `CANONICAL_OVERRIDES.accio` 把 `1Drift-F8hS3mK7pL2n` 显式指到 **`qwen3-8-flash`（无连字符）** —— accio 的展示名 `Qwen 3.8 Flash` 有空格 ⇒ name 通道得 `qwen-3-8-flash`（**多一个连字符**），而 loomy/trae/qoder 走 id 通道（id `qwen3.8-flash` 无空格）得 `qwen3-8-flash`，**同一模型被拆成两个键**；⚠️ 补丁**只加确知同模型的**（`Qwen 3.8 Max` 本来就一致、**无需**补丁；`27B`/`A3B`/`Standard`/`Professional`/`Ultimate` 是独立模型，猜着并入 = **请求打到错的模型且无提示**）；⚠️⚠️ **思考档位**（用户 2026-10-13 要求「用远端真实下发的档位、即使只有一档也要显示」）：**推翻了旧结论**「四类字段全部无效 ⇒ 目录里不声明档位」—— 旧探针用的是**非法值**（`off`/`none`/`minimal`，都不在远端声明的 `low`/`medium`/`high`/`xhigh`/`max` 里）且拿**思考字符数**当判据（同档内波动 186~490，信噪比太低）；改用**服务端权威计数 `thoughts_token_count`** 重测，Ultimate 五档中位数**单调递增 33→40→41→43→43** ⇒ 档位**真实生效**（但「**关不掉**」成立：`low` 也有 33 token ⇒ 会话命名仍走抬预算兜底）；⚠️ 远端 38 条里 **31 条 `efforts=null`**，其中 **6 条只给 `defaultReasoningEffort`**（GLM-5.3/5.2/5.3 Flash=`max`、DeepSeek V4.1 Flash/V4 Pro=`high`、MiniMax M3=`adaptive`）—— 实测**发过去服务端接受** ⇒ 是**真实单档**（正是「只有一档也要显示」那一格）；落地 `accioReasoningOf`（三格：有数组⇒全列且 `defaultEffort` 必须落在集合内否则丢弃它／只有 default⇒**单档**／都无⇒不声明）+ `normalizeAccioModel` 解析；⚠️⚠️ **另一条真缺陷：`utdid` 不带会被风控拦截**（实测：真实值与**自造随机值**都 ✅、**完全不带**或**只放 header 不放 `properties.utdid`** 都 🚫）—— 风控响应是 **HTTP 200 + `content-type: text/html`**（跳转脚本 `bixi-intl.alicdn.com/punish/…` + `rgv587_flag:sm`），**不校验 content-type 就会静默退化成「模型未返回内容块」**（本轮探测被它误导过一轮）；已在 `stream()` 加 content-type 校验（归 `SERVER`、不重试）；⚠️ 目录端点不带 `utdid` 也正常 ⇒ 该约束**只在推理路径暴露**；⚠️⚠️ **对外 id 用「人话」slug、上行仍用 `modelCode`**（用户追问「为什么回复中的模型不是标准模型 id」）：DSH 把 `CatalogEntry.id` **注入给模型当身份**，而上游 `modelCode` 是 `1Drift-N8kP2Q7wR5mX` 这类**故意不可读**的内部代号 ⇒ 模型只能自报乱码；改为 `accioModelIdOf`（= `normalizeNameKey(展示名)`，**与聚合共用同一套归一**，不自己写第二份）产出的 slug（`qwen-3-8-flash`），**但上行必须经 `accioModelCodeOf` 反查回 `modelCode`** —— 服务端只认后者，漏映射的症状是「**模型不回复**」（不是参数错误，极具误导性）；⚠️⚠️ **连带失效**：`CANONICAL_OVERRIDES` 的索引键按 `realId` 查，而聚合读的是 `listModels` 的 `id` ⇒ id 改 slug 后**补丁索引也必须改成 slug**，否则恒不命中 ⇒ accio 掉回孤例键 ⇒ **聚合轮换列表里又看不到它**且无任何报错；⚠️⚠️ **但归一化补丁只是第 ① 层**（模型层归并）——**候选层另有闸门**：`aggregate-adapter.ts` 有 **4 处**按 `WIRED_EXPIRY_PROVIDERS` 过滤（探测/候选/虚拟模型/价格），**决定「轮换列表里有没有它」的是那张表、不是 `AGGREGATE_CHANNELS`**；2026-10-13 合并审计实测：accio 当时只加进了 `AGGREGATE_CHANNELS`，`canonicalKeyFor` 已返回 `via:'patch'`（第①层对），**但候选表里没有它**（第②层被剔）⇒ 用户要的「轮换列表里要有 accio」**并未实现**且**完全静默**（我最初只验了第①层就宣布通过，是**不完整的验证**）；修法两处同改（`accioExpiry` + 白名单 + `createProviderExpiry`，由 `expiry-runtime-parity.spec.ts` 锁一致）；⚠️ **officeace 已于 2026-10-13 接入那张表**（`026a7db` "接入聚合轮换"）⇒ 它在聚合候选表里（与 buddy 系同形，`officeaceExpiry`） ⚠️⚠️ **请求级账号轮换已接上（2026-10-18，issue IKM3ZV）**：此前整条请求路径**零换号** —— `resolveCredential` 取回一个号、不成即抛，池里第二个账号**从未被尝试**（实测复现：HTTP 402 与**流内** `error_code:402` 两条路径各一发）。⚠️⚠️ **最关键的结构决定：HTTP 层与流内必须是「一个循环、两段」** —— 初版写成两个独立 `for`，实测被打穿三处（流内换号取回的号在 HTTP 层失败 ⇒ 把 402 的 JSON 体当 SSE 读、报「未返回任何内容块」；已产出内容后遇流内 402 ⇒ **连冷却都不记**；坏凭据被跳过后整池不再换号）。⚠️ **判别力一律在「第二发的 `body.token`」**（只断言错误码是**恒真**的），且**必须有反向对照**（否则「凡错就换号」也全绿 = 白烧整池）。⚠️⚠️ **两条无牙如实登记**：① `signal?.aborted` 那格是**防御性冗余**（`abort()` 下抛的是 `DOMException`/`AbortError`，**非 `LlmError`** ⇒ 已被上一条早退拦住）；② `modelId` 传空串的变异在「池替身不实现 `modelRateLimits` 过滤腿」时**无牙** ⇒ **替身缺一条真实实现里有的腿 ⇒ 对应变异全体无牙**；⚠⚠ 审计自查又发现一条更强的：本组那条「桩的自检」用例**自己曾恒真**（只断言新建 Map 为空、根本没碰过滤腿）⇒ 删掉过滤腿实测**全绿** ⇒ **「守卫全绿」不足以证明它有牙**，必须对所依赖的每条腿做一次「删掉该腿」的变异。⚠️ 顺带修了 `llm-adapter.ts` 的 CodeArts HTTP 层换号**漏传 `tried`**（与 2026-09-17 `81706da` 同构）；⚠️ 可推广：`getAvailableAccount` 的**第 3 参**是换号的承重件，而它**必然**叫 `tried` 之类的局部名 ⇒ **源码级 grep `excludeAccountIds` 查不到**（这正是 issue 判据错的那一格）。⚠️ accio 的 `rateLimit` 已随之改回 `true`（四处接线同改）。详见 §11。
- `docs/agent-notes/provider-abstraction-g3-exceptions.md`：⚠️ 2026-10-08 provider 能力抽象重构（计划 1）**做不到「零行为变化」（G3）的 6 处例外**逐条登记（含基线 `ecbb268` → 现行的**可观测量**与变异验证结论）。**动 provider 抽象层、或核对「重构是否改变了行为」前先读它**：5 处确为行为变更（凭据损坏文案 / `account.refresh` 分派 / `onboarding.claim` 错误码 / `codearts` 未知 id 模态 / `buddy` 消歧集合）、1 处（签到文案）逐字节未变只是搬了位置，**5 处已于 2026-10-08 逐条复核后全部接受**；⚠️ 另一条独立教训：**「登记了一处例外」≠「这处例外有守卫」**，必须逐项变异验证（当时实测出 G3-4 **零守卫**）
- `docs/agent-notes/providers-officeace.md`：⚠️ **OfficeAce（华为 MaaS / 果办）第 16 个 provider**：V11 签名的**三条铁律**（GET **不发** `Content-Type` / 密钥派生用 **hex 字符串**当 key 不是 raw bytes / 分隔符是 **LF** 且路径强制尾斜杠 —— 各自都曾导致 APIG.0301）；⚠️ **`expires_at` 无秒/毫秒混淆**（STS 给的是 ISO 字符串，**别顺手加** `> 1e12` 归一化，那是兄弟渠道的坑）；⚠️⚠️ **批量续期把同步池当 Promise**（Issue IKLPTZ：`listAccountsByProvider` 返回**数组**、没有 `.catch` ⇒ 恒抛 `TypeError`，被逐 provider `try` 吞成一条 warn、界面零提示；⚠️ 该误判被**复制了两遍**（模块导出 + `index.ts` 的服务包装，定时器走后者的）⇒ 修法是**只留一份** `refreshAccountList`；⚠️ **别声称「结构化接口能拦住它」**，`unknown as X` 恒被允许，有牙的是行为用例 + 只留一份实现）；⚠️ **它有一格是刻意的行为变更（不是等价重构）**：池**同步抛错**修复前会逃逸（.catch 接不住同步 throw），现吞成兜底 —— 方向正确但**必须登记**（守卫生效判据：读池抛错时兜底真被调用一次）；⚠️⚠️ **守卫网被两轮独立审计打穿七处**（第一轮 4 处：⑧ 正则对 `!`/`?.`/跨行全漏 ⇒ 改用 **AST 判据** + 判据自检；② 只断言「不抛错」⇒「读了池但不续期」仍全绿；⑤ 不验证自身声称的兜底语义；⑩ 只守 setup 一半 ⇒ `officeaceHome()` 不读 env 仍绿。**第二轮对抗性 3 处**：⚠️⚠️ ⑧ 对**间接写法**失明 —— `const list=q=>q.listAccountsByProvider(x); list(p).catch()` 这类**最像重构**的写法全漏，且**穷举间接写法不可判定**（要数据流分析）⇒ 换判据为 ⑦b **调用点普查**（「再写一份遍历」必然新增一个调用点，可判定且与写法无关）、⑧ 降级为辅助并如实标注射程；⚠️⚠️ **第一版「只接受同步池」本身就是新引入的行为回归** —— Promise 池掉进 `for…of` 抛 `accounts is not iterable` 且**绕过兜底**，而旧代码 `await ….catch()` 能跑（doc 还把该格写成「等价」，**登记错了格子**）⇒ 恢复兼容（`await` + `Array.isArray` 归一）+ doc 改表；⚠️ **`.office-claw` 未隔离** —— `readSessionCookie()` 直接 `os.homedir()`，审计实测真读到用户 cookie 并 **DPAPI 解密成功**（约 1.05s），当前不可达但属脆弱的绿）—— 另记 ⚠️ **⑩c 第一版是空的**（靠 `USERPROFILE` 第二道防线侥幸绿，实测把 env 覆盖改坏仍 18 passed）⇒ 判据内主动撤掉第二道防线；**「守卫写好了」≠「守卫有牙」**；⚠️⚠️ **两处连带发现**：① 该缺陷**遮蔽**了 `jet-hub-rpc-auth-wiring` 的一处失败（`apply()` 的 fire-and-forget 首轮跑到 officeace 就抛错 ⇒ 背景噪声不产生；修好后噪声混进「只分派到自己实例」的断言，修法是**测量前清空背景链**而不是放宽断言）；② ⚠️⚠️ **单测会消费用户真实的一次性凭据**（`storeDir()` 落 `~/.dsh-officeace/session.json`；`apply()` 的首轮续期在 `afterEach` 恢复 `USERPROFILE` **之后**才跑到兜底分支 ⇒ 读真实凭据并真发 STS，实测出现真实报文 `STS5.1806 has been used`；**用例自己改 env 抢不过后台链**）⇒ 加 `DSH_OFFICEACE_HOME`（与 `DSH_JET_HUB_STATE_DIR` 同型）+ `refreshAccountList` 的 `fallbackRefresh` 注入点，`setup-isolation.ts` 进程级隔离；⚠️⚠️ **续期三件套（2026-10-13 审计补齐，此前一条都没有）**：per-ref `SerialQueue` + 锁内重读/lead-time + 判终态前重读 —— 最隐蔽的错法是「**加了锁但加错了一条腿**」（原 `refreshInFlight` 只包住兼容文件路径，生产主路径直接绕过它）；⚠️⚠️ **`SELF_HEAL_REFRESHABLE_PROVIDERS` 又漏一家**（该陷阱已复发两次）⇒ ⚠️ **生产 Set 至今仍是硬编码**（2026-10-13 合并审计实测）；改的是**守卫用例的期望值**（从 `PROVIDER_REGISTRY` 派生）⇒ 加新 provider 时**仍须手动往 Set 里加一行**，守卫只保证「忘了加会红」；⚠️ **改「单凭据 → 多凭据」时别只改主路径** —— 旧的单文件 `session.json` 读取点会一颗颗变成串号源（实测三处）。⚠️⚠️ **换账号登录**：华为 `authui` 会**静默复用**浏览器已登录会话（`prompt=login` 被忽略、实测无重定向），只能靠**无痕窗口**（不能走 `authui/logout` —— 那是整域作用域，会连带登出用户的华为云控制台）；⚠️⚠️ **开窗的行为测试只能放 `tests/e2e/`**（用户明确要求）—— 单测里跑它会在用户桌面**弹出真实浏览器窗口**（我真实污染过两次：`example.invalid` 与 `auth.huaweicloud.com/stub`），被测代码须有 `NODE_ENV==='test'` 断路器且**不得按 URL 打补丁**；⚠️ 不要用「app 模式」开关开小窗（国产浏览器把它当**域名**解析 ⇒「域名解析错误」阻断登录，真机证伪）。⚠️⚠️ **「加了账号却在模型选择器里看不到模型」= 打错 host**（2026-10-13 真机实测）：适配器原先硬编码 `defaultBaseUrl`，而华为**按账号下发专属网关**（本机 `modelgw-0004.officeace…`）⇒ `probe` 401 ⇒ `listModels` 返回 `[]` ⇒ 空返回与「无账号」**同形** ⇒ 整个 provider 被隐藏，**全程零日志**；修法是推理/探测三处改用**凭据里的 `maasBaseUrl`**（`maasBaseUrlOf`，缺失回退默认域）；⚠️ **只改 Basic 鉴权的推理面** —— V11 签名那套（`/v1/subscription`、`/v1/model-token-rates`）实测**两个 host 都存在且都要求 IAM 签名**，是**管理面 API**，一起改会把余额与倍率打挂；⚠️ **教训**：`maasBaseUrl` 写进凭据却从没被读 —— **「写进凭据却没人读的字段」要按「可能已是主路径」对待**，不能按注释里的推断定性（该缺口审计时已登记却**低估**，只要跑一次真实 `listModels` 就会暴露）。⚠️⚠️ **聚合轮换：决定候选表可见性的是 `WIRED_EXPIRY_PROVIDERS`，不是 `AGGREGATE_CHANNELS`**（同款陷阱已复发**三次**：cline → accio → officeace，症状恒定静默 —— 该表里没有的渠道折算恒为 `UNUSABLE`，候选表里永远没有它，**零报错**）；接入必须**三处同改**（折算原语 + 白名单 + `createProviderExpiry()`，后两者由 `expiry-runtime-parity.spec.ts` 真跑 `apply()` 锁一致）；⚠️ officeace 与 **buddy 系同形**（每个积分桶都带 `expiresAt`）⇒ 判据与 `sharedPackageExpiry` **逐格同构**，但**不能直接复用**它（它的 `fetchBalance` 泛型套不进 `fetchSubscriptionSummary` 的形状）；⚠️⚠️ **必须把 `credentialRef` 传下去**（给 `ProviderExpiryContext` 新增可选字段）—— 该余额入口只有拿到 ref 才走云侧直读，否则回落果办客户端的**全局单 cookie** ⇒ 多账号折算成同一份余额（实测两个账号都显示 6500）⇒ 聚合候选是每账号粒度 ⇒ **选错人**
- `docs/agent-notes/providers-autoclaw.md`：⚠️ **AutoClaw（智谱）**：⚠️⚠️⚠️ **P0（2026-10-19，IKOYEG）：access_token 是明文 JWT、寿命恒 24h，而登录响应不给 `expires_at`/`expires_in` 时旧实现**编造** `Date.now() + 7 * 86400_000`** ⇒ 这份假值同时是**唯一**的续期判据（`refreshAll` 的 lead-time 与积分按需自愈都读它）⇒ **过期前不自愈、过期后也不自愈、日志零字**，症状是「dsh web **刚启动还能看到积分**、过一会儿变『登录凭据失效』」（实测：22:50 启动正常 → 23:02 死线 → 23:19 报错）；肇因提交 `6da5505`（10-17 接入时**同一次**提交里就同时写进了兜底 + lead-time 跳过 + `SELF_HEAL` 登记 ⇒ **上线即带病**）；⚠️ 死线与 UI 上的「有效期」差 **6 天**（`expires_at` = 登录时刻 **恰好 +10080 分钟**）⇒ **判「账号是不是真过期」一律解 JWT 的 `exp`，不要信池/凭据里的 `expires_at`**；修法是 `autoclawJwtExpiresAtMs`（**JWT 优先、声明值兜底、都读不到就 `undefined`，绝不编造**）三写入点（登录/续期/桌面端探测）+ 解析点 `parseAutoclawCredential` 共用 ⇒ **纠正必须在「每次 parse」**，否则存量坏凭据不会自愈；⚠️ **变异验证归因**：砍 JWT 腿 6 条红、恢复 7 天兜底**只** 1 条红 ⇒ 两条腿的守卫**不可互相替代**；⚠️ 旧断言 `expires_at > Date.now()` 对「+7 天编造」**恒真**（本次补「差值 < 2 天」量级断言才钉得住）；⚠️ **症状每 24h 必然复发，而「重新登录」这个手动修法会重写 `createdAt` 与假有效期、顺延死线并销毁现场** ⇒ 报障者「以前好像没这问题」多半是这么来的。⚠️⚠️⚠️ **P0：流水的 `amount` 是「历史发放额」、不是「批次剩余额」** —— 拿它当 `remaining` 求和 ⇒ 用户**消耗过积分后**批次和必然 ≠ `total_balance` ⇒ 守恒恒不成立 ⇒ 永远回退钱包包 ⇒ **逐批次分档（含红色「临期」+ 倒计时）永不出现**，表现为「刚登录那会儿对、用一段时间后静默失效」，无报错无日志 ⇒ **必须逐格对照 `trae-credits.ts` 的 `remaining = creditsLimit - used`（两腿都在才算得出剩余）**；⚠️ 教训可推广：「同款问题」只共享问题**形状**，不共享解法是否成立 —— 照抄别家判据前先确认**它依赖的那条腿在你家也在**；⚠️ **PR 引用的取证脚本 `scripts/probe-autoclaw-expiry.mjs` 不存在**，`docs/audit/pr111-autoclaw-audit.md` 亦记载钱包接口无时间字段 ⇒ 「实测 28/28 守恒 20700」**不得当作实测证据**；⚠️ **`display` 必须按官方 `wallet.display === true` 严格判断** —— `typeof … ? … : true` 在缺字段时 fail-open 会让「每日积分」池回归 ⇒ **原报障症状逐字复现**（实测钱包响应每个池都带 `display`，严格判断不误伤）；⚠️⚠️ **批次包名不得命中 `DAILY_POOL_NAMES`** —— `usage-badge.js` 是**先判先 return**（`formatPoolSplitLine` 非 null 就直接返回，根本走不到三档 + 倒计时）⇒ 上游下发一条「每日积分」就能把红色临期**整段短路**掉；修法是包名加「（批次）」后缀而**不是**改客户端那份共享名单（两份名单各存一处，`src/**` 与 `plugin-src/client/**` 不共享模块图，同步锁在单测里）；⚠️ **两个判据血泪点**：①「隐藏池余额恰好为 0」会让守卫无牙（换成「按 `balance===0` 剔除」仍全绿）**必须取非 0**；②「packages 长度为 1」区分不了「守恒不成立」与「流水失败」（同形）⇒ 要断言「真被问过流水端点」且「回退包里无 `deductionEndTime`」；⚠️⚠️ **更要紧**：原验收夹具到期时刻距真实当前 ~76.7 天 ⇒ 落在 15 天窗口外 ⇒ 即便全绿也只会渲染黄色「长期」，**永远不是用户诉求的红色临期** ⇒ 断言「`deductionEndTime` 算出来了」**不等于**断言「会变红」，必须喂给 `splitCreditsByExpiry` 断言 `expiring`/`earliestExpiringAt`。另含：负数（冲正/退款）判据 `<= 0`（客户端**静默 skip** `remaining<=0` ⇒ 合计与总额脱钩）、永久桶**按描述分列**（哨兵初值恰等于默认名 ⇒ 首条真名为「其他积分」时被下一条顶掉）、`metadata.description` **空串**要当「没有」（`??` 不落空串）、兜底造包**只在 `total>0`**、整段翻页**共用一份时间预算**（原每页各 arm 15s ⇒ 最坏 90s > 徽标 60s 轮询）。

- `docs/agent-notes/providers-qiniu.md`（12 节）：⚠️ **Qiniu（七牛云 AI）provider（第 16 家）** 是 modelscope 同范式（静态 API Key + OpenAI 兼容 + **无 refresh** + **无余额端点**），协议基线 `https://api.qnaigc.com/v1`、鉴权 `Authorization: Bearer <API Key>`、Key 在 `portal.qiniu.com/ai-inference/api-key` 创建；
⚠️⚠️ **`GET /models` 免鉴权也回 200** ⇒「目录能读到」不构成凭据有效（凭据只能靠推理 401 证伪）；
⚠️⚠️ **模型 id 两形态混排**（带厂商前缀 `moonshotai/kimi-k3` 与裸名 `deepseek-v3`）**必须原样透传**，FAQ Q6 要求与模型广场「API model 参数」逐字一致 ⇒ `normalizeQiniuModelId` 只做 trim，`canonical-models.ts` 的归一化**绝不能回流**到发请求的 model 字段；
⚠️⚠️ **兜底表必须非空**（`QINIU_FALLBACK_MODELS` = 2026-10-29 直连 `/v1/models` 的实测快照 `[id, context_length]`、`name=id`）：置空时 `listAllModels()` 冷缓存恒 `[]` ⇒ `models.total` 恒 0 ⇒ 设置页判据 `closed = total > 0 && disabled === total` 把整个 provider 误显示为「已关闭」且**无模型可关**（「删/归一 id」与「留离线快照」是两件事，Q6 只禁前者）；⚠️ `contextWindow: 0` 是「不知道」哨兵，`resolveModel` 判 `> 0` 才下发 `context`；
⚠️⚠️ **`supportsImage` 全表 false = 「没实测过」而不是「不收图」**（目录不下发模态；VL 系在目录里但七牛侧未实测），实测通过才改 true 并附取证；思考档位同理**整表不声明**（上游支持 low|medium|high 但目录不下发每模型支持情况）；
⚠️⚠️ **无余额端点 ⇒ 三处同向处理**（`src/provider-registry.ts:870` 的 `credits:{balance:false,dailyCheckin:false}` 是实测结论：`src/qiniu-credits.ts` 刻意不存在、不进 `WIRED_EXPIRY_PROVIDERS` 并在 `expiry-runtime-parity.spec.ts:264` 的 `NOT_EXPIRY_WIRED` 与 `credits-balance-self-heal.spec.ts:702` 的 `SELF_HEAL_EXEMPT` 显式登记、不进 `SELF_HEAL_REFRESHABLE_PROVIDERS`），「查不到」与「没接线」的区别必须留在注释里；
⚠️ **`rateLimit` 省略 = true 与 modelscope 的 false 刻意不同源**（本家**确实会写** `modelRateLimits`，见 `tests/helpers/provider-sets.ts:283`）；
⚠️⚠️ **额度冷却对齐 UTC+8 当日 24:00**（`qiniuRetryAfterMs` 用 `nextUtc8DayStartMs()`）：七牛「每账号每日 250 额度、按 UTC+8 自然日重置、旗舰档模型**每次调用固定扣 2 额度**（≈125 次/天）」⇒ 固定 24h 会把 23:50 撞墙的号冷却到次日 23:50（旧 fork 用固定 1h TTL 近似 ⇒ 反复空试）；
⚠️⚠️ **超限必须映射 `CONTEXT_WINDOW_EXCEEDED_CODE`、不能走 `httpErrorCode(status)`**（七牛超限回 HTTP 400 ⇒ 落 `INVALID_REQUEST` ⇒ 宿主 context-overflow 监听器 `if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE) return next()` **永不触发**、自动压缩不跑；与 `gemini-adapter.ts:888` 同修法），且 `classifyQiniuError` 的 `context_window` 判定必须排在 `rate_limit`/`quota` **之前**（超限报文常含 `too many tokens`）；
⚠️⚠️ **Key 形状闸不绑前缀**（`KEY_PATTERN = /^[A-Za-z0-9_.-]{16,}$/`，opencode IKPLRU 教训）但**派生的 ref 名必须是合法标识符**（宿主 `credentialRef()` 只认 `/^[A-Za-z_][A-Za-z0-9_]*$/` ⇒ 末段含 `-`/`.` 的 Key 会直接抛 `credential ref … must match …`、一个账号都加不进来）：`qiniuSlotNamesOf` 在尾段合法时**逐字节不变**（保护存量引用）、不合法时剥非标识符 + 追加 Key 的 **sha256 前 8 位**防撞车；前缀必须是 `QINIU`（`src/jet-hub-store.ts:1286` 的 `REF_PREFIX_TO_PROVIDER`，该陷阱**第六次**复发）；
⚠️ 凭据字段名必须是 `access_token`（`account-pool.ts:1271` 的 `identifierKey`）、重复 Key **复用同账号**、未知 RPC 方法**必须回 `undefined`**（回信封会把别家方法误判成格式错误）、`QiniuAuth` **刻意不提供 `refreshableOf`** 且 `refreshAll` 不判 `enabled`/`refreshable`；客户端入口是**粘贴 Key**（`plugin-src/client/qiniu-key-modal.js`，卡片 Key **由宿主打码下发** `account.qiniuKeyMask`，客户端不自己打码）。

## 语言约束

- **推理输出**（thinking / reasoning）一律使用中文。
- **正文输出**（正文回复、代码注释说明、总结、文档）一律使用中文。
- 代码标识符、关键字、类型名称、变量名等保持英文不变。
## 技术栈与约束

- **Node.js**：`^22.19.0 || >=24.0.0`
- **构建系统**：宿主侧用 TypeScript `tsc` 编译到 `lib/`；客户端 bundle 用
  `esbuild`（`plugin-src/client/build.mjs`）打包到 `lib/client/jet-hub.js`。
  两者都产出到已 gitignore 的 `lib/`，`prepare` 保证 git 安装时两侧产物齐全。
  ⚠️⚠️ **`prepare` 必须内联真实命令**（`tsc -p tsconfig.json && node
  scripts/copy-assets.mjs && node plugin-src/client/build.mjs`），
  **不得出现 `pnpm` / `npm` / `yarn` 任何一个名字**（2026-10-21 合并审计实测）：
  DSH 只用 pnpm 装插件、pnpm 在 clone 目录里跑 `prepare`，而 **pnpm 10 / 11
  不会把 npm 注入 PATH**（只有 pnpm ≥ 12 才会）⇒ `prepare` 里写 `npm run …`
  在 pnpm 10/11 上**必然安装失败**（实测三档：10.20.0 / 11.0.0 失败、12.8.2 成功）。
  ⇒ 守卫见 `tests/unit/package-install-scripts.spec.ts`。
  ⚠️ `pretest` 仍用 `npm run`（纯开发期路径，那时包管理器必然在）—— 刻意不同。
  ⚠️ **`tsc` 不清理「源文件已删除」的产物**：改名/删文件后 `lib/` 会留着旧的
  `.js` / `.d.ts` / `.map`（2026-10-01 把 `cline-modalities.ts` 换成
  `cline-models-dev.ts` 时实测到，`lib/cline-modalities.*` 四个文件仍在，
  并随文件拷贝式安装一起进了 profile）。**删改源文件后手动清一次 `lib/`**
  （或整目录重建），否则残留模块虽无人 import 却会一直跟着发布。
  ⚠️⚠️ **`lib/` 陈旧会让你「跑通了一个不存在的验证」**（2026-10-21 合并审计实测）：
  用 `node --input-type=module -e "import ... from './lib/xxx.js'"` 做端到端对账时，
  若 `lib/` 是旧产物，**源码里的新判据根本不参与**，你会得到一份看似成功、
  实则验证的是旧代码的结论。实测经过：PR !123 给 `splitBuddyCreditsByExpiry`
  加了 `expiringRemaining` 拆包，而 `lib/buddy-balance-rank.js` 里该符号
  **0 处**（源码 3 处）⇒ 那次「前后端逐分一致」的 5 组对账全跑在旧实现上，
  第一组直接给出 `expiring` 2500 vs 500 的**假不一致**，差点被当成真缺陷。
  ⇒ **凡是用 `lib/` 而不是 `src/` 做的验证，先 `pnpm build`（或 `pnpm build:all`）**；
  更稳的做法是**让 vitest 直接 import `src/`**（单测本来就那样，不含构建产物）。
  ⚠️ **`plugin-src/client/jet-hub-styles.js` 里的 `STYLES` 是模板字符串 ——
  CSS 注释内绝不能出现反引号**。用它给属性名加强调（`` `min-width: 0` ``）会
  **提前闭合模板**，esbuild 报 `Expected ";" but found "min"` 并把指针指到注释那一行，
  看起来像 CSS 写错了，实际是 JS 语法问题（2026-10-01 改页头样式时踩过，
  一次引入 6 对）。注释里要强调就直接裸写 `min-width: 0`。
  改完这个文件**必须跑一次 `pnpm build:client`** —— 单测只读源码文本，不会因此失败。
- **测试**：Vitest（单元测试 + E2E 端到端测试）
  - `pnpm test` — 单元测试（快速，无网络，全部 mock）
  - `pnpm test:e2e:*` — 端到端测试，按 provider 分列（如 `test:e2e:codearts`、`test:e2e:buddy`、`test:e2e:workbuddy-claim`）；**均有闸门，默认全部跳过**，详见 `tests/e2e/README.md`
- **依赖管理**：pnpm workspace（作为 DSH 插件安装）
- **代码风格**：与 `@deepseek-ai/dsh` 主仓库保持一致
## 项目结构

| 路径 | 说明 |
|-------|------|
| `src/` | TypeScript 源码目录（宿主侧） |
| `plugin-src/client/` | Jet Hub 客户端源码（esbuild 打包） |
| `lib/` | 编译产物（已 gitignore；含 `lib/client/jet-hub.js`） |
| `tests/unit/` | 单元测试 |
| `cordis.patch.yml` | DSH bundle 补丁 |
| `tsconfig.json` | TypeScript 配置 |
| `vitest.config.ts` | Vitest 配置 |
## DSH 插件契约

- 插件使用 `@deepseek-ai/dsh` 的 `credentials`、`commands`、`llm` 服务注入
- 凭据存储使用 `ctx.credentials` 模块，ref 格式遵循 POSIX 标识符（如 `CODEARTS_ACCESS_TOKEN`）
- LLM provider 通过 `ctx.llm.registerProvider()` 注册
- 命令通过 `ctx.commands.register()` 注册
- 插件配置通过 `ctx.schema` 在 profile layer 栈中声明

## ⚠️ 渠道原生搜索（`src/web-native.ts` + `src/native-search-contract.ts`）

**支持原生搜索的渠道**的官方 `web_search` 改走**渠道自带后端**，其余渠道一律
`next()` 放行 —— **不路由、不回退**，官方链路逐字节不变。

| 渠道 | 原生后端 | 鉴权 |
|---|---|---|
| `buddy` / `workbuddy` | 腾讯 `POST {endpoint}/agenttool/v1/search` | `Bearer <access_token>` |
| `qoder` / `qodercn` | Qoder `POST {encryptedInferBase}/api/v1/webSearch/oneSearch` | **COSY 签名（WASM）** |

### ⚠️ 架构：两层 + 一个契约文件（2026-10-14 改造）

| 文件 | 职责 |
|---|---|
| `src/native-search-contract.ts` | **共享契约**：错误类型 / 错误码 / `NativeSource` / `NativeSearchAdapter` 接口 |
| `src/web-native.ts` | **工具层**：拦截 `tools/execute`、官方入参校验、多 query 合并、cap |
| `src/{buddy,qoder}-adapter.ts` | **渠道层**：`searchOnce` 取数 + 字段投影（各渠道形状不同） |

⚠️ **契约必须单独成文件**：否则渠道层要 `import` 工具层，**依赖方向反了**
（渠道是更底层的实现，不该知道「谁在拦截工具执行」）。改动前先读它的模块头。

⚠️ **取数不可放在工具层**：腾讯的 `results[].url` 与 Qoder 的 `pageItems[].link`
形状不同，若混在工具层会让「渠道判断」与「字段投影」纠缠（改造前就是这样，
Qoder 根本接不进来）。

### ⚠️ 只管 `web_search`，**刻意不管** `web_fetch`（2026-10-14 修正）

本模块早期**同时**接管过 `web_fetch`（`/agenttool/v1/webfetch`），那是**净损失**，
现已整体剔除。**不要加回来**。理由三条（均有实测）：

1. **官方 fetch 根本不需要凭据**：宿主 `cordis.yml` 里 `web.fetchProvider: http`
   → `@deepseek-ai/dsh-web-fetch-http`，官方文档原话「**不发送凭据**」，零配置、
   自带 SSRF 防护与明确响应上限（5 MB / 100k 字符）。实测：删掉 `DEEPSEEK_API_KEY`
   后它照样 200。⇒ 接管它**没有换来任何能力**（search 不同 —— 官方**要** key）。
2. **复杂表格塌陷**：同一份 `api-docs.deepseek.com/.../pricing` 页面，官方保留
   `| a | b |` 行列结构；腾讯原生把整表挤成一行 ⇒ 模型读不出「哪个数字对应哪个
   模型」。而查文档/查价格恰是 fetch 最常被用的场景。
3. **依赖账号有效**：账号过期时腾讯 fetch 直接失败；官方永远可用。

（腾讯 fetch 确有独到之处：返回页面 `标题` 与多语言全文。但代价是表格结构丢失，
 用户 2026-10-14 权衡后决定撤回。守卫用例见 `web-native.spec.ts` 的「渠道判断」。）

Jet Hub 页头有总开关（`nativeWebSearchEnabled`，缺键默认启用）：关掉即**所有渠道**
（含 buddy 系）回官方搜索，此时 buddy 渠道报 `DEEPSEEK_API_KEY` 缺失属**预期**。

### 动它之前必须知道的七条

1. **`tools/execute` 是 cordis waterfall**：不调 `next()` 即短路，返回值**必须**是
   `{ value }` 形状（返回 `undefined` 会让宿主在 `normalizeDispatchResult` 里抛
   `TypeError`）。短路经 `createSuccessResult(exec, 原工具, value)` 用**原工具自己的**
   output 契约渲染。
2. **短路会跳过官方入参校验**：官方 schema 校验在 `defineTool` 包装的 `execute`
   **内部**，短路后根本不执行 ⇒ 参数判据必须在这里自己复刻（见 `readQueries`）。
3. **总开关必须每次现读**：`index.ts` 传的是 `() => pool.nativeWebSearchEnabled()`
   这个**函数**，不是布尔快照。改成快照会让「关→开」热切换失效（必须重启）。
4. **输出投影贴合官方 schema**：`sources[{url,title?,snippet?}]`（`url` 必填、
   `additionalProperties: false`）—— 多传字段会让 `createSuccessResult` 抛
   `ToolOutputError`，整条调用失败（不是少一条结果）。
   各适配器**必须丢掉**自己多余的字段（Qoder 的 `hostname` / `hostLogo` 在此列）。
   ⚠️ **但 `publishedTime` 是例外**（2026-10-14 审计修正）：官方 output schema 与
   seam 的 `WebSearchSource` **都**声明了可选的 `publishedAt?: string`，原注释把三个
   字段一锅端说成「schema 不允许」**对 `publishedTime` 不成立**。当前**刻意仍丢弃**
   —— 接它要先真机确认 Qoder 下发的是 ISO-8601 字符串，接错的代价是整条调用失败。
5. **凭据必须与聊天链路同源**：经 `Xxx.resolveCredentialFor` 复用**同一个**
   `resolveCredential` 实例；另建一份会让「enabled / 模型级限流 / 免费判定 /
   余额分档 / 池兜底 / 账本回报」六步在两条链路上漂移。
6. **Qoder 的 WASM 上下文必须 `dispose`**：`QoderContext` 是 wasm 堆上的 Rust 对象，
   `gluePromise` 是**进程级单例** —— 不释放会让堆只增不减，长上下文会话最终以裸
   `RuntimeError: unreachable` 暴毙（真实事故史见 `qoder-wasm.ts` 文件头）。
   用 `try/finally`（`finally` 里的 `throw` 会**无条件覆盖** `try` 里的原始错误）。
7. **`url` 字段名各家不同**：腾讯叫 `results[].url`、Qoder 叫 `pageItems[].link`。
   投影在**适配器**里做，工具层的合并算法对渠道无感。
8. ⚠️⚠️ **取消 / 超时的归因必须读 `signal.reason`，不能只看 `signal.aborted`**
   （2026-10-14 审计新增，**实测六格对照**）。本模块在 cordis waterfall 的**内层**
   （见下方「实测边界」），生产环境拿到的 `exec.signal` 已被外层
   `tool-call-timeout-policy` 换成带 deadline 的信号 ⇒ 外层到期时
   `aborted === true` 但**原因不是取消**：
   | 场景 | `reason.constructor` | `reason.name` |
   |---|---|---|
   | 调用方取消 | `DOMException` | `AbortError` |
   | 本模块自己的 `AbortSignal.timeout` | `DOMException` | `TimeoutError` |
   | **外层 deadline 到期** | **`TimeoutReason`** | **`TimeoutReason`** |
   判据**只留一份实现** `classifyNativeAbort`（`native-search-contract.ts`），
   buddy 与 qoder **都必须走它**；旧写法（先判 `aborted` 就归 aborted）会把超时报成
   「用户取消了搜索」，文案里那串排障指引**全部丢失**。
   ⚠️ 两个渠道**各自**必须自己 arm 一份 `AbortSignal.any([signal, AbortSignal.timeout(20s)])`
   —— 只透传 `signal` 会让 `timeout` / `aborted` 在该路径永不产生（qoder 曾如此，
   而契约注释却声称「各适配器都有 20s 预算」⇒ **注释与实现不符**）。

### 实测边界（2026-10-14 真机）

- 两个 host（`copilot.tencent.com` / `www.workbuddy.ai`）行为一致；
  `max_results` 完全生效：**1/3/5/8 原样返回、>8 封顶 8**；
- ✅ 已验证：buddy / workbuddy 搜索通、开关热切换无需重启；
- ✅ 已验证：**Qoder 原生搜索调通** —— CN 免费账号 `POST gateway.qoder.com.cn/.../oneSearch`
  → HTTP 200 返回 10 条 `pageItems`；**与客户端真实调用逐条对比：URL 10/10、标题 10/10、
  顺序完全一致**（客户端侧证据取自 `~/.qoder-cn/projects/…/d6bb315c-….jsonl`）。
  协议细节见 `docs/agent-notes/providers-qoder.md` 的「渠道原生搜索」一节；
- ✅ 已验证：`web_fetch` 在任何渠道都走官方（开关开着时也不出现 `workbuddy fetch` 文案）；
- ✅ **已验证**（2026-10-14 PR95 审计补测）：本监听器在 `tools/execute` 链中的
  **位置** = **内层**。依据两条：① `dsh-base/cordis.patch.yml` 里
  `tool-call-timeout-policy`（L401）**先于** `tool-web`（L486）声明，而 cordis 的
  waterfall 是「**先注册者在外层**」（cordis 的 `dispatch` 按注册序 `push`，
  `waterfall` 顺序 `shift`）；② 真 cordis 探针实测链序
  `A-before → B-sees:DEADLINE-FROM-A → INNER-BODY → A-after` —— 后注册者拿到的
  `exec.signal` **已被前注册者替换**。⇒ 外层超时策略**生效**，本模块必须在
  内层处理「外层 deadline 也可能 abort 我的 signal」（见上面第 8 条）。
  ⚠️ 由此推翻本 PR 原注释「我们的 20s 预算总是先于宿主 30s 触发」：
  `searchTimeoutMs` 是**可配置项**，调小后外层先到期。
- ⚠️ **仍未验证**：宿主升级后 `requestHeader()` 在工具执行时**是否已就绪**。
- ⚠️ **未接入**：Qoder 的 `bailian` 搜索后端（需百炼 API Key，默认不用）。

研究记录见 `docs/workbuddy-native-search-research.md`（含端点探测、请求头最小集、
与 DeepSeek 官方搜索的架构差异）。

## 工作方式

### ⚠️⚠️ 派 subagent 做**审计**的三条实测教训（2026-10-18，IKM3ZV 轮亲历）

#### ① **prompt 里写「禁止改主工作区」拦不住它** —— 必须用机制隔离

第一轮我给常规审计 + 对抗审计各写了一份详尽约束（禁 `git stash`/`checkout`/`restore`、
禁改主工作区、变异只放独立 worktree），**两个 agent 都没遵守**：直接在主工作区注入了
**6 处**变异且未还原（`shouldRotateAccioAccount` → `return true`、`recordsAccioRateLimit`
多 `|| auth`、额度冷却改成 `+86_400_000`、删掉 `rotate()` 前的记账、删掉续期后的
`tried` 更新……），全量测试当场 12~20 条红。

⇒ **光写指令无效，必须让它「够不到」**。可靠做法（第二轮实测有效，主工作区零污染）：

```powershell
$sha = git stash create            # ⚠️ 生成 dangling commit，但**不动工作区**
                                  #   （实测前后 git diff --stat 完全一致）
foreach ($n in @('a1','a2')) {
  git worktree add --detach "D:\...\wt-$n" $sha
}
# ⚠️ git stash create **不含未跟踪文件** ⇒ 新增的 spec 必须显式字节拷贝进去
Copy-Item tests\unit\xxx.spec.ts "D:\...\wt-a1\tests\unit\"
# ⚠️ worktree 没有 node_modules ⇒ 目录联接（只读依赖）
cmd /c mklink /J "D:\...\wt-a1\node_modules" "D:\...\主工作区\node_modules"
```

⚠️⚠️ **联接是「同一个物理目录」，不是副本** ⇒ **绝不要在 worktree 里跑 `pnpm`（`install` / `build` 都算）**
（2026-10-20 亲历，主仓库依赖被搞坏一次）：pnpm 会把它自己的虚拟store建在
`<worktree>/node_modules/.pnpm` —— 而那**就是**主仓库的 `.pnpm` —— 并把**主仓库**的顶层
链接改写成指向 `<worktree>/...` 的**相对路径**。症状有延迟：worktree 还在时一切正常
（链接能解析过去），**删掉 worktree 后主仓库的 `node_modules` 立刻全是悬空链接**
（`ls -la node_modules` 能看到 7 个条目指向 `dsh-audit-a3/...`，`vitest` 报
`requireStack: []`）。修法：在主仓库跑一次 `pnpm install`（store 有缓存，7.7 s），
并确认 `ls -la node_modules | grep -c <worktree名>` 归零。
⇒ **在 worktree 里只跑 `npx vitest` / `npx tsc`**（它们不改依赖树）；
要构建就用 `npx tsc -p tsconfig.json` + `node scripts/copy-assets.mjs` +
`node plugin-src/client/build.mjs` 这三条**绕开 pnpm**，或给 worktree 自己的**真** node_modules。

⚠️ **配套的必要性**：即使隔离了，仍要在主工作区留**指纹**（`Get-FileHash`），
审计结束后逐一比对 —— 否则「它到底动没动过主工作区」只能靠猜。

#### ② 「审计无声」必须按**未完成**处理，不能按「通过」处理

第二轮的常规审计 agent 结束时只留下一句
**「让我跑基线测试并搭变异工具」**（= 准备工作的**意图**，不是报告），
两个沙箱里**既无源码改动、也无变异脚本残留** ⇒ 它实际上**没产出任何结论**。

⚠️ agent 停止时的收尾语**不是审计结论**。判据只能是
「沙箱里有没有留下可复核的产物」+「有没有输出可验证的具体问题（带观测原文）」。
**没有任何带红/绿观测的发现 ⇒ 记为『未完成』，不记为『没发现问题』。**

#### ③ 一次只派一件小事

两轮失败的共同形态：给单个 agent **同时**派「找缺陷」+「搭变异工具」+
「评估守卫无牙」三件事，它会在准备阶段耗尽预算。⇒ 拆成互不依赖的小任务。

若确实要用 subagent（例如任务之间**没有文件重叠**且**都不做变异验证**），必须：
1. 预先告知它「工作区可能有他人未提交改动，**只 `git add` 自己的文件**」；
2. **明令禁止** `git stash` / `git checkout -- .` / `git restore` / `git add -A`；
3. 告诉它判断成败要用**自己的**测试文件，全量测试只作参考。

### `ctx.xxxAuth` 服务统一接口

本插件定义的所有 `ctx.xxxAuth` 服务（`codeartsAuth`、`buddyAuth`、`workbuddyAuth`、`lobsteraiAuth`、`qoderAuth`、`qodercnAuth`、`traeAuth`、`clineAuth`）均遵循统一接口：

- `login(options?)` — 执行浏览器登录流程
- `startLogin(options?)` — 两步式登录（先返回 loginUrl，Jet Hub 据此弹窗）
- `refreshAccountCredential(refName, pool?, accountId?)` — 按凭据 ref 续期**指定账号**（账号卡片「刷新」按钮）。⚠️ 后两个参数**必须传**：只有拿到池与账号 id，续期后的新 `expiresAt` 才能回写账号池（见下）
- `refreshAll(pool)` — 批量续期全部账号（定时调度器）

⚠️ **不注册任何斜杠命令**：十个 provider 的登录/状态/续期**全部**在 Jet Hub 设置页完成。

⚠️ **CodeArts 只支持账号池，单凭据模式已移除**（用户要求）：

- 凭据一律存 `CODEARTS_ACCOUNT_XXX`；固定的 `CODEARTS_ACCESS_TOKEN`
  **不再被写入或读取**（常量保留仅为兼容 `login`/`startLogin` 的 `refName` 缺省值）。
- 只服务于单凭据路径的方法**已删除**：`status()` / `refresh()` / `logout()` /
  `scheduleRefresh()` / `scheduleModelRefresh()`（后两者当时就没有调用方）。
  `refreshModels()` **签名改为接收 `pool`** —— 它原先直接读固定 ref，
  移除单凭据后会恒返回空列表。
- `codearts-login` / `codearts-status` / `codearts-refresh` 三个命令**已删除**
  （注意代码里**从来没有** `codearts-logout` 命令，logout 只是服务方法）。
- 十个 provider 的门控判据因此**完全一致**：都只看账号池，
  `providerCatalogVisible` 的 `extraCredentialRefs` 参数已随之删除。
- 老用户影响：若此前只用固定 ref 登录过，模型列表会变空，需在 Jet Hub 重新登录一次
  （用户已确认接受该行为，不做自动迁移）。

### ⚠️ 续期不得按 `enabled` 过滤

`refreshAll()` 与 `src/index.ts` 的续期调度器**只按 `refreshable` 过滤，不看 `enabled`**。

⚠️ **「不看 `enabled`」这条仍然有效；「按 `refreshable` 过滤」这条已被推翻**
（2026-10-02，见下文「账号池的 `refreshable` 只是凭据材料的镜像」）：
那个布尔当过滤条件用会把一次瞬时失败固化成单向门，账号从此永不自愈。

停用只应影响「账号池的自动选号」，与「凭据是否需要保持新鲜」无关 ——
停用账号同样会出现在 Jet Hub 里并参与积分领取。

**真实缺陷**（用户报障）：两个**曾停用**的 CodeBuddy 账号显示「凭证过期」，
点「一键领取积分」报 `Unexpected token '<', "<html> <h"... is not valid JSON`。
根因是两处都按 `enabled` 过滤：

- `refreshAll()` 里的 `if (!entry.enabled || !entry.refreshable) continue`
  → 停用期间 refresh_token 一路放到失效；
- `src/index.ts` 的 `accounts.some(a => a.refreshable && a.enabled)`
  → **所有账号都停用时续期定时器根本不启动**。

用户重新启用后拿到的是死凭据，只能重新登录。十个 provider 的
`refreshAll`（`buddy-auth.ts` / `service.ts` / `lobsterai-auth.ts` / `qoder-auth.ts` / `trae-auth.ts`）与调度器
**都必须保持只看 `refreshable`**。

⚠️ Qoder 中国版**复用同一个 `QoderAuth` 类**（`src/qoder-auth.ts`），故它的
`refreshAll` 判据**天然与国际版一致** —— 不存在「CN 那份实现忘了改」的可能，
这正是「差异收敛到产品配置」这个模式的价值。

### ⚠️ 续期三件事缺一不可：启动先跑一轮、lead-time 判据、回写账号池

**真实缺陷**（Gitee issue !IKIRTT，用户报障）：重启后 cline / codearts / raccoon
的账号卡片**最长 30 分钟**显示红色「有效期：已过期 · 自动续期」，积分行报
`账户信息查询失败：HTTP 401`，而凭据其实是好的（`refresh_token` 到 10 月）。
点「刷新」按钮凭据续成功了、**界面纹丝不动**，点「重测」也不救急
（`src/account-probe.ts` 的 `refresh` 是**刻意**的 no-op，探测不该触发全局续期）。

根因是多账号改造丢了三条语义，三者**必须同时在**（缺任何一条都还会看到症状）：

1. **启动首轮**：`src/index.ts` 的调度器原先只有 `setInterval`，第一次处理要等满
   一个周期。短寿命令牌（cline 1h / codearts 约 2h / raccoon 3h，对照 buddy 系 720h）
   在宿主关闭期间早已到期 → 只有这三个 provider 会暴露出来。
   现在 `pool.listAllAccounts()` 门控通过后**立刻** `void refreshAllCredentials()`。
   ⚠️ 那条链原本**没有 `.catch()`**：`listAllAccounts()` 一 reject，定时器永不武装
   且日志零字 —— 「30 分钟」会恶化成「永不自愈」。
2. **lead-time 判据**：`shouldRefreshNow()`（`src/expiry-sync.ts`）复用单凭据时代
   `REFRESH_LEAD_MS`（1 小时）—— 距过期不足 1 小时才发续期请求。
   这既让启动首轮只打 0~3 个请求（39 账号的池不会在启动时突发几十个请求），
   也终结了「八个 provider 的 `refreshAll` 没有任何过期判据、每 30 分钟全量轮换」。
   ⚠️ **判据必须用凭据自己的 `exp`，不能用账号池的 `expiresAt`** ——
   池值正是本缺陷里可能陈旧的那份数据，拿它当尺子会漏刷真正快过期的账号
   （读凭据只是本地存储访问，不花网络也不花模型额度）。
   ⚠️ **raccoon 保留更严的「已过期才刷」**（`isRaccoonExpired`，lead=0）：
   它 3 小时寿命 + 30 分钟定时器已足够，提前 1 小时刷只会多打请求 ——
   lead-time 的目的是**减少**请求，不是增加。别「为统一」把它改成 1 小时。
3. **回写账号池**：UI 读的**只**是池里的 `expiresAt`
   （`plugin-src/client/jet-hub.js` 的 `account.expiresAt <= Date.now()`）。
   原先十个 provider 里只有 raccoon 回写，其余八个（含 `createPoolRefresh` ——
   CodeBuddy 系**发消息途中**按需续期的路径，触发频率远高于点按钮）
   只 `credentials.set` → 「数据源分叉」，功能完全正常但界面永远错。
   现统一走 `src/expiry-sync.ts` 的 `syncAccountExpiry` / `refreshAccountWithReconcile`。

⚠️ **`refreshAll` 里「本轮不刷」的分支绝不能直接 `continue`** —— 必须仍做一次
有效期对账。只修「续期时回写」是不够的：**存量账号**的凭据早已在别处（IDE /
上一轮）续好，判据必然为「不用刷」，池里的旧值就**永远无人更正**。
判据用「与凭据不一致」（不是「池值已过期」），否则漏掉「池值偏小但尚未过期」。
一致时不写盘（账号列表是整体落盘的），容差 1 秒（JWT 的 `exp` 是秒级）。

四个必须记住的实现约束：

- ⚠️ **`isLoomyRefreshable` 恒为 `false`**（Loomy 没有 refresh 端点，是诚实标记）。
  故 `ExpiryAccessors.refreshableOf` 是**可选**的，Loomy 那份不提供 ——
  否则共享实现会把池里的 `refreshable` 写成 false，与该产品的设计自相矛盾。
- ⚠️ `findAccountIdByCredential` 的第二参是**凭据内容**不是 ref 名（传 ref 名会
  恒匹配失败且**静默**）；且 codearts 比对的字段是 **`access_key_id`**（它的凭据里
  根本没有 `access_token`）；它还**跳过 `enabled === false`** 的账号。
  ⇒ 调用方已知 `entry.id` 时**必须显式传**，反查只是兜底。
- ⚠️ 回写失败**只记日志、不上抛**：凭据已经续期成功了，因写索引失败而报错会让
  用户以为续期失败、甚至触发无谓的重新登录。
- ⚠️ 凭据里读不到过期时间时**不覆盖**池内旧值：`updateAccount` 做的是
  `{ ...entry, ...patch }`，写 `undefined` 落盘会被 `JSON.stringify` 整个丢弃，
  UI 于是从「已过期」变成「未知」—— 保留旧信息更有价值。

### ⚠️⚠️ 续期失败的**终态判据**必须结构化，**不得**用 message 正则（2026-10-27 两轮审计）

本仓库曾有**两份逐字同形**的实现（`autoclaw-auth.ts` 与 `minimax-auth.ts`）：

```ts
// ❌ 修前
if (/invalid_grant|expired|revoked/i.test(message)) throw new TerminalError(...)
// autoclaw 那份更宽：msg.includes('Invalid token') || msg.includes('expired') || msg.includes('401')
```

实测三处**误判**，每一处都把**健康账号**标成「需重登」：

| 上游报文 | 旧判据 | 后果 |
|---|---|---|
| `HTTP 503 {"error":"token expired"}` | 终态 | 网关抖动一次 = 账号需重登 |
| `HTTP 429 {"error":"rate limited, key expired soon"}` | 终态 | 限流一次 = 账号需重登 |
| `fetch failed`（`cause: certificate has expired`） | 终态 | 证书/代理抖动 = 账号需重登 |

⚠️ 第三条最隐蔽：本仓库自己记着「环境 HTTPS 检查代理约 50% 概率打断」，而
`certificate has expired` 里恰含 `expired`。⚠️ `includes('401')` 更是**子串**判据。

⚠️⚠️ 而 `refreshable:false` 是**单向门**（`refreshAll` 与巡检都会跳过）⇒ 误标一次
**永不自愈** —— 用户看到的就是「要一个个点回来」。

⇒ 现收口在 **`src/refresh-failure.ts`**（全仓唯一实现），三步**顺序不可颠倒**：

1. **先排传输层**（沿 `cause` 链读 `UND_ERR_*` / `CERT_*` / 文案含 `certificate`）⇒ 非终态；
2. **再看状态码**：`5xx` / `429` / `408` / `401` ⇒ 非终态；
3. **最后只认结构化 `invalid_grant`**（RFC 6749 §5.2 唯一标准码）。个别上游用自有
   词汇的（AutoClaw 业务码信封回 `msg:"Invalid token"`）在**调用点显式声明**词表。

⚠️ **方向性取舍**：漏判 = 每 30 分钟白撞一次；误判 = **账号报废**。两者不对称 ⇒
一律偏向「不标死」。

### ⚠️ 续期的「单飞」必须是**去重**，不是「串行化」

```ts
// ❌ 等完在飞任务后，照样再发一份 —— 并发 N 条 ⇒ N 份 grant，都用同一把一次性 RT
const existing = this.renewInFlight.get(refName)
if (existing !== undefined) await existing.catch(() => undefined)
const task = (async () => { … grant … })()
```

实测并发 5 次 ⇒ 5 份 grant、峰值 4 在飞 ⇒ 2 份起必然 `invalid_grant`，
输家还会把「别人刚续成功」误读成「RT 已死」⇒ **把好号标死**。

⇒ 正确形态：命中在飞任务就 `await` 并**直接返回它的结果**（`minimax` 与 `autoclaw`
现在逐字同形）。⚠️ 同时注意**契约兼容**：`JetHubAuthLike.refreshAccountCredential`
返回 `void` —— 需要把新凭据交给调用方时**另开一个方法**（如
`autoclaw-auth` 的 `renewCredentialForRef`），两者共用同一张在飞表，别改签名。

### ⚠️ 自建定时器**必须**挂 `ctx.effect` 回收（`unref()` 不算回收）

`unref()` 只解决「不阻止进程退出」，**不解决「fiber 卸载后仍在跑」**。
实测 `fiber.dispose()` 后推进 130s ⇒ 定时器 tick 照跑，而旧实例读的是**共享的**
credentials 后端（不是快照）⇒ 它会继续对**新池**发 grant；插件热重载 ⇒
新旧两个实例**并发轮换同一批一次性 RT**。

⇒ 自建定时器的类必须提供幂等的 `stop()`，接线层写
`ctx.effect(() => () => auth.stop())`；且**在飞的那一轮**也要能被叫停
（循环内每个条目之前再查一次停止标志，否则它醒来后会继续把剩余全部做完）。

⚠️ 边界（别夸大这类缺陷）：**功能一直是好的** —— 适配器发现凭据过期会按需
`refresh()` 再发请求；定时器跑过一轮后 UI 也会自愈。受影响的是「启动到首轮之间」
的界面与积分行，以及窗口内点「刷新」看不到变化。

可观测性（同一 issue 的第 5.4 条）：`src/index.ts` 原先有**十个**
`catch { /* 静默 */ }`，把 provider 内部告警与异常一起吞掉。现收成
`refreshTargets` 表驱动 + 一处 `ctx.logger.warn`。
⚠️ `src/service.ts`（codearts）此前**整份文件零 logger**，而它的令牌最短命 ——
续期失败将完全无痕，现已补 `refreshAll` 两个分支的日志。

测试：`tests/unit/expiry-sync.spec.ts`（lead 边界含 `<=`、一致不写盘、
1 秒容差、不传 refreshableOf、反查传凭据内容、回写失败不反噬、
「有效期内仍须对账」、续期返回 undefined 时绝不落盘）+
`tests/unit/refresh-bootstrap-wiring.spec.ts`（启动首轮排在定时器前、
**每个 channel provider** 都在表里、九个 auth 的 `refreshAccountCredential`
都带 pool/accountId 且真调共享回写、RPC 与 `createPoolRefresh` 都传 id）。

⚠️ **这里刻意不写条数**：原文写「（19 条…）」而 2026-10-08 复审实测该文件已 **21** 条
（12 个 `it` + `it.each` 展开）—— 条数是**必然腐坏**的快照，接一个 provider
就会失效，而「数字对不上」会让人怀疑整段约定。**条数以 `pnpm test` 输出为准。**

### ⚠️ 账号池的 `refreshable` 只是**凭据材料的镜像**，绝不能当续期门禁

**真实缺陷**（用户报障 2026-10-02）：「我们插件的 codearts 账号池出现 2 个 401 未认证，
自动续期没有工作吗？重启也还是 401」。

本机取证（只读 `~/.dsh/jet-hub/state.json` + `~/.dsh/.credentials.yaml`）：

| 事实 | 值 |
|---|---|
| 两个 codearts 账号在池里 | `refreshable: **false**`（9-25 的快照里同两条还是 `true`）|
| 凭据本体 | **完好**：`refresh_token` 还剩 18 天寿命（到 10-18）、`code_verifier` 64 位、`dpop_private_key_jwk` 都在 |
| 凭据的 `expires_at` | 停在 12 小时前那次成功续期上，此后**再没被写过** |
| 整个池 | 36 条里 **33 条** `refreshable:false`（loomy 4 + zcode 2 是诚实的 false）|

⇒ 旧实现 `refreshAll()` 第一行 `if (!entry.refreshable) continue` 把这个布尔变成了
**单向门**：任何一次把它写成 false 的事件之后，该账号**永不进入续期循环** ——
定时那轮跳过它、启动首轮也跳过它，于是「自动续期没工作、重启也没用」，
而凭据明明还能用。**这正是上一节「只按 `refreshable` 过滤」那条约定的代价**，
该约定已被本节修订，见下文。

**三条已落地的规则**（`src/service.ts` 的 `CodeArtsAuth.refreshAll`）：

1. **调度判据读凭据，不读池值**。`isCodeArtsRefreshable(credential)`
   （`refresh_token` + `code_verifier` + `dpop_private_key_jwk` 三样齐全）
   才是「能不能续」的权威；池里的 `refreshable` 是**每轮由凭据对账出来的结果**，
   不是「曾被服务端拒绝过」的案底。误标会在下一轮自动改回 true（自愈）。
   只有**凭据确实缺材料 / ref 下没有凭据**才写 `false`，且写前先比现值
   （`if (entry.refreshable)`）—— 定时器每 30 分钟一轮，别重复整体落盘。
   ⚠️ 读凭据只是**本地存储访问**，不花网络也不花模型额度 ——
   拿它当门禁来「省请求」是**错省**，省下的是自愈能力。
2. **判终态前先重读凭据**：续期被拒（`invalid_grant`）时，先看磁盘上那份
   `refresh_token` 是否**已经不等于**本次用来续期的那一份。并发下服务端烧掉的是
   **旧的**一份，而磁盘上此刻躺着一份**新的、可用的**凭据 —— 那是「他处已续成功」，
   不是「本账号不可续期」。少了这层判据，一次交错就把好账号永久标死。
   命中时改用**最新凭据**对账（`syncAccountExpiry`），不发终态标记。
3. **`InvalidDPoPHeader` 不算 refresh_token 失效**（`src/oauth.ts` 的 `requestToken`）。
   旧判据把它与 `invalid_grant` 并列为终态，注释写的理由是「避免每 10 分钟无限重试」，
   实际代价是一个**材料完好**的账号被标死、用户只能重新登录。DPoP proof 没过校验
   说的是「**这一次**证明不合格」（时钟偏差让 `iat` 落在窗口外 / proof 被判重放 /
   网关抖动），与「refresh_token 还能不能用」无关；归为可重试的代价只是 10 分钟后再发
   一个 HTTP 请求。终态只留 `invalid_grant` 与 `ExpiredRefreshToken`。

4. **调度器的武装门也不能读 `refreshable`**（`src/index.ts`）：原先是
   `accounts.some(a => a.refreshable)` 才武装定时器 —— 用**可能被误标的字段**
   决定「要不要启动修误标的机制」是循环依赖。本次事故实测 36 条账号只剩
   3 条 `true`（raccoon / minimax / cline 各一），再少三条，
   **codearts 的自愈与启动首轮会一起消失且日志零字**。现改为「池里有账号就武装」；
   各家 `refreshAll` 内部本就按凭据材料 / 是否过期过滤，放宽这里最多多一次本地遍历，
   不会白发请求。⚠️ 仍然**不看 `enabled`**（上一条铁律未变）。

**为什么会被标死：三条续期入口并发消费同一份 `refresh_token`。**

① `src/index.ts` 每 30 分钟（含启动首轮）的 `refreshAll`；
② 推理路径的按需续期（`llm-adapter.ts` 的「过期预判」与「401 兜底」，
   而 DSH 本身会**并发**发多条请求：主回复 + 标题生成 + 上下文压缩）；
③ Jet Hub 账号卡片的「刷新」按钮（`account.refresh`）。
华为 STS 在签发新凭据时**旧的那一份 refresh_token 即失效**，
并发下必然「1 个成功、其余 `invalid_grant`」，而失败方把它读成「账号不能续期」。

⇒ 已加 **per-`credentialRef` 的 `SerialQueue`**（`CodeArtsAuth.refreshQueues`）：
三条入口在同一进程内必然串行，且**锁内重读**凭据 —— 仍在有效期内就直接对账返回，
不再发第二次请求（少烧一次 token）。
⚠️ **该锁只在单进程内有效**：同一台机器上 dsh web 与 desktop 两个实例各自持锁，
跨进程互踩只能靠上面第 2 条兜 —— **两处都得有，少一个就会复发**。
（用户环境实测就是 web + desktop 两个 profile 都装了本插件。）

**可观测性**：真终态时日志带上**服务端原文**（`…；服务端原文：CodeArts token request failed: 400 {…}`），
且同一 ref 同一原因**只告警一次**（`terminalWarned`）—— 真失效时用户要做的是重新登录，
每 30 分钟重复同一行只会把有用信息埋掉。

⚠️ **本条修订「续期不得按 `enabled` 过滤」一节里的说法**：那句
「`refreshAll()` 只按 `refreshable` 过滤」现已不成立 —— `refreshable` **不再是过滤条件**，
而是被对账的字段。「不看 `enabled`」这条**仍然有效**（停用账号照旧要续）。

⚠️ **其余八个 provider 仍有同一个单向门**：buddy / workbuddy / lobsterai / qoder /
qodercn / trae / cline / minimax 的 `refreshAll` 第一行都还是
`if (!entry.refreshable) continue`，而取证时它们的账号**同样**大面积被标 false
（buddy 4/4、lobsterai 4/4、trae 4/4、qoder 5/5、qodercn 3/3、workbuddy 5/5 ——
凭据里 `refresh_token` 全都在）。本次只修了用户报障的 codearts；
推广时**三条规则要一起带**（读凭据对账、判终态前重读、per-ref 串行），
只搬第一条会继续误标。

测试：`tests/unit/service.spec.ts` 的「CodeArtsAuth refreshAll：以凭据为准的自愈」
（7 条：误标后自愈且**只回写一次**、缺材料才标 false、已 false 不重复写盘、
并发重放不误标且用最新凭据对账、真终态照标 false 且不损坏凭据、
单账号失败不中断其余、同一 ref 并发续期只发一次请求）+
`tests/unit/oauth.spec.ts`（`InvalidDPoPHeader` 归可重试、`ExpiredRefreshToken` 仍终态）。
⚠️ 已做**反向验证**：加回 `if (!entry.refreshable) continue` → 自愈用例变红；
队列改 `new SerialQueue({ enabled: false })` → 并发串行用例变红（实测 2 次请求）；
去掉「判终态前重读」→ 并发重放用例变红；把 `InvalidDPoPHeader` 加回终态判据 →
oauth 用例变红。四条各自独立锁死，**别把它们当同义反复删掉**。
⚠️ 已做**反向验证**：去掉 lead 过滤 + 去掉「一致不写盘」→ 7 条变红；
去掉启动首轮 + 去掉 cline 回写 → 3 条变红（含行为用例「刷新后池内
`expiresAt` 指向未来」，非同义反复）。
⚠️ 接线类断言一律用 `(pool|p)` / `[^)]*` 容忍重构与签名扩展 ——
写死整串会让每加一个 provider 或每补一个参数都假失败（该教训已记在
`cline-adapter.spec.ts` 的注释里）。


服务名由产品 id 派生（`${product.id}Auth`）：两个 `BuddyAuth` 实例分别注册为 `buddyAuth` 与 `workbuddyAuth`，`LobsteraiAuth` 注册为 `lobsteraiAuth`，两个 `QoderAuth` 实例（同一类、不同 `product`）分别注册为 `qoderAuth` 与 `qodercnAuth`，`TraeAuth` 注册为 `traeAuth`，`ClineAuth` 注册为 `clineAuth`，互不覆盖。

⚠️ 服务名撞车会**在构造时抛** `service "..." has been registered`，故新增同族产品时
**provider id 必须互不相同** —— 这也是 `qodercn` 这个 id 不带连字符的原因
（`qoder-cnAuth` 不符合 camelCase 惯例）。

各 provider 的登录/续期机制不同（详见 README.md），但均通过 `ctx.credentials` 统一管理凭据生命周期。
## ⚠️ DSH 0.1.7 把工具结果改为一等 `role:'tool'` 消息（消息形状双兼容）

**真实缺陷**（用户报障）：升级到 DSH **0.1.7** 后，带工具调用的会话出现
「**没有工具调用就认为对话结束**而提前停止」或「**模型陷入循环思考**」。

### 根因：`tool-result` 包裹块被删除，工具调用被整体剔除

0.1.7 重构了消息模型：

| | ≤0.1.6 | 0.1.7 |
|---|---|---|
| 工具结果承载 | `role:'user'` 内嵌 `{type:'tool-result',toolCallId,content,isError}` | **一等 `role:'tool'` 消息**，`toolCallId`/`isError` 在**顶层** |
| `ContentBlockMap` | 含 `'tool-result'` | **删除 `'tool-result'`**，新增 `'tool-addition'`/`'tool-removal'` |
| 角色 | system / user / assistant | 新增 **`tool`**、**`developer`** |
| `StreamChunk`（插件产出） | — | **逐字节未变** |

⚠️ **`StreamChunk` 没变，所以产出侧（`stream()`）完全不用改** —— 坏的只是
**消费**方向（harness 传给适配器的 `options.messages`）。

各适配器都按 `type === 'tool-result'` 识别工具结果，该判据在 0.1.7 下**恒不命中**：

1. 工具输出被当成普通 user 消息下发，`tool_call_id` 关联丢失；
2. `resolveToolPairing` 的 `allResultIds` 恒为**空集**
   → `usable.every(block => allResultIds.has(...))` 恒 false
   → **assistant 的 `tool_calls` 被整体剔除**。

wire 上于是完全没有工具调用记录，模型看到的是「我说了段话，用户回了段工具输出」。

**实测**（真实 session `session-54cbd95c`，2492 行 v3 日志经 0.1.7 解析器迁移）：
修复前保留 **0** 条工具调用，修复后 **512** 条，与 0.1.5 形状对照完全一致。

⚠️ **0.1.7 没有任何协议协商机制**：`packages/llm` 里 `LlmAdapter` / `GenerateOptions`
都没有版本协商字段（搜到的 `protocolVersion` 全属 ACP，与 LLM 适配器无关）。
所以**不能靠协商规避**，必须让代码同时认两种形状。

### 修法：形状归一化层，不改五个序列化实现

新增 **`src/message-shape.ts`**，把 0.1.7 形状**降级**为既有代码已理解的 0.1.5
形状，各入口只插一次调用：

- `normalizeHarnessMessages(messages)` —— 一等 `tool` 消息 → 包回
  `{role:'user', content:[{type:'tool-result',...}]}`；`developer` 消息**丢弃**
  （它只承载工具增删元数据，不是对话内容）；其余原样透传。
- `detectMessageShape(messages)` —— 判据用**形状**而非版本号（沿用
  `settings-compat.ts` 的能力探测先例），且**同时出现两种形态时以 `tool-role` 为准**
  （升级期会话可能混合；判成 legacy 会让新形态结果被漏掉，等于没修）。

⚠️ **`content` 数组必须整体保留、不压平** —— 既有实现依赖内嵌 `image` 块做图片
提升（工具结果内嵌图片须挂到其后的独立 user 消息），压平会让图片静默丢失。

⚠️ **`developer` 的剥离与形状探测相互独立**：`detectMessageShape` 只回答「工具
结果长什么样」，而 `developer` 是 0.1.7 专有角色，**无论有没有工具结果都要剥离**。
两者必须分别求值，否则「无工具结果的会话」会把 `developer` 当普通 user 消息下发。

⚠️ **无需改动时返回原数组引用**（`===`），保证 0.1.5 路径**逐字节**不受影响。

落点（6 处）：`sse.ts` 的 `resolveToolPairing`（共享防线，须自身独立正确）、
`llm-adapter.ts` / `openai-compat.ts` / `buddy-adapter.ts` /
`lobsterai-adapter.ts` / `trae-adapter.ts` 的 `serializeMessages`。
`qoder-adapter.ts` 复用 `openai-compat.serializeMessages`，自动受益。

⚠️ **`resolveToolPairing` 的 `content` 参数放宽为可选**（归一化层产出的类型允许
缺 content；函数内部本就按「非数组即视为空」处理）。这是**纯放宽**，不改变行为。

### 回归用例

- `tests/unit/message-shape.spec.ts` —— 探测/归一化/幂等/身份返回/真实字段布局
  （含 `source.callId` 回退：顶层 `toolCallId` 缺失时不能丢 id）。
- `tests/unit/message-shape-adapters.spec.ts` —— **核心不变式**：同一份语义数据按
  两种形状喂入，`serializeMessages` 输出**逐字节等价**。比逐个断言字段更强，
  且对实现方式中立。
- `tests/unit/session-replay.spec.ts` —— **真实会话回放**（离线只读，无网络）。
  自造 fixture 可能在真实数据上失效，故用真实会话锁死。需 `DSH_SESSION_FIXTURE`
  指向导出文件，未设则**干净 skip**（⚠️ 文件必须**惰性读取** —— `describe.skipIf`
  仍会执行回调体收集用例，顶层 `readFileSync(undefined)` 会让整份套件变成
  Failed Suite 而非 skip）。
- `scripts/export-session-messages.mjs` —— 只读导出真实会话消息。
  ⚠️ 必须用 `createSessionFormatCatalogWithChildren([])`（**不是**默认 catalog）：
  V3→V4 迁移要求显式提供子会话事实，无子会话时传**空数组**，否则 `createStage`
  抛 `SessionFormatUnsupportedMigrationError`。

⚠️ **验证「修复有效」必须做反向验证**：临时让 `normalizeHarnessMessages` 恒返回
原数组（= 修复前行为），确认用例**会失败**。否则可能写出一组恒真的同义反复。

## ⚠️⚠️ 自动续跑不得在 `agent/status` 派发栈内投递（Issue IKLEOW）

**真实报障**（用户 2026-10-13）：思考循环被守卫中止 → 插件自动续跑之后，
**对话的进行中状态丢失** —— Stop 按钮消失、插话（Steer）置灰且被服务端拒绝。

### 根因：`setPhase` 是**同步派发**，在它的监听器里同步 `followup()` 会重入

`packages/core/agent-loop/src/agent.ts` 的 `setPhase`：

```ts
private setPhase(next: Phase): void {
  const previousStatus = this.status
  this.phase = next
  const status = this.status
  if (status !== previousStatus) this.dispatch.emit('agent/status', { status })
}
```

`kick()` 的 `finally` 里 `setPhase({kind:'idle'})` 派发 `idle`；若监听器**在该
派发栈内**同步 `agent.followup()`，`wakeDriver()`（相位已是 idle）会立刻
`setPhase({kind:'running'})` 并**再次同步派发** `running`。一次 idle 转换因此
产生**两个方向相反的信号**，客户端最终采用哪一个**取决于监听器注册顺序**。

客户端三处门禁**共用同一个 running 位**（`InputBar` 的 Stop、`QueueDock` 的
Steer、`session-controller` 的 `session/steer-unavailable` 准入），故该位一错，
**Stop 与插话同时失效**。

### 判据：不能用「最终 running 位」，要用**派发嵌套**

⚠️⚠️ **本缺陷的教训（我第一版测试就踩了）**：把「最终 running 位」或
「请求开始时的 running 采样」当判据，**同步与微任务两种实现下取值完全一样**
（实测都是 `TFTF` / 全 `true`）—— 那是一组**恒真的同义反复**。
真正有区分力的判据是「**续跑唤醒的那次 `running` 派发是否嵌套在 `idle` 派发内**」：

| 投递方式 | `agent/status` 观测（`{status, nested}`）|
|---|---|
| 栈内同步（缺陷）| `[running/F, idle/F, running/`**`T`**`, idle/F]` |
| 脱离派发栈（修复）| `[running/F, idle/F, running/F, idle/F]` |

### 修法（四条，缺一不可）

1. **脱离派发栈**：新增 `LoopResumeScheduler`，生产默认 `queueMicrotask`（不是
   定时器 —— 需求是「刚失败、此刻就续跑」，微任务只需让出同步栈）。**这是本
   函数唯一的投递路径**。
2. **投递前复核**：让出栈之后**重读权威值** `status === 'idle'` 且收件箱为空。
   `observeIdle` 里那次读取只是便宜的前置过滤（窗口内别人可能已把新一轮跑起来）。
3. **停止伪造 `source: { kind: 'user' }`**：按 harness 约定，`kind:'user'` 是
   **宿主对「直接人类输入」的证明**，而 `tool-goal` 的 create / edit / pause /
   resume 都据此授权 ⇒ 伪造会让自动续跑**冒用人类授权**且 UI 误渲染成用户发言。
   改用自有 kind `loop-resume`（⚠️ 0.2.0 起 source kind 由生产者自声明，
   `MessageSourceMap` 已删除共享的 `plugin` 包装）。
4. **收窄 `observeInput`**：只有**真介入**才清零连续续跑预算。

### ⚠️ `observeInput` 的收窄：是**健壮性**修正，不是已发生缺陷的修复

⚠️⚠️ **issue 根因 2 的归因已被实测推翻**，别再照抄它。它声称「harness 自身的
`runtime-context` 注入把预算反复清零 ⇒ 续跑**无界**」。三条实测反证：

1. `runtime-context` **根本不走 `agent/inbox/inserted`** —— 它是 `preStep` 里经
   `runtimeContext.project()` 直接拼进本次请求的（`packages/core/agent-loop/src/agent.ts`
   的 `preStep`），**721 个会话零命中**。
2. 回放全部 13 个含循环中止的会话：连续续跑**从未超过 2**（= 默认上限），
   也从未触发上限告警。
3. 把判据由「宽」（除我之外都清零）换成「窄」（只有真介入才清零），
   **13 个会话结果逐个相同**（投出次数与上限告警数完全一致）。

⇒ 收窄防的是「**某个每步注入通知的插件把上限架空**」这一形态。真实词表与频次
（721 个会话扫 `inserted[].source.kind`）：

| kind | 会话数 | 性质 | 清零？ |
|---|---|---|---|
| `user` | 712 | 人类输入（宿主证明）| ✅ |
| `agent-message` | 122 | 别的 agent 发来的 | ✅ |
| `subagent-settled` | 68 | 子代理收尾 | ✅ |
| `goal` | 13 | 目标驱动器排的下一轮 | ✅ |
| `user-approval` | 5 | 人工审批结果 | ✅ |
| `tool-jobs` | 130 | 后台任务通知（自动）| ❌ |
| `agent-instructions` | 97 | 工作区指令刷新（自动）| ❌ |
| `repeat-tool-reminder` | 11 | 重复工具提醒（自动）| ❌ |
| `tool-goal` | 10 | 目标工具收尾说明（自动）| ❌ |

⚠️ **来源缺失 / 形状未知时不清零**（按自动通知处理）：这是 fail-safe 的一侧 ——
清零会让预算被反复重置、续跑更频繁；不清算则计数继续累积、更快撞上限。

### ⚠️ `Inbox.hasPending` 不是契约成员

本插件原先读 `agent.inbox.hasPending`。它**从未进 `dsh-agent` 的 `Inbox` 公开
契约**（0.2.0 起类型里已无此项；运行时 `ReactLoopInbox` 仍有该 getter）。
改用契约成员 `nextTurn` / `nextStep` 的长度判断（语义等价：实现就是二者之和 > 0）。

### 测试

- `tests/unit/loop-recovery.spec.ts` —— 纯逻辑（判据/上限/来源/投递前复核/收窄）。
  ⚠️ 它注入 `schedule: task => task()`（同步）以便断言，**故它结构上无法发现重入**
  —— 这正是 issue 指出「单测没抓到」的原因。
- `tests/unit/loop-recovery-reentry.spec.ts` —— **真实组合测试**（用真实的
  `@deepseek-ai/dsh-agent-loop` + session/system-prompt/tools/agent）。
  ⚠️ 宿主包不在 devDependencies（只随 DSH 安装），故按
  `jet-hub-styles-ownership.spec.ts` 的先例**动态定位并惰性 import**，
  找不到时**干净 skip**。
  ⚠️ profile 的宿主包在**共享的 `profiles/node_modules`**，不是
  `profiles/<名字>/node_modules`（本机实测；只写后者会永远 skip）。
  **两种监听器顺序各跑一遍** —— 缺陷的表现形式取决于注册顺序，只验一种等于没验。
- **反向验证已做**（四者各自独立变红，别当同义反复删掉）：
  `defaultSchedule` 改回 `task => task()` → 嵌套断言在**两种顺序下**都变红；
  source 改回 `{kind:'user'}` → 3 条变红；删掉投递前的两行复核 → 2 条变红；
  停用 `isInterventionSource` 收窄 → 2 条变红。

## 常见开发任务

### 新增功能

1. 确定所属模块（auth 服务 / 命令 / provider）
2. 在 `src/` 对应文件中实现逻辑（客户端 UI 改 `plugin-src/client/`）
3. 添加单元测试覆盖
4. 执行 `pnpm build:all` 编译（host + client 两侧）
5. 执行 `pnpm test` 验证
6. 更新文档

### 调试

- 使用 `pnpm typecheck` 快速验证类型
- E2E 测试需要设置环境变量 `DSH_CODEARTS_E2E=1`（测试在打开的浏览器中需要人工点击授权）
- 构建错误检查 `lib/` 目录是否存在以及 `tsconfig.json` 的 include/exclude 配置
- ⚠️ **改完插件必须重建 `lib/` 并重启 DSH 才生效**：宿主侧代码在 DSH 启动时从
  `lib/index.js` 载入，不热重载（只有 `plugin-src/client/` 的客户端 bundle 有 HMR）。
  **排查「改了没效果」时先看这两个时间**：`lib/index.js` 的 mtime 与 DSH 进程的启动时间 ——
  进程早于产物就说明跑的是旧代码。
- ⚠️ **不重启还有第二种后果：新 provider 的账号可能从池里消失**（2026-10-13 观察到的现象）
  - **观测事实**（可复核）：`state.json` 里 accio **2 条 → 0 条**，而
    `.credentials.yaml` 里的 `ACCIO_ACCOUNT_*` **两条凭据完好**（都还剩 ~719 小时）；
    同时 `providerOrder` **不含 accio**；Web 进程启动 `10/12 19:59`，
    含 accio 的 `lib/jet-hub-store.js` 编译于 `10/13 17:38`（**进程比产物早 ~22 小时**）。
  - ⚠️ **机制未确证，别照抄推测**：一度怀疑是「旧进程的陈旧 `cache` 整体回写抹掉它」，
    但**决定性实测证伪了该假设** —— 构造「载入时无 accio → 外部往磁盘加 accio →
    对无关账号做一次写操作」的序列后，**accio 仍存活**。
    ⇒ `AccountPool` 的整体回写**不会**凭旧 cache 删掉它（`sanitizeAccounts` 不按
    provider 过滤）。**真因尚未定位**，候选：DSH settings scope 的 schema 裁剪、
    客户端的 provider 列表驱动写入、或某条按 provider 白名单的写路径。
  - ⇒ **实用结论（仍成立）**：加完新 provider 后**重启 DSH**（web + desktop
    两个 profile），既为让新代码生效，也避免这类「新旧混跑」造成的账号池异常。
  - ⚠️ **凭据与账号池不同命**：账号池条目丢了**只是界面看不见**，
    `.credentials.yaml` 里的凭据仍在 ⇒ 探针/测试**直读凭据即可**，不依赖账号池。

#### ⚠️ 「没有任何报错就中断」怎么查

这类现象**无法靠读代码推断**，必须回到会话记录。DSH 把每次请求的**原始 chunk 流**
也记进了 `assistant/message` 事件（`data.stream`），据此可还原真相：

```bash
node scripts/inspect-session.mjs list zed                      # 找会话（工作区关键字）
node scripts/inspect-session.mjs turns <会话文件>               # 每轮结束原因（先定位可疑轮次）
node scripts/inspect-session.mjs brief <会话文件> assistant/message 700
node scripts/inspect-session.mjs stream <会话文件> <seq>        # 该步的原始 chunk 流（关键证据）
```

会话日志位于 `~/.dsh/sessions/<工作区转义名>/<session-id>/session.v3.jsonl.zstd`
（**zstd 压缩的 JSONL**；工作区名把 `\` `/` `:` 换成 `-`，如
`D:\jet\code\rust\zed` → `--D-jet-code-rust-zed--`）。

判据（真实案例，2026-09-23，`qoder`/`qfmodel`）：同轮相邻两步对照 ——

| 步骤 | chunk 流 | finish |
|---|---|---|
| 正常步 | `block-start(text) → text → block-start(tool-call) → tool-call-chunks → block-end×2` | `tool-calls` |
| 中断步 | `block-start(text) → text →`（**无任何 tool-call**）`→ usage → block-end` | `stop` |

即：模型写完「让我检查 X：」后流就结束了。**`turn/end` 是 `completed`**，
UI 上完全看不到错误。

⚠️ 两个可能成因，**不要凭猜认定**：
1. **连接被掐断**（没有 `finish_reason`、也没有 `[DONE]`）→ 已由
   `consumeOpenAiSse` 的 `truncatedStream` 判定改为报 `max-tokens`（可重试）；
2. **模型确实输出了 `finish_reason: stop`** 却没产出工具调用（模型抖动）→
   本层无从强制，但此时**行为可与 (1) 区分**：修复后 (1) 会重试、(2) 仍是 `stop`。
   若重启后再现且仍不重试，说明是 (2)，需换思路（如减少单步工具数量）。

**其它已修的同族缺陷**（都表现为「无报错中断」，改 `openai-compat.ts` 时务必保留）：

- **网关形态错误帧被整帧丢弃**：帧形如
  `{"stackTrace":[...],"message":"...","statusCodeValue":400}` ——
  **既没有 `code` 也没有 `error`、也没有 `choices`**，早期解析器所有条件都不命中。
  现按 `statusCodeValue >= 400` 或带 `stackTrace` 判为错误并抛出。
> ▶ 本节其余内容见 `docs/agent-notes/dev-tasks.md`（按需读）。

## LLM Provider 约定

- provider 名称：`codearts` / `buddy` / `workbuddy` / `lobsterai` / `qoder` / `trae`
- 端点格式为 OpenAI 兼容
- 请求签名/鉴权方式因 provider 而异：
  - `codearts`：华为云 `SDK-HMAC-SHA256` 签名方案
  - `buddy` / `workbuddy`：Bearer access_token + 额外自定义头（`X-Product-Code` 随产品切换）
  - `lobsterai`：Bearer access_token + `X-LobsterAI-Client-*` 头（**无签名**，也**不带**腾讯系归属头）
  - `qoder`：推理请求头**由 WASM 生成**（含签名），**必须原样透传**，不能自行构造；请求体加密。积分余额端点另走纯 `Bearer`。
  - `trae`：`Cloud-IDE-JWT <token>` + `X-Cloudide-Token` / `X-Ide-Token` / `X-Uid` / `X-Machine-Id` / `X-Device-Id` / `X-Ide-Version` 等十余个身份头（**无签名**，**不带** JSON-RPC 包装）
- provider 在 `ctx.llm` 上注册，配置在 profile 中可选
- `buddy` 与 `workbuddy` 共用 `BuddyAdapter`，行为差异全部由 `src/product.ts` 的 `BuddyProduct` 配置驱动；新增同源产品只需加一份配置并注册实例
- `lobsterai` 用独立的 `LobsteraiAdapter`（协议不同源，见项目概述）；它的产品配置是 `src/lobsterai-product.ts` 的 `LobsteraiProduct`，与 `BuddyProduct` **平行而非继承**
- `qoder` 用独立的 `QoderAdapter`（协议不同源，见项目概述）；产品配置是 `src/qoder-product.ts` 的 `QoderProduct`，同样**平行而非继承**。它的 OpenAI 协议层逻辑复用 `src/openai-compat.ts`
- `trae` 用独立的 `TraeAdapter`（协议不同源）；它的产品配置是 `src/trae-product.ts` 的 `TraeProduct`，同样**平行而非继承**。与其它四个 provider 最根本的差异是**载荷与响应都要转换**：请求体经 `transformToSOLOBody` 转成 SOLO 格式，响应经 `parseTraeSSELine` 从 SOLO 自定义 SSE 转成 OpenAI chunk

## ⚠️ 两张注册表：`PROVIDER_REGISTRY`（数据）与 `PROVIDER_RUNTIME`（实现）

2026-10-08 的 provider 能力抽象重构引入了**两张职责不同的注册表**。
新增 provider 时**必须知道改哪张、以及为什么**。

### `src/provider-registry.ts` —— **纯数据**，零 import

各家的**元数据与能力声明**（id / 展示名 / 图标 / `channel` / `credits` /
`permanentLock` / `usesExpiryWindow` / `accountTest` …）。

- ⚠️ **必须零 import**：它同时被 Node 宿主（`tsc`）与浏览器客户端（`esbuild`）使用，
  任何 `node:*` 依赖都会让客户端打包失败。客户端的能力表（
  `plugin-src/client/credits-capabilities.js`）**从它派生**，不再手抄。
- ⚠️ **provider id 一律纯小写字母**（不带连字符）—— 它同时是 cordis 服务名
  （`${product.id}Auth`）、LLM 路由名与客户端 key。`qodercn` 不带连字符正因如此。

### `src/provider-runtime.ts` —— **实现**，运行时按 id 查表

各家的**能力实现**（`auth` / `credits` / `onboarding` / `expiry` / `probe`），
在 `apply()` 里经 `registerProviderRuntime({ descriptor, auth, … })` 注册。

- ⚠️ **`registerProviderRuntime` 重复注册时保留先注册者、返回 `false`、不抛错**：
  本仓库有**实测的 fiber 重启竞态**（新 fiber 的同步 `apply()` 与旧 fiber 的异步
  `dispose()` 交错），抛错会让整个插件加载失败。
- ⚠️ **读注册表建索引的派生表必须是函数，不能是模块级常量**：
  `wiredRefreshTargets()` / `registeredRuntimeIds()` 读的是注册表，而注册发生在
  `apply()` 里 ⇒ 模块级常量在**模块加载时**求值，会恒为空表。**症状是静默的**
  （所有 provider 都不再自动续期，日志里只有常规输出）。有用例锁住。
  ⚠️ **纯数据清单不受本条约束**：`src/aggregate-expiry.ts` 的
  `WIRED_EXPIRY_PROVIDERS` **刻意保持常量**（它不是从注册表读出来的索引，
  改动会波及 29 处探针 + 86 处适配器构造），它与 runtime 的一致性改由
  `expiry-runtime-parity.spec.ts` 真跑 `apply()` 的用例锁死。
  别照搬本条去改那张表。
- ⚠️ **查表用 `Object.hasOwn` / 导出的 `xxxOf()` 助手，不要用下标**：
  `table[id]` 会命中原型链上的键（如 `constructor`），与 `authOf` 同因。

### 抽象边界：**编排可抽象，协议不抽象**

设计文档 §3.5 的边界。已抽出的**编排**骨架（`credential-resolver` /
`model-catalog` / `provider-credits` / `provider-onboarding` / `provider-expiry` /
`buddy-balance-selector`）只回答「**选哪个原语、按什么顺序**」；
各家的**协议**实现（签名、端点、载荷转换）留在各自模块内，**不强行统一**。

⚠️ **形态确实不匹配的家要如实排除，不要为「凑齐 N 家」而丢语义**：
`codearts` 的 `resolveCredential` 无 fallback 且不收 `modelId`（不纳入
`createCredentialResolver`）；`opencode` 的门控/黑名单/模态/context 与
`createModelCatalog` 有 5 处协议级差异（不纳入）；`loomy` 的 reason 类型与
`BuddyBalanceSelector` 结构不兼容（保留自己的分支）。

### ⚠️ 三类**静默失效**及其防线（重构时逐条核对）

| 失效形态 | 症状 | 防线 |
|---|---|---|
| **漏接一家** | 该家凭据永不自动续期 / 重测标记永远清不掉，**日志零字** | 派生表 + 从 `PROVIDER_REGISTRY` 派生的用例（漏一家**点名**） |
| **位置/键错位** | 中国版账号用国际版凭据续期（历史复发 6 次） | 命名对象形参（`JetHubAuths`，键 = provider id）+ 逐 provider 断言「恰好自己那个实例被调」 |
| **「未知」被写成「否定」** | 图片静默发不出去 / 或发到不支持的服务端 | `inputModalities` 三态（省略 = 未知，`['text']` = 明确不支持）+ 双向用例 |

⚠️ 另有两条**注释级**陷阱（本重构各踩过多次）：
- **不要引用行号**（`foo.ts:123`）—— 最大的文件 4000+ 行，每次重构都会失效。
  **按符号名引用**。
- **不要在注释里写出「会被验收 grep 的字符串」**（被删的符号名、`foo(` 形态）——
  会让「该符号应不存在」这类检查失效。

## ⚠️ 移植既有实现的轮换/重试语义：先抄「类别→动作」表，不是抄循环骨架

**真实事故**（2026-10-06，PR #64 的 raccoon/loomy 轮换）：照 `buddy-adapter.ts`
的**循环骨架**（tried 集合 + `getAvailableAccount(exclude)` + 换号重发）给两家补了
请求级轮换，但**漏抄了 buddy 的分支语义表** —— buddy 只在**限流类**失败写冷却标记，
认证类（401/403）只 `continue` 换号**不写标记**。初版写成「凡可换号就写冷却，
时长 `status===429 ? 1h : 24h`」⇒ 上游网关对全池回 401（`authorization_verify_error`）时，
**一个请求内 6 个号各被封 24h，整个 provider 死一天**（症状
`no usable credential; log in first`）。

**审查侧规则**（给 code-review 与自审）：看到「对齐/移植/参照既有实现」的 PR，先要
那张**类别→动作**表，再逐格对照源实现 —— 骨架长得像不代表语义抄全了：

| 问 | 为什么 |
|---|---|
| 源实现把失败分几类？判据是什么？ | 分类是语义的载体（quota/rate/auth/other 各自动作不同） |
| 每类**换不换**下一个候选？ | 换号无益的类别（400 参数错）不该换 |
| 每类**写不写**状态标记（冷却/黑名单）？ | 认证类写冷却＝把网关故障放大成全池不可用（本次事故格） |
| 每类**抛什么错误码**？ | 401 报成 `QUOTA_EXCEEDED` 会误导排障与重试策略 |
| 候选耗尽时报什么？带不带最后一次的真实原因？ | 笼统报错丢服务端原文（buddy 上同款教训） |

新实现必须配**逐格回归测试**（每格一条，先红后绿）；漏抄的那格就是将来的事故。

### ⚠️ 同族判据必须**逐格同构**，改一侧就要改另一侧（2026-10-06 同型复发）

`classifyRaccoonFailure` 与 `classifyLoomyFailure` 是**同一张判据表的两个实现**。
raccoon 在 `7b524ff` 收窄后 loomy **未同步**，于是同一报文在两个 provider 上被判成
**不同类别**，且危险方向恒定朝 loomy（多写冷却）—— 实测四例：

| 报文 | loomy（未同步时） | raccoon（已修） |
|---|---|---|
| `403 + insufficient permissions to access this resource` | `quota` ⇒ **写 24h** | `auth` ⇒ 只换号 |
| `403 + 积分不足` | `quota` ⇒ **写 24h** | `auth` ⇒ 只换号 |
| `401 + 余额不足` | `quota` ⇒ **写 24h** | `auth` ⇒ 只换号 |
| `400 + context window is insufficient for this model` | `quota` ⇒ **写 24h** | `other` ⇒ 不换号 |

前两行与上面的「全池被封」是**同一事故形态**，只换了触发词。两条不变式：

1. **401/403 先判**，恒归认证类 —— 状态码与额度文案并存时（网关侧故障常在报文里
   捎带余额提示）**以状态码为准**；
2. `insufficient` 单独出现**过宽**，必须与邻近的「钱」义词
   （`point` / `credit` / `balance` / `quota` / `token`）**共现**才算额度。
   方向是**宁可漏判不可误伤**：漏判只是不换号，误判会封可用账号 24h。

⚠️ **两侧各写一份用例挡不住复发**（单方面"改严"时两边各自的用例都能过）。
`tests/unit/loomy-adapter.spec.ts` 的「与 raccoon 对拍」段把**同一批真实报文
喂两个分类器、断言逐条同结论**，分叉即红 —— 这是防复发的真正闸门。
