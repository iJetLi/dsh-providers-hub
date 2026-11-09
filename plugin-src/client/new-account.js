/**
 * 「+ 新建账号」这条链路的**分支判定**（纯逻辑，不碰 React）。
 *
 * ## 背景：为什么这两个判定值得单独成文件
 *
 * 「+ 新建账号」按钮在**每一个** provider 的面板里都有（同一个 `ProviderPanel`
 * 组件按 `provider` prop 复用），而**弹窗内容原本是 zCode 专用的**（登录渠道下拉）。
 * 二者原本没有按 provider 分支，于是：
 *
 * - 在 CodeArts / Qoder / Loomy 等面板点「+ 新建账号」，弹出的仍是
 *   「添加 ZCode 账号」（Gitee issue IKJLK3 A1）；
 * - 弹窗里的下拉在非 zcode 面板**不往下发**（`account.create` 的载荷里没有
 *   `zcodeProvider`），用户的选择没有任何落点，UI 却像「选了就生效」（A2）；
 * - opencode 更绕：点按钮先弹 ZCode 渠道窗，点「确定」才弹出 API key 表单
 *   （`createAccount` 内部才改道到 `setKeyModal`）—— 双重弹窗（A3）。
 *
 * ## 为什么用「只对需要的 provider 弹窗」而不是「给每个 provider 各写一套弹窗」
 *
 * 除需要预选的 provider 外，**其余 provider 的登录入口本来就没有任何需要用户
 * 选择的东西**：后端立刻返回官方授权 URL（codearts / qoder / trae …）或本地扫码页
 * （loomy），opencode 则是 API key 表单（`OpencodeKeyModal`，自带渠道选择）。
 * 为它们保留一个**内容相同、只是标题换了个名字**的空弹窗，只会多一次点击。
 *
 * ⇒ 语义定为：**需要预选的 provider 走「先选、再登录」；其余 provider 点按钮即登录。**
 * 这也顺带消灭了 A2/A3 —— 没有弹窗就没有「被丢弃的选择」和「第二层弹窗」。
 *
 * ⚠️ **「渠道」这个词在本文件里是统称**，指「登录前必须由用户预选的项」：
 * 对 zcode 是**登录渠道**（bigmodel / zai），对 accio 是**登录区域**（cn / global）。
 * 两者共用同一个弹窗与同一个 state 槽（`pendingLogin`），故判据合成一个白名单。
 *
 * ## 为什么不写在 `jet-hub.js` 里直接断言
 *
 * 与 `account-model-link.js` / `model-bulk.js` 同理：单测环境是 `node`
 * （见 `vitest.config.ts`），`react` 不在依赖内，`jet-hub.js` 根本 import 不了。
 * 抽成不依赖 React 的纯模块，判据才能被**真跑**覆盖，而不是退化成
 * 「一段 `readFileSync` 断言」—— 后者改个写法就假红，一段注释就能喂绿。
 */

/**
 * 需要**先弹窗预选**的 provider（**白名单**）。
 *
 * - `zcode`：服务端支持两个 OAuth provider（`bigmodel` 国内 / `zai` 国际），
 *   授权页与凭据落点都不同，必须由用户选。
 * - `accio`：**登录页域名按区域不同**（`cn` → `www.accio-ai.com`，
 *   `global` → `zh.accio.com`），选错区域的后果是**登录页根本打不开该账号**
 *   （国际用户拿中国版登录页登不进去）。区域由服务端按账号下发、**不能事后推断**，
 *   故必须在登录前由用户指定。
 * ⚠️ **`marvis` 刻意不在本白名单里**（2026-11-09 真机报障）：它确实也要先选
 *   QQ / 微信，但它的选择 UI 是**自己的** `MarvisLoginModal`（由 `createAccount`
 *   里那条独立 `if (provider === 'marvis')` 早退打开），而本白名单驱动的是
 *   **ZCode 那个渠道弹窗** —— 一旦把 marvis 加进来，用户点「+ 新建账号」看到的
 *   就是「添加 ZCode 账号」+ cn BigModel / z.ai 两个渠道（用户截图实证）。
 *   ⇒ 判据是「**弹窗组件是哪一个**」，不是「要不要问一句」。
 * - `autoclaw` / `autoclawintl`：两者都有「一键导入本机桌面端凭据」与
 *   「手机验证码登录」两条路，且**读的是不同的 userData 目录**
 *   （`AutoClaw-official` / `AutoClaw-oversea-official`）。
 *   ⚠️ 不预选会让国际版静默走短信分支 ⇒ 读国内目录 ⇒ 国内凭据进国际槽位
 *   （2026-10-20 重演两次的真实事故，见 `buildCreateAccountPayload` 的注释）。
 *
 * ⚠️ 写成「**白名单**」而不是「排除法」：将来若新增某个同样需要预选的 provider，
 * 只改这一处即可；反过来，**任何漏判的 provider 都会被放行到「无弹窗」这条默认
 * 路径**——那是**降级**（少一次确认）而非**破坏**（错误的参数根本不会被发出去，
 * 见 `buildCreateAccountPayload`），失败方向是安全的。
 *
 * ⚠ **两家 provider 各占一个位置参数**（2026-10-17 合并 astudio + autoclaw 时登记）：
 *   `astudioLoginMethod`（本机导入 / 打开认证页）与 `autoclawMode`（一键导入 / 手机验证）
 *   是**各自独立**的载荷字段，宿主 `account.create` 也**分别**读这两个键
 *   （`jet-hub-rpc.ts` 里 `payload.astudioLoginMethod` 与 `payload.autoclawMode`），
 *   语义不可互换 ⇒ 合并成同一个形参会静默串台（A 家选了「本机导入」发给 B 家）。
 *   故 astudio 占第 4 位、autoclaw 占第 5 位，两个都是可选的。
 */
const PROVIDERS_ASKING_OPTIONS = Object.freeze([
  'zcode', 'accio', 'astudio', 'autoclaw', 'autoclawintl',
]);

/**
 * 该 provider 的「新建账号」是否**需要先问一句**（即是否弹预选窗）。
 *
 * @param {string} provider 当前面板的 provider id
 * @returns {boolean}
 */
export function newAccountAsksChannel(provider) {
  return PROVIDERS_ASKING_OPTIONS.includes(provider);
}

/**
 * `account.create` 的**请求载荷**。
 *
 * ⚠ 专属字段**只对该 provider 下发**：其余 provider 的载荷必须与接入弹窗前
 * **逐字节相同**（后端对它们都是可选字段，带一个它不认的值没有意义，
 * 且会让「非 zcode 面板也传了渠道」这种回归重新长出来）。
 *
 * ## ⚠⚠ 本文件最重要的一条：将来新增 provider，**两个函数都要看**
 *
 * 提单人在 review 里指出（且我同意）：本函数用**排除法**
 * （先把「没有专属字段的 provider」早退掉），而 `newAccountAsksChannel` 用**白名单**
 * —— **两处判据方向是相反的**，容易只改一处。
 *
 * | 只改了这处 | 症状 |
 * |---|---|
 * | 只改 `newAccountAsksChannel` | UI 弹了预选窗，但 `account.create` 不下发选择 ⇒ **选择被静默丢弃**（issue IKJLK3 A2 原状） |
 * | 只改 `buildCreateAccountPayload` | UI 不弹窗，但请求里带着一个后端不认的值 ⇒ 后端拿它去打开错误的授权端点 |
 *
 * 两种症状都**不在同一个文件里**，单看任一处都发现不了另一处没跟上。
 * ⇒ 改任何一个，都要回到这里把另一个一起看。回归用例
 * `tests/unit/new-account-dialog.spec.ts` 的 A 组有一条不变式
 * （弹窗判据 ⟺ 载荷带**该 provider 的**专属字段），样本是「真实 PROVIDERS ∪
 * 合成探针 id」—— ⚠ 它**抓不到**叫 `tencent-hunyuan` 这类探针外的名字，
 * **别把它当保证**：「测试 + 注释」各挡一层，两层都不完备。
 *
 * ⚠ **不要**为了「同源」把它写成 `if (!newAccountAsksChannel(provider)) return { provider }`：
 *   那会让载荷与弹窗判据**耦合** —— 弹窗判据一改（比如将来某个 provider 改成
 *   「有渠道但默认已选好，无需弹窗」），载荷会跟着改变行为，
 *   失去「载荷独立、即使 UI 判据被改坏也不会乱发渠道」这层独立性。
 *   提单人对这点与我一致：**保留方向不同，各守一层**。
 *
 * @param {string} provider 当前面板的 provider id
 * @param {string} [zcodeProvider] 弹窗里选的 ZCode 登录渠道（`'bigmodel'` / `'zai'`）
 * @param {string} [accioRegion] 弹窗里选的 Accio 登录区域（`'cn'` / `'global'`）
 * @param {string} [astudioLoginMethod] 弹窗里选的 AStudio 登录方式（`'local'` / `'web'`）
 * @param {string} [autoclawMode] 弹窗里选的 AutoClaw 登录方式（`'local'` / `'sms'`）
 * @returns {{ provider: string, zcodeProvider?: string, accioRegion?: string,
 *   astudioLoginMethod?: string, autoclawMode?: string }}
 */
export function buildCreateAccountPayload(
  provider, zcodeProvider, accioRegion, astudioLoginMethod, autoclawMode,
) {
  // 排除法：先把「载荷里没有任何专属字段」的 provider 早退掉（方向与白名单相反）。
  // ⚠️⚠️ **`autoclawintl` 必须在这里**（2026-10-20 修）：原实现只列了 `autoclaw`
  //    ⇒ 国际版的载荷被早退成 `{ provider }`，丢掉 `autoclawMode`
  //    ⇒ 后端 `autoclawMode === undefined`，走**短信登录**分支而不是"一键导入"，
  //    而那条分支的服务读的是**国内目录** ⇒ 国内凭据被写进国际槽位
  //    （用户看到「国际版卡片挂着国内手机号、已过期」，重演两次）。
  if (provider !== 'zcode' && provider !== 'accio'
    && provider !== 'astudio' && provider !== 'autoclaw' && provider !== 'autoclawintl') {
    return { provider };
  }
  if (provider === 'zcode') return { provider, zcodeProvider };
  if (provider === 'accio') return { provider, accioRegion };
  // ⚠️ **这里没有 marvis 分支**（2026-11-09 真机报障）：marvis 的登录方式由它自己的
  //    `MarvisLoginModal` 选，`createAccount` 在调用本函数**之前**就早退到那条独立
  //    `if (provider === 'marvis')` 了。若在这里加回 marvis 分支，唯一的效果是
  //    让人误以为「白名单里也该有它」—— 而那正是把 ZCode 弹窗弹给 marvis 的成因。
  // ⚠ 两家各返回**自己那一个**字段：绝不合并成一个字段，否则宿主读到的是
  //    另一个 provider 的值（静默串台，且两边各自都「看起来传对了」）。
  if (provider === 'astudio') return { provider, astudioLoginMethod: astudioLoginMethod ?? 'local' };
  return { provider, autoclawMode: autoclawMode ?? 'local' };
}
