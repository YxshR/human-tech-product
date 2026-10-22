import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { PayslipData, formatInr, printable, renderPayslipPdf } from '../src/payslip-pdf';

const data: PayslipData = {
  companyName: 'Acme Pvt Ltd', periodLabel: 'September 2026', employeeName: 'Asha Rao', employeeNumber: 'EMP0001', revision: 1,
  workingDays: '30.00', paidDays: '30.00', unpaidDays: '0.00',
  earnings: [{ label: 'Basic', amount: '20000.00' }, { label: 'HRA', amount: '8000.00' }, { label: 'Special allowance', amount: '22000.00' }],
  deductions: [{ label: 'Provident fund', amount: '1800.00' }],
  grossEarnings: '50000.00', totalDeductions: '1800.00', netPay: '48200.00', issuedOn: '2026-10-01',
};

describe('formatInr', () => {
  it.each([['0', '0.00'], ['5', '5.00'], ['999.5', '999.50'], ['1000', '1,000.00'], ['100000', '1,00,000.00'], ['1234567.89', '12,34,567.89'], ['123456789', '12,34,56,789.00'], ['-4500.1', '-4,500.10']])(
    '%s -> %s', (i, o) => expect(formatInr(i)).toBe(o));
  it('rejects things that are not money', () => { for (const bad of ['abc', '1.234', '', '1e5']) expect(() => formatInr(bad)).toThrow(); });
});

describe('renderPayslipPdf', () => {
  it('produces a one-page A4 PDF that can be re-opened', async () => {
    const buf = await renderPayslipPdf(data);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    const doc = await PDFDocument.load(buf);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getTitle()).toContain('September 2026');
    expect(Math.round(doc.getPage(0).getWidth())).toBe(595);
  });
  it('is deterministic for the same data', async () => {
    const a = await renderPayslipPdf(data); const b = await renderPayslipPdf(data);
    expect(a.length).toBe(b.length);
  });
  it('does not crash on names the standard fonts cannot draw', async () => {
    const doc = await PDFDocument.create(); const font = await doc.embedFont(StandardFonts.Helvetica);
    expect(printable(font, 'Asha Rao')).toBe('Asha Rao');
    expect(printable(font, 'आशा Rao')).toBe('??? Rao');
    const buf = await renderPayslipPdf({ ...data, employeeName: 'आशा राव' });
    expect((await PDFDocument.load(buf)).getPageCount()).toBe(1);
  });
  it('shrinks to fit long structures and refuses impossible ones', async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `Allowance ${i}`, amount: '100.00' }));
    expect((await PDFDocument.load(await renderPayslipPdf({ ...data, earnings: many(45) }))).getPageCount()).toBe(1);
    await expect(renderPayslipPdf({ ...data, earnings: many(200) })).rejects.toThrow(/too many/);
  });
  it('handles many components and zero deductions', async () => {
    const buf = await renderPayslipPdf({ ...data, deductions: [], earnings: Array.from({ length: 25 }, (_, i) => ({ label: `Allowance ${i}`, amount: '100.00' })) });
    expect((await PDFDocument.load(buf)).getPageCount()).toBe(1);
  });
});
