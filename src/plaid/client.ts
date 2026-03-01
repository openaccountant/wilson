import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  Products,
  CountryCode,
  type AccountBase,
  type RecurringTransactionFrequency,
} from 'plaid';

// ── Errors ───────────────────────────────────────────────────────────────────

export class PlaidError extends Error {
  constructor(
    message: string,
    public readonly errorType: string,
    public readonly errorCode: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'PlaidError';
  }
}

function isPlaidApiError(err: unknown): err is { response: { data: { error_type: string; error_code: string; error_message: string }; status: number } } {
  return typeof err === 'object' && err !== null && 'response' in err;
}

function wrapPlaidError(err: unknown): never {
  if (isPlaidApiError(err)) {
    const d = err.response.data;
    throw new PlaidError(d.error_message, d.error_type, d.error_code, err.response.status);
  }
  throw err;
}

// ── Retry ────────────────────────────────────────────────────────────────────

const RETRYABLE_CODES = new Set(['INTERNAL_SERVER_ERROR', 'PLANNED_MAINTENANCE']);

function isRetryable(err: unknown): boolean {
  if (isPlaidApiError(err)) {
    return RETRYABLE_CODES.has(err.response.data.error_code) || err.response.status >= 500;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err) || attempt === maxRetries) {
        wrapPlaidError(err);
      }
      await sleep(Math.pow(2, attempt) * 1000);
    }
  }
  throw new Error('unreachable');
}

// ── Configuration ────────────────────────────────────────────────────────────

function getPlaidEnv(): string {
  return process.env.PLAID_ENV ?? 'sandbox';
}

function getPlaidConfig(): Configuration {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;

  if (!clientId || !secret) {
    throw new Error(
      'Plaid credentials not configured. Set PLAID_CLIENT_ID and PLAID_SECRET environment variables.'
    );
  }

  const env = getPlaidEnv();
  const basePath =
    env === 'production'
      ? PlaidEnvironments.production
      : env === 'development'
        ? PlaidEnvironments.development
        : PlaidEnvironments.sandbox;

  return new Configuration({
    basePath,
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': clientId,
        'PLAID-SECRET': secret,
      },
    },
  });
}

let client: PlaidApi | null = null;

function getClient(): PlaidApi {
  if (!client) {
    client = new PlaidApi(getPlaidConfig());
  }
  return client;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a Plaid Link token for initializing the Link flow.
 * Pro-licensed users get access to investments and recurring transaction detection.
 */
export async function createLinkToken(proLicensed = false): Promise<string> {
  const plaid = getClient();

  const products: Products[] = [Products.Transactions];
  if (proLicensed) {
    products.push(Products.Investments, Products.RecurringTransactions);
  }

  const response = await withRetry(() =>
    plaid.linkTokenCreate({
      user: { client_user_id: 'oa-user' },
      client_name: 'Open Accountant',
      products,
      country_codes: [CountryCode.Us],
      language: 'en',
    }),
  );

  return response.data.link_token;
}

/**
 * Exchange a public token (from Plaid Link) for an access token.
 */
export async function exchangePublicToken(publicToken: string): Promise<{
  accessToken: string;
  itemId: string;
}> {
  const plaid = getClient();

  const response = await withRetry(() =>
    plaid.itemPublicTokenExchange({
      public_token: publicToken,
    }),
  );

  return {
    accessToken: response.data.access_token,
    itemId: response.data.item_id,
  };
}

/**
 * Get institution info and accounts for an access token.
 */
export async function getItemInfo(accessToken: string): Promise<{
  institutionName: string;
  accounts: Array<{ id: string; name: string; mask: string }>;
}> {
  const plaid = getClient();

  const accountsRes = await withRetry(() => plaid.accountsGet({ access_token: accessToken }));
  const accounts = accountsRes.data.accounts.map((a: { account_id: string; name: string; mask: string | null }) => ({
    id: a.account_id,
    name: a.name,
    mask: a.mask ?? '',
  }));

  let institutionName = 'Unknown Institution';
  const instId = accountsRes.data.item.institution_id;
  if (instId) {
    try {
      const instRes = await withRetry(() => plaid.institutionsGetById({
        institution_id: instId,
        country_codes: [CountryCode.Us],
      }));
      institutionName = instRes.data.institution.name;
    } catch {
      // Fall back to "Unknown Institution"
    }
  }

  return { institutionName, accounts };
}

/**
 * Sync transactions using the incremental /transactions/sync endpoint.
 * Returns added transactions and the updated cursor.
 */
export interface SyncedTransaction {
  transactionId: string;
  date: string;
  name: string;
  amount: number;
  category: string[];
  accountId: string;
  merchantName?: string;
  personalFinanceCategory?: { primary: string; detailed: string };
  paymentChannel?: string;
  pending: boolean;
  authorizedDate?: string;
}

export async function syncTransactions(
  accessToken: string,
  cursor: string | null
): Promise<{
  added: SyncedTransaction[];
  nextCursor: string;
}> {
  const plaid = getClient();
  const added: SyncedTransaction[] = [];

  let currentCursor = cursor ?? '';
  let hasMore = true;

  while (hasMore) {
    const response = await withRetry(() =>
      plaid.transactionsSync({
        access_token: accessToken,
        cursor: currentCursor || undefined,
      }),
    );

    for (const txn of response.data.added) {
      const pfc = txn.personal_finance_category;
      added.push({
        transactionId: txn.transaction_id,
        date: txn.date,
        name: txn.name,
        amount: txn.amount,
        category: txn.category ?? [],
        accountId: txn.account_id,
        merchantName: txn.merchant_name ?? undefined,
        personalFinanceCategory: pfc ? { primary: pfc.primary, detailed: pfc.detailed } : undefined,
        paymentChannel: txn.payment_channel ?? undefined,
        pending: txn.pending,
        authorizedDate: txn.authorized_date ?? undefined,
      });
    }

    currentCursor = response.data.next_cursor;
    hasMore = response.data.has_more;
  }

  return { added, nextCursor: currentCursor };
}

// ── Balances ─────────────────────────────────────────────────────────────────

export interface AccountBalance {
  accountId: string;
  name: string;
  mask: string;
  type: string;
  subtype: string;
  balanceCurrent: number | null;
  balanceAvailable: number | null;
  isoCurrencyCode: string | null;
}

/**
 * Get current balances for all accounts on an access token.
 */
export async function getBalances(accessToken: string): Promise<AccountBalance[]> {
  const plaid = getClient();

  const response = await withRetry(() =>
    plaid.accountsGet({ access_token: accessToken }),
  );

  return response.data.accounts.map((a: AccountBase) => ({
    accountId: a.account_id,
    name: a.name,
    mask: a.mask ?? '',
    type: a.type,
    subtype: a.subtype ?? '',
    balanceCurrent: a.balances.current,
    balanceAvailable: a.balances.available,
    isoCurrencyCode: a.balances.iso_currency_code,
  }));
}

// ── Recurring Transactions ───────────────────────────────────────────────────

export interface RecurringStream {
  streamId: string;
  description: string;
  merchantName: string | null;
  amount: number;
  frequency: string;
  category: string[];
  isActive: boolean;
  firstDate: string;
  lastDate: string;
}

/**
 * Get recurring transaction streams (subscriptions, bills, income).
 */
export async function getRecurringTransactions(accessToken: string): Promise<{
  inflow: RecurringStream[];
  outflow: RecurringStream[];
}> {
  const plaid = getClient();

  const response = await withRetry(() =>
    plaid.transactionsRecurringGet({
      access_token: accessToken,
      account_ids: [],
    }),
  );

  function mapStream(s: {
    stream_id: string;
    description: string;
    merchant_name: string | null;
    last_amount: { amount?: number };
    frequency: RecurringTransactionFrequency;
    category: string[] | null;
    is_active: boolean;
    first_date: string;
    last_date: string;
  }): RecurringStream {
    return {
      streamId: s.stream_id,
      description: s.description,
      merchantName: s.merchant_name,
      amount: s.last_amount.amount ?? 0,
      frequency: s.frequency,
      category: s.category ?? [],
      isActive: s.is_active,
      firstDate: s.first_date,
      lastDate: s.last_date,
    };
  }

  return {
    inflow: response.data.inflow_streams.map(mapStream),
    outflow: response.data.outflow_streams.map(mapStream),
  };
}
