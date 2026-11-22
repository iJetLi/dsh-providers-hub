/**
 * 「新建账号时自动打开浏览器授权页」偏好的客户端状态与读写
 * （**无 React、无组件依赖**）。
 *
 * ## 为什么单独成文件
 *
 * 两处都要用它：Jet Hub 设置弹窗里的开关、以及 `ProviderPanel` 的
 * `createAccount`（决定「自动开窗」还是「复制链接 + 显示链接」）。
 * 与 `panel-entry-store.js` 同因：把状态放进组件会让两处各持一份，
 * 设置页切开关后 `createAccount` 读到的仍是旧值（「改了不生效」且零报错）。
 *
 * ## 语义
 *
 * - `true`（默认）= 点「+ 新建账号」后照旧自动打开授权页；
 * - `false` = 不自动开窗；授权链接复制到剪贴板并显示在账号面板里。
 *
 * ⚠️ **缺省方向不能反**：还没从宿主读到 / 读失败时一律按 `true`（开）处理，
 * 与宿主侧 `sanitizeAutoOpenBrowserEnabled` 的缺键语义**逐字同构**。
 * 反过来（读失败按关）会让「一次读取抖动」变成「新建账号不再跳登录页」。
 *
 * 存宿主侧而不是浏览器本地存储：Web 端 origin 是 `http://127.0.0.1:<随机端口>`，
 * 换端口本地存储就清空，用户会看到「开关自己变回默认」。客户端也不该读写
 * 浏览器存储（本仓库有一条守卫在扫客户端源码里的存储 API 字面量）。
 */

/** 读宿主偏好的超时（毫秒）。超时按「开」兜底：卡住的 RPC 不该关掉功能。 */
const READ_TIMEOUT_MS = 5000;

/**
 * 一次 `loadLoginAutoOpen` 最多发几轮读请求（1 轮首读 + 重试）。
 *
 * ⚠️ 首读发生在 `JetHubPage` 挂载时，而冷启动的 `connection` 握手可能还没完成
 * （`panel-entry-store.js` 的 2026-10-27 真机报障：`connection.rpc.call()`
 * 在 socket 就绪前**不会本地失败**，只是一直不 settle ⇒ 5s 超时 ⇒ 偏好被永久
 * 降级）。⇒ 有界重试：每轮自带 5s 超时，间隔线性递增（200ms / 400ms）。
 */
const READ_ATTEMPTS = 3;

/** 重试间隔基数（毫秒，第 n 轮重试等 `n × 本值`）。 */
const RETRY_DELAY_MS = 200;

/** 等待若干毫秒（重试用）。 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 进程内取值：`true`（默认，自动开窗）= 本功能上线前的行为。 */
let enabled = true;

/** 最近一次读取是否失败（设置页据此显示「宿主旧代码」提示，不据此禁用开关）。 */
let readFailed = false;

/** 正在飞的那次读取（并发去重；`null` = 没有在飞）。 */
let inflight = null;

/**
 * 写入次数（单调递增）。读取在**发起时**记下当时的值，回包时再比一次：
 * 若期间用户写入过，这个回包携带的是**写之前**的宿主状态，丢弃它。
 *
 * ⚠️ 与 `panel-entry-store.js` 的 `writeSeq` 同因：慢读回包会把用户刚切好的
 * 开关**覆盖回旧值**（症状是「刚改完又自己跳回去了」）。
 */
let writeSeq = 0;

/** 订阅者集合：设置页开关与 `createAccount` 共用同一份状态。 */
const listeners = new Set();

/**
 * 当前是否自动打开浏览器授权页。
 *
 * @returns {boolean} `true` = 自动开窗（默认）；`false` = 复制链接手动打开。
 */
export function loginAutoOpenEnabled() {
  return enabled;
}

/**
 * 最近一次「读宿主偏好」是否失败。
 *
 * ⚠️ 只用于**提示**：失败时仍按「开」兜底、开关仍可点 —— 与网关面板
 * 「附属字段采集失败不该把用户挡在自救路径之外」同一取向。
 *
 * @returns {boolean}
 */
export function loginAutoOpenReadFailed() {
  return readFailed;
}

/**
 * 订阅开关状态变化（取值与读取失败标记都会触发）。
 *
 * @param {() => void} listener
 * @returns {() => void} 取消订阅
 */
export function subscribeLoginAutoOpen(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 广播一次状态变化。**无变化时不广播**，避免设置页无谓重渲染。
 *
 * @param {boolean} nextEnabled
 * @param {boolean} nextFailed
 */
function publish(nextEnabled, nextFailed) {
  if (enabled === nextEnabled && readFailed === nextFailed) return;
  enabled = nextEnabled;
  readFailed = nextFailed;
  // 复制一份再遍历：监听器里可能自己退订。
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (caught) {
      console.error('[jet-hub] 自动打开浏览器开关的监听器抛错', caught);
    }
  }
}

/**
 * 组装读取用的 AbortSignal。
 *
 * ⚠️ 与 `panel-entry-store.js` 的 `readSignal` 同因：`build.mjs` 的 esbuild
 * `target: ['chrome100']`，而 `AbortSignal.timeout` 是 Chrome 103+ —— 直接依赖它
 * 会让老内核上**整个超时保护被摘掉**。有原生 API 就用，没有就用
 * `AbortController` + `setTimeout` 等价实现。
 *
 * @returns {AbortSignal | undefined}
 */
function readSignal() {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(READ_TIMEOUT_MS);
  }
  if (typeof AbortController !== 'function') return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
  if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') {
    timer.unref();
  }
  controller.signal?.addEventListener?.('abort', () => clearTimeout(timer), { once: true });
  return controller.signal;
}

/**
 * 从宿主读一次开关（只读，不写回）。
 *
 * 调用点：`JetHubPage` 挂载时（见 `jet-hub.js`）。并发去重 + 有界重试，
 * 语义与 `panel-entry-store.js` 的 `loadPanelEntry` 同款。
 *
 * @param {(endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>} rpcCall
 * @returns {Promise<boolean>} 读到的值；失败时沿用当前状态（兜底「开」）
 */
export function loadLoginAutoOpen(rpcCall) {
  // 已有在飞的请求就复用：复用同一份 Promise，调用方拿到的值与「自己发一次」
  // 逐字节一致（同一个网络回包）。
  if (inflight !== null) return inflight;
  // ⚠️ 发起时记下写入序号：回包时若它变了，说明期间用户改过，本回包已过期。
  const seqAtStart = writeSeq;
  const task = (async () => {
    /** 最后一轮的失败原因；只有**全部轮次都失败**才把它报出去。 */
    let lastError;
    for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt += 1) {
      try {
        const result = await rpcCall('loginPreferences.getEnabled', {}, readSignal());
        // ⚠️ 防倒灌：期间有写入就丢弃本次读回包 —— 它携带的是写之前的状态。
        if (writeSeq !== seqAtStart) return enabled;
        if (typeof result?.enabled === 'boolean') {
          publish(result.enabled, false);
        } else {
          // 回包形状不对：按读取失败处理，但仍保持当前（默认开）方向。
          // ⚠️ 形状不对**不重试** —— 宿主已经答了，只是答得不对，再问三次也一样。
          publish(enabled, true);
        }
        return enabled;
      } catch (caught) {
        lastError = caught;
        // 期间用户写入过 ⇒ 本次读已过期，不必再试（写成功已给出权威值）。
        if (writeSeq !== seqAtStart) return enabled;
        if (attempt >= READ_ATTEMPTS) break;
        await delay(RETRY_DELAY_MS * attempt);
        if (writeSeq !== seqAtStart) return enabled;
      }
    }
    console.warn(
      `[jet-hub] 读取「自动打开浏览器」开关失败，按开启处理（已重试 ${READ_ATTEMPTS - 1} 次）`,
      lastError,
    );
    if (writeSeq === seqAtStart) publish(enabled, true);
    return enabled;
  })();
  inflight = task;
  // ⚠️ 清理**必须挂在 async 体外面**：`rpcCall` 若同步抛错，写在 async 体
  //    里的 `finally` 会先跑、随后被 `inflight = task` 覆盖 ⇒ 一个已 settle 的
  //    Promise 永久留在 `inflight` 上，此后每次读取都复用它、再也不发请求。
  //    （与 `panel-entry-store.js` 的 2026-10-24 复核 C2 同因。）
  const clear = () => {
    if (inflight === task) inflight = null;
  };
  void task.then(clear, clear);
  return task;
}

/**
 * 写回开关，并以宿主返回值更新本地状态。
 *
 * ⚠️ **不猜默认值**：只有宿主明确回布尔才更新；失败直接抛给调用方
 * （设置页要能回滚并提示用户 —— 静默改本地状态会造成「开关看着关了、
 * 新建账号却仍自动开窗」）。
 *
 * @param {(endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>} rpcCall
 * @param {boolean} next
 * @returns {Promise<boolean>} 宿主确认后的值
 */
export async function setLoginAutoOpen(rpcCall, next) {
  const result = await rpcCall('loginPreferences.setEnabled', { enabled: next });
  if (typeof result?.enabled !== 'boolean') {
    throw new Error('「自动打开浏览器」开关没有返回合法 enabled');
  }
  // ⚠️ 序号只在**写入成功**后递增：失败时用户的意图没落地，在飞的读回包仍然有效。
  writeSeq += 1;
  publish(result.enabled, false);
  return result.enabled;
}

/**
 * 测试接缝：直接设定进程内取值（不碰 RPC）。
 *
 * ⚠️ 只给单测用（`jet-hub-panel-wiring.spec.ts` 驱动 `createAccount` 的两态）。
 * 生产代码一律走 `loadLoginAutoOpen` / `setLoginAutoOpen`。
 *
 * @param {boolean} value
 */
export function __setLoginAutoOpenForTest(value) {
  publish(value !== false, false);
}