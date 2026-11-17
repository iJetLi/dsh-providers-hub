## 上游活动徽标（issue #101 移植）：判据来源、刻意分叉、实测取证与性能边界

> 落地日期 2026-11-17 · GitHub issue #101
> 代码：src/model-promotions.ts + src/promotion-edge-broadcast.ts
> 测试：tests/unit/model-promotions.spec.ts、tests/unit/model-promotions-wiring.spec.ts、
>       tests/unit/promotion-edge-broadcast.spec.ts、tests/unit/promotion-edge-wiring.spec.ts

### 1. 移植来源：两条腿各取一家，**判据不重写**

- **腾讯腿** = dsh-connect-workbuddy 的 src/promo.ts + docs/PROMO_BADGE.md。
  搬过来六条判据：running 优先于 standing、dailyUnusable 不许当成全天、
  validUntil 端点**不含**、badge.display 的 activeOnly、同分时活动先于等级标记、
  无颜色即 neutral。
  **没搬的**：selectPromoMultiplier（折扣价）—— 本仓价格腿 src/buddy.ts 的
  parsePromotions 已有实测判据（x 前缀 vs 后缀两套写法、factor 0 = 免费、
  无窗口 0x 视为占位），两套并存是刻意的，**不许顺手统一**。
- **Qoder 腿** = dsh-connect-qoder 的 src/promo.ts：「有窗口时窗口说了算、
  active 只是无窗口时的回退」与「声明了窗口但读不懂 ⇒ 整条不画」。
  它的 promoDisplayAt 三态里 **pending（降饱和胶囊）没搬**，见第 4 条。

### 2. ⚠️⚠️ 数据必须在**装配时刻**求值，不能冻在解析时

徽标是「此刻」的函数。目录条目里存的是**未决候选表**（BuddyRemoteModel.promos），
挑一枚发生在 toCatalogEntry（每次 listModels 都跑）。在解析时挑定 =
「22:59 读到的夜间折扣，第二天 08:00 还挂在行上」—— 那正是 issue #101 点名的事故
（用户按优惠期选择、实际按原价计费）。

守卫：model-promotions-wiring.spec.ts 的「徽标按装配时刻求值」——
同一个适配器实例，改注入时钟就换答案。

⚠️ 时钟必须**只读一次**并存进局部量。写成「判 !== undefined 一次、取值再一次」
会在跨过窗口边界那一分钟拿到不一致的两半，产出 badge: undefined 键，破坏三态。

### 3. ⚠️⚠️ promos 必须出现在 reconcileWithFallback 的白名单里

reconcileWithFallback 是**白名单式重建**：不显式搬运的字段被**静默丢弃、零报错**
（该函数自己的注释就写着「新增远端字段时必须同步加一行，否则 listModels 看不到它」）。
漏这一行的症状：解析层全绿、model-promotions.spec.ts 全绿，界面上一个徽标都没有。
有牙守卫：变异 M1 实测 5 条红。

同源的第二处：buddy-oauth.ts 的 applyPromotionCandidates。scoped 端点**不下发**
活动数组（实测响应里 discount / promo 零命中），而 mergeRemoteModels 对同 id
**以 scoped 为准** ⇒ 只补价格不补候选，徽标永远挂不上（与用户报障
「GLM-5.2 是 0.5，现在显示 0.79」同一个成因，只是这次丢的是徽标）。M8 一条红。

### 4. ⚠️⚠️ 与参考实现**刻意分叉**的一处：窗口外不画「还没到点」

dsh-connect-qoder 在**自己的卡片**上会给未开的窗口画一枚降饱和胶囊、悬停写
「22:00 生效」（promoDisplayAt === pending）。本仓**不画**：宿主徽标契约只有
{ text, tone }、**没有悬停位** ⇒ 在没打折的时刻画「错峰 4 折」就是在说一件
没发生的事。行上的原价后缀已经把「现在按原价」讲明白。

落地是 ModelPromotion.standingEligible：腾讯 true（它的「白天只带角标」条目靠它
让徽标全天挂着，那是上游的语义），Qoder false。M5（改成 true）3 条红。

**将来若要恢复这一支**，前提是宿主徽标加上悬停/description 字段，不是先画出来。

> ⚠️ **2026-11-17 更新（§18）**：本仓后来自己占了 `conversation.input.model.label`
> 槽位，于是**有了**悬停位 —— 但那一支**仍未恢复**：判据本体是
> `standingEligible`（Qoder false），改成 true 会让白天挂上「错峰 4 折」。
> 现在多出来的能力只用于**已成立**的活动补一句说明与有效期，不改变「窗口外不画」。

### 5. ⚠️ 时区兜底必须与**价格腿**同值，两处都不是 UTC

- 腾讯：parseTencentPromotions 第 3 参默认 Asia/Shanghai —— 与 src/buddy.ts 的
  zonedMinutes（无 timezone 时兜底 Asia/Shanghai）同值。
- Qoder：qoderPromotionCandidate 兜底 Asia/Shanghai —— 与 qoder-adapter.ts 的
  promotionActiveNow（硬算 UTC+8）同方向。

兜底值不同会让同一份报文在「价格」与「徽标」上差 8 小时说话（一文件两套同义判据
的复发形态）。有牙守卫：「上游没写时区时用调用方传入的兜底」—— 同一个 epoch
时刻两种兜底给出两种答案。

⚠️⚠️ **二次审计更正（2026-11-17）**：本节的「兜底必须与价格腿同值」在 PR head
上**并不成立** —— Qoder 徽标腿当时写的是
`timezone: promotion.timezone ?? fallbackTimeZone`，**听的是上游字段**，而价格腿
`promotionActiveNow` 硬算 UTC+8。上游发 `Asia/Tokyo` + 窗口 `22:30–07:50` +
`23:10Z` 时实测 **price=true / badge=false**（两腿反向）。修法已改为**新腿对齐
老腿**：一律 `timezone: fallbackTimeZone`（调用方传 `'Asia/Shanghai'` = UTC+8
无 DST = 价格腿硬编码的 +8）。改价格腿要连 `nowImpl` 与时区语义一起审，属独立 PR。
守卫：`tests/unit/model-promotions.spec.ts` 的「上游发 Asia/Tokyo 时，候选的
时区仍必须是调用方的 fallback」。

**方向刻意不同的一处（已核实并保留）**：时区**非法**（Not/AZone）时，
- 徽标腿：**不算在跑**（zonedMinute 返回 undefined ⇒ false）；
- 价格腿：src/buddy.ts 的 promotionActiveNow 是「不误杀 ⇒ 视为生效」。

这不是漂移，是两条腿的风险方向不同：价格腿误杀会让活动凭空消失（用户报障过），
徽标腿放行会夸大一句优惠。⚠️ 若要统一，必须先重跑那两条用户报障的证据，
不要按对称美学改。M10 有专门一格取样盯着：05:00 UTC 的墙上分钟数 300
恰落在 23:00–7:50 内 ⇒ 退回本地就会翻转成 true。

### 6. ⚠️ 宿主契约的三条实测边界（取证于本机 app.asar 与 dsh-llm 声明）

| 事实 | 证据 | 后果 |
|---|---|---|
| LlmModelInfo.badge **能**到选择器 | dsh-llm/lib/index.js 的 listModels 白名单里**带** badge（表形态浅拷贝） | 徽标走数据面，不需要抢 conversation.input.model.label 槽位 |
| resolveModel **不带** badge | 宿主类型注释原文 exact-route resolution omits it | 骨架的 resolveModel 不许顺手补齐（有守卫） |
| 宿主渲染就是 Tag{tone} + 名字 | ModelSelect 的 renderModelLabel 回落分支；buildModelCatalog 逐字透传 badge | 只有**没有插件占该槽位**时回落才跑；本方案走数据面，与占位无关 |

⚠️ 本仓**不注册** conversation.input.model.label 槽位（plugin-src/client/ 里该串
零命中），所以不存在 issue #101 评论里担心的「单槽位抢占」冲突。
dsh-connect-* 那两个插件抢了这个槽位 —— 如果将来本仓也去抢，两边的行会互相顶掉。

badge 缺席 ⇒ **整个键不写**（不是 badge: undefined）。写 undefined 会把「未知」与
「明确没有」在两处白名单重建里混成同一个键（本仓 toModelInfo 与宿主
resolveModelInfoFor 的判据严格程度不同）。

### 7. ⚠️ 类型名**不能**从 @deepseek-ai/dsh-llm 导入

本包 peer 下界 ^0.1.2-rc.1 里 LlmModelInfo **没有** badge 字段（0.2.2 才加），
LlmModelBadge / LlmModelBadgeTone 同样在下界不存在 ⇒ 导入会让下界编译不过。
故 ModelPromotionBadgeValue / ModelPromotionTone 是本地声明（逐字同形）。

⚠️ 但 text 的表形态**必须显式写出 en**：宿主 LocalizedText 里必需的 en 只存在于
字面量类型（裸 Record 不可赋值）—— 少了它宿主的 resolveText 返回 undefined,
**胶囊整个消失**。这是「把不变式写在编译器能检查的地方」，不是绕编译错误。

### 8. ⚠️ 上游按**客户端身份**裁剪这份文档（真实探测 2026-11-17）

同一个 URL、同一套凭据、同一天，GET /v3/config 的答案取决于 User-Agent：

| UA | data 键数 | modelPromotions | modelTiers |
|---|---|---|---|
| WorkBuddy/5.9.4 WorkBuddy AI/5.9.4 CLI/5.9.4（本仓产品配置） | 17 | 1 | 1 |
| WorkBuddy/5.9.4 WorkBuddy/5.9.4 CLI/5.9.4 | 17 | 1 | 1 |
| CLI/2.63.2 CodeBuddy/2.63.2（纯 CLI 身份） | **5** | **ABSENT** | **ABSENT** |

实测到的真实条目（取证当时仍在窗口内）：
hy4-flash-free-trial-202611 ⇒ label Free now、color #FF0000、display activeOnly、
modelIds [hy4flash-free]、validFrom 2026-11-16T00:00+08 → validUntil 2026-12-01T00:00+08；
gpt-pro-only ⇒ label Pro Only、#009273、**无 schedule**（常驻等级标记）。

⇒ 「目录里读不到活动」有两问，顺序不能反：
① **UA 是不是 App 身份**（本仓两个产品都是）；② 上游**真的**没有活动。
ok:false 与 promotions.size === 0 是两件事（issue IKJVTF 的完整性判据），
不许用「快照是否为空」反推失败。

⚠️ 本仓国际版 UA 含 WorkBuddy AI/… 段而参考实现是 WorkBuddy/… 重复两次：
实测**两档都回 17 键** ⇒ 决定答案形状的是**头里声明了哪些通道**，不是版本字符串
（版本号是惰性的）。别为了「对齐蓝本」去改 UA —— 那会牵动签名与既有实测结论。

### 9. 边界播报器：promotion-edge-broadcast.ts 的三条判据

为什么需要：宿主缓存一次目录读取的结果，后台刷新器 20 分钟一轮 ⇒ 窗口关了徽标
最长挂 20 分钟。

1. **只排最近一枚**，播报后**重新问一次**边界（不许复用旧值，否则「窗口已关」的
   活动会让定时器按同一时刻反复空转）。
2. **超过 2^31-1 毫秒必须分片**。Node 的 setTimeout 超出该上限会**立刻触发**并打
   TimeoutOverflowWarning ⇒ 播报器误判「边界到了」，再拿同一个远期边界排一枚
   ⇒ 广播风暴。活动可以排在几个月后，所以「超过就不排」等于关掉功能。
3. **取不到边界就停表**，绝不退化成轮询：未登录 / 上游没活动 / 时区读不懂 ⇒
   undefined。拿「每 N 分钟醒一次」兜底会让所有无活动用户空转
   （catalog-prewarm.ts 刻意「有界、不轮询」同一条理由）。

⚠️ **播报是零网络的**：重读走 loadCatalog，而 ensureRemoteModels 的 20 分钟新鲜度
判据会短路 ⇒ 边界时刻只是用新时钟重算候选表。**若将来有人把徽标改成「必须重拉
目录」，这条前提就破了**（代价变成每天最多两次真实上游请求），本注释必须跟着改。

⚠️ 定时器必须挂 ctx.effect 回收（unref() 不算回收）。实测时间线（假定时器、
起点 08:00 Asia/Shanghai）：播报落在 +14h（22:00 开）与 +24h（08:00 关）交替。

### 10. ⚠️ 接线守卫的一个**假失败**教训（值得复述）

promotion-edge-wiring.spec.ts 的反向对照第一版是「boot() 之后把四家的
nextPromotionEdgeAt 钉成 undefined，再推进 26 小时，断言零播报」—— **红了**。
原因不是功能有问题：apply() 是同步的，播报器在 ctx.effect 里**当场**武装了
第一枚定时器；改 getter 追不上它，那条 14:00 的播报是真的。
⇒ 反向对照必须**问播报器读到的源**（包一层 createPromotionEdgeBroadcaster 观察
构造参数、实现仍是真的），而不是「改掉依赖之后会不会动」。
同一条判据适用于任何「构造期就武装」的定时器：事后替身只能影响**下一次**求值。

### 11. 变异登记表（18 个条件全有牙；其中**四条初跑无牙**，已补守卫而不是删变异）

> ⚠️ 二次审计（2026-11-17）又补了 10 条变异，其中 **9 条有牙**；**M3（buddy 边界播报的默认时钟）仍无牙** —— 见 §17 第 1 条。

| 变异 | 变红处 |
|---|---|
| M1 reconcileWithFallback 漏搬 promos | wiring 5 条 |
| M2 骨架 toModelInfo 不写 badge | wiring 7 条 |
| M3a 播报器构造了但不武装 | edge-wiring 1 条 |
| M3b 接线漏一家（qodercn 不交边界源） | edge-wiring 1 条 |
| M3c fire 变空转 | edge-wiring 2 条 |
| M4 clockMinute 类型闸门删除（issue #139） | promotions 1 条（not.toThrow） |
| M5 Qoder standingEligible 改 true | promotions 3 条 |
| M6 selectPromotionAt 第 1 步的门去掉 | promotions 9 条 |
| M7 buddy toCatalogEntry 不装配 badge | wiring 5 条 |
| M8 buddy-oauth 不补候选 | wiring 1 条 |
| M9 分片分支删除 | broadcast 1 条 |
| M10 时区读不懂退回本地 | promotions 1 条（05:00Z 取样格） |
| M11 dailyUnusable 的闸删除 | promotions 3 条 |
| M12 非有限界值不再判过期 | wiring 1 条 |
| M13/M14 两家的边界访问器恒 undefined | 各 1 条（**补测前无牙**） |
| M15 删掉「目录落地后重排」的监听 | edge-wiring ④ 1 条 |
| M16 去掉告警去重（每条 listModels 刷屏） | wiring 1 条 |

⚠️ **四条初跑无牙**，逐条登记根因与补法（本仓纪律：无牙要如实登记并补守卫,
**不许**为了登记表好看去写恒真断言）：

| 变异 | 第一次为什么全绿 | 补了什么 |
|---|---|---|
| M4（clockMinute 的类型闸门） | 用例只经过**解析路径**，而那里的 asText 已经先把数字挡住 ⇒ 闸门那一行根本没人走到 | 喂**第二个入口**：手构条目直接带 {start: 1380}，牙在 not.toThrow（危险方向是渲染路径抛 TypeError ⇒ 整条渠道消失） |
| M10（时区读不懂退回本地） | 取样时刻的墙上分钟数本来就**不在**窗口内 ⇒ 退回本地也是 false，变异与修复态**观察上等价** | 换一格真正落在窗口内的取样（05:00 UTC = 分钟数 300，落在 23:00–7:50 里）⇒ 退回本地必翻转 |
| M13 / M14（两家的边界访问器恒 undefined） | 接线守卫用**替身**换掉了 getter ⇒ 永远走不到真实实现 | 各补一条**直接问真实访问器**的行为用例 + 反向对照（同一实例换一个 nowMs 给不同答案；无活动 ⇒ undefined） |

四条的共同形状值得记住：**「用例变绿」不等于「被测那行被走到」**。要么证明取数路径
真的经过它（第二入口、真实实例），要么证明取样落在能区分两个状态的格子里;
两者都没有时，变异与修复态在观察上就是同一条码。

另有一条**刻意不写成 toBeUndefined** 的形态：手构条目里窗口端点是数字
（start: 1380）且**没带** dailyUnusable 时，徽标仍会常驻出现。这是对的 ——
隐藏靠**事实标记**，不靠「我读不懂所以猜一个最保守的」。守卫写成 not.toThrow
（真正危险的方向是渲染路径抛 TypeError ⇒ 整条渠道消失），并在用例注释里讲明白，
**不要**改成 toBeUndefined（那是给实现编一条它没有的判据）。

### 12. 本 PR 没做的事（如实登记，别当成已完成）

issue #101 一条里混了三件事，本 PR 只做「活动徽标」。另外两件：

- **排队信息**：首轮回复里「`grep -rn "codebuddy" src/provider-registry.ts` 零命中
  ⇒ 本仓没有 codebuddy provider」这句，**grep 的输出是对的、推论不成立** ——
  那条 grep 大小写敏感，而本家在该文件里写作 id `buddy` + 展示名
  「CodeBuddy (腾讯)」（大写 C，235-238 行）。⇒ **不需要**「另接一整家 provider」
  的工作量。真正缺的是**判据**：
  src/model-queue.ts 只认 Qoder 的 10605，而腾讯的排队是另一套业务码
  （6020 waiting / 6021 full / 6022 user_limit，配 /v2/chat/queue/status）。
  ⚠️ 参考实现自己也**只做了识别**：它明写「not hold the request open and resend,
  那需要排队答案在 OpenAI 兼容端点上的形状，而没有任何测量给出过」。
  ⇒ 这是独立的一条功能（含轮询循环 + 上限 + 会话内状态），**不在本 PR 范围内**，
  也不该在下一轮里靠猜报文形状补上。
- **qoder 的客户端优惠信息**：本 PR 已经把目录每行自带的 promotion 做成了徽标，
  并且把上游的 timezone / rule_id / badge.en 三个字段**原样保留**进
  QoderModelPromotion（此前只留 badgeZh）。更深一层的「客户端优惠券 / 活动页」
  类信息仍未接：本仓没有任何实测端点，红线是不编造。
- **上游 hex 颜色的原样透出**：宿主 badge 契约只有四档 tone，没有任意色通道。
  本模块把颜色映射成 tone，hex 只作为 tone 的输入，不入库、不上屏。
  hover 文案同理：读到了、也保留在 ModelPromotion.hover 里，但宿主契约没有
  悬停位 ⇒ **当前不参与展示**（与 qoder 的 badgeZh 曾经同命）。将来宿主加字段时，
  接上它的是 promotionBadgeFor，不需要改解析层。

### 13. ⚠️ issue #101 首轮回复里那条「模型选择器是宿主渲染的，插件只能传文本」的判断**已过时**

该回复把「宿主没有徽标 API」当成前提，据此建议「把倍率从 name 里拿掉、另起一列」。
实测（本机 app.asar + dsh-llm 0.2.2-rc.1 的声明）：**0.2.2 起宿主有
LlmModelInfo.badge = { text: LocalizedText, tone }**，且 ModelSelect 就是用它渲染
名字旁边的 Tag。⇒ 徽标不需要抢槽位、也不需要退回文本方案。

⚠️ 但那条回复的**另一句仍然成立**：「静态兜底表必然腐坏」。本 PR 因此刻意
**不**给兜底表加任何活动字段（buddy 侧离线路径就是没有徽标），Qoder 侧的
promotion 是既有兜底表里**已经采集**的上游数据（不是新编的常量）。

另一条被回复列为「前置问题」的：「活动有效期的判据从哪来？」——
答案是**上游目录文档里就有**（schedule / window_start / validUntil），
不需要新增请求，也不需要静态表。第 8 条有真实报文。
### 14. ⚠️⚠️ 判定路径**必须缓存 Intl.DateTimeFormat**（实测 119µs/次 ⇒ 一条渠道 50ms+）

判定每跑一次就要问一次「这个时区现在几点」，而 new Intl.DateTimeFormat 的构造
实测**约 119µs** —— 比它要算的东西贵两个量级。首版没缓存时本机实测：

| 场景 | 缓存前 | 缓存后 |
|---|---|---|
| 单条 badge 求值 | 107µs | 3.7µs |
| 一趟 17 条（一家渠道） | 1876µs | 48µs |
| 一趟 460 条（cline 规模） | 52.7ms | 1.05ms |

为什么这条值得单独记：本仓已经有一次**同一个形状**的事故
（docs/agent-notes/providers-cline.md 的「模型目录构建的 O(N²)」：471 条实测
312ms ⇒ 1.5ms，起因是每次 resolveModel 都整份重建目录）。而 listModels 是宿主
buildModelCatalog 反复调的那条路（src/catalog-prewarm.ts 的头注就记着
「未登录或离线时表现就是首屏加载模型巨长」）。给选择器每一行加一次
「看起来只查了个时间」的调用，就是在给那条路加一个常数的两倍量级开销。

⚠️ **缓存必须有上限**（MAX_ZONE_FORMATTERS = 16）：时区名是**上游字符串**，
无上限等于让一个乱发的 feed 把我们的内存当它的字典。超出上限退回「现造一个
但不入缓存」—— 行为不变、只是不省时间；**绝不**因为缓存满而让判定失败
（那会把性能优化变成新的失效方向）。

### 15. 冷启动的两点限制（如实登记，不是「已完成」）

1. **首轮 schedule() 时 buddy / workbuddy 的远端目录还没落地**（remoteModels 是
   undefined ⇒ 边界 undefined），只有 Qoder / Qoder CN 的兜底表当场能给出边界。
   ⇒ 修法：index.ts 监听 `llm/adapters-updated` 重新求边界（目录落地时插件本来就会
   emit 该事件）。守卫 = promotion-edge-wiring ④，变异 M15 有牙。
   ⚠️ 这一条是**写守卫过程中**发现的：接线守卫①用 Qoder 兜底表的真实边界跑成绿色，
   完全看不出来「buddy 的远端活动要等到下一次 fire 才被看见」—— 又一次
   「取样偏差冒充覆盖」。
2. **播报按设计不重打上游**（见第 9 条），所以到点时读到的是「缓存目录 + 新时钟」。
   窗口**开启**与**关闭**两侧都在边界那一刻立刻改画。
   「活动**过期**（validUntil 到点）」同样不需要等 20 分钟刷新：边界时刻重算后
   该活动既不在跑也不能常驻 ⇒ 立刻不画。三段各有覆盖：装配
   （model-promotions-wiring「活动过期 ⇒ activeOnly 徽标整条消失」）、边界取值
   （model-promotions 的 nextPromotionEdgeMs 一组，validUntil 参与）、排程
   （promotion-edge-broadcast）。
3. **聚合路由（aggregate）这一代没有徽标**：它的 listModels 是手写的、不走共享骨架，
   条目是「虚拟模型」（跨渠道取最低价），而上游活动是**按真实 id** 下发的 ⇒
   「这条虚拟模型现在打折吗」取决于最后选中哪个账号，不是目录能预先回答的事实。
   ⇒ 刻意不接，不是漏接。要接先解决「虚拟模型 ↔ 候选真实 id」的归属问题，
   否则画出来的是**别人的**活动。
### 16. 告警通道：两家的「读不懂」各挂在哪、为什么不会刷屏

参考实现把日志留在**解析路径**（每次上游文档一遍），本仓两家的结构不同：

- **腾讯腿**：有独立解析点（parseModelsFromConfig）⇒ warnPromotion 走
  console.warn（src/buddy.ts 是「常量 + 纯函数」层，拿不到 ctx.logger；
  与 src/ 里既有告警同一通道，buddy-adapter.ts 自己就有 14 处 console）。
  每次文档一遍，天然不刷屏。
- **Qoder 腿**：活动就在目录每一行里、没有独立解析点 ⇒ 只能在 toCatalogEntry
  上报，而那里是「每条 × 每次 listModels」。所以加了**按消息去重 + 64 条封顶**
  （promotionWarned）。封顶后不再播、也不清空：宁可少一条日志，
  也不要一个会自己长大的内存。

⚠️ 两腿都**不能省**这条日志：省掉的后果不是「少一行输出」，而是
「徽标只是不再出现、全仓一个字都没有」—— 参考实现 issue #139 的原话症状。
用户无法自查、维护者无法归因的缺陷，判据就得自带一条出路。

### 17. ⚠️ 未修已登记（二次审计，2026-11-17；**不是待办清单**）

1. **M3 无牙**：`BuddyAdapter.nextPromotionEdgeAt()` 的默认时钟已改成
   `this.options.now?.() ?? Date.now()`（与 `toCatalogEntry` 同源），但**没有用例
   钉住**（要构造带假时钟的 `BuddyAdapter` 实例 + 一条带窗口的活动，成本高于
   该判据的风险面：它只影响单测确定性，不影响生产）。改这个默认值不会变红。

2. **`modelPromotions` 整体缺席 ⇒ 两腿一起消失且零日志**（对抗审计 P2-3）：
   无法区分「上游确实没活动」与「这份文档被 UA 裁剪了」。§8 的 17/17/5 三行
   表格**没有任何探针脚本留档**（`scripts/` 零命中），且三行 UA **都不是本仓
   实际发的 UA**（`CodeBuddyIDE/4.12.2` 从未被测过）⇒「本仓 UA 落不落被裁剪档」
   目前**无法独立回答**。补日志前要先有探针，否则只是把「不知道」写成一句断言。

3. **徽标腿不按 id 去重**（对抗审计 P2-4）：同一 `modelId` 有多条活动时，
   价格腿（`src/buddy.ts` 的 `parsePromotions`，用 `chosen` Map 按 id 取高
   priority）会去重，徽标腿（`selectPromotionAt`）只挑一枚、不去重。
   当前输入下两者给同一答案，但属又一处两腿分歧面，未修。

4. **`sortPromotions` 的 source tie-break 是死代码**（正向审计 P2-3）：
   `parseTencentPromotions` 恒先 promotion 后 tier ⇒ 该判据在生产输入不可达，
   用例 `:408` 恒真。未删（删了要同时改 `selectPromotionAt` 的语义）。

5. **§14 的性能换算**：两处数字与实测差 30–60%（`119µs/次` 与 460 次 65.2ms
   是两次独立测量，量级一致但比例不精确）⇒ 本节数字只作量级参考，不要当基准。

6. **`clockMinute` 的 `minute > 59` 分支**（正向审计 P3-6）零覆盖 —— 已由
   §16 的「读不懂」告警通道兜住（`09:60` 会落 dailyUnusable），故未单独补格。

### 18. ⚠️⚠️ 悬停这条腿：为什么徽标字段不够，以及占 single 槽的全部代价

用户实测反馈「未发现可见徽标」引出两轮定位，结论值得完整留档：

**第一轮（不是缺陷）**：截图里 `Hy4 flash · x0.00→免费 FREE` 那行 —— `免费`
是价格腿产物（`src/buddy.ts` 的 `parsePromotions`，factor 0 ⇒ `免费`），只有真
读到 `data.modelPromotions` 才算得出来；徽标腿读**同一个数组、同一个 id、
同一个 `push()`**（buddy.ts:784 vs 791-793、821-822）。⇒「缺拉取活动清单的能力」
被这张截图本身证伪。末尾那个 `FREE` 也不是徽标，是**同名消歧标记**
（`variantLabelFor`：`hy4-flash` 与 `hy4-flash-free` 撞显示名 ⇒ 公共前缀尾巴大写）。

**第二轮（真缺陷）**：起 web 的是 npm 全局 CLI `@deepseek-ai/dsh@0.2.1-rc.2`，
它自带的 `dsh-llm/lib/index.js` 里 `badge` **0 次命中** ⇒ 宿主白名单不透传徽标。
桌面端 asar（0.2.2-rc.3）同一处 1476 次命中。升级到 `@next`（0.2.2-rc.3）后白名单
实测为 `...badge === void 0 ? {} : { badge: { text, tone } }`，徽标才落地。
**教训**：「插件全绿 + 界面零徽标 + 零日志」先查**宿主版本**，再查装配层。

升级后徽标画出来了，但只剩短标签一句。原因（三条实测，全部取证于本机）：

| 事实 | 证据 | 后果 |
|---|---|---|
| 宿主 badge 契约只有 `{ text, tone }` | 0.2.2-rc.3 的 dsh-llm 里 `hover`/`tooltip`/`title` **各 0 次命中** | 上游 `hover.textZh` 那句长说明**无处可放** |
| 宿主回落渲染不带 title | asar @34131065：`jsx(Tag,{tone,children:resolveText(text)})` | 走数据面 ⇒ 永远没有悬停 |
| composer 菜单不渲染 description | `ModelSelect` 函数体内 `description` **0 次命中**（46 处全在 `/model` 弹窗那条路） | 「写进 description 换悬停」这条捷径不存在 |

⇒ 唯一出口是 `conversation.input.model.label`（宿主文档原文：「A contribution
replaces both and receives the badge in its owner props」）。用户选定该方案后
落地为 `plugin-src/client/model-label.js` + `src/promotion-tooltip.ts`。

**四条必须守住的判据**：

1. ⚠️⚠️ **该槽是 `single`**（实测宿主声明：`kind: 'single'`、`scope: 'session'`、
   `inline: true`）。赢家替**所有** provider 画行。所以组件必须两条腿：自家候选
   画 chip + 长悬停；外来行画 `model.name` + **宿主给的** `model.badge`。占住格子
   却只画裸名字 = 兄弟插件的徽标整片消失（dsh-connect-workbuddy 的 issue #138
   是同一形状，方向相反）。
2. ⚠️⚠️ **回落判据必须打在 model id，不能打在 provider**：`registerBuddyLlm` 走
   `registerAdapterIdempotent` ⇒ 撞名时**本家的注册被跳过、保留别人的路由**。
   若按「这家在不在候选表里」压掉宿主 badge，就会抹掉**别人按自己账号算出的**
   徽标。按 model id 判：我们对这一行真有计划数据才压。
3. ⚠️ **自家渠道绝不回落到目录缓存里的 badge**：`listModels` 那份 badge 是**装配
   时刻**挑定的，宿主最长 20 分钟才重读目录。候选说「此刻不成立」时若回落到它,
   画的就是过期徽标 —— 正是 issue #101 要修的形态。变异 N1（恒当外来）1 条红、
   N2（恒当自家）3 条红。
4. ⚠️ **取数完成必须 notify**：槽位在 `conversation.input.model` 挂载时注册，那一刻
   RPC 还没回；没有「快照落地 ⇒ 叫醒已挂载行」这条，首屏要等下一次心跳（60 秒）
   才画得出徽标，用户看到的就是「装完插件什么都没变」。

**刻意不依赖的两个机制**（都有实测理由）：

- `register({ inject })` 对 `single` 槽是否真被消费**无法从本机产物证实**（宿主文档
  只在 keyed/chain 语境写过 inject）⇒ `rpcCall` 存在模块级 `boundRpcCall`，由注册
  时绑定 + 心跳驱动，组件 props 里有没有它都不影响数据新鲜度。
- 兄弟插件的 priority：WB `-105`、QD `-1` ⇒ 本仓取 **`-200`**（严格更低，且不相等,
  同值会抛 `single slot already has a registration at priority N`）。

**代价如实登记**：占住 single 槽后，`dsh-connect-workbuddy` 自己行上的**负载图标、
「新」标记、折扣价后缀**不再由它渲染（它的徽标经 `model.badge` 数据面保住）。
`dsh-connect-qoder` 更硬：实测其 `src/adapter.ts` 里 `badge` **0 次命中** ⇒ 它不发布
数据面徽标，其错峰折扣 chip 由我们画不出来（我们的候选表也不含它的 provider）。
两条都是 single 槽的固有形状，不是缺陷；要消除只能等宿主把该槽改成 `keyed`。

**测试的两条方法论教训**（都在本次现场踩到）：

- 替身 React **必须真的执行 useEffect**：第一版把 `useEffect` 写成空函数，于是
  「失败保留快照」「心跳重取」「单飞闸门」三条腿一次都跑不到 —— 三条变异实测
  **全绿**。用例名承诺了它没验证的事，比没有用例更糟。
- 替身**必须收下并跑 useEffect 的清理函数**：心跳定时器住在模块级 `subscribeTick`
  里，不回收 ⇒ 第一个用例之后 `tickTimer` 恒非 null ⇒ 后续用例的 `setInterval`
  根本没建立，「过期后由心跳重取」那条**假绿**（实测期望 2 得到 1）。

另外：读者语言必须**显式注入**（`resolveHostBadgeText(text, languageOverride)`）。
宿主 `badge.text` 是表形态（LocalizedText），不 stub `navigator.language` 的话
断言会随跑测试的机器 locale 翻脸 —— 中文机器上拿到「限时免费」而断言写
`'Free now'`，红了也不是缺陷。

**变异登记：客户端侧 19 条 + 服务端侧 9 条，全部有牙。**

客户端侧（`tests/unit/model-label-promo.spec.ts`，20 条用例）：M1 外来 chip 删（1 红）、
M2 悬停短路（1 红）、M3 priority 抬到 -100（1 红）、M4 上游色丢（1 红）、
M5 名字换成 id（1 红）、M6b 失败清快照（1 红）、M6c 成功不记时间（1 红）、
M7 去单飞闸门（1 红）、M8 与 M14 取数完成不 notify（各 1 红）、M9 忽略读者语言（1 红）、
M10 自家分支 `if (false)`（3 红）、M11 不订阅（1 红）、M12 心跳不重取（1 红）、
M13 心跳不 notify（1 红）、M15 notify 空转（2 红）、N1 恒当外来（1 红）、
N2 恒当自家（3 红）、N3 不按 modelId 过滤（1 红）。

服务端侧：`jet-hub-rpc.spec.ts` 的 P1 空数组占键（1 红）、P2b 去掉隔离（1 红）、
P3 不告警（1 红）、P4 告警不点名（1 红）、P5 挑定徽标（1 红）；
`model-promotions-wiring.spec.ts` 的 A1/A2 适配器取数点（各 3 红）、
A3 恒空（3 红）、A4 剔掉 dailyUnusable（1 红）。

**三条初跑无牙，都是判据/夹具的问题而不是「功能没问题」**（已补用例而不是删变异）：

- 第一版 M6 打的是 `loadCandidates` 的**返回值**，而承重体是模块变量
  `candidatesSnapshot` ⇒ 该变异态与修复态行为相同 ⇒ **变异根本没注入**。
  换成 M6b（清空快照）才有牙。
- M13（心跳不 notify）初跑全绿：`notify()` 在心跳里与 `subscribeTick` 的
  `setTick` **冗余**。补一条「取数失败 ⇒ 成功路径的 notify 走不到」的用例,
  把这一格单独隔离出来才有牙。
- 初版三条（失败清快照 / 不记时间 / 去单飞）全绿，根因是替身 React 把
  `useEffect` 写成空函数（见上面的方法论教训）。

### 19. 无头出图与布局闸门：tools/model-label-shot.ts + measure-model-label.mjs

照 dsh-connect-workbuddy 的 `tools/section-shot.tsx` 那条路（jsdom 不做布局,
几何只能量）。两条命令：`pnpm shot:label` 生成 HTML，`pnpm shot:label:measure`
出图 + 测量 + 断言（本机没有 Chrome，浏览器自动找 Edge）。

**为什么必须有 measure 这一半**：只有生成器的话，整套工具是个**永远绿**的
截图器 —— 判据全在浏览器里跑，没人读回来。这正是本仓登记的装饰性产物形态
（「守卫有牙」≠「取值正确」）。

### 三条实测踩到的坑（都在本次现场发生，不是推演）

1. ⚠️⚠️ **闸门必须自己生成 HTML，不能只读现成的那一份**。变异验证里改完源码
   直接跑 measure，它量到的是**上一轮**留下的 HTML（实测 html mtime 19:54:28
   < 源码 19:54:36）⇒「删掉外来徽标代画」那组变异报出的红因是上一组「title
   换成短标签」的判据 —— 红因与被测腿完全无关，却给出一条**错误的确凿证据**.
2. ⚠️⚠️ **overflow 与 text-overflow 是两个字段，混成一个就恒绿**。上一版把
   `overflow` 记成 `cs(name,'text-overflow')` ⇒ 永远读到 'ellipsis'，于是
   「overflow:hidden 改成 visible」这一组变异**全绿**。拆开之后立刻有牙。
3. ⚠️ **盒子几何抓不到「文字画到框外」**：overflow:visible 时名字的
   `getBoundingClientRect().right` **完全不变**（文字只是溢出绘制）⇒ 只量
   盒子的 overlapsChip / clipped 两条都照旧通过。这一格必须打在**计算样式**上。
   同理 gap：读外层 `.cell` 的 6px 会漏掉本组件的 4px ⇒ 改成 0 时全绿,
   必须量「胶囊左缘 − 名字右缘」这个实际空隙。

另外两条通用坑（本仓已各有记录，这次又各踩一遍）：
- 模板字符串里的注释**不能出现反引号**（esbuild 报 Expected ';'）——
  `jet-hub-styles.js` 的文件头就写着这条，我在 shot 工具的注释里又犯了一次。
- 变异「全绿」先怀疑**变异本身**：G4 初跑我误判成无牙，实际 EXIT=1,
  错在我的分类器把「没匹配到标记」当成 GREEN。看退出码，别看猜的文本。

### 这套工具证明什么、不证明什么（如实登记）

| 判据 | 实测值 |
|---|---|
| 胶囊完整可见（12 档全过） | chipRight ≤ cellRight |
| 挤压方向：名字先让位 | 窄档 nameClip=true 且 chip 完整 |
| 成对判据 | clipped=7 行 **且** 存在不截的宽档（缺一即红）|
| 胶囊 flex | `0 0 auto`（与宿主同）|
| 名字截断声明 | `overflow:hidden` + `text-overflow:ellipsis` |
| 实际间隙 | 4px（宿主参照行同为 4px）|
| 悬停全文 | title 含上游原话 + 有效期，且**长过**胶囊本身 |
| 外来徽标代画 | case2 每档都有胶囊，title 恰为短标签（不替上游编长句）|
| 与宿主几何同构 | 同档截断状态一致 + 胶囊宽度差 ≤8px（实测 58 vs 55）|

**不证明**（写在这里免得被当成视觉验收）：
1. **截不到悬停**：`title` 由操作系统绘制、需真实鼠标停留 ⇒ headless 的
   `--screenshot` 拿不到。那句改由 `--dump-dom` 以**文本**落进审计并断言。
2. **配色不可比**：参照行只拿到宿主 CSS module 的 4 条规则，宿主胶囊的填充色
   来自它的 **Tag 组件**自己的样式表 ⇒ 图里参照行是灰字、我们的是绿底描边。
   这张图证明**几何同构**，不证明配色一致。
3. 渲染方是**替身 React**，不是宿主 ModelSelect ⇒ `.cell` 那层几何按宿主实测值
   手写，宿主改了这里不会跟着红。

变异登记（6 条，**其中 2 条初跑无牙、补判据后才有**）：

| 变异 | 初跑 | 现在 |
|---|---|---|
| G1 chip flex 改成收缩 | 8 处红 | 红 |
| G2 名字 overflow:hidden → visible | **全绿**（overflow 字段被记成 text-overflow 的值）| 红（字段拆开）|
| G5 本组件 gap:4px → 0 | **全绿**（探针读的是外层 .cell 的 6px）| 红（改量实际空隙）|
| G3 title 换成短标签 | 红（生成器即失败：断言打在产出 HTML 上）| 红 |
| G4 外来徽标分支反转 | 红（badge 为 undefined 时读 .tone 抛错）| 红 |
| G6 去掉 text-overflow | 红（实测 clip）| 红 |

⚠️ G4 的红因是**抛错**而不是判据 —— 合法，但要如实说明：它证明「这条分支
会崩」，不证明「判据本身有牙」。真正打在该腿上的判据是 G1/G2/G5/G6 那类。
