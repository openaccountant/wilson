declare module 'monarch-money-api' {
  export function setToken(token: string): void;
  export function loginUser(
    email: string,
    password: string,
    mfaSecretKey?: string,
  ): Promise<void>;
  export function getTransactions(options?: {
    limit?: number;
    offset?: number;
    startDate?: string | null;
    endDate?: string | null;
    search?: string;
    categoryIds?: string[];
    accountIds?: string[];
    tagIds?: string[];
  }): Promise<{
    allTransactions: {
      totalCount: number;
      results: Array<{
        id: string;
        amount: number;
        date: string;
        pending: boolean;
        plaidName: string | null;
        notes: string | null;
        isRecurring: boolean;
        category: { id: string; name: string } | null;
        merchant: { name: string; id: string } | null;
        account: { id: string; displayName: string } | null;
      }>;
    };
  }>;
  export function getAccounts(): Promise<unknown>;
}
