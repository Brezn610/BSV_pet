# BSV 技术栈核实清单

这份清单记录方案依赖的技术事实。每条都要有出处，并标明核实程度。
没有出处的说法不能当作设计依据。

## 资料优先级

1. 官方开发者包：`START-HERE.md`、`AGENTS.md`、`TBC26_BSV_Track_Requirements.pdf`。已收到。
2. 本地 ts-stack 源码：`/home/user/bsv_hackathon/packages/**`，包括源码、测试和文档。
   它的版本和 BSV_pet 安装的完全一致：sdk 4.0.1、wallet-toolbox 2.15.1、402-pay 0.3.5、overlay-topics 2.0.3、btms 1.2.6。
3. `BSV_STACK_COMPLETE_GUIDE.md`（Axel 发的指南）。
4. 记忆。只能用来提出假设，不能当结论。

## 标记

| 标记 | 含义 |
| --- | --- |
| 实测 | 在离线链上跑过实验或测试 |
| 源码 | 读过源码，给出了 文件:行 |
| 文档 | 只在 README 或指南里看到，没看源码 |
| 假设 | 还没核实 |

## 已核实的事实

| # | 事实 | 标记 | 出处 |
| --- | --- | --- | --- |
| 1 | SDK 的 PushDrop 解锁器原生支持“只签一半”：`unlock(protocolID, keyID, counterparty, signOutputs: 'single', anyoneCanPay: true, …)`，由钱包签名，不用自己算待签名摘要 | 源码 | `sdk/src/script/templates/PushDrop.ts:213-231` |
| 2 | BTMS（Basic Token Management System）是 BSV 官方的同质化代币库，README 写明“做代币应用首选这个包”。代币是 3 字段的 PushDrop：资产 ID、数量、元数据 | 文档 | `wallet/btms/README.md` |
| 3 | BTMS 的代币校验规则：同一资产的输出总量不能超过输入总量，元数据必须一致 | 文档 | `wallet/btms/README.md`；校验源码在 `overlays/topics/src/btms/BTMSTopicManager.ts:241`，待细读 |
| 4 | BTMS 通过 `networkPreset`（`mainnet` / `testnet` / `local`）连接公共 overlay 网络（`TopicBroadcaster`、`LookupResolver`，topic 为 `tm_btms`）。可能不需要自己搭登记处 | 源码 | `wallet/btms/src/BTMS.ts:141,1053,1617`；`constants.ts:15` |
| 5 | BTMS 已经定义了原子兑换用的 `MarketplaceListing` 和 `MarketplaceOffer` 类型，注释写着 future use，也就是**官方规划了但还没实现** | 源码 | `wallet/btms/src/types.ts:542-580` |
| 6 | BTMS 有钱包权限模块，可以挂到 `WalletPermissionsManager` 上，对代币的使用、转账、销毁弹窗确认 | 文档 | `wallet/btms-permission-module/README.md` |
| 7 | `@bsv/amountinator` 能按实时汇率在 sats 和法币之间换算 | 文档 | `helpers/amountinator/README.md` |
| 8 | 比赛页面给的资料是 BSV-21 代币规范、BananaBlocks 代币浏览器，以及带 38 个测试的 BSV-21 入门工具包 | 文档 | 比赛页面截图 |
| 9 | BSV-21 不受矿工检查，代币真伪由 overlay 判断。工具包的签名代码是 `TransactionSignature.format` 加上 `createSignature({hashToDirectlySign})`，签名范围固定为 `SIGHASH_ALL` | 文档 | 指南 §15、§16.2、§18；附录 A `client/signer.ts` |

## 独立审查的实验结果

实验代码在 `scratchpad/swap-review/spike.test.ts`，13 个测试全部通过，用的是真实的 wallet-toolbox 钱包，跑在离线链上。

| # | 事实 | 标记 | 出处 |
| --- | --- | --- | --- |
| 10 | 原子兑换端到端可行：做市方“只签一半”，接单方用一次 `createAction` 带上这个输入完成交易并广播；做市方实收 5000 sats，接单方付 5001（含 1 sat 手续费） | 实测 | `spike.test.ts` |
| 11 | 篡改都会失败：少付 1 sat、改收款人、调换输出顺序、不关 `randomizeOutputs`，4 种篡改全部在广播前被钱包拒绝；同一张报价单用两次会被判为双花 | 实测 | `spike.test.ts` |
| 12 | 钱包先放调用方给的输入，再追加自己的输入，不会重排；只要 `randomizeOutputs:false`，输出也不会被打乱 | 源码 | `wallet-toolbox/src/storage/methods/createAction.ts:936-941,741-745`；`signer/methods/buildSignableTransaction.ts:116-131,169-192` |
| 13 | **默认路径下，兑换失败会锁住 agent 的币，而且无法撤销。** 走 `WalletPermissionsManager`，或者设 `signAndProcess:false` 并在出错时调用 `abortAction`，就不会锁 | 实测 | `Wallet.ts:1153-1222`；`WalletPermissionsManager.ts:4441,4520,4549` |
| 14 | **官方的 BSV-21 校验规则（`tm_bsv21`）会认可凭空造出来的假 pUSD**，入门工具包的规则则会拒绝它 | 实测 | `overlays/topics/src/shared/BaseTokenTopicManager.ts:35,45-52`；`bsv21/Bsv21TopicManager.ts:42-56` |
| 15 | BTMS 的校验规则是对的：没有合法输入支撑的输出一律不认 | 源码 | `overlays/topics/src/btms/BTMSTopicManager.ts:175` |
| 16 | 守门员回调只能看到 sats 金额，以及 agent 自己写的描述，看不到代币 ID、代币数量和收款人 | 实测 | `WalletPermissionsManager.ts:4776-4835` |
| 17 | 做市方签名时，对应位置上必须已经有付给自己的那一行；否则签名不覆盖任何输出，代币会被别人白拿 | 实测 | `sdk/src/primitives/TransactionSignature.ts:223-227` |
| 18 | `@bsv/402-pay` 只支持 sats 付款，用代币付费要自己写 402 流程 | 源码 | `middleware/402-pay/src/server.ts:307-315` |
| 19 | 官方技术栈里没有挂单市场或兑换代码；1Sat 的 OrdLock 模板只适用于 NFT，不能直接拿来做同质化代币 | 源码 | `helpers/bsv-wallet-helper/src/script-templates/ordlock.ts:189` |
| 20 | 备选方案“做市方在线、双方当场一起签”也能跑通，但待签交易只存在内存里，接单方的币在等待期间会被占着 | 实测 | `spike.test.ts`；`Wallet.ts:1237` |

## 来自官方开发者包

| # | 事实 | 标记 | 出处 |
| --- | --- | --- | --- |
| 21 | 官方锁定版本：`@bsv/sdk` 3.2.1、`@bsv/wallet-toolbox` 2.14.9、`@bsv/overlay` 2.6.4、`@bsv/overlay-express` 2.7.4、`@bsv/auth-express-middleware` 2.2.9、`@bsv/payment-express-middleware` 2.1.9、`@bsv/402-pay` 0.3.3。BSV_pet 和本地 ts-stack 源码用的版本都比这新 | 文档 | `AGENTS.md` 版本表 |
| 22 | `@bsv/btms` 1.2.4 及以后的版本支持 sdk `^3.0.0`，可以和锁定版本一起用 | 实测 | `npm view @bsv/btms peerDependencies` |
| 23 | 兑换实验在锁定版本下重跑，13 个测试全部通过，结论和新版本一致，包括失败时锁币、假币被官方 BSV-21 规则承认 | 实测 | `scratchpad/spike-pinned/out.txt` |
| 24 | 评分权重：采用潜力和实际用处 35%，BSV 技术栈的使用 25%，技术实现（含非托管设计）20%，agent 付款 10%，原创性和展示 10%。官方原话：“只有能跑的代码是不够的”，最好能从其他链带来新用户或流动性 | 文档 | 比赛要求 PDF 第 4 页 |
| 25 | 官方示例方向：非托管跨链桥，把 USDT/USDC 带到 BSV（例如用 ICP 的 chain-key）；交易跨链资产的订单簿 DEX 或兑换；用跨链稳定币募资的启动平台；跨链资金流 | 文档 | 比赛要求 PDF 第 2 页 |
| 26 | 官方给每队发主网 sats：在 BSV Desktop 里复制收款地址，连同队名私信 Telegram @lexamaison。钱包请建在主网上 | 文档 | `START-HERE.md` §2 |
| 27 | 演示视频时长：PDF 写 2–3 分钟，网页写不超过 2.5 分钟。按 2.5 分钟以内准备 | 文档 | PDF 第 3 页；网页截图 |
| 28 | `AGENTS.md` 规则：资金和代币不能锁在身份公钥上，一律锁在派生密钥上；控制资产的密钥用安全级别 1 或以上；代币不能放进 `default` 篮子；只花 overlay 验证过的代币 | 文档 | `AGENTS.md` |

## 主网实测（在使用者电脑上）

| # | 事实 | 标记 | 出处 |
| --- | --- | --- | --- |
| 29 | 主网公共 overlay 托管 BTMS：SLAP 目录里 2 个节点提供 `ls_btms`，SHIP 目录里 2 个节点接收 `tm_btms`，查询 `ls_btms` 返回 32 条记录。测试网没有。风险 R2 解除，直接用公共登记处 | 实测 | `npm run probe:overlay`，2026-10-30 |
| 30 | 使用者的 BSV Desktop 为 3.3.1，主网，余额 1,000,000 sats（官方发放） | 实测 | BSV Desktop 截图，2026-10-30 |
| 31 | WSL2 打开镜像网络（`.wslconfig` 里 `networkingMode=mirrored`）后，WSL 里的程序能连到 Windows 上 BSV Desktop 的 `localhost:3321`（空请求返回 400） | 实测 | 使用者电脑，WSL 2.7.11，2026-10-30 |
| 32 | 使用者的 BSV Desktop 3.3.1 能处理 BTMS：`getPublicKey` 用 `[0,'p btms']` 成功，`listOutputs` 查 `p btms` 篮子成功，没有 P-module 报错。签单时的弹窗次数和 60 秒限制待 `desktop:maker` 验证 | 实测 | `npm run desktop:check`，2026-10-30 |
| 33 | 做市方冒烟测试在主网上跑通：用 BSV Desktop 发行 10 pUSD（`7715fbf4…13db8fe`）、拆成 1+1+1+7（`e95cc1cb…a9487985`），本地登记规则都承认；等 61 秒后通过 `WalletClient` 用 `PushDrop.unlock('single', true)` 预签报价单成功，`checkOffer` 通过。弹窗出现了几次，使用者没有计数 | 实测 | `npm run desktop:maker`，2026-10-30 |
| 34 | 两笔交易提交公共 `tm_btms` 时都返回 `ERR_ALL_HOSTS_REJECTED`，SDK 吞掉了节点的具体回复 | 实测 | 同上 |
| 35 | 原因：主网只有一个 BTMS 节点（`backend.01545c29f0fd3c5cb03921d8b1a3ce01.projects.babbage.systems`，SHIP 目录里登记了两次）。sdk 3.2.1 的 `TopicBroadcaster` 发送 `X-Topics: tm_btms`，节点按 JSON 解析失败返回 HTTP 400；改用旧格式 `["tm_btms"]` 返回 200，并承认了发行 `[0]` 和拆份 `[0,1,2,3]`。所以用 AGENTS.md 锁定的 sdk 版本，连官方 BTMS 库都提交不上去。修复：`src/registry/publicOverlay.ts` 的 `LegacyTopicsFacilitator` | 实测 | `npm run diagnose:overlay`，2026-10-30；SDK 注释见 `@bsv/sdk/dist/cjs/src/overlay-tools/SHIPBroadcaster.js` 的 `send` |
| 36 | 用旧格式请求头重新提交已登记过的交易，节点接受请求但不确认任何新输出，SDK 报 `ERR_REQUIRE_ACK_FROM_ANY_HOST_FAILED`；这是重复提交的正常表现，不是错误 | 实测 | `npm run overlay:check`，2026-10-30 |
| 37 | `ls_btms` 按 `{txid, outputIndex}` 查询时，已被花掉的代币输出也返回 found（发行输出已在拆份中花掉，仍 found）。所以“查得到”只证明来历合法，不证明未花费；未花费要另查，或依赖成交时的双花拒绝 | 实测 | 同上 |
| 38 | 主网服务端钱包可用：wallet-toolbox 2.14.9 + SQLite + Arcade 广播。BSV Desktop 用 BRC-29 给 agent 转 20000 sats（txid `78d187d8752af06412e928dd2cf07ac972c4bb01348a9f2442a1d05d329d33c2`），agent 钱包 `internalizeAction` 入账，余额 20000 | 实测 | `npm run agent:fund`，2026-10-30 |
| 39 | 第一笔主网“换币即付款”成交：txid `ee2a38964df993af6cd48f5f51d1ce0c07c7bf454363735341288d7f71bf8e8c`。一笔交易里 agent 接下做市方预签的报价单，付做市方 1000 sats，1 pUSD 直接给商家（输出 1）。守门员收到 1066 sats 的请求（输出 1001 − 做市方代币输入 1 + 手续费 66，即 1000 给做市方 + 66 手续费），与报备意图一致后放行；agent 余额 20000 → 18934 | 实测 | `npm run agent:fill`，2026-10-30 |
| 40 | 商家用旧格式请求头把成交提交给公共 `tm_btms`，节点回的 STEAK 承认了商家的 pUSD 输出，商家随后入账；BSV Desktop 作为做市方收下 1000 sats。R1 在主网端到端跑通 | 实测 | 同上 |
| 41 | 预览时 `BTMSTopicManager` 打印 `Skipping output 0: script.chunks[0].data must have value`：输出 0 是付给做市方的 P2PKH，不是代币，登记规则跳过它，属正常 | 实测 | 同上 |
| 42 | 主网成交整个过程 BSV Desktop 只弹 1 次确认（第 6 步做市方收款）；agent 和商家用服务端钱包，不弹窗 | 实测（使用者确认） | 同上 |

## 仍未验证

- BSV Desktop 真钱包是否和本地 wallet-toolbox 表现一致。推测和走 `WalletPermissionsManager` 的路径一样。

## 要问 Axel 的问题

1. 代币用 BTMS 还是 BSV-21？比赛页面指向 BSV-21，但 BTMS 是官方代币库，而且已经规划了原子兑换。另外，官方 `tm_bsv21` 会承认凭空造出的假代币，这个要私下告诉他。
2. ~~公共 overlay 网络在主网和测试网上有没有托管 `tm_btms`？~~ 已实测：主网有，测试网没有（第 29 条）。
3. 用自己发行的演示代币当稳定币，算不算数？
4. 主网已经确定（官方发主网 sats）。还要问：采用潜力占 35%，如果没有真正的跨链稳定币，用演示代币加上“将来接入跨链 USDC”的说法，他认可吗？
