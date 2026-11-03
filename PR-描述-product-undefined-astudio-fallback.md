# PR：聚合侧未传 product 时不再读取 undefined 的 id（修 credits 总览/余额抛 TypeError）

一行断言写错，两处同文本，抵掉了一条兜底分支、并在余额卡片上把「凭据未配置」变成一句
用户看不懂的 `Cannot read properties of undefined (reading 'id')`：

```
fix(jet-hub): 聚合侧未传 product 时不再读取 undefined 的 id（修 credits 总览/余额抛 TypeError）

credits.status 与 credits.balances 两条聚合路径的调用侧恒传 product=undefined（该参数
只被透传给 fetchStatus），而函数体里的 AStudio defaultCredentialRef 兜底判据写成
`(product as { id?: string }).id`——类型断言绕过了 undefined 检查，运行时必抛
TypeError: Cannot read properties of undefined (reading 'id')。

于是兜底分支从未生效：status 侧被 catch 吞成一条告警（用户无感），balances 侧把
caught.message 直接当 error 返回，余额卡片显示原始 TypeError 而不是「凭据未配置」。

改为 `(product as { id?: string } | undefined)?.id`，并补两条覆盖该入参形态的回归用例。
```

> ⚠️ 本 PR **刻意不含** AStudio 兜底行为本身的改动（详见第七、八节）：它修的是「不要再崩」，
> **不是**「把兜底跑起来」。也不含任何 UI 改动、不改 `fetchStatus` 契约、不动其余 provider。
>
> 行号说明：全部按**本 PR 分支**（基于 `origin/master` `c17a556`）。

---

## 一、缺陷现象

两处表现，严重度不对称：

1. **余额卡片**（`credits.balances`）：账号卡上出现原文
   `Cannot read properties of undefined (reading 'id')`，
   期望是「凭据未配置」。用户看到的是内部实现细节，无法据此判断该去做什么。
2. **签到状态总览**（`credits.status`）：界面看起来正常（该账号 `status = null`），
   但 `deps.warn` 里每次刷都会多一条
   `[jet-hub] credits.status 账号 … 失败: TypeError: Cannot read properties of undefined (reading 'id')`。
   **它是静默的** —— 因为告警只写日志/回调，不进 UI。

第 2 点决定这个 bug 能活很久：**同一个根因在其中一条路径上几乎不可观测**。

## 二、根因

### ① 断言把 `undefined` 说成非空，绕过了本该拦住的判据

```
src/jet-hub-rpc.ts:1133   if (resolved === undefined && (product as { id?: string }).id === ASTUDIO.id) {
src/jet-hub-rpc.ts:1373   if (resolved === undefined && (product as { id?: string }).id === ASTUDIO.id) {
```

（改前两处逐字相同，均为旧形态。）

（`:1133` 是 `collectCreditsStatus` worker 内，`:1373` 是 `collectCreditBalances` 的
`if (balance === null)` 分支内；两处改前**逐字相同**。）

`as { id?: string }` 声称「这个值是对象，只是 `id` 可选」，于是 `?.` 无处可用、
TS 也不再提示可能为空 —— 而运行时的真实取值是 `undefined`。

### ② 调用侧本来就恒传 `undefined`，且是**刻意的**

```
src/jet-hub-rpc.ts:6941   // ⚠️ 第二参（product）统一传 `undefined`：它**只被透传给 `fetchStatus`**，
src/jet-hub-rpc.ts:6945   const value = await collectCreditsStatus(accounts, undefined, {
src/jet-hub-rpc.ts:7508   const values = await collectCreditBalances(accounts, undefined, {
```

聚合侧只有这两个调用点（`src/*.ts` 全仓核对过），**两个都传 `undefined`**
⇒ 这条兜底分支在聚合路径上**一次都没有执行过**，每次进入都在第 ① 步抛异常。

### ③ 两条路径的 catch 语义不同 ⇒ 不对称暴露

```
src/jet-hub-rpc.ts:1140   } catch (error) {
src/jet-hub-rpc.ts:1146     deps.warn?.(`[jet-hub] credits.status 账号 ${...} 失败: ${String(error)}`)
（上方注释：告警是尽力而为，它坏了不该让用户看不到其余账号的签到状态）
```

status 侧：`status = null` + 一条告警 ⇒ 静默。

```
src/jet-hub-rpc.ts:1395   } catch (caught) {
（随后 error = caught instanceof Error ? caught.message : String(caught)）
src/jet-hub-rpc.ts:1376   if (resolved === undefined) {
src/jet-hub-rpc.ts:1377     error = '凭据未配置'
```

balances 侧：`error = caught.message` ⇒ 原始 TypeError 直接上屏。
**同一行断言，两种命运** —— 这是本 PR 只改断言而两条路径都要补用例的原因。

## 三、修法（两处，同一形态）

```
-        if (resolved === undefined && (product as { id?: string }).id === ASTUDIO.id) {
+        if (resolved === undefined && (product as { id?: string } | undefined)?.id === ASTUDIO.id) {
```

- 断言改成 `as { id?: string } | undefined`：让类型如实包含 `undefined`；
- 取值改用 `?.id`：`product === undefined` 时得 `undefined`，
  `undefined === ASTUDIO.id` 为 `false` ⇒ **跳过兜底、继续走既有的「无凭据」分支**，
  不再抛异常。

两处的施加方式：按行号断言原文后逐行替换（因为两处文本**完全相同**，用
`replace` 无法只改一处）。改后全文件检索旧断言 `(product as { id?: string })` 为 **0 命中**
——没有第三处遗漏。

## 四、验证

- `pnpm run build:all`（`tsc` 全量 + 资产拷贝）exit 0；
- `pnpm test`（`pretest = npm run typecheck:tests`，故测试侧类型检查同轮跑过）：
  **Test Files 483 passed | 2 skipped (485)，Tests 11653 passed | 26 skipped (11679)**，
  Duration 94.86s，exit 0。跳过项是仓库既有 skip。
- 定向：`tests/unit/jet-hub-rpc.spec.ts` **256 passed**（改动前 254，新增 2）。
- 本仓库**没有 lint 脚本**（`package.json` 无 `lint` / `format`）⇒ 验证口径就是
  `typecheck:tests` + `vitest run`。

新增两条用例（`tests/unit/jet-hub-rpc.spec.ts`），都打「聚合侧的真实入参形态」：
`product` 传 `undefined`、`resolve()` 返回 `undefined`。

| # | 用例 | 守的能力 |
|---|---|---|
| 1 | 未传 product 时回落为「无凭据」，而不是读取 undefined 的属性 | status 侧不再抛 TypeError（断言告警串里不含 `reading 'id'`） |
| 2 | 未传 product 时给出「凭据未配置」，而不是抛出 TypeError | balances 侧 `error` 是业务文案而非异常消息 |

**变异验证（这两条用例不是摆设）**：把两处改回缺陷版后跑
`vitest run tests/unit/jet-hub-rpc.spec.ts -t "未传 product"` ⇒
`Tests 2 failed | 254 skipped`，报错即缺陷本体：

```
status    Received: "[jet-hub] credits.status 账号 astudio-fallback 失败: TypeError: Cannot read properties of undefined (reading 'id')"
balances  Expected: "凭据未配置"
           Received: "Cannot read properties of undefined (reading 'id')"
```

随后还原修复版，回读确认两处均为新文本。

测试入参说明：`credits.*` 两函数的泛型默认是 buddy 系
（`<TCredential = BuddyCredential, TProduct = BuddyProduct>`），文件内既有注释记载
传 `ASTUDIO` 作 product 会 `TS2345`；而要复现本缺陷只需 `product` 为 `undefined`，
故用例沿用文件内既有的 `WORKBUDDY` 夹具、product 传 `undefined as never`，
不引入新的类型面。

## 五、⚠️ 明确**不做**的事（审阅请重点看这节）

- **不把兜底「修好」**：不去让 `product` 有值、也不改调用侧那两个 `undefined`
  （`:6945` / `:7508`）。理由见第八节——那是契约级改动，属于另一个 PR 的判断。
- **不改 AStudio 的凭据/登录/会话逻辑**：`src/astudio-product.ts` / `src/astudio-oauth.ts` 一行没动。
- **不改 `fetchStatus` 契约**：本 PR 不改它如何用 product，只改判据不再炸。
- **不动其余 provider**、不动并发语义（status 侧有限并发 / balances 侧串行，均保持原状）。
- **不改 UI**：余额卡片的文案来自 `error` 字段，修好入参后自然回落到「凭据未配置」，
  不需要前端配合。

## 六、诚实边界（如实登记）

1. **修完之后这条兜底仍然不执行**。`product === undefined` ⇒ `?.id` 得 `undefined`
   ⇒ 恒不等于 `ASTUDIO.id` ⇒ 分支被跳过。本 PR 的收益是
   「**从抛异常变成静默跳过**」，**不是**「AStudio 兜底恢复工作」。
   请勿把本 PR 读成「AStudio 的 defaultCredentialRef 兜底已可用」。
2. **兜底为什么不在这条路径上生效，是设计而非疏漏**：聚合侧注释明说第二参
   「只被透传给 `fetchStatus`，而 `fetchStatus` 现在由 credits 表提供」——
   也就是说 credits 聚合已经**不靠 product 决定凭据 ref**。要真让兜底生效，
   需要先决定聚合路径是否应该按 provider 分别传 product，这是契约取舍，不在本 PR。
3. **断言只是窄化了崩溃面**：`resolved` 之后若 `credentialRef(entry.credentialRef)` 抛出
   其它形态（例如 ref 为空串），仍走各自的 catch，本 PR 未改变这些路径的语义。
4. **并发语义未变**：`collectCreditsStatus` 仍是有限并发（默认 3），
   `collectCreditBalances` 仍是串行。本 PR 不涉及性能。

## 七、涉及文件

| 文件 | 变化 |
|---|---|
| `src/jet-hub-rpc.ts` | **±2 行 / 两处**：`as { id?: string }` → `as { id?: string } \| undefined` + `?.id`（`:1133`、`:1373`） |
| `tests/unit/jet-hub-rpc.spec.ts` | **+25**：两条回归用例（status 段、balances 段各一） |

`git diff --stat`：2 文件，`27 insertions(+) / 2 deletions(-)`。

## 八、审阅建议顺序

1. 先看 `src/jet-hub-rpc.ts:6945` / `:7508` 两个调用点与它们上方的注释（`:6941`）——
   确认「聚合侧恒传 `undefined`」是刻意的，这样才明白为什么崩是必然而非偶发；
2. 再看 `:1133` / `:1373` 的两处 diff —— 只有断言与 `?.`，没有逻辑分支变化；
3. 然后看两条新用例，重点确认它们**断言的是行为**（告警串 / `error` 文案）而不是源码文本；
4. 最后看第六节「诚实边界」第 1 条 —— **如果你希望的是「让兜底跑起来」，
   那本 PR 不是你要的那一个**，请直接说，我另开一个改契约的 PR。