# Gate recovery and evidence-gated coverage decision — 2026-09-11

- The observed 429 and timeout are public Gate endpoint degradation, not proof that the full market-data authority stopped. A trading API key cannot convert public ticker/candle/book calls into private UID quota and must not be attached to public reads.
- Use both official Gate futures REST hosts for one bounded retry on network/5xx failure, share 429 backoff by endpoint, reduce the bulk radar to one request per minute, and request completed 5-minute paths only after a new bar closes. Merge four-row incremental reads into a retained continuous path; a transient failure is diagnostic, and becomes a trading blocker only when the retained path also exceeds eleven minutes.
- Do not deploy the proposed broader `衡返` geometry. It improved the two-half result to PF 1.26/1.59 but its three chronological folds were 1.35/2.09/0.79; both strict and broad variants were negative in the latest fold (0.67/0.70). `衡返` therefore returns to paired-shadow status and can regain PAPER authority only after current three-event polarity evidence.
- Retain `势承·逆竭` and `竭转·孤返` as the executable family. Their combined three chronological folds held PF 1.35/1.40/1.37 after 0.14% friction and adverse next-bar entry; the direct trend, compression and newly explored divergence/rejoin/pullback mechanisms remain rejected. Coverage comes from thirty reliable paths plus current polarity, not extra strategy names or forced orders.

# Final V11 correction decision — 2026-09-11

- V10 is an all-environment classifier but not an all-environment trading authority. Native trend signals are suppressed, range and compression remain observation-only, and both approved names originate from the same exhaustion event. Correct the architecture rather than relaxing its final execution gates.
- Treat the latest 30-day/20-market PR replay as the baseline: held-out PF 1.15 and 50% profitable active days are insufficient evidence for the user's daily-positive objective, while the native crowded-direction branch at PF 1.02 is too close to friction to present as robust.
- A short external-data failure cannot be eliminated absolutely. Reduce its incidence and opportunity impact by keeping two-second books only for prepared routes/open positions and slowing ordinary watch markets whose decision source changes only on completed five-minute candles. Measure recent failure rate and interruption duration rather than presenting an unbounded lifetime count.
- “Execution candidate” means the backend arena actually accepted the current route for final checks. The UI may not infer this only from candle geometry; it must expose the backend's exact authorization and blocker truth.

# Operator-runtime transparency decision — 2026-09-11

- “Remove unnecessary data” means remove engineering diagnostics, not operational truth. The main page must always answer whether data is advancing, how long V10 has run, which pipeline step is active, what happens next and whether any current fault blocks trading.
- Current market analysis is actionable operator information. Show the top completed-candle candidates with selection reason, environment owner, intended direction or explicit no-trade state, route rationale/blocker and observation time.
- Do not present route score as probability. Only validated `势承` and `竭转` may show their held-out same-route win rates (35.6% and 37.2%), explicitly labeled as historical reference rather than a forecast for the current trade. Observation-only owners show no estimated probability.
- Derive the page from existing runtime summary fields. This correction adds no Gate requests, Durable Object cadence, D1 writes or strategy authority.

# All-regime compounding decision — 2026-09-11

- Historical evidence is allowed to disable a named environment owner. `衡返` and `压跃` continue classifying and shadowing their environments but cannot spend PAPER equity until a later independent validation passes; the page must not imply otherwise.
- PAPER authority is frozen to two cross-phase-positive mechanisms: `势承` continues a crowded broad-market direction when a single symbol only appears exhausted, while `竭转` reverses isolated exhaustion only when broad-market direction is neutral.
- Use at most 0.5× current equity notional per position instead of inversely levering narrow stops. This preserved route expectancy in account replay; structural-risk, correlation, margin and liquidation limits remain hard ceilings.
- Polarity is persistent state, not repeated amnesia: three wins select normal; three losses may select reverse only with matching reverse wins plus twelve-sample positive reverse mean and PF≥2.5; mixed results retain the last authorized direction.
- The main page is an operator surface, not a research notebook. Show equity/today PnL, current environment and owner, open PAPER orders and full account trades; keep shadows, diagnostics and transition internals backend-only.

- The system objective is environment-appropriate positive edge and compound equity, not a single universal signal, trade-count quota or generic risk-score stack. Market classification must precede strategy selection, while strategy profitability is measured only inside the environment it is designed to trade.
- Replace V9 rather than extend it. Maintain separate evidence for directional continuation, balanced rotation, compression release and directional exhaustion; never pool unrelated branches or symbols into one global three-result polarity.
- “Always covered” means every current environment has a strategy owner continuously evaluating it. It cannot honestly mean forced permanent exposure: when every route's after-cost expectation is non-positive or opposing routes conflict, cash is the only non-negative decision.
- Compounding uses current PAPER equity for each new position and optimizes time-ordered log-equity growth plus profitable-day coverage. Fixed 1,000 U is the starting capital, not a permanently fixed sizing base.
- Generic risk scoring must not select the strategy. Mandatory execution truth remains: fresh executable futures prices, structural invalidation, contract/lot validity, no stale-price closes, no liquidation path, bounded account exposure, and explicit owner-only LIVE OFF.

# 极序·镜转 V9 decision — 2026-09-11

- `极序·镜转` is this system's single named PAPER authority. It does not claim that generic momentum or reversal concepts have never existed; its two-path event definition, paired-shadow evidence contract, polarity switch and runner execution are designed together for this account.
- `裂变` requires a completed five-minute close beyond a twelve-bar boundary with retained close location, range expansion, body, path efficiency, displacement and non-collapsed volume. Its base side follows the release. `回卷` requires a completed-bar boundary sweep, close back inside, rejection wick, range expansion and non-collapsed volume. Its base side follows the reclaim.
- Every valid event runs both normal and mirrored reverse shadows with frozen, symmetric geometry. Exactly the latest three independent events within 24 hours decide polarity: three positive normal results select `顺极`; three negative normal results select `逆极` only if the matching reverse results are all positive. Zero and mixed results select cash. PAPER outcomes never authorize the direction.
- The polarity decision applies only to the next new extreme event and never reverses an open position. A closed symbol/branch has a thirty-minute cooldown. Current extremes are ranked globally and only ranks one through three are admission-eligible; the account still may open fewer because structural risk, same-direction risk, margin, notional, lot size or depth fails.
- A path's target is a profit-arm threshold rather than a fixed take-profit. After activation, moving protection locks at least modeled cost plus 0.35R and retains 55% of larger favorable movement; profit has no fixed upper cap. Initial stop, no-progress timeout before activation and four-to-six-hour edge decay remain mandatory.
- V9 is a clean PAPER account boundary. V8 positions are settled only from fresh executable bid/ask, the cycle is archived, and the new cycle starts at 1,000 U. Deployment cannot enable LIVE.

# 2026-09-11 — Market state selects the strategy family before expectancy ranks it

- The first trading objective is not signal count or the 10% daily aspiration. It is selecting the strategy designed for the current completed-candle market environment.
- V6 production proved that walk-forward profitability alone is insufficient: low-efficiency boundary return traded in RANGE, COMPRESSION and EXPANSION because the route generator did not enforce its own strategy-channel declaration.
- Require exact channel compatibility before an adaptive route may create an effective shadow or PAPER candidate: RANGE admits boundary return and failed acceptance; COMPRESSION admits volatility transition; TREND admits path recovery and directional persistence; EXPANSION admits valid boundary acceptance.
- Only after compatibility may the existing chronological, fully costed walk-forward evidence rank competing routes. Data freshness, structural economics, depth, Gate integer contracts and all portfolio limits remain later mandatory gates.
- Archive and reset the losing pre-correction strategy-account cycle through the existing fresh-quote version cutover. Preserve its history and keep LIVE explicitly OFF.

# 2026-09-11 — Relative strength and strong breakout are not deployment candidates

- Reject the tested relative-strength pullback and strong-breakout mechanisms. A marginal full-window profit factor is insufficient when the earlier half is negative and ordinary cost or execution stress reverses the result.
- Do not use global three-win/positive-six activation to rescue a weak underlying mechanism. On the strongest breakout path it reduced profit factor from 1.05 to 0.75 because evidence arrived after the favorable regime and stayed enabled into reversal.
- The next research stage must add genuinely new contemporaneous information or a different payoff mechanism; it may not continue threshold-searching the rejected candle-only families. PAPER implementation remains blocked until one frozen candidate is positive in both time halves, remains positive under modeled cost and adverse execution, and produces a useful opportunity rate.

# 2026-09-11 — Short-window qualification cannot prove a strategy edge

- Reject the false-auction reversal candidate despite its positive 7.85-day result. A clean 63-day causal replay made both halves negative, and the result remained negative on mature contracts and after logically motivated range/retest entry changes.
- Three consecutive wins or a positive latest-six window may be an execution admission rule only after the underlying mechanism has independent long-window evidence. Across many symbol+side streams, the rule otherwise selects ordinary lucky streaks and expands trading after warmup without preserving expectancy.
- Future strategy candidates must pass a minimum multi-regime historical window with next-bar executable entry, fully modeled friction, time-ordered qualification, account concurrency and symbol cooldown before PAPER implementation. Frequency is evaluated only after positive expectancy; a short sample meeting the daily objective is not sufficient.

# Runtime-truth and LIVE-off presentation decision — 2026-09-11

- A missing first runtime response is absence of evidence, not a 1,000 U account with zero trades and thirty ready markets. The page renders a connection state until a verified snapshot arrives, then preserves that snapshot during ordinary retryable phone failures.
- LIVE off is the public privacy boundary: no public badge, navigation entry, real balance, real order or real execution panel is rendered. An authenticated owner still gets the minimum activation, tagged-order cleanup and credential controls required to manage the switch safely.
- Settings contains simulation/system controls only. The owner-controlled LIVE switch and Gate maintenance stay in the authenticated LIVE center, and real account/order views appear only while LIVE is enabled.

# V6 decision-console decision — 2026-09-11

- Phone transport age is presentation noise, not trading authority. Once a verified snapshot exists, ordinary read failure is silent and automatically retried; only genuine MarketStream authority, protected-position or risk failures deserve a visible warning.
- The main page follows the actual V6 authority order and prioritizes account truth plus current approved routes. Market-state distribution and shadow research remain visible as evidence but do not visually impersonate the trading authority.
- The UI refresh change reads only the existing lightweight runtime summary and never adds market-data requests or D1 writes.

# V6 generated-state authority decision — 2026-09-10

- Liquidity ranking selects the thirty contracts; it does not choose direction or strategy. Completed five-minute OHLCV generates the state-path hypotheses, and fresh bid/ask/depth validates only the final executable order.
- The six mechanisms are independent path constructions, not names mapped back to the old twelve playbooks. Several mechanisms and both directions may be researched for one state; exact duplicate geometry is still collapsed.
- A currently approved chronological walk-forward result is PAPER authority. Eligible horizons outrank failed horizons before objective-score comparison, so an invalid high discovery score cannot hide another valid 10/20/30/45/60-minute route.
- The old 3/6 and mirrored-reverse code may remain only for reading legacy records; it cannot generate, activate or size a V6 order. PAPER output is cloned from the exact generated effective shadow.
- Daily positive return is an optimization objective, never a guarantee. Opportunity cadence may be improved only by testing more current hypotheses and valid horizons, not by forcing trades or weakening freshness, full-cost, target-reach, lot-size or portfolio-risk gates.
- V6 is an explicit account boundary: archive/reset the old PAPER cycle at fresh executable prices, start at 1,000 U, preserve historical orders and research, and keep LIVE requested and operational states false.

# Evidence-display decision — 2026-09-10

- A win/loss sequence is not a substitute for total after-cost return: two larger wins can outweigh four smaller losses, so the UI must show the exact aggregate used by authority.
- Normal and reverse evidence use the same labels, sample counts, latest-three sequence and latest-six total-return format.
- PAPER counts remain visible only as review data. They do not share a score cell with shadow qualification and do not influence enablement.

# V4.3 decisions — 2026-09-10

- Treat the first observed positive overnight gross result as a regression boundary: this correction does not change signal direction, frozen stop/target geometry or exit timing. Future market PnL cannot be guaranteed, but mechanical truth fixes must not silently redesign the strategy again.
- An enabled base playbook does not prove all four geometries. Confirmation/retest and fast/structure variants promote and demote independently; only the exact variant's own latest evidence authorizes an account order.
- Results from different symbols inside the same completed-five-minute regime lifecycle are correlated and count once per exact variant. This prevents one broad market move from manufacturing a three-win promotion.
- Positive rolling total is sufficient for shadow promotion, but account admission is stricter: at least three independent samples and the exact variant's conservative after-cost expectation must exceed the complete modeled cost. The frozen V4.2 replay retained five trades in roughly seven hours, with gross `+8.98 U`, costs `8.14 U` and net `+0.84 U`; this is a diagnostic replay, not a promise of future return.
- Position size still targets a continuous 10–20 U planned loss with Gate multiplier and integer contracts. If aggregate risk, same-direction risk, margin or notional capacity clamps the result below 10 U, skip the order instead of recording a one-contract dust trade.
- Simulated equity and open PnL use executable exit-side prices. Closed trade percentage means net PnL divided by account equity at entry, while position return, notional, contracts, leverage, margin and planned risk remain separately visible.
- V4.3 is a fresh evidence/account boundary. Settle any previous open simulated exposure only from fresh bid/ask, archive it, reset to 1,000 U and keep deployment/LIVE authority unchanged and OFF.

# V4.2 decisions — 2026-09-09

- The bulk ticker is a liquidity-universe selector only.
- Completed 5-minute Gate OHLCV is the durable strategy source; 15m/30m/1h structure is derived rather than fetched as a hard prerequisite.
- One effective-shadow result is allowed per base playbook/event. Different base playbooks may learn from the same symbol/event.
- Same-direction enabled playbooks share one simulated contract order and each receives attribution; opposing signals are arbitrated.
- Promotion must complete inside 24h/72h cadence windows. Rare signals remain research-only and cannot stall the system.
- SLEEPING is retained only for checkpoint compatibility; runtime transitions are SHADOW/ACTIVE.
- D1 runtime telemetry is written every five minutes, pruned after 14 days, and exposed read-only at /api/strategy-logs.
- Release resets the V4.2 strategy ledger and 1,000 U simulated cycle. LIVE remains forced OFF on restart and deployment.

# Decisions

## 2026-09-12 — Depth is a size cap, not a fixed eligibility threshold

- Strategy qualification does not depend on whether the simulated account contains 1,000 U or another amount. Capital enters only after a route has formed, when the executable number of Gate contracts is calculated.
- The retained five-level book is execution capacity, not a 10,000 U entrance requirement. Limit the order to 20% of the smaller bid/ask depth, round down to Gate integer contracts, and reject only if that result is below one contract.
- Ten U remains a sizing target, never a minimum-dollar eligibility gate. A smaller account or a route reduced by liquidity may carry less planned risk; this is not permission to enlarge risk or bypass the aggregate 10%, correlated 6.5%, margin, cost, freshness or structural checks.
- A healthy cycle with no admitted route is a completed decision, not a stalled step. The operator page must say how many candidates were rejected and that it is waiting for the next completed five-minute bar.
- The V11 replay may report `衡返` as research evidence, but `衡返` is explicitly PAPER-disabled. Its changing 30-day shadow result cannot block a sizing-only release; the gate continues to require positive current evidence for every account-authorized exhaustion branch and the V12 routes.

## 2026-09-12 — PAPER notional and LIVE representation follow the account, not a timer

- The 0.5× per-position ceiling and 20% five-level-depth haircut conflict with the derivatives account's structural-risk sizing and can reduce an otherwise valid 1,000 U PAPER order to economically immaterial exposure. Retain the existing 4× total notional ceiling and every risk/margin/economics gate; use book depth only to prove at least one Gate contract is executable.
- LIVE is the owner-enabled proportional representation of the PAPER account, not a separate signal subscriber. An open PAPER trade remains eligible for its first LIVE entry even when it predates enable or fresh execution data arrives more than ten seconds after the PAPER open.
- A PAPER notional fraction may exceed 1× equity and must remain the same fraction on LIVE up to the shared 4× ceiling. Gate lot rounding and actual LIVE risk, margin, liquidation and economics checks remain authoritative and may explicitly skip an infeasible copy.

## 2026-09-09 — Data capability defines the strategy layer

- The thirty-contract ticker radar is a best-effort discovery layer. Its failure may delay discovery of a new opportunity symbol, but may not pause completed-candle evaluation for the stable realtime core.
- Reserve six of ten realtime positions for stable liquid residents and use the remaining capacity for current trend/range/compression/anomaly candidates. Protected exposure remains first priority.
- Derive fallback market state and structure only from a contiguous suffix of completed official one-minute futures candles aggregated locally into complete five-minute bars. Combine it with current executable bid/ask and current contract metadata; never carry a stale radar price into execution.
- Treat twelve base playbooks as the promotion authority. Their four confirm/retest and fast/structure variants remain different execution choices inside one event, while one event contributes at most one effective-shadow result.
- Sleep is meaningful only for an enabled playbook whose channel is absent. A playbook that has not yet qualified stays in SHADOW so an unrelated market regime cannot stop its evidence accumulation.

## 2026-09-09 — Progressive admission for the futures simulation account

- Count one base-playbook result per independent market event; its four execution variants are comparisons inside that event and never four promotion samples.
- Four independent events with at least two wins, positive after-cost total and conservative expectation, and profit factor at least 1.0 may promote only the best observed variant to one-third-risk probation. The account reserves at most one probation slot and may stay in cash when nothing qualifies.
- Normal size requires at least eight independent events across two symbols, positive recent after-cost expectation and profit factor at least 1.15. Two consecutive losses or a non-positive six-result stage window demotes the variant to shadow.
- Promotion does not override execution truth: current structural geometry, net reward/risk of at least 1.2, cost no greater than 25% of target space, turnover, spread, two-sided five-level depth, positive empirical expectation, integer Gate contracts, margin and aggregate risk all remain mandatory.
- The 1,000 U account is a USDT-perpetual simulator using contract multipliers, integer lots, dynamic leverage and structural-risk sizing. LIVE mirrors the exact account order proportionally and reuses its modeled cost before Gate lot/margin/safety validation; deployment keeps LIVE off.
- Reset applies to the visible simulated account, archives the cycle and preserves strategy research. It is forbidden while the system has requested or active LIVE exposure.

## 2026-09-09 — one visible/executable simulation account

- SHADOW/TRIAL/VERIFIED ledgers are strategy-selection research only; they must not appear as account orders or be summed as account profit.
- `portfolioEquity`, `portfolioOpen` and `recentPortfolio` are the sole 1,000 U PAPER account truth. One symbol/event can contribute only one selected strategy order and the account holds at most three positions.
- LIVE mirrors only portfolio orders created after the owner enables LIVE. Enabling never backfills an already-open PAPER position; deployment never changes the switch.
- LIVE sizing remains proportional to actual Gate equity and retains contract rounding, 10% total risk, 6.5% same-direction risk, 30% margin, economical-target, fresh-data, unmanaged-exposure and reduce-only protection checks.

## 2026-09-09 — Market state precedes strategy selection

- Keep anomaly detection as one expansion/event candidate channel, not the prerequisite for every strategy. Add trend, range and compression candidate channels from bounded streaming features computed from the existing bulk ticker response.
- Preserve exactly three two-second deep-analysis slots and the existing request/write budgets. Reserve diversity across candidate channels, rotate observation-only symbols, and never let SHADOW trades lock a slot; only the non-duplicating portfolio simulation or protected legacy/LIVE exposure may lock one.
- Define forty-eight cells as twelve explainable playbooks times two entry styles times two exit profiles. A first after-cost SHADOW win earns only a trial simulation label; two consecutive trial losses demote it. Verified simulation requires distinct events/symbols and positive after-cost quality so one coin or duplicated event cannot qualify a strategy.
- Run isolated strategy simulations for comparison and a separate portfolio simulation that takes at most one strategy per symbol/event. Do not add duplicated isolated results together as account profit.
- Freeze regime, candidate channel, entry style, exit profile, cost, flow, structure, volatility and trend context on every observation. Reset incompatible V1 arena statistics at cutover, preserve credentials and reconciliation state, and keep LIVE forced OFF.

## 2026-09-09 — Win/loss attribution must freeze features and candidates before validation

- Keep the paired reaction lab unchanged as the sample generator. The outcome researcher is a separate pure module that reads completed shadow routes and has no exchange, D1, PAPER, LIVE or automatic strategy-mutation authority.
- Accept only routes created after this upgrade with a complete `featureVersion=1` snapshot. Freeze event strength/type, impulse and relative movement, volume, OI, starting spread/depth, trigger retrace/flow/speed and stop width before the outcome is known; do not backfill missing old fields from final state.
- Treat maximum favorable/adverse movement and holding time as path diagnostics only. They explain how winners and losers developed but are forbidden from becoming entry evidence because they occur after entry.
- Reserve the first 100 complete routes for discovery. Immediately before route 101, freeze only qualifying single-feature buckets and multi-feature segments; grade those unchanged candidates on later confirmation samples. Continue displaying an empty candidate set truthfully if discovery produces no positive candidate.
- Keep deduplication, recent samples and combination identities bounded in the existing Durable Object checkpoint. Reuse existing market observations and preserve the research-only LIVE hard lock.

## 2026-09-08 — Compare both reactions before authorizing execution

- An anomaly is a sample selector, not a directional signal. Each selected event receives the same three-minute observation window and independently eligible continuation and reversal routes; neither route inherits the anomaly direction as permission to trade.
- A continuation route requires a controlled 20%–70% retrace followed by two aligned advancing-flow observations. A reversal route requires at least a 70% retrace followed by two declining opposite-flow observations. If neither appears, retain an explicit no-trigger control instead of inventing a trade.
- Freeze entry, stop and target when each route triggers, apply the same 0.18% round-trip friction model, and resolve target-first, stop-first, ten-minute no-progress or twenty-minute maximum hold. Keep state bounded and reuse existing ticker/book traffic.
- The lab has no new PAPER or LIVE execution path: publish `decision=null`, set `allowOpen=false`, force restored LIVE authority off, and reject requests to enable it. Continue managing any pre-existing PAPER/LIVE exposure so research lock never weakens safety.
- Archive the one-direction rejection audit and its accumulated evidence rather than deleting history. Accounts, settings, completed orders, credentials and risk protections remain unchanged.

## 2026-09-08 — Rejected signals need prospective shadow outcomes

- Existing production history cannot truthfully reconstruct blocked opportunities because only completed positions and the current candidate assessment are retained. Start prospective evidence collection rather than infer unobserved entry state from later candles.
- Freeze one shadow trade per radar event at the first deep rejection. Keep its contemporaneous direction, entry, stop, target, primary blocker, all simultaneous failed rules and score evidence; never update its geometry after the fact.
- Follow outcomes for twenty minutes with the existing all-market ten-second ticker snapshot. This adds no exchange request, D1 write, PAPER position, LIVE authority or capital risk. Persist bounded audit state inside the existing heartbeat checkpoint.
- Attribute a resolved sample to every rule it failed, including missing score components. Because simultaneous failures are correlated, thirty samples can only mark a preliminary suspected false rejection; deletion or weight changes require a separate review and regression test, never automatic mutation.

## 2026-09-08 — Directional evidence is scored; execution safety remains conjunctive

- The first anomaly release was fluid because it had few directional vetoes, while the current release can produce zero entries because event kind, OI, flow and several execution conditions are all mandatory. Restoring the first release would restore its losses as well as its frequency.
- Hard gates remain for two radar confirmations, minimum event strength, materially opposite realtime flow, liquidity, spread, near-book depth, established-but-not-overextended displacement, and fee share. These protect executability and cannot be traded away for frequency.
- Quality requires three of five: stronger event, a third radar confirmation, frozen new-money/OI agreement, strongly aligned realtime flow, and unusually large movement versus the symbol baseline. No single optional observation may veto an otherwise supported event.
- Record score and blocker in bounded runtime state only; add no persistent per-snapshot writes. Preserve the four-book trigger and all PAPER/LIVE parity and authority boundaries. Deployment remains a separate user decision.

## 2026-09-08 — Realtime promotion needs residence hysteresis

- A ten-second ranking change may not evict a current realtime symbol while it remains an entry-eligible `NEW_MONEY` radar candidate. Locked positions/plans remain first, valid resident `NEW_MONEY` candidates remain next, and newly ranked `NEW_MONEY` candidates displace observation-only anomalies before using remaining slots.
- This is admission stability, not slower market scanning: the bulk all-market scan and three-symbol realtime cap keep their existing cadence and limits.

## 2026-09-08 — Anomaly is discovery, not directional proof

- Only a frozen `NEW_MONEY` event may enter as continuation; squeeze, liquidation, and unsupported price shocks remain visible candidates but cannot be converted into directional orders by this release.
- The event must also pass realtime spread/depth, aligned-flow, early-extension, friction-share, and conservative after-cost expectation gates. Passing those gates arms the existing strong-break observer; it does not execute immediately.
- Same-direction impulses keep one event identity through a three-minute quiet re-arm window, and a persisted same-symbol/same-direction closed position enforces a five-minute restart-safe cooldown. This prevents repeated consumption of one funding event without adding D1 or per-snapshot writes.


- 2026-09-07: The +150 U daily number is an aspirational display target, not an execution gate. There is no daily order cap and no daily loss halt in this version; per-entry/portfolio/margin/economic hard limits remain authoritative.
- 2026-09-07: Scan all eligible Gate USDT perpetuals with one bulk ticker request every ten seconds. Never fetch per-symbol detail across the full universe; only three priority symbols receive two-second books and rotating detail.
- 2026-09-07: Retire the fixed three-coin liquidity-route decision as the new-entry authority. Retain its proven execution, protection, persistence, chart, owner security and reconciliation infrastructure.

## 2026-09-07 — Trading health and PAPER maintenance are separate authorities

- `runtime.lastError` may contain a retryable D1 mirror warning while the Durable Object is LIVE and every market feed is fresh. That warning remains visible but cannot make the trading status or health endpoint report recovery.
- PAPER reset is an owner-authenticated, same-origin, explicit-confirmation operation. Every open PAPER position must have fresh evidence and is closed into the normal history outbox before equity becomes 1,000 U and a new cycle begins. It does not inspect or mutate Gate LIVE state.
- Clearing history deletes completed PAPER positions, diagnostics, and account logs while preserving current equity, open PAPER positions, and their entry review events. It clears pending closed-history mirrors so deleted history cannot be recreated later, and it never changes LIVE state.

## 2026-09-07 — 实时条件进场替代交易所预挂

- BREAKOUT、REVERSAL、RANGE 全部由后台内部观察；确认后按当时价格向 Gate 提交 IOC，交易所不再长期保留入场限价单。REVERSAL/RANGE 需要三个连续新鲜两秒证据，BREAKOUT 继续使用四次强势确认。
- 父区间或子区间的首次穿越若确认度至少86%、假突破风险不高于18%且仍在冻结触发位0.5R内，可以在穿越当下建立并确认计划；超过0.5R不追价。
- 当前价格已越过冻结止损或第一目标时禁止生成计划，避免出现“计划创建后同一时刻取消”或在目标之后追单。界面显示每条不可执行路线的具体阻塞原因。
- 盘口OFI与微价格位移使用短窗平滑，降低单个两秒快照翻转。所有改动复用现有两秒盘口，不增加Gate请求、DO/D1写入、组合风险或实盘权限。

## 2026-09-07 — 行情抖动冻结、分币恢复与真实故障撤销

- 生产采样显示后台通常持续推进，但一次正常 Gate REST 延迟可能接近旧的3秒总失鲜线；旧逻辑又会在一次盘口请求失败时立即清空路线、撤销准备计划，因此手机端周期性看到“数据恢复中”，已经等到的订单也被一次网络抖动销毁。
- 两秒采集节奏与Cloudflare请求/写入预算保持不变。Gate公开请求超时放宽到2秒，单份盘口有效窗口放宽到5秒，整个权威循环只有超过8秒没有任何成功行情才判为全局失鲜。
- 恢复改为逐币状态机：第一次关键盘口失败立即冻结该币计划并禁止PAPER成交；若LIVE存在交易所被动入场单则立即撤销，避免断流期间在交易所自行成交。连续两份序列前进的新鲜盘口后才重新放行，并继续使用原冻结边界、止损、目标及0.5R追价限制。
- 一次短暂失败不再删除计划。连续4次真实抓取失败或距离最后新鲜盘口达到15秒才属于持续中断并撤销准备计划；序列倒退/重置、结构失效、越过止损/目标或计划到期仍按原硬规则处理。
- 1m/15m/1h/4h完整结构属于关键证据；OI、主动成交与公开清算属于可选增强证据。后者延迟只显示“确认数据降级”，不能让三币整体停摆。运行时累计短时失败、自动恢复次数、最大观测延迟与当前冻结币数，且不新增逐快照D1写入。

## 2026-09-07 — 边界竞价的强突破、回踩延续与失败反转

- 边界被价格穿越只说明流动性被触发，不等于真突破。直接突破进场改为少数A级路径：冻结方向与当前方向确认都至少86%、假突破风险不高于18%，并连续四个不同两秒快照越过至少0.1R且不超过0.5R；普通完整1分钟外收不再直接追价。
- 普通有效突破必须先由完整1分钟在边界外形成接受，再等待后一根完整1分钟从边界外回踩、守住原边界并重新同向收盘；随后只在重新越过该回踩K线极值且仍在0.5R内时用当前价IOC进场。原边界和结构身份保持冻结，滚动形成的新高/新低不能伪装成新的首次突破。
- 假突破必须由完整1分钟扫过边界后收回区间、反向实体与收盘保持率、吸收以及反向订单流共同确认。确认后不在已经离开边界的位置追反向，而是在区间内部靠近原边界预备被动反抽单；止损位于扫边极值与1分钟噪声缓冲之外，第一目标是同级结构内最近可达的反向流动性，之后节点重新判断。
- `LOCAL_BREAKOUT`/`INTERNAL_ROTATION` 只负责首次穿越观察；新增独立的 `BREAKOUT_RETEST` 和 `FAILED_BREAKOUT_REVERSAL` 路线。三条路径互斥并继续服从单币单生命周期仲裁。旧计划不会被自动反手，现有持仓也不会被新逻辑改写保护位。
- 当前数据足以实现分钟级竞价判断：两秒盘口用于罕见强势直入，完整1分钟用于接受、回踩和失败确认；轮换获取的OI/清算只作加分项，因此不增加Gate请求、DO写入或D1写入。

## 2026-09-07 — 突破分级确认、分段经济性与长期登录

- 生产从 #568 部署到诊断时超过七小时没有新成交，后台健康且行情持续推进；期间 BTC、ETH、SOL 各形成过突破计划但均在入场前取消。问题不是数据中断，而是所有突破统一等待完整1分钟后仍要求价格处于0.5R内，强突破常在确认前已经越界，形成自我阻塞。
- 高质量突破改为实时路径：冻结计划确认度至少78%、当前假突破风险不高于25%、价格至少越过0.1R且不超过0.5R时，需要连续三个不同的两秒盘口快照成立；任一快照失败即清零。满足后 PAPER 与 LIVE 同时放行，LIVE按当前价提交IOC。中等质量仍等待完整1分钟收盘，高假突破风险继续放弃。
- 诊断时 SOL `106.2614 → 106.83` 路线确认度约94.6%、假突破风险约5.5%，但第一段净盈亏比约0.95R、模型净利润11.40U，略低于当时12.04U最低门槛；同一路线已经明确映射下一节点107.13。强分段路线现在可用下一节点做入场经济性，实际持仓目标仍先停在106.83并必须重新判断，绝不把107.13变成无需确认的固定止盈。
- owner 页面退出来自固定8小时登录有效期，不代表Gate凭据丢失。签名HttpOnly、Secure、SameSite=Strict会话延长为30天，并在每次已认证页面打开时重新签发；登录或续期仍不能改变LIVE开关。

## 2026-09-06 — 假突破实时确认、软退出耐心与净保护垫

- 后台最新四笔已结束订单合计净亏 24.85 U，模型费用与压力滑点为 23.54 U，占净亏约94.7%；真实方向毛亏只有1.31 U。四单均未因5%组合风险上限被迫结束，因此把组合风险提高到15%或把单笔风险提高到5%只会放大执行摩擦，不会增加止损价格空间。
- BTC 空单在79,526.05触发时，该分钟最低到79,517.6，但收于79,556.5，重新回到突破位上方，最大顺向仅约0.06R；这是影线刺穿后立即失败的假突破。Gate价格触发单只能判断一次价格穿越，不能同时等待K线收盘，因此BREAKOUT不再向交易所预挂触发单：内部观察计划等官方Gate完整1m K线方向实体一致、收盘至少越过0.1R且保留55%振幅；刚收完的1m数据在三币之间优先刷新，最多约三个2秒循环，然后只在当前价仍位于突破侧且距触发位不超过0.5R时按当前价重算并用IOC实时进场，走远则等待回测而不追价。RANGE/REVERSAL仍预挂被动限价。
- SOL多单从105.675最多走到105.92，约1.2R顺向；目标身份重算后，系统在完整分钟约0.6R逆向时以`TARGET_DISAPPEARED`提前退出，之后价格恢复。这证明软退出的0.25R门槛仍然过敏。目标消失或反向效用继续要求三个不同完整分钟，但现在只有新完整分钟收盘逆向达到至少0.75R才执行；两秒实时价格只能触发原始结构止损，不能触发软退出。
- 最新SOL多单105.575→105.755实际方向毛盈5.48 U，却因5.78 U模型成本显示净亏0.31 U；当前动态保护位恰好只覆盖0.18%模型摩擦，没有留下成交偏差空间。动态保护首次跨过进场价后现在至少锁定“模型摩擦+0.15R”净垫，防止一笔方向正确且已经保护的订单仅因一个价格档位仍显示为亏损。
- ETH多单在首轮修复部署完成前已经成交，冻结的原始止损仅约0.045%；它属于升级时保留的旧持仓，不能用来判断新0.18%/噪声止损下限失效。风险预算继续保持单笔1%–1.8%、组合5%；需要更宽结构止损时仍通过缩小名义仓位腾出价格空间，而不是提高账户最大亏损。

## 2026-09-06 — 四笔原始止损后的执行质量修复

- 后台精确匹配的四笔亏损全部触发原始结构止损；三笔 SOL 的结构止损仅为进场价的约 0.072%–0.080%，BTC 为约 0.128%，均低于模型 0.18% 往返摩擦。四笔净亏 38.03 U 中成本为 24.78 U，占约 65%。因此禁止继续用落在普通 1m 噪声内的极窄止损制造表面高盈亏比。
- 新计划的止损距离至少取 0.18% 与最近 20 根完整 1m K 线区间70分位的1.1倍之较大值；结构本身要求更远时继续使用更远结构位，仓位按新距离重新缩小，5%组合风险不变。
- 区间边缘单必须先出现完整1分钟扫边并收回，随后才可等待回踩成交；当前目标优先取区间中轴，若扣成本1.2R不足才适度延长且最多不超过区间70%，不再把另一侧极值当成唯一结果。小区间突破若最近1h/4h节点较远，先建立0.65%–0.9%的15分钟量度目标，到点后再决定退出或续接高周期节点。
- 同一路线、同方向因原始结构止损后，至少等两根完整1m K线并收复原触发位才可重启。生产中 SOL 22:43 止损后16秒再次接多的22:45订单会被该状态锁拦截；新路线或相反方向不受固定时间冷却误伤。
- BTC 22:31 空单曾从79,476.3走到79,170，约3R有利波动，但完整分钟收于79,441.1，只保留约11.5%的最大推进。突破持仓现在使用完整分钟的极值与收盘共同确认：至少2R且收盘保留不超过30%时记为 `BREAKOUT_PROFIT_REJECTION` 并退出；普通几秒波动仍不能触发该规则。

## 2026-09-06 — 本地路线独占执行与远端节点隔离

- 生产证据显示 ETH 在约 2,500 时生成了 2,419.4973 的 `RANGE LONG` 准备单；它没有 `routeId`，而当时真实 15m 区间是约 2,491–2,502.29。这证明旧 `decideThreeState` 回退越过了已经存在的15分钟路线，把远端高周期流动性插值成了当前入场位。
- 只要有效15分钟结构生成了路线列表，只有 `selectRouteDecision` 可以产生订单；路线均未达到执行条件时必须 WAIT，不再回退旧通用决策。无路线时的通用计划也只能在当前价 0.75% 内准备。
- 当前小周期段从 15m、1h、4h 结构中按价格选择最近节点，并限制为随15分钟区间宽度变化的 1.2%–1.5% 最大跨度。更远的高周期流动性仅保留为全局背景，等待价格接近后重新建立下一段。
- 已存在但没有路线身份、且本地路线已经存在的准备单属于硬错误，立即以 `NONLOCAL_FALLBACK_CANCEL` 撤销，不进入两根1分钟软失效等待。新生成的无路线通用计划自身携带0.75%激活上限，超过即不会建立或继续等待。

## 2026-09-06 — 决策迟滞与分级持仓保护

- 已准备计划不再被触发瞬间的单个两秒订单流分数否决。突破计划形成与触发使用同一冻结判断；触发时只重新核对真实成交价下的结构止损、目标是否已经越过、组合风险和扣成本经济性。
- 路线/目标短暂消失、路线跌破较低的迟滞阈值或价格离开激活邻域属于软失效，必须在两个不同的已收盘 1m 时点连续成立才撤单；行情失鲜、序列故障、15 分钟到期和价格已经越过冻结失效位仍立即撤销。
- 持仓前两分钟除原始结构止损、目标/节点到达外不使用软退出。之后目标消失或反向效用必须连续三个已收盘 1m 时点同因成立，并伴随至少 0.25R 的实际逆向价格移动，才允许提前退出。
- 动态止损只按已收盘 1m 节点更新：最大顺向波动不足 1R 时保持原始止损；达到 1R 后最多先将剩余风险降至 0.5R；顺向波动覆盖模型往返成本并额外达到 0.5R 后才越过进场价，随后只允许单向渐进收紧。
- `STRUCTURAL_STOP` 仅表示原始结构止损；收紧后的保护位触发记为 `DYNAMIC_PROTECTION_STOP`。页面和历史同时展示原始止损与当前保护位，避免把正常动态保护误报为方向判断错误。

## 2026-09-06 — 多周期分段流动性路线

- 单币不再只有一个扁平预测。系统从最近 12 根已收盘 15m K 线识别重复上下边界，同时保留向上突破、向下突破和两侧吸收回撤软路线；软路线不提交 Gate、不占保证金。
- 当前 15m 边界突破只交易到最近可达的 1h/4h 流动性节点。该节点同时是本段目标和下一次决策门：价格到达后重新判断拒绝、吸收或延续，只有更高确认阈值通过才启动节点上方/下方的下一段。
- 4h K 线由现有连续已收盘 1h 数据按交易所时间桶聚合，不新增 Gate 请求。15m 区间与 4h 结构都有独立新鲜度；任一缺失时相关路线失败关闭。
- 假突破过滤联合订单流、微价格、主动成交、OI、清算和 1m/15m/1h/4h 方向。突破路线只有靠近自适应激活区、确认分数合格且假突破风险不过线时才进入单执行仲裁；触发时再次确认。
- 任一币同一时刻仍只允许一张真实入场单。远期路线只能观察；现有 PREPARED 计划保留 15 分钟硬有效期，并在路线消失、目标消失、行情失鲜或价格离开激活区时提前自动撤销。
- 杠杆不再用占权益 60% 的展示档位。PAPER 与 LIVE 共用安全杠杆函数，目标单计划约占 10% 保证金，全部挂单与持仓保证金不超过权益 30%，并在预计强平边界前保留约三倍结构止损距离。提高杠杆绝不提高名义仓位或 5% 组合止损风险。
- 图表默认只绘制当前执行段和 15m 边界；超出当前 K 线视窗的高周期目标显示为图外标签，不参与 Y 轴缩放。卡片另用紧凑路线表展示其他软方案，避免 K 线被远端水平线压扁。

- Market states are mutually exclusive: BREAKOUT, REVERSAL, RANGE; otherwise WAIT.
- Inputs are predictive liquidity, path resistance, active-flow/price response, entry-price OI cohorts, public liquidation calibration, and completed 1m/15m/1h structure. Lagging oscillator and historical-analog systems are retired.
- The universe is permanently limited to BTC_USDT, ETH_USDT, and SOL_USDT. Restart recovery prunes every old symbol from the authoritative checkpoint, so ZEC and prior rotating markets cannot return.
- Every structural loss calculation includes fees and stress slippage; total open risk is capped at 5% of current PAPER equity. Stops only tighten in 0.1R steps. Holding time and take profit are not fixed, and there is no PnL pause.
- LIVE is a separate execution lane over the exact same frozen plan, never a second strategy. It defaults off and can change only after `owner` login with an HttpOnly signed session and a same-origin JSON mutation. Login and deployment never auto-enable it.
- BREAKOUT is internally confirmed and then uses a Gate IOC market entry; REVERSAL and RANGE use Gate GTC limit entries. Turning LIVE off cancels unfilled entries but never abandons an open position. Every live position receives a reduce-only exchange stop and remains under dynamic strategy exits until flat.
- Ambiguous Gate submissions are reconciled by unique tags and order status before retry. Unrecognized Gate orders/positions or hedge mode block LIVE startup; failure to create or tighten protection requests a reduce-only market close.
- Cloudflare Free uses REST alarms, not a high-frequency WebSocket. Planned DO requests and writes stay below 55,000/day and D1 billed writes are hard-gated below 5,000/day.
- The encrypted credential row id=1 remains byte-for-byte unchanged through cutover. Old business tables and old Durable Object classes are removed only after the new v6 Worker proves healthy.
- The v6 create-only deployment uses generated inert exports for retired Durable Object classes because Cloudflare requires them until v7 applies delete-class. These shims are not bound and are absent from the final v7 entry.
- The public dashboard remains read-only and exposes only plain-language decisions plus cached PAPER history. Authenticated owner responses may additionally expose Gate balances and managed order/position metadata, but never credentials.
- Every market card decides freshness independently. Its switchable 1m/15m/1h chart reads a bounded D1 mirror of the same actual completed Gate candles already collected by the 24-hour MarketStream authority, avoiding a second ad-hoc Gate request path and avoiding foreground contention with the authority. It overlays liquidity, trigger, invalidation, target, or live position levels; execution intent remains explicit text rather than an ambiguous drawing.
- A prepared entry is a frozen, executable thesis, not a two-second moving suggestion. It lasts at most 15 minutes; no neutral, same-side, or opposite-side recalculation may move or replace it. It cancels for authoritative data faults, target disappearance before the trigger, expiry, or trigger-time risk/economic failure. Every plan and actual trigger fill must retain at least 1.2:1 net reward/risk after modeled 0.18% round-trip friction; REVERSAL/RANGE additionally require absorption of at least 0.55 at the trigger.
- Routine main releases run one full deploy acceptance gate; the identical monitor remains scheduled every six hours instead of repeating immediately after every successful deploy.
- Live enabling is transactional for actual Gate mutations, while a candidate that cannot fit exchange lot size, remaining 5% risk, economics, or margin is a nonfatal per-symbol skip. Affordable candidates continue and LIVE remains operational; skipped reasons are exposed on Live Orders. Any actual submission failure still forces the switch back off and reconciles/cancels every system-tagged entry; turning the switch off performs the same forced reconciliation even when runtime memory is empty.
- Only Gate orders tagged with the system entry prefix may be treated as recoverable orphans. The owner has a separate authenticated cleanup action for those orders; manual Gate orders are never cancelled by that action.
- Gate API save/replace/delete lives in the authenticated Live Center. Save validates the account read-only, encrypts server-side, never returns the secret, and never enables LIVE. Delete is allowed only while LIVE is off and no managed position or pending entry remains; scheduled schema monitoring accepts either zero or one credential row.
- The Brain decision hero and PAPER account summary belong only to the Brain tab. Orders, Live, History, and Settings start directly with their own content; the fixed iPhone bottom navigation remains global.

# 2026-09-06 — 共享仓位上限与模拟账户破产日志

- PAPER 与 LIVE 先按账户权益比例使用同一个仓位函数：单笔结构风险随置信度在账户权益 1%–1.8% 之间变化，计划名义价值上限为权益 4 倍，组合风险不得超过 5%。若按比例后的实盘仓位不足 Gate 不可分割的 1 张合约，只允许取整到 1 张，并重新核对真实保证金、目标经济性和 5% 总风险；任何一项不合格就只跳过该币，不关闭整个实盘。
- 除至少 1.2:1 扣成本盈亏比外，目标扣除 0.18% 模型往返成本后的利润空间还必须达到当前账户权益 1.5%。以 1,000 U 为例，单笔名义价值最多 4,000 U、模型往返成本最多 7.2 U、可接受目标的净利润空间至少 15 U；这些是进场门槛，不是收益保证。
- PAPER 权益达到 300 U 时判定本轮破产。系统先取消准备计划，并只使用三秒内的新鲜价格结束尚存 PAPER 仓位；没有新鲜价格时继续保护而不以旧价结算。全部结束后，权威状态先将完整报告与新周期一起写入 Durable Object 检查点，再异步幂等写入 D1。
- 每份破产报告保存逐单诊断、方向正确率、曾经覆盖成本的顺向波动比例、目标到达率与进度、止损命中和最大逆向波动、净盈亏比、成本、持仓时长、退出原因，以及按币种/三态/方向的分解和自动排序的主要原因。报告永久显示在历史页的“账户日志”，并可复制为 JSON 发给 Codex。
- 归档完成后立即建立新的 1,000 U PAPER 周期，不设置亏损暂停。部署升级不会重置当前模拟权益：缺少周期字段的旧检查点以当时实际权益作为第一轮起点。

# 2026-09-06 — 亏损归因、动态退出去噪与逐单复盘

- 生产的首批 6 笔已结束订单全部只持有 2 秒；两笔 BTC 在进出场价格完全相同的情况下只损失往返成本，另有一笔 SOL 毛盈利但仍被成本变成净亏。这证明首要故障是两秒流动性重算直接触发退出，而不是六次方向判断全部错误。
- 结构止损继续实时执行。`TARGET_DISAPPEARED` 和 `OPPOSITE_UTILITY_DOMINANT` 改为必须在进场后两个不同的已收盘 1m K 线上连续成立；同一分钟重复轮询不重复计数，信号恢复就清零。反向效用阈值提高到原目标效用的 1.5 倍。
- 目标身份允许同方向、价格相差不超过 0.15% 的连续区域，避免订单簿分桶抖动把同一目标误判为消失。PAPER 与 LIVE 使用完全相同的目标连续性和确认逻辑。
- 历史订单的真实 Gate 1m 进场片段随 OPEN 写入，出场片段在已收盘 K 线可用后补齐；每单最多保存 120 根，保留开头 40 根与结尾 80 根，受既有 D1 4,800 次/日硬上限约束。
# 2026-09-06 — Gate 撤单必须用无损订单 ID 并回查确认

- Gate 的 int64 订单编号在所有响应中都先转为字符串，禁止经过 JavaScript `number`。
- 关闭实盘和手动清理只撤销本系统 `t-ms-e-` 入场挂单或运行时已记录的订单 ID，不碰手工订单与 reduce-only 保护单。
- 撤单请求后重新读取 Gate；最多再试一次，仍存在就返回失败并保持实盘关闭，不再把“请求已发出”当作“撤单成功”。

# 2026-09-06 — Gate 触发有效期与页面会话状态

- Gate 价格触发单有效期只能使用86400秒的整数倍且最多30天。此前突破入场提交1天、保护止损提交30天；当前突破入场已被收盘确认后的IOC实时单替代，价格触发单只继续用于保护止损。内部15分钟计划到期仍由两秒运行循环主动撤销，不能把交易所有效期当作策略有效期。
- 五个主页面和实盘的三个子页面在当前打开期间分别保存滚动位置；主页面内容保持挂载，以保留 K 线周期、展开项、实盘子页和 API 表单状态。关闭或重新载入页面后允许重置。
- 全局右上角不再重复提供模拟/实盘切换；实盘开关只保留在实盘账户与设置页。
- 模拟订单页分组显示当前持仓、等待进场和最近 15 分钟刚结束的订单。这样两秒内完成、快于页面轮询的真实模拟成交也不会从用户视野中消失；历史数据同时每 15 秒刷新。
# 2026-09-07 — Parent/child structure semantics (authorized, implementation pending)

- The candle interval is not the structural grade. The current twelve-completed-15m-candle quartile box is a child balance when it is nested inside a broader repeated 15m balance.
- A child break inside the parent is `INTERNAL_ROTATION` and may target the parent boundary; only acceptance beyond the parent boundary is a parent `LOCAL_BREAKOUT`.
- Breakout plans must be armed while price remains on the pre-trigger side. Already-crossed, consumed, or structurally replaced boundaries are missed/invalid and cannot be revived as fresh breakouts.
- The actual first target alone must pass net economics. A farther 1h/4h node cannot subsidize admission before price reaches and re-evaluates the nearer node.
- This correction does not increase leverage, per-trade loss, aggregate risk, request cadence, or LIVE authority.
# 2026-09-07 — Range sweeps are evidence, not passive entries

- The reproduced SOL plan `105.08061 / 104.89146 / 105.75132` placed its stop roughly 0.18% below entry inside a price area already visited by repeated 15m lower wicks. The upstream defect is not only stop width: a passive RANGE buy fills while the boundary sweep is still moving down, before the market proves a reclaim.
- A new RANGE lifecycle observes the frozen edge without reserving an exchange order, records the sweep extreme, and trades only after reclaim evidence. Exceptional real-time reclaim may use consecutive fresh books; ordinary reclaim uses completed 1m evidence and a later boundary retest/reacceleration. Failure to reclaim is outside acceptance and cancels the range thesis rather than filling it.
- RANGE and BREAKOUT no longer share invalidation semantics. A reclaimed RANGE position may survive an ordinary wick through the edge, protected by a hard stop beyond the observed sweep/structure/noise envelope. Persistent completed-minute acceptance outside may exit earlier at a controlled loss. Weak reversal flow alone is not an exit while price remains accepted inside the balance.
- The aggregate structural-risk hard ceiling becomes 10% for PAPER and LIVE, with adaptive 1.5%–3% per-entry risk and a lower same-direction BTC/ETH/SOL correlated-risk ceiling. The 10% ceiling is capacity, not a target; wider stops still reduce notional, and leverage still only releases margin. Existing positions are not resized or widened during deployment.

# 2026-09-07 — First-target progress replaces MFE-percentage trailing

- The observed ETH RANGE long entered at 2,498.135 and exited at 2,503.235 with 6.33 U gross but 5.58 U modeled cost, leaving only 0.75 U while price later resumed upward. The exit price matches the old rule that locked roughly 35% of a confirmed favorable excursion, proving that the protection sat inside an ordinary pre-target pullback.
- A routed trade already has a frozen first liquidity node that is checked on every fresh two-second price. Therefore an aggressive pre-target profit trail is redundant: it reduces target-hit probability without adding a distinct thesis invalidation.
- Before the first node, completed target progress—not MFE—is the protection clock. At 1.5R and 70% progress, the system may reduce remaining loss to 0.5R but cannot cross entry. Target arrival still exits or hands off to a confirmed continuation, where the next segment's structural stop becomes valid.

# 2026-09-07 — Position PnL display and line-chart data source

- PAPER and LIVE position cards use the same mark-to-market formula. “浮动盈亏” is gross USDT before closing friction, “保证金收益率” is gross PnL divided by the displayed position margin, and direction-adjusted price return is shown separately so leverage does not hide the underlying move.
- A position line chart reads the already-mirrored 1m candle cache once when mounted, aggregates it into 5m closes in the browser, and appends the midpoint already present in the page's 15-second runtime response. This makes the trend more legible without starting another Gate request stream or increasing Durable Object polling/writes.
- Entry is rendered as an exact time/price point rather than a full-width level. Historical order review uses the same 5m close line with distinct entry and exit points; structural stop and planned target remain reference levels so current PAPER, current LIVE, and historical diagnosis share one visual grammar.
- A stale midpoint may remain visible and is explicitly labeled as the last backend price, but it cannot create a chart point that changes execution authority; trading continues to use the existing per-symbol freshness gates.

# 2026-09-07 — Sweep/reclaim is a bounded event, not one candle

- Production showed a lower-edge sweep and later return into a newly calculated 15m balance, but the runtime exposed neither rebound nor rebreak as an auction. The old observer required one 1m candle to both sweep and reclaim, retained realtime evidence for only three minutes, and deleted it when the exact rolling range id changed.
- The authority now replays at most 90 already-fetched completed 1m candles into a bounded in-memory event. It accepts either a directional retained reclaim or two consecutive inside closes, keeps compatible boundary identity through a range-id roll, and invalidates reclaim only after two completed outside closes.
- A completed reclaim remains observation until a later completed inside retest holds the boundary. The rebound and renewed-break routes coexist, but ordinary arbitration can promote only one. A first target that cannot pay for the structural stop remains visible and non-executable instead of being mistaken for no detected opportunity.
- This event memory is in-process and reconstructed from the next existing 1m response after a restart. It adds no Gate request, alarm, D1 write, leverage, risk, or LIVE authority.
# 2026-09-08 — Complete PAPER history and isolated review charts

- PAPER history is a deterministic cursor API ordered by `COALESCE(exit_at, entry_at), id`; the page follows cursors rather than silently truncating at 60 rows.
- Only History renders charts. Brain, PAPER Orders, and LIVE retain prices/PnL/risk text but no longer draw market or open-position charts.
- A historical review is fetched on demand from Gate as completed 5m OHLC data, cached at the Worker edge, and refreshed once a minute until the last completed candle reaches exit plus twelve hours. This adds no Durable Object alarm request and no D1 write.
- Exact B/S markers encode the actual action: long entry B and exit S; short entry S and exit B. Original stop and planned target remain reference lines.
- Bankruptcy archival waits for the position outbox, reads every cycle-scoped `ORDER_CLOSE_DIAGNOSTIC` row from D1, and rebuilds the permanent report before writing it. The checkpoint can remain bounded while Account Logs still exposes the complete failed cycle order by order.
# 2026-09-08 — Warmup is authoritative metadata; charts are retired

- The authority's `WARMUP_SNAPSHOTS` is the only warmup threshold. The page reads `runtime.limits.warmupSnapshots`; it must never duplicate this value. The observed constant “还差26次” was `30 - 4`, while production evidence was already fresh, entry-ready, and at 4/4.
- Entry readiness is irrelevant after a position is open. With a fresh book, an open card explains its active stop/target/soft-exit management even if optional structure is refreshing; with a stale book it explains that old prices cannot drive an active close.
- User-facing charts are retired. The Worker no longer exposes `/api/candles` or `/api/order-chart`, fetches on-demand Gate 5m review history, mirrors candle bundles to D1, or stores `ORDER_ENTRY_CHART`/`ORDER_EXIT_CHART` events. Existing schema columns may remain inert for migration compatibility.
- History remains a complete cursor-paginated audit. It is fetched only when the review tab opens; later one-minute refreshes merge only the newest 100 rows. Static order data exposes entry/exit, gross PnL, modeled cost, net PnL, realized R, stop, target, duration, and exit reason without external market requests.
- “Realtime” is explicitly layered: roughly ten-second bulk tickers cover all eligible contracts, at most three promoted symbols receive two-second order books plus rotating detail, and the phone polls a read-only summary every fifteen seconds. This is current and sufficient for the implemented REST strategy, but it is not a complete tick-by-tick feed for every Gate contract.

## 2026-09-08 — False-rejection labels require isolated rule failures

- The original per-rule totals remain useful for screening but are correlated: one shadow order can contribute the same outcome to several failed rules. They may no longer produce a false-rejection label.
- Forward attribution records the admission-order primary blocker, exactly-one-rule failures, and the complete unique rule combination. Only exactly-one-rule failures may become a preliminary suspected false rejection after the existing sample, post-cost profitability, average-net-return, and target-versus-stop thresholds pass.
- Existing aggregate history is preserved. New attribution buckets start empty on an old checkpoint instead of backfilling only the bounded recent tail and misrepresenting it as complete history. Pending old-version samples retain enough frozen data to enter the new buckets when they resolve.
- Rule combinations are capped at 64 identities; overflow is counted and exposed. The upgrade adds no market request, D1 write, trading mutation, strategy threshold change, risk, or LIVE authority.
# 2026-09-09 — Strategy rotation requires short evidence, not one lucky win

- “All market strategies” is bounded to ten interpretable families fully supported by the existing ticker, order-book, completed-candle, signed-trade, OI and liquidation inputs. No synthetic strategy may silently require unavailable tick history or external indicators.
- One profitable shadow trade is not promotion evidence when many strategies compete. Promotion uses the user's fast-rotation intent but requires a rolling 6-trade window, at least 4 after-cost wins, and positive window net return.
- Every strategy keeps its own 1,000 U validation ledger. This prevents multiple strategies on one market event from hiding individual losses in a combined account.
- Two consecutive PAPER losses remain the hard demotion rule requested by the user. A non-positive rolling 6-trade PAPER result is an additional regime-change guard.
- The arena is research-only: no strategy result feeds the legacy PAPER executor or LIVE coordinator. Old PAPER history is deleted by migration and version cutover; Gate credentials and LIVE reconciliation state are preserved.
# 2026-09-09 — V4 uses rolling evidence and one dynamic-risk account

- Observation shadows never count. Effective shadows require a fresh executable bid/ask, live entry location, structure/noise stop, cost-covering target, two-sided depth, sufficient turnover and complete Gate contract metadata.
- Strategy activation is exactly latest-three independent effective-shadow wins OR positive latest-six after-cost total. Deactivation is exactly latest-three PAPER losses OR non-positive latest-six PAPER total. Demotion requires a newly resolved effective shadow before reactivation.
- Regime absence is `SLEEPING`, not failure. It retains evidence and enabled intent, resumes only when its channel returns, and opens nothing while asleep.
- Confirmation/retest variants freeze different trigger locations; fast/structure variants freeze different targets and holding/no-progress horizons. Equal conditions may not create a second score identity.
- The unified account has no product-level three-position quota. Each entry risks continuously 1%–2% of current equity; admission is bounded by 10% total stop risk, 6.5% same-direction risk, 30% margin, 4× total notional, one symbol/event winner and ten actively manageable symbols.
- The 10-second scan is limited to the thirty most liquid eligible Gate USDT perpetuals. PAPER/LIVE and effective-shadow exposure retain deep-data priority; stale or insufficient management capacity blocks only new entries and never executes an old-price exit.
- V3 account exposure survives restart until every open symbol has a fresh executable quote, then it is settled and archived. V4 starts at 1,000 U with fresh effective-shadow evidence; old trade/cycle history remains available. LIVE is forced OFF across the cutover.

# 2026-09-09 — Bulk radar failure is optional degradation, never execution failure

- The two-second authority must process current PAPER books and any LIVE reconciliation before attempting the optional ten-second whole-market ticker scan.
- A bulk radar failure retains the last successful 30-market snapshot and retries at most once per normal ten-second scan. The earlier 15/30/60-second backoff was removed because it could starve the 18-observation regime warmup and repeatedly reset profiles after five-minute gaps. Failed attempts do not update success time, do not enter global `lastError`, and do not increase the normal request cadence.
- A partial failure among ordinary candidate-market books stays in per-symbol diagnostics. It degrades the whole authority only when no market snapshot succeeds or protected-position data is unavailable; every failed symbol remains individually blocked from new entries.
- The all-market ticker payload has a dedicated four-second timeout; position-book and other execution-path requests retain their two-second timeout. Radar still runs after PAPER books and LIVE reconciliation, keeping the current management pass ahead of optional scanning while allowing the larger bulk response to survive ordinary network jitter.
- Radar candidates older than 30 seconds cannot create new strategy observations, effective shadows, or simulated orders. Existing PAPER/LIVE positions continue to use only their independent fresh bid/ask path.
- The phone shows the dedicated Chinese radar-delay notice only once the last successful scan is over 30 seconds old; a single transient timeout is silent. One successful scan clears the failure state automatically.

# 2026-09-09 — Permanent operational path memory

- Source of truth is `alicia5574188-del/market-sentinel-free` on GitHub `main`; production releases only through `.github/workflows/sentinel-v2-ci.yml` to the configured Cloudflare Worker. Do not use old branches or alternate sites.
- Scratch absolute paths and linked worktrees are temporary. If a saved worktree points to a deleted scratch Git directory, make one fresh shallow clone of the source-of-truth repository instead of probing unrelated folders.
- If local Git push lacks credentials, use the connected GitHub Git Data API once: read current `main`, create changed blobs/tree/commit, and fast-forward `main`. Do not retry the same unauthenticated CLI push.
- Production truth comes from the matching GitHub Actions run, deploy-job log, Cloudflare version ID, and its advancing `/__health` gate. Direct Chrome navigation to public JSON endpoints can be blocked by the client and is not a valid failure signal; inspect the rendered production page only for UI state.

# 2026-09-10 — Runtime health is not opportunity availability

- A current authority can be operational while individual candidate markets warm, rotate, or temporarily have no entry-ready setup. Those conditions may block the affected new orders but are not a whole-system recovery event.
- The operator badge reports recovery only for stale/absent authority, reconnecting state or required checkpoint recovery. Optional mirrors and isolated market retries are warnings; risk and protected-position blocks get their own truthful messages.
- `/__health` accepts an operational `DEGRADED` authority only when protected markets are ready. `WARMING` remains unready for release gates, and stale prices, complete snapshot loss and protected-market loss remain fail closed.

# 2026-09-10 — Six normal outcomes are the reverse promotion sample

- The exact normal variant's latest six independent effective-shadow paths are sufficient reverse evidence when they contain at least three stops, normal gross and net totals are negative, and replaying the opposite direction with swapped stop/target remains positive after complete modeled costs.
- Passing that proof enables the countertrend route for the next new executable signal. A second three-win or positive-six reverse-shadow promotion window is redundant and forbidden.
- Normal and reverse shadows continue after activation. Current-signal geometry, cost, depth, freshness, Gate lot sizing and portfolio limits still apply; reverse PAPER results alone control later reverse demotion.
# 2026-09-10 — Effective shadow is the only strategy authority

- A valid latest-six independent effective-shadow window is authoritative and is evaluated before either latest-three streak. Positive after-cost six selects normal; negative six may select reverse only when the same frozen paths remain positive after full reverse cost. Before six valid results exist, three wins or three losses provide the corresponding early decision.
- Normal and reverse are mutually exclusive states and refresh after every normal effective-shadow close. PAPER outcomes remain account-performance evidence only and cannot independently promote, demote, or preserve an orientation that current shadow evidence no longer supports.
- All genuinely distinct executable variants continue in shadow. A PAPER order may originate only from an effective shadow opened in the same event and copies that exact frozen route and accepted account sizing; results are attributed only to that exact strategy/orientation. Execution freshness, contract, depth, cost geometry and portfolio limits remain mandatory.

# 2026-09-10 — Phone transport age is never trading authority

- `/api/runtime` freshness describes only whether the phone has received a recent summary. It may alter the page status label and warning color, but it cannot determine or describe MarketStream's order authority.
- MarketStream's own `state`, `stale`, `authorityReady` and protected-market readiness remain the backend truth. A genuine backend failure may still stop new entries; 29/30 completed-candle coverage or a delayed phone poll may not stop the other usable markets.

# 2026-09-10 — Countertrend evidence uses alternative rolling windows

- A countertrend candidate may qualify from either the exact normal variant's latest three independent losses or a negative total across its latest six independent results.
- Qualification still requires the reversed path over the selected window to be positive after full modeled cost. This prevents fee-only normal losses from being mislabeled as profitable reversals and is execution evidence, not a second promotion stage.
- Existing compatible V4.4 shadows are eligible immediately; only a prior countertrend PAPER demotion requires newer normal evidence.
# 2026-09-10 — Owner reset confirmation is one exact contract

- The public client and owner-only route must both use `RESET_PAPER`. A source-contract test guards this literal so a UI refactor cannot silently make reset unusable again.
- Reset authorization remains owner session + same-origin JSON + LIVE fully off. The operation uses fresh executable prices, archives the account cycle and preserves shadow research; deployment itself never invokes reset.
# 2026-09-10 — V5 authority is conditional expectancy, not strategy promotion

- The twelve playbooks remain bounded raw hypothesis generators for compatibility and continuous counterfactual research; they are no longer PAPER authority. A unified controller groups them into materially distinct profit mechanisms and selects by current-state similarity-weighted, walk-forward, fully costed evidence.
- Normal and opposite directions are evaluated as independent mechanisms. A losing normal route never proves that swapping its stop and target is profitable.
- Holding horizon is selected from completed-candle path evidence. Generic `TIMEOUT` is replaced for V5 entries by explicit thesis/edge-decay semantics; legacy open positions keep their frozen V4 management.
- The account's aspirational daily objective is +10%, used only to rank positive-expectancy capacity. It cannot create trades, raise risk caps or weaken data/execution gates.
- Older analogous paths select the horizon; the newest 30% of the analogous paths are held out and must independently confirm positive after-cost expectancy. PAPER then freezes that exact validated direction, stop rate, target rate and horizon.
- Approved adaptive routes outrank research-only candidates for scarce fresh-book capacity. The existing five-minute D1 log records each route's samples, confirmation return, expectancy, profit factor, target reach, opportunity rate, score and rejection reason without adding a write.
# 2026-09-11 — Critical books are isolated from optional market refresh

- A 429 belongs to one Gate host and endpoint, not to every official host for that endpoint. The second official futures host remains immediately eligible, and executable order-book reads try it before suspending the affected market. Owner trading credentials remain excluded from public data reads because signing the same public REST data would not create an independent market-data authority.
- The Durable Object alarm re-arms first, completes executable books and publishes critical health before launching universe, ancillary candle, bulk radar and research-log work. Only one optional task may run at once; delayed optional work is skipped rather than queued, so it cannot hold the next two-second protection/entry pass.
- A transient data pause overlays the retained strategy stage. Completed paths, environment candidates and current route checks stay visible; recovery uses a newly verified bid/ask and may proceed only if the retained route is still inside its original executable geometry. No old-price order is permitted.

# 2026-09-11 — Staggered subset misses are not global outages

- Resident markets are intentionally staggered, so `zero successes` in one alarm describes only that alarm's scheduled subset. It must never be expanded to the ten-market pool or reset global authority while another executable snapshot remains within the eight-second freshness window.
- Isolated subset misses remain visible in rolling feed quality and per-market readiness. Global reconnect is reserved for actual authority expiry; a failed protected position or formed execution route remains an immediate exposure-specific trading block.
# 2026-09-11 — Position count is an outcome, not an admission rule

- Remove the fixed three-position and top-three-rank vetoes. Simultaneous positions are determined by current executable data plus the unchanged 10% portfolio risk, 6.5% same-direction risk, 30% margin, integer-contract, depth and one-position-per-symbol rules.
- The ten-symbol real-time surface remains a physical management boundary, not a promised ten-position target. It is not expanded in this correction because doing so would change the repaired Gate request cadence.
- LIVE uses the selected PAPER trade's notional-to-opening-equity fraction against actual Gate equity. Exchange lot rounding may make the realized fraction differ slightly; failure to fit actual funds, risk or economics skips that LIVE entry and leaves PAPER unchanged.
- “Exact strategy copy” includes the latest PAPER active protection stop, not only its original structural stop. Strategy family mapping must also preserve reversal/range/trend identity in the LIVE record.

# 2026-09-11 — V12 fills opportunity gaps only with cross-period phase evidence

- The observed three-hour no-entry interval occurred with 30/30 retained paths, ten actionable real-time markets, no data blocker and LIVE OFF. It was a route-coverage gap: only a `衡返` short reached checking and its target could not pay full executable cost.
- Direct trend resumption, broad-market catch-up, quiet drift/rotation, compression retest, impulse recoil and quiet sweep were tested causally and rejected because at least one train, held-out or chronological fold lost after 0.14% friction and 0.025% adverse next-bar entry. They do not become production strategies.
- `脉折` compares a 32-segment path with the latest six-segment contribution, requires a completed opposite reclaim, then uses synchronized market breadth to choose isolated reversal or crowded-direction continuation. `缓续` uses a less orderly 36-segment path but is authorized only when broad crowding confirms continuation; its neutral reversal half failed and is excluded. Both normalize by current path range rather than a fixed absolute volatility threshold.
- Initial PAPER authority requires both chronological halves and every one of three folds to remain above PF 1 with useful counts. Each new mechanism also requires at least thirty event identities absent from both the other accepted mechanism and current `竭转`; actual unique counts materially exceed that floor.
- Strategy direction, stop, profit arm, no-progress time and maximum hold are frozen from the accepted branch. The crowded continuation branch may not reuse reversal geometry. V11→V12 is an additive state migration: current account equity, open exposure and history survive; deployment does not reset or enable LIVE.
