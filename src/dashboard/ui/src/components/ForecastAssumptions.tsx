// The Forecast tab's assumptions & limitations panel — a first-class
// deliverable per issue #42, not a collapsed disclosure. It renders
// unconditionally in every tab state (loading excluded), including
// manual-inputs mode and the worker-unavailable fallback, so the model's
// honesty notes are never hidden behind an interaction.

export function ForecastAssumptions() {
  return (
    <div className="bg-surface-raised border border-border rounded-lg p-4">
      <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-3">
        Assumptions &amp; Limitations
      </h3>
      <div className="grid grid-cols-2 gap-6">
        <div>
          <h4 className="text-xs text-text-secondary uppercase tracking-wide mb-2">
            Assumptions — what this model does
          </h4>
          <ul className="list-disc pl-4 space-y-1 text-xs text-text-muted">
            <li>
              Every figure is in <strong>today&apos;s dollars</strong>. The return slider is a{' '}
              <em>real</em> return; inflation is not modeled separately and nominal balances will
              look larger.
            </li>
            <li>
              Monthly returns are drawn independently from a log-normal whose <strong>median</strong>{' '}
              compounds at the slider&apos;s real annual rate, with <strong>volatility fixed at
              15% a year</strong>. Volatility is not adjustable in this slice.
            </li>
            <li>
              Volatility is <strong>not fitted from your data</strong>. Net-worth snapshots mix your
              contributions with market moves, and the two cannot be separated from balances alone.
            </li>
            <li>
              Your <strong>whole</strong> net worth is modeled as one blended portfolio growing at
              that return — cash, property and debt included. There is no per-account modeling.
            </li>
            <li>
              Contributions are resampled at random, with replacement, from your observed monthly
              net cash flow (up to 24 months), then shifted by the savings-rate slider. They are
              added at the <strong>end</strong> of each month.
            </li>
            <li>
              Returns and contributions are drawn <strong>independently</strong> — a bad market and
              a bad savings month never coincide by design.
            </li>
            <li>The one-off shock is applied at the <strong>start</strong> of its month, before that month&apos;s return.</li>
            <li>The starting point is your current net worth as the accounts table reports it.</li>
            <li>
              The simulation is <strong>seeded and deterministic</strong>: the same inputs always
              produce the same fan.
            </li>
            <li>
              Everything runs in your browser, in a background worker.{' '}
              <strong>No data leaves this machine.</strong>
            </li>
          </ul>
        </div>
        <div>
          <h4 className="text-xs text-text-secondary uppercase tracking-wide mb-2">
            Limitations — what this model does not do
          </h4>
          <ul className="list-disc pl-4 space-y-1 text-xs text-text-muted">
            <li>
              <strong>No retirement drawdown.</strong> The model contributes for the entire horizon
              and never spends the portfolio down. Do not read a retirement date off this chart.
            </li>
            <li>No taxes, fees, or account-type differences (401(k) vs taxable vs mortgage).</li>
            <li>
              Returns are i.i.d. month to month — <strong>no mean reversion, no fat tails, no
              clustering</strong>. Real crashes arrive in runs; these do not, so the model
              understates sequence-of-returns risk.
            </li>
            <li>No income growth, promotions, job loss, or life events beyond the single shock you set.</li>
            <li>
              No debt amortisation — debts are netted into a single balance and are never paid down
              on a schedule. While your net worth is positive, liabilities are blended into the
              portfolio and implicitly grow at the portfolio return, which is wrong in detail.
            </li>
            <li>
              Bands are <strong>nearest-rank estimates from a finite sample</strong>. With 5,000
              paths the edges move a little between runs; the quoted figures come from the
              20,000-path run.
            </li>
            <li>
              <strong>p90 is not a promise and p10 is not a floor.</strong> By construction 1 path
              in 10 finishes outside each edge.
            </li>
            <li>Up to 24 months of cash flow is a small sample and may not describe your future.</li>
            <li>Below six months of history the projection uses the numbers you typed, not your data.</li>
            <li>
              <strong>While your net worth is negative, it grows only by what you save</strong> —
              market returns are not applied to an underwater balance, and debts are not modelled as
              compounding. Once contributions carry you above zero, normal compounding resumes.
            </li>
          </ul>
        </div>
      </div>
      <p className="text-xs text-text-muted mt-3">
        Starting net worth from your accounts (<code>/api/net-worth</code>); contributions from your
        transaction history (<code>/api/cashflow/monthly</code>).
      </p>
    </div>
  );
}
