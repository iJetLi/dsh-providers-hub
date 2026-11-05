import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildProxyDispatcher, buildSocks5Handshake, closeAllProxyDispatchers, proxyCacheSize, resolveConnectPort } from '../../src/opencode-proxy.js'
import type { NormalizedProxy } from '../../src/opencode.js'

const httpProxy: NormalizedProxy = { kind: 'http', url: 'http://127.0.0.1:7897', label: 'http://127.0.0.1:7897' }
const socksProxy: NormalizedProxy = { kind: 'socks5', url: 'socks5://127.0.0.1:1080', label: 'socks5://127.0.0.1:1080' }

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(join(here, rel), 'utf8')

/**
 * 剥掉注释后再做结构性断言。
 *
 * ⚠️ **必须有**：本文件的注释**故意**引用了那些「反面写法」
 * （例如「不许再写 `fetch(url, { dispatcher })`」「只取 error.message」），
 * 直接对原文做正则会被注释命中而**假失败** —— 写这组用例时实测到
 * （两条断言都因注释里的示例文本变红）。
 *
 * 只处理 `//` 行注释与 `/* *\/` 块注释；不追求完美的词法分析（够用即可，
 * 本仓库被检查的三个文件里没有「字符串里含 `//`」的病态写法）。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * 收集 `src/` 下全部 .ts 文件（相对仓库根）。
 *
 * 用真扫目录而不是写死文件清单：**后来者新增的调用点也要被这道闸覆盖** ——
 * 写死清单会让新文件绕过检查，那正是本不变式要被防住的场景。
 */
function listSrcFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts')) out.push(full)
    }
  }
  walk(join(here, '../../src'))
  return out
}

/**
 * 「有人自己把 dispatcher 塞给请求」的判据（在**去注释**的源码上判）。
 *
 * ## ⚠️ 演进史（两次被绕过，都是实测）
 *
 * **初版**：`/\bfetch\s*\([^;]{0,400}?dispatcher\s*:/`（要求 dispatcher 字面量
 * 出现在同一个 fetch 调用的括号里）。实测**6 种等价写法漏网**，最现实的一种是
 *
 *     const init = { dispatcher: d }; fetch(url, init)
 *
 * ⇒ 说明「绑定到 fetch 调用」这个思路本身就是错的（键可以不在调用点出现）。
 *
 * **二版**：`/\bdispatcher\s*:/`（只认属性定义本身）。把漏网降到 2 种，
 * 但仍有：`fetch(url, { ['dispatcher']: d })` 与 `[k]` 模板键 —— 计算属性名。
 *
 * **三版（当前）**：`/\bdispatcher\b/` —— 连**标识符本身**一起禁。
 * 实测 7 种写法**零漏网**，且对 `src/` **零误伤**：
 * - 大小写敏感，故大写的类型名 `Dispatcher`、函数名 `closeAllProxyDispatchers`
 *   都不会命中（`src/index.ts` 里那两处就是 `closeAllProxyDispatchers`，实测不命中）；
 * - 属性**读取**（`init.dispatcher`）会命中 —— 但 `src/` 里本来就不该读它
 *   （唯一合法落点是 `opencode-proxy.ts`，已整体豁免），故不是误伤而是正当收紧。
 *
 * ## ⚠️ 分层：`src/` 用最严判据，**测试文件**用属性级判据（实测踩过）
 *
 * 测试文件里天然存在**正当**的 `dispatcher` 措辞 —— 例如 live spec 的用例名
 * `'per-request dispatcher 生效'`、以及断言里的 `expect(seen.dispatcher)`。
 * 对它们套最严判据会**假失败**（实测：live spec 那条确实红了）。
 * 故分两个常量用，别混：
 * - {@link DISPATCHER_MENTION} → 只用于扫 `src/`；
 * - {@link DISPATCHER_PROPERTY} → 用于测试文件（只禁「当属性塞进请求对象」）。
 */
const DISPATCHER_MENTION = /\bdispatcher\b/
const DISPATCHER_PROPERTY = /\bdispatcher\s*:/

describe('buildProxyDispatcher', () => {
  it('HTTP 代理产出可用的 Dispatcher（含 dispatch/close/destroy）', () => {
    const d = buildProxyDispatcher(httpProxy) as unknown as Record<string, unknown>
    expect(typeof d.dispatch).toBe('function')
    expect(typeof d.close).toBe('function')
    expect(typeof d.destroy).toBe('function')
  })
  it('⚠️ 同 URL 复用同一实例（连接池复用）', () => {
    const a = buildProxyDispatcher(httpProxy)
    const b = buildProxyDispatcher({ ...httpProxy })
    expect(a).toBe(b)
  })
  it('不同 URL 得到不同实例', () => {
    const a = buildProxyDispatcher(httpProxy)
    const b = buildProxyDispatcher({ ...httpProxy, url: 'http://127.0.0.1:1080' })
    expect(a).not.toBe(b)
  })
  it('SOCKS5 代理也产出 Dispatcher 子集', () => {
    const d = buildProxyDispatcher(socksProxy) as unknown as Record<string, unknown>
    expect(typeof d.dispatch).toBe('function')
    expect(typeof d.close).toBe('function')
  })
  it('⚠️ 密码型 SOCKS5 URL 也能建实例（认证走隧道层，不是 URL 层）', () => {
    const d = buildProxyDispatcher({ ...socksProxy, url: 'socks5://u:p@127.0.0.1:1080' })
    expect(d).toBeDefined()
  })
  it('closeAllProxyDispatchers 清空缓存', async () => {
    buildProxyDispatcher(httpProxy)
    expect(proxyCacheSize()).toBeGreaterThan(0)
    await closeAllProxyDispatchers()
    expect(proxyCacheSize()).toBe(0)
  })
  it('LRU 上限：超过 16 个不同代理后旧实例被淘汰', async () => {
    for (let i = 0; i < 20; i++) {
      buildProxyDispatcher({ kind: 'http', url: `http://127.0.0.1:${9000 + i}`, label: '' })
    }
    expect(proxyCacheSize()).toBe(16)
    await closeAllProxyDispatchers()
  })
})

describe('SOCKS5 握手帧（RFC 1928/1929）', () => {
  it('无认证：VER=5 METHOD=0', () => {
    const hello = buildSocks5Handshake({ url: 'socks5://127.0.0.1:1080' })
    expect([...hello]).toEqual([0x05, 0x01, 0x00])
  })
  it('带认证：METHOD 序列含 0x02（用户名密码）', () => {
    const hello = buildSocks5Handshake({ url: 'socks5://u:p@127.0.0.1:1080' })
    expect(hello[0]).toBe(0x05)
    expect(hello[1]).toBe(0x02)
    expect([...hello].includes(0x02)).toBe(true)
  })
  it('只有用户名（无密码）也算带认证', () => {
    const hello = buildSocks5Handshake({ url: 'socks5://u@127.0.0.1:1080' })
    expect(hello[1]).toBe(0x02)
  })
  it('percent-encoded 的凭据被解码（用户填的 %40 是 @）', () => {
    const hello = buildSocks5Handshake({ url: 'socks5://user%40corp:p%40ss@127.0.0.1:1080' })
    expect(hello[1]).toBe(0x02)
  })
})

/**
 * ⚠️⚠️ **SOCKS5 目标端口解析**（真实缺陷，2026-10-08 实测，pre-existing）。
 *
 * 事故：旧实现写 `Number(opts.port ?? 443)`，而 undici 对**默认端口**传的是
 * **空字符串 `""`**（不是 `undefined`）——`??` 兜不住空串 ⇒ `Number("") === 0`
 * ⇒ CONNECT 帧端口写成 0 ⇒ 上游按端口 0 连接**必然失败**。
 *
 * 命中面正好是生产主路径：`OPENCODE.baseUrl = https://opencode.ai/zen`（默认 443），
 * 故「SOCKS5 代理」修复前**恒不可用**（实测三代 Node 一致：
 * `CONNECT → "opencode.ai:0"` 失败；显式端口 `example.com:8443` 则通过）。
 *
 * ⚠️ 这些用例是**纯函数**判据（不起真实隧道），故能稳定覆盖「空串」这个关键输入 ——
 * 端到端用例很难构造出「undici 传空串」这一步。
 */
describe('⚠️ resolveConnectPort：默认端口的空串必须兜住（真实缺陷）', () => {
  it('⚠️ 空串 `""`（undici 对默认端口的真实形态）→ 按协议回退，绝不能得到 0', () => {
    // 这一条就是本缺陷的核心：旧实现此处返回 0
    expect(resolveConnectPort({ port: '', protocol: 'https:' })).toBe(443)
    expect(resolveConnectPort({ port: '' })).toBe(80)
    // 反面锁死：绝不能是 0（CONNECT 帧写 0 会导致必然失败）
    expect(resolveConnectPort({ port: '', protocol: 'https:' })).not.toBe(0)
  })

  it('显式端口原样采用（数字与字符串两种形态）', () => {
    expect(resolveConnectPort({ port: '8443', protocol: 'https:' })).toBe(8443)
    expect(resolveConnectPort({ port: 8443, protocol: 'https:' })).toBe(8443)
    expect(resolveConnectPort({ port: '1080' })).toBe(1080)
  })

  it('协议默认端口按协议区分（https/wss → 443，其余 → 80）', () => {
    expect(resolveConnectPort({ port: '', protocol: 'https:' })).toBe(443)
    expect(resolveConnectPort({ port: undefined, protocol: 'wss:' })).toBe(443)
    expect(resolveConnectPort({ port: '', protocol: 'http:' })).toBe(80)
    // ⚠️ 不把 443 当通用兜底：那会把「端口没给对」伪装成「连不上」
    expect(resolveConnectPort({ port: '', protocol: 'http:' })).not.toBe(443)
  })

  it('undefined / null 也回退（不能只判空串而漏掉它们）', () => {
    expect(resolveConnectPort({ port: undefined, protocol: 'https:' })).toBe(443)
    expect(resolveConnectPort({ port: null as never, protocol: 'https:' })).toBe(443)
  })

  it('⚠️ 非法值一律回退（NaN / 0 / 负数 / 越界 / 小数 / 非数字串）', () => {
    for (const bad of ['abc', '0', '-1', '-443', '65536', '99999', '44.5', 'NaN', ' ', '  80  x', 'Infinity', '1e9']) {
      const got = resolveConnectPort({ port: bad, protocol: 'https:' })
      expect(got, `port=${JSON.stringify(bad)} 必须回退到 443`).toBe(443)
    }
  })

  it("⚠️ `'0x50'` 按 JS 语义解析为 80（合法端口）—— 记录该行为，不是缺陷", () => {
    // ⚠️ 写这条是因为我最初把它当「非法值」写进上一条，实测红了：
    //    `Number('0x50') === 80`，且 80 是合法端口 ⇒ 不该回退。
    //    这是 JS 数字字面量语义，不是解析缺陷；记录下来免得后人反复踩。
    expect(resolveConnectPort({ port: '0x50', protocol: 'https:' })).toBe(80)
  })

  it('边界：1 与 65535 是合法端口（不能被回退吃掉）', () => {
    expect(resolveConnectPort({ port: '1' })).toBe(1)
    expect(resolveConnectPort({ port: '65535' })).toBe(65535)
    // 65536 越界 ⇒ 回退
    expect(resolveConnectPort({ port: '65536', protocol: 'https:' })).toBe(443)
  })

  it("⚠️ 带空白的数字串按数字解析（`' 80 '` 是合法的，别被 trim 判成空）", () => {
    expect(resolveConnectPort({ port: ' 80 ' })).toBe(80)
  })

  it('⚠️ 接线闸：SOCKS5 connector 必须走 resolveConnectPort，不得再用 `?? 443`', () => {
    // 锁死「有人把它改回 Number(opts.port ?? 443)」——那正是本缺陷的写法。
    const src = stripComments(read('../../src/opencode-proxy.ts'))
    expect(src).toMatch(/resolveConnectPort\s*\(\s*opts\s*\)/)
    expect(src).not.toMatch(/Number\(\s*opts\.port\s*\?\?/)
  })
})

/**
 * ⚠️⚠️ **同源不变式的接线闸**（issue IKK4BY，2026-10-08）。
 *
 * ## 为什么必须有这一组
 *
 * 缺陷本身**不会**让既有的类型检查或行为用例变红（Node 26 上全绿、Node 22/24 上
 * 那两条「真联通」用例才红，而那两条曾被当成「环境性问题」放过两轮）。
 * 光把调用点改对，下次有人加新调用点时**又会踩同一个坑** —— 而且症状是
 * 「所有请求恒失败且只报 fetch failed」，排查成本极高。
 *
 * ⇒ 这里用**接线断言**把不变式钉死：凡是要传 dispatcher 的地方，
 *    fetch 必须与 dispatcher 同源（即经 `proxyFetch`）。
 *
 * ⚠️ 断言一律容忍重构（`(pool|p)` / `[^)]*` 那种写法在本仓库有先例）：
 * 写死整串会让每次加参数都假失败。
 */
describe('⚠️ 同源不变式（dispatcher 与 fetch 必须来自同一份 undici）', () => {
  const proxySrc = stripComments(read('../../src/opencode-proxy.ts'))
  const adapterSrc = stripComments(read('../../src/opencode-adapter.ts'))
  const rpcSrc = stripComments(read('../../src/opencode-rpc.ts'))
  const liveSrc = stripComments(read('opencode-proxy-live.spec.ts'))

  it('proxyFetch 存在且是导出的生产入口', () => {
    expect(proxySrc).toMatch(/export\s+function\s+proxyFetch/)
  })

  it('⚠️ 有代理时用 undici 自带的 fetch，无代理时才退回全局 fetch', () => {
    // 判据：proxyFetch 内部必须**引用**外部 undici 的 fetch 实现
    expect(proxySrc).toMatch(/import\s*\{[^}]*fetch\s+as\s+undiciFetch[^}]*\}\s*from\s*'undici'/)
    expect(proxySrc).toMatch(/undiciFetch\s*\(/)
    // 且「无代理」分支要保留全局 fetch（不改变既有直连行为）
    expect(proxySrc).toMatch(/proxy\s*===\s*undefined/)
  })

  it('⚠️ adapter 的 chat 调用点走 proxyFetch（不是裸 fetch + dispatcher）', () => {
    expect(adapterSrc).toMatch(/await\s+proxyFetch\s*\(/)
    // 反面：不许再出现「自己构造 dispatcher」的写法
    expect(adapterSrc).not.toMatch(DISPATCHER_MENTION)
    expect(adapterSrc).not.toMatch(/buildProxyDispatcher/)
  })

  it('⚠️ RPC 的 testProxy 调用点走 proxyFetch（不是裸 fetch + dispatcher）', () => {
    expect(rpcSrc).toMatch(/await\s+proxyFetch\s*\(/)
    expect(rpcSrc).not.toMatch(DISPATCHER_MENTION)
    expect(rpcSrc).not.toMatch(/buildProxyDispatcher/)
  })

  it('⚠️ testProxy 的错误信息必须带出 cause（不能只取 error.message）', () => {
    // 只取 message 时，所有传输层故障都退化成 `fetch failed`（issue IKK4BY 第 2 点）。
    // ⚠️ 断言要**精确到那一行接线**：`handleOpencodeRpc` 最外层还有个通用的
    // catch（非 fetch 路径），写成「全文件不许出现 error.message」会连它一起打死 ——
    // 那种断言过宽，且与本不变式无关（写这组用例时实测踩到）。
    expect(rpcSrc).toMatch(/const\s+message\s*=\s*describeFetchError\s*\(\s*error\s*\)/)
    expect(rpcSrc).not.toMatch(/const\s+message\s*=\s*error\s+instanceof\s+Error/)
  })

  it('⚠️ 全仓库 src/ 不得**提及** dispatcher（合法落点只有 opencode-proxy.ts 与 monkeycode-http.ts）', () => {
    // 这是不变式的**总闸**：任何人把 dispatcher 塞进请求选项都要变红，
    // 逼后来者改用 proxyFetch（或明确论证为何例外）。
    // ⚠️ 扫真目录而非写死清单 —— 新增文件也必须被覆盖（实测 src/ 下 169 个 .ts）。
    // ⚠️ proxyFetch 自身是唯一合法落点，故整体豁免该文件。
    // ⚠️ 用最严的 MENTION（连 ['dispatcher'] 方括号键、[k] 模板键都拦住）；
    //    测试文件不能用它（那里有正当措辞），见上面的分层说明。
    /**
     * ⚠️ 2026-11-05 审计返工：`monkeycode-http.ts` 是**第二个**合法落点。
     *
     * 它同时 `import { ProxyAgent, request } from 'undici'` —— 两者来自**同一份**
     * undici 模块实例，正是本不变式要求的口径（缺陷 IKK4BY 的成因是「dispatcher
     * 与 fetch 来自不同副本」）。且它必须直连（bili 会替换 `globalThis.fetch`），
     * 只有 `undici.request` 能同时满足「绕开全局 fetch」与「尊重代理/超时」。
     * ⚠️ 新增第三处前先确认：**import 源必须是同一个 'undici'**，否则请复用
     * `proxyFetch`。
     */
    const legalDispatcherFiles = ['opencode-proxy.ts', 'monkeycode-http.ts']
    const offenders = listSrcFiles()
      .filter((file) => !legalDispatcherFiles.some((legal) => file.endsWith(legal)))
      .filter((file) => DISPATCHER_MENTION.test(stripComments(readFileSync(file, 'utf8'))))
      .map((file) => file.slice(join(here, '../..').length + 1))
    expect(offenders).toEqual([])
  })

  it('⚠️ live 用例本身也走 proxyFetch（否则它又把这个缺陷构造了一遍）', () => {
    expect(liveSrc).toMatch(/proxyFetch\s*\(/)
    // ⚠️ 这里用**属性级**判据（不是 MENTION）：本文件有用例名
    //    `'per-request dispatcher 生效'` 这类正当措辞，套最严判据会假失败（实测）。
    //    要拦的是「把 dispatcher 当属性塞进请求对象」这个形态。
    expect(liveSrc).not.toMatch(DISPATCHER_PROPERTY)
  })

  it('⚠️ 「代理不可用」用例必须验 cause，不能只断言 rejects', () => {
    // 只断言 reject 时，契约错配（UND_ERR_INVALID_ARG）也会让它通过 ——
    // 这正是本缺陷被掩盖两轮的原因。
    expect(liveSrc).toMatch(/collectErrorCodes/)
    expect(liveSrc).toContain('UND_ERR_INVALID_ARG')
    expect(liveSrc).toContain('ECONNREFUSED')
  })

  it('⚠️ 死代理端口必须是「合法且无人监听」的端口（不是 forbidden port）', () => {
    // ⚠️ 早先这条断言的理由写错了：forbidden-port 只作用于 **target**，
    // 不检**代理**端口（实测：proxy 端口 1/9 走 ECONNREFUSED，不被拦）。
    // 故这里真正要守的是「端口合法可连接尝试」+「不像真实服务端口」：
    // 用 >1023 的 45xxx 段，避免与真实服务撞 port 造成环境相关的假绿/假红。
    const deadPort = /const\s+DEAD_PORT\s*=\s*([0-9_]+)/.exec(liveSrc)
    expect(deadPort).not.toBeNull()
    const port = Number((deadPort?.[1] ?? '0').replace(/_/g, ''))
    expect(port).toBeGreaterThan(1023)
  })
})
