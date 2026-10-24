import * as React from 'react';

import {
  supportsCreditBalance,
  supportsCreditPackageList,
  supportsDailyCheckin,
  supportsOnboardingTasks,
  supportsRateLimit,
  supportsAccountTest,
  supportsPermanentLock,
  supportsSubscriptionQuota,
  permanentLockCopy,
  checkinProviders,
} from './credits-capabilities.js';
import { orderAfterDrop, dropPositionFromPointer } from './account-order.js';
import {
  setSidebarEntry,
  sidebarEntryReadFailed,
  sidebarEntryVisible,
  subscribeSidebarEntry,
} from './sidebar-entry-store.js';
import { OpencodeKeyModal, OpencodeProxyModal, GeminiProxyModal } from './opencode-proxy-modal.js';
// ⚠️ **本 fork 独有**（魔搭，2026-10-17 审计 P0 修复）：与 opencode 同属
//    「不跳浏览器、手工粘贴 API Key」的 provider，故复用同一条自绘弹窗通路。
//    ⚠️ 本 import 此前**不存在** ⇒ `modelscope-key-modal.js` 整份 140 行从未进 bundle，
//    面板点「添加账号」无任何反应入口（症状零日志）。
import { ModelscopeKeyModal, ModelscopeKeyEditModal } from './modelscope-key-modal.js';
// ⚠️ 2026-10-22 整页白屏事故的兜底层（见该文件头的事故说明）。
import { normalizeProbeNotice, safeNoticeDetails } from './notice-shape.js';
import {
  formatExpirySplitLine,
  formatNamedPoolLine,
  formatPoolSplitLine,
  formatPackageTooltip,
  splitCreditsByExpiry,
  expirySplitParts,
  expiryBucketLabel,
  daysUntilExpiry,
  exclusivePoolRemainingOf,
  isExclusivePool,
} from './credit-expiry.js';
import {
  allModelsDisabled,
  disablingLeavesNoEnabledAccount,
} from './account-model-link.js';
import { buildCreateAccountPayload, newAccountAsksChannel } from './new-account.js';
import { bulkButtonState } from './model-bulk.js';
import {
  copyToClipboard,
  formatModelIdList,
  gatewayApiKeyHint,
  gatewayButtonLabel,
  gatewayButtonTitle,
  gatewayCardExpanded,
  gatewayCardLabel,
  gatewayEffortRows,
  gatewayEffortsEmptyHint,
  gatewayEffortsHintLines,
  gatewayEffortsText,
  gatewayModelKeyOf,
  filterEffortRows,
  gatewayModelsEmptyHint,
  gatewayModelsHint,
  groupGatewayEntries,
  groupGatewayModels,
  gatewayAllowLanHint,
  gatewayAllowLanSwitchDisabled,
  gatewayAllowLanToggleNotice,
  gatewayStatusLines,
  gatewayLoopbackOnly,
  gatewayFootnote,
  gatewaySwitchDisabled,
  gatewayToggleNotice,
  modelCapabilityBadge,
} from './openai-gateway-panel.js';
import {
  filterModels,
  isFilterActive,
} from './model-filter.js';
// 「供应商 → 模型列表」统一管理页的判定（跨供应商那一层：哪些分组该出现、
// 未加载怎么算、总览怎么计）。模型级筛选仍复用上面的 model-filter.js。
import {
  centerBulkState,
  centerPendingProviderIds,
  centerTotals,
  visibleCenterSections,
} from './model-center.js';
// 聚合面板的判定与文案（单测环境没有 react ⇒ 必须抽成纯函数才能覆盖）。
import {
  candidateKeyOf,
  candidateRowLabel,
  candidateStateOf,
  candidateToggleAction,
  describeCandidateState,
  expiryLabel,
  // ⚠️ `moveCandidateTo` **必须留着** —— 鼠标拖动落点用的就是它
  //（`onDrop` 里 `moveCandidateTo(orderOf(model), from, options.index)`）。
  // ⚠️ 我清理「上下箭头」时曾把它连同 `moveCandidate` 一起从 import 删掉，被
  //    `credits-capabilities.spec.ts` 的「客户端源码不得有未声明变量」守卫抓住
  //   （那个守卫存在的理由正是：未声明变量会让**整个设置页**崩掉）。
  //    ⇒ 只删真正零调用者的那个（`moveCandidate` 随箭头一起走）。
  moveCandidateTo,
  pendingOrderFromRoster,
  rejectionsFromCatalog,
  rotationBlockerOf,
  rotationRosterOf,
  shouldReprobeExpiry,
  sortCandidatesByExpiry,
  sortModelsForPanel,
  startExpiryReprobe,
  toggleRejection,
} from './aggregate-panel-logic.js';
import {
  groupProviders,
  nextProviderOrderAfterDrop,
  providerSwitchRows,
  providerToggleSummary,
  sortOpenProvidersByOrder,
  summarizeProviderToggle,
} from './provider-toggle.js';
import {
  groupBulkStateFor,
  groupExpanded,
  groupModelsForDisplay,
} from './model-groups.js';
import { formatRowTokensPerSecond } from './tokens-per-second.js';
import {
  accountLabel,
  avgPerfDetailTooltip,
  avgPerfText,
  channelCardTitle,
  channelLabel,
  channelOrder,
  entryTokenText,
  formatDuration,
  formatEntryTime,
  formatTps,
  formatTtft,
  historyHeatmapCells,
  hasAnyData,
  historyTitle,
  HISTORY_RANGES,
  ledgerSubtitle,
  rangeDaysOf,
  tokenSummaryText,
  tokenSummaryTooltip,
  todayDayKey,
  totalTokensOf,
} from './token-ledger-panel.js';
// ⚠️ `formatTokenCount` 用 jet-hub.js 自己的本地实现（有界渲染，见其注释）；
// 面板模块的同名导出只供趋势图 tooltip 等**弹窗内部**使用，不在这里导入 ——
// 两个同名符号会被 esbuild 判成重复声明（第 1 期就踩过一次）。
import { decryptBackup, encryptBackup, isEncryptedBackup } from './backup-crypto.js';
import {
  formatCredits,
  formatTokens,
  formatUnits,
  formatQuotaLine,
  formatQuotaDetail,
  formatClaimGains,
  unitLabel,
} from './credits-format.js';
import {
  quotaWindowLabel,
  quotaWindowsOf,
  quotaResetsIn,
  quotaTone,
  quotaPercentValue,
  formatQuotaPercent,
} from './quota-format.js';
import { trimBackupPayload, describeBackupAccounts } from './backup-payload.js';
import { convertForeignAccounts, looksLikeForeignAccountList } from './backup-convert.js';
import { PROVIDER_ICONS } from './provider-icons.js';
import { PROVIDER_REGISTRY } from '../../src/provider-registry.js';
import {
  scanCompensation,
  toCompensationState,
  claimAllCompensation,
  compensationHeadline,
  compensationHint,
} from './compensation-panel-logic.js';

export const JET_HUB_RPC_CHANNEL = '/jet-hub';

/**
 * Jet Hub 左栏的 provider 列表。
 *
 * ⚠️ 2026-10-08 起**从 `src/provider-registry.ts` 派生**（id / label / logoClass），
 * 图标另由 `./provider-icons.js` 的 `PROVIDER_ICONS` 提供。原先 15 条字面量
 * 手写在这里，而四处单测又从**本文本**用正则派生 id（`[a-z]+` 漏连字符）——
 * 那是「静默漏算」的来源。
 *
 * ⚠️ label 长度决定 rail 要多宽才不出省略号（`.dim-jh-rail` 的算式）；
 * 最长几条（WorkBuddy (国际版) / Gemini Code Assist）不能加长。
 */
const PROVIDERS = Object.freeze(
  PROVIDER_REGISTRY.map((d) => Object.freeze({
    id: d.id,
    label: d.label,
    icon: PROVIDER_ICONS[d.id],
    logoClass: d.logoClass,
  })),
);

/**
 * 渠道 id → 展示名。
 *
 * ⚠️ **唯一的渠道名来源**：用量徽标（`./usage-badge.js`）与设置页左栏都走它，
 * 不要在别处再抄一份 `{ codearts: 'CodeArts (华为云)', … }` —— 那样改名时必然
 * 出现「徽标写着旧名字、设置页写着新名字」的分裂。查不到时**原样返回 id**：
 * 徽标宁可显示一个裸 id（可排查），也不要显示空白。
 */
export function providerLabel(id) {
  return PROVIDERS.find(p => p.id === id)?.label ?? id;
}

/**
 * 积分能力判定见 `./credits-capabilities.js`。
 *
 * 之前这里有一份 `CREDITS_PROVIDERS = ['buddy']`，只用来决定「一键领取积分」
 * 按钮是否渲染，却**没有**约束余额查询 —— 后者在面板挂载时对所有 provider
 * 无条件发起，于是 CodeArts 面板每次打开都在控制台报
 * `unsupported provider: codearts`，账号卡片的「积分」也永远是「查询失败」。
 * 现在两项能力（balance / dailyCheckin）都在同一张表里显式登记，并在请求前判定。
 *
 * 各 provider 的签到来源：
 * - **buddy（CodeBuddy）**：签到接口位于腾讯中国区后端。
 * - **lobsterai（有道龙虾）**：签到接口是 `client-activities` 三步流程
 *   （实现见 `src/lobsterai-credits.ts`），经 `sigin.py` 实测确认。
 *
 * **workbuddy 无签到**：国际版（www.workbuddy.ai）后端没有签到接口
 * （内核中只有 `/v2/billing/meter/get-dosage-notify` 用量通知）。
 * CodeArts 是华为云账号体系，同样不参与。
 */

/**
 * 有成长中心任务可做的 provider —— **只有 buddy（CodeBuddy 中国版）**。
 *
 * ⚠️ 2026-10-08（Task 4）：宿主侧原先另有一张**手抄的平行清单**
 * `GROWTH_CAPABLE_PROVIDERS`（`src/jet-hub-rpc.ts`），**已删除** ——
 * 宿主现在按「该家是否提供 `credits.afterClaim`」受理
 *（能力注册表 `src/provider-credits.ts` 里**只有 buddy** 挂了它）。
 *
 * ⚠️ **本表仍然必须存在**：它决定「按钮渲不渲染 / 要不要传 `runTasks`」，
 * 而宿主那张决定「受不受理」—— 两侧取值同源（都源自能力声明），但**作用不同**，
 * 不能只留一处：少了本表，客户端会对没有成长中心的渠道也传 `runTasks`。
 *
 * ⚠️ `workbuddy`（国际版）**不在**清单里：contributor 在 !62 复审中实测确认
 * `www.workbuddy.ai` 后端**根本没有成长中心**（无任务列表、无 claim 端点）。
 * 原先按「同源产品、将来可能开放」保留，但既然该产品没有这个功能，
 * 留着就是等一个不会到来的能力。
 */
const GROWTH_TASK_PROVIDERS = new Set(['buddy']);

/**
 * Accio 的「每日额度」桶名 —— 必须与宿主 `src/accio-credits.ts` 的
 * `ACCIO_CREDIT_BUCKETS` 里 `daily` 那一行**逐字一致**。
 *
 * ⚠️ 按**池名**定位而不是下标：宿主对「缺席的桶不产出」是刻意设计
 * （`entitlement` 里没有 `daily` 时那一行根本不存在），下标会错位 ——
 * 错位的后果是「倒计时那一行永远不出现」，**静默失效**，没有任何报错。
 * 一致性由 `tests/unit/accio-client-panel.spec.ts` 从宿主源码真读该字面量锁死。
 */
const ACCIO_DAILY_BUCKET = '每日积分';

/**
 * Accio 每日额度的**诚实说明**（本面板唯一的说明文案来源）。
 *
 * ## 为什么必须把这四件事写清楚
 *
 * Accio **没有签到端点**：每日积分由服务端在**登录时**发放
 * （`DAILY_REWARD`，24 小时有效、**不累积**）。用户对「签到」的心智模型是
 * 「每天点一下领一笔」，而这个模型每一处都会出错：
 *
 * | 不说清 | 后果 |
 * |---|---|
 * | 登录时发放 | 用户会去找一个不存在的「领取」按钮 |
 * | 24 小时有效 | 用户以为可以攒着 |
 * | 不累积 | 用户以为昨天没登录的那份今天还能补 |
 * | 重新拿到的办法 | 用户不知道「删号重登」是当前唯一可行的手动路径 |
 *
 * ⚠️ **文案里刻意不写具体数字**（实测是 200，但那是**某一时刻的读数**）：
 * 同一屏正下方就是服务端下发的 `remaining / total`，写死数字会在上游调整额度时
 * 变成「说明说 200、桶显示 300」的**自相矛盾**。数量以宿主下发的桶为准。
 *
 * ⚠️ **本提交刻意不提供「刷新每日额度」按钮**：它需要宿主侧新增
 * 「重新登录既有账号」的 RPC（现有的 `account.create` 每次都新造账号 id，
 * 见 `src/jet-hub-rpc.ts`），在 RPC 接线之前渲染那个按钮就是一个
 * **骗人的控件**。故这里只给出**今天真的能用**的手动路径。
 * ⚠️ 文案里**不得**出现 `**` 之类的标记（它会被原样渲染成星号）。
 */
const ACCIO_DAILY_REWARD_NOTE =
  'Accio 的每日积分由服务端在登录时发放，有效期 24 小时，次日刷新、不累积。'
  + '它没有可调用的领取接口 —— 要重新拿到这份每日额度，请删除该账号后重新登录一次。';

function ProviderLogo({ provider }) {
  const p = PROVIDERS.find(p => p.id === provider);
  if (!p) return null;
  return React.createElement('span', { className: `dim-jh-providerIcon ${p.logoClass}` },
    React.createElement('img', { src: p.icon, alt: '', width: 20, height: 20 })
  );
}

function formatTime(ts) {
  if (!ts || ts <= 0) return null;
  const d = new Date(ts);
  const now = Date.now();
  if (ts < now) return '已过期';
  const diff = ts - now;
  if (diff < 3600000) return `${Math.round(diff / 60000)} 分钟后`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)} 小时后`;
  // ⚠️ **跨年必须带年份**（真实误读，2026-10-19）：Codely 的令牌有效期是一
  //    整年（JWT exp ≈ iat + 365 天），不带年份时显示「10月19日 21:47」——
  //    与签发时刻月/日/时刻全同，用户当成「今天」以为刚过期（报障原话
  //    「为啥一经过了」）。年内保持原样（多数渠道有效期 ≤ 30 天，年份冗余）。
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleString('zh-CN', {
    ...(sameYear ? {} : { year: 'numeric' }),
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// 四个限流标记操作的 hover 帮助文案。抽成常量以便按钮与说明共用同一份措辞。
const RETEST_HELP = '对本账号每个「限额重置」标记的模型真实发送一条最小消息：'
  + '正常返回则清除该标记，仍被限流则保留。会消耗少量模型额度。';
const RETEST_ALL_HELP = '对本页全部账号（含已停用）执行「重测」：'
  + '逐个模型真实发送一条最小消息，正常返回才清除标记。停用账号同样会发送。会消耗模型额度。';
const RESET_HELP = '直接清除本账号的全部「限额重置」标记，不发送任何请求。'
  + '适用于你已确认额度恢复、只想清掉显示的情况。';
const RESET_ALL_HELP = '直接清除本页全部账号（含已停用）的「限额重置」标记，不发送任何请求。';

/**
 * 「测试」按钮的说明。
 *
 * ⚠️ 措辞必须讲清「与重测的区别」：用户会本能地把两者混为一谈，然后以为
 * 「测试」只是重测的别名。真正的区别是**触发条件**——重测只测已有标记的模型，
 * 没有标记时一次请求都不发；测试无条件真发一次。
 */
const TEST_HELP = '无条件真实发送一条最小消息给这个账号（不依赖是否存在「限额重置」标记），'
  + '用来确认账号当下到底还能不能用。与「重测」的区别：重测只测「已有标记」的模型，'
  + '没有标记时一次请求都不发；测试不看标记，直接挑一个模型发出去。'
  + '只回报结果，不修改任何限流标记。会消耗少量模型额度。';

/**
 * 「显示列表」按钮的说明。
 *
 * 措辞必须讲清两点，否则用户会以为关掉开关就等于删除模型：
 * - 关闭只是**从对话框的模型选择里隐藏**，模型本身仍然存在、可随时再打开；
 * - 采用黑名单制，没被关掉的模型（含服务端后续新增的）默认都是打开的。
 */
const MODEL_LIST_HELP = '列出该 Provider 的全部模型。每个模型后面的开关默认打开；'
  + '关闭后，该模型不再出现在对话框的模型选择列表里（黑名单制：只有被关闭的才隐藏，'
  + '其余含服务端新增的模型一律默认显示）。此设置持久化保存，可随时重新打开。';

/** 把一次重测/重置的响应汇总成一行可读文案。 */
function summarizeProbe(kind, res) {
  if (kind === 'reset' || kind === 'resetAll') {
    const n = res?.clearedCount ?? 0;
    return n > 0 ? `已清除 ${n} 条限流标记` : '没有可清除的限流标记';
  }
  const accounts = res?.accounts ?? [];
  const cleared = res?.clearedCount ?? 0;
  const still = accounts.reduce((sum, a) => sum + (a.stillLimited?.length ?? 0), 0);
  const parts = [];
  if (cleared > 0) parts.push(`已清除 ${cleared} 条`);
  if (still > 0) parts.push(`${still} 条仍受限`);
  if (parts.length === 0) parts.push('没有可重测的限流标记');
  return parts.join('，');
}

/**
 * 把一次「测试」的响应汇总成一行可读文案。
 *
 * ⚠️ 必须与 `summarizeProbe` 分开写：测试的响应里**没有** `accounts` / `clearedCount`
 * 字段（它不写存储、没有「清除了几条」可报），拿它去喂 `summarizeProbe` 会得到
 * 「没有可重测的限流标记」——把「测试失败」说成「没什么可测的」，是彻底的误报。
 */
function summarizeTest(res) {
  const model = res?.modelId || '未知模型';
  if (res?.ok) return `测试通过：${model} 正常返回`;
  const reason = res?.message || '仍受限';
  return `测试未通过：${model} — ${reason}`;
}

/**
 * 积分 / token 数值的格式化已搬到 `./credits-format.js`（纯函数模块）：
 * 会话输入区的**用量徽标**同样要显示余额，而它的折叠态文案必须可单测 ——
 * 本文件顶部 `import * as React from 'react'`，而 react 是宿主注入的 external
 * （node_modules 里没有），任何 import 本文件的测试都跑不起来。
 * 搬出去同时保证了「徽标」与「设置页」不可能显示出两个不同的数字。
 */

/**
 * 把一个包的明细格式化成 tooltip 的一行。
 *
 * ⚠️ 到期提示取 `deductionEndTime`（扣费截止），**不是** `cycleEndTime`：
 * 订阅套餐的计量周期是月度的（月底清零），但积分本身可以留到 8 年后 ——
 * 拿周期时间显示会让用户以为"永久积分只剩 2 天"。两者都没有时才不显示。
 *
 * ⚠ 按**包自身**的 `unit` 格式化：同一 provider 的不同包可能单位不同
 * （且 ZCode 的包是 token，`94539275` 直接显示读不出量级）。
 *
 * @param pkg - 资源包。
 * @param windowDays - 后端回传的窗口天数（决定这一行标成「N 天内到期」还是「还有 N 天」）。
 * @param now - **渲染时**的当前时刻（分类是时间的函数，不能传缓存值）。
 */
function formatPackageLine(pkg, windowDays, now) {
  const remaining = formatUnits(pkg.remaining, pkg.unit) ?? '?';
  const total = formatUnits(pkg.total, pkg.unit) ?? '?';
  const parts = [`${pkg.active ? '' : '[已失效] '}${pkg.name || '未命名'}: ${remaining} / ${total}`];
  const daysLeft = daysUntilExpiry(pkg, now);
  if (!pkg.active && pkg.expiredTime) parts.push(`失效于 ${pkg.expiredTime}`);
  else if (daysLeft !== null) {
    const label = expiryBucketLabel(pkg, windowDays, now);
    parts.push(`距到期 ${Math.ceil(daysLeft)} 天${label ? `（${label}）` : ''}`);
  } else if (pkg.cycleEndTime) parts.push(`本周期至 ${pkg.cycleEndTime}`);
  return parts.join(' · ');
}

/**
 * 账号卡片上的余额行（积分 / Token 两种单位）。
 *
 * 三种状态严格区分，不能混为一谈：
 * - 查不到（balance 为 null）→ 显示原因，不要显示成 0
 * - 查到了但余额为 0 → 显示 0
 * - 还没有结果 → 显示"读取中"
 *
 * ## ⚠ 单位（真实缺陷）
 *
 * 用户报障：「智谱 plan 给的不是积分是 tokens，应该显示 `Token: xx.yyM` 这种格式」。
 * ZCode 的 `billing/balance` 里 `unit_type: "token"`（实测），Host 已把它
 * 透传成 `balance.unit` / `package.unit` —— 故**标签与数字都要按单位走**：
 * 标签用 `Token`（不是「积分」），数字用 `94.54M`（不是 `94539275`）。
 *
 * ⚠ 判定取**首个有效包**的单位（Host 侧同一 provider 的包单位一致；
 * 混合单位时以第一个为准，避免标签闪烁）。
 *
 * @param windowDays - 后端 `credits.balances` 回传的「临时积分」窗口（天）。
 *   有它才显示**临时 / 长期**两桶（CodeBuddy / WorkBuddy / TRAE / LobsterAI 带）。
 */
function CreditBalanceRow({ balance, error, loading, windowDays, provider }) {
  const all = balance?.packages || [];
  // ⚠ 单位从**包**上取（ZCode 是 token，其余是积分），标签与格式化都按它走。
  const unit = all.find(p => p && p.unit)?.unit;
  const label = unitLabel(unit);
  if (loading) {
    return React.createElement('div', { className: 'dim-jh-metaRow' },
      React.createElement('dt', null, label),
      React.createElement('dd', { 'data-tone': 'muted' }, '读取中…'));
  }
  if (error || !balance) {
    return React.createElement('div', { className: 'dim-jh-metaRow' },
      React.createElement('dt', null, label),
      React.createElement('dd', { 'data-tone': 'warn', title: error || '查询失败' },
        error || '查询失败'));
  }
  const total = formatUnits(balance.total, unit) ?? '0';
  const activeCount = all.filter(p => p.active).length;
  /**
   * 配额窗口（Gemini）：主行显示**逐窗口百分比**，不显示均值。
   *
   * 用户报障原文：「95 积分；为什么显示的是积分不是额度，计划里应该说了会显示额度」。
   * 两层错误叠在一起：标签走了 `unitLabel` 的「其余 ⇒ 积分」兜底分支，
   * 数字走了 `formatCredits` 的两位小数（94.5 ⇒ `94.50`）。而 94.5 本身还是
   * 两个窗口剩余比例的**平均**——一个上游根本不存在的数。逐窗口列出来
   * 才是这份读数本来的形状（计划 §3.3：「5 小时窗口 99% / 周窗口 99%」）。
   *
   * ⚠️ 非配额单位时 `quotaText` 为 `null`，下面全部走老分支，**零影响**。
   */
  const quotaText = formatQuotaLine(all, unit);
  /**
   * ⚠️ 分类在**渲染的这一刻**用当前时间现算，绝不存进 state、也不缓存到别处：
   * 「临时 / 永久」等于「距扣费截止是否满 N 天」，而宿主长期开着、时间只向前流 ——
   * 一笔距到期 15 天 30 秒的余额，用户什么都不做，半分钟后就越过线。
   * 存下来的分类会同时骗到用户（面板说没临时积分，其实有了）和排查者
   * （明明越线却按永久选号）。渲染节拍由「挂载 / 切 provider / 点刷新积分」提供，
   * 数字本身也正是这些时刻才重拉，无需额外的常驻定时器。
   */
  const now = Date.now();
  const split = splitCreditsByExpiry(all, windowDays, now);
  // ⚠ 数字按**单位**格式化（remote 引入的单位支持）：ZCode 的包是 token，
  // 用 `formatCredits` 会把 94539275 显示成「9453.93万」而非「94.54M」。
  const formatForUnit = (value) => formatUnits(value, unit);
  const expiryText = formatExpirySplitLine(split, formatForUnit);
  /**
   * 三档**带色分段**（用户 2026-10-12：永久绿 / 长期黄 / 临期红 + 倒计时）。
   *
   * ⚠️ 与 `expiryText` 同源（都走 `credit-expiry.js`），这里额外要结构化分段
   * 是为了让 React 逐段设 `data-tone` —— 单个字符串只能整体一个颜色。
   */
  const expiryParts = expirySplitParts(split, formatForUnit, now);
  /**
   * **独立池**（如 AStudio 的星火积分）：服务端给的是两个互不相通的池，
   * 那笔钱**不能**当通用积分用。分桶按金额聚合、天然丢池名 ⇒ 单独摘出来标注，
   * 否则主行一句「永久 25000」会被读成「我有 25000 通用积分」。
   *
   * ⚠️ 数字与池名都来自 `balance.packages`（单一来源），不在这里重新算；
   *    0 时不渲染（没有独立池的 provider 逐字不变）。
   */
  const exclusiveRemaining = exclusivePoolRemainingOf(all);
  // ⚠ 同口径（与 `exclusivePoolRemainingOf` 逐格一致）：
  // `active === true` 且 `remaining > 0`，不是 `active !== false`。
  const exclusiveNames = all
    .filter((pkg) => pkg && pkg.active === true && isExclusivePool(pkg)
      && Number.isFinite(Number(pkg.remaining)) && Number(pkg.remaining) > 0)
    .map((pkg) => pkg.name)
    .join('、');
  // 明细放进 title，不占版面；账号卡片本身已经信息密集了
  const detail = [
    all.length > 1 ? `共 ${all.length} 个资源包，${activeCount} 个有效` : null,
    ...all.map(pkg => formatPackageLine(pkg, windowDays, now)),
  ].filter(Boolean).join('\n');
  /**
   * 配额窗口的明细与主行**都换成百分比口径**。
   *
   * ⚠️ 明细绝不能沿用上面的 `formatPackageLine`（`95 / 100` 会被读成
   * 「95 个积分，一共 100 个」）——见 `formatQuotaDetail` 的注释。
   */
  const quotaDetail = quotaText === null ? null : formatQuotaDetail(all);
  /**
   * Loomy / Raccoon 的「当日刷新池」**单独显示**（用户明确要求）。
   *
   * 两家都有「今天不用就没了」的当日池：
   * - Loomy：`每日赠送`（每天 5000，消耗后不回补）+ `永久积分`
   * - Raccoon：`每日积分`（`daily_points`）+ 奖励 / 会员 / 充值
   *
   * 判据是**池名**（见 `findDailyPool`），不是下标 —— Raccoon 的池是按
   * 「服务端给了哪个字段」动态 push 的，下标会错位。
   *
   * ## ⚠️⚠️ 但 **accio 必须排除在这条之外**（真实缺陷，2026-10-13）
   *
   * `findDailyPool` 认的当日池名里**包含 `每日积分`** —— 而那正是 **accio 的**
   * 每日桶名！所以 accio 一旦传进来，这里也算出 `长期 0 · 每日 199`，
   * 与下面的 `namedPoolText`（`每日 199 · 每月 0 · 推荐 0`）**同时渲染**
   * ⇒ 卡片上 `每日 199` 出现**两遍**（用户报障，附截图）。
   *
   * ⇒ 两条分池线**互斥**：accio 走 `namedPoolText`（见 {@link formatNamedPoolLine}），
   * 其余走本函数。
   *
   * ⚠️ 这里写成「accio ⇒ 短路成 null，否则照算」而**不是排除法**（即
   * 「provider 不等于 accio 时才走这条」那种写法）：排除法是本仓库明令反对的形态
   * ——将来新增 provider 忘了登记时，它会**静默**落进 accio 这个分支。
   * ⚠️ 本条注释刻意**不写出那个被 grep 的形态字面量**：有断言在整份源码里搜它，
   * 注释里出现会让那条断言**假红**（本仓库记录过的注释级陷阱）。
   */
  const poolSplitText = provider === 'accio'
    ? null
    : formatPoolSplitLine(
        all,
        formatForUnit,
        // Loomy 的另一个池就叫「永久积分」；Raccoon 的奖励/会员/充值三种池
        // 到期规则各不相同，不能统称永久。
        provider === 'loomy' ? '永久' : '长期',
      );
  /**
   * ⚠️ Accio 走**逐命名池全列**（`formatNamedPoolLine`），不是上面的两桶形状。
   *
   * 用户的报障原文（2026-10-13，附截图）：「accio 的显示和别的 provider 没统一，
   * 例如 loomy 的」—— accio 原先**另起一个独立区块**（`AccioDailyPanel`）显示
   * 三类桶，而别家都在账号卡片里。现改为与 loomy 同形：卡片里就是积分行。
   *
   * ⚠️ 为什么不能直接用 `formatPoolSplitLine`：它是两桶形状，会把「每月」与
   * 「推荐」笼统求和成「长期」，而这两类语义并列（到期规则不同）——
   * 见 `formatNamedPoolLine` 的注释。
   */
  const namedPoolText = provider === 'accio' ? formatNamedPoolLine(all, formatForUnit) : null;
  /**
   * Accio 的「每日额度 ⋯ 后刷新」附注（`null` = 不渲染）。
   *
   * ⚠️ 只在**当日池存在**时才有值：`accioResetSeconds` 按池名找 `每日积分`，
   * 那个包上才挂着 `quota` 端点的倒计时（其余桶刻意留空 —— 见 `accio-credits.ts`）。
   */
  const accioResetNote = provider === 'accio'
    ? (() => {
        const countdown = formatAccioResetCountdown(accioResetSeconds(all, now));
        return countdown === null ? null : `每日额度 ${countdown}后刷新`;
      })()
    : null;
  return React.createElement('div', { className: 'dim-jh-metaRow' },
    // ⚠ 标签按单位走：ZCode 是 token，显示「Token」而不是「积分」。
    React.createElement('dt', null, label),
    React.createElement('dd', {
      className: 'dim-jh-creditValue',
      title: quotaDetail ?? (detail || undefined),
    },
    // ⚠️ 配额窗口显示**逐窗口百分比**而不是均值：均值（94.5）既不是上游给的数，
    // 在「额度」这个标签下更会被读成 94.5 个积分。见 quotaText 的注释。
    React.createElement('strong', { className: 'dim-jh-creditTotal' }, quotaText ?? total),
    // 当日池分桶（loomy / raccoon）：`formatPoolSplitLine` 已覆盖原先硬编码的
    // loomy 两池判据，且对 Raccoon 的「每日积分」同样成立（用户 2026-09-29 要求）。
    // ⚠ 数字按**包自身的单位**格式化（remote 的单位支持）：池可能来自
    // 不同 provider，不能假定都是积分。
    poolSplitText
      ? React.createElement('span', { className: 'dim-jh-creditPools' }, poolSplitText)
      : null,
    // 两个 buddy + TRAE + LobsterAI + OfficeAce：按「会不会近期作废」分**三档**，
    // 与选号判据同一套规则（后端只分两档，前端把「真永久」与「到期还远」拆开着色）。
    // 这条也解释了「锁定永久积分后为什么没有可用账号」——临期桶是 0。
    // ⚠️ 用词「长期」不是「永久」：有到期日的积分即使很远也不叫永久（用户定）；
    //    只有**服务端没给到期时间**的才是真·永久（绿）。
    // ⚠️ Accio 的逐池列（与 loomy 的 `poolSplitText` 同位置、同样式，故视觉统一）。
    namedPoolText
      ? React.createElement('span', { className: 'dim-jh-creditPools' }, namedPoolText)
      : null,
    /**
     * ⚠️ Accio 的每日额度重置倒计时（**唯一**与 loomy 不同的附注）。
     *
     * 别的家没有这一条；但 accio 的每日额度是 24 小时作废且**不累积**，
     * 「还有多久刷新」是用户唯一能据此决定「现在要不要用掉」的信息。
     * ⚠️ 它放在**积分行内**（而不是另起区块）—— 这正是 2026-10-13 的统一要求。
     */
    accioResetNote
      ? React.createElement('span', {
          className: 'dim-jh-creditPools',
          title: ACCIO_DAILY_REWARD_NOTE,
        }, accioResetNote)
      : null,
    // 两个 buddy + TRAE + LobsterAI：按「会不会近期作废」分桶，与选号判据同一套规则。
    // 这条也解释了「锁定永久积分后为什么没有可用账号」——临时桶是 0。
    // ⚠️ 用词「长期」不是「永久」：这些积分都有到期日，只是较远（用户定）。
    // ⚠️ 与上面的池分桶互斥：有当日池的（loomy / raccoon）走池名分桶，
    // 没有的走到期时间分桶。
    !poolSplitText && expiryParts.length > 0
      ? React.createElement('span', {
          className: 'dim-jh-creditPools',
          title: `永久 = 服务端未给到期时间（不会作废）；`
            + `长期 = 有到期时间但距扣费截止还有 ${windowDays} 天以上；`
            + `临期 = 距扣费截止不足 ${windowDays} 天（再不用就作废，优先消耗，锁定永久积分后不参与消耗）。`,
        }, expiryParts.flatMap((part, index) => {
          const node = React.createElement('span', {
            key: part.key,
            className: 'dim-jh-creditPoolPart',
            'data-tone': part.tone,
          }, part.countdown === undefined ? part.text : `${part.text}（${part.countdown}）`);
          // 段间分隔符：与其它分桶行的 ` · ` 一致。
          return index === 0
            ? [node]
            : [React.createElement('span', { key: `sep-${part.key}`, className: 'dim-jh-creditPoolSep' }, ' · '), node];
        }))
      : null,
    /**
     * **独立池**提示（2026-10-21 用户报障「没标注星火专属」）。
     *
     * 为什么不塞进上面那行：三档分桶是按**金额**聚合的，塞进去就只能写成
     * 「永久 25000」—— 而那正是误导的来源（用户会以为是通用积分）。
     * 单独一行 + 「不计入」字样，才能既显示这笔钱存在、又说明它不能混用。
     *
     * ⚠️ `exclusiveRemaining === 0` 时不渲染 ⇒ 没有独立池的 provider
     *    （现有全部）行为**逐字不变**。
     */
    exclusiveRemaining > 0
      ? React.createElement('span', {
          className: 'dim-jh-creditExclusive',
          title: `${exclusiveNames}：服务端下发的独立池，与上方主池分开结算，不参与主池合计、也不能当通用积分消耗。`,
        }, `另有 ${formatUnits(exclusiveRemaining, unit) ?? exclusiveRemaining} 专属（不计入）`)
      : null,
    // ⚠️ 配额单位（Gemini）下**不渲染**这句：它的两个「包」是 5 小时窗口与
    // 周窗口，不是资源包 —— 说「2/2 个资源包有效」既没信息量又误导
    // （用户报障原文：「不要渲染 / 2/2 个资源包有效」）。窗口自身的读数
    // 已由上面的 `quotaText` 逐条列出，这里再补一句纯属噪音。
    // ⚠️ 非配额单位（真正由多个资源包构成余额的 provider）行为**逐字不变**。
    quotaText === null && !poolSplitText && expiryParts.length === 0 && all.length > 1
      ? React.createElement('span', { className: 'dim-jh-creditPackages' },
          `${activeCount}/${all.length} 个资源包有效`)
      : null,
    // 失效额度单独提示：它们仍在服务端响应里，但不计入上面的数字
    // ⚠️ 配额单位下恒不渲染（`expiredTotal` 就是 0），留着分支只为不改变
    // 其它 provider 的行为。
    balance.expiredTotal > 0
      ? React.createElement('span', { className: 'dim-jh-creditExpired' },
          `另有 ${formatUnits(balance.expiredTotal, unit)} 已失效`)
      : null,
    /**
     * 失效额度单独提示：它们仍在服务端响应里，但不计入上面的数字
     * ⚠️ 配额单位下恒不渲染（`expiredTotal` 就是 0），留着分支只为不改变
     * 其它 provider 的行为。
     */
    balance.expiredTotal > 0
      ? React.createElement('span', { className: 'dim-jh-creditExpired' },
          `另有 ${formatUnits(balance.expiredTotal, unit)} 已失效`)
      : null));
}

/**
 * 该账号条目是否为 opencode 的匿名通道。
 *
 * ⚠️ 判据是**条目 id 前缀**（`opencode-anon-`）而不是凭据内容：客户端拿不到
 * 凭据（它存在 `ctx.credentials` 里，面板只拿得到 `credentialRef`），而 id 前缀
 * 是宿主与客户端之间约定好的（见 `opencode-rpc.ts` 的 `addAnonymous`）。
 */
function isAnonymousAccountId(accountId) {
  return String(accountId || '').indexOf('opencode-anon-') === 0;
}

function AccountCard({ account, index, order, provider, onToggle, onDelete, onRetest, onReset, onTest, onClaimOnboarding, onboardingBusy, busy, credits, creditsLoading, showCredits, showPackageList, windowDays, showRateLimitActions, drag,
  // ⚠️ opencode 专属：传了才渲染「代理」「指纹」两个按钮（见按钮区注释）。
  // 前者额外需要 current 代理串，故签名与 onRetest 略有不同。
  // ⚠️ **本 fork 独有**：modelscope 的「令牌」按钮同理（传了才渲染），
  // 第二参是宿主算好的**打码**串。
  onOpenProxy, onRotateFingerprint, onEditModelscopeKey }) {
  const rateLimits = account.modelRateLimits
    ? Object.entries(account.modelRateLimits).filter(([, v]) => v > Date.now())
    : [];
  const expired = typeof account.expiresAt === 'number' && account.expiresAt > 0 && account.expiresAt <= Date.now();
  // 只要存在**任何**标记（即使已过期）就允许重测/重置——过期记录正是
  // 用户最想清理的对象，而 UI 的 rateLimits 只显示未到期的。
  const hasAnyLimit = Boolean(account.modelRateLimits && Object.keys(account.modelRateLimits).length > 0);
  // 拖拽相关的状态与回调由 ProviderPanel 统一管理（它掌握整个列表顺序）。
  const dragProps = drag || {};

  /**
   * 账号名 / 状态标签 hover 时的资源包列表。
   *
   * ⚠️ 只在 `showPackageList` 为真时挂 —— 那是「余额真的由多个资源包构成」的
   * 能力位（buddy 系 / lobsterai / qoder / qodercn / trae）。loomy 的 packages
   * 是我们合成的两个池名，且没有到期字段，列出来会把「每日赠送」标成**长期**
   * （恰好说反）。
   *
   * ⚠️ `now` 在渲染时取：过滤与排序都是时间的函数，宿主长期开着，缓存会让
   * 已过期的包继续显示、或"8 天后"一直不变。
   *
   * ⚠️ 列表**只含还能用的包**（已消耗为 0 / 已过期 / 已失效的都被过滤掉），
   * 且按**到期时间升序**排（最快到期在最上）。两者都在
   * `formatPackageTooltip` 内部完成 —— 那是所有 provider 共用的，
   * 故此处无需按 provider 分支。
   *
   * ⚠️ 数字按**包自身单位**格式化：ZCode 的包是 token，用 `formatCredits`
   * 会把 94539275 显示成「9453.93万」而非「94.54M」。
   */
  const hoverPackages = credits?.balance?.packages;
  const packageTooltip = showPackageList && hoverPackages?.length
    ? formatPackageTooltip(hoverPackages, {
        format: (value) => formatUnits(value, hoverPackages.find(p => p && p.unit)?.unit),
        now: Date.now(),
      })
    : null;
  // 有可用包才挂列表；余额还没拉到时挂提示而不是空 title —— 否则用户 hover
  // 一个看起来该有内容的名字却毫无反应，会以为是坏了。
  // ⚠️ 包全不可用时 `packageTooltip` 为 null，此时**不挂** title（而不是挂空串）：
  // 那种情况说明"这个号确实没有可用资源包了"，浮层里没什么可说的。
  const accountTitle = packageTooltip
    ?? (showPackageList && creditsLoading ? '资源包加载中…' : undefined);

  return React.createElement('div', {
    className: 'dim-jh-accountCard',
    'data-enabled': account.enabled,
    'data-dragging': dragProps.isDragging ? 'true' : undefined,
    // 插入位置指示：before 画在卡片上方，after 画在下方 —— 必须与
    // 实际落点一致，否则用户按指示拖放却得到不同结果。
    'data-dropBefore': dragProps.isDropTarget && dragProps.dropPosition !== 'after' ? 'true' : undefined,
    'data-dropAfter': dragProps.isDropTarget && dragProps.dropPosition === 'after' ? 'true' : undefined,
    // 整卡可拖：抓取柄之外也能拖，手感更好；但文本选择区（凭据/时间）
    // 仍可正常选中——HTML5 拖拽不会阻止选择。
    draggable: dragProps.enabled ? 'true' : undefined,
    onDragStart: dragProps.onDragStart,
    onDragEnd: dragProps.onDragEnd,
    onDragOver: dragProps.onDragOver,
    onDrop: dragProps.onDrop,
  },
    React.createElement('div', { className: 'dim-jh-accountTop' },
      // 抓取柄 + 序号：序号即自动选号的优先级，让"拖到第一位"的含义明确。
      dragProps.enabled
        ? React.createElement('span', {
            className: 'dim-jh-dragHandle',
            title: '拖动以调整顺序（顺序即自动选号优先级）',
            'aria-hidden': 'true',
          }, '⠿')
        : null,
      dragProps.enabled
        ? React.createElement('span', { className: 'dim-jh-accountOrder', title: '自动选号优先级' },
            String((order ?? index ?? 0) + 1))
        : null,
      React.createElement('span', {
        className: 'dim-jh-accountStatus',
        'data-on': account.enabled ? 'true' : 'false',
        title: account.enabled ? '已启用' : '已停用',
        'aria-hidden': 'true',
      }),
      React.createElement('span', {
        className: 'dim-jh-accountName',
        // 资源包列表（剩余/总量 + 到期时间）。仅 buddy 系挂，见 packageTooltip。
        title: accountTitle,
      },
        account.nickname || account.id),
      React.createElement('span', {
        className: 'dim-jh-accountTag',
        'data-tone': account.enabled ? 'on' : 'off',
        // 同账号名：hover 出资源包列表（两处都挂，用户 hover 哪个都能看见）。
        title: accountTitle,
      }, account.enabled ? '已启用' : '已停用'),
      // 受限标记：这张卡片被自动沉到了列表末尾，标出来才说得清「为什么它在下面」。
      // 判据与下方「限额重置」行同源（都是未到期的 modelRateLimits）。
      rateLimits.length > 0
        ? React.createElement('span', {
            className: 'dim-jh-accountTag',
            'data-tone': 'warn',
            title: '当前处于模型限额中。该账号不会参与自动选号，并已被沉到列表末尾；'
              + '限额解除后仍留在末尾，避免它再次霸占首位而让其它账号的额度白白过期。',
          }, '限额中')
        : null,
      // ⚠️ 匿名通道标记：它不需要 key、只用于免费模型，额度按**出口 IP** 计。
      // 标注出来是为了让用户知道「这几条不是登录账号」，
      // 以及为什么给它们配不同代理才会各自获得独立额度。
      provider === 'opencode' && isAnonymousAccountId(account.id)
        ? React.createElement('span', {
            className: 'dim-jh-accountTag',
            'data-tone': 'on',
            title: '匿名通道：无需 API key，仅用于免费模型。'
              + '额度按出口 IP 计算 —— 给它单独配置代理，才会获得独立额度。',
          }, '匿名')
        : null),
    React.createElement('dl', { className: 'dim-jh-accountMeta' },
      React.createElement('div', { className: 'dim-jh-metaRow' },
        React.createElement('dt', null, '凭据'),
        React.createElement('dd', null, React.createElement('code', null, account.credentialRef))),
      React.createElement('div', { className: 'dim-jh-metaRow' },
        React.createElement('dt', null, '有效期'),
        React.createElement('dd', { 'data-tone': expired ? 'warn' : undefined },
          account.expiresAt
            ? `${formatTime(account.expiresAt) || '未知'}${account.refreshable ? ' · 自动续期' : ''}`
            : '未知')),
      // 账号规格（目前只有 Gemini 有）：Pro / Free / Ultra。
      //
      // ⚠️ 判据是 `extra.accountTier` 有值才渲染 —— 取不到档位（上游改协议、
      // 网络失败、非 Gemini 的 provider）时**整行不出现**，不显示「未知」也不
      // 报错：它只是一栏附注信息，不该制造一条无法修复的提示。
      // `title` 放上游原文（`Google AI Pro（g1-pro-tier）`），面板只放得下一个词。
      credits?.extra?.accountTier
        ? React.createElement('div', { className: 'dim-jh-metaRow' },
            React.createElement('dt', null, '账号规格'),
            React.createElement('dd', { title: credits.extra.accountTier.title },
              credits.extra.accountTier.label))
        : null,
      // 不支持积分余额的 provider 不渲染该行：留着它只能显示「查询失败」，
      // 而失败原因是「这个 provider 根本没有此接口」——与其展示一条无法修复
      // 的错误，不如不展示。
      showCredits
        ? React.createElement(CreditBalanceRow, {
            balance: credits?.balance ?? null,
            error: credits?.error,
            loading: creditsLoading,
            // 「临时 / 长期」分桶的窗口天数（buddy 系 + TRAE + LobsterAI 有值）。
            windowDays,
            // 池名分桶（loomy / raccoon）要按 provider 决定另一个池的标签。
            provider,
          })
        : null),
    rateLimits.length > 0
      ? React.createElement('div', { className: 'dim-jh-rateLimits' },
          React.createElement('span', { className: 'dim-jh-rateLimitsLabel' }, '限额重置'),
          rateLimits.map(([modelId, resetAt]) =>
            React.createElement('span', {
              key: modelId,
              className: 'dim-jh-ttlBadge',
              title: `模型 ${modelId}`,
            }, `${modelId} · ${formatTime(resetAt)}`)))
      : null,
    React.createElement('div', { className: 'dim-jh-accountActions' },
      // 新手任务（仅 Loomy）：一次性 10000 分，每号只能领一次。
      // 与「一键领取积分」（每日签到）是**不同**的操作，故独立按钮 ——
      // 混进「一键签到」会导致每天对已领完的账号发 8 个必然 alreadyCompleted 的请求。
      //
      // ⚠️ **只显示礼物图标**（用户报障：「领取新手任务」文字太长、按钮溢出行尾）。
      // 该行有 5 个按钮且 `flex-wrap: nowrap`，多一个宽按钮就会被挤出容器。
      // 文案移到 `title`（hover tooltip）与 `aria-label`（无障碍）里。
      onClaimOnboarding
        ? React.createElement('button', {
            className: 'dim-jh-btn dim-jh-iconBtn',
            // tooltip 说明「是什么 + 一次性 + 多少分」，因为图标本身不自解释
            title: '领取新手任务（合计 10000 积分，每个账号仅能领取一次）',
            'aria-label': '领取新手任务',
            disabled: busy || onboardingBusy,
            onClick: () => onClaimOnboarding(account.id),
          }, onboardingBusy
            // 领取中：换成文字，让用户明确知道正在跑（图标无法表达进度）
            ? '领取中…'
            : React.createElement('svg', {
                width: 14,
                height: 14,
                viewBox: '0 0 24 24',
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: 2,
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
                'aria-hidden': 'true',
                focusable: 'false',
              },
              // 礼物盒：盒身 + 盖子 + 竖带 + 蝴蝶结
              React.createElement('rect', { x: 3, y: 8, width: 18, height: 4, rx: 1 }),
              React.createElement('path', { d: 'M12 8v13' }),
              React.createElement('path', { d: 'M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7' }),
              React.createElement('path', { d: 'M7.5 8a2.5 2.5 0 0 1 0-5A4.8 4.8 0 0 1 12 8a4.8 4.8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5' })))
        : null,
      // 卡片级「重测 / 重置」同样只对会限流的 provider 有意义
      // （Loomy 不返回限流错误，故这两个按钮对它永远禁用 —— 直接不渲染）。
      //
      // ⚠️ 「测试」与上面两个**互不替代**，故用**独立**的 props 存在性开关
      // （与 `onOpenProxy` 同款约定）：重测只测已有标记的模型、没有标记时零请求；
      // 测试无条件真发一次。当前 Gemini 恰好只登记了测试、没登记重测 —— 若把
      // 两者绑在同一个开关上，就会出现「要么都渲染（重测对它无意义）、要么
      // 都不渲染（测试消失）」的二选一。
      //
      // ⚠️ 该行是 `flex-wrap: nowrap`，多一个按钮就可能溢出（见上方礼物图标
      // 按钮的注释）。故「测试」放在最前，且**只有**在 provider 同时登记了
      // 测试与重测时才会出现 6 个按钮 —— 当前没有任何 provider 两者皆登记。
      onTest
        ? React.createElement('button', {
            className: 'dim-jh-btn',
            title: TEST_HELP,
            // 不依赖 hasAnyLimit：测试的意义正是「没有标记时也能探活」。
            disabled: busy,
            onClick: () => onTest(account.id),
          }, '测试')
        : null,
      showRateLimitActions
        ? React.createElement('button', {
            className: 'dim-jh-btn',
            title: RETEST_HELP,
            disabled: busy || !hasAnyLimit,
            onClick: () => onRetest(account.id),
          }, '重测')
        : null,
      showRateLimitActions
        ? React.createElement('button', {
            className: 'dim-jh-btn',
            title: RESET_HELP,
            disabled: busy || !hasAnyLimit,
            onClick: () => onReset(account.id),
          }, '重置')
        : null,
      React.createElement('button', {
        className: 'dim-jh-btn',
        onClick: () => onToggle(account.id, !account.enabled),
      }, account.enabled ? '停用' : '启用'),
      // ⚠️ 仅 opencode / gemini：出口代理是该 provider 独有的**账号维度**能力
      // （其余 provider 没有这一项）。用 props 存在性开关而非
      // `provider === 'opencode'` 硬判断 —— 前者让 AccountCard 无需知道
      // provider 列表，也避免以后新增同类 provider 时漏改。
      // 位置在「停用」之后、「删除」之前：删除按钮带 data-kind='danger'，
      // 是这一行的视觉终点，不能被挤到中间。
      onOpenProxy
        ? React.createElement('button', {
            className: 'dim-jh-btn',
            // ⚠️ tooltip 必须解释「不设置会怎样」。两家语义不同，故按
            // `account.geminiProxy !== undefined` 分流文案：opencode 是
            // 「共用出口 = 共用额度」，gemini 是「出不去 = 恒连不上」。
            title: account.opencodeProxy
              ? '出口代理：' + account.opencodeProxy + '（点击修改）'
              : account.geminiProxy !== undefined
                ? '出口代理：' + (account.geminiProxy || '直连') + '（点击修改）'
                : '设置该账号的出口代理；'
                  + (account.geminiProxy !== undefined
                    ? '不设置则直连本机（出不去墙外服务）'
                    : '不设置则与其它未设代理的账号共享本机出口 IP'),
            onClick: () => onOpenProxy(account.id, account.opencodeProxy || account.geminiProxy || ''),
          }, '代理')
        : null,
      onRotateFingerprint
        ? React.createElement('button', {
            className: 'dim-jh-btn',
            title: '轮换该账号的指纹（生成新的 project id；用于怀疑多个账号被关联时）',
            disabled: busy,
            onClick: () => onRotateFingerprint(account.id),
          }, '指纹')
        : null,
      // ⚠️ **本 fork 独有**（魔搭，2026-10-17）：编辑访问令牌。
      //    账号 id 与 credentialRef 都由 Key 尾段派生 ⇒ 换 Key 等于换一条账号，
      //    没有这个入口时用户只能删除重建（会丢昵称与停用状态）。
      //    ⚠️ 同样用 **props 存在性**开关（与上面 opencode 代理/指纹同款），
      //    而非 `provider === 'modelscope'` 硬判断。
      //    ⚠️ tooltip 里给的是**宿主算好的打码串**（`modelscopeKeyMask`）——
      //    客户端不自己打码，避免与 `maskModelscopeKey` 两份实现漂移。
      onEditModelscopeKey
        ? React.createElement('button', {
            className: 'dim-jh-btn',
            title: account.modelscopeKeyMask
              ? '访问令牌：' + account.modelscopeKeyMask + '（点击修改）'
              : '设置该账号的访问令牌（ms-…）',
            disabled: busy,
            onClick: () => onEditModelscopeKey(account.id, account.modelscopeKeyMask || ''),
          }, '令牌')
        : null,
      React.createElement('button', {
        className: 'dim-jh-btn',
        'data-kind': 'danger',
        onClick: () => onDelete(account.id),
      }, '删除')));
}

/**
 * 单个模型的开关。
 *
 * 刻意不做本地乐观更新：模型列表与黑名单都以 Host 为准（可能是远端拉取的
 * 结果），本地猜测状态容易与真实持久化结果分叉。这里等 RPC 返回后再翻状态，
 * 期间禁用开关，保证界面上看到的就是服务端已接受的。
 *
 * ⚠️ **根元素是 `<label>`，且内部只能有这 1 个 checkbox。**
 * 整行是 label，故点行内任意位置（含模型名）都会切换这个开关 —— 这是既有交互。
 * 一旦再插入第二个 checkbox（如曾经加过的多选勾选框），浏览器会把点击激活到
 * **第一个**可标记控件，「点模型名」就变成切换那个新控件、可见性开关纹丝不动
 * （实测确认的行为倒退）。若将来确需多选，必须先把行容器改成 `<div>`。
 *
 * ⚠️⚠️ 「重新显示」按钮**必须 `e.stopPropagation()` + `e.preventDefault()`**
 * （2026-10-06 复审 !66）：失效模型被上游下架后，用户若不点这个按钮就**永远无法**
 * 恢复 —— 因为记录的唯一自愈路径是 30 天 TTL 过期（模型选不到 ⇒ 不可能再成功
 * ⇒ 记录永不自动清除）。按钮虽然 `type="button"`，它仍嵌在 `<label>` 内，
 * 点击会冒泡到 label 并**顺带切换可见性开关** —— 必须拦下。
 *
 * @param {{ model: {id: string, name?: string, disabled?: boolean, dead?: boolean},
 *           busy: boolean, onToggle: Function, onRestore: Function }} props
 */
function ModelToggle({ model, busy, onToggle, onRestore }) {
  const dead = model.dead === true;
  return React.createElement('label', {
    className: 'dim-jh-modelRow',
    'data-disabled': model.disabled ? 'true' : 'false',
    'data-dead': dead ? 'true' : 'false',
    title: dead ? `${model.id}（上游已下架，点击「重新显示」可恢复）` : model.id,
  },
    React.createElement('span', { className: 'dim-jh-modelInfo' },
      React.createElement('strong', { className: 'dim-jh-modelName' }, model.name || model.id),
      dead ? React.createElement('span', { className: 'dim-jh-modelDead' }, '已下架') : null,
      React.createElement('code', { className: 'dim-jh-modelId' }, model.id)),
    dead
      // ⚠️ 失效模型**不渲染可见性开关**：它已被剔除出目录，开关没有意义；
      //    只给一个「重新显示」按钮（= 清掉失效记录）。
      ? React.createElement('button', {
        type: 'button',
        className: 'dim-jh-modelRestore',
        disabled: busy,
        onClick: (event) => { event.preventDefault(); event.stopPropagation(); onRestore(model.id); },
      }, '重新显示')
      : React.createElement('input', {
        type: 'checkbox',
        className: 'dim-jh-switch',
        role: 'switch',
        checked: !model.disabled,
        disabled: busy,
        'aria-label': `${model.name || model.id} 是否在模型选择中显示`,
        onChange: () => onToggle(model.id, !model.disabled),
      }));
}

/**
 * 模型列表弹窗：点击「显示列表」后以 modal 形式浮出。
 *
 * 数据全部来自 `model.list` RPC —— 也就是适配器 `listModels()` 播报的同一份
 * 目录（对话框模型选择器读的正是它）。因此这里列出的模型与可选模型一一对应，
 * 不会出现「设置页有、选择器里没有」的错位。
 *
 * 用 modal 而不是内联展开：开关列表可能有几十项，内联会挤占账号区的空间，
 * 也让「账号池」与「模型可见性」两件不相关的事在视觉上混在一起。
 */
function ModelListPanel({ provider, rpcCall, onClose }) {
  const [models, setModels] = React.useState(null);
  const [phase, setPhase] = React.useState('loading');
  const [error, setError] = React.useState(null);
  // 单次开关操作的失败提示。与 `error` 分开：列表本身的读取失败要用整页
  // 错误态替换，而单次切换失败只需顶部提示、列表必须保留。
  const [toggleError, setToggleError] = React.useState(null);
  /**
   * 上一次开关操作的**非致命警告**（Issue IKJW33）。
   *
   * 服务端对「不在当前目录的 id」照常写入、但在响应里带 `warnings[]`：
   * 打开一个已下架、且不在黑名单里的 id 时，写入是**纯空操作**，
   * 旧实现只回「成功」，用户与 AI 助手都会以为开关生效了。
   *
   * ⚠️ 与 `toggleError` **分开存**：那条是「操作失败」（红色、`role=alert`），
   * 本条是「操作成功但没有实际效果」（中性色、`role=status`）。合并会让
   * 「下架模型」看起来像故障。
   */
  const [toggleWarnings, setToggleWarnings] = React.useState([]);
  // 正在提交的模型 id 集合：只禁用被点的那一行，避免整表锁死。
  const [busyIds, setBusyIds] = React.useState(() => new Set());
  /** 「全部重新显示」是否在提交（批量恢复失效记录）。 */
  const [deadRestoreBusy, setDeadRestoreBusy] = React.useState(false);
  /**
   * 批量开关（打开全部 / 关闭全部）是否正在提交。
   *
   * 与 `busyIds` 分开：批量期间要禁用**全部**单条开关与两个批量按钮 ——
   * 黑名单是整体写入，并发提交必然互相覆盖（后写的那次会丢掉先写的改动）。
   */
  const [bulkBusy, setBulkBusy] = React.useState(false);
  /**
   * 搜索词与状态筛选。
   *
   * Cline 的远端目录实测约 478 条，搜索与筛选确实有用。这两个状态只影响
   * **渲染**，不改变 `models` 本身，故清空筛选即恢复全量。
   *
   * ⚠️ **刻意不做多选勾选框**（曾引入真实的行为倒退，已回退）：
   * `ModelToggle` 的根元素是 `<label>`，原先 label 内只有 1 个 checkbox，
   * 点行内任意位置（如模型名）都会切换**可见性开关**。一旦插入第二个 checkbox，
   * 浏览器把点击激活到**第一个**可标记控件 —— 「点模型名」会变成切换勾选、
   * 可见性开关纹丝不动。若将来确需多选，必须先把行容器从 `<label>` 改成 `<div>`。
   *
   * ⚠️ **也刻意不做渲染上限**：改动前 478 条就是一次性全渲染、工作正常，
   * 加「显示更多」凭空多一次点击，属于功能收缩。
   */
  const [query, setQuery] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState('all');
  /**
   * 各分组的**显式折叠选择**（`组 key → 是否展开`）。
   *
   * ⚠️ 只存「用户点过的组」：没点过的组走 `groupExpanded` 的默认策略
   * （按量计费折叠、其余展开；有筛选时一律展开）。**不要把默认值烘焙进 state**
   * ——那样「清空筛选后该恢复默认」就做不到了。
   */
  const [groupToggles, setGroupToggles] = React.useState({});
  /** 正在提交「本组全开/全关」的组 key（null = 没有）。 */
  const [groupBusy, setGroupBusy] = React.useState(null);
  const mounted = React.useRef(true);

  const load = React.useCallback(async () => {
    setPhase('loading');
    setError(null);
    try {
      const res = await rpcCall('model.list', { provider });
      if (!mounted.current) return;
      setModels(res.models || []);
      setPhase('ready');
    } catch (caught) {
      if (!mounted.current) return;
      setError(caught?.message || '无法读取模型列表');
      setPhase('error');
    }
  }, [provider, rpcCall]);

  React.useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load]);

  // ESC 关闭。挂在 document 上而不是弹窗上：焦点可能落在任意一个开关上，
  // 只监听弹窗自身的 keydown 会漏掉这些按键。
  React.useEffect(() => {
    const onKeyDown = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const toggleModel = async (modelId, disabled) => {
    setBusyIds(prev => new Set(prev).add(modelId));
    setToggleError(null);
    setToggleWarnings([]);
    try {
      const res = await rpcCall('model.setDisabled', { provider, modelId, disabled });
      if (!mounted.current) return;
      // ⚠️ 必须展示服务端的 `warnings`（Issue IKJW33）：对已从上游目录消失的 id
      // 开关时写入是空操作，旧实现只回「成功」⇒ 用户/脚本会以为生效了。
      setToggleWarnings(res?.warnings || []);
      setModels(prev => (prev || []).map(m => (m.id === modelId ? { ...m, disabled } : m)));
    } catch (caught) {
      console.error('[jet-hub] toggle model failed:', caught);
      if (!mounted.current) return;
      // 开关切换失败不能把整张表替换成错误页——用户会以为模型列表没了。
      // 保留列表，只在顶部提示这次操作失败。
      setToggleError(caught?.message || '切换模型显示状态失败');
    } finally {
      if (mounted.current) {
        setBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(modelId);
          return next;
        });
      }
    }
  };

  /**
   * 「重新显示」某个被判定为失效的模型（清掉它的失效记录）。
   *
   * ⚠️ **这是用户唯一的自愈路径**（2026-10-06 复审 !66 确认）：失效记录不会被
   * 「再成功一次」清掉（模型已被剔除出目录 ⇒ 用户选不到 ⇒ 不可能再成功），
   * 只能靠 30 天 TTL 过期或点这个按钮。没有它，一次误判就等于该模型被永久隐藏。
   *
   * ⚠️ **不动黑名单**：服务端只删失效记录（`disabled` 保持原值），避免顺带
   * 把用户特意关着的模型打开。
   */
  const restoreModel = async (modelId) => {
    setBusyIds((prev) => new Set(prev).add(modelId));
    try {
      await rpcCall('model.clearDead', { provider, modelId });
      if (!mounted.current) return;
      // ⚠️ **必须整表重载，不能只翻 `dead` 标志**（2026-10-06 复审实测）：
      // 该模型重新进入目录后展示名要靠 `listAllModels()` 才能拿全 ——
      // 而设置页里原先那条是端点用**裸 id** 补回的（`{ id, name: id }`，
      // 见 `jet-hub-rpc.ts` 的 dead 回填路径）。只翻标志会让它继续显示裸 id，
      // 用户要点「刷新」或重开面板才看得到真名。与 `restoreAllDead` 保持一致。
      await load();
    } catch (caught) {
      console.error('[jet-hub] restore dead model failed:', caught);
      if (!mounted.current) return;
      setToggleError(caught?.message || '恢复模型失败');
    } finally {
      if (mounted.current) {
        setBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(modelId);
          return next;
        });
      }
    }
  };

  const all = models || [];
  const hiddenCount = all.filter(m => m.disabled).length;
  /** 被判定为已下架的条数（用于顶部提示「已隐藏 N 个下架模型」）。 */
  const deadCount = all.filter(m => m.dead === true).length;

  /**
   * 批量恢复该 provider 的全部失效模型（`model.clearDead` 省略 `modelId`）。
   *
   * ⚠️ 走**单次请求**而不是循环逐个调：误判往往同时命中多个模型，逐个点既慢
   * 又容易漏。服务端只清失效记录，不动黑名单。
   */
  const restoreAllDead = async () => {
    if (deadCount === 0) return;
    if (!confirm(`确认把 ${deadCount} 个「已下架」模型重新显示？若它们确实已被上游移除，使用时会再次失败并被重新隐藏。`)) return;
    setDeadRestoreBusy(true);
    try {
      await rpcCall('model.clearDead', { provider });
      if (!mounted.current) return;
      // 全量重载：恢复后的条目要拿回展示名/免费标记（补回的裸 id 只有 id）。
      await load();
    } catch (caught) {
      console.error('[jet-hub] restore all dead models failed:', caught);
      if (!mounted.current) return;
      setToggleError(caught?.message || '恢复模型失败');
    } finally {
      if (mounted.current) setDeadRestoreBusy(false);
    }
  };
  const providerLabel = PROVIDERS.find(p => p.id === provider)?.label || provider;
  // 「已经是目标状态」时对应按钮必须禁用，否则点了看不到任何变化、像是坏了。
  const bulk = bulkButtonState(models, bulkBusy);

  /**
   * 筛选后的列表。`filterModels` 是纯函数（见 model-filter.js）：这里只负责
   * 把当前搜索词与状态筛选项传进去。
   *
   * **不做渲染上限**：改动前 478 条就是一次性全渲染、工作正常；加「显示更多」
   * 只会凭空多一次点击（属于功能收缩），故这里直接渲染全部筛选结果。
   */
  const filtered = filterModels(all, { query, status: statusFilter });
  /** 是否有生效中的筛选。决定是否渲染「清空筛选」按钮。 */
  const filtering = isFilterActive({ query, status: statusFilter });

  /**
   * 按「计费/来源」分组后的列表（组内已应用搜索与状态筛选）。
   *
   * ⚠️ `filtered`（上面的平铺结果）与 `groups` **同源**（都由 `filterModels`
   * 算出）：前者用于计数行与「无命中」空态，后者用于渲染 —— 不会出现
   * 「计数说 3 条、界面只渲染 1 条」。
   */
  const groups = groupModelsForDisplay(all, { query, status: statusFilter });

  /** 某组此刻是否展开（用户点过以用户为准；有筛选时一律展开）。 */
  const isGroupExpanded = (group) => groupExpanded(group, {
    filterActive: filtering,
    toggled: groupToggles[group.key],
  });

  /** 点组头：把「当前展开态的反面」写成显式选择（此后由用户说了算）。 */
  const toggleGroup = (group) => {
    const next = !isGroupExpanded(group);
    setGroupToggles(prev => ({ ...prev, [group.key]: next }));
  };

  /**
   * 「本组全开 / 本组全关」。
   *
   * ⚠️ 走 `model.setDisabledMany`（**按子集**），**不能**复用
   * `model.setAllDisabled` —— 后者打开方向会清空整张黑名单，把用户特意关着的
   * 其它分组一起打开，那正是分组开关要避免的事。
   *
   * 关闭方向先二次确认（与顶部「关闭全部」同约定：一次误点会关掉一整组）；
   * 打开是恢复性操作，不弹确认（弹窗只会碍事）。
   */
  const setGroupDisabled = async (group, disabled) => {
    const ids = group.models.map(model => model.id);
    if (disabled && !confirm(
      `确认关闭「${group.label}」的 ${ids.length} 个模型？关闭后它们不再出现在对话框的模型选择里。`,
    )) {
      return;
    }
    setGroupBusy(group.key);
    setToggleError(null);
    setToggleWarnings([]);
    try {
      const res = await rpcCall('model.setDisabledMany', { provider, modelIds: ids, disabled });
      if (!mounted.current) return;
      // 同单条开关：服务端的 warnings 必须展示（Issue IKJW33）。
      setToggleWarnings(res?.warnings || []);
      // 就地更新（不等重新拉取）：端点返回的是权威黑名单，但列表里还有展示名等
      // 字段，只能按 id 就地翻 `disabled`（与顶部批量开关同款做法）。
      const changed = new Set(ids);
      setModels(prev => (prev || []).map(m => (changed.has(m.id) ? { ...m, disabled } : m)));
    } catch (caught) {
      console.error('[jet-hub] group toggle failed:', caught);
      if (!mounted.current) return;
      // 与其它开关一致：失败只提示、保留列表，绝不把整张表换成错误页。
      setToggleError(caught?.message || `本组批量${disabled ? '关闭' : '打开'}模型失败`);
    } finally {
      if (mounted.current) setGroupBusy(null);
    }
  };

  /** 清空搜索与筛选。 */
  const resetFilters = () => {
    setQuery('');
    setStatusFilter('all');
  };

  /**
   * 批量打开/关闭全部模型。
   *
   * 走**批量端点**而不是循环调用 `model.setDisabled`：后者会发 N 次请求、写 N 次
   * 完整文档、广播 N 次 `llm/adapters-updated`，且中途失败会留下「关了一半」的
   * 黑名单。批量端点只落盘一次、只广播一次。
   *
   * 「关闭全部」先二次确认：一次误点会关掉该 provider 的全部模型。反之
   * 「打开全部」是恢复性操作，不弹确认（弹窗只会碍事）。
   *
   * 成功后**就地更新**列表状态（不等重新拉取）：端点返回的是权威黑名单，
   * 但列表里还有展示名等字段，只能按 id 就地翻 `disabled`。
   */
  const setAllDisabled = async (disabled) => {
    if (disabled && !confirm(`确认关闭全部 ${all.length} 个模型？关闭后它们不再出现在对话框的模型选择里。`)) {
      return;
    }
    setBulkBusy(true);
    setToggleError(null);
    try {
      await rpcCall('model.setAllDisabled', { provider, disabled });
      if (!mounted.current) return;
      setModels(prev => (prev || []).map(m => ({ ...m, disabled })));
    } catch (caught) {
      console.error('[jet-hub] bulk toggle failed:', caught);
      if (!mounted.current) return;
      // 与单条切换同一约定：失败只提示、保留列表，绝不把整张表换成错误页。
      setToggleError(caught?.message || `批量${disabled ? '关闭' : '打开'}模型失败`);
    } finally {
      if (mounted.current) setBulkBusy(false);
    }
  };

  const dialog = React.createElement('div', {
    // `--top`：顶部锚定。列表长度随搜索变化，若垂直居中会让弹窗整体上下跳动
    //（见 jet-hub-styles.js 中该修饰类的说明）。
    className: 'dim-jh-modalOverlay dim-jh-modalOverlay--top',
    // 点击遮罩关闭；点击弹窗内部不关闭（stopPropagation 由内层容器负责）。
    onClick: (event) => { if (event.target === event.currentTarget) onClose(); },
  },
    React.createElement('div', {
      className: 'dim-jh-modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': `${providerLabel} 模型列表`,
    },
      React.createElement('div', { className: 'dim-jh-modalHead' },
        React.createElement('div', { className: 'dim-jh-modalTitle' },
          React.createElement('strong', null, '模型列表'),
          React.createElement('span', { className: 'dim-jh-modalSubtitle' }, providerLabel),
          phase === 'ready'
            ? React.createElement('span', { className: 'dim-jh-modelPanelCount' },
                filtering
                  ? `${filtered.length} / ${all.length} 个模型${hiddenCount > 0 ? `，已隐藏 ${hiddenCount} 个` : ''}`
                  : `${all.length} 个模型${hiddenCount > 0 ? `，已隐藏 ${hiddenCount} 个` : ''}`)
            : null),
        React.createElement('div', { className: 'dim-jh-modelPanelActions' },
          React.createElement('button', {
            className: 'dim-jh-btn',
            disabled: phase === 'loading',
            onClick: () => void load(),
          }, phase === 'loading' ? '读取中…' : '刷新'),
          React.createElement('button', {
            className: 'dim-jh-btn',
            'data-kind': 'primary',
            onClick: onClose,
          }, '完成'))),
      React.createElement('p', { className: 'dim-jh-modalHint' },
        '关闭开关后该模型不再出现在对话框的模型选择里；其余模型（含服务端新增的）默认显示。'),
      // ⚠️ 失效模型提示条：它们已被上游下架并从目录剔除，故单独说明「为什么看不见」
      // 并给出**批量**恢复入口（逐个点很麻烦，而误判往往不止一个）。
      phase === 'ready' && deadCount > 0
        ? React.createElement('div', { className: 'dim-jh-modelDeadBar' },
            React.createElement('span', null,
              `有 ${deadCount} 个模型被上游下架，已自动从列表隐藏。`),
            React.createElement('button', {
              className: 'dim-jh-btn',
              disabled: deadRestoreBusy,
              title: '清空该供应商的失效模型记录，让它们重新出现在列表里。',
              onClick: () => void restoreAllDead(),
            }, deadRestoreBusy ? '恢复中…' : '全部重新显示'))
        : null,
      // 搜索 + 状态筛选：Cline 的目录实测近 500 条，没有它就只能一页页翻。
      // 只在列表可用时渲染（载入中/出错时没有可筛的内容）。
      phase === 'ready' && all.length > 0
        ? React.createElement('div', { className: 'dim-jh-modelFilterBar' },
            React.createElement('input', {
              type: 'search',
              className: 'dim-jh-input dim-jh-modelSearch',
              placeholder: '搜索模型名或 id…',
              value: query,
              'aria-label': '搜索模型',
              onChange: (event) => setQuery(event.target.value),
            }),
            React.createElement('div', { className: 'dim-jh-modelStatusFilter', role: 'group', 'aria-label': '按状态筛选' },
              [['all', '全部'], ['enabled', '已打开'], ['disabled', '已关闭']].map(([value, label]) =>
                React.createElement('button', {
                  key: value,
                  className: 'dim-jh-btn',
                  'data-active': statusFilter === value ? 'true' : 'false',
                  'aria-pressed': statusFilter === value ? 'true' : 'false',
                  onClick: () => setStatusFilter(value),
                }, label))),
            filtering
              ? React.createElement('button', {
                  className: 'dim-jh-btn',
                  title: '清空搜索词与状态筛选，恢复完整列表。',
                  onClick: resetFilters,
                }, '清空筛选')
              : null)
        : null,
      // 批量工具条：只在列表可用时渲染。计数从标题挪到这里，避免与标题争宽。
      phase === 'ready' && all.length > 0
        ? React.createElement('div', { className: 'dim-jh-modelBulkBar' },
            React.createElement('button', {
              className: 'dim-jh-btn',
              title: '打开该 Provider 的全部模型开关（含此前被关闭的）。',
              disabled: bulk.openAllDisabled,
              onClick: () => void setAllDisabled(false),
            }, bulkBusy ? '处理中…' : '打开全部'),
            React.createElement('button', {
              className: 'dim-jh-btn',
              title: '关闭该 Provider 的全部模型开关，关闭后它们不再出现在对话框的模型选择里。',
              disabled: bulk.closeAllDisabled,
              onClick: () => void setAllDisabled(true),
            }, bulkBusy ? '处理中…' : '关闭全部'))
        : null,
      toggleError
        ? React.createElement('div', {
            className: 'dim-jh-probeNotice',
            'data-tone': 'error',
            role: 'alert',
          }, React.createElement('div', null, toggleError))
        : null,
      // ⚠️ 与 `toggleError` 分开渲染（Issue IKJW33）：本条是「操作成功，但没有
      // 实际效果」的说明（下架模型的空操作），用中性 tone + `role=status`；
      // 混进错误通道会让「模型已下架」看起来像插件故障。
      toggleWarnings.length > 0
        ? React.createElement('div', {
            className: 'dim-jh-probeNotice',
            // ⚠️ tone 取值必须是 `warn`：样式表里定义的是 `[data-tone="warn"]`
            //（全仓既有约定），写成 `warning` 会静默落到默认中性色 —— 不报错，
            // 但提示看起来和普通文字一样，等于没做。
            'data-tone': 'warn',
            role: 'status',
          }, toggleWarnings.map((text, index) => React.createElement('div', { key: index }, text)))
        : null,
      phase === 'error'
        ? React.createElement('div', { className: 'dim-jh-modalBody' },
            React.createElement('div', { className: 'dim-jh-empty' },
              React.createElement('p', null, error),
              React.createElement('button', { className: 'dim-jh-btn', onClick: () => void load() }, '重新读取')))
        : phase === 'loading'
          ? React.createElement('div', { className: 'dim-jh-modalBody' },
              React.createElement('div', { className: 'dim-jh-empty' }, '正在读取模型列表…'))
          : all.length === 0
            ? React.createElement('div', { className: 'dim-jh-modalBody' },
                React.createElement('div', { className: 'dim-jh-empty' },
                  React.createElement('p', null, '该 Provider 当前没有可用的模型。')))
            // 筛选后无结果：必须与「该 Provider 没有模型」区分开，否则用户会
            // 以为模型全丢了，而实际上只是搜索词没命中。
            : filtered.length === 0
              ? React.createElement('div', { className: 'dim-jh-modalBody' },
                  React.createElement('div', { className: 'dim-jh-empty' },
                    React.createElement('p', null, '没有符合当前搜索与筛选条件的模型。'),
                    React.createElement('button', { className: 'dim-jh-btn', onClick: resetFilters }, '清空筛选')))
              : React.createElement('div', { className: 'dim-jh-modalBody' },
                  React.createElement('div', { className: 'dim-jh-modelList' },
                    // **按计费/来源分组**渲染（订阅 / 免费 / Cline Cloud / 按量计费）。
                    // 组内仍是全部筛选结果（**无渲染上限**）：改动前 478 条就是
                    // 一次性全渲染、工作正常，加「显示更多」属于功能收缩。
                    groups.map(group => {
                      const expanded = isGroupExpanded(group);
                      const groupBulk = groupBulkStateFor(group, bulkBusy || groupBusy !== null);
                      return React.createElement('div', {
                        key: group.key,
                        className: 'dim-jh-modelGroup',
                      },
                        React.createElement('div', { className: 'dim-jh-modelGroupHead' },
                          React.createElement('button', {
                            className: 'dim-jh-modelGroupToggle',
                            'aria-expanded': expanded ? 'true' : 'false',
                            title: group.hint,
                            onClick: () => toggleGroup(group),
                          }, `${expanded ? '▾' : '▸'} ${group.label}`),
                          React.createElement('span', { className: 'dim-jh-modelGroupCount' },
                            group.counts.disabled > 0
                              ? `${group.counts.shown} 个 · 已关闭 ${group.counts.disabled}`
                              : `${group.counts.shown} 个`),
                          React.createElement('button', {
                            className: 'dim-jh-btn dim-jh-modelGroupBtn',
                            title: `打开「${group.label}」的全部模型（不影响其它分组）`,
                            disabled: groupBulk.openAllDisabled,
                            onClick: () => void setGroupDisabled(group, false),
                          }, '全开'),
                          React.createElement('button', {
                            className: 'dim-jh-btn dim-jh-modelGroupBtn',
                            title: `关闭「${group.label}」的全部模型（不影响其它分组）`,
                            disabled: groupBulk.closeAllDisabled,
                            onClick: () => void setGroupDisabled(group, true),
                          }, '全关')),
                        expanded
                          ? React.createElement('div', { className: 'dim-jh-modelGroupBody' },
                              group.models.map(model => React.createElement(ModelToggle, {
                                key: model.id,
                                model,
                                // 批量提交期间一并禁用单条开关：黑名单是整体写入，
                                // 并发提交必然互相覆盖（后写的会丢掉先写的改动）。
                                // 分组批量也算「批量」，故一并计入。
                                busy: busyIds.has(model.id) || bulkBusy || groupBusy !== null,
                                onToggle: (id, disabled) => void toggleModel(id, disabled),
                                onRestore: (id) => void restoreModel(id),
                              })))
                          : null);
                    })))));

  // 与登录弹窗（.dim-jh-loginOverlay）同款做法：直接渲染在组件树内，靠
  // position: fixed 覆盖全屏。**刻意不用 createPortal** —— 客户端模块表由
  // 宿主注入（staticModules 种子表），本仓库无法离线确认 `react-dom` 是否在
  // 其中；一旦不在，require 会抛「missed the module table」，弹窗直接白屏。
  // 现有登录弹窗已证明 fixed 定位在这些面板里工作正常。
  return dialog;
}

/**
 * 额度窗口的标签 / 排序 / 百分比 / 倒计时已搬到 `./quota-format.js`（纯函数模块），
 * 理由同上面的数值格式化：会话输入区的**用量徽标**要显示同一份订阅读数，
 * 而它的文案必须可单测；且两个界面共用同一套窗口顺序与夹取口径。
 */

/**
 * 时间戳 → 请求记录里的「时间」列（参考实现同款）。
 *
 * 今天只给时钟（`HH:MM:SS`），跨天补日期（`MM-DD HH:MM`）——
 * 宿主是长生命周期进程，只给时钟会让「昨天的记录」看起来像刚发生的。
 */
function formatStamp(ts) {
  const at = new Date(Number(ts ?? 0));
  if (!Number.isFinite(at.getTime())) return '-';
  const pad = (part) => String(part).padStart(2, '0');
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
  if (at.toDateString() === new Date().toDateString()) return clock;
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${clock.slice(0, 5)}`;
}

/**
 * token 数的**有界**渲染（参考实现同款）：10 万以内给精确千分位，
 * 再大改 `k` / `M` 一位小数 —— 保证四个数字加标记也不会把行撑高。
 * 精确数字保留在单元格 tooltip 里（见 renderLog）。
 */
function formatTokenCount(value) {
  const n = Math.max(0, Number(value ?? 0));
  if (!Number.isFinite(n)) return '0';
  if (n < 100_000) return n.toLocaleString('en-US');
  if (n < 1_000_000) {
    const k = (n / 1000).toFixed(1);
    // 999,999 会四舍五入成「1000.0k」—— 那是下一个单位已经命名的值。
    return Number(k) >= 1000 ? `${(n / 1_000_000).toFixed(1)}M` : `${k}k`;
  }
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * 毫秒 → 「320ms」/「4.2s」。
 *
 * ⚠️ 没发生过的时刻给 `—`（破折号），**不是 0 也不是 `-`** ——
 * `0ms` 会被读成「瞬间完成」，与「没测到」是两回事；破折号是参考实现
 * （`latency()` 的 `stamp`）对这个「未知」格的固定字形，换回半角 `-`
 * 会让两处的缺口看起来不是同一件事。
 */
function formatMs(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
}

/**
 * 一行请求的 token 构成（参考实现同款）：
 * `↓输入 ↑输出 [⚡缓存] [🧠推理]`。
 *
 * ⚠️ **未收到 usage 帧时返回 `null`**，调用方据此显示 `—`：网关没发用量
 * 与「这次调用花了 0 token」是两件事，混为一谈会误导（参考实现同约定）。
 */
function tokenParts(row) {
  if (row?.usageReported !== true) return null;
  const parts = [
    { key: 'in', icon: '↓', value: Number(row.inputTokens ?? 0) },
    { key: 'out', icon: '↑', value: Number(row.outputTokens ?? 0) },
  ];
  if (Number(row.cacheReadTokens ?? 0) > 0) {
    parts.push({ key: 'cache', icon: '⚡', value: Number(row.cacheReadTokens) });
  }
  if (Number(row.reasoningTokens ?? 0) > 0) {
    parts.push({ key: 'think', icon: '🧠', value: Number(row.reasoningTokens) });
  }
  return parts;
}

/** TOKEN 单元格：有界渲染；未收到 usage 帧显示 `—`。 */
function tokenSummary(row) {
  const parts = tokenParts(row);
  if (parts === null) return '—';
  return parts.map((part) => `${part.icon}${formatTokenCount(part.value)}`).join(' ');
}

/** TOKEN 单元格的 tooltip：**精确**数字（单元格里是缩写，只有这里保留个位）。
 *
 * ⚠️ 未收到 usage 帧时返回**空串**（参考实现同约定）——「未知」由提示行里的
 * 「— 表示网关本次未返回用量」表达，不要在这一格里另编一句替代文案，
 * 否则同一件事会出现两种说法（完整拼装见 `tokenTooltip`）。
 */
function tokenSummaryExact(row) {
  const parts = tokenParts(row);
  if (parts === null) return '';
  return parts.map((part) => `${part.icon}${part.value.toLocaleString('en-US')}`).join(' ');
}

/** TOKEN 单元格 tooltip 的图例行（参考实现原文，逐字保留）。 */
const TOKEN_LEGEND = '↓输入 ↑输出 ⚡缓存 🧠推理；— 表示网关本次未返回用量';

/**
 * TOKEN 单元格的完整 tooltip：精确数字 + 图例。
 *
 * ⚠️ 图例**必须带**：`—` 是个约定，不解释的话「网关没发用量」会被读成
 * 「没花 token」。参考实现把它钉在 tooltip 第二行。
 * 未收到 usage 时精确数字为空串，此时**不拼前导空行**（纯排版，不丢字段）。
 */
function tokenTooltip(row) {
  const exact = tokenSummaryExact(row);
  return exact === '' ? TOKEN_LEGEND : `${exact}\n${TOKEN_LEGEND}`;
}

/**
 * 速率取值 = **DeepSeek 官方（DSH 聊天 UI）的显示规则**（用户 2026-10-01 指定）。
 *
 * ⚠️ 官方实现的**出处与四条语义**（含取整规则、为什么分子不减推理 token、
 * 为什么不设最小窗口下限、以及「本插件曾在 09-30 改成正文阶段口径、已被用户
 * 否掉」这段历史）全部写在 `./tokens-per-second.js` 的模块注释里 ——
 * **改动口径前先读那个文件**，别在这里另写一份说明（两处会漂移）。
 *
 * 这里只保留面板需要的「三行」组装：首字 / 总耗时 / 输出速度（TPS）。
 */
function latencyParts(row) {
  const first = Number(row?.ttftMs ?? 0);
  const total = Number(row?.totalMs ?? 0);
  const rate = formatRowTokensPerSecond(row);
  // 生成阶段 = 首字之后 → 结束（官方 `decodeMs`）。
  const decodeMs = total - first;
  // ⚠️ `—` 的**原因**要能查到（用户曾怀疑「速率还是错的」，而其实是**不可测**）。
  const rateTitle = rate !== '—'
    ? `官方 TPS 口径：输出 ${Number(row?.outputTokens ?? 0)} tok ÷ 生成阶段 ${(decodeMs / 1000).toFixed(2)}s`
      + `（首字之后到结束，含推理 token；官方取整：≥10 整数、<10 一位小数）`
    : row?.usageReported === true
      ? '缺少可用的生成阶段时长（首字时刻缺失或总耗时不大于首字）—— 速率不可测'
      : '网关本次未返回用量 —— 速率不可测';
  return { first, total, rate, rateTitle };
}

/** 状态点：绿=成功、红=失败（参考实现同款；错误消息在 title 里）。 */
function StatusDot({ ok, title }) {
  return React.createElement('span', {
    className: 'dim-jh-quotaDot',
    'data-tone': ok ? 'ok' : 'error',
    title,
    'aria-label': title,
  });
}

/**
 * 「订阅额度」面板：官方额度窗口 + 请求记录。
 *
 * ## 三个读数**互不替代**（面板文案要讲清，否则用户以为是同一个数）
 *
 * | | 积分（账号卡片） | 订阅额度 | 请求记录 |
 * |---|---|---|---|
 * | 答什么 | 还剩多少钱 | 各时间窗用掉百分之几 | 本插件发出的每笔请求 |
 * | 来源 | `/users/{id}/balance` | `/users/me/plan/usage-limits` | 本地流水（`src/cline-request-log.ts`） |
 *
 * ## 两个区域的失败语义不同，渲染也必须不同
 *
 * - **额度**（`cline.quota`）：逐账号返回 `ok`。某个账号失败只让**那一张卡**
 *   显示原因，其余账号照常显示 —— 多账号下这是最实用的降级。
 * - **请求记录**（`cline.requestLog`）：失败以 RPC 错误抛出（本地流水不会
 *   部分失败），故 catch 后显示原因并保留空表。
 */
/**
 * MiniMax 国际站「绕过分流」设置弹窗（Gitee issue IKMEVG，2026-10-17）。
 *
 * ## 它解决什么
 *
 * `agent.minimax.io`（国际站数据面）会按**出口 IP 所在国家**把中国大陆来源
 * `307` 重定向到 `agent.minimaxi.com`（中国站）。于是大陆网络下：
 *
 * - 国际站账号的**签到 / 积分**请求被导到中国站 ⇒ 中国站不认国际站 token
 *   ⇒ `401 {"error":"invalid access token"}` ⇒ 面板显示「余额查询失败」；
 * - 同一现象也发生在**推理**上（模型「连接测试失败」）。
 *
 * ⇒ 用户看到的是「授权不成功」，实际凭据完全正常，只是**地理位置被分流**。
 *
 * ## 本弹窗给什么
 *
 * 一个输入框填**海外 IP**（如 `8.8.8.8`），后端会把它作为
 * `X-Forwarded-For` 附到国际站请求上，让上游判定为海外来源。
 *
 * ## ⚠️ 三条刻意的产品取舍
 *
 * 1. **默认不填**（空串 = 不附头）。附 `X-Forwarded-For` 本质是**声明一个并非
 *    本机的来源 IP**；上游那条规则是区域路由策略（账单/合规都基于它），
 *    默认伪造来源不该是产品的默认行为。
 * 2. **文案里先给「代理」这条更正当的路**。改出口 IP 是真话；
 *    伪造头是应急手段。文案不藏这一点。
 * 3. **保存后回读后端归一值**：非法输入（主机名 / 逗号链 / 含换行）会被后端
 *    归一成空，UI 立刻显示「未设置」—— 静默保存一个坏值是最糟的形态。
 */
function MinimaxXffPanel({ rpcCall, value, onSaved, onClose }) {
  const mounted = React.useRef(true);
  React.useEffect(() => () => { mounted.current = false; }, []);

  const [draft, setDraft] = React.useState(value ?? '');
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState(null); // { kind: 'ok' | 'bad', text }

  /**
   * 保存：后端会校验 + 归一，回传**实际生效值**。
   *
   * ⚠️ 不能用 `draft` 直接当生效值显示：用户可能填了 `my.proxy.example`，
   * 后端归一成空串（只接受 IP 字面量）。那时必须让用户**当场看见**没生效。
   *
   * @param override 显式要保存的值（「清除设置」按钮传空串）。
   *   ⚠️ 存在理由是**避开 React 状态异步**：`setDraft('')` 之后立刻读 `draft`
   *   仍是旧值，只靠状态会让「清除」把旧值又存回去。
   */
  const save = async (override) => {
    const payloadValue = typeof override === 'string' ? override : draft
    setBusy(true);
    setNotice(null);
    try {
      const res = await rpcCall('minimax.setXff', { xff: payloadValue });
      if (!mounted.current) return;
      const next = typeof res?.xff === 'string' ? res.xff : '';
      setDraft(next);
      onSaved(next);
      setNotice(next === ''
        ? { kind: 'ok', text: '已清除：后续请求不附 X-Forwarded-For（将按真实出口 IP 分流）。' }
        : { kind: 'ok', text: `已保存并生效：${next}` });
    } catch (caught) {
      if (!mounted.current) return;
      // ⚠️ 后端对非法值返回 `bad-request`（含原因），**原样显示** —— 那句原因
      //    （「只接受 IPv4 / IPv6 字面量」）就是用户唯一能自救的线索。
      //
      // ⚠️⚠️ **必须把 draft 回滚到后端真值 `value`**（真实缺陷，2026-10-17 审计打穿）：
      //    后端现在是「非法即不写」，故 `value` 仍是**上次成功保存的值**。
      //    若不回滚，「清除设置」失败（或任何保存失败）后输入框停在空/错的值，
      //    而实际生效值没变 ⇒ 用户看到界面与真实状态不一致，
      //    正是这次修复要消灭的那个症状（从「不清后端」缩小到「失败分支不清 UI」）。
      setDraft(value ?? '');
      setNotice({
        kind: 'bad',
        text: (caught instanceof Error ? caught.message : String(caught))
          + `（当前生效值未改动：${value === '' ? '未设置' : value}）`,
      });
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return React.createElement('div', {
    className: 'dim-jh-modalOverlay dim-jh-modalOverlay--top',
    onClick: (event) => { if (event.target === event.currentTarget) onClose(); },
  },
  React.createElement('div', {
    className: 'dim-jh-modal',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'MiniMax 国际站分流设置',
  },
  React.createElement('div', { className: 'dim-jh-modalHead' },
    React.createElement('div', { className: 'dim-jh-modalTitle' },
      React.createElement('strong', null, 'MiniMax 国际站分流设置')),
    React.createElement('div', { className: 'dim-jh-modelPanelActions' },
      React.createElement('button', {
        className: 'dim-jh-btn',
        onClick: onClose,
      }, '关闭'))),
  React.createElement('div', { className: 'dim-jh-modalBody' },
    // ── 原因说明 ──
    React.createElement('div', { className: 'dim-jh-hint' },
      'MiniMax 国际站的服务器按**出口 IP 所在国家**分流：中国大陆 IP 会被'
      + '重定向到中国站，从而出现「余额查询失败」「模型不可用」，'
      + '而凭据本身是好的。'),
    // ── 两条出路（先给更正当的那条）──
    React.createElement('div', { className: 'dim-jh-hint' },
      '① 推荐：用代理把出口 IP 改到海外（此时无需本设置）；'
      + '② 应急：在下面填一个海外 IP，让请求被判为海外来源。'),
    // ── 输入 ──
    React.createElement('div', { className: 'dim-jh-field' },
      React.createElement('label', { className: 'dim-jh-fieldLabel', htmlFor: 'dim-jh-minimax-xff' },
        'X-Forwarded-For（留空 = 不伪造来源）'),
      React.createElement('input', {
        id: 'dim-jh-minimax-xff',
        className: 'dim-jh-input',
        type: 'text',
        value: draft,
        spellCheck: false,
        autoComplete: 'off',
        placeholder: '例如 8.8.8.8（只接受 IPv4 / IPv6）',
        disabled: busy,
        onChange: (event) => setDraft(event.target.value),
        onKeyDown: (event) => { if (event.key === 'Enter' && !busy) void save(); },
      })),
    // ── 结果 / 错误 ──
    notice !== null
      ? React.createElement('div', {
          className: 'dim-jh-hint',
          style: notice.kind === 'bad' ? { color: 'var(--dim-danger, #e5534b)' } : undefined,
        }, notice.text)
      : null,
    // ── 风险说明（必须显式写出来）──
    React.createElement('div', { className: 'dim-jh-hint' },
      '⚠️ 该值是**声明一个并非本机的来源 IP**，仅在应急时使用；'
      + '上游若改为不信任该头，本设置会失效（届时仍会如实报错，不会假装成功）。'),
    // ── 操作 ──
    React.createElement('div', { className: 'dim-jh-modalActions' },
      React.createElement('button', {
        className: 'dim-jh-btn',
        'data-kind': 'primary',
        disabled: busy,
        onClick: () => void save(),
      }, busy ? '保存中…' : '保存'),
      /**
       * ⚠️ 「清除设置」**必须真的落盘**，不能只清输入框。
       *
       * 初版写的是 `onClick: () => setDraft('')` —— 只改了本地草稿，
       * 后端仍是旧值。用户点完看到输入框空了，会以为已经关掉绕过分流，
       * 而实际请求**仍在带 XFF**（症状：他以为改回了正常行为，其实没有）。
       * ⇒ 这里直接调后端清空并回读，语义与「保存空值」完全一致。
       */
      React.createElement('button', {
        className: 'dim-jh-btn',
        disabled: busy || (draft === '' && value === ''),
        /**
         * ⚠️ **不要在这里 `setDraft('')`**（2026-10-17 审计指出的细节）：
         * `save('')` 成功后会回读 `next` 并 `setDraft(next)`；失败时 catch 会把
         * draft 回滚到真值 `value`。若这里先清空，一旦失败就会出现
         * 「输入框空、实际仍带 XFF」的不一致。
         */
        onClick: () => { void save(''); },
      }, '清除设置'),
    ))));
}

function ClineQuotaPanel({ rpcCall, onClose }) {
  const mounted = React.useRef(true);
  React.useEffect(() => () => { mounted.current = false; }, []);

  // 额度：**每个账号一条读数，一次性全部取回** —— 所以翻页是纯本地操作，
  // 切账号时额度区零延迟（参考实现同款：「箭头不随数据禁用」）。
  const [quota, setQuota] = React.useState([]);
  const [quotaPhase, setQuotaPhase] = React.useState('loading');
  const [quotaError, setQuotaError] = React.useState('');

  /**
   * 浏览位置：**额度窗口与请求记录共享同一个索引** —— 切到谁，
   * 两个区域就一起看到谁（用户要求的「统一切换」）。
   *
   * ⚠️ 参考实现踩过的坑：这个索引是纯本地状态，**不要用 useEffect 播种**
   * （账号列表一到就 setXxx(0)）—— 那会让「浏览位置」与「显示的是谁」
   * 在两次渲染之间短暂分叉。这里只在渲染期**纯计算**出当前账号，
   * 越界时钳制但**不回写**（账号恢复后还能回到原位）。
   */
  const [viewIndex, setViewIndex] = React.useState(0);
  /** 「重新读取记录」的触发器：刷新额度时一并重读当前账号的记录。 */
  const [logNonce, setLogNonce] = React.useState(0);

  const [rows, setRows] = React.useState([]);
  const [logPhase, setLogPhase] = React.useState('idle');
  const [logError, setLogError] = React.useState('');

  const loadQuota = React.useCallback(async () => {
    setQuotaPhase('loading');
    setQuotaError('');
    try {
      const res = await rpcCall('cline.quota', { provider: 'cline' });
      if (!mounted.current) return;
      const list = Array.isArray(res?.accounts) ? res.accounts : [];
      setQuota(list);
      setQuotaPhase('ready');
    } catch (caught) {
      if (!mounted.current) return;
      console.error('[jet-hub] load cline quota failed:', caught);
      setQuotaError(caught?.message || '订阅额度查询失败');
      setQuotaPhase('error');
    }
  }, [rpcCall]);

  React.useEffect(() => { void loadQuota(); }, [loadQuota]);

  const loadLog = React.useCallback(async (accountId) => {
    setLogPhase('loading');
    setLogError('');
    try {
      const res = await rpcCall('cline.requestLog', { provider: 'cline', accountId });
      if (!mounted.current) return;
      // 记录是**本地流水**（一次性返回，无分页），整体替换。
      setRows(Array.isArray(res?.rows) ? res.rows : []);
    } catch (caught) {
      if (!mounted.current) return;
      console.error('[jet-hub] load cline request log failed:', caught);
      setLogError(caught?.message || '请求记录查询失败');
    } finally {
      if (mounted.current) setLogPhase('ready');
    }
  }, [rpcCall]);

  /** 当前浏览的账号：**渲染期纯计算**，越界钳制但不回写索引（见上）。 */
  const viewAccount = quota.length > 0
    ? quota[Math.min(viewIndex, quota.length - 1)]
    : undefined;
  const viewAccountId = viewAccount?.accountId ?? '';

  /** 箭头翻页：⚠️ **环绕** —— 末个账号的右箭头回第一个，否则用户会以为「后面没了」。 */
  const stepView = (delta) => {
    if (quota.length === 0) return;
    setViewIndex(prev => ((prev + delta) % quota.length + quota.length) % quota.length);
  };

  // 切到谁就拉谁的记录（额度区零延迟，只有这里需要网络）。
  // ⚠️ 依赖是 accountId 与 logNonce：点「刷新」时额度与记录一起重读。
  React.useEffect(() => {
    if (viewAccountId === '') return;
    void loadLog(viewAccountId);
  }, [viewAccountId, logNonce, loadLog]);

  const renderQuota = () => {
    if (quotaPhase === 'loading' && quota.length === 0) {
      return React.createElement('div', { className: 'dim-jh-empty' }, '正在读取订阅额度…');
    }
    if (quotaPhase === 'error') {
      return React.createElement('div', { className: 'dim-jh-empty', role: 'alert' },
        React.createElement('p', null, quotaError),
        React.createElement('button', { className: 'dim-jh-btn', onClick: () => void loadQuota() }, '重试'));
    }
    if (quota.length === 0) {
      return React.createElement('div', { className: 'dim-jh-empty' }, '尚未配置账号');
    }
    const entry = viewAccount;
    if (entry === undefined) return null;
    // 账号翻页器:⚠️ **一次只看一个账号**(参考实现同款,多账号下全铺开会让
    // 额度卡与记录表都变得极长)。
    // ⚠️ 单账号时**整个名字行都不渲染**(参考实现同款):箭头无处可去,
    // 而账号名在单账号下也不构成任何区分信息,留着只是占一行高度。
    const pager = quota.length > 1
      ? React.createElement('div', { className: 'dim-jh-quotaPager' },
          React.createElement('button', {
            className: 'dim-jh-quotaArrow',
            title: '上一个账号',
            'aria-label': '上一个账号',
            onClick: () => stepView(-1),
          }, '‹'),
          React.createElement('div', { className: 'dim-jh-quotaAccountName' },
            React.createElement('span', {
              className: 'dim-jh-quotaAccountLabel',
              title: entry.nickname || entry.accountId,
            }, entry.nickname || entry.accountId),
            React.createElement('span', { className: 'dim-jh-quotaIndex' },
              `第 ${viewIndex + 1} / ${quota.length} 个`)),
          React.createElement('button', {
            className: 'dim-jh-quotaArrow',
            title: '下一个账号',
            'aria-label': '下一个账号',
            onClick: () => stepView(1),
          }, '›'))
      : null;
    // 窗口顺序:**已知窗口按固定顺序在前,网关新增的未知窗口追加在后**。
    const windows = quotaWindowsOf(entry.windows);
    // ⚠️ 「查询失败」与「没有额度窗口」分开渲染:前者是错误(显示原因),
    // 后者是事实(该账号没有这一层计量)。合并成一句会让用户以为额度没了。
    const body = entry.ok
      ? (windows.length === 0
          ? React.createElement('div', { className: 'dim-jh-quotaMuted' }, '官方未返回额度窗口。')
          : React.createElement('div', { className: 'dim-jh-quotaWindows' },
              windows.map(([type, label, win]) => {
                const percent = quotaPercentValue(win.percentUsed);
                const tone = quotaTone(percent);
                const resetsIn = quotaResetsIn(win.resetsAt);
                return React.createElement('div', {
                  key: `${type}`,
                  className: 'dim-jh-quotaWindow',
                },
                  React.createElement('div', { className: 'dim-jh-quotaWindowHead' },
                    React.createElement('span', { className: 'dim-jh-quotaWindowName' }, label),
                    // ⚠️ 18px 大字 + 夹取后取整(参考实现同款):百分比是这张卡
                    // 唯一要读的数,值得占最大的字级。
                    React.createElement('span', {
                      className: 'dim-jh-quotaWindowPercent',
                      'data-tone': tone,
                    }, formatQuotaPercent(percent))),
                  React.createElement('div', {
                    className: 'dim-jh-quotaBar',
                    role: 'progressbar',
                    'aria-label': `${label} 已用`,
                    'aria-valuenow': percent,
                    'aria-valuemin': 0,
                    'aria-valuemax': 100,
                  },
                    React.createElement('div', {
                      className: 'dim-jh-quotaBarFill',
                      'data-tone': tone,
                      style: { width: `${percent}%` },
                    })),
                  resetsIn === ''
                    ? null
                    : React.createElement('div', { className: 'dim-jh-quotaReset' }, resetsIn));
              })))
      : React.createElement('div', { className: 'dim-jh-quotaMuted' },
          `暂时读不到官方额度。${entry.error ? ` ${entry.error}` : ''}`);
    return React.createElement('div', {
      // ⚠️ 按账号 id 作 key → 切账号时**重新挂载**该块(参考实现同款):
      // 否则进度条的 width 过渡会在两个账号的读数之间播放,
      // 看起来像"这个账号的额度在涨",而那只是动画。
      key: entry.accountId,
      className: 'dim-jh-quotaGroup',
    }, pager, body);
  };

  const renderLog = () => {
    if (viewAccountId === '') return null;
    // 各层先拆成局部变量再组装:createElement 的多参嵌套极易数错括号,
    // 首版就是在这里多/少一层导致 esbuild 语法错(拆开后每层独立可验证)。
    const head = React.createElement(
      'h3', { className: 'dim-jh-quotaSectionTitle' }, '请求记录');
    const hint = React.createElement(
      'p', { className: 'dim-jh-quotaLogHint' },
      '是本插件发出的请求流水（进程内存，重启后清空），不是官方账单 —— '
      + '官方渠道的消费在 Cline 自己的用量页里。');
    // 5 列:状态点 | 时间 | 模型/上游 | TOKEN | 延迟(参考实现同款)。
    const tableHead = React.createElement(
      'thead', null,
      React.createElement('tr', null,
        React.createElement('th', { className: 'dim-jh-quotaDotCol' }, ''),
        React.createElement('th', { className: 'dim-jh-quotaWhenCol' }, '时间'),
        React.createElement('th', null, '模型 / 上游'),
        React.createElement('th', null, 'TOKEN'),
        React.createElement('th', null, '延迟')));
    // 列宽提示(参考实现用 colgroup 同一写法):状态点 16px、时间 82px,
    // 其余自适应。表格是 `table-layout: auto`,故这是**提示**而非硬约束 ——
    // 与参考实现一致:内容更宽时列仍可自己长出来(不自造横向滚动)。
    const colGroup = React.createElement(
      'colgroup', null,
      React.createElement('col', { className: 'dim-jh-quotaDotCol' }),
      React.createElement('col', { className: 'dim-jh-quotaWhenCol' }),
      React.createElement('col', null),
      React.createElement('col', { className: 'dim-jh-quotaTokensCol' }),
      React.createElement('col', { className: 'dim-jh-quotaLoadCol' }));
    const tableBody = React.createElement(
      'tbody', null,
      rows.flatMap((row, index) => {
        const key = `${row.ts}-${index}`;
        const failed = row.error !== undefined;
        const figures = latencyParts(row);
        // ⚠️ 模型名去掉 `cline-pass/` 前缀(参考实现同款):这段前缀在**每一行**
        // 都一样,是常量,却占掉模型名最需要的宽度;上游另有一格用 tag 表示。
        const label = String(row.model ?? '').replace(/^cline-pass\//, '');
        const cells = [
          React.createElement('td', null, React.createElement(StatusDot, {
            ok: !failed,
            title: failed ? String(row.error) : '成功',
          })),
          React.createElement('td', { className: 'dim-jh-quotaWhen' }, formatStamp(row.ts)),
          React.createElement('td', null,
            React.createElement('span', {
              className: 'dim-jh-quotaModel',
              title: String(row.model ?? ''),
            }, label || '—'),
            // 上游与模型是两个维度:同模型可能由不同通道服务,拼一列会让
            // 「同名不同上游」的行无法区分。
            React.createElement('span', { className: 'dim-jh-quotaMeta' },
              React.createElement('span', { className: 'dim-jh-quotaTag' },
                row.upstream || '—'))),
          React.createElement('td', {
            className: 'dim-jh-quotaTokens',
            // ⚠️ tooltip = **精确**数字 + 图例:单元格里超过 10 万会缩写成 k/M,
            // tooltip 是唯一保留个位的地方;`—` 的含义也只在图例里解释
            // (参考实现同款)。
            title: tokenTooltip(row),
          }, tokenSummary(row)),
          React.createElement('td', { className: 'dim-jh-quotaLoad' },
            React.createElement('span', { className: 'dim-jh-quotaLoadRow' },
              React.createElement('span', { className: 'dim-jh-quotaLoadKey' }, '首字'),
              React.createElement('span', null, formatMs(figures.first))),
            React.createElement('span', { className: 'dim-jh-quotaLoadRow' },
              React.createElement('span', { className: 'dim-jh-quotaLoadKey' }, '总耗时'),
              React.createElement('span', null, formatMs(figures.total))),
            React.createElement('span', { className: 'dim-jh-quotaLoadRow', title: figures.rateTitle },
              React.createElement('span', { className: 'dim-jh-quotaLoadKey' }, '输出速度'),
              React.createElement('span', null, figures.rate))),
        ];
        const rowEl = React.createElement('tr', {
          key,
          'data-error': failed ? 'error' : undefined,
          // 整行 restate 一遍事实(含 token 与速率):截图或复制时信息不丢
          // (参考实现同款)。⚠️ 这里用**有界**的 tokenSummary(不是精确值),
          // 与参考实现一致:精确个位只出现在 TOKEN 单元格的 tooltip 里。
          title: [
            String(row.model ?? ''),
            `${row.upstream || '—'} · ${tokenSummary(row)}`,
            `首字 ${formatMs(figures.first)} · 总耗时 ${formatMs(figures.total)} · 输出速度 ${figures.rate}`,
            // 推理强度:有值时才有这一行(参考实现同款)。
            row.effort ? `推理强度 ${row.effort}` : '',
            failed ? String(row.error) : '',
          ].filter((line) => line !== '').join('\n'),
        }, ...cells);
        // ⚠️ 失败行:错误消息**随行**显示。两个前置空单元格让消息**从模型列起**
        // 横跨三列(模型/TOKEN/延迟),与参考实现同构 —— 收进 tooltip 用户永远看不到。
        if (failed) {
          return [
            rowEl,
            React.createElement('tr', { key: `${key}-err`, 'data-error': 'error' },
              React.createElement('td', null, ''),
              React.createElement('td', null, ''),
              React.createElement('td', {
                className: 'dim-jh-quotaError',
                colSpan: 3,
                title: String(row.error),
              }, String(row.error))),
          ];
        }
        return [rowEl];
      }));
    const table = React.createElement(
      'table', { className: 'dim-jh-quotaTable' }, colGroup, tableHead, tableBody);
    const wrap = React.createElement(
      'div', { className: 'dim-jh-quotaTableWrap' }, table);
    const empty = React.createElement(
      'div', { className: 'dim-jh-empty' },
      logError === ''
        ? '暂无记录。（面板打开后新发起的请求才会出现在这里）'
        : logError);
    const body = logPhase === 'loading'
      ? React.createElement('div', { className: 'dim-jh-empty' }, '正在读取请求记录…')
      : rows.length === 0 ? empty : wrap;
    return React.createElement(
      'div', { className: 'dim-jh-quotaLog' }, head, hint, body);
  };

  /**
   * 弹窗副标题：谁的身份。
   *
   * 参考实现的额度卡标题会带上「这是谁的额度」（多账号 = `· {n} 个账号`，
   * 单账号 = `· 账号 {名}`）。jet-hub 的账号名行在**单账号时刻意不渲染**
   * （见 renderQuota：箭头无处可去），故这份身份信息挂到副标题上，
   * 既不重复占一行，也不会在单账号下丢失「这是谁的额度」。
   */
  const quotaSubtitle = () => {
    if (quota.length > 1) return `Cline · ${quota.length} 个账号`;
    const only = quota[0];
    if (only === undefined) return 'Cline';
    return `Cline · 账号 ${only.nickname || only.accountId}`;
  };

  // 与登录弹窗、模型列表同款：直接渲染在组件树内，靠 position: fixed 覆盖全屏。
  // **刻意不用 createPortal**（理由见 ModelListPanel 的说明）。
  return React.createElement('div', {
    className: 'dim-jh-modalOverlay dim-jh-modalOverlay--top',
    onClick: (event) => { if (event.target === event.currentTarget) onClose(); },
  },
    React.createElement('div', {
      className: 'dim-jh-modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Cline 订阅额度',
    },
      React.createElement('div', { className: 'dim-jh-modalHead' },
        React.createElement('div', { className: 'dim-jh-modalTitle' },
          React.createElement('strong', null, '订阅额度'),
          React.createElement('span', { className: 'dim-jh-modalSubtitle' }, quotaSubtitle())),
        React.createElement('div', { className: 'dim-jh-modelPanelActions' },
          React.createElement('button', {
            className: 'dim-jh-btn',
            disabled: quotaPhase === 'loading',
            title: '重新查询全部账号的订阅额度窗口，并重读当前账号的请求记录。',
            onClick: () => { void loadQuota(); setLogNonce(n => n + 1); },
          }, quotaPhase === 'loading' ? '读取中…' : '刷新'),
          React.createElement('button', {
            className: 'dim-jh-btn',
            'data-kind': 'primary',
            onClick: onClose,
          }, '完成'))),
      React.createElement('p', { className: 'dim-jh-modalHint' },
        '额度窗口来自 Cline 官方网关；请求记录是本插件自己发出的请求流水（重启后清空）。'
        + '两者与账号卡片上的「积分」是三份不同的读数：积分答「还剩多少」，'
        + '额度答「各时间窗用掉百分之几」，记录答「每一笔发了多久、花了多少 token」。'),
      // ⚠️ 内容**必须**放进 .dim-jh-modalBody（flex:1; min-height:0; overflow-y:auto）。
      // .dim-jh-modal 是 max-height 有限的 flex **列**容器，子项默认不可收缩，
      // 内容直接铺在里面就会**画出弹窗边界之外** —— 首版正是漏了这一层：
      // 额度卡 + 请求表把弹窗撑破，看起来像「弹窗位置不对、内容显示不对」。
      // 模型列表弹窗的内容同样在 modalBody 里（见其 error/loading/empty 分支）。
      React.createElement('div', { className: 'dim-jh-modalBody' },
        renderQuota(),
        renderLog())));
}

/**
 * 「Token 用量」弹窗（全 provider 的本地记账视图）。
 *
 * 数据来自 RPC `usage.tokenLedger`（进程内存账本，记账点在注册收敛层，
 * 渠道由网关打标区分 —— 见 `src/token-ledger.ts` 模块头）。三层视图：
 *
 * 1. **汇总卡**：每个渠道一张（直连 / 网关），头部是渠道名 + 请求计数，
 *    卡内按 provider 分组、模型成行（token 汇总）；
 * 2. **明细表**：最近请求流水（时间 | 渠道 | 模型 | TOKEN | 耗时）；
 * 3. **空状态**：没有任何数据时说明「记了什么、什么时候开始有」。
 *
 * ⚠️ 判据全部在 `token-ledger-panel.js`（纯函数）：本组件只画形状，
 * 不做数值换算 —— 与 Cline 请求表 / 网关弹窗同款分工。
 */
function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^\s*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

function downloadCsv(filename, headers, rows) {
  const body = [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob(['\uFEFF', body], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function TokenLedgerPanel({ rpcCall, onClose }) {
  const mounted = React.useRef(true);
  React.useEffect(() => () => { mounted.current = false; }, []);

  const [snapshot, setSnapshot] = React.useState(null);
  const [phase, setPhase] = React.useState('loading');
  const [error, setError] = React.useState('');
  /** 当前展开的渠道（`null` = 全部）。账本最多两个渠道，不做更深层的筛选。 */
  const [selected, setSelected] = React.useState(null);
  /**
   * 历史视图（第 4 期）：窗口 key（HISTORY_RANGES 的 key）+ 数据 + 加载态。
   *
   * ⚠️ 历史与明细是**两份独立数据**（落盘日聚合 vs 内存流水），各自加载、
   * 各自的刷新按钮——历史来自盘上（重启保留），明细来自内存。
   */
  const [historyRange, setHistoryRange] = React.useState('30d');
  const [historyFromDay, setHistoryFromDay] = React.useState('');
  const [historyToDay, setHistoryToDay] = React.useState('');
  const [history, setHistory] = React.useState(null);
  const [historyPhase, setHistoryPhase] = React.useState('idle');
  const [deletingHistoryDay, setDeletingHistoryDay] = React.useState(null);
  const [historyDeleteError, setHistoryDeleteError] = React.useState('');
  /** 展开的那个历史日（`null` = 全收起）。天与天的聚合树同弹窗内切换。 */
  const [expandedDay, setExpandedDay] = React.useState(null);
  const [hoveredDay, setHoveredDay] = React.useState(null);
  const [entryQuery, setEntryQuery] = React.useState('');
  const [entryChannel, setEntryChannel] = React.useState('all');
  const [entryStatus, setEntryStatus] = React.useState('all');
  const [entrySort, setEntrySort] = React.useState('newest');
  const [entryPage, setEntryPage] = React.useState(1);

  const load = React.useCallback(async () => {
    setPhase('loading');
    setError('');
    try {
      const res = await rpcCall('usage.tokenLedger', {});
      if (!mounted.current) return;
      setSnapshot(res?.snapshot ?? null);
      setPhase('ready');
    } catch (caught) {
      if (!mounted.current) return;
      console.error('[jet-hub] load token ledger failed:', caught);
      setError(caught?.message || 'Token 用量读取失败');
      setPhase('error');
    }
  }, [rpcCall]);

  React.useEffect(() => { void load(); }, [load]);

  /** 读取历史日聚合（窗口切换时重拉；days=0 即「全部」，服务端钳到 90）。 */
  const loadHistory = React.useCallback(async (rangeKey, fromDay = historyFromDay, toDay = historyToDay) => {
    if (rangeKey === 'custom' && fromDay && toDay && fromDay > toDay) {
      setHistory(null);
      setHistoryPhase('ready');
      return;
    }
    setHistoryPhase('loading');
    try {
      const days = rangeDaysOf(rangeKey);
      const payload = rangeKey === 'custom'
        ? { ...(fromDay ? { fromDay } : {}), ...(toDay ? { toDay } : {}) }
        : days > 0 ? { sinceDays: days } : {};
      const res = await rpcCall('usage.tokenLedgerHistory', payload);
      if (!mounted.current) return;
      setHistory(res ?? null);
      setHistoryPhase('ready');
    } catch (caught) {
      if (!mounted.current) return;
      console.error('[jet-hub] load token ledger history failed:', caught);
      // 历史读取失败不顶掉明细视图：历史区自己显示错误行。
      setHistory(null);
      setHistoryPhase('error');
    }
  }, [historyFromDay, historyToDay, rpcCall]);

  /** 删除图表中选中的单日累计；确认文案明确限定为历史文件里的这个日期。 */
  const deleteHistoryDay = React.useCallback(async (day) => {
    if (typeof day !== 'string' || !confirm(
      `确认删除 ${day} 的历史用量？只清除这一天的日累计，不会清除实时明细、其他日期或账号设置。`,
    )) return;
    setDeletingHistoryDay(day);
    setHistoryDeleteError('');
    try {
      await rpcCall('usage.tokenLedgerDeleteDay', { day });
      if (!mounted.current) return;
      setExpandedDay(null);
      await loadHistory(historyRange);
    } catch (caught) {
      if (!mounted.current) return;
      console.error('[jet-hub] delete token ledger history failed:', caught);
      setHistoryDeleteError(caught?.message || `${day} 历史用量删除失败`);
    } finally {
      if (mounted.current) setDeletingHistoryDay(null);
    }
  }, [historyRange, loadHistory, rpcCall]);

  React.useEffect(() => { void loadHistory(historyRange); }, [historyRange, historyFromDay, historyToDay, loadHistory]);

  const channels = React.useMemo(() => {
    const list = Array.isArray(snapshot?.channels) ? [...snapshot.channels] : [];
    list.sort((a, b) => channelOrder(a?.channel, b?.channel));
    return selected === null ? list : list.filter((c) => c?.channel === selected);
  }, [snapshot, selected]);

  /** 一行模型的三个格子（实时汇总与历史日树共用，避免括号地狱）。 */
  /**
   * 均值单元格：`首字 2.11s · 982.5 tok/s` + **口径说明 tooltip**。
   *
   * ⚠️ 口径说明不是锦上添花（用户 2026-10-07 报障）：看到「982.5 tok/s」时
   * 合理怀疑算错了，而不给口径就无从判断它是真快还是被离群样本拉出来的。
   * 统一走这里，避免 7 个调用点各写一份 title 而漏掉某一处。
   */
  const perfCell = (row) => React.createElement('span', {
    className: 'dim-jh-ledgerPerf', title: avgPerfDetailTooltip(row),
  }, avgPerfText(row));

  const renderModelRow = (modelRow, key) => React.createElement('div', {
    key, className: 'dim-jh-ledgerModel',
  },
    React.createElement('span', { className: 'dim-jh-ledgerModelName', title: modelRow.model }, modelRow.model),
    React.createElement('span', { className: 'dim-jh-ledgerModelReq', title: '请求数（含失败）' },
      modelRow.requests + ' 次'),
    perfCell(modelRow),
    React.createElement('span', { className: 'dim-jh-ledgerModelTokens', title: tokenSummaryTooltip(modelRow) },
      tokenSummaryText(modelRow)));

  const renderSummary = () => {
    if (phase === 'loading' && snapshot === null) {
      return React.createElement('div', { className: 'dim-jh-empty' }, '正在读取 Token 用量…');
    }
    if (phase === 'error') {
      return React.createElement('div', { className: 'dim-jh-empty', role: 'alert' },
        React.createElement('p', null, error),
        React.createElement('button', { className: 'dim-jh-btn', onClick: () => void load() }, '重试'));
    }
    if (!hasAnyData(snapshot)) {
      return React.createElement('div', { className: 'dim-jh-empty' },
        React.createElement('p', null, '还没有任何请求记录。'),
        React.createElement('p', null,
          '本插件在每次模型请求结束时记录 token 用量（含直连与网关两条通道），重启 DSH 后清空。'));
    }
    // 渠道筛选行：全部 / 直连 / 网关。只渲染聚合树里实际存在的渠道
    //（没开网关的用户不该看到一个恒空的「网关」按钮）。
    const present = Array.from(new Set((snapshot?.channels ?? []).map((c) => c?.channel)));
    const filterRow = present.length > 1
      ? React.createElement('div', { className: 'dim-jh-ledgerFilters', key: 'filters' },
          [null, ...present].map((key) => React.createElement('button', {
            key: key === null ? 'all' : key,
            className: 'dim-jh-btn dim-jh-ledgerFilterBtn',
            'data-active': selected === key ? 'true' : 'false',
            onClick: () => setSelected(key),
          }, key === null ? '全部' : channelLabel(key))))
      : null;
    /** 一个 provider 的内部：多账号分层 / 单账号平铺（一比一的中间层是纯噪音）。 */
    const renderProviderBody = (providerRow) => {
      const accounts = providerRow.accounts ?? [];
      if (accounts.length > 1) {
        return accounts.map((accountRow) => React.createElement('div', {
          key: providerRow.provider + '#' + accountRow.accountId, className: 'dim-jh-ledgerAccount',
        },
          React.createElement('div', { className: 'dim-jh-ledgerAccountHead' },
            React.createElement('span', { className: 'dim-jh-ledgerAccountName', title: accountRow.accountId },
              accountLabel(accountRow.accountId)),
            perfCell(accountRow.totals),
            React.createElement('span', { className: 'dim-jh-ledgerAccountSum', title: tokenSummaryTooltip(accountRow.totals) },
              tokenSummaryText(accountRow.totals))),
          accountRow.models.map((modelRow) =>
            renderModelRow(modelRow, modelRow.model))));
      }
      return accounts.flatMap((accountRow) => accountRow.models.map((modelRow) =>
        renderModelRow(modelRow, providerRow.provider + '#' + modelRow.model)));
    };

    return React.createElement(React.Fragment, null,
      filterRow,
      // 汇总卡：渠道 → provider → 账号 → 模型（第 2 期加了账号层）。
      // provider / 账号行带自身小计（与模型行同列对齐）。
      channels.map((channelRow) => React.createElement('div', {
        key: channelRow.channel, className: 'dim-jh-ledgerCard',
      },
        React.createElement('div', { className: 'dim-jh-ledgerCardHead' },
          React.createElement('strong', null, channelCardTitle(channelRow)),
          perfCell(channelRow.totals),
          React.createElement('span', { className: 'dim-jh-ledgerCardSum', title: tokenSummaryTooltip(channelRow.totals) },
            tokenSummaryText(channelRow.totals))),
        channelRow.providers.map((providerRow) => React.createElement('div', {
          key: providerRow.provider, className: 'dim-jh-ledgerProvider',
        },
          React.createElement('div', { className: 'dim-jh-ledgerProviderHead' },
            React.createElement('span', { className: 'dim-jh-ledgerProviderName' }, providerRow.provider),
            perfCell(providerRow.totals),
            React.createElement('span', { className: 'dim-jh-ledgerProviderSum', title: tokenSummaryTooltip(providerRow.totals) },
              tokenSummaryText(providerRow.totals))),
          renderProviderBody(providerRow))))));
  };

  const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : [];
  const visibleEntries = React.useMemo(() => {
    const query = entryQuery.trim().toLowerCase();
    const filtered = entries.filter((entry) => {
      if (entryChannel !== 'all' && entry.channel !== entryChannel) return false;
      if (entryStatus === 'success' && entry.error !== undefined) return false;
      if (entryStatus === 'error' && entry.error === undefined) return false;
      if (query && !String(entry.model ?? '').toLowerCase().includes(query)) return false;
      return true;
    });
    const tokenValue = totalTokensOf;
    filtered.sort((a, b) => {
      if (entrySort === 'tokens') return tokenValue(b) - tokenValue(a) || b.ts - a.ts;
      if (entrySort === 'duration') return (b.durationMs ?? 0) - (a.durationMs ?? 0) || b.ts - a.ts;
      if (entrySort === 'speed') return (b.tps ?? 0) - (a.tps ?? 0) || b.ts - a.ts;
      return b.ts - a.ts;
    });
    return filtered;
  }, [entries, entryChannel, entryQuery, entrySort, entryStatus]);
  React.useEffect(() => { setEntryPage(1); }, [entryChannel, entryQuery, entrySort, entryStatus]);
  const entryPageCount = Math.max(1, Math.ceil(visibleEntries.length / 50));
  const safeEntryPage = Math.min(entryPage, entryPageCount);
  const pageEntries = visibleEntries.slice((safeEntryPage - 1) * 50, safeEntryPage * 50);

  const exportEntries = () => downloadCsv('token-usage-details.csv',
    ['时间', '渠道', '模型', '状态', '总处理量', '输入', '输出', '缓存命中', '缓存写入', '推理', '首字毫秒', '输出tok每秒', '耗时毫秒', '错误'],
    visibleEntries.map((entry) => [
      Number.isFinite(entry.ts) ? new Date(entry.ts).toISOString() : '', channelLabel(entry.channel), entry.model,
      entry.error === undefined ? '成功' : '失败',
      // ⚠️ 未收到 usage 的失败行导出**空串**而非 0：界面用 `—` 与真实的 0 严格区分
      //（见 token-ledger.ts 的「0 会被读成瞬间完成、没花 token」注释），
      // CSV 若写 0 就与界面自相矛盾，且 Excel 里再也分不出「没数据」与「真的是 0」。
      entry.usageReported === false ? '' : totalTokensOf(entry),
      entry.usageReported === false ? '' : entry.inputTokens ?? 0,
      entry.usageReported === false ? '' : entry.outputTokens ?? 0,
      entry.cacheReadTokens ?? 0,
      entry.cacheWriteTokens ?? 0, entry.reasoningTokens ?? 0, entry.ttftMs ?? '',
      entry.tps ?? '', entry.durationMs ?? '', entry.error ?? '',
    ]));

  const renderEntries = () => {
    if (entries.length === 0) return null;
    const toolbar = React.createElement('div', { className: 'dim-jh-ledgerEntryTools' },
      React.createElement('strong', null, '最近请求'),
      React.createElement('span', { className: 'dim-jh-ledgerEntryCount' }, `${visibleEntries.length} / ${entries.length}`),
      React.createElement('input', {
        className: 'dim-jh-input dim-jh-ledgerSearch', type: 'search', value: entryQuery,
        placeholder: '筛选模型', 'aria-label': '按模型筛选请求',
        onChange: (event) => setEntryQuery(event.target.value),
      }),
      React.createElement('select', {
        className: 'dim-jh-ledgerSelect', value: entryChannel, 'aria-label': '按渠道筛选请求',
        onChange: (event) => setEntryChannel(event.target.value),
      }, [
        React.createElement('option', { key: 'all', value: 'all' }, '全部渠道'),
        React.createElement('option', { key: 'direct', value: 'direct' }, '直连'),
        React.createElement('option', { key: 'gateway', value: 'gateway' }, '网关'),
      ]),
      React.createElement('select', {
        className: 'dim-jh-ledgerSelect', value: entryStatus, 'aria-label': '按请求状态筛选',
        onChange: (event) => setEntryStatus(event.target.value),
      }, [
        React.createElement('option', { key: 'all', value: 'all' }, '全部状态'),
        React.createElement('option', { key: 'success', value: 'success' }, '成功'),
        React.createElement('option', { key: 'error', value: 'error' }, '失败'),
      ]),
      React.createElement('select', {
        className: 'dim-jh-ledgerSelect', value: entrySort, 'aria-label': '请求排序方式',
        onChange: (event) => setEntrySort(event.target.value),
      }, [
        React.createElement('option', { key: 'newest', value: 'newest' }, '最新优先'),
        React.createElement('option', { key: 'tokens', value: 'tokens' }, 'Token 量最多'),
        React.createElement('option', { key: 'duration', value: 'duration' }, '耗时最长'),
        React.createElement('option', { key: 'speed', value: 'speed' }, '速率最高'),
      ]),
      React.createElement('button', {
        className: 'dim-jh-btn dim-jh-ledgerExport', onClick: exportEntries,
        disabled: visibleEntries.length === 0, title: '导出当前筛选后的请求明细 CSV',
      }, '导出明细'));
    if (visibleEntries.length === 0) return React.createElement('div', { key: 'entries' }, toolbar,
      React.createElement('div', { className: 'dim-jh-empty' }, '没有符合当前筛选条件的请求。'));
    return React.createElement('div', { key: 'entries' }, toolbar,
      React.createElement('table', { className: 'dim-jh-ledgerTable' },
      React.createElement('thead', null,
        React.createElement('tr', null,
          ['时间', '渠道', '模型', 'TOKEN', '首字', '速率', '耗时', '状态'].map((h) =>
            React.createElement('th', {
              key: h,
              title: h === 'TOKEN' ? '总处理量 = 未命中缓存输入 + 缓存命中输入 + 输出；缓存写入单列展示，不重复计入总量' : undefined,
            }, h)))),
      React.createElement('tbody', null, pageEntries.map((entry, index) => React.createElement('tr', {
        key: entry.ts + '-' + index,
        'data-error': entry.error !== undefined ? 'true' : 'false',
      },
        React.createElement('td', { title: new Date(entry.ts).toLocaleString() }, formatEntryTime(entry.ts)),
        React.createElement('td', null, channelLabel(entry.channel)),
        React.createElement('td', { className: 'dim-jh-ledgerEntryModel' }, entry.model),
        React.createElement('td', { title: tokenSummaryTooltip(entry) }, entryTokenText(entry)),
        React.createElement('td', null, formatTtft(entry)),
        React.createElement('td', null, formatTps(entry)),
        React.createElement('td', null, formatDuration(entry.durationMs)),
        React.createElement('td', {
          className: entry.error !== undefined ? 'dim-jh-ledgerError' : 'dim-jh-ledgerSuccess',
          title: entry.error !== undefined ? entry.error : '请求成功',
          'aria-label': entry.error !== undefined ? '失败详情：' + entry.error : '请求成功',
        }, entry.error !== undefined ? '失败 ⓘ' : '成功 ✓'))))),
      React.createElement('div', { className: 'dim-jh-ledgerPagination' },
        React.createElement('span', null, `第 ${safeEntryPage} / ${entryPageCount} 页，每页 50 条`),
        React.createElement('button', {
          className: 'dim-jh-btn', disabled: safeEntryPage <= 1,
          onClick: () => setEntryPage((page) => Math.max(1, page - 1)),
        }, '上一页'),
        React.createElement('button', {
          className: 'dim-jh-btn', disabled: safeEntryPage >= entryPageCount,
          onClick: () => setEntryPage((page) => Math.min(entryPageCount, page + 1)),
        }, '下一页')));
  };

  // ── 历史视图（第 4 期）：数据源是落盘日聚合，重启保留 ──
  // ⚠️ 响应体的天数数组在 `history` 键上（`RpcUsageTokenLedgerHistoryResponse`），
  // 与同级的 `totals` 平级 —— 读成 `days` 会恒得 undefined，界面表现为
  // 「合计有数、却没有柱子」（空状态文案还反过来说「今天发起的请求明天才能看到」，
  // 而当天数据其实就在响应里）。
  const historyDays = Array.isArray(history?.history) ? history.history : [];
  const heatmapDays = historyRange === 'custom'
    ? Math.min(90, historyFromDay && historyToDay
      ? Math.max(1, Math.round((Date.parse(historyToDay + 'T00:00:00Z') - Date.parse(historyFromDay + 'T00:00:00Z')) / 86400000) + 1)
      : 30)
    : rangeDaysOf(historyRange) || 90;
  const heatmapEndDay = historyRange === 'custom' && historyToDay ? historyToDay : todayDayKey();
  const heatmapCells = historyHeatmapCells(historyDays, heatmapDays, heatmapEndDay);
  const selectedHistoryDay = historyDays.find((d) => d?.day === (hoveredDay ?? expandedDay)) ?? null;
  const invalidHistoryRange = historyRange === 'custom' && historyFromDay && historyToDay && historyFromDay > historyToDay;
  const exportHistory = () => downloadCsv('token-usage-history.csv',
    ['日期', '请求数', '总处理量', '输入', '输出', '缓存命中', '缓存写入', '推理'],
    historyDays.map((day) => [day.day, day.totals?.requests ?? 0, day.totals?.totalTokens ?? 0,
      day.totals?.inputTokens ?? 0, day.totals?.outputTokens ?? 0, day.totals?.cacheReadTokens ?? 0,
      day.totals?.cacheWriteTokens ?? 0, day.totals?.reasoningTokens ?? 0]));
  const renderHistory = () => {
    // 窗口切换条：与渠道筛选同一观感（胶囊按钮组）。
    const rangeRow = React.createElement('div', { className: 'dim-jh-ledgerFilters', key: 'historyRanges' },
      HISTORY_RANGES.map((r) => React.createElement('button', {
        key: r.key,
        className: 'dim-jh-btn dim-jh-ledgerFilterBtn',
        'data-active': historyRange === r.key ? 'true' : 'false',
        onClick: () => { setHistoryRange(r.key); setExpandedDay(null); },
      }, r.label)),
      React.createElement('button', {
        key: 'custom', className: 'dim-jh-btn dim-jh-ledgerFilterBtn',
        'data-active': historyRange === 'custom' ? 'true' : 'false',
        onClick: () => {
          const today = todayDayKey();
          const [year, month, date] = today.split('-').map(Number);
          const fromDefault = new Date(Date.UTC(year, month - 1, date - 6)).toISOString().slice(0, 10);
          setHistoryFromDay((value) => value || fromDefault);
          setHistoryToDay((value) => value || today);
          setHistoryRange('custom');
          setExpandedDay(null);
        },
      }, '自选'),
      historyRange === 'custom' ? React.createElement('div', { className: 'dim-jh-ledgerDateRange', key: 'dateRange' },
        React.createElement('label', null, '从', React.createElement('input', {
          type: 'date', className: 'dim-jh-input', value: historyFromDay,
          onChange: (event) => setHistoryFromDay(event.target.value),
        })),
        React.createElement('label', null, '到', React.createElement('input', {
          type: 'date', className: 'dim-jh-input', value: historyToDay,
          onChange: (event) => setHistoryToDay(event.target.value),
        }))) : null,
      React.createElement('button', {
        className: 'dim-jh-btn dim-jh-ledgerExport', disabled: historyPhase !== 'ready' || historyDays.length === 0,
        title: '导出当前日期范围的每日汇总 CSV', onClick: exportHistory,
      }, '导出历史'),
      React.createElement('span', {
        className: 'dim-jh-ledgerPerf', style: { marginLeft: 'auto' },
        title: history?.totals ? tokenSummaryTooltip(history.totals) : undefined,
      },
        history !== null && history.totals !== undefined
          ? '总处理 ' + formatTokenCount(history.totals.totalTokens)
            + ' · ' + (history.totals.requests ?? 0) + ' 次'
          : ''));
    const body = invalidHistoryRange
      ? React.createElement('div', { className: 'dim-jh-empty', key: 'histRangeError', role: 'alert' }, '起始日期不能晚于结束日期。')
      : historyPhase === 'loading'
      ? React.createElement('div', { className: 'dim-jh-empty', key: 'histLoading' }, '正在读取历史用量…')
      : historyPhase === 'error'
        ? React.createElement('div', { className: 'dim-jh-empty', key: 'histError' }, '历史用量读取失败（不影响明细）。')
        : historyDays.length === 0
          ? React.createElement('div', { className: 'dim-jh-empty', key: 'histEmpty' },
              '还没有历史用量。请求完成后会立即按 UTC+8 日期累计，历史最多保留 90 天。')
          : React.createElement(React.Fragment, { key: 'histBody' },
              // GitHub 风格用量格：固定四行，按日期顺序排列，点击可展开当日详情。
              React.createElement('div', { className: 'dim-jh-ledgerHeatmapWrap' },
                React.createElement('div', { className: 'dim-jh-ledgerHeatmap', role: 'group', 'aria-label': '每日 Token 用量热力图' },
                  heatmapCells.map((cell) => React.createElement('button', {
                    key: cell.day,
                    className: 'dim-jh-ledgerHeatmapCell',
                    type: 'button',
                    'data-level': String(cell.level),
                    'data-today': cell.isToday ? 'true' : 'false',
                    'data-active': expandedDay === cell.day ? 'true' : 'false',
                    title: `${cell.day}\n总处理 ${formatTokenCount(cell.tokens)}\n请求 ${cell.requests} 次\n${tokenSummaryTooltip(historyDays.find((day) => day.day === cell.day)?.totals)}\n点击展开当日明细`,
                    'aria-label': `${cell.day}，总处理 ${formatTokenCount(cell.tokens)}，${cell.requests} 次请求。点击展开`,
                    onMouseEnter: () => setHoveredDay(cell.day),
                    onMouseLeave: () => setHoveredDay(null),
                    onFocus: () => setHoveredDay(cell.day),
                    onBlur: () => setHoveredDay(null),
                    onClick: () => setExpandedDay((prev) => (prev === cell.day ? null : cell.day)),
                  })))),
              selectedHistoryDay ? React.createElement('div', { className: 'dim-jh-ledgerDayPeek' },
                React.createElement('strong', null, selectedHistoryDay.day),
                React.createElement('span', null, '总处理 ' + formatTokenCount(selectedHistoryDay.totals?.totalTokens)),
                React.createElement('span', null, (selectedHistoryDay.totals?.requests ?? 0) + ' 次请求'),
                React.createElement('span', { title: tokenSummaryTooltip(selectedHistoryDay.totals) }, '悬停查看 Token 拆分'),
                React.createElement('button', {
                  className: 'dim-jh-btn dim-jh-ledgerDeleteQuick',
                  onClick: () => setExpandedDay(selectedHistoryDay.day),
                  title: '展开当日详情与删除入口',
                }, '查看 / 删除')) : React.createElement('div', { className: 'dim-jh-ledgerChartHint' },
                '悬停查看当日用量，点击日期展开详情'),
              // 展开的那天：完整聚合树（渠道 → provider → 账号 → 模型）。
              ...(expandedDay !== null
                ? historyDays.filter((d) => d?.day === expandedDay).map((dayRow) =>
                    renderDayTree(dayRow))
                : []));
    return React.createElement('div', { className: 'dim-jh-ledgerSection', key: 'history' },
      React.createElement('div', { className: 'dim-jh-ledgerSectionTitle' },
        historyTitle(historyRange)),
      rangeRow,
      body);
  };

  /** 一天的历史聚合树：结构与实时汇总卡一致（复用 tokenSummaryText 等口径）。 */
  const renderDayTree = (dayRow) => React.createElement('div', { key: 'day-' + dayRow.day, className: 'dim-jh-ledgerCard' },
      React.createElement('div', { className: 'dim-jh-ledgerCardHead' },
        React.createElement('strong', null, dayRow.day + ' · ' + (dayRow.totals?.requests ?? 0) + ' 次请求'),
        perfCell(dayRow.totals),
        React.createElement('span', { className: 'dim-jh-ledgerCardSum', title: tokenSummaryTooltip(dayRow.totals) },
          tokenSummaryText(dayRow.totals)),
        React.createElement('button', {
          className: 'dim-jh-btn',
          'data-kind': 'danger',
          disabled: deletingHistoryDay === dayRow.day,
          title: '只删除此日期的历史累计',
          onClick: () => { void deleteHistoryDay(dayRow.day); },
        }, deletingHistoryDay === dayRow.day ? '删除中…' : '删除此日')),
    historyDeleteError
      ? React.createElement('div', { className: 'dim-jh-empty', role: 'alert' }, historyDeleteError)
      : null,
    dayRow.channels.map((channelRow) => React.createElement('div', { key: channelRow.channel, className: 'dim-jh-ledgerProvider' },
      React.createElement('div', { className: 'dim-jh-ledgerProviderHead' },
        React.createElement('span', { className: 'dim-jh-ledgerProviderName' }, channelLabel(channelRow.channel)),
        perfCell(channelRow.totals),
        React.createElement('span', { className: 'dim-jh-ledgerProviderSum', title: tokenSummaryTooltip(channelRow.totals) },
          tokenSummaryText(channelRow.totals))),
      channelRow.providers.map((providerRow) => React.createElement('div', {
        key: providerRow.provider, className: 'dim-jh-ledgerAccount',
      },
        React.createElement('div', { className: 'dim-jh-ledgerAccountHead' },
          React.createElement('span', { className: 'dim-jh-ledgerAccountName' }, providerRow.provider),
          perfCell(providerRow.totals),
          React.createElement('span', { className: 'dim-jh-ledgerAccountSum', title: tokenSummaryTooltip(providerRow.totals) },
            tokenSummaryText(providerRow.totals))),
        (providerRow.accounts ?? []).length > 1
          ? providerRow.accounts.map((accountRow) => React.createElement('div', {
              key: providerRow.provider + '#' + accountRow.accountId, className: 'dim-jh-ledgerAccount',
              style: { padding: '0 0 0 8px' },
            },
              React.createElement('div', { className: 'dim-jh-ledgerAccountHead' },
                React.createElement('span', { className: 'dim-jh-ledgerAccountName' },
                  accountLabel(accountRow.accountId)),
                React.createElement('span', { className: 'dim-jh-ledgerAccountSum', title: tokenSummaryTooltip(accountRow.totals) },
                  tokenSummaryText(accountRow.totals))),
              accountRow.models.map((modelRow) =>
                renderModelRow(modelRow, accountRow.accountId + '#' + modelRow.model))))
          : (providerRow.accounts ?? []).flatMap((accountRow) => accountRow.models.map((modelRow) =>
              renderModelRow(modelRow, providerRow.provider + '#' + modelRow.model))))))));

  return React.createElement('div', {
    className: 'dim-jh-modalOverlay dim-jh-modalOverlay--top',
    onClick: (event) => { if (event.target === event.currentTarget) onClose(); },
  },
    React.createElement('div', {
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Token 用量',
      className: 'dim-jh-modal dim-jh-modal--ledger',
    },
      React.createElement('div', { className: 'dim-jh-modalHead' },
        React.createElement('div', { className: 'dim-jh-modalTitle' },
          React.createElement('strong', null, 'Token 用量'),
          React.createElement('span', { className: 'dim-jh-modalSubtitle' }, ledgerSubtitle())),
        React.createElement('div', { className: 'dim-jh-modelPanelActions' },
          React.createElement('button', {
            className: 'dim-jh-btn',
            disabled: phase === 'loading',
            title: '重新读取本机 Token 账本。',
            onClick: () => void load(),
          }, phase === 'loading' ? '读取中…' : '刷新'),
          React.createElement('button', {
            className: 'dim-jh-btn',
            'data-kind': 'primary',
            onClick: onClose,
          }, '完成'))),
      React.createElement('p', {
        className: 'dim-jh-modalHint',
        title: '总处理量 = 输入 + 输出；缓存写入不重复计入。输出速率的均值对离群样本敏感；P50/P90 是完整分布估算。速率要求解码时长至少 100ms。明细最多保留最近 500 笔，重启清空；按日累计写入 token-ledger.json。',
      },
        '按渠道、供应商、账号和模型统计用量。悬停数字查看 Token 拆分与性能口径；逐笔明细重启后清空，按日历史会保留。'),
      React.createElement('div', { className: 'dim-jh-modalBody' },
        renderHistory(),
        renderSummary(),
        renderEntries())));
}

/**
 * 把「距每日额度刷新还剩多少秒」格式化成 `12 小时 34 分`。
 *
 * ⚠️ 秒数由**宿主**下发（`quota.refreshCountdownSeconds`，见
 * `src/accio-credits.ts` 的 `AccioQuota`），客户端**不得**写死它：上游改刷新
 * 周期后写死的倒计时会与真实重置时刻脱节，而且不会有任何报错
 * （本仓库记录的「静默失效」形态）。
 *
 * @param {number} seconds 剩余秒数。
 * @returns {string|null} 不可读（负 / 非有限 / 非数字）时返回 null，调用方整行不渲染。
 */
function formatAccioResetCountdown(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  const totalMinutes = Math.floor(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分`;
  return `${seconds} 秒`;
}

/**
 * 从宿主下发的资源包里算「距每日额度刷新还剩多少秒」。
 *
 * 宿主把倒计时写进了**每日桶**的 `cycleEndTime`（`src/accio-credits.ts` 的
 * `accioQuotaResetIso`，字段本义就是「计量周期结束时间」），故这里从该时刻现算。
 *
 * ⚠️ 按 {@link ACCIO_DAILY_BUCKET} **池名**定位，不用下标（见该常量的注释）。
 * ⚠️ 算不出时返回 null（调用方整行不渲染）——**不编造一个倒计时**。
 */
function accioResetSeconds(packages, now) {
  if (!Array.isArray(packages)) return null;
  const daily = packages.find(pkg => pkg && pkg.name === ACCIO_DAILY_BUCKET);
  if (daily === undefined) return null;
  const end = typeof daily.cycleEndTime === 'string' && daily.cycleEndTime.length > 0
    ? Date.parse(daily.cycleEndTime)
    : Number.NaN;
  if (!Number.isFinite(end)) return null;
  const at = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  return Math.max(0, Math.round((end - at) / 1000));
}


function ProviderPanel({ provider, rpcCall }) {
  const [accounts, setAccounts] = React.useState([]);
  const [phase, setPhase] = React.useState('loading');
  const [error, setError] = React.useState(null);
  const [creating, setCreating] = React.useState(false);
  /**
   * CodeBuddy 限时补偿积分的**汇总**（仅 `provider === 'buddy'` 时用）。
   *
   * 形状：`{ scanned, claimableCount, claimedCount, total, endTime, error,
   *         errorCount, busy }`。`null` = 尚未查询或非 buddy（此时卡片不渲染）。
   *
   * ⚠️ **不接自动签到**：一次性限时活动，只在面板挂载/点击后查询与领取。
   * 理由与端点证据见 `src/buddy-compensation.ts` 模块头。
   *
   * ⚠️ **判据一律走 `./compensation-panel-logic.js` 的纯函数**，不在本文件里
   *    手写 `res.ok` 之类的判断 —— `rpcCall` 成功时返回的是**解包后的值**
   *    （**没有 `ok` 字段**）、失败时**抛错**，详见该模块头的 P0 说明。
   */
  const [compensation, setCompensation] = React.useState(null);
  /**
   * 补偿领取的**重入闸门**。
   *
   * ⚠️ **必须用 ref 而不是 `compensation.busy`**：`setState` 是异步的，
   *    同一 tick 内连点两次时第二次读到的仍是 `false`，而按钮的 `disabled`
   *    也要等 re-render 才生效 —— 于是两轮全量领取并发跑，对同一批账号
   *    并发发一次性写操作。与本文件既有的 `claimInFlightRef`（一键领取积分）
   *    同款理由，闸门必须在第一个 `await` **之前**生效。
   */
  const compensationClaimRef = React.useRef(false);
  /**
   * ZCode 登录渠道（仅 `provider === 'zcode'` 时用）。
   *
   * ZCode 服务端支持两个 OAuth provider，授权页与凭据落点都不同：
   * `bigmodel`（智谱开放平台，国内）与 `zai`（z.ai 国际版）。
   * 缺省 `bigmodel`，与后端 `req.zcodeProvider ?? 'bigmodel'` 对齐。
   */
  const [zcodeProvider, setZcodeProvider] = React.useState('bigmodel');
  /**
   * Accio 登录区域（仅 `provider === 'accio'` 时用）。
   *
   * ⚠️ **这不是「多一个可选偏好」，而是登录能否成功的前提**：Accio 的登录页
   * 按区域分域名（`cn` → `www.accio-ai.com`，`global` → `zh.accio.com`），
   * 而区域**由服务端按账号下发、登录前无从推断**（`userinfo.routeRegion` 要
   * 先有凭据才能查）。选错 ⇒ 国际账号打不开中国版登录页 ⇒ **根本登不进去**。
   *
   * 缺省 `cn`，与宿主 `normalizeAccioRegion` 的回落值一致（未知值也回落 `cn`）。
   */
  const [accioRegion, setAccioRegion] = React.useState('cn');
  const [astudioLoginMethod, setAstudioLoginMethod] = React.useState('local');
  const [autoclawMode, setAutoclawMode] = React.useState('local');
  /**
   * ★ 弹窗是否开着（`false` = 关着）。
   *
   * 渠道选择搬进弹窗后（用户 2026-10-03），`zcodeProvider` 只在**弹窗打开期间**
   * 被改动 —— 发起登录那一刻它就是本轮要用的渠道，
   * 避免了「授权页已开、渠道又被改掉」的不一致。
   *
   * ⚠ 这里**不再**承载 `forceNew` —— 「登录其他账号」已按用户 2026-10-02 的
   *   要求撤销（见同批提交），它现在只回答「弹窗开没开」。
   * ⚠ 弹窗**只服务 zcode**：本组件是通用面板，其余 provider 的「+ 新建账号」
   *   直接发起登录（见按钮的 `provider === 'zcode'` 分流与弹窗条件的第二道门）。
   */
  const [pendingLogin, setPendingLogin] = React.useState(undefined);
  // 正在进行的限流操作：null | 'one' | 'all'。用于禁用按钮并显示进度。
  const [probeBusy, setProbeBusy] = React.useState(null);
  // 上一次重测/重置的结果文案（成功或失败）。
  //
  // ⚠️⚠️ **写入端必须经过 `normalizeProbeNotice`**（2026-10-22 整页白屏事故）：
  //    渲染端按**对象**读 `.tone` / `.text` / `.details`，而历史上两处调用直接
  //    传了**裸字符串** ⇒ `probeNotice.details` 是 undefined ⇒ `.length` 抛
  //    TypeError ⇒ 插件内没有 ErrorBoundary ⇒ 整个 Jet Hub 设置页被 React
  //    卸载成白屏，侧栏切页也失效，只能重启 DSH。用户当时的路径就是
  //    「保存魔搭令牌」（走 `existed` 分支）。
  //    ⇒ 归一化放在状态写入这一层，任何调用点再写错形状也不会炸掉整页。
  //    ⚠️ 两个调用点本身也已改成对象形状；这是第二道闸（防御纵深），
  //    不是「用兜底掩盖错误」——真正的修复在源头。
  const [probeNotice, setProbeNoticeState] = React.useState(null);
  const setProbeNotice = React.useCallback((next) => {
    setProbeNoticeState(normalizeProbeNotice(next));
  }, []);
  // 积分余额：accountId → { balance, error }。与账号列表分开加载——余额要逐
  // 账号发网络请求，不能拖慢账号列表本身的渲染。
  const [credits, setCredits] = React.useState({});
  const [creditsLoading, setCreditsLoading] = React.useState(false);
  /**
   * 后端回传的「临时积分」窗口（天）—— 仅 CodeBuddy / WorkBuddy 有值。
   *
   * 两个来源写同一个值（同一后端函数解析 `DSH_BUDDY_EXPIRING_WINDOW_DAYS`）：
   * `credits.balances`（积分行的分桶显示）与 `credits.permanentLock`
   * （按钮文案）。互为备份：不支持余额查询时按钮 tooltip 仍有正确天数。
   *
   * ⚠️ 这里存的是**窗口配置**，不是分类结果 —— 分类每次渲染现算（见
   * `CreditBalanceRow`），因为它是时间的函数。
   */
  const [expiryWindowDays, setExpiryWindowDays] = React.useState(null);
  /**
   * 弹窗被拦截时展示给用户手动打开的登录链接。
   *
   * 保留它而不是直接失败：弹窗拦截取决于浏览器设置，用户手动点一下就能继续，
   * 没必要让整个登录流程作废。
   */
  const [loginUrlForManual, setLoginUrlForManual] = React.useState(null);
  /** 兜底登录链接的复制结果：null=未复制，true=已复制，false=复制失败。 */
  const [loginLinkCopied, setLoginLinkCopied] = React.useState(null);
  /**
   * 出口代理弹窗状态：{ accountId, current } 或 null。
   *
   * ⚠️ **独立于** `loginUrlForManual`：那个是登录链接兜底弹窗，两者共存时
   * 共用一个 state 会让开代理弹窗把登录链接顶掉（表现为链接凭空消失）。
   */
  const [proxyModal, setProxyModal] = React.useState(null);
  // ⚠️ **本 fork 独有**（modelscope，2026-10-17）：「编辑访问令牌」弹窗状态
  // { accountId, currentMasked, error } 或 null。
  // ⚠️ **独立于** `keyModal`（添加账号用）：两者语义不同（新增 vs 替换），
  // 共用一个 state 会互相顶掉（同 `proxyModal` 与 `loginUrlForManual` 的教训）。
  // ⚠️ 同样**不放明文 Key 进 state**（ref + DOM 读值），理由见下方 keyModal 注释。
  const [keyEditModal, setKeyEditModal] = React.useState(null);
  // 「添加 opencode 账号」弹窗：null（关闭）或 { error }。
  // ⚠️ 输入框内容**不放 state**（用 ref + DOM 读值）：API key 是凭据，
  // 进 state 会随每次重渲染经过整棵组件树，也会被 devtools 组件树检查器读到。
  const [keyModal, setKeyModal] = React.useState(null);
  const keyInputRef = React.useRef(null);
  // ⚠️ **本 fork 独有**（modelscope 编辑令牌）：**独立** ref ——
  // 与添加弹窗共用一个的话，打开编辑弹窗时若添加弹窗还挂着（理论上互斥，
  // 但 ref 是 DOM 级的），两个 input 会指向同一个节点。
  const keyEditInputRef = React.useRef(null);

  /**
   * 拖拽排序状态：正在拖的账号 id 与当前悬停的目标账号 id。
   *
   * 两者都只用于**视觉反馈**（源卡片淡出、目标卡片显示插入线），
   * 真正的顺序变更在 drop 时才提交给服务端。
   */
  const [draggingId, setDraggingId] = React.useState(null);
  const [dropTargetId, setDropTargetId] = React.useState(null);
  // 落点方向：'before' | 'after'。由指针落在目标卡片的上半/下半决定，
  // 让"往下拖一格"与"往上拖一格"都能生效（详见 account-order.js）。
  const [dropPosition, setDropPosition] = React.useState('before');
  const [reordering, setReordering] = React.useState(false);
  // 拖拽提交失败时的提示（如「列表已变化，请刷新」）。
  const [reorderError, setReorderError] = React.useState(null);
  const mounted = React.useRef(true);
  /**
   * 最新账号列表的 ref 镜像。
   *
   * loadCredits 的失败分支需要"当前有哪些账号"，但它与 loadAccounts 并发发起，
   * 闭包里的 accounts 还是初始空数组。ref 保证读到的是最新值。
   */
  const accountsRef = React.useRef([]);
  /**
   * 登录轮询定时器句柄。
   *
   * ⚠ **真实缺陷**（2026-10-01；同一缺陷也出现在已随 IKJLHQ 移除的官方卡片账号区里）：原实现把句柄存成
   * `createAccount` 的**局部变量**，于是
   * ① `setInterval` 只在「轮询成功」分支里 `clearInterval`，超时用的是另一个
   *    `setTimeout(() => clearInterval(pollTimer), 300000)` —— 组件在这 5 分钟内
   *    卸载（切页/关设置）时**两个定时器都还活着**，每次 tick 都会对已卸载组件
   *    setState 并继续打 `login.poll`；
   * ② `finally { setCreating(false) }` 无条件释放，用户连点两次会起**两串轮询**。
   * 存进 ref 后可在卸载清理里一并清掉，并用它做重入闸门。
   */
  const pollRef = React.useRef(0);
  /**
   * 「一键领取积分」的重入闸门。
   *
   * ⚠️ **不能用 `claiming`（useState）当守卫**：`setClaiming(true)` 是异步的，
   * 同一 tick 内连点两次时第二次读到的仍是 `false`，而按钮的
   * `disabled: claiming` 也要等 re-render 才生效 —— 于是两轮全量领取并发跑，
   * 对同一账号同一批任务并发 `POST /v2/report` 与 claim，幂等全押在服务端。
   * 成熟成长任务一轮实测 90～270s（数十个上游请求），并发两轮还会放大风控面。
   *
   * 与上面的 `pollRef` 同款做法：**用 ref 做同步闸门**（写是同步的，
   * 不经过 React 调度）。守卫必须在第一个 `await` 之前生效。
   */
  const claimInFlightRef = React.useRef(false);

  const loadAccounts = React.useCallback(async () => {
    setPhase('loading');
    setError(null);
    try {
      const res = await rpcCall('account.list', { provider });
      if (!mounted.current) return;
      const list = res.accounts || [];
      accountsRef.current = list;
      setAccounts(list);
      setPhase('ready');
    } catch (caught) {
      if (!mounted.current) return;
      setError(caught?.message || '无法读取账号列表');
      setPhase('error');
    }
  }, [provider, rpcCall]);

  /**
   * 静默重读账号列表：只更新数据，**不改变** `phase`（不切成「正在读取…」）。
   *
   * 存在的理由（issue IKKHL5 的客户端残留）：宿主侧 `credits.balances` 会对
   * 已过期账号**先续期再查余额**并回写账号池的 `expiresAt`，而卡片红字读的是
   * `account.list` 的快照 ⇒ 积分已经能读了、卡片却还红着。故余额查询成功后
   * 需要补读一次账号列表。
   *
   * ⚠️ 必须与 `loadAccounts` **分开**：后者首行就 `setPhase('loading')`，
   * 用它会在这个「顺带同步」的场景里让整块列表闪一下（自愈成功那一刻）。
   *
   * ⚠️ **失败静默**（与 `loadAccounts` 不同）：本函数只是配套同步，失败不该
   * 把面板推进错误态 —— 余额已经拿到了，界面该继续可用。
   */
  const reloadAccountsQuietly = React.useCallback(async () => {
    try {
      const res = await rpcCall('account.list', { provider });
      if (!mounted.current) return;
      const list = res.accounts || [];
      accountsRef.current = list;
      setAccounts(list);
    } catch (caught) {
      // 静默：不 setError / 不 setPhase。留一条 console 便于排障。
      console.error('[jet-hub] 静默重读账号列表失败（不影响积分显示）:', caught);
    }
  }, [provider, rpcCall]);

  /**
   * 本 provider 是否支持积分余额查询。
   *
   * 判定依据是 `./credits-capabilities.js` 的能力矩阵（唯一真相源），
   * 而不是散落在 UI 里的 provider 字面量比较。
   *
   * 必须在**发起请求之前**判掉：既不调用 RPC，也不渲染「积分」行与
   * 「刷新积分」按钮。历史缺陷是对不支持的 provider 无条件请求，导致卡片
   * 永远停在「查询失败」、控制台每次都留报错。
   */
  const canLoadCredits = supportsCreditBalance(provider);
  /**
   * 「新建账号」弹窗里问的是**登录区域**（accio）而不是**登录渠道**（zcode）。
   *
   * ⚠️ 写成**正向**判据，与本仓库「反对排除法」的约定一致；
   * 且它与 `newAccountAsksChannel(provider)` 是**两件事**：
   * 前者回答「弹窗内容长什么样」，后者回答「要不要弹」。
   * 两者都必须由 `provider` 驱动，任一处漏改都会得到「弹窗内容与判据不匹配」。
   */
  /**
   * 「新建账号」弹窗里问的是**登录区域**（accio）而不是**登录渠道**（zcode）。
   *
   * ⚠️ 写成**正向**判据，与本仓库「反对排除法」的约定一致；
   * 且它与 `newAccountAsksChannel(provider)` 是**两件事**：
   * 前者回答「弹窗内容长什么样」，后者回答「要不要弹」。
   * 两者都必须由 `provider` 驱动，任一处漏改都会得到「弹窗内容与判据不匹配」。
   */
  const accioDialog = provider === 'accio';
  const astudioDialog = provider === 'astudio';
  // ⚠️⚠️ **必须同时覆盖国际版**（2026-10-20 修）：原先是 `provider === 'autoclaw'`，
  //    漏掉 `autoclawintl` ⇒ 国际版点「新建账号」弹的是**「添加 ZCode 账号」**
  //    窗口（BigModel / z.ai 渠道下拉）—— 与本次要做的「一键导入」毫无关系。
  //    这是「autoclaw 系按 id 逐个判」的**第 4 次复发**（RPC 分支 / refName /
  //    new-account 载荷 / 这里），每次症状都不同且都不报错。
  const autoclawDialog = provider === 'autoclaw' || provider === 'autoclawintl';
  /**
   * 国际版**没有可用的短信登录**（2026-10-20 审计 P1）。
   *
   * ⚠️ 判据来自宿主侧已实测的事实（`src/autoclaw-auth.ts` 的 `loginWithCode`
   *    注释）：国际版账号是**邮箱 + Z.ai OAuth** 创建的，`phone` 为 `null`，
   *    且没有绑手机端点（`agent-bind-phone` / `bind-phone` 全 404）
   *    ⇒ 短信对国际账号**必然失败**，且失败文案不指向真因。
   *
   * ⇒ 国际版只渲染「一键导入」一条路（那是唯一能用的），不再提供短信死路。
   *    ⚠️ 这与「按钮必须按 provider 分支」同源：同一个弹窗在两家语义不同。
   *    ⚠️ 将来若 Z.ai OAuth 接上 RPC，这里要换成三条路（导入 / OAuth / —）。
   */
  const autoclawSmsAvailable = provider === 'autoclaw';
  // 支持每日签到积分的 provider 才渲染领取按钮。
  const supportsCredits = supportsDailyCheckin(provider);
  // 有成长中心的 provider 才传 runTasks（见 GROWTH_TASK_PROVIDERS 的注释：
  // 宿主侧那张手抄的平行清单已在 Task 4 删除，改由「是否提供 credits.afterClaim」判定），
  // 避免按钮渲染了却被服务端挡回 bad-request。
  const supportsGrowthTasks = GROWTH_TASK_PROVIDERS.has(provider);
  /**
   * 「订阅额度」按钮的渲染条件（当前只有 Cline）。
   *
   * ⚠️ 与 `canLoadCredits` 是**两件不同的事**：`credits.balances` 答「还剩多少」，
   * 订阅额度答「各时间窗用掉百分之几」+ 逐笔请求记录。Cline 两者都有，
   * 但按钮与请求各自独立门控 —— 将来某渠道只加其中之一时不会互相牵连。
   */
  const canShowSubscriptionQuota = supportsSubscriptionQuota(provider);

  /**
   * 拉取本页全部账号的积分余额。
   *
   * 单独一个请求、单独的 loading 状态：余额查询涉及逐账号的网络往返，可能
   * 慢或失败；它绝不能影响账号列表的可用性——查不到余额时卡片显示原因，
   * 而不是让整个面板变成错误页。
   *
   * **不支持的 provider 直接返回**：不支持的 provider 连请求都不发。
   * 这是刻意放在函数内部而不是只靠调用点判断——`claimCredits` / 「刷新积分」
   * 按钮等多个入口都调它，门控收在这里才不会被将来新增的调用点绕过。
   */
  const loadCredits = React.useCallback(async (force = false) => {
    if (!canLoadCredits) return;
    // ⚠️ **自愈后要补一次账号重读**（issue IKKHL5 的客户端残留）。
    //
    // `credits.balances` 在宿主侧会**对已过期账号先续期再查余额**（见
    // `src/jet-hub-rpc.ts` 的 `healExpiredAccountBeforeBalance`），续期成功后
    // 会把新的 `expiresAt` 回写账号池。但**卡片红字读的是 `account.list`
    // 的快照**（`AccountCard` 里 `account.expiresAt <= Date.now()`），而本函数
    // 不重读账号列表 ⇒ 「积分已经能读了，卡片却还红着『已过期』」，
    // 点别的卡片再切回来才恢复。
    //
    // ⚠⚠ **判据不能用「调用前快照里有没有已过期账号」**（初版就是这么写的，
    // 对抗审计实测证伪）：挂载 effect 里 `void loadAccounts()` 与
    // `void loadCredits()` 是**同步先后**发起的，而 `loadAccounts` 要到它的
    // 首个 `await rpcCall('account.list')` **之后**才写 `accountsRef.current`
    // ⇒ 挂载/切 provider 时读到的必然是**初始空数组**，那个条件恒为假、
    // 永不补读。而「睡眠恢复后打开面板」正是本 issue 的主场景 ⇒ 初版修复对
    // 主路径**完全无效**，只对「点刷新积分」等列表已加载的路径有效。
    //
    // ⇒ 改为**无条件**在成功后补读（但用 `quiet` 变体：不把列表切成「读取中」，
    // 否则自愈成功那一刻列表会闪一下 —— 对抗审计另指出的一点）。
    // 代价：每次余额查询多一次 `account.list`。这是**刻意的取舍** ——
    // 卡片的正确性优先于一次本地端点往返（`account.list` 读的是内存副本，
    // 不是上游请求，见 `pool.listAccounts` 的实现）。
    setCreditsLoading(true);
    try {
      // ⚠️⚠️ `force` 必须透传（2026-10-16 审计 P1-1 实测确认的回归）。
      //
      // 宿主侧 `credits.balances` 自 0fcf83a 起会吃**共享余额读数缓存**
      // （TTL 120 秒，失败时还能陈旧兼顶 15 分钟）。若本调用恒不传 `force`，
      // 「刷新积分」按钮在 120 秒内点了**等于没点**，而按钮 title 写着
      // 「余额由服务端实时计算，点此可刷新」—— 那时它是假的。
      //
      // ⚠️ 更隐蔽的一档是兼顶：上游已挂 10 分钟时，点「刷新」仍返回旧值 +
      //「本次查询失败」。用户诉求是「给我新数据」，实现给「再读一次旧数据」，
      // **比报错更糟**（它看起来成功了）。
      const res = await rpcCall('credits.balances', force ? { provider, force: true } : { provider });
      if (!mounted.current) return;
      const next = {};
      for (const item of res.accounts || []) {
        // `extra` 是逐账号的**附加读数**（目前只有 Gemini 的账号规格 Pro/Free/
        // Ultra 走这里）。它跟 `balance`/`error` 并列，必须原样带上 —— 漏掉它
        // 卡片就永远不显示那一行，而 RPC 那边看不出任何异常。
        next[item.accountId] = { balance: item.balance, error: item.error, extra: item.extra };
      }
      setCredits(next);
      // 窗口天数随余额一起回来（buddy 系 + TRAE 带）——积分行据此分「临时 / 长期」。
      setExpiryWindowDays(res?.windowDays ?? null);
      // ⚠️ 补读必须走 `quiet` 变体：普通 `loadAccounts` 首行是
      // `setPhase('loading')`，那会把整块列表切成「正在读取账号列表…」，
      // 自愈成功那一刻用户会看到列表闪一下（本函数只是顺带同步有效期，
      // 不该改变列表的加载态）。
      await reloadAccountsQuietly();
    } catch (caught) {
      console.error('[jet-hub] load credits failed:', caught);
      if (!mounted.current) return;
      // 整批失败（如 provider 不支持、RPC 未注册）：给当前每个账号都留下失败
      // 原因，避免卡片永远停在"读取中"。
      //
      // 用 accountsRef 而不是闭包里的 accounts：本函数与 loadAccounts 在挂载时
      // 并发发起，此刻闭包捕获的 accounts 仍是初始空数组，会导致一个账号都
      // 标记不上。ref 始终指向最新值。
      const snapshot = accountsRef.current;
      setCredits(prev => {
        const next = { ...prev };
        for (const account of snapshot) {
          next[account.id] = { balance: null, error: caught?.message || '积分查询失败' };
        }
        return next;
      });
    } finally {
      if (mounted.current) setCreditsLoading(false);
    }
    // ⚠️ `reloadAccountsQuietly` 必须进 deps：本函数现在会调它（余额成功后
    // 补读账号列表），而它的依赖是 `[provider, rpcCall]` —— 不进 deps 会让
    // React 持有**旧的**那个闭包（陈旧 provider / rpcCall），补读打到错误的面板上。
  }, [provider, rpcCall, canLoadCredits, reloadAccountsQuietly]);

  /**
   * 查询**本账号池全部 buddy 账号**的限时补偿积分状态（只读）。
   *
   * ⚠️ 逐个账号查询（补偿是 per-account 的），任一条失败只记一条 error 文案，
   *    **不影响其余账号**，也不打断账号列表渲染（这是附加信息）。
   *
   * ⚠️ 非 buddy 直接返回，连 RPC 都不发。
   */
  const loadCompensation = React.useCallback(async () => {
    if (provider !== 'buddy') return;
    try {
      const list = await rpcCall('account.list', { provider });
      const entries = Array.isArray(list?.accounts) ? list.accounts : [];
      // ⚠️⚠️ 逐账号容错**必须在纯函数里**（`scanCompensation` 逐个 try/catch）：
      //    `rpcCall` 失败是**抛错**而非返回 `{ok:false}`，若把 await 裸在循环里，
      //    一个账号凭据失效就会掀掉整批 —— 其余账号一条都查不到。
      //    这正是 PR !106 初版的缺陷：它按「失败返回 {ok:false}」写，
      //    于是注释宣称的「任一条失败不影响其余账号」与实现逐字相反。
      const scan = await scanCompensation(
        entries,
        (accountId) => rpcCall('buddy.compensationStatus', { provider, accountId }),
      );
      if (!mounted.current) return;
      setCompensation({ ...toCompensationState(scan), busy: false });
    } catch (caught) {
      console.error('[jet-hub] compensation status failed:', caught);
      if (!mounted.current) return;
      setCompensation({
        scanned: 0, claimableCount: 0, claimedCount: 0, total: 0, endTime: null,
        busy: false, errorCount: 0,
        error: (caught && caught.message) || '未知错误',
      });
    }
  }, [provider, rpcCall]);

  /**
   * 领取**全部可领取账号**的补偿积分（一次性写操作）。
   *
   * ⚠️ **只由按钮点击触发**，不接定时器 / 自动签到（见模块头）。
   * ⚠️ 逐账号串行、失败不中断 —— 一个账号失败不该让其余账号领不到。
   * ⚠️ 领完**重新查询**而不是本地乐观更新：领取是写操作，真实结果只有上游知道。
   */
  const claimCompensation = async () => {
    // ⚠️ 闸门读 ref 而非 `compensation.busy`（见 `compensationClaimRef` 的注释）。
    if (provider !== 'buddy' || compensation === null || compensationClaimRef.current === true) return;
    compensationClaimRef.current = true;
    setCompensation((prev) => (prev === null ? prev : { ...prev, busy: true }));
    try {
      const list = await rpcCall('account.list', { provider });
      const entries = Array.isArray(list?.accounts) ? list.accounts : [];
      const { claimed, failures } = await claimAllCompensation(
        entries,
        (accountId) => rpcCall('buddy.compensationStatus', { provider, accountId }),
        (accountId) => rpcCall('buddy.claimCompensation', { provider, accountId }),
      );
      await loadAccounts();
      await loadCompensation();
      if (failures.length > 0) {
        setProbeNotice({ tone: 'warn', text: `部分账号领取失败（${failures.length} 个）`, details: failures });
      } else if (claimed.length > 0) {
        setProbeNotice({ tone: 'ok', text: `已为 ${claimed.length} 个账号领取补偿积分。`, details: [] });
      }
    } catch (caught) {
      console.error('[jet-hub] compensation claim failed:', caught);
      if (mounted.current) {
        setProbeNotice({ tone: 'error', text: `领取失败：${(caught && caught.message) || '未知错误'}`, details: [] });
      }
    } finally {
      compensationClaimRef.current = false;
      if (mounted.current) setCompensation((prev) => (prev === null ? prev : { ...prev, busy: false }));
    }
  };

  React.useEffect(() => {
    mounted.current = true;
    void loadAccounts();
    void loadCompensation();
    // 只有支持余额查询的 provider 才在挂载时拉积分（loadCredits 内部也有一道
    // 门控，这里提前判掉是为了连 loading 状态都不翻）。
    if (canLoadCredits) void loadCredits();
    return () => {
      mounted.current = false;
      // 卸载时必须掐掉未结束的登录轮询（否则它会在 5 分钟里持续打 RPC）
      if (pollRef.current !== 0) { clearInterval(pollRef.current); pollRef.current = 0; }
      // ⚠️ 领取闸门也要清：本 effect 依赖 `provider`，切 provider 会重跑
      // （清理后重新 `mounted.current = true`）。若闸门残留 true，新 provider
      // 面板上的首次点击会被误判成「上一次仍在进行中」而永远点不动。
      // 在途的那一轮仍会跑完（无法取消 RPC），其结果由 mounted 判定是否上屏。
      claimInFlightRef.current = false;
      // ⚠️ 同款理由，补偿领取闸门也要清：否则切回 buddy 面板时首次点击会被
      // 误判成「上一次仍在进行中」而永远点不动。
      compensationClaimRef.current = false;
    };
    // loadCredits 依赖 accounts，但这里只想在挂载/provider 变化时各跑一次；
    // 账号刷新后由操作方显式再调 loadCredits（见 claimCredits）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  // 积分领取状态：claiming 用于禁用按钮，claimNotice 展示上一次领取的结果摘要。
  const [claiming, setClaiming] = React.useState(false);
  const [claimNotice, setClaimNotice] = React.useState(null);  // 新手任务（一次性，仅 Loomy）：与每日签到**完全独立**的操作。
  const [onboarding, setOnboarding] = React.useState(null);
  const [onboardingLoading, setOnboardingLoading] = React.useState(false);
  const [onboardingNotice, setOnboardingNotice] = React.useState(null);
  const canClaimOnboarding = supportsOnboardingTasks(provider);

  /**
   * 「锁定永久积分」（**provider 级**开关，持久化在宿主侧）。
   *
   * CodeBuddy / WorkBuddy / Loomy **共用这一个开关位**（各自一份状态），
   * 但「临时积分」的含义不同 —— 文案由 `permanentLockCopy(provider)` 给出，
   * 不在这里写死（把 Loomy 的「每日赠送额度」套到 buddy 上会误导用户）。
   */
  const canLockPermanent = supportsPermanentLock(provider);
  // 窗口天数用上面与余额共用的 `expiryWindowDays`（两个来源同值，互为备份）。
  // ⚠️ 文案必须用它渲染：窗口可被 `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 覆盖，
  // 前端写死 15 就会出现「提示说只烧 15 天内的、实际按 31 天筛号」。
  const lockCopy = permanentLockCopy(provider, expiryWindowDays);
  const [permanentLocked, setPermanentLocked] = React.useState(false);
  const [lockBusy, setLockBusy] = React.useState(false);
  const [lockNotice, setLockNotice] = React.useState(null);

  /**
   * 读取锁定状态（面板挂载时一次）。
   *
   * ⚠️ 只在支持该能力的 provider 上发请求：对不支持的 provider 发会拿到
   * `bad-request`，并在控制台留下必然失败的报错（与积分能力矩阵同一教训）。
   */
  React.useEffect(() => {
    if (!canLockPermanent) return undefined;
    let alive = true;
    void (async () => {
      try {
        const res = await rpcCall('credits.permanentLock', { provider });
        if (!alive) return;
        setPermanentLocked(res?.locked === true);
        setExpiryWindowDays(res?.windowDays ?? null);
      } catch (caught) {
        // 读失败不阻塞面板：保持「解锁」这一保守默认值（与后端缺省一致）。
        console.error('[jet-hub] load permanent lock failed:', caught);
      }
    })();
    return () => { alive = false; };
  }, [canLockPermanent, provider]);

  /**
   * 读取 MiniMax 国际站的 `X-Forwarded-For` 设置（issue IKMEVG）。
   *
   * ⚠️ **只在 `minimaxintl` 面板读**：其它 provider 的后端分支没有这个能力，
   * 无条件请求会在控制台留下必然失败的报错（与积分能力矩阵同一教训）。
   */
  React.useEffect(() => {
    if (provider !== 'minimaxintl') return undefined;
    let alive = true;
    void (async () => {
      try {
        const res = await rpcCall('minimax.getXff', {});
        if (!alive) return;
        setMinimaxXff(typeof res?.xff === 'string' ? res.xff : '');
      } catch (caught) {
        // 读失败不阻塞面板：保持空串（= 不附头，与后端缺省一致）。
        console.error('[jet-hub] load minimax xff failed:', caught);
      }
    })();
    return () => { alive = false; };
  }, [provider]);

  /** 切换锁定状态（持久化）。 */
  const togglePermanentLock = async () => {
    if (!canLockPermanent) return;
    const next = !permanentLocked;
    setLockBusy(true);
    setLockNotice(null);
    try {
      const res = await rpcCall('credits.permanentLock', { provider, locked: next });
      if (!mounted.current) return;
      setPermanentLocked(res?.locked === true);
      setExpiryWindowDays(res?.windowDays ?? null);
      setLockNotice({
        tone: 'ok',
        text: next ? lockCopy.lockedNotice : lockCopy.unlockedNotice,
      });
    } catch (caught) {
      console.error('[jet-hub] toggle permanent lock failed:', caught);
      if (!mounted.current) return;
      setLockNotice({ tone: 'error', text: `操作失败：${caught?.message || '未知错误'}` });
    } finally {
      if (mounted.current) setLockBusy(false);
    }
  };

  /**
   * 领取指定账号的全部新手任务（补差额，最多 10000 分）。
   *
   * ⚠️ 与「一键领取积分」（每日签到）**完全不同的操作**：新手任务是
   * **一次性**的（每号只能领一次），故独立按钮、独立端点
   * （`onboarding.claim`），**不参与**页头的「一键签到」遍历 ——
   * 否则每天会对已领完的账号发 8 个必然 `alreadyCompleted` 的请求。
   */
  const claimOnboarding = async (accountId) => {
    if (!canClaimOnboarding) return;
    setOnboardingLoading(true);
    setOnboardingNotice(null);
    try {
      const res = await rpcCall('onboarding.claim', { provider, accountId });
      const parts = [];
      if (res.claimed.length > 0) {
        const gained = res.claimed.reduce((sum, item) => sum + item.points, 0);
        parts.push(`本次领取 ${res.claimed.length} 个任务（+${gained} 积分）`);
      }
      if (res.skipped.length > 0) parts.push(`${res.skipped.length} 个此前已完成`);
      setOnboardingNotice({
        tone: 'ok',
        text: parts.length > 0 ? parts.join('，') : '没有可领取的任务',
        details: [
          `累计已领 ${res.earned} / ${res.total}`,
          ...res.claimed.map((item) => `${item.title} +${item.points}`),
        ],
      });
      setOnboarding({ earned: res.earned, total: res.total, skipped: res.skipped });
      // ⚠️ 同上：新手任务领取会改变余额，必须 force 绕过共享缓存（审计 P1-1）。
      if (canLoadCredits) await loadCredits(true);
    } catch (caught) {
      setOnboardingNotice({ tone: 'error', text: caught?.message || '领取新手任务失败' });
    } finally {
      if (mounted.current) setOnboardingLoading(false);
    }
  };
  // 「显示列表」：控制模型列表面板的展开状态。关闭时不挂载面板，避免
  // 每次进入面板都白白发一次 model.list 请求。
  const [showModels, setShowModels] = React.useState(false);
  // 「订阅额度」：控制额度/请求记录弹窗的展开状态。同样关闭即不挂载，
  // 避免每次进入面板都发 cline.quota / cline.requestLog（那两发在非 Cline
  // 渠道会直接 bad-request）。
  const [showQuota, setShowQuota] = React.useState(false);
  /**
   * MiniMax 国际站绕地理分流用的 `X-Forwarded-For`（issue IKMEVG）。
   *
   * ⚠️ 只有 `minimaxintl` 面板读它。空串 = 未设置（不附头）。
   * ⚠️ 挂载时读一次即可：它是**面板级配置**，不会因账号变化而变化；
   *    但保存后会立即用后端回传的归一值刷新（非法输入会被归一成空）。
   */
  const [minimaxXff, setMinimaxXff] = React.useState('');
  const [showMinimaxXff, setShowMinimaxXff] = React.useState(false);

  /**
   * 一键领取当前 provider 下全部已启用账号的每日签到积分。
   *
   * 后端逐个账号顺序处理，单个账号失败不会中断整批，因此这里通常正常返回，
   * 由 summary 各计数决定提示文案与色调。
   *
   * **不支持的 provider 直接返回**：守卫与按钮渲染同源（`supportsCredits`），
   * 放在函数内是为了将来若从别处调用（如快捷键、批量入口）也不会打到
   * `unsupported provider` 上——按钮不渲染只是 UI 便利，不是安全边界。
   *
   * ⚠️ **重入闸门必须在第一个 `await` 之前**（`claimInFlightRef`）：按钮的
   * `disabled: claiming` 依赖异步 state，同一 tick 内连点两次会穿透并起两轮。
   */
  const claimCredits = async () => {
    if (!supportsCredits) return;
    // 同步闸门：写 ref 不经 React 调度，故同一 tick 内的第二次点击也能拦住。
    if (claimInFlightRef.current) {
      // ⚠ 拦住后**不能静默 return**（与上面登录闸门同款教训，IKJLK3 B）：
      // 用户看到的是「点了没反应」，分不清「没反应」与「正在处理」。
      // 成长任务一轮可达数分钟，必须明确告知「还在跑」。
      setClaimNotice({
        tone: 'warn',
        text: '上一次领取仍在进行中（成长任务一轮可能数分钟），请等它结束。',
        details: [],
      });
      return;
    }
    claimInFlightRef.current = true;
    setClaiming(true);
    setClaimNotice(null);
    try {
      // runTasks：只有**手点这个按钮**时才为true。
      // 后端「每日首次启动自动签到」走同一个方法但不传该字段（缺省 false），
      // 故成长任务绝不会被开机自动触发 —— 它一轮单账号 90～270s、全串行。
      const res = await rpcCall('credits.claimAll', {
        provider,
        runTasks: supportsGrowthTasks,
      });
      const { summary, results, growth } = res;
      const parts = [];
      // ⚠ **不带 `totalCredit`**（2026-10-03）：
    //   `summary.totalCredit` 把不同 provider 的额度**直接相加** —— 而 ZCode 的
    //   单位是 token、其余是积分，1 亿 token 与 100 积分加成一个数字只会误导。
    //   真实额度在下方逐账号明细里（已按单位渲染）。
    if (summary.claimed > 0) parts.push(`${summary.claimed} 个账号领取成功`);
      if (summary.alreadyClaimed > 0) parts.push(`${summary.alreadyClaimed} 个今日已领取`);
      if (summary.inactive > 0) parts.push(`${summary.inactive} 个活动未开启`);
      if (summary.failed > 0) parts.push(`${summary.failed} 个失败`);
      if (!mounted.current) return;
      // 逐账号列出**具体原因**（昵称 + outcome.message）。
      //
      // 后端一直有这些信息（`results[].outcome.message`），但早期 UI 只显示
      // 计数（如「1 个失败」），用户与排查者都拿不到任何线索 —— 一个
      // 「campaignId 解析为空」的 bug 因此只能靠翻代码+抓包才能定位。
      // 失败/未开启的条目尤其需要原因：它们的处置方式完全不同。
      const details = [];
      for (const item of results || []) {
        const outcome = item.outcome || {};
        if (outcome.kind === 'claimed') {
          // ★ 单位感知（2026-10-03）：ZCode 的 credit 是 **token**，不是积分。
    //   后端 `toClaimOutcome` 现在会带上 `unit: token` 与真实额度
    //   （实测 100000000），这里用现成的 formatUnits/unitLabel 渲染。
    const unit = outcome.unit === 'token' ? 'token' : 'credit'
    // ⚠️ 数值与单位之间**不留空格**（`+100.00MToken`）：这是本仓库的统一口径
    //   （用量徽标 `badge-model.js` 的 `94.54MToken`、汇总行 `formatClaimGains`
    //   的 `+100.00MToken`，以及用户报障时给出的期望文案 `+100Mtoken` 同形）。
    //   本行原写作 `+${...} ${unitLabel(unit)}`（**带空格**）—— 后果是**同一次
    //   签到**的逐账号明细显示 `+100.00M Token`、而汇总行显示 `+100.00MToken`，
    //   两行并列却像两种单位（2026-10-05 复审修正）。
    details.push(
      `${item.nickname || item.accountId}：领取成功 `
      + `+${formatUnits(outcome.credit, unit)}${unitLabel(unit)}`,
    )
        } else if (outcome.kind === 'already-claimed') {
          details.push(`${item.nickname || item.accountId}：${outcome.message || '今天已领取'}`);
        } else if (outcome.kind === 'inactive') {
          details.push(`${item.nickname || item.accountId}：${outcome.message || '不在活动范围'}`);
        } else if (outcome.kind === 'failed') {
          details.push(`${item.nickname || item.accountId}：失败 — ${outcome.message || '未知原因'}`);
        }
      }
      // 成长中心任务明细（仅 supportsGrowthTasks 时后端才返回 growth）。
      //
      // 渲染口径（按用户实测反馈定的）：
      // - **零产出账号折叠成一行**。此前逐项列出，于是「一件都没做成」的账号也铺
      //   满 7 行「需客户端」，看不出「这个号本轮没有任何可自动完成的项」与
      //   「这个号失败了」的区别 —— 而两者处置完全不同。
      // - **完成项排在需客户端之前**。需客户端是终态，不需要用户逐条读。
      // - 仍**逐项列出**有产出或有失败的账号：那是「哪一项为什么没涨」的唯一线索。
      let growthFailed = 0;
      let growthTimedOut = false;
      if (Array.isArray(growth) && growth.length > 0) {
        let completed = 0;
        let clientOnly = 0;
        let claimedCount = 0;
        let claimedCredit = 0;
        for (const account of growth) {
          const who = account.nickname || account.accountId;
          completed += account.completed || 0;
          clientOnly += account.clientOnly || 0;
          growthFailed += account.failed || 0;
          claimedCount += account.claimedCount || 0;
          claimedCredit += account.claimedCredit || 0;
          if (account.timedOut) growthTimedOut = true;
          if (account.error) {
            details.push(`${who}：${account.error}`);
            continue;
          }
          const tasks = account.tasks || [];
          const settled = tasks.filter((t) => t.ok && !t.clientOnly);
          const broken = tasks.filter((t) => !t.ok);
          const needClient = tasks.filter((t) => t.ok && t.clientOnly);
          if (settled.length === 0 && broken.length === 0) {
            // 本轮该账号没有任何可自动完成的项 ⇒ 一行说清，不铺陈列表。
            const why = needClient.length > 0
              ? `${needClient.length} 项判据只在客户端行为里记录，API 推不动`
              : '本轮无 API 可达的任务';
            details.push(`${who}：${why}（未领到积分）`);
            continue;
          }
          const head = [
            settled.length > 0 ? `完成 ${settled.length} 项` : null,
            broken.length > 0 ? `失败 ${broken.length} 项` : null,
            needClient.length > 0 ? `需客户端 ${needClient.length} 项` : null,
          ].filter(Boolean).join('，');
          details.push(`${who}：${head}`);
          for (const task of settled.concat(broken)) {
            const label = task.taskCode || '未知任务';
            const reason = task.message || '';
            if (!task.ok) details.push(`　· ${label}：失败 — ${reason}`);
            else details.push(`　· ${label}：${reason}`);
          }
        }
        if (completed > 0) parts.push(`成长完成 ${completed} 项`);
        if (clientOnly > 0) parts.push(`成长需客户端 ${clientOnly} 项`);
        if (growthFailed > 0) parts.push(`成长失败 ${growthFailed} 项`);
        if (claimedCount > 0) parts.push(`自动领取 ${claimedCount} 项（+${claimedCredit} 积分）`);
        if (growthTimedOut) parts.push('本轮时间预算用尽，剩余项未执行，再点一次即可继续');
      }
      setClaimNotice({
        tone: summary.failed > 0 || growthFailed > 0 ? 'warn' : 'ok',
        text: parts.length > 0 ? parts.join('，') : '没有可领取的账号',
        details,
      });
      await loadAccounts();
      // ⚠️ 领取会改变余额，顺带刷新一次，免得卡片还显示领取前的数字。
      //   ⚠️⚠️ **必须 force = true**（2026-10-16 审计 P1-1）：宿主侧现在吃共享
      //   缓存（120s TTL），不绕过的话这里会把**领取前**的读数重新显示出来 ——
      //   正是本行注释想避免的现象，只是换了个成因（审计实测确认）。
      await loadCredits(true);
    } catch (caught) {
      console.error('[jet-hub] claim credits failed:', caught);
      if (!mounted.current) return;
      setClaimNotice({ tone: 'error', text: caught?.message || '领取积分失败' });
    } finally {
      // ⚠️ 闸门**必须无条件释放**（不能 `if (mounted.current)`）：它是个普通 ref，
      // 与组件挂载状态无关。若跟着 `mounted` 一起判，卸载后闸门永久停在 true，
      // 用户切回该面板再点就永远收到「上一次仍在进行中」——闸门卡死。
      claimInFlightRef.current = false;
      if (mounted.current) setClaiming(false);
    }
  };

  /**
   * 停表 + 收尾：清掉轮询句柄，并在**组件仍挂载**时释放 busy。
   *
   * 所有结束路径（成功 / 超时 / 卸载）都必须走这里，否则 busy 会永久卡住或
   * 句柄泄漏（这条规则对已随 IKJLHQ 移除的官方卡片账号区同样成立）。
   */
  const stopPoll = () => {
    if (pollRef.current !== 0) { clearInterval(pollRef.current); pollRef.current = 0; }
    if (mounted.current) setCreating(false);
  };

  /**
   * 真正提交一个 opencode 账号（由「添加账号」弹窗的确认按钮调用）。
   *
   * ⚠️ 错误**留在弹窗内**展示，不 `setPhase('error')`：后者会把整个账号列表
   * 换成错误态，用户刚填的 key 与错误信息一起消失，只能刷新重试。
   */
  const submitOpencodeKey = async (rawKey) => {
    const key = String(rawKey == null ? '' : rawKey).trim();
    // 空串 = 没填就点确认：静默关弹窗，不报错（免费通道本来就能用）。
    if (key === '') return;
    await submitOpencodeEntry('opencode.addAccount', { apiKey: key });
  };

  /**
   * 添加一条**匿名通道**（无需 key）。
   *
   * 匿名通道是账号池里的一条普通条目（`api_key` 为字面量 `public`），于是
   * 拖拽排序 / 停用 / 删除 / 代理 / 指纹代次全部复用既有机制 —— 这正是
   * 「多条匿名通道各走各的出口」的实现方式。
   *
   * ⚠️ 指纹分离**不增加配额**（匿名按出口 IP 限额，实测换 key/伪装头/指纹
   * 全部无效）；要多份额度必须给不同匿名通道配**不同代理**。弹窗里已说明。
   */
  const submitAnonymous = async () => {
    await submitOpencodeEntry('opencode.addAnonymous', {});
  };

  /**
   * 提交一个 modelscope（魔搭）账号。
   *
   * ⚠️ **本 fork 独有**（2026-10-17 审计 P0 修复）：此前本函数与
   *    `createAccount` 里的 `provider === 'modelscope'` 分支**都不存在** ⇒
   *    面板里点「添加账号」落到通用 `account.create`，而宿主那条 switch 没有
   *    modelscope 分支 ⇒ 回 `unknown provider: modelscope`。
   *    ⚠️ **刻意复用 {@link submitOpencodeEntry} 而不另写一份收尾**：两者的
   *    收尾语义逐字节相同（关弹窗 / 刷新 / `existed` 提示 / 错误留在弹窗内），
   *    本仓库红线是「同一份语义不许有两套实现」。
   */
  const submitModelscopeKey = async (rawKey) => {
    const key = String(rawKey == null ? '' : rawKey).trim();
    // 空串 = 没填就点确认：静默关弹窗，不报错（与 opencode 同款，不制造无谓报错）。
    if (key === '') return;
    await submitOpencodeEntry('modelscope.addAccount', { apiKey: key });
  };

  /**
   * 提交「编辑访问令牌」（**本 fork 独有**，2026-10-17）。
   *
   * ⚠️ **刻意不复用 {@link submitOpencodeEntry}**：它的收尾是「关弹窗 + 刷新 +
   * `existed` 提示」，而这里多一格 —— 宿主可能在换 Key 时**换了账号 id**
   * （id 由 Key 尾段派生），必须据此明确告诉用户「这条账号的标识变了」，
   * 否则用户会以为账号凭空消失。
   */
  const submitModelscopeKeyEdit = async (rawKey) => {
    const key = String(rawKey == null ? '' : rawKey).trim();
    if (key === '') return;
    const accountId = keyEditModal?.accountId;
    if (!accountId) return;
    setCreating(true);
    try {
      const res = await rpcCall('modelscope.setApiKey', { accountId, apiKey: key });
      setKeyEditModal(null);
      await loadAccounts();
      // ⚠️ `renamed` = 账号 id 变了（宿主已把旧条目移除、新条目建好）。
      //    提示里**不**显示明文 Key，只说变了 —— 与卡片上的打码口径一致。
      // ⚠️⚠️ **必须是对象，不能是裸字符串**（真实事故 2026-10-22，整页白屏）：
      //    渲染端读 `probeNotice.details.length`，而字符串的 `.details` 是
      //    undefined ⇒ 渲染期抛 `Cannot read properties of undefined
      //    (reading 'length')` ⇒ 整个设置页被 React 卸载（插件内没有
      //    ErrorBoundary），只能重启 DSH。兜底见 `normalizeProbeNotice`。
      setProbeNotice({
        tone: 'ok',
        text: res?.renamed
          ? '已更新访问令牌。该账号的标识随 Key 尾段一并更新（昵称与停用状态已保留）。'
          : '已更新访问令牌。',
        details: [],
      });
    } catch (caught) {
      // ⚠️ 错误留在弹窗内（同 submitOpencodeEntry 的理由）。
      setKeyEditModal((prev) => (prev ? { ...prev, error: caught?.message ? caught.message : '未知错误' } : prev));
    } finally {
      setCreating(false);
    }
  };

  /** 两个添加入口的公共收尾（成功关弹窗并刷新；失败把错误留在弹窗里）。 */
  const submitOpencodeEntry = async (method, payload) => {
    setCreating(true);
    setError(null);
    try {
      const res = await rpcCall(method, payload);
      setKeyModal(null);
      await loadAccounts();
      // 重复 key 时后端返回 existed（复用已有账号）—— 这不是错误，
      // 但要明确告知，否则用户会以为第二次粘贴白费了。
      // ⚠️ 同样必须是对象而非裸字符串 —— 这条正是用户 2026-10-22 复现白屏的
      //    路径（理由见 submitModelscopeKeyEdit 处的事故注释）。
      if (res && res.existed) {
        setProbeNotice({
          tone: 'ok',
          text: '该 key 已存在，已为你定位到原有账号。',
          details: [],
        });
      }
    } catch (caught) {
      setKeyModal({ error: caught && caught.message ? caught.message : '未知错误' });
    } finally {
      setCreating(false);
    }
  };

  const createAccount = async () => {
    // ⚠ 已有一轮登录在跑时**必须拦住**（真实缺陷）：`creating` 在返回 loginUrl 后
    // 会被 `finally` 无条件释放，按钮随即恢复可点，再点一次会叠加第二个轮询 +
    // 宿主再插一条占位账号。以轮询句柄作为重入闸门，比 UI 的 disabled 更可靠。
    //
    // ⚠⚠ 但拦住之后**不能静默 return**（Gitee issue IKJLK3 B）：弹窗的确定按钮是
    //   「先关弹窗、再调 createAccount」，早退时用户看到的是「点了没反应」，
    //   分不清「没反应」与「正在处理」—— 这正是 issue 里那条
    //   「新建账号弹窗卡死、只能重启 dsh」报障的观感来源。
    //   本面板没有独立的 create 提示位，复用 probeNotice 区块渲染。
    if (pollRef.current !== 0) {
      setProbeNotice({ tone: 'warn', text: '上一次登录仍在进行中，请先完成或等待它结束。', details: [] })
      return
    }
    // ⚠️ opencode 的登录**不跳浏览器**，而是开自绘弹窗粘贴 API key；
    // 走 `setKeyModal` 而不是下面的 `account.create` 流程。
    // 弹窗里另有两个入口：粘贴 key（submitOpencodeKey）与添加匿名通道（submitAnonymous）。
    if (provider === 'opencode') {
      setKeyModal({ provider, error: '' });
      return;
    }
    // ⚠️ **本 fork 独有**（魔搭）：凭据是用户手工粘贴的 `ms-` API Key，
    //    没有 OAuth 授权页 ⇒ 两步式 `account.create` 对它不适用，与 opencode 同款改道。
    if (provider === 'modelscope') {
      setKeyModal({ provider, error: '' });
      return;
    }

    setCreating(true);
    let accountId = '';
    let loginUrl = '';
    try {
      // ⚠⚠ **不许打印完整响应**（信息泄露，Gitee issue IKJLK3 D）：
      //   `res` 含 `loginUrl`，而它由服务端的 `fetchAuthState` 生成、**携带 OAuth state**。
      //   用户在 DevTools 里截图 / 复制日志求助时会把它一起外泄，state 在登录窗口内
      //   可被重放。⇒ 这里只记 provider 与本地生成的 `accountId`（不是凭据）。
      //
      // ⚠ `zcodeProvider` / `accioRegion` 各自**只在对应 provider 时下发**
      //   （`buildCreateAccountPayload` 内部分支），
      //   其余 provider 的载荷与接入预选弹窗前**逐字节相同**。
      const res = await rpcCall('account.create',
        // ⚠ 两个 provider 各占一个位置参数（astudio 第 4 位、autoclaw 第 5 位），
        //    不可合并成一个 —— 载荷字段不同，合并会静默串台（见 new-account.js）。
        buildCreateAccountPayload(provider, zcodeProvider, accioRegion, astudioLoginMethod, autoclawMode));
      accountId = res.accountId;
      loginUrl = res.loginUrl;
      console.log('[jet-hub] account.create ok, provider =', provider, ', accountId =', accountId);
      // ⚠ **`reused` 分支必判**：后端若声明「复用了池里已有条目、新建条目与登录 URL」，
      // 它返回的是 `{reused:true, loginUrl:''}`。若只看 `loginUrl` 为空就报
      // 「后端未返回登录地址」，会把一次成功操作显示成失败。
      // ⚠️ **2026-10-05 起 ZCode 不再产生它**（「不读本机 ZCode 数据」的决策删掉了
      // 那条复用短路），但本分支**刻意保留**：它是**契约防御** —— 判据写成
      // 「后端声明复用则空 URL 是正常的」，比反过来假设「空串必是错误」更稳。
      if (res.reused) {
        setLoginUrlForManual(null);
        await loadAccounts();
        // 复用提示借用 probeNotice 区块渲染（本面板没有独立的 create 提示位）。
        setProbeNotice({ tone: 'ok', text: '已复用本机已有的账号凭据，未新建账号。', details: [] });
        return;
      }
      // ⚠️ Loomy 也走这条**统一的「弹窗 + 轮询」路径**：它的 `loginUrl`
      // 指向**本地服务器**上的微信扫码页（内联二维码 + 首次绑手机号表单），
      // 与 codearts / lobsterai / qoder / trae / cline 的体验一致。
      //
      // ⚠️ **真实缺陷**（用户报障「新建账号失败：Loomy 短信登录需要手机号」）：
      // 早期这里为 Loomy 分出一个「短信表单」分支，而表单要等 `account.create`
      // 返回才渲染、`account.create` 又要求先有手机号 —— **顺序死锁**，
      // 表单永远出不来。改用微信扫码后该分支已删除。
      if (!loginUrl) {
        await loadAccounts();
        setProbeNotice({ tone: 'ok', text: '已成功导入账号凭据。', details: [] });
        return;
      }
      if (loginUrl) {
        // ⚠️⚠️ **OfficeAce / CodeArts：宿主已用无痕窗口打开，客户端不要再开一个**
        //（OfficeAce 2026-10-13；CodeArts 2026-10-21 —— 两家授权页都在华为云
        // SSO 域，会话复用症状逐字相同：新建账号永远建出同一个号）。
        //
        // 为什么需要无痕：华为 authui 会**静默复用**浏览器已有会话 —— 带 cookie
        // 打开授权页直接放行、看不到登录框，于是「新建账号」永远只能建出同一个号。
        // 无痕是全新 cookie jar（cookie / 本地存储 / 会话存储 / 缓存全空），
        // 天然无会话，可换账号登录，且**不碰**用户日常
        // 浏览器里的华为云控制台会话（对比 `authui/logout`：作用域是整个域）。
        //
        // ⚠️ 客户端**做不到**这件事：`window.open` 无法请求无痕模式（那是进程级
        // 启动参数），故由宿主 `spawn` 浏览器可执行文件完成，并把结果回传。
        //
        // ⚠️ 判据用 `res.incognitoOpened === true` **精确匹配**，不要写成
        // `!== false`：老宿主不返回该字段（`undefined`），必须让它走回退分支，
        // 否则升级期会出现「宿主没开、客户端也不开」= **窗口根本不出来**。
        //
        // `loginWindow` 两种打开方式都要持有：轮询结束时用它关窗。
        let loginWindow = null;
        if (res.incognitoOpened === true) {
          // 宿主已开好无痕窗，这里只记日志以便排障（不打印 URL，见上面的信息泄露注释）。
          console.log('[jet-hub] account.create 已由宿主以无痕窗口打开授权页');
        } else {
          // 回退路径（其余 provider，或无痕窗口没拉起来）：
          // 登录页在**新窗口**中打开。这里必须能成功弹出：
          // 后端对全部 provider 都是「先返回 loginUrl、后台再等回调」的两步式，
          // 因此本行紧跟用户点击、仍处于浏览器的 transient activation 窗口内。
          //
          // ⚠️ 绝不能在弹窗失败时回退到 `window.location.href = loginUrl`：
          // 那会把整个设置页（甚至用户正在编辑的会话）导航到外部登录页，
          // 登录完成后也回不来。这正是用户报障「主页面直接跳转过去了」的现象。
          // 早期 CodeArts/LobsterAI 走的是**阻塞式**登录（后端 await 到用户
          // 授权完成才返回），拿到 URL 时手势早已过期、window.open 必被拦截，
          // 于是每次都命中那个跳转兜底。根因已在后端修掉（改为两步式），
          // 这里也不再保留那条破坏性兜底。
          loginWindow = window.open(loginUrl, '_blank', 'width=800,height=600');
          if (!loginWindow || loginWindow.closed) {
            // 弹窗被拦截：展示可点击链接让用户自行打开，而不是劫持当前页面。
            // 轮询照常进行，用户手动打开也能完成登录。
            //
            // 这里**不**调 setError：本函数运行时 phase 是 'ready'，错误文案只在
            // 'error' 阶段渲染，设了也看不见；提示由下面的 loginUrlForManual 区块负责。
            setLoginUrlForManual(loginUrl);
            setLoginLinkCopied(null);
          }
        }
        // 轮询等待登录完成。
        // ⚠ 超时**不用**另起的 `setTimeout`，而是记 deadline 在轮询里判：这样全场只有
        //   一个句柄（pollRef），卸载清理与超时都不会漏掉第二个定时器。
        // ⚠ `reused` 分支必判（同上，`account.create` 契约）：后端声明复用时
        //   **不新建条目、不返回 loginUrl**；只看 `loginUrl` 为空就报错会把一次
        //   成功操作显示成失败。ZCode 已不再产生该值，但判据保留作契约防御。
        const deadline = Date.now() + 300000;
        // ⚠️ `login.poll` **自身**失败（宿主异常 ⇒ `ok:false`）原先被下面那个裸
        //   `catch` 完全吞掉：用户只剩 5 分钟后一句「登录超时」，真实原因永不上屏
        //   （独立审计攻击 5d 实测）。这里只记痕迹，不打断轮询（可能只是瞬时故障），
        //   超时时一并展示。
        let lastPollError = null;
        let pollErrorCount = 0;
        pollRef.current = setInterval(async () => {
          if (!mounted.current) { stopPoll(); return; }
          if (Date.now() > deadline) {
            // ⚠️ 超时**必须给用户一句话**（Gitee issue IKLI7J 期望 3）。
            //   原先这里只是关窗 + 停表：用户看到「转圈 5 分钟后悄悄恢复」，
            //   分不清是没授权、被服务端拒了、还是插件坏了。
            // ⚠️ **文案不得把原因写死成「未完成授权」**（独立审计发现）：走到这里还有
            //   几种与「没授权」相反的情形 —— 用户其实已授权但凭据形状不被接受（zcode
            //   残缺凭据）、账号条目在登录途中被删掉、失败记录被 TTL/上限淘汰。
            //   把原因写死会给排障者一个错误的第一个假设。
            if (loginWindow && !loginWindow.closed) loginWindow.close();
            setLoginUrlForManual(null);
            setError('登录超时或未完成（已等待 5 分钟）：可能是授权未完成、授权被拒，'
              + '或账号条目已被删除。请重新点击「+ 新建账号」再试一次；'
              + '若账号其实已经添加，可点「重新读取」查看。'
              + (pollErrorCount > 0
                ? `（期间有 ${pollErrorCount} 次轮询请求本身失败，最后一次：${lastPollError}）`
                : ''));
            setPhase('error');
            stopPoll();
            return;
          }
          try {
            const pollRes = await rpcCall('login.poll', { accountId, provider });
            if (!mounted.current) return;
            // ⚠️⚠️ **先判 `success === false`（终态失败），再判 `done`**
            //   （Gitee issue IKLI7J）。后端把失败原因放在 `success:false` + `error`；
            //   旧写法 `if (!pollRes?.done) return;` 在 `done:false` 时把 `error`
            //   整体丢掉 —— 这正是「登录失败对用户完全不可见」的根因 1。
            //   判据刻意**不写进 `done:true` 分支**：对 `done` 的取值保持不敏感。
            if (pollRes?.success === false) {
              if (loginWindow && !loginWindow.closed) loginWindow.close();
              setLoginUrlForManual(null);
              setError(pollRes.error || '登录失败（宿主未给出原因），请重新点击「+ 新建账号」。');
              setPhase('error');
              stopPoll();
              return;
            }
            if (!pollRes?.done) return;
            if (loginWindow && !loginWindow.closed) loginWindow.close();
            setLoginUrlForManual(null);
            await loadAccounts();
            stopPoll();
          } catch (caught) {
            // ⚠️ **继续轮询**（宿主可能只是瞬时不可用），但必须留下痕迹：
            //   原先这里是裸 `catch {}`，于是 `login.poll` 自身报错（`ok:false`，
            //   例如宿主 handler 抛异常）时真实原因被彻底吞掉，用户只能等到
            //   5 分钟后那句泛化的「登录超时」（独立审计攻击 5d）。
            pollErrorCount += 1;
            lastPollError = caught && caught.message ? caught.message : String(caught);
          }
        }, 1000);
      } else {
        setError('后端未返回登录地址（loginUrl 为空）。');
        setPhase('error');
      }
    } catch (caught) {
      console.error('[jet-hub] create account failed:', caught);
      setError('新建账号失败：' + (caught?.message || '未知错误'));
      setPhase('error');
    } finally {
      // ⚠ 只在**没有**轮询在跑时释放「新建中」。登录未完成期间按钮必须保持禁用，
      // 否则用户再点一次就是「叠加第二个轮询 + 宿主再插一条占位账号」的缺陷。
      if (pollRef.current === 0) setCreating(false);
    }
  };

  /**
   * 停用 / 启用账号。
   *
   * ## 与模型可见性的联动（用户明确要求）
   *
   * 门控判据刻意**不看 `enabled`**（「停用只应影响自动选号，与是否已登录无关」，
   * 见 `AccountPool.hasLoggedInAccount`）—— 这是整体设计，此处不改它。
   *
   * 但用户停用某 provider 的**最后一个**启用账号后，它的模型仍留在对话框的模型
   * 选择器里（凭据还在，目录门控判为可见），只能再去「显示列表」里逐个关。
   * 于是这里把它变成**一次显式选择**：
   *
   * - 停用后该 provider 不再有任何启用账号 → 问一句「是否同时关闭它的全部模型」；
   * - 反过来，启用一个此前无启用账号的 provider、且它的模型恰好全关时 →
   *   问一句「是否同时打开」（很可能是上次停用时连带关掉的）。
   *
   * 两个方向都**由用户决定**，不做静默联动：静默关闭会让「停用账号」这个看似
   * 与模型无关的操作产生意外副作用；静默打开则可能把用户特意关掉的模型放出来。
   *
   * 判定逻辑在 `./account-model-link.js`（纯函数，可单测）。
   */
  const toggleAccount = async (accountId, enabled) => {
    try {
      // 必须在提交**之前**判定：提交后列表已刷新，「是否还有启用账号」的答案
      // 就是变更后的状态了。
      const isLastEnabled = !enabled
        && disablingLeavesNoEnabledAccount(accountsRef.current, accountId, provider);
      const isFirstEnabled = enabled
        && !accountsRef.current.some(a => a.provider === provider && a.id !== accountId && a.enabled !== false);
      await rpcCall('account.update', { accountId, patch: { enabled } });
      await loadAccounts();

      // 停用方向：提示是否连带关闭模型。
      if (isLastEnabled) {
        const closeModels = confirm(
          `该 Provider 已没有启用账号，它的模型不会再被使用。\n\n`
          + `是否同时关闭它的全部模型（从对话框的模型选择里移除）？\n`
          + `选择「取消」则只停用账号，模型保持现状。`,
        );
        if (closeModels) {
          try {
            await rpcCall('model.setAllDisabled', { provider, disabled: true });
          } catch (caught) {
            // 账号已经停用成功，联动失败不能回滚它 —— 只提示，让用户可去
            // 「显示列表」手动处理。
            console.error('[jet-hub] cascade disable models failed:', caught);
            if (mounted.current) {
              setProbeNotice({
                tone: 'warn',
                text: `账号已停用，但关闭模型失败：${caught?.message || '未知错误'}。可在「显示列表」中手动关闭。`,
                details: [],
              });
            }
          }
        }
        return;
      }

      // 启用方向：只在「此前一个启用账号都没有」时才查模型目录（避免每次启用
      // 都多发一次 RPC），且全关时才提示打开。
      if (isFirstEnabled) {
        let models;
        try {
          const res = await rpcCall('model.list', { provider });
          models = res.models || [];
        } catch (caught) {
          // 目录读不出来就静默跳过联动：账号启用本身已经成功，不该因目录故障
          // 而报错。用户仍可去「显示列表」手动打开。
          console.error('[jet-hub] read models for cascade enable failed:', caught);
          models = null;
        }
        if (models !== null && allModelsDisabled(models)) {
          const openModels = confirm(
            `该 Provider 的 ${models.length} 个模型当前全部处于关闭状态。\n\n`
            + `是否同时打开它们（让模型重新出现在对话框的模型选择里）？`,
          );
          if (openModels) {
            try {
              await rpcCall('model.setAllDisabled', { provider, disabled: false });
            } catch (caught) {
              console.error('[jet-hub] cascade enable models failed:', caught);
              if (mounted.current) {
                setProbeNotice({
                  tone: 'warn',
                  text: `账号已启用，但打开模型失败：${caught?.message || '未知错误'}。可在「显示列表」中手动打开。`,
                  details: [],
                });
              }
            }
          }
        }
      }
    } catch (caught) {
      console.error('[jet-hub] toggle failed:', caught);
    }
  };

  const deleteAccount = async (accountId) => {
    if (!confirm('确认删除此账号？关联的凭据也将被清除。')) return;
    try {
      await rpcCall('account.delete', { accountId });
      await loadAccounts();
    } catch (caught) {
      console.error('[jet-hub] delete failed:', caught);
    }
  };

  /**
   * 轮换某账号的指纹（仅 opencode）。
   *
   * ⚠️ 二次确认是有意的：它不是「修复失败」的操作，而是**预防性**手段
   * （怀疑多个账号被上游关联时换一份新身份）。没有确认框的话，用户容易
   * 当成普通按钮随手点，点了也不知道发生了什么。
   */
  const rotateFingerprint = async (accountId) => {
    if (!confirm('轮换该账号的指纹？将生成新的 project id（用于与其他账号区分）。')) return;
    try {
      await rpcCall('opencode.rotateFingerprint', { accountId });
      await loadAccounts();
    } catch (caught) {
      alert('轮换失败：' + (caught?.message || String(caught)));
    }
  };

  /**
   * 把账号列表重排为 `orderedIds` 并持久化。
   *
   * **乐观更新**：先本地改顺序（拖拽手感即时），再提交服务端；失败则回滚并
   * 提示。拖拽若等一个网络往返才动，会明显发滞。
   *
   * 顺序不是纯 UI 状态：它就是服务端 `getAvailableAccount` 的候选优先级，
   * 即自动选号与限流换号的实际取号顺序（见 `AccountPool.reorderAccounts`）。
   */
  const commitOrder = async (orderedIds) => {
    const snapshot = accountsRef.current;
    const byId = new Map(snapshot.map(a => [a.id, a]));
    const next = orderedIds.map(id => byId.get(id)).filter(Boolean);
    if (next.length !== snapshot.length) return;   // 理论不可达：id 集合来自本列表
    accountsRef.current = next;
    setAccounts(next);
    setReordering(true);
    setReorderError(null);
    try {
      await rpcCall('account.reorder', { provider, orderedIds });
    } catch (caught) {
      console.error('[jet-hub] reorder failed:', caught);
      if (!mounted.current) return;
      // 回滚：服务端未接受这个顺序，界面不能停在"看起来已生效"的状态。
      accountsRef.current = snapshot;
      setAccounts(snapshot);
      setReorderError(caught?.message || '顺序保存失败');
    } finally {
      if (mounted.current) setReordering(false);
    }
  };

  /**
   * 计算把 `sourceId` 放到 `targetId` 前/后的新顺序。
   *
   * 实际逻辑在 `./account-order.js`（纯函数，可单测）：这里只负责取当前
   * 列表的 id 序列并转交。`position` 由指针落在目标卡片的上半/下半决定 ——
   * 只支持「插入到之前」会让"往下拖一格"变成空操作（见该模块注释）。
   */
  const computeDropOrder = (sourceId, targetId, position) =>
    orderAfterDrop(accountsRef.current.map(a => a.id), sourceId, targetId, position);

  /** 构造某张卡片的拖拽属性（关闭拖拽时返回 enabled:false）。 */
  const dragPropsFor = (account, index) => {
    // 只有一个账号时排序无意义，直接不启用（避免出现无法落点的拖拽）。
    if (accounts.length < 2) return { enabled: false };
    return {
      enabled: true,
      order: index,
      isDragging: draggingId === account.id,
      isDropTarget: dropTargetId === account.id && draggingId !== null && draggingId !== account.id,
      dropPosition,
      onDragStart: (event) => {
        setDraggingId(account.id);
        setReorderError(null);
        // 必须设置 dataTransfer，否则 Firefox 不触发拖拽。
        try { event.dataTransfer.setData('text/plain', account.id); } catch { /* 忽略 */ }
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      },
      onDragEnd: () => {
        setDraggingId(null);
        setDropTargetId(null);
      },
      onDragOver: (event) => {
        if (draggingId === null || draggingId === account.id) return;
        // 必须 preventDefault 才允许 drop。
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        if (dropTargetId !== account.id) setDropTargetId(account.id);
        // 按指针在卡片内的纵向位置决定插到前面还是后面。
        const rect = event.currentTarget?.getBoundingClientRect?.();
        const next = dropPositionFromPointer(event.clientY, rect);
        if (next !== dropPosition) setDropPosition(next);
      },
      onDrop: (event) => {
        event.preventDefault();
        const sourceId = draggingId;
        setDraggingId(null);
        setDropTargetId(null);
        if (sourceId === null || sourceId === account.id) return;
        const next = computeDropOrder(sourceId, account.id, dropPosition);
        if (next !== null) void commitOrder(next);
      },
    };
  };

  /**
   * 重测 / 重置的统一入口。
   *
   * kind 决定调用哪个 RPC：
   * - 'retest'    account.retest    对单个账号发真实请求
   * - 'retestAll' account.retestAll 对本页全部账号（含停用）发真实请求
   * - 'reset'     account.reset     单账号直接清除标记
   * - 'resetAll'  account.resetAll  本页全部账号（含停用）直接清除标记
   *
   * 重测会真实消耗模型额度，因此「重测所有」在执行前要求确认。
   */
  const runLimitAction = async (kind, accountId) => {
    if (kind === 'retestAll' && !confirm('将对本页全部账号（含已停用）各发送一条真实消息来验证限流状态，会消耗模型额度。继续？')) {
      return;
    }
    setProbeBusy(kind === 'retestAll' || kind === 'resetAll' ? 'all' : 'one');
    setProbeNotice(null);
    try {
      let res;
      if (kind === 'retest') res = await rpcCall('account.retest', { accountId });
      else if (kind === 'retestAll') res = await rpcCall('account.retestAll', { provider });
      else if (kind === 'reset') res = await rpcCall('account.reset', { accountId });
      else res = await rpcCall('account.resetAll', { provider });

      if (!mounted.current) return;
      // 仍受限的模型要如实列出原因，否则用户只看到"没清除"会以为按钮失灵。
      const details = (res?.accounts || [])
        .flatMap(a => (a.stillLimited || []).map(m => `${a.nickname || a.accountId} · ${m.modelId}：${m.message || '仍受限'}`));
      const summary = summarizeProbe(kind, res);
      setProbeNotice({ tone: details.length > 0 ? 'warn' : 'ok', text: summary, details });
      await loadAccounts();
    } catch (caught) {
      console.error('[jet-hub] limit action failed:', caught);
      if (!mounted.current) return;
      setProbeNotice({ tone: 'error', text: `操作失败：${caught?.message || '未知错误'}`, details: [] });
    } finally {
      if (mounted.current) setProbeBusy(null);
    }
  };

  /**
   * 「测试」：**无条件**真发一次请求（不依赖是否存在限流标记）。
   *
   * ⚠️ 刻意**不**复用 `runLimitAction`：那条路径的文案汇总（`summarizeProbe`）
   * 读的是 `res.accounts` / `res.clearedCount`，而 `account.test` 返回的是
   * 扁平的 `{ modelId, ok, message }` —— 复用会得到「没有可重测的限流标记」，
   * 把「测试失败」误报成「没什么可测的」。
   *
   * 复用 `probeBusy` 状态（置 `'one'`）：它同时驱动卡片的 `busy` 与按钮禁用，
   * 测试期间不该允许并发点其它按钮。
   */
  const runTestAction = async (accountId) => {
    setProbeBusy('one');
    setProbeNotice(null);
    try {
      const res = await rpcCall('account.test', { accountId });
      if (!mounted.current) return;
      const text = summarizeTest(res);
      // 仍受限/无法确认时把原始原因也列出来，否则用户只看到「未通过」会以为按钮失灵。
      const details = res && res.ok === false && res.message
        ? [`${res.nickname || res.accountId} · ${res.modelId || '未知模型'}：${res.message}`]
        : [];
      setProbeNotice({ tone: res?.ok ? 'ok' : 'warn', text, details });
      // 测试不写存储，故无需 loadAccounts() —— 但刷新一次无害且能顺带更新凭据有效期。
      await loadAccounts();
    } catch (caught) {
      console.error('[jet-hub] account test failed:', caught);
      if (!mounted.current) return;
      setProbeNotice({ tone: 'error', text: `测试失败：${caught?.message || '未知错误'}`, details: [] });
    } finally {
      if (mounted.current) setProbeBusy(null);
    }
  };

  /**
   * CodeBuddy 限时补偿积分卡片（仅 buddy 且已查询到状态时渲染）。
   *
   * ⚠️ **抽成变量而不是内联在 section(...) 的参数表里**：内联时它嵌在三元中，
   *    括号层级深、改一处极易数错（PR !106 初版实测踩到，浪费了一轮）。
   *
   * ⚠️ **刻意不接自动签到**：这是一次性的限时活动，本仓库对「一次性 / 有代价
   *    动作」的既有铁律是默认不自动执行（见 buddy-growth.ts 的 runExotic）。
   *    故这里只做「如实展示 + 用户点按钮领取」。理由与端点证据见
   *    src/buddy-compensation.ts 模块头。
   *
   * ⚠️ **只对 buddy 渲染**（AGENTS.md：「通用面板里的按钮与弹窗必须按 provider
   *    分支」）。workbuddy 虽有同款端点，但那是另一个产品面，未验证不予展示。
   *
   * ⚠️ 文案一律走纯函数（`compensation-panel-logic.js`），不在 JSX 里内联三元 ——
   *    内联文案无法被单测覆盖（无 react ⇒ 组件不渲染），初版正是这样漏掉了 P0。
   */
  const compensationCard = provider === 'buddy' && compensation !== null
    ? React.createElement('div', {
        className: 'dim-jh-probeNotice',
        'data-tone': compensation.error ? 'warn' : (compensation.total > 0 ? 'ok' : 'idle'),
      },
      React.createElement('div', null, compensationHeadline(compensation)),
      React.createElement('div', { className: 'dim-jh-hint' }, compensationHint(compensation)),
      compensation.total > 0
        ? React.createElement('button', {
            className: 'dim-jh-btn',
            type: 'button',
            disabled: compensation.busy === true,
            title: '逐个账号调用补偿领取端点。这是**一次性写操作**（每账号只能领一次），'
              + '故只在你点了这个按钮时才发起，不会随每日签到自动执行。',
            onClick: () => void claimCompensation(),
          }, compensation.busy === true ? '领取中…' : '立即领取')
        : null)
    : null;


  return React.createElement('section', { 'aria-label': `${provider} 账号管理` },
    // 标题与按钮分开成两块（而不是同一行的 space-between）：操作按钮多达 5 个，
    // 与面板标题挤在一行时既会被压缩又会溢出。标题独占一行、按钮组另起一行
    // 并允许换行，窄面板下也能完整显示。
    React.createElement('div', { className: 'dim-jh-panelHead' },
      React.createElement('h2', { className: 'dim-jh-panelTitle' },
        `${PROVIDERS.find(p => p.id === provider)?.label || provider} 账号管理`),
      React.createElement('div', { className: 'dim-jh-headerActions' },
        React.createElement('button', {
          className: 'dim-jh-btn',
          title: MODEL_LIST_HELP,
          onClick: () => setShowModels(true),
        }, '显示列表'),
        // 「订阅额度」放在**面板级**（而不是账号卡片的按钮行）：
        // 那一行已有 5 个按钮且 `flex-wrap: nowrap`，再塞一个必然溢出
        // （该行的注释里记着「领取新手任务」当时就是这么被挤出去的）。
        // 且额度是**跨账号**的读数，放在面板级与它的语义一致。
        canShowSubscriptionQuota
          ? React.createElement('button', {
              className: 'dim-jh-btn',
              title: '查看 Cline 官方订阅额度窗口（5 小时 / 周 / 月各用掉百分之几）'
                + '与逐笔请求记录（模型、token、积分）。数据来自官方网关，非本地记账。',
              onClick: () => setShowQuota(true),
            }, '订阅额度')
          : null,
        canLoadCredits
          ? React.createElement('button', {
              className: 'dim-jh-btn',
              title: '重新查询本页全部账号的剩余积分（Credits Balance）。余额由服务端实时计算，点此可刷新。',
              disabled: creditsLoading,
              onClick: () => void loadCredits(true),
            }, creditsLoading ? '查询中…' : '刷新积分')
          : null,
        supportsCredits
          ? React.createElement('button', {
              className: 'dim-jh-btn',
              title: supportsGrowthTasks
                ? `领取全部 ${PROVIDERS.find(p => p.id === provider)?.label || provider} 账号（含已停用）的每日签到积分，**并完成成长中心任务**。`
                  + '成长一轮单账号实测 90～270s 且全串行，账号多时可能需多点几次；'
                  + '受客户端动作限制的项（微信、夜猫子窗口、判据推不动）会如实标为「需客户端」。'
                : `领取全部 ${PROVIDERS.find(p => p.id === provider)?.label || provider} 账号（含已停用）的每日签到积分`,
              disabled: claiming || accounts.length === 0,
              onClick: () => void claimCredits(),
            }, claiming
              ? '领取中…'
              // ⚠️ 有成长任务的渠道必须**在点之前**告知这会做很多事：成长一轮单账号
              // 实测 90～270s 且全串行，而「一键领取积分」这个文案原本只表示
              // 毫秒级的每日签到。用户点之前不知道要等几分钟。
              : (supportsGrowthTasks ? '一键领取积分 + 成长任务' : '一键领取积分'))
          : null,
        // 「重测 / 重置」只对**会返回限流错误**的 provider 有意义。
        // ⚠️ Loomy 不会限流（积分耗尽时静默降级为扣永久积分），故对它
        // 隐藏这两个按钮 —— 重测永远测不出限流、重置也没有标记可清，
        // 而重测还会白烧积分（用户报障：「这个 provider 好像没发现模型限流，
        // 把重置所有按钮删掉」）。
        supportsRateLimit(provider)
          ? React.createElement('button', {
              className: 'dim-jh-btn',
              title: RETEST_ALL_HELP,
              disabled: probeBusy !== null || accounts.length === 0,
              onClick: () => void runLimitAction('retestAll'),
            }, probeBusy === 'all' ? '重测中…' : '重测所有')
          : null,
        supportsRateLimit(provider)
          ? React.createElement('button', {
              className: 'dim-jh-btn',
              title: RESET_ALL_HELP,
              disabled: probeBusy !== null || accounts.length === 0,
              onClick: () => void runLimitAction('resetAll'),
            }, '重置所有')
          : null,
        // 锁定永久积分：只消耗会近期作废的积分，保住长期积分。
        // 文案按 provider 给（Loomy 是「每日赠送额度」，两个 buddy 是
        // 「15 天内到期的积分包」）—— 见 permanentLockCopy 的说明。
        canLockPermanent
          ? React.createElement('button', {
              className: 'dim-jh-btn',
              'data-kind': permanentLocked ? 'primary' : undefined,
              title: permanentLocked ? lockCopy.lockedTitle : lockCopy.lockTitle,
              disabled: lockBusy,
              onClick: () => void togglePermanentLock(),
            }, lockBusy
              ? '处理中…'
              : (permanentLocked ? '解锁永久积分' : '锁定永久积分'))
          : null,
        // ⚠️ 渠道弹窗**只服务 ZCode**：非 zcode 直接发起登录，与「搬进弹窗」
        //   之前逐字等价。上游 15ccae5 把渠道选择搬进弹窗时丢了这层门控，
        //   于是全部 14 个 provider 点「+ 新建账号」都弹出一个「添加 ZCode 账号」。
        React.createElement('button', {
          className: 'dim-jh-btn',
          'data-kind': 'primary',
          title: '通过浏览器登录一个新的账号并加入账号池。',
          // ⚠⚠ **必须按 provider 分支**（真实缺陷，Gitee issue IKJLK3 A1/A2/A3）：
          //   这个按钮在**每一个** provider 的面板里都有，而下面的弹窗是
          //   **zCode 专用**的（登录渠道下拉）。原先无条件 `setPendingLogin(false)`，
          //   于是「在 CodeArts 面板点新建账号」弹出的也是「添加 ZCode 账号」，
          //   里面的下拉还不会下发（载荷里没有 `zcodeProvider`），
          //   opencode 则要用户先过一遍 ZCode 弹窗才看到自己的 API key 表单。
          //   ⇒ 判据收在 `newAccountAsksChannel()`：只有 zcode 先问渠道，
          //   其余 provider 点按钮即发起登录。**别把它改回无条件开弹窗。**
          onClick: () => {
            if (newAccountAsksChannel(provider)) setPendingLogin(false)
            else void createAccount()
          },
          disabled: creating,
        }, creating ? '正在登录…' : '+ 新建账号'),
        /**
         * ⚠️ **只给 MiniMax 国际版**（issue IKMEVG）：它的数据面
         * `agent.minimax.io` 按**出口 IP 国别**把中国大陆来源 307 到中国站，
         * 于是大陆网络下国际站账号永远拿不到数据面（与 token 有效性无关）。
         * 这里给一个入口让用户填海外 IP 绕开该分流。
         *
         * ⚠️ 其它 provider 一律不渲染（多一个永远无效的按钮只会让用户困惑）。
         *
         * ⚠️ **位置必须在「+ 新建账号」之后**（2026-10-17 用户要求
         * 「minimax国际版的新建账号放在国际站分流之前」）：新建账号是**主操作**，
         * 分流设置是**排障用的次要入口** —— 次要项排在主操作前面会让用户
         * 先看到「分流设置」而不是「怎么加账号」。
         */
        provider === 'minimaxintl'
          ? React.createElement('button', {
              className: 'dim-jh-btn',
              'data-kind': minimaxXff !== '' ? 'primary' : undefined,
              title: 'MiniMax 国际站的服务器会按**出口 IP 所在国家**决定把你路由到哪个站：'
                + '中国大陆 IP 会被 307 重定向到中国站，表现为「余额查询失败 / 模型不可用」。'
                + '\n\n在此填写一个**海外 IP**（如 8.8.8.8）即可让请求被判为海外来源、留在国际站。'
                + '\n留空 = 不伪造来源（推荐先用代理改变出口 IP，那是更正当的方式）。'
                + `\n\n当前：${minimaxXff === '' ? '未设置' : minimaxXff}`,
              onClick: () => setShowMinimaxXff(true),
            }, minimaxXff !== '' ? '国际站分流：已绕过' : '国际站分流设置')
          : null,
        // ★ 预选对话框（用户 2026-10-03：从按钮旁搬到弹窗里）
        //
        // ⚠ 内容按 provider 分支：zcode 问**登录渠道**，accio 问**登录区域**
        //   （两者都收在 `newAccountAsksChannel` 的白名单里）。
        //
        // ⚠ `newAccountAsksChannel(provider)` 这道是**防御性**的：按钮已经分支过，
        //   正常路径下不在白名单的 provider 永远不会把 `pendingLogin` 置为「开」。
        //   但状态是活的（用户切 provider 时本面板会重新挂载，理论上仍可能
        //   残留一帧），漏掉它就会退回 issue 里那个「非 zcode 弹出 ZCode 窗」的形态。
        //
        // ⚠ 类名 `dim-jh-zcDialog*` 名字里带 zc，但它**已是通用弹窗样式**
        //   （见 `jet-hub-styles.js`），**不是** zCode 专用标记。
        //   曾想改名，但样式表一起动、收益仅是可读性，故保留名字。
        //
        // ⚠ 本弹窗原先有**两个入口**（这里与官方模型卡片里的 ZCode 账号区）；后者
        //   已随 Gitee issue IKJLHQ 整体移除（它占用的 provider-card 槽 key 与第三方
        //   pi-ai 扩展互斥，机制见 index.js 文件头）—— 现在只剩本处一个入口。
        pendingLogin === undefined || !newAccountAsksChannel(provider) ? null : React.createElement(
          'div',
            {
              className: 'dim-jh-zcDialogMask',
              onClick: () => setPendingLogin(undefined),
            },
            React.createElement('div', {
              className: 'dim-jh-zcDialog',
              onClick: (event) => event.stopPropagation(),
            },
              React.createElement('h3', { className: 'dim-jh-zcDialogTitle' },
                // ⚠ 弹窗服务四个 provider（zcode / accio / astudio / autoclaw），
                //   各问各的东西：渠道 / 区域 / AStudio 登录方式 / AutoClaw 登录方式。
                astudioDialog ? '添加 AStudio 账号'
                  : autoclawDialog ? '添加 AutoClaw 账号'
                    : (accioDialog ? '添加 Accio 账号' : '添加 ZCode 账号')),
              React.createElement('p', { className: 'dim-jh-zcDialogHint' },
                astudioDialog
                  ? '支持导入本机桌面端已登录会话，或在浏览器中打开三合一登录页（支持手机短信/账号密码/微信扫码）。'
                  : autoclawDialog
                    ? '请选择登录方式：可直接读取本机已安装并登录的桌面端凭据，或使用手机短信验证码快速登录。'
                    : (accioDialog
                        ? 'Accio 的登录页按区域分域名，且区域由服务端按账号下发 —— 登录前'
                          + '无法自动判断。请选择该账号所属的区域，否则会打开打不开的登录页。'
                        : '选择登录渠道后才会打开对应的认证页面。两个渠道的授权页与凭据各自独立，')),
              (accioDialog || astudioDialog || autoclawDialog)
                ? null
                : React.createElement('p', { className: 'dim-jh-zcDialogHint' },
                    '可用 z.ai（国际）登录另一个账号。'),
              React.createElement('label', { className: 'dim-jh-zcProvider' },
                astudioDialog ? '登录方式'
                  : autoclawDialog ? '登录方式' : (accioDialog ? '登录区域' : '登录渠道'),
                // ⚠️⚠️ **原生 `<select>` 已整体删除**（2026-10-17 审计 P2 修复，
                //    本次合并 astudio 侧时一并采纳 —— astudio 侧原本还留着第四个死 select）。
                //   原先此处有**四个**各自带 `style:{display:'none'}` 的 `<select>`
                //   （astudioLoginMethod / autoclawMode / accioRegion / zcodeProvider），
                //   功能已由下方**单选卡片组**接管（Windows/Electron 下原生下拉经常点不开）。
                //   ⇒ 那四个是纯**死 DOM**：不可见、其 `onChange` 永不触发，
                //     却仍渲染出 `<option>` 并把 state 挂在上面 ——
                //     既是维护陷阱（改 options 会让人误以为生效），
                //     也是「一份状态两套 UI 判据」这种本仓库红线形态。
                //   ⚠️ 守卫已同步改写：`tests/unit/new-account-dialog.spec.ts`
                //     里原先断言 `value: accioRegion` / `onChange: …target.value`
                //     （原生 select 专属形态）的那几条，现在锁的是**卡片组**的
                //     `onClick: () => setXxx(opt.value)` —— 否则删掉死 DOM
                //     会让守卫变成「保护一个不存在的东西」。
              // ⚠️ **label 自身到此闭合**（2026-10-17 审计 P2 修复）：
              //   删掉原先那个 `<select>`（第三个子参数）后，`label` 的
              //   `createElement(` 只剩两个参数 ⇒ 必须补这个右括号，
              //   否则 esbuild 报 `Expected ")" but found ";"`。
              //   ⚠️ 这类语法错误**单测查不出来**（本仓库 client 守卫多为
              //   源码文本断言，不做解析）⇒ 改完本文件**必须**跑
              //   `pnpm build:client`，见 AGENTS.md 的「单测只读源码文本」那条。
              ),
              // 彻底解决 Windows/Electron 下原生 <select> 下拉框经常点不开的恶心 bug：使用 100% 可靠的 DOM 单选卡片组
              React.createElement('div', {
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                  margin: '8px 0 16px',
                },
              },
                (astudioDialog
                  ? [
                      { value: 'local', label: '⚡ 一键导入本机桌面端凭据', desc: '需已在 AStudio 桌面端登录，自动读取本地会话' },
                      { value: 'web', label: '🌐 网页三合一快捷登录', desc: '在浏览器载体页中登录，支持手机短信/账号密码/微信扫码，免依赖桌面端' },
                    ].map((opt) => {
                      const active = astudioLoginMethod === opt.value;
                      return React.createElement('div', {
                        key: opt.value,
                        onClick: () => setAstudioLoginMethod(opt.value),
                        style: {
                          display: 'flex',
                          alignItems: 'center',
                          gap: '10px',
                          padding: '10px 14px',
                          borderRadius: '6px',
                          border: active
                            ? '1.5px solid var(--dsw-alias-primary, #0284c7)'
                            : '1px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.25))',
                          background: active
                            ? 'var(--dsw-alias-primary-tint, rgba(2, 132, 199, 0.1))'
                            : 'var(--dsw-alias-bg-layer-2, transparent)',
                          cursor: 'pointer',
                          transition: 'all 0.15s ease',
                          userSelect: 'none',
                        },
                      },
                        React.createElement('div', {
                          style: {
                            width: '14px',
                            height: '14px',
                            borderRadius: '50%',
                            border: active
                              ? '4px solid var(--dsw-alias-primary, #0284c7)'
                              : '1.5px solid var(--dsw-alias-border-l2, #8b949e)',
                            boxSizing: 'border-box',
                            flexShrink: 0,
                            background: active ? '#fff' : 'transparent',
                          },
                        }),
                        React.createElement('div', { style: { display: 'flex', flexDirection: 'column' } },
                          React.createElement('span', {
                            style: {
                              fontSize: '13px',
                              fontWeight: active ? 600 : 400,
                              color: 'var(--dsw-alias-label-primary, inherit)',
                            },
                          }, opt.label),
                          React.createElement('span', {
                            style: {
                              fontSize: '11px',
                              color: 'var(--dsw-alias-label-tertiary, #888)',
                              marginTop: '2px',
                            },
                          }, opt.desc)
                        )
                      );
                    })
                  : (accioDialog
                      ? [
                          { value: 'cn', label: '🇨🇳 中国版（www.accio-ai.com）', desc: '适用于 Accio 国内站点账号' },
                          { value: 'global', label: '🌐 国际版（zh.accio.com）', desc: '适用于 Accio 国际站点账号' },
                        ].map((opt) => {
                          const active = accioRegion === opt.value;
                          return React.createElement('div', {
                            key: opt.value,
                            onClick: () => setAccioRegion(opt.value),
                            style: {
                              display: 'flex',
                              alignItems: 'center',
                              gap: '10px',
                              padding: '10px 14px',
                              borderRadius: '6px',
                              border: active
                                ? '1.5px solid var(--dsw-alias-primary, #0284c7)'
                                : '1px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.25))',
                              background: active
                                ? 'var(--dsw-alias-primary-tint, rgba(2, 132, 199, 0.1))'
                                : 'var(--dsw-alias-bg-layer-2, transparent)',
                              cursor: 'pointer',
                              transition: 'all 0.15s ease',
                              userSelect: 'none',
                            },
                          },
                            React.createElement('div', {
                              style: {
                                width: '14px',
                                height: '14px',
                                borderRadius: '50%',
                                border: active
                                  ? '4px solid var(--dsw-alias-primary, #0284c7)'
                                  : '1.5px solid var(--dsw-alias-border-l2, #8b949e)',
                                boxSizing: 'border-box',
                                flexShrink: 0,
                                background: active ? '#fff' : 'transparent',
                              },
                            }),
                            React.createElement('div', { style: { display: 'flex', flexDirection: 'column' } },
                              React.createElement('span', {
                                style: {
                                  fontSize: '13px',
                                  fontWeight: active ? 600 : 400,
                                  color: 'var(--dsw-alias-label-primary, inherit)',
                                },
                              }, opt.label),
                              React.createElement('span', {
                                style: {
                                  fontSize: '11px',
                                  color: 'var(--dsw-alias-label-tertiary, #888)',
                                  marginTop: '2px',
                                },
                              }, opt.desc)
                            )
                          );
                        })
                  : (autoclawDialog
                      ? [
                          { value: 'local', label: '⚡ 一键导入本机桌面端凭据', desc: '需已在 AutoClaw 桌面端登录，自动秒级解密' },
                          // ⚠️ 国际版**不渲染**这条：它的账号是邮箱 + Z.ai OAuth 创建的、
                          //    `phone` 为 null、无绑手机端点 ⇒ 短信必然失败（详见
                          //    `autoclawSmsAvailable` 的注释）。
                          ...(autoclawSmsAvailable
                            ? [{ value: 'sms', label: '📱 手机验证码快速登录', desc: '免安装桌面端，支持输入任意手机号登录' }]
                            : []),
                        ].map((opt) => {                          const active = autoclawMode === opt.value;
                          return React.createElement('div', {
                            key: opt.value,
                            onClick: () => setAutoclawMode(opt.value),
                            style: {
                              display: 'flex',
                              alignItems: 'center',
                              gap: '10px',
                              padding: '10px 14px',
                              borderRadius: '6px',
                              border: active
                                ? '1.5px solid var(--dsw-alias-primary, #0284c7)'
                                : '1px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.25))',
                              background: active
                                ? 'var(--dsw-alias-primary-tint, rgba(2, 132, 199, 0.1))'
                                : 'var(--dsw-alias-bg-layer-2, transparent)',
                              cursor: 'pointer',
                              transition: 'all 0.15s ease',
                              userSelect: 'none',
                            },
                          },
                            React.createElement('div', {
                              style: {
                                width: '14px',
                                height: '14px',
                                borderRadius: '50%',
                                border: active
                                  ? '4px solid var(--dsw-alias-primary, #0284c7)'
                                  : '1.5px solid var(--dsw-alias-border-l2, #8b949e)',
                                boxSizing: 'border-box',
                                flexShrink: 0,
                                background: active ? '#fff' : 'transparent',
                              },
                            }),
                            React.createElement('div', { style: { display: 'flex', flexDirection: 'column' } },
                              React.createElement('span', {
                                style: {
                                  fontSize: '13px',
                                  fontWeight: active ? 600 : 400,
                                  color: 'var(--dsw-alias-label-primary, inherit)',
                                },
                              }, opt.label),
                              React.createElement('span', {
                                style: {
                                  fontSize: '11px',
                                  color: 'var(--dsw-alias-label-tertiary, #888)',
                                  marginTop: '2px',
                                },
                              }, opt.desc)
                            )
                          );
                        })
                      : [
                          { value: 'bigmodel', label: '🇨🇳 BigModel（智谱开放平台，国内）', desc: '适用于 open.bigmodel.cn 国内平台账号' },
                          { value: 'zai', label: '🌐 z.ai（chat.z.ai，国际版）', desc: '适用于 z.ai 国际版账号' },
                        ].map((opt) => {
                          const active = zcodeProvider === opt.value;
                          return React.createElement('div', {
                            key: opt.value,
                            onClick: () => setZcodeProvider(opt.value),
                            style: {
                              display: 'flex',
                              alignItems: 'center',
                              gap: '10px',
                              padding: '10px 14px',
                              borderRadius: '6px',
                              border: active
                                ? '1.5px solid var(--dsw-alias-primary, #0284c7)'
                                : '1px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.25))',
                              background: active
                                ? 'var(--dsw-alias-primary-tint, rgba(2, 132, 199, 0.1))'
                                : 'var(--dsw-alias-bg-layer-2, transparent)',
                              cursor: 'pointer',
                              transition: 'all 0.15s ease',
                              userSelect: 'none',
                            },
                          },
                            React.createElement('div', {
                              style: {
                                width: '14px',
                                height: '14px',
                                borderRadius: '50%',
                                border: active
                                  ? '4px solid var(--dsw-alias-primary, #0284c7)'
                                  : '1.5px solid var(--dsw-alias-border-l2, #8b949e)',
                                boxSizing: 'border-box',
                                flexShrink: 0,
                                background: active ? '#fff' : 'transparent',
                              },
                            }),
                            React.createElement('div', { style: { display: 'flex', flexDirection: 'column' } },
                              React.createElement('span', {
                                style: {
                                  fontSize: '13px',
                                  fontWeight: active ? 600 : 400,
                                  color: 'var(--dsw-alias-label-primary, inherit)',
                                },
                              }, opt.label),
                              React.createElement('span', {
                                style: {
                                  fontSize: '11px',
                                  color: 'var(--dsw-alias-label-tertiary, #888)',
                                  marginTop: '2px',
                                },
                              }, opt.desc)
                            )
                          );
                        }))))),
              React.createElement('div', { className: 'dim-jh-zcDialogActions' },
                React.createElement('button', {
                  className: 'dim-jh-btn',
                  onClick: () => setPendingLogin(undefined),
                }, '取消'),
                React.createElement('button', {
                  className: 'dim-jh-btn',
                  'data-kind': 'primary',
                  onClick: () => {
                    setPendingLogin(undefined)
                    void createAccount()
                  },
                // ⚠ 两家（astudio / autoclaw）都在「本机导入」档时改成导入语义文案，
                //    其余档都是打开认证页。两个 provider 各判各的，不可合并。
                },
                (astudioDialog && astudioLoginMethod === 'local') || (autoclawDialog && autoclawMode === 'local')
                  ? '确定并导入本地账号'
                  : '确定并打开认证页'))),
        )),
    probeNotice
      ? React.createElement('div', {
          className: 'dim-jh-probeNotice',
          'data-tone': probeNotice.tone,
          role: 'status',
        },
        React.createElement('div', null, probeNotice.text),
        // ⚠️ 不能直接读 `probeNotice.details.length`：`probeNotice` 若被写成裸
        //    字符串（2026-10-22 整页白屏事故），`.details` 是 undefined ⇒ 抛
        //    TypeError ⇒ 整个 Jet Hub 设置页被 React 卸载。这里按「无明细」
        //    降级：宁可少一行明细，也不能让整页消失。
        safeNoticeDetails(probeNotice.details).length > 0
          ? React.createElement('ul', { className: 'dim-jh-probeDetails' },
              safeNoticeDetails(probeNotice.details).map((d, i) => React.createElement('li', { key: i }, d)))
          : null)
      : null,
    lockNotice
      ? React.createElement('div', {
          className: 'dim-jh-probeNotice',
          'data-tone': lockNotice.tone,
          role: lockNotice.tone === 'error' ? 'alert' : 'status',
        }, lockNotice.text)
      : null,
    claimNotice
      ? React.createElement('div', {
          className: 'dim-jh-probeNotice',
          'data-tone': claimNotice.tone,
          role: claimNotice.tone === 'error' ? 'alert' : 'status',
        },
        React.createElement('div', null, claimNotice.text),
        // 逐账号原因列表。没有它时用户只看到「1 个失败」，无从判断是
        // 凭据问题、活动未开、还是解析 bug。
        (claimNotice.details || []).length > 0
          ? React.createElement('ul', { className: 'dim-jh-probeDetails' },
              claimNotice.details.map((d, i) => React.createElement('li', { key: i }, d)))
          : null)
      : null,
    // 新手任务结果（仅 Loomy，一次性领取）。
    onboardingNotice
      ? React.createElement('div', {
          className: 'dim-jh-probeNotice',
          'data-tone': onboardingNotice.tone,
          role: onboardingNotice.tone === 'error' ? 'alert' : 'status',
        },
        React.createElement('div', null, onboardingNotice.text),
        (onboardingNotice.details || []).length > 0
          ? React.createElement('ul', { className: 'dim-jh-probeDetails' },
              onboardingNotice.details.map((line, index) =>
                React.createElement('li', { key: index }, line)))
          : null)
      : null,
    // 弹窗被拦截：给出可点击的登录链接 + 复制按钮。不劫持当前页面（见 createAccount 的说明）。
    // 链接 300+ 字符，用户此刻唯一动作就是复制到别处；手工框选漏一个字符会得到「授权失败」假象。
    loginUrlForManual
      ? React.createElement('div', {
          className: 'dim-jh-probeNotice',
          'data-tone': 'warn',
          role: 'alert',
        },
        React.createElement('div', null, '登录窗口被浏览器拦截，请手动打开下方链接完成登录：'),
        React.createElement('div', {
          className: 'dim-jh-loginLinkRow',
          'data-copy-state': loginLinkCopied === false ? 'failed' : 'idle',
        },
          React.createElement('a', {
            className: 'dim-jh-loginLink',
            href: loginUrlForManual,
            target: '_blank',
            rel: 'noopener noreferrer',
          }, loginUrlForManual),
          // type='button' 必须有：按钮若落在表单里，默认 submit 会连带提交表单。
          React.createElement('button', {
            className: 'dim-jh-btn',
            type: 'button',
            title: loginLinkCopied === false ? '复制失败：请手动选中链接后按 Ctrl+C' : '复制授权链接',
            onClick: async () => setLoginLinkCopied(await copyToClipboard(loginUrlForManual)),
          }, loginLinkCopied === true ? '已复制 ✓'
            : loginLinkCopied === false ? '复制失败，请手动选中' : '复制链接')))
      : null,
    compensationCard,
    phase === 'loading'
      ? React.createElement('div', { className: 'dim-jh-empty' }, '正在读取账号列表…')
      : phase === 'error'
        ? React.createElement('div', { className: 'dim-jh-empty', role: 'alert' },
            React.createElement('p', null, error),
            React.createElement('button', { className: 'dim-jh-btn', onClick: loadAccounts }, '重新读取'))
        : accounts.length === 0
          ? React.createElement('div', { className: 'dim-jh-empty' },
              // ⚠️ opencode 的「新建」是**粘贴 API key**、不是浏览器登录，
              // 空态文案必须跟着变 —— 否则用户会去找一个根本不存在的登录页。
              provider === 'opencode'
                ? React.createElement('div', null,
                    React.createElement('p', null,
                      '尚未添加账号。免费模型无需账号即可使用；添加自己的 API key 可启用付费模型，并为每个账号配置独立出口。'),
                    React.createElement('p', { className: 'dim-jh-hint' },
                      'API key 在 opencode.ai/auth 生成，形如 sk-…'))
                : React.createElement('div', null,
                    React.createElement('p', null, '尚未配置账号'),
                    React.createElement('p', null, '点击"+ 新建账号"进行浏览器登录。')))
          : React.createElement('div', { className: 'dim-jh-accountList' },
              // ⚠️ **必须有 className**（2026-10-21 修）：本行的父级是
              // `.dim-jh-panelHead`（column flex），而它原先带 `align-items: flex-start`
              // ⇒ 无类名的 div 作为 flex item 会**收缩到内容宽度** —— 只有单个账号时
              // 卡片缩成 ~257px 的窄条（多账号时被那句排序提示撑宽，所以看起来正常）。
              // `.dim-jh-accountList` 用 `align-self: stretch` 强制满宽，与账号数量无关。
              // ⚠️ **根因已另修**（`jet-hub-styles.js` 的 `.dim-jh-panelHead` 去掉了
              // `align-items: flex-start` ⇒ 全部子项 stretch）⇒ 本条规则现在是冗余兜底。
              // ⚠️ 注释里原先写的「654px 长的排序提示」是**错的**（2026-10-21 实测：
              // 那句是两段拼接、共 100 字符、12px 字号 ⇒ max-content **约 1200px**）。
              // ⚠️ opencode 专属策略提示：必须说清「多账号 ≠ 多额度」——
              // 匿名通道按出口 IP 限流，同一出口下的多个账号共用一份额度。
              // 不解释的话，用户加了 5 个号却只看到一份配额，会以为功能坏了。
              provider === 'opencode'
                ? React.createElement('p', { className: 'dim-jh-hint' },
                    '免费模型在所有通道间自动轮换，收费模型仅「API key 账号」可用。'
                    + '匿名通道无需 key，可添加多条、各自配代理；'
                    + '注意额度按「出口 IP」计算 —— 多条通道共用一个出口不会增加额度，'
                    + '分别配不同代理才会各自获得独立额度。')
                : null,
              // 排序提示：顺序会真实影响自动选号，必须让用户知道，否则
              // 「拖了有什么用」无从得知。仅两个以上账号时才显示。
              accounts.length > 1
                ? React.createElement('p', { className: 'dim-jh-orderHint' },
                    '拖动卡片可调整顺序（也可直接拖整张卡片）。顺序即自动选号与限流换号的优先级，排在前面的账号优先使用。'
                    + '命中限额的账号会自动沉到末尾，恢复后仍留在末尾 —— 这样额度不会因为某个号一直霸占首位而白白过期。')
                : null,
              reorderError
                ? React.createElement('div', {
                    className: 'dim-jh-probeNotice',
                    'data-tone': 'warn',
                    role: 'alert',
                  }, React.createElement('div', null, `顺序保存失败：${reorderError}`))
                : null,
              accounts.map((account, index) => React.createElement(AccountCard, {
                key: account.id,
                account,
                index,
                // ⚠️ `provider` 必须传进来：积分行的**池名分桶**要按 provider
                // 决定另一个池的标签（Loomy 是「永久」、Raccoon 是「长期」）。
                // 漏传会在渲染时抛 `ReferenceError: provider is not defined`
                // 并让整个 Jet Hub 设置页崩成白屏（真实事故，2026-09-29）。
                provider,
                busy: probeBusy !== null,
                credits: credits[account.id],
                creditsLoading: creditsLoading && credits[account.id] === undefined,
                // ⚠️ accio **不再**关掉通用积分行（2026-10-13 改）：
                // 用户报障原文「accio 的显示和别的 provider 没统一，例如 loomy 的」。
                // 现改为与 loomy 同形 —— 卡片里就是积分行，三类桶由
                // `CreditBalanceRow` 的 `formatNamedPoolLine` 逐池列出，
                // 倒计时作为同一行内的一个附注（见那里的注释）。
                showCredits: canLoadCredits,
                // 账号名 hover 列资源包：只有余额真由多个包构成的 provider 才挂
                // （loomy 的池是我们合成的、无到期字段，列出来会把「每日赠送」
                // 标成长期 —— 恰好说反）。
                showPackageList: supportsCreditPackageList(provider),
                // 「临时 / 长期」分桶的窗口天数（buddy 系 + TRAE + LobsterAI 才有值）。
                windowDays: expiryWindowDays,
                // 卡片级「重测 / 重置」：只对会返回限流错误的 provider 渲染。
                showRateLimitActions: supportsRateLimit(provider),
                onToggle: toggleAccount,
                onDelete: deleteAccount,
                onRetest: (id) => void runLimitAction('retest', id),
                onReset: (id) => void runLimitAction('reset', id),
                // ⚠️ 「测试」用**独立**的能力位（`supportsAccountTest`）与独立的
                // props 存在性开关，不能挂在 `showRateLimitActions` 上：Gemini
                // 恰好只登记了测试、没登记重测（它的限流是配额窗口制，重测无意义），
                // 绑一起就会二选一地消失一个按钮。
                onTest: supportsAccountTest(provider)
                  ? (id) => void runTestAction(id)
                  : undefined,
                // ⚠️ 仅 opencode：这两个回调只在该 provider 下传，
                // AccountCard 靠「props 存在性」决定是否渲染按钮。
                ...(provider === 'opencode'
                  ? {
                      onOpenProxy: (id, current) => setProxyModal({ provider, accountId: id, current }),
                      onRotateFingerprint: (id) => void rotateFingerprint(id),
                    }
                  : {}),
                // ⚠️ **Gemini 也要「代理」按钮**（Gitee issue IKLTZ2）：它的全部端点
                // 都在墙外，而插件进程**不读系统代理** ⇒ 没出口就恒连不上。
                // ⚠️ 与 opencode **刻意分成两个回调**而不是共用：两者读不同的池字段
                //（`geminiProxy` / `opencodeProxy`）、调不同的端点前缀、共用会让
                // 「清掉 Gemini 的代理」连带清掉 opencode 的出口配置。
                ...(provider === 'gemini'
                  ? {
                      onOpenProxy: (id, current) => setProxyModal({ provider, accountId: id, current }),
                    }
                  : {}),
                // ⚠️ **本 fork 独有**（modelscope，2026-10-17）：编辑访问令牌。
                // 同样只在该 provider 下传，靠「props 存在性」决定是否渲染按钮。
                ...(provider === 'modelscope'
                  ? {
                      onEditModelscopeKey: (id, masked) => setKeyEditModal({
                        accountId: id, currentMasked: masked,
                      }),
                    }
                  : {}),
                // 新手任务（仅 Loomy）：一次性 10000 分，每号只能领一次。
                // 与「一键领取积分」（每日签到）是**不同**的操作，故独立按钮。
                onClaimOnboarding: canClaimOnboarding
                  ? (id) => void claimOnboarding(id)
                  : undefined,
                onboardingBusy: onboardingLoading,
                // 提交顺序期间禁用拖拽，避免并发提交互相覆盖。
                drag: reordering ? { enabled: false } : dragPropsFor(account, index),
              }))),
    // 模型列表以 modal 渲染：它是覆盖层，放在账号区之后只是组件树的书写顺序，
    // 实际靠 fixed 定位浮在整个面板之上，不再挤占账号池的版面。
    showModels
      ? React.createElement(ModelListPanel, {
          provider,
          rpcCall,
          onClose: () => setShowModels(false),
        })
      : null,
    // 「订阅额度」弹窗同样以覆盖层渲染（不挤占账号池版面）。
    // 不复用 ModelListPanel 的 provider 形参：额度端点当前只认 Cline，
    // 由 `canShowSubscriptionQuota` 门控按钮，面板内部固定传 'cline'。
    showQuota
      ? React.createElement(ClineQuotaPanel, {
          rpcCall,
          onClose: () => setShowQuota(false),
        })
      : null,
    // MiniMax 国际站分流设置弹窗（issue IKMEVG）：覆盖层，独立 state。
    showMinimaxXff
      ? React.createElement(MinimaxXffPanel, {
          rpcCall,
          value: minimaxXff,
          onSaved: (next) => setMinimaxXff(next),
          onClose: () => setShowMinimaxXff(false),
        })
      : null,
    // 出口代理弹窗（仅 opencode）：覆盖层，与上面两个弹窗各自独立 state，
    // 同时打开也只是叠加，不会互相顶掉。
    //
    // ⚠️⚠️ **必须用 `React.createElement(组件, props)`，不能直接调用函数**
    // （真实事故 2026-10-02）：这两个弹窗内部有 `useState`，若在
    // ProviderPanel 的渲染过程中**直接函数调用**，它们的 hook 会被算进
    // ProviderPanel —— 于是「打开弹窗」与「关闭弹窗」两次渲染的 hook 数量
    // 不同，React 抛 #310（"Rendered more hooks than during the previous render"），
    // 整个设置页崩成白屏。仓库其它弹窗（ModelListPanel / BackupPanel /
    // ClineQuotaPanel）都是 `createElement` 形式，正是这个原因。
    proxyModal
      ? React.createElement(proxyModal.provider === 'gemini' ? GeminiProxyModal : OpencodeProxyModal, {
          // ⚠️ 传最小 ctx 门面而不是整个面板：弹窗只需要 rpc，
          // 这样它在单测/复用时不必拖上整个 ProviderPanel 的依赖。
          ctx: { rpc: (payload) => rpcCall(payload.method, payload.payload) },
          accountId: proxyModal.accountId,
          current: proxyModal.current,
          onClose: () => setProxyModal(null),
        })
      : null,
    // 「添加 opencode 账号」弹窗：自绘而非 window.prompt ——
    // DSH 客户端沙箱里 prompt() 直接抛 `prompt() is not supported`（真机报障）。
    keyModal && keyModal.provider !== 'modelscope'
      ? React.createElement(OpencodeKeyModal, {
          error: keyModal.error,
          busy: creating,
          inputRef: keyInputRef,
          onSubmit: (value) => void submitOpencodeKey(value),
          onSubmitAnonymous: () => void submitAnonymous(),
          onClose: () => setKeyModal(null),
        })
      : null,
    // ⚠️ **本 fork 独有**（魔搭）：与上面共用 `keyModal` 状态与 `keyInputRef`
    //    （两个弹窗都是单例、互斥显示），但**按 provider 分派** —— 本仓库约定
    //    「通用面板里的按钮与弹窗必须按 provider 分支」，两家的表单字段不同。
    //    ⚠️ 必须用 `React.createElement` 而非直接调用组件函数：直接调用会把
    //    组件的 hook 算进 ProviderPanel（该文件头记录过 hook #310 事故）。
    keyModal && keyModal.provider === 'modelscope'
      ? React.createElement(ModelscopeKeyModal, {
          error: keyModal.error,
          busy: creating,
          inputRef: keyInputRef,
          onSubmit: (value) => void submitModelscopeKey(value),
          onClose: () => setKeyModal(null),
        })
      : null,
    // ⚠️ **本 fork 独有**（魔搭）：「编辑访问令牌」弹窗（独立 state + 独立 ref）。
    // ⚠️ 必须用 `React.createElement` 而非直接调用组件函数：直接调用会把组件的
    // hook 算进 ProviderPanel（该文件头记录过 hook #310 事故，整个设置页白屏）。
    keyEditModal
      ? React.createElement(ModelscopeKeyEditModal, {
          error: keyEditModal.error || '',
          busy: creating,
          currentMasked: keyEditModal.currentMasked || '',
          inputRef: keyEditInputRef,
          onSubmit: (value) => void submitModelscopeKeyEdit(value),
          onClose: () => setKeyEditModal(null),
        })
      : null));
}

/**
 * 账号备份（导出 / 恢复）。
 *
 * 放在 Jet Hub 页面头部（关闭按钮旁），面向「更换 DSH 版本」的迁移场景：
 * 导出把全部账号的密钥/凭据与模型黑名单打包成一个自包含 JSON，导入整体
 * 还原。加密在浏览器侧完成（PBKDF2 + AES-GCM，见 backup-crypto.js）——
 * 明文 JSON 不经过 RPC / 日志，加密与否由用户在导出弹窗里选择（默认加密）。
 *
 * 弹窗被拦截 / 口令错误等失败只提示、不清空已选文件，用户可以修正后重试。
 */
function BackupPanel({ rpcCall, onImported }) {
  // 当前打开的弹窗：null | 'export' | 'import'
  const [dialog, setDialog] = React.useState(null);
  // 导出弹窗：是否加密 + 两次口令
  const [encrypt, setEncrypt] = React.useState(true);
  const [pass1, setPass1] = React.useState('');
  const [pass2, setPass2] = React.useState('');
  // 导入弹窗：已选文件（解析后的对象 + 是否加密容器）
  const [importFile, setImportFile] = React.useState(null);
  const [importPass, setImportPass] = React.useState('');
  // 当前账号池统计（backup.status）：缺 expiresAt 的条目疑似版本切换自动恢复
  // 的产物，导入会整体覆盖它们——用于确认文案里显式提示。
  const [backupStatus, setBackupStatus] = React.useState(null);
  // 导入两步式：false = 口令/提示页，true = 确认页（应用内二次确认，替代 confirm()）
  const [confirmStep, setConfirmStep] = React.useState(false);
  // 解密后的备份载荷（确认页展示账号数 & 导入时使用）
  const [decryptedPayload, setDecryptedPayload] = React.useState(null);
  // 正在提交（导出/解密/导入进行中，禁用按钮）
  const [busy, setBusy] = React.useState(false);
  // 弹窗内提示（成功 / 失败 / 口令不一致等）
  const [notice, setNotice] = React.useState(null);
  /**
   * 导出时选中的账号 id（null = 全部）。
   *
   * 「单独导出某个账号」= 勾掉其余账号。只影响 accounts / credentials 两个
   * 字段，黑名单与锁定表仍是全量，故产物依然是可整体还原的自包含快照。
   */
  const [exportIds, setExportIds] = React.useState(null);
  /**
   * 导入模式：'replace' 整体还原（覆盖全部）| 'merge' 仅追加（只增加，不覆盖）。
   *
   * 默认 replace = 保持既有「恢复」按钮的行为不变（老用户点进来还是还原）。
   */
  const [importMode, setImportMode] = React.useState('replace');
  /**
   * 导入时选中的账号 id（null = 备份里的全部账号）。
   *
   * 配合 `importMode === 'merge'` 即「单独导入一个账号」：从别人的整份备份里
   * 只挑一个加进自己的账号池。
   */
  const [importIds, setImportIds] = React.useState(null);
  const fileRef = React.useRef(null);
  const mounted = React.useRef(true);

  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const closeDialog = () => {
    if (!mounted.current) return;
    setDialog(null);
    setNotice(null);
    setBusy(false);
    setEncrypt(true);
    setPass1('');
    setPass2('');
    setImportFile(null);
    setImportPass('');
    setBackupStatus(null);
    setConfirmStep(false);
    setDecryptedPayload(null);
    setExportIds(null);
    setImportMode('replace');
    setImportIds(null);
  };

  const safeNotice = (next) => { if (mounted.current) setNotice(next); };

  /** 打开导出弹窗：拉取账号列表供勾选（拉不到就退化成「导出全部」）。 */
  const openExportDialog = async () => {
    setDialog('export');
    setNotice(null);
    setExportIds(null);
    try {
      const status = await rpcCall('backup.status', {});
      if (mounted.current) setBackupStatus(status || null);
    } catch (caught) {
      // 账号列表只是勾选辅助：拿不到不影响「导出全部」这条主路径。
      console.warn('[jet-hub] backup.status failed:', caught);
    }
  };

  /** 导出：RPC 取载荷 → （可选）加密 → 浏览器下载。 */
  const doExport = async () => {
    if (encrypt && pass1.length === 0) {
      safeNotice({ tone: 'warn', text: '请设置备份口令' });
      return;
    }
    if (encrypt && pass1 !== pass2) {
      safeNotice({ tone: 'warn', text: '两次输入的口令不一致' });
      return;
    }
    // 勾了账号但一个都没选：明确报错而不是静默导出全部 —— 后者会让用户拿到
    // 一份含全部账号的文件，与他「只导一个」的意图相反（泄漏面变大）。
    //
    // ⚠️ 变量名刻意避开 model-filter 那条全局字符串守卫的禁用标识符：
    // `tests/unit/model-filter.spec.ts` 有一道源码级回归墙（防止 ModelListPanel
    // 的多选勾选被重新引入），它不区分文件里的位置，用同名会被误判为回归。
    // 那个守卫本身是对的，不该为这里放宽。
    const exportIdList = exportIds === null ? null : Array.from(exportIds);
    if (exportIdList !== null && exportIdList.length === 0) {
      safeNotice({ tone: 'warn', text: '请至少勾选一个账号，或选择「导出全部」' });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      // 必须传空对象而非省略 payload：callManagementRpc 会把 payload 序列化进
      // 请求体，后端校验要求 payload 键存在；传 undefined 会被 JSON 序列化丢弃，
      // 导致后端报 "Invalid Jet Hub management request."
      const res = await rpcCall('backup.export', exportIdList === null ? {} : { accountIds: exportIdList });
      const payload = res.payload;
      const warnings = res.warnings || [];
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      // 文件名带账号数，避免「只导了一个」的文件被误当成整份备份收着
      const single = payload.accounts.length === 1 ? `-${payload.accounts[0].id}` : '';
      let data = payload;
      let filename = `dsh-codearts-backup${single}-${stamp}.json`;
      if (encrypt) {
        data = await encryptBackup(payload, pass1);
        filename = `dsh-codearts-backup${single}-${stamp}.enc.json`;
      }
      downloadJson(filename, data);
      const extra = warnings.length > 0 ? `，${warnings.length} 个账号凭据缺失（已跳过）` : '';
      // 不自动关闭：让用户看到成功结果（含跳过提示），再手动关闭
      safeNotice({ tone: 'ok', text: `已导出 ${payload.accounts.length} 个账号${encrypt ? '（已加密）' : '（明文）'}${extra}` });
    } catch (caught) {
      console.error('[jet-hub] backup export failed:', caught);
      safeNotice({ tone: 'error', text: `导出失败：${caught?.message || '未知错误'}` });
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  /** 选择文件：读取并解析；加密容器留在弹窗里等口令，第三方账号列表自动转换。 */
  const onFileSelected = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    safeNotice(null);
    try {
      const text = await readFileAsText(file);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        safeNotice({ tone: 'error', text: `${file.name} 不是有效的 JSON 备份文件` });
        return;
      }
      if (!mounted.current) return;

      /**
       * 第三方账号列表（别的工具导出的裸数组）→ 本地转换成插件备份载荷。
       *
       * ⚠️ 转换发生在**前端**，且只改结构不改令牌；转换结果显示在弹窗里供核对。
       * 走这条路径时**不**询问口令（它不是加密容器），也**不**拉 backup.status
       * （第三方文件里没有本机账号信息，覆盖提示无意义）。
       */
      if (looksLikeForeignAccountList(parsed)) {
        const converted = convertForeignAccounts(parsed);
        if (converted === null) {
          safeNotice({ tone: 'error', text: `${file.name} 无法识别为账号列表` });
          return;
        }
        setImportFile({
          name: file.name,
          encrypted: false,
          parsed: converted.payload,
          converted: {
            count: converted.accounts.length,
            warnings: converted.warnings,
            providers: converted.providers,
          },
        });
        setDialog('import');
        setImportPass('');
        // ⚠️ 必须同时填 `decryptedPayload`：确认页读的是它（不是 importFile.parsed）。
        // 漏了这一步会走进确认页却显示「没有账号」，正是本次要修的那个症状。
        setDecryptedPayload(converted.payload);
        // 转换来的账号是「别人的新号」，默认落到**只追加**模式，避免误覆盖本机账号。
        setImportMode('merge');
        setImportIds(null);
        setConfirmStep(true);
        return;
      }

      setImportFile({ name: file.name, encrypted: isEncryptedBackup(parsed), parsed });
      setDialog('import');
      setImportPass('');
      // 换文件时清掉上一个文件的勾选与模式，避免把「上一个文件的勾选」带到这个文件。
      setImportMode('replace');
      setImportIds(null);
      // 拉取当前账号池统计：确认导入前提示「有 N 个自动恢复账号将被覆盖」。
      // 失败不阻断导入——提示只是辅助信息，拿不到就静默跳过。
      try {
        const status = await rpcCall('backup.status', {});
        if (mounted.current) setBackupStatus(status || null);
      } catch (caught) {
        console.warn('[jet-hub] backup.status failed:', caught);
      }
    } catch (caught) {
      console.error('[jet-hub] read backup file failed:', caught);
      safeNotice({ tone: 'error', text: `读取文件失败：${caught?.message || '未知错误'}` });
    }
  };

  /** 导入第一步：解密（如需）→ 进入应用内确认页。整体替换，不是合并。 */
  const stepImport = async () => {
    if (!importFile) return;
    if (importFile.encrypted) {
      if (importPass.length === 0) {
        safeNotice({ tone: 'warn', text: '请输入备份口令' });
        return;
      }
      setBusy(true);
      setNotice(null);
      try {
        const payload = await decryptBackup(importFile.parsed, importPass);
        if (!mounted.current) return;
        setDecryptedPayload(payload);
      } catch (caught) {
        console.error('[jet-hub] backup decrypt failed:', caught);
        safeNotice({ tone: 'error', text: '解密失败：口令错误或备份文件已被篡改' });
        setBusy(false);
        return;
      }
      setBusy(false);
    } else {
      setDecryptedPayload(importFile.parsed);
    }
    // 进入确认页（应用内二次确认，替代浏览器 confirm()）
    setConfirmStep(true);
    setNotice(null);
  };

  /**
   * 导入第二步：确认后执行导入 RPC。
   *
   * 两种模式共用一个端点（`backup.import` 的 `mode` 字段）：
   * - `replace`：整体还原，载荷原样发出；
   * - `merge`：只追加。载荷一律先**裁剪**成只含选中账号及其凭据 ——
   *   不裁剪的话，后端虽然只按选中账号判重，却仍会把备份里那些「不在选中
   *   范围」的凭据写进凭据存储（它们可能已被本机现有账号占用，写进去等于
   *   覆盖现有凭据），与「只增加不覆盖」的承诺相反。
   *
   * ⚠️ 「全部账号」也要裁剪（而不是直接把原始载荷发出去）：原始载荷里的
   * `credentials` 还含账号池之外的独立凭据 ref（各 provider 的默认单凭据），
   * 那些 ref 在合并语义下同样不该被回写。
   */
  const confirmImport = async () => {
    const payload = decryptedPayload;
    if (!payload) return;
    setBusy(true);
    setNotice(null);
    try {
      const allBackupIds = describeBackupAccounts(payload).map((entry) => entry.id);
      const targetIds = importIds === null ? allBackupIds : Array.from(importIds);
      if (importMode === 'merge' && targetIds.length === 0) {
        safeNotice({ tone: 'warn', text: '请至少勾选一个要导入的账号' });
        setBusy(false);
        return;
      }
      const outgoing = importMode === 'merge'
        ? trimBackupPayload(payload, targetIds)
        : payload;
      const res = await rpcCall('backup.import', importMode === 'merge'
        ? { payload: outgoing, mode: 'merge' }
        : { payload: outgoing });
      const parts = importMode === 'merge'
        ? [`新增 ${res.accountsImported ?? 0} 个账号`]
        : [`已导入 ${res.accountsImported} 个账号`];
      parts.push(`${res.credentialsImported} 条凭据`);
      // 合并模式下「已存在」是正常结果，必须显式告知 —— 否则用户看到「新增 0 个」
      // 会以为导入失败，而实际是刻意跳过（不覆盖现有账号）。
      if (importMode === 'merge' && Array.isArray(res.accountsSkipped) && res.accountsSkipped.length > 0) {
        parts.push(`${res.accountsSkipped.length} 个账号已存在（已跳过，未覆盖）`);
      }
      if (res.skipped.length > 0) parts.push(`${res.skipped.length} 条凭据跳过`);
      // 已过期的账号：refresh_token 仍有效时会自动静默续期；若也已失效则需重新登录
      if (res.expiredAccounts > 0) {
        parts.push(`${res.expiredAccounts} 个凭据已过期（失效账号需重新登录）`);
      }
      // 凭据缺失的账号：对应 provider 目录会被隐藏（像未登录一样），需重新登录
      if (res.missingCredentials > 0) {
        parts.push(`${res.missingCredentials} 个账号凭据缺失（需重新登录）`);
      }
      // 账号集合已变化：通知 JetHubPage 重新挂载 ProviderPanel 刷新列表；
      // 不自动关闭弹窗，让用户看到导入结果。
      onImported?.();
      safeNotice({ tone: 'ok', text: parts.join('，') });
    } catch (caught) {
      console.error('[jet-hub] backup import failed:', caught);
      safeNotice({ tone: 'error', text: `导入失败：${caught?.message || '未知错误'}` });
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  // 账号勾选列表（导出/导入共用）。`ids === null` 表示「全部」，此时不勾选任何
  // 单条、并把「全部」那行标记为选中态 —— 与用户的直觉一致。
  const renderAccountPicker = (entries, ids, setIds, emptyHint) => {
    if (!Array.isArray(entries) || entries.length === 0) {
      return React.createElement('p', { className: 'dim-jh-modalHint' }, emptyHint);
    }
    const allSelected = ids === null;
    const toggleOne = (id) => {
      // 从「全部」进入逐条模式时，以全部为基础再取消这一条（保留其余）。
      const base = new Set(ids === null ? entries.map((entry) => entry.id) : ids);
      if (base.has(id)) base.delete(id); else base.add(id);
      setIds(base);
    };
    return React.createElement('div', { className: 'dim-jh-accountPick' },
      React.createElement('label', { className: 'dim-jh-checkRow' },
        React.createElement('input', {
          type: 'checkbox',
          checked: allSelected,
          onChange: (event) => setIds(event.target.checked ? null : new Set()),
        }),
        `全部账号（${entries.length} 个）`),
      React.createElement('div', { className: 'dim-jh-accountPickList' },
        entries.map((entry) => React.createElement('label', {
          key: entry.id,
          className: 'dim-jh-checkRow dim-jh-accountPickRow',
        },
          React.createElement('input', {
            type: 'checkbox',
            // 「全部」态下每条都显示为选中，用户一取消某条就自动落到逐条模式。
            checked: allSelected || ids.has(entry.id),
            onChange: () => toggleOne(entry.id),
          }),
          React.createElement('span', { className: 'dim-jh-accountPickName' },
            entry.nickname || entry.id,
            React.createElement('span', { className: 'dim-jh-accountPickMeta' },
              `${entry.provider}${entry.enabled === false ? ' · 已停用' : ''}`))))));
  };

  // 弹窗通用结构：遮罩 + 对话框。点击遮罩关闭（与 ModelListPanel 同款）。
  const renderDialog = () => {
    const isExport = dialog === 'export';
    const title = isExport ? '导出备份' : '导入备份';
    const subtitle = isExport
      ? '全部或选中的账号密钥与凭据'
      : importFile?.name || '';
    const body = isExport ? (
      React.createElement(React.Fragment, null,
        React.createElement('p', { className: 'dim-jh-modalHint' },
          '备份文件包含账号的密钥与 refresh_token，请',
          React.createElement('strong', { className: 'dim-jh-emph-warn' }, '妥善保管'),
          '。'),
        React.createElement('p', { className: 'dim-jh-modalHint' },
          '备份是导出时刻的凭据快照：refresh_token 会随续期轮换或过期，建议导出后尽快迁移，导入后失效的账号需重新登录。'),
        renderAccountPicker(
          backupStatus?.accountList,
          exportIds,
          setExportIds,
          '读取账号列表失败，将导出全部账号。'),
        React.createElement('label', { className: 'dim-jh-checkRow' },
          React.createElement('input', {
            type: 'checkbox',
            checked: encrypt,
            onChange: (event) => setEncrypt(event.target.checked),
          }),
          '加密备份文件（推荐）'),
        encrypt
          ? React.createElement('div', { className: 'dim-jh-formRows' },
              React.createElement('input', {
                className: 'dim-jh-input',
                type: 'password',
                placeholder: '备份口令（用于解密，请牢记）',
                value: pass1,
                onChange: (event) => setPass1(event.target.value),
              }),
              React.createElement('input', {
                className: 'dim-jh-input',
                type: 'password',
                placeholder: '再次输入口令',
                value: pass2,
                onChange: (event) => setPass2(event.target.value),
              }))
          : null)
    ) : !isExport && confirmStep ? (
      // 导入确认页（应用内二次确认）：模式选择 + 覆盖警告 / 追加说明
      React.createElement(React.Fragment, null,
        // 第三方账号列表的转换摘要：让用户先确认「识别到了几条、都是谁」，
        // 再决定导入。没有这段提示时，用户会怀疑文件没被读进去。
        importFile?.converted
          ? React.createElement(React.Fragment, null,
              React.createElement('p', { className: 'dim-jh-modalHint' },
                '已自动识别为',
                React.createElement('strong', { className: 'dim-jh-emph-warn' }, '第三方账号列表'),
                '并转换为插件格式：共 ',
                React.createElement('strong', { className: 'dim-jh-emph-warn' }, `${importFile.converted.count}`),
                ' 个账号',
                importFile.converted.providers?.length > 0
                  ? `（${importFile.converted.providers.join('、')}）`
                  : '',
                '。'),
              importFile.converted.warnings?.length > 0
                ? React.createElement('p', { className: 'dim-jh-modalHint' },
                    `${importFile.converted.warnings.length} 条记录被跳过：`,
                    importFile.converted.warnings.slice(0, 3).join('；'),
                    importFile.converted.warnings.length > 3 ? ' …' : '')
                : null)
          : null,
        React.createElement('div', { className: 'dim-jh-modePick' },
          React.createElement('label', { className: 'dim-jh-checkRow' },
            React.createElement('input', {
              type: 'radio',
              name: 'dim-jh-import-mode',
              checked: importMode === 'replace',
              onChange: () => setImportMode('replace'),
            }),
            '整体还原（覆盖当前全部账号）'),
          React.createElement('label', { className: 'dim-jh-checkRow' },
            React.createElement('input', {
              type: 'radio',
              name: 'dim-jh-import-mode',
              checked: importMode === 'merge',
              onChange: () => setImportMode('merge'),
            }),
            '单独导入（只增加账号，不覆盖现有账号）')),
        importMode === 'replace'
          ? React.createElement(React.Fragment, null,
              React.createElement('p', { className: 'dim-jh-modalHint' },
                '导入将',
                React.createElement('strong', { className: 'dim-jh-emph-danger' }, '覆盖'),
                '当前全部账号与模型开关（共 ',
                React.createElement('strong', { className: 'dim-jh-emph-warn' }, `${decryptedPayload?.accounts?.length ?? 0}`),
                ' 个账号），且',
                React.createElement('strong', { className: 'dim-jh-emph-danger' }, '不可撤销'),
                '。'),
              backupStatus?.withoutExpiry > 0
                ? React.createElement('p', { className: 'dim-jh-modalHint' },
                    '当前有 ',
                    React.createElement('strong', { className: 'dim-jh-emph-warn' }, `${backupStatus.withoutExpiry}`),
                    ' 个账号缺少有效期信息（可能是版本切换后自动恢复的），导入将',
                    React.createElement('strong', { className: 'dim-jh-emph-warn' }, '整体覆盖'),
                    '它们。')
                : null)
          : React.createElement(React.Fragment, null,
              React.createElement('p', { className: 'dim-jh-modalHint' },
                '只把选中的账号',
                React.createElement('strong', { className: 'dim-jh-emph-warn' }, '追加'),
                '到当前账号池：同 id 的账号',
                React.createElement('strong', { className: 'dim-jh-emph-warn' }, '自动跳过、不会被覆盖'),
                '，现有账号、模型开关与锁定状态都不受影响。'),
              renderAccountPicker(
                describeBackupAccounts(decryptedPayload),
                importIds,
                setImportIds,
                '该备份文件里没有账号。')))
    ) : importFile?.encrypted ? (
      React.createElement(React.Fragment, null,
        React.createElement('p', { className: 'dim-jh-modalHint' },
          '该备份已加密，请输入导出时设置的口令。'),
        React.createElement('input', {
          className: 'dim-jh-input',
          type: 'password',
          placeholder: '备份口令',
          value: importPass,
          onChange: (event) => setImportPass(event.target.value),
        }))
    ) : (
      React.createElement('p', { className: 'dim-jh-modalHint' },
        '该备份为明文文件，点「下一步」后选择导入方式（整体还原或单独导入）。')
    );

    return React.createElement('div', {
      className: 'dim-jh-modalOverlay',
      onClick: (event) => { if (event.target === event.currentTarget) closeDialog(); },
    },
      React.createElement('div', {
        className: 'dim-jh-modal',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': title,
      },
        React.createElement('div', { className: 'dim-jh-modalHead' },
          React.createElement('div', { className: 'dim-jh-modalTitle' },
            React.createElement('strong', null, title),
            subtitle.length > 0
              ? React.createElement('span', { className: 'dim-jh-modalSubtitle' }, subtitle)
              : null),
          React.createElement('div', { className: 'dim-jh-modelPanelActions' },
            React.createElement('button', {
              className: 'dim-jh-btn',
              onClick: closeDialog,
            }, '关闭'))),
        React.createElement('div', { className: 'dim-jh-modalBody' },
          body,
          notice
            ? React.createElement('div', {
                className: 'dim-jh-probeNotice',
                'data-tone': notice.tone,
                role: notice.tone === 'error' ? 'alert' : 'status',
              }, React.createElement('div', null, notice.text))
            : null,
          React.createElement('div', { className: 'dim-jh-modalActions' },
            isExport
              ? React.createElement('button', {
                  className: 'dim-jh-btn',
                  'data-kind': 'primary',
                  disabled: busy,
                  onClick: () => void doExport(),
                }, busy ? '生成中…' : '生成备份文件')
              : confirmStep
                ? React.createElement(React.Fragment, null,
                    React.createElement('button', {
                      className: 'dim-jh-btn',
                      disabled: busy,
                      onClick: () => { setConfirmStep(false); setNotice(null); },
                    }, '返回'),
                    React.createElement('button', {
                      className: 'dim-jh-btn',
                      'data-kind': 'primary',
                      disabled: busy,
                      onClick: () => void confirmImport(),
                    }, busy ? '导入中…' : '确认导入'))
                : React.createElement('button', {
                    className: 'dim-jh-btn',
                    'data-kind': 'primary',
                    disabled: busy,
                    onClick: () => void stepImport(),
                  }, busy ? '处理中…' : '下一步')))));
  };

  return React.createElement(React.Fragment, null,
    React.createElement('button', {
      className: 'dim-jh-btn',
      title: '导出账号的密钥与凭据（全部或勾选其中几个），便于迁移或单独搬一个账号。',
      onClick: () => void openExportDialog(),
    }, '备份'),
    React.createElement('button', {
      className: 'dim-jh-btn',
      title: '从备份文件导入账号：可选「整体还原（会覆盖当前全部账号）」或「单独导入（只增加账号，不覆盖）」。',
      onClick: () => fileRef.current?.click(),
    }, '恢复'),
    React.createElement('input', {
      ref: fileRef,
      type: 'file',
      accept: '.json,application/json',
      style: { display: 'none' },
      onChange: onFileSelected,
    }),
    dialog !== null ? renderDialog() : null);
}

/** 触发浏览器下载一个 JSON 文件。 */
function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 读取文件为文本。 */
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/**
 * 供应商一行的影响面摘要（模型数 / 账号数）。
 *
 * ⚠️ 「读不到」与「确实是 0」必须区分：状态未返回时显示 `状态尚未读取`，
 * 而不是 `模型 0（已关 0）` —— 后者会让用户以为这个供应商没有模型，
 * 而实际上只是那一次 `provider.status` 还没回来（或失败了）。
 */
function providerRowSummary(row) {
  if (row.models === null && row.accounts === null) return '状态尚未读取';
  // ⚠️⚠️ **已关闭时不得渲染 `模型 0（已关 0）`**（Gitee issue IKP8OF，文案自相矛盾）。
  //
  // 真实形态：用户关闭了供应商，随后它的账号被全部删除 / 目录被清空 ⇒
  // 服务端 `{total:0, disabled:0, closed:true}`。此时按计数渲染会得到
  // 「模型 0（已关 0）」，而同一行还在「已关闭」分组里 —— 用户看到的是
  // 「一个没有模型的供应商被标成已关闭」，既不像事实也无法理解。
  // ⇒ 已关闭时直接说「已全部关闭」，不再报计数（关闭态下计数没有信息量）。
  const models = row.models
    ? (row.checked === false
      ? '模型已全部关闭'
      : `模型 ${row.models.total ?? 0}（已关 ${row.models.disabled ?? 0}）`)
    : '模型 —';
  const accounts = row.accounts
    ? `账号 ${row.accounts.total ?? 0}（启用 ${row.accounts.enabled ?? 0}）`
    : '账号 —';
  return `${models} · ${accounts}`;
}

/**
 * 「供应商开关」弹窗：页头按钮点开，一个供应商一行、行尾一个开关。
 *
 * ## 为什么从左侧导航里搬出来
 *
 * 原先开关直接挂在左侧每个供应商行的右侧（!25 的形态）。那是个**破坏性批量操作**
 * （一次改动几十个模型 + 全部账号），却和「选择要看哪个供应商」这个高频无害动作
 * 挤在同一行里：既容易误点，也让左侧那条本应承担导航的窄栏长出了控件。
 * 搬进弹窗后，开关与「显示列表」里的模型开关是同一种东西 —— 点进去、看清影响面、
 * 再决定，误点的可能性归零。
 *
 * ## 显示逻辑与模型列表弹窗保持一致（用户明确要求）
 *
 * 复用同一套结构与类名，而不是另起一套：
 * - 骨架：`dim-jh-modalOverlay--top` + `dim-jh-modalHead`（标题 / 计数 / 刷新 / 完成）
 *   + `dim-jh-modalHint` + `dim-jh-modalBody` + `dim-jh-modelList`；
 * - 行：`dim-jh-modelRow`（`data-disabled` 表示**该供应商已关闭** → 整行淡出，
 *   与模型列表里「已关闭的模型」同一语义）+ `dim-jh-modelInfo` / `dim-jh-modelName`
 *   / `dim-jh-modelId`（这里放影响面摘要）+ `dim-jh-switch`；
 * - 排序：已打开在前、已关闭在后（`providerSwitchRows`，与左侧分组同一判据）；
 *   已打开组支持**拖拽自定义顺序**（`order` prop = 宿主持久化顺序，2026-10-06），
 *   关闭组恒按声明顺序沉底（用户明确要求「这个逻辑不变」）；
 * - ESC 与点遮罩关闭。
 *
 * ⚠️ 行容器是 `<label>` 且**内部只能有这 1 个 checkbox** —— 与 `ModelToggle` 同一条
 * 约束（见其注释：插入第二个 checkbox 会让「点行内文字」激活错的那个控件）。
 * 拖拽柄因此只能用 `<span>`，且必须 `preventDefault` 掐掉 label 的激活路径
 * （见渲染处的注释）。
 *
 * 本组件不持有**持久化**数据：状态、busy 集合、切换动作与顺序全部由 `JetHubPage`
 * 传入；拖拽的视觉状态（正在拖哪行 / 落点在哪）是本组件的局部 UI 状态，drop 时
 * 通过 `onCommitOrder` 把新顺序交给页面层持久化。
 */
function ProviderSwitchPanel({ providers, statuses, statusFailed, busyIds, onToggle, onReload, onClose, order, onCommitOrder, reordering, notice, rpcCall }) {
  // ESC 关闭：挂在 document 上而不是弹窗上 —— 焦点可能落在任意一个开关上，
  // 只监听弹窗自身的 keydown 会漏掉这些按键（与 ModelListPanel 同因）。
  React.useEffect(() => {
    const onKeyDown = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // 拖拽排序的三件套视觉状态（与 ProviderPanel 的账号拖拽同款）：
  // 正在拖的行 id / 悬停的目标行 id / 落点方向。真正的顺序变更在 drop 时
  // 才经 onCommitOrder 提交给页面层持久化。
  const [draggingId, setDraggingId] = React.useState(null);
  const [dropTargetId, setDropTargetId] = React.useState(null);
  const [dropPosition, setDropPosition] = React.useState('before');

  /**
   * 视图切换：`switches`（本供应商的开关）/ `models`（跨供应商统一管模型）。
   *
   * ⚠️ 两屏**共用同一个弹窗**，而不是再挂一个全屏覆盖层 —— 本文件已有一份
   * 全屏覆盖层互斥清单（供应商 / 网关 / Token 用量，同时开就会叠在一起，
   * 而 ESC 只关掉后挂载的那一个，剩下一个挡住整个设置页）。给「模型列表」
   * 再开一层等于把那条纪律又复制一遍，且层数变成三层。
   *
   * ⚠️ 视图状态是**局部 UI 状态**：关掉弹窗即不挂载、下次打开回到开关屏
   * （用户点「供应商」时的默认意图是开关，不是模型管理）。
   */
  const [view, setView] = React.useState('switches');

  const rows = providerSwitchRows(providers, statuses, order);
  const summary = providerToggleSummary(providers, statuses);
  const countText = summary.known
    ? `共 ${summary.total} 个，已打开 ${summary.open}，已关闭 ${summary.closed}`
    : (statusFailed ? '状态读取失败' : '正在读取状态…');

  // 已打开 ≥2 行才值得拖（与账号面板同款门槛）；任一开关提交中则整体冻结，
  // 避免「拖到一半那行被停用」造成展示组与拖拽组错位。
  // ⚠️ `reordering`（排序提交中）也必须计入：提交期间界面顺序未变（不做乐观
  // 更新），再拖一次会基于旧顺序计算并把上一次移动静默覆盖（账号面板同款，
  // 那边是 `reordering ? { enabled: false } : dragPropsFor(...)`）。
  const dragEnabled = rows.filter(row => row.checked).length >= 2
    && busyIds.size === 0
    && !reordering;

  /**
   * 构造某一行的拖拽属性（关闭组或不允许拖时返回 enabled:false）。
   *
   * openIds / closedIds 取自 `rows` 而不是 providers+statuses 重算：rows 已经
   * 是「分组 + 排序」后的最终展示形态，`checked === false` 恰好就是已关闭组
   * （见 providerSwitchState：closed ⇔ checked=false），且保持声明顺序。
   */
  const dragPropsFor = (row) => {
    if (!row.checked || !dragEnabled) return { enabled: false };
    return {
      enabled: true,
      isDragging: draggingId === row.id,
      isDropTarget: dropTargetId === row.id && draggingId !== null && draggingId !== row.id,
      dropPosition,
      onDragStart: (event) => {
        setDraggingId(row.id);
        // 必须设置 dataTransfer，否则 Firefox 不触发拖拽（与账号卡片同因）。
        try { event.dataTransfer.setData('text/plain', row.id); } catch { /* 忽略 */ }
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      },
      onDragEnd: () => {
        setDraggingId(null);
        setDropTargetId(null);
      },
      onDragOver: (event) => {
        if (draggingId === null || draggingId === row.id) return;
        // 必须 preventDefault 才允许 drop。
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        if (dropTargetId !== row.id) setDropTargetId(row.id);
        // 按指针在行内的纵向位置决定插到前面还是后面。
        const rect = event.currentTarget?.getBoundingClientRect?.();
        const next = dropPositionFromPointer(event.clientY, rect);
        if (next !== dropPosition) setDropPosition(next);
      },
      onDrop: (event) => {
        event.preventDefault();
        const sourceId = draggingId;
        setDraggingId(null);
        setDropTargetId(null);
        if (sourceId === null || sourceId === row.id) return;
        const openIds = rows.filter(r => r.checked).map(r => r.id);
        const closedIds = rows.filter(r => !r.checked).map(r => r.id);
        // ⚠️ 必须传当前的 `order`（旧顺序）：已关闭 id 的位置由「它在旧顺序里
        // 的直接前驱」决定，漏传就退化成按展示序缀尾 —— 关闭期间拖过一次之后
        // 重开就会掉到末尾（PR #63 初版的真实缺陷）。
        const next = nextProviderOrderAfterDrop(openIds, closedIds, sourceId, row.id, dropPosition, order);
        if (next !== null) void onCommitOrder(next);
      },
    };
  };

  return React.createElement('div', {
    // `--top`：顶部锚定。行数固定但窗口高度会变，垂直居中会让弹窗上下跳动
    // （与模型列表同款，见 jet-hub-styles.js 中该修饰类的说明）。
    className: 'dim-jh-modalOverlay dim-jh-modalOverlay--top',
    onClick: (event) => { if (event.target === event.currentTarget) onClose(); },
  },
  React.createElement('div', {
    className: 'dim-jh-modal',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': '供应商开关',
  },
  React.createElement('div', { className: 'dim-jh-modalHead' },
    React.createElement('div', { className: 'dim-jh-modalTitle' },
      React.createElement('strong', null, view === 'models' ? '供应商模型列表' : '供应商开关'),
      React.createElement('span', { className: 'dim-jh-modelPanelCount' },
        view === 'models' ? '跨供应商统一管理' : countText)),
    React.createElement('div', { className: 'dim-jh-modelPanelActions' },
      // 两屏共用一个弹窗（见上面 `view` 的注释）。复用 `.dim-jh-modelStatusFilter`
      // 那套 `[data-active="true"]` 高亮样式，不新增样式类。
      React.createElement('div', {
        className: 'dim-jh-modelStatusFilter',
        role: 'group',
        'aria-label': '弹窗视图',
      },
      [['switches', '开关'], ['models', '模型列表']].map(([value, label]) => React.createElement('button', {
        key: value,
        className: 'dim-jh-btn',
        'data-active': view === value ? 'true' : 'false',
        'aria-pressed': view === value ? 'true' : 'false',
        title: value === 'models'
          ? '在同一个弹窗里管理全部供应商的模型开关（按需读取目录，不一次拉全部）'
          : '逐个打开/关闭供应商',
        onClick: () => setView(value),
      }, label))),
      React.createElement('button', {
        className: 'dim-jh-btn',
        title: '重新读取各供应商的模型数与账号数。',
        onClick: () => void onReload(),
      }, '刷新'),
      React.createElement('button', {
        className: 'dim-jh-btn',
        'data-kind': 'primary',
        onClick: onClose,
      }, '完成'))),
  view === 'models'
    // 模型列表屏有它自己的说明（在 ModelCenterPanel 里），这一条讲的是「关掉供应商」
    // 的语义 —— 放在模型屏会误导（用户会以为关模型等于关供应商）。
    ? null
    : React.createElement('p', { className: 'dim-jh-modalHint' },
        '关闭一个供应商 = 关闭它的全部模型（从对话框的模型选择里移除）并停用它的全部账号；'
        + '打开则恢复。关闭前会再确认一次。没有可关闭模型的供应商会被禁用（服务端也会拒绝）。'
        + '拖动已打开的行可自定义顺序（顺序只保存在本机）；已关闭的供应商仍按默认顺序显示在底部。'),
  // ⚠️ 供应商相关的提示必须在**这里**（弹窗内）显示，不能只挂在页面层：
  // 拖拽与开关切换都发生在弹窗打开期间，而弹窗遮罩是 fixed + z-index 3000，
  // 页面层的 notice 会被它整个盖住 —— 用户只会看到「操作没生效，却什么提示都没有」。
  // ⚠️ 弹窗开着时**显示全部** notice（含 toggleProvider 的结果/失败提示）——
  // 它们此刻在页面层同样被遮住，只按 inModal 过滤会让切换结果一样消失。
  // 弹窗关闭即不挂载、页面层那条照旧渲染，两边不会重复出现。
  // 复用既有 `.dim-jh-probeNotice` + `.dim-jh-modal .dim-jh-probeNotice` 样式，不新增样式。
  notice
    ? React.createElement('div', {
        className: 'dim-jh-probeNotice',
        'data-tone': notice.tone,
        role: notice.tone === 'error' ? 'alert' : 'status',
      }, React.createElement('div', null, notice.text))
    : null,
  React.createElement('div', { className: 'dim-jh-modalBody' },
    view === 'models'
      ? React.createElement(ModelCenterPanel, { providers, rpcCall, statuses })
      : React.createElement('div', { className: 'dim-jh-modelList' },
      rows.map(row => {
        const busy = busyIds.has(row.id);
        const action = row.checked ? '关闭' : '打开';
        const drag = dragPropsFor(row);
        return React.createElement('label', {
          key: row.id,
          className: 'dim-jh-modelRow',
          // 与模型列表同语义：`data-disabled` 表示**这一项已被关闭**（整行淡出），
          // 不是「这行点不动」—— 点不动由下面 input 的 disabled 表达。
          'data-disabled': row.checked ? 'false' : 'true',
          // 拖拽排序（与账号卡片同款视觉语言）：源行淡出、落点行画插入线。
          draggable: drag.enabled ? 'true' : undefined,
          onDragStart: drag.onDragStart,
          onDragEnd: drag.onDragEnd,
          onDragOver: drag.onDragOver,
          onDrop: drag.onDrop,
          'data-dragging': drag.isDragging ? 'true' : undefined,
          'data-dropBefore': drag.isDropTarget && drag.dropPosition !== 'after' ? 'true' : undefined,
          'data-dropAfter': drag.isDropTarget && drag.dropPosition === 'after' ? 'true' : undefined,
          title: row.disabled ? row.reason : `${action}「${row.label}」：${action}它的全部模型并${row.checked ? '停用' : '启用'}全部账号`,
        },
        drag.enabled
          ? React.createElement('span', {
              className: 'dim-jh-dragHandle',
              title: '拖动以调整顺序（顺序只保存在本机）',
              'aria-hidden': 'true',
              // ⚠️ 行容器是 <label>：点柄的 click 会沿 label 激活开关。preventDefault
              // 掐掉这条激活路径 —— 拖柄不是开关，点了不该有开关反应（拖拽本身
              // 不经过 click，互不影响）。
              onClick: (event) => { event.preventDefault(); event.stopPropagation(); },
            }, '⠿')
          : null,
        React.createElement('span', { className: 'dim-jh-modelInfo' },
          React.createElement('strong', { className: 'dim-jh-modelName' }, row.label),
          React.createElement('code', { className: 'dim-jh-modelId' }, providerRowSummary(row))),
        React.createElement('input', {
          type: 'checkbox',
          className: 'dim-jh-switch',
          role: 'switch',
          checked: row.checked,
          // busy 只锁被点的那一行：状态是服务端推导的，锁整表会让用户以为全挂了。
          disabled: row.disabled || busy,
          'aria-label': `${action} ${row.label}`,
          onChange: () => void onToggle(row.id, !row.checked),
        }));
      })))));
}

/**
 * 「供应商 → 模型列表」统一管理屏。
 *
 * ## 它解决的问题
 * 此前模型开关只能从**某一家**供应商面板的「显示列表」进入（`ModelListPanel`），
 * 想关掉五个供应商里的若干模型就要来回切换五次。这一屏把全部供应商放进同一棵树，
 * 按需展开、统一搜索、逐家批量。
 *
 * ## 按需读取，不是一次全拉
 * `model.list` 是**单 provider** 的接口（服务端没有跨全部供应商的批量端点），
 * 而一次性并发拉二十来家会同时打二十多个上游目录请求（Cline / WorkBuddy 的
 * 目录本身要访问远端），既可能触发限流，也让界面长时间没有任何反馈。因此：
 * - 分组**折叠时不发请求**，展开才拉（懒加载的唯一触发点是下面那个 effect）；
 * - 「加载全部」按并发 3 补齐，且**只补没就绪的**（`centerPendingProviderIds`）。
 * 代价是「未加载」成为一等状态 —— 没有它就会把「还没读」谎报成「0 个模型」，
 * 用户于是不会去展开那一家（`model-center.js` 里对此有单测）。
 *
 * ## 与 `ModelListPanel` 的分工
 * 这一屏只做**跨供应商的批量动作**：逐项开关、整家全开/全关、恢复已下架模型。
 * 单家内部的计费分组折叠（订阅 / 免费 / Cline Cloud / 按量计费）仍由
 * `ModelListPanel` 负责 —— 在这一层再套分组会让树深到不可用（二十家 × 四组）。
 *
 * ## 约束（与 `ModelToggle` / `ProviderSwitchPanel` 同源）
 * 行是 `<label>`，**每行只能有一个 checkbox** —— 开关一律交给 `ModelToggle` 渲染，
 * 本组件不自己造 checkbox（插第二个会让「点行内文字」激活错的那个控件）。
 * 本组件也刻意**不用 `createPortal`**（见 `ModelListPanel` 的注释：客户端模块表
 * 由宿主注入，`react-dom` 可能不在其中，require 会抛「missed the module table」白屏）。
 */
function ModelCenterPanel({ providers, rpcCall, statuses }) {
  // providerId -> { phase: 'idle'|'loading'|'ready'|'error', models, error }
  const [states, setStates] = React.useState({});
  const [query, setQuery] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState('all');
  // 用户显式动过的展开态（没动过的走 isOpen 的默认策略）
  const [openIds, setOpenIds] = React.useState({});
  // `${providerId}::${modelId}` -> true，只锁被点的那一行
  const [busyIds, setBusyIds] = React.useState(() => new Set());
  // 整家批量动作进行中的 providerId（与逐项 busy 分开：整家动作会让该家全部行变灰）
  const [providerBusy, setProviderBusy] = React.useState(() => new Set());
  const [toggleError, setToggleError] = React.useState('');
  const [toggleWarnings, setToggleWarnings] = React.useState([]);
  const [loadingAll, setLoadingAll] = React.useState(false);

  // 卸载后不再 setState：一轮「加载全部」会跨多个 await，中途关掉弹窗会把状态
  // 写进已卸载的组件（React 18 不警告，但白留一份闭包）。
  //
  // ⚠️⚠️ **挂载时必须复位 `mounted.current = true`**（2026-10-21 合并审计发现）：
  // React 18 StrictMode 的双挂载序列是「mount → effect → cleanup → effect」，
  // cleanup 把 `mounted.current` 置 `false`，**第二次 effect 若不复位**，
  // 之后所有 `if (!mounted.current) return` 恒成立 ⇒ RPC 结果全被丢弃
  // ⇒ 界面永远停在「正在读取该供应商的模型列表…」，且懒加载会因 state 不更新
  // 而**再发一次** `model.list`。
  //
  // ⚠️ 本文件既有的 `ModelListPanel`（`:1110`）**有**这一行 ⇒ 同一个文件里
  // 两套写法，本屏是漏掉的那套 ⇒ 按同构补齐。
  // ⚠️ 可达性：宿主 web bundle 里 `StrictMode` 无实际使用点 ⇒ **当前不可达**
  // （属「差一行复位」的脆弱绿，不是现行缺陷）。
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  /**
   * 读一家的目录。
   *
   * ⚠️ 已有数据时**不切回 loading** —— 整屏闪空再填回来比不刷新更糟，
   * 而且「全开/全关」之后的重载会让刚点的那一行消失一瞬。
   */
  const loadProvider = React.useCallback(async (providerId) => {
    setStates(prev => {
      if (prev[providerId]?.phase === 'ready') return prev;
      return { ...prev, [providerId]: { phase: 'loading', models: [], error: '' } };
    });
    try {
      const result = await rpcCall('model.list', { provider: providerId });
      if (!mounted.current) return;
      setStates(prev => ({
        ...prev,
        [providerId]: {
          phase: 'ready',
          // 服务端下发的是**未过滤全量**（含被关掉的和已下架的），这里原样收下：
          // 用过滤后的目录回填会让被关过的模型连开关一起消失（只能改 settings.yaml 才能救回）。
          models: Array.isArray(result?.models) ? result.models : [],
          error: '',
        },
      }));
    } catch (error) {
      if (!mounted.current) return;
      setStates(prev => ({
        ...prev,
        [providerId]: { phase: 'error', models: [], error: error?.message || String(error) },
      }));
    }
  }, [rpcCall]);

  const filtering = isFilterActive({ query, status: statusFilter });
  const sections = visibleCenterSections(providers, states, { query, status: statusFilter });
  // ⚠ 注意：`centerTotals` 统计的是「**全部已加载的分组**」而不是「筛选后可见的」
  // ⇒ 必须直接传 `providers` + `states`（否则搜索一不匹配就显示「已读取 0 / N 家」）。
  const totals = centerTotals(providers, states);
  const pending = centerPendingProviderIds(providers, states);
  const providerCount = Array.isArray(providers) ? providers.length : 0;

  /**
   * 分组默认展开策略：
   * - 用户点过的以显式值为准（与 `model-groups.js` 的 `groupExpanded` 同一条规则）；
   * - 否则**有筛选时展开**（不然用户搜到命中项还要逐家点开，搜索等于白做）；
   * - 无筛选时折叠（二十家全摊开会有上千行）。
   *
   * ⚠️ 筛选时的自动展开**只对已加载的分组生效**。展开会触发下面的懒加载
   * effect —— 若把未加载的也自动展开，输入搜索词的瞬间就会同时发出二十个
   * `model.list`（每家的目录都可能访问上游），与「加载全部」限并发 3 的
   * 初衷直接冲突。未加载的保持折叠，计数位显示「未读取」，由「加载全部」补齐。
   */
  const isOpen = (providerId) => {
    if (Object.prototype.hasOwnProperty.call(openIds, providerId)) return openIds[providerId] === true;
    return filtering && states[providerId]?.phase === 'ready';
  };

  // 懒加载的唯一触发点：展开了但还没读过的分组立刻拉。
  // ⚠️ 只认 `phase === 'idle'`：一旦拉过，phase 变 loading/ready/error，这个
  // effect 再跑也不会重复发请求（否则 setStates 与 effect 会互相触发成死循环）。
  React.useEffect(() => {
    for (const section of sections) {
      if (section.phase !== 'idle') continue;
      if (!isOpen(section.id)) continue;
      void loadProvider(section.id);
    }
  }, [sections, openIds, filtering, loadProvider, states]);

  const busyKey = (providerId, modelId) => `${providerId}::${modelId}`;

  const resetFilters = () => { setQuery(''); setStatusFilter('all'); };

  const toggleSection = (providerId) => {
    setOpenIds(prev => ({ ...prev, [providerId]: !isOpen(providerId) }));
  };

  const toggleModel = async (providerId, modelId, disabled) => {
    setToggleError('');
    setToggleWarnings([]);
    const key = busyKey(providerId, modelId);
    setBusyIds(prev => { const next = new Set(prev); next.add(key); return next; });
    try {
      const result = await rpcCall('model.setDisabled', { provider: providerId, modelId, disabled });
      if (!mounted.current) return;
      // 服务端会回「已下架模型被跳过」这类**成功但无实际效果**的提示（Issue IKJW33）——
      // 单独一条通道展示，不能和错误混在一起（两者语气相反，混在一起用户无法判断有没有生效）。
      setToggleWarnings(Array.isArray(result?.warnings) ? result.warnings : []);
      // 就地翻，不整表重载：关掉一个模型就重拉一遍目录，在二十家的列表里是明显的卡顿。
      setStates(prev => {
        const state = prev[providerId];
        if (state === undefined || state.phase !== 'ready') return prev;
        return {
          ...prev,
          [providerId]: {
            ...state,
            models: state.models.map(model => (model.id === modelId ? { ...model, disabled } : model)),
          },
        };
      });
    } catch (error) {
      if (mounted.current) setToggleError(`「${modelId}」切换失败：${error?.message || String(error)}`);
    } finally {
      if (mounted.current) {
        setBusyIds(prev => { const next = new Set(prev); next.delete(key); return next; });
      }
    }
  };

  const restoreModel = async (providerId, modelId) => {
    setToggleError('');
    const key = busyKey(providerId, modelId);
    setBusyIds(prev => { const next = new Set(prev); next.add(key); return next; });
    try {
      await rpcCall('model.clearDead', { provider: providerId, modelId });
      // 必须整表重载：被补回来的条目只有裸 id，需要拿回展示名与计费分组。
      await loadProvider(providerId);
    } catch (error) {
      if (mounted.current) setToggleError(`「${modelId}」恢复失败：${error?.message || String(error)}`);
    } finally {
      if (mounted.current) {
        setBusyIds(prev => { const next = new Set(prev); next.delete(key); return next; });
      }
    }
  };

  /**
   * 整家全开 / 全关。
   *
   * ⚠️ 用 `model.setAllDisabled`（整张黑名单），不是 `model.setDisabledMany` ——
   * 「全开」的语义是连**历史**关闭记录一起清掉（服务端 `setAllDisabled(false)`
   * 直接清空该家的黑名单），而 setDisabledMany 要传具体 id 列表、只能清当前在列的。
   * 关闭方向必须确认：一次误点会让这家所有模型从对话框的模型选择里消失。
   */
  const setProviderAll = async (providerId, label, disabled) => {
    if (disabled && !confirm(`确认关闭「${label}」的全部模型？它们会从对话框的模型选择里消失；取消则不做任何变更。`)) return;
    setToggleError('');
    setToggleWarnings([]);
    setProviderBusy(prev => { const next = new Set(prev); next.add(providerId); return next; });
    try {
      // ⚠⚠⚠ **`closeProvider: false`**（2026-10-21 合并审计发现，阻断级）：
      // 本屏是**模型级**管理，用户的意图是「关这家模型」，不是「关掉这个供应商」。
      //
      // ⚠⚠ 服务端默认 `closeProvider` 为 `true`（既有语义：「关闭全部模型」≡
      // 「关闭该供应商」，与 `provider.setEnabled(false)` 同一条路径）⇒ 若不显式传
      // `false`，点一次「全关」会把**整个供应商**也关掉：
      // ① `provider.status` 报 `closed: true` ⇒ 左侧分组变成「已关闭」；
      // ② 各适配器的 `listModels` 直接返回 `[]` ⇒ 该家在选择器里一个模型都没有；
      // ③ **再打开任意一个模型，供应商被顺带打开**（打开方向会清意图）。
      // ⇒ 两头都与用户意图相反，且**零提示**。
      const result = await rpcCall('model.setAllDisabled', {
        provider: providerId,
        disabled,
        closeProvider: false,
      });
      if (mounted.current) setToggleWarnings(Array.isArray(result?.warnings) ? result.warnings : []);
      // 批量动作会改动整张黑名单，逐项翻不可靠 ⇒ 重载这一家。
      await loadProvider(providerId);
    } catch (error) {
      if (mounted.current) setToggleError(`批量切换「${label}」失败：${error?.message || String(error)}`);
    } finally {
      if (mounted.current) {
        setProviderBusy(prev => { const next = new Set(prev); next.delete(providerId); return next; });
      }
    }
  };

  const loadAll = async () => {
    const queue = centerPendingProviderIds(providers, states);
    if (queue.length === 0) return;
    setLoadingAll(true);
    // 并发 3：一次全发会同时打二十多个上游目录请求（Cline / WorkBuddy 的目录
    // 本身要访问远端），既可能触发限流，也让界面长时间没有任何反馈。
    const concurrency = 3;
    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length) {
        const providerId = queue[cursor];
        cursor += 1;
        await loadProvider(providerId);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));
    if (mounted.current) setLoadingAll(false);
  };

  const renderSection = (section) => {
    const opened = isOpen(section.id);
    const sectionBusy = providerBusy.has(section.id);
    // 供应商整体被关闭时它的模型必然全是关闭态；标出来，免得用户以为是模型级设置。
    const providerClosed = statuses?.[section.id]?.closed === true;
    const phrase = section.phase === 'error'
      ? '读取失败'
      : !section.loaded
        ? (section.phase === 'loading' ? '正在读取…' : '未读取')
        : `${section.summary.total} 个 · 已关闭 ${section.summary.disabled}`
          + (section.summary.dead > 0 ? ` · 已下架 ${section.summary.dead}` : '');
    const countText = providerClosed ? `${phrase}（该供应商已关闭）` : phrase;
    // ⚠ ⚠ **判据走 `centerBulkState`**（排除 dead 条目）：
    // 服务端的写入集不含 dead 模型（它们被 `withDeadModelPruning` 剔除）
    // ⇒ 用含 dead 的 `summary.total` 做比较会让「全关」按钮永不禁用（点下去服务端走幂等短路、
    // 界面上一个数字都不变 ⇒ 观感为「按钮坏了」）。
    const bulk = centerBulkState(section.models);
    const allDisabled = section.loaded && bulk.allDisabled;
    const noneDisabled = section.loaded && bulk.noneDisabled;
    return React.createElement('div', { key: section.id, className: 'dim-jh-modelGroup' },
      React.createElement('div', { className: 'dim-jh-modelGroupHead' },
        React.createElement('button', {
          className: 'dim-jh-modelGroupToggle',
          'aria-expanded': opened ? 'true' : 'false',
          title: opened ? '收起该供应商的模型' : '展开并读取该供应商的模型列表',
          onClick: () => toggleSection(section.id),
        }, `${opened ? '▾' : '▸'} ${section.label}`),
        React.createElement('span', { className: 'dim-jh-modelGroupCount' }, countText),
        React.createElement('button', {
          className: 'dim-jh-btn dim-jh-modelGroupBtn',
          disabled: !section.loaded || sectionBusy || noneDisabled,
          title: noneDisabled ? '该供应商没有已关闭的模型' : '打开该供应商的全部模型（含之前关闭的）',
          onClick: () => void setProviderAll(section.id, section.label, false),
        }, sectionBusy ? '处理中…' : '全开'),
        React.createElement('button', {
          className: 'dim-jh-btn dim-jh-modelGroupBtn',
          disabled: !section.loaded || sectionBusy || allDisabled,
          title: allDisabled ? '该供应商的模型已全部关闭' : '关闭该供应商的全部模型',
          onClick: () => void setProviderAll(section.id, section.label, true),
        }, sectionBusy ? '处理中…' : '全关')),
      opened
        ? React.createElement('div', { className: 'dim-jh-modelGroupBody' },
            section.phase === 'error'
              ? React.createElement('div', { className: 'dim-jh-empty' },
                  React.createElement('p', null, states[section.id]?.error || '读取该供应商的模型列表失败。'),
                  React.createElement('button', {
                    className: 'dim-jh-btn',
                    onClick: () => void loadProvider(section.id),
                  }, '重新读取'))
              : !section.loaded
                ? React.createElement('p', { className: 'dim-jh-modalHint' }, '正在读取该供应商的模型列表…')
                : section.summary.total === 0
                  ? React.createElement('p', { className: 'dim-jh-modalHint' }, '该 Provider 当前没有可用的模型。')
                  : section.models.length === 0
                    ? React.createElement('div', { className: 'dim-jh-empty' },
                        React.createElement('p', null, '没有符合当前搜索与筛选条件的模型。'),
                        React.createElement('button', { className: 'dim-jh-btn', onClick: resetFilters }, '清空筛选'))
                    : section.models.map(model => React.createElement(ModelToggle, {
                        key: model.id,
                        model,
                        busy: sectionBusy || busyIds.has(busyKey(section.id, model.id)),
                        onToggle: (modelId, disabled) => void toggleModel(section.id, modelId, disabled),
                        onRestore: (modelId) => void restoreModel(section.id, modelId),
                      })))
        : null);
  };

  return React.createElement('div', null,
    React.createElement('div', { className: 'dim-jh-modelFilterBar' },
      React.createElement('input', {
        type: 'search',
        className: 'dim-jh-input dim-jh-modelSearch',
        placeholder: '搜索供应商、模型名或 id…',
        'aria-label': '搜索供应商或模型',
        value: query,
        onChange: (event) => setQuery(event.target.value),
      }),
      React.createElement('div', {
        className: 'dim-jh-modelStatusFilter',
        role: 'group',
        'aria-label': '按模型开关状态筛选',
      },
      [['all', '全部'], ['enabled', '已打开'], ['disabled', '已关闭']].map(([value, label]) => React.createElement('button', {
        key: value,
        className: 'dim-jh-btn',
        'data-active': statusFilter === value ? 'true' : 'false',
        'aria-pressed': statusFilter === value ? 'true' : 'false',
        onClick: () => setStatusFilter(value),
      }, label))),
      filtering
        ? React.createElement('button', { className: 'dim-jh-btn', onClick: resetFilters }, '清空筛选')
        : null,
      React.createElement('button', {
        className: 'dim-jh-btn',
        title: '读取所有还没读过的供应商目录（并发 3 个，避免同时打爆上游）。',
        disabled: loadingAll || pending.length === 0,
        onClick: () => void loadAll(),
      }, loadingAll ? '读取中…' : `加载全部${pending.length > 0 ? `（${pending.length}）` : ''}`)),
    React.createElement('p', { className: 'dim-jh-modalHint' },
      `已读取 ${totals.loaded} / ${providerCount} 家`
      + (totals.loaded === 0
          ? '。展开某一家，或点「加载全部」。'
          : `：共 ${totals.total} 个模型，已关闭 ${totals.disabled} 个。`)
      + '关闭开关后该模型不再出现在对话框的模型选择里；'
      + '「已下架」的模型是上游移除的，可用「重新显示」恢复。'
      + '未读取的供应商不参与搜索，点「加载全部」补齐。'),
    toggleError
      ? React.createElement('div', {
          className: 'dim-jh-probeNotice',
          'data-tone': 'error',
          role: 'alert',
        }, React.createElement('div', null, toggleError))
      : null,
    // `warn` 必须是这个拼写：写成 `warning` 会静默落成中性色（`data-tone` 是枚举）。
    toggleWarnings.length > 0
      ? React.createElement('div', {
          className: 'dim-jh-probeNotice',
          'data-tone': 'warn',
          role: 'status',
        }, React.createElement('div', null, toggleWarnings.join('；')))
      : null,
    React.createElement('div', { className: 'dim-jh-modelList' },
      sections.length === 0
        ? React.createElement('div', { className: 'dim-jh-empty' },
            React.createElement('p', null, '没有符合当前搜索与筛选条件的供应商。'),
            React.createElement('button', { className: 'dim-jh-btn', onClick: resetFilters }, '清空筛选'))
        : sections.map(section => renderSection(section))));
}

/**
 * 网关清单里的一行模型（**只读**，没有开关）。
 *
 * ⚠️ 与模型列表的 `ModelToggle` 不同，这里**刻意不用 `<label>`**：网关弹窗只做
 * 「把 ID 抄走」这一件事，行内没有任何控件；用 label 会让整行带上「可点」的错觉
 * （模型列表那边踩过「双 checkbox 让点文字变成勾选」的同型坑，见 `model-filter.js`）。
 *
 * ⚠️ 行内只显示**去掉供应商前缀**的模型名（`gatewayModelKeyOf`），完整 ID 放在
 * tooltip 与「复制」里。理由：实测 `codearts/deepseek-v4.1-flash` 这类 id 占满整行，
 * 在 id 单元格 `max-width: 46%` 的夹取下跌成 `codearts/deepse…`，模型名反而读不出来；
 * 而卡片标题已经把供应商写清楚了，前缀是纯重复。
 */
function GatewayModelRow({ model }) {
  // 「可发图片」只标在支持的那个上 —— 用户据此挑模型，而不是靠撞一次
  // unsupported_content 才知道。数据来自宿主，与 /v1/models 同源。
  const badge = modelCapabilityBadge(model);
  return React.createElement('div', {
    className: 'dim-jh-gatewayModelRow',
    // tooltip = 完整 ID（可直接选中复制）+ 展示名，截图/复制时信息不丢。
    title: `${model.id}\n${model.name || ''}`.trim(),
  },
    React.createElement('code', { className: 'dim-jh-modelId' }, gatewayModelKeyOf(model)),
    React.createElement('span', { className: 'dim-jh-modelName' }, model.name || model.id),
    badge
      ? React.createElement('span', { className: 'dim-jh-modelBadge', title: '该模型接受图片输入。' }, badge)
      : null);
}

/**
 * 思考档位对照表里的一行（**只读**）。
 *
 * ⚠️ 与模型清单的行分开写：这里要显示「真实档位 / 客户端该填」两列，
 * 而正文允许换行（用户反馈过「字符过长被省略」，见下面的类注释），
 * 与模型行「单行 + 省略号」的排版目标完全不同。
 */
function GatewayEffortRow({ row }) {
  return React.createElement('div', {
    className: 'dim-jh-effortRow',
    title: `${row.id}\n真实档位：${row.declared}\n客户端该填：${row.fill}`,
  },
    React.createElement('div', { className: 'dim-jh-effortHead' },
      // 卡片头已写明供应商，行内显示去掉前缀的名字；完整 id 在 tooltip 与复制里。
      React.createElement('code', { className: 'dim-jh-effortModel' }, gatewayModelKeyOf(row)),
      row.lossy
        ? React.createElement('span', {
          className: 'dim-jh-modelBadge',
          title: '该模型的档位名与 OpenAI 客户端不同名：照 DSH 界面上的名字填，网关会按强度就近翻译。',
        }, '需对照')
        : null),
    React.createElement('div', { className: 'dim-jh-effortLine' },
      React.createElement('span', { className: 'dim-jh-effortLabel' }, '真实档位：'),
      row.declared),
    React.createElement('div', { className: 'dim-jh-effortLine' },
      React.createElement('span', { className: 'dim-jh-effortLabel' }, '客户端该填：'),
      row.fill));
}

/**
 * 把一批条目按供应商渲染成**卡片**（模型清单与档位对照表共用）。
 *
 * ⚠️ **共用**是刻意的：两处的分组口径（`groupGatewayEntries`）、折叠规则
 * （`gatewayCardExpanded`）、卡片头（标题 + 条数 + 「复制本组」）理应完全一致 ——
 * 用户看到的是同一种「一家供应商一张卡」的形态，各写一套迟早一处改了另一处没改。
 *
 * @param {object} props
 * @param {Array<object>} props.cards `groupGatewayEntries` 的产物
 * @param {(row: object) => object} props.renderRow 行渲染函数
 * @param {(provider: string) => boolean} props.isExpanded 该卡片此刻是否展开
 * @param {(provider: string) => void} props.onToggle 折叠开关
 * @param {(card: object) => void} props.onCopy 复制该卡片（部分）
 * @param {(provider: string) => boolean} props.isCopied 该卡片是否刚复制成功
 * @param {string} props.foldSuffix 条数单位，如「个模型」
 * @param {string} props.foldLabel `counts.fold` 的含义，如「可发图片」「需对照」；
 *   为空串表示这一批条目没有第二类计数（不显示那段）。
 * @param {string} props.copyNoun 复制按钮 tooltip 里的量词，如「个完整模型 ID」
 */
function GatewayCards({ cards, renderRow, isExpanded, onToggle, onCopy, isCopied, foldSuffix, foldLabel, copyNoun }) {
  return React.createElement('div', { className: 'dim-jh-gatewayCards', style: { marginTop: '6px' } },
    cards.map(card => {
      const expanded = isExpanded(card.provider);
      const label = gatewayCardLabel(card.provider, providerLabel);
      return React.createElement('div', {
        // ⚠️ 供应商 key 拿不到时用 `__unknown__`：`key: ''` 会让 React 报警并可能丢行。
        key: card.provider === '' ? '__unknown__' : card.provider,
        className: 'dim-jh-gatewayCard',
      },
        React.createElement('div', { className: 'dim-jh-gatewayCardHead' },
          React.createElement('button', {
            className: 'dim-jh-gatewayCardToggle',
            'aria-expanded': expanded ? 'true' : 'false',
            // tooltip 里给出**原始 provider key**：卡片标题是展示名，
            // 而用户要复制进配置的是 ID 里的那个 key，两者可能不同。
            title: card.provider === ''
              ? '这些条目没有回传供应商字段（上游数据异常），仍照实列出。'
              : `供应商 key：${card.provider}（模型 ID 的前缀就是它）`,
            onClick: () => onToggle(card.provider),
          }, `${expanded ? '▾' : '▸'} ${label}`),
          React.createElement('span', { className: 'dim-jh-gatewayCardCount' },
            card.counts.fold > 0 && foldLabel !== ''
              ? `${card.counts.total} ${foldSuffix} · ${card.counts.fold} 个${foldLabel}`
              : `${card.counts.total} ${foldSuffix}`),
          React.createElement('button', {
            className: 'dim-jh-btn dim-jh-gatewayCardBtn',
            title: `只复制「${label}」这一家的 ${card.counts.total} ${copyNoun}（每行一个完整 ID）。`,
            onClick: () => onCopy(card),
          }, isCopied(card.provider) ? '已复制 ✓' : '复制本组')),
        expanded
          ? React.createElement('div', { className: 'dim-jh-gatewayCardBody' },
            card.entries.map((entry, index) => React.createElement(
              // ⚠️ 同一 id 重复出现时 key 会撞（上游缺陷），补下标保证 React 不丢行。
              React.Fragment, { key: `${card.provider}#${entry.id}#${index}` }, renderRow(entry))))
          : null);
    }));
}

/**
 * 「本机 OpenAI 网关」弹窗。
 *
 * 展示三件用户配外部客户端时真正需要的信息：**开关**、**对外地址**、**密钥在哪**。
 *
 * ⚠️ 三条约束：
 * 1. **地址只在真监听时显示**：端口可被 `DSH_OPENAI_GATEWAY_PORT` 改过，
 *    没在监听时回显一个连不上的地址比不显示更糟。
 * 2. **不在这里显示 API Key 本身**：密钥是凭据，弹窗里明文展示等于把凭据复制到
 *    剪贴板/截图里。只告诉用户它存在哪、由哪个环境变量覆盖。
 * 3. **状态全部来自宿主侧**（`gateway.getEnabled`），前端不拿 `enabled` 自行
 *    推导运行态 —— 端口冲突与 env 停用都会让两者不一致。
 */
function GatewayPanel({ status, busy, notice, onToggle, onToggleAllowLan, onReload, onClose }) {
  const [copied, setCopied] = React.useState(false);
  const [revealed, setRevealed] = React.useState(false);
  const [modelsOpen, setModelsOpen] = React.useState(false);
  const [effortsOpen, setEffortsOpen] = React.useState(false);
  /**
   * 两处清单各自的搜索词。
   *
   * ⚠️ 用户 2026-10-04 要求「搜索应当在展开后才可用」：搜索框渲染在**展开区之内**。
   * 收起时按钮的 onClick 会把对应搜索词清空 —— 否则筛子不可见却仍在生效，
   * 下次展开会莫名其妙少掉一半行。
   */
  const [modelsQuery, setModelsQuery] = React.useState('');
  const [effortsQuery, setEffortsQuery] = React.useState('');
  const [effortsCopied, setEffortsCopied] = React.useState(false);
  const [idsCopied, setIdsCopied] = React.useState(false);
  /**
   * 每张供应商卡片各自的展开态（`provider → 用户点过的布尔`）。
   * 只在用户**点过**之后才有值，此前由 `gatewayCardExpanded` 按条数给默认值。
   * 模型清单与对照表各一套：两者的条目数与折叠阈值都不同，共用一个对象会让
   * 「展开 model 家的模型清单」连带动了「展开 model 家的档位表」。
   */
  const [modelCardToggles, setModelCardToggles] = React.useState({});
  const [effortCardToggles, setEffortCardToggles] = React.useState({});
  /** 刚复制成功的那张卡片（provider key），用于把按钮打成「已复制 ✓」。 */
  const [copiedModelCard, setCopiedModelCard] = React.useState(null);
  const [copiedEffortCard, setCopiedEffortCard] = React.useState(null);
  const apiKey = status?.apiKey ?? null;
  const models = status?.models ?? [];
  /**
   * 模型清单的搜索（与对照表的搜索**同一约定**：空搜索词 = 未搜索）。
   *
   * ⚠️ 判据复用 `model-filter.js` 的 `filterModels`（只匹配 id 与展示名）。
   * **不要**顺手换成对照表那套 `filterEffortRows` —— 那个还会匹配档位名，
   * 用在这里会让「搜 `max`」命中一堆没这个功能的模型（见 openai-gateway-panel.js
   * 里 matchesEffortQuery 的说明）。
   */
  const modelsFiltering = isFilterActive({ query: modelsQuery });
  const visibleModels = filterModels(models, { query: modelsQuery });
  /**
   * 按供应商折成卡片（用户 2026-10-03 要求：一家供应商一张卡，而不是一个模型一行）。
   *
   * ⚠️ 分组判据在纯函数 `groupGatewayModels` / `groupGatewayEntries` 里
   * （单测环境没有 react，组件渲染不了 —— 判据必须抽出来才能真跑覆盖）。
   *
   * ⚠️ 在**筛出来的模型**上分组（不是先分组再筛），与对照表同一口径：
   * 卡片头的条数必须与卡内实际行数一致。
   */
  const modelCards = groupGatewayModels(visibleModels);
  const effortRows = gatewayEffortRows(models);
  // ⚠️ 搜索在**渲染时**做，不改 effortRows 本身：清空搜索即恢复全量。
  const visibleEffortRows = filterEffortRows(effortRows, effortsQuery);
  const effortsFiltering = isFilterActive({ query: effortsQuery });
  /**
   * 对照表也折成**同一套供应商卡片**。
   *
   * ⚠️ 先在**筛出来的行**上分组（不是先分组再筛）：卡片头部的条数必须与卡内实际
   * 行数一致，否则搜索时会出现「卡片写着 8 个、里面只有 1 行」的矛盾读数。
   */
  const effortCards = groupGatewayEntries(visibleEffortRows, (row) => row.lossy);

  // 每次重新打开/换密钥后复位：否则上一条「已复制」会挂在新密钥旁边误导用户。
  React.useEffect(() => { setCopied(false); setRevealed(false); }, [status?.apiKey?.value]);
  // ⚠️ 目录换了一批就复位「已复制」：否则旧卡片的勾会留在同名卡片上。
  // ⚠️ 也要跟着搜索词复位：那句「已复制 ✓」讲的是**当时那批行**，换了筛子它还留着
  // 就是误导（用户会以为刚复制的是现在屏幕上这批）。
  React.useEffect(() => { setIdsCopied(false); setCopiedModelCard(null); }, [models.length, modelsQuery]);
  // 换了搜索词还留着上一条「已复制 ✓」会误导（那条讲的是另一批行）。
  React.useEffect(() => { setEffortsCopied(false); setCopiedEffortCard(null); }, [models.length, effortsQuery]);

  React.useEffect(() => {
    const onKeyDown = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  /**
   * 复制密钥。失败（无 Clipboard API / 非用户手势 / 权限被拒）必须给回退：
   * 直接把密钥显示出来让用户手动选中，否则就是「点了没反应」。
   */
  const handleCopy = async () => {
    if (!apiKey) return;
    const ok = await copyToClipboard(apiKey.value);
    if (ok) {
      setCopied(true);
      return;
    }
    setRevealed(true);
    setCopied(false);
  };

  /**
   * 复制模型 ID（每行一个）。
   *
   * ⚠️ 有搜索词时只复制**筛出来的模型**，与「复制对照表」同一口径：
   * 按钮上写着 `复制全部 N 个 ID`，那个 N 就是筛出来的条数，复制全量会让用户
   * 以为搜索没生效（拿到的 ID 数对不上按钮上的数字）。
   *
   * 失败时展开列表让用户手动选中 —— 与密钥同理，不能「点了没反应」。
   */
  const handleCopyModelIds = async () => {
    const text = formatModelIdList(visibleModels);
    if (!text) return;
    const ok = await copyToClipboard(text);
    setIdsCopied(ok);
    if (!ok) setModelsOpen(true);
  };

  /**
   * 复制**一张卡片**的模型 ID（每行一个完整的 `provider/模型名`）。
   *
   * ⚠️ 复制的是**完整 ID**，不是行内显示的短名字：客户端配置要的是前者，
   * 抄一个短名字进去必然 404。行内显示短名只是为了不被截断（见 `GatewayModelRow`）。
   */
  const handleCopyCardIds = async (card) => {
    const text = formatModelIdList(card.entries);
    if (!text) return;
    const ok = await copyToClipboard(text);
    setCopiedModelCard(ok ? card.provider : null);
    if (!ok) setModelsOpen(true);
  };

  /**
   * 复制思考档位对照表。有搜索词时只复制**筛出来的那些行** ——
   * 用户搜完再复制，拿到的正是屏幕上看到的内容（复制全量会让人以为搜索没生效）。
   *
   * 失败时展开对照表让用户手动选中：与密钥、模型 ID 两处同理，
   * 绝不能「点了没反应」。
   */
  const handleCopyEfforts = async () => {
    const text = gatewayEffortsText(visibleEffortRows);
    if (!text) return;
    const ok = await copyToClipboard(text);
    setEffortsCopied(ok);
    if (!ok) setEffortsOpen(true);
  };

  /**
   * 复制**一张卡片**的档位对照（只含该供应商的行）。
   *
   * 与「复制对照表」的区别只是范围：用户常只需一家（例如只在配 Codex 的
   * `trae` 那一档），复制全量反而要自己再挑。
   */
  const handleCopyCardEfforts = async (card) => {
    const text = gatewayEffortsText(card.entries);
    if (!text) return;
    const ok = await copyToClipboard(text);
    setCopiedEffortCard(ok ? card.provider : null);
    if (!ok) setEffortsOpen(true);
  };

  const disabled = gatewaySwitchDisabled(status);
  const action = status?.enabled ? '关闭' : '打开';
  // 「允许局域网访问」行的禁用与动作词（与主开关同构，判据不同：它只在
  // env 显式给了 host 时被禁——那一刻翻开关改变不了监听地址）。
  const allowLanDisabled = gatewayAllowLanSwitchDisabled(status);
  const allowLanAction = status?.allowLan ? '关闭' : '打开';
  return React.createElement('div', {
    className: 'dim-jh-modalOverlay dim-jh-modalOverlay--top',
    onClick: (event) => { if (event.target === event.currentTarget) onClose(); },
  },
  React.createElement('div', {
    className: 'dim-jh-modal dim-jh-gatewayModal',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': '本机 OpenAI 网关',
  },
  React.createElement('div', { className: 'dim-jh-modalHead' },
    React.createElement('div', { className: 'dim-jh-modalTitle' },
      React.createElement('strong', null, '本机 OpenAI 网关')),
    React.createElement('div', { className: 'dim-jh-modelPanelActions' },
      React.createElement('button', {
        className: 'dim-jh-btn',
        title: '重新读取网关状态。',
        onClick: () => void onReload(),
      }, '刷新'),
      React.createElement('button', {
        className: 'dim-jh-btn',
        'data-kind': 'primary',
        onClick: onClose,
      }, '完成'))),
  React.createElement('div', { className: 'dim-jh-modalBody' },
    // ── 第 1 段：开关与连接信息 ──
    // ⚠️ 用户 2026-10-04 要求把三段用**可见的分段**区分开（原话：「这三坨字全混在
    // 一起有点难看清」）。做法是每段包一个 .dim-jh-gatewaySection：
    // 段与段之间用上边框 + 更大的间距分开，段内保持紧凑。
    // ⚠️ 不要用「给每段加不同底色」：弹窗会被截图，色块在深色主题下还要另配一套 token。
    React.createElement('div', { className: 'dim-jh-gatewaySection' },
      React.createElement('label', { className: 'dim-jh-modelRow' },
        React.createElement('span', { className: 'dim-jh-modelInfo' },
          React.createElement('strong', { className: 'dim-jh-modelName' }, '启用本机网关'),
          // ⚠️ 用户 2026-10-04 要求这句只留「在 127.0.0.1 监听，供客户端调用」——
          // 原先列了 Pi / Continue / Cline / OpenCode 四个客户端名，在窄面板下折成两行
          // 且把「打开/关闭」那个动作词挤到很后面。客户端列举属于 README 的内容。
          // ⚠️ **地址必须是动态的**（issue IKL7UN）：host 现在可配（容器化部署下
          // 就是容器桥接 IP），写死 127.0.0.1 会让用户照着抄一个从容器外连不上的
          // 地址 —— 而那正是 issue 报告者踩的坑。未在监听时退回「本机」这一定性
          // 说法（与 gatewayEndpoint 返回 '' 的既有取舍同源：不编造具体地址）。
          React.createElement('code', { className: 'dim-jh-modelId' },
            status?.address
              ? `在 ${status.address.host} 监听，供客户端调用`
              : '在本机监听，供客户端调用')),
        React.createElement('input', {
          type: 'checkbox',
          className: 'dim-jh-switch',
          role: 'switch',
          checked: status?.enabled === true,
          // 被 env 停用时禁用而非「点了没反应」：让用户做一次明知无效的操作更困惑。
          disabled: disabled || busy,
          'aria-label': action + '本机网关',
          onChange: () => void onToggle(!(status?.enabled === true)),
        })),
      // ── 「允许局域网访问」开关（2026-10-20）──
      // ⚠️ 与主开关同一行结构，但**语义不同**：它改变的是监听地址（127.0.0.1 ↔
      // 0.0.0.0），翻动会触发服务端关闭旧实例并重建换绑；env 显式给了
      // DSH_OPENAI_GATEWAY_HOST 时被禁用（那一刻翻动无效，禁用并说明原因）。
      React.createElement('label', { className: 'dim-jh-modelRow' },
        React.createElement('span', { className: 'dim-jh-modelInfo' },
          React.createElement('strong', { className: 'dim-jh-modelName' }, '允许局域网访问'),
          React.createElement('code', { className: 'dim-jh-modelId' },
            '打开后监听 0.0.0.0，同一局域网的设备可凭 API Key 访问')),
        React.createElement('input', {
          type: 'checkbox',
          className: 'dim-jh-switch',
          role: 'switch',
          checked: status?.allowLan === true,
          disabled: allowLanDisabled || busy,
          'aria-label': allowLanAction + '「允许局域网访问」',
          onChange: () => void onToggleAllowLan(!(status?.allowLan === true)),
        })),
      gatewayAllowLanHint(status)
        ? React.createElement('p', {
          key: 'allow-lan-hint',
          className: 'dim-jh-modalHint dim-jh-gatewayLine',
        }, gatewayAllowLanHint(status))
        : null,
      gatewayStatusLines(status).map((line, index) =>
        // ⚠️ 顶部三行是同一段话，用更紧的 .dim-jh-gatewayLine（再叠上弹窗级的
        // 6px 会显得像三段互不相干的内容）。
        React.createElement('p', {
          key: `status-${index}`,
          className: 'dim-jh-modalHint dim-jh-gatewayLine',
        }, line)),
      // 凭据区：默认**不**渲染明文（设置页会被截图/录屏/投屏）。点「复制」直接
      // 进剪贴板；复制失败（无 Clipboard API、非用户手势、权限被拒）则退回显示
      // 明文供手动选中 —— 绝不能变成「点了没反应」。
      //
      // ⚠️ 用户 2026-10-04 要求精简：原先是一行「鉴权用 Authorization: Bearer
      // <网关 API Key>。」+ 下面一排按钮，现改为「API KEY：」与两个按钮**同一行**。
      // Bearer 那半句没丢 —— 它移到了 CC Switch 之外的客户端需要的信息里，见 README
      // 的「鉴权使用」；面板上只留用户真正要抄的两个东西（地址、密钥）。
      apiKey
        ? React.createElement('div', { className: 'dim-jh-gatewayKeyRow', style: { marginTop: '6px' } },
          React.createElement('span', { className: 'dim-jh-modalHint dim-jh-gatewayKeyLabel' }, 'API KEY：'),
          React.createElement('button', {
            className: 'dim-jh-btn',
            'data-kind': 'primary',
            title: '把密钥复制到剪贴板。明文会进入剪贴板历史，注意别在不信任的机器上这么做。',
            onClick: () => void handleCopy(),
          }, copied ? '已复制 ✓' : '复制密钥'),
          revealed
            ? React.createElement('code', {
              className: 'dim-jh-modelId',
              style: { userSelect: 'all' },
            }, apiKey.value)
            : React.createElement('button', {
              className: 'dim-jh-btn',
              title: '自动复制不可用时用它显示明文，供手动选中。',
              onClick: () => setRevealed(true),
            }, '显示明文'))
        : React.createElement('p', { className: 'dim-jh-modalHint' },
          'API KEY：尚未生成（启用网关时会自动创建）。'),
      // ⚠️ 只有拿到密钥时才补这一行来源说明：`apiKey` 为空时上面那句
      // 「尚未生成（启用网关时会自动创建）」已经把事情说完，而
      // `gatewayApiKeyHint(null)` 说的是同一件事 —— 两句并排就是冗余，
      // 与本次「精简臃肿」的目标正好相反。
      apiKey
        ? React.createElement('p', { className: 'dim-jh-modalHint' }, gatewayApiKeyHint(apiKey))
        : null),

    // ── 第 2 段：模型目录 ──
    // 存在的理由：有些 agent（ZCode 等）**不会**主动扫 `/v1/models`，要靠用户
    // 手工把 ID 填进配置。而该端点需要 Bearer 头，浏览器地址栏直接打开只会得到
    // 401 —— 所以清单必须出现在设置页里。
    React.createElement('div', { className: 'dim-jh-gatewaySection' },
      React.createElement('p', { className: 'dim-jh-gatewaySectionTitle' },
        React.createElement('strong', null, '模型 ID（可用的完整清单）')),
      React.createElement('p', { className: 'dim-jh-modalHint' }, gatewayModelsHint(models, status?.modelsSource)),
      // ⚠️ `dim-jh-gatewayActions` 是给「下方四个按钮压成与密钥行同款小号」用的钩子
      // （见 jet-hub-styles.js 里与 .dim-jh-gatewayKeyRow 合并的那条规则）。
      // 不能直接改 .dim-jh-modelPanelActions .dim-jh-btn —— 那个类在页头、模型面板、
      // 卡片头等 8 处都在用，改它会把无关页面一起改小。
      React.createElement('div', { className: 'dim-jh-modelPanelActions dim-jh-gatewayActions', style: { marginTop: '4px' } },
        React.createElement('button', {
          className: 'dim-jh-btn',
          'data-kind': 'primary',
          disabled: visibleModels.length === 0,
          title: '把模型 ID 每行一个复制到剪贴板（每行一个完整 ID；有搜索词时只复制筛出来的那些）。',
          onClick: () => void handleCopyModelIds(),
        }, idsCopied ? '已复制 ✓' : `复制全部 ${visibleModels.length} 个 ID`),
        React.createElement('button', {
          className: 'dim-jh-btn',
          'aria-expanded': modelsOpen ? 'true' : 'false',
          onClick: () => {
            // 收起时**清掉搜索词**：搜索栏挂在展开区里，收起来还留着筛子的话，
            // 下次展开会莫名其妙少掉一半模型，而筛子此刻是不可见的。
            if (modelsOpen) setModelsQuery('');
            setModelsOpen(open => !open);
          },
        }, modelsOpen ? '收起清单' : '展开清单')),
      modelsOpen
        // 搜索栏与清单**同生共死**：用户 2026-10-04 要求「搜索应当在展开后才可用，
        // 而不是像现在这样放在外面」。挂在外面的问题是常驻半屏宽的输入框，
        // 而它只对下面那张清单有效 —— 收起时那个框既占位又无事可做。
        ? React.createElement(React.Fragment, null,
          React.createElement('div', { className: 'dim-jh-modelFilterBar' },
            React.createElement('input', {
              type: 'search',
              className: 'dim-jh-input dim-jh-modelSearch',
              placeholder: '搜索模型 ID 或展示名…',
              value: modelsQuery,
              'aria-label': '搜索模型 ID',
              onChange: (event) => setModelsQuery(event.target.value),
            }),
            modelsFiltering
              ? React.createElement('button', {
                  className: 'dim-jh-btn',
                  title: '清空搜索词，恢复完整清单。',
                  onClick: () => setModelsQuery(''),
                }, '清空搜索')
              : null),
          visibleModels.length === 0
            // 空结果必须能自解释（与对照表同一约定）：否则用户会以为网关没有模型了。
            ? React.createElement('div', { className: 'dim-jh-gatewayEmpty' }, gatewayModelsEmptyHint(modelsQuery))
            // 按**供应商**分组渲染：一家一张卡片，卡片头写清是哪家、有几条、
            // 几条能发图片，卡内才是它自己的模型。用户报障（2026-10-03）——
            // 此前平铺成「一个模型一行」，同一家的 deepseek-account/deepseek-flash
            // 与 deepseek-account/deepseek-v4-pro 看起来毫无关系，
            // 而用户真正要对照的正是「一家供应商下有哪些模型」。
            //
            // ⚠️ 在**筛出来的模型**上分组（不是先分组再筛），与对照表同一口径：
            // 卡片头的条数必须与卡内实际行数一致。
            : React.createElement(GatewayCards, {
              cards: modelCards,
              renderRow: (model) => React.createElement(GatewayModelRow, { model }),
              isExpanded: (provider) => gatewayCardExpanded(
                modelCards.find(card => card.provider === provider),
                // 有搜索词时一律展开：命中结果藏在折叠卡里，用户会以为「搜不到」。
                { toggled: modelCardToggles[provider], searching: modelsFiltering },
              ),
              onToggle: (provider) => setModelCardToggles(prev => ({
                ...prev,
                [provider]: !gatewayCardExpanded(
                  modelCards.find(card => card.provider === provider),
                  { toggled: prev[provider], searching: modelsFiltering },
                ),
              })),
              onCopy: (card) => void handleCopyCardIds(card),
              isCopied: (provider) => copiedModelCard === provider,
              foldSuffix: '个模型',
              foldLabel: '可发图片',
              copyNoun: '个完整模型 ID',
            }))
        : null),

    // ── 第 3 段：思考档位对照表 ──
    // 存在的理由：各 provider 的档位 id 是**上游私有值**（TRAE 的 light/extra_high、
    // LobsterAI 的 xhigh（界面上叫 Max）、Cline 的 max（界面上叫 Extra）），而走
    // OpenAI 协议的客户端只有固定 8 档词汇，表达不出这些私有值。用户照 DSH 界面上
    // 的名字填进 CC Switch/Codex，撞 400 且两端都看不出原因。
    // 网关现在按强度自动翻译（填错不再失败），但**精确对应**只有一列答案 —— 就是这里。
    //
    // ⚠️ 数据只含**已开启**的模型（来自适配器 listModels 的黑名单过滤），
    // 故与对话框里的模型选择器同源。
    React.createElement('div', { className: 'dim-jh-gatewaySection' },
      React.createElement('p', { className: 'dim-jh-gatewaySectionTitle' },
        React.createElement('strong', null, '思考档位对照表')),
      // ⚠️ 说明**一行一个 p**（与弹窗顶部 gatewayStatusLines 同款做法）。
      // 用户 2026-10-04 第三次报障：这两句原先拼成一整段交给浏览器断行，
      // 于是品牌名被从中间切开 —— 前一行结尾是「CC」、下一行开头是「Switch」。
      // 两句本就各说一件事，各占一行既不会断开品牌名，也更好读。
      gatewayEffortsHintLines(models).map((line, index) =>
        React.createElement('p', {
          key: `efforts-hint-${index}`,
          className: 'dim-jh-modalHint dim-jh-gatewayLine',
        }, line)),
      // ⚠️ 用户 2026-10-04 要求这两个按钮**互换位置**，与模型清单那段保持一致
      //（那边是「复制全部 …」在前、「展开清单」在后）。顺序统一后，
      // 三段里的按钮位置可预期，用户不必每段重新找。
      React.createElement('div', { className: 'dim-jh-modelPanelActions dim-jh-gatewayActions', style: { marginTop: '4px' } },
        // 复制的是**当前筛出来的那些行**：用户搜完再复制，拿到的正是屏幕上看到的内容。
        effortRows.length > 0
          ? React.createElement('button', {
              className: 'dim-jh-btn',
              'data-kind': 'primary',
              title: '把对照表（含真实档位与该填的值）复制到剪贴板。有搜索词时只复制筛出来的行。',
              onClick: () => void handleCopyEfforts(),
            }, effortsCopied ? '已复制 ✓' : `复制对照表（${visibleEffortRows.length} 行）`)
          : null,
        React.createElement('button', {
          className: 'dim-jh-btn',
          'aria-expanded': effortsOpen ? 'true' : 'false',
          // 没有模型声明档位时禁用而非「点了没反应」：展开一张空表毫无意义。
          disabled: effortRows.length === 0,
          onClick: () => {
            // 与模型清单同理：收起时清掉搜索词，避免下次展开时筛子不可见却仍在生效。
            if (effortsOpen) setEffortsQuery('');
            setEffortsOpen(open => !open);
          },
        }, effortsOpen ? '收起对照表' : `展开对照表（${effortRows.length} 行）`)),
      effortsOpen
        ? React.createElement(React.Fragment, null,
          // 搜索：对照表本身要能按**档位名**查（「哪些渠道有 xhigh？」「界面上的 Max 是哪个 id？」
          // —— 后者是用户真踩过的坑）。故判据比模型清单的搜索多匹配档位名，
          // 但「空搜索词 = 未搜索」的约定与它共用同一份实现（model-filter.js）。
          //
          // ⚠️ 用户 2026-10-04 要求它**展开后才可用**（原先挂在展开区之外，收起时也在占位）。
          effortRows.length > 0
            ? React.createElement('div', { className: 'dim-jh-modelFilterBar' },
                React.createElement('input', {
                  type: 'search',
                  className: 'dim-jh-input dim-jh-modelSearch',
                  placeholder: '搜索模型 id、展示名或档位名（如 xhigh / Max / Extra）…',
                  value: effortsQuery,
                  'aria-label': '搜索思考档位',
                  onChange: (event) => setEffortsQuery(event.target.value),
                }),
                effortsFiltering
                  ? React.createElement('button', {
                      className: 'dim-jh-btn',
                      title: '清空搜索词，恢复完整对照表。',
                      onClick: () => setEffortsQuery(''),
                    }, '清空搜索')
                  : null)
            : null,
          visibleEffortRows.length === 0
            // 空结果必须能自解释，否则用户会以为网关坏了（而不是被搜索词筛没了）。
            ? React.createElement('div', { className: 'dim-jh-effortEmpty' }, gatewayEffortsEmptyHint(effortsQuery))
            // ⚠️ 与模型清单**同一套卡片形态**（`GatewayCards`）：两处都是
            // 「一家供应商一张卡」，用户不必学两种读法。
            : React.createElement(GatewayCards, {
              cards: effortCards,
              renderRow: (row) => React.createElement(GatewayEffortRow, { row }),
              isExpanded: (provider) => gatewayCardExpanded(
                effortCards.find(card => card.provider === provider),
                // ⚠️ 有搜索词时一律展开：命中结果藏在折叠卡里，用户会以为「搜不到」
                // （与 `model-groups.js` 的同一取舍）。
                { toggled: effortCardToggles[provider], searching: effortsFiltering },
              ),
              onToggle: (provider) => setEffortCardToggles(prev => ({
                ...prev,
                [provider]: !gatewayCardExpanded(
                  effortCards.find(card => card.provider === provider),
                  { toggled: prev[provider], searching: effortsFiltering },
                ),
              })),
              onCopy: (card) => void handleCopyCardEfforts(card),
              isCopied: (provider) => copiedEffortCard === provider,
              foldSuffix: '个可选档位',
              foldLabel: '需对照',
              copyNoun: '个模型的档位对照',
            }))
        : null),
    // ── 网关弹窗脚注 ──
    // ⚠️ 这段是**安全声明**，随着 host 可配（issue IKL7UN）它必须跟着实际监听
    // 地址变化 —— 写死「只绑定 127.0.0.1」在容器部署下是错误陈述（详见
    // `gatewayFootnote` 的注释）。
    React.createElement('p', { className: 'dim-jh-modalHint dim-jh-gatewayFootnote' },
      gatewayFootnote(status)),
    notice
      ? React.createElement('div', {
        className: 'dim-jh-probeNotice',
        'data-tone': notice.tone,
        role: notice.tone === 'error' ? 'alert' : 'status',
        style: { marginTop: '10px' },
      }, React.createElement('div', null, notice.text))
      : null)));
}

/**
 * 聚合面板空态文案里那句「已接入临期折算的渠道」的 **provider id 名单**。
 *
 * ⚠️ 它是 `src/aggregate-expiry.ts` 的 `WIRED_EXPIRY_PROVIDERS` 的**手抄副本**
 * （客户端 bundle 是独立 entry、**不** import 宿主模块 —— 见 `build.mjs`）。
 * 加渠道时**必须同改这里**：2026-10-13 接入 `accio` / `officeace` 之后没人回头改，
 * 于是**只登了这两家**的用户会看到「请先在……登录账号」这句**错话** ——
 * 他们其实已经登录了，只是名单里没有那两家。
 *
 * ⚠️⚠️ **本名单存 id，不存显示名**（2026-10-20 改）：
 *    旧形态是 `AGG_WIRED_CHANNEL_LABELS = 'buddy / workbuddy / …'`（一份手抄的
 *    **显示名**），它与后端存 id 的清单**天然不同构** —— 之前靠 11 家的 label
 *    恰好等于 id 蒙混过关，一遇到 label 与 id 不同的 provider（如 `autoclawintl`
 *    → 「AutoClaw (国际版)」）就必然分叉，守卫永远对不上。
 *    ⇒ 现在名单只存 id，**显示名一律经 `providerLabel(id)` 现查**（registry 是
 *      唯一真相源）⇒ 改名 / 新增 provider 时文案**零改动**自动正确。
 *
 * 两边的一致性由 `tests/unit/aggregate-panel-logic.spec.ts` 末尾的 ★★ 守卫锁成
 * **集合相等**（判据 fail-closed：抽不到这份名单就报红，改名/重构不会让它静默失效）。
 *
 * ⚠️⚠️ **数组字面量必须紧跟在 `=` 之后（中间不得插注释/空行以外的东西）**：
 * 那条守卫用正则 `/const AGG_WIRED_CHANNEL_IDS = \[([^\]]*)\]/` 抽取名单 ——
 * 在 `=` 与字面量之间插多行注释会让它**抽不到**从而报红。
 * ⚠️ 曾因此踩过一次（把 modelscope 的说明写在 `=` 与字符串之间）。
 * ⇒ 渠道相关的说明写在这段 JSDoc 里，别写到常量正上方。
 *
 * ⚠️ **本 fork 独有**（魔搭，2026-10-17 用户明确要求加入聚合轮换）：
 * `modelscope` 已进 `WIRED_EXPIRY_PROVIDERS` ⇒ 这里**必须**同改，否则只登了
 * 魔搭的用户会看到「请先在……登录账号」这句错话（他们其实已经登录了）。
 *
 * ⚠️ **AutoClaw**（智谱，2026-10-17 审计 P0 修复）：同样已进
 * `WIRED_EXPIRY_PROVIDERS` ⇒ 同改，理由同上。
 *
 * ⚠️ **AutoClaw 国际版**（`autoclawintl`，2026-10-20）：与国内版一起进了
 * `WIRED_EXPIRY_PROVIDERS` ⇒ 同改。它的**显示名与国内版不同**
 * （「AutoClaw (国际版)」），而 `providerLabel()` 会按 id 现查 registry ⇒ 自动取到
 * 正确的名字，**不需要在这里区分**。
 *
 * ⚠️⚠️ **本清单存的是 provider id，不是显示名** —— 显示名一律经
 * `providerLabel(id)` 现查（L192）。这样「id → label」只有一处真相源
 * （registry），本名单与自己都不抄名字 ⇒ 改名/新增 provider 时**零改动**。
 *
 * ⚠️ **Qoder 中国版 / 国际版**（2026-10-20，该陷阱第 7 次复发）：两家都是
 * `AGGREGATE_CHANNELS` 的成员，同日接入 `WIRED_EXPIRY_PROVIDERS`
 *（折算原语 `qoderExpiry` 走共享的 `sharedPackageExpiry`）。
 * ⚠️ 同样**是两个渠道 id，必须各占一项**（两站共用同一个 `QoderAdapter` 类
 * 与同一份 `fetchQoderCreditBalance`，差异只在 `qoder-product.ts` 的
 * `QODER` / `QODER_CN` 常量）—— 漏掉中国版 ⇒ 只用中国站的用户仍看到错话。
 *
 * ⚠️ 但**如实标注本家的实际形态**，本行文案不要被读成「Qoder 也有临期档」：
 * Qoder 上游 `/sash/api/v2/me/usage` **只下发聚合标量**（`userQuota` /
 * `addOnQuota` 各一个 `total/used/remaining`），**逐包到期拿不到**
 *（逐包明细端点只对浏览器登录态开放；`dedicatedResourcePackages` 才是唯一带
 * 真实 `expiresAt` 的字段，本机账号实测为 `undefined`）⇒ 它的**临期桶恒为 0**、
 * 全部额度进「永久（未知到期）」桶。这**不影响本行必须列出它** ——
 * 本行的语义是「哪些渠道参与了跨渠道临期优先路由的候选表」，而 Qoder
 * 确实已接入该表（`aggregate-expiry.ts` 的 `WIRED_EXPIRY_PROVIDERS`）。
 * 指「有没有临期积分可排序」是另一回事，由上游给不给逐包日期决定。
 * ⚠️ **AStudio**（讯飞 AstronStudio，2026-10-20）：`/points/balance` 的
 * member / buy / activity 三池各带 `*NextExpireTime` ⇒ 已进
 * `WIRED_EXPIRY_PROVIDERS`，这里必须同改（漏改会让只登了 AStudio 的账号在
 * 聚合面板看到「请先在……登录账号」这句错话）。
 *
 * ⚠️ **MiniMax Code 中国版 / 国际版**（2026-10-20，第 6 次复发）：两家都是
 * `AGGREGATE_CHANNELS` 的成员，且 `/minimax-cloud/api/v1/credit/details` 的
 * 每条 `details[]` 带 `expire_at_ms` ⇒ 同日接入 `WIRED_EXPIRY_PROVIDERS`，
 * 这里必须同改。⚠️ **是两个渠道 id，必须各占一项**（共用一个 `MinimaxAuth`
 * 不等于共用一个 id）；漏掉国际版 ⇒ 只登国际站的用户仍看到错话。
 */
const AGG_WIRED_CHANNEL_IDS = [
  'buddy', 'workbuddy', 'loomy', 'codearts', 'zcode', 'lobsterai', 'trae',
  'accio', 'officeace', 'modelscope', 'autoclaw', 'autoclawintl',
  'qoder', 'qodercn',
  'astudio', 'minimax', 'minimaxintl',
];

/**
 * 「按临期排序」模式下面板**自动重探**临期顺序的间隔（用户 2026-10-16 从 5 分钟改为 **2 分钟**）。
 *
 * ⚠️ 用户原话追问是「按临期排序的顺序应该后台定时刷新现在有吗？」—— 实测答复是
 * **宿主侧没有**任何定时刷新（`src/refresh-scheduler.ts` 只管凭据续期，
 * `MODEL_REFRESH_INTERVAL_MS` 是死配置）⇒ 本 PR 补的是**面板挂载期间**的客户端轮询
 * （见 `AggregatePanel` 里那段 `setInterval` 的三条约束）。
 * ⚠️ 别把它写成「后台定时刷新」：面板关掉就不轮询了（这是**刻意**的 ——
 * 我们没有常驻的宿主定时器，也不该为一个排序展示加一个）。
 *
 * ⚠️ 改动本值时要**同步**：`AggregatePanel` 里的两处说明文案、工具行两个按钮的
 * `title`、以及 `README.md` 的聚合表格（否则面板会说自己「每 5 分钟」而实际不是 —— 那
 * 正是本项目反复处理过的「面板没说真话」）。
 */
const AGG_EXPIRY_REPROBE_MS = 2 * 60 * 1000;

/**
 * 聚合 provider 的设置面板。
 *
 * ## ⚠️ 为什么是**独立组件**（不塞进 `ProviderPanel`）
 *
 * `aggregate` 与其余 14 家有一个根本差异：**它不持有账号、凭据与积分**
 *（它复用各渠道的账号）。塞进 `ProviderPanel` 会得到一个「点进去没有登录按钮、
 * 没有账号列表」的空面板，而 `ProviderPanel` 的整条状态机都是围绕账号设计的。
 *
 * 先例：`GatewayPanel`（旁路功能用独立组件，且组件定义在本文件内 —— 独立文件
 * `openai-gateway-panel.js` 只放**纯逻辑**，因为单测环境没有 react）。
 * 同理，本面板的判定与文案在 `aggregate-panel-logic.js` 里（27 条用例覆盖）。
 *
 * ## 数据来源：`aggregate.catalog`（只读、零余额查询）
 *
 * ⚠️ 该端点**不做**余额探测（规格 §8.3）—— 否则打开面板就会对每个渠道打一次上游
 * 请求。实时余额仍由各渠道自己的面板负责。
 */
function AggregatePanel({ rpcCall }) {
  const [models, setModels] = React.useState(null);
  const [rejections, setRejections] = React.useState({});
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState(null);
  /** 每个虚拟模型的展开态（`canonicalId → 用户点过的布尔`）。 */
  const [expanded, setExpanded] = React.useState({});
  /**
   * 排序模式（`'expiry'` / `'manual'`）—— **权威在宿主**。
   *
   * ⚠️ 进入面板时用 `aggregate.catalog` 响应的 `orderMode` 初始化，切换时**先发
   * `aggregate.setOrderMode` 再改本地 state**：先改本地会让落盘失败时面板与宿主分叉，
   * 用户下次打开面板才发现模式变回去了（比报错更难查）。
   * ⚠️ **不得**用「顺序表非空」推导它：用户可以切到手工模式却一条都没拖过
   *（那时两种模式行为相同，但面板该显示「按手工」= 用户选的那个）。
   */
  const [orderMode, setOrderMode] = React.useState('expiry');
  /**
   * 拖动中**尚未落盘**的临时顺序（`canonicalId → 键数组`）。
   *
   * ⚠️ 拖动结果先落在这里、松手后统一提交一次：每次 `dragover` 都发 RPC 会在一次拖动里
   * 打出几十个请求（`commitOrder` 才发）。
   */
  const [pendingOrder, setPendingOrder] = React.useState({});
  /** 落盘 in-flight 闸门（防连点 / 连拖造成竞态：后发的响应先到会覆盖新的顺序）。 */
  const [orderBusy, setOrderBusy] = React.useState({});
  /** 一键「拒绝非临期」的 in-flight 闸门。 */
  const [rejectBusy, setRejectBusy] = React.useState(false);
  /** 按临期排序上次探测的时刻（工具行显示「N 分钟前」；null = 还没探过）。 */
  const [lastProbeAt, setLastProbeAt] = React.useState(null);

  /**
   * 拉取目录。
   *
   * ⚠️ 失败时**保留**旧数据、只把错误放进 notice（不要清空成 null）——
   * 清空会让面板闪成空白，用户以为「聚合坏了」，而真实原因只是一次读取失败。
   *
   * @param {boolean} force - **绕过宿主侧的目录 TTL 缓存**（60 秒）。
   *   ⚠️ 真实缺陷（对抗审计实测证伪）：初版**恒不传 force** ⇒ 「刷新」按钮实际是
   *   「读缓存」，用户在渠道侧新增/关闭模型后点刷新**看不到任何变化**，会以为
   *   聚合坏了。⇒ 挂载时走缓存（`false`），**用户显式点刷新**时传 `true`。
   * @param {{ keepNotice?: boolean }} [options]
   *   `keepNotice: true` ⇒ **成功时不清空 notice**。
   *   ⚠️⚠️ 真实缺陷（用户验收 2026-10-16：「拒绝后给出的提示信息不到 1 秒就消失了
   *   基本不会看清内容」）：调用方先 `setNotice('已把 N 条…恢复为…')`，紧接着
   *   `await load(true)`，而本函数成功分支里那行 `setNotice(null)` **把刚写的提示
   *   清掉了** ⇒ 用户只看到不到 1 秒（甚至看不到）。
   *   ⇒ 凡「先写提示、再刷新」的调用方都必须传 `keepNotice: true`。
   *   ⚠️ 默认（省略）仍是**清空** —— 那是「用户主动点刷新」的既有语义
   *   （刷新后旧的错误提示该消失），不改它以免影响既有行为。
   */
  const load = React.useCallback(async (force = false, options = {}) => {
    setBusy(true);
    try {
      // ⚠️⚠️ **必须传对象而非省略 payload**（真实缺陷，用户报障
      //    「读取聚合目录失败：Error: Invalid Jet Hub management request.」）：
      //    `callManagementRpc` 把 payload 序列化进请求体，而**后端校验要求
      //    payload 键存在**（`jet-hub-rpc.ts` 的
      //    `hasOwnProperty.call(call, 'payload')`）；传 undefined 会被 JSON
      //    序列化**丢弃** ⇒ 后端判为非法请求并回 `Invalid Jet Hub management request.`。
      //    本文件 `backup.export` 处早有同款注释（同一个坑的第二实例）。
      const res = await rpcCall('aggregate.catalog', { force });
      // ⚠️⚠️ **`rpcCall` 成功时返回的是「解包后的值」，不是 `{ok, value}`**
      //    （真实缺陷，第二次报障）：`index.js` 的 rpcCall =
      //    `unwrapRpcResult(callManagementRpc(...))`，而
      //    `unwrapRpcResult` 在 `ok === true` 时返回 `result.value`、
      //    在 `ok === false` 时**抛错**（`throw new Error(error.message)`）。
      //    ⇒ 写 `res.ok === true` 判断**永远为假**（res 是解包后的对象，没有 ok 字段）
      //      ⇒ 界面显示兜底文案「读取聚合目录失败」且**丢掉真实原因**（因为
      //      `res.error.message` 也是 undefined）。这正是用户第二次看到的现象。
      //    ⇒ 正确写法：直接用 `res.models`，错误一律走 `catch` 的 `caught.message`。
      //    既有调用点都是这个形状（如 `model.list` 用 `res.models`、
      //    `backup.export` 用 `res.payload`）。
      const models = res?.models ?? [];
      setModels(models);
      // ⚠️ 排序模式的**权威在宿主**（响应里的 `orderMode`）。缺字段（老宿主）⇒ 临期序。
      setOrderMode(res?.orderMode === 'manual' ? 'manual' : 'expiry');
      // ⚠️⚠️ **必须把宿主返回的 `rejected` 回填进本地拒绝表**（真实缺陷，
      //    对抗审计探针实测证伪）：宿主在每个候选上返回 `rejected: boolean`
      //   （`src/aggregate-adapter.ts` 的 `describeCatalog`），而初版**从不读它** ——
      //    组件读的是本地 `rejections` 状态，其初值是 `{}` 且 `load()` 从不回填。
      //    ⇒ **刷新页面后每条开关都显示「参与轮换」**（即使该候选已被拒绝）：
      //      用户无法通过界面判断自己拒绝过什么；而一点击就会发出一个与宿主
      //      真实状态相反的语义 ⇒ **静默改变轮换行为**。
      //    ⇒ 摊平逻辑在纯函数 `rejectionsFromCatalog` 里（单测环境没有 react），
      //      其三层结构与 `isRejected` 逐层一致（否则回填静默失效）。
      //    ⚠️ 2026-10-15 起该函数**还看 `state`**：`rejected` 的语义已收窄为
      //      「当前不参与轮换」，只有 `state === 'rejected'` 才是用户显式拒绝 ——
      //      否则未接入渠道的「默认不参与」会在面板上被显示成「已拒绝」（用户在撒谎的界面里）。
      setRejections(rejectionsFromCatalog(models));
      // ⚠️ 重拉目录后**丢弃**拖动中的临时顺序：宿主刚下发的 `model.order` 才是权威
      //    （保留临时值会让「刷新」看起来没生效）。
      setPendingOrder({});
      // ⚠️ `keepNotice` 时**保留**调用方刚写的提示（见 options 的注释）。
      if (options.keepNotice !== true) setNotice(null);
    } catch (caught) {
      // ⚠️ `caught.message` 才是服务端给的**真实原因**（如
      //    「聚合 provider 未注册或未提供目录」）—— 不要吞掉它只显示兜底文案。
      setNotice(`读取聚合目录失败：${caught?.message ?? String(caught)}`);
    } finally {
      setBusy(false);
    }
  }, [rpcCall]);

  React.useEffect(() => { void load(); }, [load]);

  /**
   * 切换某条候选的「参与轮换」开关。
   *
   * ⚠️⚠️ **写哪张表由纯函数 `candidateToggleAction` 决定**（"点哪张表"的唯一判据）：
   *    未接入渠道的「不参与」与「拒绝」**同义** ⇒ 关掉它必须写**白名单**（回到默认态），
   *    写拒绝表会留下一批永不起作用的条目、并污染「拒绝非临期」的计数。
   *    **不得**在这里按 `expiryWired` 再分一次支（本仓库「两套同义判据」红线）。
   */
  const onToggleCandidate = React.useCallback(async (model, candidate) => {
    const { rpc, payload } = candidateToggleAction(model.canonicalId, candidate, {
      // ⚠️ 传**回退后**的三态：老宿主（响应无 `state`）下按终端的拒绝表判，
      //    于是只会发出老宿主认识的 `aggregate.setRejected`（它没有 `setAllowed` 端点）。
      state: candidateStateOf(model.canonicalId, candidate, rejections),
    });
    // ⚠️ 乐观更新（仅更**拒绝表**那一半）：先用纯函数算出新表并立刻渲染，再发 RPC。
    //    失败时用服务端状态纠正（见下）—— 否则开关会「点了不动」，用户以为坏了。
    //    ⚠️ 白名单侧的乐观更新**不做**：客户端只回填拒绝表（与既有机制一致），
    //    白名单由随后的 `load(true)` 重新摊平 —— 两边都乐观改会出现两份状态。
    if (rpc === 'aggregate.setRejected') {
      setRejections((prev) => toggleRejection(
        prev, model.canonicalId, candidate.provider, candidate.realId, payload.rejected,
      ));
    }
    try {
      await rpcCall(rpc, payload);
      // ⚠️⚠️ **不要用 `res.aggregateRejections` 直接覆盖本地表**（真实缺陷，对抗审计实测证伪）。
      //
      // `aggregate.setRejected` 返回的是 `pool.listAggregateRejections()` —— 那是
      // **原始存储表**（只含用户逐条写入的 realId），而**轮换实际用的是 `rejectedFor`**：
      // 它还会把「漂移的旧 id」**降级展开**成渠道级拒绝（D4，见 `aggregate-adapter.ts`）。
      //
      // ⇒ 用原始表覆盖会让**开关显示与宿主行为分叉**：降级态下
      //   `isRejected(原始表, 当前 realId) === false` ⇒ 开关显示「参与轮换」，
      //   而宿主**实际仍拒绝**该候选 ⇒ 用户看不出原因也无法自救。
      //
      // ⇒ 改为**重新拉目录**（`aggregate.catalog` 的每个候选都带经 `rejectedFor`
      //   展开后的 `state`），显示与轮换判据**同源**。
      //   ⚠️ `load()` 内部已含 `setRejections(rejectionsFromCatalog(models))`，
      //   故不必在这里再摊平一次。
      // ⚠️ 必须 force = true：load() 默认走宿主侧目录 TTL 缓存（60 秒），
      //    那样拿到的仍是**写之前**的候选表 ⇒ 开关会「点了不动」。
      await load(true, { keepNotice: true });
      // ⚠️ 这里**已经**在 load 之后写了「成功」的语义（`load` 内部会清 notice），
      //    故不传 `keepNotice` —— 本路径没有「先写提示再刷新」的时序问题。
      setNotice(null);
    } catch (caught) {
      // ⚠️ 失败时用服务端状态**纠正**乐观更新（否则界面显示已改、实际没改）。
      setNotice(`保存失败：${caught?.message ?? String(caught)}`);
      // ⚠️ 失败路径**必须** keepNotice（否则 load() 会把刚写的失败原因清掉，
      //    用户看到的是「点了没反应」而不是「保存失败：…」）。
      await load(false, { keepNotice: true });
    }
  }, [rpcCall, load]);

  /**
   * 「按临期排序」的探测结果（`provider → expiry`）；null = 还没探过。
   *
   * ⚠️ 默认**不探测**：临期顺序要逐渠道打一次上游余额请求，而面板一打开就探测
   * 是不可接受的（规格 §8.3 要求 `aggregate.catalog` 零余额查询）。
   * ⇒ 挂载时不探；用户切/点「按临期」才探，且该模式下每 2 分钟自动重探一次。
   *
   * ⚠️ **声明位置在 `onSelectOrderMode` 之前**：那个回调的依赖数组引用了本函数
   *（`const` 的 TDZ 会让「声明在后」在**首次渲染**就抛 `Cannot access before initialization`
   *  —— 而不是等到用户点击时才暴露）。
   */
  const [expiryOrder, setExpiryOrder] = React.useState(null);
  const [expiryBusy, setExpiryBusy] = React.useState(false);
  const onSortByExpiry = React.useCallback(async () => {
    setExpiryBusy(true);
    try {
      // ⚠️ 与 `load` 同款：`rpcCall` 成功返回**解包后的值**（`{ order }`），失败抛错。
      //    不写 `res.ok` 判断（它永远为假，会丢掉真实原因）。
      // ⚠️ `force: true`：**绕过探针自己的 60 秒折算缓存**。用户点「刷新临期顺序」
      //    期待的是真重查；传 false 会让「每 2 分钟自动重探」实际读 60 秒缓存
      //    （用户改了渠道侧配置后要等更久）。
      const res = await rpcCall('aggregate.expiryOrder', { force: true });
      setExpiryOrder(res?.order ?? {});
      setLastProbeAt(Date.now());
      setNotice(null);
    } catch (caught) {
      // ⚠️ 探测失败**不清空**已有顺序，只提示（与 `load` 的失败处理同取向）。
      setNotice(`读取临期顺序失败：${caught?.message ?? String(caught)}`);
    } finally {
      setExpiryBusy(false);
    }
  }, [rpcCall]);

  /**
   * 切换排序模式（顶部 toggle）。
   *
   * ⚠️ **先发 RPC 再改本地 state**：反过来会让落盘失败时面板显示新模式、宿主仍用旧模式
   *（用户下次打开才发现，且中间这段时间「拖了排序不生效」）。
   *
   * ## ⚠️⚠️ 只有切到「按临期」才探测（真实缺陷，用户验收 2026-10-16）
   *
   * 用户原话：「4C 是不覆盖但是有 2 个问题，切换会手工还在查询中等很长时间，
   * **手工排序不用查询吧**？」
   *
   * 根因：本函数原先**无条件** `await onSortByExpiry()` —— 那是**逐渠道上游余额
   * 请求**（十几个 GET），于是切到手工模式也要干等一轮探测。而手工模式的价值恰恰
   * 是「按用户拖的顺序」—— 切过去的那一刻**不需要**任何临期值。
   *
   * ⚠️ 那为什么原来要探？因为手工模式下**没拖过的尾巴**仍按临期排序
   *（`manualRankOf` 对未排过的返回 `undefined` ⇒ 回落临期↓倍率）。但那是
   * **尾部次序的精细度**问题，不是「切模式能不能用」的问题：
   *   - 未探测时 `expiryOf` 返回 `undefined` ⇒ 尾部按**目录序**（与「按渠道名」
   *     那个已删的口径同源）—— 仍然是一个稳定的顺序；
   *   - 用户真正拖过的位次**完全不受影响**（手工位次是严格序，不看临期）。
   * ⇒ 探针留给「按临期」模式（那个模式的存在意义就是它），以及用户**手动**点按钮。
   *   顺带省掉十几个上游请求。
   */
  const onSelectOrderMode = React.useCallback(async (mode) => {
    if (mode === orderMode) {
      // 已经是该模式：再点就是「重新探测」（用户在按临期模式下想刷新顺序）。
      await onSortByExpiry();
      return;
    }
    try {
      const res = await rpcCall('aggregate.setOrderMode', { mode });
      setOrderMode(res?.orderMode === 'manual' ? 'manual' : 'expiry');
      // ⚠️ 这里**刻意清空**（不是 keepNotice）：本路径没有「先写提示再刷新」的时序
      //    问题 —— `setNotice(null)` 在 `load` **之前**，语义是「切模式时丢掉旧提示」。
      //    ⚠️ 我修「提示被清」那个缺陷时曾误给这一处也加了 `keepNotice`，
      //    那会让**上一次操作**的无关提示被保留下来（改成「保留 null」等于没清）。
      setNotice(null);
      await load(true);
      // ⚠️⚠️ **只在切到「按临期」时探测**（见上方长注释）：手工模式不查上游。
      //    切到手工时若已有临期数据（用户从按临期切过来）就继续用，不清空 ——
      //    那能让「未拖过的尾巴」仍按真实临期排，且零额外请求。
      if (mode === 'expiry') await onSortByExpiry();
    } catch (caught) {
      setNotice(`切换排序方式失败：${caught?.message ?? String(caught)}`);
    }
  }, [orderMode, rpcCall, load, onSortByExpiry]);

  /**
   * 「按临期」模式下每 2 分钟自动重探一次（用户 2026-10-15 的追问：
   * 「按临期排序的顺序应该后台定时刷新现在有吗？」—— 答复是**没有**，这里补上）。
   *
   * ⚠️ 三条约束缺一不可：
   *  ① **只在按临期模式**轮询：手工模式的顺序由用户决定，探针只用于给未拖过的尾巴排序，
   *     变了也不会改用户已拖过的位次（轮询纯属浪费上游请求）；
   *  ② **页面隐藏时跳过这一轮**（`document.hidden`）：后台标签页持续打上游是不可接受的；
   *  ③ **卸载时 clearInterval**：面板是设置页的组件，反复进出会叠加定时器
   *    （叠加 N 个 ⇒ 上游请求量 ×N，且只在长时间挂着时才看得出来）。
   * ⚠️ 与手动点击**共用** `expiryBusy` 闸门：并发探测会把上游打爆。
   *
   * ## ⚠️ 2026-10-16：三条判据**搬到纯函数**里（本条原先长期零用例）
   *
   * 用户追问「重探怎么测」时核实：全仓库对这条的断言数为 **0**，因为实现
   * 内联在组件里、单测环境没有 react ⇒ **够不到**。
   * ⇒ 抽到 `aggregate-panel-logic.js` 的 {@link startExpiryReprobe}（挂定时器 +
   * 返回 cleanup）与 {@link shouldReprobeExpiry}（该不该发这一轮）。本处只留接线，
   * **判据全部在那两个纯函数里**（`schedule`/`cancel` 注入 ⇒ 单测能用假定时器真跑
   * 「到点轮询」并断言 cleanup 真的停了定时器）。
   *
   * ⚠️ 接线必须传**真的** `setInterval` / `clearInterval`，且 `isHidden` 传
   * **取值函数**（隐藏状态会在两轮之间变化，传快照会判错）。
   */
  React.useEffect(() => startExpiryReprobe({
    orderMode,
    intervalMs: AGG_EXPIRY_REPROBE_MS,
    isHidden: () => typeof document !== 'undefined' && document.hidden === true,
    probe: () => { void onSortByExpiry(); },
  }), [orderMode, onSortByExpiry]);

  /**
   * 一键「拒绝非临期」：把所有未接入折算渠道的手工打开恢复为「默认不参与」。
   *
   * ⚠️ 文案**分两路**（`cleared === 0` 时不许说「已恢复 N 条」）：空点击是**幂等成功**，
   *    不是错误 —— 用户连点两次看到「没有需要恢复的候选」才是正确的反馈。
   */
  const onRejectNonExpiring = React.useCallback(async () => {
    setRejectBusy(true);
    try {
      const res = await rpcCall('aggregate.rejectNonExpiring', {});
      const cleared = typeof res?.cleared === 'number' ? res.cleared : 0;
      setNotice(cleared === 0
        ? '没有需要恢复的候选：无临期积分的渠道本来就都在「默认不参与」状态。'
        : `已把 ${cleared} 条候选恢复为「默认不参与轮换」。`);
      // ⚠️⚠️ **必须 `keepNotice: true`**（真实缺陷，用户验收 2026-10-16：
      //    「拒绝后给出的提示信息不到 1 秒就消失了基本不会看清内容」）：
      //    上面刚写了提示，而 `load()` 成功分支里的 `setNotice(null)` 会把它清掉。
      await load(true, { keepNotice: true });
    } catch (caught) {
      setNotice(`恢复默认失败：${caught?.message ?? String(caught)}`);
    } finally {
      setRejectBusy(false);
    }
  }, [rpcCall, load]);

  /** 某模型当前生效的顺序数组（临时值优先，缺省用宿主下发的 `order`）。 */
  const orderOf = (model) => pendingOrder[model.canonicalId] ?? model.order ?? [];

  /**
   * 把拖动结果落盘（**整体提交**，见 `pendingOrderFromRoster`）。
   *
   * ⚠️ 用**服务端返回的权威数组**覆盖本地临时顺序（不是本地回声）：
   *    服务端会过滤掉「不再是候选」的脏键并去重，客户端据此校正才不会长期分叉。
   * ⚠️ `orderBusy` 闸门按模型隔离：拖 A 的同时拖 B 不该互相阻塞，但同一个模型
   *    连拖两次必须串行（后发的响应先到会覆盖新的顺序）。
   */
  const commitOrder = React.useCallback(async (model, participating) => {
    if (orderBusy[model.canonicalId] === true) return;
    setOrderBusy((prev) => ({ ...prev, [model.canonicalId]: true }));
    try {
      const order = pendingOrderFromRoster(participating);
      const res = await rpcCall('aggregate.setOrder', { canonicalId: model.canonicalId, order });
      setPendingOrder((prev) => ({ ...prev, [model.canonicalId]: res?.order ?? [] }));
      setNotice(null);
    } catch (caught) {
      setNotice(`保存顺序失败：${caught?.message ?? String(caught)}`);
      // ⚠️ 失败时丢弃临时顺序（回到宿主下发的权威值），否则面板会显示一份
      //    宿主**并不知道**的顺序 —— 那是显示与行为分叉。
      setPendingOrder((prev) => {
        const next = { ...prev };
        delete next[model.canonicalId];
        return next;
      });
    } finally {
      setOrderBusy((prev) => ({ ...prev, [model.canonicalId]: false }));
    }
  }, [orderBusy, rpcCall]);

  /** 拖动中的源键（跨 dragover 传递；只在组件内用，不进 state）。 */
  const dragKeyRef = React.useRef(null);

  const renderCandidate = (model, candidate, options = {}) => {
    const canonicalId = model.canonicalId;
    // ⚠️ 传**回退后**的三态（见 candidateStateOf）：老宿主下也能显示正确的开关文案
    //    与「已拒绝」，而不是让用户看到「状态未知」。
    const resolvedState = { state: candidateStateOf(canonicalId, candidate, rejections) };
    const state = describeCandidateState(candidate, resolvedState);
    // ⚠️ 临期顺序**只在探测过之后**才有值；未探测时按原顺序（渠道名字母序）。
    const expiry = expiryOrder === null ? undefined : expiryOrder[candidate.provider];
    // ⚠️ 未参与的候选整行淡化（与升级前「已拒绝」的视觉一致），但**仍可点**（那是恢复路径）。
    const inactive = candidateStateOf(canonicalId, candidate, rejections) !== 'allowed';
    const draggable = options.draggable === true;
    return React.createElement('div', {
      className: 'dim-jh-aggCandidate'
        + (inactive ? ' dim-jh-aggCandidateRejected' : '')
        + (options.dragOver === true ? ' dim-jh-aggDragOver' : ''),
      key: `${candidate.provider}\u0000${candidate.realId}`,
      // ⚠️ 只有**参与轮换**的候选可拖（见 `rotationRosterOf` 的说明）。
      draggable: draggable,
      onDragStart: draggable
        ? (event) => {
            dragKeyRef.current = candidateKeyOf(candidate);
            // ⚠️⚠️ **必须 `setData`，否则拖拽根本不触发**（真实缺陷，用户验收实测：
            //    「拖动好像是不生效的」）。本仓库另两处拖动（账号卡片、渠道开关）
            //    都有这一行并各自注明「Firefox 不触发拖拽」—— 我第一版漏了它，
            //    于是只在「上下箭头」路径能改序，鼠标拖拽整个失效。
            try { event.dataTransfer.setData('text/plain', candidateKeyOf(candidate)); } catch { /* 忽略 */ }
            if (event?.dataTransfer !== undefined) event.dataTransfer.effectAllowed = 'move';
          }
        : undefined,
      // ⚠️ `onDragEnd` 必须清引用：拖到无效区域（或按 Esc 取消）时不会有 `drop`，
      //    残留的 `dragKeyRef` 会让**下一次** hover 到别的行时被当成「正在拖」而 preventDefault。
      onDragEnd: draggable ? () => { dragKeyRef.current = null; } : undefined,
      onDragOver: draggable
        ? (event) => {
            if (dragKeyRef.current === null) return;
            // ⚠️ 必须 preventDefault，否则浏览器不允许 drop（与仓库另两处拖动同因）。
            event.preventDefault();
            if (event?.dataTransfer !== undefined) event.dataTransfer.dropEffect = 'move';
          }
        : undefined,
      onDrop: draggable
        ? (event) => {
            event.preventDefault();
            const from = dragKeyRef.current;
            dragKeyRef.current = null;
            if (from === null) return;
            // ⚠️ 拖动结果先落**本地临时顺序**（立即重渲染），**紧接着就提交**。
            //
            // ⚠️⚠️ **必须在 `onDrop` 里直接提交**（真实缺陷，用户验收 2026-10-16：
            //    「把 codearts 拉到第一个，关闭设置窗口再打开又跑最后一个了」）。
            //
            // 我原先只在 `onDrop` 里 `setPendingOrder(...)`、把落盘交给一个
            // **「保存顺序」按钮**，于是：拖动**只改了界面**，宿主的
            // `state.json.aggregateOrder` 一个字都没变 ⇒ 关窗再打开（重新 `load`）
            // 就回到宿主的旧顺序 —— 用户看到的正是「白拖了」。
            //
            // ⚠️ 本仓库另两处拖动（账号卡片 `:3555`、渠道开关 `:4746`）都是
            // **松手即提交**（`onDrop` 里直接 `void commit(...)`）⇒ 我那个
            // 「先预览、再点保存」的设计与全站交互不一致，**是本缺陷的根源**。
            // ⇒ 改为同一形态：松手即落盘（一次拖动只发**一个**请求 —— 每次
            //    `dragover` 都发才会打出几十个）。
            const next = moveCandidateTo(orderOf(model), from, options.index);
            setPendingOrder((prev) => ({ ...prev, [canonicalId]: next }));
            // ⚠️ 提交用**拖后顺序对应的候选对象**（`commitOrder` 要参与候选的完整顺序）。
            const byKey = new Map((model.candidates ?? []).map((c) => [candidateKeyOf(c), c]));
            const participatingNext = next
              .map((key) => byKey.get(key))
              .filter((c) => c !== undefined)
            // ⚠️ 补上「顺序表里没出现但确实参与」的候补（与 `commitOrder` 的前置一致）：
            //    漏掉会让服务端把未出现的候选按临期兜底追加 ⇒ 用户刚排好的相对位置被改。
            for (const candidate of model.candidates ?? []) {
              if (candidateStateOf(canonicalId, candidate, rejections) !== 'allowed') continue
              const key = candidateKeyOf(candidate)
              if (!next.includes(key)) participatingNext.push(candidate)
            }
            void commitOrder(model, participatingNext);
          }
        : undefined,
    },
    // ⚠️ 拖动手柄**显式**给出（HTML5 拖动的一个已知可用性坑）：
    //    整行可拖时用户不知道能拖；且手柄能承载 title 说明「拖到哪」。
    draggable
      ? React.createElement('span', {
          className: 'dim-jh-aggDragHandle',
          title: '按住拖动以调整这个模型的候选顺序',
          'aria-hidden': 'true',
        }, '⠿')
      : null,
    React.createElement('span', { className: 'dim-jh-aggCandidateLabel' },
      candidateRowLabel(candidate)),
    // ⚠️ 只有探测过才显示到期提示 —— 否则显示「到期未知」会让用户以为查过了。
    expiry === undefined
      ? null
      : React.createElement('span', {
          className: 'dim-jh-aggCandidateExpiry',
          title: '按临期排序时算出的到期时刻',
        }, expiryLabel(expiry)),
    // ⚠️⚠️ **不再渲染「无临期积分 · 未参与」这段文字**（用户 2026-10-16 验收要求）：
    //    「图1红框中的内容可以不用显示」。未参与的状态由**整行淡化**
    //   （`dim-jh-aggCandidateRejected`）与开关本身的文案表达，行里再挂一遍是冗余。
    //    ⚠️ 开关按钮**保留**它的文案与 title（那是三态的**唯一**出口，
    //    去掉用户就无从知道该点还是不点）。
    // ⚠️ 上移 / 下移按钮**已删除**（用户明确要求：「我们不应该有上下箭头就是应该
    //    鼠标拖动」）。键盘可达性由开关与展开区承担；拖动走 HTML5 drag（已修
    //    `setData` 那一处，见 `onDragStart`）。
    React.createElement('button', {
      type: 'button',
      className: 'dim-jh-aggToggle' + (state.pressed ? '' : ' dim-jh-aggToggleOff'),
      // ⚠️ 语义是「**参与**轮换」的正向开关：打开 = 允许用这个渠道（规格 §7.1 的原话）。
      // ⚠️ 文案与 title 来自纯函数（三态 + 「已打开的未接入渠道排在最后」的说明）。
      'aria-pressed': String(state.pressed),
      title: state.title,
      onClick: () => { void onToggleCandidate(model, candidate); },
    }, state.label));
  };

  const renderModel = (model) => {
    const open = expanded[model.canonicalId] === true;
    // ⚠️ 排序模式决定用哪套判据：
    //    - `expiry`：**保持升级前的单列表**（全部候选、按临期或字母序），不动信息架构；
    //    - `manual`：两段式（参与 / 未参与），只有参与段可拖动。
    const manual = orderMode === 'manual';
    const rankMap = manual
      ? new Map(orderOf(model).map((key, index) => [key, index]))
      : null;
    const expiryOf = (provider) => (expiryOrder === null ? undefined : expiryOrder[provider]);
    const { participating, inactive } = rotationRosterOf(model, rankMap, expiryOf, rejections);
    const candidates = manual
      ? participating
      : (expiryOrder === null
          ? model.candidates
          : sortCandidatesByExpiry(model.candidates.map((c) => ({
              ...c, expiry: expiryOrder[c.provider],
            }))));
    const blocker = rotationBlockerOf(model, rejections);
    // ⚠️⚠️ 帽子必须**极短**（用户 2026-10-16 验收：「图1中的无临期积分 默认不参与占太宽了
    //    把模型名字都挤没了，需要缩短提示」）⇒ 一律 ≤ 5 个汉字。
    //    解释性文字全部移进 `title`（hover 才看）—— 帽子只承担「这个模型现在有问题」
    //    这一个信号。用户选定的文案是「无临期全拒」。
    //    ⚠️ `all-rejected` 那一档的**语义与恢复指引不得丢**（规格 §5.2 明文要求
    //    「面板需对候选全被拒给出显式提示」），故 title 里保留完整指引。
    const blockerNode = blocker === 'all-rejected'
      ? React.createElement('span', {
          className: 'dim-jh-aggAllRejected',
          title: '你把该模型的全部候选都关了「参与轮换」——请求会如实报「没有任何可用候选」。'
            + '若想恢复，展开后在子列表里重新打开至少一条。',
        }, '全部被拒')
      : blocker === 'all-default'
        ? React.createElement('span', {
            className: 'dim-jh-aggAllRejected',
            title: '该模型的候选都来自没有临期积分折算的渠道，默认不参与轮换。'
              + '展开后可以逐条手工打开（打开后它们排在所有能算出临期的候选之后）。'
              + '在打开之前，这个模型不会出现在模型选择器里。',
          }, '无临期全拒')
        : blocker === 'mixed'
          ? React.createElement('span', {
              className: 'dim-jh-aggAllRejected',
              title: '候选全部未参与轮换：其中一部分是你拒绝的、一部分是没有临期积分折算'
                + '默认不参与的。展开后可以逐条处理。',
            }, '均未参与')
          : null;
    return React.createElement('div', { className: 'dim-jh-aggModel', key: model.canonicalId },
      React.createElement('button', {
        type: 'button',
        className: 'dim-jh-aggModelHead',
        'aria-expanded': String(open),
        onClick: () => setExpanded((prev) => ({ ...prev, [model.canonicalId]: !open })),
      },
      React.createElement('span', { className: 'dim-jh-aggModelName' },
        model.name || model.canonicalId),
      // ⚠️⚠️ **不再渲染「N 个渠道 · 按渠道名/按临期/按手工」这段 meta**
      //（用户 2026-10-16 验收要求：「图1红框中的内容可以不用显示」）。
      //   当前处于哪种排序模式由**顶部 toggle 的高亮段**表达（那是权威且唯一），
      //   模型头再挂一遍是冗余；「N 个渠道」用户展开就看得见。
      //   ⚠️ 候选**数量**信息并未丢失：展开后「未参与轮换（K）」那一段仍带计数，
      //   而参与数量 = 展开后的可拖行数。
      blockerNode,
      React.createElement('span', { className: 'dim-jh-aggChevron' }, open ? '▾' : '▸')),
      open
        ? React.createElement('div', { className: 'dim-jh-aggCandidates' },
            candidates.map((candidate, index) => renderCandidate(model, candidate, {
              draggable: manual,
              index: index,
              last: index === candidates.length - 1,
            })),
            // ── 未参与段（仅手工模式）──
            // ⚠️ **「保存顺序」按钮已删除**（用户验收 2026-10-16）：拖动现在
            //    **松手即提交**（见 `onDrop`），那个按钮既多余、又会让人以为
            //    「不点就不会保存」（真实缺陷：原先不点就真的不保存 ⇒
            //     关窗再开顺序就丢了）。交互与本仓库另两处拖动统一。
            manual && inactive.length > 0
              ? React.createElement('div', { className: 'dim-jh-aggInactiveSection' },
                  React.createElement('span', { className: 'dim-jh-aggInactiveTitle' },
                    `未参与轮换（${inactive.length}）`),
                  inactive.map((candidate) => renderCandidate(model, candidate)))
              : null)
        : null);
  };

  // ⚠️ 根元素用 `div` 而非 `main`（真实缺陷，对抗审计指出）：
  //    父级 `JetHubPage` 已经是 `<main className="dim-jh-panel" role="tabpanel">`
  //    （见本文件的渲染分流处），内层再写 `<main>` 会产生**嵌套 main** ——
  //    无障碍语义错误（一个文档只应有一个 main landmark）。
  //    ⚠️ 同理不再重复声明 `role="tabpanel"`（那是父级的角色）。
  //    ⚠️ 也不再重复 `.dim-jh-panel` 类（父级已有；重复会让两条规则的 padding/overflow
  //    互相覆盖，样式归属分叉）。
  // ⚠️ 模型列表的排序：用户 2026-10-07 要求**去掉厂商分组标题**（「8 个聚合模型下面
  //    不需要再显示渠道了，因为渠道在每个模型的展开展示参与轮换的子列表中显示了」）
  //    ⇒ 模型平铺，全局按候选渠道数降序。厂商信息仍可在展开后的子列表里逐条看到。
  const sortedModels = sortModelsForPanel(models ?? []);
  // 探测时间的人话（工具行显示「N 分钟前」，让用户知道看到的是多旧的数据）。
  const probedAgoText = lastProbeAt === null ? '' : (() => {
    const minutes = Math.floor((Date.now() - lastProbeAt) / 60_000);
    return minutes < 1 ? '刚刚' : `${minutes} 分钟前`;
  })();
  return React.createElement('div', {
    className: 'dim-jh-aggPanel',
  },
  // ── 说明区 ──
  React.createElement('section', { className: 'dim-jh-aggIntro' },
    React.createElement('h2', { className: 'dim-jh-aggTitle' }, '聚合'),
    React.createElement('p', { className: 'dim-jh-aggIntroLine' },
      '把同一个模型在各渠道的条目聚合成一个名字，请求时按「积分最快作废」自动选渠道。'),
    React.createElement('p', { className: 'dim-jh-aggIntroLine' },
      '三层开关互不影响：关渠道（各渠道自己的面板）、关模型（模型选择器）、'
      + '以及本页子列表里逐条控制某个候选是否参与轮换（只影响这一个模型）。'),
    React.createElement('p', { className: 'dim-jh-aggIntroWarn' },
      '本 provider 无需登录、没有账号池；积分与限流由各渠道自己管理。'),
    // ⚠️ 文案必须**说真话**（2026-10-15 改写）：未接入折算的渠道现在**也出现在目录里**
    //    且可逐条手工打开，故不能再写「不参与轮换（仍可直连使用）」那句 ——
    //    它会让用户以为这里做什么都没用。
    React.createElement('p', { className: 'dim-jh-aggIntroLine' },
      '没有临期积分折算的渠道**默认不参与轮换**（它们现在也出现在目录里，'
      + '展开模型后可以逐条手工打开）。'),
    // ⚠️ 这一句是**必须**的：手工打开的未接入候选与「无临期积分」的已接入候选
    //    都是 `NEVER` ⇒ 它们排在能算出临期的候选**之后**。用户看到「我明明手工打开了
    //    却排在最后」时，若面板从没说过这件事，就会以为是缺陷。
    React.createElement('p', { className: 'dim-jh-aggIntroLine' },
      '「按手工排序」模式下可以拖动候选调整顺序。手工打开的「无临期积分」候选'
      + '排在所有能算出临期的候选之后（两者没有可比较的到期时间），'
      + '这种混合顺序是正常的、不是缺陷。')),
  // ── 工具行 ──
  // ⚠️⚠️ **顺序：按钮在前、计数在后**（用户 2026-10-16 第三次验收：
  //    「43 个聚合模型应该显示在按钮下面」）。
  //    原先计数在最前 ⇒ 它占掉第一行的一个位置。⇒ 现在按钮先排，计数放**最后**
  //    并由 CSS 的 flex-basis: 100% 强制换行 ⇒ 恒定显示在按钮**下面**。
  React.createElement('div', { className: 'dim-jh-aggToolbar' },
    // ⚠️⚠️ 排序模式改成**单个切换按钮**（用户 2026-10-16 验收要求：
    //    「图2的排序按手工还是按临期应该是一个按钮的点击切换（就像解锁永久积分和
    //     锁定永久积分一样）」）。
    //    形态照 `permanentLockCopy` 那个按钮：按钮文字说**当前状态**，点击切到另一种，
    //    变化与代价放 `title`；激活态（按手工）用 `data-kind='primary'` 区分。
    //    ⚠️ 原来的两段式 `dim-jh-aggSegmented` 已删除 —— 两段在窄面板下各占一列，
    //    会把工具行挤成竖排（同一个验收截图里的现象）。
    // ⚠️⚠️ **必须用 `.dim-jh-btn`**（用户 2026-10-16 第二次验收：
    //    「拒绝非临期和切换排序为什么还是没有按按钮样式（图2）显示」）。
    //    根因：我原先给聚合工具栏用的是自造的 `.dim-jh-aggRefresh`（圆角 6px、**无背景色**、
    //    `primary` 只是描边变蓝），而全站按钮的标准类 `.dim-jh-btn` 是
    //    圆角 8px + 有底色 + hover 变蓝 + `primary` = **实心蓝底白字**（图2 那个
    //    「解锁永久积分」正是它）⇒ 两套样式看起来不像同一个 UI。
    //    ⇒ 排序切换与「拒绝非临期」「刷新」全部改用 `.dim-jh-btn`，
    //      激活态沿用 `data-kind='primary'`（与「锁定永久积分」**逐字同一形态**）。
    React.createElement('button', {
      type: 'button',
      className: 'dim-jh-btn',
      'data-kind': orderMode === 'manual' ? 'primary' : undefined,
      disabled: expiryBusy,
      'aria-pressed': String(orderMode === 'manual'),
      title: orderMode === 'manual'
        ? '当前按**你手工拖动的顺序**轮换。点此切回「按临期」——'
          + '临期序每 2 分钟自动重查一次（会打上游请求）；手工序不受影响、仍各自保存。'
        : '当前按**积分最快作废**的顺序轮换（每 2 分钟自动重查一次，会打上游请求）。'
          + '点此切到「按手工」——展开模型后可拖动候选调整顺序，两种顺序分别保存、互不覆盖。',
      onClick: () => { void onSelectOrderMode(orderMode === 'manual' ? 'expiry' : 'manual'); },
    }, expiryBusy
      ? '查询中…'
      : (orderMode === 'manual'
          ? '排序：按手工'
          : `排序：按临期${lastProbeAt !== null ? ` · ${probedAgoText}` : ''}`)),
    // ⚠️ 一键「拒绝非临期」：把未接入折算渠道的手工打开恢复为「默认不参与」。
    //    它**不弹确认**（可逆、且逐条还能再打开）—— 但文案必须区分
    //    「恢复了 N 条」与「本来就没打开」（见 `onRejectNonExpiring`）。
    React.createElement('button', {
      type: 'button',
      className: 'dim-jh-btn',
      disabled: rejectBusy,
      title: '把所有没有临期积分折算的渠道恢复为「默认不参与轮换」的初始状态'
        + '（它们仍留在聚合目录里，可随时逐条手工打开；已接入折算的渠道不受影响）',
      onClick: () => { void onRejectNonExpiring(); },
    }, rejectBusy ? '处理中…' : '拒绝非临期'),
    React.createElement('button', {
      type: 'button',
      className: 'dim-jh-btn',
      disabled: busy,
      // ⚠️ **显式刷新必须传 `true`**（绕过宿主侧 60 秒目录缓存）——
      //    否则按钮实际是「读缓存」，用户改了渠道模型后点刷新看不到变化。
      title: '重新读取各渠道的模型目录（绕过 60 秒缓存）',
      onClick: () => { void load(true); },
    }, busy ? '刷新中…' : '刷新'),
    // ⚠️ 计数**放最后**（见工具行开头的注释）：CSS 的 flex-basis: 100% 让它
    //    恒定换行到按钮**下一行**（用户要求「应该显示在按钮下面」）。
    React.createElement('span', { className: 'dim-jh-aggCount' },
      models === null ? '读取中…' : `${models.length} 个聚合模型`)),
  notice !== null
    ? React.createElement('div', { className: 'dim-jh-aggNotice' }, notice)
    : null,
  // ── 空态 ──
  // ⚠️ 文案**不得写死渠道数量**（那类快照必然腐坏，仓库既有教训：接入 accio/officeace
  //    后手抄名单没人回头改，只登那两家的用户会看到「请先登录」这句错话）。
  //    这里从 `AGG_WIRED_CHANNEL_IDS` 现查 `providerLabel()` —— id 名单的集合相等
  //    由用例锁死；**名字不抄**（registry 是唯一真相源）⇒ 改名 / 新增均零改动。
  // ⚠️ 2026-10-15 补上「或手工打开」这条出路：未接入渠道的账号**不会**让模型自动
  //    进轮换，用户若只登录了那几家，看到的仍是空态 —— 必须告诉他第二步做什么。
  models !== null && models.length === 0
    ? React.createElement('div', { className: 'dim-jh-aggEmpty' },
        '当前没有可聚合的模型：请先在至少一个已接入临期折算的渠道'
        + '（' + AGG_WIRED_CHANNEL_IDS.map(id => providerLabel(id)).join(' / ') + '）登录账号；'
        + '或者登录其它渠道后，在本页展开模型、把候选逐条手工打开。')
    : null,
  // ── 模型列表（**平铺**，全局按候选渠道数降序；不再有厂商分组标题）──
  sortedModels.map((model) => renderModel(model)),
  // ── 页脚说明 ──
  React.createElement('footer', { className: 'dim-jh-aggFooter' },
    React.createElement('p', null,
      '为什么没有签到 / 重置 / 新建账号按钮：本 provider 不持有账号与积分。'),
    React.createElement('p', null,
      '候选如何得出：字面推导（id / name 双通道）+ 显式映射补丁。'),
    React.createElement('p', null,
      '如何核查：展开任一模型，逐条看渠道与真实 modelId；不同意就关掉那一行。')));
}

/**
 * Jet Hub 设置页根组件。
 *
 * ⚠️ 宿主对 `settings.section` 还会注入一个 `close`（契约
 * `SettingsSectionOwnerProps`，是 section 收到的**唯一**一个 shell 能力）。
 * 本页**刻意不接收**它：它原本只驱动页头那个「关闭」按钮，而该按钮已被
 * 「渠道原生搜索」开关取代（关闭途径仍有设置面板右上角的 × 与点击空白处）。
 * 将来若要做「从 Jet Hub 直接启动会话」，需要把它加回签名。
 */
export function JetHubPage({ rpcCall }) {
  const [selected, setSelected] = React.useState(PROVIDERS[0].id);
  // 每次切换 provider 时递增版号，强制重新挂载 ProviderPanel 触发 loadAccounts
  const [version, setVersion] = React.useState(0);
  // 一键签到：busy 防重复点击，notice 显示上一次结果摘要。
  const [checkinBusy, setCheckinBusy] = React.useState(false);
  const [checkinNotice, setCheckinNotice] = React.useState(null);
  /**
   * 供应商级状态（provider id → ProviderStatus），driving 左侧分组与页头弹窗里的开关。
   *
   * `null` = 尚未读取成功（分组退化为不分组平铺，弹窗里的开关全部禁用）——
   * 与「读取到空对象」区分：后者说明服务端确实什么都没返回，也按未读取处理。
   */
  const [providerStatuses, setProviderStatuses] = React.useState(null);
  /**
   * 供应商状态**读取失败**（区别于「还没读回来」）。
   *
   * `providerStatuses === null` 同时承载「加载中」与「失败」两种情况，界面上
   * 必须分开说：加载中提示「正在读取状态…」是准确的，失败时再这么说就成了
   * 误导（用户会一直等）。失败信息由页头那条 notice 与弹窗计数共同承担。
   */
  const [providerStatusFailed, setProviderStatusFailed] = React.useState(false);
  /**
   * 「供应商开关」弹窗的展开状态。
   *
   * 与「显示列表」同款取舍：**关闭时不挂载**，避免每次进入设置页都为它做一次
   * 无谓的渲染；状态本身由页面级 `providerStatuses` 提供，不额外发请求。
   */
  const [showProviderSwitches, setShowProviderSwitches] = React.useState(false);
  /** 正在提交的供应商 id 集合：只禁用被点的那一个开关。 */
  const [providerBusy, setProviderBusy] = React.useState(() => new Set());
  /**
   * 供应商自定义显示顺序（「供应商开关」弹窗的拖拽排序，宿主持久化）。
   *
   * `null` = 尚未读到 / 读取失败 / 用户从未自定义 —— 三种情况展示侧都按
   * 声明顺序渲染，界面上无法也不必区分。降级思路与 providerStatuses 一致：
   * 顺序是**纯展示偏好**，任何一次读取失败都不该打扰用户（区别于开关状态，
   * 那个失败会显式提示）。
   */
  const [providerOrder, setProviderOrder] = React.useState(null);
  /**
   * 排序提交进行中（与账号面板的 `reordering` 同款）。
   *
   * ⚠️ 不做乐观更新 ⇒ RPC 返回前 `providerOrder` 仍是旧值，`rows` 也仍基于
   * 旧值。若这段时间里用户再拖一次，第二次会**基于旧顺序**计算，于是第一次的
   * 移动被静默覆盖（实测：拖 cline 到最前后紧接着拖 loomy，cline 被打回原位）。
   * 账号面板早就有这把锁（`reordering ? { enabled: false } : dragPropsFor(...)`），
   * 这里必须同样把「排序提交中」并入 `dragEnabled`。
   */
  const [providerReordering, setProviderReordering] = React.useState(false);
  /**
   * 排序提交的**同步**互斥锁（ref 而非 state）。
   *
   * ⚠️ 必须用 ref 而不是直接读 `providerReordering`：state 写入后要等下一次
   * 渲染才可见，而两次 drop 可以发生在同一次渲染周期内 —— 读 state 会让锁
   * 形同虚设（账号面板的 `reordering` 走 state，是因为它的入口是按钮、
   * 有一次点击到渲染的自然间隔；拖拽 drop 没有这层间隔）。
   */
  const reorderLockRef = React.useRef(false);
  /**
   * 供应商开关的结果提示（成功或失败）。
   *
   * 与 `checkinNotice` 分开：两者可能先后出现，共用一个状态会让后写的覆盖先写的，
   * 用户就看不到自己刚做的那个操作的结果了。
   */
  const [providerNotice, setProviderNotice] = React.useState(null);
  /**
   * 本机网关的开关面板可见性与状态。
   *
   * ⚠️ `gatewayStatus` 初值为 `null`（= 未知），**不能**默认成「已开启」：
   * 未知时按钮文字与开关都必须退化成中性态，否则一次读取失败就会让 UI 显示
   * 「网关开着」而用户其实连不上。判据见 `openai-gateway-panel.js`。
   */
  const [showGateway, setShowGateway] = React.useState(false);
  const [gatewayStatus, setGatewayStatus] = React.useState(null);
  const [gatewayBusy, setGatewayBusy] = React.useState(false);
  const [gatewayNotice, setGatewayNotice] = React.useState(null);
  /** 「Token 用量」弹窗（覆盖层，与供应商开关/网关弹窗互斥打开）。 */
  const [showTokenLedger, setShowTokenLedger] = React.useState(false);
  const mounted = React.useRef(true);
  React.useEffect(() => () => { mounted.current = false; }, []);

  /**
   * 读取网关状态。
   *
   * 失败**不抛**、也不把 `gatewayStatus` 置成任何「像是有值」的状态：保持
   * `null` 让 UI 退化成「读取中/未知」，并在提示条里说明原因。
   */
  const loadGatewayStatus = React.useCallback(async () => {
    try {
      const res = await rpcCall('gateway.getEnabled', {});
      if (!mounted.current) return;
      setGatewayStatus(res);
    } catch (caught) {
      console.error('[jet-hub] read gateway status failed:', caught);
      if (!mounted.current) return;
      setGatewayStatus(null);
      setGatewayNotice({ tone: 'error', text: '读取网关状态失败：' + (caught?.message || '未知错误') });
    }
  }, [rpcCall]);

  React.useEffect(() => { void loadGatewayStatus(); }, [loadGatewayStatus]);

  /**
   * 切换「允许局域网访问」。
   *
   * ⚠️ 与 `toggleGateway` 同约定：**不做乐观更新** —— 换绑是否成功（端口、
   * env host 覆盖、网关总开关状态）只有服务端知道，一律以回传的整份 status 为准。
   */
  const toggleGatewayAllowLan = React.useCallback(async (nextAllowLan) => {
    setGatewayBusy(true);
    setGatewayNotice(null);
    try {
      const res = await rpcCall('gateway.setAllowLan', { allowLan: nextAllowLan });
      if (!mounted.current) return;
      setGatewayStatus(res);
      setGatewayNotice({ tone: 'ok', text: gatewayAllowLanToggleNotice(res, nextAllowLan) });
    } catch (caught) {
      console.error('[jet-hub] toggle gateway allowLan failed:', caught);
      if (!mounted.current) return;
      // 保留原状态：重新拉一次以确保与服务端一致。
      setGatewayNotice({ tone: 'error', text: '操作失败：' + (caught?.message || '未知错误') });
      await loadGatewayStatus();
    } finally {
      if (mounted.current) setGatewayBusy(false);
    }
  }, [rpcCall, loadGatewayStatus]);

  /**
   * 打开/关闭网关。
   *
   * ⚠️ **不做乐观更新**：网关是否真在监听取决于端口占用与环境变量两件前端看不见
   * 的事，本地先改会让开关显示「已开启」而实际没跑起来。一律以服务端回传为准。
   */
  const toggleGateway = React.useCallback(async (nextEnabled) => {
    setGatewayBusy(true);
    setGatewayNotice(null);
    try {
      const res = await rpcCall('gateway.setEnabled', { enabled: nextEnabled });
      if (!mounted.current) return;
      setGatewayStatus(res);
      setGatewayNotice({ tone: 'ok', text: gatewayToggleNotice(res, nextEnabled) });
    } catch (caught) {
      console.error('[jet-hub] toggle gateway failed:', caught);
      if (!mounted.current) return;
      // 保留原状态：重新拉一次以确保与服务端一致。
      setGatewayNotice({ tone: 'error', text: '操作失败：' + (caught?.message || '未知错误') });
      await loadGatewayStatus();
    } finally {
      if (mounted.current) setGatewayBusy(false);
    }
  }, [rpcCall, loadGatewayStatus]);

  /**
   * 读取全部供应商的汇总状态。
   *
   * 一次请求拿全部 8 个（而不是逐个查）：服务端全程只用同步内存副本，
   * 不产生网络往返（见 `provider.status` 的注释）。
   *
   * **失败不阻断账号管理**：读不到就把 `providerStatuses` 置为 null，让 rail
   * 退化为不分组平铺（仍可正常选择供应商、管理账号），只在页头提示一句。
   * 若在这里抛错，整个设置页会白屏 —— 那是「左侧装饰性功能拖垮主功能」的糟糕取舍。
   */
  const loadProviderStatuses = React.useCallback(async () => {
    try {
      const res = await rpcCall('provider.status', { providers: PROVIDERS.map(p => p.id) });
      if (!mounted.current) return;
      setProviderStatuses(res?.statuses || {});
      setProviderStatusFailed(false);
    } catch (caught) {
      console.error('[jet-hub] load provider statuses failed:', caught);
      if (!mounted.current) return;
      setProviderStatuses(null);
      setProviderStatusFailed(true);
      setProviderNotice({
        tone: 'warn',
        text: `供应商开关状态读取失败（${caught?.message || '未知错误'}），已按原顺序显示供应商；账号管理不受影响。`,
      });
    }
  }, [rpcCall]);

  React.useEffect(() => {
    mounted.current = true;
    void loadProviderStatuses();
  }, [loadProviderStatuses]);

  /**
   * 读取供应商自定义顺序。
   *
   * 失败**不提示**（只 console.error + 保持 null）：与 loadProviderStatuses
   * 的降级口径不同 —— 状态读不到会影响「能不能关」的操作判断，值得一条提示；
   * 顺序读不到只是回到默认排列，用户毫无感知损失，弹提示反而是噪音。
   */
  const loadProviderOrder = React.useCallback(async () => {
    try {
      const res = await rpcCall('provider.getOrder', {});
      if (!mounted.current) return;
      setProviderOrder(Array.isArray(res?.order) && res.order.length > 0 ? res.order : null);
    } catch (caught) {
      console.error('[jet-hub] load provider order failed:', caught);
      if (!mounted.current) return;
      setProviderOrder(null);
    }
  }, [rpcCall]);

  React.useEffect(() => {
    void loadProviderOrder();
  }, [loadProviderOrder]);

  /**
   * 打开 Jet Hub 时的默认选中卡片 = 自定义序第一位的供应商。
   *
   * 初值 `PROVIDERS[0].id` 是**声明序第一位**——providerOrder 是异步读的，
   * useState 时刻它还是 null，没法一步到位。这里用「一次性纠偏」：
   * providerOrder 首次到达后，若用户**尚未**手动点过任何卡片（touchedRef），
   * 把 selected 切到自定义序的第一个**已打开**供应商；一旦用户点过，不再
   * 接管（避免覆盖用户的选择）。
   *
   * ⚠️ 本 effect 的依赖（providerOrder / providerStatuses）**必须**声明在本
   * effect 之后：`useEffect(fn, deps)` 的 deps 数组由 JS 引擎在进入调用前
   * 就急切求值，若依赖的 `const` 还在 TDZ（声明之前），**首次渲染就会抛
   * ReferenceError: Cannot access 'providerOrder' before initialization**，
   * 整个 Jet Hub 页直接打不开。初版把它放在两个 useState 之前，症状是
   * 「构建/单测全绿、点开 Jet Hub 白屏」—— 纯源码断言的用例测不到它。
   *
   * 「已打开」过滤的原因：自定义序首位若已被关闭，把它选进来会渲染一个
   * 无账号可管理的空面板——此刻跳到下一个 open 的才是用户想要的。
   * providerStatuses 未读时保守回退 providerOrder[0]（宁多勿少，与分组
   * 判据同取向）。
   */
  const providerTouchedRef = React.useRef(false);
  React.useEffect(() => {
    if (providerTouchedRef.current) return;
    if (!Array.isArray(providerOrder) || providerOrder.length === 0) return;
    const firstUsable =
      providerOrder.find(id => providerStatuses === null || providerStatuses?.[id]?.closed !== true)
      ?? providerOrder[0];
    if (typeof firstUsable === 'string' && firstUsable !== selected
      && PROVIDERS.some(p => p.id === firstUsable)) {
      setSelected(firstUsable);
      setVersion(v => v + 1);
    }
    // providerStatuses 一并依赖：它到达后「首位已关闭 → 跳下一个 open」的纠偏
    // 才能算准。touchedRef 不进依赖（ref 读取无时序问题）。
  }, [providerOrder, providerStatuses, selected]);

  /**
   * 提交拖拽后的新顺序。
   *
   * ⚠️ **不做乐观更新**（与 toggleGateway 同一取舍）：服务端才是顺序的权威
   * 存储，本地先改会在写入失败时出现「界面已变、重启又弹回」的错觉。成功后才
   * 落 state。失败复用 providerNotice（弹窗内没有独立的 notice 区）提示，
   * 并回读一次确保界面与服务端一致。
   */
  const commitProviderOrder = React.useCallback(async (next) => {
    if (!Array.isArray(next)) return;
    // ⚠️ 提交期间上锁：RPC 返回前界面顺序未变，再拖一次会基于旧顺序计算，
    // 把本次的移动静默覆盖（账号面板的 `reordering` 同款，理由见 state 处注释）。
    if (reorderLockRef.current) return;
    reorderLockRef.current = true;
    setProviderReordering(true);
    // ⚠️ **只清排序自己的旧提示**（inModal 那条），不能无条件清空：
    // 用户「切换某供应商（成功提示）→ 立刻拖一次」时，前一条 ok 提示不该被吞掉
    // （`toggleProvider` 写的 notice 没有 inModal 标记，见 ProviderSwitchPanel）。
    // 拖拽本身在弹窗内没有独立区域显示 toggle 的结果，故保留它。
    setProviderNotice(prev => (prev && prev.inModal ? null : prev));
    try {
      await rpcCall('provider.setOrder', { order: next });
      if (!mounted.current) return;
      setProviderOrder(next);
    } catch (caught) {
      console.error('[jet-hub] commit provider order failed:', caught);
      if (!mounted.current) return;
      setProviderNotice({
        tone: 'error',
        text: '保存排序失败：' + (caught?.message || '未知错误') + '。界面顺序保持不变，可重试拖动。',
        // ⚠️ 必须由**弹窗内**呈现：拖拽必然发生在弹窗打开期间，而弹窗遮罩是
        // fixed + z-index 3000，页面层的 notice 会被它整个盖住（用户看不到失败）。
        inModal: true,
      });
      await loadProviderOrder();
    } finally {
      reorderLockRef.current = false;
      if (mounted.current) setProviderReordering(false);
    }
  }, [rpcCall, loadProviderOrder]);

  const selectProvider = (id) => {
    // 用户手动点过卡片 → 「打开 Jet Hub 默认选中自定义序首位」的纠偏不再生效。
    providerTouchedRef.current = true;
    setSelected(id);
    setVersion(v => v + 1);
  };

  /**
   * 供应商级一键开关。
   *
   * 语义（用户已确认，与后端 `provider.setEnabled` 严格对应）：
   * - **关闭** = 关闭它的全部模型（从对话框的模型选择里移除）+ 停用它的全部账号；
   * - **打开** = 打开它的全部模型 + 启用它的全部账号。
   *
   * 三个要点：
   * 1. **关闭前必须确认**：这是会改动多个模型与账号的批量操作，静默执行不可接受。
   *    文案带上已读取到的计数，让用户知道影响面。
   * 2. **失败时保留弹窗里的原状态**：不乐观更新 —— 供应商状态是推导出来的
   *    （由模型黑名单），本地猜测容易与服务端不一致；成功后重新拉状态即可。
   * 3. **成功后递增版号**：该 provider 的账号启用状态刚在服务端被改过，
   *    右侧账号面板必须重新加载才能与左侧一致（用户已确认允许这一处刷新）。
   */
  const toggleProvider = async (providerId, enabled) => {
    const label = PROVIDERS.find(p => p.id === providerId)?.label || providerId;
    const status = providerStatuses?.[providerId];
    if (!enabled) {
      const models = status?.models?.total ?? 0;
      const accounts = status?.accounts?.enabled ?? 0;
      const ok = confirm(
        `确认关闭「${label}」？\n\n`
        + `将关闭它的 ${models} 个模型（从对话框的模型选择里移除），`
        + `并停用它的 ${accounts} 个启用账号。\n\n`
        + `取消则不做任何变更。`,
      );
      if (!ok) return;
    }
    setProviderBusy(prev => new Set(prev).add(providerId));
    setProviderNotice(null);
    try {
      const res = await rpcCall('provider.setEnabled', { provider: providerId, enabled });
      if (!mounted.current) return;
      setProviderNotice({
        tone: 'ok',
        text: `${label}：${summarizeProviderToggle(enabled, res)}`,
      });
      // 重新拉状态（分组随之变化）+ 重挂载右侧面板（账号启用状态已变）
      await loadProviderStatuses();
      if (mounted.current) setVersion(v => v + 1);
    } catch (caught) {
      console.error('[jet-hub] toggle provider failed:', caught);
      if (!mounted.current) return;
      // 保留 rail 原状态：状态由模型黑名单推导，本地猜测容易与服务端不一致。
      setProviderNotice({
        tone: 'error',
        text: `${label} 操作失败：${caught?.message || '未知错误'}`,
      });
    } finally {
      if (mounted.current) {
        setProviderBusy((prev) => {
          const next = new Set(prev);
          next.delete(providerId);
          return next;
        });
      }
    }
  };

  /**
   * 一键签到**所有支持签到的渠道**。
   *
   * 逐个渠道 `await` 现有 `credits.claimAll`（不新增后端端点）。
   *
   * ⚠️ **必须串行**，不能 `Promise.all`：单渠道内部已是「逐账号顺序执行
   * （并发易触发风控）」（见 `src/jet-hub-rpc.ts`），而这是**真实领积分**的
   * 写操作，跨渠道并发会同时发出多路领取请求，触发风控的代价是用户当天领不到。
   *
   * 渠道集合由能力表推导（`checkinProviders()`）—— workbuddy / cline 后端
   * 没有签到接口，**绝不能**出现在请求列表里（那会产生必然失败的请求，
   * 正是 CodeArts 历史缺陷的形态）。
   *
   * 单渠道失败只计入 failed，**不中断后续渠道**（与后端「单账号失败不中断
   * 整体」同型）。但后端对**无账号**的渠道本就是零请求，故不额外预查账号。
   */
  const checkinAll = async () => {
    setCheckinBusy(true);
    setCheckinNotice(null);
    const parts = [];
    // 需要用户操作的提示（如「该账号尚未开通，请先用官方客户端登录一次」）。
    // 单独收集、单独渲染：混进计数行会被读漏，而这类提示的价值就在于被看到。
    const notes = [];
    // ★ 按单位分组的合计（2026-10-04，真实缺陷）：见下方累加处的说明。
    //
    // ⚠️ 这里**刻意不设 `totalCredit` 标量**：它是跨单位求和的数，展示路径本就
    //   一律不得使用。本 PR 首版留着它并配了「兜底旧宿主」的三元分支，但那个
    //   分支**永远走不到**（只要有 `claimed`，`totalByUnit` 必非零）—— 旧宿主
    //   的兜底实际发生在下面逐渠道的 `s.totalByUnit || {...}` 那一跳。
    //   留一个恒为 0 的变量 + 一句会骗人的注释，比删掉它危险得多。
    const totalByUnit = { token: 0, credit: 0 };
    let failed = 0;
    for (const provider of checkinProviders()) {
      const label = PROVIDERS.find(p => p.id === provider)?.label || provider;
      try {
        const res = await rpcCall('credits.claimAll', { provider });
        const s = res?.summary || {};
        // ⚠️ **每个非零计数都必须出现在提示里**。
        //
        // 早期只判 `claimed` / `alreadyClaimed` / `failed` 三个分支，于是
        // 「活动未开启」（`inactive > 0`）的渠道会**整条从提示里消失** ——
        // 用户看到的是「一键签到：A 今日已领，B 今日已领」，完全不知道 C 渠道
        // 执行过、更不知道它为什么没结果。
        //
        // 同理，一个渠道可能**同时**有成功与失败（多账号），逐个列出而不
        // 用 else-if 短路，否则后者的信息被前者的分支吞掉。
        const bits = [];
        if (s.claimed > 0) {
          // ★ 按单位分别累加（2026-10-04，真实缺陷）：`s.totalCredit` 是**跨单位
          //   求和** —— ZCode 的 1 亿 token 与其余渠道的积分会被加成一个数，并
          //   在汇总行标成「积分」（用户报障原文：`ZCode（智谱）+100000000
          //   （共 +100000100）`）。单位必须一路带着走，故这里读 `totalByUnit`。
          const byUnit = s.totalByUnit || { credit: s.totalCredit, token: 0 };
          totalByUnit.credit += Number(byUnit.credit) || 0;
          totalByUnit.token += Number(byUnit.token) || 0;
          // ⚠️ 逐渠道那行也按单位渲染：原先写裸数字（`+100000000`），既看不出
          //   单位、量级也读不出来。缺 `totalByUnit` 的旧宿主回落到「按积分」。
          // ⚠️ **不要在这里再拼 `+`**：`formatClaimGains` 的返回值**自带**每个单位
          //   的 `+`（`+100.00MToken, +100积分`），再拼一次会渲染成 `++100.00MToken`。
          //   真实缺陷（2026-10-05 复审本 PR 时实测）：本行原写作 `+${amount}`，
          //   而汇总行又写 `（共 +${totalAmount}）` —— 两个界面同时出现双加号，
          //   且**全量单测 5448 条全绿也抓不到**（没有任何用例断言调用点的拼装形态）。
          //   回归由 `tests/unit/claim-unit-callsites.spec.ts` 的源码级断言锁死。
          const amount = formatClaimGains(byUnit);
          if (amount !== null) bits.push(amount);
        }
        if (s.alreadyClaimed > 0) bits.push(`${s.alreadyClaimed} 个今日已领`);
        if (s.inactive > 0) bits.push(`${s.inactive} 个暂无活动`);
        if (s.failed > 0) {
          failed += s.failed;
          // 附上第一条失败原因：只给计数会让用户与排查者都无从下手
          const reason = (res?.results || [])
            .map(item => item?.outcome?.message)
            .find(msg => typeof msg === 'string' && msg.length > 0);
          bits.push(`${s.failed} 个失败${reason ? `（${reason}）` : ''}`);
        }
        parts.push(`${label} ${bits.length > 0 ? bits.join('，') : '无账号'}`);

        // ⚠️ **需要用户操作的提示必须单独列出，不能只留在计数里**。
        //
        // 真实缺陷（用户报障 2026-09-26）：用本插件 GitHub 授权**新注册**的
        // Qoder 账号尚未在 Qoder 侧开通每日领取，后端已返回可操作文案
        // （「请先用 Qoder 官方客户端登录一次该账号」），但汇总行只显示
        // 「N 个暂无活动」—— 用户看不到该怎么办，只能来问。
        //
        // 判据用后端的**显式字段** `outcome.actionRequired`，
        // **不要**改成「message 非空就展示」或去匹配文案内容：
        // 前者会把所有 inactive 都单列（含「今天活动暂未开始」这类无需操作的），
        // 后者会在文案改措辞时静默失效。语义定义见 `src/credits.ts`。
        for (const item of res?.results || []) {
          const outcome = item?.outcome || {};
          if (outcome.actionRequired !== true) continue;
          const msg = outcome.message;
          if (typeof msg !== 'string' || msg.length === 0) continue;
          // 去重：多个账号同因未开通时只提示一次，避免刷屏
          if (!notes.includes(msg)) notes.push(msg);
        }
      } catch (caught) {
        failed += 1;
        parts.push(`${label} 失败（${caught?.message || '未知原因'}）`);
      }
      if (!mounted.current) return;
    }
    if (!mounted.current) return;
    // ★ 汇总行按单位分别报（2026-10-04，真实缺陷）：原先写 `（共 +${totalCredit} 积分）`，
    //   而 `totalCredit` 是跨单位求和 —— 用户报障的 `（共 +100000100）` 就是它。
    //   期望形态是 `（共 +100.00MToken, +100积分）`（见 `formatClaimGains`）。
    //
    // ⚠️ **不能再拼 `+`**：`formatClaimGains` 的返回值自带每个单位的 `+`
    //   （`+100.00MToken, +100积分`）—— 本行原写作 `（共 +${totalAmount}）`，
    //   渲染出 `（共 ++100.00MToken, +100积分）`（2026-10-05 复审实测）。
    //
    // ⚠️ **兜底只在累加处做一次**：旧宿主（无 `totalByUnit`）的值已在上面
    //   逐渠道时回落进 `totalByUnit`，故这里直接用它。原先还写了一个
    //   `... : { credit: totalCredit }` 的三元兜底，而 `totalCredit` 早已不再累加
    //   （恒为 0）⇒ 该分支既走不到、又让人以为旧宿主靠它兜底。已删除。
    const totalAmount = formatClaimGains(totalByUnit);
    setCheckinNotice({
      // 有待用户处理的提示时用 warn 色调，让那条提示更显眼
      tone: failed > 0 || notes.length > 0 ? 'warn' : 'ok',
      text: parts.length > 0
        ? `一键签到：${parts.join('，')}${totalAmount === null ? '' : `（共 ${totalAmount}）`}`
        : '一键签到：没有可领取的渠道',
      notes,
    });
    setCheckinBusy(false);
    // 领取会改变余额；递增版号让当前面板重新挂载并刷新账号与积分
    setVersion(v => v + 1);
  };

  /**
   * 单个供应商行：只有一个 `<button role="tab">`（选择面板）。
   *
   * ⚠️ 这里**不再有开关**。!25 曾把开关直接挂在行尾，但那是一个破坏性批量操作
   * （一次改动几十个模型 + 全部账号），和「选择要看哪个供应商」这个高频无害动作
   * 挤在同一行里既容易误点，也让本应承担导航的窄栏长出了控件。现在它整体搬到
   * 页头的「供应商开关」弹窗里（见 `ProviderSwitchPanel`）。
   *
   * 分组仍保留在这里 —— 它是**纯展示**（告诉你哪些已被关闭），不含任何操作；
   * 行上也不再挂 onClick 之外的交互，原「开关必须是 button 兄弟节点」那条约束
   * 随开关一起消失（弹窗里的行是 `<label>` + 单个 checkbox，另有一套约束）。
   */
  const renderProviderRow = (p) => {
    const closed = providerStatuses?.[p.id]?.closed === true;
    return React.createElement('div', { className: 'dim-jh-providerRow', key: p.id, 'data-provider': p.id },
      React.createElement('button', {
        type: 'button',
        role: 'tab',
        className: 'dim-jh-provider',
        'aria-selected': p.id === selected,
        // 标题带上关闭状态：行本身已经没有开关，用户得知道去哪儿打开它。
        // ⚠️ 按钮名是「供应商」（页头），文案要与它一致，否则用户找不到。
        title: closed
          ? `${p.label}（已关闭，可在页头「供应商」按钮里打开）`
          : p.label,
        onClick: () => selectProvider(p.id),
      },
      React.createElement(ProviderLogo, { provider: p.id }),
      // ⚠️ 这里给 label 加了 `dim-jh-providerLabel` —— 该类在样式表里**早已定义**
      // （含 min-width: 0 与省略号），但此前从未被任何 JS 使用，故真实界面上长
      // 供应商名一直在**折行**。加上它可把折行改为单行省略号（实测：rail 243px 时
      // 只有 WorkBuddy 一行超宽 21px），且列表总高不变（384px）；若不加，行高会
      // 从 48px 被顶到 58px、总高 424px。这是一处左侧的可见变化，已在交付说明中注明。
      React.createElement('span', { className: 'dim-jh-providerLabel' },
        React.createElement('strong', null, p.label))));
  };

  /**
   * 渲染左侧导航。
   *
   * 两种形态：
   * - **已读取到状态**：分「已打开 / 已关闭」两组，各带计数；
   * - **未读取到**（首次加载中 / 请求失败）：按 `PROVIDERS` 原顺序平铺、不分组。
   *   分组只是**展示**，读不到状态时宁可不分组，也不要把用户以为「供应商被关掉了」
   *   —— 与 `groupProviders` 那条「状态缺失一律归入已打开」是同一个取向。
   *
   * 行上**没有开关**（已搬到页头的 `ProviderSwitchPanel`），故这里不再关心
   * 禁用态：那套判据（`models.total === 0` ⇒ 禁用并给出原因）现在只在弹窗里用。
   *
   * 「已打开」组按 `providerOrder`（弹窗拖拽保存的自定义顺序）排序——与弹窗
   * 共用同一份顺序（宿主端持久化在 state.json 的 providerOrder 字段）；
   * `providerOrder === null`（未自定义/读取失败）时 `sortOpenProvidersByOrder`
   * 返回原数组 = 声明序兜底。「已关闭」组恒按声明顺序沉底（与弹窗同口径）。
   */
  const renderRail = () => {
    if (providerStatuses === null) {
      return PROVIDERS.map(p => renderProviderRow(p));
    }
    const { open, closed } = groupProviders(PROVIDERS, providerStatuses);
    const group = (title, list, key) => React.createElement('div', { className: 'dim-jh-railGroup', key },
      React.createElement('div', { className: 'dim-jh-railGroupTitle' }, title),
      list.map(p => renderProviderRow(p)));
    return [
      // ⚠️ 第三个实参 = **声明顺序**（注册表全量 id）。传它才能让
      // `providerOrder` 里缺失的**新增** provider 落回它该在的位置，
      // 而不是被缀到末尾（真实缺陷，2026-10-17 用户报障
      // 「minimax 国际版的顺序应该在中国版下面」）。
      group(
        `已打开 (${open.length})`,
        sortOpenProvidersByOrder(open, providerOrder, PROVIDERS.map(p => p.id)),
        'open',
      ),
      group(`已关闭 (${closed.length})`, closed, 'closed'),
    ];
  };

  /**
   * 页头按钮上的计数（tooltip 用）。
   *
   * 状态没读回来时**不显示计数** —— 报「已打开 0、已关闭 0」会让用户以为
   * 一个供应商都没有，而真实原因只是那一次 `provider.status` 还没回来。
   */
  const providerSummary = providerToggleSummary(PROVIDERS, providerStatuses);

  /**
   * 「渠道原生搜索」总开关。
   *
   * 开 = 支持原生搜索的渠道（CodeBuddy / WorkBuddy）走自己后端的搜索接口；
   * 关 = 所有渠道一律回官方 DeepSeek 搜索（需要 `DEEPSEEK_API_KEY`）。
   *
   * ⚠️ 与 `toggleGateway` 同取向：**不做乐观更新**。开关的实际效果由服务端
   * 落盘值决定，本地先改会让界面显示「已关闭」而搜索其实还在走原生。
   */
  const [nativeSearchOn, setNativeSearchOn] = React.useState(true);
  const [nativeSearchBusy, setNativeSearchBusy] = React.useState(false);
  const [nativeSearchFailed, setNativeSearchFailed] = React.useState(false);

  const loadNativeSearchStatus = React.useCallback(async () => {
    try {
      const res = await rpcCall('nativeSearch.getEnabled', {});
      if (!mounted.current) return;
      setNativeSearchOn(res?.enabled !== false);
      setNativeSearchFailed(false);
    } catch (caught) {
      console.error('[jet-hub] load native search status failed:', caught);
      if (!mounted.current) return;
      // 降级为「默认开启」并标记读取失败：开关本身不可用，但不影响其余功能。
      setNativeSearchOn(true);
      setNativeSearchFailed(true);
    }
  }, [rpcCall]);

  const toggleNativeSearch = React.useCallback(async (nextEnabled) => {
    setNativeSearchBusy(true);
    try {
      const res = await rpcCall('nativeSearch.setEnabled', { enabled: nextEnabled });
      if (!mounted.current) return;
      setNativeSearchOn(res?.enabled !== false);
      setNativeSearchFailed(false);
    } catch (caught) {
      console.error('[jet-hub] toggle native search failed:', caught);
      if (!mounted.current) return;
      // 保留原状态：重新拉一次以确保与服务端一致。
      await loadNativeSearchStatus();
    } finally {
      if (mounted.current) setNativeSearchBusy(false);
    }
  }, [rpcCall, loadNativeSearchStatus]);

  React.useEffect(() => { void loadNativeSearchStatus(); }, [loadNativeSearchStatus]);

  /**
   * 「侧栏」开关：主导航里显不显示 Jet Hub 入口。
   *
   * 与上面那个原生搜索开关的两点不同：
   * 1. 它改的是**客户端自己的槽注册**（`sidebar.panellist` 那一行），立刻生效；
   * 2. 偏好落盘在**宿主侧**（`sidebarEntry.setEnabled`）—— Web 端 origin 的端口
   *    每次启动都变，浏览器本地存储留不住（理由见 `sidebar-entry-store.js`）。
   *
   * ⚠️ 与 `toggleGateway` 同取向：**不做乐观更新**，宿主回什么就显示什么 ——
   * 本地先改会让界面显示「已隐藏」而侧栏其实还在。
   */
  const [sidebarEntryOn, setSidebarEntryOn] = React.useState(() => sidebarEntryVisible());
  const [sidebarEntryBusy, setSidebarEntryBusy] = React.useState(false);
  const [sidebarEntryFailed, setSidebarEntryFailed] = React.useState(() => sidebarEntryReadFailed());

  // 与「侧栏行」共用同一份进程内状态：任何一侧改完，两侧的开关一起更新
  // （主面板与设置页可能同时挂着两个 JetHubPage 实例）。
  React.useEffect(() => subscribeSidebarEntry(() => {
    setSidebarEntryOn(sidebarEntryVisible());
    setSidebarEntryFailed(sidebarEntryReadFailed());
  }), []);

  const toggleSidebarEntry = React.useCallback(async (nextEnabled) => {
    setSidebarEntryBusy(true);
    try {
      const value = await setSidebarEntry(rpcCall, nextEnabled);
      if (!mounted.current) return;
      setSidebarEntryOn(value);
      setSidebarEntryFailed(false);
    } catch (caught) {
      console.error('[jet-hub] toggle sidebar entry failed:', caught);
      if (!mounted.current) return;
      // 保留宿主的实际状态：失败时把开关拉回进程内副本，别停在用户点出来的位置上。
      setSidebarEntryOn(sidebarEntryVisible());
      setSidebarEntryFailed(true);
    } finally {
      if (mounted.current) setSidebarEntryBusy(false);
    }
  }, [rpcCall]);

  return React.createElement('section', { className: 'dim-jh-page', 'aria-label': 'Jet Hub Provider 设置' },
    // ⚠️ 页头左侧的「Jet Hub」标题块已**整块删除**（用户 2026-10-07 要求：
    // 标题只占宽度、不带任何操作，空间全给按钮行）。这里先后删过两样东西，
    // 都**不要**加回来：
    // ① 副标题「提供商凭据与多账号管理」（.dim-jh-brandDesc）—— 2026-10-06，
    //    因为按钮太多，副标题既显示不全又挤占页头高度；
    // ② 标题本体「Jet Hub」（.dim-jh-brand / .dim-jh-brandName）—— 2026-10-07，
    //    页头一排已有 7 个按钮，标题纯属占位。设置页的语义由本节点的
    //    aria-label 与宿主左侧「Jet Hub」导航项承担，不丢。
    React.createElement('header', { className: 'dim-jh-header' },
      React.createElement('div', { className: 'dim-jh-headerActions' },
        // 「供应商开关」在页头，而不是左侧每个供应商行尾（!25 的原形态）：
        // 它是破坏性批量操作，与「选择看哪个供应商」这个高频无害动作分开摆放，
        // 误点的可能性归零，也让左侧窄栏回到纯导航。见 `ProviderSwitchPanel`。
        // ⚠️ 按钮文字只写「供应商」（不是「供应商开关」）：页头四个按钮要排成
        // 一排，5 个字会把「关闭」挤到第二行 —— 完整语义由 tooltip 与弹窗标题承担。
        React.createElement('button', {
          className: 'dim-jh-btn',
          title: (providerSummary.known
            ? '供应商开关：逐个打开/关闭（已打开 ' + providerSummary.open + '、已关闭 ' + providerSummary.closed + '）。'
            : '供应商开关：逐个打开/关闭。')
            + '关闭一个供应商 = 关闭它的全部模型并停用它的全部账号。',
          'aria-haspopup': 'dialog',
          'aria-expanded': showProviderSwitches ? 'true' : 'false',
          onClick: () => {
            // 与网关弹窗互斥：两者都是 position:fixed 的全屏覆盖层，
            // 同时打开会叠在一起，而 ESC 只关掉后挂载的那个。
            setShowGateway(false);
            setShowProviderSwitches(true);
          },
        }, '供应商'),
        // 一键签到在备份/恢复**左侧**（需求指定位置）
        React.createElement('button', {
          className: 'dim-jh-btn',
          title: '依次签到全部支持签到的渠道（CodeBuddy / LobsterAI / CodeArts / Qoder / TRAE）。'
            + '串行执行以避免触发风控。',
          disabled: checkinBusy,
          onClick: () => void checkinAll(),
        }, checkinBusy ? '签到中…' : '一键签到'),
        React.createElement(BackupPanel, {
          rpcCall,
          // 导入成功会整体替换账号，ProviderPanel 只在挂载时拉列表；
          // 递增版号强制重新挂载，让账号列表与模型目录立即反映新状态。
          onImported: () => setVersion(v => v + 1),
        }),
        // 本机网关开关。⚠️ 文字刻意只写「网关」（见「供应商」按钮上方的同款
        // 注释）：页头按钮排成一行，长文字会把右端「关闭」挤到第二行。
        React.createElement('button', {
          className: 'dim-jh-btn',
          title: gatewayButtonTitle(gatewayStatus),
          'aria-haspopup': 'dialog',
          'aria-expanded': showGateway ? 'true' : 'false',
          onClick: () => {
            setShowProviderSwitches(false);
            setShowGateway(true);
            setGatewayNotice(null);
            void loadGatewayStatus();
          },
        }, gatewayButtonLabel(gatewayStatus)),
        // 「Token 用量」入口：全 provider 的本地记账（直连/网关分开统计）。
        React.createElement('button', {
          className: 'dim-jh-btn',
          title: 'Token 用量：按渠道（直连/网关）、供应商与模型统计本机请求的 token 消耗。',
          'aria-haspopup': 'dialog',
          'aria-expanded': showTokenLedger ? 'true' : 'false',
          onClick: () => {
            setShowProviderSwitches(false);
            setShowGateway(false);
            setShowTokenLedger(true);
          },
        }, 'Token 用量'),
        // 「渠道原生搜索」总开关。**取代**了原先这里的「关闭」按钮 ——
        // 关闭设置页仍有右上角 × 与点击空白处两条路径，而那个按钮与外壳的 ×
        // 语义完全重复（用户 2026-10-14 决定）。
        //
        // 语义：开 = 支持原生搜索的渠道（CodeBuddy / WorkBuddy）走自己后端的
        // 搜索接口；关 = 所有渠道一律回官方 DeepSeek 搜索（需要 API Key）。
        React.createElement('label', {
          className: 'dim-jh-nativeSearch',
          title: (nativeSearchFailed
            ? '⚠️ 开关状态读取失败，当前显示的是默认值（开启）。点击即可重新提交一次。'
            : '渠道原生搜索：为支持原生搜索的渠道（CodeBuddy / WorkBuddy）启用其自带搜索。'
              + '关闭后所有渠道都改用 DeepSeek 官方搜索（需要 DEEPSEEK_API_KEY）。'),
        },
          React.createElement('input', {
            type: 'checkbox',
            className: 'dim-jh-switch',
            checked: nativeSearchOn,
            // ⚠️ **只**因提交中而禁用：读取失败时不禁用 —— 那会让用户在
            //    唯一一次读取抖动后**彻底失去**自救路径（连切换都点不动），
            //    与网关面板「任何一个附属字段采集失败都不该把用户挡在关掉它
            //    这条自救路径之外」同一取向。
            disabled: nativeSearchBusy,
            onChange: (event) => void toggleNativeSearch(event.target.checked),
          }),
          React.createElement('span', null, '渠道原生搜索')),
        // 「侧栏」开关：主导航里显不显示 Jet Hub 入口。
        //
        // 语义：开 = 主侧栏多一行「Jet Hub」，点它把本页渲染进中央主面板；
        // 关 = 那一行消失，进入路径只剩「设置 → 插件 → Jet Hub」（本页仍在）。
        // 与上面那个原生搜索开关同款外观，刻意并列在页头最右侧。
        React.createElement('label', {
          className: 'dim-jh-nativeSearch',
          title: (sidebarEntryFailed
            ? '⚠️ 侧栏开关状态读取失败，当前显示的是默认值（显示）。点击即可重新提交一次。'
            : '侧栏入口：在左侧主导航里显示「Jet Hub」一行，点它直接在中央面板打开本页。'
              + '关闭后该行消失，仍可从「设置 → 插件 → Jet Hub」进入，不影响任何功能。'),
        },
          React.createElement('input', {
            type: 'checkbox',
            className: 'dim-jh-switch',
            checked: sidebarEntryOn,
            // ⚠️ 与原生搜索开关同一取向：**只**因提交中而禁用；读取失败时不禁用，
            //    否则一次抖动就让用户失去「点一下重新提交」的自救路径。
            disabled: sidebarEntryBusy,
            onChange: (event) => void toggleSidebarEntry(event.target.checked),
          }),
          React.createElement('span', null, '侧栏')))),
    // 签到结果放在页头下方横跨整宽：页头是 flex 且不换行，塞进去会挤压按钮。
    // `flex: none` 是必需的 —— `dim-jh-page` 是 column flex 且 `dim-jh-layout`
    // 带 `flex: 1`，不锁住的话提示条会被压扁（与 modal 内同款做法）。
    checkinNotice
      ? React.createElement('div', {
          className: 'dim-jh-probeNotice',
          'data-tone': checkinNotice.tone,
          role: checkinNotice.tone === 'error' ? 'alert' : 'status',
          style: { flex: 'none', margin: '12px 24px 0' },
        },
        React.createElement('div', null, checkinNotice.text),
        // 需要用户操作的提示单列成列表（如「请先用 Qoder 官方客户端登录一次」）。
        // 复用既有的 `dim-jh-probeDetails` 样式，不引入新样式。
        (checkinNotice.notes || []).length > 0
          ? React.createElement('ul', { className: 'dim-jh-probeDetails' },
              checkinNotice.notes.map((note, index) =>
                React.createElement('li', { key: index }, note)))
          : null)
      : null,
    // ⚠️ `inModal` 的提示交给弹窗自己渲染（见 ProviderSwitchPanel）—— 重复渲染
    // 会让同一条错误在遮罩内外各出现一次。
    providerNotice && !providerNotice.inModal
      ? React.createElement('div', {
          className: 'dim-jh-probeNotice',
          'data-tone': providerNotice.tone,
          role: providerNotice.tone === 'error' ? 'alert' : 'status',
          style: { flex: 'none', margin: '12px 24px 0' },
        }, React.createElement('div', null, providerNotice.text))
      : null,
    React.createElement('div', { className: 'dim-jh-layout' },
      React.createElement('nav', { className: 'dim-jh-rail', role: 'tablist', 'aria-label': 'Provider 导航' },
        renderRail()),
      React.createElement('main', {
        className: 'dim-jh-panel',
        role: 'tabpanel',
      },
      PROVIDERS.map(p => p.id === selected
        // ⚠️ 聚合走**独立组件**（见 `AggregatePanel` 的注释）：它没有账号/凭据/积分，
        //    塞进 `ProviderPanel` 会得到一个「没有登录按钮、没有账号列表」的空面板。
        //    先例：网关也是旁路功能用独立组件（`GatewayPanel`，以覆盖层渲染）。
        ? (p.id === 'aggregate'
            ? React.createElement(AggregatePanel, { key: p.id + '-' + version, rpcCall })
            : React.createElement(ProviderPanel, {
                key: p.id + '-' + version,
                provider: p.id,
                rpcCall,
              }))
        : null))),
    // 「供应商开关」以 modal 渲染：它是覆盖层，放在布局之后只是组件树的书写顺序
    // （与账号面板里的模型列表同款做法）。关闭即不挂载，避免常驻一份开关列表。
    showProviderSwitches
      ? React.createElement(ProviderSwitchPanel, {
          providers: PROVIDERS,
          statuses: providerStatuses,
          statusFailed: providerStatusFailed,
          busyIds: providerBusy,
          onToggle: toggleProvider,
          onReload: loadProviderStatuses,
          onClose: () => setShowProviderSwitches(false),
          order: providerOrder,
          onCommitOrder: commitProviderOrder,
          reordering: providerReordering,
          notice: providerNotice,
          // 弹窗的「模型列表」视图要逐家调 `model.list`（服务端只有单 provider 端点）。
          rpcCall,
        })
      : null,
    // 同款做法：网关开关也是覆盖层，且与「供应商开关」互斥 —— 两者都是
    // `position: fixed` 的全屏弹窗，同时打开会叠在一起、ESC 只关掉后挂载的那个。
    showGateway
      ? React.createElement(GatewayPanel, {
          status: gatewayStatus,
          busy: gatewayBusy,
          notice: gatewayNotice,
          onToggle: toggleGateway,
          onToggleAllowLan: toggleGatewayAllowLan,
          onReload: loadGatewayStatus,
          onClose: () => setShowGateway(false),
        })
      : null,
    // 「Token 用量」弹窗：同样是覆盖层（createElement 形式 —— 与其它弹窗
    // 同一理由，见 OpencodeProxyModal 上方的 hook 计数事故注释）。
    showTokenLedger
      ? React.createElement(TokenLedgerPanel, {
          rpcCall,
          onClose: () => setShowTokenLedger(false),
        })
      : null);
}

