/**
 * ★★ **`TM.00000001` 的文案必须带上游 `x-request-id`**（2026-11-28，Gitee IKYLQ2 ①）。
 *
 * ## 缺口原文
 *
 * 文案写着「把本句与 error_code（含 logid）一起反馈」，但抛错处只带 `{ status }`，
 * 全文件 `grep x-request-id` **零处** ⇒ 用户**永远拿不到** logid
 * ⇒ 那条诉求**无法被满足**（本仓纪律「文案本身就是出路」的反面）。
 *
 * 上游**确实下发**该头（报障者三条真机探针都有，形如 `6a6fe69b68e79c80f382711fbfb344fb`）。
 *
 * ⚠️ 这条守卫必须**走真实 HTTP 响应头**，不能只测 `codeartsGatewayBusyMessage(model, 'x')`
 * —— 那样测不到「调用处有没有把 header 传进去」，而缺口恰恰在调用处。
 */
import { describe, expect, it } from 'vitest'
import { codeartsGatewayBusyMessage } from '../../src/llm-adapter.js'

describe('★★ codeartsGatewayBusyMessage：logid 与措辞（IKYLQ2）', () => {
  it('★★★ 传了 requestId ⇒ 文案里必须出现它', () => {
    const msg = codeartsGatewayBusyMessage('glm-5.3', '6a6fe69b68e79c80f382711fbfb344fb')
    expect(msg).toContain('6a6fe69b68e79c80f382711fbfb344fb')
    expect(msg).toContain('request-id')
  })

  it('★★ 没传 requestId（上游未下发）⇒ 不得出现空的「request-id：」尾巴', () => {
    const msg = codeartsGatewayBusyMessage('glm-5.3')
    expect(msg).not.toContain('request-id：')
    expect(msg).not.toContain('undefined')
  })

  it('★★ 空串与 undefined 等价（不得渲染出空白 logid）', () => {
    const a = codeartsGatewayBusyMessage('glm-5.3', '')
    expect(a).not.toContain('request-id：')
    expect(a).not.toContain('undefined')
  })

  it('★★★ 措辞：必须并列「瞬时抖动 / 可手动重试」这一种可能（不得只说是策略变更）', () => {
    const msg = codeartsGatewayBusyMessage('glm-5.3', 'rid-1')
    expect(msg).toContain('网关瞬时抖动')
    expect(msg).toContain('可手动重试一次')
    expect(msg, '★ 不得用确定口吻否定重试').not.toContain('重试也无效')
  })
})
