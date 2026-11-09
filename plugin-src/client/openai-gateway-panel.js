/**
 * 「本机 OpenAI 网关」设置面板的状态判定与文案（纯逻辑）。
 *
 * ## 为什么单独成文件
 *
 * 与 `provider-toggle.js` / `model-bulk.js` / `credits-capabilities.js` 同理：
 * 本仓库的单测环境里 react 不在依赖内，组件无法渲染。把判定与文案抽成纯函数
 * 才能用真实断言覆盖，而不是靠源码级字符串匹配间接验证。
 *
 * ## 判据全部由宿主侧给定，前端不重算
 *
 * `enabled` / `running` / `blockedByEnv` / `address` 四项都来自
 * `gateway.getEnabled`（见 `src/jet-hub-rpc.ts`）。前端**只读不判**：
 *
 * - `enabled` 是**用户的选择**（持久化状态），与端口是否真在监听无关；
 * - `running` 是**实际运行态**（可能因端口冲突而未监听）；
 * - `blockedByEnv` 表示被 `DSH_OPENAI_GATEWAY_ENABLED` 显式停用，此时
 *   用户的 `enabled` 为真也**不会**让网关跑起来。
 *
 * ⚠️ 前端若自己拿 `enabled` 推导「是否在运行」，就会在端口冲突或 env 停用时
 * 显示「已开启」而用户连不上 —— 这类自相矛盾最难排查，故一律以宿主侧为准。
 *
 * @typedef {object} ApiKeyInfo
 * @property {string} value 密钥本体
 * @property {boolean} fromEnv 是否来自 DSH_OPENAI_GATEWAY_API_KEY
 * @property {string | null} path 密钥文件路径（来自环境变量时为 null）
 *
 * @typedef {object} GatewayStatus
 * @property {boolean} enabled 用户在设置页里的选择
 * @property {boolean} running 当前是否真的在监听端口
 * @property {boolean} blockedByEnv 是否被环境变量显式停用
 * @property {boolean} allowLan 「允许局域网访问」开关（用户的选择，持久化）
 * @property {boolean} hostFromEnv env 是否显式给了 DSH_OPENAI_GATEWAY_HOST
 *   （此时局域网开关不生效，UI 必须禁用并说明）
 * @property {{ host: string, port: number } | null} address 实际监听地址
 * @property {ApiKeyInfo | null} [apiKey] 正在使用的凭据
 * @property {{ kind: 'start-failed' | 'factory-missing', reason: string, at: number } | null} [lastError]
 *   「期望运行但未监听」的结构化原因（Issue #11）。⚠️ 可选：老版本宿主不返回它，
 *   所有读取点都必须容忍 `undefined`（统一走 `gatewayFailureReason()`）。
 */

/**
 * 把密钥写进剪贴板。
 *
 * ## 为什么默认**不**把密钥明文渲染到页面上
 *
 * 设置页会被截图、被录屏、被投屏演示。让用户点一下「复制」比让密钥整条躺在
 * 屏幕上更可控 —— 明文只在用户主动点击的那一刻进入剪贴板。
 *
 * ## 失败必须自己处理
 *
 * 浏览器只在**用户手势**里允许 `navigator.clipboard.writeText`，异步兜底
 * （非 https、权限被拒、旧内核无 Clipboard API）都会 reject。调用方必须据此
 * 提示「请手动复制」并把值显示出来，否则用户点了按钮却毫无反应 —— 这正是
 * 「复制按钮点了没反应」这类最难自查的失败。
 *
 * @param {string} value 要复制的文本
 * @returns {Promise<boolean>} 是否写入成功
 */
// ⚠️ 搜索判据与模型清单**共用同一份实现**（`model-filter.js`）：两处各写一套
// 「空搜索词算命中全部」之类的约定，迟早漂移成「同一句话在两张表里搜出不同结果」。
import { isFilterActive, matchesModelQuery } from './model-filter.js';
// ⚠️⚠️ host 的归一化与「是否只绑回环」**必须与宿主侧同源**
// （`src/openai-gateway/config.ts` 的 `formatGatewayHost` / `isLoopbackHost`）。
// 初版前端自己写了 `/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/` + `=== '[::1]'`，而
// 宿主侧走的是 URL 规范化 —— 两套判据立刻漂移：`127.1` / `0:0:0:0:0:0:0:1` /
// `::ffff:127.0.0.1` / `localhost` 这些**内核实测只在回环可达**的写法被判成
// 「已对外暴露」，面板于是输出它自己声称要消除的那种**错误安全陈述**
// （两轮独立审计各自实测到，2026-10-13）。
// ⚠️ 该模块必须**零 node import**（它同时被 esbuild 打进浏览器 bundle）。
import { formatGatewayHost, gatewayHttpUrl, isLoopbackHost, isWildcardHost } from '../../src/openai-gateway/config.js';

export async function copyToClipboard(value) {
  // 1) 首选 Clipboard API（安全上下文 / 有权限时）。
  //    ⚠️ 捕获后**必须继续降级**，不能直接 return false —— 见下方 legacyCopy 的说明。
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // 权限被拒 / 非用户手势调用 → 落到 legacyCopy
  }
  // 2) 降级：execCommand('copy')
  if (legacyCopy(value)) return true;
  // 3) 兜底：自动复制用不了就把文本摊出来让用户自己 Ctrl+C。
  //    ⚠️ 返回 false（自动复制确实失败，调用方该展开列表/提示），但**同时**弹窗，
  //    保证用户在任何环境下都能拿到文本 —— 「点了没反应」比「丑一点的弹窗」糟得多。
  showManualCopy(value);
  return false;
}

/**
 * 手动复制兜底面板：把文本摊进一个自动全选的 textarea。
 *
 * ## 为什么必须有这一层（2026-10-23 二次报障）
 *
 * 前两层都失效的环境是真实存在的：
 *
 * - 非安全上下文（`http://<内网 IP>`）→ 无 `navigator.clipboard`
 * - iframe 未授予 `allow="clipboard-write"` → `execCommand('copy')` 静默返回 false
 * - 浏览器隐私策略 / 企业策略禁用剪贴板写入
 *
 * 这些情况下前端能做的最后一件事就是**把文本交给用户**。`window.prompt` 也能做到，
 * 但它对「复制全部 605 个 ID」这种长文本会被截断（各浏览器上限约 2000 字符），
 * 所以这里自己搭一个小面板。
 *
 * ⚠️ 用原生 DOM 而不是 React 状态：`copyToClipboard` 是被 `jet-hub.js` 里多个
 * 非组件函数调用的纯工具，为了一个罕见的兜底路径把整个调用链改成受控组件不值得。
 * z-index 取 `2147483647` —— DSH 的浮层栈很深，兜底面板必须压在最上面才有意义。
 *
 * @param {string} value
 * @returns {boolean} 是否成功渲染出面板
 */
function showManualCopy(value) {
  if (typeof document === 'undefined' || !document.body) return false;
  try {
    // ⚠️ 2026-10-31 审计（P3）：失败环境下连点 N 次「复制」会叠 N 个遮罩面板
    //    （每个都要单独点关闭）。已有面板在场时直接复用它：更新 textarea 内容、
    //    重新全选 —— 语义仍是「用户拿到了文本」，且不叠加。
    //    用 data 属性标记而不是保存全局引用：本函数无状态，重复弹守卫靠 DOM 自身。
    const existing = document.body.querySelector('[data-dsh-manual-copy]');
    if (existing) {
      const again = existing.querySelector('textarea');
      if (again) {
        again.value = value;
        again.focus();
        again.select();
        again.setSelectionRange(0, value.length);
        return true;
      }
      existing.remove();
    }

    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    // ⚠️ 给查询选择器留钩子（见上面的重复弹守卫）。
    overlay.setAttribute('data-dsh-manual-copy', '');
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483647',
      'display:flex', 'align-items:center', 'justify-content:center', 'padding:24px',
      'background:rgba(0,0,0,.45)', 'font-family:inherit',
      // ⚠️ 2026-10-31 审计（P2）：宿主可能跑深色主题（DSH Web 常见形态），
      //    硬编码浅色会在深色界面里糊一块高亮白。用 color-scheme 声明跟随宿主
      //    （textarea 的 UA 默认色/滚动条随之适配），其余颜色尽量走系统语义色，
      //    实在写死的（边框/阴影）选中性灰，深浅两版都不刺眼。
      'color-scheme:dark light',
    ].join(';');

    const box = document.createElement('div');
    box.style.cssText = [
      'background:Canvas', 'color:CanvasText',
      'border-radius:12px', 'box-shadow:0 12px 40px rgba(0,0,0,.28)',
      'border:1px solid rgba(128,128,128,.35)',
      'width:min(720px,100%)', 'max-height:80vh', 'display:flex',
      'flex-direction:column', 'padding:16px', 'gap:12px',
    ].join(';');

    const title = document.createElement('div');
    title.textContent = '浏览器阻止了自动复制，请按 Ctrl+C 复制（内容已全选）';
    title.style.cssText = 'font-size:13px;font-weight:600;color:CanvasText';

    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    // ⚠️ 审计（P2）：密钥/模型 ID 不是人类语言，别让浏览器给它画拼写红线。
    textarea.setAttribute('spellcheck', 'false');
    textarea.style.cssText = [
      'flex:1', 'min-height:220px', 'box-sizing:border-box',
      'font-family:ui-monospace,Consolas,monospace', 'font-size:12px', 'line-height:1.5',
      'border:1px solid rgba(128,128,128,.35)', 'border-radius:8px',
      'padding:8px', 'resize:vertical', 'color-scheme:dark light',
    ].join(';');

    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '关闭';
    close.title = '关闭（Esc）';
    close.style.cssText = [
      'align-self:flex-end', 'padding:6px 16px', 'border-radius:6px',
      'border:1px solid rgba(128,128,128,.35)', 'background:transparent',
      'color:inherit', 'cursor:pointer', 'font-size:13px', 'font-family:inherit',
    ].join(';');

    // ⚠️ 2026-10-31 审计（P1）：面板声明了 aria-modal 却没有 Escape 处理，而
    //    宿主在 document 级注册了 `Escape → 关闭网关 modal`（jet-hub.js 的
    //    onKeyDown）。用户按 Esc 想关这个小面板，结果**先关掉底层大模态**，
    //    小面板挂在 body 上残留（不随 React 卸载）。⇒ 面板自己接 Escape 并在
    //    **capture 阶段**拦下（stopPropagation 阻断后宿主的 document 冒泡监听
    //    收不到该事件），关闭时移除监听。textarea 初始持焦点，keydown 必经这里。
    const dismissAndCleanup = () => {
      document.removeEventListener('keydown', onKeyDown, { capture: true });
      overlay.remove();
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        event.preventDefault();
        dismissAndCleanup();
      }
    };
    document.addEventListener('keydown', onKeyDown, { capture: true });
    close.addEventListener('click', dismissAndCleanup);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) dismissAndCleanup(); });

    box.append(title, textarea, close);
    overlay.append(box);
    document.body.appendChild(overlay);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, value.length);
    return true;
  } catch {
    return false;
  }
}

/**
 * `document.execCommand('copy')` 降级实现。
 *
 * ## ⚠️ 这个降级不是可选项（2026-10-23 报障：本地用户复制不了，服务器端正常）
 *
 * `navigator.clipboard` **只在安全上下文存在**：
 *
 * | 打开方式 | 安全上下文 | `navigator.clipboard` |
 * |---|---|---|
 * | `https://host/...` | 是 | 有 |
 * | `http://localhost:3000`、`http://127.0.0.1:3000` | 是 | 有 |
 * | **`http://192.168.1.20:3000`**（局域网地址） | **否** | **`undefined`** |
 *
 * 所以同一份产物，在服务器本机用 `localhost` 打开时复制正常，同事从局域网用
 * `http://<内网 IP>` 打开时「复制本组 / 复制全部 ID / 复制对照表」全部静默失效 ——
 * 现象就是"服务端能复制、本地不能"，极易被误判成权限或后端问题。
 *
 * `execCommand('copy')` 已废弃但**所有浏览器仍支持**，且**不要求安全上下文**，
 * 是这条路径上唯一的出路。
 *
 * ## 几个必须的细节
 *
 * - 隐藏用 `opacity: 0` 而**不是** `display: none`：后者不在渲染树里，选不中，复制必失败。
 * - `position: fixed` + 1px：避免插入元素把页面顶出滚动条或抖动。
 * - `readonly`：否则移动端弹出软键盘。
 * - `setSelectionRange(0, len)`：iOS Safari 上 `select()` 对 textarea 有时选不全。
 * - **还原焦点**：`select()` 会把焦点抢到 textarea，不还回去会让键盘用户的操作位置丢失
 *   （例如 Tab 到复制按钮、按回车、焦点跳到页面顶部）。
 *
 * @param {string} value
 * @returns {boolean} 是否成功
 */
function legacyCopy(value) {
  if (typeof document === 'undefined' || typeof document.body === 'undefined') return false;
  const previousFocus = typeof document.activeElement !== 'undefined' ? document.activeElement : null;
  let textarea = null;
  try {
    textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '0';
    textarea.style.width = '1px';
    textarea.style.height = '1px';
    textarea.style.padding = '0';
    textarea.style.border = 'none';
    textarea.style.outline = 'none';
    textarea.style.boxShadow = 'none';
    textarea.style.background = 'transparent';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, value.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    if (textarea && textarea.parentNode) textarea.parentNode.removeChild(textarea);
    if (previousFocus && typeof previousFocus.focus === 'function') {
      try { previousFocus.focus(); } catch { /* 元素可能已被卸载 */ }
    }
  }
}

/**
 * 密钥来源的展示文案。
 *
 * ⚠️ 来自环境变量时**不显示文件路径** —— 那一刻根本没有文件，显示一个假路径
 * 只会让用户去那儿找然后扑空。
 *
 * @param {{ fromEnv: boolean, path: string | null } | null | undefined} apiKey
 * @returns {string}
 */
export function gatewayApiKeyHint(apiKey) {
  if (!apiKey) return '网关尚未生成过密钥：启用一次网关即会自动生成。'
  if (apiKey.fromEnv) return '密钥来自环境变量 DSH_OPENAI_GATEWAY_API_KEY（不在文件里）。'
  return apiKey.path ? `密钥文件：${apiKey.path}` : '密钥来自环境变量。'
}

/**
 * 页头按钮的文字。
 *
 * ⚠️ 刻意**只写「网关」**（不是「网关开关」）：页头按钮排成一行，文字越长越容易
 * 把右端的「关闭」挤到第二行（`jet-hub.js` 里「供应商」按钮旁有同款注释）。
 * 完整语义由 `title` 与弹窗标题承担。
 *
 * @param {GatewayStatus | null | undefined} status
 * @returns {string}
 */
export function gatewayButtonLabel(status) {
  if (!status) return '网关'
  // 运行态用「●」提示，开着的按钮一眼可辨；但绝不用颜色单独承载语义
  // （`title` 与弹窗里都有文字说明）。
  return status.running ? '网关 ●' : '网关'
}

/**
 * 该模型是否接受图片输入。
 *
 * ⚠️ 判据取自**宿主回传的 `input`**（与 `/v1/models` 同一份），前端不自行推断。
 * 缺字段时按「不支持」处理：宁可少标一个（用户发图后拿到明确错误），也不要
 * 错标成支持（用户发完图才发现图被拒）。
 *
 * @param {{ input?: readonly string[] } | null | undefined} model
 * @returns {boolean}
 */
export function modelSupportsImage(model) {
  return Array.isArray(model?.input) && model.input.includes('image');
}

/**
 * 模型行上的能力标记。
 *
 * @param {{ input?: readonly string[] } | null | undefined} model
 * @returns {string} 空串表示不标任何标记
 */
export function modelCapabilityBadge(model) {
  return modelSupportsImage(model) ? '可发图片' : '';
}

/**
 * 列出模型 ID 的一行文本（每行一个，供粘贴到 agent 配置）。
 *
 * @param {Array<{ id: string }> | null | undefined} models
 * @returns {string}
 */
export function formatModelIdList(models) {
  if (!models || models.length === 0) return ''
  return models.map((model) => model.id).join('\n')
}

/**
 * 条目所属的供应商 key。
 *
 * ⚠️ **优先取采集侧给的 `provider`**，只在它缺失时才按首个 `/` 切 `id` 兜底。
 * 兜底分支与网关自己的路由口径**同源**（`src/openai-gateway/messages.ts` 的
 * `parseModelRoute` 同样用 `indexOf('/')` 切第一个斜杠），所以兜底出来的分组
 * 与「能不能调用成功」不会矛盾 —— 这是它能安全兜底的前提。
 *
 * 但兜底**不是**首选：模型名里允许带斜杠（实测 Cline 的
 * `cline/anthropic/claude-sonnet-5.5`），一旦某家的模型名以 `/` 开头，
 * 或 provider key 本身含 `/`，反推就会错位。故正常路径一律用权威字段。
 *
 * @param {{ id?: string, provider?: string } | null | undefined} entry
 * @returns {string} 拿不到时返回 `''`（调用方据此归入「未知」卡片，而不是丢行）
 */
export function gatewayProviderOf(entry) {
  const provider = entry?.provider
  if (typeof provider === 'string' && provider !== '') return provider
  const id = typeof entry?.id === 'string' ? entry.id : ''
  const slash = id.indexOf('/')
  return slash > 0 ? id.slice(0, slash) : ''
}

/**
 * 条目在**供应商内部**的名字（不含 `<provider>/` 前缀）。
 *
 * 卡片已经按供应商分组，行内再重复一遍前缀是纯噪声：实测
 * `codearts/deepseek-v4.1-flash` 这类 id 会占掉整行的宽度，在窄面板的夹取下跌成
 * `codearts/deepse…` —— 用户既看不出模型名，也读不到能复制的 ID。
 * 故行内只显示这一段的**可读名字**，而「复制」始终复制完整 `id`。
 *
 * @param {{ id?: string, provider?: string, model?: string } | null | undefined} entry
 * @returns {string} 拿不到时退回完整 `id`（宁可多显示前缀，也不要给空行）
 */
export function gatewayModelKeyOf(entry) {
  const inner = entry?.model
  if (typeof inner === 'string' && inner !== '') return inner
  const id = typeof entry?.id === 'string' ? entry.id : ''
  const provider = gatewayProviderOf(entry)
  if (provider !== '' && id.startsWith(provider + '/')) return id.slice(provider.length + 1)
  return id
}

/**
 * 卡片**默认**展开的最大条目数。
 *
 * 超过它就默认折叠：网关清单是**全 provider 汇总**，Cline 一家实测近 500 条，
 * 全展开等于把弹窗撑成没法翻的长条（用户在找的是「哪家有哪些模型」，不是
 * 「一次看完 500 行」）。折叠是**可见的**（卡片头上有条数），不会让人以为丢了行。
 * 与 `model-groups.js` 的 `groupExpanded` 同一取舍（那里默认折叠「按量计费」大桶）。
 */
export const GATEWAY_CARD_AUTOCOLLAPSE_AT = 24

/**
 * 把条目按供应商折成**一个供应商一张卡片**。
 *
 * 用户报障（2026-10-03）：`deepseek-account/deepseek-flash` 与
 * `deepseek-account/deepseek-v4-pro` 被平铺成两行，看不出它们同属一家 ——
 * 而用户真正要对照的正是「一家供应商下有哪些模型」。
 *
 * - **卡片顺序保持目录原序**（首次出现的先后），与「组内不重排」同一口径；
 * - 供应商 key 拿不到（条目畸形）时归入 `''` 那张卡，**不丢行**：
 *   少一个 ID 会让用户照着一份不完整的清单配客户端；
 * - 不做去重：同一 `id` 出现两次是上游的事，这里如实显示（去重会掩盖上游缺陷）。
 *
 * ⚠️ 模型清单与思考档位对照表**共用**本函数（前者传模型条目、后者传对照行），
 * 故它只依赖 `provider` / `id` 两个字段 —— 两处的分组口径因此不可能漂移。
 *
 * @param {Array<object> | null | undefined} entries
 * @param {(entry: object) => boolean} [countFold] 统计「这一类」条目的数量
 * @returns {Array<{ provider: string, entries: Array<object>, counts: { total: number, fold: number } }>}
 */
export function groupGatewayEntries(entries, countFold) {
  const list = Array.isArray(entries) ? entries : []
  const byProvider = new Map()
  for (const entry of list) {
    const provider = gatewayProviderOf(entry)
    let bucket = byProvider.get(provider)
    if (bucket === undefined) {
      bucket = []
      byProvider.set(provider, bucket)
    }
    bucket.push(entry)
  }
  return [...byProvider].map(([provider, bucket]) => ({
    provider,
    entries: bucket,
    counts: {
      total: bucket.length,
      fold: typeof countFold === 'function' ? bucket.filter(countFold).length : 0,
    },
  }))
}

/**
 * 把模型清单折成**一个供应商一张卡片**（子项是该供应商的模型）。
 *
 * `counts.fold` 是其中**能发图片**的条数（卡片头上据此给个总览）。
 *
 * @param {Array<object> | null | undefined} models
 * @returns {Array<{ provider: string, entries: Array<object>, counts: { total: number, fold: number } }>}
 */
export function groupGatewayModels(models) {
  return groupGatewayEntries(models, (model) => modelSupportsImage(model))
}

/**
 * 这张卡片此刻是否展开。
 *
 * 优先级（从高到低，与 `model-groups.js` 的 `groupExpanded` 同构）：
 * 1. **用户显式点过**（`toggled` 是布尔）—— 用户的选择永远优先；
 * 2. 有生效中的搜索/筛选时一律展开（否则搜到的结果藏在折叠卡里，
 *    用户会以为「搜不到」—— 这与对照表搜索的取舍同源）；
 * 3. 默认值：条数超过 {@link GATEWAY_CARD_AUTOCOLLAPSE_AT} 的卡片折叠。
 *
 * @param {{ counts?: { total?: number } } | null | undefined} card
 * @param {{ toggled?: boolean, searching?: boolean }} [options]
 * @returns {boolean}
 */
export function gatewayCardExpanded(card, options = {}) {
  const toggled = options.toggled
  if (toggled === true || toggled === false) return toggled
  if (options.searching === true) return true
  return (card?.counts?.total ?? 0) <= GATEWAY_CARD_AUTOCOLLAPSE_AT
}

/**
 * 卡片标题：供应商 key → 给人看的名字。
 *
 * 供应商 key 拿不到时（条目畸形）给一个**可解释**的标题，而不是空字符串：
 * 空标题会让用户以为界面坏了，而这其实是上游数据的问题。
 *
 * @param {string} provider
 * @param {(id: string) => string} [labelOf] 渠道名查询（设置页传 `providerLabel`）
 * @returns {string}
 */
export function gatewayCardLabel(provider, labelOf) {
  if (provider === '') return '（未标注供应商）'
  if (typeof labelOf === 'function') {
    const label = labelOf(provider)
    // ⚠️ 查不到时 `providerLabel` 原样返回 id，仍是可读的；只有拿到空串才退回 id。
    if (typeof label === 'string' && label !== '') return label
  }
  return provider
}

/**
 * 模型目录的说明文案。
 *
 * ⚠️ 空清单必须**自解释**：此前只说「还没有可用模型，登录至少一个供应商」，
 * 而真实原因可能是宿主根本没给出任何可枚举的 provider（插件加载异常）。
 * 用户照着错误提示去检查自己的登录，怎么都找不到原因。
 *
 * @param {Array<{ id: string }> | null | undefined} models
 * @param {'catalog' | 'adapters' | 'none'} [source] 目录来源
 * @returns {string}
 */
export function gatewayModelsHint(models, source) {
  if (!models || models.length === 0) {
    if (source === 'none') {
      // ⚠️ 这两句是**空状态的指路**（用户报障过：每个 provider 都登录了却是 0 个，
      // 而旧文案让他去查登录，怎么都对不上）。精简时保留「不是登录问题」这个
      // 反直觉判断 —— 它正是省掉用户半小时排查的那句。
      return '拿不到任何 provider 列表（不是登录问题）：通常是 DSH 侧模型服务未就绪，重启 DSH 或点「刷新」再试。';
    }
    return '还没有可用模型：登录至少一个供应商后点「刷新」。';
  }
  const providers = new Set(models.map(model => gatewayProviderOf(model))).size;
  // ⚠️ 用户 2026-10-04 第二次精简（5 句 → 4 句 → **1 句**）。留下的三项事实都是
  // 「不看就会配错」的：① 数量（用户要确认「有没有我的渠道」）；② 供应商数；
  // ③ ID 区分大小写（大小写写错即 404，且用户不会想到去核对大小写）。
  //
  // 被删掉的两句为什么可以删（而不是丢了信息）：
  //   - 「必须带供应商前缀」→ 移到了**卡片头 tooltip**（「供应商 key：xxx（模型 ID
  //     的前缀就是它）」）。用户真正抄 ID 时就在那张卡片上，比在这句总述里更近。
  //   - 「行内显示短名、复制出去的是完整 ID」→ 移到两个复制按钮的 tooltip
  //     （「每行一个完整 ID」）。按钮上写着的比远景说明更不容易读漏。
  const base = `共开启 ${models.length} 个可用模型，来自 ${providers} 个供应商，ID 区分大小写。`;
  // ⚠️ 兜底目录那半句保留：它是**条件性**的（只在宿主的适配器兜底生效时出现），
  // 讲的是「这份清单可能不完整」这一无法从别处推断的事实，不是冗余解释。
  return source === 'adapters'
    ? base + '（目录来自本插件已注册的适配器，可能不含 DSH 自带的模型）'
    : base;
}

/**
 * 模型清单搜索结果为空时的提示。
 *
 * ⚠️ 与 `gatewayEffortsEmptyHint` 同构（用户要求两处清单都能搜）：空结果必须能
 * 区分「被搜索词筛没了」与「网关本来就没有可用模型」，否则用户会去查登录。
 *
 * @param {string} [query]
 * @returns {string}
 */
export function gatewayModelsEmptyHint(query) {
  const needle = typeof query === 'string' ? query.trim() : '';
  if (needle.length === 0) return '当前没有可用模型。';
  return `没有匹配「${needle}」的模型。搜索会匹配模型 ID 与展示名（不区分大小写）。`;
}

/**
 * 用命令行查看目录的命令模板。
 *
 * ⚠️ 刻意**不含明文密钥**，用占位符代替：命令会进剪贴板历史、可能被贴到聊天里，
 * 把真 key 写进去等于顺手泄露。
 *
 * @param {string | null | undefined} endpoint
 * @returns {string}
 */
export function gatewayModelsCurl(endpoint) {
  const base = endpoint ? endpoint.replace(/\/v1$/, '') : 'http://127.0.0.1:8326'
  return `curl ${base}/v1/models -H "Authorization: Bearer <把你的 API Key 贴在这里>"`
}

/**
 * 思考档位对照表的**一行**（每个声明了档位的模型一行）。
 *
 * ## 这一列为什么必须存在（真实缺陷）
 *
 * 各 provider 的档位 id 是**上游自己的叫法**，而 OpenAI 协议的客户端只有固定
 * 8 档词汇（`none…ultra`，CC Switch 的档位多选器就是这 8 个）。用户只能照 DSH
 * 界面上显示的名字去填客户端，于是必然撞车：
 *
 * | 界面上看到的 | 客户端照填 | 模型真实认的 |
 * |---|---|---|
 * | LobsterAI 的 **Max** | `max` | `xhigh` |
 * | Cline 的 **Extra** | `xhigh` | `max` |
 * | TRAE 的 **Light / Extra High** | `low` / `xhigh` | `light` / `extra_high` |
 *
 * 网关现在会按强度**自动翻译**（填错不再 400），但「精确对应」仍然只有一列答案：
 * 即 `openai_efforts`。故把它渲染出来，用户抄一次就永久正确。
 *
 * ⚠️ **这张表只含「已开启」的模型**：数据来自各适配器的 `listModels`，而它按用户在
 * Jet Hub 里关掉的模型（黑名单）过滤。故表里的行数与模型选择器同源，不会出现
 * 「关掉的模型还在这里占位」。
 *
 * ⚠️ 返回 `null` 表示该模型**没有声明**档位（网关不下发该参数）。
 * 调用方必须跳过它，而不是渲染一行空表 —— 「不知道」与「一个都没有」是两件事。
 *
 * @param {{ id: string, name?: string, reasoning?: { efforts?: Array<{ id: string, name: string, canonical?: string }>, default?: string, openai_efforts?: readonly string[] } } | null | undefined} model
 * @returns {{ id: string, name: string, declared: string, fill: string, lossy: boolean } | null}
 */
export function gatewayEffortRow(model) {
  const reasoning = model?.reasoning;
  const efforts = reasoning?.efforts;
  if (!Array.isArray(efforts) || efforts.length === 0) return null;
  return {
    id: model.id,
    // ⚠️ 带上权威供应商与内部模型名：对照表也要按供应商折成卡片，而行内只显示
    // **去掉前缀**的名字（与模型清单同一取舍，见 `gatewayModelKeyOf`）。
    // 复制出去的仍是完整 `id`（客户端配置要的是它）。
    provider: gatewayProviderOf(model),
    model: gatewayModelKeyOf(model),
    // 展示名留给搜索用（与模型清单的搜索共用 matchesModelQuery）。
    name: typeof model.name === 'string' ? model.name : '',
    // 两个名字都给出来：`id` 是网关实际下发的 wire 值，`name` 是 DSH 界面上的叫法
    // （用户就是照它填错的，故两列都得能对上）。
    declared: efforts.map((effort) => `${effort.id}（${effort.name}）`).join(' · '),
    fill: Array.isArray(reasoning.openai_efforts) ? reasoning.openai_efforts.join(', ') : '',
    // 「真实 id 与应填的规范名不完全一致」= 客户端侧的显示名会与 DSH 界面不同，
    // 这类行才是用户真正会看错的，值得在 UI 上标出来。
    //
    // ⚠️ **`canonical === undefined`（上游给了个没登记的私有 id，如 `turbo`）也算**：
    // 那种档位**任何规范名都表达不出来**，`fill` 列会比 `declared` 列少一档。
    // 原判据只认「canonical 与 id 不同」，于是这种行恰恰**不标徽章** ——
    // 用户看到一档填不出来的东西，却没有任何解释。
    lossy: efforts.some((effort) => effort.canonical === undefined || effort.canonical !== effort.id),
  };
}

/**
 * 全部模型的档位对照行（跳过未声明档位的模型）。
 *
 * @param {Array<object> | null | undefined} models
 * @returns {Array<{ id: string, name: string, declared: string, fill: string, lossy: boolean }>}
 */
export function gatewayEffortRows(models) {
  if (!Array.isArray(models)) return [];
  return models.map(gatewayEffortRow).filter(Boolean);
}

/**
 * 单行是否命中搜索词。
 *
 * ⚠️ **比模型清单的搜索多匹配「档位」** —— 这正是这张表最常用的查法：
 * 「哪些渠道有 `xhigh`？」「界面上的 Max 到底是哪个 id？」。
 * 故判据是「模型 id / 展示名（复用 `matchesModelQuery`，与模型清单同一口径）
 * **或**真实档位名 / 该填的规范名」。
 *
 * @param {{ id?: string, name?: string, declared?: string, fill?: string } | null | undefined} row
 * @param {string} query
 * @returns {boolean}
 */
export function matchesEffortQuery(row, query) {
  if (matchesModelQuery(row, query)) return true;
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (needle.length === 0) return true;
  return `${row?.declared ?? ''} ${row?.fill ?? ''}`.toLowerCase().includes(needle);
}

/**
 * 按搜索词过滤对照表。
 *
 * 无搜索词时**原样返回入参**（不复制、不改顺序）：与 `model-filter.js` 的
 * 「未搜索」口径一致（空串不是「搜索空串」）。
 *
 * @param {Array<object> | null | undefined} rows
 * @param {string} query
 * @returns {Array<object>}
 */
export function filterEffortRows(rows, query) {
  const list = Array.isArray(rows) ? rows : [];
  if (!isFilterActive({ query })) return list;
  return list.filter((row) => matchesEffortQuery(row, query));
}

/**
 * 对照表的说明文案（**按行**给出）。
 *
 * ⚠️ 两件事必须说清，否则用户会以为「表里有我没开的模型」，或者去试一个必然失败的写法：
 * 1. 这张表**只含已开启的模型**（关掉的不会出现）—— 故句子开头必须写「**已开启的**」；
 * 2. 那一列填的是 **CC Switch 的映射档位**，且**未登记的档位名称真会被拒绝**
 *    （见下方实现里的注释：强度序只登记 12 个名字，`turbo` 这类写法会 400）。
 *
 * ⚠️ 曾有一版注释在这里写着「3. 填别的**也不会失败** —— 网关按强度就近翻译」，
 * 那是**与实现对立的错误说法**：就近翻译只覆盖「登记过的别名」，未登记的名字是硬 400。
 * 界面文案与用例都锁的是「会被拒绝」，改这段注释时**别把它改回「不会失败」**
 * （`openai-gateway-panel.spec.ts` 里有 `not.toContain('也不会报错')` 守着）。
 *
 * ⚠️ 返回值是**行数组**而不是一整段（用户 2026-10-04 第三次报障）。
 * 原先两句拼成一串，浏览器在行尾按**空格**断行，于是品牌名被从中间切开 ——
 * 用户看到的正是前一行结尾是「CC」、下一行开头是「Switch」。
 * 品牌名断行会让人怀疑是不是把字写错了，而这两句本来就各说一件事
 * （第一句讲数量与图例，第二句讲那一列填到哪 + 边界），各占一行更清楚。
 * ⚠️ 做法与本报文既有 `gatewayStatusLines` 一致（弹窗顶部那三行就是这么给的）：
 * 判据出纯函数、渲染层只负责「一行一个 p」，**不要**在渲染层拆字符串。
 *
 * @param {Array<object> | null | undefined} models
 * @returns {string[]}
 */
export function gatewayEffortsHintLines(models) {
  const rows = gatewayEffortRows(models);
  if (rows.length === 0) {
    return ['当前已开启的模型都没声明思考档位：网关不下发该参数，按模型默认走。'];
  }
  const lossy = rows.filter((row) => row.lossy).length;
  const enabled = Array.isArray(models) ? models.length : rows.length;
  // ⚠️ 用户 2026-10-04 第二次精简（4 句 → **2 句**）。与模型清单的取舍一致：
  // 删冗余解释，留会导致误配的事实。
  //   1. 「已开启的 N 个模型里，有 M 个可选思考档位」—— 必须点明「已开启」，
  //      否则「14 个」会被读成「网关只认 14 个模型」，而关掉的模型不在表里；
  //      「（N 个不同名，标「需对照」）」是**图例**：不带这句，卡片上的徽章无从解释。
  //   2. 「「客户端该填」为 CC Switch 需配置的映射档位，未登记的档位名称将被拒绝。」
  //      —— 前半句说明那一列**填到哪里**（CC Switch 的映射档位多选器），
  //      后半句是**边界**：强度序只登记了 12 个名字（8 个规范名 + 上游私有的
  //      off / light / on / extra_high），`turbo` 这类未登记的写法**真会 400**
  //      （见 reasoning-ladder.ts 的 REASONING_EFFORT_RANK）。照实说，用户才不会
  //      去试一个必然失败的写法；错误里本来就会列出该模型可用的档位。
  // 删掉的是：「可直接抄进 CC Switch / Codex」（被前半句取代）、「关掉的模型不在
  // 表里」（上方第一句的「已开启的」已表达同一约束）、以及括号里的举例（如 turbo）。
  return [
    `已开启的 ${enabled} 个模型里，有 ${rows.length} 个可选思考档位`
      + `${lossy > 0 ? `（${lossy} 个不同名，标「需对照」）` : ''}。`,
    '「客户端该填」为 CC Switch 需配置的映射档位，未登记的档位名称将被拒绝。',
  ];
}

/**
 * 对照表说明的**单行**形态（把上面的行拼起来）。
 *
 * ⚠️ 保留它是为了不动既有调用方与断言的口径（README、用例、变异脚本都按一整串读）。
 * 面板渲染**必须**用 `gatewayEffortsHintLines` —— 拼成一行再交给浏览器断行，
 * 正是品牌名被从中间切开的那个缺陷（见该函数的注释）。
 *
 * ⚠️ 拼接用**全角空格以外的普通空格**：它只用于「一整串」这种读法
 * （长度上限、关键词包含），不进入任何渲染路径，故不必考虑断行。
 *
 * @param {Array<object> | null | undefined} models
 * @returns {string}
 */
export function gatewayEffortsHint(models) {
  return gatewayEffortsHintLines(models).join('');
}

/**
 * 搜索结果为空时的提示。
 *
 * ⚠️ 空结果必须能自解释：要能区分「被搜索词筛没了」与「本来就没有声明档位的模型」，
 * 否则用户会以为网关坏了、或者以为模型没登录。
 *
 * @param {string} [query]
 * @returns {string}
 */
export function gatewayEffortsEmptyHint(query) {
  const needle = typeof query === 'string' ? query.trim() : '';
  if (needle.length === 0) return '当前没有模型声明思考档位。';
  return `没有匹配「${needle}」的模型。搜索会匹配模型 id / 展示名，也会匹配档位名`
    + '（真实 id 与 DSH 界面上的叫法都算，例如 xhigh / Max / Extra）。';
}

/**
 * 对照表的纯文本形态（供「复制」按钮写进剪贴板）。
 *
 * 与面板渲染共用同一批行，故复制到的内容与屏幕上看到的必然一致。
 *
 * ⚠️ 复制的是**完整 id**（`provider/模型名`），不是行内显示的短名字：
 * 客户端配置要的是前者，抄一个短名字进去必然 404。这一点与模型清单的
 * 「复制」口径完全一致。
 *
 * @param {Array<{ id: string, declared: string, fill: string }> | null | undefined} rows
 * @returns {string}
 */
export function gatewayEffortsText(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list.map((row) => [
    row.id,
    `  真实档位：${row.declared}`,
    `  客户端该填：${row.fill}`,
  ].join('\n')).join('\n\n');
}

/**
 * 查看档位对照表的命令模板（同样**不含密钥**）。
 *
 * @param {string | null | undefined} endpoint
 * @returns {string}
 */
export function gatewayEffortsCurl(endpoint) {
  const base = endpoint ? endpoint.replace(/\/v1$/, '') : 'http://127.0.0.1:8326'
  return `curl ${base}/v1/reasoning-efforts -H "Authorization: Bearer <把你的 API Key 贴在这里>"`
}

/**
 * 页头按钮的 tooltip。
 *
 * @param {GatewayStatus | null | undefined} status
 * @returns {string}
 */
/**
 * 从 `status.lastError` 取出**可展示的失败原因**（空串 = 没有失败原因）。
 *
 * ⚠️ 存在的理由（Issue #11 审计 P1-1）：本文件有**四条**文案都在描述「已选择
 * 开启但没在监听」，而 PR 起初只给其中两条接了 `lastError` ⇒ 同一语义两套判据，
 * 另两条仍在印「通常是端口被占用」这个**猜测**（`gatewayButtonTitle` 是真实渲染
 * 的页头 tooltip）。抽成一个函数，四条路径共用，避免将来再加文案时又漏。
 *
 * @param {GatewayStatus | null | undefined} status
 * @returns {string} 非空 = 有真实原因；空串 = 无（调用方可回落到通用提示）
 */
export function gatewayFailureReason(status) {
  const reason = status?.lastError?.reason
  return typeof reason === 'string' && reason.length > 0 ? reason : ''
}

export function gatewayButtonTitle(status) {
  if (!status) return '本机 OpenAI 网关：读取状态中。'
  if (status.blockedByEnv) {
    return '本机 OpenAI 网关：已被环境变量 DSH_OPENAI_GATEWAY_ENABLED 停用，'
      + '在这里改开关不会让它监听端口。'
  }
  if (status.running) return `本机 OpenAI 网关：运行中（${gatewayEndpoint(status)}）。`
  if (status.enabled) {
    // ⚠️ 页头 tooltip 也必须转述真实原因（Issue #11 审计 P1-1）：原先无条件说
    // 「通常是端口被占用」—— 那是**猜的**，真实原因可能是配置/密钥初始化失败。
    const reason = gatewayFailureReason(status)
    if (reason !== '') return `本机 OpenAI 网关：已选择开启，但启动失败（${reason}）。`
    return '本机 OpenAI 网关：已选择开启，但当前未在监听（通常是端口被占用）。'
  }
  return '本机 OpenAI 网关：已关闭。'
}

/**
 * 网关的对外基地址，形如 `http://127.0.0.1:8326/v1`。
 *
 * ⚠️ `address` 为 `null` 时返回 `''` 而不是编造默认端口：端口可被
 * `DSH_OPENAI_GATEWAY_PORT` 改过，写死 `8326` 会让用户拿一个连不上的地址去
 * 配客户端，且这种错误在客户端侧表现为「连不上」，极难自查。
 *
 * ⚠️ **host 同样来自宿主侧**（`DSH_OPENAI_GATEWAY_HOST`，issue IKL7UN）：
 * 容器化部署里它是容器桥接 IP（如 `172.21.0.8`），此时前端若还印
 * `127.0.0.1` 就是把**宿主地址**当成容器内地址展示 —— 用户抄走后从宿主访问
 * 恰好连不上（那正是 issue 报告者的症状）。故这里一律用真实监听地址。
 *
 * @param {GatewayStatus | null | undefined} status
 * @returns {string}
 */
export function gatewayEndpoint(status) {
  const address = status?.address
  if (!address) return '';
  const publicEndpoint = gatewayPublicEndpoint(status)
  if (publicEndpoint !== '') return publicEndpoint;
  return gatewayHttpUrl(address.host, address.port, '/v1');
}

export function gatewayPublicEndpoint(status) {
  const value = status?.publicUrl
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
}

/**
 * 网关是否只绑在本机回环上。
 *
 * ⚠️⚠️ **判据直接复用宿主侧实现**（`src/openai-gateway/config.ts` 的
 * `isLoopbackHost`），**不要**在客户端另写一套正则。初版就是自己写的
 * `/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/` + `=== '[::1]'`，于是
 * `127.1` / `0:0:0:0:0:0:0:1` / `::ffff:127.0.0.1` / `localhost` 这些
 * **内核实测只在回环可达**的写法被判成「已对外暴露」，面板会输出它自己声称
 * 要消除的那种**错误安全陈述**（两轮独立审计各自实测到）。
 *
 * 取舍与宿主侧一致：主机名只认 `localhost`，其余**未知即按「不只回环」**
 * 处理（宁可多提示，不漏暴露风险）。
 *
 * @param {GatewayStatus | null | undefined} status
 * @returns {boolean}
 */
export function gatewayLoopbackOnly(status) {
  const host = status?.address?.host;
  if (typeof host !== 'string' || host.trim() === '') return true;
  return isLoopbackHost(host);
}

/**
 * `running: true` 但 `address === null`。
 *
 * ⚠️ **这是合法组合**（2026-10-22 对抗审计 m-1）：宿主侧 `running`（`isGatewayRunning()`）
 * 与 `address`（`gatewayAddress()`）是**两次独立 `degrade`**，任一次抛错都会让对应字段为空
 * ⇒「在跑」与「拿不到地址」可以同时成立。
 *
 * 旧实现在这种情况下会：
 * - `isWildcardHost(undefined)` 抛 `TypeError` ⇒ **整个状态面板崩**（已修：
 *   `normalizeHostForCompare` 对非字符串返回空串）；
 * - 修了不崩之后仍会输出「只绑定 127.0.0.1」—— 而开关可能是**开着的**
 *   ⇒ 又一条与事实相反的安全声明（IKL7UN 那条纪律：暴露面变了就必须明说）。
 *
 * ⇒ 判据：**地址未知时不得声称任何暴露面**，只能如实说「拿不到地址」。
 */
function gatewayAddressUnknown(status) {
  if (status?.running !== true) return false;
  const address = status?.address;
  return address === null || address === undefined
    || typeof (address).host !== 'string' || (address).host.trim() === '';
}

/**
 * 绑了**非回环**地址时的提示行（issue IKL7UN）。
 *
 * ## 为什么这条必须存在
 *
 * 面板里原有的安全声明是常量：「网关只绑定 127.0.0.1」。host 可配之后，用户
 * 完全可能（容器化部署下**必须**）把它设成容器桥接 IP —— 此时那句声明就是
 * 错误陈述，而错误的后果是双向的：
 *
 * - 「只绑回环」⇒ 用户以为「外部连不上是设计如此」，放弃排查；
 * - 「已绑对外地址」却不说 ⇒ 用户以为「同机隔离仍然成立」，把网关配进
 *   浏览器端工具或扩展（面板脚注里点名警告的正是这件事）。
 *
 * ⚠️ **必须点名「宿主」**：容器化部署下经端口映射可达的**不止同网络容器**，
 * 宿主本身也在暴露面内（红队用 network namespace + bridge 实测：同 bridge
 * 的另一个容器与宿主都能连到，跨 bridge 网络才被隔离）。只说「同网络」会把
 * 宿主漏掉，而宿主恰恰是用户最可能低估的那一端。
 *
 * ⚠️ 必须同时给出**怎么改回去**：只说「暴露面变大了」会让用户卡在
 * 「那我该填什么」上，而他填的就是本 issue 的正解（容器自身 IP）。
 *
 * ⚠️ **纯文本，不得出现 `**`**：这些文案渲染进 React 文本节点，markdown 的
 * `**加粗**` 会**原样显示星号**（本仓库已有同型事故，见 `clineExhaustedAdvice`
 * 的三条规矩）。有用例 `not.toContain('**')` 守着。
 *
 * @param {GatewayStatus} status 必定带 address（调用方已判过 running）
 * @returns {string}
 */
export function nonLoopbackNotice(status) {
  const address = status?.address;
  const host = typeof address?.host === 'string' && address.host.trim() !== '' ? address.host : '非回环地址';
  return `监听地址是 ${host}（不再是本机回环）：只应在容器/端口映射或局域网共享场景使用，`
    + '此时同一网络内的其它设备与宿主都能连到这个端口。仅本机使用时关掉「允许局域网访问」'
    + '开关即可立即恢复；若地址来自 DSH_OPENAI_GATEWAY_HOST，把它改回 127.0.0.1 并重启。';
}

/**
 * 弹窗末尾那条**安全脚注**（不属于三段中的任何一段）。
 *
 * ## 为什么必须按实际监听地址分支（issue IKL7UN）
 *
 * 原文案是常量：「网关只绑定 127.0.0.1，但这挡不住同机的其它用户或进程 ——
 * 真正的隔离靠密钥，不要把它配置进任何浏览器端工具或扩展。」
 *
 * `DSH_OPENAI_GATEWAY_HOST` 一旦可配，这句话在绑了桥接 IP 的部署里就**前后
 * 矛盾**：前半句说「只绑定 127.0.0.1」（错），后半句却警告「同机其它用户也能
 * 连」—— 用户读到矛盾的说明时最可能的反应是**两边都不信**。
 *
 * ⚠️ 回环分支必须**逐字节保留**原文案：它是用户 2026-10-04 定下的措辞，
 * 且该分支覆盖绝大多数（非容器）部署 —— 改它等于无故改动既有 UI 文案。
 *
 * ⚠️ 非回环分支**必须点名宿主**（红队 netns 实测宿主可达），且**不得出现
 * `**`**（会原样显示星号，见 {@link nonLoopbackNotice} 的同条理由）。
 *
 * @param {GatewayStatus | null | undefined} status
 * @returns {string}
 */
export function gatewayFootnote(status) {
  // ⚠️ **地址未知时不得声称任何暴露面**（2026-10-22 m-1）：
  //    旧实现会落到最后那句「只绑定 127.0.0.1」，而开关可能开着 ⇒
  //   与事实相反的安全声明。
  if (gatewayAddressUnknown(status)) {
    return '网关正在运行，但本次读不到它的监听地址 —— 无法确认它只绑了回环。'
      + '若你打开了「允许局域网访问」，请按已开启对待（隔离只靠密钥）。';
  }
  if (status?.running && !gatewayLoopbackOnly(status)) {
    const host = typeof status.address?.host === 'string' ? status.address.host : '非回环地址';
    return `网关绑定在 ${host}，同一网络内的其它设备与宿主都能连到该端口 —— 隔离只靠密钥，`
      + '不要把它配置进任何浏览器端工具或扩展。仅本机使用时关掉「允许局域网访问」'
      + '开关即可恢复；若地址来自 DSH_OPENAI_GATEWAY_HOST，把它改回 127.0.0.1 并重启。';
  }
  return '网关只绑定 127.0.0.1，但这挡不住同机的其它用户或进程 —— 真正的隔离靠密钥，'
    + '不要把它配置进任何浏览器端工具或扩展。';
}

/**
 * 弹窗里的状态说明行。
 *
 * @param {GatewayStatus | null | undefined} status
 * @returns {string[]}
 */
export function gatewayStatusLines(status) {
  if (!status) return ['正在读取网关状态…']
  if (status.blockedByEnv) {
    return [
      '已被环境变量 DSH_OPENAI_GATEWAY_ENABLED 停用，网关不会监听端口。',
      '在下面的开关里做出的选择会被记住，但需要先取消该环境变量才会生效。',
    ]
  }
  if (status.running) {
    const endpoint = gatewayEndpoint(status)
    return [
      // ⚠️ 用户 2026-10-04 要求精简（原三句「网关正在运行 / 把外部客户端的… /
      // 地址：…」合并成下面这组短行）。**语义必须保住两条**：
      //   1. 推荐 CC Switch —— 它是本仓库对 Codex/Cline 那类客户端的既有推荐入口；
      //   2. **两种协议都要点名**：Responses API 是后加的，不说就没人知道它存在。
      // ⚠️ 措辞不得写成「可切换」：两个端点同时都在，没有互斥开关（用例会红）。
      '推荐使用 CC Switch 进行网关配置。',
      '协议支持：OpenAI Chat Completions 与 OpenAI Responses API。',
      // 地址单列一行（带端口），它是用户要抄走的东西。
      endpoint ? `API 请求地址：${endpoint}` : '',
      // ⚠️ 绑 0.0.0.0（局域网开关）时，抄走的字面量在任何设备上都连不上
      // （0.0.0.0 不是一台具体设备的地址）——必须当场说明要换成什么。
      // 判据复用宿主侧 isWildcardHost（与本文件其它 host 判据同源）。
      isWildcardHost(status.address?.host) && gatewayPublicEndpoint(status) === ''
        ? '其它设备请把地址里的 0.0.0.0 换成本机的局域网 IP（ipconfig 可查）。'
        : '',
      // ⚠️ 暴露面变了必须**明说**（issue IKL7UN）。原先「只绑定 127.0.0.1」是
      // 常量文案，host 可配之后它就是错误陈述 —— 用户会以为「外面连不上是
      // 设计如此」而放弃排查。反之，回环部署下**不加这句**，避免把刚精简过的
      // 三行文案重新撑肿（精简是用户 2026-10-04 的明确要求）。
      gatewayLoopbackOnly(status) ? '' : nonLoopbackNotice(status),
    ].filter(Boolean)
  }
  if (status.enabled) {
    return [
      '已选择开启，但网关当前没有在监听。',
      // ⚠️ 有真实原因时**如实转述**（Issue #11 建议 ②）。原先这句「最常见的原因
      // 是端口被其它程序占用」是**猜的**：当真实原因是「配置/密钥初始化失败」或
      // 「插件没注册工厂」时，用户会照着它去查端口，永远查不出问题 —— 报障者正是
      // 因此把它误读成 API-key 问题。宿主侧现在回传 `lastError`。
      ...(gatewayFailureReason(status) !== ''
        ? [`启动失败的原因：${gatewayFailureReason(status)}`]
        : ['最常见的原因是端口被其它程序占用 —— 换 DSH_OPENAI_GATEWAY_PORT 后重启即可。']),
    ]
  }
  return ['网关已关闭，不会监听任何端口。']
}

/**
 * 开关是否可点。
 *
 * ⚠️ 被 env 停用时**禁用**而不是「点了没反应」：让用户完成一次明知无效的操作，
 * 比直接说清「这里改不动、原因是什么」更让人困惑。
 *
 * @param {GatewayStatus | null | undefined} status
 * @returns {boolean}
 */
export function gatewaySwitchDisabled(status) {
  if (!status) return true
  return status.blockedByEnv
}

/**
 * 「允许局域网访问」开关是否可点。
 *
 * ⚠️ **只在 env 显式给了 `DSH_OPENAI_GATEWAY_HOST` 时禁用**：那一刻开关翻成
 * 什么都改变不了监听地址（env 是运维口径，优先级更高），「打开了却没生效」比
 * 「禁用并解释」更让人困惑 —— 与主开关被 `blockedByEnv` 禁用的同一取舍。
 * 网关总开关关闭时**不禁用**：用户可以先选好，打开总开关时立即生效。
 *
 * @param {GatewayStatus | null | undefined} status
 * @returns {boolean}
 */
export function gatewayAllowLanSwitchDisabled(status) {
  if (!status) return true
  return status.hostFromEnv === true
}

/**
 * 「允许局域网访问」开关行下的说明文案。
 *
 * ⚠️ 两件事必须说清，否则用户要么不知道暴露面变了多大，要么不知道隔离靠什么：
 * 1. 打开 = 绑 **0.0.0.0**（全部网卡），同一局域网的设备都能连到网关；
 * 2. 隔离**只靠 API Key** —— 浏览器端工具/扩展不要配（面板脚注同款警告）。
 *
 * ⚠️ 纯文本，不得出现 `**`（会原样显示星号，见 `nonLoopbackNotice` 的同条理由）。
 *
 * @param {GatewayStatus | null | undefined} status
 * @returns {string}
 */
export function gatewayAllowLanHint(status) {
  if (!status) return ''
  if (status.hostFromEnv) {
    return '已由环境变量 DSH_OPENAI_GATEWAY_HOST 显式指定监听地址，本开关此刻不生效；'
      + '删除该环境变量并重启 DSH 后才能用这里的选择。'
  }
  // ⚠️⚠️ **必须同时判 `running`**（2026-10-22 对抗审计 P2）。
  //
  // 只判 `allowLan` 会在「用户打开了开关、但网关总开关关着 / 端口被占 / env 停用」时
  // 输出「**已监听**全部网卡」—— 而那是**错误的安全陈述**（谎报暴露），并把它与同一
  // 弹窗里另外两条文案直接矛盾起来：
  //   - `gatewayStatusLines` 说「网关已关闭，不会监听任何端口」；
  //   - `gatewayFootnote` 说「网关只绑定 127.0.0.1」。
  // ⇒ 三条文案对「现在到底在不在监听」给出三种答案。
  //
  // ⚠️ 这正是本仓 IKL7UN 反复记的那种「面板输出它自己声称要消除的错误安全陈述」，
  //   只是方向反了（这次是**谎报暴露**而不是谎报安全）。
  // ⚠️ 同一文件里 `gatewayAllowLanToggleNotice` **已经**判了 `running` ⇒ 这是
  //   「同一语义两套判据」的实例，本次把 hint 这条补齐到同口径。
  if (status.allowLan && status.running) {
    return '已监听全部网卡（0.0.0.0）：同一局域网内的设备都能连到网关，隔离只靠 API Key'
      + '——不要把它配置进任何浏览器端工具或扩展。'
  }
  if (status.allowLan) {
    // 已选择但**没在监听** ⇒ 如实说「还没生效」，绝不谎报「已监听」。
    return '已选择允许局域网访问（0.0.0.0），但网关当前没有在监听：'
      + '打开网关总开关后才会真正绑定全部网卡。'
  }
  return '默认只绑定 127.0.0.1，仅本机能访问。打开后网关改绑 0.0.0.0，'
    + '同一局域网内的设备可凭 API Key 连到网关。'
}

/**
 * 局域网开关切换成功后的一句提示。
 *
 * @param {GatewayStatus | null | undefined} status 切换后的状态
 * @param {boolean} nextAllowLan 用户想要的状态
 * @returns {string}
 */
export function gatewayAllowLanToggleNotice(status, nextAllowLan) {
  if (status?.hostFromEnv) {
    return '选择已保存，但 DSH_OPENAI_GATEWAY_HOST 已显式指定监听地址，本开关此刻不生效。'
  }
  if (!nextAllowLan) {
    if (status?.running) return `已恢复默认监听：${gatewayEndpoint(status)}`
    return '已恢复只绑定 127.0.0.1（网关当前未在监听）。'
  }
  if (status?.running) {
    // ⚠️ 端口不能写死 8326：它可被 `DSH_OPENAI_GATEWAY_PORT` 改过。写死会让用户
    //    照抄一个连不上的地址（与本文件 `gatewayEndpoint` 立的纪律同源 —— 那边
    //    也是因为这个原因才从状态里取端口，而不是拼常量）。
    const port = status?.address?.port
    return Number.isInteger(port)
      ? `已改绑 0.0.0.0：其它设备用「这台电脑的局域网 IP:${port}/v1」+ API Key 访问。`
      : '已改绑 0.0.0.0：其它设备用「这台电脑的局域网 IP + 网关状态页显示的端口」+ API Key 访问。'
  }
  // ⚠️ 翻 LAN 开关**自己就可能失败**（Issue #11 的真实场景：换绑要关旧实例再重建，
  // 而 close() 曾挂在在途连接上）。原先这里一律说「先打开网关总开关」—— 但总开关
  // **本来就是开的**（用户刚点的是 LAN 开关），于是这条提示把用户指向一个已经满足
  // 的条件，真正的失败原因被藏起来。与 `gatewayToggleNotice` 同轴。
  if (gatewayFailureReason(status) !== '') {
    return `已保存选择，但网关换绑失败：${gatewayFailureReason(status)}`
  }
  return '已选择允许局域网访问，但网关当前没有在监听（先打开网关总开关）。'
}

/**
 * 切换成功后给出的一句提示。
 *
 * @param {GatewayStatus | null | undefined} status 切换后的状态
 * @param {boolean} nextEnabled 用户想要的状态
 * @returns {string}
 */
export function gatewayToggleNotice(status, nextEnabled) {
  if (status?.blockedByEnv) {
    return '选择已保存，但 DSH_OPENAI_GATEWAY_ENABLED 仍在停用网关，取消它才会生效。'
  }
  if (!nextEnabled) return '网关已关闭，不再监听端口。'
  if (status?.running) return `网关已启动：${gatewayEndpoint(status)}`
  // ⚠️ 同样如实转述真实原因（Issue #11 建议 ②）：只说「请检查端口」会把
  // 「密钥/配置初始化失败」这类原因藏起来，用户永远查不到。
  if (gatewayFailureReason(status) !== '') {
    return `已选择开启，但网关启动失败：${gatewayFailureReason(status)}`
  }
  return '已选择开启，但网关没有在监听，请检查端口是否被占用。'
}
