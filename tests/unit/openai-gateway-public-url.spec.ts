import { describe, expect, it } from 'vitest'
import { gatewayPublicUrl } from '../../src/openai-gateway/config.js'
import {
  gatewayButtonTitle,
  gatewayEndpoint,
  gatewayEffortsCurl,
  gatewayModelsCurl,
  gatewayPublicEndpoint,
  gatewayStatusLines,
} from '../../plugin-src/client/openai-gateway-panel.js'

const LISTEN_WILDCARD = {
  enabled: true,
  running: true,
  blockedByEnv: false,
  address: { host: '0.0.0.0', port: 8326 },
}

describe('gatewayPublicUrl（宿主侧读取 env）', () => {
  it('未设置 / 空白 ⇒ null（老行为）', () => {
    expect(gatewayPublicUrl({})).toBeNull()
    expect(gatewayPublicUrl({ DSH_OPENAI_GATEWAY_PUBLIC_URL: '' })).toBeNull()
    expect(gatewayPublicUrl({ DSH_OPENAI_GATEWAY_PUBLIC_URL: '   ' })).toBeNull()
  })

  it('合法地址原样返回，只去掉首尾空白与末尾斜杠', () => {
    expect(gatewayPublicUrl({ DSH_OPENAI_GATEWAY_PUBLIC_URL: ' http://192.168.1.10:8080/v1/ ' }))
      .toBe('http://192.168.1.10:8080/v1')
    expect(gatewayPublicUrl({ DSH_OPENAI_GATEWAY_PUBLIC_URL: 'https://api.example.com/v1' }))
      .toBe('https://api.example.com/v1')
    expect(gatewayPublicUrl({ DSH_OPENAI_GATEWAY_PUBLIC_URL: 'https://example.com/gw' }))
      .toBe('https://example.com/gw')
  })

  it('非法值抛错（由 RPC 层按字段降级并记 warn）', () => {
    for (const bad of [
      'not a url',
      'ftp://example.com/v1',
      'https://user:pass@example.com/v1',
      'https://example.com/v1?key=sk-xxx',
      'https://example.com/v1#frag',
    ]) {
      expect(() => gatewayPublicUrl({ DSH_OPENAI_GATEWAY_PUBLIC_URL: bad }), bad).toThrow(/DSH_OPENAI_GATEWAY_PUBLIC_URL/)
    }
  })
})

describe('面板优先使用对外地址', () => {
  it('未配置时与改动前完全一致', () => {
    expect(gatewayPublicEndpoint(LISTEN_WILDCARD)).toBe('')
    expect(gatewayEndpoint(LISTEN_WILDCARD)).toBe('http://0.0.0.0:8326/v1')
    expect(gatewayStatusLines(LISTEN_WILDCARD).join('\n')).toContain('0.0.0.0 换成本机的局域网 IP')
    expect(gatewayEndpoint({ ...LISTEN_WILDCARD, publicUrl: null })).toBe('http://0.0.0.0:8326/v1')
  })

  it('配置后：地址、按钮提示、curl 示例全部改用对外地址，且不再提示替换 0.0.0.0', () => {
    const status = { ...LISTEN_WILDCARD, publicUrl: 'http://192.168.1.10:8080/v1' }
    expect(gatewayEndpoint(status)).toBe('http://192.168.1.10:8080/v1')
    expect(gatewayButtonTitle(status)).toContain('http://192.168.1.10:8080/v1')
    const lines = gatewayStatusLines(status).join('\n')
    expect(lines).toContain('API 请求地址：http://192.168.1.10:8080/v1')
    expect(lines).not.toContain('0.0.0.0 换成本机的局域网 IP')
    expect(gatewayModelsCurl(gatewayEndpoint(status))).toContain('http://192.168.1.10:8080/v1/models')
    expect(gatewayEffortsCurl(gatewayEndpoint(status))).toContain('http://192.168.1.10:8080')
  })

  it('空白字符串视为未配置（不显示一个空地址）', () => {
    expect(gatewayEndpoint({ ...LISTEN_WILDCARD, publicUrl: '  ' })).toBe('http://0.0.0.0:8326/v1')
  })

  it('网关未监听时不给地址（与「地址只在真监听时给出」同一口径）', () => {
    const down = { enabled: true, running: false, blockedByEnv: false, address: null, publicUrl: 'https://api.example.com/v1' }
    expect(gatewayEndpoint(down)).toBe('')
  })
})
