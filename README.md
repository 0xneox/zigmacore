# Zigma – AI-Powered Polymarket Intelligence Agent

> **Deterministic + AI oracle for Polymarket edge detection and trade triage**

Zigma continuously ingests live Polymarket data, cross-references short-form news, runs structured LLM analysis, and surfaces executable trades with tunable risk controls. SAFE_MODE stays on by default so you can iterate without shipping live orders or X posts.

---

## 📈 Current Status (Jan 2026)

- Autonomous cycle (fetch → enrich → analyze → signal) completes in ~22s.
- Up to **1,000 markets per cycle** (cap via `MAX_MARKETS`, default 1k) with 150–200 deep analyses.
- Integrated **Tavily + LLM news fallback** so “no headlines” states still get context.
- Trade gate now yields **6–14 executable ideas per cycle** (min 5% effective edge enforced).
- SAFE_MODE, SQLite caching, retries, and fallbacks keep the agent resilient during long runs.

---

## 🔑 Core Capabilities

### Market Intake & Metrics
- Paginated Gamma fetcher with cap (`MAX_MARKETS`) to avoid 10k+ downloads when unnecessary.
- Sanity filter strips closed/inactive markets; snapshot cache backfills history gaps.
- Grouping + volatility/liquidity heuristics prioritize the ~200 highest-alpha markets per pass.

### News Intelligence
- Primary source: Tavily multi-query search (`searchTavily`).
- Automatic fallback: OpenAI chat completion (`searchLLMNews`) that returns JSON-only headlines when Tavily times out or misses.
- Results are deduped, sentiment-scored, and cached for 10 minutes to limit API spend.

### LLM Probability Engine
- Enhanced prompt blends market microstructure (spreads, depth, liquidity score) + order books + news stack.
- Safe JSON parser recovers confidence/narrative even when the LLM drifts.
- Revised priors merge LLM delta + news delta with category-specific base rates.
- Liquidity-aware Kelly sizing and confidence boosts that favor meaningful edges while still penalizing volatility.

### Trade Simulation & Watchlist
- Each signal receives normalized confidence, expected edge, and an intent exposure percentage.
- Min edge veto: trades must show ≥5% effective edge (post horizon discount + confidence).
- Execution gate (v1.5.1.1): exposure ≥0.05% bankroll (0.0005 normalized) **and** confidence ≥68 unlocks MEDIUM/STRONG tiers; probes with >3.5% edge auto-promote.
- Detailed `[DEBUG] Signal ... → EXECUTABLE/DROPPED` logs explain why trades pass or fail.
- Liquidity veto (<$10k) and high-odds safety rails remain in place.

### Distribution & Safety
- SAFE_MODE (default `true`) blocks real posts/X orders while preserving log output.
- When disabled, STRONG/SMALL/PROBE tiers publish formatted X updates via `twitter-api-v2`.
- Cycle metadata persisted to `cache/latest_cycle.json` + SQLite for auditing.

---

## ⚙️ Configuration Cheat Sheet

| Variable | Purpose | Default |
| --- | --- | --- |
| `OPENAI_API_KEY` | Required for OpenAI analysis + LLM news fallback | _none_ |
| `LLM_PROVIDER` / `LLM_MODEL` | Core analysis model selection (`openai` or `xai`) | `openai` / `gpt-4o-mini` |
| `LLM_NEWS_MODEL` | Optional override for news fallback model | inherits `LLM_MODEL` |
| `ENABLE_LLM_NEWS_FALLBACK` | Toggle JSON headline fallback | `true` |
| `GAMMA_API_URL` | Polymarket Gamma endpoint | `https://gamma-api.polymarket.com` |
| `MAX_MARKETS` | Per-cycle fetch cap (protect against 10k+ downloads) | `1000` |
| `REQUEST_TIMEOUT` / `MAX_RETRIES` | HTTP client tuning | `20000` ms / `3` |
| `SAFE_MODE` | Prevents real tweets/trades | `true` |
| `CRON_SCHEDULE` | Cycle cadence (cron syntax) | `0 * * * *` |

Populate these in a `.env` file at repo root. Example:

```env
OPENAI_API_KEY=sk-...
LLM_MODEL=gpt-4o-mini
ENABLE_LLM_NEWS_FALLBACK=true
MAX_MARKETS=1000
SAFE_MODE=true
```

---

## 🚀 Running Locally

```bash
npm install
npm run dev   # runs a single cycle (SAFE_MODE friendly)
```

Watch the console for:
- `🌐 FETCH PAGE` logs (pagination + cap)
- `Headlines found` / `Using LLM news fallback` messages
- `[DEBUG] Signal ... → EXECUTABLE` lines showing trade triage decisions
- Final cycle summary with watchlist/outlook/rejected counts

To daemonize, keep `npm run dev` alive or rely on `runCycle`’s cron schedule once the process is up.

---

## 📊 Observed Performance (latest run)

- Fetch: ~6k candidate markets trimmed to 1k max; ~170 make it to deep analysis.
- LLM latency: 3–4s avg per market (OpenAI GPT-4o mini).
- Executable trades: 0 while SAFE_MODE on, but 6–14 per cycle flagged internally.
- No critical errors after resilience upgrades (timeouts handled, fallbacks logged).

---

## ⚠️ Disclaimers

- Educational tooling only—**not** financial advice.
- Polymarket trading carries risk; do your own research.
- API usage incurs cost/quotas (OpenAI, Tavily, Gamma).

---

