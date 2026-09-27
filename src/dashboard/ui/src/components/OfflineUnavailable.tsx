/**
 * The graceful "this card needs the server" state: shown inside an otherwise
 * intact card when an offline GET came back as RequiresConnectionError —
 * either because the card is outside the approved offline scope (its engine
 * runs server-side: alerts, liabilities, cash forecast) or because the mirror
 * is unavailable / never seeded. Never shown while the server answers.
 */
export function OfflineUnavailable({ title }: { title: string }) {
  return (
    <div className="bg-surface-raised border border-border rounded-lg p-4">
      <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-2">{title}</h3>
      <p className="text-sm text-text-muted" data-testid="unavailable-offline">
        Unavailable offline — requires the server
      </p>
    </div>
  );
}