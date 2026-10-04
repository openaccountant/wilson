# Demo personas

Five synthetic seed datasets for `demo-cf`, parallel to the existing single-persona
`chase-demo.csv`. Same rules that dataset follows: fictional merchants/employers,
realistic recurring transactions, and **one planted anomaly per persona** so audit
and alert lessons find something real.

**One persona, one import format.** Every persona uses a different bank/parser so
the five together exercise wilson's whole parser matrix
(`cli/src/tools/import/parsers/`: Chase, Amex, BofA, generic CSV, OFX, QIF) — no two
personas look the same on import, and the demo teaches every supported format
across the five lessons instead of just one.

| Persona | File(s) | Format | Bank/institution (fictional) |
|---|---|---|---|
| 1 — Comingled Founder | `checking.csv`, `card.csv` | Chase CSV + Amex CSV | "Chase"-shaped checking, Amex-shaped card |
| 2 — New Grad | `checking.csv` | BofA checking CSV | "Bank of America"-shaped checking |
| 3 — Dual-Income Household | `joint-checking.ofx` | OFX (bank direct-connect) | Meridian Trust Bank (fictional) |
| 4 — Near-Retiree | `checking.qif` | QIF (Quicken) | longtime Quicken user, thematically fitting |
| 5 — Single Parent | `checking.csv` | generic CSV (auto-detected) | unnamed community bank/credit union |

Every file is verified against wilson's **actual `detectFormat`/`detectBank` +
parser** pipeline, not just the parser function in isolation — see
[Verification](#verification) below for why that distinction mattered.

Account balances (Acorns/Merrill-style investment or retirement accounts, mortgages)
are **balance-tracked via `account-manage`/`balance-update`, not transaction-imported**
— those personas note the balance to seed rather than a CSV, since there's no
per-line transaction history to replay for them in a one-month demo window.

---

## Budget target: 75% spend / 10% save / 15% invest

Every persona is working toward the same target split, expressed as two
`goal_manage` entries (a savings goal + an investing goal) sized to that persona's
actual monthly income shown in their seed data:

| Persona | Monthly income | 75% spend | 10% save (goal) | 15% invest (goal) |
|---|---:|---:|---:|---:|
| 1 — Comingled Founder | $7,300 | $5,475 | $730 | $1,095 |
| 2 — New Grad | $2,900 | $2,175 | $290 | $435 |
| 3 — Dual-Income Household | $10,900 | $8,175 | $1,090 | $1,635 |
| 4 — Near-Retiree | $3,900 | $2,925 | $390 | $585 |
| 5 — Single Parent | $3,235 (irregular) | $2,426 | $324 | $485 |

**Product gap surfaced by this exercise:** `goal_manage` takes a fixed
`targetAmount`, not a percentage of income — there's no way to say "10% of
whatever I make" once, and have it hold. That's fine for personas 1–4 (steady
income, recompute rarely), but breaks down for Persona 5, whose income genuinely
varies week to week — the $324/$485 figures above go stale as soon as a paycheck
does. Worth a feature request (percentage-based recurring goals) rather than
something to work around in the demo data.

Persona-specific notes:
- **Persona 1:** $7,300 mixes personal ($3,100 day job) and business ($4,200 client
  revenue) — the 75/10/15 split shown is a household-level approximation. Once
  `entity_manage` splits business from personal (see below), the business slice
  should really target its own tax/opex reserve, not a personal savings goal.
- **Persona 4:** "15% invest" for a fixed-income retiree is less about growth
  contributions and more a placeholder for reinvesting distributions/RMDs into the
  brokerage account — noted so the lesson doesn't imply a retiree should be adding
  new principal at the same rate as someone working.
- **Persona 5:** the seed data does *not* hit this target — it ends in an overdraft.
  That gap is the point: this persona is the "here's the goal, here's the current
  reality" lesson, not a "goal already achieved" one.

---

## Automatic separation: accounts, goals, and entities — not just entities

The buckets requested (life, business, home, investment, vacation, retirement)
don't all map to the same wilson mechanism. Checked against the actual tool
schemas before writing this:

- **`entity_manage`** is specifically **business entities** (its own tool
  description: "Manage business entities"). It assigns transactions/accounts to a
  business (e.g., an LLC vs. personal) — the right fit for exactly one bucket:
  **business**. It is not a general-purpose life/vacation/home tagger.
- **`account_manage`** registers an actual named account (checking, savings, real
  estate, loan — `institution` + `currentBalance` fields) — this is the real
  "automatic separation" mechanism for the other buckets: a distinct account per
  purpose (a "Home" mortgage account, a "Vacation" savings account, a "Retirement"
  account, an "Investment"/brokerage account), separate by construction because
  money is literally sitting in a different account.
- **`goal_manage`** tracks progress toward a target (`targetAmount`, `targetDate`,
  optional `accountId`) — pairs with an account to give a bucket a finish line, not
  just a balance (e.g., the Vacation account plus a "$3,000 by August" goal).

So: **business** → `entity_manage` (tag transactions/accounts to a business entity,
handles the comingled-account case directly). **Life, home, investment, vacation,
retirement** → one `account_manage` record each, optionally paired with a
`goal_manage` target for the ones with a savings finish line (vacation, house
down payment) rather than an ongoing balance (life/checking).

Not every persona needs every bucket — that's intentional, and more realistic:

| Persona | Buckets present | Buckets deliberately absent |
|---|---|---|
| 1 — Comingled Founder | life (checking+card), business (entity split), investment (robo + brokerage, balance-only) | home, vacation, retirement — no formal retirement account yet, a natural nudge lesson |
| 2 — New Grad | life (checking) | business, home, investment, vacation, retirement — hasn't started any of these yet |
| 3 — Dual-Income Household | life (joint checking), home (mortgage), vacation (the recurring "house fund" transfer already in the data), retirement (401k-style, balance-only) | business |
| 4 — Near-Retiree | life (checking), investment (brokerage), retirement (balance-only) | business, home (mortgage-free — explains the property-tax line with no mortgage payment), vacation |
| 5 — Single Parent | life (checking) | business, home, investment, vacation, retirement — the aspirational-goal lesson is *getting to* the first of these |

---

## Verification

Every file is checked against the real detection + parsing pipeline
(`detectFormat`/`detectBank` in `src/tools/import/detect-bank.ts`, then the
matched parser), not just a parser function called directly with the right bank
already assumed. That distinction caught a real near-miss: the first draft of
`1-comingled-founder/card.csv` had only `Date,Description,Amount` — it parsed fine
when `parseAmexCSV` was called directly, but `detectBank` requires a `Card Member`
or `Account #` column to actually route a file to the Amex parser, so under the
real `/import` flow it would have silently gone through the generic parser instead
(coincidentally still correct in this case, since Amex's positive-is-charge
convention happens to match the generic parser's auto-negate heuristic — but that's
luck, not verification). Fixed by adding a `Card Member` column, matching what real
Amex exports include anyway.

Checked: `detectFormat` returns the intended bank *and* the matched parser produces
the expected row count, for all six files.

---

## Seeding one of these

Same shape as `scripts/demos/setup.sh` / `chase-demo.csv`, pointed at a persona
folder instead:

```bash
wilson --profile <persona-name>
# then, in the TUI:
/import scripts/demos/personas/<n>-<slug>/<file>
```
