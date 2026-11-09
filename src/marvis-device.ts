/**
 * Marvis 的设备 guid。
 *
 * ## 为什么每次登录都**新造**一个随机 guid
 *
 * Marvis 的 access token 与**设备 guid 绑定**（`Ual-Access-Guid` 是登录态校验
 * 的一部分）。若所有账号共用本机 guid，「登录第二个 QQ 号」会让第一个号的
 * token 立刻失效 —— 用户看到的是「刚登好的号又掉了」。⇒ 每次登录新造一个
 * 随机 guid，让每个账号各自拥有一个虚拟设备。
 *
 * ## 为什么**不**读本机 svid
 *
 * 读过一版 `HKCU\SOFTWARE\Tencent\Marvis\Env\svid` + `md5(host|user|marvis)`
 * 的「稳定设备 id」，但它在产品上**没有落点**：多账号场景下共用本机 svid 正是
 * 上面那个顶号问题，而「从桌面客户端导入」这条路径我们只导凭据、不导设备身份。
 * ⇒ 2026-11-09 整支评审 M1：整段删除（含 16 条只守护不可达代码的用例），
 * 只留真正在用的随机 guid。
 *
 * @module src/marvis-device.ts
 */

import { randomBytes } from 'node:crypto'

/** 新设备 guid（32 位小写 hex，与 Marvis 自己签发的 svid 同形）。 */
export function newMarvisDeviceGuid(): string {
  return randomBytes(16).toString('hex')
}
