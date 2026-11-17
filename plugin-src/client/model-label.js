/**
 * 模型选择器每一行的名字与徽标（`conversation.input.model.label`）。
 *
 * ## 为什么本插件要占这个槽位（方案 A，用户 2026-11-17 选定）
 *
 * 上游活动的**短标签**走宿主数据面（`LlmModelInfo.badge`）已经能画出来，但那句
 * 活动说明 + 有效期 + 每日时段在宿主契约里**没有格子可放**：0.2.2-rc.3 的 badge
 * 只有 `{ text, tone }`（实测 dsh-llm 的 listModels 白名单只写这两格，`hover` /
 * `tooltip` / `title` 在该文件里各 0 次命中），而宿主自己的回落渲染
 * `jsx(Tag, { tone, children: resolveText(text) })` **不带 title**。
 * ⇒ 症状是「界面上只有一枚『限时免费』，用户不知道它哪天过期」。
 *
 * 宿主文档给的唯一出口就是本槽位：「A contribution replaces both and receives
 * the badge in its owner props」。占位者自己画名字 + 徽标 + 悬停，长文案才有落点。
 *
 * ## ⚠️⚠️ 本槽位是 `single`（宿主声明实测于 app.asar：kind 'single'、scope 'session'）
 *
 * 一个格子只有一个赢家，而赢家要替**所有** provider 画行 —— 不是只画自己家的。
 * 所以本组件必须两条腿都在：
 *
 * 1. 本插件有候选的渠道 ⇒ 按**此刻**挑一枚、画 chip + 悬停（长文案）；
 * 2. 其余每一行 ⇒ 画 `model.name` + **该模型自己的** `model.badge`（宿主目录字段,
 *    由发布它的那个适配器填，本组件不认识也不必认识它是谁）。
 *
 * 腿 2 不是礼貌：宿主只在格子**没有占位者**时才跑它自己的徽标回落。占住格子却
 * 只画裸名字，兄弟插件的徽标会**在界面上彻底消失**（dsh-connect-workbuddy 的
 * issue #138 就是这个形状，只是方向相反）。读的是宿主给的 props.model.badge,
 * 不读槽位账本、不渲染别人的组件、输出与装了谁无关 —— 与插件间协调无关。
 *
 * ## ⚠️ 时钟每次渲染都重读，取数完成后必须让行重渲染
 *
 * 徽标是墙钟的函数（夜间窗口会开关、活动会到期）。在取数时挑定并持有 = 白天还
 * 挂着「夜间折扣」，正是 issue #101 要修的形态。⇒ 候选表取一次、缓存 60 秒,
 * **挑哪一枚**每次渲染现算。
 *
 * 另一条同样致命：**取数完成不会自己触发重渲染**。槽位在 `conversation.input.model`
 * 挂载时注册，那一刻 RPC 还没回来；若没有「快照更新 ⇒ 通知所有已挂载行」这条,
 * 首屏永远画不出徽标，直到下一次心跳（60 秒）—— 用户看到的就是「装完插件没变化」。
 * 共享 ticker 只负责跨过窗口边界，不负责首次落地。
 *
 * ## 判定实现**不在本文件重写**
 *
 * 挑哪一枚、说什么话、什么颜色，全部 import `src/model-promotions.js` 与
 * `src/promotion-tooltip.js` —— 与宿主侧 `toCatalogEntry` 同一条实现。同一个
 * schema 写两套判据是本仓的复发缺陷形态（`build.mjs` 会把这两个模块内联进
 * 产物，实测产物里无残留 require）。
 */

import * as React from 'react';

import { selectPromotionAt } from '../../src/model-promotions.js';
import { promotionTooltip, promotionBadgeLabel, promotionChipColor, promotionReaderLanguage } from '../../src/promotion-tooltip.js';

/**
 * 注册优先级。
 *
 * ⚠️ **必须低于本机所有已装的兄弟插件**，否则本插件永远画不出来：
 * 宿主按 priority 升序取首个 live 条目（小者渲染）。实测本机 ——
 * dsh-connect-workbuddy 的 `MODEL_LABEL_PRIORITY = -105`、
 * dsh-connect-qoder 的注册 `priority: -1`。
 *
 * 取 -200 而不是 -106：留足余量给兄弟插件将来继续下调（它们下调一次就把我们
 * 顶回去，而我们上调要改这里）。同 priority 会**抛错**（`single slot … already
 * has a registration at priority N`），所以这个值也必须与它们**不相等**。
 */
export const MODEL_LABEL_PRIORITY = -200;

/** 候选表被信任多久（毫秒）。与参考实现的 usage 快照同量级。 */
const CANDIDATES_CACHE_MS = 60_000;

/** 已挂载的行重读时钟的间隔（毫秒）。一条共享定时器，不是每行一条。 */
const CLOCK_TICK_MS = 60_000;

/**
 * provider id → modelId → 该模型的未决候选。
 *
 * ⚠️ 缺席 = 「本插件没有这家的活动数据」，**不是**「这家没有活动」。两者对
 * 渲染的后果不同：前者要回落到宿主数据面（腿 2），后者什么都不画。
 * 判据只看「这张表里有没有这个 provider」，由服务端 `promotion.candidates`
 * 决定（实现了 `promotionCandidates()` 的家才出现在表里）。
 */
let candidatesSnapshot = null;
/** 上一次**成功**取数的时刻。 */
let candidatesAt = 0;
/** 单飞闸门：一次取数没结束就不再发第二次。 */
let candidatesInflight = null;
/**
 * 注册时绑定的取数出口。
 *
 * ⚠️ 取数**不依赖**宿主把 `register({ inject })` 的产物喂进组件 props：那条路
 * 对 `single` 槽是否生效无法从本机产物证实（宿主文档只在 keyed/chain 语境里写
 * 过 inject）。把出口存在模块级、由共享定时器驱动 ⇒ 组件 props 里有没有
 * `rpcCall` 都不影响数据新鲜度，少一个未验证的前提。
 */
let boundRpcCall = null;

/** 需要重渲染的已挂载行。 */
const listeners = new Set();
let tickTimer = null;

/**
 * 通知所有已挂载的行重渲染。
 *
 * ⚠️ 一行的异常不许带走整个菜单 ⇒ 逐个 try。
 */
function notify() {
  for (const fn of [...listeners]) {
    try { fn(); } catch { /* 单行渲染失败不影响其余行 */ }
  }
}

/**
 * 共享时钟定时器：至少每 60 秒让已挂载的行重渲染一次（跨过窗口边界那一分钟
 * 自己会变），并且**快照落地时立刻**叫醒一次。
 *
 * ⚠️ 必须是**一条**、按订阅者计数回收：一次菜单里可能同时挂着二十行,
 * 每行一条定时器会让长期开着的页面攒出一堆没人清的表。
 */
function subscribeTick(listener) {
  listeners.add(listener);
  if (tickTimer === null) {
    // 心跳做两件事：缓存过期就重新取数（loadCandidates 内部短路），
    // 以及**无论如何**都让已挂载的行重读时钟 —— 后者是窗口边界生效的路径。
    tickTimer = setInterval(() => {
      if (boundRpcCall !== null) void loadCandidates(boundRpcCall);
      notify();
    }, CLOCK_TICK_MS);
    // Node（单测环境）里也要能被回收；浏览器忽略这个调用。
    if (typeof tickTimer.unref === 'function') tickTimer.unref();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  };
}

/**
 * 取一次全部渠道的未决候选（缓存 + 单飞）。
 *
 * ⚠️ 失败 ⇒ 保留**上一次**的快照并照常返回，不写 `candidatesAt`（下次渲染会
 * 重试）。一次 RPC 抖动不该让界面上的徽标整片消失 —— 与宿主「刷新失败保留
 * 上一次显示选择」同取向。
 *
 * ⚠️ 成功后**必须 notify()**：没有这一步，首屏要等到下一次心跳才画得出徽标。
 */
async function loadCandidates(rpcCall) {
  if (candidatesSnapshot !== null && Date.now() - candidatesAt < CANDIDATES_CACHE_MS) {
    return candidatesSnapshot;
  }
  if (candidatesInflight !== null) return candidatesInflight;
  const run = async () => {
    try {
      const value = await rpcCall('promotion.candidates', {});
      const providers = value !== null && typeof value === 'object' ? value.providers : undefined;
      if (providers === null || typeof providers !== 'object') return candidatesSnapshot;
      candidatesSnapshot = providers;
      candidatesAt = Date.now();
      notify();
      return candidatesSnapshot;
    } catch {
      return candidatesSnapshot;
    }
  };
  candidatesInflight = run().finally(() => { candidatesInflight = null; });
  return candidatesInflight;
}

/** 单测与诊断用：清掉缓存，让下一次渲染重新取数。 */
export function resetModelLabelCandidates() {
  candidatesSnapshot = null;
  candidatesAt = 0;
  candidatesInflight = null;
}

/**
 * 宿主目录里那枚徽标的文本（`LlmModelInfo.badge.text`）→ 一句可读的话。
 *
 * ⚠️ 本地声明、不 import 宿主类型名：本包 peer 下界 `^0.1.2-rc.1` 里它还不存在。
 * `text` 可能是裸字符串，也可能是按语言小写键的表（宿主 LocalizedText）。
 *
 * ⚠️ 这一句**不许抛**：它跑在替所有 provider 画行的通路上，抛出会让整格装饰
 * 消失（参考实现为此把 `uiLanguage()` 收成恒返回字符串）。
 */
export function resolveHostBadgeText(text, languageOverride) {
  if (typeof text === 'string') return text;
  if (text === null || typeof text !== 'object') return undefined;
  // 语言可注入：渲染路径读 navigator，单测必须能钉住「读者是谁」,
  // 否则断言会随跑测试的机器 locale 翻脸（本仓踩过：断言写成中文文案,
  // 英文机器上整组变红 —— 那不是缺陷，是夹具没有把变量独立出来）。
  const language = (languageOverride ?? promotionReaderLanguage()).toLowerCase();
  const table = text;
  if (language !== '' && !language.startsWith('en')) {
    const native = table[language];
    if (typeof native === 'string' && native.length > 0) return native;
    const zh = table.zh;
    if (typeof zh === 'string' && zh.length > 0) return zh;
  }
  const en = table.en;
  if (typeof en === 'string' && en.length > 0) return en;
  return undefined;
}

/** 宿主四档语义色（与宿主 Tag 的 tone 同名同数）。 */
const HOST_TONES = Object.freeze(['neutral', 'info', 'success', 'warning']);

/** 单测与诊断用：判据本体（渲染分支与它共用一份，避免两处口径）。 */
export function hostBadgeToneOf(tone) {
  return HOST_TONES.indexOf(String(tone)) >= 0 ? String(tone) : 'neutral';
}

/**
 * 一行：名字 + 徽标（+ 悬停）。
 *
 * @param props.provider - 宿主给的 `{ id, name }`。
 * @param props.model - 宿主目录里的那一条（`id` / `name` / 可选 `badge`）。
 * @param props.rpcCall - 注册时 inject 进来的 Jet Hub RPC 通道。
 * @returns 一个**非交互**的行内片段：点击、焦点、勾选、档位仍归宿主。
 */
export function ModelLabel(props) {
  const provider = props.provider;
  const model = props.model;
  const rpcCall = props.rpcCall;
  const [, setTick] = React.useState(0);

  React.useEffect(() => subscribeTick(() => setTick((n) => n + 1)), []);
  // 快照缺席时自己补一次（注册时机早于 RPC 返回；也覆盖「兄弟插件先取过但失败」）。
  React.useEffect(() => {
    if (typeof rpcCall === 'function') void loadCandidates(rpcCall);
  }, [rpcCall]);

  const language = promotionReaderLanguage();
  const providerId = provider !== null && typeof provider === 'object' ? String(provider.id ?? '') : '';
  const modelId = model !== null && typeof model === 'object' ? model.id : undefined;

  // 腿 1：本插件有候选 ⇒ 按此刻挑一枚，画 chip + 长悬停。
  const rows = candidatesSnapshot !== null && typeof candidatesSnapshot === 'object'
    ? candidatesSnapshot[providerId]
    : undefined;
    const list = Array.isArray(rows)
    ? rows.filter((row) => row !== null && typeof row === 'object' && row.modelId === modelId)
    : [];
  /**
   * ⚠️ 判据打在**这一行有没有我们的数据**，不是「这家在不在表里」：
   * provider 级判据有一个真实的误伤面 —— 若某个路由的注册被幂等包装跳过
   * （撞名让给兄弟插件），目录里那枚 badge 是**它**按自己账号算的,
   * 而我们的候选表来自本插件自己的缓存 ⇒ 按 provider 压掉它 = 抹掉别人的徽标。
   * 按 model id 判：我们没这一行的候选 ⇒ 一律照画宿主给的 badge。
   */
  const weOwnThisRow = list.length > 0;
  const selected = selectPromotionAt(list.map((row) => row.promotion), Date.now());

  if (selected !== undefined) {
    const label = promotionBadgeLabel(selected, language);
    const tooltip = promotionTooltip(selected, language);
    const color = promotionChipColor(selected);
    return React.createElement('span', { className: 'dim-jh-modelLabel' },
      React.createElement('span', { className: 'dim-jh-modelLabelName' }, String(model.name ?? '')),
      React.createElement('span', {
        className: 'dim-jh-modelPromoChip',
        'data-tone': 'upstream',
        ...(tooltip.length > 0 ? { title: tooltip } : {}),
        ...(color === undefined ? {} : { style: { color, borderColor: color } }),
      }, label));
  }

  // 腿 2：**只有外来渠道**才画宿主目录里的那枚 badge（见上：自家渠道回落
  // 到缓存徽标会重新制造「活动过期而徽标还在」）。
  const badge = weOwnThisRow || model === null || typeof model !== 'object' ? undefined : model.badge;
  const hostText = badge === null || typeof badge !== 'object'
    ? undefined
    : resolveHostBadgeText(badge.text);
  if (hostText === undefined) return React.createElement('span', null, String(model.name ?? ''));
  return React.createElement('span', { className: 'dim-jh-modelLabel' }, ...orderBadgeParts(props.placement,
    React.createElement('span', { className: 'dim-jh-modelLabelName' }, String(model.name ?? '')),
    React.createElement('span', { className: 'dim-jh-modelPromoChip', 'data-tone': hostBadgeToneOf(badge.tone), title: hostText }, hostText)));
}

/**
 * 名字与徽标的**先后顺序**必须跟宿主走（PR #110 对抗审计 P1-1）。
 *
 * ⚠️ 宿主 `@deepseek-ai/dsh-client-ui-model-selection` 在两处的排法**相反**：
 * · `placement: 'trigger'`（输入框上方那一行）⇒ **徽标在名字前面**；
 * · `placement: 'option'`（下拉菜单里的候选行）⇒ **徽标在名字后面**。
 * 本插件占的是 single 槽、替**全部** provider 画这一行（不只自家），所以若一律
 * 「名字→徽标」，外来渠道在 trigger 行就会从「名前」漂到「名后」= 视觉回归。
 * `placement` 缺省（宿主老版本 / 替身）⇒ 按 `'option'` 排，与历史行为一致。
 *
 * @returns 顺序排好的 children 数组。
 */
export function orderBadgeParts(placement, nameNode, chipNode) {
  return placement === 'trigger' ? [chipNode, nameNode] : [nameNode, chipNode];
}

/**
 * 注册本槽位。
 *
 * ⚠️⚠️ **try/catch 必须在 inject 回调里面**（参考实现的教训）：`inject()` 的回调
 * 可能**稍后**才跑（槽位尚未声明时它会订阅），那时抛出会被渲染器的
 * `queueMicrotask` 重新抛出 ⇒ 用户在重启后的首屏看到一条渲染错误横幅,
 * 而不是「徽标没了」。放外面等于没放。
 *
 * ⚠️ 回调的契约是**返回一个 disposer**，不能返回 undefined —— 上层要靠它回收。
 */
export function registerModelLabelSlot(ctx, rpcCall) {
  const refuse = (error) => {
    try {
      ctx.logger.warn(`[jet-hub] 模型名槽位注册失败（宿主与其余功能不受影响）: ${String(error)}`);
    } catch { /* 日志出口本身坏掉时不升级成异常 */ }
  };
  boundRpcCall = typeof rpcCall === 'function' ? rpcCall : null;
  try {
    return ctx.slots.inject('conversation.input.model.label', () => {
      // 注册时机即取数时机：比组件挂载更早，首屏能少等一个往返。
      void loadCandidates(rpcCall);
      try {
        return ctx.slots.register({
          name: 'conversation.input.model.label',
          priority: MODEL_LABEL_PRIORITY,
          inject: () => ({ rpcCall }),
        }, ModelLabel);
      } catch (error) {
        refuse(error);
        return () => {};
      }
    });
  } catch (error) {
    // 只有 inject() 自己抛出才走到这里（该宿主根本没声明这个槽）。
    refuse(error);
    return undefined;
  }
}
