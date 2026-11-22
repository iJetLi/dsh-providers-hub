## 这个 PR 做什么

Jet Hub 设置里新增一个开关（**默认开**），控制「**+ 新建账号**」时是否**自动打开浏览器授权页**：

| 开关 | 「+ 新建账号」时 |
|---|---|
| **开**（默认） | 与改动前**逐字节相同**：宿主 / 客户端自动打开授权页 |
| **关** | **不自动开窗**；授权链接**复制到剪贴板**，并在账号面板里显示同一链接（带「复制链接」按钮），由用户手动粘贴到浏览器打开 |

同批把「设置」弹窗从 **560×上限 760** 抬到 **840×上限 940**，并给它加一个**明显的边界**（直接复用「档次窗口」`.dim-jh-windowModal` 的实边框 + 内描边）—— 内容多了之后又出现下拉条（用户报障），分区间距按要求保持原样（8/10）。

---

## 一、现状取证：谁在「自动打开浏览器」

| # | 机制 | 位置 | UI 可达 | 不改的症状 |
|---|---|---|---|---|
| ① | 客户端 `window.open`（**唯一出口**） | `jet-hub.js` `createAccount`：普通 `loginUrl` / MiniMax `forcedLoginUrl` / 先开登出页 | ✅ | 关了设置，普通窗口照开 |
| ② | 宿主 `openBrowser()` | `login.ts`（阻塞式入口 + `buddy/cline/lobsterai/qoder` 的 `defaultOpenBrowser` 都走它） | ❌（当前无 UI 调用点） | 阻塞式登录仍偷开窗 |
| ③ | 宿主 `openIncognitoWindow()` | `login.ts`，被 `account.create` 的 **CodeArts / OfficeAce** 分支调用 | ✅ | 关了设置仍弹一个**无痕窗** |
| ④ | 宿主 `openRaccoonAuthorizePage()` | `raccoon-login-page.ts` 的 `runAuthorizeRound`（本地载体页「浏览器登录」Tab） | ✅ | 关掉后，载体页里点一下仍由宿主开浏览器 |

**例外（刻意不动）**：豆包 / 百智云 / 超级麦吉 / MonkeyCode / Marvis 是插件**自己拉起并接管** Chromium 去读登录态（`chromium-session.ts`、`*-browser-login.ts`）—— 没有可交给用户自己打开的授权 URL，关掉开关即**完全无法登录**。⇒ 它们**不受**本开关影响（用户 2026-11-23 明确要求设置分区里不写这条提示，边界只记在 README / agent-notes）。

---

## 二、修法

### 唯一偏好源，两条「读腿」

```
$DSH_HOME/jet-hub/login-preferences.json
        { "schema": ".../v1", "autoOpenBrowserEnabled": true }
                 │
     ┌───────────┴────────────┐
  宿主 policy（每次现读）     客户端 store（RPC 读 + 进程内缓存）
  openBrowser / 无痕窗       createAccount 分流
  raccoon 授权页
```

- **缺键 / 文档损坏 / 读失败 ⇒ 一律「开」**（`raw !== false`）。方向不能反：反过来会让任何一次读取失败都变成「新建账号不再跳登录页」，而用户根本没有关过它。
- 客户端缓存来自宿主 RPC（不是浏览器存储：Web 端 origin 带随机端口，localStorage 会丢）。
- **不做乐观更新**：`setEnabled` 回**落盘后重读的值**（与 `gateway` / `nativeSearch` / `reasoningDefault` 同约定）。

### RPC（沿用既有范式）

| 方法 | 载荷 | 返回 | 备注 |
|---|---|---|---|
| `loginPreferences.getEnabled` | `{}` | `{ enabled: boolean }` | 缺省/损坏 ⇒ `true` |
| `loginPreferences.setEnabled` | `{ enabled: boolean }` | `{ enabled: boolean }` | 非布尔 ⇒ `bad-request`；回读落盘值；写成功即生效 |

### 客户端分流（最小侵入，**既有锚点一个字不改**）

在 `createAccount` 的 `loginUrl` 分支前置一层分母：

```js
if (!loginAutoOpenEnabled()) {
  manualUrl = res.forcedLoginUrl（非空时优先，MiniMax 语义）否则 loginUrl
  setLoginUrlForManual(manualUrl) + setLoginManualMode(true)
  setLoginLinkCopied(await copyToClipboard(manualUrl, { silent: true }))
  skipClientOpen = true           // 下面的原分支整段跳过
} else if (res.incognitoOpened === true) { … }   // 原代码原样
if (!skipClientOpen) { … window.open(forcedLoginUrl) … window.open(loginUrl) … }
```

- 原有 `if (!skipClientOpen) { … }` 整段**字面保留**：`codearts-incognito-login` / `minimax-forced-login` / `login-link-copy` 三条既有守卫都锚着那些字面量（本轮逐条核对）。
- 手动链接区块复用现有「弹窗被拦截」的 UI（链接 + 复制按钮 + 三态文案 + 失败一键全选），只把标题按 `loginManualMode` 分流：
  - 复制成功：「已关闭「自动打开浏览器」：授权链接已复制到剪贴板，请粘贴到浏览器打开并完成登录。」
  - 复制失败：「自动复制被浏览器拦截，请手动选中下方链接复制。」
  - 非手动（弹窗被拦）：原文案不变。
- CodeArts / OfficeAce 在手动模式额外提示「建议在无痕 / 隐私窗口打开」（关闭后宿主不再开无痕窗，普通窗口可能复用上一个账号的登录态）。
- `copyToClipboard` 新增可选 `{ silent: true }`：自动复制失败时**不弹**通用复制面板（面板里的链接区块本身就是兜底）。
- 轮询与「手动粘贴回调链接」逻辑完全不变。

### 宿主闸门（一个原语一处判据）

| 位置 | 关闭态 |
|---|---|
| `login.ts` `openBrowser()` | 不 spawn；`console.info` 打出 URL（阻塞式路径至少留下可复制地址） |
| `login.ts` `openIncognitoWindow()` | `return false`（测试断路器仍在前；调用方本来就要处理 false） |
| `accio-oauth.ts` 自带的 `openBrowser()` | 不 spawn（同口径） |
| `raccoon-login-page.ts` `runAuthorizeRound` | 不调用 `openAuthorizePage`；`/raccoon/authorize/start` 回 `{ opened:false, autoOpen:false }`；页面显示链接 + 「复制链接」按钮（页面自己的 `window.open` 只在用户点击链接时发生，属用户手势） |

### 设置分区（用户定稿的 D 方案）

「供应商」下方新增「登录授权」，开关采用**长句并入 label**的写法（与「思考强度」同款）：

```
登录授权
[开关 ✓] 新建账号时自动打开浏览器授权页；关闭则把授权链接复制到剪贴板
  开（默认）：点「+ 新建账号」后自动打开授权页，与现在的行为一致。关：不自动开窗；
  授权链接复制到剪贴板，并显示在账号面板里（带「复制链接」按钮）。
```

读 / 写失败时显示 `⚠️ 开关状态读取 / 保存失败（宿主可能仍在运行旧代码）。请重试；仍不行请完全退出并重新打开 DSH。`（与 `reasoningDefault` 的旧宿主提示同款），且**不禁用**开关（保留自救路径）。

### 设置弹窗尺寸与边界

```css
.dim-jh-settingsModal {
  width: min(840px, 100%);
  max-height: min(940px, calc(100vh - 48px));
  border: 1px solid var(--dsw-alias-border-l2, #3a3d45);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-label-primary, #fff) 8%, transparent),
    0 16px 48px rgba(0, 0, 0, 0.38);
}
```

- 只改设置弹窗，**不动**通用 `.dim-jh-modal`；**分区间距保持 8/10**（用户要求）。
- 边框直接复用「档次窗口」（`.dim-jh-windowModal`，2026-11-20 同一报障）的两条处方：① 实边框 `border-l2`（暗色主题下最可靠的窗口边界）；② 内描边半透明白（浅色主题下 `border-l2` 太淡，第二道保险）。
- 保留 `.dim-jh-modalBody` 的 `overflow-y: auto`：768p 笔记本仍要能滚到底部「完成」——「不出下拉条」是 1080p 及以上的效果，不是把滚动能力删掉。

---

## 三、落点

| 位置 | 内容 |
|---|---|
| `src/login-preferences.ts` | **新增**：偏好文档（文件/内存两后端、按路径缓存、原子写、`sanitize`）+ 宿主闸门判据来源（`configureAutoOpenBrowserEnabled` / `autoOpenBrowserEnabled`） |
| `src/index.ts` | 启动时接线偏好来源（与 `configureStrongestReasoningEnabled` 并列） |
| `src/login.ts` / `src/accio-oauth.ts` | 三处 `openBrowser` / `openIncognitoWindow` 闸门 |
| `src/raccoon-login-page.ts` | `autoOpenBrowser` 注入点；`runAuthorizeRound` 回报 `opened/autoOpen`；页面复制按钮与提示分流 |
| `src/jet-hub-rpc.ts` / `src/types.ts` | 两条 RPC + 三个类型 |
| `plugin-src/client/login-preferences-store.js` | **新增**：客户端唯一状态源（读失败按开、有界重试、慢读回包不倒灌） |
| `plugin-src/client/jet-hub.js` | 设置分区 + `createAccount` 分流 + 手动链接文案 + 清理点复位 |
| `plugin-src/client/openai-gateway-panel.js` | `copyToClipboard(value, { silent })` |
| `plugin-src/client/jet-hub-styles.js` | 840 / 940 + 实边框与内描边（间距不动、滚动兜底保留） |
| `README.md` / `docs/agent-notes/client-ui.md` / `AGENTS.md` | 用法说明 + 事故史/两条腿 + 索引从 27 节改为 28 节 |
| `package.json` | `0.2.1-rc.4` → `0.2.1-rc.5` |

---

## 四、验证

### 测试（新增 49 条 + 扩展 6 条）

| 文件 | 条数 | 锁什么 |
|---|---|---|
| `tests/unit/login-preferences.spec.ts` | 12 | 缺键=开 / 只有字面量 `false` 才关 / 写进去读回来 / 损坏回落开 / 裸布尔兼容 / 两实例共享缓存 / 闸门未接线与来源抛错都按开 |
| `tests/unit/login-preferences-rpc.spec.ts` | 5 | 真 handler：默认开、损坏仍开、写后读到、**非布尔 bad-request**、**响应回落盘值**（`save` 静默失败时抓回传入参） |
| `tests/unit/login-preferences-store.spec.ts` | 11 | 客户端：读失败按开（3 轮重试）、形状不对不重试、并发去重、**慢读回包不倒灌**、宿主回传值优先、订阅 |
| `tests/unit/login-auto-open-wiring.spec.ts` | 21 | 三处宿主闸门 + RPC/类型 + raccoon 三态 + 客户端分流 + 既有锚点 + 780/940 + 「间距不压缩」「滚动兜底仍在」 |
| `tests/unit/jet-hub-panel-wiring.spec.ts` | +3 | 真渲染 `ProviderPanel` + 真调 `createAccount`：**关闭态不开窗 / 不弹无痕确认 / 剪贴板拿到链接 / 面板显示链接**；MiniMax 关闭态不弹登出确认、复制的是 `forcedLoginUrl`；开启态反向对照 |
| `tests/unit/raccoon-login-page.spec.ts` | +3 | 关闭态不调用 `openAuthorizePage` 且回报 `false/false`；开启态照旧开窗一次；单飞复用 `opened=false` |

### 变异验证（8 条全部精确变红，事后逐个还原）

| 变异 | 变红的用例 |
|---|---|
| 偏好默认值翻面（只认 `true`） | `login-preferences` |
| 客户端手动分支短路（`if (false)`） | `jet-hub-panel-wiring` |
| 去掉自动复制 | `jet-hub-panel-wiring` |
| RPC 去掉非布尔校验 | `login-preferences-rpc` |
| Raccoon 忽略闸门（`if (true)`） | `raccoon-login-page` |
| 设置弹窗尺寸改回 560/760 | `login-auto-open-wiring` |
| 客户端读失败按「关」兜底 | `login-preferences-store` |
| 宿主 `openBrowser` 去掉闸门 | `login-auto-open-wiring` |

### 全量

- `npx tsc -p tsconfig.json --noEmit` / `npx tsc -p tsconfig.tests.json` ✅
- `pnpm build:all` ✅
- `npx vitest run`：**14990 passed / 7 failed / 26 skipped**（共 15023）。
  7 条为 **`origin/master` 基线已知失败**，本次改动**不触碰**它们的文件：
  `qoder-web-usage.spec.ts`×4、`balance-disk-cache.spec.ts`×1（flaky）、
  `raccoon-authorize.spec.ts`×1、`autoclawintl-zai-wiring.spec.ts`×1。
  （在本 PR 改动前的同基线全量跑中，同一批 7 条即已失败。）

### 真机验收（建议照此过一遍）

| 场景 | 开关=开 | 开关=关 |
|---|---|---|
| CodeArts / OfficeAce | 自动无痕窗（现状） | 不开窗；剪贴板有链接；面板显示链接 + 无痕提示 |
| Qoder / Buddy / Trae / Cline / Gemini / Accio / ZCode / LobsterAI | 弹窗（现状） | 不开窗；剪贴板有链接；粘贴打开后 `login.poll` 正常落定 |
| MiniMax | 登出确认 → 授权页（现状） | 不弹登出确认、不开窗；链接是 `forcedLoginUrl` |
| Raccoon | 载体页点「打开授权页」⇒ 宿主开窗 | 载体页显示链接 + 复制按钮，无宿主弹窗 |
| 豆包 / 百智云 / 超级麦吉 / MonkeyCode / Marvis | 受控浏览器窗口 | **仍然开**（预期） |
| 设置弹窗 | 1080p 下无滚动条 | 同左；768p 可滚动 |
| 重启 DSH | — | 开关保持「关」 |

---

## 五、兼容与边界

- **默认开**：与本功能上线前一致，升级后行为不突变。
- **新客户端 + 旧宿主**（改了插件没重启）：`getEnabled` 不存在 ⇒ 客户端按「开」并提示重启；旧宿主仍会开无痕窗 —— 不静默变坏。
- **旧客户端 + 新宿主**：旧客户端照旧 `window.open`，宿主无痕窗被闸门挡住 ⇒ 窗口期只能自动开普通窗（不会打不开）；刷新页面即恢复。
- CodeArts / OfficeAce 手动打开可能复用旧会话 ⇒ 文案显式提示用无痕窗口（这是关闭自动开窗的**已知代价**）。
- 回环渠道（`127.0.0.1` 链接）在远程部署下仍需「手动粘贴回调链接」那条既有通道；本 PR 不改它。
- **不引入环境变量**：避免「环境变量 + 设置页」两套判据；无头部署可直接写 `login-preferences.json`。

---

## 六、未做（如实登记）

- **不按 provider 单独开关**：需求是一个开关；文件 schema 预留扩展位。
- **不改变 CDP 驱动渠道**：没有可复制 URL，关掉即不可登录。
- **不改「弹窗被拦截」时的既有行为**（只复用 UI）。
- **不动 `login.poll` 三态契约、不动无痕隔离机制**（只加闸门）。