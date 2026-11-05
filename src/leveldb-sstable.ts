/**
 * 极简 **LevelDB SSTable（`.ldb`）读取器 + Snappy 解压** —— 只做一件事：
 * 把 Chromium 系浏览器 `Local Storage/leveldb/*.ldb` 里的记录解出来。
 *
 * ## ═══ 为什么必须有它（真机报障 2026-11-04）═══════════════════════════════
 *
 * 旧实现（`magicrew-local-browser.ts` 的 `leveldbTextForProfile`）把 `.ldb` 直接
 * `readFileSync(...).toString('latin1')` 拼成文本，然后在文本里正则找
 * `"key":"authorization"` —— **永远找不到**，因为：
 *
 * 1. 记录被 LevelDB **按 key 前缀压进 data block**（每条记录只存「与上一条的公共前缀
 *    之后的差异部分」）；
 * 2. 这些 block **整块被 Snappy 压缩**（实测本机 Edge `071584.ldb`：index block 指向
 *    的 60 个 data block，压缩类型**全部**是 `1`）。
 *
 * ⇒ 原始字节里 `"key":"authorization"` 出现 **0 次**（本机实测 `indexOf` 返回 -1）。
 *   更隐蔽的是：**光做前缀还原还不够** —— Snappy 会把 JWT 这种长 base64 串按重复片段
 *   回引（copy tag），所以解压后必须**真正重建**那段字节，单纯的「跳过压缩头再读」也读不全。
 *
 * ## ═══ 只实现「读」需要的那部分 ═══════════════════════════════════════════
 *
 * | 环节 | 本模块 | 说明 |
 * |---|---|---|
 * | Footer / 索引块 | ✅ | 固定 48 字节，末尾 8 字节是 magic |
 * | Data block 解压 | ✅ | 压缩类型 `0`（不压）/ `1`（Snappy） |
 * | 前缀压缩 entry 还原 | ✅ | restart 数组用不上（我们只要**全部**记录，不做点查） |
 * | Bloom filter / Snappy 压缩 | ❌ | 只读一侧，不需要 |
 *
 * ⚠️ **不做安全兜底之外的任何猜测**：magic 不对 / 越界 / 压缩类型未知一律**抛错**，
 * 由调用方决定退化成「这个文件读不了」（见 `magicrew-local-browser.ts` 的
 * `sstableTextFor`）——**绝不**返回半截数据，那会让「读到了但配错」比「读不到」难查得多。
 *
 * ⚠️ **只读**：本模块不写任何文件。
 */

/**
 * 一条 LevelDB 记录（key / value 都是原始字节）。
 *
 * ## ⚠️⚠️ `sequence` / `deleted` 是 2026-11-05 返工新增的（P2-2 / P2-3）
 *
 * LevelDB 的 internal key = `user_key || (seq<<8 | type)`。同一 user key 的**多次
 * 写入**会同时留在磁盘上（旧值在 `.ldb`、新值/tombstone 在 `.log` WAL），必须按
 * **sequence 取最新**、并把 `type === 0`（删除标记）当成「该 key 不存在」。
 * 不这样做就会：
 * - 复活已登出的组织（旧 org 比 tombstone 还早）；
 * - 先登出再登录时漏读（`.log` 是写入序，旧在前，配到空值就放弃）。
 *
 * ⚠️ 人造记录（单测直接构造 / 非 LevelDB 来源）可以**缺省**这两个字段，
 * 此时 {@link leveldbVisibleRecords} 原样保留、不做去重。
 */
export interface LeveldbRecord {
  /** 原始 key（**不含** internal key 尾部 8 字节；`latin1` 才能无损取回）。 */
  readonly key: Buffer
  /** 原始 value。 */
  readonly value: Buffer
  /** LevelDB sequence（越大越新）；人造记录可缺省。 */
  readonly sequence?: number
  /** 是否为删除标记（internal key type `0` = tombstone）。 */
  readonly deleted?: boolean
}

/** LevelDB SSTable footer 的固定长度。 */
const FOOTER_SIZE = 48

/**
 * 单个 block **解压后**允许的最大字节数（拒绝病态声明）。
 *
 * ## ⚠️⚠️ 为什么必须有它（2026-11-05 审计 P1）
 *
 * Snappy 流的第一个字段是 `varint32 解压后长度`，而旧实现只校验「非负安全整数」
 * 就 `Buffer.alloc(expected)` —— **在解析任何 tag 之前**。于是**任意 5 个字节**
 *（`80 80 80 80 08` = `2^31`）就能让进程先申请 **2 GiB** 外部内存、再因为
 * 「产出与声明不符」抛错（错误被 `leveldbTextForFile` 吞掉，内存却已经付出）。
 * 损坏/半写的 `.ldb` 是**真实会发生的**（浏览器崩溃、断电、并发压实），
 * 这不是理论攻击面。
 *
 * LevelDB 默认 `block_size = 4 KiB`。**本机 5 个真实 Edge `.ldb` 实测**：最大块
 * **39 846 B**（p50 5 172 B）⇒ 取 **8 MiB**（真实最大块的 **~200 倍**）已极宽，
 * 正常文件永远碰不到；一旦越过就说明这个块已损坏，直接 fail-closed 比「先分配
 * 再报错」安全。
 *
 * ⚠️ 为什么不是 64 MiB（2026-11-05 对抗审计 P3-2）：上限越宽，一个**合法但恶意**
 * 的块能放大的内存越大（100k 条记录 ≈ 34 MiB heap，358 B/条 ⇒ 64 MiB 块外推
 * ~5.6 GiB）。8 MiB 仍给「单 record 很大」留足余量，同时把放大面压到可控。
 */
const MAX_DECOMPRESSED_BLOCK_BYTES = 8 * 1024 * 1024

/**
 * SSTable 文件末尾的 magic（小端 `0xdb4775248b80fb57`）。
 *
 * ⚠️ 校验它**不是**洁癖：不校验就会把「随便一个文件」当成 SSTable 去解，
 * 越界读出来的垃圾字节可能恰好凑出 `eyJ…` 形状，那是**编造凭据**。
 */
const FOOTER_MAGIC = Buffer.from([0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb])

/**
 * 读一个 varint（32/64 位共用；LevelDB 的 varint32 与 varint64 编码同形）。
 *
 * @param buf 缓冲
 * @param pos 起始位置
 * @returns 值与下一个字节位置
 * @throws 越过末尾 / 超过 64 位（说明这个文件不是我们要的格式）
 */
export function readVarint(buf: Buffer, pos: number): { value: number, next: number } {
  let value = 0
  let shift = 0
  let at = pos
  for (;;) {
    if (at >= buf.length) throw new Error('leveldb: varint 越过文件末尾')
    const byte = buf[at] as number
    at += 1
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return { value, next: at }
    shift += 7
    if (shift > 63) throw new Error('leveldb: varint 超过 64 位')
  }
}

/**
 * 解压一段 **Snappy 原始格式**（`snappy::Compress` 的输出，**不带** framed 的
 * `sNaPpY` 流头）。
 *
 * 格式：`varint32 解压后长度` + 若干个 tag：
 *
 * | tag 低 2 位 | 含义 | 长度 | 偏移 |
 * |---|---|---|---|
 * | `00` | literal | `(tag>>2)+1`；`tag>>2 >= 60` 时再读 `tag>>2-59` 字节小端 = 长度-1 | — |
 * | `01` | copy，1 字节偏移 | `4 + ((tag>>2)&7)` | `(tag>>5)<<8 \| 下一字节` |
 * | `10` | copy，2 字节偏移 | `(tag>>2)+1` | 2 字节小端 |
 * | `11` | copy，4 字节偏移 | `(tag>>2)+1` | 4 字节小端 |
 *
 * ⚠️ **copy 必须逐字节前向复制**（`out[written] = out[written - offset]`，**不能**用
 * `Buffer.copy`）：Snappy 允许 `offset < length`，此时源区间会**边写边长**
 * （典型的 RLE 用法）。用 `copy` 一次拷一段会读到还没写出来的字节 ⇒ 输出错位，
 * 而错位后的数据仍然「看起来像文本」，极难发现。
 *
 * @throws 任何越界 / 非法偏移（不产出半截结果）
 */
export function snappyDecompress(input: Buffer): Buffer {
  const declared = readVarint(input, 0)
  const expected = declared.value
  if (expected < 0 || !Number.isSafeInteger(expected)) throw new Error('snappy: 非法长度')
  // ⚠️ 必须在 `Buffer.alloc` **之前**判上限：病态声明先分配会真吃掉 2 GiB（见常量注释）。
  if (expected > MAX_DECOMPRESSED_BLOCK_BYTES) {
    throw new Error(
      `snappy: 声明长度 ${expected} 超过上限 ${MAX_DECOMPRESSED_BLOCK_BYTES}（块已损坏）`,
    )
  }
  const out = Buffer.alloc(expected)
  let at = declared.next
  let written = 0
  while (at < input.length) {
    const tag = input[at] as number
    at += 1
    const kind = tag & 0x03
    if (kind === 0) {
      const sizeTag = tag >> 2
      let run: number
      if (sizeTag < 60) {
        run = sizeTag + 1
      } else {
        const extraBytes = sizeTag - 59
        if (at + extraBytes > input.length) throw new Error('snappy: literal 长度越界')
        let raw = 0
        for (let index = 0; index < extraBytes; index += 1) {
          raw += (input[at + index] as number) * 2 ** (8 * index)
        }
        at += extraBytes
        run = raw + 1
      }
      if (at + run > input.length) throw new Error('snappy: literal 数据越界')
      if (written + run > expected) throw new Error('snappy: literal 超出声明长度')
      input.copy(out, written, at, at + run)
      at += run
      written += run
      continue
    }
    let run: number
    let offset: number
    if (kind === 1) {
      if (at + 1 > input.length) throw new Error('snappy: copy1 越界')
      run = 4 + ((tag >> 2) & 0x07)
      offset = ((tag >> 5) << 8) | (input[at] as number)
      at += 1
    } else if (kind === 2) {
      if (at + 2 > input.length) throw new Error('snappy: copy2 越界')
      run = (tag >> 2) + 1
      offset = input.readUInt16LE(at)
      at += 2
    } else {
      if (at + 4 > input.length) throw new Error('snappy: copy4 越界')
      run = (tag >> 2) + 1
      offset = input.readUInt32LE(at)
      at += 4
    }
    if (offset === 0 || offset > written) throw new Error('snappy: copy 引用了尚未产出的字节')
    if (written + run > expected) throw new Error('snappy: copy 超出声明长度')
    for (let index = 0; index < run; index += 1) {
      out[written + index] = out[written + index - offset] as number
    }

    written += run
  }
  if (written !== expected) throw new Error('snappy: 实际产出与声明长度不符')
  return out
}

/**
 * 读一个 block handle（`varint 偏移` + `varint 长度`）。
 *
 * @returns 偏移 / 长度 / 下一个字节位置
 */
function readHandle(buf: Buffer, pos: number): { offset: number, size: number, next: number } {
  const offset = readVarint(buf, pos)
  const size = readVarint(buf, offset.next)
  return { offset: offset.value, size: size.value, next: size.next }
}

/**
 * 取一个 block 的**明文**（按 trailer 里的压缩类型解压）。
 *
 * ⚠️ 压缩类型那 1 字节在 `offset + size`（**不在** block 内容里），紧跟其后还有 4 字节
 * CRC —— 本模块**不校验 CRC**：CRC 用的是 LevelDB 自带的 crc32c 掩码变体，为一个只读
 * 读取器实现一份纯 JS crc32c 不值得；magic + 长度 + varint 三重边界检查已经能挡住
 * 「把别的文件当 SSTable 解」这种误用。
 */
function readBlock(buf: Buffer, offset: number, size: number): Buffer {
  if (offset < 0 || size < 0 || offset + size + 1 > buf.length) {
    throw new Error('leveldb: block handle 越界')
  }
  const raw = buf.subarray(offset, offset + size)
  const compression = buf[offset + size]
  if (compression === 0) return raw
  if (compression === 1) return snappyDecompress(raw)
  throw new Error(`leveldb: 不支持的 block 压缩类型 ${String(compression)}`)
}

/**
 * 还原一个 block 里的**全部** entry（前缀压缩还原）。
 *
 * entry 布局：`varint shared` + `varint nonShared` + `varint valueLen` +
 * `keyDelta[nonShared]` + `value[valueLen]`，其中真正的 key = 上一条 key 的前
 * `shared` 字节 + `keyDelta`。
 *
 * ⚠️ restart 数组**只用来跳过**（`block.length - 4 - numRestarts*4` 就是 entry 区末尾）：
 * 我们不做点查，逐条顺序还原比按 restart 分段更简单，且不会漏掉任何一条。
 */
export function parseBlockEntries(block: Buffer): LeveldbRecord[] {
  if (block.length < 4) throw new Error('leveldb: block 太短')
  const restarts = block.readUInt32LE(block.length - 4)
  const end = block.length - 4 - restarts * 4
  if (end < 0) throw new Error('leveldb: restart 数组越界')
  const out: LeveldbRecord[] = []
  let key = Buffer.alloc(0)
  let at = 0
  while (at < end) {
    const shared = readVarint(block, at)
    const nonShared = readVarint(block, shared.next)
    const valueLength = readVarint(block, nonShared.next)
    at = valueLength.next
    if (shared.value > key.length) throw new Error('leveldb: entry 公共前缀超过上一条 key')
    if (at + nonShared.value + valueLength.value > end) throw new Error('leveldb: entry 越界')
    key = Buffer.concat([
      key.subarray(0, shared.value),
      block.subarray(at, at + nonShared.value),
    ])
    at += nonShared.value
    out.push({ key, value: block.subarray(at, at + valueLength.value) })
    at += valueLength.value
  }
  return out
}

/**
 * 读出一个 `.ldb` 文件里的**全部**记录（按 key 升序，与 LevelDB 一致）。
 *
 * ## ⚠️ 只走索引块，**不扫** metaindex
 *
 * metaindex 里放的是 filter block 之类的元数据，与记录无关 —— 扫它只会多解一份无用数据。
 *
 * @throws 文件不是 SSTable（magic 不符）/ 结构损坏 —— 由调用方决定降级还是当作没读到
 */
export function readSstableRecords(file: Buffer): LeveldbRecord[] {
  if (file.length <= FOOTER_SIZE) throw new Error('leveldb: 文件太短，不是 SSTable')
  if (!file.subarray(file.length - 8).equals(FOOTER_MAGIC)) {
    throw new Error('leveldb: SSTable magic 不匹配')
  }
  const footerAt = file.length - FOOTER_SIZE
  // footer 里先是 metaindex handle，第二个才是 index handle。
  const metaindex = readHandle(file, footerAt)
  const index = readHandle(file, metaindex.next)
  const out: LeveldbRecord[] = []
  for (const entry of parseBlockEntries(readBlock(file, index.offset, index.size))) {
    const handle = readHandle(entry.value, 0)
    // ⚠️ 不要用 `out.push(...entries)`：块里记录数到 ~12.8 万时 V8 会抛
    //    `RangeError: Maximum call stack size exceeded`，被上层 `catch` 吞成
    //    「整份 .ldb 跳过」（2026-11-05 对抗审计 P3-1）。
    for (const record of parseBlockEntries(readBlock(file, handle.offset, handle.size))) {
      out.push(splitInternalKey(record))
    }
  }
  return out
}

/**
 * 把一条 **internal key** 拆成「user key + sequence + 删除标记」。
 *
 * LevelDB 的 internal key = `user_key || (seq << 8 | type)`（8 字节小端）。
 * `type` 只有两种：`1` = value、`0` = 删除标记（tombstone）。
 *
 * ⚠️ 未知 `type` 一律抛错（不猜）：把 `2` 当成 value 会静默产出错误记录。
 */
function splitInternalKey(record: LeveldbRecord): LeveldbRecord {
  const internal = record.key
  if (internal.length < 8) {
    throw new Error(`leveldb: internal key 只有 ${internal.length} 字节（短于 8 字节尾部）`)
  }
  const raw = internal.readBigUInt64LE(internal.length - 8)
  const type = Number(raw & 0xffn)
  if (type !== 0 && type !== 1) throw new Error(`leveldb: 未知 internal key 类型 ${type}`)
  return {
    key: internal.subarray(0, internal.length - 8),
    value: record.value,
    sequence: Number(raw >> 8n),
    deleted: type === 0,
  }
}

/**
 * 按 user key 取**最新**那条记录，并丢掉 tombstone（= 该 key 已删除）。
 *
 * ## ⚠️⚠️ 为什么必须在**跨文件**层面做（2026-11-05 返工 P2-2 / P2-3）
 *
 * LevelDB 的 `.ldb`（压实后的 SSTable）与 `.log`（WAL 尾写）共用**同一个 sequence
 * 空间**，同一条 localStorage key 的多次写入可以横跨两者：
 *
 * | 形态 | 正确结果 | 不去重的后果 |
 * |---|---|---|
 * | 旧值在 `.ldb`、新值在 `.log` | 用新值 | 先登出再登录 ⇒ 配到空值/旧值 ⇒ **漏读** |
 * | 旧值在 `.ldb`、tombstone 在 `.log` | 该 key 不存在 | 复活已登出组织（200 + code:403） |
 * | 同一 `.ldb` 内新旧两版 | 用 seq 大的 | 取决于块内顺序 |
 *
 * ⇒ 收集**全部文件**的记录后统一去重；没有 `sequence` 的人造记录原样保留
 * （单测直接构造文本的路径不受影响）。
 *
 * ⚠️ 顺序：按**首次出现**的顺序输出（`Map` 保持插入序），保证同一份数据渲染稳定
 * —— 否则 `credsNear` 的「jwt 配它后面最近的 org」会随 Map 哈希顺序抖动。
 */
export function leveldbVisibleRecords(records: readonly LeveldbRecord[]): LeveldbRecord[] {
  const latest = new Map<string, LeveldbRecord>()
  for (const record of records) {
    if (record.sequence === undefined) {
      // 人造记录：用「唯一键」占位，保证原样保留且顺序稳定。
      latest.set(`\u0000raw:${latest.size}`, record)
      continue
    }
    const id = record.key.toString('latin1')
    const previous = latest.get(id)
    if (previous === undefined || (previous.sequence ?? -1) < record.sequence) {
      latest.set(id, record)
    }
  }
  return [...latest.values()].filter((record) => record.deleted !== true)
}

/** leveldb WAL（`.log`）的 record 头长度：`crc32(4) + length(2) + type(1)`。 */
const WAL_HEADER_SIZE = 7

/** leveldb WAL 里 `type` 的取值（只认整条 `FULL`）。 */
const WAL_FULL_RECORD = 1

/** WriteBatch 头：`seq(8) + count(4)`。 */
const WRITE_BATCH_HEADER_SIZE = 12

/**
 * 解析 leveldb **WAL**（`.log`）里的 WriteBatch 记录。
 *
 * 格式（`leveldb/db/write_batch.cc` + `log_writer.cc`）：
 *
 * ```
 * WAL record: crc32(4) | length(2 LE) | type(1) | payload[length]
 * payload   : seq(8 LE) | count(4 LE) | count × entry
 * entry     : kind(1) | varint keyLen | key | [varint valueLen | value]   // kind 1 = put
 * entry     : kind(1) | varint keyLen | key                              // kind 0 = delete
 * ```
 *
 * @returns 记录数组；**不是**合法 WAL 时返回 `undefined`（调用方退回「原文扫描」）。
 *
 * ⚠️ 任何一步越界/未知 kind/分片记录（`FIRST`/`MIDDLE`/`LAST`）都返回
 * `undefined` —— 宁可退回原文扫描（本文件其它 `.log` 的既有行为），也不要
 * 产出半截记录（那会静默改变配对结果）。
 */
export function readWalRecords(input: Buffer): LeveldbRecord[] | undefined {
  const records: LeveldbRecord[] = []
  let at = 0
  try {
    while (at + WAL_HEADER_SIZE <= input.length) {
      const length = input.readUInt16LE(at + 4)
      const type = input[at + 6]
      const payloadStart = at + WAL_HEADER_SIZE
      if (length === 0 || type !== WAL_FULL_RECORD || payloadStart + length > input.length) {
        return undefined
      }
      const payload = input.subarray(payloadStart, payloadStart + length)
      at = payloadStart + length
      if (payload.length < WRITE_BATCH_HEADER_SIZE) return undefined
      const baseSequence = payload.readBigUInt64LE(0)
      const count = payload.readUInt32LE(8)
      if (count > 1_000_000) return undefined
      let position = WRITE_BATCH_HEADER_SIZE
      for (let index = 0; index < count; index += 1) {
        const kind = payload[position]
        position += 1
        if (kind !== 0 && kind !== 1) return undefined
        const keyLength = readVarint(payload, position)
        position = keyLength.next
        const keyEnd = position + keyLength.value
        if (keyEnd > payload.length) return undefined
        const key = payload.subarray(position, keyEnd)
        position = keyEnd
        const sequence = Number(baseSequence + BigInt(index))
        if (kind === 0) {
          records.push({ key, value: Buffer.alloc(0), sequence, deleted: true })
          continue
        }
        const valueLength = readVarint(payload, position)
        position = valueLength.next
        const valueEnd = position + valueLength.value
        if (valueEnd > payload.length) return undefined
        records.push({
          key,
          value: payload.subarray(position, valueEnd),
          sequence,
          deleted: false,
        })
        position = valueEnd
      }
    }
  } catch {
    return undefined
  }
  return records.length > 0 ? records : undefined
}

/**
 * 把 Chromium `Local Storage` 的 value 解成字符串。
 *
 * Chromium 在这个库里给每个 value 加了 **1 字节编码头**（实测本机 Edge）：
 *
 * | 头字节 | 载荷 |
 * |---|---|
 * | `0x00` | UTF-16LE（`MAGIC:user:userInfo` 就是这种） |
 * | `0x01` | Latin-1（`MAGIC:user:authorization` / `organizationCode` 是这种） |
 *
 * ⚠️ 没有这两种头的 value **不猜**：整段按 latin1 原样返回。丢掉这层会导致
 * UTF-16 的 value 里每个字符之间都夹一个 `\x00`（正则全部失效）。
 */
function decodeValue(value: Buffer): string {
  if (value.length === 0) return ''
  const encoding = value[0]
  if (encoding === 0x00) return value.subarray(1).toString('utf16le')
  if (encoding === 0x01) return value.subarray(1).toString('latin1')
  return value.toString('latin1')
}

/**
 * 把记录渲染成**可供 `credsNear` 检索的文本**。
 *
 * 形态与「未压缩 leveldb 的原始字节」对齐：`<带 origin 前缀的 key>\n<value>`。
 * 之所以仍然产出文本、而不是直接产出结构化的 `{jwt, organizationCode}`：
 * `credsNear` 的「按 origin 截断 + jwt 配它自己后面最近的 org」那套配对纪律
 * （见 `magicrew-local-browser.ts`）已经在 888 行单测里钉死，换数据源不该重写它。
 *
 * ⚠️ key 用 **latin1** 取回：`_https://…\x00\x01<name>\x01<8 字节序号>` 里既有
 * `\x00`/`\x01` 也有二进制序号，utf8 解码会把非法字节换成 `U+FFFD`（→ `\uFFFD`），
 * 而 `ORIGIN_RE` 依赖 `\x00\x01` 这两个**原字节**做边界。
 */
export function leveldbRecordsText(records: readonly LeveldbRecord[]): string {
  const parts: string[] = []
  for (const record of records) {
    parts.push(record.key.toString('latin1'), decodeValue(record.value))
  }
  return parts.join('\n')
}
