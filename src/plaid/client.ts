import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  Products,
  CountryCode,
} from 'plaid';

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
 */
export async function createLinkToken(): Promise<string> {
  const plaid = getClient();

  const response = await plaid.linkTokenCreate({
    user: { client_user_id: 'wilson-cli-user' },
    client_name: 'Wilson',
    products: [Products.Transactions],
    country_codes: [CountryCode.Us],
    language: 'en',
  });

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

  const response = await plaid.itemPublicTokenExchange({
    public_token: publicToken,
  });

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

  const accountsRes = await plaid.accountsGet({ access_token: accessToken });
  const accounts = accountsRes.data.accounts.map((a: { account_id: string; name: string; mask: string | null }) => ({
    id: a.account_id,
    name: a.name,
    mask: a.mask ?? '',
  }));

  let institutionName = 'Unknown Institution';
  const instId = accountsRes.data.item.institution_id;
  if (instId) {
    try {
      const instRes = await plaid.institutionsGetById({
        institution_id: instId,
        country_codes: [CountryCode.Us],
      });
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
export async function syncTransactions(
  accessToken: string,
  cursor: string | null
): Promise<{
  added: Array<{
    transactionId: string;
    date: string;
    name: string;
    amount: number;
    category: string[];
    accountId: string;
  }>;
  nextCursor: string;
}> {
  const plaid = getClient();
  const added: Array<{
    transactionId: string;
    date: string;
    name: string;
    amount: number;
    category: string[];
    accountId: string;
  }> = [];

  let currentCursor = cursor ?? '';
  let hasMore = true;

  while (hasMore) {
    const response = await plaid.transactionsSync({
      access_token: accessToken,
      cursor: currentCursor || undefined,
    });

    for (const txn of response.data.added) {
      added.push({
        transactionId: txn.transaction_id,
        date: txn.date,
        name: txn.name,
        amount: txn.amount,
        category: txn.category ?? [],
        accountId: txn.account_id,
      });
    }

    currentCursor = response.data.next_cursor;
    hasMore = response.data.has_more;
  }

  return { added, nextCursor: currentCursor };
}
