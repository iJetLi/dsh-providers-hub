/**
 * Gitee 复现：「魔塔社区的令牌我一保存，页面直接清空，切换页面无效，只能重启 dsh」。
 *
 * ## 根因（2026-10-22）
 *
 * `ProviderPanel` 的 `probeNotice` 渲染端按**对象**读三个字段：
 *
 *     'data-tone': probeNotice.tone,
 *     React.createElement('div', null, probeNotice.text),
 *     probeNotice.details.length > 0 ? ...
 *
 * 但两条「保存魔搭令牌」的路径传的是**裸字符串**：
 *
 * - `submitModelscopeKeyEdit`（编辑路径）：`setProbeNotice(res?.renamed ? '…' : '已更新访问令牌。')`
 * - `submitOpencodeEntry`（添加路径，`res.existed` 分支）：`setProbeNotice('该 key 已存在…')`
 *
 * 字符串没有 `.details` ⇒ `.length` 抛 `TypeError: Cannot read properties of
 * undefined (reading 'length')`。**插件内没有任何 ErrorBoundary** ⇒ React 卸载
 * 整棵设置页子树 ⇒ 「页面直接清空」，侧栏切页也失效，只能重启 DSH。
 *
 * 用户当时命中的是 `existed` 分支：`state.json` 里那个魔搭账号
 * `createdAt` 是 2026-10-19，而报障发生在 10-22 —— 同一把 Key 再加一次。
 *
 * ## 这个文件锁什么
 *
 * | 组 | 锁的是什么 |
 * |---|---|
 * | A | `normalizeProbeNotice` 的形状收敛（裸字符串不丢文案、对象透传、空文案不渲染） |
 * | B | `safeNoticeDetails` 对非数组的降级 |
 * | C | **源码级**：`jet-hub.js` 里不得再出现「裸字符串喂 setProbeNotice」 |
 * | D | **源码级**：渲染端不得再裸读 `probeNotice.details.length` |
 *
 * ⚠️ C/D 组是**源码断言**而非运行断言：单测环境是 `node`，`react` 是宿主注入
 * 的 external（`node_modules` 里没有），`jet-hub.js` 根本 import 不了，
 * 组件无法渲染。本仓库同款先例见 `tests/unit/new-account-dialog.spec.ts` 的
 * 「为什么 A 组一半靠源码断言」。
 *
 * @see plugin-src/client/notice-shape.js
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { normalizeProbeNotice, safeNoticeDetails } from '../../plugin-src/client/notice-shape.js';

const here = dirname(fileURLToPath(import.meta.url));

/** 读客户端源码（源码级断言的唯一输入）。 */
function readClientSource() {
  return readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8');
}

/**
 * 去掉注释后再断言。
 *
 * ⚠️ 必须去注释：本次修复的注释里**逐字引用**了错误写法
 * （`setProbeNotice('该 key 已存在…')`），不去注释会让「禁止裸字符串」
 * 的断言被自己的说明文字**假红**。本仓库已记录过这个陷阱
 * （见 `zcode-carrier-client-wiring.spec.ts` 的 `stripComments`）。
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('A. normalizeProbeNotice —— 裸字符串不得炸掉页面', () => {
  it('A1 裸字符串收敛成对象，且**不丢文案**', () => {
    const normalized = normalizeProbeNotice('该 key 已存在，已为你定位到原有账号。');
    expect(normalized).toEqual({
      tone: 'ok',
      // ⚠️ 文案必须原样保留：用户的抱怨是「白屏」，不是「提示没了」。
      //    收敛时丢掉文案等于把 bug 换成另一个体验问题。
      text: '该 key 已存在，已为你定位到原有账号。',
      details: [],
    });
  });

  it('A2 收敛结果必须**可以被渲染端安全读取**（回归本体）', () => {
    const normalized = normalizeProbeNotice('已更新访问令牌。');
    expect(normalized).not.toBeNull();
    // 这一行就是崩掉用户页面的那个表达式。裸字符串时它是 TypeError。
    expect(() => normalized.details.length).not.toThrow();
    expect(normalized.details.length).toBe(0);
  });

  it('A3 正常对象原样透传（tone/text/details 都不被改写）', () => {
    const input = { tone: 'warn', text: '部分账号领取失败（2 个）', details: ['a 超时', 'b 401'] };
    expect(normalizeProbeNotice(input)).toEqual(input);
  });

  it('A4 缺 details 的对象补空数组（老调用点只传 tone+text）', () => {
    expect(normalizeProbeNotice({ tone: 'error', text: '操作失败：xxx' }))
      .toEqual({ tone: 'error', text: '操作失败：xxx', details: [] });
  });

  it('A5 缺 tone 时默认 ok，不产生 undefined 的 data-tone', () => {
    // `data-tone={undefined}` 会让 CSS 的 [data-tone="…"] 全部落空，
    // 提示块变成无着色的一坨，虽不崩但很难读。
    expect(normalizeProbeNotice({ text: '已复制' })?.tone).toBe('ok');
  });

  it('A6 details 里的非字符串项被丢掉（不把 undefined 渲染成 "undefined"）', () => {
    expect(normalizeProbeNotice({
      tone: 'warn',
      text: 'x',
      details: ['ok', undefined, 42, null, '', 'second'],
    })?.details).toEqual(['ok', 'second']);
  });

  it('A7 null / undefined ⇒ null（不渲染该区块）', () => {
    expect(normalizeProbeNotice(null)).toBeNull();
    expect(normalizeProbeNotice(undefined)).toBeNull();
  });

  it('A8 空文案 ⇒ null（不渲染一个空的白条）', () => {
    expect(normalizeProbeNotice({ tone: 'ok', text: '' })).toBeNull();
    expect(normalizeProbeNotice({ tone: 'ok' })).toBeNull();
  });

  it('A9 非对象标量与数组 ⇒ null（无法解释成提示，但不能抛）', () => {
    expect(normalizeProbeNotice(42)).toBeNull();
    expect(normalizeProbeNotice(true)).toBeNull();
    // 数组带 .length，若原样透传会比裸字符串更隐蔽 —— 直接拒绝。
    expect(normalizeProbeNotice(['a'])).toBeNull();
  });
});

describe('B. safeNoticeDetails —— 渲染端的安全读取', () => {
  it('B1 非数组一律空数组（裸字符串 / undefined / 对象）', () => {
    expect(safeNoticeDetails(undefined)).toEqual([]);
    expect(safeNoticeDetails('已更新访问令牌。')).toEqual([]);
    expect(safeNoticeDetails({ length: 5 })).toEqual([]);
  });

  it('B2 数组原样返回（含引用相同，避免每帧新建数组）', () => {
    const details = ['a', 'b'];
    expect(safeNoticeDetails(details)).toBe(details);
  });

  it('B3 对裸字符串读 .length 不抛（回归本体）', () => {
    // 修复前渲染端写的是 `probeNotice.details.length`；对字符串 probeNotice
    // 这里是 `undefined.length` ⇒ TypeError ⇒ 整页卸载。
    expect(() => safeNoticeDetails('已更新访问令牌。').length).not.toThrow();
  });
});

describe('C. 源码级：不得再用裸字符串喂 setProbeNotice', () => {
  it('C1 全部 setProbeNotice 调用都是对象 / null / 变量，没有字符串字面量', () => {
    const source = stripComments(readClientSource());
    const offenders = [];
    const pattern = /setProbeNotice\(\s*(['"`])/g;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const line = source.slice(0, match.index).split('\n').length;
      offenders.push(`line ${line}: ${source.slice(match.index, match.index + 80).split('\n')[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('C2 写入端统一经过 normalizeProbeNotice（状态钩子被包装）', () => {
    const source = stripComments(readClientSource());
    // 判据是「存在包装」而不是「存在某个字面量」：将来重命名内部 state 不影响本断言。
    expect(source).toMatch(/setProbeNoticeState\(\s*normalizeProbeNotice\(/);
    // 裸的 useState(null) 若直接暴露成 setProbeNotice，包装就形同虚设。
    expect(source).not.toMatch(/const\s*\[\s*probeNotice\s*,\s*setProbeNotice\s*\]\s*=\s*React\.useState/);
  });
});

describe('D. 源码级：渲染端不得裸读 details.length', () => {
  it('D1 probeNotice 的明细必须经 safeNoticeDetails 读取', () => {
    const source = stripComments(readClientSource());
    // 修复前的那行原文：`probeNotice.details.length > 0`
    expect(source).not.toMatch(/probeNotice\.details\.length/);
    expect(source).toMatch(/safeNoticeDetails\(probeNotice\.details\)/);
  });
});
