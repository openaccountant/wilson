import { useTrustedAction } from './useTrustedAction';

/**
 * Confirm for a QUICK row (open-jev agrees with the stored suggestion). One row
 * per click. It ignores scripted clicks (`isTrusted` false) and any click in
 * the first 800 ms after the row appears. A speed bump, not proof of a human.
 */
export function QuickConfirmButton({ busy, onConfirm }: { busy: boolean; onConfirm: () => void }) {
  const { enabled, onClick } = useTrustedAction(onConfirm);
  return (
    <button
      data-testid="prelabel-confirm"
      onClick={onClick}
      disabled={busy || !enabled}
      className="bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-xs font-medium px-2.5 py-1.5 rounded-md transition-colors cursor-pointer border border-green/60 whitespace-nowrap"
      title="open-jev agrees with the suggestion. Apply it (one row)."
    >
      Confirm
    </button>
  );
}
