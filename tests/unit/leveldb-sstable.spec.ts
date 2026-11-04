/**
 * leveldb-sstable.spec.ts —— LevelDB SSTable（`.ldb`）读取器 + Snappy 解压单测
 *
 * 被测：`src/leveldb-sstable.ts`
 *
 * ── 为什么这个文件非有不可 ───────────────────────────────────────────────
 * 这模块修的是一个**测试全绿却真机全废**的缺陷（2026-11-04）：旧代码把 `.ldb` 直接
 * `toString('latin1')` 正则搜索，而真实 `.ldb` 里每条记录都做了**前缀压缩**、整块又被
 * **Snappy 压缩** ⇒ `"key":"authorization"` 在原始字节里 0 命中。原来的 888 行单测
 * 只喂裸文本 `.log` fixture，**从没覆盖压缩块**，所以测不出问题。
 *
 * ⇒ 本文件的 fixture 必须**真造一个 SSTable**（含 snappy 压缩块），不能再用裸文本。
 *
 * ── ⚠️ 绝不读用户真实浏览器数据 ──────────────────────────────────────────
 * 全部用内存里构造的 Buffer 与 `mkdtempSync` 临时目录。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  leveldbRecordsText,
  parseBlockEntries,
  readSstableRecords,
  readVarint,
  snappyDecompress,
} from '../../src/leveldb-sstable.js'
import { readMagicrewLocalCreds } from '../../src/magicrew-local-browser.js'

// ════════════════════════════════════════════════════════════════════════
// fixture 原语：varint / snappy / block / sstable
// ════════════════════════════════════════════════════════════════════════

/** 按 varint 编码一个非负整数。 */
function varint(value: number): Buffer {
  const bytes: number[] = []
  let rest = value
  while (rest >= 0x80) {
    bytes.push((rest & 0x7f) | 0x80)
    rest = Math.floor(rest / 128)
  }
  bytes.push(rest)
  return Buffer.from(bytes)
}

/** 发一段 literal（长度 ≤ 60 用短形式，否则带长度字节）。 */
function emitLiteral(parts: Buffer[], payload: Buffer): void {
  if (payload.length === 0) return
  const encoded = payload.length - 1
  if (encoded < 60) {
    parts.push(Buffer.from([encoded << 2]), payload)
    return
  }
  let extra = 1
  while (extra < 4 && encoded >= 2 ** (8 * extra)) extra += 1
  const lengthBytes: number[] = []
  let value = encoded
  for (let index = 0; index < extra; index += 1) {
    lengthBytes.push(value & 0xff)
    value = Math.floor(value / 256)
  }
  parts.push(Buffer.from([(59 + extra) << 2]), Buffer.from(lengthBytes), payload)
}

/**
 * 造一份**只用 literal tag** 的合法 Snappy 流（不做回引）。
 *
 * 用途：钉住解压器的 literal 分支与长度扩展。**不**用来模拟真实 `.ldb` ——
 * 真实压缩会把重复串压成 copy 回引，原始字节里就搜不到明文了（见 {@link snappyCompress}）。
 */
function snappyLiteralOnly(payload: Buffer): Buffer {
  const parts: Buffer[] = [varint(payload.length)]
  emitLiteral(parts, payload)
  return Buffer.concat(parts)
}

/**
 * ★ 一个**真的会回引**的极简 Snappy 压缩器（4 字节哈希匹配，copy2 输出，单段最长 64）。
 *
 * ## 为什么 fixture 必须用它
 *
 * 用 literal-only 的「压缩」造 fixture，明文在原始字节里**依然可见** —— 于是
 * 「老代码直接 `toString('latin1')` 也能搜到」⇒ 这样的 fixture **测不出**真机缺陷，
 * 反向验证（把修复撤掉应当变红）会**照常全绿**。实测踩过：第一版 fixture 就是
 * literal-only，撤掉修复后 26 条全绿。
 *
 * 真实 Edge `.ldb` 里 `"key":"authorization"` 在原始字节里出现 **0 次**（indexOf 返回 -1），
 * 就是因为这些重复的 origin / 键名前缀被压缩成了 copy 回引。本函数复现这一点，
 * 并在 {@link buildSstable} 里由用例断言「原始字节不含明文」。
 */
function snappyCompress(input: Buffer): Buffer {
  const parts: Buffer[] = [varint(input.length)]
  const table = new Map<number, number>()
  let literalStart = 0
  let at = 0
  while (at + 4 <= input.length) {
    const key = input.readUInt32LE(at)
    const previous = table.get(key)
    table.set(key, at)
    if (previous === undefined) {
      at += 1
      continue
    }
    const offset = at - previous
    if (offset <= 0 || offset > 0xffff) {
      at += 1
      continue
    }
    // 往后尽量延长匹配（copy2 单段上限 64）
    let length = 4
    while (length < 64 && at + length < input.length && input[previous + length] === input[at + length]) {
      length += 1
    }
    emitLiteral(parts, input.subarray(literalStart, at))
    parts.push(Buffer.from([((length - 1) << 2) | 0x02, offset & 0xff, (offset >> 8) & 0xff]))
    at += length
    literalStart = at
  }
  emitLiteral(parts, input.subarray(literalStart))
  return Buffer.concat(parts)
}

/** 一个 block：entry 区 + restart 数组 + restart 数量（restart 间隔取 1 ⇒ shared 恒 0）。 */
function buildBlock(entries: readonly { key: Buffer, value: Buffer }[]): Buffer {
  const chunks: Buffer[] = []
  const restarts: number[] = []
  let offset = 0
  for (const entry of entries) {
    restarts.push(offset)
    const encoded = Buffer.concat([
      varint(0),
      varint(entry.key.length),
      varint(entry.value.length),
      entry.key,
      entry.value,
    ])
    chunks.push(encoded)
    offset += encoded.length
  }
  chunks.push(Buffer.from(new Uint32Array(restarts.length ? restarts : [0]).buffer))
  chunks.push(Buffer.from(new Uint32Array([restarts.length || 1]).buffer))
  return Buffer.concat(chunks)
}

/** block trailer：1 字节压缩类型 + 4 字节 CRC 占位（本读取器不校验 CRC）。 */
function trailer(compression: 0 | 1): Buffer {
  return Buffer.from([compression, 0, 0, 0, 0])
}

const FOOTER_MAGIC = Buffer.from([0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb])

/**
 * 造一个最小可读的 SSTable：若干 data block + 空 metaindex + index + footer。
 *
 * @param blocks 每个 data block 的记录，以及它是否被压缩
 */
function buildSstable(blocks: readonly { entries: { key: Buffer, value: Buffer }[], compressed: boolean }[]): Buffer {
  const parts: Buffer[] = []
  const handles: { offset: number, size: number }[] = []
  let offset = 0
  for (const block of blocks) {
    const raw = buildBlock(block.entries)
    // ⚠️ 必须用**真会回引**的 snappyCompress，不能用 snappyLiteralOnly ——
    //    后者明文仍在原始字节里，测不出「不解压就搜不到」这个真机缺陷。
    const payload = block.compressed ? snappyCompress(raw) : raw
    handles.push({ offset, size: payload.length })
    parts.push(payload, trailer(block.compressed ? 1 : 0))
    offset += payload.length + 5
  }
  const metaindex = buildBlock([])
  const metaindexOffset = offset
  parts.push(metaindex, trailer(0))
  offset += metaindex.length + 5
  const indexBytes = buildBlock(handles.map((handle, index) => ({
    key: Buffer.from(`block-${String(index).padStart(4, '0')}`),
    value: Buffer.concat([varint(handle.offset), varint(handle.size)]),
  })))
  const indexOffset = offset
  parts.push(indexBytes, trailer(0))
  // ⚠️ footer 固定 **48 字节** = 两个 handle + 补齐到 40 + 8 字节 magic。
  //    补齐是「补到 40」，不是「再补 40」—— 后者会让 magic 落错位置。
  const footerHandles = Buffer.concat([
    varint(metaindexOffset),
    varint(metaindex.length),
    varint(indexOffset),
    varint(indexBytes.length),
  ])
  parts.push(Buffer.concat([
    footerHandles,
    Buffer.alloc(40 - footerHandles.length),
    FOOTER_MAGIC,
  ]))
  return Buffer.concat(parts)
}

/** Chromium 给 localStorage value 加的编码头（`0x01` = Latin-1，`0x00` = UTF-16LE）。 */
function ldbValue(json: string): Buffer {
  return Buffer.concat([Buffer.from([0x01]), Buffer.from(json, 'latin1')])
}

// ════════════════════════════════════════════════════════════════════════

describe('readVarint', () => {
  it('单字节直接返回', () => {
    expect(readVarint(Buffer.from([0x05]), 0)).toEqual({ value: 5, next: 1 })
  })

  it('多字节按 7 位累加', () => {
    // 300 = 0b1_0010_1100 ⇒ 低 7 位 0x2C | 0x80、高位 0x02
    expect(readVarint(Buffer.from([0xac, 0x02]), 0)).toEqual({ value: 300, next: 2 })
  })

  it('越过末尾要抛错（不是返回半截值）', () => {
    expect(() => readVarint(Buffer.from([0x80]), 0)).toThrow(/varint 越过文件末尾/)
  })

  it('超过 64 位要抛错', () => {
    expect(() => readVarint(Buffer.alloc(12, 0xff), 0)).toThrow(/varint 超过 64 位/)
  })
})

describe('snappyDecompress', () => {
  it('纯 literal', () => {
    const payload = Buffer.from('hello world')
    expect(snappyDecompress(snappyLiteralOnly(payload)).toString()).toBe('hello world')
  })

  it('copy1（1 字节偏移，长度 4~11）', () => {
    // literal 'hello'（5 字节）+ copy1：run = 4 + 1 = 5、offset = 5
    const input = Buffer.concat([
      varint(10),
      Buffer.from([0x10]), // 5-1 = 4 ⇒ 4 << 2 = 0x10
      Buffer.from('hello'),
      Buffer.from([0x05, 0x05]), // kind 01, run-4 = 1 ⇒ tag = (1<<2)|1 = 0x05；offset 高 3 位 0
    ])
    expect(snappyDecompress(input).toString()).toBe('hellohello')
  })

  it('copy2（2 字节偏移）', () => {
    const input = Buffer.concat([
      varint(10),
      Buffer.from([0x10]),
      Buffer.from('hello'),
      Buffer.from([0x12, 0x05, 0x00]), // kind 10, run = (4)+1 = 5, offset = 5
    ])
    expect(snappyDecompress(input).toString()).toBe('hellohello')
  })

  it('copy4（4 字节偏移）', () => {
    const input = Buffer.concat([
      varint(10),
      Buffer.from([0x10]),
      Buffer.from('hello'),
      Buffer.from([0x13, 0x05, 0x00, 0x00, 0x00]),
    ])
    expect(snappyDecompress(input).toString()).toBe('hellohello')
  })

  it('★ 重叠 copy（offset < run）必须逐字节前向复制 —— RLE 场景', () => {
    // literal 'a' 之后 copy2：offset = 1、run = 7 ⇒ 期望 'aaaaaaaa'
    // ⚠️ 用 Buffer.copy 一次拷 7 字节会读到尚未写出的字节 ⇒ 这条用例专门钉住它。
    const input = Buffer.concat([
      varint(8),
      Buffer.from([0x00]), // literal 长度 1
      Buffer.from('a'),
      Buffer.from([0x1a, 0x01, 0x00]), // kind 10, run = 6+1 = 7, offset = 1
    ])
    expect(snappyDecompress(input).toString()).toBe('aaaaaaaa')
  })

  it('扩展 literal 长度（≥61 字节）', () => {
    const payload = Buffer.alloc(61, 0x41)
    expect(snappyDecompress(snappyLiteralOnly(payload))).toEqual(payload)
  })

  it('实际产出与声明长度不符要抛错', () => {
    const input = Buffer.concat([varint(10), Buffer.from([0x10]), Buffer.from('hello')])
    expect(() => snappyDecompress(input)).toThrow(/与声明长度不符/)
  })

  it('offset 为 0 要抛错（会读到自身）', () => {
    const input = Buffer.concat([
      varint(10),
      Buffer.from([0x10]),
      Buffer.from('hello'),
      Buffer.from([0x12, 0x00, 0x00]),
    ])
    expect(() => snappyDecompress(input)).toThrow(/引用了尚未产出的字节/)
  })

  it('offset 超过已产出长度要抛错', () => {
    const input = Buffer.concat([
      varint(10),
      Buffer.from([0x10]),
      Buffer.from('hello'),
      Buffer.from([0x12, 0x09, 0x00]),
    ])
    expect(() => snappyDecompress(input)).toThrow(/引用了尚未产出的字节/)
  })
})

describe('parseBlockEntries：前缀压缩还原', () => {
  it('还原共享前缀', () => {
    // 手写一个 shared 不为 0 的 block：两条 key 共享 'abc'
    const entries = Buffer.concat([
      varint(0), varint(3), varint(1), Buffer.from('abc'), Buffer.from('1'),
      varint(3), varint(2), varint(1), Buffer.from('de'), Buffer.from('2'),
    ])
    const block = Buffer.concat([
      entries,
      Buffer.from(new Uint32Array([0]).buffer),
      Buffer.from(new Uint32Array([1]).buffer),
    ])
    const records = parseBlockEntries(block)
    expect(records.map((record) => record.key.toString())).toEqual(['abc', 'abcde'])
    expect(records.map((record) => record.value.toString())).toEqual(['1', '2'])
  })

  it('空 block 返回空数组', () => {
    expect(parseBlockEntries(buildBlock([]))).toEqual([])
  })

  it('公共前缀超过上一条 key 要抛错', () => {
    const entries = Buffer.concat([
      varint(0), varint(1), varint(0), Buffer.from('a'),
      varint(9), varint(1), varint(0), Buffer.from('b'),
    ])
    const block = Buffer.concat([
      entries,
      Buffer.from(new Uint32Array([0]).buffer),
      Buffer.from(new Uint32Array([1]).buffer),
    ])
    expect(() => parseBlockEntries(block)).toThrow(/公共前缀超过上一条 key/)
  })
})

describe('readSstableRecords', () => {
  it('★ 读出 snappy 压缩块里的记录（真机缺陷的正面用例）', () => {
    const file = buildSstable([{
      compressed: true,
      entries: [
        { key: Buffer.from('_https://www.letsmagic.cn\x00\x01MAGIC:user:authorization'), value: ldbValue('{"key":"authorization","value":"eyJx.eyJ5.sig"}') },
        { key: Buffer.from('_https://www.letsmagic.cn\x00\x01MAGIC:user:organizationCode'), value: ldbValue('{"key":"organizationCode","value":"d3efvqc1uduv"}') },
      ],
    }])
    // ★ 前提必须先钉住：**JSON 明文形态在原始字节里搜不到**（否则这条用例测不出缺陷）
    //
    // ⚠️ 判据必须是「`"key":"…","value":"…"` 这段连续 JSON」，**不能**是裸键名：
    //    snappy 里任何一段第一次出现都必然是 literal ⇒ `MAGIC:user:authorization`
    //    这个**孤立键名**在压缩后仍然可见（实测过，用它做断言会永远绿）。
    //    真机上失效的是 `credsNear` 那两套正则，它们要求 key 与 value 在同一段
    //    连续字节里 —— 而重复的 `"key":"…","value":"…"` 结构会被回引切断。
    expect(file.includes('"key":"authorization","value"')).toBe(false)
    expect(file.includes('"key":"organizationCode","value"')).toBe(false)
    // ⚠️ 反过来，**孤立**的 jwt 字面量在压缩后仍可见（首次出现必是 literal）——
    //    所以「明文是不是完全看不见」不是本缺陷的判据，别拿它做断言。

    const records = readSstableRecords(file)
    expect(records).toHaveLength(2)
    expect(records[0]!.key.toString('latin1')).toContain('MAGIC:user:authorization')
    expect(leveldbRecordsText(records)).toContain('eyJx.eyJ5.sig')
  })

  it('跨多个 data block（混合压缩与非压缩）', () => {
    const file = buildSstable([
      { compressed: true, entries: [{ key: Buffer.from('a'), value: Buffer.from('1') }] },
      { compressed: false, entries: [{ key: Buffer.from('b'), value: Buffer.from('2') }] },
    ])
    expect(readSstableRecords(file).map((record) => record.key.toString())).toEqual(['a', 'b'])
  })

  it('不是 SSTable（magic 不符）要抛错', () => {
    const file = buildSstable([{ compressed: false, entries: [{ key: Buffer.from('a'), value: Buffer.from('1') }] }])
    file[file.length - 1] = 0x00
    expect(() => readSstableRecords(file)).toThrow(/magic 不匹配/)
  })

  it('文件太短要抛错', () => {
    expect(() => readSstableRecords(Buffer.alloc(10))).toThrow(/文件太短/)
  })

  it('未知压缩类型要抛错（而不是当成明文读）', () => {
    const file = buildSstable([{ compressed: false, entries: [{ key: Buffer.from('a'), value: Buffer.from('1') }] }])
    // 第一个 data block 的 trailer 压缩字节：block 长度 + 0
    const block = buildBlock([{ key: Buffer.from('a'), value: Buffer.from('1') }])
    file[block.length] = 2
    expect(() => readSstableRecords(file)).toThrow(/不支持的 block 压缩类型 2/)
  })
})

describe('leveldbRecordsText：Chromium value 编码头', () => {
  it('0x01 头被剥掉（Latin-1）', () => {
    const text = leveldbRecordsText([
      { key: Buffer.from('k'), value: Buffer.concat([Buffer.from([0x01]), Buffer.from('{"v":"a"}')]) },
    ])
    // ⚠️ 必须**精确**比较：只断言 contains 时，编码头 0x01 留着也照样命中，
    //    这条用例就白写了（实测踩过）。
    expect(text).toBe('k\n{"v":"a"}')
  })

  it('0x00 头按 UTF-16LE 解（否则每个字符间会夹 \x00）', () => {
    const text = leveldbRecordsText([
      { key: Buffer.from('k'), value: Buffer.concat([Buffer.from([0x00]), Buffer.from('用户', 'utf16le')]) },
    ])
    expect(text).toBe('k\n用户')
  })

  it('没有编码头的 value 原样按 latin1（不猜）', () => {
    const text = leveldbRecordsText([
      { key: Buffer.from('k'), value: Buffer.from('raw-value') },
    ])
    expect(text).toContain('raw-value')
  })
})

describe('★ 端到端：.ldb 文件 → readMagicrewLocalCreds', () => {
  it('压缩块里的凭据能被本机浏览器导入链路读到', () => {
    const root = mkdtempSync(join(tmpdir(), 'leveldb-ldb-'))
    try {
      const dir = join(root, 'Default', 'Local Storage', 'leveldb')
      mkdirSync(dir, { recursive: true })
      const now = 1_800_000_000
      const jwt = [
        Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
        Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 3600 })).toString('base64url'),
        'fixture-signature',
      ].join('.')
      const file = buildSstable([{
        compressed: true,
        entries: [
          {
            key: Buffer.from('_https://www.letsmagic.cn\x00\x01MAGIC:user:authorization'),
            value: ldbValue(JSON.stringify({ key: 'authorization', value: jwt })),
          },
          {
            key: Buffer.from('_https://www.letsmagic.cn\x00\x01MAGIC:user:organizationCode'),
            value: ldbValue(JSON.stringify({ key: 'organizationCode', value: 'org-from-ldb' })),
          },
        ],
      }])
      writeFileSync(join(dir, '000005.ldb'), file)

      const creds = readMagicrewLocalCreds('www.letsmagic.cn', { roots: [root], now })
      expect(creds?.jwt).toBe(jwt)
      expect(creds?.organizationCode).toBe('org-from-ldb')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('同一个目录里 .ldb 与 .log 都读（WAL 里有刚写进去的凭据）', () => {
    const root = mkdtempSync(join(tmpdir(), 'leveldb-mixed-'))
    try {
      const dir = join(root, 'Default', 'Local Storage', 'leveldb')
      mkdirSync(dir, { recursive: true })
      const now = 1_800_000_000
      const jwt = [
        Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
        Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 3600 })).toString('base64url'),
        'fixture-signature',
      ].join('.')
      // .ldb 里只有无关记录，凭据在未压实的 .log 里
      writeFileSync(
        join(dir, '000005.ldb'),
        buildSstable([{ compressed: true, entries: [{ key: Buffer.from('unrelated'), value: ldbValue('x') }] }]),
      )
      const wal = [
        '_https://www.letsmagic.cn\x00\x01MAGIC:user:authorization',
        JSON.stringify({ key: 'authorization', value: jwt }),
        '_https://www.letsmagic.cn\x00\x01MAGIC:user:organizationCode',
        JSON.stringify({ key: 'organizationCode', value: 'org-from-wal' }),
      ].join('\n')
      writeFileSync(join(dir, '000006.log'), Buffer.from(wal, 'latin1'))

      const creds = readMagicrewLocalCreds('www.letsmagic.cn', { roots: [root], now })
      expect(creds?.organizationCode).toBe('org-from-wal')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('损坏的 .ldb 不影响同目录的 .log（只跳过该文件）', () => {
    const root = mkdtempSync(join(tmpdir(), 'leveldb-broken-'))
    try {
      const dir = join(root, 'Default', 'Local Storage', 'leveldb')
      mkdirSync(dir, { recursive: true })
      const now = 1_800_000_000
      const jwt = [
        Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
        Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 3600 })).toString('base64url'),
        'sig',
      ].join('.')
      writeFileSync(join(dir, '000005.ldb'), Buffer.alloc(500, 0xaa))
      const wal = [
        '_https://www.letsmagic.cn\x00\x01MAGIC:user:authorization',
        JSON.stringify({ key: 'authorization', value: jwt }),
        '_https://www.letsmagic.cn\x00\x01MAGIC:user:organizationCode',
        JSON.stringify({ key: 'organizationCode', value: 'org-ok' }),
      ].join('\n')
      writeFileSync(join(dir, '000006.log'), Buffer.from(wal, 'latin1'))

      const creds = readMagicrewLocalCreds('www.letsmagic.cn', { roots: [root], now })
      expect(creds?.organizationCode).toBe('org-ok')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
