"""Research-only inventory-aware control. No production imports or trade API.

The first experiment isolates a continuation-value controller, NOT a release
candidate. Funding is an adverse allowance, not reconstructed exchange funding.
Gate lots, mark-price liquidation and live fill parity are deliberately not
claimed. Historical data have already been inspected in earlier research.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
import unittest
from urllib.request import Request, urlopen

import numpy as np

SYMBOLS = ["BTC_USDT", "ETH_USDT", "SOL_USDT"]
NSTATE = 81
TRAIN_HOURS = 180 * 24
REFIT_HOURS = 7 * 24
PRIOR = 64.0
FUNDING_ALLOWANCE_DAY = 0.0002  # scenario only: adverse 2bp/day, both sides
WEIGHTS = np.array([[0., 0., 0.]] + [
    [s * size if j == k else 0. for j in range(3)]
    for k in range(3) for s in (-1., 1.) for size in (0.5, 1.)])


def utc(value: str) -> int:
    return int(datetime.fromisoformat(value).replace(tzinfo=timezone.utc).timestamp())


def market_states(c: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Every state uses its own completed candle and older candles only."""
    n = len(c)
    out = np.full(n, -1, dtype=int)
    lr = np.diff(np.log(c), axis=0, prepend=np.log(c[:1]))
    for i in range(49, n):
        vol = max(float(np.median(np.std(lr[i-47:i+1], axis=0))), 1e-6)
        r6 = c[i] / c[i-6] - 1
        tr = float(np.median(r6)) / (vol * np.sqrt(6))
        impulse = float(np.median(lr[i])) / vol
        vb = float(np.median(v[i] / np.maximum(np.mean(v[i-24:i], axis=0), 1e-12)))
        a = int(tr > -0.7) + int(tr > 0.7)
        b = int(impulse > -0.7) + int(impulse > 0.7)
        d = int(vb > 0.7) + int(vb > 1.4)
        leader = int(np.argmax(r6))
        out[i] = ((a * 3 + b) * 3 + d) * 3 + leader
    return out


def model(states: np.ndarray, opens: np.ndarray, i: int):
    # Feature i is known at close i. Execute at open i+2: one full bar delay.
    # Label j ends at open j+3. Require j<=i-3: strictly known before decision.
    j = np.arange(max(49, i-TRAIN_HOURS), i-2)
    assert len(j) and int(j[-1])+3 <= i
    a, b = states[j], states[j+1]
    r = opens[j+3] / opens[j+2] - 1
    if (a < 0).any() or (b < 0).any() or not np.isfinite(r).all():
        raise ValueError("invalid training observations")
    counts = np.bincount(a, minlength=NSTATE).astype(float)
    prior_next = np.bincount(b, minlength=NSTATE).astype(float) + 1.0
    prior_next /= prior_next.sum()
    trans = np.zeros((NSTATE, NSTATE))
    np.add.at(trans, (a, b), 1)
    trans = (trans + PRIOR * prior_next[None, :]) / (counts[:, None] + PRIOR)
    raw = r @ WEIGHTS.T
    # Second-order expected log-growth approximation; not an exact optimizer.
    raw = raw - 0.5 * raw**2
    reward = np.zeros((NSTATE, len(WEIGHTS)))
    np.add.at(reward, a, raw)
    reward /= counts[:, None] + PRIOR  # zero-edge shrinkage, no PnL promotion
    reward -= FUNDING_ALLOWANCE_DAY / 24 * np.abs(WEIGHTS).sum(axis=1)
    return trans, reward, int(j[-1])+3


def policy(trans: np.ndarray, reward: np.ndarray, fee: float, horizon: int):
    switch_cost = fee * np.abs(WEIGHTS[:, None, :] - WEIGHTS[None, :, :]).sum(axis=2)
    value = np.tile(-fee * np.abs(WEIGHTS).sum(axis=1), (NSTATE, 1))
    pi = np.zeros_like(value, dtype=int)
    for _ in range(horizon):
        future = trans @ value
        q = reward[:, None, :] + future[:, None, :] - switch_cost[None, :, :]
        pi = q.argmax(axis=2)
        value = q.max(axis=2)
    return pi


def transact(equity: float, qty: np.ndarray, prices: np.ndarray, w: np.ndarray, fee: float):
    """Self-financing futures resize; charge actual changed notional once."""
    after = equity
    for _ in range(30):
        target = w * after / prices
        new_after = equity - fee * np.abs((target-qty) * prices).sum()
        if abs(new_after-after) < 1e-10:
            after = new_after
            break
        after = new_after
    target = w * after / prices
    notional = float(np.abs((target-qty)*prices).sum())
    if after <= 0 or abs(after - (equity-fee*notional)) > 1e-7:
        raise ValueError("insolvent or nonconvergent account")
    return target, float(after), notional


def metrics(ledger: list[dict]):
    eq = np.array([1000.] + [x["equity"] for x in ledger])
    curve = np.array([x["equity"] for x in ledger])
    times = np.array([x["time"] for x in ledger])
    rolls = eq[720:] / eq[:-720] - 1 if len(eq) > 720 else np.array([])
    monthly = []
    # Boundaries are UTC, with MTM equity at the boundary, not closing-trade PnL.
    boundaries = {int(t): float(e) for t, e in zip(times, curve)}
    if len(ledger):
        boundaries[ledger[0]["time"]-3600] = 1000.
    for y in (2025, 2026):
        for m in range(1, 13):
            start = utc(f"{y}-{m:02d}-01")
            end = utc(f"{y+int(m==12)}-{m%12+1:02d}-01")
            if start in boundaries and end in boundaries:
                monthly.append({"month": f"{y}-{m:02d}", "return_pct": 100*(boundaries[end]/boundaries[start]-1)})
    return {"start_equity": 1000., "end_equity": float(eq[-1]),
            "net_pct": float(100*(eq[-1]/1000-1)),
            "max_close_drawdown_pct": float(100*np.max(1-eq/np.maximum.accumulate(eq))),
            "rolling_30d_windows": len(rolls),
            "rolling_30d_double_fraction": float(np.mean(rolls >= 1)) if len(rolls) else None,
            "rolling_30d_median_pct": float(100*np.median(rolls)) if len(rolls) else None,
            "rolling_30d_worst_pct": float(100*rolls.min()) if len(rolls) else None,
            "rolling_30d_best_pct": float(100*rolls.max()) if len(rolls) else None,
            "switches": sum(x["switched"] for x in ledger),
            "entries": sum(x["entered"] for x in ledger),
            "nonzero_fill_batches": sum(x["turnover"] > 1e-8 for x in ledger),
            "turnover_usdt": sum(x["turnover"] for x in ledger),
            "fees_usdt": sum(x["fee"] for x in ledger),
            "funding_allowance_usdt": sum(x["funding_allowance"] for x in ledger),
            "time_in_market_fraction": float(np.mean([x["gross"] > 0 for x in ledger])),
            "months_utc": monthly}


def run(data: dict, outdir: Path):
    by = {x["symbol"]: x["rows"] for x in data["datasets"]}
    rows = [by[s] for s in SYMBOLS]
    t = np.array([x["time"] for x in rows[0]], dtype=np.int64)
    if not all(np.array_equal(t, [x["time"] for x in r]) for r in rows):
        raise ValueError("symbol time grids differ; no imputation is permitted")
    if not np.all(np.diff(t) == 3600):
        raise ValueError("hourly gaps: abort rather than invent returns")
    def arr(k):
        return np.array([[r[i][k] for r in rows] for i in range(len(t))], dtype=float)
    o, c, v = arr("open"), arr("close"), arr("volume")
    if not np.isfinite(o).all() or not (o > 0).all():
        raise ValueError("invalid prices")
    states = market_states(c, v)
    indexes = np.where((t+7200 >= utc("2025-01-01")) & (t+10800 <= utc("2026-08-01")))[0]
    if not len(indexes) or indexes[0] < TRAIN_HOURS or indexes[-1]+3 >= len(t):
        raise ValueError("insufficient warmup/evaluation/boundary data")
    output = {"protocol": "inventory-continuation-v1", "symbols": SYMBOLS,
              "dataset_sha256": data.get("sha256"), "execution_delay_hours": 1,
              "models": {}, "release_eligible": False,
              "limitations": ["already-inspected historical data, not blind",
                  "hourly trade-price execution; not mark-price liquidation or order-book replay",
                  "funding is an adverse allowance, not actual historical settlements",
                  "continuous contract quantities; Gate lot/minimum/margin checks absent",
                  "Bellman reward is a shrunken second-order log approximation",
                  "market-state model omits position age and unrealized-PnL state",
                  "hourly target-weight resizing can add small fills; these costs are counted",
                  "overlapping 30-day windows are not independent trials"]}
    first_model = model(states, o, int(indexes[0]))
    for fee in (0.000825, 0.00135):
        for name, horizon, adaptive in (("myopic_refit", 1, True),
                                        ("continuation_refit", 24, True),
                                        ("continuation_frozen", 24, False)):
            pi = policy(first_model[0], first_model[1], fee, horizon)
            last_fit = int(indexes[0]); label_end = first_model[2]
            equity = 1000.; qty = np.zeros(3); held = 0; ledger = []
            for i0 in indexes:
                i = int(i0)
                if adaptive and i-last_fit >= REFIT_HOURS:
                    trans, reward, label_end = model(states, o, i)
                    pi = policy(trans, reward, fee, horizon); last_fit = i
                assert label_end <= i
                action = int(pi[states[i], held]); w = WEIGHTS[action]
                prev = held
                qty, after, turnover = transact(equity, qty, o[i+2], w, fee)
                gross = float(np.abs(qty*o[i+2]).sum())
                funding = gross * FUNDING_ALLOWANCE_DAY / 24
                equity = after + float(qty @ (o[i+3]-o[i+2])) - funding
                if equity <= 0:
                    raise ValueError("account insolvent: no silent recovery/reset")
                held = action
                ledger.append({"time": int(t[i+3]), "decision_time": int(t[i]+3600),
                    "train_label_end": int(t[label_end]), "equity": equity,
                    "action": action, "switched": int(action != prev),
                    "entered": int(action != 0 and (prev == 0 or np.dot(WEIGHTS[prev], w) <= 0)),
                    "turnover": turnover, "fee": turnover*fee,
                    "funding_allowance": funding, "gross": gross})
            # Final liquidation is charged at the SAME final valuation boundary.
            final_notional = float(np.abs(qty*o[int(indexes[-1])+3]).sum())
            ledger[-1]["equity"] -= final_notional*fee
            ledger[-1]["fee"] += final_notional*fee
            ledger[-1]["turnover"] += final_notional
            key = f"{name}_{fee:.6f}"
            output["models"][key] = metrics(ledger)
            (outdir / f"{key}_ledger.json").write_text(json.dumps(ledger), encoding="utf-8")
            print(key, json.dumps(output["models"][key]), flush=True)
    (outdir / "results.json").write_text(json.dumps(output, indent=2), encoding="utf-8")


class Tests(unittest.TestCase):
    def test_cash_no_fee(self):
        q, e, n = transact(1000., np.zeros(3), np.ones(3)*100, WEIGHTS[0], .001)
        self.assertEqual((e, n), (1000., 0.)); self.assertEqual(q.sum(), 0.)

    def test_one_way_fee(self):
        q, e, n = transact(1000., np.zeros(3), np.ones(3)*100, WEIGHTS[4], .001)
        self.assertAlmostEqual(e, 1000/1.001); self.assertAlmostEqual(1000-e, .001*n)

    def test_close_fee(self):
        q, e, n = transact(1000., np.array([10., 0., 0.]), np.ones(3)*100, WEIGHTS[0], .001)
        self.assertAlmostEqual(e, 999.); self.assertEqual(n, 1000.)

    def test_reverse_two_legs(self):
        q, e, n = transact(1000., np.array([10., 0., 0.]), np.ones(3)*100, WEIGHTS[2], .001)
        self.assertGreater(n, 1990.); self.assertLess(q[0], 0.)

    def test_cost_changes_choice(self):
        trans = np.eye(NSTATE); r = np.zeros((NSTATE, len(WEIGHTS)))
        r[:, 4] = .0003
        self.assertEqual(int(policy(trans, r, .000825, 1)[0, 0]), 0)
        self.assertEqual(int(policy(trans, r, .000825, 24)[0, 0]), 4)

    def test_flat_market_no_entry(self):
        pi = policy(np.eye(NSTATE), np.zeros((NSTATE, len(WEIGHTS))), .001, 24)
        self.assertTrue((pi[:, 0] == 0).all())

    def test_future_does_not_change_past_features(self):
        rng = np.random.default_rng(4)
        c = np.exp(np.cumsum(rng.normal(0, .003, (500, 3)), axis=0))*100
        v = np.ones((500, 3)); before = market_states(c, v)
        c[300:] *= 10; v[300:] *= 100
        self.assertTrue(np.array_equal(before[:300], market_states(c, v)[:300]))

    def test_future_does_not_change_fitted_model(self):
        states = np.arange(500) % NSTATE
        o = np.exp(np.arange(1500).reshape(500, 3)*.00001)
        a = model(states, o, 300); o[301:] *= 5; states[301:] = 0
        b = model(states, o, 300)
        self.assertTrue(np.array_equal(a[0], b[0])); self.assertTrue(np.array_equal(a[1], b[1]))

    def test_label_embargo(self):
        _, _, end = model(np.arange(500)%NSTATE, np.ones((500, 3)), 300)
        self.assertLess(end, 301)

    def test_transition_rows_sum_one(self):
        p, _, _ = model(np.arange(500)%NSTATE, np.ones((500, 3)), 300)
        self.assertTrue(np.allclose(p.sum(axis=1), 1.))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--dataset")
    parser.add_argument("--out", default="research-output/inventory-v1")
    args = parser.parse_args()
    if args.self_test:
        unittest.main(argv=[__file__], exit=True)
    if not args.dataset:
        parser.error("--dataset or --self-test required")
    path = Path(args.out); path.mkdir(parents=True, exist_ok=True)
    raw = Path(args.dataset).read_bytes()
    (path / "input_provenance.json").write_text(json.dumps({"input_file_sha256": hashlib.sha256(raw).hexdigest()}))
    run(json.loads(raw), path)
