# 跨插件余额服务

本改动为 Usage Stats 的 PR #144 提供宿主侧配套。服务只返回余额和额度包，凭据解析、供应商协议、自愈与缓存仍由 Providers Hub 的既有余额路径负责。

## 接口

宿主在 connection 服务就绪后注册一个 `creditBalance` 实例；connection 移除时由 Cordis 撤销，重新挂载后创建新实例。

```ts
ctx.creditBalance.supportedProviders()
// Array<{ id: string; displayName: string }>

await ctx.creditBalance.creditsBalances(providerId)
// { accounts: PublicCreditAccount[] }
```

类型定义见 `src/credit-balance-service.ts`。清单从真实 registry 派生，并排除 OpenCode：它在本插件里的数字表示本地可用通道数，不能当成 Go 订阅剩余额度。

## 读数语义

- `balance.total` 是当前剩余额度，不是百分比分母；包的 `total` 与 `used` 才能用于消费百分比。
- 零余额仍是成功读数；缺少余额、坏数值、单号失败和旧读数不伪装成零。
- 部分账号失败不会遮住其他账号的余额。旧读数标记为 `stale: true`，投影不把它当成新余额返回。
- 账号 ID 与昵称换成本次响应内的序号。凭据、原始账号记录、RPC 错误、私有附加字段不跨服务边界。
- 供应商未知或不支持余额时，在读取之前以 `UnsupportedProviderError` 拒绝。
- 服务不签到、不选择默认账号、不实现自己的登录或续期；正常余额查询仍可能触发宿主既有的凭据自愈及缓存写入。
- 原生 MiniMax API Key 路由与 Providers Hub 的 MiniMax Code 账号池不是同一个账户；消费方不得按名字覆盖原生路由。

## 验证

```sh
pnpm run build:all
pnpm exec vitest run tests/unit/credit-balance-service.spec.ts tests/unit/credit-balance-wiring.spec.ts

# 在 Usage Stats 的 PR #144 分支中，指向本仓库的已构建目录：
node scripts/test-providers-hub-integration.mjs /absolute/path/to/dsh-providers-hub
```

最后一项使用真实 Cordis、真实余额分派和真实 Usage Stats 消费/缓存/导出，只把供应商取数替换成合成读数。它不会访问真实账户或供应商网络，不能替代真实控制台对账。

## 交付边界

当前配套基于官方 Gitee 提交 `4c428487bd75e0a02d7b4faa789e456ff44955e0`。本地候选包供隔离验证，尚不代表上游已合并或 npm 已发布此服务。正式支持仍需上游发布含此服务的版本，并用明确选择的真实账户核对余额、额度包和到期时间。
