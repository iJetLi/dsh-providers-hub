/**
 * 单测隔离：**每个测试文件一个独立的 Jet Hub 状态目录**。
 *
 * ## 为什么需要它（实测到的既有竞态）
 *
 * Jet Hub 的持久化后端解析顺序（`src/jet-hub-store.ts`）：
 *
 * ```
 * ① settings 老契约命名空间
 * ② DSH_JET_HUB_STATE_DIR     ← 测试环境在这里拦
 * ③ profileContext.home
 * ④ DSH_HOME
 * ⑤ homedir()/.dsh            ← 兜底：真实用户目录！
 * ```
 *
 * 而绝大多数 spec 只 `provide('credentials')`、不 provide `settings`，
 * 于是 `createJetHubStore` 一路落到第 ② 条（测试环境设了该变量）。
 *
 * ⚠️ **但原来那个变量是在 `vitest.config.ts` 顶层 `mkdtempSync` 出来的
 * ——config 求值只发生一次，所有 worker 共享同一个目录。**
 * 后果：并行跑的多个 spec 同时读写**同一个** `state.json`，
 * 后写的覆盖先写的，于是 `AccountPool.listAccounts()` 可能拿到
 * *另一个 spec 的*账号列表。
 *
 * 观测到的形态（符合文件竞态的一切特征）：
 * - 全套跑时偶发 `cline-auth.spec.ts` 的 `addAccount` 断言失败；
 * - 该 spec **单独跑必然通过**；
 * - 连续复跑 3 次又全绿（约 1/5 的复现率）。
 *
 * ## 修法
 *
 * 在 `setupFiles` 里**按测试文件**重新生成目录 —— setup 文件对每个
 * 测试文件各执行一次，故每个文件拿到自己的目录，互不干扰。
 * 同时它仍然拦住了第 ⑤ 条兜底，**不会污染真实的 `~/.dsh`**。
 *
 * ⚠️ QODER_RUNTIME_INFO 不需要每文件独立（它只是一个「不存在的路径」），
 * 但必须与状态目录分开 —— 否则一个名为 `no-such-runtime-info` 的目录
 * 可能被 `mkdtemp` 意外创建出来。
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ★ 单测默认关闭模型目录 / 余额的磁盘缓存（见下方两段的说明）。
import { setCatalogCacheEnabledForTest } from '../src/model-catalog-cache.js'
import { setBalanceDiskCacheEnabledForTest } from '../src/balance-disk-cache.js'

/** 每个测试文件独享的状态目录。 */
const stateDir = mkdtempSync(join(tmpdir(), 'dsh-jet-hub-'))

process.env.DSH_JET_HUB_STATE_DIR = stateDir

/**
 * ⚠️⚠️ **OfficeAce 的用户级目录必须隔离**（2026-10-14，IKLPTZ 修复时实测到的
 * **真实事故路径**，不是理论风险）。
 *
 * `src/officeace-auth.ts` 的三条用户级路径都由本变量覆盖：
 * `~/.dsh-officeace`（凭据 `session.json` + 兼容文件 + 余额缓存）
 * 与 `~/.office-claw`（客户端 cookie + CA）。其中 `session.json` 是
 * **用户真实的华为云凭据**，而其 `refresh_token` **一次性** —— 读进来续一次
 * 就烧掉了，用户只能重新登录。
 *
 * ## 为什么「在 spec 里改 `USERPROFILE`」不够
 *
 * `src/index.ts` 的 `apply()` 内部有 `void refreshAllCredentials()`
 * 的 **fire-and-forget 首轮续期**。spec 的 `afterEach` 把 `USERPROFILE`
 * 恢复成真实值**之后**，那条后台链才跑到 OfficeAce 的「池为空 ⇒ 续期本机
 * 凭据」兜底分支 ⇒ 用**真实 home** 读凭据并真发 STS 请求。
 *
 * 实测证据：修复 IKLPTZ 前 `refreshAll` 恒抛 `TypeError`，这条路径**被遮蔽**；
 * 修好之后它**被打通**，vitest 输出里随即出现真实上游报文
 * `STS5.1806 has been used`（一次性 token 已被消费的专属错误码）。
 *
 * ⇒ 唯一可靠的做法是**进程级**把该目录指向临时目录（与上面
 * `DSH_JET_HUB_STATE_DIR` 同型），而不是靠用例自己改环境变量抢时序。
 * 这样 `apply()` 的后台链无论何时跑、跑多少次，都只会看临时目录。
 *
 * ⚠️ **必须覆盖全部三条腿**（2026-10-14 对抗性审计打穿后补）：凭据目录、
 * 兼容文件目录、以及 `.office-claw`。审计实测：漏掉 `.office-claw` 时
 * `readSessionCookie()` 会读到用户**真实**的 `~/.office-claw/session.cookie`
 * 并**成功 DPAPI 解密**（耗时约 1.1s，真跑 powershell）。当时它**不可达**
 * （生产调用点都传了 `ref` ⇒ 走云侧直读），但那是**脆弱的绿** ——
 * 任何新测试调 `readSessionCookie()` / `fetchModelTokenRates()` 就会踩到。
 * ⇒ 现已收进同源覆盖（`officeAceClientHome()` 复用本变量）。
 */
if (process.env.DSH_OFFICEACE_HOME === undefined) {
  process.env.DSH_OFFICEACE_HOME = mkdtempSync(join(tmpdir(), 'dsh-officeace-'))
}

/**
 * Qoder 设备身份：**测试里绝不能真的 spawn `runtime-info.exe`**
 * （单次约 3.8 秒，且结果随开发机是否装了桌面端而变）。
 * 指向不存在的路径即等价于「未安装」。
 */
if (process.env.QODER_RUNTIME_INFO === undefined) {
  process.env.QODER_RUNTIME_INFO = join(stateDir, 'no-such-runtime-info')
}

/**
 * AutoClaw（智谱）：**桌面端凭据读取的进程级隔离**（2026-10-17 审计 P0 修复）。
 *
 * ## 它防的是什么
 *
 * `probeAutoclawLocalCredential()` 会真读 `%APPDATA%\AutoClaw-official\` 并
 * **真跑 powershell 解 DPAPI**（约 1s）—— 读到的是用户**真实**的
 * access/refresh token。`resolveDeviceId()` 同款（读真实设备号，而它会进
 * 登录/签到请求体 ⇒ 断言结果随开发机状态漂移）。
 *
 * ⚠️ 与上面 OfficeAce 那次事故**同型**：`apply()` 内部有 fire-and-forget 的
 * 后台链，用例的 `afterEach` 恢复环境变量**之后**那条链才跑到本分支 ⇒
 * 「在用例里改 `APPDATA`」不可靠，**只能进程级**。
 *
 * ## ⚠️ 为什么修复前这条缺失却仍然「全绿」
 *
 * 当时唯一的用例显式传了 `customAppData: 'F:/non_existent_path_test'`
 * ⇒ 恰好绕开了 env 读取。**那是脆弱的绿**：任何新用例走「不传参读 env」
 * 就会真读用户凭据 + 真跑 powershell（本仓库吃过两次亏，故在此显式登记）。
 *
 * 守卫见 `tests/unit/autoclaw-isolation.spec.ts`。
 */
if (process.env.DSH_AUTOCLAW_APPDATA === undefined) {
  process.env.DSH_AUTOCLAW_APPDATA = mkdtempSync(join(tmpdir(), 'dsh-autoclaw-'))
}

/**
 * ⚠️⚠️ **CodeArts 的模型缓存目录必须隔离**（2026-10-27 实测污染）。
 *
 * `src/models.ts` 的 `cacheDir()` 在 `DSH_CODEARTS_CACHE_DIR` 缺失时回退到
 * `~/.cache/deveco`，而那里存着**用户真实的两份文件**：
 *
 * | 文件 | 内容 | 被测试写坏后的后果 |
 * |---|---|---|
 * | `codearts_models.json` | 远端模型目录的落盘副本 | 下次启动用测试造的空目录 ⇒ 模型列表缺失 |
 * | `codearts_benefit_models.json` | benefit 集合（决定是否带 `maas_type`） | 陈旧/错值 ⇒ 每轮请求带错头或白付一轮往返 |
 *
 * 实测：跑完 `pnpm test` 后这两个文件的 mtime 都变成当天 —— 即有 spec 走了
 * 「真读真写」路径。`tests/unit/models.spec.ts` 自己做了隔离，
 * 但 `llm-adapter.spec.ts`（及各新加的 spec）**没有** ⇒ 它们读的是开发机的
 * 真实缓存 ⇒ 换一台机器就可能假红/假绿，且会**污染用户**的下一轮真实运行。
 *
 * ⇒ 与 `DSH_JET_HUB_STATE_DIR` / `DSH_OFFICEACE_HOME` / `DSH_AUTOCLAW_APPDATA`
 *   同型，在这一层**进程级**隔离（每测试文件一个临时目录）。
 *
 * ⚠️ 用 `=== undefined` 判断而不是无条件覆盖：某些 spec（`models.spec.ts`）
 * 会在用例内部自己换目录并在 `afterEach` 复原成「环境里原本的值」，
 * 无条件覆盖会把它的复原目标打歪。
 */
if (process.env.DSH_CODEARTS_CACHE_DIR === undefined) {
  process.env.DSH_CODEARTS_CACHE_DIR = mkdtempSync(join(tmpdir(), 'dsh-codearts-cache-'))
}

/**
 * ⚠️⚠️ **模型目录的磁盘缓存（SWR）必须隔离**（2026-11-20 实测污染）。
 *
 * `src/model-catalog-cache.ts` 的缓存目录是
 * `$DSH_HOME/cache/model-catalog/<provider>.json`，而 `DSH_HOME` 缺失时回退
 * `~/.dsh` —— 即**用户的真实目录**。
 *
 * ## 实测到的形态（第一版没有隔离时的真实事故）
 *
 * `createModelCatalog` 一接上 SWR 就**真的往真实目录写盘**，于是单测里每个
 * 用例的假目录都落进 `~/.dsh/cache/model-catalog/`，**下一个用例启动时先读到
 * 上一个用例的假目录** ⇒ 用例互相串味。
 *
 * `buddy-adapter.spec.ts` 一次红 **5 条**，且症状极具误导性：
 *
 * ```
 * expected 'Hy4 preview' to be 'GLM-5.3 · x0.79'
 * ```
 *
 * —— 名字对不上，因为读到的根本不是本用例的目录。**单独跑那条是绿的，
 * 跑整个文件才红**，属于最难归因的一类。
 *
 * ⇒ 与 `DSH_JET_HUB_STATE_DIR` / `DSH_CODEARTS_CACHE_DIR` 同型，
 *   在本层**进程级**隔离成临时目录（每测试文件一个）。
 *
 * ⚠️⚠️ **必须无条件覆盖，不能像上面几个变量那样判 `=== undefined`**
 * （2026-11-20 实测踩到）：`DSH_HOME` 在**用户的 shell / DSH 进程环境里
 * 通常已经是 `C:\Users\<user>\.dsh`** ⇒ `=== undefined` 判据**恒为假**
 * ⇒ 隔离**完全不生效**，测试照样往真实目录写。
 *
 * 实测后果：我第一次修完以为已隔离，重跑测试仍然红，且
 * `~/.dsh/cache/model-catalog/buddy.json` 又被创建 —— 正是本变量的
 * 默认值把它指向了真实目录。
 *
 * ⇒ 本变量是**唯一**必须无条件覆盖的隔离项（其余几个在测试环境里本来就没设）。
 */
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-home-model-catalog-'))

/**
 * ★★★ **单测里默认关掉模型目录的磁盘缓存**（2026-11-20，实测串味）。
 *
 * ## 为什么「隔离目录」还不够
 *
 * 上面的 `DSH_HOME` 隔离只保证**不污染用户的真实目录**，但**同一测试文件内**
 * 的所有用例仍然共用那一个临时目录 ⇒ 用例之间照样串味。
 *
 * 实测形态（`buddy-adapter.spec.ts`）：单跑任意一条都绿，跑**整个 describe**
 * 就红 5 条 —— 因为第一条用例把它的假目录（1 条模型）写进了缓存，第二条用例
 * 构造时**先读到那份缓存** ⇒ 断言拿到的 `models[0].name` 是第一条的名字。
 *
 * ⇒ 单测默认关闭（`readCatalogCache` 恒 `undefined`、`writeCatalogCache` 恒
 * `false`），行为回到加缓存前。要看真实读写的用例（`model-catalog-cache.spec.ts`）
 * 自己 `beforeEach(() => setCatalogCacheEnabledForTest(true))` 打开。
 *
 * ⚠️ 这是本仓库既定取向：`models-dev-cache` 的「注入的 fetcher 不落盘」、
 *    `DSH_CODEARTS_CACHE_DIR` 的隔离，都是同一类「测试不该碰真实缓存」。
 */
setCatalogCacheEnabledForTest(false)

/**
 * ★★★ **单测里同样关掉余额磁盘缓存** —— 与上面模型目录缓存同因。
 *
 * `balance-cache.ts` 现在会在「冷启动回源之前」读磁盘缓存。若不关，
 * 同一测试文件内的用例会读到**上一个用例**留下的假余额 ⇒ 断言拿到别的用例的值。
 *
 * 要看真实读写的用例（`balance-disk-cache.spec.ts`）自己显式打开。
 */
setBalanceDiskCacheEnabledForTest(false)
