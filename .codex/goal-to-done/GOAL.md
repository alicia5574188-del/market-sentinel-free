# Goal

Build a clean PAPER-only Gate USDT futures system around one predictive question: which reachable liquidity concentration offers the best utility? The runtime must choose at most one of BREAKOUT, REVERSAL, RANGE, or WAIT; prepare before a boundary is crossed; use dynamic structural exits; and keep aggregate structural stop loss at or below 5% of PAPER equity.

Keep only the GitHub-to-Cloudflare release path and the existing AES-GCM/HKDF-compatible live_exchange_credentials row id=1. Do not expose a live entry surface, submit Gate orders, deploy from the coding branch, or touch production during implementation.
