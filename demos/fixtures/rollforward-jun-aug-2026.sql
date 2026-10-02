-- September 2026 roll-forward for the demo profile.
--
-- Timeline after this runs: Jan–Apr (history-backfill-jan-apr-2026.sql),
-- May 2026 (original import, dup-seconds neutralized below), then June, July,
-- August — with AUGUST as the new hero month carrying the engineered beats:
--   * MEGAMART ONLINE duplicate pair (08/12 + 08/13, -89.99 each)
--   * HARBORVIEW HOTEL duplicate pair (08/17 + 08/20, -318.00 each)
--   * coastal-trip dining/travel spike cluster (08/17–08/21) vs flat June/July
-- Categories copied from the May rows' post-import assignments in the demo DB.
-- source_file mirrors the provenance CSVs. Idempotent: safe to re-run.
--
-- Remove everything this file adds/neutralizes with:
--   DELETE FROM transactions WHERE source_file IN
--     ('data/demo/june-2026-chase.csv','data/demo/july-2026-chase.csv','data/demo/august-2026-chase.csv');
--   (the two May dup-second rows must then be re-imported from
--    data/demo/may-2026-chase.csv if the old May story is needed)

BEGIN TRANSACTION;

-- Neutralize the May duplicate-second rows so August is the only dup story.
DELETE FROM transactions
 WHERE source_file = 'data/demo/may-2026-chase.csv'
   AND ((description = 'MEGAMART ONLINE'  AND date = '2026-05-13')
     OR (description = 'HARBORVIEW HOTEL' AND date = '2026-05-20'));

-- Clear any previous application of this file.
DELETE FROM transactions WHERE source_file IN
  ('data/demo/june-2026-chase.csv',
   'data/demo/july-2026-chase.csv',
   'data/demo/august-2026-chase.csv');

INSERT INTO transactions (date, description, amount, category, source_file) VALUES
-- JUNE (quiet baseline)
('2026-06-01','PAYROLL DEPOSIT - ACME CORP', 3200.00,'Income','data/demo/june-2026-chase.csv'),
('2026-06-01','MAPLE AVE APARTMENTS RENT',  -2400.00,'Home','data/demo/june-2026-chase.csv'),
('2026-06-02','CORNER MARKET #1247',          -57.90,'Groceries','data/demo/june-2026-chase.csv'),
('2026-06-03','SKYSTREAM PLUS MONTHLY',       -14.99,'Subscriptions','data/demo/june-2026-chase.csv'),
('2026-06-03','CLOUDVAULT BACKUP',             -9.99,'Subscriptions','data/demo/june-2026-chase.csv'),
('2026-06-04','OAK STREET COFFEE',             -6.25,'Dining','data/demo/june-2026-chase.csv'),
('2026-06-05','CITY ELECTRIC CO AUTOPAY',    -124.10,'Utilities','data/demo/june-2026-chase.csv'),
('2026-06-06','RIVERDALE GYM MONTHLY',        -49.99,'Health','data/demo/june-2026-chase.csv'),
('2026-06-07','CORNER MARKET #1247',          -63.45,'Groceries','data/demo/june-2026-chase.csv'),
('2026-06-08','OAK STREET COFFEE',             -5.75,'Dining','data/demo/june-2026-chase.csv'),
('2026-06-09','FUEL DEPOT #88',               -44.60,'Transport','data/demo/june-2026-chase.csv'),
('2026-06-10','SUNRISE DINER',                -21.75,'Dining','data/demo/june-2026-chase.csv'),
('2026-06-14','CORNER MARKET #1247',          -49.25,'Groceries','data/demo/june-2026-chase.csv'),
('2026-06-15','PAYROLL DEPOSIT - ACME CORP', 3200.00,'Income','data/demo/june-2026-chase.csv'),
('2026-06-16','OAK STREET COFFEE',             -6.50,'Dining','data/demo/june-2026-chase.csv'),
('2026-06-18','CITY PARKING AUTHORITY',       -18.00,'Transport','data/demo/june-2026-chase.csv'),
('2026-06-21','CORNER MARKET #1247',          -66.70,'Groceries','data/demo/june-2026-chase.csv'),
('2026-06-23','OAK STREET COFFEE',             -5.75,'Dining','data/demo/june-2026-chase.csv'),
('2026-06-24','STREAMFLIX SUBSCRIPTION',      -19.99,'Subscriptions','data/demo/june-2026-chase.csv'),
('2026-06-25','FUEL DEPOT #88',               -47.85,'Transport','data/demo/june-2026-chase.csv'),
('2026-06-26','SUNRISE DINER',                -19.30,'Dining','data/demo/june-2026-chase.csv'),
('2026-06-28','CORNER MARKET #1247',          -54.35,'Groceries','data/demo/june-2026-chase.csv'),
('2026-06-29','OAK STREET COFFEE',             -6.25,'Dining','data/demo/june-2026-chase.csv'),
('2026-06-30','PHARMACY PLUS #210',           -29.85,'Health','data/demo/june-2026-chase.csv'),
-- JULY (quiet baseline)
('2026-07-01','PAYROLL DEPOSIT - ACME CORP', 3200.00,'Income','data/demo/july-2026-chase.csv'),
('2026-07-01','MAPLE AVE APARTMENTS RENT',  -2400.00,'Home','data/demo/july-2026-chase.csv'),
('2026-07-02','CORNER MARKET #1247',          -62.15,'Groceries','data/demo/july-2026-chase.csv'),
('2026-07-03','SKYSTREAM PLUS MONTHLY',       -14.99,'Subscriptions','data/demo/july-2026-chase.csv'),
('2026-07-03','CLOUDVAULT BACKUP',             -9.99,'Subscriptions','data/demo/july-2026-chase.csv'),
('2026-07-04','OAK STREET COFFEE',             -5.75,'Dining','data/demo/july-2026-chase.csv'),
('2026-07-05','CITY ELECTRIC CO AUTOPAY',    -130.25,'Utilities','data/demo/july-2026-chase.csv'),
('2026-07-06','RIVERDALE GYM MONTHLY',        -49.99,'Health','data/demo/july-2026-chase.csv'),
('2026-07-07','CORNER MARKET #1247',          -51.80,'Groceries','data/demo/july-2026-chase.csv'),
('2026-07-08','OAK STREET COFFEE',             -6.50,'Dining','data/demo/july-2026-chase.csv'),
('2026-07-09','FUEL DEPOT #88',               -45.90,'Transport','data/demo/july-2026-chase.csv'),
('2026-07-10','SUNRISE DINER',                -22.60,'Dining','data/demo/july-2026-chase.csv'),
('2026-07-14','CORNER MARKET #1247',          -58.95,'Groceries','data/demo/july-2026-chase.csv'),
('2026-07-15','PAYROLL DEPOSIT - ACME CORP', 3200.00,'Income','data/demo/july-2026-chase.csv'),
('2026-07-16','OAK STREET COFFEE',             -5.75,'Dining','data/demo/july-2026-chase.csv'),
('2026-07-18','CITY PARKING AUTHORITY',       -18.00,'Transport','data/demo/july-2026-chase.csv'),
('2026-07-21','CORNER MARKET #1247',          -47.60,'Groceries','data/demo/july-2026-chase.csv'),
('2026-07-23','OAK STREET COFFEE',             -6.25,'Dining','data/demo/july-2026-chase.csv'),
('2026-07-24','STREAMFLIX SUBSCRIPTION',      -19.99,'Subscriptions','data/demo/july-2026-chase.csv'),
('2026-07-25','FUEL DEPOT #88',               -46.20,'Transport','data/demo/july-2026-chase.csv'),
('2026-07-26','SUNRISE DINER',                -20.15,'Dining','data/demo/july-2026-chase.csv'),
('2026-07-28','CORNER MARKET #1247',          -64.25,'Groceries','data/demo/july-2026-chase.csv'),
('2026-07-29','OAK STREET COFFEE',             -5.75,'Dining','data/demo/july-2026-chase.csv'),
('2026-07-30','PHARMACY PLUS #210',           -31.40,'Health','data/demo/july-2026-chase.csv'),
-- AUGUST (hero month: two dup pairs + trip spike cluster)
('2026-08-01','PAYROLL DEPOSIT - ACME CORP', 3200.00,'Income','data/demo/august-2026-chase.csv'),
('2026-08-01','MAPLE AVE APARTMENTS RENT',  -2400.00,'Home','data/demo/august-2026-chase.csv'),
('2026-08-02','CORNER MARKET #1247',          -61.35,'Groceries','data/demo/august-2026-chase.csv'),
('2026-08-03','SKYSTREAM PLUS MONTHLY',       -14.99,'Subscriptions','data/demo/august-2026-chase.csv'),
('2026-08-03','CLOUDVAULT BACKUP',             -9.99,'Subscriptions','data/demo/august-2026-chase.csv'),
('2026-08-04','OAK STREET COFFEE',             -5.75,'Dining','data/demo/august-2026-chase.csv'),
('2026-08-05','CITY ELECTRIC CO AUTOPAY',    -122.75,'Utilities','data/demo/august-2026-chase.csv'),
('2026-08-06','RIVERDALE GYM MONTHLY',        -49.99,'Health','data/demo/august-2026-chase.csv'),
('2026-08-07','CORNER MARKET #1247',          -55.20,'Groceries','data/demo/august-2026-chase.csv'),
('2026-08-08','OAK STREET COFFEE',             -6.25,'Dining','data/demo/august-2026-chase.csv'),
('2026-08-09','FUEL DEPOT #88',               -46.80,'Transport','data/demo/august-2026-chase.csv'),
('2026-08-10','SUNRISE DINER',                -23.15,'Dining','data/demo/august-2026-chase.csv'),
('2026-08-12','MEGAMART ONLINE',              -89.99,'Shopping','data/demo/august-2026-chase.csv'),
('2026-08-13','MEGAMART ONLINE',              -89.99,'Shopping','data/demo/august-2026-chase.csv'),
('2026-08-14','CORNER MARKET #1247',          -68.40,'Groceries','data/demo/august-2026-chase.csv'),
('2026-08-15','PAYROLL DEPOSIT - ACME CORP', 3200.00,'Income','data/demo/august-2026-chase.csv'),
('2026-08-16','OAK STREET COFFEE',             -5.75,'Dining','data/demo/august-2026-chase.csv'),
('2026-08-17','HARBORVIEW HOTEL',            -318.00,'Travel','data/demo/august-2026-chase.csv'),
('2026-08-17','BLUE WAVE SEAFOOD',            -96.40,'Dining','data/demo/august-2026-chase.csv'),
('2026-08-18','COASTAL CAB CO',               -34.50,'Transport','data/demo/august-2026-chase.csv'),
('2026-08-18','THE GILDED FORK',             -142.85,'Dining','data/demo/august-2026-chase.csv'),
('2026-08-19','SEASIDE BAR & GRILL',          -78.20,'Dining','data/demo/august-2026-chase.csv'),
('2026-08-20','HARBORVIEW HOTEL',            -318.00,'Travel','data/demo/august-2026-chase.csv'),
('2026-08-21','AIRPORT NEWS & GIFTS',         -28.75,'Shopping','data/demo/august-2026-chase.csv'),
('2026-08-22','CORNER MARKET #1247',          -59.60,'Groceries','data/demo/august-2026-chase.csv'),
('2026-08-23','OAK STREET COFFEE',             -6.25,'Dining','data/demo/august-2026-chase.csv'),
('2026-08-24','STREAMFLIX SUBSCRIPTION',      -19.99,'Subscriptions','data/demo/august-2026-chase.csv'),
('2026-08-25','FUEL DEPOT #88',               -43.55,'Transport','data/demo/august-2026-chase.csv'),
('2026-08-26','SUNRISE DINER',                -20.40,'Dining','data/demo/august-2026-chase.csv'),
('2026-08-27','MEGA ONLINE STORE',           -156.40,'Shopping','data/demo/august-2026-chase.csv'),
('2026-08-28','CORNER MARKET #1247',          -51.30,'Groceries','data/demo/august-2026-chase.csv'),
('2026-08-29','OAK STREET COFFEE',             -5.75,'Dining','data/demo/august-2026-chase.csv'),
('2026-08-29','CITY PARKING AUTHORITY',       -18.00,'Transport','data/demo/august-2026-chase.csv'),
('2026-08-30','PHARMACY PLUS #210',           -33.15,'Health','data/demo/august-2026-chase.csv');

-- Flag the true recurring monthly charges across ALL months (Jan backfill,
-- May import, and the new rows). The transaction_search tool maps
-- "recurring"/"subscription" to is_recurring=1, and real bank syncs set this
-- flag at import; without it the subscriptions beat finds nothing.
UPDATE transactions SET is_recurring = 1 WHERE description IN
  ('SKYSTREAM PLUS MONTHLY',
   'CLOUDVAULT BACKUP',
   'STREAMFLIX SUBSCRIPTION',
   'RIVERDALE GYM MONTHLY');

COMMIT;
