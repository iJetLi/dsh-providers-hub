/**
 * MonkeyCode / 百智云 **客户端接线**守卫（源码级）。
 *
 * ## 为什么需要（2026-11-02 二审 D 报告 🟡7 末条）
 *
 * 「改 Key」按钮、`editing` 判据、失败路径的弹窗字段、百智云会话闸门、
 * 补登录态后拉积分 —— 这五处本轮改动的**承重件**，在 tests 里此前只出现在
 * 一句注释里；把接线删掉、把判据改坏，43 + 48 + 33 条既有用例**全绿**。
 *
 * ## ⚠️ 三审 E 的教训（写在这里防复发）
 *
 * 本文件第一版用 `slice(startMarker, endMarker)`，而 `slice` 内部是
 * `indexOf(startMarker)` —— **取第一次出现**。结果两条「★★」用例守的其实是
 * `submitBaizhiKey` 的 catch（同文本在 `jet-hub.js` 里出现 3 次），把目标函数
 * `submitOpencodeEntry` 的兜底改回错误写法，用例**照样绿**。
 *
 * ⇒ 现在 `slice()` **强制要求起点标记唯一**（`countOccurrences(...) === 1`），
 *    不唯一就直接失败。并列断言一律用计数。
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const clientSource = readFileSync(
  new URL('../../plugin-src/client/jet-hub.js', import.meta.url),
  'utf8',
)

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

/** 读另一个客户端源文件（弹窗组件不是 `jet-hub.js` 的一部分）。 */
function sliceTab(relativePath: string): string {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8')
}

/**
 * 取一段源码切片。
 *
 * ⚠️ `startMarker` 必须**唯一**：`indexOf` 取的是第一次出现，若起点在别处也命中，
 * 切片会静默漂移到**另一个函数**上，断言看起来还全绿（三审 E 实测过）。
 */
function slice(startMarker: string, endMarker: string): string {
  const hits = countOccurrences(clientSource, startMarker)
  expect(hits, `切片起点必须唯一，实际命中 ${hits} 处：${startMarker}`).toBe(1)
  const start = clientSource.indexOf(startMarker)
  const end = clientSource.indexOf(endMarker, start)
  expect(end, `找不到切片终点：${endMarker}`).toBeGreaterThan(start)
  return clientSource.slice(start, end)
}

describe('失败路径不得造出「没有 provider」的弹窗对象（D 🔴1 + E 🔴2）', () => {
  const entryBody = slice('const submitOpencodeEntry = async (', '  const submitMagicrewLocalImport = async (')

  it('★★ 函数签名不再有 provider 形参（那两条防线成立后它零使用）', () => {
    expect(entryBody).toMatch(/const submitOpencodeEntry = async \(method, payload\) =>/)
  })

  it('★★ catch 只在弹窗还活着时写回，绝不凭空造对象', () => {
    expect(entryBody).toContain('setKeyModal((prev) => prev ? { ...prev, error: message } : prev)')
    // 反向：两种「造对象」写法都不许回来 —— 裸 `{ error }`（无 provider）
    // 与 `{ provider, error }`（凭空重开一个用户已经关掉的窗）。
    expect(entryBody, '不能造裸对象').not.toMatch(/setKeyModal\(\{\s*error/)
    expect(entryBody, '不能凭空重开弹窗').not.toMatch(/setKeyModal\(\{\s*provider,\s*error/)
  })

  it('★★ 弹窗已被用户关掉时，错误落到顶部提示条（用户关掉的窗不许再冒出来）', () => {
    expect(entryBody).toContain('if (keyModalRef.current === null)')
    expect(entryBody).toContain("setProbeNotice({ tone: 'error', text: message, details: [] })")
  })
})

describe('弹窗渲染是白名单，不是排除名单（E 🔴2 的结构性修法）', () => {
  it('★★ 通用分支必须显式要求 provider === \'opencode\'', () => {
    expect(clientSource).toContain("keyModal && keyModal.provider === 'opencode'")
  })

  it('★★ 排除名单写法不能再回来（任何缺 provider 的对象都会落进 opencode）', () => {
    expect(clientSource).not.toContain("keyModal.provider !== 'modelscope'")
    expect(clientSource).not.toContain("!MONKEYCODE_PROVIDER_IDS.includes(keyModal.provider)")
  })

  it('★ 每家专属弹窗各自按 provider 精确分派', () => {
    for (const id of ['modelscope', 'qiniu', 'baizhi']) {
      expect(countOccurrences(clientSource, `keyModal && keyModal.provider === '${id}'`)).toBe(1)
    }
    expect(countOccurrences(clientSource, "keyModal && MONKEYCODE_PROVIDER_IDS.includes(keyModal.provider)")).toBe(1)
  })
})

describe('弹窗编辑态判据（D 🟡2）', () => {
  it('★★ 两个弹窗都由 accountId 派生 editing（mask 可能为空，不能拿它判态）', () => {
    expect(countOccurrences(clientSource, 'editing: Boolean(keyModal.accountId)')).toBe(2)
  })

  it('★ 两个弹窗都要拿到 currentMasked（显示「当前 Key：…」）', () => {
    expect(countOccurrences(clientSource, 'currentMasked: keyModal.currentMasked || ')).toBe(2)
  })
})

describe('只补会话 cookie 的分流（D 🟡3 + E 🟡5）', () => {
  const body = slice('const submitMonkeycodeKey = async (', '  const submitMagicrewLocalImport = async (')

  it('★★ API Key 为空且编辑态且有 cookie ⇒ 走 setSession，而不是直接 return', () => {
    expect(body).toContain('`${provider}.setSession`')
    expect(body).toContain('{ accountId: editAccountId, sessionCookie }')
  })

  it('★★ setSession 成功后必须真拉积分（否则提示说「积分可用了」而积分行停在旧值）', () => {
    const branch = body.slice(body.indexOf('${provider}.setSession'), body.indexOf("'已写入会话 cookie"))
    expect(branch).toContain('await loadCredits(true);')
  })

  it('★ 空 Key 的空 cookie 情形仍然只 return（保持「什么都不做就别报错」）', () => {
    expect(body).toMatch(/if \(editAccountId !== '' && sessionCookie !== ''\) \{/)
  })
})

describe('百智云会话闸门用 Set（D 🟡5 + E 🟡4）', () => {
  it('★★ 闸门必须是 Set，不能是单槽位字符串', () => {
    const decl = slice('const baizhiSessionRef = React.useRef(', '  const ')
    expect(decl).toContain('new Set()')
    expect(decl).not.toContain('(null)')
  })

  it('★★ 进入/退出分别 has+add / delete，且 delete 必须在 finally 里', () => {
    const gate = slice('const inFlight = baizhiSessionRef.current;', '  };')
    expect(gate).toContain('if (inFlight.has(accountId)) return;')
    expect(gate).toContain('inFlight.add(accountId);')
    expect(gate).toContain('inFlight.delete(accountId);')
    /**
     * ⚠️ 只断言「delete 文本存在」是**无牙**的：把 delete 挪到 try 之后（只覆盖
     * 成功路径），`baizhi.startSession` 抛错时该账号会**永远点不动**（Set 留残值，
     * `has` 恒真），而用例照样绿。所以必须验证它落在 `finally` 里。
     */
    const tryAt = gate.indexOf('try {')
    const finallyAt = gate.indexOf('} finally {')
    const deleteAt = gate.indexOf('inFlight.delete(accountId);')
    expect(tryAt, '闸门里必须有 try').toBeGreaterThanOrEqual(0)
    expect(finallyAt, '闸门里必须有 finally').toBeGreaterThan(tryAt)
    expect(deleteAt, 'delete 必须在 finally 之后（否则异常路径泄漏）').toBeGreaterThan(finallyAt)
  })
})

describe('补登录态成功后真的拉积分（D 🟡6）', () => {
  it('★★ 命中 baizhiHasSession 后必须 loadCredits(true)（否则积分行停在旧值）', () => {
    const hit = slice('if (hit && hit.baizhiHasSession === true) {', 'return;\n      }')
    expect(hit).toContain('await loadCredits(true);')
  })
})

describe('「改 Key」按钮接线（D 🟡7 末条）', () => {
  it('★★ AccountCard 必须解构两个 onEdit*（上一轮传了却没解构 ⇒ 按钮根本没渲染）', () => {
    const head = slice('function AccountCard({', '}) {')
    expect(head).toContain('onEditMonkeycodeKey')
    expect(head).toContain('onEditBaizhiKey')
  })

  it('★★ 两个按钮各有 onClick 且只在 props 存在时挂（别家不受影响）', () => {
    /**
     * ⚠️ 用 `String.fromCharCode(10)` 拼换行，**不要**在字符串里直接写 `\n`
     * （源码里 `? React.createElement` 是换行写的 —— 字面量匹配会恒为 0，
     * 那是「断言看起来严格但其实失效」）。
     */
    const NL = String.fromCharCode(10)
    expect(countOccurrences(clientSource, 'onEditMonkeycodeKey ? React.createElement(')).toBe(1)
    expect(countOccurrences(clientSource, 'onEditBaizhiKey ? React.createElement(')).toBe(1)
    expect(clientSource).toContain('onClick: () => onEditMonkeycodeKey(account.id, account.monkeycodeKeyMask')
    expect(clientSource).toContain('onClick: () => onEditBaizhiKey(account.id, account.baizhiKeyMask')
  })

  it('★ 调用点必须带上 accountId（否则弹窗会退回新建模式）', () => {
    expect(clientSource).toContain('onEditMonkeycodeKey: (id, masked) => setKeyModal(')
    expect(clientSource).toContain('onEditBaizhiKey: (id, masked) => setKeyModal(')
  })
})

describe('输入即清宿主错误（三审 E 🟢-15）', () => {
  it('★★ 两个弹窗都要拿到 onDismissError，且父组件只清 error、其余字段保留', () => {
    expect(countOccurrences(clientSource, 'onDismissError: () => setKeyModal((prev) => prev ? { ...prev, error:')).toBe(2)
  })

  it('★ 两个弹窗都必须真的在输入时调用它（否则红字会一直挂到下次提交）', () => {
    const mono = sliceTab('plugin-src/client/monkeycode-key-modal.js')
    expect(mono).toContain("if (error && onDismissError) onDismissError()")
    const bz = sliceTab('plugin-src/client/baizhi-key-modal.js')
    expect(bz).toContain("if (error && onDismissError) onDismissError()")
  })
})

describe('异步失败不得凭空重开弹窗（三审自查）', () => {
  it('★★ 必须有 keyModal 的当前值镜像（闭包里的 keyModal 是发起请求时的旧值）', () => {
    expect(clientSource).toContain('const keyModalRef = React.useRef(null);')
    expect(clientSource).toContain('keyModalRef.current = keyModal;')
  })
})

describe('编辑态「只改 signing_secret」必须明确拒绝（三审自查）', () => {
  const body = slice('const submitMonkeycodeKey = async (', '  const submitMagicrewLocalImport = async (')

  it('★★ 账号 id 由 API Key 派生 ⇒ 没 Key 就定位不到凭据，不能静默丢掉 secret', () => {
    expect(body).toContain('改 signing_secret 必须同时重填 API Key')
    expect(body).toMatch(/if \(editAccountId !== '' && signingSecret !== ''\) \{/)
  })

  it('★ 三处取值都先 trim（全空格不能被当成「填了」）', () => {
    expect(body).toMatch(/const apiKey = String\(value && value\.apiKey \? value\.apiKey : ''\)\.trim\(\);/)
    expect(body).toMatch(/const sessionCookie = String\(value && value\.sessionCookie \? value\.sessionCookie : ''\)\.trim\(\);/)
    expect(body).toMatch(/const signingSecret = String\(value && value\.signingSecret \? value\.signingSecret : ''\)\.trim\(\);/)
  })
})
