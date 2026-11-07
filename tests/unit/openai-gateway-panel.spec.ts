import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  copyToClipboard,
  formatModelIdList,
  gatewayAllowLanHint,
  gatewayAllowLanSwitchDisabled,
  gatewayAllowLanToggleNotice,
  gatewayApiKeyHint,
  gatewayButtonLabel,
  gatewayButtonTitle,
  gatewayCardExpanded,
  gatewayCardLabel,
  gatewayEndpoint,
  gatewayLoopbackOnly,
  gatewayFootnote,
  nonLoopbackNotice,
  gatewayEffortRow,
  gatewayEffortRows,
  gatewayEffortsCurl,
  gatewayEffortsEmptyHint,
  gatewayEffortsHint,
  gatewayEffortsHintLines,
  gatewayEffortsText,
  gatewayModelKeyOf,
  gatewayProviderOf,
  groupGatewayEntries,
  groupGatewayModels,
  GATEWAY_CARD_AUTOCOLLAPSE_AT,
  filterEffortRows,
  matchesEffortQuery,
  gatewayModelsCurl,
  gatewayModelsEmptyHint,
  gatewayModelsHint,
  gatewayStatusLines,
  gatewaySwitchDisabled,
  gatewayToggleNotice,
  modelCapabilityBadge,
  modelSupportsImage,
} from '../../plugin-src/client/openai-gateway-panel.js'
import { matchesModelQuery } from '../../plugin-src/client/model-filter.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(HERE, '../../plugin-src/client/jet-hub.js'), 'utf8')

/**
 * 剥掉源码里的注释。
 *
 * ⚠️ 断言「源码里不得出现某个选择器」时必须先剥注释：本文件多处注释**特意**写着
 * 「第一版是 `.dim-jh-gatewayModal .dim-jh-gatewayModelRow .dim-jh-modelId`，那是错的」
 * —— 直接 `not.toContain` 会把**这句警戒**当成缺陷命中（假红）。
 * 这个坑本仓库踩过多次（`'鉴权用 Authorization` / `额度按**出口 IP** 计算` 同类）。
 */
const stripCommentsOf = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

const RUNNING = { enabled: true, running: true, blockedByEnv: false, address: { host: '127.0.0.1', port: 8326 } }
const OFF = { enabled: false, running: false, blockedByEnv: false, address: null }
const ENV_BLOCKED = { enabled: true, running: false, blockedByEnv: true, address: null }
const WANTED_BUT_DOWN = { enabled: true, running: false, blockedByEnv: false, address: null }

describe('本机网关面板的文案与判定', () => {
  it('按钮文字足够短，且运行中带运行态提示', () => {
    expect(gatewayButtonLabel(RUNNING)).toBe('网关 ●')
    expect(gatewayButtonLabel(OFF)).toBe('网关')
    // 页头按钮排成一行，文字过长会把右端「关闭」挤到第二行。
    expect(gatewayButtonLabel(RUNNING).length).toBeLessThanOrEqual(4)
  })

  it('状态未读取时按钮退化为「网关」而不是空白', () => {
    expect(gatewayButtonLabel(null)).toBe('网关')
    expect(gatewayButtonTitle(null)).toContain('读取状态中')
    expect(gatewayStatusLines(null)).toEqual(['正在读取网关状态…'])
  })

  it('地址只在真监听时给出，且端口取自宿主侧而非写死 8326', () => {
    const custom = { ...RUNNING, address: { host: '127.0.0.1', port: 9999 } }
    expect(gatewayEndpoint(custom)).toBe('http://127.0.0.1:9999/v1')
    // ⚠️ 端口可被 DSH_OPENAI_GATEWAY_PORT 改过；address 为空时编造 8326 会让
    // 用户拿一个连不上的地址去配客户端。
    expect(gatewayEndpoint(OFF)).toBe('')
    expect(gatewayEndpoint(WANTED_BUT_DOWN)).toBe('')
    expect(gatewayEndpoint(null)).toBe('')
  })

  /**
   * Issue IKL7UN：host 也可配了，面板必须展示**真实监听地址**。
   *
   * ⚠️ 判据里必须同时有 IPv6 那条：`http://${host}:${port}` 的朴素插值对
   * `::1` 会拼出 `http://::1:8326/v1`（非法 URL，端口被当成 IPv6 的一段），
   * 只测 IPv4 的话这种实现照样绿。
   */
  it('★ 地址用宿主侧的真实 host（容器里是桥接 IP），IPv6 必须带方括号', () => {
    expect(gatewayEndpoint({ ...RUNNING, address: { host: '172.21.0.8', port: 8326 } }))
      .toBe('http://172.21.0.8:8326/v1')
    expect(gatewayEndpoint({ ...RUNNING, address: { host: '::1', port: 8326 } }))
      .toBe('http://[::1]:8326/v1')
    // ⚠️ 显示出来的地址必须能被 URL 解析 —— 这是「用户能抄走」的机械判据，
    // 比逐字符比较更强（对实现方式中立）。
    for (const host of ['127.0.0.1', '172.21.0.8', '::1', 'fe80::1']) {
      expect(() => new URL(gatewayEndpoint({ ...RUNNING, address: { host, port: 8326 } })), host).not.toThrow()
    }
  })

  /**
   * ⚠️ 安全声明不得说谎（issue IKL7UN 带出来的**文案正确性**问题）。
   *
   * 面板里原有「网关只绑定 127.0.0.1 / 不起作用」这类**常量**文案，它在 host
   * 可配之后会变成错误陈述：用户绑了容器桥接 IP 时，看到「只绑 127.0.0.1」
   * 会以为「外面连不上是设计如此」，从而把真实故障排查方向带偏。
   */
  /**
   * ⚠️ 回环判据必须与宿主侧**同源**（审计实测：两套判据立刻漂移）。
   *
   * 客户端初版自己写 `/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/` + `=== '[::1]'`，
   * 于是 `127.1` / `0:0:0:0:0:0:0:1` / `::ffff:127.0.0.1` / `localhost`
   * 这些**内核实测只在回环可达**的写法被判成「已对外暴露」⇒ 面板输出它自己
   * 声称要消除的那种错误安全陈述。这批逐条锁住。
   */
  it('★ 回环判据：127.0.0.0/8、::1、IPv4-mapped 回环、localhost 都算回环', () => {
    for (const host of [
      '127.0.0.1', '127.0.0.2', '127.1', '127.0.0.1.', '::1', '[::1]',
      '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'localhost',
    ]) {
      expect(gatewayLoopbackOnly({ ...RUNNING, address: { host, port: 8326 } }), host).toBe(true)
    }
    for (const host of ['172.21.0.8', '192.168.3.125', '0.0.0.0', '::', '::ffff:0:0', 'fe80::1', 'host.docker.internal']) {
      expect(gatewayLoopbackOnly({ ...RUNNING, address: { host, port: 8326 } }), host).toBe(false)
    }
    // address 缺失时按回环（此时根本没有「已暴露」这件事可说，且不该在没运行时报警）。
    expect(gatewayLoopbackOnly(OFF)).toBe(true)
    expect(gatewayLoopbackOnly(null)).toBe(true)
  })

  it('★ 绑了非回环地址时，状态行必须如实说明「不再只有本机可达」', () => {
    const bridged = { ...RUNNING, address: { host: '172.21.0.8', port: 8326 } }
    // 正例：回环部署下**不得**多出这句噪音（用户 2026-10-04 刚要求精简过文案）。
    expect(gatewayStatusLines(RUNNING).join()).not.toContain('172.21')
    // 反例：绑了桥接 IP 必须点名该地址，让用户意识到暴露面变了。
    expect(gatewayStatusLines(bridged).join()).toContain('172.21.0.8')
    // ⚠️ 必须给出**怎么做**（怎么改回去），而不只是陈述事实。
    expect(gatewayStatusLines(bridged).join()).toMatch(/DSH_OPENAI_GATEWAY_HOST/)
  })

  /**
   * ★ 安全脚注必须按实际监听地址分支。
   *
   * ⚠️ 这条锁的是**文案不能说谎**，不是排版：
   * 常量脚注「网关只绑定 127.0.0.1」在绑了桥接 IP 的部署里是错误陈述，
   * 而且它与同一句的后半段（「同机其它用户也能连」）自相矛盾。
   */
  it('★ 安全脚注：回环部署逐字节保留原文案，非回环必须改名并给出改回去的做法', () => {
    // ① 回环分支逐字节等于用户 2026-10-04 定下的措辞（改它就是无故改 UI 文案）。
    const original = '网关只绑定 127.0.0.1，但这挡不住同机的其它用户或进程 —— 真正的隔离靠密钥，'
      + '不要把它配置进任何浏览器端工具或扩展。'
    expect(gatewayFootnote(RUNNING)).toBe(original)
    // 未运行时同样是回环口径（此时没有「已暴露」可言，且拿不到 address）。
    expect(gatewayFootnote(OFF)).toBe(original)
    expect(gatewayFootnote(null)).toBe(original)

    // ② 非回环分支：必须点名真实地址、不得再声称「只绑定 127.0.0.1」、并给出改法。
    const bridged = { ...RUNNING, address: { host: '172.21.0.8', port: 8326 } }
    const text = gatewayFootnote(bridged)
    expect(text).toContain('172.21.0.8')
    expect(text).not.toContain('只绑定 127.0.0.1')
    expect(text).toContain('DSH_OPENAI_GATEWAY_HOST')
    // ⚠️ 「隔离靠密钥」这条核心告诫**不许丢** —— 它是这段脚注存在的首要理由。
    expect(text).toContain('密钥')
    // ⚠️ 「不要配置进浏览器端工具或扩展」也必须留着（暴露面变大时它更关键）。
    expect(text).toContain('浏览器端工具或扩展')
    // ⚠️ **必须点名宿主**（红队 netns 实测：宿主经端口映射可达，而它既不是
    // 「同网络容器」也不是「同机进程」，只说「同网络」会把它漏掉）。
    expect(text).toContain('宿主')
    expect(nonLoopbackNotice(bridged)).toContain('宿主')
  })

  /**
   * ⚠️⚠️ **这些文案渲染进 React 文本节点，markdown 的 `**` 会原样显示星号**。
   *
   * 本仓库已有同型事故（`clineExhaustedAdvice`：用户截图里就是 `**当日免费额度**`，
   * 见 `docs/agent-notes/providers-cline.md` 的三条规矩）。我在初版非回环脚注里
   * 写了 `隔离**只**靠密钥` —— 那会原样显示星号。
   *
   * 判据用**真实函数的返回值**（而不是源码文本），对实现方式中立。
   */
  /**
   * ★★ **`running: true` + `address: null` 不得崩、也不得说反话**
   * （2026-10-22 对抗审计 m-1）。
   *
   * ## 为什么这是**合法组合**而不是脏数据
   *
   * 宿主侧 `running`（`isGatewayRunning()`）与 `address`（`gatewayAddress()`）是
   * **两次独立 `degrade`**，任一次抛错都让对应字段为空。
   *
   * ## 两条真缺陷（实测）
   *
   * 1. **崩**：`isWildcardHost(undefined)` 走 `normalizeHostForCompare` 抛
   *    `TypeError: Cannot read properties of undefined (reading 'normalize')`
   *    ⇒ 整个网关状态面板直接不渲染（用户只看到一片空白）。
   * 2. **说反话**：修了不崩之后，`gatewayFootnote` 仍落到「只绑定 127.0.0.1」
   *    那句，而「允许局域网访问」开关可能是**开着的** ⇒ 又一条与事实
   *    相反的安全声明（正是 IKL7UN 那条纪律要消除的）。
   *
   * ⚠️ 判据分两层：**不崩**（两个函数都能返回）+ **不说反话**
   * （不得出现「只绑定 127.0.0.1」）。只测第一层会让第二条漏掉。
   */
  it('★★ running:true + address:null 不崩、且不得声称「只绑定 127.0.0.1」', () => {
    const unknown = { ...RUNNING, allowLan: true, address: null }
    // ① 不崩（两个入口都要跑一遍）
    expect(() => gatewayFootnote(unknown)).not.toThrow()
    expect(() => gatewayStatusLines(unknown)).not.toThrow()
    // ② 不得说反话
    expect(
      gatewayFootnote(unknown),
      '地址未知时不得声称只绑了回环（开关可能开着）',
    ).not.toContain('只绑定 127.0.0.1')
    // ③ 修法本身也要有城市：必须如实说「读不到地址」
    expect(gatewayFootnote(unknown)).toContain('读不到它的监听地址')
    // ④ 反向对照：正常回环仍必须说「只绑定 127.0.0.1」
    expect(gatewayFootnote(RUNNING), '不得把回环那句改掉').toContain('只绑定 127.0.0.1')
  })
  it('★★ 面板文案一律不得含 markdown 标记（星号会原样显示）', () => {
    const bridged = { ...RUNNING, address: { host: '172.21.0.8', port: 8326 } }
    const texts = [
      gatewayFootnote(RUNNING), gatewayFootnote(bridged), gatewayFootnote(null),
      nonLoopbackNotice(bridged),
      ...gatewayStatusLines(RUNNING), ...gatewayStatusLines(bridged),
      ...gatewayStatusLines(WANTED_BUT_DOWN), ...gatewayStatusLines(ENV_BLOCKED),
      gatewayToggleNotice(bridged, true), gatewayToggleNotice(RUNNING, true),
      gatewayToggleNotice(OFF, false), gatewayToggleNotice(ENV_BLOCKED, true),
      gatewayButtonTitle(RUNNING), gatewayButtonTitle(bridged),
      gatewayApiKeyHint({ fromEnv: true, path: null, value: 'k' }),
      gatewayApiKeyHint({ fromEnv: false, path: 'C:/x/api-key', value: 'k' }),
      gatewayEndpoint(RUNNING), gatewayEndpoint(bridged),
      gatewayModelsCurl(gatewayEndpoint(RUNNING)), gatewayEffortsCurl(gatewayEndpoint(bridged)),
    ]
    for (const text of texts) {
      expect(text, text).not.toContain('**')
    }
  })

  it('「已选择开启但没监听」必须与「运行中」说不同的话', () => {
    // 这两种状态在 UI 上都表现为 enabled=true，只靠 enabled 推导会显示
    // 「已开启」而用户连不上。
    expect(gatewayStatusLines(RUNNING).join()).toContain('CC Switch')
    expect(gatewayStatusLines(WANTED_BUT_DOWN).join()).toContain('没有在监听')
    expect(gatewayStatusLines(WANTED_BUT_DOWN).join()).toContain('端口')
  })

  it('★ 运行中的三行文案精简且信息完整（用户 2026-10-04 要求）', () => {
    // 用户报障：网关页「非常臃肿」，要求精简这第一段。
    // 精简**不许把信息减掉**，故逐项锁住三行各自的职责：
    const lines = gatewayStatusLines(RUNNING)
    expect(lines).toHaveLength(3)
    // ① 指向 CC Switch（本仓库对 Codex/Cline 那类客户端的既有推荐入口）
    expect(lines[0]).toContain('CC Switch')
    // ② 两种协议都点名（Responses API 是后加的，不说就没人知道它存在）
    expect(lines[1]).toContain('Chat Completions')
    expect(lines[1]).toContain('Responses API')
    // ③ 地址单独一行、带真实端口（端口可被 env 改过）
    expect(lines[2]).toContain('http://127.0.0.1:8326/v1')
    // ⚠️ 精简后不得留下旧版的冗长句式。
    expect(lines.join()).not.toContain('把外部客户端的')
  })

  it('★ 运行中必须说清「两种协议同时可用」（Responses API 是后加的，面板不说就没人知道）', () => {
    const lines = gatewayStatusLines(RUNNING).join()
    expect(lines).toContain('Chat Completions')
    expect(lines).toContain('Responses API')
    // ⚠️ 措辞不得写成「可切换」：两端点同时都在，没有互斥开关。
    expect(lines).not.toContain('切换')
  })

  it('被 env 停用时开关禁用，且明确指出原因与 env 名', () => {
    expect(gatewaySwitchDisabled(ENV_BLOCKED)).toBe(true)
    expect(gatewaySwitchDisabled(RUNNING)).toBe(false)
    expect(gatewaySwitchDisabled(OFF)).toBe(false)
    expect(gatewayButtonTitle(ENV_BLOCKED)).toContain('DSH_OPENAI_GATEWAY_ENABLED')
    expect(gatewayStatusLines(ENV_BLOCKED).join()).toContain('DSH_OPENAI_GATEWAY_ENABLED')
  })

  it('★ 四条「没在监听」文案必须**全部**转述 lastError（Issue #11 审计 P1-1）', () => {
    // ⚠️ 本文件有**四条**文案都在描述「已选择开启但没在监听」。PR 起初只给两条
    // 接了 `lastError`，另两条仍印「通常是端口被占用」这个**猜测** —— 这正是
    // 本 PR 声称要消除的那句话，而 `gatewayButtonTitle` 是**真实渲染的页头
    // tooltip**。这条用例把四条一起钉住，防止将来只补其中几条。
    const reason = 'listen EADDRINUSE: address already in use'
    const failed = {
      enabled: true,
      running: false,
      blockedByEnv: false,
      allowLan: false,
      hostFromEnv: false,
      address: null,
      apiKey: null,
      models: [],
      modelsSource: 'none',
      lastError: { kind: 'start-failed', reason, at: 1 },
    }
    // ① 状态行
    expect(gatewayStatusLines(failed).join('\n')).toContain(reason)
    // ② 主开关切换提示
    expect(gatewayToggleNotice(failed, true)).toContain(reason)
    // ③ 页头 tooltip（审计指出这条此前完全没接）
    expect(gatewayButtonTitle(failed)).toContain(reason)
    // ④ 局域网开关切换提示（审计指出这条此前把用户指向「先开总开关」，归因错误）
    expect(gatewayAllowLanToggleNotice(failed, true)).toContain(reason)

    // ⚠️ 反向对照：没有 lastError 时四条都必须回落到**通用**提示（而不是空串/
    // 也不该凭空编原因）——否则上面的断言在「无条件都说失败」的实现下也会绿。
    const noReason = { ...failed, lastError: null }
    expect(gatewayStatusLines(noReason).join('\n')).toContain('端口被其它程序占用')
    expect(gatewayToggleNotice(noReason, true)).toContain('端口是否被占用')
    expect(gatewayButtonTitle(noReason)).toContain('端口被占用')
    expect(gatewayAllowLanToggleNotice(noReason, true)).toContain('先打开网关总开关')
  })

  it('状态未读取时开关禁用，避免用户对着未知状态做操作', () => {
    expect(gatewaySwitchDisabled(null)).toBe(true)
  })

  it('切换提示如实反映「没跑起来」，不谎报成功', () => {
    expect(gatewayToggleNotice(RUNNING, true)).toContain('http://127.0.0.1:8326/v1')
    expect(gatewayToggleNotice(OFF, false)).toContain('已关闭')
    expect(gatewayToggleNotice(WANTED_BUT_DOWN, true)).toContain('端口')
    expect(gatewayToggleNotice(ENV_BLOCKED, true)).toContain('DSH_OPENAI_GATEWAY_ENABLED')
  })

  it('客户端确实接上了宿主侧的两个网关端点', () => {
    expect(source).toContain("rpcCall('gateway.getEnabled'")
    expect(source).toContain("rpcCall('gateway.setEnabled'")
  })
})

describe('凭据的展示与复制', () => {
  it('来自环境变量时不显示文件路径（那一刻根本没有文件）', () => {
    const hint = gatewayApiKeyHint({ fromEnv: true, path: null, value: 'k' })
    expect(hint).toContain('DSH_OPENAI_GATEWAY_API_KEY')
    expect(hint).not.toContain('api-key')
  })

  it('来自文件时给出准确路径，帮用户自己核对/备份', () => {
    expect(gatewayApiKeyHint({ fromEnv: false, path: 'C:/Users/Jet/.dsh/openai-gateway/api-key', value: 'k' }))
      .toContain('C:/Users/Jet/.dsh/openai-gateway/api-key')
  })

  it('尚未生成过密钥时说明「启用后自动生成」，而不是给一个必然 401 的占位串', () => {
    const hint = gatewayApiKeyHint(null)
    expect(hint).toContain('自动生成')
  })

  it('复制失败时返回 false，调用方据此退回「显示明文」而不是无声无息', async () => {
    // 无 Clipboard API（node 环境）必须返回 false 而不是抛错。
    expect(await copyToClipboard('secret')).toBe(false)
  })

  it('复制成功时返回 true', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    try {
      expect(await copyToClipboard('secret')).toBe(true)
      expect(writeText).toHaveBeenCalledWith('secret')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('写剪贴板被拒（权限/非用户手势）时返回 false 而不是抛到 UI', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    try {
      expect(await copyToClipboard('secret')).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  // ⚠️ 这条锁的是「局域网 http 打不开复制」那个报障的修复（2026-10-23）。
  //    `navigator.clipboard` 只在安全上下文存在；用 `http://<内网 IP>` 访问时它是
  //    `undefined`，而此时**必须**降级到 `execCommand('copy')`，不能直接返回 false。
  it('非安全上下文（局域网 http，没有 navigator.clipboard）时降级到 execCommand', async () => {
    const execCommand = vi.fn().mockReturnValue(true)
    const appended: any[] = []
    const body = {
      appendChild: (el: any) => { el.parentNode = body; appended.push(el); return el },
      removeChild: (el: any) => { el.parentNode = null; return el },
    }
    const textarea = {
      value: '',
      style: {} as Record<string, string>,
      parentNode: null as any,
      setAttribute: vi.fn(),
      select: vi.fn(),
      setSelectionRange: vi.fn(),
    }
    const focus = vi.fn()
    vi.stubGlobal('navigator', {})  // 没有 clipboard —— 正是局域网 http 的样子
    vi.stubGlobal('document', {
      body,
      activeElement: { focus },
      createElement: vi.fn().mockReturnValue(textarea),
      execCommand,
    })
    try {
      expect(await copyToClipboard('secret')).toBe(true)
      expect(execCommand).toHaveBeenCalledWith('copy')
      // 值必须真的塞进 textarea，否则复制到的是空串
      expect(textarea.value).toBe('secret')
      // 必须真的插入 DOM 才能选中；用完必须摘掉，不能留垃圾节点
      expect(appended).toHaveLength(1)
      expect(textarea.parentNode).toBeNull()
      // 焦点要还给用户，否则键盘操作位置丢失
      expect(focus).toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('降级路径也失败时返回 false（不能让 UI 以为复制成功了）', async () => {
    const body = {
      appendChild: (el: any) => { el.parentNode = body; return el },
      removeChild: (el: any) => { el.parentNode = null; return el },
    }
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', {
      body,
      activeElement: null,
      createElement: () => ({
        value: '',
        style: {} as Record<string, string>,
        parentNode: null as any,
        setAttribute() {},
        select() {},
        setSelectionRange() {},
      }),
      execCommand: vi.fn().mockReturnValue(false),
    })
    try {
      expect(await copyToClipboard('secret')).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  // ⚠️ 2026-10-31 审计（P2 补牙）：showManualCopy 原先零覆盖 —— 删掉函数体只剩
  //    return false，全文件测试仍全绿。三层降级的核心承诺「用户总能拿到文本」
  //    不能只靠注释自律。本组三条用例直接观测第三层的 DOM 行为。
  describe('第三层手动复制面板（showManualCopy）', () => {
    /** 造一个足够真实的 DOM 桩：overlay/box/textarea/button 各自独立创建。 */
    function makeDomStub() {
      const appended: any[] = []
      const removed: any[] = []
      const documentListeners: Array<{ type: string; fn: (e: any) => void; options?: any }> = []
      /**
       * 只看**当前还挂在 body 上**的节点：legacyCopy 的 textarea 会 append 后
       * 立刻 removeChild（ parentNode=null），手动面板则一直挂着。
       * 断言「面板挂出来了」必须过滤掉前者，否则 appended[0] 是那个已摘除的
       * 隐形 textarea。
       */
      const live = () => appended.filter((el) => el.parentNode !== null)
      const makeEl = (tag: string) => {
        const listeners: Record<string, Array<(e: any) => void>> = {}
        const el: any = {
          tagName: tag,
          value: '',
          style: {} as Record<string, string>,
          parentNode: null as any,
          children: [] as any[],
          setAttribute: vi.fn((k: string, v: string) => { el[`data-attr-${k}`] = v }),
          focus: vi.fn(),
          select: vi.fn(),
          setSelectionRange: vi.fn(),
          append: (...kids: any[]) => { el.children.push(...kids) },
          remove: vi.fn(() => { removed.push(el) }),
          // 递归子树查找（真实 DOM 的 querySelector 语义的最小实现）——
          // 重复弹守卫用 overlay.querySelector('textarea') 取文本框
          querySelector: (sel: string) => {
            const tag = sel.replace(/[[\]']/g, '')
            const walk = (node: any): any => {
              for (const kid of node.children ?? []) {
                if (kid.tagName === tag) return kid
                const hit = walk(kid)
                if (hit) return hit
              }
              return undefined
            }
            return walk(el)
          },
          addEventListener: (type: string, fn: (e: any) => void) => {
            ;(listeners[type] ??= []).push(fn)
          },
          __fire: (type: string, event: any) => {
            for (const fn of listeners[type] ?? []) fn({ target: el, ...event })
          },
        }
        return el
      }
      const documentStub = {
        body: {
          appendChild: (el: any) => { el.parentNode = documentStub.body; appended.push(el); return el },
          removeChild: (el: any) => { el.parentNode = null; return el },
          // 查询选择器桩：返回当前**还挂着**的 overlay（无则 null）—— 重复弹守卫读它。
          // 同样要过滤已摘除的 legacyCopy textarea。
          querySelector: (sel: string) => (sel.includes('manual-copy')
            ? (live().find((el) => el.tagName === 'div') ?? null)
            : null),
        },
        // ⚠️ 每次createElement 给独立对象（不能用 mockReturnValue 单例）——
        //    legacyCopy 与 showManualCopy 各自创建元素，共享对象会让第二个
        //    消费者拿到被前一个污染的实例（这也正是被测实现依赖的真实语义）。
        createElement: (tag: string) => makeEl(tag),
        addEventListener: (type: string, fn: (e: any) => void, options?: any) => {
          documentListeners.push({ type, fn, options })
        },
        removeEventListener: (type: string, fn: (e: any) => void, options?: any) => {
          const i = documentListeners.findIndex((l) => l.type === type && l.fn === fn)
          if (i >= 0) documentListeners.splice(i, 1)
        },
        __documentListeners: documentListeners,
      }
      vi.stubGlobal('navigator', {})
      vi.stubGlobal('document', documentStub)
      /**
       * 面板 overlay = 当前仍挂在 body 上的 div（legacyCopy 的 textarea 已摘除，
       * 且它不是 div）。三条用例共用这一判定，避免各自摸 appended 数组下标。
       */
      const findLiveOverlay = () => live().find((el) => el.tagName === 'div')
      const liveOverlays = () => live().filter((el) => el.tagName === 'div')
      const findTextarea = (el: any): any => {
        if (el === undefined || el === null) return undefined
        if (el.tagName === 'textarea') return el
        for (const kid of el.children ?? []) {
          const hit = findTextarea(kid)
          if (hit) return hit
        }
        return undefined
      }
      return { appended, removed, documentListeners, findLiveOverlay, liveOverlays, findTextarea }
    }

    it('★ execCommand 失败 ⇒ body 上真的挂出含完整文本的 overlay（用户总能拿到文本）', async () => {
      const { findLiveOverlay, findTextarea } = makeDomStub()
      try {
        expect(await copyToClipboard('secret-key-123')).toBe(false)
        const overlay = findLiveOverlay()
        expect(overlay, '第三层必须真的往 body 挂面板').toBeDefined()
        const ta = findTextarea(overlay)
        expect(ta, '面板里必须有 textarea').toBeDefined()
        expect(ta.value, '面板必须携带完整原文').toBe('secret-key-123')
        expect(ta.setAttribute).toHaveBeenCalledWith('readonly', '')
        expect(ta.setAttribute, '密钥不是词，别让浏览器画拼写红线').toHaveBeenCalledWith('spellcheck', 'false')
        // 打开即全选（Ctrl+C 直接可用）
        expect(ta.select).toHaveBeenCalled()
        expect(ta.setSelectionRange).toHaveBeenCalledWith(0, 'secret-key-123'.length)
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('★ Escape 关闭面板且阻断冒泡（宿主 document 级的 Esc 监听不得收到事件）', async () => {
      const { documentListeners, findLiveOverlay } = makeDomStub()
      try {
        await copyToClipboard('secret')
        const overlay = findLiveOverlay()
        expect(overlay, '面板必须已挂出').toBeDefined()
        // 面板必须在 document 上注册了 capture 阶段的 keydown（否则宿主先收到 Esc）
        const captureKeydown = documentListeners.find((l) => l.type === 'keydown' && l.options?.capture === true)
        expect(captureKeydown, 'Escape 拦截必须是 capture 阶段').toBeDefined()

        // 模拟按 Esc：断言 stopPropagation 被调（阻断宿主监听）+ overlay 被移除
        const stopPropagation = vi.fn()
        const preventDefault = vi.fn()
        captureKeydown!.fn({ key: 'Escape', stopPropagation, preventDefault })
        expect(stopPropagation, '必须阻断冒泡，否则宿主的大模态会被误关').toHaveBeenCalled()
        expect(overlay.remove, 'Escape 必须关掉面板本身（而不是宿主的大模态）').toHaveBeenCalled()
        // 关闭后 document 监听必须摘掉（不泄漏）
        expect(
          documentListeners.some((l) => l.type === 'keydown' && l.options?.capture === true),
          '关闭后 keydown 监听必须移除',
        ).toBe(false)
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('★ 连点失败 ⇒ 不叠加面板（复用已有 overlay，更新内容重新全选）', async () => {
      const { liveOverlays, findTextarea } = makeDomStub()
      try {
        await copyToClipboard('first-value')
        await copyToClipboard('second-value')
        const overlays = liveOverlays()
        expect(
          overlays,
          '连点 N 次不得叠 N 个遮罩（重复弹守卫）',
        ).toHaveLength(1)
        const ta = findTextarea(overlays[0])
        expect(ta.value, '复用面板时内容要更新成最新一次的').toBe('second-value')
        expect(ta.select, '复用时重新全选').toHaveBeenCalled()
      } finally {
        vi.unstubAllGlobals()
      }
    })
  })

  it('面板默认不把密钥明文渲染进 DOM，只有点「显示明文」才出现', () => {
    // 设置页会被截图/录屏/投屏，明文默认躺在屏幕上等于把凭据带出去。
    const body = source.slice(
      source.indexOf('function GatewayPanel('),
      source.indexOf('export function JetHubPage'),
    )
    // ⚠️ 用 \s 跨空白而不是 '\n' 字面量：源文件是 CRLF，字面量匹配不上。
    // 这里验的正是「明文必须被 revealed 门控」——三元里 revealed 为真才渲染 value。
    expect(body).toMatch(/revealed\s*\?\s*React\.createElement\('code'[\s\S]*?apiKey\.value/)
    // 复制走的是同一个值，避免「显示的」与「复制的」不是同一个。
    expect(body).toContain('copyToClipboard(apiKey.value)')
    // 复制失败必须退回显示明文，不能让按钮点了没反应。
    expect(body).toMatch(/setRevealed\(true\)[\s\S]{0,80}setCopied\(false\)/)
  })

  it('★ 「API KEY：」与两个按钮在同一行（用户 2026-10-04 要求精简）', () => {
    // 旧版是三截：一行「鉴权用 Authorization: Bearer <网关 API Key>。」+
    // 下面单独一排按钮。用户要求精简成一行「API KEY：⌈复制密钥⌋⌈显示明文⌋」。
    const body = source.slice(
      source.indexOf('function GatewayPanel('),
      source.indexOf('export function JetHubPage'),
    )
    // 标签与按钮必须在**同一个容器**里（否则又变回两行）。
    //
    // ⚠️ 窗口必须收紧到 160 字：写成 400 字会**假装**锁住了 —— 把「API KEY：」
    // 挪到容器外、紧挨着的兄弟节点上（真的又变回两行）时，400 字窗口仍然命得中，
    // 变异测试里这个锁会存活。收紧后顺序也被锁死：容器 → 标签 → 复制按钮。
    expect(body).toMatch(/dim-jh-gatewayKeyRow'[\s\S]{0,160}'API KEY：'[\s\S]{0,300}'复制密钥'/)
    expect(body).toContain("'显示明文'")
    // ⚠️ 那行冗长的 Bearer 说明已移除（协议与鉴权方式在 README 里有完整说明；
    // 面板上只留用户真正要抄的两个东西：地址与密钥）。
    //
    // ⚠️ 必须匹配**带引号的字面量** `'鉴权用 Authorization`：紧邻的注释里也写着
    // 这句原文（用来说明「原先是什么」），只匹配裸短语会把注释误判成没删干净。
    expect(body).not.toContain("'鉴权用 Authorization")
  })

  it('⚠️ 没有密钥时也要给出「API KEY：」一行，而不是整块消失', () => {
    // 整块消失会让用户以为面板坏了；说清「启用后自动生成」才是指路。
    const body = source.slice(
      source.indexOf('function GatewayPanel('),
      source.indexOf('export function JetHubPage'),
    )
    expect(body).toMatch(/API KEY：尚未生成/)
  })

  it('⚠️ 没有密钥时不重复说两遍「未生成」（精简的反面就是冗余）', () => {
    // `apiKey` 为空时，「API KEY：尚未生成（启用网关时会自动创建）」已经说完，
    // 而 gatewayApiKeyHint(null) 讲的是同一件事 —— 两句并排是冗余。
    // 故来源说明那一行必须与「有密钥」同门控。
    const body = source.slice(
      source.indexOf('function GatewayPanel('),
      source.indexOf('export function JetHubPage'),
    )
    expect(body).toMatch(/apiKey\s*\?\s*React\.createElement\('p',\s*\{[^}]*\},\s*gatewayApiKeyHint\(apiKey\)\)\s*:\s*null/)
  })
})

describe('模型 ID 清单（ZCode 等不会自动扫目录的客户端靠它）', () => {
  const MODELS = [
    { id: 'codearts/GLM-5.2', name: 'GLM-5.2' },
    { id: 'codearts/glm-5.3-flash', name: 'GLM-5.3 Flash' },
    { id: 'cline/anthropic/claude-sonnet-5.5', name: 'Claude' },
  ]

  it('每行一个 ID，保持原大小写（大小写敏感，规范化会给出错误 ID）', () => {
    expect(formatModelIdList(MODELS)).toBe(
      'codearts/GLM-5.2\ncodearts/glm-5.3-flash\ncline/anthropic/claude-sonnet-5.5',
    )
  })

  it('空清单不产生空白字符串（否则「复制」按钮会复制到一个换行）', () => {
    expect(formatModelIdList([])).toBe('')
    expect(formatModelIdList(null)).toBe('')
    expect(formatModelIdList(undefined)).toBe('')
  })

  it('提示语给出数量，并点明「ID 区分大小写」这个实测踩过的坑', () => {
    const hint = gatewayModelsHint(MODELS, 'catalog')
    expect(hint).toContain('3 个')
    // ⚠️ MODELS 里是 codearts + cline 共 **2** 家（写 3 会是假红）。
    expect(hint).toContain('2 个供应商')
    expect(hint).toContain('大小写')
    // ⚠️ 「已开启」这个限定词不能丢：网关目录来自各适配器的 listModels，
    // 而它按用户在 Jet Hub 里关掉的模型过滤 —— 少了这三个字，用户会把
    // 「14 个」读成「网关总共只认这 14 个模型」，进而以为关掉的模型也调不了。
    expect(hint).toContain('共开启')
  })

  it('★ 提示语已精简到**一句**（用户 2026-10-04 第二次要求），但不许删掉会致误配的事实', () => {
    // 用户报障：这几段介绍「非常冗长」；第二轮要求「精简里面的语句」。
    const hint = gatewayModelsHint(MODELS, 'catalog')
    // ⚠️ 判据用**长度上限**而不是「恰好等于某串」：长度为 0 的空串也满足
    // 一切 toContain，故长度上限必须与下面的正向断言同用才有意义。
    // 面板宽 min(560px)，12px 字号下一行约 40 个中文字，故 60 字以内必然是 1 行。
    expect(hint.length).toBeLessThanOrEqual(60)
    // 三项事实仍在：数量、供应商数、大小写。
    expect(hint).toContain('个可用模型')
    expect(hint).toContain('个供应商')
    expect(hint).toContain('大小写')
    // ⚠️ 被删掉的两句不是丢了信息，而是**换了更近的位置**：前缀规则在卡片头
    // tooltip（「供应商 key：xxx（模型 ID 的前缀就是它）」）、短名 vs 完整 ID
    // 在两个复制按钮的 tooltip（「每行一个完整 ID」）。见下面那两条用例。
    expect(hint).not.toContain('必须带供应商前缀')
    expect(hint).not.toContain('复制出去的始终是完整 ID')
    // 删掉的是举例与铺垫（这些是「冗长」的来源）。
    expect(hint).not.toContain('例如 codearts 与 buddy')
    expect(hint).not.toContain('不会自动扫描')
  })

  it('★ 精简后**前缀规则与短名差异**必须仍在面板里能找到（只是换了位置）', () => {
    // 「精简」最容易犯的错是把信息删掉。这两条是用户配错 ID 的直接原因，
    // 故它们必须落在**用户抄 ID 时眼睛所在的地方**：卡片头与复制按钮。
    const panel = source.slice(
      source.indexOf('function GatewayCards('),
      source.indexOf('export function JetHubPage'),
    )
    // ① 前缀规则：卡片头 tooltip 里明确「模型 ID 的前缀就是供应商 key」。
    expect(panel).toContain('（模型 ID 的前缀就是它）')
    // ② 短名 vs 完整 ID：复制按钮的 tooltip 写明复制出来的是完整 ID
    //    （行内显示的却是短名 —— 两者不同正是用户抄错的来源）。
    expect(panel).toContain('每行一个完整 ID')
    expect(panel).toMatch(/title: '把模型 ID 每行一个复制到剪贴板/)
    expect(panel).toContain("copyNoun: '个完整模型 ID'")
  })

  it('⚠️ 空清单必须能自解释：区分「没登录」与「宿主没给出 provider」', () => {
    // 实机报障：用户每个 provider 都登录了，清单却是 0 个，而提示却说
    // 「还没有可用模型，登录至少一个供应商」—— 用户照着去查登录怎么都对不上。
    expect(gatewayModelsHint([], 'none')).toContain('拿不到任何 provider 列表')
    expect(gatewayModelsHint([], 'none')).toContain('不是登录问题')
    expect(gatewayModelsHint([], 'catalog')).toContain('还没有可用模型')
  })

  it('★ 搜索筛空时的提示要能区分「被搜没了」与「没有可用模型」', () => {
    // 用户要求给模型清单也加搜索框；加了搜索就必须有这一条，
    // 否则搜不到时的那张白卷会被读成「网关里一个模型都没有」。
    expect(gatewayModelsEmptyHint('banana')).toContain('没有匹配「banana」')
    // 要顺便教会用户能搜什么，否则他只会换个词继续试。
    expect(gatewayModelsEmptyHint('banana')).toContain('展示名')
    expect(gatewayModelsEmptyHint('')).toContain('当前没有可用模型')
    expect(gatewayModelsEmptyHint()).toContain('当前没有可用模型')
  })

  it('目录来自适配器兜底时说明它可能不完整', () => {
    const hint = gatewayModelsHint(MODELS, 'adapters')
    expect(hint).toContain('已注册的适配器')
  })

  it('★ curl 模板本身仍可用（函数留给 README 与其它入口），但**弹窗里不再渲染**', () => {
    // ⚠️ 用户 2026-10-04 要求删掉弹窗里那两段 curl 命令（它们与 README 重复，
    // 且是「三坨字混在一起」的一部分）。**函数保留**：它是纯函数、有独立价值
    // （README 的说明与将来的 CLI 入口都可能用），只是不再出现在面板上。
    const curl = gatewayModelsCurl('http://127.0.0.1:9999/v1')
    expect(curl).toContain('127.0.0.1:9999/v1/models')
    expect(curl).toContain('Authorization: Bearer')
    // ⚠️ 命令会进剪贴板历史、可能被贴进聊天里，不能把真 key 写进去。
    expect(curl).toContain('把你的 API Key 贴在这里')
    // 弹窗里不得再出现它（及其说明句）。
    expect(source).not.toContain('gatewayModelsCurl(')
    expect(source).not.toContain('命令行查看同一份目录')
    expect(source).not.toContain('地址栏直接打开会 401')
  })

  it('面板确实渲染了清单与「复制全部 ID」按钮', () => {
    // ⚠️ 复制的对象是**筛出来的**模型（与对照表同一口径）：按钮上写着 N，
    // 而 N 取自 `visibleModels.length` —— 复制全量会让用户以为搜索没生效。
    expect(source).toContain('formatModelIdList(visibleModels)')
    expect(source).toContain('handleCopyModelIds')
    // ⚠️ 按钮上的 N 与复制出的行数必须**同源**：只锁 `复制全部` 是不够的
    // （把 N 改回全量时会假绿，实测踩到过），故这里连插值一起锁。
    expect(source).toMatch(/复制全部 \$\{visibleModels\.length\} 个 ID/)
    // 被复制的内容为空时按钮禁用（避免复制到一个空串）。
    expect(source).toMatch(/disabled: visibleModels\.length === 0/)
    // 复制失败必须展开清单让用户手动选中。
    expect(source).toMatch(/setIdsCopied\(ok\)[\s\S]{0,120}setModelsOpen\(true\)/)
  })

  it('★ 搜索框渲染在**展开区之内**，收起时清空搜索词', () => {
    // 用户 2026-10-04 要求：「搜索功能应当在展开后才可用，而不是像现在这样放在外面，
    // 模型ID的展开清单里也应该加个搜索栏。」
    // ⚠️ 判据必须是**结构性的**（搜索框出现在 modelsOpen 的三元分支之后），
    // 而不是「源码里有没有那串 placeholder」—— 后者在搜索框挪回外面时依然成立。
    const section = source.slice(
      // ⚠️ 分界注释在第四批（第二轮）加了段号前缀（「第 2 段：」/「第 3 段：」）——
      // 锚点跟着改。**别**用「模型目录」这类裸词：`gatewayModelsHint` 的注释里也有。
      source.indexOf('// ── 第 2 段：模型目录 ──'),
      source.indexOf('// ── 第 3 段：思考档位对照表 ──'),
    )
    expect(section, '分界注释必须能定位（改了注释就要改这里）').not.toBe('')
    // ⚠️ 锚点取**展开分支本身**（`modelsOpen ? React.createElement(React.Fragment`），
    // 拿第一个 `modelsOpen` 是不够的：操作行里的 `'aria-expanded': modelsOpen`
    // 也在它前面，那样写会退化成「搜索框在操作行之后」这种弱判据。
    // 中间还夹着几行 `//` 注释，故用「注释行可选」的写法。
    const openAt = section.search(/modelsOpen\s*(?:\/\/[^\n]*\n\s*)*\?\s*React\.createElement\(React\.Fragment/)
    expect(openAt, '应能定位到展开分支').toBeGreaterThan(-1)
    // 搜索框在展开分支之后 ⇒ 它在展开区之内（收起时不渲染）。
    // ⚠️ 匹配带引号的属性名（`'aria-label':`）—— 这与渲染处的写法一致，
    // 且注释里提到「搜索模型 ID」时不会被误命中。
    const searchInputAt = section.indexOf("'aria-label': '搜索模型 ID'")
    expect(searchInputAt, '模型清单的搜索框应存在').toBeGreaterThan(-1)
    expect(searchInputAt).toBeGreaterThan(openAt)
    // 收起时必须清掉搜索词，否则不可见的筛子会让下次展开少掉一半行。
    expect(section).toMatch(/if \(modelsOpen\) setModelsQuery\(''\)/)
    // 空结果自解释（与对照表同一条约定）。
    expect(section).toContain('gatewayModelsEmptyHint(modelsQuery)')
    // ⚠️ 搜索判据必须复用 model-filter.js 的 filterModels（只匹配 id/展示名）。
    // 若误用对照表那套 filterEffortRows，「搜 max」会命中一堆没有该功能的模型。
    // 该行在组件顶部的派生值区（不在这一段里），故按全文断言。
    expect(source).toContain('filterModels(models, { query: modelsQuery })')
  })
})

/**
 * 「哪些模型能发图片」的标记。
 *
 * 背景：用户给网关发图得到 `unsupported_content`，但他**事先无从知道**该模型
 * 支不支持图片 —— 只能撞一次错才知道。`/v1/models` 早已带 `input` 字段，只是
 * 设置页没显示。
 */
describe('模型能力标记（可发图片）', () => {
  it('input 含 image 时标记为可发图片', () => {
    expect(modelSupportsImage({ input: ['text', 'image'] })).toBe(true)
    expect(modelCapabilityBadge({ input: ['text', 'image'] })).toBe('可发图片')
  })

  it('⚠️ 缺 input / 不含 image 一律**不标**（宁可少标也不错标）', () => {
    // 错标成支持，用户发完图才发现被拒；少标则只是没提示，错误仍是明确的。
    expect(modelSupportsImage({ input: ['text'] })).toBe(false)
    expect(modelSupportsImage({})).toBe(false)
    expect(modelSupportsImage(null)).toBe(false)
    expect(modelSupportsImage(undefined)).toBe(false)
    expect(modelSupportsImage({ input: 'image' as never })).toBe(false)
    expect(modelCapabilityBadge({ input: ['text'] })).toBe('')
  })

  it('判据只看是否含 image，不因顺序或额外模态而改变', () => {
    expect(modelSupportsImage({ input: ['image'] })).toBe(true)
    expect(modelSupportsImage({ input: ['image', 'text', 'audio'] })).toBe(true)
  })

  it('清单行确实渲染了这个标记', () => {
    expect(source).toContain('modelCapabilityBadge')
    expect(source).toContain('dim-jh-modelBadge')
  })

  it('样式里有这个类，且锁住 flex: none（否则会被 id/name 挤没）', () => {
    const styles = readFileSync(resolve(HERE, '../../plugin-src/client/jet-hub-styles.js'), 'utf8')
    expect(styles).toMatch(/\.dim-jh-modelBadge \{[^}]*flex: none/)
  })
})

/**
 * 思考档位对照表。
 *
 * 背景（真实缺陷）：各 provider 的档位 id 是上游私有值，而 OpenAI 协议的客户端
 * 只有固定 8 档词汇。用户照 DSH 界面上的名字填进 CC Switch（LobsterAI 的 Max →
 * `max`、Cline 的 Extra → `xhigh`、TRAE 的 Light/Extra High → `low`/`xhigh`），
 * 网关按 id 校验，全部 400 —— 整轮对话不可用，而两端都看不出原因。
 */
describe('思考档位对照表', () => {
  const TRAE = {
    id: 'trae/deepseek-v4.1-flash',
    name: 'Flash',
    reasoning: {
      efforts: [
        { id: 'light', name: 'Light', canonical: 'low' },
        { id: 'high', name: 'High', canonical: 'high' },
        { id: 'extra_high', name: 'Extra High', canonical: 'xhigh' },
      ],
      default: 'high',
      openai_efforts: ['low', 'high', 'xhigh'],
    },
  }
  /** 档位名与客户端一致的行：不该被标「需对照」。 */
  const PLAIN = {
    id: 'qoder/dfmodel',
    name: 'DeepSeek-Flash',
    reasoning: {
      efforts: [{ id: 'low', name: '低', canonical: 'low' }, { id: 'high', name: '高', canonical: 'high' }],
      openai_efforts: ['low', 'high'],
    },
  }
  const NO_EFFORT = { id: 'zcode/GLM-5.3', name: 'GLM' }

  it('★ 一行同时给出「真实档位」与「客户端该填」（只给一个都救不了用户）', () => {
    const row = gatewayEffortRow(TRAE)
    // 真实档位要把 id 与 DSH 界面上的 name 都给出来：用户就是照 name 填错的。
    expect(row?.declared).toBe('light（Light） · high（High） · extra_high（Extra High）')
    expect(row?.fill).toBe('low, high, xhigh')
    expect(row?.lossy).toBe(true)
    // 展示名要带上，搜索时才搜得到（与模型清单的搜索共用 matchesModelQuery）。
    expect(row?.name).toBe('Flash')
  })

  it('档位名与客户端一致的行不标「需对照」', () => {
    expect(gatewayEffortRow(PLAIN)?.lossy).toBe(false)
  })

  it('⚠️ 未声明档位的模型不产生行（「不知道」≠「一个都没有」）', () => {
    expect(gatewayEffortRow(NO_EFFORT)).toBeNull()
    expect(gatewayEffortRow({ id: 'x', reasoning: { efforts: [], openai_efforts: [] } })).toBeNull()
    expect(gatewayEffortRows([TRAE, NO_EFFORT, PLAIN]).map(row => row.id))
      .toEqual(['trae/deepseek-v4.1-flash', 'qoder/dfmodel'])
  })

  it('脏输入不抛错（宿主字段缺失/形态不符时面板仍要能渲染）', () => {
    expect(gatewayEffortRows(null)).toEqual([])
    expect(gatewayEffortRows(undefined)).toEqual([])
    expect(gatewayEffortRow(null)).toBeNull()
    expect(gatewayEffortRow({ id: 'x', reasoning: { efforts: 'nope' as never } })).toBeNull()
    // openai_efforts 缺失时给空串而不是 undefined（否则 UI 会渲染出 "undefined"）。
    expect(gatewayEffortRow({ id: 'x', reasoning: { efforts: [{ id: 'turbo', name: 'T' }] } })?.fill).toBe('')
    expect(gatewayEffortRow({ id: 'x', reasoning: { efforts: [{ id: 'turbo', name: 'T' }] } })?.name).toBe('')
    // ⚠️ 上游给了个**没登记**的私有 id（没有 canonical）时，这一档**任何规范名都表达
    // 出来**，`declared` 比 `fill` 多一档 —— 必须标「需对照」，否则用户看到一档填不
    // 出来的东西却没有任何解释。原判据只认「canonical 与 id 不同」，恰恰漏了这种。
    const unregistered = gatewayEffortRow({
      id: 'x',
      reasoning: {
        efforts: [{ id: 'turbo', name: 'T' }, { id: 'high', name: 'H', canonical: 'high' }],
        openai_efforts: ['high'],
      },
    })
    expect(unregistered?.fill).toBe('high')
    expect(unregistered?.lossy).toBe(true)
  })

  it('★ 说明文案：不能说「填什么都不会报错」—— 未登记的写法是真会 400 的', () => {
    const hint = gatewayEffortsHint([TRAE, PLAIN, NO_EFFORT])
    // 用户看到「14 个」时会以为网关只认得 14 个模型 —— 必须点明这是**已开启**的数量。
    expect(hint).toContain('已开启的 3 个模型')
    expect(hint).toContain('有 2 个可选思考档位')
    // 只有 TRAE 那行是「需对照」，数量必须如实。
    expect(hint).toContain('1 个不同名')
    expect(hint).toContain('CC Switch')
    // ⚠️ 边界必须照实说：强度序只登记了 12 个名字（8 规范名 + off/light/on/extra_high），
    // 未登记的写法会被拒绝。让用户去试一个必然 400 的写法是误导。
    expect(hint).toContain('未登记的档位名称将被拒绝')
    expect(hint).not.toContain('也不会报错')
  })

  it('★ 说明文案已精简到**两句**（用户 2026-10-04 第二次要求），但边界与列含义仍照实', () => {
    const hint = gatewayEffortsHint([TRAE, PLAIN, NO_EFFORT])
    // ⚠️ 判据用**长度上限**而不是「恰好等于某串」：长度为 0 的空串也满足
    // 一切 toContain，故长度上限必须与下面的正向断言同用才有意义。
    // 上一版实测 105 字（约 2 行），本版压到 85 字以内（必然 2 行）。
    expect(hint.length).toBeLessThanOrEqual(85)
    // 「标「需对照」」是**图例**：卡片上的徽章就写着这三个字，不带这句无从解释。
    expect(hint).toContain('需对照')
    // 「客户端该填」那一列的去向（CC Switch 的映射档位）与边界都必须留着。
    expect(hint).toContain('客户端该填')
    expect(hint).toContain('未登记的档位名称将被拒绝')
    expect(hint).not.toContain('按强度就近')
    // 供应商数量不重复（卡片头已写明是哪一家）。
    expect(hint).not.toContain('个供应商')
    // ⚠️ 用户给的原文里举例（如 turbo）已被删掉：边界照旧，只是不再点名。
    // 若哪天有人按旧用例把它加回来，这条会提醒他长度预算已被收紧。
    expect(hint).not.toContain('turbo')
  })

  it('一个模型都没声明档位时说明「网关不下发该参数」', () => {
    expect(gatewayEffortsHint([NO_EFFORT])).toContain('不下发该参数')
    expect(gatewayEffortsHint([])).toContain('不下发该参数')
  })

  it('★ 说明文案**按行**给出，品牌名 CC Switch 不得被行尾断开（用户 2026-10-04 第三次报障）', () => {
    const lines = gatewayEffortsHintLines([TRAE, PLAIN, NO_EFFORT])
    // ⚠️ 判据是「两行」而不是「拼起来含某串」：用户看到的缺陷正是**拼成一整段**
    // 交给浏览器断行，结果前一行的结尾是「CC」、下一行开头是「Switch」。
    // 只锁关键词的话，退回单行拼法照样绿（品牌名仍会被切断），故必须锁行结构。
    expect(lines).toHaveLength(2)
    // 第一行讲数量与图例。
    expect(lines[0]).toContain('已开启的 3 个模型')
    expect(lines[0]).toContain('有 2 个可选思考档位')
    expect(lines[0]).toContain('1 个不同名')
    // 第二行讲那一列填到哪 + 边界，且**整句**都在同一行里（品牌名与它不被拆开）。
    expect(lines[1]).toContain('「客户端该填」为 CC Switch 需配置的映射档位')
    expect(lines[1]).toContain('未登记的档位名称将被拒绝')
    // ⚠️ 「CC Switch」必须以**整个词**出现在同一行内 —— 这是本次报障的正题。
    // 若哪天有人把品牌名写成 'CC' + 换行 + 'Switch'，或插了换行符，这条会红。
    expect(lines.some((line) => line.includes('CC Switch'))).toBe(true)
    // 品牌名不得被拆到两行里去（拼接后仍要能搜到完整词，且各半不得单独成行）。
    expect(lines.some((line) => line.trim() === 'CC')).toBe(false)
    expect(lines.some((line) => line.startsWith('Switch'))).toBe(false)
  })

  it('单行形态仍由行数组拼出（既有断言与 README 的口径不变）', () => {
    const models = [TRAE, PLAIN, NO_EFFORT]
    // ⚠️ 拼接口径必须与行数组一致 —— 否则「读到的文案」与「屏幕上显示的」会分叉。
    expect(gatewayEffortsHint(models)).toBe(gatewayEffortsHintLines(models).join(''))
    // 空表时是一行，拼接后仍是那句。
    expect(gatewayEffortsHintLines([NO_EFFORT])).toHaveLength(1)
  })

  it('★ 对照表 curl 模板本身仍可用，但**弹窗里不再渲染**（与模型目录同理）', () => {
    const curl = gatewayEffortsCurl('http://127.0.0.1:9999/v1')
    expect(curl).toContain('127.0.0.1:9999/v1/reasoning-efforts')
    expect(curl).toContain('把你的 API Key 贴在这里')
    expect(source).not.toContain('gatewayEffortsCurl(')
    expect(source).not.toContain('命令行查看同一份对照表')
  })

  it('面板确实渲染了对照表，且数据来自宿主的档位视图', () => {
    expect(source).toContain('gatewayEffortRows(models)')
    // ⚠️ 接线锁的是**行数组那个函数**，不是拼接用的 gatewayEffortsHint：
    // 后者一用就退回「拼成一整段交给浏览器断行」，正是品牌名被切开的缺陷。
    expect(source).toContain('gatewayEffortsHintLines(models)')
    // ⚠️ 同时锁「一行一个 p」的渲染结构（只锁函数名的话，有人把它 join 回来照样绿）。
    expect(source).toMatch(/gatewayEffortsHintLines\(models\)\.map\(/)
    expect(source).toMatch(/efforts-hint-\$\{index\}/)
    expect(source).toContain('客户端该填')
    // 空表不能让用户点开一个什么都没有的区块。
    expect(source).toMatch(/disabled:\s*effortRows\.length === 0/)
  })
})

/**
 * 对照表的**搜索**（用户要求：表要能查）。
 *
 * ⚠️ 与模型清单的搜索**不是同一套判据**：那里只匹配 id/name，这里还要匹配
 * **档位名** —— 因为最常用的查法就是「哪些渠道有 xhigh？」「界面上的 Max 是哪个 id？」
 * （后者正是用户踩过的坑）。但「空搜索词 = 未搜索」的约定与它共用
 * `model-filter.js`，避免两处漂移。
 */
describe('思考档位对照表的搜索', () => {
  const ROWS = [
    gatewayEffortRow({
      id: 'trae/deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash',
      reasoning: {
        efforts: [
          { id: 'light', name: 'Light', canonical: 'low' },
          { id: 'high', name: 'High', canonical: 'high' },
          { id: 'extra_high', name: 'Extra High', canonical: 'xhigh' },
        ],
        openai_efforts: ['low', 'high', 'xhigh'],
      },
    }),
    gatewayEffortRow({
      id: 'lobsterai/deepseek-flash', name: 'DeepSeek-Flash',
      reasoning: {
        efforts: [
          { id: 'off', name: '关闭', canonical: 'none' },
          { id: 'high', name: '高', canonical: 'high' },
          { id: 'xhigh', name: 'Max', canonical: 'xhigh' },
        ],
        openai_efforts: ['none', 'high', 'xhigh'],
      },
    }),
    gatewayEffortRow({
      id: 'cline/cline-free/deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash',
      reasoning: {
        efforts: [
          { id: 'none', name: 'None', canonical: 'none' },
          { id: 'max', name: 'Extra', canonical: 'max' },
        ],
        openai_efforts: ['none', 'max'],
      },
    }),
  ].filter(Boolean)

  it('空搜索词 = 未搜索（返回全部，而不是筛空）', () => {
    expect(filterEffortRows(ROWS, '').length).toBe(3)
    expect(filterEffortRows(ROWS, '   ').length).toBe(3)
    expect(filterEffortRows(ROWS)).toBe(ROWS)
    expect(filterEffortRows(null, 'x')).toEqual([])
  })

  it('按模型 id / 展示名搜（与模型清单同一口径）', () => {
    expect(filterEffortRows(ROWS, 'lobsterai').map(row => row.id)).toEqual(['lobsterai/deepseek-flash'])
    expect(filterEffortRows(ROWS, 'DEEPSEEK-V4.1-FLASH').map(row => row.id))
      .toEqual(['trae/deepseek-v4.1-flash', 'cline/cline-free/deepseek-v4.1-flash'])
  })

  it('★ 按**档位名**搜（这是本表最常用的查法）', () => {
    // 真实 id
    expect(filterEffortRows(ROWS, 'light').map(row => row.id)).toEqual(['trae/deepseek-v4.1-flash'])
    expect(filterEffortRows(ROWS, 'xhigh').map(row => row.id))
      .toEqual(['trae/deepseek-v4.1-flash', 'lobsterai/deepseek-flash'])
    // DSH 界面上的叫法也要能搜到（用户就是照着它填错的）。
    // ⚠️ 子串匹配：`Max` 同时命中 Cline 的真实 id `max` —— 这是对的
    //（那一行的真实档位列写的就是 `max`），用户据两列自行区分。
    expect(filterEffortRows(ROWS, 'Max').map(row => row.id))
      .toEqual(['lobsterai/deepseek-flash', 'cline/cline-free/deepseek-v4.1-flash'])
    // `Extra` 同时命中 TRAE 的 Extra High 与 Cline 的 Extra —— 这正是「按档位名搜」
    // 该有的行为（模糊命中即可，用户自己看两行的真实 id 区分）。
    expect(filterEffortRows(ROWS, 'Extra').map(row => row.id))
      .toEqual(['trae/deepseek-v4.1-flash', 'cline/cline-free/deepseek-v4.1-flash'])
    // 该填的规范名同样算命中
    expect(filterEffortRows(ROWS, 'none').map(row => row.id))
      .toEqual(['lobsterai/deepseek-flash', 'cline/cline-free/deepseek-v4.1-flash'])
  })

  it('搜不到时返回空数组（不是抛错、也不是返回全量）', () => {
    expect(filterEffortRows(ROWS, 'banana')).toEqual([])
  })

  it('两种搜索判据的差异被锁住：档位名只在对照表里搜得到', () => {
    // 模型清单的 matchesModelQuery 只认 id/name —— 若哪天有人把对照表的搜索
    // 「顺手统一」成它，按档位名就再也搜不到了（Max / Extra 这类查法会失效）。
    expect(matchesModelQuery(ROWS[1], 'Max')).toBe(false)
    expect(matchesEffortQuery(ROWS[1], 'Max')).toBe(true)
  })
})

describe('思考档位对照表：复制与空结果文案', () => {
  const ROWS = [
    gatewayEffortRow({
      id: 'lobsterai/deepseek-flash', name: 'DeepSeek-Flash',
      reasoning: {
        efforts: [{ id: 'xhigh', name: 'Max', canonical: 'xhigh' }],
        openai_efforts: ['xhigh'],
      },
    }),
  ].filter(Boolean)

  it('复制出来的文本与屏幕上的两行一致（含模型 id）', () => {
    expect(gatewayEffortsText(ROWS)).toBe(
      'lobsterai/deepseek-flash\n  真实档位：xhigh（Max）\n  客户端该填：xhigh',
    )
  })

  it('多行之间空行分隔，且空输入返回空串（否则「复制」会复制一堆空白）', () => {
    expect(gatewayEffortsText([ROWS[0], ROWS[0]])).toContain('\n\n')
    expect(gatewayEffortsText([])).toBe('')
    expect(gatewayEffortsText(null)).toBe('')
  })

  it('★ 空结果必须能区分「被搜索词筛没了」与「本来就没有」', () => {
    expect(gatewayEffortsEmptyHint('banana')).toContain('没有匹配「banana」')
    // 要顺便教会用户能搜什么，否则他只会换个词继续试。
    expect(gatewayEffortsEmptyHint('banana')).toContain('档位名')
    expect(gatewayEffortsEmptyHint('')).toContain('没有模型声明思考档位')
    expect(gatewayEffortsEmptyHint()).toContain('没有模型声明思考档位')
  })

  it('面板接上了搜索框、复制按钮与空结果提示', () => {
    expect(source).toContain('filterEffortRows(effortRows, effortsQuery)')
    expect(source).toContain('gatewayEffortsEmptyHint(effortsQuery)')
    expect(source).toContain('gatewayEffortsText(visibleEffortRows)')
    expect(source).toContain('搜索模型 id、展示名或档位名')
    // 复制失败必须展开表格让用户手动选中（不能「点了没反应」）。
    expect(source).toMatch(/setEffortsCopied\(ok\)[\s\S]{0,120}setEffortsOpen\(true\)/)
    // 换了搜索词要复位「已复制」，否则那句提示讲的是另一批行。
    expect(source).toMatch(/setEffortsCopied\(false\)[\s\S]{0,40}\[models\.length,\s*effortsQuery\]/)
  })

  it('★ 搜索框渲染在**展开区之内**（用户 2026-10-04 要求），收起时清空搜索词', () => {
    // 原话：「搜索功能应当在展开后才可用，而不是像现在这样放在外面」。
    // ⚠️ 判据必须是**结构性的**（搜索框出现在 effortsOpen 的三元分支之后），
    // 而不是「源码里有没有那串 placeholder」—— 后者在搜索框挪回外面时依然成立。
    const section = source.slice(
      source.indexOf('// ── 第 3 段：思考档位对照表 ──'),
      // ⚠️ 终点锚点用**脚注那段的渲染处**，不是脚注文案：文案随 host 变化
      // （issue IKL7UN 之后它由 `gatewayFootnote(status)` 产出），
      // 拿文案当锚点会让「换了个地址」变成测试失败。
      source.indexOf('// ── 网关弹窗脚注 ──'),
    )
    expect(section, '分界注释必须能定位（改了注释就要改这里）').not.toBe('')
    // ⚠️ 锚点取**展开分支本身**，而不是第一个 `effortsOpen`：操作行里的
    // `'aria-expanded': effortsOpen` 也在它前面，那样写会退化成弱判据。
    const openAt = section.search(/effortsOpen\s*(?:\/\/[^\n]*\n\s*)*\?\s*React\.createElement\(React\.Fragment/)
    expect(openAt, '应能定位到展开分支').toBeGreaterThan(-1)
    // ⚠️ 匹配带引号的属性名（`'aria-label':`），注释里的「搜索思考档位」不受影响。
    const searchInputAt = section.indexOf("'aria-label': '搜索思考档位'")
    expect(searchInputAt, '对照表的搜索框应存在').toBeGreaterThan(-1)
    expect(searchInputAt).toBeGreaterThan(openAt)
    // 收起时必须清掉搜索词，否则不可见的筛子会让下次展开少掉一半行。
    expect(section).toMatch(/if \(effortsOpen\) setEffortsQuery\(''\)/)
  })
})

/**
 * 「字符过长被省略号截断」是用户明确反馈的问题（2026-10-03）：
 * 对照表的内容**就是要抄的东西**，截断等于让功能失效。
 *
 * 故这里锁两条：
 * 1. 对照表**不复用**模型清单那套带 `text-overflow: ellipsis` 的类；
 * 2. 它自己的类必须允许换行（`overflow-wrap: anywhere`）且**不含**截断属性。
 */
describe('思考档位对照表的排版（不截断）', () => {
  const styles = readFileSync(resolve(HERE, '../../plugin-src/client/jet-hub-styles.js'), 'utf8')
  const rule = (selector: string) => {
    const match = styles.match(new RegExp(`\\${selector} \\{([^}]*)\\}`))
    return match?.[1] ?? ''
  }

  it('⚠️ 对照表的行与文本不得使用 ellipsis / nowrap 截断', () => {
    for (const selector of ['.dim-jh-effortRow', '.dim-jh-effortHead', '.dim-jh-effortModel', '.dim-jh-effortLine']) {
      const body = rule(selector)
      expect(body, `${selector} 应有样式`).not.toBe('')
      expect(body, `${selector} 不得截断（那是用户反馈的缺陷）`).not.toContain('ellipsis')
      expect(body, `${selector} 不得 nowrap`).not.toContain('nowrap')
    }
  })

  it('长内容靠 overflow-wrap 换行，而不是被切掉', () => {
    expect(rule('.dim-jh-effortModel')).toContain('overflow-wrap: anywhere')
    expect(rule('.dim-jh-effortLine')).toContain('overflow-wrap: anywhere')
  })

  it('渲染用的类确实是新那套（用错就会重新截断）', () => {
    expect(source).toContain("className: 'dim-jh-effortRow'")
    expect(source).toContain("className: 'dim-jh-effortModel'")
    expect(source).toContain("className: 'dim-jh-effortLine'")
    // ⚠️ 模型清单那两行是 ellipsis 截断的，对照表**不能**复用它们。
    // ⚠️ 取渲染处的注释做起点（`handleCopyEfforts` 的注释里也提到这几个字，
    // 从那里切会把上面的模型清单一起圈进来）。
    const effortSection = source.slice(
      source.indexOf('// ── 第 3 段：思考档位对照表'),
      source.indexOf('// ── 网关弹窗脚注 ──'),
    )
    expect(effortSection).not.toBe('')
    expect(effortSection).not.toContain('dim-jh-modelName')
  })
})

/**
 * 「一个供应商一张卡片」（用户报障 2026-10-03）。
 *
 * 用户原话：`deepseek-account/deepseek-flash` 与 `deepseek-account/deepseek-v4-pro`
 * 这是同一家供应商 `deepseek-account` 的，却分为了两个卡片（当时是一个模型一行）。
 * 用户要的形态是「供应商 → 它名下有哪些模型」。
 *
 * ⚠️ 分组判据必须抽成纯函数才能真跑覆盖：单测环境是 `node`，react 不在依赖内。
 */
describe('按供应商分组（一个供应商一张卡片）', () => {
  const MODELS = [
    { id: 'deepseek-account/deepseek-flash', provider: 'deepseek-account', model: 'deepseek-flash', name: 'Flash' },
    { id: 'deepseek-account/deepseek-v4-pro', provider: 'deepseek-account', model: 'deepseek-v4-pro', name: 'Pro' },
    { id: 'codearts/GLM-5.2', provider: 'codearts', model: 'GLM-5.2', name: 'GLM' },
  ]

  it('★ 用户报障的那两条必须落在同一张卡片里', () => {
    const cards = groupGatewayModels(MODELS)
    const ds = cards.find(card => card.provider === 'deepseek-account')
    expect(ds?.entries.map(entry => entry.model)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    // 卡片数 = 供应商数（不是模型数）。
    expect(cards.map(card => card.provider)).toEqual(['deepseek-account', 'codearts'])
  })

  it('卡片顺序 = 目录原序（首次出现的先后），不重排', () => {
    const shuffled = [MODELS[2], MODELS[1], MODELS[0]]
    expect(groupGatewayModels(shuffled).map(card => card.provider)).toEqual(['codearts', 'deepseek-account'])
  })

  it('★ 卡片头的条数如实统计（总数 + 可发图片数）', () => {
    const cards = groupGatewayModels([
      { id: 'a/x', provider: 'a', model: 'x', name: 'X', input: ['text', 'image'] },
      { id: 'a/y', provider: 'a', model: 'y', name: 'Y', input: ['text'] },
    ])
    expect(cards[0].counts).toEqual({ total: 2, fold: 1 })
  })

  it('★ provider 缺失时按首个斜杠兜底（与网关路由同源），仍不丢行', () => {
    // 宿主字段缺失（旧版本/替身）时的降级路径：能分组，只是分组由 id 反推。
    const cards = groupGatewayModels([{ id: 'codearts/GLM-5.2', name: 'GLM' }])
    expect(cards.map(card => card.provider)).toEqual(['codearts'])
  })

  it('⚠️ 拿不到 provider（id 里没斜杠）归入「未知」卡片，**不丢行**', () => {
    // 少一个 ID 会让用户照着一份不完整的清单配客户端，故宁可单列一张卡。
    const cards = groupGatewayModels([{ id: 'bogus', name: 'B' }, ...MODELS])
    expect(cards.map(card => card.provider)).toEqual(['', 'deepseek-account', 'codearts'])
    expect(cards[0].entries).toHaveLength(1)
    // 未知那张卡要有**可解释**的标题，空标题会让用户以为界面坏了。
    expect(gatewayCardLabel('')).toContain('未标注供应商')
  })

  it('脏输入不抛错（面板在数据未就绪时也要能渲染）', () => {
    expect(groupGatewayModels(null)).toEqual([])
    expect(groupGatewayModels(undefined)).toEqual([])
    expect(groupGatewayModels('nope' as never)).toEqual([])
    expect(gatewayProviderOf(null)).toBe('')
    expect(gatewayProviderOf({ id: '/leading' })).toBe('')
  })

  it('⚠️ 不去重：同一 id 出现两次是上游的事，如实显示（去重会掩盖上游缺陷）', () => {
    const cards = groupGatewayModels([MODELS[0], MODELS[0]])
    expect(cards[0].counts.total).toBe(2)
  })

  it('★ 模型清单与档位对照表共用同一套分组判据（两处口径不可能漂移）', () => {
    // 对照行只有 provider/id/model 三个字段，groupGatewayEntries 也只依赖它们。
    const rows = [
      { id: 'trae/deepseek-v4.1-flash', provider: 'trae', model: 'deepseek-v4.1-flash', name: 'F' },
      { id: 'trae/deepseek-v4-pro', provider: 'trae', model: 'deepseek-v4-pro', name: 'P' },
      { id: 'lobsterai/deepseek-flash', provider: 'lobsterai', model: 'deepseek-flash', name: 'L' },
    ]
    expect(groupGatewayEntries(rows).map(card => card.provider)).toEqual(['trae', 'lobsterai'])
    // ⚠️ 对照表的分组必须发生在**筛出来的行**上（否则卡片头写着 8 个、里面只有 1 行）。
    expect(groupGatewayEntries(rows.slice(0, 1)).map(card => card.counts.total)).toEqual([1])
  })

  it('卡片标题走渠道名（查不到时退回 provider key，不显示空白）', () => {
    expect(gatewayCardLabel('codearts', () => 'CodeArts (华为云)')).toBe('CodeArts (华为云)')
    expect(gatewayCardLabel('codearts')).toBe('codearts')
    // 回调给出空串时也要退回 id，否则标题会是空白。
    expect(gatewayCardLabel('codearts', () => '')).toBe('codearts')
  })

  /**
   * ⚠️ 纯函数的正确性**不足以**证明面板接对了：判据还在、但没人调用（或调用了
   * 另一批数据）时，用例照样全绿。故这里额外锁三处**接线**。
   */
  it('★ 两处清单都真的走了分组卡片（模型清单 + 档位对照表）', () => {
    // ⚠️ 模型清单的卡片建在**筛出来的模型**上（`visibleModels`），与对照表同一口径：
    // 建在全量 `models` 上时，搜索会出现「卡片头写着 8 个、卡里只有 1 行」的矛盾读数。
    expect(source).toContain('groupGatewayModels(visibleModels)')
    expect(source).not.toContain('groupGatewayModels(models)')
    // ⚠️ 对照表的卡片必须建在**筛出来的行**上：若建在全量 `effortRows` 上，
    // 搜索时会出现「卡片头写着 8 个、卡里只有 1 行」的自相矛盾读数。
    expect(source).toContain('groupGatewayEntries(visibleEffortRows')
    expect(source).not.toContain('groupGatewayEntries(effortRows')
    // 两种清单都渲染成卡片（同一套形态，用户不必学两种读法）。
    expect(source.match(/React\.createElement\(GatewayCards, \{/g)).toHaveLength(2)
    // 行内用短名字、复制用完整 id（两处都不能搞反）。
    expect(source).toContain('gatewayModelKeyOf(model)')
    expect(source).toContain('gatewayModelKeyOf(row)')
    expect(source).toContain('formatModelIdList(card.entries)')
  })

  it('★ 两处清单的搜索都让卡片展开（`searching` 两处都传了）', () => {
    // 少了 `searching`，搜到的结果会藏在默认折叠的大卡片里 —— 用户会以为「搜不到」。
    // 与对照表同一取舍（model-groups.js 的 groupExpanded）。
    expect(source.match(/searching: modelsFiltering/g)).toHaveLength(2)
    expect(source.match(/searching: effortsFiltering/g)).toHaveLength(2)
  })
})

/**
 * 网关弹窗里「胶囊」（行内 ID 块、能力标记、卡片标题）的完整显示。
 *
 * **用户报障（2026-10-04）**：「网关这里面的所有胶囊内容都没有完整显示，应当修正
 * 使其完整显示内容」。根因是 `.dim-jh-modelId` / `.dim-jh-modelBadge` /
 * `.dim-jh-gatewayCardToggle` 这三个类**天生带截断**（`max-width` + `ellipsis` +
 * `nowrap`），而它们本是给**模型列表**设计的（那里一行里还要塞下开关，紧凑是刻意的）。
 * 网关弹窗里这些内容恰恰是要被读、被抄的。
 *
 * ⚠️ 故修法必须在 `.dim-jh-gatewayModal` 前缀下覆盖，**不能**直接改那三个通用类。
 */
describe('网关弹窗的胶囊不截断（用户报障 2026-10-04）', () => {
  const styles = readFileSync(resolve(HERE, '../../plugin-src/client/jet-hub-styles.js'), 'utf8')
  /**
   * 取出某条规则体。
   *
   * ⚠️ 两个易错点：
   * 1. 选择器里的 `.` 必须**全部**转义：`.dim-jh-modelId` 不转义会匹配到
   *    `Xdim-jh-modelId`，将来多一条相似规则就可能取错那条而给出假绿；
   * 2. 选择器必须出现在**行首或逗号之后** —— 本文件里注释也会提到类名
   *    （如「.dim-jh-modelId 是 max-width 46%…」），不锚定行首就会把注释
   *    当成规则、取到下面那条无关的规则体而给出假绿。
   *
   * 多选择器规则（`A,\nB { … }`）返回**同一份**体：网关的胶囊覆盖就是这种写法。
   */
  const rule = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = styles.match(new RegExp(`(?:^|[,\\n])[ \\t]*${escaped}[ \\t]*(?=[,{])[^{}]*\\{([^}]*)\\}`))
    return match?.[1] ?? ''
  }

  it('★ 网关弹窗内的 ID 胶囊必须能换行（去掉 max-width 夹取），且不截断', () => {
    // ⚠️⚠️ 判据是**两级通配**（弹窗 + 类名），**不许夹中间祖先**。
    // 这里返工过一次，务必看懂再改：
    //   第一版写成 `.dim-jh-gatewayModal .dim-jh-gatewayModelRow .dim-jh-modelId`
    //   （外加 KeyRow / CardBody 两条），只覆盖到**卡片内**的胶囊。用户随后截图框出
    //   三处仍在截断的地方，它们的祖先链各不相同：
    //     · 开关行：.dim-jh-modalBody > .dim-jh-modelRow > .dim-jh-modelInfo > code
    //     · 两处 curl 代码块：.dim-jh-modalBody > code
    //   三条带祖先的规则**一条都匹配不上**，于是「供 Pi / Cont…」与两行 curl 照旧被吃。
    // ⚠️ 当时的机械审计脚本也没抓到 —— 它只查**类名**有没有被某条网关规则覆盖，
    //   而 .dim-jh-modelId 在卡片那条里"有覆盖"，于是整体判通过。
    //   **教训：判断会不会被截断要看元素的祖先链，不能看类名是否出现过。**
    const body = rule('.dim-jh-gatewayModal .dim-jh-modelId')
    expect(body, '应有一条网关专用的覆盖规则').not.toBe('')
    expect(body).toContain('max-width: none')
    expect(body).toContain('overflow-wrap: anywhere')
    expect(body).toContain('white-space: normal')
    expect(body).not.toContain('ellipsis')
    // 模型展示名同理（原先只在模型列表里才允许收缩 + 截断）。
    const name = rule('.dim-jh-gatewayModal .dim-jh-modelName')
    expect(name).toContain('white-space: normal')
    expect(name).not.toContain('ellipsis')
  })

  it('★ 覆盖规则不得夹中间祖先（否则开关行与 curl 代码块又会被截断）', () => {
    // 上一条证明「有一条两级通配规则在」；这一条堵住「有人把祖先限定加回来」。
    // ⚠️ 必须**先剥掉注释**再解析选择器：上一条规则的注释里就写着
    //   「第一版写成 .dim-jh-gatewayModal .dim-jh-gatewayModelRow .dim-jh-modelId」
    // 直接正则会把**那句注释**当成一条规则命中（假红）—— 与「not.toContain 命中注释」
    // 是同一个坑：判据必须作用在**真规则**上。
    const stripped = styles.replace(/\/\*[\s\S]*?\*\//g, '')
    const rules = [...stripped.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter(([, sel, b]) => sel.includes('.dim-jh-gatewayModal') && sel.includes('.dim-jh-modelId')
        && /text-overflow:\s*clip/.test(b))
      .map(([, sel]) => sel)
    expect(rules.length, '应有网关内的 ID 胶囊覆盖规则').toBeGreaterThan(0)
    for (const sel of rules) {
      for (const one of sel.split(',').map(s => s.trim())) {
        if (!one.includes('.dim-jh-modelId')) continue
        // 两级选择器 = `.dim-jh-gatewayModal .dim-jh-modelId`（中间正好一个空格）
        expect(one, `不允许夹中间祖先：${one}`)
          .toMatch(/^\.dim-jh-gatewayModal\s+\.dim-jh-modelId$/)
      }
    }
  })

  it('★ 弹窗内**不得再有第二条**给 .dim-jh-modelId 设宽度上限的规则', () => {
    // 这条来自一次变异「存活」：把已删掉的
    //   .dim-jh-gatewayModelRow .dim-jh-modelId { max-width: 52% }
    // 加回两级通配**之后**（同优先级 (0,2,0)，后者胜），卡片内 ID 又被夹到 52%。
    // 上面那条「不得夹中间祖先」只筛 `text-overflow: clip` 的规则，**抓不到它**
    // （它只设 max-width，不带 clip）—— 故必须单独堵这个洞。
    const stripped = styles.replace(/\/\*[\s\S]*?\*\//g, '')
    // ⚠️ 解析 CSS**不能**用 `/([^{}]+)\{([^{}]*)\}/g` 这类正则：
    //   它可以从任意位置起匹配，选择器组会跨过前一条规则的 `}` 一路吃掉前文，
    //   于是 selector/body 角色互换（实测解析出
    //   `SEL="A { x: 1 }" BODY="A "` 这种鬼东西），判据永远不命中 ⇒ 变异假存活。
    //   必须按花括号深度**扫描**。这里用 rulesOf 正确切分顶层规则。
    const rulesOf = (css: string) => {
      const out: Array<{ sel: string, body: string }> = []
      const stack: number[] = []
      let selStart = 0
      let bodyStart = -1
      for (let i = 0; i < css.length; i++) {
        const ch = css[i]
        if (ch === '{') {
          if (stack.length === 0) bodyStart = i + 1
          stack.push(i)
        } else if (ch === '}') {
          const open = stack.pop()
          if (open === undefined) continue
          if (stack.length === 0) {
            out.push({ sel: css.slice(selStart, open), body: css.slice(bodyStart, i) })
            selStart = i + 1
          }
        }
      }
      return out
    }
    // 反向自检：扫描器必须真的能解析出规则，否则「没找到违规」只是「什么都没解析出来」。
    expect(rulesOf(stripped).length, '扫描器应能解析出规则').toBeGreaterThan(100)

    const offenders = rulesOf(stripped)
      .filter(r => /\.dim-jh-modelId\b/.test(r.sel) && /max-width:\s*(?!none)\S/.test(r.body))
      .map(r => r.sel.trim().replace(/\s+/g, ' ') + ' { ' + (r.body.trim().match(/max-width:[^;]*/)?.[0] ?? '') + ' }')
      // 允许的只有模型列表那份基础规则（.dim-jh-modelId 单独出现，46%，在网关之外且刻意）。
      .filter(one => !/^\.dim-jh-modelId \{/.test(one))
    expect(offenders, '网关弹窗内不得再有给 .dim-jh-modelId 设上限的规则').toEqual([])
  })

  it('★ 去掉上限后，开关行的标题「启用本机网关」不得被副标题挤断', () => {
    // ⚠️ 这是**修截断时新引入的**排版退化（渲染截图发现）：
    //   胶囊不再有 max-width 上限后把整行吃光，而 .dim-jh-modelName 是
    //   `flex: 0 1 auto`（可收缩）⇒ 标题被压成「启用本机网」「关」两行。
    //   修法是让**标题**保持固有宽度、由副标题去换行。
    // ⚠️ 判据用 `> .dim-jh-modelName`（直接子元素）而不是 `.dim-jh-modelName`：
    //   后者会连卡片行里的模型展示名一起命中，而那里的收缩是刻意的
    //   （长展示名必须能给胶囊让位，见 GatewayModelRow）。
    const stripped = styles.replace(/\/\*[\s\S]*?\*\//g, '')
    const m = /\.dim-jh-gatewayModal \.dim-jh-modelInfo > \.dim-jh-modelName \{([^{}]*)\}/.exec(stripped)
    expect(m, '开关行标题应有「保持固有宽度」的规则').not.toBeNull()
    expect(m![1]).toContain('flex: none')
    // ⚠️ 反向：**不能**把这条写成通配（那会把卡片行的展示名也钉死，长名横向溢出）。
    expect(stripped).not.toMatch(/\.dim-jh-gatewayModal \.dim-jh-modelName \{[^}]*flex: none/)
  })

  it('★ 弹窗里每个 .dim-jh-modelId 渲染点，祖先链都被两级通配覆盖', () => {
    // 上一条锁的是「选择器长什么样」；这一条锁**渲染处确实存在这些位置**，
    // 否则「改成通配」可能只是因为我把那几处渲染删掉了（那就不是修好，是移走）。
    // ⚠️ 用**整个 GatewayPanel 到文末**做区间：卡片行渲染在 GatewayModelRow 里，
    // 用 `indexOf('export function JetHubPage')` 截断会把它们切掉（实测踩到）。
    const panel = source.slice(source.indexOf('function GatewayPanel('))
    // ① 开关行那个 code（用户 2026-10-04 要求把客户端列举删掉，只剩这一句；
    //    issue IKL7UN 之后地址改为取自真实 host，句式不变）
    expect(panel).toMatch(/`在 \$\{status\.address\.host\} 监听，供客户端调用`/)
    // ② 卡片行内的模型 ID（在 GatewayModelRow 里，同一个文件）
    expect(source).toContain('gatewayModelKeyOf(model)')
    // ③ API KEY 明文那块也用它（显示明文时，祖先只有 gatewayKeyRow）
    expect(panel).toContain("className: 'dim-jh-gatewayKeyRow'")
    expect(panel).toMatch(/apiKey\.value/)
    // ⚠️ 两处 curl 代码块**已被用户要求删除**（它们曾是这条判据的第 4/5 个渲染点）。
    //    删掉之后 `.dim-jh-modelId` 在弹窗里仍有 3 个位置、祖先链各不相同 ——
    //    故两级通配**仍然必需**，这条判据没有因为删 curl 而失效。
    expect(stripCommentsOf(panel)).not.toContain('gatewayModelsCurl(')
    // 这些位置**没有**共同的中间祖先 —— 故只能两级通配。
    expect(stripCommentsOf(source)).not.toContain('dim-jh-gatewayModelRow .dim-jh-modelId')
  })

  it('★ 卡片标题不再截断（长供应商名被截成 deepseek-accou… 是用户报障的形态）', () => {
    const body = rule('.dim-jh-gatewayCardToggle')
    expect(body).not.toBe('')
    expect(body).not.toContain('ellipsis')
    expect(body).not.toContain('nowrap')
    // 长供应商名要能落到第二行显示，而不是被省略号吃掉。
    expect(body).toContain('overflow-wrap: anywhere')
  })

  it('★ 能力标记（可发图片 / 需对照）在网关弹窗内允许换行', () => {
    const body = rule('.dim-jh-gatewayModal .dim-jh-modelBadge')
    expect(body).not.toBe('')
    expect(body).toContain('white-space: normal')
    expect(body).not.toContain('nowrap')
  })

  it('★ 模型列表那份紧凑样式**没被顺手改坏**（截断是那里的刻意设计）', () => {
    // 网关的修法必须**只**作用在 .dim-jh-gatewayModal 之内：模型列表面向 478 条
    // 目录，一行里还要放开关，去掉 max-width/ellipsis 会把整列撑坏。
    expect(rule('.dim-jh-modelId')).toContain('max-width: 46%')
    expect(rule('.dim-jh-modelId')).toContain('ellipsis')
    expect(rule('.dim-jh-modelBadge')).toContain('flex: none')
    expect(rule('.dim-jh-modelBadge')).toContain('nowrap')
  })

  it('★ 「可发图片」徽标仍保留 flex: none 的兜底（模型列表那份）', () => {
    // 上一条已锁；这里再单独点名，因为它是 2026-10-03 那条报障的直接回归点。
    expect(rule('.dim-jh-modelBadge')).toContain('flex: none')
  })
})

/**
 * 「下面的四个按钮也按复制密钥的大小来统一」（用户 2026-10-04）。
 *
 * 四个按钮 = 复制全部 N 个 ID / 展开清单 / 展开对照表 / 复制对照表。
 * 它们原先走通用的 `.dim-jh-btn`（约 28px 高），比同行 18px 高的文字高 10px，
 * 既撑高行、又与上面密钥行的两个小按钮观感割裂。
 */
describe('网关弹窗的按钮尺寸统一（用户要求与「复制密钥」同款）', () => {
  const styles = readFileSync(resolve(HERE, '../../plugin-src/client/jet-hub-styles.js'), 'utf8')

  it('★ 密钥行与清单操作行**共用同一条**小号按钮规则', () => {
    // ⚠️ 判据是「同一条规则里同时出现两个选择器」：各写一份迟早一处改了另一处没改。
    const match = styles.match(/\.dim-jh-gatewayKeyRow \.dim-jh-btn,\s*\.dim-jh-gatewayModal \.dim-jh-gatewayActions \.dim-jh-btn \{([^}]*)\}/)
    expect(match, '两个选择器应写在同一条规则里').not.toBeNull()
    const body = match![1]
    // 与密钥行原先那套完全一致（padding 2px 8px / 11px / 16px / 圆角 6px）。
    expect(body).toContain('padding: 2px 8px')
    expect(body).toContain('font-size: 11px')
    expect(body).toContain('line-height: 16px')
    expect(body).toContain('border-radius: 6px')
  })

  it('★ 两处操作行都挂上了 dim-jh-gatewayActions 钩子（接线，不只是样式在) ', () => {
    // 纯样式在、但没人挂类名 = 尺寸根本没生效（「判据还在但没人调用」的同型缺陷）。
    const hooks = source.match(/className: 'dim-jh-modelPanelActions dim-jh-gatewayActions'/g)
    expect(hooks, '模型清单与对照表两个操作行都要挂钩子').toHaveLength(2)
  })

  it('★ 通用按钮没被改小（30+ 处调用点：页头、卡片头…）', () => {
    // ⚠️ 必须**行首锚定**：`\.dim-jh-btn \{` 也会命中
    //    `.dim-jh-railActions > .dim-jh-btn {`（2026-11-05 侧边栏底部操作行
    //    新增的小号变体）—— 那条写在基础规则**之前**，不加锚点就会取到它的
    //    `padding: 6px 4px`，误报「通用按钮被改小」。
    const generic = /(?:^|\n)\.dim-jh-btn \{([^}]*)\}/.exec(styles)?.[1] ?? ''
    expect(generic, '找不到基础 .dim-jh-btn 规则').not.toBe('')
    expect(generic).toContain('padding: 4px 12px')
    expect(generic).toContain('line-height: 18px')
  })

  it('★ 操作行允许换行 —— 按钮文案带动态计数，nowrap 会被推出容器', () => {
    // ⚠️ 这条来自一次**机械审计**（audit-gateway-pills.mjs）：把网关弹窗用到的类
    // 与样式表里带截断属性的类求交集，`.dim-jh-btn` 因 `white-space: nowrap` 落在交集里。
    // nowrap 本身对按钮是对的（防按钮内文字折行），但它在窄容器里的真实风险是
    // 「按钮被整体推出容器、点不到」—— 而这两行的文案带着**模型数/行数**，
    // 数字变长就会发生。故操作行必须能换行。
    // ⚠️ 本段没有 pills 那段里的 `rule()` 辅助函数（不同 describe 作用域），此处就地取。
    const body = /\.dim-jh-gatewayModal \.dim-jh-gatewayActions \{([^}]*)\}/.exec(styles)?.[1] ?? ''
    expect(body, '操作行应有网关专用规则').not.toBe('')
    expect(body).toContain('flex-wrap: wrap')
    // 间距仍与密钥行一致。
    expect(body).toContain('gap: 6px')
  })
})

/**
 * 用户 2026-10-04 第四批（第二轮）的四条要求。
 *
 * 原话：「① 修改『启用本机网关』右边的那个胶囊为『在 127.0.0.1 监听，供客户端调用』。
 * ② 思考档位对照表里的『展开对照表』与『复制对照表』两个按钮位置互换。
 * ③ 删掉这两段：命令行查看同一份目录/对照表 + 那两条 curl。
 * ④ 这三个红框框起来的不同的功能段，能明显的区分开来。」
 */
describe('网关弹窗第四批（第二轮）：胶囊文案 / 按钮顺序 / 删 curl / 分段', () => {
  const styles = readFileSync(resolve(HERE, '../../plugin-src/client/jet-hub-styles.js'), 'utf8')
  const css = styles.slice(styles.indexOf('`') + 1, styles.lastIndexOf('`'))
  /** 剥注释：注释里会**引用**被判为禁止的写法（本轮踩过多次假红）。 */
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const panel = source.slice(source.indexOf('function GatewayPanel('))

  it('① 开关行胶囊只留「在 … 监听，供客户端调用」，且地址取自真实 host', () => {
    // ⚠️ 用户 2026-10-04 定下的**句式**保留（「在 X 监听，供客户端调用」）。
    // ✅ issue IKL7UN 之后 X 必须来自 `status.address.host`：写死 127.0.0.1 会让
    // 容器部署的用户照着抄一个从容器外连不上的地址 —— 正是该 issue 的症状。
    expect(panel).toMatch(/`在 \$\{status\.address\.host\} 监听，供客户端调用`/)
    // 未在监听时退回定性说法，**不得**编造具体地址（与 gatewayEndpoint 的取舍同源）。
    expect(panel).toContain("'在本机监听，供客户端调用'")
    // ⚠️ 硬编码 127.0.0.1 的胶囊**必须消失**（剥注释后判，注释里会引用旧写法）。
    expect(code(panel)).not.toContain('在 127.0.0.1 监听，供客户端调用')
    // ⚠️ 客户端列举必须删掉 —— 它是窄面板下折行、且把「打开/关闭」动作词挤远的成因。
    // 但要**先剥注释**：说明「原先列了 Pi / Continue …」的注释里原样写着它们。
    expect(code(panel)).not.toContain('Pi / Continue')
    // ⚠️ 「打开/关闭」这个动作词不能跟着一起删：胶囊里现在不含它了，
    // 它由开关的 aria-label 承担（读屏与 tooltip 仍能说清点下去会发生什么）。
    expect(panel).toMatch(/'aria-label': action \+ '本机网关'/)
  })

  it('② 对照表两个按钮互换：复制在前、展开在后（与模型清单那段一致）', () => {
    // 判据是**顺序**，不是「两个按钮都在」。
    const copyAt = panel.indexOf('复制对照表（${visibleEffortRows.length} 行）')
    const toggleAt = panel.indexOf('收起对照表')
    expect(copyAt, '复制按钮应在').toBeGreaterThan(-1)
    expect(toggleAt, '展开按钮应在').toBeGreaterThan(-1)
    expect(copyAt, '复制按钮必须排在展开按钮之前').toBeLessThan(toggleAt)
    // 反向：模型清单那段本来就是「复制 → 展开」，两段口径必须一致。
    const idsAt = panel.indexOf('复制全部 ${visibleModels.length} 个 ID')
    const listAt = panel.indexOf("'收起清单'")
    expect(idsAt).toBeLessThan(listAt)
  })

  it('③ 两段 curl 命令与它们的说明句都从弹窗里删掉了', () => {
    const stripped = code(panel)
    expect(stripped).not.toContain('命令行查看同一份目录')
    expect(stripped).not.toContain('命令行查看同一份对照表')
    expect(stripped).not.toContain('gatewayModelsCurl(')
    expect(stripped).not.toContain('gatewayEffortsCurl(')
    // ⚠️ 「地址栏直接打开会 401」那句 401 说明是 curl 段的标题的一半，一并删掉；
    // 但**这个事实本身不能丢** —— 它已由 README 承担（`README.md` 的「模型清单」节）。
    expect(stripped).not.toContain('地址栏直接打开会 401')
    const readme = readFileSync(resolve(HERE, '../../README.md'), 'utf8')
    expect(readme, '401 这件事必须在 README 里仍有交代').toContain('401')
  })

  it('④ 三段各有一个 .dim-jh-gatewaySection 容器，且段间有分隔', () => {
    // 结构：三个段容器（开关+连接信息 / 模型 ID / 思考档位对照表）。
    expect((panel.match(/className: 'dim-jh-gatewaySection'/g) || []).length, '应恰好三段')
      .toBe(3)
    // 段标题只有后两段有（第一段以开关行为锚，无需标题）。
    expect((panel.match(/className: 'dim-jh-gatewaySectionTitle'/g) || []).length).toBe(2)
    // ⚠️ 分隔靠 `A + B` **相邻兄弟**选择器：写成 `.dim-jh-gatewaySection` 通配
    // 会给第一段也加上边框，紧贴弹窗标题的一条横线看着像多出来的分隔条。
    expect(css).toMatch(/\.dim-jh-gatewaySection \+ \.dim-jh-gatewaySection \{[^}]*border-top/)
    expect(css).toMatch(/\.dim-jh-gatewaySection \+ \.dim-jh-gatewaySection \{[^}]*margin-top/)
    // ⚠️ 段标题必须比段内说明**更重**：两者同为 12px 灰字时分隔线的效果会被抵消。
    const title = /\.dim-jh-gatewaySectionTitle \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(title).toContain('font-weight: 600')
    expect(title).not.toContain('8f959e')
  })

  it('④ 末尾那条安全提示是**脚注**，与三段分开（它不属于任何一段）', () => {
    const foot = /\.dim-jh-gatewayModal \.dim-jh-gatewayFootnote \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(foot, '脚注应有自己的规则').not.toBe('')
    expect(foot).toContain('border-top')
    // 渲染处确实用了这个类，且出现在「思考档位对照表」之后。
    expect(panel).toContain('dim-jh-modalHint dim-jh-gatewayFootnote')
    expect(panel.indexOf('dim-jh-gatewayFootnote')).toBeGreaterThan(panel.indexOf('思考档位对照表'))
    // ⚠️ 它必须在**最后一个段容器之外**：判据是「脚注那行之后不再有段容器的收尾」——
    // 用「脚注是 dim-jh-modalBody 的最后一个子元素」这个更稳的说法：
    // 脚注之后只应剩 notice 段（它本来就是弹窗级的提示，不属于三段之一）。
    const after = panel.slice(panel.indexOf('dim-jh-gatewayFootnote'))
    expect(after).not.toContain("className: 'dim-jh-gatewaySection'")
  })
})

/**
 * 行内只显示**去掉供应商前缀**的模型名（用户要的「模型名显示别那么乱」）。
 *
 * 卡片头已经写明供应商，行内再重复前缀是纯噪声：实测
 * `codearts/deepseek-v4.1-flash` 这类 id 占满整行，在 `max-width: 46%` 的夹取下跌成
 * `codearts/deepse…` —— 用户既看不出模型名，也读不到能复制的 ID。
 */
describe('卡片内的模型名（去掉供应商前缀）', () => {
  it('★ 用宿主给的权威 model 字段，不靠切 id', () => {
    expect(gatewayModelKeyOf({ id: 'codearts/GLM-5.2', provider: 'codearts', model: 'GLM-5.2' }))
      .toBe('GLM-5.2')
  })

  it('⚠️ model 缺失时按前缀剥一次，剥不掉就退回完整 id（绝不返回空行）', () => {
    expect(gatewayModelKeyOf({ id: 'codearts/GLM-5.2', provider: 'codearts' })).toBe('GLM-5.2')
    // 前缀对不上（字段畸形）时不能硬切，否则会切出半个 ID。
    expect(gatewayModelKeyOf({ id: 'codearts/GLM-5.2', provider: 'other' })).toBe('codearts/GLM-5.2')
    expect(gatewayModelKeyOf({ id: 'bogus' })).toBe('bogus')
    expect(gatewayModelKeyOf(null)).toBe('')
  })

  it('⚠️ 模型名里带斜杠时只剥 provider 那一段（不是按斜杠切一半）', () => {
    expect(gatewayModelKeyOf({
      id: 'cline/anthropic/claude-sonnet-5.5', provider: 'cline', model: 'anthropic/claude-sonnet-5.5',
    })).toBe('anthropic/claude-sonnet-5.5')
  })

  it('★ 对照表行同样只显示短名字，但复制出去的仍是完整 id', () => {
    const row = gatewayEffortRow({
      id: 'trae/deepseek-v4.1-flash',
      provider: 'trae',
      model: 'deepseek-v4.1-flash',
      name: 'Flash',
      reasoning: { efforts: [{ id: 'high', name: 'High', canonical: 'high' }], openai_efforts: ['high'] },
    })
    expect(row?.model).toBe('deepseek-v4.1-flash')
    expect(row?.provider).toBe('trae')
    // ⚠️ 复制用的 `id` 必须保持完整 —— 抄一个短名字进客户端必然 404。
    expect(row?.id).toBe('trae/deepseek-v4.1-flash')
    expect(gatewayEffortsText([row!])).toContain('trae/deepseek-v4.1-flash')
  })
})

/**
 * 卡片的折叠规则。
 *
 * 网关清单是**全 provider 汇总**，Cline 一家实测近 500 条，全展开等于把弹窗
 * 撑成没法翻的长条（用户找的是「哪家有哪些模型」，不是「一次看完 500 行」）。
 */
describe('供应商卡片的折叠', () => {
  const small = { counts: { total: 3, fold: 0 } }
  const huge = { counts: { total: GATEWAY_CARD_AUTOCOLLAPSE_AT + 1, fold: 0 } }

  it('默认：小卡片展开，超过阈值的折叠（折叠是可见的，不会让人以为丢了行）', () => {
    expect(gatewayCardExpanded(small)).toBe(true)
    expect(gatewayCardExpanded(huge)).toBe(false)
    expect(gatewayCardExpanded({ counts: { total: GATEWAY_CARD_AUTOCOLLAPSE_AT } })).toBe(true)
  })

  it('★ 用户点过之后以用户为准（两个方向都要生效）', () => {
    expect(gatewayCardExpanded(huge, { toggled: true })).toBe(true)
    expect(gatewayCardExpanded(small, { toggled: false })).toBe(false)
  })

  it('★ 有搜索词时一律展开 —— 否则搜到的结果藏在折叠卡里，用户以为「搜不到」', () => {
    expect(gatewayCardExpanded(huge, { searching: true })).toBe(true)
    // ⚠️ 但用户**显式折叠过**的仍要听用户的（优先级：点过 > 搜索 > 默认）。
    expect(gatewayCardExpanded(huge, { toggled: false, searching: true })).toBe(false)
  })

  it('脏输入退化为展开（宁可多显示，也不要藏起来）', () => {
    expect(gatewayCardExpanded(null)).toBe(true)
    expect(gatewayCardExpanded({})).toBe(true)
  })
})

/**
 * 「允许局域网访问」开关（2026-10-20）的判定与文案。
 *
 * ⚠️ 安全文案的两条既有规矩在这里继续生效：
 * 1. **不得出现 `**`**（React 文本节点会原样显示星号）；
 * 2. 非回环警告**必须点名宿主**（红队 netns 实测宿主可达，只说「同网络设备」
 *    会把它漏掉 —— 既有用例守着这条）。
 */
describe('「允许局域网访问」开关的判定与文案', () => {
  const base = { enabled: true, running: true, blockedByEnv: false } as const

  it('★ 只在 env 显式给了 host 时禁用（那一刻翻开关改变不了监听地址）', () => {
    expect(gatewayAllowLanSwitchDisabled(null)).toBe(true)
    expect(gatewayAllowLanSwitchDisabled({ ...base, allowLan: false, hostFromEnv: false, address: null })).toBe(false)
    expect(gatewayAllowLanSwitchDisabled({ ...base, allowLan: false, hostFromEnv: true, address: null })).toBe(true)
    // ⚠️ 网关总开关关闭时**不禁用**：用户可以先选好，打开总开关时立即生效。
    expect(gatewayAllowLanSwitchDisabled({
      ...base, enabled: false, allowLan: false, hostFromEnv: false, address: null,
    })).toBe(false)
  })

  it('★ 提示文案按状态分支，且不得出现 markdown 星号', () => {
    const off = gatewayAllowLanHint({ ...base, allowLan: false, hostFromEnv: false, address: null })
    const on = gatewayAllowLanHint({ ...base, allowLan: true, hostFromEnv: false, address: null })
    const overridden = gatewayAllowLanHint({ ...base, allowLan: true, hostFromEnv: true, address: null })
    expect(off).toContain('127.0.0.1')
    expect(off).not.toContain('**')
    expect(on).toContain('0.0.0.0')
    expect(on).toContain('API Key')
    expect(on).not.toContain('**')
    // env 覆盖时必须明说「不生效」——「打开了却没反应」比禁用并解释更让人困惑。
    expect(overridden).toContain('DSH_OPENAI_GATEWAY_HOST')
    expect(overridden).toContain('不生效')
  })

  it('★ 切换通知按结果分支', () => {
    expect(gatewayAllowLanToggleNotice({ ...base, allowLan: true, hostFromEnv: true, address: null }, true))
      .toContain('不生效')
    expect(gatewayAllowLanToggleNotice({
      ...base, allowLan: true, hostFromEnv: false, address: { host: '0.0.0.0', port: 8326 },
    }, true)).toContain('局域网 IP')
    expect(gatewayAllowLanToggleNotice({
      ...base, allowLan: false, hostFromEnv: false, address: { host: '127.0.0.1', port: 8326 },
    }, false)).toContain('127.0.0.1')
    // 网关没在监听时不得谎称「已改绑」。
    expect(gatewayAllowLanToggleNotice({
      ...base, running: false, allowLan: true, hostFromEnv: false, address: null,
    }, true)).toContain('没有在监听')
  })

  it('★ 翻 LAN 开关失败时必须转述真实原因，不得把用户指向「先开总开关」（Issue #11）', () => {
    // ⚠️ 这条锁的是**错误归因**：翻 LAN 开关时网关总开关**本来就是开的**
    // （用户刚点的就是 LAN 开关），而换绑自身可能失败（要关旧实例再重建）。
    // 原先一律回「先打开网关总开关」⇒ 把用户指向一个已经满足的条件。
    const withReason = gatewayAllowLanToggleNotice({
      ...base,
      running: false,
      allowLan: true,
      hostFromEnv: false,
      address: null,
      lastError: { kind: 'start-failed', reason: 'listen EADDRINUSE: address already in use' },
    }, true)
    expect(withReason).toContain('EADDRINUSE')
    expect(withReason).toContain('换绑失败')
    expect(withReason).not.toContain('先打开网关总开关')

    // 反向对照：没有 lastError 时才允许说「先打开总开关」——
    // 否则上一条断言在「无条件都说换绑失败」的实现下也会绿（无牙）。
    const withoutReason = gatewayAllowLanToggleNotice({
      ...base, running: false, allowLan: true, hostFromEnv: false, address: null, lastError: null,
    }, true)
    expect(withoutReason).toContain('先打开网关总开关')
  })

  it('★ 绑 0.0.0.0 时状态行必须教用户把地址换成局域网 IP（0.0.0.0 抄走连不上）', () => {
    const lines = gatewayStatusLines({
      enabled: true,
      running: true,
      blockedByEnv: false,
      allowLan: true,
      hostFromEnv: false,
      address: { host: '0.0.0.0', port: 8326 },
      apiKey: null,
      models: [],
      modelsSource: 'none',
    })
    const joined = lines.join('\n')
    expect(joined).toContain('0.0.0.0')
    expect(joined).toContain('局域网 IP')
    // 非回环警告必须点名宿主（既有守卫，见脚注用例的同条理由）。
    expect(joined).toContain('宿主')
  })

  it('★ 回环部署的状态行不出现局域网指引（避免把精简过的文案重新撑肿）', () => {
    const lines = gatewayStatusLines({
      enabled: true,
      running: true,
      blockedByEnv: false,
      allowLan: false,
      hostFromEnv: false,
      address: { host: '127.0.0.1', port: 8326 },
      apiKey: null,
      models: [],
      modelsSource: 'none',
    })
    expect(lines.join('\n')).not.toContain('局域网 IP')
  })
})

/**
 * ★★ **「已选择允许局域网、但网关没在监听」不得谎报「已监听」**（2026-10-22 对抗审计 P2）。
 *
 * ## 修的那个真缺陷
 *
 * `gatewayAllowLanHint` 原来只判 `status.allowLan`，不判 `status.running` ⇒ 用户打开
 * 开关但**网关总开关关着 / 端口被占 / env 停用**时，它输出「**已监听**全部网卡」——
 * 这是**错误的安全陈述**（谎报暴露），且与同一弹窗里另外两条文案直接矛盾：
 * - `gatewayStatusLines` 说「网关已关闭，不会监听任何端口」；
 * - `gatewayFootnote` 说「网关只绑定 127.0.0.1」。
 *
 * ⇒ 三条文案对「现在到底在不在监听」给出**三种答案**。
 * ⚠️ 这正是本仓 IKL7UN 反复记的那种「面板输出它自己声称要消除的错误安全陈述」，
 *   只是方向反了（谎报暴露而非谎报安全）。
 * ⚠️ 同文件 `gatewayAllowLanToggleNotice` **已经**判了 `running` ⇒ 这是
 *   「同一语义两套判据」的实例，本次把 hint 补齐到同口径。
 *
 * ⚠️ 既有那条「提示文案按状态分支」的用例用的 `base` 是 `running: true`
 * ⇒ **只覆盖了「已在监听」那一格**，对「已选择但未监听」零判别力（我实测：
 *    把 `&& status.running` 去掉后它仍 107 passed）。
 */
describe('★ 局域网开关：已选择但未监听时不得谎报「已监听」', () => {
  it('★★ allowLan=true 且 running=false ⇒ 不得出现「已监听」，必须说「还没生效」', () => {
    const hint = gatewayAllowLanHint({
      enabled: false,
      running: false,
      blockedByEnv: false,
      allowLan: true,
      hostFromEnv: false,
      address: null,
    } as never)
    expect(hint, '⚠️⚠️ 网关没在监听，绝不能说「已监听」').not.toContain('已监听')
    expect(hint, '必须如实说「没有在监听」').toContain('没有在监听')
    expect(hint, '必须给出可执行的出路（打开总开关）').toContain('总开关')
    // 与另外两条文案不矛盾的核验：这句不得断言「已绑定」。
    expect(hint).not.toContain('已改绑')
  })

  it('★ allowLan=true 且 running=true ⇒ 仍然说「已监听」（修复不得削掉正向那一格）', () => {
    const hint = gatewayAllowLanHint({
      enabled: true,
      running: true,
      blockedByEnv: false,
      allowLan: true,
      hostFromEnv: false,
      address: { host: '0.0.0.0', port: 8326 },
    } as never)
    expect(hint).toContain('已监听')
    expect(hint).toContain('0.0.0.0')
  })
})
