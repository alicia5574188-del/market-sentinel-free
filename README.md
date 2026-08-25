# Market Sentinel

面向手机和电脑的 Gate USDT 永续合约量化监控 PWA。它使用公开行情做多维、可复核的信号分析和 1,000U 模拟合约订单，并提供所有者专用、默认关闭的可选 Gate 实盘执行。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/alicia5574188-del/market-sentinel-free)

## 手机一键部署

1. 点击上方 **Deploy to Cloudflare**。
2. 在 Cloudflare 页面连接 GitHub 与 Cloudflare 账户，保留默认 Worker、D1 和 Durable Object 名称。
3. 在 `OWNER_ACCESS_TOKEN` 中输入一个只有你知道的至少 16 位访问码。不要使用邮箱密码或交易所密码。
4. 点击部署并等待构建完成，然后打开 Cloudflare 给出的 `workers.dev` 地址。
5. 输入刚才设置的访问码。iPhone 请用 Safari“添加到主屏幕”，再在程序设置中开启通知。

Cloudflare 会从 `wrangler.jsonc` 自动创建并绑定 D1 数据库、三个 Durable Objects 和一分钟恢复 Cron；部署脚本会在发布前应用全部 D1 migrations。新的 Cloudflare 数据库从空记录开始，不会伪造或继承旧网站的历史订单。

## 后台运行方式

- 持仓监控 Durable Object：有真实模拟持仓时每 10 秒从 Gate 重新估值，并按已保存的止损、止盈和时间规则平仓。
- 市场扫描 Durable Object：每 60 秒排名 Gate 成交额前 30 个 USDT 永续合约，并在免费计划的请求限制内轮换深度分析。
- 实盘协调 Durable Object：串行处理开关、对账、进场、交易所保护单和紧急停机，防止后台任务重叠造成重复订单。
- Cron Trigger：每分钟检查并恢复意外停止的 Durable Object alarms；不是用网页定时器冒充后台。
- 关闭 iPhone 页面后，服务器任务仍继续；符合进场或出场规则时通过 Web Push 通知。

## 安全边界

- `OWNER_ACCESS_TOKEN` 只作为 Cloudflare secret 注入，不提交到仓库。
- VAPID P-256 推送密钥由访问码通过域分离 SHA-256 稳定派生，无需在手机复制复杂私钥。
- 默认只读取 Gate 公共市场数据，不需要 Gate API Key；保存密钥也不会自动开启实盘。
- Gate API Key/Secret 仅由所有者在程序内填写，验证后使用 AES-GCM 加密写入 D1，浏览器存储、日志和 API 响应均不保存或回显明文；更换 `OWNER_ACCESS_TOKEN` 后必须重新填写 Gate 密钥。
- 密钥必须只开启永续合约读写；钱包、提现和其他非永续写权限必须关闭。当前实盘执行只接受经典合约账户和单向持仓模式；统一/组合保证金账户会拒绝启用。策略验证使用程序内模拟交易，确认逻辑稳定后再用小额 Gate 实盘验证，不再要求配置 Gate TestNet。
- 新保存的交易所凭据只接受 Gate 实盘环境；历史版本若曾保存 TestNet 凭据，自动开仓会保持禁止，直到所有者更换为 Gate 实盘 API。
- 自动开仓关闭时不再创建新订单，已有仓位继续受交易所止盈止损保护；一键停机会撤销该账户全部 USDT 永续挂单并 reduce-only 清仓，且不会自动恢复。
- 自动实盘只接受本次开关开启后产生、且确认时间不超过 2 分钟的新策略订单；Worker 延迟、重启或排队后超过时限的旧信号不会补开仓，同一时间有多个新候选时优先处理最新确认的信号。
- 全部资金风控统一按权益比例计算，不再使用固定 U 门槛：单笔结构止损风险 ≤ 当前权益 1%，单笔保证金 ≤ 当前权益 20%，保守 TP2 预计净利润 ≥ 当前权益 1.5%；Gate 当日已实现亏损达到当日参考权益 3% 或权益较实盘峰值回撤达到 10% 后锁定新开仓。真实成交后会按成交价和当前权益再次复核。
- 模拟交易与 Gate 实盘使用同一套比例风控。以 500U / 1,000U / 2,000U 权益为例：单笔风险分别为 5U / 10U / 20U，TP2 最低净利润为 7.5U / 15U / 30U，日内暂停线约为 15U / 30U / 60U；所有金额都会随权益自动变化。
- TP2 平仓使用收益闸门内的受限滑点；保护止损和紧急平仓优先可靠退出，使用 Gate 合约默认市价滑点上限。极端跳空时实际止损仍可能超过计划的 1% 风险。
- 实盘保护确认、平仓、风控锁和紧急停机结果只推送给保存密钥的所有者账户；成员不会收到或读取实盘账户信息。
- 这是尚待真实样本校准的研究与模拟工具，不承诺收益；量化计算、止损和仓位规则均为确定性代码并保留审计证据。

## 本地验证

需要 Node.js 22.15 或更高版本：

```bash
npm ci
npm run test:signals
npm test
npm run lint
npx tsc --noEmit --incremental false
```

Cloudflare 官方一键部署说明：<https://developers.cloudflare.com/workers/platform/deploy-buttons/>
