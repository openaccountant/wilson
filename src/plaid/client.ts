import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  Products,
  CountryCode,
  type AccountBase,
  type RecurringTransactionFrequency,
} from "plaid";
import { logger } from "../utils/logger.js";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const DEBUG_DIR = join(process.cwd(), "data", "api", "debug");
function dumpDebug(name: string, data: unknown): void {
  if (process.env.OA_DEBUG !== "1") return;
  try {
    mkdirSync(DEBUG_DIR, { recursive: true });
    writeFileSync(
      join(DEBUG_DIR, `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`),
      JSON.stringify(data, null, 2),
    );
  } catch { /* don't break on write failure */ }
}

// ── Errors ───────────────────────────────────────────────────────────────────

export class PlaidError extends Error {
  constructor(
    message: string,
    public readonly errorType: string,
    public readonly errorCode: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "PlaidError";
  }
}

function isPlaidApiError(
  err: unknown,
): err is {
  response: {
    data: { error_type: string; error_code: string; error_message: string };
    status: number;
  };
} {
  return typeof err === "object" && err !== null && "response" in err;
}

function wrapPlaidError(err: unknown): never {
  if (isPlaidApiError(err)) {
    const d = err.response.data;
    throw new PlaidError(
      d.error_message,
      d.error_type,
      d.error_code,
      err.response.status,
    );
  }
  throw err;
}

// ── Retry ────────────────────────────────────────────────────────────────────

const RETRYABLE_CODES = new Set([
  "INTERNAL_SERVER_ERROR",
  "PLANNED_MAINTENANCE",
]);

function isRetryable(err: unknown): boolean {
  if (isPlaidApiError(err)) {
    return (
      RETRYABLE_CODES.has(err.response.data.error_code) ||
      err.response.status >= 500
    );
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
  throw new Error("unreachable");
}

// ── Proxy support ───────────────────────────────────────────────────────────

const OA_API_URL =
  process.env.OA_API_URL ?? "https://openaccountant-api.workers.dev";

/**
 * Check whether local Plaid credentials are configured.
 */
export function hasLocalPlaidCreds(): boolean {
  return !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
}

/**
 * Fetch helper for the OA API Plaid proxy.
 * Authenticates via the cached license key.
 */
async function proxyFetch(
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const { getLicenseInfo } = await import("../licensing/license.js");
  const license = getLicenseInfo();
  if (!license?.key) {
    throw new Error("No license key found. Run /license to activate.");
  }

  const res = await fetch(`${OA_API_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${license.key}`,
    },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      (data.error as string) ?? `Proxy request failed (${res.status})`,
    );
  }
  return data;
}

/**
 * Stable per-user ID for Plaid's client_user_id field.
 * Uses license email when available, falls back to OS username.
 */
function getPlaidUserId(): string {
  try {
    // Dynamic import would be async; use sync require for licensing
    const { getLicenseInfo } = require("../licensing/license.js");
    const info = getLicenseInfo();
    if (info?.email) return `oa-${info.email}`;
  } catch {
    // Licensing module not available
  }
  return `oa-${process.env.USER ?? process.env.USERNAME ?? "local"}`;
}

// ── Configuration ────────────────────────────────────────────────────────────

function getPlaidEnv(): string {
  return process.env.PLAID_ENV ?? "sandbox";
}

function getPlaidConfig(): Configuration {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;

  if (!clientId || !secret) {
    throw new Error(
      "Plaid credentials not configured. Set PLAID_CLIENT_ID and PLAID_SECRET environment variables.",
    );
  }

  const env = getPlaidEnv();
  const basePath =
    env === "production"
      ? PlaidEnvironments.production
      : env === "development"
        ? PlaidEnvironments.development
        : PlaidEnvironments.sandbox;

  return new Configuration({
    basePath,
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": clientId,
        "PLAID-SECRET": secret,
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
 *
 * When `useProxy` is true, delegates to the OA API (no local Plaid creds needed).
 */
export async function createLinkToken(
  proLicensed = false,
  useProxy = false,
): Promise<string> {
  if (useProxy) {
    const products = ["transactions"];
    if (proLicensed) {
      products.push("investments");
    }
    const data = (await proxyFetch("/plaid/link-token", {
      products,
      client_user_id: getPlaidUserId(),
    })) as {
      link_token: string;
    };
    logger.info("plaid:link-token", { products, link_token: data.link_token.slice(0, 20) + "..." });
    dumpDebug("link-token", data);
    return data.link_token;
  }

  const plaid = getClient();

  const products: Products[] = [Products.Transactions];
  if (proLicensed) {
    products.push(Products.Investments);
  }

  const response = await withRetry(() =>
    plaid.linkTokenCreate({
      user: { client_user_id: getPlaidUserId() },
      client_name: "Open Accountant",
      products,
      country_codes: [CountryCode.Us],
      language: "en",
    }),
  );

  logger.info("plaid:link-token", { products, link_token: response.data.link_token.slice(0, 20) + "..." });
  dumpDebug("link-token", response.data);
  return response.data.link_token;
}

/**
 * Exchange a public token (from Plaid Link) for an access token.
 *
 * When `useProxy` is true, delegates to the OA API.
 */
export async function exchangePublicToken(
  publicToken: string,
  useProxy = false,
): Promise<{
  accessToken: string;
  itemId: string;
}> {
  if (useProxy) {
    const data = (await proxyFetch("/plaid/exchange", {
      public_token: publicToken,
    })) as { access_token: string; item_id: string };
    logger.info("plaid:exchange", { item_id: data.item_id, access_token_prefix: data.access_token.slice(0, 10) + "..." });
    dumpDebug("exchange", data);
    return {
      accessToken: data.access_token,
      itemId: data.item_id,
    };
  }

  const plaid = getClient();

  const response = await withRetry(() =>
    plaid.itemPublicTokenExchange({
      public_token: publicToken,
    }),
  );

  logger.info("plaid:exchange", { item_id: response.data.item_id, access_token_prefix: response.data.access_token.slice(0, 10) + "..." });
  dumpDebug("exchange", response.data);
  return {
    accessToken: response.data.access_token,
    itemId: response.data.item_id,
  };
}

/**
 * Get institution info and accounts for an access token.
 */
export async function getItemInfo(
  accessToken: string,
  useProxy = false,
): Promise<{
  institutionName: string;
  accounts: Array<{ id: string; name: string; mask: string }>;
}> {
  if (useProxy) {
    const accountsData = (await proxyFetch("/plaid/accounts", {
      access_token: accessToken,
    })) as {
      accounts: Array<{ account_id: string; name: string; mask: string | null }>;
      item: { institution_id: string | null };
    };
    logger.info("plaid:accounts", { accounts: accountsData.accounts, item: accountsData.item });
    dumpDebug("accounts", accountsData);

    const accounts = accountsData.accounts.map((a) => ({
      id: a.account_id,
      name: a.name,
      mask: a.mask ?? "",
    }));

    let institutionName = "Unknown Institution";
    const instId = accountsData.item?.institution_id;
    if (instId) {
      try {
        const instData = (await proxyFetch("/plaid/institution", {
          institution_id: instId,
        })) as { institution: { name: string } };
        institutionName = instData.institution.name;
        logger.info("plaid:institution", { institution_id: instId, name: institutionName });
        dumpDebug("institution", instData);
      } catch {
        // Fall back to "Unknown Institution"
      }
    }

    return { institutionName, accounts };
  }

  const plaid = getClient();

  const accountsRes = await withRetry(() =>
    plaid.accountsGet({ access_token: accessToken }),
  );
  logger.info("plaid:accounts", { accounts: accountsRes.data.accounts, item: accountsRes.data.item });
  dumpDebug("accounts", accountsRes.data);
  const accounts = accountsRes.data.accounts.map(
    (a: { account_id: string; name: string; mask: string | null }) => ({
      id: a.account_id,
      name: a.name,
      mask: a.mask ?? "",
    }),
  );

  let institutionName = "Unknown Institution";
  const instId = accountsRes.data.item.institution_id;
  if (instId) {
    try {
      const instRes = await withRetry(() =>
        plaid.institutionsGetById({
          institution_id: instId,
          country_codes: [CountryCode.Us],
        }),
      );
      institutionName = instRes.data.institution.name;
      logger.info("plaid:institution", { institution_id: instId, name: institutionName });
      dumpDebug("institution", instRes.data);
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
  cursor: string | null,
  useProxy = false,
): Promise<{
  added: SyncedTransaction[];
  nextCursor: string;
}> {
  const added: SyncedTransaction[] = [];
  let currentCursor = cursor ?? "";
  let hasMore = true;

  if (useProxy) {
    while (hasMore) {
      const data = (await proxyFetch("/plaid/transactions/sync", {
        access_token: accessToken,
        cursor: currentCursor || undefined,
      })) as {
        added: Array<{
          transaction_id: string;
          date: string;
          name: string;
          amount: number;
          category: string[] | null;
          account_id: string;
          merchant_name: string | null;
          personal_finance_category: { primary: string; detailed: string } | null;
          payment_channel: string | null;
          pending: boolean;
          authorized_date: string | null;
        }>;
        next_cursor: string;
        has_more: boolean;
      };

      logger.info("plaid:sync:page", { added_count: data.added.length, has_more: data.has_more, cursor: data.next_cursor, added: data.added });
      dumpDebug("sync-page", data);

      for (const txn of data.added) {
        const pfc = txn.personal_finance_category;
        added.push({
          transactionId: txn.transaction_id,
          date: txn.date,
          name: txn.name,
          amount: txn.amount,
          category: txn.category ?? [],
          accountId: txn.account_id,
          merchantName: txn.merchant_name ?? undefined,
          personalFinanceCategory: pfc
            ? { primary: pfc.primary, detailed: pfc.detailed }
            : undefined,
          paymentChannel: txn.payment_channel ?? undefined,
          pending: txn.pending,
          authorizedDate: txn.authorized_date ?? undefined,
        });
      }

      currentCursor = data.next_cursor;
      hasMore = data.has_more;
    }

    return { added, nextCursor: currentCursor };
  }

  const plaid = getClient();

  while (hasMore) {
    const response = await withRetry(() =>
      plaid.transactionsSync({
        access_token: accessToken,
        cursor: currentCursor || undefined,
      }),
    );

    logger.info("plaid:sync:page", { added_count: response.data.added.length, has_more: response.data.has_more, cursor: response.data.next_cursor, added: response.data.added });
    dumpDebug("sync-page", response.data);

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
        personalFinanceCategory: pfc
          ? { primary: pfc.primary, detailed: pfc.detailed }
          : undefined,
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
export async function getBalances(
  accessToken: string,
  useProxy = false,
): Promise<AccountBalance[]> {
  if (useProxy) {
    const data = (await proxyFetch("/plaid/accounts", {
      access_token: accessToken,
    })) as {
      accounts: Array<{
        account_id: string;
        name: string;
        mask: string | null;
        type: string;
        subtype: string | null;
        balances: {
          current: number | null;
          available: number | null;
          iso_currency_code: string | null;
        };
      }>;
    };

    logger.info("plaid:balances", { accounts: data.accounts });
    dumpDebug("balances", data);

    return data.accounts.map((a) => ({
      accountId: a.account_id,
      name: a.name,
      mask: a.mask ?? "",
      type: a.type,
      subtype: a.subtype ?? "",
      balanceCurrent: a.balances.current,
      balanceAvailable: a.balances.available,
      isoCurrencyCode: a.balances.iso_currency_code,
    }));
  }

  const plaid = getClient();

  const response = await withRetry(() =>
    plaid.accountsGet({ access_token: accessToken }),
  );

  logger.info("plaid:balances", { accounts: response.data.accounts });
  dumpDebug("balances", response.data);

  return response.data.accounts.map((a: AccountBase) => ({
    accountId: a.account_id,
    name: a.name,
    mask: a.mask ?? "",
    type: a.type,
    subtype: a.subtype ?? "",
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
/**
 * Remove a Plaid Item (revoke access token on Plaid's side).
 * Should be called before removing from local store.
 */
export async function removeItem(
  accessToken: string,
  useProxy = false,
): Promise<void> {
  if (useProxy) {
    await proxyFetch("/plaid/item/remove", {
      access_token: accessToken,
    });
    logger.info("plaid:item:remove", { via: "proxy" });
    return;
  }

  const plaid = getClient();

  await withRetry(() =>
    plaid.itemRemove({ access_token: accessToken }),
  );

  logger.info("plaid:item:remove", { via: "direct" });
}

/**
 * Create a Link token in update mode for re-authentication.
 * Used when a Plaid Item's login credentials become stale.
 */
export async function createUpdateLinkToken(
  accessToken: string,
  useProxy = false,
): Promise<string> {
  if (useProxy) {
    const data = (await proxyFetch("/plaid/link-token/update", {
      access_token: accessToken,
      client_user_id: getPlaidUserId(),
    })) as { link_token: string };
    logger.info("plaid:link-token:update", { link_token: data.link_token.slice(0, 20) + "..." });
    return data.link_token;
  }

  const plaid = getClient();

  const response = await withRetry(() =>
    plaid.linkTokenCreate({
      user: { client_user_id: getPlaidUserId() },
      client_name: "Open Accountant",
      country_codes: [CountryCode.Us],
      language: "en",
      access_token: accessToken,
    }),
  );

  logger.info("plaid:link-token:update", { link_token: response.data.link_token.slice(0, 20) + "..." });
  return response.data.link_token;
}

/**
 * Get the institution_id for a Plaid Item (used for duplicate detection).
 */
export async function getItemInstitutionId(
  accessToken: string,
  useProxy = false,
): Promise<string | null> {
  if (useProxy) {
    const data = (await proxyFetch("/plaid/accounts", {
      access_token: accessToken,
    })) as { item: { institution_id: string | null } };
    return data.item?.institution_id ?? null;
  }

  const plaid = getClient();
  const response = await withRetry(() =>
    plaid.accountsGet({ access_token: accessToken }),
  );
  return response.data.item.institution_id ?? null;
}

export async function getRecurringTransactions(
  accessToken: string,
  useProxy = false,
): Promise<{
  inflow: RecurringStream[];
  outflow: RecurringStream[];
}> {
  function mapStream(s: {
    stream_id: string;
    description: string;
    merchant_name: string | null;
    last_amount: { amount?: number };
    frequency: RecurringTransactionFrequency | string;
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
      frequency: s.frequency as string,
      category: s.category ?? [],
      isActive: s.is_active,
      firstDate: s.first_date,
      lastDate: s.last_date,
    };
  }

  if (useProxy) {
    const data = (await proxyFetch("/plaid/transactions/recurring", {
      access_token: accessToken,
    })) as {
      inflow_streams: Array<{
        stream_id: string;
        description: string;
        merchant_name: string | null;
        last_amount: { amount?: number };
        frequency: string;
        category: string[] | null;
        is_active: boolean;
        first_date: string;
        last_date: string;
      }>;
      outflow_streams: Array<{
        stream_id: string;
        description: string;
        merchant_name: string | null;
        last_amount: { amount?: number };
        frequency: string;
        category: string[] | null;
        is_active: boolean;
        first_date: string;
        last_date: string;
      }>;
    };

    logger.info("plaid:recurring", { inflow_streams: data.inflow_streams, outflow_streams: data.outflow_streams });
    dumpDebug("recurring", data);

    return {
      inflow: data.inflow_streams.map(mapStream),
      outflow: data.outflow_streams.map(mapStream),
    };
  }

  const plaid = getClient();

  const response = await withRetry(() =>
    plaid.transactionsRecurringGet({
      access_token: accessToken,
      account_ids: [],
    }),
  );

  logger.info("plaid:recurring", { inflow_streams: response.data.inflow_streams, outflow_streams: response.data.outflow_streams });
  dumpDebug("recurring", response.data);

  return {
    inflow: response.data.inflow_streams.map(mapStream),
    outflow: response.data.outflow_streams.map(mapStream),
  };
}
