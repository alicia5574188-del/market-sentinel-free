# Market Sentinel

面向手机和电脑的 Gate USDT 永续合约量化监控 PWA。它使用公开行情做多维、可复核的信号分析和 1,000U 模拟合约订单，不会自动操作交易所账户。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/alicia5574188-del/market-sentinel)

## 手机一键部署

1. 点击上方 **Deploy to Cloudflare**。
2. 在 Cloudflare 页面连接 GitHub 与 Cloudflare 账户，保留默认 Worker、D1 和 Durable Object 名称。
3. 在 `OWNER_ACCESS_TOKEN` 中输入一个只有你知道的至少 16 位访问码。不要使用邮箱密码或交易所密码。
4. 点击部署并等待构建完成，然后打开 Cloudflare 给出的 `workers.dev` 地址。
5. 输入刚才设置的访问码。iPhone 请用 Safari“添加到主屏幕”，再在程序设置中开启通知。

Cloudflare 会从 `wrangler.jsonc` 自动创建并绑定 D1 数据库、两个 Durable Objects 和一分钟恢复 Cron；部署脚本会在发布前应用全部 D1 migrations。新的 Cloudflare 数据库从空记录开始，不会伪造或继承旧网站的历史订单。

## 后台运行方式

- 持仓监控 Durable Object：有真实模拟持仓时每 10 秒从 Gate 重新估值，并按已保存的止损、止盈和时间规则平仓。
- 市场扫描 Durable Object：每 60 秒排名 Gate 成交额前 30 个 USDT 永续合约，并在免费计划的请求限制内轮换深度分析。
- Cron Trigger：每分钟检查并恢复意外停止的两个 Durable Object alarms；不是用网页定时器冒充后台。
- 关闭 iPhone 页面后，服务器任务仍继续；符合进场或出场规则时通过 Web Push 通知。

## 安全边界

- `OWNER_ACCESS_TOKEN` 只作为 Cloudflare secret 注入，不提交到仓库。
- VAPID P-256 推送密钥由访问码通过域分离 SHA-256 稳定派生，无需在手机复制复杂私钥。
- 默认只读取 Gate 公共市场数据，不需要 Gate API Key，不读取余额，也不会自动下单。
- 这是尚待真实样本校准的研究与模拟工具，不承诺收益；量化计算、止损和仓位规则均为确定性代码并保留审计证据。

## 本地验证

需要 Node.js 22.13 或更高版本：

```bash
npm ci
npm run test:signals
npm test
npm run lint
npx tsc --noEmit --incremental false
```

Cloudflare 官方一键部署说明：<https://developers.cloudflare.com/workers/platform/deploy-buttons/>
