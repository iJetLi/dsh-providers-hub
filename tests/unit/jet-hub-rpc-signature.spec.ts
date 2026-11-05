import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { authOf, registerJetHubRpc, type JetHubAuths } from '../../src/jet-hub-rpc.js'

/**
 * `registerJetHubRpc` 的 **auths 命名对象**形参回归。
 *
 * ## 为什么要有本文件
 *
 * 该函数原先收 **13 个位置参数**（`codearts, buddy, …, gemini`），其签名注释自陈
 * 「历史上已因少传/插队错位复发 **6 次**」。位置参数天生有这个缺陷：
 * 改签名顺序、插一个新 provider 都会**静默错位**，症状是「某个 provider 在用
 * 另一个 provider 的凭据续期」。改成命名对象后错位在**类型层面**不可能。
 *
 * ## ⚠️ 本文件的两类断言，强度完全不同
 *
 * | 断言 | 形态 | 谁能发现回归 |
 * |---|---|---|
 * | 完整命名对象调用**能编译** | 类型层 | `pnpm typecheck:tests` |
 * | 缺键 / 写错键**编译不过** | 类型层 | `pnpm typecheck:tests` |
 * | `authOf` 按 id 取实例 | 运行时 | `pnpm test` |
 * | 对象按 id 键控（不是变量名） | 运行时 | `pnpm test` |
 *
 * ⚠️⚠️ **类型层断言必须靠 `pnpm typecheck:tests` 才有牙** —— 本仓库的
 * `pnpm typecheck` 只编译 `src/`（`tsconfig.json` 的 `include` 就是 `["src"]`），
 * 而 vitest 走 esbuild **不做类型检查**。只写 `@ts-expect-error` 而不接一条
 * 类型检查命令，等于写了个恒真的注释（实测：本文件在位置参数签名下
 * `pnpm vitest run` 照样全绿）。故新增了 `tsconfig.tests.json` +
 * `typecheck:tests` 脚本，本文件是它**唯一**的编译对象。
 */

/**
 * 最小 `ctx` 桩：只提供 `registerJetHubRpc` 端点注册需要的东西。
 *
 * ⚠️ 用的是生产代码真实读取的路径 `connection.fetch.register`（**不是**
 * `connection.rpc.register` —— 那是不存在的 API）。用错的话端点根本没注册，
 * 而 `registerJetHubEndpoints` 只会记一条 warn 后返回，用例便**静默恒绿**。
 */
function makeCtx(): { ctx: Context; registered: string[] } {
  const registered: string[] = []
  const ctx = {
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    // `connection` 由生产代码**惰性注入**（`ctx.inject(['connection'], …)`）挂载，
    // 而非插件级静态 inject。替身必须复刻这一机制，否则会以
    // `ctx.inject is not a function` 直接抛错。
    inject: (_deps: string[], cb: (c: Context) => void) => cb(ctx as never),
    get: () => undefined,
    connection: {
      fetch: {
        register: (options: { path: string }) => { registered.push(options.path) },
      },
    },
  }
  return { ctx: ctx as never, registered }
}

describe('registerJetHubRpc：auths 是命名对象（类型层守卫）', () => {
  it('★ 完整的命名对象调用在类型层面成立（位置参数签名下这一行编译不过）', () => {
    // ⚠️⚠️ **这条是本文件唯一能区分「命名对象」与「位置参数」的断言**，
    //    别把它换成下面那种 `@ts-expect-error` 写法。
    //
    // 理由：`@ts-expect-error` 只要求「这一行**有**错误」，而位置参数签名下
    // 把一个对象字面量传给 `codearts: CodeArtsAuth` 形参**同样**是错误
    // ⇒ 那个指令在新旧两种签名下**都被消耗**，恒绿、零证明力。
    //
    // 反之，本行是**正向**调用：
    // - 命名对象签名 ⇒ 全部键齐全、类型正确 ⇒ 编译通过；
    // - 位置参数签名 ⇒ `{ … }` 不能赋给 `CodeArtsAuth` ⇒ **编译失败**。
    // ⇒ 判据是 `pnpm typecheck:tests` 的 exit code，不是 vitest。
    //    已做反向验证：把签名改回 13 个位置参数 ⇒ 该命令变红（见 Task 9 报告）。
    const stub = {} as never
    const { ctx, registered } = makeCtx()
    registerJetHubRpc(ctx, {} as never, {
      codearts: stub,
      buddy: stub,
      workbuddy: stub,
      lobsterai: stub,
      qoder: stub,
      // ⚠️ 键是 **provider id**（`qodercn`），值是实例 —— 两者不同名是刻意的。
      qodercn: stub,
      trae: stub,
      cline: stub,
      loomy: stub,
      raccoon: stub,
      minimax: stub,
      // ⚠️ MiniMax Code 国际版：与 `minimax` 共用同一个 auth 类，是两个 provider
      //（账号不互通、API 主机不同）⇒ `JetHubAuths` 必须各占一个键。
      minimaxintl: stub,
      zcode: stub,
      gemini: stub,
      officeace: {} as never,
      accio: stub,
      // astudio = goal 302 第 3 处接线（JetHubAuths.readonly astudio: AstudioAuth，
      // 由 #578 乙组落盘）。本用例是「完整命名对象调用能编译」的正向类型守卫，
      // 漏掉这个键会让 typecheck:tests 报 TS2345 —— 也正是该用例想要守的不变式。
      astudio: stub,
      autoclaw: stub,
      // ⚠️ AutoClaw 国际版（PR121）：与 `autoclaw` 是两个实例、两个 provider id，
      //    `JetHubAuths` 必须各占一个键 —— 漏掉会让本行报 TS2345（正是本用例要守的）。
      autoclawintl: stub,
      // ⚠️ **本 fork 独有**（魔搭，2026-10-16）：键同样是 provider id。
      modelscope: stub,
      // ⚠️ **本 fork 独有**（七牛云，2026-10-29）：键同样是 provider id。
      //    漏掉会让本行报 TS2345 —— 正是本用例想守的不变式。
      qiniu: stub,
      magicrew: stub,
      // ⚠️ **MagiCrew 国际版**（2026-11-01）：与 `magicrew` 是两个实例、两个
      //    provider id ⇒ `JetHubAuths` 各占一个键 —— 漏掉会让本行报 TS2345。
      magicrewintl: stub,
      // ⚠️ 2026-11-02 加 monkeycode（MonkeyCode）：与上面两条同因 ——
      //    `JetHubAuths` 新增键后所有替身都要补齐，否则本行报 TS2345。
      monkeycode: stub,
      // ⚠️ 2026-11-02 拆站：国际站与百智云各自是独立 provider，都要有自己的 auth 键
      //    （`JetHubAuths` 是全量 Record，漏一个就编译失败 —— 这正是它该起的作用）。
      monkeycodeintl: stub,
      baizhi: stub,
    })
    // 运行时只要求端点真的注册了（证明桩搭对了，上面那行的类型检查才有意义）。
    expect(registered.length).toBeGreaterThan(0)
  })

  it('缺少某个 provider 键在类型层面被拒绝（全部键必须都在）', () => {
    // @ts-expect-error —— 只给 codearts，缺其余全部键，必须报错。
    //
    // ⚠️ 本指令**不能**区分新旧签名（见上一条的注释），它守的是另一条不变式：
    //    `JetHubAuths` 的**全部键一个都不能少** —— 那正是本 Task 的价值
    //    （漏接一个 provider 就编译不过，而不是运行时报 `Unknown provider`）。
    //    故**不要**把 `JetHubAuths` 的字段都放宽成 `JetHubAuthLike`，
    //    那会让「漏一个键」重新变成静默失效。
    registerJetHubRpc(makeCtx().ctx, {} as never, { codearts: {} as never })
  })
})

/**
 * `authOf`：按 **provider id** 取 auth 实例。
 *
 * ⚠️ 它是 Task 2 把 `account.refresh` 的 13 例 `switch (entry.provider)` 换成
 * 查表分派时要用的那个入口，故其**键约定**必须现在就被锁死。
 */
describe('authOf：按 provider id 查表', () => {
  it('★ 用 provider id `qodercn` 查得到中国版实例（键是 id，不是变量名 `qoderCn`）', () => {
    // ⚠️⚠️ **本仓库踩过的同型缺陷**：`JetHubAuths` 的键若写成**变量名**
    //    （`qoderCn`），`authOf(auths, 'qodercn')` 就查不到中国版，而症状是
    //    「中国版账号续期报 `Unknown provider: qodercn`」—— 与历史上的
    //    `workbuddy` 漏接是同一形态（该 provider 的 `account.refresh`
    //    长期报 `Unknown provider`）。
    const cn = {} as never
    const intl = {} as never
    const auths = { qoder: intl, qodercn: cn } as unknown as JetHubAuths

    expect(authOf(auths, 'qodercn'), '键必须是 provider id `qodercn`').toBe(cn)
    expect(authOf(auths, 'qoder')).toBe(intl)
  })

  it('反向：键写成变量名 `qoderCn` 时查不到（这正是我们要避免的形态）', () => {
    // 把「键用变量名」这个错误形态**显式**跑一遍，证明上一条的断言有区分力
    //（否则上一条可能只是「随便怎么键都能查到」）。
    const wrong = { qoderCn: {} } as unknown as JetHubAuths
    expect(authOf(wrong, 'qodercn')).toBeUndefined()
  })

  it('未登记的 provider 返回 undefined（调用方据此报 Unknown provider）', () => {
    const auths = { qoder: {} } as unknown as JetHubAuths
    expect(authOf(auths, 'never-heard-of-it')).toBeUndefined()
  })

  it('不命中原型链上的键（用 Object.hasOwn 而非 in）', () => {
    // ⚠️ `in` 会命中原型链：`'constructor' in {}` 为 true ⇒ 会把
    //    `entry.provider` 为怪值（如 `'constructor'`）的账号误判成
    //    「有该 provider」，进而 `authOf(...).refreshAccountCredential` 抛
    //    TypeError 或打到 Object 构造器上。故必须用 `Object.hasOwn`。
    const auths = { qoder: {} } as unknown as JetHubAuths
    expect(authOf(auths, 'constructor')).toBeUndefined()
    expect(authOf(auths, 'toString')).toBeUndefined()
    expect(authOf(auths, 'hasOwnProperty')).toBeUndefined()
  })
})
