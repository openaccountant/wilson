import { describe, test, expect } from 'bun:test';
import { parseOfx, parseOfxDate, isOfxContent } from '../tools/import/parsers/ofx.js';

const OFX_1X_SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII

<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<DTSERVER>20260215120000
<LANGUAGE>ENG
<FI><ORG>Chase Bank<FID>1001</FI>
</SONRS>
</SIGNONMSGSRSV1>
<BANKMSGSRSV1>
<STMTTRNRS>
<TRNUID>1001
<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<STMTRS>
<CURDEF>USD
<BANKACCTFROM>
<BANKID>021000021
<ACCTID>123456789
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20260201
<DTEND>20260228
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260215120000.000[-5:EST]
<TRNAMT>-85.50
<FITID>2026021501
<NAME>WHOLE FOODS MARKET
<MEMO>GROCERY PURCHASE
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260210
<TRNAMT>3500.00
<FITID>2026021002
<NAME>DIRECT DEPOSIT
<MEMO>PAYROLL
</STMTTRN>
<STMTTRN>
<TRNTYPE>CHECK
<DTPOSTED>20260220120000
<TRNAMT>-150.00
<FITID>2026022001
<NAME>CHECK 1234
<CHECKNUM>1234
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;

const OFX_2X_XML = `<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="220" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>
<DTSERVER>20260215120000</DTSERVER>
<LANGUAGE>ENG</LANGUAGE>
<FI><ORG>Wells Fargo</ORG><FID>3000</FID></FI>
</SONRS>
</SIGNONMSGSRSV1>
<BANKMSGSRSV1>
<STMTTRNRS>
<TRNUID>1001</TRNUID>
<STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>
<STMTRS>
<CURDEF>USD</CURDEF>
<BANKACCTFROM>
<BANKID>121000248</BANKID>
<ACCTID>987654321</ACCTID>
<ACCTTYPE>SAVINGS</ACCTTYPE>
</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20260201</DTSTART>
<DTEND>20260228</DTEND>
<STMTTRN>
<TRNTYPE>DEBIT</TRNTYPE>
<DTPOSTED>20260218120000</DTPOSTED>
<TRNAMT>-42.99</TRNAMT>
<FITID>WF20260218001</FITID>
<NAME>AMAZON.COM</NAME>
<MEMO>ONLINE PURCHASE</MEMO>
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEP</TRNTYPE>
<DTPOSTED>20260205</DTPOSTED>
<TRNAMT>1200.00</TRNAMT>
<FITID>WF20260205001</FITID>
<NAME>TRANSFER FROM CHECKING</NAME>
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;

describe('OFX Parser', () => {
  describe('parseOfxDate', () => {
    test('parses full timestamp with timezone offset', () => {
      expect(parseOfxDate('20260215120000.000[-5:EST]')).toBe('2026-02-15');
    });

    test('parses date-only format', () => {
      expect(parseOfxDate('20260215')).toBe('2026-02-15');
    });

    test('parses timestamp without timezone', () => {
      expect(parseOfxDate('20260215120000')).toBe('2026-02-15');
    });
  });

  describe('isOfxContent', () => {
    test('detects OFXHEADER prefix', () => {
      expect(isOfxContent('OFXHEADER:100\nDATA:OFXSGML')).toBe(true);
    });

    test('detects <?OFX processing instruction', () => {
      expect(isOfxContent('<?xml version="1.0"?>\n<?OFX OFXHEADER="200"?>')).toBe(true);
    });

    test('detects <OFX> tag', () => {
      expect(isOfxContent('<OFX>\n<SIGNONMSGSRSV1>')).toBe(true);
    });

    test('rejects CSV content', () => {
      expect(isOfxContent('Date,Description,Amount\n01/15/2026,Store,-50.00')).toBe(false);
    });

    test('rejects QIF content', () => {
      expect(isOfxContent('!Type:Bank\nD01/15/2026\nT-50.00')).toBe(false);
    });
  });

  describe('OFX 1.x SGML format', () => {
    const transactions = parseOfx(OFX_1X_SGML);

    test('returns 3 transactions', () => {
      expect(transactions).toHaveLength(3);
    });

    test('first transaction: grocery debit', () => {
      const txn = transactions[0];
      expect(txn.date).toBe('2026-02-15');
      expect(txn.description).toBe('WHOLE FOODS MARKET');
      expect(txn.amount).toBe(-85.50);
      expect(txn.bank).toBe('ofx');
      expect(txn.external_id).toBe('2026021501');
      expect(txn.merchant_name).toBe('WHOLE FOODS MARKET');
      expect(txn.transaction_type).toBe('DEBIT');
    });

    test('second transaction: direct deposit credit', () => {
      const txn = transactions[1];
      expect(txn.date).toBe('2026-02-10');
      expect(txn.amount).toBe(3500.00);
      expect(txn.external_id).toBe('2026021002');
      expect(txn.transaction_type).toBe('CREDIT');
    });

    test('third transaction: check with check number', () => {
      const txn = transactions[2];
      expect(txn.check_number).toBe('1234');
      expect(txn.transaction_type).toBe('CHECK');
      expect(txn.amount).toBe(-150.00);
    });
  });

  describe('OFX 2.x XML format', () => {
    const transactions = parseOfx(OFX_2X_XML);

    test('returns 2 transactions', () => {
      expect(transactions).toHaveLength(2);
    });

    test('first transaction: Amazon debit', () => {
      const txn = transactions[0];
      expect(txn.date).toBe('2026-02-18');
      expect(txn.description).toBe('AMAZON.COM');
      expect(txn.amount).toBe(-42.99);
      expect(txn.bank).toBe('ofx');
      expect(txn.external_id).toBe('WF20260218001');
      expect(txn.merchant_name).toBe('AMAZON.COM');
      expect(txn.transaction_type).toBe('DEBIT');
    });

    test('second transaction: deposit without memo (no merchant_name)', () => {
      const txn = transactions[1];
      expect(txn.date).toBe('2026-02-05');
      expect(txn.amount).toBe(1200.00);
      expect(txn.external_id).toBe('WF20260205001');
      expect(txn.transaction_type).toBe('DEP');
      expect(txn.merchant_name).toBeUndefined();
    });
  });

  describe('missing optional fields', () => {
    test('transaction with only required fields', () => {
      const minimal = `<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260301
<TRNAMT>-25.00
<FITID>MIN001
</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;
      const txns = parseOfx(minimal);
      expect(txns).toHaveLength(1);
      expect(txns[0].date).toBe('2026-03-01');
      expect(txns[0].description).toBe('Unknown');
      expect(txns[0].amount).toBe(-25.00);
      expect(txns[0].bank).toBe('ofx');
      expect(txns[0].external_id).toBe('MIN001');
      expect(txns[0].merchant_name).toBeUndefined();
      expect(txns[0].check_number).toBeUndefined();
      expect(txns[0].authorized_date).toBeUndefined();
    });

    test('transaction with MEMO but no NAME uses MEMO as description', () => {
      const memoOnly = `<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN>
<TRNTYPE>FEE
<DTPOSTED>20260315
<TRNAMT>-5.00
<FITID>FEE001
<MEMO>MONTHLY SERVICE FEE
</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;
      const txns = parseOfx(memoOnly);
      expect(txns).toHaveLength(1);
      expect(txns[0].description).toBe('MONTHLY SERVICE FEE');
      expect(txns[0].merchant_name).toBeUndefined();
    });
  });

  describe('authorized_date (DTUSER)', () => {
    test('maps DTUSER to authorized_date', () => {
      const withDtUser = `<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN>
<TRNTYPE>POS
<DTPOSTED>20260220
<DTUSER>20260219
<TRNAMT>-15.00
<FITID>POS001
<NAME>COFFEE SHOP
</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;
      const txns = parseOfx(withDtUser);
      expect(txns).toHaveLength(1);
      expect(txns[0].date).toBe('2026-02-20');
      expect(txns[0].authorized_date).toBe('2026-02-19');
    });
  });
});
