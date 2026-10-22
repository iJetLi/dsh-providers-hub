/**
 * Jet Hub 设置页面样式 —— 对齐 dsh-im 设计。
 */

const STYLES = `
.dim-jh-page { display: flex; flex-direction: column; height: 100%; }
/* 「侧栏」面板的宿主（main 槽）：中央面板自己不留白，只给顶部一条 28px 的
   标题带（插件市场页同款）。设置页里的 .dim-jh-page 则由 SettingsRoot 缩进，
   两条入口共用同一个组件、靠这一层补丁拉开差别。
   ⚠️ 顶部清障**只在 darwin 上叠加**（2026-10-26 修双重预留）：
   Windows 的框架已经把整块内容区按 padding-top: var(--dsh-windows-titlebar-height)
   （40px）下推过标题栏了，而 --dsh-frame-top-clearance 在 Windows 上正是同一个
   40px ⇒ 这里若无条件再叠一次，顶部就空出 40 + 28 + 40 = 108px，用户看到的是
   「卡片上方一大片白」。macOS 的框架不给这层 padding（红绿灯浮在内容上），
   所以只有 darwin 需要补。判据与插件市场页的 .V7pFBG_pageHead 逐字同源。
   ⚠️ 本文件是 JS 模板字符串，注释里**不能出现反引号**（会提前闭合）。 */
.dim-jh-panelHost { box-sizing: border-box; height: 100%; min-height: 0; display: flex; flex-direction: column; padding: 28px 24px 24px; }
[data-platform='darwin'] .dim-jh-panelHost { padding-top: calc(28px + var(--dsh-frame-top-clearance, 0px)); }
.dim-jh-panelHost > .dim-jh-page { flex: 1 1 auto; min-height: 0; }
/* ⚠️ 左右 padding 为 0（2026-10-14）：宿主 SettingsRoot 已经把整个 section
   内容区按 padding 0 24px 24px 缩进了一层（类名 .wCInkW_options，见
   @deepseek-ai/dsh-client-ui-settings-general/SettingsRoot.module.css）。
   此前这里再写 24px，页头就比下方内容（.dim-jh-layout 无 padding）多缩进
   一层，按钮行看起来往里缩、与 provider 列表左边界对不齐。
   改为 0 后页头与内容对齐到同一条 24px 基准线，并净得 48px 横向空间
   （页头按钮多，这 48px 直接决定「渠道原生搜索」开关是否换行）。
   注意：本文件是 JS 模板字符串，注释里不能出现反引号。
   ⚠️ 不要加回来：它省不了任何东西，只会重新制造那层错位。 */
.dim-jh-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 0; border-bottom: 1px solid var(--dsw-alias-border-default, #e5e5e5); }
/* ⚠️ 页头左侧的标题块**已整块删除**（2026-10-07）：
   ① 「Jet Hub」标题本体（.dim-jh-brand / .dim-jh-brandName）—— 页头一排已有
      7 个按钮，标题只占宽度、不带任何操作。CSS 一并删除（留在样式表里的
      「无引用规则」没有任何价值，只会在下次重构时被误当成生效样式）。
   ② 副标题「提供商凭据与多账号管理」（.dim-jh-brandDesc）—— 2026-10-06，
      按钮太多，副标题既显示不全又挤占页头高度。
   ⚠️ **两者都不要加回来**：设置页语义由 .dim-jh-page 的 aria-label
   「Jet Hub Provider 设置」与宿主左侧「Jet Hub」导航项承担，不丢。 */

/* 布局：对齐 dsh-im 的两栏 */
.dim-jh-layout { display: flex; flex: 1; overflow: hidden; }

/* 左侧导航：align dsh-im .dim-rail */
/* ⚠️ 宽度 228px 是「尽量给右侧让位」与「最长行不出省略号」的交点。算式（含滚动条）：
     可用文字宽 = W − 12(rail padding 6×2) − 2(按钮边框) − 20(按钮 padding 10×2)
                     − 30(图标) − 8(图标间距) − 15(Windows 经典滚动条) = W − 85
     W = 228 ⇒ 可用 **143px**，刚好装得下最长行 WorkBuddy (国际版) —— 它实测要 141px
     （!25 的实测表：200px + 行尾开关时标签只剩 77px、该行超宽 64px ⇒ 77 + 64 = 141）。
   与 !25 的 243px 相比省出 15px，再加上开关移走后消失的那条 8px 空列
   ⇒ 右侧账号区净得约 23px。**再往回收就会截断最长行**（用户已报过一次
   「workbuddy国际版有省略号」），要更窄只能改短 label —— 但那会与
   RaccoonProduct / QODER_CN 等 displayName 的跨文件一致性断言冲突，故未做。
   ⚠️ 测量本身的三条坑（inline 元素 clientWidth 恒 0 会得到假阴性、不能靠行高判折行、
   滚动条吃掉约 15px）见工作区 jet-hub-provider-toggle-notes.md。 */
.dim-jh-rail { width: 228px; border-right: 1px solid var(--dsw-alias-border-default, #e5e5e5); padding: 6px; overflow-y: auto; display: grid; align-content: start; gap: 8px; }

/* 每个 provider 按钮：align dsh-im .dim-channel */
/* padding 与图标间距比 !25 各收窄 2px（12→10、10→8）：这两处是**纯开销**，
   省下的每一像素都直接变成标签可用宽度，比加宽 rail 划算 —— 正是靠这 4px
   才把「不截断」所需的 rail 宽度从 232px 压到 228px。 */
.dim-jh-provider { width: 100%; min-height: 48px; display: grid; grid-template-columns: 30px minmax(0, 1fr); align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l2, #eef0f3); border-radius: 14px; color: inherit; background: var(--dsw-alias-bg-layer-3, #fff); box-shadow: 0 2px 8px rgb(31 35 41 / 3%); font: inherit; text-align: left; cursor: pointer; transition: border-color .16s ease, background .16s ease, box-shadow .16s ease; }
.dim-jh-provider:hover { border-color: color-mix(in srgb, #1677ff 25%, var(--dsw-alias-border-l2, #eef0f3)); background: color-mix(in srgb, #1677ff 2%, var(--dsw-alias-bg-layer-3, #fff)); box-shadow: 0 5px 16px rgb(31 35 41 / 5%); }
.dim-jh-provider[aria-selected="true"] { border-color: color-mix(in srgb, #1677ff 43%, var(--dsw-alias-border-l2, #dfe1e5)); color: #1677ff; background: color-mix(in srgb, #1677ff 12%, var(--dsw-alias-bg-layer-3, #fff)); box-shadow: 0 3px 12px rgb(51 112 255 / 7%); }
.dim-jh-provider:focus-visible { outline: none; border-color: color-mix(in srgb, #1677ff 72%, var(--dsw-alias-border-l2, #dfe1e5)); box-shadow: 0 0 0 1px color-mix(in srgb, #1677ff 24%, transparent) inset, 0 3px 12px rgb(51 112 255 / 7%); }

/* 图标容器：align dsh-im .dim-logo */
.dim-jh-providerIcon { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 9px; box-shadow: 0 1px 3px rgb(31 35 41 / 7%); overflow: hidden; }
.dim-jh-providerIcon img { display: block; width: 20px; height: 20px; border-radius: 2px; }
.dim-jh-providerIcon.codearts { background: white; }
.dim-jh-providerIcon.buddy { background: white; }
.dim-jh-providerIcon.workbuddy { background: white; }
.dim-jh-providerIcon.lobsterai { background: white; }
.dim-jh-providerIcon.qoder { background: white; }
/* Qoder 中国版：官方 ICO 缩图，白底容器中对比度足够。 */
.dim-jh-providerIcon.qodercn { background: white; }
.dim-jh-providerIcon.trae { background: white; }
/* Raccoon Work（商汤）：官方图标是深蓝底白色面具，白底容器中显示清晰。 */
.dim-jh-providerIcon.raccoon { background: white; }
/* MiniMax Code（中国版）：官方 logo **自带浅蓝底** #7DC6FF，白底容器中显示清晰。
   ⚠️ 本文件的样式整体是一个模板字符串 —— 注释里**不能出现反引号**（会提前终止）。 */
.dim-jh-providerIcon.minimax { background: white; }
/* MiniMax Code（国际版）：与上面中国版**共用同一个 logo**，故同样给白底容器。
   ⚠️ 每个 logoClass 都必须各自声明背景（本文件没有兜底规则），漏了会让该行容器
      没有底色、与其它行视觉不一致 —— 与 officeace 那次「注释失实且无守卫」同型。 */
.dim-jh-providerIcon.minimaxintl { background: white; }
/*
 * ZCode（智谱）：图标自带深色圆角底 + 青色 Z，本身即完整图形，
 * 故容器保持透明（加白底反而会出现一圈突兀的方块）。
 */
.dim-jh-providerIcon.zcode { background: transparent; }
/* Gemini Code Assist：内联 SVG 自带蓝紫渐变星形，白底容器中显示清晰。
   ⚠️ 本文件的样式整体是一个模板字符串 —— 注释里**不能出现反引号**（会提前终止）。 */
.dim-jh-providerIcon.gemini { background: white; }
/* Accio（阿里）：内联 SVG 自带品牌橙圆角方块 + 白色 A 字，白底容器中显示清晰。
   ⚠️ 本文件的样式整体是一个模板字符串 —— 注释里**不能出现反引号**（会提前终止）。 */
.dim-jh-providerIcon.accio { background: white; }
/* OfficeAce（华为 MaaS / 果办）：内联 SVG **自带不透明红底 + 白字 OA**，
   故容器用 transparent（与 zcode 同因：图标自己不透明，再叠白底是多余的）。
   ⚠️ 这一条是 2026-10-13 合并审计补的 —— 此前 provider-icons.js 的注释
      声称「样式见本文件」，而本文件**零命中 officeace**（注释失实且无守卫）。
   ⚠️ 本文件的样式整体是一个模板字符串 —— 注释里**不能出现反引号**（会提前终止）。 */
.dim-jh-providerIcon.officeace { background: transparent; }
/* AStudio：内联 SVG 自带不透明品牌蓝底 + 白字 A，容器白底与其它内联 SVG 家一致。 */
.dim-jh-providerIcon.astudio { background: white; }
/* 超级麦吉（Magicrew）：官方 favicon 自带紫蓝渐变圆底，本身即完整图形，
   故容器保持透明（与 zcode / officeace / codely 同因：图标自己不透明，再叠白底多余）。
   ⚠️ 本文件的样式整体是一个模板字符串 —— 注释里不能出现反引号（会提前终止）。 */
.dim-jh-providerIcon.magicrew { background: transparent; }
/* 聚合 provider：内联 SVG（三渠道汇聚），白底容器中显示清晰。
   ⚠️ 加这一条是必要的 —— 上面每家的 logoClass 都各自声明了背景，
      没有兜底规则，缺了会让聚合的图标容器**没有背景**（与其它行不一致）。 */
.dim-jh-providerIcon.aggregate { background: white; }
/* Codely（Unity 团结引擎）：内联 SVG 自带深灰圆角底 + 白色 U，本身即完整图形，
   故容器保持透明（与 zcode / officeace 同因：图标自己不透明，再叠白底是多余的）。
   ⚠️ 本文件的样式整体是一个模板字符串 —— 注释里不能出现反引号（会提前终止）。 */
.dim-jh-providerIcon.codely { background: transparent; }

/* provider 文案：align dsh-im .dim-channelCopy */
.dim-jh-providerLabel { min-width: 0; display: grid; }
.dim-jh-providerLabel strong { overflow: hidden; color: inherit; font-size: 14px; line-height: 20px; font-weight: 680; text-overflow: ellipsis; white-space: nowrap; }

/* ── 供应商级一键开关（左侧 rail 的分组 + 行尾开关）── */
/* 分组：与 rail 同为 grid，组之间留出间隔。分组只是展示分组，不改变声明顺序。 */
.dim-jh-railGroup { display: grid; gap: 8px; }
.dim-jh-railGroup + .dim-jh-railGroup { margin-top: 10px; }
.dim-jh-railGroupTitle { padding: 2px 4px 0; font-size: 12px; line-height: 16px; font-weight: 600; color: var(--dsw-alias-label-tertiary, #8f959e); }
/* 每行：只有一个选择按钮（开关已搬到页头的「供应商开关」弹窗）。
   ⚠️ 列宽仍写 minmax(0, 1fr) 而不是 1fr：grid 项的 min-width 默认 auto，
   长供应商名会把行撑宽、撑出 rail（与模型行那次「开关不可见」的缺陷同型）。
   ⚠️ **不要再留第二列**：!25 时代这里是 minmax(0, 1fr) auto 给行尾开关用；
   开关移走后那一列虽为 0 宽，**8px 的列间距却照样计入**，于是在卡片右侧
   留下一条看着像「rail 没铺满」的空白。用户报障原话：
   「去掉开关后右边有片空白，要省略让右边的账号池区域显示更宽」。 */
.dim-jh-providerRow { display: grid; grid-template-columns: minmax(0, 1fr); }
.dim-jh-providerRow .dim-jh-provider { min-width: 0; }

/* 右侧面板。
   ⚠️ 2026-10-26 用户要求「页头滚动时应该只滚动账号列表」：本容器改为
   **纵向 flex**，把「谁滚动」这件事交给子组件自己决定 ——
   .dim-jh-accountSection 内部只让 .dim-jh-accountList 滚，
   .dim-jh-aggPanel 自己滚。若本容器仍是普通块级 + overflow-y: auto，
   滚动会发生在**它**身上 ⇒ 账号管理页的标题/提示/按钮组跟着一起滚走。
   ⚠️ overflow-y: auto 保留为兜底（子项没撑开时仍能滚），正常路径下不会出现滚动条。 */
.dim-jh-panel { flex: 1; min-width: 0; display: flex; flex-direction: column; padding: 24px; overflow-y: auto; }
.dim-jh-empty { text-align: center; padding: 40px; color: var(--dsw-alias-label-tertiary, #888); }
.dim-jh-empty p { margin: 8px 0; font-size: 14px; }

/* 账号卡片 */
.dim-jh-accountCard { position: relative; border: 1px solid var(--dsw-alias-border-l2, #eef0f3); border-radius: 14px; padding: 14px 16px; margin-bottom: 10px; background: var(--dsw-alias-bg-layer-3, #fff); box-shadow: 0 2px 8px rgb(31 35 41 / 3%); transition: border-color .16s ease, box-shadow .16s ease, opacity .16s ease; }
.dim-jh-accountCard:hover { border-color: color-mix(in srgb, #1677ff 22%, var(--dsw-alias-border-l2, #eef0f3)); box-shadow: 0 5px 16px rgb(31 35 41 / 5%); }
.dim-jh-accountCard[data-enabled="false"] { opacity: 0.62; }

/* 拖拽排序 */
/* 抓取柄：独立的小区域，避免与卡片内的按钮/文本选择冲突 */
.dim-jh-dragHandle { flex: none; width: 16px; height: 20px; display: flex; align-items: center; justify-content: center; cursor: grab; color: var(--dsw-alias-label-tertiary, #9aa0a6); font-size: 12px; line-height: 1; letter-spacing: -1px; user-select: none; border-radius: 4px; }
.dim-jh-dragHandle:hover { color: var(--dsw-alias-label-secondary, #5f6672); background: rgb(31 35 41 / 5%); }
.dim-jh-dragHandle:active { cursor: grabbing; }
/* 正在被拖动的卡片：淡出以表明它已"拿起" */
.dim-jh-accountCard[data-dragging="true"] { opacity: 0.4; border-style: dashed; }
/* 拖拽悬停的目标位置：插入线。上方=插到该卡片之前，下方=之后。 */
.dim-jh-accountCard[data-dropBefore="true"]::before { content: ''; position: absolute; left: 0; right: 0; top: -6px; height: 3px; border-radius: 2px; background: #1677ff; }
.dim-jh-accountCard[data-dropAfter="true"]::after { content: ''; position: absolute; left: 0; right: 0; bottom: -6px; height: 3px; border-radius: 2px; background: #1677ff; }
/* 序号徽标：让当前优先级一目了然（顺序即自动选号优先级） */
.dim-jh-accountOrder { flex: none; min-width: 18px; padding: 0 5px; border-radius: 6px; font-size: 11px; line-height: 17px; font-weight: 600; text-align: center; color: var(--dsw-alias-label-secondary, #5f6672); background: rgb(31 35 41 / 6%); }
/* 排序提示：与按钮组同处 .dim-jh-panelHead 第二行（用户 2026-10-26
   「将按钮行合并到文案行最右侧」，随后「文案改为一行显示」）。
   ⚠️ white-space: nowrap 是这次需求的核心：提示必须单行，不随窗口变窄折行。
   折行会让第二行变成两行高、把按钮组挤到垂直居中的怪位置，观感也乱。
   ⚠️ flex: 0 1 auto 而**不是** 1 1 0：1 1 0 的基准宽是 0，nowrap 下浏览器
   仍按 min-content 撑开，结果是「要么整行、要么溢出」；0 1 auto 按内容宽
   起算，配合 min-width: 0 才能在空间不足时真正收缩。
   ⚠️ overflow: hidden + text-overflow: ellipsis 是 nowrap 的必要配套：
   没有它们，窄窗口下文本会溢出到按钮组底下互相压字。省略号是最后手段，
   完整文案挂在元素的 title 上，悬停仍可读全。
   ⚠️ 上下 margin 归零：这一行的高度由两者中较高者决定，旧值 margin: 0 0 10px
   是「独占一行」时代的遗留，留着会在按钮组下方多出一截空隙。 */
.dim-jh-orderHint { flex: 0 1 auto; min-width: 0; margin: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8f959e); }

/* 顶部一行：状态点 + 名称 + 状态标签 */
.dim-jh-accountTop { display: flex; align-items: center; gap: 8px; }
.dim-jh-accountStatus { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, #9aa0a6); }
.dim-jh-accountStatus[data-on="true"] { background: #22c55e; box-shadow: 0 0 0 3px rgb(34 197 94 / 14%); }
.dim-jh-accountName { flex: 1 1 auto; min-width: 0; overflow: hidden; font-size: 14px; line-height: 20px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); text-overflow: ellipsis; white-space: nowrap; }
.dim-jh-accountTag { flex: none; padding: 1px 8px; border-radius: 999px; font-size: 11px; line-height: 17px; font-weight: 500; }
.dim-jh-accountTag[data-tone="on"] { color: #15803d; background: rgb(34 197 94 / 12%); }
.dim-jh-accountTag[data-tone="off"] { color: var(--dsw-alias-label-tertiary, #8f959e); background: rgb(143 149 158 / 12%); }
/* 「限额中」标记：与 metaRow 的 warn 同色系，让「沉到底部的原因」一眼可辨。 */
.dim-jh-accountTag[data-tone="warn"] { color: #b45309; background: rgb(227 116 0 / 12%); }
/* 状态徽章兼作启停开关（用户 2026-10-26：把底部「停用」按钮的功能合并进来）。
   ⚠️ 只加「可点」的观感，不动 data-tone 的配色 —— 绿 / 灰两态与合并前逐字一致。 */
/* 用户反馈「不明显」（2026-10-26）：只给 cursor 不够 —— 胶囊本身太像一个
   纯展示标签。加 1px 边框，把它做成按钮的样子。
   ⚠️ 边框会让盒子长 2px（上下各 1px），故 padding 各减 1px 抵掉，
   与旁边的静态标签（如「限额中」）**保持等高** —— 同一行里两枚标签差
   2px 高度非常显眼。
   ⚠️ 先给 transparent 兜底再按 tone 上色：这样即使以后新增 tone，
   也不会有哪一态突然变高。 */
.dim-jh-accountTag[data-clickable="true"] { cursor: pointer; user-select: none; padding: 0 7px; border: 1px solid transparent; }
.dim-jh-accountTag[data-clickable="true"][data-tone="on"] { border-color: rgb(34 197 94 / 45%); }
.dim-jh-accountTag[data-clickable="true"][data-tone="off"] { border-color: rgb(143 149 158 / 40%); }
.dim-jh-accountTag[data-clickable="true"]:hover { filter: brightness(0.94); }
/* hover 时把边框也压深：只靠背景亮度变化，在浅色主题下几乎看不出。 */
.dim-jh-accountTag[data-clickable="true"][data-tone="on"]:hover { border-color: #15803d; }
.dim-jh-accountTag[data-clickable="true"][data-tone="off"]:hover { border-color: var(--dsw-alias-label-tertiary, #8f959e); }
.dim-jh-accountTag[data-clickable="true"]:active { transform: translateY(1px); }
/* 焦点圈：去掉它等于把「键盘可达」退化回只能用鼠标。 */
.dim-jh-accountTag[data-clickable="true"]:focus-visible { outline: 2px solid #1677ff; outline-offset: 1px; }

/* 元信息：键值对齐的网格 */
/* ⚠️ 2026-10-27 用户报障「面板在仅设置页时按钮与信息重叠，其次将积分和详细积分
   进行分行处理，避免越界」：本容器同时是**容器查询的锚点**
   （见下方 @container 块）。设置页里的卡片比侧栏窄一截，同一套 nowrap 布局
   在那边会溢出到右侧按钮列上。
   ⚠️ container-type: inline-size 只影响本容器的**宽度计算**（让内部按容器宽
   而不是视口宽做响应式），不改变它自身的盒模型 —— 把它挂在这里而不是整个
   .dim-jh-accountCard 上，是为了把影响面收到元信息区，不碰卡片的拖拽指示线
   （那两条 ::before / ::after 是相对卡片定位的）。 */
.dim-jh-accountMeta { display: grid; gap: 3px; margin: 8px 0 0; container-type: inline-size; }
.dim-jh-metaRow { display: grid; grid-template-columns: 52px minmax(0, 1fr); align-items: baseline; gap: 8px; }
.dim-jh-metaRow dt { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8f959e); }
.dim-jh-metaRow dd { min-width: 0; margin: 0; overflow: hidden; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #646a73); text-overflow: ellipsis; white-space: nowrap; }
.dim-jh-metaRow dd[data-tone="warn"] { color: #e37400; }
/* 积分未取到时的弱化提示。与 warn 区分：这不是异常，只是还没有数据 */
.dim-jh-metaRow dd[data-tone="muted"] { color: var(--dsw-alias-label-tertiary, #8f959e); }
.dim-jh-metaRow code { padding: 1px 5px; border-radius: 5px; background: var(--dsw-alias-bg-layer-2, #f4f5f7); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }

/* 账号卡片上的积分余额。
   覆盖 metaRow 的 overflow:hidden / nowrap —— 这里要的是横向排列的
   数值 + 次要说明，而 dd 默认样式是为单行截断文本准备的。

   ⚠️⚠️ 2026-10-27 用户报障「面板在仅设置页时按钮与信息重叠」的**根因就在
   这一行**：原先这里是 display: flex + overflow: visible，而父规则
   .dim-jh-metaRow dd 带 white-space: nowrap ⇒ 那一整串
   「永久 1670.57 · 长期 500 · 临期 200」被当成**一个不可断行的整体**按内容宽
   撑开；dd 的宽度又被 minmax(0, 1fr) 钉住 ⇒ 内容直接画到右侧按钮列上
   （设置页卡片窄，症状最明显；侧栏宽，看不出来）。

   ★ 用户 2026-10-27 定稿方案：「详细积分也别换行了，就继续在后面，越界部分
   使用 ... 替代，悬浮可看详情」。故这里**不换行**（nowrap），越界走省略号，
   完整内容挂在 title 上（见 CreditBalanceRow 的 title 计算）。

   ⚠️⚠️ **不能保留 display: flex**：text-overflow: ellipsis 在 flex 容器上
   **不生效**（它只作用于块级容器的行内内容），实测表现为「flex 子项各自
   nowrap 撑开、整行照样溢出」。故改成 block，子元素回到 inline 流。
   ⚠️ 子元素之间的间距不再由 flex gap 提供，改由下面那条
   > * + * 的 margin-left 给 —— 否则改成 inline 后各段会黏成一团。
   ⚠️ 父规则已有的 text-overflow / overflow 不再被覆盖（这里刻意**不写**
   overflow: visible），省略号才能生效。 */
.dim-jh-metaRow dd.dim-jh-creditValue { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* inline 化：让主数值、分桶、独立池、资源包计数排在同一条不可断行的行内流里，
   省略号才有「一个整体被截断」的语义。 */
.dim-jh-metaRow dd.dim-jh-creditValue > * { display: inline; }
/* 段间间距（替代原 flex gap: 6px）。用相邻兄弟选择器，首段不带左边距。 */
.dim-jh-metaRow dd.dim-jh-creditValue > * + * { margin-left: 6px; }
.dim-jh-creditTotal { font-size: 13px; font-weight: 600; color: #1677ff; font-variant-numeric: tabular-nums; }
.dim-jh-creditPackages { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8f959e); }
/* 分桶说明（三档带色）：永久绿 / 长期黄 / 临期红 + 倒计时（用户 2026-10-12）。
   ⚠️ 颜色语义与 credit-expiry.js 的 expirySplitParts 一一对应：
     permanent（服务端没给到期时间，真·永久）→ ok 绿
     longTerm（有到期时间但还早）              → warn 黄
     expiring（窗口内，再不用就作废）          → error 红
   ⚠️ 与 .dim-jh-badgeNotePart 同一套 tone 变量（深浅主题各自有定义）。 */
.dim-jh-creditPoolPart { font-size: 11px; font-variant-numeric: tabular-nums; }
.dim-jh-creditPoolPart[data-tone="ok"] { color: var(--dsw-alias-state-success-primary, #15803d); }
.dim-jh-creditPoolPart[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary, #b45309); }
.dim-jh-creditPoolPart[data-tone="error"] { color: var(--dsw-alias-state-error-primary, #d93025); }
.dim-jh-creditPoolPart[data-tone="muted"] { color: var(--dsw-alias-label-tertiary, #8f959e); }
.dim-jh-creditPoolSep { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8f959e); }
/* 已失效额度：弱化的橙色提示，与主数值的蓝色明确区分 */
.dim-jh-creditExpired { font-size: 11px; color: #b45309; }
/* 独立池（AStudio 星火积分等）：与上方三档分桶并列的事实标注。
   用中性灰而**不是** warn 橙 —— 它不是「快过期」的告警，而是「这笔钱不能混用」
   的说明；用橙色会与临期档抢注意力。 */
.dim-jh-creditExclusive { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8f959e); }

/* 限额重置徽章行 */
.dim-jh-rateLimits { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px; }
.dim-jh-rateLimitsLabel { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8f959e); }

/* 操作按钮：横向一行，右对齐。
   ⚠️ flex-wrap: nowrap 是**有意**的（2026-10-26 之前就是），理由是账号卡片
   在侧栏里足够宽、行内按钮排成一条更好看。但它在**窄容器**（仅设置页那种
   宽度）里会让按钮组溢出卡片右边缘 —— 与积分文字重叠的那个报障同源。
   ⇒ 窄容器改由下方 @container 块覆盖成 wrap，宽容器逐字不变。
   ⚠️ 别直接把这里改成 wrap：宽容器下 nowrap + flex-end 是「按钮贴右、
   不换行」的既定观感，改了会波及侧栏（用户明确说那边不用处理）。 */
.dim-jh-accountActions { display: flex; flex-direction: row; flex-wrap: nowrap; justify-content: flex-end; gap: 8px; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l2, #f0f1f3); }

/* 带操作按钮的积分行：第三列 auto 让按钮贴最右（用户报障「底部那排按钮
   别单独占一行」）。⚠️ 只有传了 actions 的调用方才带这个类名 —— 其余
   provider 的 .dim-jh-metaRow 仍是两列，逐字不变。 */
.dim-jh-metaRow--actions { grid-template-columns: 52px minmax(0, 1fr) auto; }
/* 挂进积分行后就不再需要「独立成行」的那些装饰（上边距 / 分隔线），
   否则会在按钮上方多出一条线并撑高行距。
   align-self: center 覆盖 metaRow 的 baseline —— 按钮是 flex 容器，
   按基线对齐会贴到文字基线下方。 */
.dim-jh-metaRow--actions .dim-jh-accountActions { margin-top: 0; padding-top: 0; border-top: 0; align-self: center; }

/* ── 窄容器（仅设置页那种宽度）：积分行改成两行，按钮组独占第二行 ──
   ⚠️⚠️ 2026-10-27 用户报障「面板在仅设置页时按钮与信息重叠」的**第二处根因**：
   三列 grid（52px | minmax(0,1fr) | auto）里按钮列是 auto ⇒ 它按内容宽
   吃走固定宽度，剩下给积分列的空间在设置页里只有 ~200px；而积分列里塞着
   主数值 + 三档分桶 + 独立池 + 资源包计数四五段文字。**光靠换行还不够**：
   换行只是把溢出从横向变成纵向，行高会涨到三四行，按钮仍与文字挨在同一行。

   正解是**结构换行**：容器窄时把第三列（按钮组）下移一行独占整宽 ——
   标签与积分占第一行，按钮组占第二行右对齐。侧栏宽度足够，不触发本块，
   观感与改动前逐字一致（用户明说「仅在侧栏显示的话，宽度足够，可以考虑
   不用处理」）。

   ⚠️ 阈值 420px 的由来：设置页里的卡片内容宽实测约 300–380px（弹层左右
   各留白 + rail 不出现），侧栏里约 520–700px。取 420 落在两档之间，两侧
   都有余量 —— 不要为了「更保险」往上调，那会把侧栏也拖进两行布局。
   ⚠️ 必须用 @container 而不是 @media：媒体查询看的是**视口**宽，而同一
   个组件在两处入口的宽度差来自**容器**（设置弹层 vs 中央面板），视口完全
   可能一样宽 —— 用 media 会得到「两处同时变/同时不变」的错误行为。
   ⚠️ 容器查询锚点是上面 .dim-jh-accountMeta 的 container-type: inline-size；
   删掉那一行，本块**整段静默失效**（浏览器不会报错，只是不匹配）。 */
@container (max-width: 420px) {
  /* 标签与积分占第一行，按钮组换到第二行并贴右。
     ⚠️ grid-template-areas 比数格子稳：三列变两行时不用重算列宽。
     ⚠️ align-items: start 覆盖基础规则的 baseline —— 窄容器下 dt / dd /
     按钮组各自独占一格，baseline 会让空标签把行高撑歪。 */
  .dim-jh-metaRow--actions {
    grid-template-columns: 52px minmax(0, 1fr);
    grid-template-areas:
      "label value"
      "actions actions";
    row-gap: 6px;
    align-items: start;
  }
  .dim-jh-metaRow--actions > dt { grid-area: label; }
  .dim-jh-metaRow--actions > dd.dim-jh-creditValue { grid-area: value; }
  /* ⚠️ 这里**不再**让主数值独占一行（用户 2026-10-27 定稿：「详细积分也别
     换行了，就继续在后面，越界部分使用 ... 替代」）。积分行本身已是
     nowrap + ellipsis 的**单行**，窄容器下由省略号收尾、悬浮看全 ——
     再让它占整行只会把行数从 1 变成 2，与用户要求相反。 */
  /* ⚠️ 按钮组在第一列起、跨两列：它现在是整行，justify-content: flex-end
     让按钮贴右，与宽容器下的视觉位置一致（用户不会觉得按钮「跑到左边」）。 */
  .dim-jh-metaRow--actions > .dim-jh-accountActions {
    grid-area: actions;
    grid-column: 1 / -1;
    justify-content: flex-end;
    align-self: start;
    /* ⚠️ 窄容器下**允许换行**：这一行有 5～6 个按钮（新手任务 / 重测 / 重置 /
       测试 / 代理 / 令牌 / 删除），整行宽度在 300px 级容器里放不下 ——
       nowrap 会把最后一个（删除）推出卡片外，用户看不到也点不到。
       宽容器仍是 nowrap（见基础规则），观感不变。 */
    flex-wrap: wrap;
    /* 与上方积分行拉开一点距离，否则按钮紧贴积分文字。 */
    margin-top: 2px;
  }
}

/* 按钮：align dsh-im .dim-deliveryButton */
.dim-jh-btn { font-size: 12px; line-height: 18px; padding: 4px 12px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; background: var(--dsw-alias-bg-layer-3, #fff); cursor: pointer; color: var(--dsw-alias-label-primary, #1f2329); white-space: nowrap; transition: border-color .15s ease, background .15s ease, color .15s ease; }
.dim-jh-btn:hover:not(:disabled) { border-color: color-mix(in srgb, #1677ff 40%, var(--dsw-alias-border-l2, #dfe1e5)); color: #1677ff; background: color-mix(in srgb, #1677ff 6%, var(--dsw-alias-bg-layer-3, #fff)); }
.dim-jh-btn[data-kind="primary"] { background: #1677ff; color: #fff; border-color: #1677ff; }
.dim-jh-btn[data-kind="primary"]:hover:not(:disabled) { background: #0f5fce; border-color: #0f5fce; color: #fff; }
.dim-jh-btn[data-kind="danger"] { color: #d93025; border-color: color-mix(in srgb, #d93025 35%, var(--dsw-alias-border-l2, #dfe1e5)); }
.dim-jh-btn[data-kind="danger"]:hover:not(:disabled) { color: #b3261e; border-color: #d93025; background: rgb(217 48 37 / 6%); }
.dim-jh-btn:disabled { opacity: 0.5; cursor: default; }


/* 纯图标按钮（如「领取新手任务」的礼物图标）。
   ⚠️ 存在的理由：.dim-jh-accountActions 是 flex-wrap: nowrap，
   行内已有 5 个文字按钮，再加一个「领取新手任务」会被挤出容器（用户报障）。
   故把它压成等宽等高的方形图标按钮，文案移到 title tooltip。
   正方形靠固定 padding（左右 = 上下）实现，不依赖内容宽度。
   ⚠️ 本文件整体是一个 JS 模板字符串，注释里**不能出现反引号** —— 会提前
   终止字符串（本次构建失败的成因）。 */
.dim-jh-iconBtn { display: inline-flex; align-items: center; justify-content: center; padding: 4px 8px; min-width: 26px; }
.dim-jh-iconBtn svg { display: block; }
/* 图标 + 短文字（如「模型列表」的列表图标 + 「模型」二字）。
   ⚠️ 与 .dim-jh-iconBtn 的区别：那个是纯图标（正方形，文案全在 title 里），
   这个是「图标打头、文字收尾」，横向排列且保留 6px 间距 —— 没有这条间距，
   svg 会紧贴文字，看着像一个怪字符。
   ⚠️ 本文件整体是 JS 模板字符串，注释里绝不能出现反引号（本行因此红过多次）。 */
.dim-jh-iconTextBtn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
.dim-jh-iconTextBtn svg { display: block; flex: none; }
/* 加载态：图标自转（「刷新积分」换图标后没有文字可换，只能靠动效表达进行中）。
   ⚠️ 必须尊重 prefers-reduced-motion —— 前庭功能敏感的用户会被旋转动画伤到，
   这是无障碍硬要求，不是可选项。降级后仍有 .dim-jh-btn:disabled 的 .5 透明度可辨识。
   ⚠️ 两条选择器缺一不可：纯图标按钮（刷新积分 / 新建账号 / 删除）用
   .dim-jh-iconBtn，而「图标 + 短文字」按钮（模型、永久积分）用
   .dim-jh-iconTextBtn —— 只写前者时，后者的图标在加载态**不会转**，
   用户眼神落在图标上就以为没点上。
   ⚠️ 本文件整体是 JS 模板字符串，注释里绝不能出现反引号（本行就因此红过一次）。 */
@keyframes dim-jh-spin { to { transform: rotate(360deg); } }
.dim-jh-iconBtn[data-loading="true"] svg,
.dim-jh-iconTextBtn[data-loading="true"] svg { animation: dim-jh-spin .9s linear infinite; }
@media (prefers-reduced-motion: reduce) {
  .dim-jh-iconBtn[data-loading="true"] svg,
  .dim-jh-iconTextBtn[data-loading="true"] svg { animation: none; }
}

/* 限流 TTL 徽章 */
.dim-jh-ttlBadge { display: inline-block; padding: 1px 8px; border-radius: 999px; background: rgb(227 116 0 / 10%); color: #b45309; font-size: 11px; line-height: 17px; font-weight: 500; }

/* 面板标题区：标题独占一行，操作按钮另起一行。
   此前用单行 space-between 把标题与 5 个按钮挤在一起，面板一窄就溢出被裁掉。

   ⚠️⚠️ **刻意不写 align-items（= 默认 stretch）**（2026-10-21 合并审计的**根因修法**）。

   原先这里是 align-items: flex-start ⇒ panelHead 是 column flex、交叉轴是**水平**
   ⇒ 每个子项按 fit-content 收缩到 **max-content**。后果是**一整类**「窄条/贴左」缺陷，
   而不只是账号卡片那一格：

   - .dim-jh-accountList：单账号时卡片缩成 ~257px 窄条（多账号时被那句约 1200px 长的
     排序提示撑宽，所以只有单账号暴露）—— 这是用户真机看到的那一格；
   - .dim-jh-probeNotice / .dim-jh-empty / 补偿卡片：**短文案**时渲染成带边框背景的
     **窄药丸**；其中 .dim-jh-empty 的加载文案 正在读取账号列表… 还带
     text-align: center ⇒ 每次开面板都看到一句**贴左**的加载提示（最常被看到的一格）。

   ⇒ 去掉 align-items 让全部子项 stretch 到面板宽，**一次修好账号列表 + 7 个兄弟**。

   ⚠️ **本次唯一的可见行为变化**：.dim-jh-headerActions 有 justify-content: center，
   而它此前是 max-content 宽（没有空余可分配 ⇒ 居中不生效、观感贴左）；现在它整宽 ⇒
   按钮总宽小于面板宽时**真的居中**（这正是它声明 center 的本意）。
   ⚠️ 2026-10-26 起改为贴右（见下方 .dim-jh-headerActions 段落），本段只保留
   「不要改回 flex-start」这条仍然成立的结论。

   ⚠️ **不要**把它改回 flex-start：那会同时复发上面那一整类缺陷
   （而下面 .dim-jh-accountList 那两条规则只能兜住账号列表这一格）。

   ⚠️ 2026-10-26 由 column 改为 **row + wrap**（用户要求「将按钮行合并到
   文案行最右侧」）。布局契约（同日第三次改后，账号列表已移出本容器）：
     第一行 = .dim-jh-panelTitle（flex: 1 0 100% 强制独占）
     第二行起 = 各条 .dim-jh-probeNotice（flex: 1 0 100% 各占一整行，见下方规则）
     最后一行 = .dim-jh-orderHint（flex: 0 1 auto）+ .dim-jh-headerActions
              （margin-left: auto 贴右）
   ⚠️ 账号列表**不再**是本容器的子项（它挪到 .dim-jh-accountSection 下，
   由那里负责滚动）—— 所以本容器里没有「第三行起 = accountList」那条了。
   ⚠️ 三个子项的 flex-basis 是**互相依赖**的：任何一项改成 auto，那一行就会
   与相邻项挤在一起。改布局时三处一起看，别只改一处。
   ⚠️ align-items: center 让「提示 + 按钮组」那一行里两种高度的元素垂直居中对齐。 */
.dim-jh-panelHead { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 16px; }
/* 标题独占一行（用户 2026-10-26「将按钮行合并到文案行最右侧」的配套）。
   ⚠️ flex-basis: 100% 是唯一能让标题单独占一行的写法：wrap + basis 100%
   会把后续兄弟挤到下一行，而**不必**给 panelHead 换 flex-direction。 */
.dim-jh-panelHead > .dim-jh-panelTitle { flex: 1 0 100%; }
/* 面板级状态提示（探测结果 / 锁定状态 / 领取结果 / 新手任务 / 登录链接 / 补偿卡）。
   ⚠️ 2026-10-26 用户要求「信息应该在按钮行上方行，而不是下方行」：这些提示
   已从 section 直接子节点搬进 panelHead、排在按钮组之前，**必须各占一整行**。
   缺了 flex: 1 0 100% 这条，它们是 flex: 0 1 auto 的，会与按钮组挤在同一行 ——
   正是「补偿积分已领取」被挤到按钮组右侧那个报障的形态。
   ⚠️ margin-bottom 归零：行间距由 panelHead 的 gap: 10px 统一给，
   两套间距并存会让提示与按钮行之间多出一截。
   ⚠️ 必须是**直接子级**选择器：若哪天有人给这些提示包一层容器，本规则
   与下面那两条 tone 规则会一起失效（它们全部挂在直接子级上）。 */
.dim-jh-panelHead > .dim-jh-probeNotice { flex: 1 0 100%; margin-bottom: 0; }
/* 账号管理页：整页是一个纵向 flex，**只有账号列表滚动**（用户 2026-10-26
   「页头滚动时应该只滚动账号列表」）。
   布局契约：
     第一行 .dim-jh-panelHead   —— flex: none，页头恒在顶部，不参与滚动
     第二行 .dim-jh-accountList —— flex: 1 1 auto + min-height: 0 + overflow-y: auto
                                    （以及「正在读取 / 空态」那几个 .dim-jh-empty）
   ⚠️ min-height: 0 是必需的：flex 子项默认 min-height: auto，内容多时它会被
   撑到内容高而不是收缩，于是滚动条又跑回 .dim-jh-panel 上，页头照旧跟着滚。
   ⚠️ 非列表态（loading / error / 空账号）用的是 .dim-jh-empty，同样给 flex: 1 1 auto
   让它在剩余空间里居中，而不是把 section 撑出滚动。 */
.dim-jh-accountSection { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.dim-jh-accountSection > .dim-jh-panelHead { flex: none; }
.dim-jh-accountSection > .dim-jh-empty { flex: 1 1 auto; min-height: 0; overflow-y: auto; }

/* 账号列表容器：宽度与账号数量无关，并且**它就是滚动容器**
   （用户 2026-10-26「页头滚动时应该只滚动账号列表」）。
   ⚠️ 2026-10-26 第二次改：本容器此前是 .dim-jh-panelHead 的子项
   （那时用 flex: 1 0 100% 靠 wrap 强制独占一行）。现在它在
   .dim-jh-accountSection（**纵向** flex）里，那套 basis: 100% 的写法
   在纵向主轴下等于「高度取满容器且不许收缩」⇒ 内容多时直接溢出、
   滚动条跑回 .dim-jh-panel 上，页头又开始跟着滚。
   正确写法是 flex: 1 1 auto + min-height: 0 + overflow-y: auto。
   ⚠️ 根因已在上面 .dim-jh-panelHead 修掉（去掉 align-items: flex-start），
      故 align-self 现在是**冗余兜底** —— 保留是刻意的：万一有人把
      align-items: flex-start 改回来，账号列表（用户唯一明确报障过的那一格）仍正确。
   ⚠️ min-width: 0 在纵向 flex 的**交叉轴**方向是惰性声明，保留只为将来
      本容器改成横向排布时承重；**不要**把它当成「账号列表靠它才整宽」。 */
.dim-jh-accountList { flex: 1 1 auto; align-self: stretch; min-width: 0; min-height: 0; overflow-y: auto; }
.dim-jh-accountList > .dim-jh-accountCard { width: 100%; box-sizing: border-box; }
.dim-jh-panelTitle { margin: 0; font-size: 16px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); }

/* 操作按钮组。**两类页头共用同一个类名**，对齐方式不同：
   ① 全局页头（.dim-jh-header 内）：供应商 / 一键签到 / 备份 / 恢复 / 网关 /
      Token 用量 / 渠道原生搜索 —— **居中**；
   ② 账号管理页头（.dim-jh-panelHead 内）：模型列表 / 刷新 / 一键领取积分 /
      重测所有 / 重置所有 / 新建账号 —— **贴右**（与排序提示同一行）。
   ⚠️ 故基础规则写**居中**，贴右只在 .dim-jh-panelHead 的直接子级选择器下覆盖。
   2026-10-26 我先直接把基础规则改成 flex-end，结果把全局页头那排按钮也
   一起拖到了最右（用户截图报障「供应商…渠道原生搜索按钮行应该保持居中」）——
   共用类名改默认值会波及另一处，这是本文件最常犯的一类错。
   ⚠️ 允许换行：按钮数量随 provider / 状态变化，固定单行在窄窗口下必然溢出。
   ⚠️ 本文件 CSS 装在**模板字符串**里 —— 注释内绝不能出现反引号，否则提前
   闭合、esbuild 报 "Expected ; but found ..." 并把指针指到注释行（2026-10-07
   在同一天内踩了两次，故把这条写进最常改的页头段落）。
   ⚠️ 页头左侧标题块（.dim-jh-brand / .dim-jh-brandName）已删除（2026-10-07）。
   ⚠️ 全局页头的对齐历经三次调整，**当前是居中**：
   ① 有标题时：space-between 靠标题把按钮推到右边；
   ② 标题删除后：改 flex: 1 + 默认左对齐（贴左，注释原话「保持原观感」）；
   ③ 2026-10-14：用户要求改**居中**（justify-content: center）——
      按钮组是页头唯一内容，居中让整排在视觉上更平衡，也不与下方内容左边界打架。
   ⚠️ 居中与 flex: 1 1 auto 并存是**必需的**：去掉 flex 后容器宽度收缩到内容宽，
   justify-content 就没有可分配的空间、视觉上退回贴左。 */
.dim-jh-headerActions { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 8px; flex: 1 1 auto; min-width: 0; }

/* 账号管理页头里的那一组**贴右**（用户 2026-10-26「将按钮行合并到文案行最右侧」）：
   margin-left: auto 是主手段（排序提示存在时把它顶到最右），
   justify-content: flex-end 是兜底（提示为 null、本组独占一行时同样贴右）。
   ⚠️ 两条缺一不可：只留 flex-end 时提示会与按钮组之间留一大段空白；
   只留 auto 时「账号 ≤ 1、提示不渲染」那种状态下按钮组会贴左。
   ⚠️ flex: 1 1 auto 在这里的作用是让本组吃掉第二行的剩余宽度，
   auto 外边距才有效（若本组收缩到内容宽，auto 外边距没有可分配空间，
   视觉上会贴着提示末尾而不是贴右）。 */
.dim-jh-panelHead > .dim-jh-headerActions { justify-content: flex-end; margin-left: auto; }

/* 上一次「重测 / 重置」的结果提示 */
.dim-jh-probeNotice { margin-bottom: 12px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2, #eef0f3); background: var(--dsw-alias-bg-layer-2, #f7f8fa); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #646a73); }
.dim-jh-probeNotice[data-tone="ok"] { border-color: color-mix(in srgb, #22c55e 35%, var(--dsw-alias-border-l2, #eef0f3)); background: rgb(34 197 94 / 8%); color: #15803d; }
.dim-jh-probeNotice[data-tone="warn"] { border-color: color-mix(in srgb, #e37400 35%, var(--dsw-alias-border-l2, #eef0f3)); background: rgb(227 116 0 / 8%); color: #b45309; }
.dim-jh-probeNotice[data-tone="error"] { border-color: color-mix(in srgb, #d93025 35%, var(--dsw-alias-border-l2, #eef0f3)); background: rgb(217 48 37 / 8%); color: #b3261e; }
.dim-jh-probeDetails { margin: 6px 0 0; padding-left: 18px; display: grid; gap: 2px; }
.dim-jh-probeDetails li { font-size: 12px; line-height: 18px; }

/* 全局统计带（Jet Hub 页头下方：tab 按钮组与「已打开 / 已关闭」列表之间）。
   ⚠️ 5 格全部是**可跨 provider 累加的计数**：账号数、供应商开关数、过期/临期账号数。
      刻意**不放**积分余额与累计已用 —— 各家"积分"单位不同，跨 provider 求和没有意义
      （与一键签到汇总「必须按单位分列」同一条红线）。余额类读数只出现在单 provider 面板里。 */
.dim-jh-globalStats { flex: none; display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 24px 0; }
.dim-jh-globalStat { flex: 1 1 96px; min-width: 96px; display: flex; flex-direction: column; gap: 2px; padding: 8px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2, #eef0f3); border-left-width: 3px; background: var(--dsw-alias-bg-layer-2, #f7f8fa); }
.dim-jh-globalStat[data-tone="info"] { border-left-color: #3370ff; }
.dim-jh-globalStat[data-tone="ok"] { border-left-color: #22c55e; }
.dim-jh-globalStat[data-tone="warn"] { border-left-color: #e37400; }
.dim-jh-globalStat[data-tone="danger"] { border-left-color: #d93025; }
.dim-jh-globalStat[data-tone="muted"] { border-left-color: #8f959e; }
/* 字号取法：标签比正文小一档（12px vs 13px）、数值大两档（20px）。
   目的是让统计带读起来是「同一层级的摘要」而不是新的一层，避免与下方账号卡片标题（16px）打架。 */
.dim-jh-globalStatLabel { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8f959e); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dim-jh-globalStatValue { font-size: 20px; line-height: 26px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); font-variant-numeric: tabular-nums; }
.dim-jh-globalStatUnit { margin-left: 2px; font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-tertiary, #8f959e); }
/* 窄屏（手机 / 侧栏收窄）：数值降一档；格子最小 84px 靠 wrap 自动折成两列，不出现横向溢出。 */
@media (max-width: 720px) {
  .dim-jh-globalStats { gap: 6px; margin: 8px 12px 0; }
  .dim-jh-globalStat { flex: 1 1 84px; min-width: 84px; padding: 6px 10px; }
  .dim-jh-globalStatLabel { font-size: 11px; line-height: 16px; }
  .dim-jh-globalStatValue { font-size: 16px; line-height: 22px; }
}
/* 授权链接 + 复制按钮同行。链接不设 min-width: 0 时，300+ 字符的 URL 会把按钮顶出可视区。 */
.dim-jh-loginLinkRow { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 6px; }
.dim-jh-loginLink { flex: 1 1 240px; min-width: 0; color: var(--dsw-alias-link); word-break: break-all; }
/* 复制失败时把链接变成一次点击全选，用户能直接 Ctrl+C。 */
.dim-jh-loginLinkRow[data-copy-state="failed"] .dim-jh-loginLink { user-select: all; }

/* 登录弹窗 */
.dim-jh-loginOverlay { position: fixed; inset: 0; background: rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.dim-jh-loginDialog { background: var(--dsw-alias-bg-layer-1, #fff); border-radius: 12px; padding: 24px; min-width: 320px; box-shadow: 0 8px 32px rgba(0,0,0,0.15); }
.dim-jh-loginDialog h3 { margin: 0 0 8px; font-size: 16px; }
.dim-jh-loginDialog p { font-size: 13px; color: var(--dsw-alias-label-secondary, #555); margin: 0 0 16px; }
.dim-jh-loginActions { display: flex; gap: 8px; justify-content: flex-end; }

/* ── 模型列表弹窗（「显示列表」） ── */
/* 复用登录弹窗的遮罩模式：fixed 覆盖全屏，z-index 高于设置页内容。
   3000 高于 .dim-jh-loginOverlay 的 1000，保证两个弹窗同时存在时模型列表在上。 */
.dim-jh-modalOverlay { position: fixed; inset: 0; z-index: 3000; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(0,0,0,0.32); }
/* ⚠️ .dim-jh-modalOverlay--top（顶部锚定修饰类）已于 2026-10-26 **整体删除**，
   全仓已无任何 className 用到它。它当初存在的理由（2026-10-07 真实报障
   「输入文字后整个弹框的位置会发生改变，有点突兀」）并没有消失：
   align-items: center 会把「弹窗高度变化」直接翻译成「整体位置跳动」——
   模型列表弹窗搜索后从 32 项变 3 项，实测 top 从 4px 跳到 187px。
   当时的解法是把上边缘钉死在顶部（flex-start + 8vh）。
   现在用户要求**所有弹窗一律居中**（视觉一致性优先），故改为
   「居中 + 给弹窗兜一个 min-height」，把高度变化区间压到 (min-height, max-height]。
   见下方 .dim-jh-modal 的 min-height 注释。
   ⚠️ 若日后仍有「弹窗上下跳」的报障，正解是给**列表型**弹窗固定 height，
   而不是把本修饰类加回来（加回来就等于又一次违反「全部居中」）。
   ⚠️ 本文件整体是 JS 模板字符串，注释里**不能出现反引号**（会提前终止字符串）。 */
/* 弹窗本体：max-height 按视口封顶，min-height 兜住居中时的跳动幅度。
   min-height 取 300px 的由来：模型列表 3 项时内容高约 260px，兜到 300 后
   与「32 项撑满 640px」的位移差从约 380px 降到约 340px —— 仍有位移，但
   视觉上不再像「跳了一下」；再往上兜（如 480px）会让表单型小弹窗空出一大片。 */
.dim-jh-modal { display: flex; flex-direction: column; width: min(560px, 100%); min-height: min(300px, calc(100vh - 48px)); max-height: min(640px, calc(100vh - 48px)); padding: 20px 22px; border-radius: 14px; background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: 0 16px 48px rgba(0,0,0,0.22); }
/* Token 用量弹窗：比通用弹窗宽一档（960px），高度上限 700px（2026-10-26 用户指定）。
   ⚠️ 这里同时把 min-height 压回 0：通用 .dim-jh-modal 的 min-height 是 300px
   （为居中时兜住「列表变短导致整体跳动」），但本弹窗的内容永远够高，
   那条兜底只会让它下边框多空出一截 —— 本弹窗要的是「上下收紧」。
   max-height 取 700px：比通用 640px 高、比原 820px 矮；1080p 下遮罩内边距
   24px×2 之后仍有余量，汇总区 3 张卡片 + 明细表十余行的常见形态不出滚动条。 */
.dim-jh-modal--ledger { width: min(960px, 100%); min-height: 0; max-height: min(700px, calc(100vh - 48px)); }
.dim-jh-modalHead { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dim-jh-modalTitle { min-width: 0; display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; font-size: 15px; line-height: 22px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); }
.dim-jh-modalSubtitle { overflow: hidden; font-size: 12px; line-height: 18px; font-weight: 400; color: var(--dsw-alias-label-tertiary, #8f959e); text-overflow: ellipsis; white-space: nowrap; }
/* 头部右侧按钮组与标题里的计数徽标 */
.dim-jh-modelPanelActions { flex: none; display: flex; align-items: center; gap: 8px; }
.dim-jh-modelPanelCount { font-size: 12px; line-height: 18px; font-weight: 400; color: var(--dsw-alias-label-tertiary, #8f959e); }
.dim-jh-modalHint { flex: none; margin: 10px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8f959e); }
/* 弹窗提示里的强调词：danger=危险操作（覆盖/不可撤销），warn=警示（妥善保管） */
.dim-jh-emph-danger { color: #b3261e; font-weight: 600; }
.dim-jh-emph-warn { color: #b45309; font-weight: 600; }
.dim-jh-modal .dim-jh-probeNotice { flex: none; margin: 10px 0 0; }
/* .dim-jh-modelBulkBar（模型列表顶部「打开全部 / 关闭全部」工具条）已于
   2026-10-26 随按钮一起删除。分组按钮走 .dim-jh-modelGroupBtn，不受影响。
   ⚠️ 本条注释里**不能**出现反引号：STYLES 整段是模板字符串，写一个就提前闭合。 */
/* 搜索 + 状态筛选条（Cline 目录近 500 条，没有它就只能一页页翻）。
   允许换行：窄面板下搜索框与三个状态按钮放不进一行。 */
.dim-jh-modelFilterBar { flex: none; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
/* 搜索框占据剩余宽度，最小 140px —— 再窄就输不下有意义的模型名片段。 */
.dim-jh-modelSearch { flex: 1 1 140px; min-width: 140px; width: auto; }
.dim-jh-modelStatusFilter { flex: none; display: flex; align-items: center; gap: 6px; }
/* 选中的筛选按钮高亮：三个按钮外观一致时用户看不出当前筛的是什么。 */
.dim-jh-modelStatusFilter .dim-jh-btn[data-active="true"] { border-color: #1677ff; color: #1677ff; background: color-mix(in srgb, #1677ff 10%, var(--dsw-alias-bg-layer-3, #fff)); font-weight: 600; }
/* 列表区独立滚动：头部与说明固定，模型多时只滚中间 */
/* ⚠️ overflow-x: hidden 是**兜底**，不是主修复（主修复见下方 grid 的 minmax）。
   没有它时，任何一行的偶然溢出都会让整个弹窗出现横向滚动条，而横向滚动条会把
   每一行的**开关**一起推出可视区 —— 用户报障「开关在最右边，要横向滑动才看得到」。
   ⚠️ 本文件整体是 JS 模板字符串，注释里**不能出现反引号**（会提前终止字符串，
   本次就因此构建失败过一次）—— 说明 CSS 属性时一律不加反引号。 */
.dim-jh-modalBody { flex: 1 1 auto; min-height: 0; margin-top: 10px; overflow-y: auto; overflow-x: hidden; }
.dim-jh-modalBody .dim-jh-empty { padding: 24px; }

/* 每行一个模型：左侧名称 + id，右侧开关 */
/* ⚠️ grid-template-columns: minmax(0, 1fr) 是**必须的**，不能省。
   单列 grid 的列宽默认是 auto，而 grid 项的 min-width 默认也是 auto ——
   两者叠加会让列宽按**最宽内容**撑开，于是长 id 把行推宽、行末的开关被挤出
   弹窗右边缘（真实缺陷：Cline 有 300 个 id 超过 20 字符，几乎每行都中招，
   表现为「开关在最后，需要横向滑动，我看不到」）。
   minmax(0, 1fr) 把列的最小宽度显式压到 0，行才会跟着容器收缩。 */
.dim-jh-modelList { display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; }
/* 行本身是 grid 项也是 flex 容器，两处都需要 min-width: 0 才允许收缩。 */
.dim-jh-modelRow { display: flex; align-items: center; gap: 12px; min-width: 0; padding: 7px 8px; border-radius: 8px; cursor: pointer; transition: background .15s ease; }
.dim-jh-modelRow:hover { background: var(--dsw-alias-bg-layer-2, #f7f8fa); }
/* 已关闭的模型整体降透明度：一眼能看出哪些被隐藏了 */
.dim-jh-modelRow[data-disabled="true"] .dim-jh-modelInfo { opacity: 0.5; }

/* 行首的供应商图标（2026-10-26，用户要求「所有页面供应商和模型左侧 + 图标」）。
   ⚠️ .dim-jh-providerIcon 的基类尺寸是 30px —— 那是给左栏 rail 的 48px 高按钮
   用的；模型行 padding 只有 7px，直接套会顶高整行、把行距撑开。
   故这里用**后代选择器**就地收窄，不动基类（rail 与两处弹窗共用同一枚 class）。
   flex: none 是必需的：同行的 .dim-jh-modelInfo 是 flex: 1 1 auto，
   图标若参与收缩会被长模型名挤成一条线。
   阴影也去掉 —— 22px 的方块配 30px 的那层投影会显脏。 */
.dim-jh-modelRow > .dim-jh-providerIcon { flex: none; width: 22px; height: 22px; border-radius: 6px; box-shadow: none; }
.dim-jh-modelRow > .dim-jh-providerIcon img { width: 15px; height: 15px; }
/* 已关闭的模型连图标一起降透明度：只淡文字会让图标显得「亮着但不可用」。 */
.dim-jh-modelRow[data-disabled="true"] > .dim-jh-providerIcon { opacity: 0.5; }

/* 「供应商开关」弹窗的行拖拽（2026-10-06）。
   视觉语言与账号卡片（.dim-jh-accountCard[data-dragging] 系）完全一致：
   源行淡出虚线、落点行画插入线。
   ⚠️ 这几行**必须带 .dim-jh-modal 作用域前缀**：.dim-jh-modelRow 是共享类名，
   ModelToggle（模型列表弹窗）与 GatewayPanel 也在用它们。那些行不设
   data-dropBefore/After，伪元素无 content 故不渲染，但给它们挂 position:relative
   仍是作用域过宽 —— 将来任一处加 absolute 子元素都会莫名受影响。
   与既有的 .dim-jh-modal .dim-jh-probeNotice 同一收窄惯例。
   ⚠️⚠️ 本文件整体是一个 JS **模板字符串**：注释里**禁止**出现反引号，
   否则会提前终止字符串、把后面的 CSS 当成代码解析（实测报 TS2304）。 */
.dim-jh-modal .dim-jh-modelRow { position: relative; }
.dim-jh-modal .dim-jh-modelRow[data-dragging="true"] { opacity: 0.4; border-style: dashed; }
.dim-jh-modal .dim-jh-modelRow[data-dropBefore="true"]::before { content: ''; position: absolute; left: 0; right: 0; top: -5px; height: 3px; border-radius: 2px; background: #1677ff; }
.dim-jh-modal .dim-jh-modelRow[data-dropAfter="true"]::after { content: ''; position: absolute; left: 0; right: 0; bottom: -5px; height: 3px; border-radius: 2px; background: #1677ff; }
/* 拖拽柄在弹窗行里略收窄：行高比账号卡片矮（padding 7px vs 14px），
   16px 宽的柄会顶着模型名，缩到 14px 并把 gap 让出来。 */
.dim-jh-modal .dim-jh-modelRow .dim-jh-dragHandle { width: 14px; }
.dim-jh-modelInfo { flex: 1 1 auto; min-width: 0; display: flex; align-items: baseline; gap: 8px; }
/* 名称与 id 都必须能收缩（min-width: 0 + 可收缩的 flex-basis），否则长内容会
   顶宽整行。展示名优先保留，故 id 另加 max-width 上限。
   ⚠️ id 早期是 flex: none（拒绝收缩）—— 那正是「开关被挤出可视区」最直接的成因。 */
.dim-jh-modelName { flex: 0 1 auto; min-width: 0; overflow: hidden; font-size: 13px; line-height: 19px; font-weight: 500; color: var(--dsw-alias-label-primary, #1f2329); text-overflow: ellipsis; white-space: nowrap; }
.dim-jh-modelId { flex: 0 1 auto; min-width: 0; max-width: 46%; overflow: hidden; padding: 1px 5px; border-radius: 5px; background: var(--dsw-alias-bg-layer-2, #f4f5f7); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--dsw-alias-label-tertiary, #8f959e); text-overflow: ellipsis; white-space: nowrap; }

/* ── 模型能力标记（如「可发图片」）──
   ⚠️ 只标在**支持**的那一类模型上：不标 = 不支持。这样用户扫一眼清单就知道
   哪些模型能发图，不必靠撞一次 unsupported_content 才发现。
   flex: none 是必需的 —— 它是行尾的固定标签，参与收缩会被 id/name 挤没。 */
.dim-jh-modelBadge { flex: none; padding: 1px 6px; border-radius: 5px; background: var(--dsw-alias-color-success-light, #e8ffea); color: var(--dsw-alias-color-success, #00875a); font-size: 11px; line-height: 16px; white-space: nowrap; }

/* ── 已下架（失效）模型（2026-10-06 复审 !66）──
   ⚠️ **必须放在上面 .dim-jh-modelName / .dim-jh-modelId 基础规则之后**：
   tests/unit/model-filter.spec.ts 的 ruleOf() 按**源码顺序**取第一条匹配规则，
   把带 [data-dead] 的规则写在前面会让它误取到本块、跳过基础规则。
   ⚠️⚠️ **本块内禁止出现反引号**（AGENTS.md 红线：样式是模板字符串，注释里的
   反引号会提前闭合模板；tests/unit/zcode-channel-dialog.spec.ts 有专门用例守着）。
   与「已关闭」**必须视觉可区分**：一个是用户的主动选择（开关可拨回），
   一个是系统判定上游已移除（只能点「重新显示」恢复）。若长得一样，用户会去拨
   那个根本不存在的开关，于是以为「模型被吞了、插件有 bug」。
   ⇒ 用左侧警示竖条 + 琥珀色角标，与「已关闭」的纯淡出区分开。 */
.dim-jh-modelRow[data-dead="true"] { box-shadow: inset 3px 0 0 var(--dsw-alias-warning, #d48806); }
.dim-jh-modelRow[data-dead="true"] .dim-jh-modelInfo { opacity: 1; }
.dim-jh-modelRow[data-dead="true"] .dim-jh-modelName { color: var(--dsw-alias-warning, #d48806); }
.dim-jh-modelDead {
  flex: none;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-warning, #d48806);
  background: color-mix(in srgb, var(--dsw-alias-warning, #d48806) 12%, transparent);
}
.dim-jh-modelRestore {
  flex: none;
  padding: 2px 10px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--dsw-alias-text-secondary, #4e5969);
  background: var(--dsw-alias-bg-layer-2, #f7f8fa);
  border: 1px solid var(--dsw-alias-border-l2, #dfe1e5);
  cursor: pointer;
}
.dim-jh-modelRestore:hover:not(:disabled) {
  color: #1677ff;
  border-color: color-mix(in srgb, #1677ff 40%, var(--dsw-alias-border-l2, #dfe1e5));
}
.dim-jh-modelRestore:disabled { opacity: 0.5; cursor: default; }
/* 顶部批量恢复条 */
.dim-jh-modelDeadBar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 6px 0;
  padding: 7px 10px;
  border-radius: 8px;
  font-size: 12px;
  color: var(--dsw-alias-text-secondary, #4e5969);
  background: color-mix(in srgb, var(--dsw-alias-warning, #d48806) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-warning, #d48806) 26%, transparent);
}

/* ── 思考档位对照表 ──
   与模型清单的行**刻意不同**：那两行的 id/name 用 ellipsis 截断（清单要紧凑），
   而对照表的内容本身就是用户要抄的东西 —— 截断等于让功能失效
   （真实反馈：「你这对照表字符过长都被省略了」）。
   故这里用 grid 竖排：第一行模型 id + 徽标，后两行整宽、可换行、可选中复制。
   ⚠️ 绝不能加 text-overflow: ellipsis / white-space: nowrap。 */
.dim-jh-effortRow { display: grid; grid-template-columns: minmax(0, 1fr); gap: 3px; min-width: 0; padding: 7px 8px; border-radius: 8px; }
.dim-jh-effortRow:hover { background: var(--dsw-alias-bg-layer-2, #f7f8fa); }
.dim-jh-effortHead { display: flex; align-items: center; gap: 8px; min-width: 0; }
/* 模型 id 在这里允许换行（对照表不追求单行紧凑），但仍优先占满剩余宽度。 */
.dim-jh-effortModel { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-primary, #1f2329); }
.dim-jh-effortLine { min-width: 0; overflow-wrap: anywhere; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #4e5969); }
.dim-jh-effortLabel { color: var(--dsw-alias-label-tertiary, #8f959e); }
/* 搜索结果为空时的提示（与其它空状态同款观感）。 */
.dim-jh-effortEmpty { padding: 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8f959e); }
/* 档位对照行里的模型名也**不得截断**（用户 2026-10-04：「所有胶囊内容都没有
   完整显示」）。这里本就没写 ellipsis，但补一条**显式**声明把意图锁住：
   下面「网关弹窗里的胶囊」那条 .dim-jh-modelId 规则不该被误用到它身上，
   而将来若有人给 .dim-jh-effortModel 加上截断，这条会立刻在单测里变红。
   ⚠️ 本文件整体是一个 JS 模板字符串，注释里**不能出现反引号** —— 会提前
   终止字符串（见 .dim-jh-iconBtn 处的同款警告）。 */
.dim-jh-gatewayModal .dim-jh-effortModel { overflow: visible; text-overflow: clip; white-space: normal; overflow-wrap: anywhere; }

/* ── 网关弹窗的排版收紧（用户 2026-10-04 要求：「这几段话之间的行间距小一点」）──
   ⚠️ 必须加 .dim-jh-gatewayModal 前缀：.dim-jh-modalHint 是**共用**类，
   另有 24 处调用点（账号面板、opencode 弹窗、备份弹窗…），本次只该动网关弹窗
   —— 全局把 10px 改成 6px 会悄悄改掉那些页面的观感。
   本弹窗有 8 处说明行，10px × 8 ≈ 80px 空隙，收成 6px 后观感明显紧凑。 */
.dim-jh-gatewayModal .dim-jh-modalHint { margin-top: 6px; }
/* 弹窗顶部那三行是**同一段话**（推荐 / 协议 / 地址），彼此再紧一档，
   否则它们看起来像三个互不相干的段落。
   ⚠️ 现在「思考档位对照表」那段的两句说明也用这个类（同样是一段话拆成两行，
   为的是不让品牌名 CC Switch 在行尾被从中间切开）。 */
.dim-jh-gatewayModal .dim-jh-gatewayLine { margin-top: 4px; }

/* ── 三段功能区的**分隔**（用户 2026-10-04：「这三坨字全混在一起有点难看清」）──
   用户把弹窗分成三块：① 开关 + 连接信息（推荐 / 协议 / 地址 / API KEY）
   ② 模型 ID 清单 ③ 思考档位对照表。
   此前三段之间只靠一个 16px 的 margin，而每段内部又各有若干行 12px 灰字，
   视觉上连成一片 —— 用户找不到「下一块从哪开始」。

   做法：段间用**一条上边框 + 更大的上间距**切开，段内保持原有的紧凑。
   ⚠️ 用 border-top 而不是背景色块：弹窗会被截图，色块在深色主题下还要另配
   一整套 token（本文件别处同理，见 .dim-jh-gatewayCards 的注释）。
   ⚠️ 第一段**不要**上边框（它紧跟在弹窗标题下，加线会像多出一条分隔条）。 */
.dim-jh-gatewaySection { display: block; }
.dim-jh-gatewaySection + .dim-jh-gatewaySection {
  margin-top: 12px; padding-top: 10px;
  border-top: 1px solid var(--dsw-alias-border-l2, #eef0f3);
}
/* 段标题比正文说明重一档，作为「这块讲什么」的锚点。
   ⚠️ 不能沿用 .dim-jh-modalHint 那套 12px 灰字 —— 段标题与段内说明同为灰色时，
   分隔线的效果会被抵消（用户仍然分不清哪一行是标题）。 */
.dim-jh-gatewaySectionTitle { margin: 0; font-size: 13px; line-height: 19px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); }
/* 段内第一行紧跟段标题，不再叠那 6px。 */
.dim-jh-gatewaySectionTitle + .dim-jh-modalHint { margin-top: 3px; }
/* 弹窗末尾那条安全提示：与上面三段拉开，且**不属于任何一段**（它是整个弹窗的脚注）。 */
.dim-jh-gatewayModal .dim-jh-gatewayFootnote { margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l2, #eef0f3); }

/* ── 密钥行：小号按钮，不让按钮把这一行撑高 ──
   ⚠️ 用户 2026-10-04 报障：「复制密钥」「显示明文」大到把这行撑开。
   根因是 .dim-jh-btn 是**通用**按钮（padding 4px 12px + line-height 18px
   ⇒ 约 28px 高），而同行只有 18px 高的说明文字 —— 按钮比文字高 10px，
   整行的高度就被它顶起来了。这里单独压到约 22px，与文字行接近。
   ⚠️ 不能直接改 .dim-jh-btn（30+ 处调用点：页头、卡片头、对照表…）。
   ⚠️ 用户随后又要求「下面的四个按钮也按复制密钥的大小来统一」，故把
   清单/对照表那两个操作行（.dim-jh-gatewayActions）并进同一条规则 ——
   两处必须是**同一条规则**，各写一份迟早一处改了另一处没改。 */
.dim-jh-gatewayKeyRow { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.dim-jh-gatewayKeyRow .dim-jh-btn,
.dim-jh-gatewayModal .dim-jh-gatewayActions .dim-jh-btn { padding: 2px 8px; font-size: 11px; line-height: 16px; border-radius: 6px; }
/* 「API KEY：」标签：与按钮同基线、不可压缩（否则窄面板下会折成两行）。 */
.dim-jh-gatewayKeyRow .dim-jh-gatewayKeyLabel { flex: none; margin: 0; }
/* 下方两个操作行（模型清单 / 思考档位对照表）的间距也向密钥行看齐（8px → 6px）：
   四个按钮既然压成小号，原来的 8px 间隔配小按钮会显得松散。
   ⚠️ 另加 flex-wrap: wrap：.dim-jh-modelPanelActions 默认是 nowrap
   （页头那两三个固定按钮用它没问题），而这两行的按钮文案带**动态计数**
   （「复制全部 1234 个 ID」「复制对照表（1234 行）」），计数一长，nowrap
   会把按钮推出容器、点不到。实测当前数据（15 个模型）在 364px 窄弹窗下不出问题，
   但那是**当前数据**的结论 —— 换行让它对任意计数都成立。
   ⚠️ 本文件整体是一个 JS 模板字符串，注释里**不能出现反引号**（会提前终止字符串）。
   我在这条注释里用反引号括了一次类名，直接把文件从中间截断、构建产物语法错误 ——
   写类名时**裸写**，要强调就用「」或**。 */
.dim-jh-gatewayModal .dim-jh-gatewayActions { gap: 6px; flex-wrap: wrap; }

/* ── 网关清单：**一个供应商一张卡片**（模型清单与档位对照表共用）──
   用户 2026-10-03 报障：此前按「一个模型一行」平铺，同一家的
   deepseek-account/deepseek-flash 与 deepseek-account/deepseek-v4-pro
   看起来毫无关系；用户真正要对照的是「哪家有哪些模型」，故改成分组卡片。
   分组判据在 openai-gateway-panel.js 的 groupGatewayEntries（纯函数，可单测）。
   ⚠️ 本文件整体是 JS 模板字符串，注释里**不能出现反引号**（会提前终止字符串）。 */
.dim-jh-gatewayCards { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
/* 卡片：细边框 + 圆角，与复用的分组头（.dim-jh-modelGroup）同一种规格语言。
   ⚠️ min-width: 0 是**必需**的：卡片是 grid 项，默认 min-width: auto 会被
   内部长 id 撑开，从而把整个弹窗顶出横向滚动条（模型列表踩过同一个坑）。 */
.dim-jh-gatewayCard { min-width: 0; border: .5px solid var(--dsw-alias-border-l3, #e5e5e5); border-radius: 10px; overflow: hidden; }
/* 卡片头：吸顶。清单很长时滚到底部仍要能看出「我在哪一家」。
   背景用不透明层色，否则卡内行会从下面透出来。 */
.dim-jh-gatewayCardHead { position: sticky; top: 0; z-index: 2; display: flex; align-items: flex-start; flex-wrap: wrap; gap: 4px 8px; min-width: 0; padding: 6px 8px; background: var(--dsw-alias-bg-layer-2, #f7f8fa); border-bottom: .5px solid var(--dsw-alias-border-l3, #e5e5e5); }
/* 卡片标题（可点，折叠开关）：占满剩余宽度。
   ⚠️ 用户 2026-10-04 报障「网关里的胶囊内容都没有完整显示」：此处原先是
   ellipsis + nowrap，长供应商名（或展示名）被截成 deepseek-accou…，
   而卡片标题正是用户**唯一**能确认「这一家是谁」的地方。
   改为换行显示：整行放不下时 title 独占一行，计数与「复制本组」按钮落到第二行。
   ⚠️ 绝不能加回 text-overflow: ellipsis / white-space: nowrap。 */
.dim-jh-gatewayCardToggle { flex: 1 1 auto; min-width: 0; padding: 2px 0; border: 0; background: transparent; color: var(--dsw-alias-label-primary, #1f2329); font-size: 12.5px; line-height: 18px; font-weight: 600; text-align: left; overflow-wrap: anywhere; cursor: pointer; }
.dim-jh-gatewayCardToggle:hover { color: var(--dsw-alias-brand-primary, #1677ff); }
/* 计数与按钮：可以掉到第二行，但**不换行、不截断**（flex: none 保证不被挤没）。 */
.dim-jh-gatewayCardCount { flex: 0 0 auto; margin-left: auto; font-size: 11px; line-height: 17px; font-variant-numeric: tabular-nums; white-space: nowrap; color: var(--dsw-alias-label-tertiary, #8f959e); }
.dim-jh-gatewayCardHead .dim-jh-gatewayCardBtn { flex: none; padding: 2px 8px; font-size: 11px; }
/* 卡片标题里的供应商图标（2026-10-26）。
   ⚠️ 基类是 display: grid（block-level）—— 直接塞进这个按钮会在图标前后**各断
   一行**，标题当场变成三行。而按钮本身不是 flex 容器（它是 flex: 1 1 auto 的
   **项**），故这里只能用 inline-grid + vertical-align 把它压回文字流。
   负的 vertical-align 是让 18px 方块的中线对准 12.5px 文字的视觉中线。 */
.dim-jh-gatewayCardToggle > .dim-jh-providerIcon { display: inline-grid; vertical-align: -5px; width: 18px; height: 18px; margin-right: 4px; border-radius: 5px; box-shadow: none; }
.dim-jh-gatewayCardToggle > .dim-jh-providerIcon img { width: 13px; height: 13px; }
.dim-jh-gatewayCardBody { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1px; padding: 3px 4px 5px; }
/* 一行模型（**只读**，无开关）：短名字 + 展示名 + 能力标记。
   ⚠️ 行内显示的是去掉供应商前缀的名字（见 gatewayModelKeyOf）—— 卡片头已经
   写清了是哪一家，再重复一遍前缀只会把整行挤到只剩省略号。
   ⚠️ 这里刻意**不用** .dim-jh-modelRow：那个类带 cursor: pointer 与 hover 底色，
   是给「整行可点切换开关」的 label 用的，用在这里会被读成可点。 */
.dim-jh-gatewayModelRow { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 5px 6px; border-radius: 6px; }
.dim-jh-gatewayModelRow:hover { background: var(--dsw-alias-bg-layer-2, #f4f5f7); }
/* ⚠️ 这里曾有一条「.dim-jh-gatewayModelRow .dim-jh-modelId { max-width: 52% }」
   （把模型列表那 46% 的上限放宽到 52%）。**已删除**，别再写回来：
   它的优先级 (0,2,0) 与下面那条两级通配 (0,2,0) **完全相同**，
   于是谁生效**只取决于源码先后** —— 一个纯粹靠「写在对的位置」维持的假象。
   下面那条把 max-width 直接设成 none（且覆盖了开关行与 curl 代码块），
   一行里本该完整显示的东西，不该还留一个 52% 的上限等着被谁「压过去」。
   ⚠️ 本文件是 JS 模板字符串，注释里**绝不能出现反引号**（我在这条注释上
   第四次踩到同一个坑）—— 类名与代码一律裸写。 */

/* ── 网关弹窗里的「胶囊」一律完整显示（用户报障 2026-10-04）──
   原话：「网关这里面的所有胶囊内容都没有完整显示，应当修正使其完整显示内容」。
   胶囊 = 行内的 <code> ID 块（.dim-jh-modelId）、能力标记（.dim-jh-modelBadge）、
   档位对照行里的模型名（.dim-jh-effortModel）。

   ⚠️ 根因是那三个类**天生带截断**，而且是给**别处**设计的：
   .dim-jh-modelId 是 max-width 46% + ellipsis + nowrap（模型列表要紧凑，
   一行里还得塞下开关）；.dim-jh-modelBadge 是 nowrap；模型名同理。
   而网关弹窗里这些内容**就是要被读/被抄的东西** —— 截断等于让功能失效。

   ⚠️ 只能加 .dim-jh-gatewayModal 前缀：.dim-jh-modelId 在模型列表里
   另有用途（那里的紧凑是刻意的，见 model-filter.js 的模块注释），
   全局去掉 max-width 会把整个模型列表撑坏。

   ⚠️⚠️ **选择器只能写「弹窗 + 类名」两级，绝不能夹中间祖先**（这里返工过一次）：
   第一版写的是「弹窗 + gatewayModelRow + modelId」这类**带中间祖先**的三条规则，
   结果**只覆盖到了卡片内的胶囊**。用户随即又截图框出三处仍在截断的地方，
   它们的祖先链各不相同：
     - 开关行：modalBody > modelRow > modelInfo > code
     - 两处 curl 代码块：modalBody > code
   三条祖先限定规则**一条都匹配不上** ⇒ 用户看到的还是「供 Pi / Cont…」与
   「curl … -H "…"」被吃掉。
   ⚠️ 当时的「机械审计」脚本也没抓到，因为它只检查**类名**有没有被某条网关规则
   覆盖 —— modelId 在卡片那条规则里「有覆盖」，于是整体判通过。
   **教训：判断一个元素会不会被截断，必须看它实际的祖先链，不能看类名是否出现过。**
   现在改成两级通配，弹窗内任何位置的这个类都生效（含 API KEY 明文那块 code）。
   ⚠️ 本文件整体是 JS 模板字符串，注释里**绝不能出现反引号** ——
   我在上面这段注释里用反引号括类名，第三次踩到了同一个坑（构建直接失败）。
   要强调就用「」或 ** 包住类名，永远裸写。 */
.dim-jh-gatewayModal .dim-jh-modelId,
.dim-jh-gatewayModal .dim-jh-modelName {
  max-width: none; overflow: visible; text-overflow: clip; white-space: normal; overflow-wrap: anywhere;
}
/* 能力标记（「可发图片」「需对照」）：短标签，但 flex: none + nowrap 会在
   窄面板下被挤出可视区 —— 允许换行远比被切掉好。 */
.dim-jh-gatewayModal .dim-jh-modelBadge {
  flex: 0 0 auto; white-space: normal; overflow-wrap: anywhere;
}
/* ⚠️ 顶部开关行的标题「启用本机网关」**不许被挤**（去掉 ID 胶囊的 max-width 后
   新引入的问题）：胶囊不再有 46% 上限，于是它把整行宽度吃光，
   而 .dim-jh-modelName 是 flex: 0 1 auto（可收缩）⇒ 标题被压成
   「启用本机网」「关」两行。
   判据：网关弹窗的开关行里，标题保持固有宽度（flex: none），
   让**副标题**去换行 —— 副标题是补充说明，标题是动作主体。
   ⚠️ 本文件是 JS 模板字符串，注释里**绝不能出现反引号**（又踩了一次，第五次）。 */
.dim-jh-gatewayModal .dim-jh-modelInfo > .dim-jh-modelName { flex: none; }
/* 搜索/空结果的容器：与对照表的 .dim-jh-effortEmpty 同款观感。 */
.dim-jh-gatewayEmpty { padding: 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8f959e); }

/* ── 「Token 用量」弹窗（渠道 × provider × 模型 三级汇总 + 最近明细）──
   数据来自本机内存账本（usage.tokenLedger），记账点在注册收敛层。
   卡片结构与网关弹窗的供应商卡片同一规格语言（细边框 + 圆角 + 吸顶头），
   但不吸顶：本弹窗层级只有两级，吸顶收益小于复杂度。
   ⚠️ 本文件整体是 JS 模板字符串，注释里绝不能出现反引号 —— 类名一律裸写。 */
.dim-jh-ledgerFilters { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.dim-jh-ledgerFilterBtn { padding: 2px 10px; font-size: 11.5px; line-height: 17px; border-radius: 999px; opacity: .72; }
.dim-jh-ledgerFilterBtn[data-active="true"] { opacity: 1; font-weight: 600; }
.dim-jh-ledgerCard { min-width: 0; border: .5px solid var(--dsw-alias-border-l3, #e5e5e5); border-radius: 10px; overflow: hidden; }
.dim-jh-ledgerCardHead { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px; padding: 7px 10px; background: var(--dsw-alias-bg-layer-2, #f7f8fa); border-bottom: .5px solid var(--dsw-alias-border-l3, #e5e5e5); }
.dim-jh-ledgerCardHead strong { font-size: 12.5px; line-height: 18px; color: var(--dsw-alias-label-primary, #1f2329); }
.dim-jh-ledgerCardSum { margin-left: auto; font-size: 11.5px; line-height: 17px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary, #4e5969); white-space: nowrap; }
.dim-jh-ledgerProvider { padding: 4px 10px 6px; }
.dim-jh-ledgerProvider + .dim-jh-ledgerProvider { border-top: .5px solid var(--dsw-alias-border-l3, #eef0f3); }
/* 账号层（第 2 期）：只在多账号（或含「未归属」）时渲染，缩进一层；
   单账号 provider 不展开 —— 一比一的中间层是纯噪音。 */
.dim-jh-ledgerAccount { min-width: 0; }
.dim-jh-ledgerAccount + .dim-jh-ledgerAccount { border-top: .5px dashed var(--dsw-alias-border-l3, #eef0f3); }
.dim-jh-ledgerAccountHead { display: flex; align-items: baseline; gap: 8px; padding: 3px 0 1px 8px; }
.dim-jh-ledgerAccountName { min-width: 0; font-size: 11.5px; line-height: 17px; font-weight: 600; color: var(--dsw-alias-label-secondary, #4e5969); overflow-wrap: anywhere; }
.dim-jh-ledgerAccountSum { margin-left: auto; flex: none; font-size: 11px; line-height: 16px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary, #8f959e); white-space: nowrap; }
.dim-jh-ledgerProviderHead { display: flex; align-items: baseline; gap: 8px; padding: 4px 0 2px; }
.dim-jh-ledgerProviderName { min-width: 0; font-size: 12px; line-height: 18px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); overflow-wrap: anywhere; }
.dim-jh-ledgerProviderSum { margin-left: auto; flex: none; font-size: 11px; line-height: 16px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary, #8f959e); white-space: nowrap; }
.dim-jh-ledgerModel { display: flex; align-items: baseline; gap: 8px; min-width: 0; padding: 2px 0 2px 10px; }
.dim-jh-ledgerModelName { flex: 1 1 auto; min-width: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; line-height: 17px; color: var(--dsw-alias-label-secondary, #4e5969); overflow-wrap: anywhere; }
.dim-jh-ledgerModelReq { flex: none; font-size: 11px; line-height: 16px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary, #8f959e); white-space: nowrap; }
.dim-jh-ledgerModelTokens { flex: none; font-size: 11.5px; line-height: 17px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary, #1f2329); white-space: nowrap; }
/* 均值格（首字 · 速率）：三级汇总行（渠道/账号/模型）共用，等宽数字对齐。 */
.dim-jh-ledgerPerf { flex: none; font-size: 11px; line-height: 16px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary, #8f959e); white-space: nowrap; }
/* ── 历史视图（第 4 期）：GitHub 风格每日用量格 + 展开的日聚合树 ── */
.dim-jh-ledgerSection { margin-bottom: 14px; }
.dim-jh-ledgerSectionTitle { font-size: 13px; line-height: 19px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); margin-bottom: 6px; }
.dim-jh-ledgerHeatmapWrap { width: 100%; overflow-x: auto; padding: 4px 3px 8px; }
.dim-jh-ledgerHeatmap { display: grid; grid-auto-flow: column; grid-template-rows: repeat(4, 12px); grid-auto-columns: 12px; gap: 4px; width: max-content; }
.dim-jh-ledgerHeatmapCell { appearance: none; box-sizing: border-box; width: 12px; height: 12px; padding: 0; border: 1px solid rgba(34, 211, 238, .16); border-radius: 3px; background: rgba(34, 211, 238, .07); box-shadow: 0 0 2px rgba(34, 211, 238, .08); transition: background .12s ease, box-shadow .12s ease, transform .12s ease; }
.dim-jh-ledgerHeatmap button.dim-jh-ledgerHeatmapCell { cursor: pointer; }
.dim-jh-ledgerHeatmapCell[data-level="1"] { background: rgba(34, 211, 238, .25); box-shadow: 0 0 4px rgba(34, 211, 238, .16); }
.dim-jh-ledgerHeatmapCell[data-level="2"] { background: rgba(34, 211, 238, .46); box-shadow: 0 0 5px rgba(34, 211, 238, .28); }
.dim-jh-ledgerHeatmapCell[data-level="3"] { background: rgba(6, 182, 212, .84); border-color: rgba(103, 232, 249, .75); box-shadow: 0 0 7px rgba(34, 211, 238, .5); }
.dim-jh-ledgerHeatmapCell[data-level="4"] { background: #0e7490; border-color: #67e8f9; box-shadow: 0 0 12px rgba(34, 211, 238, .9), inset 0 0 5px rgba(103, 232, 249, .72); }
.dim-jh-ledgerHeatmap button.dim-jh-ledgerHeatmapCell:hover { transform: scale(1.18); border-color: #a5f3fc; box-shadow: 0 0 10px rgba(34, 211, 238, .8); }
.dim-jh-ledgerHeatmapCell[data-today="true"] { outline: 1px solid #cffafe; outline-offset: 1px; }
.dim-jh-ledgerHeatmapCell[data-active="true"] { outline: 2px solid #67e8f9; outline-offset: 2px; }
.dim-jh-ledgerHeatmap button.dim-jh-ledgerHeatmapCell:focus-visible { outline: 2px solid #cffafe; outline-offset: 2px; }
.dim-jh-ledgerDayPeek { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 14px; min-height: 30px; margin-top: 7px; padding: 5px 9px; border-radius: 7px; background: var(--dsw-alias-bg-layer-2, #f7f8fa); color: var(--dsw-alias-label-secondary, #4e5969); font-size: 11.5px; }
.dim-jh-ledgerDayPeek strong { color: var(--dsw-alias-label-primary, #1f2329); }
.dim-jh-ledgerChartHint { margin-top: 7px; color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11px; }
.dim-jh-ledgerDeleteQuick { margin-left: auto; }
.dim-jh-ledgerDateRange { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.dim-jh-ledgerDateRange label { display: flex; align-items: center; gap: 5px; color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11px; }
.dim-jh-ledgerDateRange input { width: 136px; padding: 3px 6px; font-size: 11px; }
.dim-jh-ledgerExport { flex: none; }
/* 明细表：紧凑小字；模型列允许换行（长 wire 名不能截断 —— 网关弹窗同一条教训）。 */
.dim-jh-ledgerEntryTools { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin: 12px 0 5px; }
.dim-jh-ledgerEntryTools strong { margin-right: 2px; font-size: 13px; color: var(--dsw-alias-label-primary, #1f2329); }
.dim-jh-ledgerEntryCount { margin-right: auto; color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11px; font-variant-numeric: tabular-nums; }
.dim-jh-ledgerSearch { flex: 1 1 130px; width: auto; min-width: 120px; padding: 4px 7px; font-size: 11px; }
.dim-jh-ledgerSelect { min-width: 82px; max-width: 130px; padding: 4px 6px; border: 1px solid var(--dsw-alias-border-l2, #d0d3d9); border-radius: 6px; background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #1f2329); font-size: 11px; }
.dim-jh-ledgerTable { width: 100%; margin-top: 4px; border-collapse: collapse; table-layout: fixed; font-size: 11.5px; line-height: 17px; }
.dim-jh-ledgerTable th { position: sticky; top: 0; z-index: 1; padding: 4px 6px; text-align: left; font-weight: 600; color: var(--dsw-alias-label-tertiary, #8f959e); background: var(--dsw-alias-bg-layer-1, #fff); border-bottom: .5px solid var(--dsw-alias-border-l3, #e5e5e5); }
.dim-jh-ledgerTable td { padding: 3px 6px; border-bottom: .5px solid var(--dsw-alias-border-l3, #f0f1f3); font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary, #4e5969); vertical-align: baseline; }
.dim-jh-ledgerTable .dim-jh-ledgerEntryModel { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dsw-alias-label-primary, #1f2329); overflow-wrap: anywhere; }
.dim-jh-ledgerTable tbody tr[data-error="true"] td { color: var(--dsw-alias-state-error-primary, #d93025); }
.dim-jh-ledgerTable .dim-jh-ledgerError { cursor: help; font-weight: 600; }
.dim-jh-ledgerTable .dim-jh-ledgerSuccess { color: var(--dsw-alias-state-success-primary, #25803c); }
.dim-jh-ledgerPagination { display: flex; align-items: center; justify-content: flex-end; gap: 7px; padding: 7px 0; color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11px; }
@media (max-width: 700px) {
  .dim-jh-modal--ledger { padding: 14px 12px; }
  .dim-jh-ledgerPerf { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
  .dim-jh-ledgerEntryTools { align-items: stretch; }
  .dim-jh-ledgerEntryCount { flex: 1 1 50%; }
  .dim-jh-ledgerSearch { flex-basis: 100%; }
  .dim-jh-ledgerSelect { flex: 1 1 30%; max-width: none; }
  .dim-jh-ledgerTable { font-size: 10px; }
  .dim-jh-ledgerTable th, .dim-jh-ledgerTable td { padding: 3px 2px; overflow-wrap: anywhere; }
}

/* ── 模型列表的「计费/来源」分组（订阅 / 免费 / Cline Cloud / 按量计费）──
   分组由 model-groups.js 的纯函数决定（判据见其模块注释）；这里只管观感。
   ⚠️ 组头是**独立的 div**，绝不能包进 .dim-jh-modelRow 的 <label> 里 ——
   label 内点任意位置都会切换可见性开关（见 jet-hub.js 里「刻意不做多选」的说明）。 */
.dim-jh-modelGroup { min-width: 0; }
/* 组头吸顶：按量计费那组展开后有 460+ 行，滚到底部时也要能看到「我在哪一组」。
   背景用不透明层色，否则行会从下面透出来。 */
.dim-jh-modelGroupHead { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 8px; min-width: 0; padding: 6px 8px 5px; background: var(--dsw-alias-bg-layer-1, #fff); border-bottom: 0.5px solid var(--dsw-alias-border-l3, #e5e5e5); }
.dim-jh-modelGroupToggle { flex: 1 1 auto; min-width: 0; padding: 2px 0; border: 0; background: transparent; color: var(--dsw-alias-label-primary, #1f2329); font-size: 12.5px; font-weight: 600; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.dim-jh-modelGroupToggle:hover { color: var(--dsw-alias-brand-primary, #1677ff); }
.dim-jh-modelGroupCount { flex: none; font-size: 11px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary, #8f959e); }
/* 组头的两个按钮做紧凑处理：组头一行里要放下折叠标题 + 计数 + 两个按钮。 */
.dim-jh-modelGroupHead .dim-jh-modelGroupBtn { flex: none; padding: 2px 8px; font-size: 11px; }
.dim-jh-modelGroupBody { display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; padding: 2px 0 6px; }

/* 开关：基于 checkbox 绘制，保持原生语义（可聚焦、可键盘操作、可读屏） */
.dim-jh-switch { flex: none; appearance: none; -webkit-appearance: none; position: relative; width: 34px; height: 20px; margin: 0; border-radius: 999px; background: var(--dsw-alias-border-l2, #d0d3d9); cursor: pointer; transition: background .18s ease; }
.dim-jh-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgb(31 35 41 / 20%); transition: transform .18s ease; }
.dim-jh-switch:checked { background: #1677ff; }
.dim-jh-switch:checked::after { transform: translateX(14px); }
.dim-jh-switch:focus-visible { outline: none; box-shadow: 0 0 0 2px color-mix(in srgb, #1677ff 30%, transparent); }
.dim-jh-switch:disabled { opacity: 0.5; cursor: default; }

/* 「渠道原生搜索」开关（页头，取代原「关闭」按钮）。
   white-space: nowrap 是必需的：页头按钮行不换行，而 label 内的文字
   默认会在窄面板下折成两行，把整行高度撑开（与页头按钮同款约束）。
   字号与 .dim-jh-btn 对齐，视觉上仍是「一排控件」的一部分。 */
.dim-jh-nativeSearch { flex: none; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; font-size: 13px; color: var(--dsw-alias-label-p, inherit); cursor: pointer; user-select: none; }

/* ── 账号备份（导出 / 恢复）── */
/* 口令输入框：宽度撑满弹窗内容区，避免在窄面板下挤坏布局。
   ⚠️ 背景必须用**真实存在**的 token。早期写的是 --dsw-alias-bg-input，而主题里
   根本没有这个 token（真实的是 bg-base / bg-layer-1/2/3）—— var() 遇不存在的
   token **不报错**，静默取 fallback #fff，于是深色模式下变成「浅色文字 + 白底」，
   文字完全看不见（用户报障）。这里对齐官方 Input 原语用的 bg-layer-1，
   并去掉 fallback 以免再次掩盖 token 拼错。 */
.dim-jh-input { box-sizing: border-box; width: 100%; padding: 6px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-1); font-size: 13px; color: var(--dsw-alias-label-primary); }
.dim-jh-input:focus { outline: none; border-color: #1677ff; box-shadow: 0 0 0 2px color-mix(in srgb, #1677ff 20%, transparent); }
/* placeholder 用官方 Input 的 dimmed 色：默认色在深色模式下对比度不足。 */
.dim-jh-input::placeholder { color: var(--dsw-alias-label-dimmed); }
/* 加密勾选行：勾选框 + 文案一行排开 */
.dim-jh-checkRow { display: flex; align-items: center; gap: 8px; margin: 10px 0 4px; font-size: 13px; color: var(--dsw-alias-label-primary, #1f2329); cursor: pointer; }
.dim-jh-checkRow input[type="checkbox"] { margin: 0; accent-color: #1677ff; }
/* 两次口令输入：纵向堆叠 */
.dim-jh-formRows { display: flex; flex-direction: column; gap: 8px; margin: 8px 0 4px; }
/* ── 账号勾选（导出选账号 / 导入选账号）── */
/* 「全部」那行与逐条列表同宽，列表可滚动：账号多时不把弹窗撑爆 */
.dim-jh-accountPick { display: flex; flex-direction: column; margin: 6px 0 2px; }
.dim-jh-accountPickList { display: flex; flex-direction: column; max-height: 200px; overflow-y: auto; padding-right: 4px; }
/* 逐条行：缩进一级，视觉上从属于上面的「全部账号」 */
.dim-jh-accountPickRow { margin: 2px 0; padding-left: 14px; font-weight: 400; }
.dim-jh-accountPickName { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
/* 昵称过长时省略，而不是把 provider 标记挤出可视区 */
.dim-jh-accountPickName > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dim-jh-accountPickMeta { flex: none; font-size: 11px; color: var(--dsw-alias-label-tertiary, #8f959e); }
/* ── 导入方式单选（整体还原 / 单独导入）── */
.dim-jh-modePick { display: flex; flex-direction: column; margin: 4px 0 8px; }
.dim-jh-modePick input[type="radio"] { margin: 0; accent-color: #1677ff; }
/* 弹窗底部动作区：右对齐（生成/确认按钮） */
.dim-jh-modalActions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
/* ── 备份 / 恢复弹窗的方向切换条（2026-10-27 合并两个入口后新增）──
   ⚠️ 这是「换一页」不是「选项」：两个按钮互斥、点即生效，故用按钮 + data-active
   而不是 radio（radio 的语义是随表单一起提交，这里没有提交动作）。
   ⚠️ 选中态沿用既有的 data-kind="primary" 观感（蓝底白字）**不**另起一套配色：
   本仓库反复记录过「两套样式看起来不像同一个 UI」。 */
.dim-jh-backupTabs { display: flex; gap: 8px; margin: 2px 0 10px; }
/* 选中态：与 .dim-jh-btn[data-kind="primary"] 逐字同形（背景/边框/文字三处）。 */
.dim-jh-backupTabs .dim-jh-btn[data-active="true"] { background: #1677ff; color: #fff; border-color: #1677ff; font-weight: 600; }
.dim-jh-backupTabs .dim-jh-btn[data-active="true"]:hover:not(:disabled) { background: #0f5fce; border-color: #0f5fce; color: #fff; }


/* ── Cline「订阅额度」弹窗（官方额度窗口 + 请求记录）── */
/* 账号翻页器:⚠️ **一次只看一个账号**(参考实现同款,多账号全铺开会让
   额度卡与记录表都极长);额度窗口与请求记录**共享同一个索引**。
   ⚠️ 单账号时整行都不渲染(见 renderQuota)——箭头无处可去。 */
.dim-jh-quotaGroup { display: flex; flex-direction: column; gap: 12px; }
.dim-jh-quotaPager { display: flex; align-items: center; gap: 8px; }
/* 24×24 方形按钮(参考实现 .cp-usage-nav):箭头是导航控件,不是文字按钮。 */
.dim-jh-quotaArrow { box-sizing: border-box; width: 24px; height: 24px; flex: none; padding: 0; border: 0.5px solid var(--dsw-alias-border-l2, #d0d3d9); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary, #1f2329); font-size: 13px; line-height: 1; cursor: pointer; }
.dim-jh-quotaArrow:hover { border-color: var(--dsw-alias-brand-primary, #1677ff); }
.dim-jh-quotaAccountName { display: flex; align-items: center; gap: 8px; flex: 1 1 auto; min-width: 0; }
.dim-jh-quotaAccountLabel { overflow: hidden; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); text-overflow: ellipsis; white-space: nowrap; }
.dim-jh-quotaIndex { flex: none; font-size: 12px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary, #8f959e); }
/* 读数区:**多窗口并排卡片**(grid,参考实现同款)。
   ⚠️ auto-fit + 最小 170px:窄面板自动换列,不会把卡片压成一条。 */
.dim-jh-quotaWindows { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; }
.dim-jh-quotaWindow { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border: 0.5px solid var(--dsw-alias-border-l2, #d0d3d9); border-radius: 8px; }
.dim-jh-quotaWindowHead { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.dim-jh-quotaWindowName { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary, #555); }
/* 百分比是这张卡唯一要读的数 —— 18px 大字(参考实现同款) */
.dim-jh-quotaWindowPercent { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary, #1f2329); }
.dim-jh-quotaWindowPercent[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary, #d9822b); }
.dim-jh-quotaWindowPercent[data-tone="error"] { color: var(--dsw-alias-state-error-primary, #d93025); }
/* 进度条:宽度用的就是**夹取后**的百分比(与文案同一个值)。
   ⚠️ 正常档是**绿色**(参考实现 usageColor):全染品牌蓝会让「用掉九成」
   与「用掉一成」看起来一样,额度条就失去警示作用。 */
.dim-jh-quotaBar { height: 6px; overflow: hidden; border-radius: 999px; background: var(--dsw-alias-border-l2, #d0d3d9); }
.dim-jh-quotaBarFill { height: 100%; border-radius: 999px; background: var(--dsw-alias-state-success-primary, #2ea043); transition: width .3s; }
.dim-jh-quotaBarFill[data-tone="warn"] { background: var(--dsw-alias-state-warn-primary, #d9822b); }
.dim-jh-quotaBarFill[data-tone="error"] { background: var(--dsw-alias-state-error-primary, #d93025); }
.dim-jh-quotaReset { font-size: 12px; color: var(--dsw-alias-label-tertiary, #8f959e); }
/* 不可用 / 无窗口的静默文案(参考实现 .cp-muted) */
.dim-jh-quotaMuted { font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-tertiary, #8f959e); word-break: break-word; }

/* 请求记录区:与额度区用上边框分开 */
.dim-jh-quotaLog { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--dsw-alias-border-default, #e5e5e5); }
.dim-jh-quotaSectionTitle { margin: 0 0 4px; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); }
/* 说明「记录是本地流水」的提示:让用户知道重启会清空,而不是丢数据。 */
.dim-jh-quotaLogHint { margin: 0 0 8px; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary, #8f959e); }
/* 表格容器:⚠️ 自带纵向滚动 + 表头 sticky(参考实现 .cp-history 的 280px):
   长列表在弹窗内滚,表头始终可见。 */
.dim-jh-quotaTableWrap { max-height: 280px; overflow: auto; padding: 0 4px 2px; }
.dim-jh-quotaTable { width: 100%; border-collapse: collapse; table-layout: auto; font-size: 12px; }
/* ⚠️ td 默认 overflow:hidden:TOKEN / 延迟 / 错误列必须各自改成 normal+visible,
   否则它们继承的截断会把内容吃掉(参考实现踩过同一个坑)。 */
.dim-jh-quotaTable th, .dim-jh-quotaTable td { padding: 6px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2, #eee); font-size: 12px; vertical-align: middle; text-align: center; overflow: hidden; }
.dim-jh-quotaTable th { position: sticky; top: 0; z-index: 1; background: var(--dsw-alias-bg-layer-1, #fff); font-weight: 400; font-size: 11px; color: var(--dsw-alias-label-tertiary, #8f959e); white-space: nowrap; }
.dim-jh-quotaTable tbody tr:hover td { background: var(--dsw-alias-bg-layer-2, #f4f5f7); }
/* 列宽:状态点 16px、时间 82px(参考实现实测值,防时间戳被截断)。
   ⚠️ 用复合选择器:单独一个类的优先级压不过 .dim-jh-quotaTable td 的 (0,1,1)。 */
.dim-jh-quotaTable .dim-jh-quotaDotCol { width: 16px; }
.dim-jh-quotaTable .dim-jh-quotaWhenCol, .dim-jh-quotaTable .dim-jh-quotaWhen { width: 82px; }
.dim-jh-quotaTable td.dim-jh-quotaWhen { color: var(--dsw-alias-label-tertiary, #8f959e); font-variant-numeric: tabular-nums; }
/* 状态点:绿=成功、红=失败(参考实现同款;错误消息在 title 里)。 */
.dim-jh-quotaDot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-state-success-primary, #2ea043); }
.dim-jh-quotaDot[data-tone="error"] { background: var(--dsw-alias-state-error-primary, #d93025); }
/* 模型列:等宽字 + 省略号(模型 id 是最该被扫到的标识);上游做成 tag。 */
.dim-jh-quotaModel { display: block; max-width: 100%; overflow: hidden; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dsw-alias-label-primary, #1f2329); text-overflow: ellipsis; white-space: nowrap; }
.dim-jh-quotaMeta { display: flex; align-items: center; justify-content: center; gap: 6px; min-width: 0; overflow: hidden; margin-top: 2px; }
.dim-jh-quotaTag { padding: 1px 6px; border-radius: 5px; background: var(--dsw-alias-bg-layer-2, #f4f5f7); font-size: 11px; color: var(--dsw-alias-label-tertiary, #8f959e); white-space: nowrap; }
/* TOKEN 列:⚠️ 必须**允许折行**(参考实现同款)—— nowrap 会让
   「↓12.3k ↑4.5k ⚡1.2k 🧠89」把表格撑出横向滚动。 */
.dim-jh-quotaTable td.dim-jh-quotaTokens { font-size: 11.5px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary, #555); white-space: normal; overflow: visible; }
/* 延迟列:三行(首字 / 总耗时 / 输出速率),标签左、数值右(参考实现同款)。 */
.dim-jh-quotaTable td.dim-jh-quotaLoad { font-variant-numeric: tabular-nums; white-space: normal; overflow: visible; }
.dim-jh-quotaLoadRow { display: flex; justify-content: space-between; gap: 5px; max-width: 112px; margin: 0 auto; font-size: 11.5px; line-height: 1.5; }
.dim-jh-quotaLoadRow > span { white-space: nowrap; }
.dim-jh-quotaLoadRow > span:first-child { flex: none; }
.dim-jh-quotaLoadRow > span:last-child { min-width: 0; overflow: hidden; text-align: right; text-overflow: ellipsis; }
.dim-jh-quotaLoadKey { color: var(--dsw-alias-label-tertiary, #8f959e); }
/* 失败行:错误消息随行横跨数据列。⚠️ 必须允许折行 —— 错误文案(429 / 11140)
   很长,继承 td 的 nowrap + hidden 会把表格撑出横向滚动(参考实现的原坑)。 */
.dim-jh-quotaTable tr[data-error="true"] td { color: var(--dsw-alias-state-error-primary, #d93025); }
.dim-jh-quotaTable td.dim-jh-quotaError { font-size: 11.5px; line-height: 1.5; white-space: normal; overflow: visible; text-overflow: clip; word-break: break-word; }

/*
 * ── ZCode 登录渠道弹窗（Jet Hub 设置页；dim-jh-zcDialog / dim-jh-zcSelect） ──
 *
 * 这套样式**只服务 Jet Hub 设置页**的「添加账号 → 登录渠道」弹窗
 * （BigModel 国内 / z.ai 国际，见 jet-hub.js 的 zcodeProvider 下拉）。
 *
 * ⚠⚠️ 随 Gitee issue IKJLHQ 一并移除的还有一整套「官方「模型卡片 → 编辑」内的
 * ZCode 账号区」样式（.dim-jh-zcSection / zcSummary / zcAccount / zcMeta / zcBtn
 * / zcEmpty / zcNotice / zcLink，以及 [data-jet-hub-hidden]）。那套 UI 靠占用
 * settings.models.provider-card 槽的 llm-pi-ai key 实现，而该 key 与第三方
 * pi-ai 扩展**物理互斥**（机制见 index.js 文件头的长注释）—— ZCode 账号管理
 * 现在只在 Jet Hub 页。**别把那套样式加回来。**
 *
 * 颜色一律走 --dsw-alias-* 令牌；变量取不到时用 CSS 系统色（Canvas / CanvasText）
 * 兜底，跟随系统深浅色。
 * ⚠ 本文件整体是 JS 模板字符串，注释里**不能出现反引号**（会提前终止字符串）。
 */
/* 登录渠道选择（BigModel 国内 / z.ai 国际） */
.dim-jh-zcProvider { display: inline-flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary, GrayText); font-size: 12px; line-height: 18px; }
/* ⚠ background/color 的变量**必须带 fallback**（真实报障 2026-10-03：下拉里两项
   全是白的，只有 hover 才看见内容）。
   两个原因叠加：
   ① 原写法 background 设为全透明（0 0）+ color 用了无 fallback 的变量
      —— 变量在弹窗 scope 里取不到时 color 整条失效，退回继承。
   ② ⚠ Windows/Electron 下 **option 的背景不继承 select 的 background**，
      由系统主题决定；文字却**继承** color。
   ⇒ 浅色系统上就是「白底 + 失效/白字」⇒ 看不见。
   修法：① 变量都带 fallback，且 fallback 用 **CSS 系统色**（Canvas/CanvasText），
   它跟随系统深浅色；② 给 option 单独声明背景与文字色。
   ⚠⚠ 本注释里**绝不能出现反引号**（STYLES 是模板字符串，见 AGENTS.md）。 */
.dim-jh-zcSelect { box-sizing: border-box; height: 28px; padding: 0 8px; border: .5px solid var(--dsw-alias-border-l3, #dee0e3); border-radius: 14px; background: var(--dsw-alias-bg-layer-3, Canvas); color: var(--dsw-alias-label-primary, CanvasText); font-size: 12px; line-height: 18px; cursor: pointer; }
/* ⚠ 必须单独声明：option 的背景不继承 select（见上）。缺这条就是「下拉项全白」。 */
.dim-jh-zcSelect option { color: var(--dsw-alias-label-primary, CanvasText); background-color: var(--dsw-alias-bg-layer-3, Canvas); }
.dim-jh-zcSelect:disabled { opacity: .4; cursor: default; }
.dim-jh-zcSelect:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-alias-border-l3, #dee0e3); }
.dim-jh-zcDialogMask { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, .45); }
.dim-jh-zcDialog { box-sizing: border-box; width: min(420px, calc(100vw - 32px)); padding: 18px 20px; border-radius: 10px; background: var(--dsw-alias-bg-layer-3, Canvas); box-shadow: 0 8px 32px rgba(0, 0, 0, .28); }
/* ⚠ 背景**必须**用 bg-layer-3（真实报障 2026-10-03：深色主题下弹窗是白的）。
   原先写的是 --dsw-alias-surface —— 那是**猜的变量名，DSH 里并不存在**，
   于是 fallback 里的浅色生效 ⇒ 深色主题下白底 + 浅色字，几乎看不见。
   本文件通篇用 bg-layer-1/2/3；fallback 用 CSS 系统色 Canvas（跟随系统深浅），
   这样变量取不到时也不会退回浅色。 */
.dim-jh-zcDialogTitle { margin: 0 0 6px; font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary, CanvasText); }
.dim-jh-zcDialogHint { margin: 0 0 12px; font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-tertiary, GrayText); }
.dim-jh-zcDialog .dim-jh-zcProvider { display: flex; align-items: center; gap: 8px; margin: 0 0 16px; font-size: 13px; }
.dim-jh-zcDialogActions { display: flex; justify-content: flex-end; gap: 8px; }

/* ── 用量徽标（会话输入区，模型选择器旁） ────────────────────────────────
   折叠态是一枚紧凑按钮，浮层用 position:absolute + bottom:calc(100% + 8px)
   向上展开（贴着输入区上沿，不遮挡输入框）。
   ⚠ 输入区（RlGAzG_root / dock / trailing / standardControls）没有
   overflow:hidden（只有文本域 .RlGAzG_scroll 是 overflow-y:auto），故浮层
   不会被裁剪 —— 若将来上游给这些容器加上裁剪，这里要改成固定定位 + 锚点换算。

   浮层尺寸口径（用户 2026-10-02：「小巧、美观，但信息不能缺失」→「不够小巧和精致」
   →「额度那块文字居中 + 浅色模式下按钮和线条太不明显」三轮迭代后定稿）：
   - 宽 **280px**、正文字号 10–11px、节间距 7px、进度条 3px；
   - **每个订阅窗口只占一行**：名称 / 进度条 / 百分比 / 重置倒计时；
   - 订阅额度那块用 grid **整块水平居中**（justify-content: center），列仍对齐；
   - 按钮与分隔线一律用**主题描边**（--dsw-alias-border-l2，全不透明）——
     试过「去线条」，浅色模式下按钮和分区线会看不见，用户明确反馈后撤回；
   - 阴影双层（近处极淡 + 远处扩散），比单层大阴影更精致。
   信息项一项未减（渠道名、更新时间与缓存标记、偏好三态、窗口百分比与倒计时、
   套餐名称与到期与账号数、逐账号余额与分桶、停用/失败计数、两个签到按钮）。 */
/* ⚠️ 徽标宽度会**挤压右侧的模型选择器**（真机报障 2026-10-02）。
 *
 * ## 症状
 *
 * 徽标与模型选择器同在 composer 一行（徽标 order:100 在模型选择器左侧），
 * 而本元素是 flex: none —— 不参与收缩。原先 max-width: 280px 会把
 * 「图标 + 模型名 + ▾」的模型选择器压到只剩几十 px，**图标被挤没**，
 * 用户看到「只有放大到很大才能看到那个图标」。
 *
 * ## 为什么会暴露
 *
 * 早期徽标永不显示（store.current 恒为 null 的缺陷期），模型选择器独占
 * 整行所以一直正常；徽标修好后开始占位，才暴露出这个抢占。
 *
 * ## 两级收敛（用户定：1+2）
 *
 * ## 宽度：**内容自适应**，216px 只是上限（不是目标宽度）
 *
 * 胶囊本身是**内容自适应**的：宽度由实际文字撑开，短内容就短
 * （Cline • 5积分 仅 93px），不会有固定留白。下面的 max-width 只在
 * 内容**过长**时兜底，防止挤压右侧的模型选择器。
 *
 * ⚠️ 2026-10-03 上限从 150px 提到 **216px**（用户报障「供应商名字显示不完整」
 * 之后又提了一次）。两次报障、同一条链路的两个不同成因：
 * 1. **数字被截**（第一次）：整句塞进一个 overflow:hidden 的 span，省略号从右往左
 *    吃掉了余额。修法是**结构**（拆成可独立收缩的 span，见 badge-model.js 的
 *    readingOf 与 usage-badge.js 的三段式渲染）；
 * 2. **渠道名被截**（第二次）：结构修好后，186px 仍不够长渠道名 + 长余额，
 *    于是省略号落到**名字**上（用户截图：CodeArts (华为…）。216px 解决它。
 *
 * **216 是量出来的，不是拍的**：实测 13 个渠道展示名 × 10 种现实读数
 * （含 123456.78积分 / 9499.84积分 / 94.54MToken / 0积分）共 130 组，
 * 需要的最宽度是 **209.34px**（WorkBuddy (国际版) • 123456.78积分），
 * 216px 全部装得下且留 6.7px 余量（字体回退时字宽会变）。
 *
 * ⚠️ **上限不能再往上放**：实测把上限放到「无上限」时，极窄 composer（220px）
 * 下胶囊会**溢出容器 8.3px** —— 那正是 2026-10-02「模型选择器图标被挤没」
 * 的形态。内容自适应 + 合理上限，两者缺一不可。
 * 兜底退化顺序：超长时**渠道名**先出省略号，**余额一个字都不会少**
 * （.dim-jh-badgeReading 是 flex: none）。
 *
 * ⚠️ button 元素**本来就是 border-box**（UA 默认样式表），故下面的 box-sizing
 * 是**显式写出**（防止哪天元素换成 span/div 时语义悄悄变成内容盒），不是修复。
 * ⚠️⚠️ 本段注释里**不能出现反引号**（本文件整体是 JS 模板字符串，会提前终止）。
 * ② 容器再窄时（< 720px，媒体查询挂在**全局宽度**上：composer 宽度受
 *    侧栏影响，用容器查询无法表达「右侧还剩多少」）**只留状态点**，
 *    文字与 chevron 全部隐藏 —— 此时代理器优先级让给模型选择器。 */
/* ⚠️ flex: 0 1 auto（而非 none）：胶囊自身也要能收缩。它是 flex: none 时
   宽度只由 max-width 兜底，而 max-width 只在**内容超标**时生效 —— 容器更窄时
   它会连同右侧模型选择器一起溢出。允许收缩后，空间不足时胶囊与选择器一起让位，
   且胶囊内部退化是有序的（先名字出省略号，数字最后才动）。 */
.dim-jh-badge { position: relative; display: flex; align-items: center; flex: 0 1 auto; min-width: 0; }
/* ⚠️ box-sizing 是**显式写出**的，不是修复：button 的 UA 默认样式表本就是
   border-box（实测 offsetWidth 与 max-width 相等）。写上它只为在元素类型被改
   （span/div 默认是 content-box）时语义不悄悄漂移 —— 那种情况下 max-width 会从
   「占位宽度」变成「内容宽度」，胶囊会突然变宽 19px 而这行代码看着毫无变化。 */
.dim-jh-badgeBtn { box-sizing: border-box; display: flex; align-items: center; gap: 5px; max-width: 216px; min-width: 0; padding: 2px 9px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 999px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; line-height: 1.5; cursor: pointer; white-space: nowrap; font-variant-numeric: tabular-nums; transition: background .15s ease, color .15s ease, border-color .15s ease; }
.dim-jh-badgeBtn:hover { background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); }
.dim-jh-badgeBtn[aria-expanded="true"] { background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); border-color: color-mix(in srgb, #1677ff 45%, var(--dsw-alias-border-l2)); }
/* 聚合「待首次请求」占位胶囊（用户报障 2026-10-08：「也没胶囊了？」）。
   ⚠️ 刻意与 .dim-jh-badgeBtn **外观一致但不共用类名**：那个类名带 cursor:pointer
   与 :hover 反馈，而这里没有任何可点的东西（无历史 ⇒ 没有余额可展开）。
   给一个点了没反应的按钮比没有按钮更糟。
   ⚠️ 宽度口径与 .dim-jh-badgeBtn 同步（gap 5px / padding 2px 9px / 字号 11px）：
   两者会在同一位置交替出现（首次请求成功后换成真胶囊），尺寸不一致会看到跳动。 */
.dim-jh-badgePending { display: inline-flex; align-items: center; gap: 5px; max-width: 216px; min-width: 0; padding: 2px 9px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 999px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 1.5; white-space: nowrap; }
.dim-jh-badgePending > span:last-child { overflow: hidden; text-overflow: ellipsis; }
/* 三段式文本容器：渠道名 + 分隔符 + 读数。
   ⚠️ 必须是 flex 容器，两个文本子项才能各自独立收缩（这正是「数字不被截」的前提）。 */
.dim-jh-badgeText { display: flex; align-items: center; min-width: 0; }
/* ⚠️ 让位顺序：中段说明(999) → 渠道名(99) → 读数(none，**不参与收缩**)。
   收缩量按 flex-shrink × flex-basis 加权分配，999 与 99 相差一个数量级，
   故「包名先走、渠道名其次」，读数一个字都不会少。
   flex-grow 一律为 0：胶囊是内容自适应宽度，任何 grow 都只会让它在宽容器里虚胖。
   min-width:0 是省略号生效的前提（flex 子项默认 min-width:auto，会撑破 max-width）。 */
.dim-jh-badgeName { flex: 0 99 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 分隔符「•」：定宽不收缩，两侧间距由 margin 给。
   ⚠️ 这里的 3px **不能**换成前后空格：flex 容器把 span 之间只含空白的文本节点
   渲染成**零宽**（实测 gap=0，节点还在但看不见），空格会静默消失。
   带空格的那份写法（BADGE_SEP = ' • '）只用于 title / aria-label 那句整文。 */
.dim-jh-badgeSep { flex: none; margin: 0 3px; }
/* 中段说明（只有套餐模式有值，如包名 Free Plan Subscription）。
   ⚠️ 收缩权重**最大**（999）：它比渠道名更该让位 —— 包名多为样板字、且长，
   而用户认得出自己选的渠道。
   ⚠️ 它被压到 0 宽时（内容过长）该节点仍在，会留下一个「悬空的分隔符」；
   这在胶囊这一行是可接受的（完整文案在 title 与弹窗里），故不额外做条件渲染。 */
.dim-jh-badgeDetail { flex: 0 999 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* ⚠️⚠️ 读数必须 flex: none（**完全不收缩**），不能写 flex: 0 1 auto。
   这是第二处、也是更隐蔽的一处「数字被截」成因，**靠截图才发现**：

   收缩量按 flex-shrink × flex-basis 加权分配，读数那一份虽小却**不为零** ——
   实测读数被分到 0.77px 的收缩（getBoundingClientRect 宽 78.23 / 内容宽 79）。
   而 text-overflow: ellipsis 的触发条件是 scrollWidth > clientWidth，
   **亚像素级的收缩就足以命中** ⇒ 最后一个字被换成「…」，
   视觉上和「整段被截」一样严重。

   ⚠️ 更坑的是**量不出来**：clientWidth 取整，53.97 报成 54，
   于是 scrollWidth > clientWidth 判为 false —— 我用它写的「数字是否完整」
   断言一路全绿，而截图里明明白白写着「347.87积…」。
   教训：判断省略号要看**截图**或用小数宽度（getBoundingClientRect），
   不能用取整后的 clientWidth。

   ⚠️ 类名刻意**不叫 .dim-jh-badgeValue**：那个名字已被弹窗读数占用，且那条规则
   （font-weight:600）排在样式表更后面 —— 同名会让胶囊数字被静默加粗。

   ⇒ 读数恒定完整；全部收缩由 .dim-jh-badgeDetail(999) 与 .dim-jh-badgeName(99)
   承担，两者最坏缩到 0 也放得下（读数最宽约 97px + 分隔符与内边距 ≈ 131px
   < 186px 上限）。 */
.dim-jh-badgeReading { flex: none; min-width: 0; white-space: nowrap; }
/* 「这个读数不完整」的标记（合计少算了账号时才出现），排在读数**之后**。
   ⚠️ 必须与读数同级 flex: none：它是**补语**，被省略号吃掉就等于没标 —— 而它要
   提醒的恰恰是「别把这个数字当真」，看不见比不标更糟。
   ⚠️ 用 warn 而不是 error：账号读不到多半是临时的（凭据过期 / 网络抖动），
   error 是留给「整个渠道都不可用」的（那会走 empty 模式）。
   字号小一档并压紧行高，让它读起来像角标而不是读数的一部分。 */
.dim-jh-badgeWarn { flex: none; font-size: 10px; line-height: 1; color: var(--dsw-alias-state-warn-primary); cursor: help; }

/* ② 窄屏收敛：只留状态点，文字与 chevron 让位给模型选择器。
 * 阈值 720px 是实测桌面版在 100% 缩放下「徽标 216px + 模型选择器 ≥ 240px」的临界值。
 * ⚠️⚠️ 本段的**位置**是功能性的，不要为了排版把它挪到 .dim-jh-badgeText 之前：
 * 它与 ".dim-jh-badgeText { display: flex }" 特异性相同（都是单个类），
 * 靠**源顺序**决定胜负 —— 一旦被排到前面，窄屏下 display:none 会被
 * 后面的 display:flex 覆盖，文字重新出现并挤压模型选择器（静默回归）。 */
@media (max-width: 720px) { .dim-jh-badgeText, .dim-jh-badgeBtn > svg, .dim-jh-badgeBtn > .dim-jh-badgeChevron { display: none; } .dim-jh-badgeBtn { max-width: none; padding: 2px 6px; } }
.dim-jh-badgeDot { width: 5px; height: 5px; flex: none; border-radius: 999px; background: var(--dsw-alias-state-success-primary); }
.dim-jh-badgeDot[data-tone="warn"] { background: var(--dsw-alias-state-warn-primary); }
.dim-jh-badgeDot[data-tone="error"] { background: var(--dsw-alias-state-error-primary); }
.dim-jh-badgeDot[data-tone="muted"] { background: var(--dsw-alias-label-tertiary); }
.dim-jh-badgePop { position: absolute; bottom: calc(100% + 8px); right: 0; z-index: 40; width: 280px; max-width: min(280px, 86vw); max-height: 58vh; overflow-y: auto; display: flex; flex-direction: column; padding: 9px 10px 10px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 11px; background: var(--dsw-alias-bg-layer-1); box-shadow: 0 1px 2px rgba(0, 0, 0, .06), 0 8px 24px rgba(0, 0, 0, .14); text-align: left; white-space: normal; }
/* 窄屏时徽标只留状态点，弹窗也随之收窄（否则它会盖住模型选择器）。
 * 宽度写 min() 而非媒体查询覆盖：弹窗是 absolute，媒体查询命中时按钮虽已
 * 收窄，但弹窗仍按 280px 渲染会显得与触发点不匹配。 */
@media (max-width: 720px) { .dim-jh-badgePop { width: 220px; max-width: min(220px, 76vw); } }
.dim-jh-badgeHead { display: flex; align-items: center; gap: 5px; padding-bottom: 7px; }
.dim-jh-badgeTitle { flex: none; max-width: 118px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dim-jh-badgeAt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
/* 刷新：默认**无边框无底色**（降低视觉重量），hover 才浮起；文字说明放 title/aria-label
   ⚠️ 2026-10-02 用户反馈「浅色模式下按钮和线条不太明显」：这里从「完全透明」
   改回**主题描边 + layer-2 底**（浅色下 layer-2 与弹窗底色太接近，靠描边才立得住）。 */
.dim-jh-badgeRefresh { flex: none; width: 20px; height: 20px; display: grid; place-items: center; border: .5px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 1; cursor: pointer; transition: color .15s ease, background .15s ease, border-color .15s ease; }
.dim-jh-badgeRefresh:hover:not(:disabled) { border-color: color-mix(in srgb, #1677ff 45%, var(--dsw-alias-border-l2)); background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-brand-primary); }
.dim-jh-badgeRefresh:disabled { opacity: .5; cursor: default; }
/* 自动签到状态灯：与刷新键**同尺寸同描边**（浅色下靠描边才立得住），紧挨它左侧。
   ⚠️ 状态**不只用颜色**表达：灯本身有形态差异（关=空心环 / 开=实心点 /
   今天已跑=实心点带外环 / 进行中=省略号），且 title 与 aria-label 都带完整文字说明，
   故色觉障碍与读屏都能分辨「开还是关、今天跑没跑」。 */
.dim-jh-badgeAuto { flex: none; width: 20px; height: 20px; display: grid; place-items: center; border: .5px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 12px; line-height: 1; cursor: pointer; transition: color .15s ease, background .15s ease, border-color .15s ease; }
.dim-jh-badgeAuto:hover { border-color: color-mix(in srgb, #1677ff 45%, var(--dsw-alias-border-l2)); background: var(--dsw-alias-bg-layer-3); }
.dim-jh-badgeAutoDot { width: 7px; height: 7px; box-sizing: border-box; border-radius: 999px; background: transparent; border: 1.5px solid currentColor; }
.dim-jh-badgeAuto[data-state="on"],
.dim-jh-badgeAuto[data-state="done"] { color: var(--dsw-alias-state-success-primary); }
.dim-jh-badgeAuto[data-state="on"] .dim-jh-badgeAutoDot,
.dim-jh-badgeAuto[data-state="done"] .dim-jh-badgeAutoDot { background: currentColor; border: 0; }
.dim-jh-badgeAuto[data-state="done"] .dim-jh-badgeAutoDot { box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-success-primary) 28%, transparent); }
.dim-jh-badgeAuto[data-running="true"] { color: var(--dsw-alias-brand-primary); }
/* ⚠️ 这里曾有一枚「自动签到 已关闭 / 今天已完成」的小胶囊（右对齐在签到按钮上方）。
   用户 2026-10-02 反馈「新加的这个感觉有点不是太好看」，改为在「全部渠道签到」
   按钮文案后加「（自动）」后缀（只在开关打开时加）⇒ 相关样式整段删除。
   状态本身的说明仍由右上角状态灯的 title 承载。 */
/* **常驻**的自动签到状态文字（用户 2026-10-02：自动签到下也要显示各渠道状态，
   但**不要自动消失**，改为手动关闭 ⇒ 小按钮在文字**上方**）。
   ⚠️ 与 .dim-jh-badgeNotice（手动签到结果，8s/20s 自动消失）是两种语义，
   样式刻意区分：这里用中性底 + 细描边（「状态」），那里用带色调的提示块（「回执」）。 */
.dim-jh-badgeAutoStatus { margin-top: 5px; padding: 5px 6px 6px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 7px; background: var(--dsw-alias-bg-layer-2); }
.dim-jh-badgeAutoCloseRow { display: flex; justify-content: flex-end; margin-bottom: 2px; }
.dim-jh-badgeAutoClose { width: 14px; height: 14px; display: grid; place-items: center; border: .5px solid var(--dsw-alias-border-l2); border-radius: 4px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 10px; line-height: 1; cursor: pointer; transition: color .15s ease, background .15s ease, border-color .15s ease; }
.dim-jh-badgeAutoClose:hover { border-color: color-mix(in srgb, #1677ff 45%, var(--dsw-alias-border-l2)); background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-brand-primary); }
.dim-jh-badgeAutoStatusHead { font-size: 10.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.dim-jh-badgeAutoChannels { display: flex; flex-wrap: wrap; gap: 2px 5px; margin-top: 3px; font-size: 10px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); }
/* 分隔符跟在条目**后面**（不是用 ::before 加在下一个前面）：十余个渠道在 280px 里必然
   换行，::before 的写法会让换行处那一行**以孤立的点开头**（预览里实测到了）；
   ::after 则表现为行尾的「·」，与行内文本的分隔习惯一致。
   ⚠️ 刻意不写死渠道数：原文写「9 个」，加 minimaxintl 后已是 10 个（2026-10-16 审计）。 */
.dim-jh-badgeAutoChannel:not(:last-child)::after { content: " ·"; opacity: .6; }
/* 偏好：分段控件（未选中透明、选中浮起），比三个独立胶囊更紧凑整齐 */
.dim-jh-badgePref { display: flex; gap: 2px; padding: 2px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 7px; background: var(--dsw-alias-bg-layer-2); }
.dim-jh-badgePrefBtn { flex: 1; min-width: 0; padding: 2px; border: 0; border-radius: 5px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 10px; line-height: 1.5; white-space: nowrap; cursor: pointer; transition: background .15s ease, color .15s ease; }
.dim-jh-badgePrefBtn:hover { color: var(--dsw-alias-label-primary); }
/* 选中项自带描边：浅色下只靠白色底与底色区分太弱 */
.dim-jh-badgePrefBtn[aria-pressed="true"] { border: .5px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, var(--dsw-alias-border-l2)); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-brand-primary); font-weight: 600; box-shadow: 0 1px 2px rgba(0, 0, 0, .06); }
/* 分区：细分隔线分组，间距 5px（比 4px 多 1px 呼吸：账号备注是 10px 灰字，
   紧贴下一个账号名会读成同一块；再大就不「小巧」了）
   ⚠️ 分隔线用**全不透明**的 border-l2：此前用 color-mix 降到 75%，浅色下几乎看不见。 */
.dim-jh-badgeSection { display: flex; flex-direction: column; gap: 5px; margin-top: 7px; padding-top: 7px; border-top: .5px solid var(--dsw-alias-border-l2); }
.dim-jh-badgeSectionTitle { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: 10px; font-weight: 600; letter-spacing: .02em; color: var(--dsw-alias-label-tertiary); }
.dim-jh-badgeSectionSum { font-weight: 600; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.dim-jh-badgeRow { display: flex; flex-direction: column; gap: 1px; }
/* 一行放下「名字 …… 数值」（名字可省略号，数值不换行） */
.dim-jh-badgeRowHead { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: 11px; color: var(--dsw-alias-label-primary); }
.dim-jh-badgeRowName { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dim-jh-badgeRowNote { font-size: 10px; line-height: 14px; color: var(--dsw-alias-label-tertiary); }
/* 分桶说明的**逐段带色**（用户 2026-10-12：永久绿 / 长期黄 / 临期红 + 倒计时）。
   ⚠️ 颜色语义与 credit-expiry.js 的 expirySplitParts 一一对应，改一处要改两处：
     permanent（服务端没给到期时间，真·永久）→ ok 绿
     longTerm（有到期时间但还早）              → warn 黄
     expiring（窗口内，再不用就作废）          → error 红
   ⚠️ 用 tone 变量而不是硬编码色值：深浅色主题各自有定义（与 .dim-jh-badgeDot 同源）。 */
.dim-jh-badgeNotePart { font-variant-numeric: tabular-nums; }
.dim-jh-badgeNotePart[data-tone="ok"] { color: var(--dsw-alias-state-success-primary, #15803d); }
.dim-jh-badgeNotePart[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary, #b45309); }
.dim-jh-badgeNotePart[data-tone="error"] { color: var(--dsw-alias-state-error-primary, #d93025); }
.dim-jh-badgeNotePart[data-tone="muted"] { color: var(--dsw-alias-label-tertiary); }
.dim-jh-badgeNoteSep { color: var(--dsw-alias-label-tertiary); }
/* 窗口：**一行**放下 名称 / 进度条 / 百分比 / 重置倒计时。
   ⚠️ 用户 2026-10-02 明确口径（附截图）：「像两边对齐，但进度条要一样长，文字部分
   左右分别对齐」⇒ 用**共享列宽的 grid**（不是整块居中、也不是每行各自 flex）：
   - 列 1 max-content：标签统一按最宽那个对齐，**靠左**，于是三行进度条起点也一致；
   - 列 2 minmax(60px, 1fr)：进度条吃掉剩余宽度 ⇒ 三行**等长**且自适应；
   - 列 3 max-content：百分比紧跟在条后；
   - 列 4 固定 100px + text-align: right：倒计时**贴右边缘**，各行对齐。
   （早先试过「整块居中 + 固定 64px 条」——被否掉：那样两侧不对齐。） */
.dim-jh-badgeWins { display: grid; grid-template-columns: max-content minmax(60px, 1fr) max-content 100px; align-items: center; gap: 4px 6px; }
.dim-jh-badgeWin { display: contents; }
.dim-jh-badgeWinLabel { font-size: 10.5px; color: var(--dsw-alias-label-secondary); text-align: left; white-space: nowrap; }
.dim-jh-badgeWin .dim-jh-quotaBar { height: 3px; }
.dim-jh-badgeWinReset { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; color: var(--dsw-alias-label-tertiary); text-align: right; }
.dim-jh-badgeValue { flex: none; font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
.dim-jh-badgeValue[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); font-weight: 500; }
.dim-jh-badgeNote { font-size: 10px; line-height: 14px; color: var(--dsw-alias-label-tertiary); }
/* 签到：两个按钮并排、等分（本渠道按钮在不支持签到时不渲染，另一个占满整行）
   ⚠️ 保留 .5px 主题描边：浅色下 layer-2 底与弹窗底色几乎同色，无描边就看不出是按钮。 */
.dim-jh-badgeClaim { gap: 5px; }
.dim-jh-badgeClaimRow { display: flex; gap: 5px; }
.dim-jh-badgeAction { flex: 1; min-width: 0; padding: 3px 7px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 7px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: 10.5px; line-height: 1.5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; transition: background .15s ease, color .15s ease, border-color .15s ease; }
.dim-jh-badgeAction:hover:not(:disabled) { border-color: color-mix(in srgb, #1677ff 45%, var(--dsw-alias-border-l2)); background: color-mix(in srgb, #1677ff 10%, var(--dsw-alias-bg-layer-2)); color: var(--dsw-alias-brand-primary); }
.dim-jh-badgeAction:disabled { opacity: .55; cursor: default; }
.dim-jh-badgeNotice { font-size: 10px; line-height: 14px; color: var(--dsw-alias-label-secondary); }
.dim-jh-badgeNotice[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); }
.dim-jh-badgeFail { font-size: 10px; line-height: 14px; color: var(--dsw-alias-state-error-primary); }
.dim-jh-badgeFoot { font-size: 10px; line-height: 14px; color: var(--dsw-alias-label-tertiary); }
/* 「展开其余 N 个账号」/「收起」：纯文字按钮，左对齐、不占满宽。
   ⚠️ 刻意**不复用** .dim-jh-badgeAction：那条规则是 flex:1 的实心按钮（用于签到），
   放在明细列表下面会抢走视觉焦点 —— 用户要的是「明细可以收起来」，不是一个主操作。
   align-self: flex-start 是因为父容器 .dim-jh-badgePop 是 flex 列（默认 stretch）。 */
.dim-jh-badgeMore { align-self: flex-start; margin-top: 3px; padding: 1px 0; border: 0; background: none; font: inherit; font-size: 10px; line-height: 1.6; color: var(--dsw-alias-link); cursor: pointer; }
.dim-jh-badgeMore:hover { color: var(--dsw-alias-brand-primary); text-decoration: underline; }

/* ── 聚合 provider 的面板（AggregatePanel）──
   ⚠️ 本文件是模板字符串 ⇒ 注释里**禁止反引号**（会提前闭合）。
   ⚠️ 带属性选择器的规则必须放在**基础规则之后**（model-filter.spec.ts 的 ruleOf()
      按源码顺序取第一条匹配规则，写在前面会让它误取到新块、跳过基础规则）。 */
.dim-jh-aggPanel { flex: 1 1 auto; min-height: 0; padding: 16px 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
/* ⚠️⚠️ 面板的**直接内容子项必须 flex: none**（真实缺陷，用户 2026-10-27 报障
   「聚合页模型列表显示异常」：22 个聚合模型的每行都被压成几像素高的细线，
   右侧只剩一片横线，一个字都看不见）。
   根因链：2026-10-26 的账号页重排给本容器加了 flex: 1 1 auto + min-height: 0
   （目的：让面板自己滚，而不是把滚动条推给外层 .dim-jh-panel）——但本容器
   同时还是 display: flex / flex-direction: column，于是它成了「高度受限的
   纵向 flex 容器」，而**子项默认 flex-shrink: 1 会在内容超高时被压缩**，
   不是溢出。.dim-jh-aggModel 又带 overflow: hidden ⇒ 它的 min-height: auto
   自动下限**失效**，能被一路压到 0 高。
   ⇒ 约束高度 + 子项不收缩 + overflow-y: auto，三者齐备才是「内容保持原高、
     超出就滚动」。
   ⚠️ **不得用通配符 .dim-jh-aggPanel > * **。
   ⚠️ 2026-10-28 审计更正：原先这里写的理由是「会把 .dim-jh-aggCount 一起钉死」——
   那是**错的**：aggCount 是 .dim-jh-aggToolbar 的**孙节点**，子代组合器 > *
   根本选不到它（flex-basis: 100% 的换行不受影响）。
   真实理由两条：① 逐类名让「本面板有哪些直接子项」在 CSS 里**可读、可与渲染树对照**；
   ② 通配符会把**将来**新增的直接子项也一并钉成 flex: none —— 若新子项需要收缩
   （例如一条可压缩的提示条），它会静默失去弹性。 */
.dim-jh-aggPanel > .dim-jh-aggIntro,
.dim-jh-aggPanel > .dim-jh-aggToolbar,
.dim-jh-aggPanel > .dim-jh-aggNotice,
.dim-jh-aggPanel > .dim-jh-aggEmpty,
.dim-jh-aggPanel > .dim-jh-aggModel,
.dim-jh-aggPanel > .dim-jh-aggFooter { flex: none; }
.dim-jh-aggIntro { display: flex; flex-direction: column; gap: 4px; }
.dim-jh-aggTitle { margin: 0; font-size: 16px; font-weight: 600; color: var(--dsw-alias-label-primary, #1a1a1a); }
.dim-jh-aggIntroLine { margin: 0; font-size: 12px; line-height: 1.7; color: var(--dsw-alias-label-secondary); }
.dim-jh-aggIntroWarn { margin: 0; font-size: 12px; line-height: 1.7; color: var(--dsw-alias-label-tertiary); }
/* ⚠️⚠️ 工具行必须**允许换行**（真实缺陷，用户 2026-10-16 验收截图）：
   原本是 display: flex 且默认 nowrap ⇒ 面板一窄，「排序：按临期」/「拒绝非临期」
   这些多字按钮被压到只剩几个字符宽，**文字竖排**逐字折行（截图里正是那样）。
   ⇒ flex-wrap: wrap 让它们换行，而不是被压扁。
   ⚠️ 本文件是模板字符串：注释里**绝不能出现反引号**（会提前闭合模板，报错却指向
   注释那一行，看起来像 CSS 写错了 —— AGENTS.md 有专条记录，我这次又踩了一次）。 */
.dim-jh-aggToolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
/* ⚠️ 计数**独占一行**（用户 2026-10-16：「43 个聚合模型应该显示在按钮下面」）。
   两道措施：
   ① HTML 里它排在全部按钮**之后**（见 jet-hub.js 的工具行注释）；
   ② 这里给 flex-basis: 100% —— 强制换行到下一行，而不是「面板够宽时又跑到按钮右侧」。
      用户要的是**位置**（在按钮下面），不是「窄的时候才换行」。
   order: 1 是纵深防御：即使将来有人把它的 HTML 顺序挪回前面，它仍排在按钮之后。 */
.dim-jh-aggCount { flex-basis: 100%; order: 1; font-size: 12px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
/* ⚠️⚠️ 工具栏的按钮**不再有自己的样式类**（2026-10-16，用户第二次验收）。
   原先这里是自造的 .dim-jh-aggRefresh / .dim-jh-aggBtn（圆角 6px、无背景色、
   primary 只是描边变蓝），与全站标准按钮 .dim-jh-btn（圆角 8px、有底色、
   hover 变蓝、primary = 实心蓝底白字）**形态不一致** ⇒ 用户看到的是
   「拒绝非临期和切换排序为什么还是没有按按钮样式（图2）显示」。
   ⇒ 聚合工具栏与「保存顺序」现已统一用 .dim-jh-btn（那里自带 nowrap 与 :disabled），
     本处两个自造类**已删除**（零使用者的死样式是本仓库红线）。
   ⚠️ 唯一保留的自定义：工具行本身的 .dim-jh-aggToolbar（flex-wrap）与计数样式。 */
.dim-jh-aggNotice { padding: 6px 10px; border-radius: 6px; font-size: 12px; color: var(--dsw-alias-label-error, #c0392b); background: var(--dsw-alias-bg-error, rgba(192, 57, 43, 0.08)); }
.dim-jh-aggEmpty { padding: 12px; font-size: 12px; line-height: 1.7; color: var(--dsw-alias-label-secondary); }
/* ⚠️ 原先这里还有 .dim-jh-aggGroup / .dim-jh-aggGroupTitle（厂商分组标题），
   已按用户 2026-10-07 的要求删除 —— 渠道维度信息在**展开后的子列表**里逐条显示，
   分组标题冗余（且其中的「(2)/(5)」是**模型个数**，容易被误读成渠道个数）。
   ⚠️ 本文件的样式整体是一个模板字符串 —— 注释里**不能出现反引号**（会提前终止，
   有专门用例守着：usage-badge-client.spec.ts / zcode-channel-dialog.spec.ts）。 */
/* ⚠️ 模型块是这一页**唯一的重复单元**（22 个平铺），它的观感就是整页的观感。
   ⇒ 底色 / 边框 / 悬停 / 展开态四件套都在这几处定，别散落到别处去覆盖。
   「transition」 同时过渡边框与阴影：展开瞬间的抬升要有过程，不能是跳变。 */
.dim-jh-aggModel { border: 1px solid var(--dsw-alias-border-secondary); border-radius: 8px; overflow: hidden; background: var(--dsw-alias-bg-layer-1, #fff); transition: border-color .15s ease, box-shadow .15s ease; }
/* 悬停：边框提亮 + 一层极淡投影（暗示「这一块整体是一个可点单元」）。
   ⚠️ 阴影必须**极淡**（7% 以内）：22 个块若同时带明显投影，整页会发灰。 */
.dim-jh-aggModel:hover { border-color: var(--dsw-alias-border-l2, #d0d3d8); box-shadow: 0 1px 4px rgb(31 35 41 / 7%); }
/* 展开态：边框转品牌色 + 阴影加深 + **模型头底色加一层淡蓝**。
   ① 边框用 brand 而不是更深的灰 —— 22 个块里只有一个展开，
      要让它在滚动的长列表里**一眼能定位**（用户滚到中间时不至于找不到自己在看哪块）。
   ② 头部底色与边框同源（brand 6%）：单独染边、不染头会显得「框是框、内容是内容」。
   ③ 展开态优先于悬停，但两条腿的**取胜机制不同**（2026-10-28 审计更正）：
      · 边框 / 阴影：与 :hover **同特异性**（都是 (0,2,0)），靠**顺序在后**取胜；
      · 模型头底色：展开态那条写在 :hover **之前**，靠**特异性**取胜
        （[data-open=true] > .dim-jh-aggModelHead = (0,3,0)
        > .dim-jh-aggModelHead:hover = (0,2,0)）。
      ⇒ 别把「顺序在后」当成这两条的共同前提：底色那条挪到 hover 之后结果**不变**；
        它真正不能动的是**特异性**（少一个类名就会输给 hover）。 */
.dim-jh-aggModel[data-open='true'] { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #1677ff) 45%, var(--dsw-alias-border-secondary)); box-shadow: 0 2px 8px rgb(22 119 255 / 10%); }
.dim-jh-aggModel[data-open='true'] > .dim-jh-aggModelHead { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #1677ff) 6%, transparent); }
/* 模型平铺后的行间距：原先由 .dim-jh-aggGroup 的 gap: 4px 提供，分组去掉后
   改由相邻兄弟选择器承担（与 .dim-jh-railGroup + .dim-jh-railGroup 同一模式）。 */
.dim-jh-aggModel + .dim-jh-aggModel { margin-top: 4px; }
/* 模型头：整块唯一的常驻行，高度与字号是这一页的「节奏基准」。
   ⚠️ padding 从 7px 提到 9px：22 行的列表里，行高过密会让点击目标过小
   （用户要连点十几下才能展开自己关心的模型）。9px + 13px 字号 ≈ 33px 行高，
   仍显著小于左栏 rail 的 48px，不会把列表撑得过分松散。 */
.dim-jh-aggModelHead { display: flex; align-items: center; gap: 8px; width: 100%; padding: 9px 10px; border: 0; background: none; font: inherit; font-size: 13px; text-align: left; color: var(--dsw-alias-label-primary); cursor: pointer; transition: background .15s ease; }
/* ⚠️ 悬停底色**必须弱于**展开态的 brand 6%：否则鼠标一划过，
   展开块与未展开块看起来一模一样，「data-open」 那层染色就白做了。 */
.dim-jh-aggModelHead:hover { background: var(--dsw-alias-bg-secondary, rgba(0, 0, 0, 0.03)); }
/* 模型名：这一行唯一吃剩余宽度的一格。
   ⚠️ 字重 500 而不是 600 —— 22 个块个个加粗会让整页看起来「到处都在喊」，
   而这里确实只有模型名值得这一档。 */
.dim-jh-aggModelName { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
/* 「候选全部未参与轮换」提示（规格 §5.2 要求显式提示，避免用户以为模型坏了）。
   ⚠️ 用 warning 色与说明文字区分开（它是**需要注意**的状态）。
   ⚠️⚠️ 2026-10-16（用户验收：「占太宽了把模型名字都挤没了」）三道防线：
   - 文案已缩到 ≤5 个汉字（解释性文字移进 title）；
   - white-space: nowrap 让帽子**不换行**（换行会变两行高、且吃掉模型名宽度）；
   - max-width: 40% + 省略号，帽子不得无限撑开。
   模型名那一格是 flex: 1 / min-width: 0，故剩余宽度全归它（超长才省略号）。 */
.dim-jh-aggAllRejected { flex: none; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 1px 6px; border-radius: 4px; font-size: 11px; color: var(--dsw-alias-state-warn-primary, #b45309); background: var(--dsw-alias-bg-warn, rgba(180, 83, 9, 0.10)); }
/* 展开箭头：字符「▸」换成了 svg（用户 2026-10-27「美化聚合页模型列表」）。
   ⚠️ 之所以换 svg 而不是继续用字符：字符版**没有中间态**，展开时是从
   「▸」直接跳到「▾」，在高频点击的模型列表里显得很廉价；svg 走 transform
   旋转就有过渡。这也是全站图标化的既有口径（删除 / 刷新 / 模型 都是 svg）。
   ⚠️ 尺寸必须**钉死** 14px：svg 自带 12px，若不给容器定宽，「place-items: center」
   下它会与 13px 的文字基线对不齐，箭头看着偏上。 */
.dim-jh-aggChevron { flex: none; display: grid; place-items: center; width: 14px; height: 14px; color: var(--dsw-alias-label-tertiary); transition: transform .15s ease, color .15s ease; }
.dim-jh-aggModel[data-open='true'] > .dim-jh-aggModelHead > .dim-jh-aggChevron { transform: rotate(90deg); color: var(--dsw-alias-brand-primary, #1677ff); }
.dim-jh-aggCandidates { display: flex; flex-direction: column; border-top: 1px solid var(--dsw-alias-border-secondary); }
/* 候选行的行距（用户 2026-10-27「美化聚合页模型列表」）。
   ⚠️ 从 5px 提到 6px：分成四格之后横向元素变多，行与行贴太近时
   「哪一格属于哪一行」会看不出来（尤其是倍率徽章有底色，视觉重量比纯文字大）。
   ⚠️ 左内距 20px 是留给拖动柄的；拖动柄只在手工模式下出现，
   但**不能**因此把左内距改成条件式的 —— 那会让模式切换时整列文字左右横跳。 */
.dim-jh-aggCandidate { display: flex; align-items: center; gap: 6px; padding: 6px 10px 6px 20px; font-size: 12px; }
.dim-jh-aggCandidate + .dim-jh-aggCandidate { border-top: 1px solid var(--dsw-alias-border-tertiary, rgba(0, 0, 0, 0.04)); }
/* 悬停的高亮：这一页要「逐条比较渠道」，鼠标必须能确认自己停在哪一行。
   ⚠️ 用极淡底色而不是改边框 —— 候选行之间已有 1px 分隔线，
   再加边框会出现双线（视觉上像分组，而不是同行）。
   ⚠️ 必须在 .dim-jh-aggCandidateRejected 之前定义？不需要：opacity 是另一属性，
   两者叠加（未参与的候选悬停 = 淡底色 + 0.55 透明度）正是想要的效果。 */
.dim-jh-aggCandidate:hover { background: var(--dsw-alias-bg-secondary, rgba(0, 0, 0, 0.03)); }
.dim-jh-aggCandidateRejected { opacity: 0.55; }
/* 候选行里的供应商图标（2026-10-26）。
   ⚠️ 基类 30px 是给左栏 48px 按钮的；这一行 padding 只有 6px、字号 12px，
   照搬会把行高从 28px 撑到 40px，14 个模型的候选列表当场变长一倍。
   ⚠️ 这里**不需要**额外的淡出规则：未参与的候选整行走 .dim-jh-aggCandidateRejected
   的 opacity，图标作为子节点自然一起淡（与模型列表那处不同 —— 那边只淡了文字格）。 */
.dim-jh-aggCandidate > .dim-jh-providerIcon { flex: none; width: 18px; height: 18px; border-radius: 5px; box-shadow: none; }
.dim-jh-aggCandidate > .dim-jh-providerIcon img { width: 13px; height: 13px; }
/* ── 候选行的文字四格（用户 2026-10-27「美化聚合页模型列表」）──
   ⚠️⚠️ 改造前这里只有一条 .dim-jh-aggCandidateLabel，里面放整串
   「渠道名 · 模型 id · 倍率」—— 三者同色、同字号、同权重。
   而这一页的**唯一用途**就是逐条比较渠道，最该被一眼分辨的恰恰是
   「哪家渠道」和「哪个模型」，倍率只是附注。同权渲染让整列看起来
   是一堆等长的灰点，用户报障原话就是「美化聚合页模型列表」。
   ⇒ 拆成四格 + 四种视觉层级：渠道（次要色/小字/不换行）、模型 id
   （主要色/等宽数字/吃剩余宽度）、倍率（圆角徽章）、补丁（警示角标）。

   .dim-jh-aggCandidateLabel 仍是**外层容器**（类名不变）：
   「provider-icon-coverage.spec.ts」 用它在源码里的位置当锚点，
   换掉名字会让那条「图标必须在标签之前」的用例失去判据。 */
.dim-jh-aggCandidateLabel { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 6px; overflow: hidden; color: var(--dsw-alias-label-secondary); }
/* 渠道名：三格中**最次要**的一格。
   ⚠️ flex: none + max-width 28%：渠道名长度差异极大（「buddy」 5 字符、
   「workbuddy」 9、「astudio」 7），若允许它参与压缩，同一页里每行的
   「模型 id 起始位置」就会错落 —— 对比渠道时眼睛要来回找起点了。
   钉住它、把弹性全给模型 id。
   ⚠️ 2026-10-28 审计更正：这**不产生跨行对齐** —— 实测各行「模型 id 起始位置」随
   渠道名长度错落，最多差 **38px**（flex: none 让渠道格 = 内容宽，本来就各不相同）。
   真要跨行对齐，得给渠道格一个**固定宽度**（不是 max-width）。 */
.dim-jh-aggCandidateProvider { flex: none; max-width: 28%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
/* 模型 id：本行**唯一**吃剩余宽度的一格。
   ⚠️ font-variant-numeric: tabular-nums 与字号 12px：模型 id 里数字很多
   （「deepseek-v4.1-flash」、「glm-4.6」），等宽数字能让上下列的版本号对齐。
   ⚠️ min-width: 0 不可省 —— 少了它，flex 项的最小尺寸是内容宽度，
   ellipsis 永远不触发，长 id 会把右侧的到期提示与开关挤出可视区。 */
.dim-jh-aggCandidateId { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
/* 倍率徽章：观感沿用全站 .dim-jh-badgeBtn 的胶囊口径（999px 圆角 / 11px / .5px 边框），
   但**不共用类名** —— 那个类名带 cursor:pointer，而这里只是一枚只读读数。
   ⚠️ flex: none：徽章宽度由内容决定，不能被模型 id 那种弹性挤变形。 */
.dim-jh-aggCandidatePrice { flex: none; padding: 1px 7px; border: .5px solid var(--dsw-alias-border-l2, #d0d3d8); border-radius: 999px; background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.03)); font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary); white-space: nowrap; font-variant-numeric: tabular-nums; }
/* 「免费」（倍率 0）：它与「x0.15」不是同一类信息 —— 前者是**该渠道不计费**，
   后者是折扣。用 success 色区分，否则用户会把「免费」当成倍率恰好为 0 的折扣。 */
.dim-jh-aggCandidatePrice[data-free='true'] { color: var(--dsw-alias-state-success-primary, #16a34a); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #16a34a) 40%, transparent); }
/* 补丁角标：规格 §7.1 要求人工核查的来源标记。
   ⚠️ 只有 viaPatch 的候选才有，所以必须 flex: none —— 它出现与否会改变
   本行星级的宽度分配，若允许它伸缩，同一模型的不同候选行的模型 id 宽度会不一致。
   ⚠️ 用 warning 色而非 error 色：补丁不是错误，是需要核查。 */
.dim-jh-aggCandidatePatch { flex: none; padding: 1px 6px; border-radius: 4px; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-state-warn-primary, #b45309); background: var(--dsw-alias-bg-warn, rgba(180, 83, 9, 0.10)); white-space: nowrap; }
/* 「按临期排序」后显示在候选行右侧的到期提示（相对时间，如「3 天」）。
   ⚠️ flex: none 让它不参与压缩（候选名那一格已经 flex:1 吃掉剩余宽度）。 */
.dim-jh-aggCandidateExpiry { flex: none; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.dim-jh-aggToggle { flex: none; padding: 2px 8px; border: 1px solid var(--dsw-alias-border-secondary); border-radius: 5px; background: none; font: inherit; font-size: 11px; color: var(--dsw-alias-link); cursor: pointer; }
.dim-jh-aggToggleOff { color: var(--dsw-alias-label-tertiary); text-decoration: line-through; }
/* ⚠️⚠️ 下面三组样式已**删除**（用户 2026-10-16 验收要求，别再写回来）：
   - .dim-jh-aggSegmented / .dim-jh-aggSeg / .dim-jh-aggSegOn：两段式排序 toggle
     ⇒ 改成**单个切换按钮**（照「锁定永久积分」的形态，激活态用 data-kind="primary"）。
     两段在窄面板下各占一列，会把工具行挤成**竖排文字**（同一个验收截图里的现象）。
   - .dim-jh-aggMove / .dim-jh-aggMove:disabled：上移/下移按钮
     ⇒ 用户明确要求「我们不应该有上下箭头就是应该鼠标拖动」。
     ⚠️ 拖动本身在此前是**坏的**（onDragStart 漏了 dataTransfer.setData ⇒
     浏览器不触发拖拽），所以那时只有箭头能用 —— 修好拖动后才删箭头。
   - .dim-jh-aggModelMeta：模型头的「N 个渠道 · 按渠道名/按临期」
     ⇒ 当前排序模式由顶部按钮表达，模型头不再重复（用户要求「可以不用显示」）。
   拖动相关样式保留：手柄与落点高亮仍是拖拽的**可发现性**信号。
   ⚠️ 本文件是模板字符串：注释里**绝不能出现反引号**（AGENTS.md 专条记录）。 */
/* 拖动手柄（只有「按手工」模式下的参与候选才有）。
   ⚠️ cursor: grab 是主要的可发现性信号（整行可拖时用户不知道能拖）。 */
.dim-jh-aggDragHandle { flex: none; cursor: grab; color: var(--dsw-alias-label-tertiary); font-size: 12px; user-select: none; }
.dim-jh-aggDragOver { outline: 1px dashed var(--dsw-alias-border-secondary); outline-offset: -1px; }
/* 未参与轮换的候选段（手工模式）：与参与段视觉分开，但仍留在同一个模型块里
   —— 用户要能一眼看到「还有哪些没打开」。 */
.dim-jh-aggInactiveSection { display: flex; flex-direction: column; border-top: 1px dashed var(--dsw-alias-border-secondary); }
.dim-jh-aggInactiveTitle { padding: 5px 10px 2px 20px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.dim-jh-aggOrderActions { display: flex; justify-content: flex-end; gap: 6px; padding: 6px 10px; border-top: 1px solid var(--dsw-alias-border-secondary); }
/* ⚠️ 原先这里还有 .dim-jh-aggBtn（「保存顺序」按钮），已删除 —— 改用全站标准
   .dim-jh-btn（理由见上面工具栏那段注释）。零使用者的死样式是本仓库红线。 */
.dim-jh-aggFooter { display: flex; flex-direction: column; gap: 2px; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-secondary); }
.dim-jh-aggFooter p { margin: 0; font-size: 11px; line-height: 1.7; color: var(--dsw-alias-label-tertiary); }

/* ── Accio：**没有**专属样式 ──
   ⚠️ 2026-10-13 删除了原先的「专属积分区」整段（dim-jh-accioPanel /
   accioHead / accioAccount* / accioCountdown / accioBuckets* 共 12 条）。
   原因：用户报障「accio 的显示和别的 provider 没统一，例如 loomy 的」——
   accio 原先另起一个独立区块，现改为与 loomy 同形（积分行直接进账号卡片，
   三类桶由 formatNamedPoolLine 逐池列出、倒计时作为同一行内的附注）。
   ⇒ 那 12 条样式已零引用，留着就是死代码（且会让人以为还有那个面板）。
   ⚠️ 图标底色 .dim-jh-providerIcon.accio 在文件上方，**仍在用**，别一起删。
   ⚠️ 本文件整体是模板字符串：注释里**绝不能出现反引号**（会提前闭合，
   esbuild 的报错会指向注释行、看起来像 CSS 写错）。本条注释就曾踩过。 */

/* ── 窄屏（手机 / 远程访问，max-width 720px）──
   POC（2026-10-17）：本插件此前**只有弹窗内部**有 3 处 media 查询，主布局
   .dim-jh-layout 是写死的左右两栏且 .dim-jh-rail 固定 228px —— 手机宽度约
   400px 时右面板只剩约 76px 可用，于是面板被压成一条窄缝、操作按钮被裁断、
   中文提示逐字竖排。
   修法：窄屏下改为**上下两段** —— 左栏降级为顶部横向可滑动的标签条，
   右面板获得整宽。**只新增本块，不改任何既有规则**（故 228px 那条断言不受影响）。
   ⚠️ **范围限定**（2026-10-20 审计订正）：本块只解决**本插件 settings 面板
   自身**的两栏布局问题。装了「把 DSH Web 包成手机 App」的外壳插件（如
   dsh-mobile）时，外壳接管的是**页面级**布局（替换宿主 root 槽位），本插件
   面板会以 drawer / surface 的形态呈现 —— 那种场景下的整体观感不由本块决定。
   故原描述里「解决手机端界面割裂」这个全局宣称已收窄。
   ⚠️ 本文件是模板字符串，本注释内不得出现反引号。 */
@media (max-width: 720px) {
  .dim-jh-layout { flex-direction: column; }
  .dim-jh-rail {
    width: auto; flex: none;
    display: flex; flex-direction: row; align-items: stretch;
    gap: 8px; padding: 8px 10px;
    overflow-x: auto; overflow-y: hidden;
    border-right: 0;
    border-bottom: 1px solid var(--dsw-alias-border-default, #e5e5e5);
  }
  /* 分组外壳在横向条里不再需要：display: contents 让 provider 按钮
     直接参与父级 flex，避免每个分组各占一整行。 */
  .dim-jh-railGroup { display: contents; }
  .dim-jh-railGroupTitle { display: none; }
  .dim-jh-providerRow { flex: none; }
  .dim-jh-provider { width: auto; min-height: 40px; padding: 6px 10px; }
  .dim-jh-panel { padding: 14px 12px; }
}

/* ── 窄屏：用量浮层（聊天输入区那枚徽标展开的面板）──
   POC（2026-10-17，报障「对话框的这里 ui 也需要适配」，附窄屏截图）。
   ⚠️ 2026-10-20 审计整改：本块的**根因描述与 z-index 论证都被推翻重写**，
   下面每一段都标了「已订正」。原描述保留在末尾的「历史」段里供追溯。

   ## 已订正 ①：真正的失效机制不是「左边缘被裁」
   原描述说窄屏下浮层左边缘越出视口 89px。按宿主**真实** composer 布局复刻
   PRE-PR 形态实测：徽标在 .uV2eYG_trailing 里（该行有 margin-left: auto）
   ⇒ 徽标靠**右**（VW=492 时 L=334 R=468），浮层向左展开 220px 得
   popL=248 ⇒ **完全没有越界**。原描述里 badge=134~151（靠左）在宿主布局中
   不成立。⇒ 本块的真实收益是「浮层改为视口锚定、不再跟着徽标跑，且更宽」，
   不是「修裁切」。

   ## 已订正 ②：真正需要 CSS 兜底的是**旧内核的 containing block 偏差**
   宿主 composer 工具行 .uV2eYG_row 带 container-type: inline-size，而徽标
   是它的后代。实测两引擎行为不同：
     - Chromium 154：inline-size containment 只含 inline 轴，**不**创建 fixed
       的 containing block ⇒ fixed 仍按视口锚定（符合规范）；
     - Edge 122：把它当 layout containment ⇒ fixed 改为**相对该祖先**定位
       ⇒ left/right/bottom 全变成「相对 composer 行」的坐标，浮层跟着 composer
       跑、宽度被压缩（实测 popLeft 24→124、width 476→344）。
   ⇒ 只靠 CSS 无法在旧内核上做视口锚定，故窄屏浮层改由 usage-badge.js
   **portal 到 document.body**（body 之上无 containment 祖先，两引擎都按视口
   锚定）。本块仍保留全部承重声明作**兜底**：内联样式一旦被改坏，这里还能挡住。

   ## 已订正 ③：bottom 必须用宿主的 composer 高度变量，不能硬编码
   宿主用 ResizeObserver 把真实 composer 高度写进 --dsh-composer-height
   （dsh-client-ui-conversation 的 ConversationContent），其 CSS fallback 是
   **152px**（宿主三处都写 var(--dsh-composer-height,152px)）。
   原实现硬编码 88px —— 实测 composer=152px 时浮层**压住输入区 64px**，并
   **盖住「用量」徽标按钮**（命中测试点到的不是按钮，是浮层内的 DIV）
   ⇒ 用户点不到。改用变量后 gap=0、徽标可点（两引擎、多档 composer 高度均实测）。
   ⚠️ 该变量能被浮层继承：CSS 变量沿 **DOM 祖先链**继承，与定位方式无关；
   portal 到 body 后 body 仍在 scroller 的**兄弟**位置？—— 不是，body 是共同祖先，
   故变量照样继承得到（已实测 popover 侧 getComputedStyle 读到 152px/220px）。

   ## 已订正 ④：z-index 的区间是 (1101, 3000)，不是 (250, 1000)
   原论证的下限 250 只考虑了**外部外壳**（dsh-mobile），漏了**宿主自己**：
     - 宿主 79 处 z-index 里有 **6 处 1100**（chat 的 bRhRbq_panel、
       conversation 的 JObwrW_panel【composer 里的 ContextMeter，与徽标同一行】、
       model-selection 的 _7KE1Ra_menu【与徽标同一行的模型选择菜单】、
       plugin-manager、schedule ×2）；
     - 另有 **3 处全屏 overlay**：attachment 1000、settings-general 1000、
       settings-account 1001（还有 onboarding 900）。
   浮层若取 300，上述任一出现就把浮层整块盖住。
   原上限 1000 的锚点 .dim-jh-loginOverlay 是**死规则**：全仓 className 用法
   0 命中、git 历史从未渲染过（只剩一条 CSS + 注释）；且它与浮层**不在同一
   stacking context**（分属 settings 页树与 composer 树，两树中间的
   .dim-jh-page/.dim-jh-layout/.dim-jh-rail/.dim-jh-panel 全无 z-index）
   ⇒ z-index 本就不可比。
   ⇒ 改为按**真正同族**的 .dim-jh-modalOverlay(3000) 定上限，按宿主最高
   overlay(1001) 与 ContextMeter(1100) 定下限 ⇒ 取 **1200**（(1101, 3000) 内）。
   另注：dsh-mobile 的 [data-shell-overlay] 恰好是 z-index:300（带 !important），
   原取值与它**完全相等** ⇒ 同层级时后出现的 DOM 胜出，不可预测；1200 也消除了这点。

   ⚠️ 本注释内**不得出现反引号**：本文件整体是模板字符串，反引号会提前闭合它
   （AGENTS.md 红线；本文件的 usage-badge-client.spec.ts 有专条用例逐块扫描注释）。

   ## 历史（已推翻，勿据此改回）
   原描述：根因是「VW=492 badge=134~151 pop=-89~151 L_OVER=true」；取 300 的
   理由是「下限 > 250 压过 dsh-mobile details、上限 < 1000 因为
   .dim-jh-loginOverlay 是 1000」；bottom 硬编码 88px。上述三处均已订正。 */
@media (max-width: 720px) {
  .dim-jh-badgePop {
    position: fixed !important;
    left: 8px !important;
    right: 8px !important;
    top: auto !important;
    bottom: calc(env(safe-area-inset-bottom, 0px) + var(--dsh-composer-height, 152px)) !important;
    width: auto !important;
    max-width: none !important;
    /* ⚠️ 100dvh 而不是 100vh：移动端地址栏收放会让 100vh 与真实可视高度脱节。
       外加 max(120px, ...) 下限 —— 原写法在 vh<=140 时算出 0 或负值，实测
       vh=120 时 max-height 被压成 0px（浮层完全不可见却仍占位）、
       vh=60 时整块飞出屏幕上方。 */
    max-height: max(120px, calc(100dvh - 160px)) !important;
    z-index: 1200 !important;
  }
}

/* ── 插件详情页（plugins.bundle.config）的自有设置卡片 ──

   最外层必须自成 column 且 gap 为 0：宿主 detailSection 给直接子元素
   12px 间隔（PluginManagerPage.module.css 的 .detailSection），官方插件卡
   （终端 / 网页搜索）都包了一层内层 column，容器只看到一个子元素。
   间距改由每块自己的 padding 提供。

   下列几何与字号全部照抄官方设置行与官方插件卡实测值，不要凭感觉改。 */
.dim-jh-cardStack { display: flex; flex-direction: column; gap: 0; }
.dim-jh-cardRow { display: flex; align-items: center; gap: 8px; padding: 16px 0; }
.dim-jh-cardRowText { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; padding-right: 48px; }
.dim-jh-cardTitle { font-size: 13px; font-weight: 500; line-height: 19.5px; color: var(--dsw-alias-label-primary); }
.dim-jh-cardDesc { font-size: 12px; font-weight: 400; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
/* 下拉触发按钮：几何与官方设置页选择器一致（高 36 / 圆角 md / 13px 500）。 */
.dim-jh-cardSelector { display: inline-flex; align-items: center; gap: 12px; height: 36px; padding: 0 14px; border: none; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-module-platform); font: inherit; font-size: 13px; font-weight: 500; line-height: 19.5px; color: var(--dsw-alias-label-primary); cursor: pointer; }
.dim-jh-cardSelector:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
/* 提交中压暗整个控件，而不是只改文字色：官方对带背景控件就是这么做的
   （Switch 用 opacity 0.5，SegmentedControl 用 0.4）。 */
.dim-jh-cardSelector:disabled { cursor: default; opacity: 0.5; }
.dim-jh-cardChevron { flex: none; }
/* 焦点环：跟随本文件既有约定（outline:none + box-shadow），与 .dim-jh-switch /
   .dim-jh-zcSelect 一致。官方设置页的选择器**没有** outline 规则，故这里也不加，
   否则同一张插件页上本卡片会比其他控件多一圈描边。 */
.dim-jh-cardSelector:focus-visible { outline: none; box-shadow: 0 0 0 2px color-mix(in srgb, #1677ff 30%, transparent); }
`



/**
 * 本插件的**包 id** —— 必须等于 package.json 的 name（当前 dsh-providers-hub）。
 *
 * ⚠️ 它同时是宿主 claimStyles / removeOwnedStyles 用的 ownerId
 * （dsh-client-modules 的 stripClientSuffix(registration.id)），
 * 也就是样式标签 data-plugin 的**正确取值**。
 *
 * ⚠️ 本文件被 esbuild 打进 bundle，**运行时读不到 package.json**，故这里是字面量。
 * 它与包名的一致性由 tests/unit/jet-hub-styles-ownership.spec.ts 对拍锁住
 * —— 那个用例直接从 package.json 取 name，两边不一致即红。
 *
 * ⚠️⚠️ 改名时必须同时改 package.json 的 name：bundle 的注册 id 取自它
 * （见 build.mjs），而 DSH 按包名物化客户端条目 —— 不一致会让**整个插件加载失败**
 * （2026-10-15 真实事故，桌面端反复把插件隔离进恢复模式）。
 *
 * ⚠️ 上面这段注释**刻意不写反引号**：紧邻其上的 STYLES 是模板字符串，
 * 注释里出现反引号会提前闭合它（AGENTS.md 明令禁止；本文件已有四个用例在守）。
 */
const PLUGIN_ID = 'dsh-providers-hub'

/** 样式标签的资源标识（宿主 data-plugin-css 的语义，见下）。 */
const STYLE_TAG_ID = PLUGIN_ID + '/jet-hub.css'

/** 幂等判据用的选择器：按**资源标识**查自己的那张标签。 */
/** 幂等判据用的选择器：按**资源标识**查自己那张标签。 */
const STYLE_SELECTOR = 'style[data-plugin-css=' + JSON.stringify(STYLE_TAG_ID) + ']'

/**
 * 引用计数的挂载键。
 *
 * ⚠️⚠️ 计数必须挂在**元素**（dataset）上，不能挂在模块级变量上
 * （真机实测 2026-10-09，issue IKKGYN）：
 *
 * 模块级变量只在**同一个模块实例**内有效，而宿主 replace 会先
 * tearDownEntryFiber（它会 await 旧 fiber 的 inertia）再重新 import ——
 * 新 factory 若跑在旧 dispose **之前**，就出现
 * 「两个实例先后注入、disposer 交错执行」的交错。计数挂在 DOM 上则跨实例共享
 * 同一份真相。
 *
 * ⚠️ 挂载后是 data-jet-hub-refs，是本插件**私有**属性名；
 * 宿主 claimStyles / removeOwnedStyles 只认 data-plugin，不会碰它。
 */
const REFS_KEY = 'jetHubRefs'

/** 当前挂在文档里的样式元素（不在就返回 null）。 */
function styleElement() {
  // ⚠️ 用字符串拼接而**不是**模板字符串：本文件的反引号数被单测钉死为 2
  // （STYLES 的定界符），多一对就会命中「模板字符串被提前闭合」那条闸门。
  return document.head.querySelector(STYLE_SELECTOR)
}

/** 插入一份样式表；已存在则**复用**（绝不新建第二份）。 */
function mountStyles() {
  const existing = styleElement()
  if (existing !== null) return existing
  const style = document.createElement('style')
  // ⚠️ 署名是**关键**（issue IKK764）：claimStyles 只认领无主标签，
  // removeOwnedStyles 只删自己名下的标签。
  style.dataset.plugin = PLUGIN_ID
  style.dataset.pluginCss = STYLE_TAG_ID
  style.textContent = STYLES
  document.head.appendChild(style)
  return style
}

/** 把引用计数读成整数（缺失 / 非法一律当 0）。 */
function refsOf(style) {
  const n = Number(style.dataset[REFS_KEY])
  return Number.isFinite(n) ? n : 0
}

/**
 * 注入 Jet Hub 的整张样式表。
 *
 * ## ⚠️⚠️ 为什么必须写 data-plugin（Gitee issue IKK764）
 *
 * 宿主（@deepseek-ai/dsh-client-modules 的 lib/client.js）对 style 标签有归属机制：
 *
 * - claimStyles(id)：把自己物化期间出现的**无主**标签
 *   （选择器 style:not([data-plugin])）**全部**认领给当前插件；
 * - removeOwnedStyles(id)：按 data-plugin 精确匹配删除，触发路径有四条 ——
 *   该插件行 revision 变化（updateManifest）、对应行被 prune、factory 抛错、
 *   条目被替换（replace）。
 *
 * 而 installJetHubStyles 是在 ctx.effect(...)（插件 apply 阶段）里注入的，
 * **必然晚于自己那次 claimStyles**。所以无署名版本有双重缺陷：
 *
 * 1. 标签**始终无主** ⇒ 之后任何一个插件物化都会把它认领走；那个插件一热重载 /
 *    被禁用 / 被卸载，宿主就把「它名下」的样式连根删掉 ⇒ **Jet Hub 整套 UI 掉样式**
 *    （.dim-jh-* 全量，不是局部）；
 * 2. 幂等按模块级布尔 ⇒ 标签被外部删除后**永不再补注**。
 *
 * 故这里：① 注入时**署名**；② 幂等按**DOM 存在性**判断。
 *
 * ## ⚠️⚠️ 为什么 disposer 改用「闭包持有元素 + 元素上引用计数」（IKKGYN）
 *
 * 旧 disposer 是 document.querySelector(STYLE_SELECTOR)?.remove() ——
 * 它删的是**「当前那张」**，不是「自己注入的那张」。只要出现
 * 「新实例先注入、旧 disposer 后执行」的交错（宿主 replace 的
 * tearDownEntryFiber 会 await 旧 fiber 的 inertia，故 dispose 天然晚于新的 apply），
 * 旧 disposer 就会把**新注入的那张**删掉，且此后无人补注 ⇒ IKK764 的故障面重新打开。
 * 本机 CDP 实测该时序确实成立（新表 1 份 → 旧 disposer 跑完 → 0 份）。
 *
 * 现在：disposer **闭包持有自己那张元素**，只减自己的计数 —— 后来注入的那张
 * （另一个元素）既不会被旧 disposer 减到，也就不会被误删。
 *
 * ⚠️ data-plugin-css 只是资源标识（宿主 claimStyles 回读它做 inventory），
 * 用「包 id + 文件名」的形式，便于将来多张样式表各自幂等。
 *
 * ⚠️⚠️ 本文件的样式整体装在模板字符串里，**整份文件只允许 STYLES 首尾那两个
 * 反引号**：注释里写字面反引号会提前闭合模板（AGENTS.md 红线，已有三条护栏用例
 * 分别计数）。故上面所有标识符一律裸写，本函数内也不得再引入模板字符串 ——
 * STYLE_TAG_ID / STYLE_SELECTOR 因此刻意用字符串拼接。
 */
export function installJetHubStyles() {
  const style = mountStyles()
  style.dataset[REFS_KEY] = String(refsOf(style) + 1)
  let released = false
  return () => {
    // 幂等守卫：cordis 允许同一 disposer 被调用两次，重入不得二次减计数。
    if (released) return
    released = true
    // ⚠️ 只动**自己闭包里那张**元素：已被外部删掉就别再计数（元素不在文档里）。
    if (style.parentNode === null) return
    const left = refsOf(style) - 1
    if (left > 0) {
      style.dataset[REFS_KEY] = String(left)
      return
    }
    style.remove()
  }
}

/**
 * 渲染期自愈：样式表被外力摘掉（宿主回收、热更新、误删）时补回。
 *
 * ⚠️ 为什么记账还不够：「组件还在、样式没了」正是这样发生的 —— 记账只保证
 * 「有人持有就不删」，管不住「已经被删掉之后」。而 installJetHubStyles 只挂在
 * apply 阶段（ctx.effect），**渲染路径上不会重跑**，故必须另开一个渲染期入口，
 * 否则样式表一丢就只能 F5 整页刷新才恢复。
 *
 * @returns 是否真的补了一次（补过就打一条 warn，便于直接定位而不是靠截图取证）
 */
export function ensureJetHubStyles() {
  if (styleElement() !== null) return false
  mountStyles()
  console.warn('[jet-hub] 样式表缺失（被卸载或热更新摘除），已重新注入')
  return true
}
