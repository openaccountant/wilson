# Dedup Test Data

Test files for verifying deduplication logic.

## Files

- **chase-jan.csv** — Full January 2026 Chase transactions (8 txns)
- **chase-jan-overlap.csv** — Late January + early February (10 txns, 5 overlap with chase-jan.csv)

## Test scenarios

1. **File-hash dedup**: Import `chase-jan.csv` twice. Second import should be rejected (same file hash).
2. **Per-transaction dedup**: Import `chase-jan.csv`, then `chase-jan-overlap.csv`. The 5 overlapping transactions (01/15 - 01/28) should be skipped. Only 5 new February transactions should be added.
3. **Near-duplicate detection**: `chase-jan-overlap.csv` contains a second `PAYROLL DEPOSIT - ACME CORP` on 02/15. This is a *different* transaction (different date) and should NOT be deduped against the 01/15 payroll.
