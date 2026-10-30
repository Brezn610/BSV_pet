# Agent 守门员换汇通道（开发中）

给 AI agent 用的非托管“换币即付款”通道：agent 用一笔交易把 sats 换成商家要的 pUSD（BTMS 代币）并完成付款，做市方提前只签自己那一半，每一笔都先过 agent 钱包里的守门员。

设计文档：<https://claude.ai/artifact/T5b7MCNga2GYVNiGobsY28>。技术事实和出处见 [`docs/verified-facts.md`](./docs/verified-facts.md)。给 AI 编码助手的规则见官方 [`AGENTS.md`](./AGENTS.md)。

> 这个目录暂时放在 `BSV_pet` 仓库里，提交前会搬到独立的公开仓库。提交给评委的 README 会另写英文版。

## 运行

需要 Node.js 22 以上。全部离线，不花真钱。

```sh
cd rail
npm install
npm test               # 离线端到端测试：兑换 11 个、发行 2 个、守门员 3 个
npm run typecheck
npm run spike          # 第二轮审查的 BTMS 兑换实验
```

## 在自己电脑上做主网验证（H0–H4 第 ② ③ 步）

需要 BSV Desktop 在同一台电脑上打开并解锁，钱包里有主网 sats。

```sh
npm run probe:overlay                   # ② 公共 overlay 有没有托管 tm_btms（不花钱）
npm run desktop:check                   # ③ 连 BSV Desktop，检查 p btms 协议和篮子（不花钱）
CONFIRM_MAINNET=1 npm run desktop:maker # ③ 发行 10 pUSD、拆份、等 1 分钟、预签 1 张报价单（花几百 sats）
```

`desktop:check` 如果报 P-module 相关错误，在后两条命令前加上 `TOKEN_PROTOCOL="agent swap token"`，改用自己的协议名，篮子和标签会一起切换。`desktop:maker` 把代币和签好的报价单存到 `data/maker-smoke.json`（已在 `.gitignore` 里），留给下一步主网成交用。

## 主网真实成交一笔（第 ④ 步）

先完成第 ③ 步，`data/maker-smoke.json` 里要有签好的报价单。agent 和商家各用一个服务端钱包（wallet-toolbox + SQLite，经 Arcade 广播），数据库放在 `data/`。

```sh
npm run keys:init                        # 生成 agent 和商家的私钥，写进 .env（不进 git），只打印公钥
CONFIRM_MAINNET=1 npm run agent:fund     # BSV Desktop 用 BRC-29 给 agent 转 20000 sats（FUND_SATS 可改），弹 1 次确认
CONFIRM_MAINNET=1 npm run agent:fill     # agent 经守门员接单付款 → 商家经公共 overlay 验收入账 → BSV Desktop 收款（弹确认）
```

`agent:fill` 分 6 步打印进度，第 4 步会打印守门员交易核对的结果。成交后把进度存到 `data/fill-<报价单>.json`。如果第 5、6 步失败，直接重跑同一条命令，会从成交之后接着做，不会重复付款。`.env` 里是真钱的私钥，别发给任何人，也别贴到聊天里。

再成交一笔：先用剩下的 pUSD 小份预签一张新报价单，再成交。

```sh
npm run desktop:offer                    # 不花钱，BSV Desktop 可能弹 1 次签名确认
CONFIRM_MAINNET=1 npm run agent:fill
```

## 守门员的交易核对层

守门员原来只看到“要付多少 sats”和每项描述。现在 `TxObserver` 夹在权限管理器和真钱包之间，守门员在批准前拿到钱包真正要签的那笔交易，和 agent 事先报备的计划（`swapPayPlan`，由代码从报价单和发票算出来，不由模型写）逐项比对：

- 输入 0 是报价单的代币，做市方的签名原样带上；其余输入只能是普通的钱，不能把 agent 自己的代币当零钱花掉。
- 输出 0 付做市方，金额等于报价；输出 1 是给商家的 pUSD，锁定脚本和发票算出的一模一样；多出来的找零不能是代币。
- 手续费不超过上限（默认 500 sats）。
- 用 BTMS 登记规则预跑这笔真实交易，确认给商家的 pUSD 会被承认，不会被烧掉。

任何一项对不上就拒绝，钱包放弃这笔交易，报价单和 agent 的钱都不动。离线测试里演示了“收款人被调包”被拦下、之后同一张报价单还能正常成交。

## 版本

按 `AGENTS.md` 锁定：`@bsv/sdk` 3.2.1、`@bsv/wallet-toolbox` 2.14.9、`@bsv/overlay` 2.6.4，另加 `@bsv/btms` 1.2.6（支持 sdk 3.x）。`package.json` 用 `overrides` 保证全项目只有一份 sdk 3.2.1。

`@bsv/overlay-topics` 2.0.3 要求 overlay ^2.7.0，和锁定版本冲突，所以 BTMS 登记规则从 ts-stack 源码拷了一份放在 `src/registry/BTMSTopicManager.ts`，逻辑保持和上游一致。

## 目录

| 路径 | 内容 | 状态 |
| --- | --- | --- |
| `src/token/pusd.ts` | pUSD 协议名、篮子和标签开关、单位、给别人公钥锁代币、解码 | 完成 |
| `src/token/issue.ts` | 发行 pUSD（BTMS 格式，跟随协议开关） | 完成，离线测试 |
| `src/token/split.ts` | 把代币拆成刚好的份额（做市方） | 完成，离线测试 |
| `src/swap/offer.ts` | 做市方只签一半的报价单；接单前校验签名；做市方收款 | 完成，离线测试 |
| `src/swap/fill.ts` | agent 一笔交易成交；签名前预跑登记规则 | 完成，离线测试 |
| `src/merchant/invoice.ts` | 商家按单派生收款公钥；验证、登记、入账 | 完成，离线测试 |
| `src/registry/` | 官方 BTMS 登记规则 + 进程内迷你登记处 | 完成 |
| `src/guardian/` | 守门员：规则、Claude 裁判、交易核对层（`txCheck.ts`、`txObserver.ts`） | 完成，离线测试；主网成交已接入 |
| `src/chain/mockChain.ts`、`src/wallet/agentWallet.ts` | 离线链、钱包包装 | 从 BSV_pet 拷贝 |
| `spikes/` | 审查实验和 overlay 探测脚本 | 可运行 |
| `src/chain/serverWallet.ts`、`src/env.ts` | 主网服务端钱包（agent、商家），私钥从 `.env` 读 | 第 ④ 步用 |
| `scripts/` | 连 BSV Desktop 的检查、做市方冒烟测试、agent 充值和主网成交 | ③ ④ 已在主网跑通 |

## 还没做（按设计文档的计划）

主网验证（H0–H4）已全部完成，见 `docs/verified-facts.md` 第 31–42 条。

1. 报价簿服务、商家的 402 HTTP 接口、恶意 API（演示守门员拦截）。
2. 做市方命令行：把 `desktop:maker`、`desktop:offer` 和收款整理成一个工具。
3. agent（Claude）和面板。

## 安全

私钥只放在环境变量里，不进代码和仓库；`.env` 已在 `.gitignore` 里。不向任何人索要私钥或助记词。
