# 待实现需求备忘

> 记录时刻：2026-11-26
> 状态：**未开始**，仅记录需求与已讨论的方案。

---

## 需求 1：子代理候选帐号池

### 用户原话

> 「我想修改一下子代理设置，增加一个候选帐号池的功能，也就是选定的帐号池里面才拉起子代理，
> 不在池里的不拉」

### 已讨论的语义（**未最终确认**）

| # | 问题 | 建议 |
|---|---|---|
| 1 | 池里无可用号时是否允许拉起 | **A：报错不拉**（待用户确认）|
| 2 | 按账号勾选 / 按档位 | 按**账号**勾选 |
| 3 | 空池 = 全部允许还是全部禁止 | 空 = **全部允许**（等于未配置，零回归）|

### 实现路径（已勘察）

| 层 | 改动 | 复杂度 |
|---|---|---|
| 数据 | `SubagentRotationSetting` 加 `allowedAccountIds?: string[]` + `sanitize` | 低 |
| 逻辑 | `credential-resolver` 的 `candidatesOf(...)` 之后加一道 filter | 低 |
| RPC | 校验 + 透传 | 低 |
| UI | 折叠式多选（见下）| 中 |
| 测试 | 行为级 + 变异 | 中 |

**核心逻辑只有一行**：

```ts
const candidates = candidatesOf(deps.pool, providerId, modelId)
  .filter((c) => allowedAccountIds === undefined || allowedAccountIds.includes(c.id))
```

**现成模板**：`jet-hub-store.ts` 的 `aggregateAllowed`（`sanitizeAggregateAllowed`
就是「按 provider → 按账号 id 的 boolean 表」，语义与 sanitize 模式可直接复用）。

### UI 方案（用户倾向待确认）

默认折叠，只占一行；展开用两列网格：

```
候选帐号池   ⚪ 全部（默认）  ⚫ 自定义 ▾
             ↓ 展开后
             ┌─────────────┬─────────────┐
             │ ☑ 1 190***883│ ☐ 5 177***896│
             │ ☑ 2 177***916│ ☐ 6 陈水广   │
             │ ☐ 3 134***959│ ☐ 7 行行     │
             │ ☐ 4 177***016│              │
             └─────────────┴─────────────┘
             [全选] [清空]      已选 2 / 7
```

理由：
- 默认「全部」⇒ 不配置时行为**完全不变**（零回归）
- 折叠态只占 1 行，不挤压现有排版
- 两列网格在 7~13 个号时都不挤

---

## 需求 2：档位「积分阈值」提前降级（**方案已定稿**）

> 状态：**UI 已定稿并经浏览器实拍确认**，等 PR #158 被上游采纳后再实现。

### 用户原话

> 「如果我想要档次窗口的临期和短期窗口右侧，加上低于指定积分就算另一档位，可以做吗？
> 比如，临期积分低于 20 就不再算临期了，归入短期，短期低于 30 就不算短期了，
> 自动归入长期，因为现在帐号的积分获取比较慢，所以实际上当帐号在使用临期时，
> 总是会使用全部临期和部分短期才会切换下一个临期帐号，所以上一个帐号的短期被使用部分，
> 我想加上这个功能，让一个帐号提前切换，防止它的短期积分被使用。」

### 问题本质

```
现在：临期 > 0 就算临期档
      ⇒ 一个号只要还剩 1 点临期，就一直是「临期号」
      ⇒ 系统把它临期烧光 + 部分短期才切走
      ⇒ 那个号的短期被「污染」

要：  临期 < 20 ⇒ 该号按「短期」排队（提前切走）
      短期 < 30 ⇒ 按「长期」排队
      ⇒ 保住下一档积分不被这个号吃掉
```

### 已确认的语义（用户定案，**不要再变**）

| # | 问题 | 定案 |
|---|---|---|
| 1 | 阈值单位 | **绝对值**（积分，不是百分比）|
| 2 | 降级还是不可用 | **降级** —— 看成「该档已消耗完」，提前进入下一档队列（**不浪费剩余积分**）|
| 3 | 阈值与窗口天数关系 | **并列 AND**：`距过期 < N 天 **且** 剩余 ≥ 阈值` 才算该档 |
| 4 | 存储层级 | 按 **provider** 存（与现有 `creditWindows` 同层级）|
| 5 | 空值语义 | **留空 / 0 = 关闭**（与现状完全一致，零回归）|
| 6 | 轮到时是否烧剩余那点临期 | **会** —— 降级只改「排队顺序」，不改「烧包顺序」|

### 数据结构

```ts
// jet-hub-store.ts 的 CreditWindowSetting
export interface CreditWindowSetting {
  windowDays?: number
  imminentDays?: number
  /** ★ 临期剩余**低于**该值 ⇒ 提前按「短期」排队。`undefined` / 0 = 关闭。 */
  imminentFloor?: number
  /** ★ 短期剩余**低于**该值 ⇒ 提前按「长期」排队。`undefined` / 0 = 关闭。 */
  expiringFloor?: number
  subagent?: SubagentRotationSetting
}
```

### 后端核心（只有 2 行）

```ts
// buddy-balance-rank.ts 的 buddyBalanceTier
export function buddyBalanceTier(balance, options = {}) {
  const imminentFloor = options.imminentFloor ?? 0
  const expiringFloor = options.expiringFloor ?? 0

  // ⚠️ `>` 不是 `>=`：阈值 0 时 `> 0` = 现状（零回归）
  if (positiveOrZero(balance.imminentBalance) > imminentFloor) return imminent
  if (positiveOrZero(balance.expiringBalance) > expiringFloor) return expiring
  if (options.allowPermanent === false) return none
  if (positiveOrZero(balance.permanentBalance) > 0) return permanent
  return none
}
```

### ⚠️ 必须同步客户端（本仓红线：同一语义不得两套）

| 位置 | 用途 | 必须同改 |
|---|---|---|
| `buddy-balance-rank.ts` 的 `buddyBalanceTier` | 后端选号 | ✅ |
| `usage-badge.js` 的 `tierAtSelectionOf` | 客户端算档位快照 | ✅ |

**不同步的后果**：面板显示的档位与实际选号分叉
—— 正是历史上「界面说临期、实际烧永久」的形态。

### 覆盖数必须实时联动（用户明确要求）

`credit-window-ui.js` 的 `computeCoverage` 要接阈值入参：

```ts
export function computeCoverage(accounts, windowDays, imminentDays, now, imminentFloor = 0, expiringFloor = 0) {
  const split = splitCreditsByExpiry(packages, windowDays, now, imminentDays)
  const imminent = Number(split.imminent) || 0
  // ★ 低于阈值就不算这一档（落到下一档）
  const countsImminent = imminent > imminentFloor
  // ...按 countsImminent 累计覆盖面
}
```

⚠️ **必须与后端同口径**，否则覆盖数会骗人。

---

### UI 定稿（v5，已用浏览器实拍确认）

实测 HTML：`C:/Users/HSG/ego/credit-floor-mock-20261126/mock-v5.html`
（含 5 种状态：默认 / 最大数值 / 与旧版对比 / 关闭态 / 窄屏 400px）

```
┌─ 档次窗口  CodeBuddy ────────────────────────────────────┐
│ ● 临期窗口 [ 1 ] 天 剩余< [ 20 ] 积分  覆盖 2 个号        │
│   距过期 < 1 天 且 剩余 ≥ 20 积分 → 算「临期」            │
│                                                           │
│ ● 短期窗口 [ 2 ] 天 剩余< [ 30 ] 积分  覆盖 4 个号        │
│   距过期 ≤ 2 天 且 剩余 ≥ 30 积分 → 算「短期」（含临期）  │
│                                                           │
│ ┌ 改动后预览（按新窗口 + 阈值重新分档）──────────────┐  │
│ │ ● 临期 < 1 天          2 个号    52.68   ▬         │  │
│ │ ● 短期 1 ~ 2 天        2 个号    98.33   ▬▬        │  │
│ │ ● 永久 ≥ 2 天          3 个号 3,400.00   ████████  │  │
│ └─────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────┘
```

#### 三条硬性排版要求（用户逐条确认过）

| # | 要求 | 实现 |
|---|---|---|
| 1 | **阈值与窗口期同一行** | 实测自然宽 **371px**，可用 520px ✅ 余 149px |
| 2 | **窗口框与阈值框都 52px** | 「36500」12px 下仅占 33px，内容区 38px 余 5px ✅ |
| 3 | **覆盖徽标紧跟阈值，不靠右** | 去掉 `margin-left: auto`，改 `margin-left: 4px` |

#### CSS 定稿

```css
/* 从 92px 收到 52px；窗口框与阈值框统一 */
.dim-jh-windowInput {
  width: 52px;
  text-align: center;              /* 短数字居中更整齐 */
  font-variant-numeric: tabular-nums;
}

/* 覆盖徽标紧跟阈值（原来是 margin-left: auto 靠右） */
.dim-jh-windowCover {
  margin-left: 4px;
}
```

#### 其他 UI 细节

- **关闭态**：阈值留空 ⇒ `border-style: dashed` + `placeholder="0"` + 灰字
- **窄屏 400px**：`flex-wrap: wrap`，徽标必要时降第二行，输入框不压缩
- **预览区不显示降级提示**（用户明确说不需要）
- **输入约束**：`maxlength="5"`，合法范围 `0 ~ 36500`

#### 浏览器实测数据（可复现）

| 项 | 值 |
|---|---|
| 「36500」在 12px 字号下文本宽 | **33px** |
| 52px 框的内容区宽 | **38px**（余 5px ✅）|
| 整行自然宽度（含阈值）| **371px**（弹窗内容区 520px）|
| 徽标间隙 | 38px（=「积分」二字 + 6px gap）|
| 右侧余量 | 195px（不靠右，自然留白）|

---

### 改动量估算

| 文件 | 改动 | 量 |
|---|---|---|
| `jet-hub-store.ts` | +2 字段 + sanitize | ~30 行 |
| `buddy-balance-rank.ts` | **+2 行** | 2 行 |
| `usage-badge.js` | **+2 行**（客户端档位同步）| 2 行 |
| `credit-window-ui.js` | `computeCoverage` 接阈值 + 校验 | ~20 行 |
| `jet-hub.js` | UI 渲染（阈值输入行）| ~40 行 |
| `jet-hub-rpc.ts` | RPC 校验 + 透传 | ~15 行 |
| `jet-hub-styles.js` | CSS（52px / margin-left）| ~10 行 |
| 测试 | 行为级 + 变异 | ~10 条 |

**总计约 250 行**（含测试），**无架构性改动**。

### ⚠️ 实现时必须注意的四条

1. **`>` 不能写成 `>=`** —— 阈值 0 时 `> 0` 才是现状（零回归）
2. **客户端与后端必须同源** —— 否则面板与实际选号分叉
3. **覆盖数必须实时联动** —— 改阈值立刻变（用户明确要求）
4. **锁定永久时的降级链** —— 临期(低) → 短期(低) → **none**（不去烧永久）

