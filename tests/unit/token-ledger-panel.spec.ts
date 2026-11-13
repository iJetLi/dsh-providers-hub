import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  accountLabel,
  avgPerfText,
  avgPerfTooltip,
  buildAccountNameMap,
  channelCardTitle,
  channelLabel,
  channelOrder,
  entryTokenText,
  formatDuration,
  formatEntryTime,
  formatTps,
  formatTtft,
  formatTokenCount,
  filterChannelsBySelection,
  hasAnyData,
  historyHeatmapCells,
  historyTitle,
  HISTORY_RANGES,
  ledgerSubtitle,
  ledgerEntryModelText,
  rangeDaysOf,
  tokenSummaryText,
  todayDayKey,
} from '../../plugin-src/client/token-ledger-panel.js'

/** 源码契约测试用：定位仓库根下的 src/ 与 plugin-src/。 */
const here = dirname(fileURLToPath(import.meta.url))
/**
 * 面板源码全文（**模块级**：多个 describe 都要读它 —— 放进单个 describe 里
 * 会让后面的用例拿到 undefined 却不报错，只在 `client.slice` 处才炸）。
 */
const client = readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')

describe('formatTokenCount', () => {
  it('千分位：<10K 精确显示', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(999)).toBe('999')
    expect(formatTokenCount(1234)).toBe('1,234')
    expect(formatTokenCount(9999)).toBe('9,999')
  })

  it('K / M 单位：大数紧凑，去尾随 0', () => {
    expect(formatTokenCount(10_000)).toBe('10K')
    expect(formatTokenCount(12_345)).toBe('12.35K')
    expect(formatTokenCount(1_000_000)).toBe('1M')
    expect(formatTokenCount(94_540_000)).toBe('94.54M')
  })

  it('垃圾值按 0 处理（负数/NaN/非数）', () => {
    expect(formatTokenCount(-5)).toBe('0')
    expect(formatTokenCount(Number.NaN)).toBe('0')
    expect(formatTokenCount(undefined as never)).toBe('0')
  })
})

describe('tokenSummaryText / entryTokenText', () => {
  it('汇总：默认只显示总处理量，拆分放在悬浮详情', () => {
    expect(tokenSummaryText({ inputTokens: 1200, outputTokens: 340 })).toBe('总处理 1,540')
    expect(tokenSummaryText({ inputTokens: 1200, outputTokens: 340, cacheReadTokens: 800, reasoningTokens: 56 }))
      .toBe('总处理 2,340')
    expect(tokenSummaryText({ inputTokens: 1200, outputTokens: 340, cacheWriteTokens: 9 }))
      .toBe('总处理 1,540')
    // 0 值段省略（不渲染恒 0 的装饰数字）
    expect(tokenSummaryText({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, reasoningTokens: 0 }))
      .toBe('总处理 3')
  })

  it('明细行：未收到 usage 显示 —，与「用了 0」严格区分', () => {
    expect(entryTokenText({ usageReported: false, inputTokens: 0, outputTokens: 0 })).toBe('—')
    expect(entryTokenText({ usageReported: true, inputTokens: 0, outputTokens: 0 })).toBe('总处理 0')
    expect(entryTokenText(null)).toBe('—')
    expect(entryTokenText(undefined)).toBe('—')
  })
})

describe('formatDuration / formatEntryTime', () => {
  it('耗时：0/负数 → —，<1s 毫秒，≥1s 一位小数', () => {
    expect(formatDuration(0)).toBe('—')
    expect(formatDuration(-1)).toBe('—')
    expect(formatDuration(320)).toBe('320ms')
    expect(formatDuration(4200)).toBe('4.2s')
  })

  it('时间：HH:MM:SS；垃圾时间戳 → —', () => {
    const d = new Date(2026, 9, 5, 8, 7, 9)
    expect(formatEntryTime(d.getTime())).toBe('08:07:09')
    expect(formatEntryTime(Number.NaN)).toBe('—')
  })
})

describe('渠道维度', () => {
  it('channelLabel / channelOrder：直连在前', () => {
    expect(channelLabel('direct')).toBe('直连')
    expect(channelLabel('gateway')).toBe('网关')
    expect(channelOrder('direct', 'gateway')).toBeLessThan(0)
    expect(channelOrder('gateway', 'direct')).toBeGreaterThan(0)
    expect(channelOrder('direct', 'direct')).toBe(0)
  })

  it('channelCardTitle：渠道名 + 请求数', () => {
    expect(channelCardTitle({ channel: 'gateway', totals: { requests: 7 } })).toBe('网关 · 7 次请求')
    expect(channelCardTitle(null)).toBe('直连 · 0 次请求')
  })

  it('filterChannelsBySelection：null = 全部；否则按渠道', () => {
    const channels = [
      { channel: 'direct', totals: { requests: 1 } },
      { channel: 'gateway', totals: { requests: 2 } },
    ]
    expect(filterChannelsBySelection(channels, null)).toHaveLength(2)
    expect(filterChannelsBySelection(channels, 'gateway')[0]!.channel).toBe('gateway')
    expect(filterChannelsBySelection(channels, 'direct')[0]!.channel).toBe('direct')
    expect(filterChannelsBySelection(undefined, null)).toEqual([])
  })
})

describe('空状态', () => {
  it('hasAnyData：有明细才 true；ledgerSubtitle 说明明细与存盘的差别', () => {
    expect(hasAnyData({ entries: [{ ts: 1 }] })).toBe(true)
    expect(hasAnyData({ entries: [] })).toBe(false)
    expect(hasAnyData(null)).toBe(false)
    const subtitle = ledgerSubtitle()
    // 第 2 期：明细重启清空，但日累计已落盘 —— 两者都要说清。
    expect(subtitle).toContain('重启')
    expect(subtitle).toContain('存盘')
  })
})

describe('账号维度（第 2 期）', () => {
  it('accountLabel：空串给「未归属」，其余原样', () => {
    expect(accountLabel('')).toBe('未归属')
    expect(accountLabel(undefined)).toBe('未归属')
    expect(accountLabel('qoder-bb211a53')).toBe('qoder-bb211a53')
  })
})

/**
 * 账号显示名（第 5 期，2026-11-10）：`nickname` → `accountName` → 内部 id。
 *
 * ⚠️ 第二参**必须可选**：不传时行为与加参数前逐字节相同（上面那条
 * `accountLabel('qoder-bb211a53')` 就是这条契约的守卫，不许为迁就新代码改它）。
 */
describe('账号显示名 · nameMap 优先级与回落', () => {
  it('nameMap 命中 ⇒ 用映射里的名字（昵称）', () => {
    const names = new Map([['qodercn-c5a414d5', 'M籾 959']])
    expect(accountLabel('qodercn-c5a414d5', names)).toBe('M籾 959')
  })

  it('nameMap 未命中 ⇒ 回落 id（账号删了但账本还有历史，这是对的）', () => {
    const names = new Map([['other-account', '别的号']])
    expect(accountLabel('qoder-bb211a53', names)).toBe('qoder-bb211a53')
  })

  it('nameMap 为 undefined ⇒ 回落 id（向后兼容：旧调用点不传第二参）', () => {
    expect(accountLabel('qoder-bb211a53', undefined)).toBe('qoder-bb211a53')
  })

  it('nameMap 里的值是空串 ⇒ 回落 id（不许渲染成空白账号行）', () => {
    expect(accountLabel('qoder-bb211a53', new Map([['qoder-bb211a53', '']]))).toBe('qoder-bb211a53')
    // 非字符串（脏数据）同样回落。
    expect(accountLabel('qoder-bb211a53', new Map([['qoder-bb211a53', 42 as unknown as string]])))
      .toBe('qoder-bb211a53')
  })

  it('★★ nameMap 里的值是**纯空格** ⇒ 同样回落 id（判据必须是 trim 之后非空）', () => {
    // 2026-11-13 PR #69 对抗审计 P2 / B-1 实测：只判 `length > 0` 时，
    // `'   '` 的 length 是 3 ⇒ 原样采纳 ⇒ 界面上出现一行**纯空白**的账号名，
    // 比显示裸池 id 更让人困惑（「这一行是谁」无从判断）。
    // 而本函数上方的注释恰恰写着「空串也不能用」—— 注释对，实现只挡了空串。
    expect(accountLabel('qoder-bb211a53', new Map([['qoder-bb211a53', '   ']])))
      .toBe('qoder-bb211a53')
    expect(accountLabel('qoder-bb211a53', new Map([['qoder-bb211a53', '\t\n ']])))
      .toBe('qoder-bb211a53')
    // 反向对照：首尾带空格的**真实**名字必须原样保留（trim 只用于判空，不改值）
    expect(accountLabel('qoder-bb211a53', new Map([['qoder-bb211a53', ' 清 ']])))
      .toBe(' 清 ')
  })

  it('accountId 为空串 ⇒ 「未归属」，nameMap 不参与（空 key 不是账号）', () => {
    expect(accountLabel('', new Map([['', '不该被读到']]))).toBe('未归属')
    expect(accountLabel(undefined, new Map())).toBe('未归属')
  })

  it('nameMap 传普通对象（非 Map）也能工作', () => {
    expect(accountLabel('qoder-bb211a53', { 'qoder-bb211a53': '超级清' })).toBe('超级清')
    expect(accountLabel('qoder-bb211a53', {})).toBe('qoder-bb211a53')
  })

  it('★ buildAccountNameMap：nickname 优先于 accountName，都没有则不进映射', () => {
    const map = buildAccountNameMap([
      { id: 'a', nickname: '用户备注', accountName: 'upstream-name' },
      { id: 'b', nickname: '', accountName: 'mylzscy4' },
      { id: 'c', nickname: '', accountName: '' },
      { id: 'd' },
      { id: '', nickname: '没有 id' },
      null,
      undefined,
      'not-an-object',
      42,
    ])
    expect(map.get('a')).toBe('用户备注')
    // nickname 空串**不是**名字 ⇒ 用 accountName（真实姓名）
    expect(map.get('b')).toBe('mylzscy4')
    // 两者都没有 ⇒ 不进映射（让 accountLabel 回落 id，而不是渲染空白）
    expect(map.has('c')).toBe(false)
    expect(map.has('d')).toBe(false)
    expect(map.has('')).toBe(false)
    expect(map.size).toBe(2)
  })

  it('★★ buildAccountNameMap：**纯空格**昵称必须让位给 accountName（不许盖掉上游真名）', () => {
    // 2026-11-13 PR #69 对抗审计 P2 / B-1：`nickname` 是用户手填的，
    // 一个手滑的空格也是合法输入；只判 `length > 0` 会让这行空白**盖掉**
    // `accountName`（宿主从凭据里读出的上游真实用户名）⇒ 账号列变成一片空白。
    const map = buildAccountNameMap([
      { id: 'a', nickname: '   ', accountName: 'upstream-name' },
      { id: 'b', nickname: '\t\n ', accountName: 'mylzscy4' },
      { id: 'c', nickname: '   ', accountName: '   ' },
    ])
    expect(map.get('a')).toBe('upstream-name')
    expect(map.get('b')).toBe('mylzscy4')
    // 两者都是空白 ⇒ 不进映射（让 accountLabel 回落 id）
    expect(map.has('c')).toBe(false)
    expect(map.size).toBe(2)
  })

  it('buildAccountNameMap：非数组输入给空 Map（不抛）', () => {
    expect(buildAccountNameMap(undefined).size).toBe(0)
    expect(buildAccountNameMap(null).size).toBe(0)
    expect(buildAccountNameMap({} as unknown as unknown[]).size).toBe(0)
  })
})

/**
 * ⚠️ 均值口径必须**显式说明**（真实缺陷，用户 2026-10-07 报障「982.5 tok/s」）。
 *
 * 症状：lobsterai 的速率显示 982.5 tok/s，远超该模型的合理区间。根因是
 * `decodeMs` 塌缩到个位数毫秒（服务端已修），但**均值口径**本身仍需交代：
 * 算术平均对离群样本敏感，不给口径用户无从判断某天的高值是真快还是被拉高。
 */
describe('均值口径说明', () => {
  it('avgPerfTooltip 说明了解码时长门槛与「均值对离群样本敏感」', () => {
    const tip = avgPerfTooltip()
    // 门槛数值必须写出来（用户要能核对服务端判据）。
    expect(tip).toContain('100ms')
    // 「算术平均」与「敏感」两句都在：缺任一句都无法解释异常值。
    expect(tip).toContain('算术')
    expect(tip).toContain('敏感')
    // 口径要指明分子分母，不能只说「速率」。
    expect(tip).toContain('输出 token')
    expect(tip).toContain('首块')
  })

  it('★ 全部均值格必须挂口径 tooltip（7 处调用点不得漏）', () => {
    // 收敛到 perfCell 一个 helper：逐个调用点各写一份 title 时必然会漏。
    expect(client).toMatch(/const perfCell = \(row\) =>/s)
    expect(client).toMatch(/className: 'dim-jh-ledgerPerf',\s*title: avgPerfDetailTooltip\(row\)/)
    // 不得再有裸的 avgPerfText 调用（那是没有 tooltip 的漏网渲染）。
    const rawCalls = client.match(/className: 'dim-jh-ledgerPerf' \}, avgPerfText\(/g) ?? []
    expect(rawCalls).toEqual([])
    // 7 个均值渲染点全部经由 perfCell（明细模型行 + 汇总 4 处 + 历史日树 3 处）。
    expect((client.match(/perfCell\(/g) ?? []).length).toBe(7)
    // ⚠️ 余下那处 ledgerPerf 是历史区的「合计」格（无均值、无需口径说明）——
    // 刻意不要求它挂 tooltip，故不能断言 ledgerPerf 全文只出现一次。
    expect(client).toContain('总处理 ')
  })

  it('弹窗提示用户可悬停查看完整口径', () => {
    // ⚠️ 判据必须锚在「Token 用量」那处弹窗：全文件有 13 处 modalHint
    // （多个弹窗复用），按位置切片会切到别的弹窗上去。
    const modalIdx = client.indexOf("'aria-label': 'Token 用量'")
    expect(modalIdx).toBeGreaterThan(-1)
    const hint = client.slice(modalIdx, client.indexOf('dim-jh-modalBody', modalIdx))
    expect(hint).toContain('悬停数字查看 Token 拆分与性能口径')
  })

  it('弹窗说明 tooltip 必须作为 props 传入，不能作为 React 子节点', () => {
    const modalIdx = client.indexOf("'aria-label': 'Token 用量'")
    const modal = client.slice(modalIdx, client.indexOf('dim-jh-modalBody', modalIdx))
    // React 不允许把普通对象渲染为子节点；放错 createElement 参数会令整个页面崩溃。
    expect(modal).toMatch(/React\.createElement\('p',\s*\{\s*className: 'dim-jh-modalHint',\s*title:/)
  })
})

describe('首字用时与速率（第 3 期）', () => {
  it('formatTtft：缺失/0 → —；有值按耗时格式化', () => {
    expect(formatTtft(undefined)).toBe('—')
    expect(formatTtft({})).toBe('—')
    expect(formatTtft({ ttftMs: 0 })).toBe('—')
    expect(formatTtft({ ttftMs: 850 })).toBe('850ms')
    expect(formatTtft({ ttftMs: 2900 })).toBe('2.9s')
  })

  it('formatTps：缺失/非正 → —；有值带单位', () => {
    expect(formatTps(undefined)).toBe('—')
    expect(formatTps({ tps: 0 })).toBe('—')
    expect(formatTps({ tps: 52.3 })).toBe('52.3 tok/s')
    expect(formatTps({ tps: 100 })).toBe('100 tok/s')
  })

  it('avgPerfText：两边都无 → —；单边有值时另一边占位', () => {
    expect(avgPerfText(undefined)).toBe('—')
    expect(avgPerfText({})).toBe('—')
    expect(avgPerfText({ avgTtftMs: 850 })).toBe('首字 850ms')
    expect(avgPerfText({ avgTps: 48.2 })).toBe('均值 48.2 tok/s')
    expect(avgPerfText({ avgTtftMs: 1200, avgTps: 51.5 })).toBe('首字 1.2s · 均值 51.5 tok/s')
  })
})

describe('历史视图（第 4 期）', () => {
  it('HISTORY_RANGES / rangeDaysOf：窗口 key → 天数；未知 key 回退全部(0)', () => {
    expect(HISTORY_RANGES.map((r) => r.key)).toEqual(['today', '7d', '30d', 'all'])
    expect(rangeDaysOf('today')).toBe(1)
    expect(rangeDaysOf('7d')).toBe(7)
    expect(rangeDaysOf('30d')).toBe(30)
    expect(rangeDaysOf('all')).toBe(0)
    expect(rangeDaysOf('bogus')).toBe(0)
  })

  it('todayDayKey：与服务端 utc8DayKey 同形（YYYY-MM-DD）', () => {
    expect(todayDayKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('historyHeatmapCells：补齐缺失日期、按用量分档并标记真实今天', () => {
    const history = [
      { day: '2026-10-07', totals: { requests: 1, inputTokens: 25, outputTokens: 25 } },
      { day: '2026-10-09', totals: { requests: 3, inputTokens: 100 } },
    ]
    const cells = historyHeatmapCells(history, 5, '2026-10-09')
    expect(cells.map((cell) => cell.day)).toEqual([
      '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09',
    ])
    expect(cells.map((cell) => cell.tokens)).toEqual([0, 0, 50, 0, 100])
    expect(cells.map((cell) => cell.level)).toEqual([0, 0, 2, 0, 4])
    expect(historyHeatmapCells(undefined, 1, todayDayKey())[0]?.isToday).toBe(true)
    expect(historyHeatmapCells(undefined, 5, '2026-01-05').every((cell) => !cell.isToday)).toBe(true)
  })

  it('historyTitle：窗口 key → 标题；未知回退「全部」', () => {
    expect(historyTitle('7d')).toBe('历史用量 · 近 7 天')
    expect(historyTitle('bogus')).toBe('历史用量 · 全部')
  })
})

/**
 * ⚠️ 历史视图的**响应体字段名契约**（真实缺陷的闸门）。
 *
 * 症状（用户 2026-10-07 报障）：过了 00:00 打开「Token 用量」，「今日」窗口
 * 右侧合计显示「284 次请求」，主体却显示「还没有历史用量」。数据在响应里，
 * 柱子却是空的 —— 空状态文案还反过来说「今天发起的请求明天就能在这里看到」。
 *
 * 根因：RPC 响应体的天数数组在 `history` 键（与 `totals` 平级，见
 * `RpcUsageTokenLedgerHistoryResponse`），客户端读的是 `history?.days` ⇒ 恒
 * undefined ⇒ `historyDays` 恒为 `[]`。`totals` 读对了，所以合计照常显示 ——
 * **两者一好一坏正是这个 bug 的指纹**。
 *
 * 为什么两侧单测都拦不住：`token-ledger.spec.ts` 只测服务端函数返回
 * `{ days, totals }`（服务端内部形状，对 RPC 字段名无约束），
 * `token-ledger-panel.spec.ts` 只测纯函数热力图数据（喂数组，不碰响应体）。
 * 跨进程的那一层**两侧都够不着** —— 只能断言源码字面量。
 *
 * 判据用**字段名的存在性**（`history.history` / `history.days`）而非整段字面量：
 * 改格式、换引号、加注释都不该假失败，但字段名改错必须变红。
 */
describe('历史视图 · RPC 响应体字段名契约', () => {
  it('客户端读的是 `history.history`（RPC 的真实字段名），不是 `history.days`', () => {
    expect(client).toMatch(/Array\.isArray\(history\?\.history\)/)
    // ⚠️ 旧读法必须**显式禁死**：它是本缺陷的写法，留着就会二次复发。
    expect(client).not.toMatch(/history\?\.days/)
  })

  it('服务端 RPC 构造的响应体确实带 `history` 键', () => {
    const rpc = readFileSync(resolve(here, '../../src/jet-hub-rpc.ts'), 'utf8')
    expect(rpc).toMatch(/RpcUsageTokenLedgerHistoryResponse\s*=\s*\{\s*history:/)
  })

  it('类型声明的字段名与客户端一致（`history`，非 `days`）', () => {
    const types = readFileSync(resolve(here, '../../src/types.ts'), 'utf8')
    const block = types.slice(types.indexOf('interface RpcUsageTokenLedgerHistoryResponse'))
    expect(block).toMatch(/^\s*history: TokenLedgerHistoryDay\[\]/m)
    expect(block).not.toMatch(/^\s*days:/m)
  })
})

describe('历史用量删除 · 范围隔离契约', () => {
  it('客户端二次确认后只调用单日历史删除 RPC，并在确认文案中声明保留明细与其他日期', () => {
    expect(client).toMatch(/usage\.tokenLedgerDeleteDay',\s*\{\s*day\s*\}/)
    expect(client).toMatch(/只清除这一天的日累计，不会清除实时明细、其他日期或账号设置/)
    expect(client).toMatch(/删除此日/)
  })

  it('服务端只接受有效日期键，并委托给历史账本删除入口', () => {
    const rpc = readFileSync(resolve(here, '../../src/jet-hub-rpc.ts'), 'utf8')
    expect(rpc).toMatch(/case 'usage\.tokenLedgerDeleteDay'/)
    expect(rpc).toMatch(/isValidTokenLedgerDayKey\(req\?\.day\)/)
    expect(rpc).toMatch(/deleteTokenLedgerDay\(req\.day\)/)
  })
})

/** 热力图渲染接线契约：数据分档、四行样式与用户指定的简洁布局。 */
describe('用量热力图 · 渲染接线与样式契约', () => {
  const styles = readFileSync(resolve(here, '../../plugin-src/client/jet-hub-styles.js'), 'utf8')

  it('渲染热力图数据，并将档位交给色阶样式', () => {
    expect(client).toMatch(/historyHeatmapCells\(historyDays,\s*heatmapDays,\s*heatmapEndDay\)/)
    expect(client).toMatch(/'data-level': String\(cell\.level\)/)
  })

  it('固定四行，且不渲染星期标签或少/多图例', () => {
    expect(styles).toMatch(/\.dim-jh-ledgerHeatmap\s*\{[^}]*grid-template-rows:\s*repeat\(4,/s)
    expect(client).not.toContain('dim-jh-ledgerHeatmapWeekdays')
    expect(client).not.toContain('dim-jh-ledgerHeatmapLegend')
  })

  it('用量档位提高时颜色变深并增强青色发光', () => {
    expect(styles).toMatch(/\.dim-jh-ledgerHeatmapCell\[data-level="4"\]\s*\{[^}]*background:\s*#0e7490[^}]*box-shadow:/s)
  })

  it('⚠️ 样式文件仍是合法的单段模板字符串（STYLES 内不得出现反引号）', () => {
    // 该文件用模板字符串承载 CSS：注释里写一个反引号就会提前闭合、esbuild 报错。
    // ⚠️ 只查**配对**不够（2026-10-07 两次事故的反例）：像 space-between 这样
    // 「一对反引号包一个词」在 JS 语法上完全合法、backtick 计数仍是偶数，
    // 却是 esbuild 真正报错的那一种。故再断言 STYLES 的 CSS 段里**一个反引号
    // 都没有**（整文件只允许首尾各一个）。
    const backticks = (styles.match(/`/g) ?? []).length
    expect(backticks % 2).toBe(0)
    // STYLES = ` ... ` 的内容段（首个与末个反引号之间）不得含任何反引号。
    const start = styles.indexOf('`')
    const end = styles.lastIndexOf('`')
    const css = styles.slice(start + 1, end)
    expect(css).not.toMatch(/`/)
  })
})

/**
 * 用量树的**三层视觉契约**（2026-11-11 两轮报障的终稿）。
 *
 * ## 第一轮：账号与模型区分度不足
 * 根因是两层**字号与颜色完全相同**（都 11.5px / 都 `--dsw-alias-label-secondary`），
 * 只靠 600 字重与等宽字体族区分 ⇒ 读起来是「四行平铺」。
 *
 * ## 第二轮：① 色条是白的 ② provider 被画成账号
 * - ① 我用了 `--dsw-alias-brand-primary`，而它在 DSH 深色主题下 =
 *   `--dsw-static-neutral-bluish-50` = **#f9fafb（近白）**。它是反色/对比色，
 *   不是蓝色；真正的蓝是 `--dsw-static-deepseek-450` = #5686fe。
 *   ⚠️ 写了 `#1677ff` 回退值也没用 —— **变量存在时回退值永不生效**。
 * - ② 历史日树的 provider 行错用了 `dim-jh-ledgerAccount` 类名 ⇒ 供应商被染成账号。
 *
 * ## 终稿（用户选定「方案 3 + 档位 D」）
 * provider（0px 缩进 / 淡色块 / 灰竖线 / 11.5px 粗体）
 *   → 账号（30px / 浓色块 / 蓝条 / 12px 主色）
 *   → 模型（54px / 无底色 / 11px 最暗 / ↳ 前导）
 *
 * ⚠️ 断言是**数值级**的，不是「有没有某个类名」：类名在、但字号/颜色/缩进改回
 * 相同值，正是这些缺陷复发的形态。
 */
describe('用量树三层视觉契约（provider / 账号 / 模型）', () => {
  const styles = readFileSync(resolve(here, '../../plugin-src/client/jet-hub-styles.js'), 'utf8')

  /** 取出某个选择器的**第一条**声明块（只认 `{ … }`，不做嵌套解析）。 */
  const ruleOf = (selector: string): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const m = styles.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 's'))
    return m?.[1] ?? ''
  }

  it('★ 第一层 provider：淡色块 + 灰色竖线 + 11.5px 粗体，且不缩进', () => {
    const head = ruleOf('.dim-jh-ledgerProviderHead')
    expect(head, '找不到 .dim-jh-ledgerProviderHead 规则').not.toBe('')
    // 淡色块：用**前景色小比例混色**（4%），两种主题下都可见。
    expect(head).toMatch(/background:\s*color-mix\(in srgb,\s*var\(--dsw-alias-label-primary,\s*#1f2329\)\s*4%/)
    // ⚠️⚠️ 回归守卫（2026-11-13 审计 D1/P1，本 PR 初版就是错的）：
    //    **绝不能**用 --dsw-alias-bg-layer-2 / -3 铺底色 —— 宿主那三层在**浅色主题下
    //    全是 #fff**（body{--dsw-alias-bg-layer-1/-2/-3: var(--dsw-static-neutral-bluish-00)}，
    //    而 bluish-00 = #fff），而弹窗底色就是 -layer-1 ⇒ 色块与背景**逐字节相同**，
    //    「三层视觉语言」的底色维度整条失效。深色下才有 #232324/#2c2c2e/#353638 的差异。
    //    ⇒ 这里的否定断言是那次缺陷的墓碑；顺带也守住了「别把编造的 #2a2b2f 回退值写回来」
    //    （该字面量在整个 DSH 安装里 0 命中，是初版自己编的）。
    expect(head).not.toMatch(/--dsw-alias-bg-layer-[23]/)
    // 左侧 3px 灰色竖线 = 「容器级」
    expect(head).toMatch(/border-left:\s*3px\s+solid\s+var\(--dsw-alias-border-l2/)
    // 粗体，「标题」的信号
    expect(ruleOf('.dim-jh-ledgerProviderName')).toMatch(/font-weight:\s*700/)
    // ⚠️ provider 是容器级，**不许**有左缩进（它是最外层）。
    //    判据必须同时认 `padding-left` **与四值简写** `padding: a b c d` ——
    //    只查 `padding-left` 时，写成 `padding: 4px 10px 6px 20px` 的变异**无牙**
    //    （2026-11-11 变异验证实测抓到的假守卫）。
    //    ⚠️ 但没有左缩进 ≠ 左内边距为 0：现有规则是 `padding: 4px 10px 6px`
    //    （三值 = 上 8 横 下），左边距就是那个 `10px`，是**有意的**（与卡片内缘对齐）。
    //    真正要守的是「provider 不被推得比账号更靠右」—— 见下面与账号缩进的比较。
    const providerRule = ruleOf('.dim-jh-ledgerProvider')
    expect(providerRule).not.toMatch(/padding-left:\s*[1-9]/)
    const shorthand = providerRule.match(/padding:\s*([^;]+);/)?.[1] ?? ''
    const parts = shorthand.trim().split(/\s+/).filter((p) => p.length > 0)
    // 四值简写的第 4 个是左；三值/两值时第 2 个是左；单值时全是
    const leftPad = parts.length === 4 ? parts[3] : (parts.length >= 2 ? parts[1] : parts[0])
    const providerLeft = Number.parseFloat(leftPad ?? '0') || 0
    // ⚠️ 核心不变式：provider 的**有效左偏移必须严格小于账号的**。
    //    账号有 30px 的 `margin-left` ⇒ provider 的左内边距（10px）远小于它。
    //    给 provider 加到 ≥ 20px 就会与账号齐平/超出，层级塌掉 ⇒ 这条必须红。
    //    ⚠️ 判据用「左内边距」而不是「总偏移」，因为两者是不同层级的量：
    //    账号的 30px 是 margin，provider 的 10px 是 padding，比的是**视觉左缘**。
    const accountLeft = Number.parseFloat(
      ruleOf('.dim-jh-ledgerAccount').match(/margin-left:\s*([^;]+);/)?.[1] ?? '0',
    ) || 0
    expect(providerLeft, 'provider 的左内边距必须明显小于账号缩进，否则不再是容器级')
      .toBeLessThan(accountLeft / 2)
  })

  it('★★★ 第二层账号：蓝条必须是 deepseek-450（真蓝），**绝不能**是 brand-primary', () => {
    const head = ruleOf('.dim-jh-ledgerAccountHead')
    expect(head, '找不到 .dim-jh-ledgerAccountHead 规则').not.toBe('')

    // ① 必须是真正的蓝色变量
    expect(head).toMatch(/border-left:\s*3px\s+solid\s+var\(--dsw-static-deepseek-450/)
    // ②⚠️⚠️ 回归守卫：品牌色 brand-primary 在深色主题下是 #f9fafb（近白）——
    //    用它画出来的就是一条白条（真实报障）。这条断言是那次 bug 的墓碑。
    expect(head).not.toMatch(/border-left:[^;]*--dsw-alias-brand-primary/)
    // ③ 退一步：整个账号头里都不该出现 brand-primary（它可能被挪到别处再犯）
    expect(head).not.toContain('--dsw-alias-brand-primary')
    // ④ 浓色块（层级高于 provider 的淡色块）
    //    ⚠️ 同样**不能**用 bg-layer-*：浅色主题下它是 #fff，与弹窗底色逐字节相同
    //    （2026-11-13 审计 D1/P1 —— 详见 provider 那条用例里的长注释）。
    expect(head).toMatch(/background:\s*color-mix\(in srgb,\s*var\(--dsw-alias-label-primary,\s*#1f2329\)\s*7%/)
    expect(head).not.toMatch(/--dsw-alias-bg-layer-[23]/)
    // ⑤ ⚠️ 核心不变式：账号的混色比例必须**大于** provider 的 ——
    //    「淡色块 → 浓色块」是这层设计的全部意义。两条各自写死 4%/7% 就够，
    //    但那样两个数字可以一起被改成 1%/1%（层级塌平）而两条用例**都绿**，
    //    所以这里再比一次大小关系。
    const accountPct = Number.parseInt(
      head.match(/--dsw-alias-label-primary,\s*#1f2329\)\s*(\d+)%/)?.[1] ?? '0', 10,
    )
    const providerPct = Number.parseInt(
      ruleOf('.dim-jh-ledgerProviderHead').match(/--dsw-alias-label-primary,\s*#1f2329\)\s*(\d+)%/)?.[1] ?? '0', 10,
    )
    expect(providerPct, 'provider 的混色比例必须 > 0，否则没有色块').toBeGreaterThan(0)
    expect(accountPct, '账号的色块必须比 provider 更浓，否则「淡→浓」的层级塌掉')
      .toBeGreaterThan(providerPct)
  })

  it('★★★ 三层缩进必须递增：provider 0 < 账号 30 < 模型 54（档位 D）', () => {
    const indentOf = (block: string, prop: string): number | null => {
      const m = block.match(new RegExp(`${prop}:\\s*([^;]+);`))
      if (m === null) return 0 // 没写 = 0
      const v = Number.parseFloat(m[1]!)
      return Number.isFinite(v) ? v : 0
    }
    const account = indentOf(ruleOf('.dim-jh-ledgerAccount'), 'margin-left')
    // `.dim-jh-ledgerModel` 的 padding 是四值简写，取第 4 个（左）
    const modelPad = ruleOf('.dim-jh-ledgerModel').match(/padding:\s*([^;]+);/)?.[1] ?? ''
    const model = Number.parseFloat(modelPad.split(/\s+/)[3] ?? '0')

    expect(account, '账号缩进必须是 30px（档位 D）').toBe(30)
    expect(model, '模型缩进必须是 54px（档位 D）').toBe(54)
    // ⚠️ 核心不变式：三层必须**严格递增**，否则层级又糊了
    expect(account).toBeGreaterThan(0)
    expect(model).toBeGreaterThan(account)
  })

  it('★★ 账号名与模型名不同级：字号更大 + 颜色更高一档', () => {
    const acct = ruleOf('.dim-jh-ledgerAccountName')
    const model = ruleOf('.dim-jh-ledgerModelName')
    expect(acct, '找不到 .dim-jh-ledgerAccountName 规则').not.toBe('')
    expect(model, '找不到 .dim-jh-ledgerModelName 规则').not.toBe('')

    // ① 字号：账号 12px，模型 11px（相同就是本缺陷的原形态）
    expect(acct).toMatch(/font-size:\s*12px/)
    expect(model).toMatch(/font-size:\s*11px/)

    // ② 颜色：账号 primary，模型 tertiary（相同就是本缺陷的原形态）
    expect(acct).toMatch(/color:\s*var\(--dsw-alias-label-primary/)
    expect(model).toMatch(/color:\s*var\(--dsw-alias-label-tertiary/)

    // ③ 反向对照：两段不得是同一组「字号 + 颜色」
    const sig = (block: string): string => {
      const size = block.match(/font-size:\s*([^;]+);/)?.[1]?.trim() ?? ''
      const color = block.match(/color:\s*([^;]+);/)?.[1]?.trim() ?? ''
      return `${size}|${color}`
    }
    expect(sig(acct)).not.toBe(sig(model))
  })

  it('★ 模型层有 ↳ 前导（装饰，用 ::before 而非文本节点）', () => {
    const before = styles.match(/\.dim-jh-ledgerModel::before\s*\{([^}]*)\}/s)?.[1] ?? ''
    expect(before, '缺少 .dim-jh-ledgerModel::before 规则').not.toBe('')
    expect(before).toMatch(/content:\s*"↳"/)
    // ⚠️ 必须是伪元素：塞进 children 会被 CSV 导出/复制/读屏念出来。
    expect(client).not.toMatch(/dim-jh-ledgerModelName',[^)]*'↳'/)
  })

  it('★★★ provider 与账号**必须用各自的类名**（历史日树曾把 provider 画成账号）', () => {
    // ⚠️ 真实报障：历史日树的 provider 行写的是 className: 'dim-jh-ledgerAccount'，
    //    于是 buddy / qodercn 这些供应商被套上账号的色块。判据打在**渲染出的 props** 上。
    //    这里做源码级粗筛：仓库里不存在「用 ledgerAccount 承载 provider 行」的写法。
    expect(client).not.toMatch(/key:\s*providerRow\.provider,\s*className:\s*'dim-jh-ledgerAccount'/)
    // 反向对照：provider 行确实用的是 -Provider
    const providerRows = client.match(/key:\s*providerRow\.provider,\s*className:\s*'dim-jh-ledgerProvider'/g) ?? []
    // 实时卡 + 历史日树 = 2 处（少一处就是又分叉了）
    expect(providerRows).toHaveLength(2)
  })

  it('★ 窄屏必须收窄三层缩进（54px 在 <700px 会把模型名挤成三行）', () => {
    const media = styles.slice(styles.indexOf('@media (max-width: 700px)'))
    expect(media).toMatch(/\.dim-jh-ledgerAccount\s*\{[^}]*margin-left:\s*14px/)
    expect(media).toMatch(/\.dim-jh-ledgerModel\s*\{[^}]*padding:\s*2px 0 2px 26px/)
  })

  it('★★ 窄面板下「总处理」必须放得进容器（统计组宽不得超过可用宽）', () => {
    // 2026-11-13 PR #69 对抗审计 P2 / B-2：宿主右侧栏最低可拖到 300px，
    // 而 `.dim-jh-ledgerPane` 的水平内边距是 12+12=24px ⇒ 可用内容宽 276px，
    // 却给统计组写死 `width: 300px` ⇒ 右侧「总处理」多出 24px，
    // 而 `.dim-jh-ledgerPaneBody{overflow-x:hidden}` 把它**裁掉且没有滚动条**
    // ⇒ 用户看到「总处理」数字被切一半，且不知道右边还有内容。
    //
    // ⚠️⚠️ 修法**只能**是「组宽不得超过容器」（max-width: 100%）：
    // 面板体的 `overflow-x: hidden` 是 tests/unit/ledger-pane-chrome.spec.ts:405
    // 的既有契约（8 列定宽明细表靠它裁），改成 auto 会让那条契约红。
    // 两个窄档块都要写 —— 少一处，那种窗口尺寸下仍然溢出。
    const container = styles.slice(
      styles.indexOf('@container (max-width: 720px)'),
      styles.indexOf('@media (max-width: 700px)'),
    )
    expect(container, '找不到 @container 窄档块').not.toBe('')
    expect(container).toMatch(/\.dim-jh-ledgerPaneBody \.dim-jh-ledgerStatGroup\s*\{[^}]*max-width:\s*100%/)
    const media = styles.slice(styles.indexOf('@media (max-width: 700px)'))
    expect(media).toMatch(/\.dim-jh-ledgerStatGroup\s*\{[^}]*max-width:\s*100%/)
    // 反向对照：宽屏那条基础规则必须仍是定宽 460px（只有窄档收窄，
    // 否则弹窗里 9 列 + 统计组的排布会跟着变形）。
    const base = styles.match(/^\.dim-jh-ledgerStatGroup\s*\{([^}]*)\}/m)?.[1] ?? ''
    expect(base, '缺少基础 .dim-jh-ledgerStatGroup 规则').not.toBe('')
    expect(base).toMatch(/width:\s*460px/)
    expect(base, '基础规则不该带 max-width（窄档才需要）').not.toMatch(/max-width/)
    // 反向对照：明细表自己的横向滚动容器必须还在（9 列定宽靠它，不是靠面板体）
    expect(container).toMatch(/\.dim-jh-ledgerPaneBody \.dim-jh-ledgerTableScroll\s*\{[^}]*overflow-x:\s*auto/)
  })

  it('★ 模型行不再按账号数分支，且 data-single 属性不得复活', () => {
    // ⚠️ 判据只认**属性写法**与 **CSS 选择器**，不认注释 ——
    //    注释里提到 data-single 是在解释「为什么删掉」，那是应该存在的。
    expect(client).not.toMatch(/'data-single'\s*:/)
    expect(styles).not.toMatch(/\[data-single/)
    expect(client).not.toMatch(/\[data-single/)
  })
})

/**
 * 「最近请求」明细表：**模型列 = provider/model** + 列宽排布（2026-11-11 用户需求）。
 *
 * 用户原话：「列表中，模型显示应该是 provider/模型名的格式，跟上游原来的一样才行」
 * 以及「你合理排布一下时间、渠道的长度（因为时间长度固定，渠道列只有直连和网关，
 * 基本长度固定），以放下模型列一行显示」。
 *
 * ⚠️ 事实澄清：**上游原本就只显示裸模型 id**（`entry.model`），不是我们改坏的。
 *   `provider/model` 是本轮**新增**的展示口径。`TokenLedgerEntry.provider` 一直都在，
 *   故服务端零改动。
 *
 * ## 实测依据（960px 弹窗 / 11.5px 字体，见提交说明）
 *
 * | 内容 | 实测宽 |
 * |---|---|
 * | 时间 `00:19:26` | 42.2px |
 * | 渠道 `直连`/`网关` | 23px |
 * | 账号 `account-names@example.com`（原样本已脱敏，此处为**同长度**示例地址） | 154.5px |
 * | 最长模型串 `workbuddy/deepseek-v4.1-flash-free` | 187.3px（+12 内边距 = 199.3） |
 *
 * 改前的病根：时间给 9%、渠道给 8%（各自浪费约 50px），模型只拿到 182px ⇒ **截断**。
 */
describe('明细表 · 模型列格式与列宽排布', () => {
  const styles = readFileSync(resolve(here, '../../plugin-src/client/jet-hub-styles.js'), 'utf8')

  it('★ ledgerEntryModelText：拼成 provider/模型', () => {
    expect(ledgerEntryModelText({ provider: 'workbuddy', model: 'deepseek-v4.1-flash' }))
      .toBe('workbuddy/deepseek-v4.1-flash')
    expect(ledgerEntryModelText({ provider: 'qodercn', model: 'dfmodel' })).toBe('qodercn/dfmodel')
  })

  it('★ 缺 provider 时只回模型名，不拼出 undefined/ 或 /model 脏串', () => {
    // 账本里 provider 恒有值，但字段被截断/旧数据的形态不该渲染成脏串。
    expect(ledgerEntryModelText({ model: 'dfmodel' })).toBe('dfmodel')
    expect(ledgerEntryModelText({ provider: '', model: 'dfmodel' })).toBe('dfmodel')
    expect(ledgerEntryModelText({ provider: 'qoder' })).toBe('')
    expect(ledgerEntryModelText(undefined)).toBe('')
    expect(ledgerEntryModelText(null)).toBe('')
  })

  it('★★★ 明细表的模型格必须用 ledgerEntryModelText（不是裸 entry.model）', () => {
    // ⚠️ 判据打在**渲染表达式**上：写回 `entry.model` 就是本需求未实现。
    expect(client).toMatch(/className:\s*'dim-jh-ledgerEntryModel',\s*title:\s*ledgerEntryModelText\(entry\)/s)
    expect(client).toMatch(/\}, ledgerEntryModelText\(entry\)\)/)
    // 反向：模型格那一段里不许再出现裸 `entry.model)`（导出另算，见下条）
    const modelCell = client.match(/className: 'dim-jh-ledgerEntryModel'[\s\S]{0,180}?\)/)?.[0] ?? ''
    expect(modelCell, '模型格应当只经 ledgerEntryModelText 取值').not.toMatch(/\}, entry\.model\)/)
  })

  it('★★ CSV 导出的模型列必须与界面同口径（provider/模型）', () => {
    // 界面写 workbuddy/xxx、CSV 只写 xxx 就是两处自相矛盾。
    expect(client).toMatch(/accountLabel\(entry\.accountId, accountNames\), ledgerEntryModelText\(entry\)/)
  })

  it('★★★ 列宽必须是「实测值」而不是百分比（百分比正是改前的病根）', () => {
    // 时间/渠道压到贴紧内容：42.2 / 23px 的内容给 62 / 46px（含内边距）。
    expect(client).toMatch(/key: 'time'[^}]*width: '62px'/)
    expect(client).toMatch(/key: 'channel'[^}]*width: '46px'/)
    // 账号 172px：实测最长账号名 154.5px + 内边距 12px = 166.5px ⇒ 160px 会截断。
    expect(client).toMatch(/key: 'account'[^}]*width: '172px'/)
    // 模型列吃剩余宽度（auto），不是固定 200px（差 7.5px 会截断）。
    expect(client).toMatch(/key: 'model'[^}]*width: 'auto'/)
    // 右侧数字列按实测分配。
    expect(client).toMatch(/key: 'tokens'[^}]*width: '104px'|key: 'tokens',\s*\n\s*label: 'TOKEN',[\s\S]{0,120}?width: '104px'/)
    expect(client).toMatch(/key: 'ttft'[^}]*width: '58px'/)
    expect(client).toMatch(/key: 'tps'[^}]*width: '86px'/)
    expect(client).toMatch(/key: 'duration'[^}]*width: '58px'/)
    expect(client).toMatch(/key: 'status'[^}]*width: '60px'/)
    // ⚠️ 反向：整个列定义表里一个百分比都不许留（会退回「等分/浪费」的老形态）。
    const colBlock = client.slice(client.indexOf('const LEDGER_ENTRY_COLUMNS'), client.indexOf('const LEDGER_ENTRY_CSV_COLUMNS'))
    expect(colBlock).not.toMatch(/width:\s*'\d+%'/)
  })

  it('★★ 列宽总计必须 ≈ 912px（960 弹窗 − 左右内边距），给模型列留足余量', () => {
    const colBlock = client.slice(client.indexOf('const LEDGER_ENTRY_COLUMNS'), client.indexOf('const LEDGER_ENTRY_CSV_COLUMNS'))
    const fixed = [...colBlock.matchAll(/width:\s*'(\d+)px'/g)].map((m) => Number(m[1]))
    // 8 列固定（model 是 auto）+ 列数校验：少一列说明有人删了列。
    expect(fixed).toHaveLength(8)
    const sum = fixed.reduce((a, b) => a + b, 0)
    // 固定列合计必须 < 912，余量是模型列的（实测需要 199.3px）。
    expect(sum).toBeLessThan(912)
    expect(912 - sum, '模型列剩余宽度必须大于实测最长串 199.3px').toBeGreaterThan(199.3)
  })

  it('★ 窄屏必须横向滚动，不许压缩各列（9 列固定宽必然超宽）', () => {
    expect(styles).toMatch(/\.dim-jh-ledgerTableScroll\s*\{[^}]*overflow-x:\s*auto/)
    // 渲染层也必须有这个容器，否则样式挂不上去。
    expect(client).toMatch(/className: 'dim-jh-ledgerTableScroll'/)
  })

  it('★ 模型格的 title 挂完整串（窄屏省略号截断时靠悬停看全）', () => {
    expect(client).toMatch(/title:\s*ledgerEntryModelText\(entry\)/)
  })
})

/**
 * 单模型账号合并 —— **实现只能有一份**（2026-11-11）。
 *
 * ⚠️ 这条守卫是变异验证抓出来的：把历史日树的 `renderAccountRow(...)` 换回
 * 手写的一段 JSX 后，全部测试**依然全绿** —— 因为所有行为测试只渲染了
 * `renderSummary`（实时卡）那条路径，历史日树那条**从来没被渲染过**。
 *
 * 真实后果与「provider 被画成账号」同型：同一份数据在两处显示不同结构，
 * 用户会以为其中一份算错了（本仓库已因此复发过两次：
 * `>1 → >0` 与 provider 类名各漏过一次历史树）。
 *
 * ⇒ 判据只能打在**源码结构**上：`renderAccountRow` 必须恰好被两处调用
 * （实时卡 + 历史日树），且历史日树里**不许**再出现手写的账号头。
 */
describe('单模型合并 · 实现唯一性（历史日树必须复用，不许各写一份）', () => {
  it('★★★ renderAccountRow 必须恰好有 2 个调用点（实时卡 + 历史日树）', () => {
    // 调用形态是 `renderAccountRow(accountRow, ...)`；定义形态是
    // `const renderAccountRow = (accountRow, keyPrefix) =>`，两者不会互相匹配。
    const calls = client.match(/renderAccountRow\(accountRow,/g) ?? []
    expect(calls.length, 'renderAccountRow 必须被调用 2 次：实时卡 1 次 + 历史日树 1 次')
      .toBe(2)
  })

  it('★★★ 历史日树里不许再有手写的账号头（必须走 renderAccountRow）', () => {
    // 历史日树那一段的锚点：`renderDayTree`
    const dayTree = client.slice(client.indexOf('const renderDayTree'))
    // 它内部若出现「手写的账号容器 + 账号头」就是又分叉了
    expect(dayTree).not.toMatch(/className:\s*'dim-jh-ledgerAccount',\s*\n?\s*\},\s*\n?\s*React\.createElement\('div',\s*\{\s*className:\s*'dim-jh-ledgerAccountHead'/)
    // 正向：历史树确实调用了共用实现
    expect(dayTree).toMatch(/renderAccountRow\(/)
  })

  it('★★ 合并行的统计必须取**模型**的（不是账号小计）', () => {
    // ⚠️ 单模型时两者数值相同 ⇒ 行为测试测不出来（变异实测无牙）。
    //    只能打在实现上：`statRow` 必须优先取 `single`。
    expect(client).toMatch(/const statRow = single \?\? accountRow\.totals;/)
    // 反向：不许写成 always-account（那就是需求未实现）
    expect(client).not.toMatch(/const statRow = accountRow\.totals;?\s*\n/)
  })

  it('★★★ 合并行与模型行的**数字右缘必须对齐**（实测抓到的 12px 错位）', () => {
    // ⚠️ 真实缺陷（2026-11-11 浏览器实测）：账号色块有 `padding: 5px 8px`，
    //    模型行原本右侧不留白 ⇒ 合并行「总处理」右缘 1132px、模型行 1144px，
    //    纵向比数字时明显错一截。
    //    修法：模型行也留 8px 右内边距，两边收到同一个内缘。
    const styles = readFileSync(resolve(here, '../../plugin-src/client/jet-hub-styles.js'), 'utf8')
    const modelRule = styles.match(/\.dim-jh-ledgerModel\s*\{([^}]*)\}/s)?.[1] ?? ''
    expect(modelRule, '找不到 .dim-jh-ledgerModel 规则').not.toBe('')
    // 四值 padding 的第 2 个（右）必须是 8px
    const pad = modelRule.match(/padding:\s*([^;]+);/)?.[1]?.trim() ?? ''
    const parts = pad.split(/\s+/)
    const right = parts.length === 4 ? parts[1] : (parts.length >= 2 ? parts[1] : parts[0])
    expect(right, '模型行右内边距必须与账号色块的 8px 一致，否则数字右缘对不齐').toBe('8px')
    // 账号色块的横向内边距也必须是 8px（两边同源才好维护）
    const headRule = styles.match(/\.dim-jh-ledgerAccountHead\s*\{([^}]*)\}/s)?.[1] ?? ''
    expect(headRule).toMatch(/padding:\s*5px\s+8px/)
  })

  it('★★★ 账号行的「总处理」只有**单模型**才加粗（多模型账号合计保持不加粗）', () => {
    // ⚠️ 用户 2026-11-11 第四次修正：「当帐号行有两个模型及以上时，帐号行的总处理是
    //    不加粗的，保持原来的就行…我只要每个模型的总处理结果是加粗的就行，
    //    这样方便我一眼看到每个帐号下每个模型的请求总量」。
    //
    // | 行 | 类名 | 视觉 |
    // |---|---|---|
    // | 单模型合并行 | ledgerModelTokens | 加粗亮白 |
    // | 多模型账号行 | ledgerAccountSum  | 灰、不加粗 |
    //
    // ⇒ 判据必须是**条件切换**，不能无条件用其中一个。
    expect(client).toMatch(/className:\s*single === null \? 'dim-jh-ledgerAccountSum' : 'dim-jh-ledgerModelTokens'/)
    // 反向：不许无条件 ModelTokens（会让账号合计看起来像单个模型的用量）
    expect(client).not.toMatch(/className:\s*'dim-jh-ledgerModelTokens',\s*\n\s*title:\s*tokenSummaryTooltip\(statRow\)/)
  })

  it('★★★ 统计信息必须包在固定宽的 StatGroup 里（否则「次数」列参差不齐）', () => {
    // ⚠️ 用户 2026-11-11 第三次修正：「统计信息（红框内）要放在行中间」。
    //    改前每个统计格各自 margin-left:auto ⇒ 被推成各自最右，而内容宽度不同
    //    ⇒ 「次数」起始位置 4 种（714/720/726/732），账号名后留一大片空白。
    //    修法：整组固定 460px、组内左对齐 ⇒ 实测全部 510px。
    const styles = readFileSync(resolve(here, '../../plugin-src/client/jet-hub-styles.js'), 'utf8')
    const group = styles.match(/\.dim-jh-ledgerStatGroup\s*\{([^}]*)\}/s)?.[1] ?? ''
    expect(group, '缺少 .dim-jh-ledgerStatGroup 规则').not.toBe('')
    expect(group).toMatch(/width:\s*460px/)
    expect(group).toMatch(/margin-left:\s*auto/)
    // ⚠️ 组内的「次数」不许再各自 auto（那会退回参差不齐）
    const req = styles.match(/\.dim-jh-ledgerAccountReq\s*\{([^}]*)\}/s)?.[1] ?? ''
    expect(req).not.toMatch(/margin-left:\s*auto/)
    // 渲染层：账号行与模型行都必须包这个组
    expect(client).toMatch(/className:\s*'dim-jh-ledgerStatGroup'/)
    const groups = client.match(/className: 'dim-jh-ledgerStatGroup'/g) ?? []
    expect(groups.length, '账号行与模型行各一处 StatGroup').toBe(2)
  })

  it('★★★ 服务端的 「-」 空账号哨兵必须显示为「（未知帐号）」，不能是裸 `-`', () => {
    // ⚠️ 用户 2026-11-11 报障：「怎么出现一条没有帐号的呢」——界面上有一行账号叫 `-`。
    // 根因：`src/token-ledger.ts` 两处（内存聚合 + 落盘日聚合）把空 accountId 归一成
    // `'-'`（Map 键不能缺失），然后原样传给客户端。
    // ⚠️ 而**明细**路径在同样情形下是**空串** ⇒ 两种形态都要认。
    expect(accountLabel('-')).toBe('（未知帐号）')
    // 空串仍是「未归属」（明细路径的形态，既有契约不许改）
    expect(accountLabel('')).toBe('未归属')
    // 正常 id 不受影响
    expect(accountLabel('qodercn-c5a414d5')).toBe('qodercn-c5a414d5')
    // nameMap 里若有 '-' 的映射也不该覆盖哨兵语义
    expect(accountLabel('-', new Map([['-', '不该显示']]))).toBe('（未知帐号）')
  })
})
