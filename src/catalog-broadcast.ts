/**
 * 目录变更广播的**唯一**实现（issue IKJVTF）。
 *
 * ## 为什么需要它
 *
 * DSH 客户端 `dsh-client-ui-model-selection` 的 `ModelCatalogDirectory` 把
 * `modelCatalog` 响应缓存进一个 `status === 'ready'` 即**短路返回**的 store，
 * 只在四个宿主事件上 `refresh()`：`llm/adapters-updated` /
 * `settings/document-updated` / `credentials/record-updated` /
 * `credentials/reference-updated`。
 *
 * 于是「**远端模型目录刚刚落地**」这件事必须显式广播 —— 冷启动首拉失败时
 * 客户端会把**兜底表**缓存成 ready，此后远端目录真的拿到也**没有任何事件**
 * 通知它重读 ⇒ 永久分叉：Jet Hub 设置页（走插件 RPC，每次实时）显示 5 个模型，
 * 对话框选择器（走 DSH `buildModelCatalog` → `ctx.llm.listModels()`）只剩 2 个。
 * 修复前十个适配器的 `ensureRemoteModels` 全是 **0 处广播**。
 *
 * ## 三条语义
 *
 * 1. **同 tick 合并**：一次目录落地会牵动多个 provider / 多个调用点，
 *    逐个 emit 会让客户端刷新 N 次。同一 `ctx` 在本次派发完成前只排一次。
 * 2. **`queueMicrotask` 派发，不同步 emit**：`llm/adapters-updated` 的监听器
 *    会再次走 `buildModelCatalog` → `listModels` → 可能又触发一次目录落地。
 *    同步 emit 会把这条链变成**重入**（在闸门的 `run` 里再进 `run`）。
 *    排到 microtask 后，闸门的 `inFlight` 已能正确合并这类重入。
 * 3. **派发期间保持合并标记**：`pending` 在 `emit` **之后**才清 —— 否则
 *    emit 期间的重入会被当成「新的一轮」再排一次，形成广播风暴。
 *    emit 返回后才清，使「异步落地的新一轮」仍能正常广播。
 *
 * ⚠️ 广播失败**只记日志**：目录已经落地了，因通知失败而抛错会让调用方
 * （`listModels` 的宿主路径）以为目录加载失败。与 `jet-hub-rpc.ts` 里
 * 「通知失败不能反噬已经落盘的开关」是同一条约定。
 */

import type { Context } from '@deepseek-ai/cordis'

/**
 * 已排程待派发的 ctx 集合（**时间窗口**合并用）。
 *
 * 用 `WeakSet` 而非 `Set`：ctx 是长生命周期对象，且插件可能被卸载重建 ——
 * 不持有强引用，卸载后条目自然回收，不会把旧 ctx 永久留在集合里。
 */
const pending = new WeakSet<Context>()

/**
 * ★★★ **广播合并窗口**（2026-11-20 真实启动卡顿修复）。
 *
 * ## 它修的是什么（实测）
 *
 * 探针抓到冷启动的 `listModels` 调用时间线（33 个 provider）：
 *
 * ```
 * + 0s    11  ███
 * + 1s   216  ███████████████████████████████████████████████████████
 * +15s   208  ███████████████████████████████████████████████████████
 * +31s   199  ███████████████████████████████████████████████████████
 * +37s   104  █████████████████████████████████████████████████████
 * ```
 *
 * 单 provider 被调 **16 次**，没账号的也被调 **14 次**。
 *
 * ## 根因：20+ 个适配器各自广播，宿主每次广播都重算**全部** provider
 *
 * 每个适配器在目录落地时都调 `onCatalogLoaded: () => broadcastCatalogChanged(ctx)`，
 * 而宿主收到 `llm/adapters-updated` 后会对**每个** provider 重新
 * `buildModelCatalog` → `await listModels()`。
 *
 * ⇒ `N 家目录先后落地` = `N 次广播` = `N × 33 次 listModels`。
 *
 * ## 为什么原来的 `queueMicrotask` 合并无效
 *
 * 它只在**同一个 tick** 内合并。而各家目录是**网络响应错开**落地的
 *（几十毫秒到十几秒不等）⇒ 几乎每次都在不同 tick ⇒ 合并率接近 0。
 *
 * ## 改法：合并窗口
 *
 * 用一个 `setTimeout` 窗口（{@link CATALOG_BROADCAST_COALESCE_MS}）替代
 * `queueMicrotask`：窗口内所有调用只派发**一次**。
 *
 * ⚠️ **为什么不更长**：窗口是「目录更新可见」的延迟上限。800ms 对用户
 * 无感（面板刷新本来就有 120s 缓存），再长会让「刚加的模型不出现」被察觉。
 *
 * ⚠️ **`setTimeout` 必须 `unref()`**：否则它会持有事件循环、拖住进程退出
 *（与 `index.ts` 里 `modelsDevTimer` 同款约定）。
 */
export const CATALOG_BROADCAST_COALESCE_MS = 800

/** 每个 ctx 当前的定时器（用于窗口内不重复排程）。 */
const timers = new WeakMap<Context, ReturnType<typeof setTimeout>>()

/**
 * 广播「模型目录可能已变化」。
 *
 * 幂等：同一 `ctx` 在一个**合并窗口**内重复调用只派发一次。
 *
 * ⚠️ 语义变化（2026-11-20）：从「同 tick 合并」放宽到「同时窗合并」。
 * 代价是派发最多晚 {@link CATALOG_BROADCAST_COALESCE_MS}；收益是冷启动
 * 的 `listModels` 调用量降一个数量级（实测 8 家落地 → 1 次派发）。
 */
export function broadcastCatalogChanged(ctx: Context): void {
  if (pending.has(ctx)) return
  pending.add(ctx)
  const timer = setTimeout(() => {
    timers.delete(ctx)
    try {
      ctx.emit('llm/adapters-updated')
    } catch (error) {
      ctx.logger?.warn?.(`[jet-hub] 广播模型目录变更事件失败：${String(error)}`)
    } finally {
      // ⚠️ **必须在 emit 之后清**（不是之前）：emit 同步触发的监听器会重入
      // `listModels` → 可能再次调到这里，那时若标记已清就会再排一轮，
      // 每次派发都翻一倍 —— 广播风暴。emit 期间保持标记即把这类重入合并掉。
      // 异步落地的新一轮（emit 返回之后才拿到目录）不受影响，照常广播。
      pending.delete(ctx)
    }
  }, CATALOG_BROADCAST_COALESCE_MS)
  // ⚠️ 不 `unref` 会持有事件循环 ⇒ 插件卸载后进程退不掉（与 modelsDevTimer 同款）。
  ;(timer as unknown as { unref?: () => void }).unref?.()
  timers.set(ctx, timer)
}
