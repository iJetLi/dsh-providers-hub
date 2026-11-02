/**
 * CodeBuddy 成长中心任务自动化。
 *
 * 借鉴自 WorkDaddy 的 `growth-daily.js`（AGPL）重写，只保留**纯 API 内核**：
 * 任务接取 + 判据事件上报 + 逐项领奖。端点基址随 `product.endpoint`
 * （`copilot.tencent.com`）切换，鉴权复用 Jet Hub 的账号池 token（Bearer）。
 * WorkDaddy 里那套 CDP 注入、DOM 自动化、AI 刷活跃保连胜的引擎**不**搬运 ——
 * Jet Hub 没有客户端注入面，纯 API 层才是可移植部分。
 *
 * 合规：端点契约参考 WorkBuddy（AGPL-3.0）公开文档，本实现为独立重写，
 * 不复制其代码、构建产物或 CDP 引擎，不构成 AGPL 派生作品。
 *
 * 端点与格式来自对 WorkBuddy 5.5.x 成长中心的逆向 + 真实请求实测（2026-10-03；
 * 2026-11-01 增补按 workbuddy2api 面板 2026-09~10 实测口径校正）：
 *
 *   任务列表  GET  /v2/activity/growth/tasks            （v1: /activity/growth/tasks）
 *   任务列表  GET  /v2/activity/growth/tasks            （小程序口径：X-Client-Platform:
 *                                                       miniprogram；Sequential_* 族只在
 *                                                       该口径下发，且该列表是默认口径的
 *                                                       **超集**，合并时按 task_code 去重）
 *   任务接取  POST /activity/growth/tasks/accept        body {task_codes:[…]}（mp 族同路径
 *                                                       但必须带 miniprogram 头，缺头实测
 *                                                       `task not found`）
 *   旅行状态  GET  /activity/growth/buddy/travel/status
 *   旅行领奖  POST /activity/growth/buddy/travel/claim  body {}
 *   遥测上报  POST /v2/report                           （桌面指纹走 endpoint；web 指纹与
 *                                                       小程序指纹走 webBase —— mp 上报头是
 *                                                       mp-weixin/wechatmp，不是 miniprogram）
 *   逐项领奖  POST {claimBase}/activity/growth/tasks/<task_code>/claim
 *   连登状态  GET  /activity/growth/streak              （data.streak.days + makeup_cards +
 *                                                       redemption_status.tiers）
 *   连登兑换  POST /activity/growth/redeem              body {tier, client_token}
 *   连登热图  GET  /activity/growth/heatmap             （补签窗口判定）
 *   补签      POST /activity/growth/makeup-cards/use    body {target_date}
 *   抽奖状态  GET  /activity/growth/lottery/summary     （data.chances）
 *   抽奖      POST /activity/growth/lottery/draw        body {client_token}（⚠ 无 /v2 前缀）
 *   首Buddy   POST /activity/growth/buddy/agreement     body {agree:true}（幂等，前置）
 *             POST /activity/growth/buddy/first         body {}
 *   新手礼包  POST {webBase}/billing/meter/check-gift-claimed（状态）
 *             POST {webBase}/billing/meter/claim-gift   （领取）
 *
 * ## 积分获取路径全覆盖（2026-11-01，用户口径「不运行 app 自动做所有积分领取」）
 *
 * `collectBuddyGrowth`（一键领取积分 + 成长任务按钮的唯一入口）现在按序跑：
 *   ① 成长任务两族（含 2026-10-29 新增的 5 项「体验专家」与小程序 Sequential 族）
 *     ：接取 → 完成动作 → 逐项领奖 → 扫尾补领；
 *   ② 连登链：补签保连登 → 兑换已解锁档位（7d/14d/28d，发积分/能量/补签卡/抽奖次数）
 *     → 按 chances 抽完抽奖（次数由兑换获得，抽完即止，不预支）；
 *   ③ 首Buddy 领养（+300 一次性，agreement 前置）；
 *   ④ 新手礼包（一次性，先查状态、待领才领）；
 *   ⑤ 保连胜（一条真实短对话，维持签到倍数基数）。
 * **刻意不自动**的只剩盲盒（消耗能量 —— 那是把任务挣来的资源花掉，不是领积分），
 * 仍留在 `runExotic` 门控后。
 *
 * **「等新的任务」的覆盖口径**：扫尾补领按**全量任务列表**逐项 claim（不筛白名单），
 * 所以服务端日后新增、且判据是「真实使用自然达成」的任务，其奖励会被自动领走；
 * 需要主动「做动作」的新任务则要登记进 {@link AUTOMATABLE_TASK_CODES} +
 * {@link GROWTH_TASK_COMPLETION}（两行）。
 *
 * 两个关键结论（实测）：
 *
 * 1. **幂等/无对象判定以响应体 code + msg 为准**，不能只看 HTTP 状态。
 *    不可领状态是 HTTP 400 + code 400 + msg（"no unclaimed travel" /
 *    "insufficient energy" / "please accept buddy adoption agreement first"），
 *    与签到端点的 10001 同型 —— 只看状态码会把「没有可领对象」误报为失败。
 *
 * 2. **任务接取（accept）本身不加积分**，它把任务从 `not_accepted` 置为
 *    `in_progress`；积分在任务**完成后**由服务端发放（`reward_credit`/
 *    `reward_energy`）。故完成动作只对登记过的任务执行；对纯「真实使用」判据的
 *    任务（如 Sequential 族的反作弊节奏任务）按服务端口径补发判据事件。
 *
 * 3. **小程序（Sequential_Tasks_*）任务的反作弊是节奏性的**（2026-09-26 实测）：
 *    数秒级连发的 `chat_request_send` 会先计数后被整体回滚（claim 400
 *    `task not completed`）；45s 间隔 + 抖动逐条上报才存活。故 mp 对话事件
 *    逐条等待 {@link MP_CHAT_EVENT_GAP_MS}，宁可慢不可白报。
 */
import { createHash } from 'node:crypto'
import {
  BUDDY_DEPLOYMENT_TYPE,
  HTTP_HEADER_DOMAIN,
  HTTP_HEADER_PRODUCT,
  HTTP_HEADER_PRODUCT_CODE,
  type BuddyCredential,
} from './buddy.js'
import type { ClaimOutcome } from './credits.js'
import type { BuddyProduct } from './product.js'
import type { ProviderAccountEntry, RpcBuddyGrowthAccountResult } from './types.js'

/**
 * 判据事件里必须出现的固定资源 id。这些是**服务端判据绑定的具体资源**，
 * 换掉就不计数，因此不是可调参数；但写成裸字面量会让「这是真实资源 id」
 * 与「这是拼写错误」无法区分，故在此具名。
 *
 * - BUDDY_APP_ID：应用类判据只认 buddyId。Buddy_App 与 Buddy_App_QQ 判据同源。
 * - LIGHTHOUSE_EXPERT_ID：Expert_lighthouse 绑定固定专家，市场里任取专家不计数。
 *   该专家为腾讯轻量云专家，id 取自实测可达的专家市场列表。
 */
const BUDDY_APP_ID = 'cb_y5Dy46tPQGGWtueMxXbe'
const LIGHTHOUSE_EXPERT_ID = 'ex_2cvvUZQhDyeJ'
const LIGHTHOUSE_EXPERT_NAME = '腾讯轻量云专家'
/** `Hp_Appearance` 判据绑定的主题资源 key。 */
const APPEARANCE_THEME_KEY = 'theme-tkmw7j'
/** `Library_read` 判据绑定的资料库空间文档 id。 */
const LIBRARY_SPACE_DOC_ID = 'o0KWYeynteVv06UnAZqIFm'
/** `skill_1` / `skill_installed` 判据绑定的技能 id。 */
const SKILL_ID = 'skill_2097350077599879168'
/** 通用对话链使用的真实模型 id（非 `default-model` 虚拟路由别名）。 */
const DEFAULT_CHAT_MODEL = 'deepseek-v4.1-flash'
/** 快速模型：等级族与技能类判据只认它。 */
const FAST_MODEL = 'fast-model'
/** `Model_chat_GLM5.2` 判据绑定的模型 id 与模型名（**大小写不同**，同值不计数）。 */
const GLM_MODEL_ID = 'glm-5.2'
const GLM_MODEL_NAME = 'GLM-5.2'

/** 任务列表查询端点（v2 主、v1 回退，二者都 200）。 */
export const GROWTH_TASKS_PATHS = ['/v2/activity/growth/tasks', '/activity/growth/tasks'] as const
/** 任务接取端点。 */
export const GROWTH_TASK_ACCEPT_PATH = '/activity/growth/tasks/accept'
/** 旅行状态查询端点。 */
export const GROWTH_TRAVEL_STATUS_PATH = '/activity/growth/buddy/travel/status'
/** 旅行领奖端点。 */
export const GROWTH_TRAVEL_CLAIM_PATH = '/activity/growth/buddy/travel/claim'
/** Buddy 采纳协议端点（幂等；`buddy/first` 的前置，缺它实测 400 adoption agreement）。 */
export const GROWTH_BUDDY_AGREEMENT_PATH = '/activity/growth/buddy/agreement'
/** 首个 Buddy 解锁端点（一次性 +300，纯收益，进默认流）。 */
export const GROWTH_FIRST_BUDDY_PATH = '/activity/growth/buddy/first'
/** 盲盒端点（消耗 energy —— 花资源而非领积分，保持 runExotic 门控）。 */
export const GROWTH_BLIND_BOX_PATH = '/v2/activity/growth/buddy/open'
/**
 * 抽奖端点。⚠ **无 `/v2` 前缀**（2026-09-12 成长中心 bundle 逆向 + 页面实测口径）——
 * 本文件曾按设计稿猜过 `/v2/activity/growth/lottery/draw`，与 Go 面板实测路径相悖，
 * 以实测为准（同族 redeem/makeup/heatmap 均无 v2 前缀）。
 */
export const GROWTH_LOTTERY_DRAW_PATH = '/activity/growth/lottery/draw'
/** 抽奖次数查询端点（data.chances）。 */
export const GROWTH_LOTTERY_SUMMARY_PATH = '/activity/growth/lottery/summary'
/** 连登状态端点（data.streak.days / data.makeup_cards / data.redemption_status）。 */
export const GROWTH_STREAK_PATH = '/activity/growth/streak'
/** 连登档位兑换端点（发 credit/energy/补签卡/抽奖次数）。 */
export const GROWTH_REDEEM_PATH = '/activity/growth/redeem'
/** 连登热图端点（补签窗口判定：本月漏签 = score 0）。 */
export const GROWTH_HEATMAP_PATH = '/activity/growth/heatmap'
/** 补签卡使用端点（body {target_date}）。 */
export const GROWTH_MAKEUP_USE_PATH = '/activity/growth/makeup-cards/use'
/** 新手礼包状态端点（webBase 域；⚠ 无 /v2 前缀，带 /v2 实测 404）。 */
export const GIFT_STATUS_PATH = '/billing/meter/check-gift-claimed'
/** 新手礼包领取端点（webBase 域）。 */
export const GIFT_CLAIM_PATH = '/billing/meter/claim-gift'

/**
 * 小程序口径的平台头值。Sequential_Tasks_* 族的**列表下发、accept、claim 全链路**
 * 都要求 `X-Client-Platform: miniprogram`（缺头 accept 实测 `task not found`）。
 * ⚠ 与 mp **事件上报**的头（`mp-weixin`/`wechatmp`，见 {@link mpReportHeaders}）是
 * 两套值，别混。
 */
const MP_PLATFORM_HEADER = 'miniprogram'

/**
 * 小程序口径专属的成长任务：默认（web 口径）列表不出现，list/accept/claim 都走
 * mp 头。新任务出现时在此登记（同步加入 {@link AUTOMATABLE_TASK_CODES} 与
 * {@link GROWTH_TASK_COMPLETION}）。
 */
export const MP_TASK_CODES: ReadonlySet<string> = new Set([
  'Sequential_Tasks_1', // 小程序首对话（mini chat，无 activityId）
  'Sequential_Tasks_2', // 小程序选中专家并完成有效对话（mp 指纹 expert_actual_use）
  'Sequential_Tasks_3', // 小程序 5 次对话（与 Tasks_1 同形状，target=5 逐条累加）
  // Tasks_4..7 每日零点解锁一环（locked 期间 accept 不落账），判据部分为预置口径，
  // 解锁后按实测校正。
  'Sequential_Tasks_4',
  'Sequential_Tasks_5',
  'Sequential_Tasks_6',
  'Sequential_Tasks_7',
])

/** 该任务是否小程序口径专属（决定回读/接受/领奖的头与列表口径）。 */
export function isMpTaskCode(code: string): boolean {
  return MP_TASK_CODES.has(code)
}

/**
 * 可自动接取的任务白名单（task_code）。
 *
 * 只接取**纯使用即可达成**、且奖励为普通 credit/energy 的任务。限定款
 * （`reward_buddy:true`、需下载桌面端/升级主题解锁的盲盒 Buddy）**不**进默认白名单，
 * 避免误触发一次性解锁动作。判据与 WorkDaddy `AUTOMATABLE_TASK_CODES` 对齐。
 *
 * 2026-11-01 增补（workbuddy2api 面板 2026-10-29 实测任务列表）：
 * - `WorkBuddy_Valorant` + `expert_use_*` 四项：「体验专家」类活动，判据同
 *   `Expert_lighthouse`，专家 id 绑定任务 jump_url（见 {@link FIXED_EXPERT_TASKS}）。
 * - `Sequential_Tasks_1..7`：小程序口径专属族（{@link MP_TASK_CODES}）。
 */
export const AUTOMATABLE_TASK_CODES = new Set([
  'create_canvas', 'template_5', 'expert_5', 'Expert_team_use_3',
  'automation_1', 'playbook_prompt', 'Expert_lighthouse', 'Buddy_App',
  'Buddy_App_QQ', 'Hp_Appearance', 'chat_5', 'Model_chat_GLM5.2',
  // 「养虾等级」任务族
  'first_chat', 'template_used', 'expert_summoned', 'skill_installed', 'wechat_linked',
  'black_cat', 'Library_read', 'RichMeow_Chat', 'skill_1',
  'wb_wechat_oa_subscribe_task',
  // ── 「体验专家」活动族（判据同 Expert_lighthouse，截止期以任务列表为准）──
  'WorkBuddy_Valorant',
  'expert_use_maidehao',
  'expert_use_douyinyin',
  'expert_use_shangjia_xuanchuan',
  'expert_use_bowangwang',
  // ── 小程序口径专属族（mp 头全链路）──
  'Sequential_Tasks_1', 'Sequential_Tasks_2', 'Sequential_Tasks_3',
  'Sequential_Tasks_4', 'Sequential_Tasks_5', 'Sequential_Tasks_6', 'Sequential_Tasks_7',
])

/**
 * 「体验「X」专家」类活动的固定参数（task_code → 专家）。
 *
 * 专家 id 全部取自任务自身的 jump_url（PC 的 deeplink `experts?expertId=ex_…`、
 * 小程序的 `expert-center/detail?id=ex_…`），与专家市场真实条目一一对应。
 * ⚠ **name 是专家的「昵称」、title 是任务标题里的「职业名」**（卖得好/斗音音/
 * 播旺旺是昵称）——判据事件里 `name` 取昵称、`expertTitle` 取职业名，两者都参与
 * 服务端校验，**不能互换**。version 以市场条目为准（见运行时 enrich），表内是
 * 搜不到市场条目时的静态兜底值。
 */
export const FIXED_EXPERT_TASKS: Readonly<Record<string, MarketExpert>> = {
  Expert_lighthouse: {
    expertId: LIGHTHOUSE_EXPERT_ID, expertType: 'agent',
    name: LIGHTHOUSE_EXPERT_NAME, title: LIGHTHOUSE_EXPERT_NAME, version: '1.0.2',
  },
  WorkBuddy_Valorant: {
    expertId: 'ex_xQHHD1u5Jkua', expertType: 'agent',
    name: '无畏契约拼豆专家', title: '无畏契约拼豆专家', version: '1.2.1',
  },
  expert_use_maidehao: {
    expertId: 'ex_GDl31WahyIH0', expertType: 'agent',
    name: '卖得好', title: '中国电商运营专家', version: '1.0.1',
  },
  expert_use_douyinyin: {
    expertId: 'ex_FbY5nlWTqDod', expertType: 'agent',
    name: '斗音音', title: '抖音策略师', version: '1.0.2',
  },
  expert_use_shangjia_xuanchuan: {
    expertId: 'ex_Weo3x2EZuSDm', expertType: 'agent',
    name: '商家宣传设计师', title: '商家宣传页与海报设计师', version: '1.6.0',
  },
  expert_use_bowangwang: {
    expertId: 'ex_WZY136wV5aMt', expertType: 'agent',
    name: '播旺旺', title: '直播电商教练', version: '1.0.2',
  },
}

/** 请求超时（毫秒）。与签到同款口径，单请求 30s。 */
const REQUEST_TIMEOUT_MS = 30_000
/**
 * 「没有可领对象」类的业务码。成长端点把这类情况统一回 HTTP 400 + code 400，
 * 靠 msg 文案区分具体原因（无未领旅行 / 能量不足 / 未签 Buddy 采纳协议）。
 * 与签到端点 10001 同型：判定以响应体 code + msg 为准。
 */
const GROWTH_NO_OBJECT_CODE = 400
/**
 * 平台身份三元组：同一台机器在两个上报域里的自洽视图。
 */
interface PlatformIdentity {
  os: string
  arch: string
  osVersion: string
}

/**
 * 各平台 `osVersion` 的取值。**必须与 `os` 同平台** —— 此前非 darwin 一律写
 * `10.0.26220`（Windows 版本号），于是 Linux 宿主上报 `os: 'linux'` 配一个
 * Windows 版本号，自相矛盾。
 */
const PLATFORM_OS_VERSIONS: Readonly<Record<string, string>> = {
  darwin: '15.0',
  win32: '10.0.26220',
  linux: '6.8.0',
}

/**
 * Node 的 `process.platform` → 浏览器 `navigator.platform` 取值。
 *
 * 两个域对同一个操作系统的**命名不同**（桌面域说 `win32`、web 域说 `Win32`），
 * 但描述的是同一台机器，故各自按本域习惯命名、而 `arch` 与 `osVersion` 保持一致。
 *
 * ⚠️ 这些值是**基线**：`arch` 明确时由 {@link webOsName} 按架构细化。
 * 原先 linux 恒写 `'Linux x86_64'`，于是 arm64 宿主上报
 * `os: 'Linux x86_64'` 配 `arch: 'arm64'` —— 同一对象里自相矛盾
 * （与「非 darwin 一律写 Windows 版本号」是同一类缺陷）。
 */
const WEB_OS_NAMES: Readonly<Record<string, string>> = {
  darwin: 'MacIntel',
  win32: 'Win32',
  linux: 'Linux x86_64',
}

/** `process.arch` → `navigator.platform` 里的架构后缀（仅 linux 需要区分）。 */
const WEB_ARCH_SUFFIXES: Readonly<Record<string, string>> = {
  x64: 'x86_64',
  arm64: 'aarch64',
  ia32: 'i686',
}

/**
 * web 域的 `navigator.platform` 取值。
 *
 * linux 下按真实架构拼后缀，避免 `os` 与 `arch` 在一个对象里互相矛盾
 * （浏览器在 linux 上就是报 `Linux x86_64` / `Linux aarch64` 这种形态）。
 */
function webOsName(os: string, arch: string): string {
  if (os === 'linux') {
    const suffix = WEB_ARCH_SUFFIXES[arch]
    return suffix === undefined ? WEB_OS_NAMES['linux']! : `Linux ${suffix}`
  }
  return WEB_OS_NAMES[os] ?? os
}

/** 桌面域平台身份。`os` 用 Node 原值，`arch` 用 `process.arch`（不写死 x64）。 */
function platformIdentity(): PlatformIdentity {
  const os = process.platform
  return {
    os,
    arch: process.arch,
    osVersion: PLATFORM_OS_VERSIONS[os] ?? '0.0.0',
  }
}

/** web 域平台身份：同一台机器，按浏览器习惯重命名 `os`。 */
function webPlatformIdentity(): PlatformIdentity {
  const identity = platformIdentity()
  // `os` 按架构细化（linux 的 x86_64/aarch64），`arch` 与 `osVersion` 原样保留 ——
  // 同一台机器在两个域只能命名不同，不能描述不同。
  return { ...identity, os: webOsName(identity.os, identity.arch) }
}

/** 单账号时间预算缺省值（毫秒）。实测单账号 90～270s，10 分钟够 3～4 项从容跑完。 */
const DEFAULT_BUDGET_MS = 600_000
/** 任务间隔节流（毫秒）。 */
const TASK_INTERVAL_MS = 1500
/** 同任务多轮上报之间的节流（毫秒）。 */
const ROUND_INTERVAL_MS = 1000
/** 扫尾补领每项之间的节流（毫秒）。 */
const SWEEP_INTERVAL_MS = 1000
/** 上报后等待服务端结算再复查 progress 的等待（毫秒）。 */
const SETTLE_WAIT_MS = 4000
/** 主题写入后等皮肤事件生效的等待（毫秒）。 */
const APPEARANCE_SETTLE_MS = 2000

/**
 * mp（小程序）对话事件的真人节奏间隔（毫秒）。
 *
 * 上游对 Sequential_Tasks_3「5 次有效对话」有**反作弊校验**：数秒级连发的事件会先
 * 被计入进度（回读 5/5、accept_status 甚至短暂转 completed），随后被判定无效整体
 * 回滚（进度回落、claim 400 `task not completed`）——2026-09-26 实测 2s 连发 4 条
 * 全灭，45s 间隔逐条上报全存活且 claim +300c+5e 成功。每条上报前等待本间隔 +
 * 0~{@link MP_CHAT_JITTER_MAX_MS} 抖动；**首条也等**（上一轮残留进度被回滚后
 * 立即重报同样无效）。
 */
export const MP_CHAT_EVENT_GAP_MS = 45_000
/** mp 对话事件的随机抖动上限（毫秒），叠加在 {@link MP_CHAT_EVENT_GAP_MS} 上。 */
export const MP_CHAT_JITTER_MAX_MS = 10_000
/** mp 任务写动作间隔（accept/上报/领奖之间，防频控）。 */
const MP_ACTION_GAP_MS = 2_000

/**
 * mp（小程序）埋点公共指纹（对齐小程序 appservice 运行时 wQ()+Ao() 的实测形状）。
 *
 * ⚠ 这些值描述的是**小程序运行时**（微信小程序宿主），不是本机 —— 与
 * {@link desktopFingerprint} 按 `process.platform` 推导的桌面指纹**刻意不同**：
 * 判据事件按上报指纹归因到「小程序端行为」，换成宿主机真实平台反而改变判据归属。
 * `machineId` 固定为实测值（同一设备多账号共用一台机器的机器码是真实形态）。
 */
function mpFingerprint(credential: BuddyCredential): Record<string, unknown> {
  return {
    timestamp: Date.now(),
    ideType: 'WorkBuddy_MP',
    ideVersion: '2.4.0',
    extName: 'workbuddy-mp',
    extVersion: '2.4.0',
    product: 'SaaS',
    ideName: 'wx_app_cloud',
    platform: 'mini_program',
    os: 'windows',
    osVersion: '11',
    arch: 'x64',
    machineId: '0655736a-607f-4d9d-b430-58176ee9a090',
    timezone: 'Asia/Shanghai',
    userId: String(credential.user_id ?? ''),
    userNickname: String(credential.nickname ?? ''),
  }
}

// ── 数据结构 ──

/**
 * 一条判据事件。`eventCode` 之后的键名由服务端判据定义，随任务族变化，
 * 故取 `Record<string, unknown>` 而非穷举。
 */
export type GrowthEvent = { eventCode: string } & Record<string, unknown>

/** 成长端点响应信封。`code === 0` 为业务成功。 */
export interface GrowthEnvelope {
  code?: number
  msg?: string
  data?: unknown
}

/** 两族任务合并后的任务项。缺 `accept_status` 即为「养虾等级」族。 */
export interface GrowthTaskItem {
  task_code?: string
  /** 等级族的码字段。 */
  code?: string
  accept_status?: string
  /** 等级族的 `status`（仅 `available` 可做）。 */
  status?: string
  /** 小程序族的每日解锁锁（true = 尚未解锁，accept 不落账）。 */
  locked?: boolean
  progress?: { current?: number; target?: number }
}

/** 成长中心返回的数据体。 */
export interface GrowthTaskData {
  tasks?: GrowthTaskItem[]
}

/** 单项进度。 */
export interface GrowthProgress {
  current: number
  target: number
}

/** 成长任务查询结果。 */
export interface GrowthTaskQuery {
  /** 查询是否成功（端点可达且 code 0）。 */
  ok: boolean
  /** 白名单内且按 `includeInProgress` 筛出的任务码。 */
  codes: string[]
  /** 返回的任务总数。 */
  total: number
  /**
   * `ok:false` 时的失败原因。
   *
   * ⚠️ 必须带上（不能只说「查询失败」）：下游 `collectBuddyGrowth` 靠
   * **消息文本**判定僵尸账号（401/403 → 「凭据已失效」），原因丢失会让
   * 「请重新登录」被显示成「没有可做任务」。
   */
  message?: string
  /** 仅 `includeInProgress` 时给出：仍需 accept 的 task_code。 */
  toAccept?: Set<string>
  /** 仅 `includeInProgress` 时给出：每个任务码的进度。 */
  progressByCode?: Record<string, GrowthProgress>
}

/** {@link fetchGrowthTaskCodes} 的选项。 */
export interface GrowthTaskQueryOptions {
  /** 纳入 in_progress（未完成）任务，供 runTasks 档补发完成动作。 */
  includeInProgress?: boolean
}

/** {@link claimAllGrowth} 的选项。 */
export interface GrowthClaimOptions {
  /**
   * 是否追加有代价/一次性动作（盲盒 / 抽奖 / 首Buddy 解锁）。
   * 默认 `false`：只做任务接取 + 旅行领奖（低副作用）。
   */
  runExotic?: boolean
}

/** 真实专家（来自专家市场）。判据要求 `expertId` 是平台真实 id，编造不计数。 */
export interface MarketExpert {
  expertId: string
  expertType: string
  name: string
  title: string
  version?: string
  industryId?: string
}

/** 事件上报结果。 */
export interface ReportResult {
  ok: boolean
  /** 实际发出的事件条数。 */
  reported: number
  message: string
}

/** 领奖结果。 */
export interface ClaimResult {
  ok: boolean
  /** `false` 表示已领过或无可领。 */
  claimed: boolean
  credit: number
  message: string
}

/** 完成动作的映射项。 */
export interface GrowthTaskSpec {
  /** 动作类型。 */
  kind:
    | 'canvas' | 'chat' | 'canvasThenChat' | 'webClick' | 'appearance' | 'skillFresh'
    /** 绑定固定专家的「体验专家」活动（召唤链 + 真实对话 + LOCAL actual_use）。 */
    | 'fixedExpert'
    /** 小程序口径：对话判据事件（Sequential_Tasks_1/3/6，45s 节奏）。 */
    | 'mpChat'
    /** 小程序口径：mp 指纹 expert_actual_use（Sequential_Tasks_2，市场 id 前置）。 */
    | 'mpExpert'
    /** 小程序口径：预置判据事件（Sequential_Tasks_4/5/7，primary+fallback）。 */
    | 'mpEvent'
  /** 展示名。 */
  label: string
}

/** {@link runGrowthTaskCompletions} 的选项。 */
export interface GrowthCompletionOptions {
  /**
   * 单账号时间预算（毫秒）。缺省 10 分钟。传 0 或负数表示不限（供本地排障）。
   * 非有限值（NaN / Infinity）归为「不限」并留痕：`Number('abc')` 得 NaN，
   * 而 `NaN > 0` 为 false，若不显式区分会静默变成不限时，恰是本预算要防的情况。
   */
  budgetMs?: number
  /**
   * ⚠ **仅供单测注入**（压缩 mp 反作弊节奏，生产代码不要传）：
   * mp 对话事件间隔（缺省 {@link MP_CHAT_EVENT_GAP_MS} = 45s）。
   */
  mpChatGapMs?: number
  /** ⚠ 仅供单测注入：mp 间隔随机抖动上限（缺省 10s；传 0 去抖动）。 */
  mpJitterMaxMs?: number
  /** ⚠ 仅供单测注入：mp 写动作间隔（缺省 2s）。 */
  mpActionGapMs?: number
}

/** {@link runGrowthTaskCompletions} 的单项结果。 */
export interface GrowthTaskResult {
  taskCode: string
  ok: boolean
  message: string
  /** 判据在服务端推不动、如实归为「需客户端」而非「失败」。 */
  clientOnly?: boolean
}

/** {@link runGrowthTaskCompletions} 的汇总。 */
export interface GrowthCompletionReport {
  ok: boolean
  results: GrowthTaskResult[]
  completed: number
  clientOnly: number
  failed: number
  claimedCount: number
  claimedCredit: number
  /** 时间预算用尽、本轮提前收住。 */
  timedOut: boolean
  message?: string
}

/** 完成动作构造器的额外参数。 */
export interface EventSequenceOptions {
  conversationId?: string
  requestId?: string
  model?: string
  /** 真实专家；缺省时专家类回退通用对话链。 */
  expert?: MarketExpert
  templateId?: string
  templateName?: string
}

/** 一次成长端点调用的原始结果。 */
type GrowthCallResult =
  | { ok: true; status: number; body: GrowthEnvelope }
  | { ok: false; nonJson?: boolean; status?: number; message: string }

/** 写端点响应的三分类。 */
type GrowthWriteResult =
  | { state: 'success'; data: Record<string, unknown> }
  | { state: 'no-object'; message: string }
  | { state: 'failed'; code?: number; message: string }

/** 只带极简头的端点（会话族、上报族）共用的鉴权头。 */
function minimalHeaders(credential: BuddyCredential, product: BuddyProduct): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.access_token}`,
    'Content-Type': 'application/json',
    'User-Agent': product.userAgent,
  }
  if (credential.user_id) {
    headers['X-User-Id'] = credential.user_id
  }
  return headers
}

/**
 * `/v2/chat/completions` 的 `X-Conversation-*` 三头（**逐请求一次性 id**）。
 *
 * ## ⚠️ 这三枚头**不是**准入必需 —— 但那是**按账号**的（2026-10-16，IKM7SG 结清）
 *
 * 原先以为「三头缺一即 400/11128 `conversation id missing`」，PR #104 据此补了
 * 主链路。复测（真实凭据、约 90 次请求）**在该账号上**推翻了它：
 * - 逐枚消融适配器构造的 **14 枚头，全部仍 200**（含这三枚）；
 * - 逐级剥到「连 UA / 鉴权头 / 身份头都不发」仍 **200**；
 * - 6 模型 × 4 请求形状 = 48 格，三头与响应状态**零关联**；
 * - `conversation id missing` 这句 msg **零次复现**（同批复现了
 *   `first message is not system prompt` 与 `Illegal API invocation from an
 *   unapproved channel` 两句，证明这批请求确实打到了能报 11128 的网关）。
 *
 * ⚠️⚠️ **但 IKM7SG 用本仓库自己的 e2e（只换 `WB_REF`）证明这是「按账号」的**：
 * 在**特定账号**（实测 `66E05E7C`）上，三头**缺任一枚即 400/11128**；
 * 在**多数账号**（实测 `D87606B1`）上则非必需。
 * ⇒ 准确表述是「**在多数账号上不是；在特定账号上是**」。
 * 完整对照表与字段级穷举见 `src/buddy-adapter.ts` 内 `send()` 的对应注释。
 *
 * 上游对这三枚头的真实用法是**回显**：实测回包 `"id"` 的前缀 3/3 命中所发值，
 * 填 `abc-123` 时上游直接回 `"id":"abc-123"`。⚠️ 但 IKM7SG 实测到**在那个账号上
 * 「回显」与「准入判据」并存** ⇒ 「只当种子、不作判据」这句**对多数账号成立、
 * 对那个账号不成立**。
 *
 * ## ⇒ 那为什么还要发（理由已按 IKM7SG 更新）
 * 1. **对「要求三头」的账号是硬需求**（三枚齐全才 200）—— 不再是「反正无害」；
 * 2. 对多数账号无害（无三头也 200）；
 * 3. 官方客户端确实带这三枚，补上让后台归因与上游行为对齐；
 * 4. **三条出站路径形态统一**，将来上游若真的收紧校验，改一处即可。
 * ⚠️ ⇒ **删任何一枚都是错的**：IKM7SG 那批 14/14 消融数据**不能**用来论证
 *「可以删」—— 它只在**不要求三头**的账号上取得。
 *
 * ⚠️ 这也**纠正了 PR #104 里「buddy-growth 早已带一枚 ⇒ 属补一致性缺口」的
 * 论证**：那条论证本身是对的，但它恰恰是「一枚就够」的反证 —— 与
 * 「缺一即 400」矛盾。结论保留（三头照发），**理由按 IKM7SG 更新为
 * 「对『要求三头』的账号是硬需求 + 形态一致」**。
 *
 * ## ⚠️ 三头是逐请求 id，不是会话身份
 * 官方 `X-Conversation-ID = context.id`（**会话稳定**），本实现逐请求新生成
 * ⇒ 语义相反。实测上游不做跨轮状态机，故当前无害。
 * 完整对照表见 `src/buddy-adapter.ts` 内 `send()` 的对应注释。
 *
 * ## ⚠️ 两条旁路的可达性（成本登记）
 * - `chatRealSession`：**活路径** —— `skill_1` / `Expert_lighthouse` /
 *   通用真实会话，经「一键领取积分」触发（`runGrowthTaskCompletions` 内）。
 * - `keepStreakActive`（保连胜）：**2026-11-01 起有生产调用方** ——
 *   `claimStreakExtras` 第 6 步（随 `collectBuddyGrowth` 每轮保活跃）。
 *   2026-10-16 曾长期零调用，当时的补三头 + 守卫是为接入时形态不漂移。
 *
 * @param conversationId 逐请求生成的 32 位无横线 uuid
 */
export function conversationHeaders(conversationId: string): Record<string, string> {
  return {
    'X-Conversation-ID': conversationId,
    'X-Conversation-Request-ID': conversationId,
    'X-Conversation-Message-ID': conversationId,
  }
}

/** 生成 `/v2/chat/completions` 用的逐请求 conversation id（32 位无横线 uuid）。 */
export function newConversationId(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

/**
 * {@link growthHeaders} + 三枚 `X-Conversation-*`。
 *
 * ## ⚠️⚠️ 存在的原因是 {@link growthHeaders} 返回 **`Headers` 实例**
 * 不能用对象展开合并 —— JS 的 `Headers` 没有自有可枚举属性，`{...headers}`
 * **恒为 `{}`**。写错的后果是 `Authorization` 等 9 枚头**全部消失**、请求必然 401，
 * 而只断言「三枚 Conv 头齐全」的守卫**照样全绿**（第二轮审计实测的假绿）。
 * ⇒ 必须**在实例上逐枚 `set`**，且守卫要断言**原有头仍在**。
 */
function growthHeadersWithConversation(
  credential: BuddyCredential,
  product: BuddyProduct,
  conversationId: string,
): Headers {
  const headers = growthHeaders(credential, product)
  for (const [key, value] of Object.entries(conversationHeaders(conversationId))) {
    headers.set(key, value)
  }
  return headers
}

/** 从 JSON 安全读取字符串。 */
function readString(source: unknown, key: string): string {
  if (typeof source !== 'object' || source === null) {
    return ''
  }
  const value = (source as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : ''
}

/** 从 JSON 安全读取数字（非有限或非数字归 0）。 */
function readNumber(source: unknown, key: string): number {
  if (typeof source !== 'object' || source === null) {
    return 0
  }
  const value = (source as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 把端点基址尾斜杠去掉，避免拼出 `//`。 */
function baseOf(product: BuddyProduct): string {
  return String(product.endpoint).replace(/\/+$/, '')
}

/**
 * web 域**领奖**基址，取 `product.claimBase`。缺字段时返回 `''`（调用方须判空）。
 *
 * ⚠️ **不能直接 `String(product.claimBase)`**：`String(undefined)` 得到的是
 * **字符串 `"undefined"`** 而非抛错 —— URL 会拼成
 * `undefined/activity/growth/tasks/<code>/claim`，请求真的发出去，失败现象看起来
 * 像服务端问题，真因（本插件缺配置）却毫无线索。这类「不崩但静默错」比崩溃更难查。
 * （感谢 contributor 在 !62 复审中指出，原文见该 PR 讨论。）
 */
function claimBaseOf(product: BuddyProduct): string {
  const raw = typeof product.claimBase === 'string' ? product.claimBase.trim() : ''
  return raw.replace(/\/+$/, '')
}

/**
 * web 域**遥测上报**基址，取 `product.webBase`；未配置时退到 `claimBase`。
 *
 * ⚠️ 与 `claimBaseOf` **刻意分开**（见 `BuddyProduct.webBase` 的注释：领奖走
 * 产品 API 站、web 遥测走网页站，`Origin` / `Referer` 需各自独立配置）。
 * `webBase` 曾只定义不读取（死配置），此处是唯一读取点 —— 删字段前先确认这里。
 *
 * 回退顺序：`webBase` → `claimBase` → `''`（两站当前同主机，但取不到时宁可返回空
 * 让调用方报可读错误，也不要拼出 `undefined/...` 这种能发出去却指向本地缺配置的 URL）。
 */
function webBaseOf(product: BuddyProduct): string {
  const explicit = typeof product.webBase === 'string' ? product.webBase.trim() : ''
  if (explicit.length > 0) {
    return explicit.replace(/\/+$/, '')
  }
  return claimBaseOf(product)
}

/** SHA-256 十六进制摘要。桌面/网页指纹的 machineId 与 sessionId 由此派生。 */
function sha256Hex(input: unknown): string {
  return createHash('sha256').update(String(input)).digest('hex')
}

/** 构造成长中心请求头。与签到请求头（`credits.ts` 的 `checkinHeaders`）同款口径：
 * `X-Domain` 以**产品配置**为准而非凭据快照，避免国际版旧凭据把身份标识发错区域。
 * 额外带 `X-Client-Platform`（成长中心前端固定 `web`；小程序口径任务族
 * （Sequential_*）的 list/accept/claim 必须 `miniprogram`，缺头实测 `task not found`）。 */
function growthHeaders(
  credential: BuddyCredential,
  product: BuddyProduct,
  clientPlatform: string = 'web',
): Headers {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${credential.access_token}`)
  headers.set('Accept', 'application/json')
  headers.set('Content-Type', 'application/json')
  headers.set('X-Client-Platform', clientPlatform)
  headers.set(HTTP_HEADER_DOMAIN, product.apiDomain || credential.domain || '')
  headers.set(HTTP_HEADER_PRODUCT, BUDDY_DEPLOYMENT_TYPE)
  headers.set(HTTP_HEADER_PRODUCT_CODE, product.productCode)
  if (credential.user_id !== undefined && credential.user_id.length > 0) {
    headers.set('X-User-Id', credential.user_id)
  }
  if (credential.enterprise_id !== undefined && credential.enterprise_id.length > 0) {
    headers.set('X-Enterprise-Id', credential.enterprise_id)
    headers.set('X-Tenant-Id', credential.enterprise_id)
  }
  headers.set('User-Agent', product.userAgent)
  return headers
}

/**
 * 发起一次成长中心请求并解析 JSON。
 * 与签到同款：先取文本再解析，非 JSON（凭据失效的网关 HTML 页）时带上状态码，
 * 不把「凭据过期」压成 `Unexpected token '<'`。
 *
 * `method` 区分读/写：任务列表是 **GET**（POST 会 404），接取/领奖/盲盒/抽奖
 * 是 **POST**。默认 POST。`clientPlatform` 透传给 {@link growthHeaders}
 * （小程序口径任务传 `miniprogram`）。
 */
async function growthJson(
  method: 'GET' | 'POST',
  path: string,
  credential: BuddyCredential,
  product: BuddyProduct,
  body: unknown,
  fetcher: typeof fetch,
  clientPlatform: string = 'web',
): Promise<GrowthCallResult> {
  try {
    const response = await fetcher(`${product.endpoint}${path}`, {
      method,
      headers: growthHeaders(credential, product, clientPlatform),
      body: method === 'POST' && body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return {
        ok: false,
        nonJson: true,
        status: response.status,
        message: describeNonJsonResponse(response.status, text),
      }
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return { ok: false, status: response.status, message: '请求失败或响应无法解析' }
    }
    return { ok: true, status: response.status, body: parsed as GrowthEnvelope }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** 成长读端点（GET）请求。任务列表 / 旅行状态等。 */
function getGrowthJson(
  path: string,
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch,
  clientPlatform: string = 'web',
): Promise<GrowthCallResult> {
  return growthJson('GET', path, credential, product, undefined, fetcher, clientPlatform)
}

/** 成长写端点（POST）请求。接取 / 领奖 / 盲盒 / 抽奖 / 首Buddy。 */
function postGrowthJson(
  path: string,
  credential: BuddyCredential,
  product: BuddyProduct,
  body: unknown,
  fetcher: typeof fetch,
  clientPlatform: string = 'web',
): Promise<GrowthCallResult> {
  return growthJson('POST', path, credential, product, body, fetcher, clientPlatform)
}

/** 把「响应不是 JSON」整理成可读原因（同签到端点口径）。 */
function describeNonJsonResponse(status: number, text: string): string {
  if (status === 401 || status === 403) {
    return `凭据已失效（HTTP ${status}），请重新登录该账号`
  }
  const snippet = text.trim().slice(0, 80).replace(/\s+/g, ' ')
  return `服务端返回了非 JSON 响应（HTTP ${status}）：${snippet}`
}

/**
 * 「无对象」文案白名单（大小写不敏感的子串匹配）。
 *
 * ⚠️ **必须窄**：`code 400` 是成长端点表达多种语义的通用码 —— 它既表示
 * 「没有可领对象」（正常幂等终态），也表示 `task not completed`（任务真没做完）、
 * 参数错误等**真失败**。只认 code 会把后者一并归成「已领奖」，用户看到
 * 「已领到积分」而实际一分没有。
 *
 * 实测文案（2026-10-03）：
 * - `no unclaimed travel` —— 没有未领的旅行奖励
 * - `insufficient energy` —— 能量不足（盲盒/抽奖类）
 * - `please accept buddy adoption agreement first` —— 未签 Buddy 采纳协议
 *
 * ⚠️ 反向要求：白名单命中即**不再算失败**（归 `no-object` → `already-claimed`），
 * 故**宁可漏判不可误伤** —— 少了词条只会让某条正常终态被显示成失败（用户多点一次，
 * 无损害）；多了词条会把真失败谎报成成功（用户以为领到了）。这与本仓库
 * 「方向取保守」的总原则一致。
 */
const GROWTH_NO_OBJECT_MESSAGE_PATTERNS: readonly RegExp[] = [
  /no unclaimed travel/i,
  /insufficient energy/i,
  /accept buddy adoption agreement/i,
]

/** 该 msg 是否表示「没有可领对象」这一正常终态。 */
function isNoObjectMessage(message: string): boolean {
  return GROWTH_NO_OBJECT_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))
}

/**
 * 把一次成长写请求的响应归类为三类之一：
 * - `success`：code 0，返回 data（可能为空对象）。
 * - `no-object`：code 400 **且 msg 命中「无对象」文案**（无未领旅行/能量不足/未签协议）
 *   —— 这是**正常的幂等终态**，不是失败。
 * - `failed`：其余（含 code 400 但 msg 是 `task not completed` 这类真失败）。
 */
function classifyGrowthWrite(result: GrowthCallResult): GrowthWriteResult {
  if (!result.ok) {
    return { state: 'failed', message: result.message }
  }
  const body = result.body
  const code = typeof body.code === 'number' ? body.code : -1
  const message = readString(body, 'msg')
  if (code === 0) {
    const data =
      typeof body.data === 'object' && body.data !== null
        ? (body.data as Record<string, unknown>)
        : {}
    return { state: 'success', data }
  }
  // ⚠️ code 400 必须**同时**看 msg：见上面白名单的注释（此处曾把任何 code 400
  // 都当幂等终态，于是 `task not completed` 被谎报成「已领奖」）。
  if (code === GROWTH_NO_OBJECT_CODE && isNoObjectMessage(message)) {
    return { state: 'no-object', message }
  }
  return { state: 'failed', code, message: message.length > 0 ? message : '领取失败' }
}

/** 从信封里取任务数组。 */
function tasksOf(result: GrowthCallResult): GrowthTaskItem[] {
  if (!result.ok || result.body.code !== 0) {
    return []
  }
  const data = result.body.data
  if (typeof data !== 'object' || data === null) {
    return []
  }
  const tasks = (data as GrowthTaskData).tasks
  return Array.isArray(tasks) ? tasks : []
}

/**
 * 查询账号的成长任务列表，筛出「白名单且尚未接取/完成」的任务码。
 * 返回 `ok:false`（而非空 `codes`）表示查询失败 —— 让调用方区分「查不到」与「没有可接任务」。
 */
export async function fetchGrowthTaskCodes(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch = fetch,
  options: GrowthTaskQueryOptions = {},
): Promise<GrowthTaskQuery> {
  const includeInProgress = options.includeInProgress === true
  /**
   * ⚠ 必须**合并**两个端点，不能命中第一个就 return。
   *
   * 成长中心有两族任务，schema 完全不同：
   *
   * | 族 | 端点 | 码字段 | 状态字段 | progress |
   * |---|---|---|---|---|
   * | 成长任务 | `/v2/activity/growth/tasks` | `task_code` | `accept_status` | 有 |
   * | 养虾等级 | `/activity/growth/tasks` | `code` | `status`（`available` 等） | **无** |
   *
   * 原实现命中 `/v2/...` 就返回 ⇒ 等级族 5 项（`first_chat` / `skill_installed` /
   * `wechat_linked` / `expert_summoned` / `template_used`）**永远进不了待办**。
   * 且它只读 `task_code`，等级族返回的是 `code`，即使读到也会被跳过。
   */
  const progressByCode: Record<string, GrowthProgress> = {}
  const pending: string[] = []
  const toAccept = new Set<string>()
  let total = 0
  let anyOk = false
  /** 首个失败原因（供下游区分「凭据失效」与「没有任务」，见 GrowthTaskQuery.message）。 */
  let failureMessage = ''
  /**
   * 查询描述符：两族 web 口径 + 小程序口径。⚠ 必须**全查并合并**，不能命中第一个
   * 就 return —— 三份列表各有独占任务（成长族在 /v2、等级族在 v1、Sequential_* 族
   * 只在 mp 头口径下发；mp 列表虽是默认口径的超集，但默认两族互不包含）。
   */
  const queries: ReadonlyArray<readonly [path: string, platform: string]> = [
    ...GROWTH_TASKS_PATHS.map((p) => [p, 'web'] as const),
    [GROWTH_TASKS_PATHS[0], MP_PLATFORM_HEADER] as const,
  ]
  for (const [path, platform] of queries) {
    const result = await getGrowthJson(path, credential, product, fetcher, platform)
    if (!result.ok || result.body.code !== 0) {
      // 只留首个原因：几个口径通常同因失败，后者多为级联。
      if (failureMessage.length === 0) {
        failureMessage = result.ok
          ? `任务列表返回 code ${String(result.body.code)}`
          : result.message
      }
      continue
    }
    anyOk = true
    const tasks = tasksOf(result)
    total += tasks.length
    for (const task of tasks) {
      if (typeof task !== 'object' || task === null) {
        continue
      }
      // 两族的码字段不同：`task_code`（成长）/ `code`（等级）。
      const taskCode = readString(task, 'task_code') || readString(task, 'code')
      if (!AUTOMATABLE_TASK_CODES.has(taskCode)) {
        continue
      }
      const progress = task.progress ?? {}
      const acceptStatus = readString(task, 'accept_status')
      if (acceptStatus !== '') {
        // 成长族：按 progress 与 accept_status 判定。
        progressByCode[taskCode] = {
          current: readNumber(progress, 'current'),
          target: readNumber(progress, 'target') || 1,
        }
        // 小程序族的「每日零点解锁一环」：locked 期间 accept 不落账（实测返回
        // prerequisite not met），如实跳过 —— 不进 pending，留给解锁后的下一轮。
        if (task.locked === true) {
          continue
        }
        if (includeInProgress) {
          if (
            acceptStatus === 'not_accepted' ||
            acceptStatus === 'in_progress' ||
            acceptStatus === 'accepted'
          ) {
            pending.push(taskCode)
            if (acceptStatus === 'not_accepted') {
              toAccept.add(taskCode)
            }
          }
        } else if (acceptStatus === 'not_accepted') {
          pending.push(taskCode)
        }
        continue
      }
      // 等级族：无 accept_status、无 progress，判据是服务端记录的真实活动。
      // `status` 非 available 即视为已达成（不再重复做）。
      const status = readString(task, 'status')
      progressByCode[taskCode] = { current: status === 'available' ? 0 : 1, target: 1 }
      if (status === 'available') {
        pending.push(taskCode)
      }
    }
  }
  if (!anyOk) {
    return {
      ok: false, codes: [], total: 0,
      message: failureMessage.length > 0 ? failureMessage : '任务列表查询失败',
    }
  }
  const base = { ok: true, codes: [...new Set(pending)], total }
  return includeInProgress ? { ...base, toAccept, progressByCode } : base
}

/**
 * 执行**每日成长领取**（低副作用核心）。
 *
 * 步骤（串行，防风控）：
 *   1. 拉任务列表，接取所有「白名单且 not_accepted」的任务；
 *   2. 旅行领奖 —— 无未领旅行时归类为 `already-claimed`。
 *
 * 返回单个 {@link ClaimOutcome}：`kind` 取**本次真正到账**的口径 ——
 * 只要接取或领奖**任一成功**且到账 credit/energy > 0 计 `claimed`（接取本身
 * 不加积分，credit 取旅行领奖的 `reward_credit`；接取成功但无旅行奖时 credit=0
 * 仍计 `claimed`，因为已把可完成任务推进到 in_progress）。全部无对象计
 * `already-claimed`；网络/解析失败计 `failed`。
 *
 * ⚠️ `runExotic`（默认 `false`）开启时才追加盲盒/抽奖/首Buddy 的**有代价/一次性**
 * 动作。默认路径只做接取+旅行领奖，避免误触消耗 energy / 一次性解锁。
 */
export async function claimAllGrowth(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch = fetch,
  options: GrowthClaimOptions = {},
): Promise<ClaimOutcome> {
  const runExotic = options.runExotic === true
  const notes: string[] = []
  let acceptedCount = 0
  let acceptedOk = false
  // 1) 任务接取（web/mp 两口径分流，Sequential_* 族必须 mp 头）
  const tasks = await fetchGrowthTaskCodes(credential, product, fetcher)
  if (tasks.ok && tasks.codes.length > 0) {
    // ⚠ mp 码不在这里 accept：本函数不做完成动作，抢 accept 只会留下
    // 「已登记未完成」的登记态；mp 任务（含 accept+上报+领奖闭环）由
    // runGrowthTaskCompletions 的 runner 全链路承担。mp 任务的**领奖**不受影响 ——
    // 扫尾/claimGrowthTaskReward 对 mp 码自动换 miniprogram 头。
    const webCodes = tasks.codes.filter((c) => !isMpTaskCode(c))
    if (webCodes.length > 0) {
      const accept = classifyGrowthWrite(
        await postGrowthJson(
          GROWTH_TASK_ACCEPT_PATH, credential, product, { task_codes: webCodes }, fetcher,
        ),
      )
      if (accept.state === 'success') {
        acceptedOk = true
        acceptedCount += webCodes.length
      } else if (accept.state === 'failed') {
        notes.push(`任务接取失败：${accept.message}`)
      }
    }
  }
  // 2) 旅行领奖。dsh 实测口径 body `{}` 即可（2026-10-03）；Go 面板口径 claim 必带
  //    `{record_id}`（取自 travel/status）。两条口径并存 ⇒ 先按实测的 `{}` 发，
  //    失败且 msg 提到 record 时按新口径取 record_id 重试一次（严格增量，不动已验证路径）。
  let travel = classifyGrowthWrite(
    await postGrowthJson(GROWTH_TRAVEL_CLAIM_PATH, credential, product, {}, fetcher),
  )
  if (travel.state === 'failed' && /record/i.test(travel.message)) {
    const statusRes = await getGrowthJson(GROWTH_TRAVEL_STATUS_PATH, credential, product, fetcher)
    const statusData = statusRes.ok && statusRes.body.code === 0 &&
        typeof statusRes.body.data === 'object' && statusRes.body.data !== null
      ? (statusRes.body.data as Record<string, unknown>)
      : {}
    const recordId = String(statusData['record_id'] ?? '')
    if (recordId.length > 0) {
      travel = classifyGrowthWrite(
        await postGrowthJson(
          GROWTH_TRAVEL_CLAIM_PATH, credential, product, { record_id: recordId }, fetcher,
        ),
      )
    }
  }
  let credit = 0
  if (travel.state === 'success') {
    credit = readNumber(travel.data, 'reward_credit')
    if (credit > 0 || acceptedOk) {
      notes.push(credit > 0 ? `旅行领奖 +${credit}` : '已接取待完成任务')
    } else {
      notes.push('旅行已领奖')
    }
  } else if (travel.state === 'no-object') {
    // 「无未领旅行」是正常终态：若上面也没接取成功，则整轮无新增。
    if (notes.length === 0) {
      notes.push(travel.message)
    }
  } else {
    notes.push(`旅行领奖失败：${travel.message}`)
  }
  // 3)（可选）有代价动作 —— 默认关闭。首Buddy 领养带 agreement 前置（缺它实测
  //    400 adoption agreement）；抽奖走实测路径（无 /v2 前缀）。
  let exoticCredit = 0
  if (runExotic) {
    const agreement = classifyGrowthWrite(
      await postGrowthJson(GROWTH_BUDDY_AGREEMENT_PATH, credential, product, { agree: true }, fetcher),
    )
    if (agreement.state === 'success') {
      notes.push('已同意 Buddy 采纳协议')
    }
    const first = classifyGrowthWrite(
      await postGrowthJson(GROWTH_FIRST_BUDDY_PATH, credential, product, {}, fetcher),
    )
    if (first.state === 'success') {
      exoticCredit += readNumber(first.data, 'reward_credit')
      notes.push('已解锁首个 Buddy')
    }
    const box = classifyGrowthWrite(
      await postGrowthJson(GROWTH_BLIND_BOX_PATH, credential, product, { count: 1 }, fetcher),
    )
    if (box.state === 'success') {
      notes.push('已开启盲盒')
    }
    const lottery = classifyGrowthWrite(
      await postGrowthJson(
        GROWTH_LOTTERY_DRAW_PATH,
        credential,
        product,
        { client_token: `jh-${Date.now()}` },
        fetcher,
      ),
    )
    if (lottery.state === 'success') {
      notes.push('已抽奖')
    }
  }
  // 汇总为单个 ClaimOutcome（与 credits.ts 的汇总口径对齐）
  const totalCredit = credit + exoticCredit
  const anyProgress = acceptedOk || totalCredit > 0
  if (anyProgress) {
    const claimed: ClaimOutcome = {
      kind: 'claimed',
      credit: totalCredit,
      streakDays: 0,
      isStreakDay: false,
      ...(notes.length > 0 ? { message: notes.join('；') } : {}),
      ...(acceptedCount > 0 ? { acceptedCount } : {}),
    }
    return claimed
  }
  if (
    travel.state === 'no-object' ||
    notes.some((n) => /暂无可领取|无未领|已领奖/.test(n))
  ) {
    return {
      kind: 'already-claimed',
      message: notes.length > 0 ? notes.join('；') : '暂无可领取的成长奖励',
    }
  }
  if (notes.length > 0 && notes.every((n) => /失败/.test(n))) {
    return { kind: 'failed', code: -1, message: notes.join('；') }
  }
  return { kind: 'failed', code: -1, message: '成长中心无可用奖励' }
}

/** 保连胜：向 buddy-adapter 同款 chat completions 端点发一条「你好」，
 * 触发一次「活跃」记录以维持 `streak_days`（签到积分倍数基数）。
 *
 * 不新建通道 —— 复用 buddy 既有 `POST ${product.endpoint}/v2/chat/completions`
 * 端点与 `product.userAgent`（归因账单用），只改 body。连胜断一天签到基数归零，
 * 故这是本机唯一还能 API 化的积分相关动作（做任务本身必须客户端真操作）。
 * 幂等：重复调用只是多发一次对话，不重复计积分（活跃按天去重，服务端保证）。
 * 低频：串行 + 单账号单条，避免触发风控。
 *
 * ⚠️ **本文件是第三条直连腾讯端点的旁路，不经 `BuddyAdapter`，因此不过
 * `tencent-fingerprint` 的内容级风控改写**（同一文件里另一处发 chat 的
 * `fetchRealRequestId` 同理）。当前**安全**，因为两处的请求体都是**写死的短消息**
 * （「你好」/「1+1等于几」），既不含风控指纹、也没有 assistant 历史。
 * ⚠️ 但这条安全性**依赖「请求体写死」这个易碎前提**：一旦将来改成携带会话历史
 * 或把用户内容拼进来，就必须同时接上 `rewriteTencentContentFingerprints`
 * （见 `src/openai-gateway/tencent-fingerprint.ts`），否则会静默变成一个
 * 未改写的入口 —— 而那种失败的表象是「整轮 400/11128」，极难归因。
 */
/**
 * 连登档位兑换结果行（并入账号结果的合成任务行，UI 按普通任务行渲染）。
 */
export interface StreakExtraRow {
  /** 展示码（如 `(连登兑换:7d)`），带括号与真实 task_code 区分。 */
  taskCode: string
  ok: boolean
  message: string
}

/** {@link claimStreakExtras} 的汇总。 */
export interface StreakExtrasReport {
  ok: boolean
  /** 净新增积分（兑换 + 礼包 + 首Buddy；抽奖奖品不计积分）。 */
  credit: number
  /** 有真实到账的领取动作数（兑换/礼包/首Buddy），供 claimedCount 汇总。 */
  claimedCount: number
  /** 抽奖次数。 */
  drewCount: number
  /** 补签张数。 */
  makeupUsed: number
  notes: string[]
  rows: StreakExtraRow[]
  /** 任一响应报「凭据已失效」⇒ 下游按僵尸账号处置。 */
  expired: boolean
}

/** 连登档位 status 的「无需兑换」终态。locked = 天数未到；claimed = 已兑。 */
function isTierSettled(status: string): boolean {
  return status === 'locked' || status === 'claimed'
}

/** 抽奖安全上限（chances 异常大时兜底，防一次跑出天文次数）。 */
const LOTTERY_DRAW_CAP = 20

/**
 * 连登链 + 一次性奖励的自动领取（幂等，全部「有则领、无则跳过」）：
 *
 *   1. 补签保连登：heatmap 找本月漏签日 → 有补签卡则从最近一天往回补
 *      （连续天数一断就要重攒 7 天，直接影响兑换资格）；
 *   2. 兑换已解锁档位（7d/14d/28d → credit/energy/补签卡/抽奖次数）；
 *   3. 按 chances 抽完抽奖（次数只能从兑换获得，抽完即止，不预支不透支）；
 *   4. 首 Buddy 领养（agreement 前置 → first，+300 一次性纯收益）；
 *   5. 新手礼包（billing 域：先查状态，待领才领）；
 *   6. 保连胜：发一条真实短对话维持 streak_days（签到积分倍数基数）。
 *
 * 每步独立 catch，单步失败不中断后续（对齐「单号失败不中断整体」口径）。
 * **刻意不含盲盒** —— 它消耗能量（把任务挣来的资源花掉），不是领积分。
 */
export async function claimStreakExtras(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch = fetch,
  deadlineAt?: number,
): Promise<StreakExtrasReport> {
  const notes: string[] = []
  const rows: StreakExtraRow[] = []
  let credit = 0
  let claimedCount = 0
  let drewCount = 0
  let makeupUsed = 0
  let expired = false
  /**
   * 每步开跑前的预算闸门：连登链固定 ~10 请求 + 补签/抽奖若干，病态网络下最坏
   * 可拖数分钟 —— 不受整轮 deadline 约束时，N 个账号串行会把整轮拖爆宿主 RPC
   * 超时（2026-11-01 审计 P1：此前完全豁免）。超时后剩余步骤如实记一笔并跳过。
   */
  const budgetLeft = (): boolean => {
    if (deadlineAt === undefined || Date.now() < deadlineAt) {
      return true
    }
    notes.push('连登链：本轮时间预算已用尽，剩余步骤未执行（再点一次可继续）')
    return false
  }
  const markExpired = (message: string): void => {
    if (/凭据已失效/.test(message)) {
      expired = true
    }
  }

  if (!budgetLeft()) {
    return { ok: true, credit, claimedCount, drewCount, makeupUsed, notes, rows, expired }
  }
  // 1+2) 连登状态：补签 + 兑换（同一份 streak 载荷）。
  let streakFull: Record<string, unknown> | undefined
  const streakRes = await getGrowthJson(GROWTH_STREAK_PATH, credential, product, fetcher)
  if (streakRes.ok && streakRes.body.code === 0 &&
      typeof streakRes.body.data === 'object' && streakRes.body.data !== null) {
    streakFull = streakRes.body.data as Record<string, unknown>
  } else {
    const reason = streakRes.ok
      ? `code ${String(streakRes.body.code)}`
      : streakRes.message
    notes.push(`连登状态查询失败：${reason}`)
    markExpired(reason)
  }

  // 1) 补签：本月（1 号起）到昨天之间 score==0 的日子，从最近一天往回补。
  if (streakFull !== undefined) {
    try {
      const heat = await getGrowthJson(GROWTH_HEATMAP_PATH, credential, product, fetcher)
      if (heat.ok && heat.body.code === 0 && typeof heat.body.data === 'object' && heat.body.data !== null) {
        const data = heat.body.data as Record<string, unknown>
        const cells = Array.isArray(data['cells']) ? (data['cells'] as unknown[]) : []
        // today 是嵌套对象 {date}：宿主机时钟不可靠（UTC 误会算错天），窗口以下
        // 响应给的 today.date 为准。
        const todayObj = typeof data['today'] === 'object' && data['today'] !== null
          ? (data['today'] as Record<string, unknown>)
          : {}
        const todayDate = readString(todayObj, 'date')
        const cards = typeof streakFull['makeup_cards'] === 'object' && streakFull['makeup_cards'] !== null
          ? (streakFull['makeup_cards'] as Record<string, unknown>)
          : {}
        let balance = readNumber(cards, 'balance')
        if (todayDate.length >= 10 && balance > 0) {
          const monthStart = `${todayDate.slice(0, 8)}01`
          const broken = cells
            .map((cell) => (typeof cell === 'object' && cell !== null ? cell as Record<string, unknown> : {}))
            .filter((cell) => {
              const d = readString(cell, 'date')
              return d.length >= 10 && readNumber(cell, 'score') === 0 &&
                d >= monthStart && d < todayDate.slice(0, 10)
            })
            .map((cell) => readString(cell, 'date'))
            .sort()
          for (let i = 0; i < Math.min(balance, broken.length); i++) {
            const targetDate = broken[broken.length - 1 - i] as string
            const use = classifyGrowthWrite(
              await postGrowthJson(
                GROWTH_MAKEUP_USE_PATH, credential, product, { target_date: targetDate }, fetcher,
              ),
            )
            if (use.state === 'success') {
              makeupUsed += 1
              balance -= 1
              rows.push({ taskCode: '(补签)', ok: true, message: `已用补签卡补签 ${targetDate}（保连登）` })
            } else if (use.state === 'failed') {
              markExpired(use.message)
              rows.push({ taskCode: '(补签)', ok: true, message: `补签 ${targetDate} 未成：${use.message}` })
              break // 上游拒绝即停（注册前的日子同样是 0 分，只能由拒绝兜底）
            }
          }
          if (makeupUsed > 0) {
            notes.push(`补签 ${makeupUsed} 天`)
          }
        }
      }
    } catch (error) {
      notes.push(`补签跳过：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 2) 兑换已解锁档位。解锁状态以上一轮补签后的新查询为准（刚补的签到可能刚好
  //    跨过 7 天门槛）——多一次 GET，收益是档位不漏。
  try {
    const fresh = await getGrowthJson(GROWTH_STREAK_PATH, credential, product, fetcher)
    if (fresh.ok && fresh.body.code === 0 && typeof fresh.body.data === 'object' && fresh.body.data !== null) {
      streakFull = fresh.body.data as Record<string, unknown>
    }
    if (streakFull !== undefined) {
      const redemption = typeof streakFull['redemption_status'] === 'object' && streakFull['redemption_status'] !== null
        ? (streakFull['redemption_status'] as Record<string, unknown>)
        : {}
      const statuses: Record<string, string> = {
        '7d': readString(redemption, 'tier_7d_status'),
        '14d': readString(redemption, 'tier_14d_status'),
        '28d': readString(redemption, 'tier_28d_status'),
      }
      const tiers = Array.isArray(redemption['tiers']) ? (redemption['tiers'] as unknown[]) : []
      for (const tierRow of tiers) {
        if (typeof tierRow !== 'object' || tierRow === null) {
          continue
        }
        const tier = readString(tierRow, 'tier')
        if (tier.length === 0 || isTierSettled(statuses[tier] ?? '')) {
          continue
        }
        const redeem = classifyGrowthWrite(
          await postGrowthJson(
            GROWTH_REDEEM_PATH, credential, product,
            { tier, client_token: `jh-${crypto.randomUUID()}` }, fetcher,
          ),
        )
        if (redeem.state === 'success') {
          const tierCredit = readNumber(tierRow, 'credit')
          credit += tierCredit
          claimedCount += 1
          const chances = readNumber(tierRow, 'chances')
          rows.push({
            taskCode: `(连登兑换:${tier})`, ok: true,
            message: `已兑换 ${tier} 档（+${tierCredit} 积分${chances > 0 ? `，+${chances} 抽奖次数` : ''}）`,
          })
        } else if (redeem.state === 'failed') {
          markExpired(redeem.message)
          // 天数不足/未解锁是正常竞态（补签后状态未刷新），不算失败行。
          if (/天数不足|locked|not unlocked/i.test(redeem.message)) {
            continue
          }
          rows.push({ taskCode: `(连登兑换:${tier})`, ok: true, message: `兑换未成：${redeem.message}` })
        }
      }
    }
  } catch (error) {
    notes.push(`连登兑换跳过：${error instanceof Error ? error.message : String(error)}`)
  }

  if (!budgetLeft()) {
    return { ok: true, credit, claimedCount, drewCount, makeupUsed, notes, rows, expired }
  }
  // 3) 抽奖：chances 有多少抽多少（不预支）。summary 打不到时跳过（不盲抽）。
  try {
    const summary = await getGrowthJson(GROWTH_LOTTERY_SUMMARY_PATH, credential, product, fetcher)
    if (summary.ok && summary.body.code === 0 && typeof summary.body.data === 'object' && summary.body.data !== null) {
      const data = summary.body.data as Record<string, unknown>
      const chances = readNumber(data, 'chances')
      const module = typeof data['module'] === 'object' && data['module'] !== null
        ? (data['module'] as Record<string, unknown>)
        : {}
      const enabled = module['enabled'] !== false
      if (enabled && chances > 0) {
        for (let i = 0; i < Math.min(chances, LOTTERY_DRAW_CAP); i++) {
          if (!budgetLeft()) {
            break
          }
          const draw = classifyGrowthWrite(
            await postGrowthJson(
              GROWTH_LOTTERY_DRAW_PATH, credential, product,
              { client_token: `jh-${crypto.randomUUID()}` }, fetcher,
            ),
          )
          if (draw.state === 'success') {
            drewCount += 1
          } else {
            markExpired(draw.message)
            break // 无次数/限频即停
          }
        }
        if (drewCount > 0) {
          rows.push({ taskCode: '(抽奖)', ok: true, message: `已抽奖 ${drewCount} 次` })
        }
      }
    }
  } catch (error) {
    notes.push(`抽奖跳过：${error instanceof Error ? error.message : String(error)}`)
  }

  if (!budgetLeft()) {
    return { ok: true, credit, claimedCount, drewCount, makeupUsed, notes, rows, expired }
  }
  // 4) 首 Buddy 领养（一次性 +300）：agreement 前置（幂等）→ first。先补一条活跃
  // 事件（领养门槛 = 当日活跃，Go 面板同款前置；失败不阻断）。
  try {
    const activeConv = `jb-active-${Date.now()}`
    await reportDesktopEvents(
      credential, product, fetcher,
      [chatRequestSendEvent(FAST_MODEL, FAST_MODEL, activeConv)],
      activeConv, `${activeConv}-r`,
    ).catch(() => undefined)
    const agreement = classifyGrowthWrite(
      await postGrowthJson(GROWTH_BUDDY_AGREEMENT_PATH, credential, product, { agree: true }, fetcher),
    )
    if (agreement.state === 'failed') {
      markExpired(agreement.message)
    }
    const first = classifyGrowthWrite(
      await postGrowthJson(GROWTH_FIRST_BUDDY_PATH, credential, product, {}, fetcher),
    )
    if (first.state === 'success') {
      const firstCredit = readNumber(first.data, 'reward_credit')
      credit += firstCredit
      claimedCount += 1
      rows.push({ taskCode: '(首Buddy)', ok: true, message: `已领养首个 Buddy（+${firstCredit} 积分）` })
    }
    // no-object（已领养/门槛未过）静默 —— 正常终态。
  } catch (error) {
    notes.push(`首Buddy 领养跳过：${error instanceof Error ? error.message : String(error)}`)
  }

  if (!budgetLeft()) {
    return { ok: true, credit, claimedCount, drewCount, makeupUsed, notes, rows, expired }
  }
  // 5) 新手礼包（billing 域，webBase；先查状态、待领才领 —— 盲领会把「已领过」
  //    打成假的「+0 积分」成功行）。
  try {
    const webBase = webBaseOf(product)
    if (webBase.length > 0) {
      const headers = {
        ...minimalHeaders(credential, product),
        Accept: 'application/json',
        Origin: webBase,
      }
      const statusRes = await fetcher(`${webBase}${GIFT_STATUS_PATH}`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers,
        body: '{}',
      })
      const statusText = await statusRes.text()
      let statusPayload: unknown
      try {
        statusPayload = JSON.parse(statusText)
      } catch {
        statusPayload = null
      }
      if (statusRes.status === 401 || statusRes.status === 403) {
        expired = true
        rows.push({ taskCode: '(新手礼包)', ok: true, message: `凭据已失效（HTTP ${statusRes.status}）` })
      } else if (typeof statusPayload === 'object' && statusPayload !== null) {
        const envelope = statusPayload as Record<string, unknown>
        const data = typeof envelope['data'] === 'object' && envelope['data'] !== null
          ? (envelope['data'] as Record<string, unknown>)
          : {}
        const active = data['active'] === true
        const claimed = data['claimed'] === true
        const creditNum = readNumber(data, 'credit_num')
        if (active && !claimed && creditNum > 0) {
          const claimRes = await fetcher(`${webBase}${GIFT_CLAIM_PATH}`, {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            headers,
            body: '{}',
          })
          if (claimRes.status === 401 || claimRes.status === 403) {
            // 领取阶段的凭据失效同样必须传播（否则僵尸信号在两发请求之间死亡就漏判）。
            expired = true
            rows.push({ taskCode: '(新手礼包)', ok: true, message: `凭据已失效（HTTP ${claimRes.status}）` })
          }
          const claimText = await claimRes.text()
          let claimPayload: unknown = null
          try {
            claimPayload = JSON.parse(claimText)
          } catch {
            claimPayload = null
          }
          const claimData = (typeof claimPayload === 'object' && claimPayload !== null
            ? (claimPayload as Record<string, unknown>)['data']
            : null)
          const gotCredit = typeof claimData === 'object' && claimData !== null
            ? readNumber(claimData as Record<string, unknown>, 'credit')
            : readNumber(claimPayload as Record<string, unknown>, 'credit')
          if (claimRes.ok) {
            credit += gotCredit > 0 ? gotCredit : creditNum
            claimedCount += 1
            rows.push({ taskCode: '(新手礼包)', ok: true, message: `已领取新手礼包（+${gotCredit > 0 ? gotCredit : creditNum} 积分）` })
          } else {
            rows.push({ taskCode: '(新手礼包)', ok: true, message: `礼包领取失败：HTTP ${claimRes.status}` })
          }
        }
      }
    }
  } catch (error) {
    notes.push(`新手礼包跳过：${error instanceof Error ? error.message : String(error)}`)
  }

  if (!budgetLeft()) {
    return { ok: true, credit, claimedCount, drewCount, makeupUsed, notes, rows, expired }
  }
  // 6) 保连胜：一条真实短对话维持 streak_days（签到倍数基数）。幂等（活跃按天
  //    去重），失败不影响其它路径。
  try {
    const keep = await keepStreakActive(credential, product, fetcher)
    if (keep.ok) {
      rows.push({ taskCode: '(保连胜)', ok: true, message: keep.message })
    } else {
      markExpired(keep.message)
      rows.push({ taskCode: '(保连胜)', ok: true, message: keep.message })
    }
  } catch (error) {
    notes.push(`保连胜跳过：${error instanceof Error ? error.message : String(error)}`)
  }

  return { ok: true, credit, claimedCount, drewCount, makeupUsed, notes, rows, expired }
}

export async function keepStreakActive(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch = fetch,
): Promise<{ ok: boolean; message: string }> {
  const body = {
    model: 'default-model',
    messages: [{ role: 'user', content: '你好' }],
    max_tokens: 8,
    stream: true,
  }
  try {
    const response = await fetcher(`${product.endpoint}/v2/chat/completions`, {
      method: 'POST',
      // ⚠️⚠️ **绝不能**写成 `{ ...growthHeaders(...), ...conversationHeaders(...) }`：
      // `growthHeaders` 返回的是 **`Headers` 实例**（见其签名），而 JS 的 `Headers`
      // **没有自有可枚举属性** —— 对象展开恒为 `{}`：
      //   `new Headers([['a','1'],['b','2']]).spread` → `{}`
      // ⇒ 那样写会让 `Authorization` / `X-Domain` / `X-Product` / `X-User-Id` /
      // `User-Agent` 等 9 枚头**全部消失**，请求必然 401。
      // （2026-10-16 第二轮审计实测发现：本 PR 的初版正是这样写的，
      //   而当时的两条守卫只断言三枚 Conv 头齐全 ⇒ **假绿放过了这个回归**。）
      // 故改为：在 `Headers` 实例上**逐枚 set**，不新建对象。
      headers: growthHeadersWithConversation(credential, product, newConversationId()),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: `凭据已失效（HTTP ${response.status}），请重新登录该账号` }
    }
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '')
      let parsed: unknown = null
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = null
      }
      const reason = parsed === null ? '' : readString(parsed, 'msg') || readString(parsed, 'error')
      const message = reason.length > 0 ? reason : `保连胜请求失败（HTTP ${response.status}）`
      return { ok: false, message }
    }
    // 读 SSE 流直到拿到首个内容块（活跃已记录）或流结束；不消费完整个回复，省 token。
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        buffer += decoder.decode(value, { stream: true })
        // 首个 data 行即表明服务端已受理本次对话，足够记录一次活跃。
        if (/^data:/.test(buffer) || buffer.includes('"delta"') || buffer.includes('"content"')) {
          break
        }
      }
    } catch (error) {
      return {
        ok: false,
        message: `保连胜流读取失败：${error instanceof Error ? error.message : String(error)}`,
      }
    }
    return { ok: true, message: '已发送保活跃消息' }
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      return { ok: false, message: '保连胜请求超时' }
    }
    return {
      ok: false,
      message: `保连胜请求失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * 查询连登状态。端点为 **`/activity/growth/streak`（无 /v2 前缀）**，响应形状
 * `data.streak.days`（实测口径 —— 本函数早先按猜的 `/v2/...` + `data.days` 写，
 * 零调用方掩盖了它打不到东西的事实；2026-11-01 按 Go 面板实测口径校正）。
 */
export async function fetchStreakStatus(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch = fetch,
): Promise<{ ok: boolean; days: number; makeupCards: number }> {
  const result = await getGrowthJson(GROWTH_STREAK_PATH, credential, product, fetcher)
  if (!result.ok || result.body.code !== 0) {
    return { ok: false, days: 0, makeupCards: 0 }
  }
  const data = result.body.data
  if (typeof data !== 'object' || data === null) {
    return { ok: true, days: 0, makeupCards: 0 }
  }
  const record = data as Record<string, unknown>
  const streak = typeof record['streak'] === 'object' && record['streak'] !== null
    ? (record['streak'] as Record<string, unknown>)
    : {}
  const cards = typeof record['makeup_cards'] === 'object' && record['makeup_cards'] !== null
    ? (record['makeup_cards'] as Record<string, unknown>)
    : {}
  return {
    ok: true,
    days: readNumber(streak, 'days'),
    makeupCards: readNumber(cards, 'balance'),
  }
}

/**
 * 建一次画布会话（`create_canvas` 的前置动作，副作用最小档）。
 *
 * ⚠️ **只带极简头**（Authorization + Content-Type + User-Agent，与 curl 实证
 * 200 的那套一致）。`/console/as/` 会话族端点对 `growthHeaders` 的多余身份头
 * （`X-Client-Platform:web` / `X-Domain` / `X-Product` / `X-Product-Code`）做
 * 鉴权收紧会回 401，故不能复用 `growthHeaders`——这与成长中心族端点要全套头
 * 的特性相反。
 */
export async function createCanvasTask(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch = fetch,
): Promise<{ ok: boolean; conversationId?: string; message: string }> {
  try {
    const response = await fetcher(`${baseOf(product)}/console/as/conversations/`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: minimalHeaders(credential, product),
      body: JSON.stringify({ title: 'canvas' }),
    })
    const text = await response.text()
    let payload: GrowthEnvelope
    try {
      payload = JSON.parse(text) as GrowthEnvelope
    } catch {
      return { ok: false, message: describeNonJsonResponse(response.status, text) }
    }
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, message: '建画布会话响应无法解析' }
    }
    if (!response.ok || (payload.code !== undefined && payload.code !== 0)) {
      return {
        ok: false,
        message: payload.msg ?? `建画布会话接口 HTTP ${response.status}`,
      }
    }
    const data =
      typeof payload.data === 'object' && payload.data !== null
        ? (payload.data as Record<string, unknown>)
        : {}
    const conversationId = readString(data, 'id')
    return {
      ok: true,
      conversationId,
      message: conversationId.length > 0 ? `画布会话已建（${conversationId}）` : '画布会话已建',
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      return { ok: false, message: '建画布会话请求超时' }
    }
    return {
      ok: false,
      message: `建画布会话失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * 各「API 可达」成长任务的**完成动作**映射。
 *
 * 与 {@link AUTOMATABLE_TASK_CODES}（可接取）区分：接取把任务置 `in_progress`，
 * **积分在完成动作后由服务端发放**。本表只列能纯 API 完成的 task_code；
 * 微信服务号订阅（wb_wechat_oa_subscribe_task）等仅客户端可完成的不在这里（CLIENT_ONLY 降级）。
 *
 * 动作类型（按副作用递增）：
 * - `canvas`：建一条画布会话（`create_canvas`）。
 * - `chat`：发对话/事件链（`playbook_prompt`/`chat_5`/`expert_5`/`template_5`…）。
 * - `canvasThenChat`：先建画布再发首条消息（`create_canvas` 的完整闭环）。
 * - `webClick`：web 域浏览器指纹单事件（`Library_read` 判据）。
 * - `appearance`：主题设置 API + 皮肤生效事件（`Hp_Appearance` 判据）。
 * - `skillFresh`：真实会话（服务端 id）+ skill_info 事件（`skill_1` 判据）。
 *
 * 每项的完成动作**可重复**（服务端按天去重/幂等），重复触发不重复计积分；
 * 风控纪律靠**串行单账号单动作 + 白名单限定**兜住。
 */
export const GROWTH_TASK_COMPLETION: Record<string, GrowthTaskSpec> = {
  create_canvas: { kind: 'canvasThenChat', label: '建画布并发一条消息' },
  playbook_prompt: { kind: 'chat', label: '做同款对话' },
  chat_5: { kind: 'chat', label: '发一条对话' },
  Buddy_App: { kind: 'chat', label: 'Buddy App 会话' },
  Buddy_App_QQ: { kind: 'chat', label: 'Buddy App QQ 会话' },
  expert_5: { kind: 'chat', label: '专家对话' },
  Expert_team_use_3: { kind: 'chat', label: '专家团队对话' },
  automation_1: { kind: 'chat', label: '自动化触发' },
  black_cat: { kind: 'chat', label: '夜猫子 glm-5.2 对话' },
  'Model_chat_GLM5.2': { kind: 'chat', label: '指定模型对话' },
  template_5: { kind: 'chat', label: '使用 5 个模板创建任务' },
  RichMeow_Chat: { kind: 'chat', label: '桌面端对话（fast-model）' },
  Library_read: { kind: 'webClick', label: '资料库介绍点击（web 域）' },
  Hp_Appearance: { kind: 'appearance', label: '换主题 + 皮肤生效事件' },
  skill_1: { kind: 'skillFresh', label: '真实对话 + skill_info 技能加载' },
  wb_wechat_oa_subscribe_task: { kind: 'chat', label: '微信服务号订阅（需客户端）' },
  // ── 「养虾等级」任务族（第二族，来自 `/activity/growth/tasks`）──
  first_chat: { kind: 'chat', label: '完成一次对话（等级任务）' },
  template_used: { kind: 'chat', label: '使用一次模板（等级任务）' },
  expert_summoned: { kind: 'chat', label: '召唤一次专家（等级任务）' },
  skill_installed: {
    kind: 'skillFresh',
    label: '完成技能安装（等级任务，判据 skill_info）',
  },
  wechat_linked: { kind: 'chat', label: '链接微信（等级任务，需客户端）' },
  // ── 「体验专家」活动族（判据同 Expert_lighthouse；专家绑定见 FIXED_EXPERT_TASKS）──
  Expert_lighthouse: { kind: 'fixedExpert', label: '轻量云专家：召唤+真实对话+使用链' },
  WorkBuddy_Valorant: { kind: 'fixedExpert', label: '无畏契约拼豆专家：召唤+真实对话+使用链' },
  expert_use_maidehao: { kind: 'fixedExpert', label: '中国电商运营专家：召唤+真实对话+使用链' },
  expert_use_douyinyin: { kind: 'fixedExpert', label: '抖音策略师：召唤+真实对话+使用链' },
  expert_use_shangjia_xuanchuan: {
    kind: 'fixedExpert', label: '商家宣传页与海报设计师：召唤+真实对话+使用链',
  },
  expert_use_bowangwang: { kind: 'fixedExpert', label: '直播电商教练：召唤+真实对话+使用链' },
  // ── 小程序口径专属族（mp 头 list/accept/claim + mp 指纹事件）──
  Sequential_Tasks_1: { kind: 'mpChat', label: '小程序首对话（45s 真人节奏）' },
  Sequential_Tasks_2: { kind: 'mpExpert', label: '小程序专家对话（市场真实 id 前置）' },
  Sequential_Tasks_3: { kind: 'mpChat', label: '小程序五次对话（45s 真人节奏）' },
  Sequential_Tasks_4: { kind: 'mpEvent', label: '小程序定时任务（PC 同源事件，判据预留）' },
  Sequential_Tasks_5: { kind: 'mpEvent', label: '小程序使用 GLM5.2（mp+PC 双形态）' },
  Sequential_Tasks_6: { kind: 'mpChat', label: '小程序十次对话（45s 真人节奏）' },
  Sequential_Tasks_7: { kind: 'mpEvent', label: '体验灵感功能（PC+mp 双形态，判据预留）' },
}

/** 桌面事件上报的字段顺序（照 WorkBuddy 桌面端 `DesktopChatSequence`）。 */
const DESKTOP_EVENT_ORDER = [
  'agent_task_created',
  'chat_message_send',
  'chat_request_send',
  'chat_message_response',
  'chat_message_status',
  'chat_request_response',
]

/** 桌面指纹（模拟固定 WorkBuddy 桌面端）。 */
function desktopFingerprint(
  credential: BuddyCredential,
  product: BuddyProduct,
): Record<string, unknown> {
  const uid = String(credential.user_id || '')
  const nickname = String(credential.nickname || '')
  const hash = (salt: string): string => {
    try {
      return Buffer.from(sha256Hex(`${salt}:${uid}`)).toString('hex').slice(0, 36)
    } catch {
      return `${salt}-${uid.slice(0, 12)}`
    }
  }
  return {
    timezone: 'Asia/Shanghai',
    reportDelay: 2000,
    userId: uid,
    username: nickname,
    userNickname: nickname,
    product: BUDDY_DEPLOYMENT_TYPE,
    releaseDate: 1789036585355,
    commit: '5f9692923c93033111c51ad7b003eb80204a9b75',
    ideName: 'WorkBuddy',
    ideType: 'WorkBuddy',
    ideVersion: '5.5.6',
    machineId: hash('machine'),
    sessionId: hash('session'),
    extName: 'workbuddy-desktop',
    extVersion: '5.5.6',
    ...platformIdentity(),
    cpuCores: 8,
    memorySize: 16,
    timestamp: Date.now(),
    presentAt: Date.now(),
    ideVersionCli: product.cliVersion || '2.137.1',
  }
}

/** 构造一组事件体的通用小工具。 */
function events(code: string, count: number, extra: Record<string, unknown>): GrowthEvent[] {
  return Array.from({ length: count }, () => ({ eventCode: code, ...extra }))
}

/**
 * 通用对话六连事件链（`agent_task_created → … → chat_request_response`）。
 *
 * @param model `requestModelId` / `responseModelId` 的取值。
 * @param modelName `requestModelName` 的取值。**必须与 model 分开传** ——
 *   服务端按模型**名**对齐「体验某模型」类任务：`Model_chat_GLM5.2` 的判据是
 *   `requestModelId=glm-5.2` 且 `requestModelName=GLM-5.2`（大小写不同）。
 *   两者同值时该任务不计数。缺省等于 `model`，其余任务沿用同值即可。
 */
function chatEventChain(
  model: string,
  conversationId: string,
  requestId: string,
  modelName: string = model,
): GrowthEvent[] {
  const messageId = `${conversationId}-m`
  const uuid = requestId
  const common = {
    traceId: uuid,
    rootRequestId: requestId,
    parentConversationId: conversationId,
    agentName: 'cli',
    agentType: 'main',
    'codebuddy.session_id': conversationId,
    'codebuddy.conversation_request_id': requestId,
  }
  return [
    {
      eventCode: DESKTOP_EVENT_ORDER[0],
      source: 'LOCAL', name: 'working', task_target: 'local', mode: 'craft',
      requestModelId: model, requestModelName: modelName, has_repo: false, repo_type: 'none',
      workspace_type: 'empty', has_connector: false, connector_types: [], has_mention: false,
      mention_types: [], has_template: false, action: '', template_name: '', has_expert: false,
      expert_id: '', expert_name: '', expert_industry_id: '', has_skill: false, skill_names: [],
      conversationId, messageId, buddyId: '', buddyName: '',
    },
    {
      eventCode: DESKTOP_EVENT_ORDER[1],
      messageId: `${messageId}-assistant`, historyCount: 0, isContextTruncated: false,
      currentStepCount: 1, ...common,
    },
    {
      eventCode: DESKTOP_EVENT_ORDER[2],
      inputLength: 24, isPlan: false, isAutoExecuteTerminal: false, isAutoModify: false,
      codebaseEnable: false, maxToken: 0, maxSteps: 500, temperature: 0, maxRetries: 0,
      mentionContexts: [], knowledgeId: [], knowledgeName: [], codebaseId: '',
      mentionContextCount: 0, command: '', recommendId: '', skillId: '', skillCount: 0,
      totalCount: 0, ...common,
    },
    {
      eventCode: DESKTOP_EVENT_ORDER[3],
      messageId: `${messageId}-assistant`, responseModelId: model, inputToken: 120,
      outputToken: 80, totalToken: 200, cachedTokens: 0, cachedWriteTokens: 0,
      cachedMissTokens: 0, isSuccessful: true, messageErrorCode: '', finishReason: 'stop',
      firstTokenAt: Date.now(), conversationId, ...common,
    },
    {
      eventCode: DESKTOP_EVENT_ORDER[4],
      messageId: `${messageId}-assistant`, messageErrorCode: '0', ...common,
    },
    {
      eventCode: DESKTOP_EVENT_ORDER[5],
      mode: 'craft', toolCallCount: 0, inputToken: 120, outputToken: 80, totalToken: 200,
      cachedTokens: 0, cachedWriteTokens: 0, cachedMissTokens: 0, isSuccessful: true,
      messageErrorCode: '', finishReason: 'stop', ...common,
    },
  ]
}

/**
 * 构造**单条** `chat_request_send` 事件。
 *
 * ## 为什么单独造这个构造器（而不用 chatEventChain 的六连）
 *
 * 「体验某模型」类任务（`Model_chat_GLM5.2`）的判据是**一条**带正确模型字段的
 * `chat_request_send`：Go 侧 `ReportChatActivityModel` 只发这一条，多余事件不参与
 * 判定。附带两个必须照抄的细节：
 *
 * 1. `requestModelId` 与 `requestModelName` **不同值**（`glm-5.2` / `GLM-5.2`）。
 * 2. `requestID` 传空串 → 回落成 `conversationID`。也就是说**不需要真实会话的
 *    requestId**，只要自生成的会话 id 与一条真实对话并存即可。
 *
 * @param modelId `requestModelId`，如 `glm-5.2`
 * @param modelName `requestModelName`，如 `GLM-5.2`
 * @param conversationId 自生成的会话 id（服务端不校验其真实性）
 */
function chatRequestSendEvent(
  modelId: string,
  modelName: string,
  conversationId: string,
): GrowthEvent {
  const requestId = conversationId
  return {
    eventCode: DESKTOP_EVENT_ORDER[2],
    mode: 'craft',
    conversationId,
    requestId,
    inputLength: 12,
    requestModelId: modelId,
    requestModelName: modelName,
    isPlan: false,
    isAutoExecuteTerminal: false,
    isAutoModify: false,
    codebaseEnable: false,
    maxToken: 0,
    maxSteps: 0,
    temperature: 0,
    maxRetries: 0,
    mentionContexts: [],
    knowledgeId: [],
    knowledgeName: [],
    codebaseId: '',
    mentionContextCount: 0,
    command: '',
    expertId: '',
    recommendId: '',
    skillId: '',
    skillCount: 0,
    totalCount: 0,
    fileUri: '',
    presentAt: Date.now(),
    traceId: requestId,
    rootRequestId: requestId,
    parentConversationId: conversationId,
    agentName: 'cli',
    agentType: 'main',
  }
}

/** Buddy 应用「进入应用」五连事件（实测点亮 Buddy_App / Buddy_App_QQ）。 */
function buddyAppEventChain(buddyId: string, buddyName: string): GrowthEvent[] {
  const common = { mode: 'LOCAL', buddyId, buddyName, elementId: buddyId, elementName: buddyName }
  return [
    { eventCode: 'buddyapp_discover_click', ...common },
    { eventCode: 'buddyapp_show', ...common, position: 2 },
    { eventCode: 'buddyapp_enter_click', ...common, position: 2, isFirstPage: '1' },
    { eventCode: 'buddyapp_auth_confirm_click', ...common },
    { eventCode: 'buddyapp_bindaccount_skip_click', ...common },
  ]
}

/** 模板任务「使用模板创建」事件组（实测点亮 template_5）：对话链 + template 事件。 */
function templateUseEventChain(
  templateId: string,
  templateName: string,
  conversationId: string,
  requestId: string,
): GrowthEvent[] {
  return [
    ...chatEventChain(FAST_MODEL, conversationId, requestId),
    {
      eventCode: 'agent_task_created_with_template', mode: 'working', isCustomModel: false,
      id: templateId, name: templateName, requestId,
    },
    { eventCode: 'template_used', template_id: templateId, task_mode: 'working' },
  ]
}

/** 灵感案例「做同款」事件组（实测点亮 playbook_prompt）：对话链 + playbook 点击/发送。 */
function playbookPromptEventChain(
  caseId: string,
  caseName: string,
  conversationId: string,
  requestId: string,
): GrowthEvent[] {
  const payload = { id: caseId, name: caseName, type: 'document', categoryId: '', categoryName: '' }
  return [
    ...chatEventChain(FAST_MODEL, conversationId, requestId),
    {
      eventCode: 'web_element_click', pageName: 'playbook_detail',
      elementId: 'playbook_ctaClick', elementName: caseName, source: 'discover',
    },
    { eventCode: 'playbook_cta_click', source: 'discover', position: 0, ...payload },
    { eventCode: 'playbook_prompt_send', conversationId, requestId, ...payload },
  ]
}

/** 定时任务创建成功事件。 */
function automationCreateEvent(name: string): GrowthEvent[] {
  return events('automated_task_create_suc', 1, {
    name, source: 'manually', modelId: FAST_MODEL,
    modelIsThinking: true, connectorCount: 0, skills: '', skillCount: 0, scheduleType: 'once',
    mode: 'LOCAL',
  })
}

/**
 * 专家召唤事件链（`expert_summon_click → expert_summoned → expert_actual_use`）。
 * `expert` = `fetchMarketExpertList` 取到的真实专家。
 *
 * `requestId` 由调用方填真实会话 id（服务端对 `expert_actual_use` 的 requestId
 * 有校验倾向；纯 API 口径下用生成值，若不计数则降级 clientOnly，不谎报完成）。
 */
function expertEventChain(
  expert: MarketExpert,
  conversationId: string,
  requestId: string,
  product: BuddyProduct,
): GrowthEvent[] {
  const cat = 'expert-all'
  const version = expert.version ?? '1.0.0'
  return [
    {
      eventCode: 'web_element_click',
      source: expert.expertId, type: cat, version, elementId: 'expert_summon_click',
      elementName: '立即召唤', pageURL: `${baseOf(product)}/`,
    },
    {
      eventCode: 'expert_summon_click',
      id: expert.expertId, name: expert.name, expertTitle: expert.title,
      type: cat, position: 0, expertType: expert.expertType, version, mode: 'LOCAL',
    },
    {
      eventCode: 'expert_summoned',
      id: expert.expertId, name: expert.name, expertTitle: expert.title, type: cat,
    },
    {
      eventCode: 'expert_actual_use',
      id: expert.expertId, name: expert.name, expertType: expert.expertType,
      conversationId, requestId, inputToken: 120,
      outputToken: 80, totalToken: 200, isSuccessful: true,
    },
  ]
}

/** 一次事件序列构造的结果。 */
interface EventSequence {
  events: GrowthEvent[]
  conversationId: string
  requestId: string
  model?: string
}

/**
 * 按任务代码选择「完成动作事件序列」：
 * - `Buddy_App`/`Buddy_App_QQ` → Buddy 应用五连（判据只认 buddyId，两族同源）。
 * - `automation_1` → 定时任务创建成功。
 * - 其余聊天类（`chat_5`/`expert_5`/`template_5`/`Model_chat_GLM5.2`/`playbook_prompt`…）
 *   → 通用对话链（`Model_chat_GLM5.2` 带 `glm-5.2` 模型，其余通用款）。
 * 资料库/皮肤/QQ 外观等纯 UI 动作不在此（仍 clientOnly）。
 */
function buildTaskEventSequence(
  taskCode: string,
  model: string | undefined,
  round: number,
  extraOptions: EventSequenceOptions,
  product: BuddyProduct,
): EventSequence {
  const conversationId =
    extraOptions.conversationId ?? `jb-${Date.now()}-${round}`
  const requestId = extraOptions.requestId ?? `${conversationId}-r${round}`
  const expert = extraOptions.expert
  if (taskCode === 'Hp_Appearance') {
    // 判据 = appearance_skin_apply（客户端主题生效离开设置页时上报）；纯 set API 不计分。
    return {
      events: events('appearance_skin_apply', 1, {
        action: 'apply', source: 'settings_close',
        id: APPEARANCE_THEME_KEY, vipLevel: 0, series: '', type: 'unknown',
      }),
      conversationId,
      requestId,
    }
  }
  if (taskCode === 'skill_1') {
    const messageId = `${conversationId}-m`
    const chain = chatEventChain(FAST_MODEL, conversationId, requestId)
    const response = chain.find((e) => e.eventCode === DESKTOP_EVENT_ORDER[3])
    if (response) {
      response.finishReason = 'tool_calls'
    }
    chain.push({
      eventCode: 'skill_info', id: '润泽小馆·日报撰写',
      skillId: SKILL_ID, skillVersion: '1.0.0',
      toolStatus: 'success', fileCount: 56, source: 'workbuddy-desktop',
      conversationId, requestId, messageId,
      requestModelId: FAST_MODEL, requestModelName: FAST_MODEL, traceId: requestId,
    })
    return { events: chain, conversationId, requestId, model: FAST_MODEL }
  }
  if (taskCode === 'create_canvas') {
    // 判据是设计创意画布遥测（Ardot create_design 完成时上报），不是画布会话本身。
    const chain = chatEventChain(FAST_MODEL, conversationId, requestId)
    chain.push(
      {
        eventCode: 'wbx_design_canvas_task_create', conversationId, requestId,
        source: 'summon_keyword', cost: 12000, isSuccessful: true,
      },
      {
        eventCode: 'wbx_design_canvas_open', conversationId, requestId,
        id: `ardot-file-${requestId.slice(-8)}`, source: 'summon_keyword',
        type: 'page', cost: 13000, isSuccessful: true,
      },
    )
    return { events: chain, conversationId, requestId, model: FAST_MODEL }
  }
  if (taskCode === 'Buddy_App' || taskCode === 'Buddy_App_QQ') {
    // 应用类判据只认 buddyId，不区分应用名。Buddy_App（进入任一应用）与
    // Buddy_App_QQ 判据同源，故共用同一个 id。
    return {
      events: buddyAppEventChain(
        BUDDY_APP_ID,
        taskCode === 'Buddy_App_QQ' ? '企鹅教师助手' : 'Buddy',
      ),
      conversationId,
      requestId,
    }
  }
  if (taskCode === 'automation_1') {
    return { events: automationCreateEvent('jb-automation'), conversationId, requestId }
  }
  if (taskCode === 'template_5') {
    const templates: ReadonlyArray<readonly [string, string]> = [
      ['1', '深度研究'], ['2', '周报生成'], ['3', '竞品分析'], ['4', '活动策划'], ['5', '代码评审'],
    ]
    const tpl = templates[round % templates.length] as readonly [string, string]
    return {
      events: templateUseEventChain(tpl[0], tpl[1], conversationId, requestId),
      conversationId,
      requestId,
    }
  }
  if (taskCode === 'playbook_prompt') {
    return {
      events: playbookPromptEventChain(
        `case-jb-${round}`,
        'jb灵感案例',
        conversationId,
        requestId,
      ),
      conversationId,
      requestId,
    }
  }
  // 专家/专家团类：expert_actual_use 需平台真实 expert_id（编造不计数），由调用方
  // 先拉 MarketExpertList 取真 id 注入（`expert` 字段）；未注入时回退通用对话链。
  if (taskCode === 'expert_5' || taskCode === 'Expert_team_use_3') {
    if (expert?.expertId) {
      return {
        events: expertEventChain(expert, conversationId, requestId, product),
        conversationId,
        requestId,
        model: model ?? FAST_MODEL,
      }
    }
    return {
      events: chatEventChain(model ?? FAST_MODEL, conversationId, requestId),
      conversationId,
      requestId,
      model: model ?? FAST_MODEL,
    }
  }
  // 轻量云专家（Expert_lighthouse）：专家召唤链 + mode=LOCAL 的 expert_actual_use 变体。
  // 专家 id 由调用方注入（专家市场 agent 型）；未注入时回退通用对话链。
  // ⚠ 2026-11-01 起 lighthouse 的完成动作已改道 runFixedExpertExperience（fixedExpert
  // kind），本分支保留为「该判据的事件形状权威记载」，供新体验专家任务对齐时参照。
  if (taskCode === 'Expert_lighthouse') {
    if (expert?.expertId) {
      // 真实轻量云样本顺序：3 条召唤 → fast-model 对话六连（agent_task_created 带
      // has_expert）→ 单条 LOCAL expert_actual_use（type 空、cost 0）。
      const summon = expertEventChain(expert, conversationId, requestId, product).slice(0, 3)
      const chat = chatEventChain(model ?? FAST_MODEL, conversationId, requestId).map((e) =>
        e.eventCode === DESKTOP_EVENT_ORDER[0]
          ? {
              ...e,
              has_expert: true,
              expert_id: expert.expertId,
              expert_name: expert.name,
              expert_industry_id: expert.industryId ?? '',
            }
          : e,
      )
      return {
        events: [
          ...summon,
          ...chat,
          {
            eventCode: 'expert_actual_use', id: expert.expertId, name: expert.name,
            expertType: expert.expertType, conversationId, requestId,
            inputToken: 120, outputToken: 80, totalToken: 200,
            isSuccessful: true, mode: 'LOCAL', type: '', cost: 0,
          },
        ],
        conversationId,
        requestId,
        model: model ?? FAST_MODEL,
      }
    }
    return {
      events: chatEventChain(model ?? FAST_MODEL, conversationId, requestId),
      conversationId,
      requestId,
      model: model ?? FAST_MODEL,
    }
  }
  // 夜猫子（black_cat）：glm-5.2 对话链推进（判据是 glm-5.2 夜间对话计数）。
  if (taskCode === 'black_cat') {
    return {
      events: chatEventChain(GLM_MODEL_ID, conversationId, requestId),
      conversationId,
      requestId,
      model: GLM_MODEL_ID,
    }
  }
  if (taskCode === 'RichMeow_Chat') {
    return {
      events: chatEventChain(FAST_MODEL, conversationId, requestId),
      conversationId,
      requestId,
      model: FAST_MODEL,
    }
  }
  /**
   * ── 「养虾等级」任务族（第二族：来自 `/activity/growth/tasks`，与成长任务不同端点）──
   *
   * ⚠ 这族没有 `progress` / `accept_status`，判据是服务端记录的真实活动，
   * 故一律走「已实测点亮」的既有链路，不另造机制。
   */
  if (taskCode === 'first_chat') {
    // 「完成一次对话」：判据就是存在一次真实对话，与 skill_1 同款（已实测 1/1）。
    return {
      events: chatEventChain(FAST_MODEL, conversationId, requestId),
      conversationId,
      requestId,
      model: FAST_MODEL,
    }
  }
  if (taskCode === 'template_used') {
    // 「使用一次模板」：对话链 + agent_task_created_with_template + template_used
    // （template_5 已 5/5）。
    const tplId = extraOptions.templateId ?? '1'
    const tplName = extraOptions.templateName ?? '深度研究'
    const tplConv = `jb-tpl-${conversationId.replace(/\D/g, '') || Date.now()}`
    return {
      events: [
        ...templateUseEventChain(tplId, tplName, tplConv, requestId),
        { eventCode: 'template_used', template_id: tplId, task_mode: 'working' },
      ],
      conversationId: tplConv,
      requestId,
      model: FAST_MODEL,
    }
  }
  if (taskCode === 'expert_summoned') {
    // 「召唤一次专家」：expert_5 已 5/5，机制完全一致。
    // ⚠ `expert_id` 必须是市场真实 id（编造不计数），故由调用方经 `expert` 注入；
    // 未注入时回退通用对话链，由调用方判失败。
    if (expert?.expertId) {
      return {
        events: expertEventChain(expert, conversationId, requestId, product),
        conversationId,
        requestId,
        model: FAST_MODEL,
      }
    }
    return {
      events: chatEventChain(FAST_MODEL, conversationId, requestId),
      conversationId,
      requestId,
      model: FAST_MODEL,
    }
  }
  if (taskCode === 'skill_installed') {
    // 「完成技能安装」：真判据是 `skill_info` 事件。
    // ⚠ 权威记载的教训 ——「此前的 `skill_request_send` / `skill_installed` /
    // `skill_action` 全是错误方向」，只有 `skill_info` 被实测点亮。
    // 故复用 skill_1 的同款事件组。
    return {
      events: buildTaskEventSequence(
        'skill_1',
        FAST_MODEL,
        round,
        extraOptions,
        product,
      ).events,
      conversationId,
      requestId,
      model: FAST_MODEL,
    }
  }
  if (taskCode === 'Model_chat_GLM5.2') {
    /**
     * 「体验某模型」判据：一条带 glm-5.2 模型字段的 `chat_request_send`。
     *
     * ⚠ 两个必须照抄的细节，否则**不计数**（本任务曾因此长期 0/1）：
     *   - `requestModelId=glm-5.2` 与 `requestModelName=GLM-5.2` **大小写不同**
     *   - `requestId` 留空 → 回落成 `conversationId`，**不需要真实会话 id**
     */
    const glmConv = `jb-glm52-${Date.now()}-${round}`
    return {
      events: [chatRequestSendEvent(GLM_MODEL_ID, GLM_MODEL_NAME, glmConv)],
      conversationId: glmConv,
      requestId: glmConv,
      model: GLM_MODEL_ID,
    }
  }
  // 聊天/模型类：其余走通用对话链。
  const chatModel = model ?? DEFAULT_CHAT_MODEL
  return {
    events: chatEventChain(chatModel, conversationId, requestId),
    conversationId,
    requestId,
    model: chatModel,
  }
}

/**
 * 把一组事件注入桌面指纹 + 会话上下文 + 时间戳，一次 POST 到桌面域 `/v2/report`。
 */
async function reportDesktopEvents(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch,
  eventList: GrowthEvent[],
  conversationId: string,
  requestId: string,
): Promise<ReportResult> {
  const fingerprint = desktopFingerprint(credential, product)
  const body = eventList.map((ev) => ({
    ...fingerprint,
    ...ev,
    conversationId,
    requestId,
    timestamp: Date.now(),
    presentAt: Date.now(),
  }))
  try {
    const response = await fetcher(`${baseOf(product)}/v2/report`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        ...minimalHeaders(credential, product),
        'x-client-platform': 'web',
        ...(fingerprint['userId'] ? { 'X-User-Id': String(fingerprint['userId']) } : {}),
      },
      body: JSON.stringify(body),
    })
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reported: 0, message: `凭据已失效（HTTP ${response.status}）` }
    }
    if (!response.ok) {
      return { ok: false, reported: 0, message: `事件上报请求失败（HTTP ${response.status}）` }
    }
    return { ok: true, reported: body.length, message: `已上报 ${body.length} 条事件` }
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      return { ok: false, reported: 0, message: '事件上报请求超时' }
    }
    return {
      ok: false,
      reported: 0,
      message: `事件上报失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * 按任务代码上报「完成动作事件」，推进 progress。
 * `count` = 还需补的进度（target - current）；不同 round 用不同 conversationId 各计一次。
 * 串行 + 1s 节流。
 */
async function reportTaskEvents(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch,
  taskCode: string,
  count: number,
  extraOptions: EventSequenceOptions,
): Promise<ReportResult> {
  let reported = 0
  for (let round = 0; round < count; round++) {
    const seq = buildTaskEventSequence(
      taskCode,
      extraOptions.model,
      round,
      extraOptions,
      product,
    )
    const result = await reportDesktopEvents(
      credential,
      product,
      fetcher,
      seq.events,
      seq.conversationId,
      seq.requestId,
    )
    if (!result.ok) {
      return { ok: false, reported, message: result.message }
    }
    reported += result.reported
    if (round < count - 1) {
      await new Promise((resolve) => setTimeout(resolve, ROUND_INTERVAL_MS))
    }
  }
  return { ok: true, reported, message: `已上报 ${reported} 条事件` }
}

/** 拉取专家市场真实专家列表（`POST /portal/operation-platform/market/expert/list`）。
 * `expert_5` / `Expert_team_use_3` 的完成判据要求 `expert_id` 是平台**真实**专家
 * （编造 id 不计数），故完成动作前必须先取真 id。
 * `expertType`：`agent`=单专家（expert_5），`team`=专家团（Expert_team_use_3）。
 */
export async function fetchMarketExpertList(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch = fetch,
  expertType: 'agent' | 'team' = 'agent',
): Promise<{ ok: boolean; experts: MarketExpert[]; message: string }> {
  const query = {
    page: 1,
    page_size: 20,
    sort_by: 'reco_rank',
    sort_order: 'desc',
    expert_type: expertType,
  }
  try {
    const response = await fetcher(
      `${baseOf(product)}/portal/operation-platform/market/expert/list`,
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { ...minimalHeaders(credential, product), 'x-client-platform': 'web' },
        body: JSON.stringify(query),
      },
    )
    if (response.status === 401 || response.status === 403) {
      return { ok: false, experts: [], message: `凭据已失效（HTTP ${response.status}）` }
    }
    if (!response.ok) {
      return { ok: false, experts: [], message: `专家市场查询失败（HTTP ${response.status}）` }
    }
    let payload: unknown
    try {
      payload = JSON.parse(await response.text())
    } catch {
      return { ok: false, experts: [], message: '专家市场返回无法解析的数据' }
    }
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, experts: [], message: '专家市场返回无法解析的数据' }
    }
    const envelope = payload as GrowthEnvelope & Record<string, unknown>
    if (envelope.code !== undefined && envelope.code !== 0) {
      return {
        ok: false,
        experts: [],
        message: `专家市场查询失败：${readString(envelope, 'msg')}`,
      }
    }
    const data = (
      typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : envelope
    ) as Record<string, unknown>
    const list = data['experts'] ?? data['list']
    const rows: unknown[] = Array.isArray(list) ? list : []
    const experts: MarketExpert[] = rows
      .filter((row): row is Record<string, unknown> => {
        if (typeof row !== 'object' || row === null) {
          return false
        }
        const record = row as Record<string, unknown>
        return Boolean(record['expert_id'] ?? record['id'])
      })
      .map((row) => {
        const record = row as Record<string, unknown>
        return {
          expertId: String(record['expert_id'] ?? record['id']),
          expertType: String(record['expert_type'] ?? expertType),
          name: String(
            record['display_name_zh'] ?? record['display_name'] ?? record['name'] ?? '',
          ),
          title: String(record['profession_zh'] ?? ''),
          // ⚠ version 必须带回：体验专家族的召唤链「以服务端条目为准」，市场命中时
          // 若丢 version，eventSequence 会兜底成 1.0.0，把静态表里的正确版本覆盖掉
          // （2026-11-01 审计 P1：enrich 曾对 version 是死路径）。
          ...(record['version'] !== undefined ? { version: String(record['version']) } : {}),
          ...(record['industry_id'] !== undefined
            ? { industryId: String(record['industry_id']) }
            : {}),
        }
      })
    return {
      ok: experts.length > 0,
      experts,
      message: experts.length > 0 ? `取到 ${experts.length} 个专家` : '专家市场无可用专家',
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      return { ok: false, experts: [], message: '专家市场查询超时' }
    }
    return {
      ok: false,
      experts: [],
      message: `专家市场查询失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * 读**全量**成长任务 code（含 not_accepted / in_progress / accepted / completed），
 * 供扫尾补领覆盖所有「已完成未领取」的任务（而非只 not_accepted 子集）。
 * 全失败返回空数组。
 *
 * ⚠️ 与 {@link fetchGrowthTaskCodes} 同款的要求，**改这里时必须一起改**，
 * 否则扫尾会静默漏项（两处一旦分叉，只有这里漏，且不报错）：
 *
 * 1. **必须合并三个口径**（v2 / v1 / mp 头），不能命中第一个就返回。
 *    mp 口径（Sequential_* 族）在默认两个端点里都不出现。
 * 2. **码字段名两族不同**：成长族是 `task_code`，等级族是 `code`。
 *    只读 `task_code` 会让等级族全部被 `.filter(code.length > 0)` 静默丢掉。
 * 3. 扫尾**不筛白名单、不看 locked**：已完成未领取的奖励与 locked 无关
 *    （locked 只挡 accept），mp 族任务达标未领时也必须用 mp 头去领（见
 *    {@link claimGrowthTaskReward}）。
 */
async function listAllGrowthTaskCodes(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch,
): Promise<string[]> {
  const codes = new Set<string>()
  const queries: ReadonlyArray<readonly [path: string, platform: string]> = [
    ...GROWTH_TASKS_PATHS.map((p) => [p, 'web'] as const),
    [GROWTH_TASKS_PATHS[0], MP_PLATFORM_HEADER] as const,
  ]
  for (const [path, platform] of queries) {
    const result = await getGrowthJson(path, credential, product, fetcher, platform)
    if (!result.ok || result.body.code !== 0) {
      continue
    }
    for (const task of tasksOf(result)) {
      // 两族的码字段不同：`task_code`（成长）/ `code`（等级）—— 同 fetchGrowthTaskCodes。
      const code = readString(task, 'task_code') || readString(task, 'code')
      if (code.length > 0) {
        codes.add(code)
      }
    }
  }
  return [...codes]
}

/**
 * 领取单个成长任务奖励。
 *
 * 端点实测口径（对齐网页「领取」按钮真实请求）：
 * **`POST {claimBase}/activity/growth/tasks/<task_code>/claim`** ——
 * `task_code` 放 URL 路径、**不带 `/v2` 前缀**、打 **web 域**（不是任务列表走的
 * `product.endpoint`，也不存在 `/v2/.../reward/claim` 这个路径——打它恒 400
 * `task not completed`）。响应体 `{ code:0, data:{ already_claimed, credit, energy } }`。
 * 重复领取返回 `already_claimed:true`（幂等终态，不报错）。
 *
 * ⚠ 小程序口径任务（Sequential_*）的 claim 必须带 `X-Client-Platform: miniprogram`
 * （缺头实测 `task not found`）；mp 头打该路径 400 时降级 web 头重试一次 —— 降级
 * 只认「非业务信封」与 msg=`task not found`（口径不认）两类；`task not completed`
 * 这类业务判定不降级（请求已被正确受理，重发浪费）。
 */
export async function claimGrowthTaskReward(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch = fetch,
  taskCode: string,
): Promise<ClaimResult> {
  // ⚠️ 必须在发请求前判空：空基址会拼出 `undefined/...` 或 `/activity/...`（相对路径），
  // 两者都能「发出去」，失败现象却指向服务端 —— 真因是本插件缺配置。
  const claimBase = claimBaseOf(product)
  if (claimBase.length === 0) {
    return {
      ok: false,
      claimed: false,
      credit: 0,
      message: '领取失败：产品配置缺少 claimBase（成长中心领奖站点），请检查 product.ts',
    }
  }
  // mp 任务先 mp 头、400 再降级 web 头重试一次（幂等，重发不加重）。
  const platforms = isMpTaskCode(taskCode) ? [MP_PLATFORM_HEADER, 'web'] : ['web']
  for (const platformHeader of platforms) {
    try {
      const response = await fetcher(
        `${claimBase}/activity/growth/tasks/${encodeURIComponent(taskCode)}/claim`,
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            ...minimalHeaders(credential, product),
            Accept: 'application/json, text/plain, */*',
            Origin: claimBase,
            Referer: `${claimBase}/profile/growth-center`,
            'x-client-platform': platformHeader,
          },
          body: '{}',
        },
      )
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          claimed: false,
          credit: 0,
          message: `凭据已失效（HTTP ${response.status}）`,
        }
      }
      // 降级条件：mp 头打 400（网关/租户形态不认 mp 口径）才换 web 头重试；
      // 业务层的 400（body 里 code/msg）走下方正常解析，不是降级信号 ——
      // 例外：msg 是 `task not found`（**口径不认的实测症状**，Go 面板记载该形态
      // 由 web 口径兜底可领），信封 400 也降级重试一次。
      const isMpDowngrade =
        response.status === 400 && platformHeader === MP_PLATFORM_HEADER
      let payload: GrowthEnvelope
      try {
        payload = JSON.parse(await response.text()) as GrowthEnvelope
      } catch {
        if (isMpDowngrade) {
          continue
        }
        return {
          ok: false,
          claimed: false,
          credit: 0,
          message: response.ok
            ? `领取 ${taskCode} 响应无法解析`
            : `领取 ${taskCode} 失败：HTTP ${response.status}`,
        }
      }
      if (isMpDowngrade) {
        // ⚠️ 降级只认两类：响应体不可解析为业务信封（网关层拒绝），或 msg 明说
        // `task not found`（口径不认）。`{code:400,msg:'task not completed'}` 这类
        // 业务判定说明请求已被正确受理（mp 头是通的），降级重发只是浪费请求。
        const downgradeMsg = readString(payload, 'msg')
        if (payload !== null && typeof payload === 'object' && typeof payload.code === 'number') {
          if (!/task not found/i.test(downgradeMsg)) {
            // 落入下方统一解析（不 continue）。
          } else {
            continue
          }
        } else {
          continue
        }
      }
      if (typeof payload !== 'object' || payload === null) {
        return {
          ok: false,
          claimed: false,
          credit: 0,
          message: `领取 ${taskCode} 响应无法解析`,
        }
      }
      // ⚠️ 写端点的成功判据必须是**显式的 `code === 0`**，不能写成
      // `code !== undefined && code !== 0` —— 那样「响应里根本没有 code」会被
      // 当成成功，于是网关错误体（如 `{msg:'Unauthorized', status:401}` 这类
      // 非 0 但无 code 的形状）被谎报成「已领取奖励（+0 积分）」并计入
      // `claimedCount`。这与本文件 `classifyGrowthWrite`（写端点的权威分类器，
      // 缺 code 时归 -1 → failed）判据相反，是同一文件内的分叉。
      const code = typeof payload.code === 'number' ? payload.code : undefined
      if (code !== 0) {
        const reason = readString(payload, 'msg')
        return {
          ok: false,
          claimed: false,
          credit: 0,
          message: `领取 ${taskCode} 失败：${
            reason.length > 0 ? reason : code === undefined ? '响应缺少 code 字段' : `code ${code}`
          }`,
        }
      }
      const data =
        typeof payload.data === 'object' && payload.data !== null
          ? (payload.data as Record<string, unknown>)
          : {}
      const credit = readNumber(data, 'credit')
      if (data['already_claimed'] === true) {
        return {
          ok: true,
          claimed: false,
          credit: 0,
          message: `${taskCode} 奖励已领取过（幂等，无新增积分）`,
        }
      }
      const energy = readNumber(data, 'energy')
      return {
        ok: true,
        claimed: true,
        credit,
        message: `已领取 ${taskCode} 奖励（+${credit} 积分${energy > 0 ? ` + ${energy} 能量` : ''}）`,
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        return { ok: false, claimed: false, credit: 0, message: `领取 ${taskCode} 超时` }
      }
      return {
        ok: false,
        claimed: false,
        credit: 0,
        message: `领取 ${taskCode} 失败：${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }
  // 不可达：循环体对每个 platform 要么 return 要么 continue；mp 任务两轮都
  // continue（HTTP 400 双双非 JSON）时走到这里 —— 归为失败并如实说明。
  return {
    ok: false,
    claimed: false,
    credit: 0,
    message: `领取 ${taskCode} 失败：mp/web 两种口径均返回 HTTP 400`,
  }
}

/**
 * 上报一次 **web 域** 单事件（`POST {claimBase}/v2/report`）。
 * `Library_read`（资料库介绍点击）的完成判据在 web 侧事件流，桌面域 `/v2/report` 不计，
 * 故资料库类必须打 web 域。此处只发一条事件（eventCode/elementId/elementName 由调用方给）。
 */
async function reportWebEvent(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch,
  eventCode: string,
  elementId: string,
  elementName: string,
): Promise<{ ok: boolean; message: string }> {
  // ⚠️ 用 `webBaseOf` 而非 `claimBaseOf`：本函数是 **web 遥测**（`/v2/report` +
  // 带 `Origin`/`Referer`），与领奖端点分属两站，配置项也不同。
  const webOrigin = webBaseOf(product)
  if (webOrigin.length === 0) {
    return { ok: false, message: 'web 事件上报失败：产品配置缺少 webBase / claimBase' }
  }
  const now = Date.now()
  const pageUrl = `${webOrigin}/space/d/${LIBRARY_SPACE_DOC_ID}`
  const body = [{
    eventCode,
    timestamp: now,
    reportDelay: 0,
    pageURL: pageUrl,
    elementId,
    elementName,
    ...webPlatformIdentity(),
    userAgent: product.userAgent,
    machineId: sha256Hex(`webmachine:${credential.user_id}`).slice(0, 36),
    userId: String(credential.user_id ?? ''),
    userNickname: String(credential.nickname ?? ''),
    enterpriseId: String(credential.enterprise_id ?? ''),
  }]
  try {
    const response = await fetcher(`${webOrigin}/v2/report`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        ...minimalHeaders(credential, product),
        'x-client-platform': 'web',
        Origin: webOrigin,
        Referer: pageUrl,
      },
      body: JSON.stringify(body),
    })
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: `凭据已失效（HTTP ${response.status}）` }
    }
    if (!response.ok) {
      return { ok: false, message: `web 事件上报失败（HTTP ${response.status}）` }
    }
    return { ok: true, message: `web 事件 ${eventCode} 已上报` }
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      return { ok: false, message: 'web 事件上报超时' }
    }
    return {
      ok: false,
      message: `web 事件上报异常：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

// ── 小程序（Sequential_Tasks_* 族）口径：指纹、事件构造、上报、accept 回读 ──

/** mp 事件上报头。⚠ 与 growth 任务域的 `miniprogram` 头是**两套值**（小程序
 * appservice 自身的上报指纹是 mp-weixin/wechatmp），别混。 */
function mpReportHeaders(credential: BuddyCredential, product: BuddyProduct): Record<string, string> {
  return {
    ...minimalHeaders(credential, product),
    Accept: 'application/json',
    'X-Client-Product': 'workbuddy-mp',
    'X-Client-Version': '2.4.0',
    'X-Client-Platform': 'mp-weixin',
    'X-Platform': 'wechatmp',
  }
}

/**
 * 以小程序指纹批量上报事件（`POST {webBase}/v2/report`）。
 *
 * ⚠ 基址是 `webBaseOf`（= www.workbuddy.cn，客户端把 CN 侧全部 billing/growth/
 * activity 都打这个站），不是桌面指纹用的 `endpoint`。
 */
async function reportMpEvents(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch,
  eventList: GrowthEvent[],
): Promise<ReportResult> {
  const webOrigin = webBaseOf(product)
  if (webOrigin.length === 0) {
    return { ok: false, reported: 0, message: 'mp 事件上报失败：产品配置缺少 webBase / claimBase' }
  }
  const fingerprint = mpFingerprint(credential)
  const body = eventList.map((ev) => ({ ...fingerprint, ...ev }))
  try {
    const response = await fetcher(`${webOrigin}/v2/report`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: mpReportHeaders(credential, product),
      body: JSON.stringify(body),
    })
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reported: 0, message: `凭据已失效（HTTP ${response.status}）` }
    }
    if (!response.ok) {
      return { ok: false, reported: 0, message: `mp 事件上报失败（HTTP ${response.status}）` }
    }
    return { ok: true, reported: body.length, message: `已上报 ${body.length} 条 mp 事件` }
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      return { ok: false, reported: 0, message: 'mp 事件上报超时' }
    }
    return {
      ok: false,
      reported: 0,
      message: `mp 事件上报异常：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/** mp 对话判据事件（Sequential_Tasks_1/3/6 的计数载体；无 activityId，服务端按
 * source=mini_program 指纹关联）。`conversationId` 带横线的 uuid，`rid` 官方形态
 * 32 位无横线 hex 且**前 12 位是毫秒时间戳**（同会话内严格单调 —— 纯随机的批次
 * id 会构成可聚类的反作弊特征，Go 客户端同款口径）。 */
function mpMessageId(): string {
  const timeHex = Date.now().toString(16).padStart(12, '0')
  const randHex = crypto.randomUUID().replace(/-/g, '').slice(0, 20)
  return `${timeHex}${randHex}`
}

function miniChatSendEvent(conversationId: string): GrowthEvent {
  const rid = mpMessageId()
  return {
    eventCode: 'chat_request_send',
    inputLength: 14, isPlan: false, isAutoExecuteTerminal: false,
    isAutoModify: false, codebaseEnable: false, maxToken: 0,
    maxSteps: 500, temperature: 0, maxRetries: 0,
    mentionContexts: [], knowledgeId: [], knowledgeName: [],
    codebaseId: '', mentionContextCount: 0, command: '',
    recommendId: '', skillId: '', skillCount: 0, totalCount: 0,
    traceId: rid, rootRequestId: rid,
    parentConversationId: conversationId, conversationId,
    messageId: `msg-${rid.slice(-8)}`,
    agentName: 'mp', agentType: 'main',
    'codebuddy.session_id': conversationId,
    'codebuddy.conversation_request_id': rid,
  }
}

/** mp 对话事件 + 模型字段（Sequential_Tasks_5 的 primary 判据载体）。 */
function miniChatModelEvent(conversationId: string, modelId: string, modelName: string): GrowthEvent {
  return { ...miniChatSendEvent(conversationId), requestModelId: modelId, requestModelName: modelName }
}

/**
 * mp 指纹 expert_actual_use（Sequential_Tasks_2 判据：上报即 completed）。
 * 形状对齐小程序源码真实发射点：**不带** conversationId/activityId、
 * extVersion=2.2.8、source=mini_program、type 固定 `send_message`、
 * `id`/`name` 都取专家 id（服务端以 id 入账，name 兜底同值）。
 */
function miniExpertUseEvent(expertId: string, expertName: string, expertType: string): GrowthEvent {
  return {
    eventCode: 'expert_actual_use', reportDelay: 0,
    extVersion: '2.2.8', source: 'mini_program',
    id: expertId, name: expertId,
    expertTitle: expertName.length > 0 ? expertName : expertId, type: 'send_message',
    characterCount: 12, expertType: expertType.length > 0 ? expertType : 'agent',
  }
}

/** mp 指纹灵感事件组（Sequential_Tasks_7 的 fallback 判据载体）。 */
function miniPlaybookEvents(caseId: string, caseName: string): GrowthEvent[] {
  const base = {
    id: caseId, name: caseName, type: 'document',
    categoryId: '', categoryName: '',
    skills: '', skillNames: '',
  }
  return [
    {
      eventCode: 'playbook_cta_click', source: 'discover', position: 1,
      extVersion: '2.2.8', ...base,
    },
    {
      eventCode: 'playbook_prompt_send', source: 'discover',
      promptLength: 96, isOfficial: 1,
      conversationId: crypto.randomUUID(),
      extVersion: '2.2.8', ...base,
    },
  ]
}

/**
 * mp 口径任务列表查询（`GET /v2/activity/growth/tasks` + miniprogram 头）。
 * Sequential_* 族只在口径下出现；返回 `tasks` 为空数组且 `ok` 表示「查到了但没有」。
 */
async function fetchMpTask(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch,
  taskCode: string,
): Promise<{ ok: boolean; task: GrowthTaskItem | undefined; message: string }> {
  const result = await getGrowthJson(
    GROWTH_TASKS_PATHS[0], credential, product, fetcher, MP_PLATFORM_HEADER,
  )
  if (!result.ok || result.body.code !== 0) {
    const message = result.ok
      ? `mp 任务列表返回 code ${String(result.body.code)}`
      : result.message
    return { ok: false, task: undefined, message }
  }
  const found = tasksOf(result).find(
    (task) => (readString(task, 'task_code') || readString(task, 'code')) === taskCode,
  )
  return { ok: true, task: found, message: found === undefined ? 'mp 口径未下发该任务' : '' }
}

/** mp 任务进度/target 的兜底读取：未 accept 的 mp 任务 progress 为 null（target 下发 0）。 */
function mpTaskTarget(taskCode: string, reported: number): number {
  if (reported > 0) {
    return reported
  }
  switch (taskCode) {
    case 'Sequential_Tasks_3':
      return 5
    case 'Sequential_Tasks_6':
      return 10
    default:
      return 1
  }
}

/**
 * mp accept 并回读验证登记生效：上游存在 200+OK 但 accept 未真正登记的形态
 * （此时上报事件全部不归账，任务永远点不亮）——判定以回读 `accept_status` 为准，
 * 未生效重试一次。
 *
 * ⚠ 失败必须带出**原始原因**：accept 阶段的 401/403 会以「凭据已失效」文案出现，
 * 调用方若把它吞成固定文案，`collectBuddyGrowth` 的僵尸账号判据（按 message 匹配）
 * 就失灵了 —— 僵尸会被显示成「accept 未登记生效」这种可重试错误。
 */
async function acceptMpWithVerify(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch,
  taskCode: string,
  actionGapMs: number,
): Promise<{ ok: boolean; message: string }> {
  let lastFailure = 'accept 未登记生效，上游未确认任务已接受'
  for (let attempt = 0; attempt < 2; attempt++) {
    const accept = classifyGrowthWrite(
      await postGrowthJson(
        GROWTH_TASK_ACCEPT_PATH, credential, product,
        { task_codes: [taskCode] }, fetcher, MP_PLATFORM_HEADER,
      ),
    )
    if (accept.state === 'failed') {
      // 带出原始原因（含「凭据已失效」），不再静默重试第二次（凭据失效重试也没用）。
      lastFailure = `accept 失败：${accept.message}`
      if (/凭据已失效/.test(accept.message)) {
        return { ok: false, message: lastFailure }
      }
      continue
    }
    await new Promise((resolve) => setTimeout(resolve, actionGapMs))
    const { ok, task } = await fetchMpTask(credential, product, fetcher, taskCode)
    if (ok) {
      const status = readString(task ?? {}, 'accept_status')
      if (status !== '' && status !== 'not_accepted') {
        return { ok: true, message: '' }
      }
    }
  }
  return { ok: false, message: lastFailure }
}

/** mp 任务回读轮询间隔（异步计分：上报后数秒才刷新，两轮 × 3s 与 Go 面板同预算）。 */
const MP_POLL_GAP_MS = 3_000

/** mp 任务的 sleep（gap + 0~jitter 抖动）。 */
async function mpPace(ms: number, jitterMaxMs: number): Promise<void> {
  const jitter = jitterMaxMs > 0 ? Math.floor(Math.random() * jitterMaxMs) : 0
  await new Promise((resolve) => setTimeout(resolve, ms + jitter))
}

/**
 * 设置外观主题（`POST /v2/user-asset/appearance/set`，kind=theme）。
 * `Hp_Appearance` 完成判据是桌面域 `appearance_skin_apply` 事件，但服务端要求主题已实际
 * 写入用户资产，故先调此接口落主题，再补一条 `appearance_skin_apply` 事件。
 */
async function setAppearanceTheme(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch,
): Promise<{ ok: boolean; message: string }> {
  try {
    const response = await fetcher(`${baseOf(product)}/v2/user-asset/appearance/set`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { ...minimalHeaders(credential, product), 'x-client-platform': 'web' },
      body: JSON.stringify({ kind: 'theme', resource_key: APPEARANCE_THEME_KEY }),
    })
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: `凭据已失效（HTTP ${response.status}）` }
    }
    if (!response.ok) {
      return { ok: false, message: `外观设置失败（HTTP ${response.status}）` }
    }
    return { ok: true, message: `外观主题已设为 ${APPEARANCE_THEME_KEY}` }
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      return { ok: false, message: '外观设置超时' }
    }
    return {
      ok: false,
      message: `外观设置异常：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * 发起一次**真实** SSE 对话（`POST /v2/chat/completions`），从响应体抓真实服务端 requestId。
 * `skill_1` / `Expert_lighthouse` 的判据要求事件 JOIN 到一条**真实**会话（编造 requestId 不计），
 * 故这两项必须先跑本函数拿真 requestId，再交给 `reportTaskEvents` 上报事件链。
 * 读完整 SSE 正文并正则抓 32 位 hex id（对齐 Go 侧 idRegex）。
 */
async function chatRealSession(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch,
  expertId: string,
  model: string = FAST_MODEL,
): Promise<{ ok: boolean; requestId: string; message: string }> {
  const body = {
    model,
    messages: [
      { role: 'system', content: '当前处于中文环境，请使用简体中文回答。' },
      { role: 'user', content: '1+1等于几？直接回答。' },
    ],
    agent: 'cli',
    temperature: 1,
    stream: true,
    stream_options: { include_usage: true },
  }
  try {
    const response = await fetcher(`${baseOf(product)}/v2/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        ...minimalHeaders(credential, product),
        Accept: 'text/event-stream',
        // ⚠️ 原先这里只有一枚 `X-Conversation-ID: jb-conv-<ts>`，另两枚缺失。
        // 2026-10-16 起补齐三枚：**对「要求三头」的账号是硬需求**（IKM7SG 实测
        // 三枚齐全才 200），且与主链路形态统一 —— 见 `conversationHeaders` 的注释。
        ...conversationHeaders(newConversationId()),
        'X-Request-ID': String(Date.now()),
        // 空 expertId 不发该头（通用对话链不是专家会话；Go 面板同款：空则不发）。
        ...(expertId.length > 0 ? { 'X-Expert-Id': expertId } : {}),
        'X-Agent-Intent': 'craft',
        'X-Agent-Type': 'main',
      },
      body: JSON.stringify(body),
    })
    if (response.status === 401 || response.status === 403) {
      return { ok: false, requestId: '', message: `凭据已失效（HTTP ${response.status}）` }
    }
    if (!response.ok) {
      return { ok: false, requestId: '', message: `真实对话请求失败（HTTP ${response.status}）` }
    }
    // 读完整 SSE 流并从正文抽真实 id（`"id":"<32hex>"`）。
    const text = await response.text()
    const idMatch = text.match(/"id"\s*:\s*"((?:cmb-)?[0-9a-f]{32})"/)
    if (!idMatch) {
      return {
        ok: false,
        requestId: '',
        message: '真实对话未返回可用 requestId（服务端未派发 id）',
      }
    }
    return {
      ok: true,
      requestId: idMatch[1] as string,
      message: `真实对话完成（requestId=${idMatch[1]}）`,
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      return { ok: false, requestId: '', message: '真实对话超时' }
    }
    return {
      ok: false,
      requestId: '',
      message: `真实对话异常：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/** 夜猫子任务的服务端计入窗口：23:00–08:00。 */
function isGrowthNightWindow(date = new Date()): boolean {
  const hour = date.getHours()
  return hour >= 23 || hour < 8
}

/** 客户端专属任务：完成判据在客户端 UI（微信动作），事件上报推不动，如实降级。 */
const CLIENT_ONLY_TASK_CODES = new Set(['wb_wechat_oa_subscribe_task', 'wechat_linked'])
/**
 * 「养虾等级」任务族中**判据结构性不可达**的 4 项。
 *
 * 这族任务的第二端点（`/activity/growth/tasks`）不返回 `progress`，只返回
 * `status`（`available` = 未达成）。事件上报改变不了 `status` —— 实测 2 轮 ×
 * 3 个账号共 6 次，`first_chat` / `template_used` / `expert_summoned` /
 * `skill_installed` 的 `status` 始终 `available`，`progress` 视图恒为 0/1。
 *
 * 据此**跳过「真实会话 + 真 requestId」重试**：那一次重试要发一条真实对话
 * （消耗 token 与活跃记录）再等 4s 结算，而结果已确定不会变。多账号时会累积成
 * 明显的无效请求与风控面。合成事件仍照发一次，保留判据万一改版的可能。
 *
 * ⚠️ 这不是「做不到」的断言，而是「当前服务端口径下事件不计数」。若日后
 * `status` 也接受事件驱动，此处的短路应同步撤掉。
 */
const LEVEL_UNREACHABLE_TASK_CODES: ReadonlySet<string> = new Set([
  'first_chat',
  'template_used',
  'expert_summoned',
  'skill_installed',
])

/** 专家类任务：判据要求真实 expert_id，且服务端按 expert_id 按天去重。
 * 「体验专家」活动族（FIXED_EXPERT_TASKS）的判据同源，一并计入 —— 它们的专家
 * id 固定，但市场列表仍用于 enrich version/名称（服务端以市场条目为准）。 */
function isExpertTaskCode(code: string): boolean {
  return (
    code === 'expert_5' ||
    code === 'Expert_team_use_3' ||
    code === 'expert_summoned' ||
    FIXED_EXPERT_TASKS[code] !== undefined
  )
}

/** 按任务判据对齐的缺省模型；`undefined` 表示走通用模型。 */
function modelForTaskCode(code: string): string | undefined {
  if (code === 'Model_chat_GLM5.2' || code === 'black_cat') {
    return GLM_MODEL_ID
  }
  if (
    code === 'RichMeow_Chat' ||
    code === 'first_chat' ||
    code === 'template_used' ||
    code === 'expert_summoned'
  ) {
    return FAST_MODEL
  }
  return undefined
}

/** 读某个任务码的当前进度（缺失即 0/1）。 */
async function readProgress(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch,
  code: string,
): Promise<{ current: number; target: number }> {
  const after = await fetchGrowthTaskCodes(credential, product, fetcher, {
    includeInProgress: true,
  })
  const prog = after.ok ? after.progressByCode?.[code] : undefined
  return { current: prog?.current ?? 0, target: prog?.target ?? 1 }
}

/** {@link runFixedExpertExperience} 的结果（ok/clientOnly/message 三态，同 GrowthTaskResult）。 */
interface FixedExpertOutcome {
  ok: boolean
  clientOnly: boolean
  message: string
}

/**
 * 「体验「X」专家」类任务的完成动作（Expert_lighthouse / WorkBuddy_Valorant /
 * expert_use_* 同源判据）：真实对话（服务端 requestId，带 X-Expert-Id）→ 召唤链
 * → has_expert 对话链 + LOCAL expert_actual_use（type 空、cost 0）→ 复查进度 →
 * 达标即领奖。
 *
 * `marketList` 用于 enrich 专家条目（version 等以服务端为准）；搜不到就用
 * {@link FIXED_EXPERT_TASKS} 的静态兜底 —— 召唤链本身不依赖市场查询成功。
 * ⚠ 顺序不可换：召唤链与使用链都 JOIN 真实会话（`jb-conv-<requestId>`），
 * 没有真实 requestId 的链不计数（Expert_lighthouse 的实测结论）。
 */
async function runFixedExpertExperience(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch,
  taskCode: string,
  spec: MarketExpert,
  marketList: MarketExpert[],
): Promise<FixedExpertOutcome> {
  const expert = marketList.find((e) => e.expertId === spec.expertId) ?? spec
  const session = await chatRealSession(credential, product, fetcher, expert.expertId)
  if (!session.ok) {
    return { ok: false, clientOnly: false, message: `${spec.title}真实会话失败：${session.message}` }
  }
  const conv = `jb-conv-${session.requestId}`
  const summonRes = await reportDesktopEvents(
    credential, product, fetcher,
    expertEventChain(expert, conv, session.requestId, product).slice(0, 3),
    conv, session.requestId,
  )
  if (!summonRes.ok) {
    return { ok: false, clientOnly: false, message: summonRes.message }
  }
  const chatWithExpert = chatEventChain(FAST_MODEL, conv, session.requestId).map((e) =>
    e.eventCode === DESKTOP_EVENT_ORDER[0]
      ? {
          ...e,
          has_expert: true,
          expert_id: expert.expertId,
          expert_name: expert.name,
          expert_industry_id: expert.industryId ?? '',
        }
      : e,
  )
  chatWithExpert.push({
    eventCode: 'expert_actual_use', id: expert.expertId, name: expert.name,
    // 保真键（Go 面板实测形状的并集；title=职业名与 name=昵称都参与服务端校验）：
    expertTitle: expert.title, version: expert.version ?? '1.0.0', source: 'builtin',
    characterCount: 12, messageId: `msg-${session.requestId.slice(-8)}`,
    requestModelId: FAST_MODEL, requestModelName: FAST_MODEL,
    expertType: expert.expertType, conversationId: conv,
    requestId: session.requestId,
    inputToken: 120, outputToken: 80, totalToken: 200,
    isSuccessful: true, mode: 'LOCAL', type: '', cost: 0,
  })
  const useRes = await reportDesktopEvents(
    credential, product, fetcher, chatWithExpert, conv, session.requestId,
  )
  if (!useRes.ok) {
    return { ok: false, clientOnly: false, message: useRes.message }
  }
  await new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS))
  const progress = await readProgress(credential, product, fetcher, taskCode)
  const done = `${session.message}；${summonRes.message} + ${useRes.message}`
  if (progress.current >= progress.target) {
    const claim = await claimGrowthTaskReward(credential, product, fetcher, taskCode)
    return {
      ok: true, clientOnly: false,
      message: `${done}，progress 达标（${progress.current}/${progress.target}）；${claim.message}`,
    }
  }
  return {
    ok: true, clientOnly: true,
    message: `${done}，progress ${progress.current}/${progress.target} 未涨，需在客户端真实体验该专家`,
  }
}

/** mp 任务项的进度读取：`progress:{current,target}` 与平铺 `current`/`target` 两形状都认
 * （上游列表随任务类型变体，Go 面板同款双形状解析）。 */
function progressOfMpTask(task: GrowthTaskItem): { current: number; target: number } {
  const progress = task.progress ?? {}
  const nestedCurrent = readNumber(progress, 'current')
  const nestedTarget = readNumber(progress, 'target')
  if (nestedCurrent > 0 || nestedTarget > 0) {
    return { current: nestedCurrent, target: nestedTarget }
  }
  return { current: readNumber(task, 'current'), target: readNumber(task, 'target') }
}

/** mp 三个 runner 共享的运行参数（含单测注入的节奏压缩与整轮 deadline）。 */
interface MpTaskContext {
  credential: BuddyCredential
  product: BuddyProduct
  fetcher: typeof fetch
  /** mp 对话事件间隔（毫秒）。 */
  gapMs: number
  /** mp 间隔随机抖动上限（毫秒）。 */
  jitterMs: number
  /** mp 写动作间隔（毫秒）。 */
  actionGapMs: number
  /** 整轮 deadline（毫秒时刻；undefined = 不限）。 */
  deadlineAt: number | undefined
}

/** mp runner 的统一结果（对齐 GrowthTaskResult 三态）。 */
interface MpTaskOutcome {
  ok: boolean
  clientOnly: boolean
  message: string
}

/** 有界轮询 mp 任务直到达标/领取/预算用尽（异步计分：约 5-8s 后才刷新）。 */
async function pollMpTask(
  ctx: MpTaskContext,
  taskCode: string,
  rounds: number,
): Promise<{ ok: boolean; task: GrowthTaskItem | undefined; message: string }> {
  let last: { ok: boolean; task: GrowthTaskItem | undefined; message: string } = {
    ok: false, task: undefined, message: '未轮询',
  }
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, MP_POLL_GAP_MS))
    const found = await fetchMpTask(ctx.credential, ctx.product, ctx.fetcher, taskCode)
    if (!found.ok) {
      return { ok: false, task: last.task, message: found.message }
    }
    last = found
    const t = found.task
    if (t === undefined) {
      continue
    }
    const status = readString(t, 'accept_status')
    const { current, target } = progressOfMpTask(t)
    if (status === 'claimed' || status === 'completed' || (target > 0 && current >= target)) {
      return found
    }
  }
  return last
}

/** mp 任务的领奖（幂等；失败如实带原因）。 */
async function claimMpReward(
  ctx: MpTaskContext,
  taskCode: string,
): Promise<{ ok: boolean; claimed: boolean; message: string }> {
  const claim = await claimGrowthTaskReward(ctx.credential, ctx.product, ctx.fetcher, taskCode)
  return { ok: claim.ok, claimed: claim.claimed, message: claim.message }
}

/**
 * mp 对话判据任务通用闭环（Sequential_Tasks_1/3/6）：
 * mp 查询 → 已领即回 → 已达标即领 → accept（带登记回读验证）→ 按差额补 mini chat
 * 事件（**每条前等待 gap+抖动** —— 反作弊节奏，见 {@link MP_CHAT_EVENT_GAP_MS}）
 * → 有界轮询 → 达标领奖。事件逐条检查 deadline，预算用尽如实停（进度累计，可续跑）。
 */
async function runMpChatTask(ctx: MpTaskContext, taskCode: string): Promise<MpTaskOutcome> {
  const { ok, task, message } = await fetchMpTask(ctx.credential, ctx.product, ctx.fetcher, taskCode)
  if (!ok) {
    return { ok: false, clientOnly: false, message }
  }
  if (task === undefined) {
    return { ok: true, clientOnly: true, message: `${taskCode}: mp 口径未下发该任务（活动可能已结束或前置未解锁）` }
  }
  if (readString(task, 'accept_status') === 'claimed') {
    return { ok: true, clientOnly: false, message: `${taskCode}: 已领取` }
  }
  let { current, target } = progressOfMpTask(task)
  const effectiveTarget = mpTaskTarget(taskCode, target)
  if (current >= effectiveTarget || readString(task, 'accept_status') === 'completed') {
    const claim = await claimMpReward(ctx, taskCode)
    return {
      ok: claim.ok, clientOnly: false,
      message: claim.ok ? `${taskCode}: ${claim.message}` : `${taskCode}: 领奖失败：${claim.message}`,
    }
  }
  // 已登记（accepted/in_progress）的任务跳过 accept-verify（幂等但白打两发请求）。
  const chatStatus = readString(task, 'accept_status')
  if (chatStatus === '' || chatStatus === 'not_accepted') {
    const accept = await acceptMpWithVerify(ctx.credential, ctx.product, ctx.fetcher, taskCode, ctx.actionGapMs)
    if (!accept.ok) {
      return { ok: false, clientOnly: false, message: `${taskCode}: ${accept.message}` }
    }
  }
  // accept 后回读一次拿真实 target（accept 前 progress 为 null、target 下发 0，
  // 兜底表会少报 —— Tasks_6 首轮实测 target=10 只补 1 条就误判达标）。
  const after = await fetchMpTask(ctx.credential, ctx.product, ctx.fetcher, taskCode)
  if (after.ok && after.task !== undefined) {
    const p = progressOfMpTask(after.task)
    current = p.current
    target = mpTaskTarget(taskCode, p.target)
  }
  const need = Math.max(0, target - current)
  if (need === 0) {
    const claim = await claimMpReward(ctx, taskCode)
    return { ok: claim.ok, clientOnly: false, message: `${taskCode}: ${claim.message}` }
  }
  let sent = 0
  for (let i = 0; i < need; i++) {
    if (ctx.deadlineAt !== undefined && Date.now() >= ctx.deadlineAt) {
      // 与主流程预算用尽的语义一致（ok:false → failed 计数、提示染黄）：
      // 该任务这轮**没有做完**，不能标成 clientOnly 那种「终态需客户端」。
      return {
        ok: false, clientOnly: false,
        message: `${taskCode}: 已补报 ${sent}/${need} 条，本轮时间预算用尽（进度已累计，再点一次可继续）`,
      }
    }
    // 首条也等：上一轮残留进度可能被反作弊回滚，回滚后立即重报同样无效。
    await mpPace(ctx.gapMs, ctx.jitterMs)
    const report = await reportMpEvents(
      ctx.credential, ctx.product, ctx.fetcher,
      [miniChatSendEvent(crypto.randomUUID())],
    )
    if (!report.ok) {
      return { ok: false, clientOnly: false, message: `${taskCode}: 完成 ${sent}/${need} 次上报后中断：${report.message}` }
    }
    sent += 1
  }
  const polled = await pollMpTask(ctx, taskCode, 2)
  if (!polled.ok) {
    return { ok: false, clientOnly: false, message: `${taskCode}: 已上报 ${sent} 条但回读失败：${polled.message}` }
  }
  const t = polled.task
  const status = t === undefined ? '' : readString(t, 'accept_status')
  const prog = t === undefined ? { current: 0, target: 0 } : progressOfMpTask(t)
  if (status === 'claimed') {
    return { ok: true, clientOnly: false, message: `${taskCode}: 本轮已入账（claimed）` }
  }
  const targetNow = mpTaskTarget(taskCode, prog.target)
  if (prog.current < targetNow && status !== 'completed') {
    return {
      ok: true, clientOnly: true,
      message: `${taskCode}: 已上报 ${sent} 条但进度未达 ${prog.current}/${targetNow}（异步计分未归账，下次重试）`,
    }
  }
  const claim = await claimMpReward(ctx, taskCode)
  return {
    ok: claim.ok, clientOnly: false,
    message: claim.ok
      ? `${taskCode}: 任务点亮并领取奖励（${claim.message}）`
      : `${taskCode}: 领奖失败：${claim.message}`,
  }
}

/**
 * mp 专家对话任务（Sequential_Tasks_2）：**市场真实专家 id 前置**（空 id 服务端不入账；
 * accept 前置解析避免留下「已登记未上报」的半程态）→ mp 查询 → 已领/已达标即领 →
 * accept（带验证）→ mp 指纹 expert_actual_use → 有界轮询 → 达标领奖。
 */
async function runMpExpertTask(ctx: MpTaskContext, taskCode: string): Promise<MpTaskOutcome> {
  const { ok, task, message } = await fetchMpTask(ctx.credential, ctx.product, ctx.fetcher, taskCode)
  if (!ok) {
    return { ok: false, clientOnly: false, message }
  }
  if (task === undefined) {
    return { ok: true, clientOnly: true, message: `${taskCode}: mp 口径未下发该任务（活动可能已结束）` }
  }
  if (readString(task, 'accept_status') === 'claimed') {
    return { ok: true, clientOnly: false, message: `${taskCode}: 已领取` }
  }
  const { current, target } = progressOfMpTask(task)
  const effectiveTarget = target > 0 ? target : 1
  if (current >= effectiveTarget || readString(task, 'accept_status') === 'completed') {
    const claim = await claimMpReward(ctx, taskCode)
    return { ok: claim.ok, clientOnly: false, message: `${taskCode}: ${claim.message}` }
  }
  // 判据载体前置（**accept 之前**解析市场真实专家 id）：空 id 服务端不入账，且
  // 拉不到市场就整任务不动作 —— 不先 accept，避免留下「已登记未上报」的半程态。
  const market = await fetchMarketExpertList(ctx.credential, ctx.product, ctx.fetcher, 'agent')
  if (!market.ok || market.experts.length === 0) {
    return {
      ok: false, clientOnly: false,
      message: `${taskCode}: 专家市场不可用（${market.message}），跳过以防半程态`,
    }
  }
  const expert = market.experts[0] as MarketExpert
  const name = expert.name.length > 0 ? expert.name : expert.title
  const expertStatus = readString(task, 'accept_status')
  if (expertStatus === '' || expertStatus === 'not_accepted') {
    const accept = await acceptMpWithVerify(ctx.credential, ctx.product, ctx.fetcher, taskCode, ctx.actionGapMs)
    if (!accept.ok) {
      return { ok: false, clientOnly: false, message: `${taskCode}: ${accept.message}` }
    }
  }
  const report = await reportMpEvents(
    ctx.credential, ctx.product, ctx.fetcher,
    [miniExpertUseEvent(expert.expertId, name, expert.expertType)],
  )
  if (!report.ok) {
    return { ok: false, clientOnly: false, message: `${taskCode}: 上报 expert_actual_use 失败：${report.message}` }
  }
  const polled = await pollMpTask(ctx, taskCode, 2)
  if (!polled.ok) {
    return { ok: false, clientOnly: false, message: `${taskCode}: 已上报但回读失败：${polled.message}` }
  }
  const t = polled.task
  const status = t === undefined ? '' : readString(t, 'accept_status')
  const prog = t === undefined ? { current: 0, target: 0 } : progressOfMpTask(t)
  if (status === 'claimed') {
    return { ok: true, clientOnly: false, message: `${taskCode}: 本轮已入账（claimed）` }
  }
  if (prog.current < (prog.target > 0 ? prog.target : 1) && status !== 'completed') {
    return { ok: true, clientOnly: true, message: `${taskCode}: 已上报但进度未归账（异步计分，下次重试）` }
  }
  const claim = await claimMpReward(ctx, taskCode)
  return {
    ok: claim.ok, clientOnly: false,
    message: claim.ok ? `${taskCode}: 任务点亮并领取奖励（${claim.message}）` : `${taskCode}: 领奖失败：${claim.message}`,
  }
}

/**
 * mp 预留任务通用骨架（Sequential_Tasks_4/5/7，每日零点解锁一环）：
 * mp 查询 → 已领/已达标即领 → accept（带验证；locked 期间不落账，如实返回）
 * → primary 判据事件 → 有界轮询 → 未点亮且有 fallback 时补一轮 → 再轮询 → 达标领奖。
 */
async function runMpEventTask(
  ctx: MpTaskContext,
  taskCode: string,
  primary: () => Promise<MpTaskOutcome>,
  fallback: (() => Promise<MpTaskOutcome>) | undefined,
): Promise<MpTaskOutcome> {
  const { ok, task, message } = await fetchMpTask(ctx.credential, ctx.product, ctx.fetcher, taskCode)
  if (!ok) {
    return { ok: false, clientOnly: false, message }
  }
  if (task === undefined) {
    return {
      ok: true, clientOnly: true,
      message: `${taskCode}: mp 口径未下发该任务（前置任务未完成或活动未开始）`,
    }
  }
  if (task.locked === true) {
    return { ok: true, clientOnly: true, message: `${taskCode}: 任务尚未解锁（每日零点解锁一环），本轮跳过` }
  }
  if (readString(task, 'accept_status') === 'claimed') {
    return { ok: true, clientOnly: false, message: `${taskCode}: 已领取` }
  }
  const { current, target } = progressOfMpTask(task)
  const effectiveTarget = target > 0 ? target : 1
  if (current >= effectiveTarget || readString(task, 'accept_status') === 'completed') {
    const claim = await claimMpReward(ctx, taskCode)
    return { ok: claim.ok, clientOnly: false, message: `${taskCode}: ${claim.message}` }
  }
  const eventStatus = readString(task, 'accept_status')
  if (eventStatus === '' || eventStatus === 'not_accepted') {
    const accept = await acceptMpWithVerify(ctx.credential, ctx.product, ctx.fetcher, taskCode, ctx.actionGapMs)
    if (!accept.ok) {
      return { ok: false, clientOnly: false, message: `${taskCode}: ${accept.message}` }
    }
  }
  const primaryResult = await primary()
  if (!primaryResult.ok) {
    return { ok: false, clientOnly: false, message: `${taskCode}: 判据上报失败：${primaryResult.message}` }
  }
  let polled = await pollMpTask(ctx, taskCode, 2)
  if (!polled.ok) {
    return { ok: false, clientOnly: false, message: `${taskCode}: 已上报但回读失败：${polled.message}` }
  }
  const reached = (t: GrowthTaskItem | undefined): boolean => {
    if (t === undefined) {
      return false
    }
    const status = readString(t, 'accept_status')
    const prog = progressOfMpTask(t)
    return status === 'claimed' || status === 'completed' || prog.current >= (prog.target > 0 ? prog.target : 1)
  }
  if (!reached(polled.task) && fallback !== undefined) {
    const fallbackResult = await fallback()
    if (!fallbackResult.ok) {
      return { ok: false, clientOnly: false, message: `${taskCode}: 备选判据上报失败：${fallbackResult.message}` }
    }
    polled = await pollMpTask(ctx, taskCode, 2)
    if (!polled.ok) {
      return { ok: false, clientOnly: false, message: `${taskCode}: 备选上报后回读失败：${polled.message}` }
    }
  }
  if (readString(polled.task ?? {}, 'accept_status') === 'claimed') {
    return { ok: true, clientOnly: false, message: `${taskCode}: 本轮已入账（claimed）` }
  }
  if (!reached(polled.task)) {
    return {
      ok: true, clientOnly: true,
      message: `${taskCode}: 已上报但进度未点亮（判据形态待解锁后校正，下次重试）`,
    }
  }
  const claim = await claimMpReward(ctx, taskCode)
  return {
    ok: claim.ok, clientOnly: false,
    message: claim.ok ? `${taskCode}: 任务点亮并领取奖励（${claim.message}）` : `${taskCode}: 领奖失败：${claim.message}`,
  }
}

/**
 * 执行**全量任务完成动作**（默认路径的完整档）。
 *
 * 编排（串行，防风控）：
 *   1. 拉任务列表，筛「白名单 ∩ not_accepted ∩ GROWTH_TASK_COMPLETION 可达」；
 *   2. 接取这些任务（`accept`）；
 *   3. 逐项执行完成动作（`canvas` 建会话 / `chat` 发消息 / `canvasThenChat` 两者）；
 *   4. 扫尾补领所有「已达标未领取」的任务。
 *
 * ⚠️ 与 {@link claimAllGrowth}（只接取 + 旅行领奖，副作用最小）的区别：本函数
 * **真正执行完成动作**，会建会话 / 发消息（消耗少量 token 与活跃记录）。
 * 串行 + 单账号 + 白名单限定控制风控。
 */
export async function runGrowthTaskCompletions(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch = fetch,
  options: GrowthCompletionOptions = {},
): Promise<GrowthCompletionReport> {
  /**
   * ⚠️ 缺 `user_id` 必须**显式留痕**，不能静默跑完。
   *
   * 判据事件里的 `userId` / `machineId` 全部由 `credential.user_id` 派生
   * （见 `desktopFingerprint` / `reportWebEvent`）：uid 为空时 `userId` 上报空串、
   * `machineId` 退化成 `sha256('machine:')` —— 按用户维度计数的判据**必然不计数**，
   * 而代码不报错、接口不报错，表现为「跑完一圈 0 项完成」，用户完全无从排查。
   *
   * 不直接返回失败：仍有不依赖 uid 的服务端逻辑（接取、部分任务），
   * 直接放弃会连那些也丢掉。故只把原因写进 message 让用户看见。
   */
  const missingUserId = !credential.user_id
  if (missingUserId) {
    console.warn(
      '[buddy-growth] 凭据缺少 user_id：判据事件里的 userId/machineId 将退化，'
      + '任务大概率不被服务端计数。请重新登录该账号。',
    )
  }
  // 取「白名单可达 ∩ 未完成（not_accepted + in_progress）」的 task_code。
  // 接取（accept）把任务从 not_accepted 置 in_progress，完成动作必须在
  // in_progress 上再触发一次才判完成并发积分 —— 不能只看 not_accepted。
  const unfinished = await fetchGrowthTaskCodes(credential, product, fetcher, {
    includeInProgress: true,
  })
  if (!unfinished.ok) {
    /**
     * ⚠️ 必须把失败原因**也放进 `results`**（用 `unfinished.message`，其中
     * 401/403 会说「凭据已失效」），不能只写在 `message` 里。
     *
     * 下游 `collectBuddyGrowth`（本文件）判僵尸账号的依据是
     * **逐项** `results.some(r => /凭据已失效/.test(r.message))`。此处若返回空
     * `results`，凭据失效就判不出来 ⇒ `expired=false` ⇒ 既不计 failed 也不写
     * error ⇒ 前端显示「本轮无 API 可达的任务（未领到积分）」，
     * **把「请重新登录」说成「没有任务」**，用户完全无从排查。
     */
    const reason = unfinished.message ?? '任务列表查询失败'
    return {
      ok: false, results: [{ taskCode: '', ok: false, message: reason }],
      completed: 0, clientOnly: 0, failed: 0,
      claimedCount: 0, claimedCredit: 0, timedOut: false,
      message: reason,
    }
  }
  const actionable = unfinished.codes.filter((code) => GROWTH_TASK_COMPLETION[code] !== undefined)
  const results: GrowthTaskResult[] = []
  /** `actionable` 为空时仍须走扫尾（见下方块尾注释），此处只用于最终文案。 */
  const noActionableTasks = actionable.length === 0

  let completed = 0
  let failed = 0
  let clientOnly = 0
  const progressByCode = unfinished.progressByCode ?? {}

  // 预算**必须在此处**算好：扫尾补领受同一 deadline 约束，若等到逐项完成阶段
  // 才计算，则 `actionable` 为空时扫尾会绕过预算直接对全量任务逐个 POST。
  // 非有限值（NaN / Infinity）归为「不限」并留痕：Number('abc') 得 NaN，而
  // NaN > 0 为 false，若不显式区分会静默变成不限时，恰是本预算要防的情况。
  const rawBudget = options.budgetMs === undefined ? DEFAULT_BUDGET_MS : Number(options.budgetMs)
  const budgetInvalid = !Number.isFinite(rawBudget)
  const budgetMs = budgetInvalid ? 0 : rawBudget
  const deadlineAt = budgetMs > 0 ? Date.now() + budgetMs : undefined
  if (budgetInvalid) {
    console.warn(`[buddy-growth] budgetMs=${String(options.budgetMs)} 非有限值，本轮不限时`)
  }
  let timedOut = false

  // 接取这批里仍 not_accepted 的（in_progress 的跳过 accept，幂等）
  const toAccept = unfinished.toAccept
    ? actionable.filter((code) => unfinished.toAccept?.has(code))
    : actionable
  /**
   * 批量 accept 只发 **web 口径**的任务（失败只标记该批，不阻断其余项与扫尾）。
   * ⚠ mp 码（Sequential_*）**不在这里 accept**：它们由各自的 runner 自管 accept
   * （带登记回读验证；Sequential_Tasks_2 还要求市场真实专家 id **先于 accept**
   * 解析，防「已登记未上报」半程态 —— 批量抢先会绕过该守卫）。mp 头口径与 web
   * 不能混批：web 口径那批发 mp 码会被 `task not found` 拒掉。
   */
  const webAcceptCodes = toAccept.filter((c) => !isMpTaskCode(c))
  const acceptFailedCodes = new Set<string>()
  let acceptFailureMessage = ''
  if (webAcceptCodes.length > 0) {
    const accept = classifyGrowthWrite(
      await postGrowthJson(
        GROWTH_TASK_ACCEPT_PATH, credential, product, { task_codes: webAcceptCodes }, fetcher,
      ),
    )
    if (accept.state === 'failed') {
      for (const c of webAcceptCodes) acceptFailedCodes.add(c)
      acceptFailureMessage = accept.message
    }
  }
  // 接取失败：逐项记为失败，但**仍继续走其余项与扫尾** —— 接取失败只影响「本轮
  // 新接的那批任务」，账号里已达标未领取的奖励与接取无关，不该被它连带跳过。
  // （早期实现此处直接 return，于是接取一失败就整轮不领奖。）
  if (acceptFailedCodes.size > 0) {
    for (const code of actionable) {
      if (!acceptFailedCodes.has(code)) {
        continue
      }
      results.push({ taskCode: code, ok: false, message: `接取失败：${acceptFailureMessage}` })
    }
    failed += acceptFailedCodes.size
  }
  // 接取失败 ⇒ 该任务未进入 in_progress，完成动作无从生效，故只跳过失败子集。
  const completable = actionable.filter((code) => !acceptFailedCodes.has(code))

  // 专家类先拉市场真实专家列表（编造 id 不计数；服务端按 expert_id 去重，
  // 同 id 同天只计一次，故 expert_5 需 5 个**不同**专家各用一次，故拉整份列表轮换）。
  // expert_summoned 也要真实专家 id —— 它与 expert_5 同一条召唤链。
  let expertAgentList: MarketExpert[] = []
  let expertTeamList: MarketExpert[] = []
  if (actionable.some(isExpertTaskCode)) {
    const agentRes = await fetchMarketExpertList(credential, product, fetcher, 'agent')
    if (agentRes.ok) {
      expertAgentList = agentRes.experts
    }
    const teamRes = await fetchMarketExpertList(credential, product, fetcher, 'team')
    if (teamRes.ok) {
      expertTeamList = teamRes.experts
    }
  }

  // 串行逐项完成（单账号，防风控）
  for (const code of completable) {
    const spec = GROWTH_TASK_COMPLETION[code]
    let ok = false
    let clientOnlyFlag = false
    let message = ''
    /**
     * ⚠ spec 缺失必须**兜住而不是崩**：`AUTOMATABLE_TASK_CODES` 与
     * `GROWTH_TASK_COMPLETION` 是两张手工维护的表，前者有码而后者漏写时
     * `spec.kind` 会抛 TypeError，把**整轮**领取连带其它账号一起炸掉。
     */
    if (spec === undefined) {
      results.push({
        taskCode: code,
        ok: false,
        message: '无完成动作实现（AUTOMATABLE_TASK_CODES 有它但 GROWTH_TASK_COMPLETION 漏写）',
      })
      failed += 1
      continue
    }
    // ⚠ 预算耗尽就**如实停在这里**：剩下每一项的真实完成动作都可能包含真实
    // 对话与多次复查，硬跑完会让整轮 RPC 悬到宿主超时（超时上限由
    // dsh-credentials 的 rpc 层决定，本插件不可见也不可控）—— 表现是用户点一次
    // 按钮、长时间无响应、最后失败，而前面已完成的项的积分虽已到账却看不到回执。
    // 宁可「少做几项 + 如实报出哪几项没做」，也不要「卡死到超时」。
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
      timedOut = true
      const remain = actionable.slice(actionable.indexOf(code))
      for (const pending of remain) {
        results.push({
          taskCode: pending,
          ok: false,
          message: '本轮时间预算已用尽，未执行（点一次按钮可继续）',
        })
      }
      failed += remain.length
      break
    }
    // 养虾等级族：判据是服务端 `status` 而非 progress 计数，事件推不动（见该常量
    // 注释）。**在分派之前**短路，才能同时覆盖 `chat` 与 `skillFresh` 两种 kind ——
    // 后者的真实会话写在分支开头，只在 chat 分支里拦不住。
    if (LEVEL_UNREACHABLE_TASK_CODES.has(code)) {
      ok = true
      clientOnlyFlag = true
      message = `${code} 的判据由服务端 status 记录（非 progress 计数），API 事件不改变它；需在客户端真实完成`
      results.push({ taskCode: code, ok, message, clientOnly: true })
      clientOnly += 1
      await new Promise((resolve) => setTimeout(resolve, TASK_INTERVAL_MS))
      continue
    }
    try {
      switch (spec.kind) {
        case 'canvas':
        case 'canvasThenChat': {
          // 判据是 wbx_design_canvas_* 遥测事件，故不建真实画布（避免在账号里堆画布）。
          const canvas = await reportTaskEvents(credential, product, fetcher, code, 1, {})
          if (!canvas.ok) {
            message = canvas.message
            break
          }
          await new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS))
          const progress = await readProgress(credential, product, fetcher, code)
          if (progress.current >= progress.target) {
            ok = true
            const claim = await claimGrowthTaskReward(credential, product, fetcher, code)
            message = `${canvas.message}，progress 达标（${progress.current}/${progress.target}）；${claim.message}`
          } else {
            ok = true
            clientOnlyFlag = true
            message = `${canvas.message}，progress ${progress.current}/${progress.target} 未涨，需在设计创意模式真实建一次画布`
          }
          break
        }
        case 'chat': {
          if (CLIENT_ONLY_TASK_CODES.has(code)) {
            clientOnlyFlag = true
            ok = true // 已尝试触达，但积分需客户端动作
            message = '需客户端完成（API 无法推进此任务进度）'
            break
          }
          // 夜猫子仅在服务端 23:00–08:00 计入，窗口外如实标注而不谎报已发。
          if (code === 'black_cat' && !isGrowthNightWindow()) {
            clientOnlyFlag = true
            ok = true
            message = `夜猫子仅在 23:00–08:00 计入，当前 ${new Date().getHours()} 点不在窗口内（未上报，窗口内点一次即可自动补足 3 次）`
            break
          }
          // 按 progress.target 补次数：还差几条发几条（不同会话各计一次）。
          // 专家类：服务端按真实 expert_actual_use 事件逐轮计数，单轮未必补满，
          // 故多轮补到 target 或无法再涨为止。
          const prog = progressByCode[code] ?? { current: 0, target: 1 }
          const remaining = Math.max(1, prog.target - prog.current)
          const isExpert = isExpertTaskCode(code)
          const model = modelForTaskCode(code)
          // 专家类：每轮换一个**不同**专家（服务端按 expert_id 去重，同 id 同天只计一次），
          // 列表不够时回到首个。非专家类传空专家。
          // ⚠ 绑定固定专家的任务（Expert_lighthouse / 体验专家族）走 fixedExpert 分支，
          // 到不了这里 —— 这里只服务「市场任取」的 expert_5 / Expert_team_use_3 /
          // expert_summoned。
          const expertList =
            code === 'Expert_team_use_3'
              ? expertTeamList
              : code === 'expert_5' || code === 'expert_summoned'
                ? expertAgentList
                : []
          // 服务端按 expert_id 去重（同 id 当天只计一次），故 remaining=1 时也要换不同
          // 专家连试，直到 progress 上涨或专家用尽。
          const maxRounds = isExpert
            ? Math.min(Math.max(remaining, 3), Math.max(1, expertList.length))
            : 1
          let reportedTotal = 0
          let nowCurrent = prog.current
          let targetNow = prog.target
          let lastReport: ReportResult = { ok: true, reported: 0, message: '' }
          for (let roundNo = 0; roundNo < maxRounds; roundNo++) {
            const thisRemaining = Math.max(1, targetNow - nowCurrent)
            lastReport = await reportTaskEvents(
              credential,
              product,
              fetcher,
              code,
              thisRemaining,
              expertList.length > 0
                ? { expert: expertList[roundNo % expertList.length] as MarketExpert }
                : {},
            )
            if (!lastReport.ok) {
              message = lastReport.message
              break
            }
            reportedTotal += lastReport.reported
            // 复查 progress，未达标且还有轮次则继续补
            const progress = await readProgress(credential, product, fetcher, code)
            nowCurrent = progress.current
            targetNow = progress.target
            if (nowCurrent >= targetNow) {
              break
            }
            if (roundNo < maxRounds - 1) {
              await new Promise((resolve) => setTimeout(resolve, ROUND_INTERVAL_MS))
            }
          }
          if (!lastReport.ok) {
            message = lastReport.message
            break
          }
          if (nowCurrent >= targetNow) {
            ok = true
            // progress 达标 → 自动领取奖励（免手动点击到账）。
            const claim = await claimGrowthTaskReward(credential, product, fetcher, code)
            message = `已上报 ${reportedTotal} 条事件，progress 达标（${nowCurrent}/${targetNow}）；${claim.message}`
            break
          }
          /**
           * 合成事件链没推进 ⇒ 改用**真实会话 + 真实 requestId** 再试一次。
           *
           * ⚠⚠ 顺序不可换：只发一次真实对话（不带它的 requestId）不算数 ——
           * 服务端按「事件 JOIN 到真实会话」计数，没有真 requestId 的事件链不被认，
           * 于是合成链不涨、真实对话也不涨，任务被误判成「需客户端」。
           * `Model_chat_GLM5.2` 就是这样被判成 clientOnly 的：它在旧账号上早于
           * 本实现就已领取，所以从没有机会暴露出「合成链推不动它」。
           * `skill_1` 走的是真 requestId 路径，所以它能成 —— 同一个机制，
           * 当时只给 skill_1 用了。
           */
          const realModel = model ?? FAST_MODEL
          const session = await chatRealSession(credential, product, fetcher, '', realModel)
          if (!session.ok) {
            // 连真实会话都拿不到 requestId（凭据/端点/限频）⇒ 如实报失败，
            // 不能报 clientOnly —— 那会把「服务端不可达」说成「要用户手动做」。
            message = `已上报 ${reportedTotal} 条事件，真实会话失败：${session.message}`
            break
          }
          const realReport = await reportTaskEvents(
            credential,
            product,
            fetcher,
            code,
            Math.max(1, targetNow - nowCurrent),
            {
              conversationId: `jb-${session.requestId}`,
              requestId: session.requestId,
              model: realModel,
            },
          )
          if (!realReport.ok) {
            message = realReport.message
            break
          }
          await new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS))
          const settled = await readProgress(credential, product, fetcher, code)
          if (settled.current >= targetNow) {
            ok = true
            const claim = await claimGrowthTaskReward(credential, product, fetcher, code)
            message = `${session.message}；${realReport.message}，progress 达标（${settled.current}/${targetNow}）；${claim.message}`
          } else {
            // 真实会话 + 真 requestId 仍不涨 ⇒ 这次是真的推不动，如实归 clientOnly。
            ok = true
            clientOnlyFlag = true
            message = `已上报 ${reportedTotal} 条合成事件 + 真实会话(${realModel})，progress ${settled.current}/${targetNow} 仍未涨`
          }
          break
        }
        case 'fixedExpert': {
          // 「体验「X」专家」族（含 Expert_lighthouse）：判据绑定固定 expert_id，
          // 市场列表仅用于 enrich 条目（version/名称以服务端为准）。
          const spec2 = FIXED_EXPERT_TASKS[code]
          if (spec2 === undefined) {
            message = '任务在 GROWTH_TASK_COMPLETION 里是 fixedExpert 但 FIXED_EXPERT_TASKS 缺登记'
            break
          }
          const outcome = await runFixedExpertExperience(
            credential, product, fetcher, code, spec2, expertAgentList,
          )
          ok = outcome.ok
          clientOnlyFlag = outcome.clientOnly
          message = outcome.message
          break
        }
        case 'mpChat':
        case 'mpExpert':
        case 'mpEvent': {
          // 小程序口径族：mp 头全链路（list/accept/claim）+ mp 指纹判据事件。
          // deadline 与节奏压缩选项从本轮选项取（后者仅供单测）。
          const mpCtx: MpTaskContext = {
            credential, product, fetcher,
            gapMs: options.mpChatGapMs ?? MP_CHAT_EVENT_GAP_MS,
            jitterMs: options.mpJitterMaxMs ?? MP_CHAT_JITTER_MAX_MS,
            actionGapMs: options.mpActionGapMs ?? MP_ACTION_GAP_MS,
            deadlineAt,
          }
          if (spec.kind === 'mpChat') {
            const outcome = await runMpChatTask(mpCtx, code)
            ok = outcome.ok
            clientOnlyFlag = outcome.clientOnly
            message = outcome.message
            break
          }
          if (spec.kind === 'mpExpert') {
            const outcome = await runMpExpertTask(mpCtx, code)
            ok = outcome.ok
            clientOnlyFlag = outcome.clientOnly
            message = outcome.message
            break
          }
          // mpEvent：Sequential_Tasks_4/5/7 的 primary + fallback 双形态。
          // primary 按任务定；fallback 是另一域的同判据形态（判据未解锁时双发只多
          // 两次无害上报）。事件构造复用既有 builder（PC 桌面指纹）与 mp 构造器。
          const primary =
            code === 'Sequential_Tasks_4'
              ? async (): Promise<MpTaskOutcome> => {
                  const conv = `jb-mp-${Date.now()}`
                  const report = await reportDesktopEvents(
                    credential, product, fetcher,
                    automationCreateEvent('自动化'), conv, `${conv}-r`,
                  )
                  return { ok: report.ok, clientOnly: false, message: report.message }
                }
              : code === 'Sequential_Tasks_5'
                ? async (): Promise<MpTaskOutcome> => {
                    const report = await reportMpEvents(
                      credential, product, fetcher,
                      [miniChatModelEvent(crypto.randomUUID(), GLM_MODEL_ID, GLM_MODEL_NAME)],
                    )
                    return { ok: report.ok, clientOnly: false, message: report.message }
                  }
                : async (): Promise<MpTaskOutcome> => {
                    // Sequential_Tasks_7（体验灵感）：primary 走 PC 口径灵感事件组
                    // （playbook_prompt 三账号实测点亮），fallback 走 mp 指纹。
                    const conv = `jb-pb-${Date.now()}`
                    const req = `${conv}-r`
                    const report = await reportDesktopEvents(
                      credential, product, fetcher,
                      playbookPromptEventChain('pm-gtm-launch-plan', '新产品上市 GTM 发布计划一页纸', conv, req),
                      conv, req,
                    )
                    return { ok: report.ok, clientOnly: false, message: report.message }
                  }
          const fallback =
            code === 'Sequential_Tasks_5'
              ? async (): Promise<MpTaskOutcome> => {
                  const report = await reportDesktopEvents(
                    credential, product, fetcher,
                    [chatRequestSendEvent(GLM_MODEL_ID, GLM_MODEL_NAME, `jb-glm-${Date.now()}`)],
                    `jb-glm-${Date.now()}`, `jb-glm-${Date.now()}`,
                  )
                  return { ok: report.ok, clientOnly: false, message: report.message }
                }
              : code === 'Sequential_Tasks_7'
                ? async (): Promise<MpTaskOutcome> => {
                    const report = await reportMpEvents(
                      credential, product, fetcher,
                      miniPlaybookEvents('pm-gtm-launch-plan', '新产品上市 GTM 发布计划一页纸'),
                    )
                    return { ok: report.ok, clientOnly: false, message: report.message }
                  }
                : undefined
          const outcome = await runMpEventTask(mpCtx, code, primary, fallback)
          ok = outcome.ok
          clientOnlyFlag = outcome.clientOnly
          message = outcome.message
          break
        }
        case 'webClick': {
          // Library_read：资料库介绍点击，判据在 web 域事件流（elementId 固定
          // library_doc_intro_click，页面为资料库空间）。
          const webRes = await reportWebEvent(
            credential, product, fetcher,
            'web_element_click', 'library_doc_intro_click', 'WorkBuddy资料库介绍',
          )
          if (!webRes.ok) {
            message = webRes.message
            break
          }
          await new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS))
          const progress = await readProgress(credential, product, fetcher, code)
          if (progress.current >= progress.target) {
            ok = true
            const claim = await claimGrowthTaskReward(credential, product, fetcher, code)
            message = `${webRes.message}，progress 达标（${progress.current}/${progress.target}）；${claim.message}`
          } else {
            ok = true
            clientOnlyFlag = true
            message = `${webRes.message}，progress ${progress.current}/${progress.target} 未涨，需在资料库页手动点一次介绍`
          }
          break
        }
        case 'appearance': {
          // Hp_Appearance：先落主题资产，再补桌面域 appearance_skin_apply 事件。
          const theme = await setAppearanceTheme(credential, product, fetcher)
          if (!theme.ok) {
            message = theme.message
            break
          }
          await new Promise((resolve) => setTimeout(resolve, APPEARANCE_SETTLE_MS))
          const report = await reportTaskEvents(credential, product, fetcher, code, 1, {})
          if (!report.ok) {
            message = report.message
            break
          }
          await new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS))
          const progress = await readProgress(credential, product, fetcher, code)
          const done = `${theme.message} + ${report.message}`
          if (progress.current >= progress.target) {
            ok = true
            const claim = await claimGrowthTaskReward(credential, product, fetcher, code)
            message = `${done}，progress 达标（${progress.current}/${progress.target}）；${claim.message}`
          } else {
            ok = true
            clientOnlyFlag = true
            message = `${done}，progress ${progress.current}/${progress.target} 未涨，需在设置页切一次主题`
          }
          break
        }
        case 'skillFresh': {
          // skill_1：判据是 skill_info 事件 JOIN 到真实 fast-model 会话，
          // 故先取服务端真实 requestId，再以其为根上报对话链 + skill_info。
          const session = await chatRealSession(credential, product, fetcher, '')
          if (!session.ok) {
            message = session.message
            break
          }
          // ⚠ `fast-model` 写死而非取变量：skill_info 判据只认 fast-model 会话。
          // skill_installed（等级族）与 skill_1（成长族）共用 skill_info 判据。
          const report = await reportTaskEvents(
            credential, product, fetcher, code, 1,
            { requestId: session.requestId, model: FAST_MODEL },
          )
          if (!report.ok) {
            message = report.message
            break
          }
          await new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS))
          const progress = await readProgress(credential, product, fetcher, code)
          const done = `${session.message} + ${report.message}`
          if (progress.current >= progress.target) {
            ok = true
            const claim = await claimGrowthTaskReward(credential, product, fetcher, code)
            message = `${done}，progress 达标（${progress.current}/${progress.target}）；${claim.message}`
          } else {
            ok = true
            clientOnlyFlag = true
            message = `${done}，progress ${progress.current}/${progress.target} 未涨，需在客户端真实调用一次技能`
          }
          break
        }
      }
    } catch (error) {
      /**
       * 单个任务的异常（代码缺陷 / 端点返回意外形状）**只记该项失败**，
       * 不得中断整轮 —— 否则一个任务出问题会让所有账号、所有任务一起失败，
       * 用户只看到一个 `失败 — <内部异常>`，完全无从判断是哪一项。
       */
      message = `完成动作异常：${error instanceof Error ? error.message : String(error)}`
    }
    results.push({
      taskCode: code,
      ok,
      message,
      ...(clientOnlyFlag ? { clientOnly: true } : {}),
    })
    if (ok && !clientOnlyFlag) {
      completed += 1
    } else if (!ok) {
      failed += 1
    }
    if (clientOnlyFlag) {
      clientOnly += 1
    }
    // 串行节流：任务间留缓冲。
    await new Promise((resolve) => setTimeout(resolve, TASK_INTERVAL_MS))
  }

  // ── 扫尾：对所有「已达标未领取」的任务补领（网页显示可领取 = 服务端已判完成，
  //    此时 claim 端点直接到账，无需依赖我推 progress 的数值）。幂等：已领过返回
  //    already_claimed，不重复计分。
  let claimedCount = 0
  let claimedCredit = 0
  {
    // 扫尾覆盖**全量**任务 code（含已完成未领的），不只 not_accepted 子集。
    const allCodes = await listAllGrowthTaskCodes(credential, product, fetcher)
    for (const code of allCodes) {
      // 扫尾同样受时间预算约束：allCodes 长度由服务端决定，无上限，
      // 每项一次 POST + 1s sleep，超时未检查会撞上宿主 RPC 超时。
      if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
        timedOut = true
        const remaining = allCodes.length - allCodes.indexOf(code)
        console.warn(
          `[buddy-growth] 扫尾补领在时间预算处停止，剩余 ${remaining} 项未执行`,
        )
        results.push({
          taskCode: code,
          ok: false,
          // ⚠️ 文案必须与逐项阶段的「未执行」用**同一个词**：这条断言
          // （`message` 含「未执行」）是回归用例判据，两处一旦分叉，
          // 扫尾分支就没有测试覆盖了。
          message: `扫尾补领触及时间预算，本轮还有 ${remaining} 项未执行；再点一次即可继续`,
        })
        failed += 1
        break
      }
      const claim = await claimGrowthTaskReward(credential, product, fetcher, code)
      if (claim.ok && claim.claimed) {
        claimedCount += 1
        claimedCredit += claim.credit
      }
      await new Promise((resolve) => setTimeout(resolve, SWEEP_INTERVAL_MS))
    }
  }

  const hasActivity = completed > 0 || failed > 0 || clientOnly > 0 || claimedCount > 0
  /** 缺 uid 的提示（拼在末尾，无论有无活动都要出现 —— 否则正是「静默」）。 */
  const uidHint = missingUserId
    ? '；⚠️ 凭据缺少 user_id，判据事件可能不被服务端计数，请重新登录该账号'
    : ''
  return {
    ok: failed === 0,
    results,
    completed,
    clientOnly,
    failed,
    claimedCount,
    claimedCredit,
    timedOut,
    ...(hasActivity
      ? {
          message: `完成 ${completed} 项，需客户端 ${clientOnly} 项，失败 ${failed} 项，自动领取 ${claimedCount} 项（+${claimedCredit} 积分）${timedOut ? '；本轮时间预算用尽，剩余项未执行，再点一次即可继续' : ''}${uidHint}`,
        }
      : // 无活动：区分「本来就没有可完成任务」与「扫尾领到了但逐项阶段没做」
        // —— 后者说明账号里只有已达标未领的奖励，是正常终态。
        noActionableTasks
        ? { message: `无 API 可达的待完成任务${uidHint}` }
        : { ...(uidHint.length > 0 ? { message: uidHint.replace(/^；/, '') } : {}) }),
  }
}

/**
 * 单账号的成长中心任务执行，转成 RPC 明细。
 *
 * ## ⚠️ 为什么在**本文件**而不是 `jet-hub-rpc.ts`（2026-10-08 Task 4 搬迁）
 *
 * 它是 `credits.afterClaim` 的实现，而 `afterClaim` 由 `src/provider-credits.ts`
 * 的能力表提供。留在 `jet-hub-rpc.ts` 会让那张表必须 import 它 ⇒
 * `provider-credits.ts ⇄ jet-hub-rpc.ts` **循环 import**（后者已经 import 前者）。
 * 搬到本文件后依赖是单向的：`jet-hub-rpc.ts` → `provider-credits.ts` → `buddy-growth.ts`。
 *
 * ⚠️ 搬迁是**逐字**的（函数体一行未改），只有 import 来源变了。
 *
 * 僵尸账号（凭据被外部删除 ⇒ 上游回 401/403）归 `error` 提示但**不计入 failed**：
 * 它的处置是「重新登录」，与「任务真的推不动」完全不同。签到侧已把这类账号归
 * `inactive`（`collectClaimResults` 的 `凭据未配置` 分支同义），成长侧须一致 ——
 * 否则同一个僵尸条目在两处会给出互相矛盾的判定。
 *
 * @param budgetMs 透传给 `runGrowthTaskCompletions`；`undefined` 由其取缺省 10 分钟。
 */
export async function collectBuddyGrowth(
  credential: BuddyCredential,
  product: BuddyProduct,
  entry: ProviderAccountEntry,
  budgetMs: number | undefined,
  roundDeadlineAt: number | undefined,
): Promise<RpcBuddyGrowthAccountResult> {
  // 整轮预算已耗尽 ⇒ 该账号**不再发起任何成长请求**。
  //
  // ⚠️ 签到侧已经跑完（afterClaim 在 claim 之后调用），所以这里返回的只是成长
  // 明细，不影响该账号的签到判定。逐项标 `failed` 会让整条提示染黄，而这不是
  // 任何账号的过错 —— 故用 `ok:true` + `error` 说明「本轮没轮到它」。
  if (roundDeadlineAt !== undefined && Date.now() >= roundDeadlineAt) {
    return {
      accountId: entry.id, nickname: entry.nickname,
      ok: true, completed: 0, clientOnly: 0, failed: 0,
      claimedCount: 0, claimedCredit: 0, timedOut: true, tasks: [],
      error: '本轮时间预算已用尽，未执行成长任务（再点一次即可继续）',
    }
  }
  let report: Awaited<ReturnType<typeof runGrowthTaskCompletions>>
  try {
    report = await runGrowthTaskCompletions(credential, product, fetch, { budgetMs })
  } catch (error) {
    return {
      accountId: entry.id, nickname: entry.nickname,
      ok: false, completed: 0, clientOnly: 0, failed: 0,
      claimedCount: 0, claimedCredit: 0, timedOut: false, tasks: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
  // 凭据失效的判据：逐项 message 里出现「凭据已失效」。它与「任务失败」是
  // 两回事 —— 前者要重新登录，后者是判据推不动。
  let expired = report.results.some((r) => /凭据已失效/.test(r.message))
  // ── 连登链 + 一次性奖励（补签/兑换/抽奖/首Buddy/礼包/保连胜）──
  // 与任务完成动作相互独立：任务阶段失败（含预算用尽）不影响这里把「已解锁/已
  // 达标」的奖励领走；反之这里失败也不回改任务结果。全部幂等，重复点不重复计分。
  let extras: StreakExtrasReport | undefined
  try {
    extras = await claimStreakExtras(credential, product, fetch, roundDeadlineAt)
  } catch (error) {
    // 连登链整体异常不吞任务结果，如实附一行说明。
    extras = {
      ok: false, credit: 0, claimedCount: 0, drewCount: 0, makeupUsed: 0,
      notes: [`连登链异常：${error instanceof Error ? error.message : String(error)}`],
      rows: [], expired: false,
    }
  }
  expired = expired || extras.expired
  const extraRows: GrowthTaskResult[] = extras.rows.map((row) => ({
    taskCode: row.taskCode, ok: row.ok, message: row.message,
  }))
  // ⚠ notes 不能放进 `error`：UI 见到 error 会**折叠全部任务明细**只显示那一行。
  // 连登链的非致命说明（查询失败/跳过原因）以合成行承载，明细照常展开。
  if (extras.notes.length > 0 && !expired) {
    extraRows.push({ taskCode: '(连登链)', ok: true, message: extras.notes.join('；') })
  }
  const allResults = [...report.results, ...extraRows]
  const extraCredit = extras.credit
  const extraClaimed = extras.claimedCount
  return {
    accountId: entry.id, nickname: entry.nickname,
    // 僵尸账号视作「无需再管」，不把整条提示染成失败。
    ok: report.ok || expired,
    completed: report.completed,
    clientOnly: report.clientOnly,
    failed: expired ? 0 : report.failed,
    claimedCount: report.claimedCount + extraClaimed,
    claimedCredit: report.claimedCredit + extraCredit,
    timedOut: report.timedOut,
    tasks: allResults,
    ...(expired ? { error: '凭据已失效，请在 Jet Hub 重新登录该账号' } : {}),
  }
}
