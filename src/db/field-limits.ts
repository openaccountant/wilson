/**
 * Shared length caps for user-supplied transaction text. Single source of truth for the agent tool
 * validators (src/mcp/tool-catalog.ts) and the dashboard /api/import row validation, so a value
 * accepted on import can always be edited later through update_transaction / categorize_transaction.
 */
export const MAX_CATEGORY_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 200;
/** Other short free-text fields on an imported row (bank, merchant_name, payment_channel, external_id, account_last4). */
export const MAX_TEXT_FIELD_LENGTH = 200;
/** Upload file name (also stored as imports.file_path / transactions.source_file). */
export const MAX_FILENAME_LENGTH = 255;
