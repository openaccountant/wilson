# Eval persona fixtures (v3)

Synthetic data for the browser-subagent evaluation. Nothing here is real and none of it comes from any
`~/.openaccountant` database.

## What is here

| Path | What |
|---|---|
| `v3/<persona>.book.json` | The persona's **book**: accounts, six month-end balance snapshots per account (2026-01-31 to 2026-06-30) and loans. Generated, checked in, loaded by the harness. |
| `../../../specs/eval/fixtures-v3.md` | Human-readable summary per persona (accounts, balances, months covered, notable transactions). Written so a question writer can read it without seeing any product code or rules. |

The persona **transactions** are not here. They stay in the seed files
(`scripts/demos/personas/<n>-<slug>/` of the main checkout, found via `OA_PERSONAS_DIR` or
`resolvePersonasDir()` in `scripts/subagent-route-eval-personas.ts`). The seeds are never modified:
the generator reads them and the writer refuses to write inside the seed directory.

## How the harness uses them

`buildPersonaFixture(personasDir, persona)` imports the seed transactions, then writes the book into the
same database (`applyPersonaBook`: the product's `insertAccount`, `insertBalanceSnapshot`, `insertLoan`),
then builds the mirror from that database. Before v3, personas had no accounts, so net worth and
forecast ran over an empty book. Transactions are not linked to accounts (`account_id` stays empty), so
transaction search output is the same as in Round 2 and the row counts did not change.

## Regenerating

```bash
bun scripts/subagent-route-eval-fixtures.ts [<personasDir>]
```

Rewrites `v3/*.book.json` and `specs/eval/fixtures-v3.md`. `bun test src/__tests__/subagent-route-fixtures.test.ts`
fails if either file is out of date with the generator and the seeds. Edit the account specs in
`scripts/subagent-route-eval-fixtures.ts`, never the JSON by hand.

## How the numbers are tied together

- **Cash-like accounts that appear in a transaction file** (checking, the card, the house-fund savings
  account) move in June by exactly what those transactions add up to. The May-31 snapshot is derived
  (June-30 balance minus the June movement); the earlier months are plain synthetic history. Statement
  balances already in the seeds are honored: the BofA `Running Bal.` column (persona 2, 06/30 balance
  `1879.14`, 05/31 `800.00`) and the OFX `LEDGERBAL` (persona 3, `6588.61`).
- **Loans** (`student loan`, `mortgage`, `auto loan`) use the product's amortization schedule
  (`src/tools/net-worth/amortization.ts`): the snapshot at each month end is the balance after the
  payments made so far, first payment in the `start_date` month. `interest_rate` is stored as a decimal
  (`0.06` = 6%), like the product's loan tool. The scheduled monthly payment matches the payments in
  the June transactions (within 2%).
- **Balance-only accounts** (investments, homes, vehicles) have no transactions; their series are plain
  synthetic numbers. A loan with a financed asset sets `linked_asset_key` so equity is reportable.
- Debt balances are amounts owed, stored positive. Net worth = assets minus debts.

## Duplicate external ids: the `-dup2` approach

The product's `computeExternalId` hashes `date|description|amount`. Two genuinely separate rows with the
same date, description and amount therefore get the **same** `external_id`, and `transactions.external_id`
is UNIQUE, so inserting both in one batch fails (`insertTransactions` throws and rolls the whole batch back),
and the importer's per-row dedup (`checkExternalId`) would treat the second one as already imported.

Persona 1 deliberately plants exactly that: two `ADOBE CREATIVE CLOUD` charges of `-54.99` on 06/05.
The eval needs both rows (questions ask about the possible double billing), so
`readPersonaRows` in `scripts/subagent-route-eval-personas.ts` keeps the first row's id unchanged and
gives each later repeat an occurrence suffix in file order:

| Occurrence | `external_id` |
|---|---|
| 1st | `<hash>` (what the product computes) |
| 2nd | `<hash>-dup2` |
| 3rd | `<hash>-dup3` |

Rules of the approach:

- It applies only to rows that are identical in date, description and amount **and** appear in the
  persona's own files; the counter is per persona (reset for each call).
- Ids stay deterministic and stable across runs, so results can be compared between runs.
- It is a measurement-side choice. It does not change, and must not be copied into, the product's
  importer, which should keep treating same-id rows as duplicates.
- The server database and the mirror are built from the same rows, so both hold both Adobe rows.
- If a new seed adds another identical pair, no change is needed; the suffix is applied automatically.
