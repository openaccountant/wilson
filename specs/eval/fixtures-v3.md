# Eval fixtures v3

Synthetic people used to write and answer questions about a personal-finance book. Everything here is made up. Each person has a few accounts, a month-end balance history and the transactions of one month. This page describes exactly what is in each book so a question can be written from it alone.

## Conventions

- Dates are June 2026 for transactions. Balances are as of 06/30/2026 unless a column says otherwise.
- Transaction amounts: money out (spending, payments, fees) is negative, money in (pay, refunds) is positive. A charge on a credit card is also stored negative, and a payment to the card is positive.
- Debt balances (credit card, mortgage, loans) are amounts owed, shown as positive numbers. Net worth is assets minus debts.
- "Cash on hand" means checking plus savings (plus physical cash, none here). Investments, homes and vehicles are not cash.
- Each checking-style account moves during June by exactly what its transactions add up to, so the 05/31 and 06/30 balances agree with the transaction list.
- Months before June have balances only, no transactions.

## Overview

| Person | Accounts | Assets | Debts | Net worth | Cash on hand |
|---|---:|---:|---:|---:|---:|
| 1-comingled-founder | 5 | $39,062.47 | $1,284.67 | $37,777.80 | $9,520.17 |
| 2-new-grad | 2 | $1,879.14 | $35,111.15 | -$33,232.01 | $1,879.14 |
| 3-dual-income-household | 5 | $557,500.91 | $329,366.85 | $228,134.06 | $21,088.61 |
| 4-near-retiree | 4 | $1,136,210.94 | $0.00 | $1,136,210.94 | $9,860.45 |
| 5-single-parent | 3 | $11,627.20 | $8,713.20 | $2,914.00 | $577.20 |

## Personas

### 1-comingled-founder

A solo founder with a day job and a consulting business who runs both through one checking account and one charge card. Roughly $7,300 comes in each month: $3,100 from the day job and $4,200 from two consulting clients. Savings and investments exist but there is no retirement account yet.

#### Accounts

| Account | Kind | Asset or debt | Institution | 05/31 | 06/30 (current) |
|---|---|---|---|---:|---:|
| Founder Checking | Checking | Asset | Northgate Bank | $3,265.53 | $6,420.17 |
| Tax Reserve Savings | Savings | Asset | Northgate Bank | $3,100.00 | $3,100.00 |
| Roboinvest Portfolio | Investment | Asset | Roboinvest | $8,102.18 | $8,236.90 |
| Brokerage Account | Investment | Asset | Summit Brokerage | $21,011.07 | $21,305.40 |
| Founder Charge Card | Credit card | Debt (amount owed) | Charter Card Services | $1,151.74 | $1,284.67 |

Totals at 06/30: assets $39,062.47, debts $1,284.67, **net worth $37,777.80**. Cash on hand (checking and savings): $9,520.17.

- Founder Checking: One checking account for both personal and business money.
- Tax Reserve Savings: Set aside for estimated taxes. Last topped up in May.
- Roboinvest Portfolio: Automated investing account. Balance tracked by hand, no transactions.
- Brokerage Account: Taxable brokerage account. Balance tracked by hand, no transactions.
- Founder Charge Card: Charge card used for both personal and business spending. Balance is the amount owed.

Loans: none.

Month-end balances (amounts owed for debts):

| Account | 01/31 | 02/28 | 03/31 | 04/30 | 05/31 | 06/30 |
|---|---:|---:|---:|---:|---:|---:|
| Founder Checking | $3,880.12 | $4,410.75 | $2,950.30 | $3,720.46 | $3,265.53 | $6,420.17 |
| Tax Reserve Savings | $1,900.00 | $2,200.00 | $2,500.00 | $2,800.00 | $3,100.00 | $3,100.00 |
| Roboinvest Portfolio | $7,410.55 | $7,522.10 | $7,391.27 | $7,880.34 | $8,102.18 | $8,236.90 |
| Brokerage Account | $19,420.00 | $19,905.12 | $19,488.33 | $20,577.61 | $21,011.07 | $21,305.40 |
| Founder Charge Card | $412.90 | $980.15 | $655.30 | $1,102.45 | $1,151.74 | $1,284.67 |

#### Months covered

- Transactions: June 2026 only (06/01 to 06/27), 21 rows, $7,900.00 in and $4,878.29 out (the $600 card payment is counted on both sides: out of checking, in on the card). There is no transaction history before or after June 2026.
- Balances: one snapshot per account at each month end from January through June 2026 (6 per account). Current balances are the 06/30 snapshots.

#### Notable transactions

- Two identical charges on the same day, possibly a double billing.
  - 06/05 ADOBE CREATIVE CLOUD: -$54.99
  - 06/05 ADOBE CREATIVE CLOUD: -$54.99
- Consulting income from two clients lands in the same checking account as personal pay.
  - 06/01 CLIENT PAYMT - STONEBRIDGE CONSULTING: $2,400.00
  - 06/15 CLIENT PAYMT - HARBOR LOGISTICS: $1,800.00
- Day-job paycheck (personal income).
  - 06/08 PAYROLL DEP - DAYJOB INC: $3,100.00
- Estimated quarterly tax payment, the second-largest outflow after rent.
  - 06/24 STATE QUARTERLY TAX PMT: -$1,200.00
- The card payment shows up twice: leaving checking and as a credit on the card.
  - 06/04 AMEX EPAYMENT - THANK YOU: $600.00
  - 06/04 TRANSFER TO CREDIT CARD XXXX-4471: -$600.00
- Business-looking card charges (client dinner, conference travel, office supplies, shipping) mixed in with personal ones.
  - 06/01 STAPLES BUSINESS ADVANTAGE: -$89.20
  - 06/03 UNION SQUARE CAFE - CLIENT DINNER: -$156.40
  - 06/06 DELTA AIR LINES - CONF TRAVEL: -$412.00
  - 06/23 FEDEX OFFICE PRINT & SHIP: -$34.75

### 2-new-grad

A recent graduate with a retail job, paid $1,450 every other week, renting a place and paying down a student loan. One checking account, no savings or investments yet.

#### Accounts

| Account | Kind | Asset or debt | Institution | 05/31 | 06/30 (current) |
|---|---|---|---|---:|---:|
| Everyday Checking | Checking | Asset | Bayfront Bank | $800.00 | $1,879.14 |
| Student Loan | Student loan | Debt (amount owed) | Navient | $35,358.32 | $35,111.15 |

Totals at 06/30: assets $1,879.14, debts $35,111.15, **net worth -$33,232.01**. Cash on hand (checking and savings): $1,879.14.

- Everyday Checking: Only account. Paid every other week.
- Student Loan: Federal-style student loan, paid in two installments of $210 each month.

Loans:

- Student Loan: borrowed $38,000.00 at 5.80% over 120 months, first payment 2025-07; scheduled payment $418.07 a month; owed $35,111.15 at 06/30.

Month-end balances (amounts owed for debts):

| Account | 01/31 | 02/28 | 03/31 | 04/30 | 05/31 | 06/30 |
|---|---:|---:|---:|---:|---:|---:|
| Everyday Checking | $1,240.55 | $905.20 | $1,480.00 | $1,115.75 | $800.00 | $1,879.14 |
| Student Loan | $36,335.18 | $36,092.73 | $35,849.11 | $35,604.31 | $35,358.32 | $35,111.15 |

#### Months covered

- Transactions: June 2026 only (06/02 to 06/27), 13 rows, $2,900.00 in and $1,820.86 out. There is no transaction history before or after June 2026.
- Balances: one snapshot per account at each month end from January through June 2026 (6 per account). Current balances are the 06/30 snapshots.

#### Notable transactions

- Two paychecks of $1,450, two weeks apart.
  - 06/02 PAYROLL DEP - BRIGHTPATH RETAIL: $1,450.00
  - 06/16 PAYROLL DEP - BRIGHTPATH RETAIL: $1,450.00
- Student loan paid in two installments of $210.
  - 06/04 NAVIENT STUDENT LOAN: -$210.00
  - 06/24 NAVIENT STUDENT LOAN: -$210.00
- One-off concert ticket, the largest discretionary purchase of the month.
  - 06/14 TICKETMASTER - CONCERT: -$185.00
- Rent, the largest outflow.
  - 06/03 RENT PAYMENT: -$975.00

### 3-dual-income-household

Two earners (one at a steel company, one in health care) with a young child in daycare. They own a home with a mortgage, move $500 twice a month into a house-fund savings account, and have a 401(k). Roughly $10,900 comes in each month.

#### Accounts

| Account | Kind | Asset or debt | Institution | 05/31 | 06/30 (current) |
|---|---|---|---|---:|---:|
| Joint Checking | Checking | Asset | Meridian Trust Bank | $600.00 | $6,588.61 |
| House Fund Savings | Savings | Asset | Meridian Trust Bank | $13,500.00 | $14,500.00 |
| Joint 401(k) | Investment | Asset | Harbor Steel Retirement Plan | $94,870.66 | $96,412.30 |
| Family Home | Real estate | Asset | Self-estimated | $440,000.00 | $440,000.00 |
| Home Mortgage | Mortgage | Debt (amount owed) | Lakeview Home Loans | $329,816.19 | $329,366.85 |

Totals at 06/30: assets $557,500.91, debts $329,366.85, **net worth $228,134.06**. Cash on hand (checking and savings): $21,088.61.

- Joint Checking: Both paychecks land here. June 30 balance is the statement ledger balance.
- House Fund Savings: Receives two $500 transfers from joint checking every month.
- Joint 401(k): Employer retirement plan. Balance tracked by hand, no transactions.
- Family Home: Estimated market value, updated by hand.
- Home Mortgage: Thirty-year fixed mortgage on the family home.

Loans:

- Home Mortgage: borrowed $350,000.00 at 6.00% over 360 months, first payment 2022-03; scheduled payment $2,098.43 a month; owed $329,366.85 at 06/30. Finances Family Home (worth $440,000.00, equity $110,633.15).

Month-end balances (amounts owed for debts):

| Account | 01/31 | 02/28 | 03/31 | 04/30 | 05/31 | 06/30 |
|---|---:|---:|---:|---:|---:|---:|
| Joint Checking | $1,020.35 | $860.90 | $1,475.20 | $730.45 | $600.00 | $6,588.61 |
| House Fund Savings | $9,500.00 | $10,500.00 | $11,500.00 | $12,500.00 | $13,500.00 | $14,500.00 |
| Joint 401(k) | $88,410.22 | $90,155.80 | $87,904.35 | $92,233.10 | $94,870.66 | $96,412.30 |
| Family Home | $438,000.00 | $438,000.00 | $440,000.00 | $440,000.00 | $440,000.00 | $440,000.00 |
| Home Mortgage | $331,591.33 | $331,150.86 | $330,708.19 | $330,263.30 | $329,816.19 | $329,366.85 |

#### Months covered

- Transactions: June 2026 only (06/01 to 06/29), 13 rows, $10,900.00 in and $4,911.39 out. There is no transaction history before or after June 2026.
- Balances: one snapshot per account at each month end from January through June 2026 (6 per account). Current balances are the 06/30 snapshots.

#### Notable transactions

- Two employers, each paying twice a month.
  - 06/01 PAYROLL DEP HARBOR STEEL CO: $2,850.00
  - 06/03 PAYROLL DEP MERIDIAN HEALTH: $2,600.00
  - 06/15 PAYROLL DEP HARBOR STEEL CO: $2,850.00
  - 06/17 PAYROLL DEP MERIDIAN HEALTH: $2,600.00
- Mortgage payment, the largest outflow.
  - 06/05 MORTGAGE PAYMENT LAKEVIEW HOME LOANS: -$2,100.00
- Daycare, the second-largest outflow.
  - 06/06 SUNSHINE DAYCARE: -$980.00
- Two $500 transfers into the house-fund savings account.
  - 06/13 TRANSFER TO SAVINGS HOUSE FUND: -$500.00
  - 06/29 TRANSFER TO SAVINGS HOUSE FUND: -$500.00
- The two big grocery runs.
  - 06/08 COSTCO WHOLESALE: -$212.44
  - 06/19 WHOLE FOODS MARKET: -$168.30

### 4-near-retiree

A retired teacher living on Social Security and a state pension (about $3,900 a month), with a brokerage account, a rollover IRA and a home with no mortgage.

#### Accounts

| Account | Kind | Asset or debt | Institution | 05/31 | 06/30 (current) |
|---|---|---|---|---:|---:|
| Retirement Checking | Checking | Asset | Old Mill Savings | $8,053.09 | $9,860.45 |
| Brokerage Account | Investment | Asset | Summit Brokerage | $309,515.62 | $312,400.18 |
| Rollover IRA | Investment | Asset | Summit Brokerage | $427,954.09 | $428,950.31 |
| Paid-off Home | Real estate | Asset | Self-estimated | $385,000.00 | $385,000.00 |

Totals at 06/30: assets $1,136,210.94, debts $0.00, **net worth $1,136,210.94**. Cash on hand (checking and savings): $9,860.45.

- Retirement Checking: Pension and Social Security land here.
- Brokerage Account: Taxable brokerage account. Balance tracked by hand, no transactions.
- Rollover IRA: Retirement account rolled over from an employer plan. Balance tracked by hand, no transactions.
- Paid-off Home: Estimated market value. No mortgage, which is why the property tax bill is the only housing payment.

Loans: none.

Month-end balances (amounts owed for debts):

| Account | 01/31 | 02/28 | 03/31 | 04/30 | 05/31 | 06/30 |
|---|---:|---:|---:|---:|---:|---:|
| Retirement Checking | $7,210.88 | $7,655.40 | $8,302.15 | $7,480.62 | $8,053.09 | $9,860.45 |
| Brokerage Account | $301,880.45 | $305,120.18 | $296,744.90 | $303,008.37 | $309,515.62 | $312,400.18 |
| Rollover IRA | $421,300.00 | $424,880.55 | $417,330.21 | $425,610.78 | $427,954.09 | $428,950.31 |
| Paid-off Home | $385,000.00 | $385,000.00 | $385,000.00 | $385,000.00 | $385,000.00 | $385,000.00 |

#### Months covered

- Transactions: June 2026 only (06/01 to 06/28), 11 rows, $3,900.00 in and $2,092.64 out. There is no transaction history before or after June 2026.
- Balances: one snapshot per account at each month end from January through June 2026 (6 per account). Current balances are the 06/30 snapshots.

#### Notable transactions

- The only two income lines, together $3,900.
  - 06/01 SOCIAL SECURITY ADMIN: $2,100.00
  - 06/03 PENSION DISBURSEMENT - STATE TEACHERS FUND: $1,800.00
- An unrecognized, uncategorized $412.60 charge from an unknown merchant (international-looking).
  - 06/15 UNKNOWN MERCHANT INTL*7719402: -$412.60
- Property tax installment, the only housing payment since the home has no mortgage.
  - 06/25 PROPERTY TAX INSTALLMENT: -$890.00
- Health costs: Medigap premium and a pharmacy purchase.
  - 06/05 MEDIGAP INSURANCE PREMIUM: -$245.00
  - 06/09 CVS PHARMACY: -$38.55
- Monthly golf club dues.
  - 06/12 GOLF CLUB DUES: -$150.00

### 5-single-parent

A single parent working at a medical practice with irregular paychecks, child support, childcare and a car loan. Money is tight: the checking account is overdrawn at times and there are no savings or investments.

#### Accounts

| Account | Kind | Asset or debt | Institution | 05/31 | 06/30 (current) |
|---|---|---|---|---:|---:|
| Community Checking | Checking | Asset | Eastside Credit Union | -$285.00 | $577.20 |
| Used Sedan | Vehicle | Asset | Self-estimated | $11,200.00 | $11,050.00 |
| Auto Loan | Auto loan | Debt (amount owed) | CarMax Financial | $8,921.93 | $8,713.20 |

Totals at 06/30: assets $11,627.20, debts $8,713.20, **net worth $2,914.00**. Cash on hand (checking and savings): $577.20.

- Community Checking: Only cash account. Starts June overdrawn and goes further negative before the mid-month paycheck.
- Used Sedan: Estimated resale value, falling a little each month.
- Auto Loan: Five-year car loan, one payment of $265 each month.

Loans:

- Auto Loan: borrowed $13,200.00 at 7.50% over 60 months, first payment 2024-08; scheduled payment $264.50 a month; owed $8,713.20 at 06/30. Finances Used Sedan (worth $11,050.00, equity $2,336.80).

Month-end balances (amounts owed for debts):

| Account | 01/31 | 02/28 | 03/31 | 04/30 | 05/31 | 06/30 |
|---|---:|---:|---:|---:|---:|---:|
| Community Checking | $140.25 | -$60.10 | $215.80 | -$120.45 | -$285.00 | $577.20 |
| Used Sedan | $11,800.00 | $11,650.00 | $11,500.00 | $11,350.00 | $11,200.00 | $11,050.00 |
| Auto Loan | $9,744.01 | $9,540.40 | $9,335.53 | $9,129.38 | $8,921.93 | $8,713.20 |

#### Months covered

- Transactions: June 2026 only (06/01 to 06/29), 14 rows, $3,235.00 in and $2,372.80 out. There is no transaction history before or after June 2026.
- Balances: one snapshot per account at each month end from January through June 2026 (6 per account). Current balances are the 06/30 snapshots.
- Checking runs from -$285.00 on 05/31 down to a low of -$1,346.30 (after the 06/05 entry) and ends June at $577.20.

#### Notable transactions

- A $35 overdraft fee on 06/14, the account was negative when it hit.
  - 06/14 OVERDRAFT FEE: -$35.00
- Four paychecks of different sizes ($780, $612, $845, $598), irregular hours.
  - 06/01 PAYROLL DEP - RIVERSIDE MEDICAL: $780.00
  - 06/08 PAYROLL DEP - RIVERSIDE MEDICAL: $612.00
  - 06/15 PAYROLL DEP - RIVERSIDE MEDICAL: $845.00
  - 06/29 PAYROLL DEP - RIVERSIDE MEDICAL: $598.00
- Child support received, $400.
  - 06/09 CHILD SUPPORT - STATE DISBURSEMENT UNIT: $400.00
- Car loan payment, $265.
  - 06/12 AUTO LOAN PAYMENT - CARMAX FINANCIAL: -$265.00
- Childcare, the second-largest outflow after rent.
  - 06/03 SUNRISE CHILDCARE CENTER: -$620.00
- Child-related one-offs: a co-pay and a school fee.
  - 06/10 SCHOOL SUPPLY FEE - LINCOLN ELEMENTARY: -$85.00
  - 06/21 PEDIATRIC CO-PAY: -$35.00
