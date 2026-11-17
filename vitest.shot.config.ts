import { defineConfig } from 'vitest/config'

/**
 * 无头出图专用配置（`pnpm shot:label`）。
 *
 * ⚠️ 与 `vitest.config.ts` **分开**是刻意的，理由与 dsh-connect-workbuddy 的
 * `vitest.card.config.ts` 逐字相同：这个工具会写文件、需要真浏览器才有意义,
 * 若塞进默认套件就得配一条 skip —— 而一条故意 skip 的用例会让每次运行都报
 * 「1 skipped」，绿色从此不再等于「全跑过」。`tools/` 也不在默认 glob 里。
 */
export default defineConfig({
  test: {
    include: ['tools/*.ts'],
    environment: 'node',
  },
})
