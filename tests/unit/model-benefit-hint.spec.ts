import { describe, expect, it, vi } from 'vitest'

/**
 * 「需福利包」角标的行为级守卫（Gitee issue **IKJOF7**）。
 *
 * ## 这个文件要挡的是什么
 *
 * issue 的原始诉求是「`glm-5.3-flash` 在积分制账号上必然失败」，而它的**症状**
 * 极难自诊断：请求先带 `maas_type: benefit` 被上游 `InferHub.4004.200` 拒 ⇒
 * 插件自动降级去头重试 ⇒ 再回 `002002009.404 The model is not registered`。
 * 用户看到的最终错误与「模型名写错了」**逐字节同形**。
 *
 * 修法是在设置页给这类模型挂一枚「需福利包」角标，把因果讲清楚。而这条修法
 * 的价值**全部**压在一个 `=== true` 判据上：
 *
 * | 写法 | 未知状态（冷缓存）时的后果 |
 * |---|---|
 * | `model.benefitOnly === true` | ✅ 不渲染（正确） |
 * | `model.benefitOnly !== false` | ❌ 整页模型都挂角标（`undefined !== false` 为真） |
 * | `model.benefitOnly ?? false` 后再判真 | ✅ 等价，但若写成 `!== undefined` 又错 |
 * | `Boolean(model.benefitOnly)` | ✅ 等价 |
 * | `'benefitOnly' in model` | ❌ 服务端「命中才写」⇒ 看起来等价，但一旦字段被写成 `false` 就错 |
 *
 * 而**源码文本断言**对这五者里的任意两个都分辨不出来（本仓 `if (false)` 旁路
 * 事故已记录同型：三条源码断言各有一个真实旁路，41 条用例全绿而代码确实抛错）。
 *
 * ⇒ 必须真渲染九种 `model` 形状，逐个看产物里有没有那枚角标。
 *
 * ## ⚠️ 为什么本来`model-center-panel.spec.ts` 拦不住
 *
 * 那个文件是**源码级**的（文件头写明「单测环境里没有 react，组件无法渲染」），
 * 它只钉「模型屏必须复用 `ModelToggle`」。`ModelToggle` 内部的渲染分支
 * 一条都没被真正执行过 —— 这也正是本仓「接线层零守卫」反复出现的那个坑。
 */

/** 极简 React 元素树：只要能把 props 与文本子节点走一遍。 */
type Node = { type: unknown; props: Record<string, unknown>; children: unknown[] }

const reactStub = {
  createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Node =>
    ({ type, props: props ?? {}, children }),
  Fragment: 'Fragment',
  StrictMode: 'StrictMode',
}

vi.mock('react', () => reactStub)

type ToggleProps = {
  provider: string
  model: Record<string, unknown>
  busy: boolean
  onToggle: (id: string, disabled: boolean) => void
  onRestore: (id: string) => void
}

/** 真渲染一次 `ModelToggle`，返回元素树根。 */
async function renderRow(model: Record<string, unknown>): Promise<Node> {
  const mod = await import('../../plugin-src/client/jet-hub.js') as unknown as {
    __modelToggleForTest: (props: ToggleProps) => Node
  }
  expect(mod.__modelToggleForTest, '客户端必须导出 __modelToggleForTest 才能真渲染').toBeTypeOf('function')
  return mod.__modelToggleForTest({
    provider: 'codearts',
    model,
    busy: false,
    onToggle: () => {},
    onRestore: () => {},
  })
}

/** 深度优先收集所有元素节点（含根）。 */
function walk(node: Node): Node[] {
  const out: Node[] = [node]
  for (const child of node.children) {
    if (child !== null && typeof child === 'object' && 'props' in (child as Node)) {
      out.push(...walk(child as Node))
    }
  }
  return out
}

/** 某个类名的全部节点。 */
function byClass(root: Node, className: string): Node[] {
  return walk(root).filter((node) => node.props.className === className)
}

/** 收集节点子树里的全部文本（用来断言角标文案与 title）。 */
function textsOf(node: Node): string {
  const parts: string[] = []
  for (const child of node.children) {
    if (typeof child === 'string') parts.push(child)
    else if (child !== null && typeof child === 'object' && 'props' in (child as Node)) {
      parts.push(textsOf(child as Node))
    }
  }
  return parts.join('')
}

const BASE = { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', disabled: false, dead: false }

describe('设置页「需福利包」角标（IKJOF7）', () => {
  /**
   * ⚠️⚠️ 本文件**唯一**的核心判据：未知状态必须不渲染。
   *
   * 服务端「命中才写 `benefitOnly: true`」，冷缓存 / 远端降级时该字段**彻底缺席**
   * （见 `src/types.ts` 的字段注释）。把「缺席」渲染成角标就等于告诉用户
   * 「所有模型都要福利包」—— 与 `dead-model-store.ts` 里「拿读不到反推已下架」
   * 是同一条禁令。
   */
  it('★★★ 字段缺席（未确认）⇒ 不渲染角标', async () => {
    const row = await renderRow({ ...BASE })

    expect(byClass(row, 'dim-jh-modelBenefitOnly'), '未确认时不许挂角标').toHaveLength(0)
    expect(textsOf(row)).not.toContain('需福利包')
  })

  it('★★★ 显式 false ⇒ 不渲染角标', async () => {
    const row = await renderRow({ ...BASE, benefitOnly: false })

    expect(byClass(row, 'dim-jh-modelBenefitOnly')).toHaveLength(0)
  })

  it('★★★ 脏数据（字符串 "true" / 数字 1）⇒ 不渲染角标', async () => {
    // ⚠️ 只有 `=== true` 才认。写成 `Boolean(...)` 或 `!== false` 时这两个都会
    //    被当成真 —— 而它们只能来自版本不匹配或手改的响应，不该驱动 UI。
    for (const dirty of ['true', 1, {}, []]) {
      const row = await renderRow({ ...BASE, benefitOnly: dirty })
      expect(byClass(row, 'dim-jh-modelBenefitOnly'), `benefitOnly=${JSON.stringify(dirty)} 不该渲染`).toHaveLength(0)
    }
  })

  it('★★★ true ⇒ 渲染恰好一枚角标，且文案与解释齐备', async () => {
    const row = await renderRow({ ...BASE, benefitOnly: true })

    const marks = byClass(row, 'dim-jh-modelBenefitOnly')
    expect(marks, '确认属于 benefit 集合时必须挂角标').toHaveLength(1)
    // 行内只放极短帽子（≤ 5 个汉字，与「已下架」同一取舍：解释全进 title）。
    expect(textsOf(marks[0])).toBe('需福利包')

    const title = String(marks[0].props.title)
    // 解释必须讲清三件事，否则用户仍然不知道该怎么办：
    //   ① 为什么要特殊对待（要带 maas_type 头）
    //   ② 插件会做什么（自动领一次，幂等）
    //   ③ 最终会看到什么错误（002002009.404，与「模型名写错」同形）
    expect(title).toContain('maas_type')
    expect(title).toContain('福利包')
    expect(title).toContain('自动')
    expect(title).toContain('002002009.404')
  })

  it('★★ 角标是标记不是门禁：开关照常渲染、照常可点', async () => {
    // ⚠️ 这一格防的是「顺手把这类模型禁用/隐藏」的改法：那会让用户
    //    **失去换账号后立刻可用的路径**，也会重演「静态表当门禁」那两轮事故。
    const onToggle = vi.fn()
    const mod = await import('../../plugin-src/client/jet-hub.js') as unknown as {
      __modelToggleForTest: (props: ToggleProps) => Node
    }
    const row = mod.__modelToggleForTest({
      provider: 'codearts',
      model: { ...BASE, benefitOnly: true },
      busy: false,
      onToggle,
      onRestore: () => {},
    })

    const boxes = walk(row).filter((node) => node.props.type === 'checkbox')
    expect(boxes, '角标不得顶掉开关').toHaveLength(1)
    expect(boxes[0].props.disabled, '角标不得禁用开关').toBe(false)
    expect(boxes[0].props.checked).toBe(true)

    ;(boxes[0].props.onChange as () => void)()
    expect(onToggle).toHaveBeenCalledWith('glm-5.3-flash', true)
  })

  it('★★ 与「已下架」共存：两种角标各自独立', async () => {
    // 已下架 = 系统判定上游拿掉了（只能「重新显示」）；需福利包 = 换账号就能用。
    // 两者同时成立时**都不许丢**，否则用户会按错的自救路径操作。
    const row = await renderRow({ ...BASE, dead: true, benefitOnly: true })

    expect(byClass(row, 'dim-jh-modelDead'), '已下架角标被顶掉了').toHaveLength(1)
    expect(byClass(row, 'dim-jh-modelBenefitOnly'), '需福利包角标被顶掉了').toHaveLength(1)
  })

  it('★ 角标位于 name/id 之前（窄面板下不被 ellipsis 先裁掉）', async () => {
    const row = await renderRow({ ...BASE, benefitOnly: true })
    const info = byClass(row, 'dim-jh-modelInfo')
    expect(info).toHaveLength(1)

    const order = info[0].children
      .filter((child): child is Node => child !== null && typeof child === 'object' && 'props' in (child as Node))
      .map((child) => String(child.props.className))
    expect(order.indexOf('dim-jh-modelBenefitOnly'), '角标必须排在 id 之前').toBeGreaterThan(-1)
    expect(order.indexOf('dim-jh-modelBenefitOnly')).toBeLessThan(order.indexOf('dim-jh-modelId'))
  })
})
