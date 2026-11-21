/**
 * ★★★ **适配器落盘接线的派生式普查**（2026-11-21）。
 *
 * ## 为什么要它（真实漏接）
 *
 * 2026-11-20 批量给适配器接 `rememberForDisk` 时，我按「有 `ensureRemoteModels`
 * 方法」的清单逐个改。而 **`zcode-adapter.ts` 的结构不同**（`remoteModels` 在
 * `catalog()` 里赋值，没有独立的 `ensureRemoteModels` 方法）⇒ 它被漏了。
 *
 * 症状极隐蔽：`~/.dsh/cache/model-catalog/` 下只有 4 个 provider 的文件，
 * 而用户有 8 家有账号 —— **少的那几家只是「重启慢」，没有任何报错**。
 * 实测就是用户发现「为什么只有 4 个文件」才暴露的。
 *
 * ## ⚠️ 为什么用「派生式普查」而不是硬编码清单
 *
 * 本仓库已有教训（`client-ui.md` 记着）：硬编码清单**漏一家就静默失效**，
 * 而派生式普查「新增一家适配器时自动纳入」。判据是：
 *
 * **凡有 `this.remoteModels =` 赋值的适配器，必须同时有 `rememberForDisk?.(` 调用。**
 *
 * 这条不变式的含义是「**有远端目录 ⇒ 就该落盘**」——
 * 若某家确实不该落盘（例如 `marvis` 没有远端端点、恒用静态表），
 * 它自然没有 `remoteModels` 赋值，不会进本普查。
 *
 * ## ⚠️ 已知的「合法不接入」
 *
 * | 家 | 为什么不接入 |
 * |---|---|
 * | `marvis` | **没有远端端点**（实测 9 个候选全 404），`catalog()` 恒返回静态表 ⇒ 无 `remoteModels` 赋值 |
 *
 * ⚠️ 若将来出现「有 `remoteModels` 但**确实**不该落盘」的家，
 * 应把它加进下面的 `EXEMPT` 并写明理由 —— 而不是放宽判据
 *（放宽会让真正的漏接再次逃过）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, '../../src')

/** 剥掉注释行（否则「注释里提到 rememberForDisk」会让判据失真）。 */
function stripComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
}

/**
 * 合法豁免（**必须写明理由**）。
 *
 * ⚠️ 当前**没有**需要豁免的家：`marvis` 因为没有 `remoteModels` 赋值，
 * 天然不进普查。留这个常量是为了让「将来要豁免」有明确的落点，
 * 且强制填写理由（空理由会被下面的用例断言挡住）。
 */
const EXEMPT: Record<string, string> = {}

describe('适配器落盘接线普查（派生式）', () => {
  const adapters = readdirSync(srcDir).filter((f) => f.endsWith('-adapter.ts'))

  /** 有远端目录赋值的适配器（派生，不硬编码）。 */
  const withRemoteCatalog = adapters.filter((f) => {
    const code = stripComments(readFileSync(join(srcDir, f), 'utf8'))
    return /this\.remoteModels\s*=/.test(code)
  })

  it('★ 普查本身有牙：至少能找到 10 家有远端目录', () => {
    // ⚠️ 这条防「正则写错导致普查恒空」—— 普查空转时下面那条恒真。
    expect(withRemoteCatalog.length, '派生出的适配器过少，普查可能失效')
      .toBeGreaterThanOrEqual(10)
  })

  it('★★★ 凡有 remoteModels 赋值 ⇒ 必须调 rememberForDisk（否则重启慢且无报错）', () => {
    const missing: string[] = []
    for (const f of withRemoteCatalog) {
      if (EXEMPT[f] !== undefined) continue
      const code = stripComments(readFileSync(join(srcDir, f), 'utf8'))
      if (!/rememberForDisk\?\.\(/.test(code)) missing.push(f)
    }

    expect(
      missing,
      `以下适配器有远端目录但没接入落盘（重启后该家目录不会走缓存）：${missing.join(', ')}`,
    ).toEqual([])
  })

  it('★ 豁免表里每条都必须写明理由（否则等于放宽判据）', () => {
    for (const [file, reason] of Object.entries(EXEMPT)) {
      expect(reason.trim().length, `${file} 的豁免理由不得为空`).toBeGreaterThan(10)
    }
  })

  it('★ 豁免的家必须真的存在（防止改名后豁免表腐坏）', () => {
    for (const file of Object.keys(EXEMPT)) {
      expect(adapters, `豁免表里的 ${file} 不存在了`).toContain(file)
    }
  })
})