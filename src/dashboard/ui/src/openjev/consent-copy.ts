/**
 * The "Download once" consent copy for the on-device open-jev model (Round 4, DECISIONS: reuse
 * the Review tab's consent with updated wording). Pure, so the Review tab's panel renders it
 * and a test pins what it must say: where the download comes from, that text stays on this
 * machine, and that the SAME model may also pick lookups for chat questions when that
 * feature is on. One consent covers both uses (the host reads the same opt-in key).
 */

export const CONSENT_BUTTON_LABEL = 'Download once';

/** `size` is a human string such as "334 MB". */
export function downloadOnceCopy(size: string): string {
  return (
    `Second opinion from open-jev runs on this computer’s GPU. One-time download: about ${size} from huggingface.co ` +
    `(a pinned model version). Transaction text never leaves this machine; later visits make about 1 KB of version checks ` +
    `to huggingface.co. When on-device chat lookups are enabled, this same model also helps pick which lookup answers a ` +
    `chat question; that reuses this download and sends nothing new off this machine.`
  );
}
