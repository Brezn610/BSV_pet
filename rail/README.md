# Agent 守门员换汇通道（开发中）

给 AI agent 用的非托管“换币即付款”通道：agent 用一笔交易把 sats 换成商家要的 pUSD（BTMS 代币）并完成付款，做市方提前只签自己那一半，每一笔都先过 agent 钱包里的守门员。

设计文档：<https://claude.ai/artifact/T5b7MCNga2GYVNiGobsY28>。技术事实和出处见 [`docs/verified-facts.md`](./docs/verified-facts.md)。给 AI 编码助手的规则见官方 [`AGENTS.md`](./AGENTS.md)。

> 这个目录暂时放在 `BSV_pet` 仓库里，提交前会搬到独立的公开仓库。提交给评委的 README 会另写英文版。

## 运行

需要 Node.js 22 以上。全部离线，不花真钱。

```sh
cd rail
npm install
npm test               # 离线端到端测试：兑换 7 个、发行 2 个、守门员 3 个
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
| `src/guardian/` | 从 BSV_pet 移植的守门员 | 锁定版本下测试通过；交易核对层待做 |
| `src/chain/mockChain.ts`、`src/wallet/agentWallet.ts` | 离线链、钱包包装 | 从 BSV_pet 拷贝 |
| `spikes/` | 审查实验和 overlay 探测脚本 | 可运行 |
| `scripts/` | 在自己电脑上连 BSV Desktop 的检查和做市方冒烟测试 | 待在本地运行 |

## 还没做（按设计文档的计划）

1. 主网验证：BSV Desktop 是否有 BTMS 权限模块（`p btms`），主网公共 overlay 是否托管 `tm_btms`。没有模块就设 `TOKEN_PROTOCOL` 换成自己的协议名。
2. 守门员的交易核对层：解析实际交易，和 agent 报备的结构化意图逐项比对，接上 `previewFill` 和 `checkOffer`。
3. 报价簿服务、商家的 402 HTTP 接口、恶意 API。
4. 做市方命令行脚本：用 `WalletClient('auto', '<域名>')` 连 BSV Desktop 拆份、签单、收款。
5. agent（Claude）、面板、主网服务端钱包配置。

## 安全

私钥只放在环境变量里，不进代码和仓库；`.env` 已在 `.gitignore` 里。不向任何人索要私钥或助记词。
