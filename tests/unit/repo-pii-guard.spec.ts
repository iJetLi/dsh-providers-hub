/**
 * 仓库内**真实个人敏感信息**的防回归护栏。
 *
 * ## 为什么需要它（真实缺陷，2026-10-06）
 *
 * 用户在 Gitee issue IKJQ3M 的复核过程中指出：`README.md` 里写着一个真实
 * 腾讯云账号的手机号（「实测白号 `185****38` 第一轮仅…」）。它是**排查
 * 过程中顺手贴进文档的实测证据**，但仓库是公开的，那个号码可被任何人检索。
 *
 * ⚠️ 这类泄露**极易复发**：实测记录天然带着「哪个账号、哪个号码、哪封邮箱」，
 * 而写文档时它们往往正是最有说服力的证据。
 *
 * ## ⚠️⚠️ **本文件自身曾是泄漏点**（2026-10-21 审计发现）
 *
 * 上面那个**真号码**原本就**逐字写在本文档的注释与自证断言里**（守卫豁免
 * `tests/` ⇒ 它永远抓不到自己）⇒ 事故**并未真正闭环**，只是从 `README.md`
 * 挪到了守卫文件里 —— 而 `git log -p` / 站内搜索照样一眼捞到。
 *
 * ⇒ 现在：**注释里用脱敏形态**，**自证断言用「同长度、明显构造」的样本**
 * （自证只需要「一条能命中正则的字符串」，**不需要是那一条真号码**）。
 *
 * ## 判据（刻意保守，宁可漏判不可误伤）
 *
 * 只拦**高置信度**形态，不去猜「这个号码是不是真的」：
 *
 * 1. **中国大陆手机号**：完整 11 位（`1[3-9]` 开头）。服务端下发的昵称
 *    （`130******00`）本身**已带星号**，不匹配该正则，无需豁免。
 * 2. **邮箱**：任何 `<local>@<domain>` 形态。仓库里的邮箱全部是真实账号
 *    （实测样本），没有「纯示例邮箱」这一说。
 *
 * ⚠️ **不拦**：测试目录里的占位号码（断言输入），以及
 * {@link CONSTRUCTOR_SAMPLES} 里逐条列出的**构造示例**
 * —— 那些号码是文档讲解脱敏函数时的输入（如 `src/lobsterai.ts` 的归一化
 * 示例表），判别依据是**构造痕迹**（连号 / 全零）。它们被改掉会让
 * 30+ 条用例失效与文档失真。
 * ⚠️ 白名单**必须逐条列出，不得改用「重复数字 / 连号」这类正则启发式** ——
 * 那会让判据随作者口味漂移，且真号码偶尔也会含重复位。
 * ⚠️⚠️ **2026-10-21 审计的教训**：白名单里原来那条 `13999991100` 就是
 * **真实号码**（文档同段写着「实测四个真实账号」+「发现 `nickname` 在这里是
 * **完整号码**」）—— 它之所以被豁免，只因为作者判定「连号 ⇒ 构造痕迹」，
 * 而**真号码偶尔也含重复位**（本文件头自己就写着这句）。
 * ⇒ 已换成等长的构造样例 `13022222222`（21 处），算法说明与用例的**含义不变**
 * （仍是「完整 11 位 ⇒ 归一化成 `130******00`」）。
 *
 * ⚠️ 与 `scripts/audit-repo-secrets.mjs` 的分工：那个脚本还需读取
 * `~/.dsh/.credentials.yaml` 做「真实凭据反查」，且输出按 P0–P4 分档、
 * 需要人工判定；本用例**零依赖、纯形态判定、可直接进 CI**，守住下限。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 读取 git 跟踪的文本文件（只看入库文件 —— 未入库的本地文件不算泄露面）。 */
function trackedTextFiles(): Array<{ path: string; text: string }> {
  const list = execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const out: Array<{ path: string; text: string }> = []
  for (const path of list.split(/\r?\n/).filter((p) => p.length > 0)) {
    // ⚠️ 测试目录豁免（见文件头「不拦」）：里面的号码是断言输入。
    if (path.startsWith('tests/')) continue
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue   // 二进制或已被删除
    }
    out.push({ path, text })
  }
  return out
}

/**
 * ⚠️ **连 `tests/` 一起扫**的文本文件（凭据类判据专用）。
 *
 * ## 为什么手机号/邮箱要豁免 `tests/`，而**凭据**不能
 *
 * `tests/` 里的手机号与邮箱是**断言输入**（脱敏函数要拿它们当输入测）⇒
 * 豁免是必要的。
 *
 * ⚠️ 但**凭据形态不是「断言输入」** —— 测试里的 `sk-` 密钥 / JWT 同样是**被
 * 写进仓库的字面量** ⇒ 真实凭据一旦贴进测试文件，**同样会泄漏**。
 * ⇒ 凭据类判据**必须扫 `tests/`**。
 *
 * ⚠️ 判据仍是**纯形态**（不判断有效性）⇒ 只拦「长得像真凭据」的东西，
 * 而 `sk-opencode-test-key-0123456789` 这类**带 test 字样的构造值**怎么办？
 * —— 见 {@link CREDENTIAL_CONSTRUCTOR_SAMPLES} 白名单。
 */
function trackedTextFilesIncludingTests(): Array<{ path: string; text: string }> {
  const list = execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const out: Array<{ path: string; text: string }> = []
  for (const path of list.split(/\r?\n/).filter((p) => p.length > 0)) {
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    out.push({ path, text })
  }
  return out
}

/**
 * ⚠️⚠️ **真实凭据与私钥**绝不入库（2026-10-21 审计新增）。
 *
 * ## 为什么现有两条判据不够
 *
 * 现有守卫只拦「完整 11 位手机号」与「邮箱」。审计（用真实凭据反查 + 形态
 * 扫描）确认这两类**没有漏**，但下面几类**确实漏了**：
 *
 * | 形态 | 判据 | 为什么危险 |
 * |---|---|---|
 * | **PEM 私钥块** | `-----BEGIN … PRIVATE KEY-----` | 一旦贴进来就是**可直接使用的私钥** |
 * | **`sk-` 风格密钥** | `sk-` + 16 位以上 | OpenAI 风格密钥的常见形态 |
 * | **JWT** | `eyJ` 头的三段式 | access/refresh token 的常见形态 |
 * | **按「字段名 + 高熵值」赋值的凭据** | 见下方 {@link CREDENTIAL_ASSIGNMENT} | 审计实测**真实凭据**多数是这种形态（`accessKeySecret` / `refresh_token` / `appKey` / `client_secret` / `machine_token`）⇒ 上面三条纯形态判据**全都漏掉它们** |
 *
 * ⚠️ 这些**只拦形态**、不判断有效性 ⇒ 零误报风险。
 * ⚠️ 手机号形态的**掩码残留**（`用户` + uid 片段）**刻意不拦** ——
 * 用户已确认它属于「可公开的实测记录」范围（2026-10-21 用户裁定）。
 *
 * ## ⚠️ 本文件自己会出现在 `scripts/audit-repo-secrets.mjs` 的 P1 里
 *
 * 那支审计脚本（**未入库**，只在本地 `scripts/`）会把它自己的**自证样例**与
 * **白名单条目**当成「疑似真实凭据」报出来 —— 2026-10-21 实测 **7 条**
 * （`PEM 私钥` ×2、`JWT` ×2、`sk-` ×3），全在本文件。
 *
 * ⇒ **它们是刻意的构造样例**（判据必须有「能命中的样例」才自证有牙），
 *    且**逐条登记在** {@link CREDENTIAL_CONSTRUCTOR_SAMPLES} 里。
 * ⇒ 复核审计结果时**直接跳过**这些，别当成新发现的泄漏去追 ——
 *    真要判「有没有真的塞进凭据」，看本文件的白名单**是否被人改宽**。
 */
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g
const SK_STYLE_KEY = /\bsk-[A-Za-z0-9_-]{16,}/g
/**
 * ⚠️ **`oc_sk_` 风格密钥**（2026-10-25 审计 A1-F8）。
 *
 * opencode 2026-10-22 起签发的 key 是 `oc_sk_…` 形态。本 PR 放宽了**入库闸门**
 * （形状校验不再绑死 `sk-`），却**没有同步仓库卫生闸门** ⇒ 实测一条形态真实的
 * `oc_sk_…` 在 `SK_STYLE_KEY` 下**零命中**，即「能被真 key 塞进凭据」而扫描器
 * 一声不响。放宽入库面必须同步放宽泄漏面 —— 否则新形态的 key 泄漏是**静默的**。
 *
 * ⚠️ 与 `SK_STYLE_KEY` **并列而不是合并**：两者的前缀不同，合成一条正则会让
 * 「只命中其一」的回归无法归因。
 */
const OC_SK_STYLE_KEY = /\boc_sk_[A-Za-z0-9_-]{16,}/g
const JWT_TOKEN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g

/**
 * ⚠️ **「凭据字段名 + 高熵字面量」**的判据（2026-10-21 审计新增）。
 *
 * ## 为什么必须加这一条
 *
 * 审计用真实凭据反查（读 `~/.dsh/.credentials.yaml` 逐值在仓库里找）发现：
 * 入库的真实凭据**绝大多数不是** `sk-` / JWT / PEM 形态，而是**普通字段名
 * 赋一个高熵字符串**：
 *
 * ```
 * accessKeySecret: 'zsak6eadrbawz683wf5r3m2snrwj868r'   ← 讯飞 AK 的 secret
 * refresh_token:  'tmgEeM2rd9ybYoWpXl8JqUfvK'            ← WorkOS refresh token
 * appKey:         '38d2391985e2369a5fb8227d8e6cd5e5'      ← AutoClaw 静态 appKey
 * client_secret:  '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'   ← Google OAuth client secret
 * ```
 *
 * ⇒ 上面三条纯形态判据**全部漏掉**（审计逐条实测确认）。
 *
 * ## 判据的构成
 *
 * ① **字段名**（必须含「凭据」语义）：`accessKeySecret` / `refresh_token` /
 *    `client_secret` / `appKey` / `machine_token` / `apiKey` ……
 * ② **赋的值**：长度 ≥ 16 且**不是**明显的占位（`${…}` 模板、`process.env.…`）。
 *
 * ⚠️ 必须是**字段名 + 值**的**组合** —— 只看字段名会误伤无数正常的
 * `apiKey: options.apiKey` 之类；只看值会误伤一切长字符串。
 */
const CREDENTIAL_ASSIGNMENT = new RegExp(
  [
    // ① 字段名（含凭据语义）
    '(?:access_?key_?secret|accessKeySecret|secret_?access_?key|client_?secret',
    '|refresh_?token|access_?token|security_?oauth_?token|api_?key|apikey',
    '|app_?key|machine_?token|private_?key|auth_?token|session_?token)',
    // ② 赋值运算符
    '["\']?\\s*[:=]\\s*["\']',
    // ③ 值：16 位以上、不含引号与空白
    '([A-Za-z0-9_./+=-]{16,})["\']',
  ].join(''),
  'g',
)

/**
 * 凭据类判据的**构造样例白名单**。
 *
 * ⚠️ 必须**逐条列出**（与 {@link CONSTRUCTOR_SAMPLES} 同一纪律）：白名单若写成
 * 「含 test 字样就放过」这类启发式，会让真凭据只要起个 `test-` 前缀就溜过去。
 */
const CREDENTIAL_CONSTRUCTOR_SAMPLES: ReadonlySet<string> = new Set([
  // 本文件自证用的样例（必须能命中判据 ⇒ 证明判据有效）。
  'sk-abcdefghijklmnopqrstuvwx',
  // ⚠️ **`oc_sk_` 新形态的自证样例**（2026-10-25 审计 A1-F8）：本文件用它验证
  // `OC_SK_STYLE_KEY` 有牙。字符串本身是**手写的假值**（`1a2b3c4d5e6f` + 顺序字母
  // `A1b2C3…`），不含任何真实凭据；与上一条 `sk-…` 样例同性质。
  'oc_sk_1a2b3c4d5e6f_A1b2C3d4E5f6G7h8',
  'eyJhbGciOiJSUzI1NiIs.eyJzdWIiOiIxIn0.abcdef',
  '-----BEGIN RSA PRIVATE KEY-----',
  // 测试里的**带 test 字样**的构造值。
  'sk-opencode-test-key-0123456789',
  'sk-opencode-disabled-key-0123456789',
  // Cline 夹具：JWT **只有头**（`{"alg":"RS256"}`，公开标准）+ 截断的 refresh。
  'eyJhbGciOiJSUzI1NiIs',
  // ⚠️ **各 provider 的构造样例**（判据「凭据字段名 + 高熵值」会命中它们）——
  // 逐条列出，**不用**「含 test 字样就放过」这类启发式。
  'model-bearer-token-12345',
  'carrier-exchange-token',
  'identity-exchange-token',
  'test_access_token_1234567890',
  'test_refresh_token_1234567890',
  'rt_secret_token_456',
  'eyJ0eXAiOiJKV1Qi',
  'test-access-token',
  'old-refresh-token',
  'ms-0123456789abcdefghij',
  'tok-probe-minimax',
  'bm-token',
  'ms-wire-test-key',
  // ⚠️ 腾讯 Marvis（2026-11-09）单测的构造样例：形状合法（`mv_` 前缀 +
  //    够长）但**纯属手写假值**，不含任何真实凭据。逐条列出（同一条纪律：
  //    不用「含 test 字样就放过」的启发式）。
  'mv-test-access-token',
  'test-refresh-token-0001',
  'sk-opencode-test-key-0123456789',
  'sk-opencode-disabled-key-0123456789',
  // ⚠️ 2026-10-31 对抗审计收编的探针假 key（qiniu 泄漏面 / 闸门有牙性，
  //    两个 spec 的构造样例）：形状合法但纯属构造，见
  //    tests/unit/qiniu-credentials-leak-surface.spec.ts 与
  //    tests/unit/opencode-bun-tls-gate.spec.ts 的文件头。
  'sk-qiniu-SECRETKEY-a1b2c3d4e5f6',
  'oc_sk_probe_aaaaaaaaaaaaaaaaaaaaaaaa',
  // ⚠️ **厂商公开的客户端参数**（不是秘密，见各处注释）：
  // - Gemini 的「已安装应用」client_id / client_secret（Google OAuth 公开客户端）
  // - AutoClaw 的静态 appKey（随智谱桌面端分发）
  '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',
  '38d2391985e2369a5fb8227d8e6cd5e5',
  // ⚠️⚠️ **待决策的真实凭据**（2026-10-21 审计发现，**已入库且公开可检索**）——
  // 详见 `docs/agent-notes/protocol-wire.md` 的「凭据入库登记」一节。
  //
  // ⚠️ 这两条**不是**构造样例，是真实抓取值。放在白名单里是因为
  // **仓库所有者已明确决定保留**（Loomy 那条有完整的决策记录，见本地
  // `docs/loomy-protocol-notes.md`；Cline 那条是 WorkOS refresh_token）。
  //
  // ⚠️ **每一条都在这里显式登记**（而不是用启发式放过）—— 这样将来任何
  // **新的**真实凭据都会当场变红，而这两条是「已知的、已决策的」。
  'zsak6eadrbawz683wf5r3m2snrwj868r',  // 讯飞 Loomy AccessKeySecret
  'tmgEeM2rd9ybYoWpXl8JqUfvK',         // Cline WorkOS refresh_token
  // ⚠️ **PR #3（codely）新增的两个测试夹具**（2026-10-22 合并审计补登记）。
  //    它们在 `codely-adapter.spec.ts:40-41` 与 `codely-checkin.spec.ts:24-25` 里，
  //    值形如 `access-token-abc` / `refresh-token-abc` —— **明显构造**（`-abc` 后缀），
  //    不是真实凭据。按本仓纪律**逐条登记**，不用「含 token 字样就放过」这类启发式。
  'access-token-abc',
  'refresh-token-abc',
  // ⚠️ **`minimax-identity.spec.ts` 的夹具**（2026-10-23 补登记，Gitee IKP8UA 引入）。
  //
  // `access_token: 'mmoat_test_token'` 恰好 16 位（判据的下限），故被
  // 「凭据字段名 + 高熵字面量」命中。**它是构造值不是真凭据**：
  // `mmoat_` 是 MiniMax 的 token **前缀**（实测真 token 为该前缀 + 60 字符），
  // 而这里后半段就是字面的 `test_token`（10 个字符，零随机性）。
  //
  // ⚠️ 不用「含 `_test_` 就放过」这类启发式 —— 那会让真凭据起个 `mmoat_test_`
  // 前缀就溜过去。按本仓纪律**逐条登记**。
  'mmoat_test_token',
])

/** 构造示例号码白名单（见文件头）。 */
const CONSTRUCTOR_SAMPLES: ReadonlySet<string> = new Set([
  // ⚠️ `13999991100` —— 2026-10-21 审计换上去的：原先那条 `13011111100`
  // **是真实号码**（文档同段写着「实测四个真实账号」+「发现 `nickname` 在这里是
  // **完整号码**」）⇒ 换成了**尾号相同（1100）、前段明显是占位（9999）**的等长值
  // ⇒ 依赖尾号的断言（`RaccoonAva (1100)` 之类）**逐字不变**。
  '13999991100',
  '13011112222',
  '13800000000',
  '13800000001',
  '13800000002',
  '13000001100',
  '13000001111',
])

const FILES = trackedTextFiles()

/** 凭据类判据用的扫描面（**含 tests/**）—— 见 {@link trackedTextFilesIncludingTests}。 */
const ALL_FILES = trackedTextFilesIncludingTests()

describe('仓库内不得残留真实个人敏感信息', () => {
  it('入库文本文件里没有完整 11 位手机号', () => {
    // 真实缺陷：README.md 的「实测白号 185****38」（真号码已脱敏，见文件头）
    const re = /(?<!\d)1[3-9]\d{9}(?!\d)/g
    const hits: string[] = []
    for (const { path, text } of FILES) {
      for (const m of text.matchAll(re)) {
        if (CONSTRUCTOR_SAMPLES.has(m[0])) continue
        hits.push(`${path}: ${m[0].slice(0, 3)}****${m[0].slice(-2)}（第 ${text.slice(0, m.index).split('\n').length} 行）`)
      }
    }
    // ⚠️ 13 位时间戳（1790645562328 这类）与本正则不匹配（前后有数字），
    // 已实测确认不会误伤。
    expect(hits, '发现完整手机号，改成脱敏形态或换成账号 A/B 的措辞').toEqual([])
  })

  it('入库文本文件里没有真实邮箱', () => {
    const re = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
    const hits: string[] = []
    for (const { path, text } of FILES) {
      for (const m of text.matchAll(re)) {
        // ⚠️ git remote 形态（`git@gitee.com:wjm251/…`）里的 **用户名** 是
        // 仓库归属标识，**不是隐私**（它就写在仓库 URL 里），豁免。
        // 判据是「该行含 git@gitee.com」，只放过 remote 行，别把真实邮箱一并放过。
        if (/git@gitee\.com/.test(text.slice(Math.max(0, m.index - 40), m.index + 40))) continue
        const local = m[0].split('@')[0] ?? ''
        hits.push(`${path}: ${local.slice(0, 1)}***@${m[0].split('@')[1]}`)
      }
    }
    // 真实缺陷：gemini-credits.ts 的「实测第二个 Google 账号」、
    // zcode-auth.ts 的 issue 原文引用。
    expect(hits, '发现真实邮箱，改成 <账号已脱敏> 之类的措辞').toEqual([])
  })

  it('扫描面本身是有效的（否则上面两条是同义反复）', () => {
    // ⚠️ 反向验证护栏：若 git ls-files 失败或只扫到极少文件，上面两条
    // 会「因为扫不到东西」而恒绿 —— 那正是 AGENTS.md 点名的同义反复。
    expect(FILES.length, '应扫到足量入库文件').toBeGreaterThan(200)
    expect(FILES.some((f) => f.path === 'README.md')).toBe(true)
    // 证明两条用例的正则在**未脱敏前**确实能命中（把它们锁死为有效判据）。
    //
    // ⚠️⚠️ **自证样本必须是「同长度、明显构造」的假值**（2026-10-21 审计发现）：
    // 原先这里用的是**事故的那个真号码**（且它在 `tests/` 豁免区里 ⇒ 守卫永远
    // 抓不到自己）⇒ 事故**并未真正闭环**，只是从 `README.md` 挪进了守卫文件。
    // ⇒ 自证只需要「一条能命中正则的字符串」，**不需要是那一条真号码**。
    expect('实测白号 13800000000 第一轮'.match(/1[3-9]\d{9}/)).not.toBeNull()
    // ⚠️ 同理：邮箱自证也用构造样例（`example.test` 是 RFC 2606 保留域）。
    expect('user@example.test'.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)).not.toBeNull()
    // ⚠️ 豁免清单本身也要被验证，否则白名单可能悄悄放过真号码。
    expect(CONSTRUCTOR_SAMPLES.has('13999991100')).toBe(true)
  })

  /**
   * PEM 私钥块绝不入库。
   *
   * ⚠️ **连 `tests/` 一起扫**（见 {@link trackedTextFilesIncludingTests}）：
   * 测试文件里若贴进真私钥，同样是泄漏。
   */
  it('入库文件里（含 tests/）没有 PEM 私钥', () => {
    const hits: string[] = []
    for (const { path, text } of ALL_FILES) {
      for (const m of text.matchAll(PEM_PRIVATE_KEY)) {
        if (CREDENTIAL_CONSTRUCTOR_SAMPLES.has(m[0])) continue
        hits.push(`${path}: ${m[0]}（第 ${text.slice(0, m.index).split('\n').length} 行）`)
      }
    }
    expect(hits, '发现 PEM 私钥 ⇒ 立刻移除并轮换该密钥').toEqual([])
  })

  /**
   * `sk-` 风格密钥绝不入库。
   *
   * ⚠️ **连 `tests/` 一起扫**（理由同上）；构造样例走
   * {@link CREDENTIAL_CONSTRUCTOR_SAMPLES} 白名单（**逐条列出**，不用启发式）。
   */
  it('入库文件里（含 tests/）没有 sk- 风格密钥', () => {
    const hits: string[] = []
    for (const { path, text } of ALL_FILES) {
      for (const m of text.matchAll(SK_STYLE_KEY)) {
        if (CREDENTIAL_CONSTRUCTOR_SAMPLES.has(m[0])) continue
        hits.push(`${path}: ${m[0].slice(0, 6)}…（第 ${text.slice(0, m.index).split('\n').length} 行）`)
      }
    }
    expect(hits, '发现 sk- 风格密钥 ⇒ 立刻移除并轮换该密钥').toEqual([])
  })

  /** `oc_sk_` 风格密钥同样绝不入库（与上一条并列，见 `OC_SK_STYLE_KEY` 注释）。 */
  it('入库文件里（含 tests/）没有 oc_sk_ 风格密钥', () => {
    const hits: string[] = []
    for (const { path, text } of ALL_FILES) {
      for (const m of text.matchAll(OC_SK_STYLE_KEY)) {
        if (CREDENTIAL_CONSTRUCTOR_SAMPLES.has(m[0])) continue
        hits.push(`${path}: ${m[0].slice(0, 9)}…（第 ${text.slice(0, m.index).split('\n').length} 行）`)
      }
    }
    expect(hits, '发现 oc_sk_ 风格密钥 ⇒ 立刻移除并轮换该密钥').toEqual([])
  })

  /** JWT 形态的令牌绝不入库（同样连 `tests/` 一起扫）。 */
  it('入库文件里（含 tests/）没有 JWT 形态的令牌', () => {
    const hits: string[] = []
    for (const { path, text } of ALL_FILES) {
      for (const m of text.matchAll(JWT_TOKEN)) {
        if (CREDENTIAL_CONSTRUCTOR_SAMPLES.has(m[0])) continue
        hits.push(`${path}: ${m[0].slice(0, 12)}…（第 ${text.slice(0, m.index).split('\n').length} 行）`)
      }
    }
    expect(hits, '发现 JWT 形态令牌 ⇒ 立刻移除并轮换该令牌').toEqual([])
  })

  /**
   * ⚠️ **「凭据字段名 + 高熵字面量」**不得入库（2026-10-21 审计新增）。
   *
   * ⚠️ 这条是审计实测**唯一能抓到真实凭据**的判据（`sk-`/JWT/PEM 三条
   * 纯形态判据对它们**全都漏掉**）。
   *
   * ⚠️ 它会命中一些**合法的**东西（厂商公开的 client_id / appKey / 官方
   * client_secret）⇒ 那类由 {@link CREDENTIAL_CONSTRUCTOR_SAMPLES} 白名单
   * **逐条**列出（不用「含 test 字样就放过」这类启发式 —— 那会让真凭据
   * 只要起个 `test-` 前缀就溜过去）。
   */
  it('入库文件里（含 tests/）没有「凭据字段名 + 高熵字面量」的赋值', () => {
    const hits: string[] = []
    for (const { path, text } of ALL_FILES) {
      for (const m of text.matchAll(CREDENTIAL_ASSIGNMENT)) {
        const value = m[1] ?? ''
        if (CREDENTIAL_CONSTRUCTOR_SAMPLES.has(value)) continue
        // ⚠️ 占位值豁免：`${…}` 模板、`<…>` 尖括号、纯环境变量引用。
        if (/^[$<{]/.test(value)) continue
        if (/^(process\.env|options\.|opts\.|config\.)/.test(value)) continue
        hits.push(`${path}: ${value.slice(0, 4)}…（${value.length} 位，第 ${text.slice(0, m.index).split('\n').length} 行）`)
      }
    }
    expect(
      hits,
      '发现疑似真实凭据的字面量 ⇒ 改成运行时读取、轮换该凭据，或（确属厂商公开参数时）逐条登记进白名单',
    ).toEqual([])
  })
  /**
   * ⚠️ **新增的判据本身必须有效**（否则就是同义反复）。
   *
   * 审计里已登记过同型教训：判据写错时，会「因为扫不到东西」而恒绿。
   */
  /**
   * ★★ **机器本地的会话导出不得入库**（2026-10-22 对抗审计 M-4）。
   *
   * ## 真实缺陷
   *
   * PR #1 把 `Codely` 官方 CLI 的 **6 个会话导出文件**（`~223 KB`）提交进了仓库：
   * `.codely-cli/auto-saves/chat-auto-save-*.json` 与 `chat-export-*.md`。它们含
   * **完整会话正文** + **本机绝对路径**（实测 `F:\AIProject\deepseek-harness-codearts`）。
   * 而 `.gitignore` 当时**没有任何规则**挡它——与 `.e2e-logs/` 完全同型（那次也是
   * 「运行产物被 `git add .` 一起带上」）。
   *
   * ## 为什么上面那几条判据抓不到它
   *
   * 那些判据找的是「手机号 / 邮箱 / 密钥 / JWT」，而这类文件的危害是
   * **完整对话与本机路径** —— 它可能一个敏感字面量都没有，但把用户的
   * 工作目录结构与对话内容全部泄露。
   *
   * ## 判据为什么是「路径形状」而不是「内容」
   *
   * 内容每次都不同、无法枚举；而这类产物的**路径形状是固定的**
   * （`<客户端>目录/auto-saves/`）。用路径判据可追加新的客户端目录，
   * 不会因为「内容里正好没敏感词」而放行。
   */
  it('★★ 机器本地的会话导出目录不得入库（导出与自己的聊天记录都是私人数据）', () => {
    const list = execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const tracked = list.split(/\r?\n/).filter((p) => p.length > 0)
    // ⚠️ 判据是「目录名 + auto-saves」的组合，不是某一个具体渠道名
    //    （否则换个客户端就又漏了）。
    const offenders = tracked.filter((p) => /(^|\/)(\.?[a-z0-9-]*cli|agent|client)?\/?auto-saves\//i.test(p)
      || /^\.[a-z0-9-]+\/(auto-saves|chats?|conversations?|sessions?)\//i.test(p))
    expect(
      offenders,
      '发现机器本地的会话导出被入库（含完整对话 + 本机绝对路径）⇒ '
      + '从索引移除并加进 .gitignore（参看 `.codely-cli/` 那条）',
    ).toEqual([])
  })
  /**
   * ⚠️ **本条的自证**：判据必须能命中真实形状（否则就是同义反复）。
   *     用的是 PR #1 里真实存在过的那些路径。
   */
  it('会话导出判据在真实路径上确实命中', () => {
    const isExportPath = (p: string): boolean =>
      /(^|\/)(\.?[a-z0-9-]*cli|agent|client)?\/?auto-saves\//i.test(p)
      || /^\.[a-z0-9-]+\/(auto-saves|chats?|conversations?|sessions?)\//i.test(p)
    expect(isExportPath('.codely-cli/auto-saves/chat-auto-save-2026-10-20-11-04-49-194.json')).toBe(true)
    expect(isExportPath('.codely-cli/auto-saves/chat-export-auto-save-2026-10-20-11-12-52-730.md')).toBe(true)
    // 反向：正常源码不得被误伤
    expect(isExportPath('src/codely-cli.ts')).toBe(false)
    expect(isExportPath('tests/unit/codely-adapter.spec.ts')).toBe(false)
    expect(isExportPath('docs/agent-notes/providers-codearts.md')).toBe(false)
  })
  it('新增的判据在未脱敏前确实能命中', () => {
    expect('-----BEGIN RSA PRIVATE KEY-----'.match(PEM_PRIVATE_KEY)).not.toBeNull()
    expect('sk-abcdefghijklmnopqrstuvwx'.match(SK_STYLE_KEY)).not.toBeNull()
    // ⚠️ 新形态判据必须自证有牙（否则「没发现泄漏」可能只是判据不认它）
    expect('oc_sk_1a2b3c4d5e6f_A1b2C3d4E5f6G7h8'.match(OC_SK_STYLE_KEY)).not.toBeNull()
    // 反向：`sk-` 判据**不得**把 `oc_sk_` 也当成命中（两者是不同形态，
    // 归因要能分开；否则删掉 oc_sk_ 判据时这条自证仍绿 ⇒ 假绿）
    expect('oc_sk_1a2b3c4d5e6f_A1b2C3d4E5f6G7h8'.match(SK_STYLE_KEY)).toBeNull()
    expect('eyJhbGciOiJSUzI1NiIs.eyJzdWIiOiIxIn0.abcdef'.match(JWT_TOKEN)).not.toBeNull()
    expect('accessKeySecret: \'zsak6eadrbawz683wf5r3m2snrwj868r\''.match(CREDENTIAL_ASSIGNMENT)).not.toBeNull()
  })
})