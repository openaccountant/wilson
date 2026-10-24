/**
 * Missing-model setup hints (#182, #189). Pure: the Settings → Models rows and
 * the chat's failed-turn bubble both read from here.
 */

import type { ModelAvailability } from '../types';

/** Where the fix lives — the same words the server's error text uses (src/utils/errors.ts). */
export const MODELS_SETTINGS_LABEL = 'Settings → Models';

export interface AvailabilityHint {
  /** Short chip text shown next to the execution badge. */
  badge: string;
  /** The one step that fixes it, in plain language. */
  fix: string;
}

/**
 * Chip + fixing step for an Ollama row whose model can't run yet, or null when
 * there is nothing to say (installed, not an Ollama row, not checked). The
 * "Runs on this device" badge stays: it says where data goes, not whether the
 * model is there.
 */
export function availabilityHint(
  availability: ModelAvailability | null | undefined,
  model: string | null,
  canChange: boolean,
): AvailabilityHint | null {
  const name = model?.replace(/^ollama:/, '') ?? '';
  const other = canChange ? ', or pick an installed model below' : ', or ask an admin to pick an installed model';
  if (availability === 'not-installed') {
    return {
      badge: 'Not installed',
      fix: `Not installed in Ollama yet — run \`ollama pull ${name || '<model>'}\` in a terminal${other}.`,
    };
  }
  if (availability === 'unreachable') {
    return {
      badge: 'Ollama not running',
      fix: `Ollama didn't answer, so this model can't run — start Ollama (open the app, or run \`ollama serve\`)${other}.`,
    };
  }
  return null;
}

/**
 * True when an assistant bubble is a failed turn whose fix is in Settings →
 * Models (the server's missing-model message), so the chat can offer a button
 * to go there.
 */
export function pointsToModelSettings(content: string): boolean {
  const failed = content.startsWith('Error:') || content.startsWith('**Categorization failed:**');
  return failed && content.includes(MODELS_SETTINGS_LABEL);
}
