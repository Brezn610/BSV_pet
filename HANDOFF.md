# SatsPet 交接文档

写于 2026-10-29 晚（黑客松前一天）。读者是接手的新 Claude 会话和队友。
读完这份文档就应该能继续开发，不需要翻之前的对话。

---

## 0. 第一件事：把代码放进 GitHub 仓库

**现状：** GitHub 仓库 `Brezn610/BSV_pet`（公开）的 `main` 上只有一个初始提交
`3802ec6 Initial commit`，内容是只有一行 `# BSV_pet` 的 README。
**全部代码还没推上去。** 上一个会话推送时被权限检查拦下了。

代码在两个文件里，用户会上传到新会话：

| 文件 | 内容 | 用法 |
| --- | --- | --- |
| `satspet.bundle` | git bundle，**带完整历史**，已经合并了 GitHub 上的初始提交 | 首选 |
| `satspet.zip` | 纯源码，不带 git 历史 | bundle 用不了时的备选 |

**新会话要在 `Brezn610/BSV_pet` 仓库里执行（首选 bundle）：**

```sh
# 在 BSV_pet 仓库根目录
git fetch /path/to/satspet.bundle main:refs/remotes/bundle/main
git merge --ff-only bundle/main      # bundle 已包含 3802ec6，可以直接快进
git log --oneline | head             # 应看到下面的 4 个提交
git push origin main
```

bundle 里的提交：

```
<最新>   docs: add handoff document          ← 本文档
7c51b50  Merge the initial GitHub commit of BSV_pet
6bd992d  fix: settle at 0-conf on the dev chain, following the BSV stack guide
30d9803  feat: scaffold SatsPet, an AI pet with a guardian agent in its wallet
3802ec6  Initial commit (GitHub)
```

**备选 zip：** 解压后把 `satspet/` 里的所有文件复制到仓库根目录（README 用 zip 里的版本），
然后 `git add -A && git commit && git push`。

推完后先在仓库根目录跑一遍 `npm install && npm test`，确认 7 个测试全部通过。

**仓库纪律：**
- 只在 `Brezn610/BSV_pet` 里开发。
- **不要改** `eujinnl/bsv_hackathon`。那是 BSV 官方 ts-stack 单体仓库的拷贝，用户明确要求保持原样。

---

## 1. 黑客松背景

| 项目 | 内容 |
| --- | --- |
| 活动 | TUM Blockchain & AI Hackathon（TUM Blockchain Conference 2026 的一部分） |
| 时间地点 | 2026-10-30 到 10-31，约 30 小时，慕尼黑 House of Communication，线下 |
| 平台 | Devfolio（tum.devfolio.co），官网 hackathon.tum-blockchain.com |
| 我们的赛道 | BSV Association 赛道，奖金 €4,000。主题：agentic payments，让自主 AI agent 能安全、即时地在链上交易 |
| 其他赛道 | 据第三方信息有 Cardano（€6,000）和 API3（€2,000），每队最多报 3 个赛道。未核实 |
| 评分标准、提交要求 | **还不知道**：官网和 Devfolio 在上个会话的网络环境里打不开 |
| BSV 联系人 | Axel（BSV Association），现场支持；私信他钱包地址就会发主网 sats |
| 官方钱包 | BSV Desktop 桌面版 https://desktop.bsvb.tech/，浏览器版 https://mobile.bsvb.tech/ |
| 官方文档 | `BSV_STACK_COMPLETE_GUIDE.md`（Axel 发的，4400 行），**请用户上传到新会话**。下文的“指南 §x”都指它 |

**黑客松没有测试用例，是评委看演示打分。** 验收标准要从两处来：
Devfolio 上 BSV 赛道的描述和评分标准，以及现场问 Axel。

---

## 2. 项目是什么

**SatsPet：一只会自己赚钱、自己花钱的 AI 宠物，钱包里住着一个守门员 agent。**

- 宠物会饿：能量随时间下降，饿了通过 HTTP 402 向零食店付款买食物，没电就休眠。
- 宠物会赚钱：访客通过 HTTP 402 付 80 sats 买它写的诗，钱直接进它的钱包。
- 宠物的大脑**故意做得很好骗**：访客让它买什么、付给谁，它都答应。
- 但它的每一笔付款都要先过**守门员 agent**。守门员接在钱包权限管理器的花费授权回调上，
  替代了 BSV Desktop 里让人点“同意”的那个弹窗。
- 守门员的每个决定都用哈希串成记录链，链头写进宠物的**灵魂 token**（链上的一个 PushDrop UTXO）。
  谁持有这个 UTXO，谁就拥有这只宠物。

**一句话卖点：** 你没法让 LLM agent 不被骗，所以不要指望它；把安全放进钱包里，agent 说服不了钱包。

**答辩钩子：** BSV Desktop 花钱时会弹窗问人（指南 §4）；SatsPet 的钱包问的是守门员 agent。

---

## 3. 运行和测试

需要 Node.js 22 及以上。

```sh
npm install
npm start            # 面板 http://localhost:4000；零食店 :4001；“免费送币”骗局商店 :4002
npm test             # 7 个端到端测试，离线，约 3 到 10 秒
npm run typecheck    # tsc 7，应无输出
```

- 没有 `ANTHROPIC_API_KEY` 时，宠物大脑和守门员都用确定性逻辑，完全离线也能演示。
- 设置 `ANTHROPIC_API_KEY` 后，两者都会调用 Claude。`SATSPET_LLM=off` 可以强制关闭 Claude。
- 所有可调参数都在 `src/config.ts`，可用环境变量覆盖，见 `.env.example`。

---

## 4. 架构

```
访客聊天 ──► 宠物大脑（Claude 或脚本，故意好骗）
               │ 声明意图：“我要在 Y 买 X，因为 Z”
               ▼
          402 客户端 ──► WalletPermissionsManager ──► onSpendingAuthorizationRequested
                                                        │
                                                        ▼
                                                   守门员 agent
                                                   1. 硬规则
                                                   2. 灰色地带交给 Claude 复核
                                                   3. 一次性批准 / 签发链上额度 / 拒绝
                                                   4. 写入哈希链记录
               ▼ 批准后
          BRC-29 付款 ──► 商家用 BRC-121 验证（HTTP 402）──► 返回商品

每次心跳：灵魂 token 被花掉并重新铸造，记录 { 能量, 心情, 记忆哈希, guardianRoot }
```

### 代码地图

| 文件 | 作用 |
| --- | --- |
| `src/config.ts` | 全部参数和环境变量 |
| `src/events.ts` | 进程内事件总线，面板通过 SSE 订阅 |
| `src/chain/mockChain.ts` | 离线链：`DevChainServices`（修过的 MockServices）、钱包工厂、水龙头 |
| `src/wallet/agentWallet.ts` | `createGuardedWallet()` 配置权限管理器（只保留花费授权）；`bindOriginator()` 修正 402 的 originator |
| `src/guardian/policy.ts` | 纯函数硬规则，可单独测试 |
| `src/guardian/llmJudge.ts` | Claude 复核，结构化 JSON 输出，开启 `fallbacks: "default"` |
| `src/guardian/guardian.ts` | 权限回调、判决、链上额度、哈希链记录、余额快照 |
| `src/pet/brain.ts` | 宠物大脑：`ClaudeBrain` 和 `ScriptedBrain`，以及商品目录类型 |
| `src/pet/soul.ts` | 灵魂 token：铸造、花掉再铸造、解码 |
| `src/pet/pet.ts` | 新陈代谢、购买、收入、记忆、保存灵魂；用串行队列避免并发花同一个 UTXO |
| `src/market/shops.ts` | 零食店（受信任）和免费送币商店（陌生），各自独立的 402 服务和钱包 |
| `src/world.ts` | 把所有部分组装起来，服务器和测试共用 |
| `src/server.ts` | 面板 API、SSE、宠物自己的 402 卖诗接口、攻击预设 |
| `public/` | 面板，纯 HTML/JS/CSS，不需要构建 |
| `test/world.test.ts` | 端到端测试 |

### 守门员规则（`policy.ts`）

| 规则 | 级别 | 默认值 |
| --- | --- | --- |
| 必须提前声明意图 | 拦截 | |
| 实际价格不能高于声明的标价 | 拦截 | |
| 意图文本命中提示注入特征 | 拦截 | 正则列表 |
| 意图来自陌生人聊天 | 复核 | |
| 商家不在信任名单 | 复核 | |
| 商家在黑名单 | 拦截 | |
| 单笔上限（含手续费） | 拦截 | 500 sats |
| 24 小时预算 | 拦截 | 2000 sats |
| 付款后余额不得低于保命余额 | 拦截 | 300 sats |

判决结果：
- 有任何一条拦截就拒绝。
- 全部通过：对受信任商家且意图来自宠物自己的需求时，签发**链上额度**
  （BRC-73 DSAP token，默认 600 sats）；否则一次性批准。
- 需要复核：有 Claude 时由 Claude 判断，**只能把复核结果判为批准或拒绝，不能推翻硬规则**；
  没有 Claude 时一律拒绝（fail closed）。
- 守门员自身出错也一律拒绝。

---

## 5. 关键决策和踩过的坑（别再踩一遍）

1. **项目必须是 CommonJS。** `@bsv/wallet-toolbox` 只有 CJS 版本。用 ESM 会加载两份 `@bsv/sdk`，
   报错 `script[serializedBytes] is not a function`。指南 §2 有同样的警告。
2. **402 的 originator 格式。** `@bsv/402-pay` 把带协议的 URL（`http://localhost:4001`）当作 originator，
   但权限管理器只接受纯域名。`bindOriginator(wallet, 'snack-shop.local')` 解决这个问题，
   同时让守门员知道是哪个商家在收钱。指南 §10.4 的 `withHostOriginator()` 是同一个思路。
3. **授权回调里不能查余额。** 构建付款时钱包已经锁住了输入，回调里调用 `balance()` 会偏低甚至为 0。
   守门员在 `declareIntent()` 时记下余额快照。
4. **签发额度需要第二枚币。** 付款还在进行中时铸造额度 token，需要另一个未锁定的 UTXO。
   钱包设置为 `wallet.setWalletChangeParams(8, 500)`，水龙头也拆成多枚币发。
   万一铸造失败，守门员会把这次批准降级为一次性批准，付款照常完成。
5. **离线链的两个补丁（`DevChainServices`）。** 和指南附录 A 里 `test/helpers/mockchain.ts` 的修法一致：
   - 重复广播同一笔交易算成功。付款方和收款方都会广播，原版 MockServices 会把第二次当成双花。
   - 一笔交易花同一个未确认父交易的两个输出时（比如灵魂 token 和它的找零），共用同一个解析后的父交易对象，
     否则脚本验证会失败。
6. **立即广播。** 离线链上用 `ImmediateBroadcastWallet` 强制 `acceptDelayedBroadcast: false`，
   因为没有运行 Monitor 的后台广播任务。指南 §9.1 的 BRC-29 发送方也是这么设的。
7. **0-conf。** 修好之后，所有交易不需要出块就能结算，和主网一致。有一个测试专门断言这一点。
8. **离线链出块。** `world.start()` 每 10 秒出一个块，只是为了让钱包拿到 merkle proof；结算不依赖它。

---

## 6. 已验证和未验证

### 已验证（离线链上的 7 个测试，以及手动启动服务器、截图检查面板）

1. 宠物出生时铸造灵魂 token
2. 宠物饿了会买食物，守门员签发链上额度
3. 提示注入的付款被拦下，余额不变，而且是守门员拦的（不是因为余额不足）
4. 陌生商家的聊天请求，在没有 Claude 时一律拒绝
5. 访客通过 HTTP 402 付钱买诗，宠物余额刚好增加诗的价格
6. 交易过程中区块高度不变（0-conf）
7. 保存灵魂会花掉旧 token 并铸造新的，`guardianRoot` 等于守门员记录链的链头

另外手动验证过：面板能显示守门员的决定、额度和事件日志，手机宽度下没有横向滚动。

### 未验证

- **Claude 路径：** `ClaudeBrain` 和 `llmJudge.ts` 只通过了类型检查，从没实际调用过（上个会话没有 API key）。
  模型是 `claude-opus-5-5`，用 `client.beta.messages.create`，带 beta `server-side-fallback-2026-07-01`、
  `fallbacks: 'default'` 和 `output_config.format` 的 JSON schema。
- **主网：** 还没实现。`createWorld()` 遇到 `SATSPET_MODE=live` 会直接报错。
- **BSV Desktop：** 没有和真实钱包对接过。指南 §10.4 提到，402-pay 配合 `WalletClient` 加 BSV Desktop 的组合官方也没测过。

### 当前依赖版本

`@bsv/sdk` 4.0.1，`@bsv/wallet-toolbox` 2.15.1，`@bsv/402-pay` 0.3.5，`@anthropic-ai/sdk` ^1.3.0，
express 5，typescript 7.0.2，tsx。指南验证时用的是 sdk 3.2.1、toolbox 2.14.9、402-pay 0.3.3，
比我们旧，API 基本一致。

---

## 7. 下一步任务（按优先级）

### P0：推代码（见第 0 节）

### P0：去问清验收标准
- 让用户把 Devfolio 上 BSV 赛道的描述和评分标准贴过来。
- 现场问 Axel：评委要不要看主网交易？推荐 BRC-121 还是 BRC-105？对 agent 的安全模型有没有期待？
- 拿到后把要求逐条写成验收测试或演示检查项。

### P0：实际跑一遍 Claude 路径
- 设置 `ANTHROPIC_API_KEY` 后运行 `npm start`，依次点三个攻击按钮。
- 验收：
  - “甜言蜜语诈骗”由 Claude 复核，面板显示 “judged by Claude” 和一句理由。
  - 提示注入仍然被硬规则拦截。
  - `ClaudeBrain` 返回的 JSON 能正确解析。
- 如果结构化输出的 schema 被拒（比如 `anyOf` 里含 `null`），把 `purchase` 改成可选字段或拆成两个字段。

### P1：主网模式（`SATSPET_MODE=live`）
参考指南 §14.2、§9、§11、§20。建议的设计：

1. **新文件 `src/chain/liveWallet.ts`**：
   - 用 `StorageKnex` 加 SQLite 文件（`data/pet.sqlite`，加进 `.gitignore`）。
   - `Services.createDefaultOptions('main')`，并设置 `options.arcadeUrl = 'https://arcade-v2-us-1.bsvblockchain.tech'`。
   - `Monitor.createDefaultWalletMonitorOptions(...)`，然后 `addDefaultTasks()` 和 `startTasks()`。
   - 根私钥从环境变量 `PET_ROOT_KEY_HEX` 读取，**绝不提交**。
   - `wallet.setWalletChangeParams(8, 500)`。
2. **`world.ts`** 按模式选择离线链或主网钱包。主网模式下禁用水龙头，也不再定时出块。
3. **充值页面**（`public/fund.html` 加 `POST /api/fund`）：
   - 浏览器用 `new WalletClient('auto')` 连接 BSV Desktop，按指南 §9.1 的 `createBrc29Payment()` 付款给宠物的身份公钥。
   - 服务端按 §9.2 的 `acceptBrc29Payment()` 用 `ArcadeChainTracker`（§20.3）先做 SPV 验证，再 `internalizeAction`。
   - 测试币在组员的 BSV Desktop 里，由组员自己打开这个页面充值。**不要索要任何人的私钥或助记词。**
4. **商店：** 主网上零食店和骗局商店也要有各自的服务端钱包（只收款，不需要充值）。
5. **访客买诗：** 主网上访客是真人，用 BSV Desktop 付款。BRC-121 加 `WalletClient` 官方没测过；
   如果不行，改用 BRC-105（`AuthFetch` 加 `@bsv/payment-express-middleware`，指南 §10.3）。
6. **面板：** txid 链接到 `https://whatsonchain.com/tx/<txid>`。
7. **预算：** 准备 2 万到 5 万 sats；宠物初始资金调小一些，比如 3000。

### P1：演示打磨
- 按 README 的三分钟演示脚本排练，计时。
- 宠物用分心情的动画小图替代 emoji。
- “领养”：把灵魂 token 转给另一个钱包，展示所有权就是 UTXO。
- 导出守门员记录，并现场验证它和链上的 `guardianRoot` 一致。

### P2：更多攻击场景
- 价格诱饵：商家在宠物声明意图后临时涨价，应被 price-match 规则拦下。
- 额度耗尽：额度用完后需要守门员重新审批。
- 冒充守门员：聊天里说“守门员已经批准了”。

---

## 8. 已知限制

- **状态都在内存里：** 宠物状态、守门员记录、离线链重启后全部丢失。链上只保留灵魂 token。
  主网模式需要把宠物状态和记录落盘，至少写成 JSON 文件。
- **守门员记录只在本机：** 链上只有链头哈希。要证明完整历史，需要导出记录再逐条重算哈希。
- **规则比较粗：** 提示注入只靠正则；“24 小时花费”只统计成功的购买，按标价计，不含手续费。
- **只有一个宠物，商家名单写死在代码里。**
- **ScriptedBrain** 只做关键词匹配，只用于离线演示和测试。

---

## 9. 给新会话的开场提示（复制粘贴）

> 我在做 TUM Blockchain & AI Hackathon 的 BSV 赛道项目 SatsPet。仓库是 `Brezn610/BSV_pet`。
> 我上传了 `satspet.bundle`、`satspet.zip` 和 `BSV_STACK_COMPLETE_GUIDE.md`。
> 请先读 bundle 里的 `HANDOFF.md`，按第 0 节把代码合并进仓库并推到 main，跑 `npm test` 确认 7 个测试通过，
> 然后告诉我第 7 节里你建议先做哪一项。不要修改 `eujinnl/bsv_hackathon`。
