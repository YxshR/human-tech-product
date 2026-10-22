import { PDFDocument, PDFFont, StandardFonts, rgb } from 'pdf-lib';

export interface PayslipData {
  companyName: string;
  periodLabel: string;           // e.g. "September 2026"
  employeeName: string;
  employeeNumber: string;
  revision: number;
  workingDays: string; paidDays: string; unpaidDays: string;
  earnings: Array<{ label: string; amount: string }>;
  deductions: Array<{ label: string; amount: string }>;
  grossEarnings: string; totalDeductions: string; netPay: string;
  issuedOn: string;              // YYYY-MM-DD
}

/** 1234567.5 -> "12,34,567.50" (lakh/crore grouping). Works on the decimal string so no float rounding can creep in. */
export function formatInr(amount: string): string {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(amount);
  if (!m) throw new Error(`not a money amount: ${amount}`);
  const [, sign, whole, frac = ''] = m;
  const last3 = whole!.slice(-3);
  const rest = whole!.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${sign}${grouped}.${frac.padEnd(2, '0')}`;
}

/** The standard PDF fonts only cover Latin text: anything else is replaced rather than crashing the whole run. */
export function printable(font: PDFFont, text: string): string {
  const set = new Set(font.getCharacterSet());
  return [...text].map((ch) => (set.has(ch.codePointAt(0)!) ? ch : '?')).join('');
}

export async function renderPayslipPdf(d: PayslipData): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Payslip ${d.periodLabel} - ${d.employeeNumber}`);
  pdf.setProducer('humanTech'); pdf.setCreator('humanTech');
  pdf.setCreationDate(new Date(`${d.issuedOn}T00:00:00Z`)); pdf.setModificationDate(new Date(`${d.issuedOn}T00:00:00Z`));
  const page = pdf.addPage([595.28, 841.89]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.12); const muted = rgb(0.42, 0.44, 0.48); const rule = rgb(0.82, 0.84, 0.87);
  const left = 48; const right = 595.28 - 48; const mid = 595.28 / 2;
  let y = 790;

  const text = (t: string, x: number, size: number, f: PDFFont = regular, color = ink) => page.drawText(printable(f, t), { x, y, size, font: f, color });
  const textRight = (t: string, xr: number, size: number, f: PDFFont = regular) => {
    const s = printable(f, t);
    page.drawText(s, { x: xr - f.widthOfTextAtSize(s, size), y, size, font: f, color: ink });
  };
  const line = (x1: number, x2: number, thickness = 0.6) => page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color: rule });

  text(d.companyName, left, 16, bold); y -= 20;
  text(`Payslip for ${d.periodLabel}${d.revision > 1 ? ` (revision ${d.revision})` : ''}`, left, 11, regular, muted); y -= 16;
  line(left, right, 1); y -= 22;

  const info: Array<[string, string]> = [['Employee', d.employeeName], ['Employee no.', d.employeeNumber], ['Working days', d.workingDays], ['Paid days', d.paidDays], ['Unpaid days', d.unpaidDays]];
  for (let i = 0; i < info.length; i += 2) {
    for (const [col, entry] of [info[i], info[i + 1]].entries()) {
      if (!entry) continue;
      const x = col === 0 ? left : mid + 10;
      text(entry[0], x, 9, regular, muted); text(entry[1], x + 78, 10, bold);
    }
    y -= 16;
  }
  y -= 10; line(left, right); y -= 18;

  // Earnings (left) | Deductions (right)
  text('EARNINGS', left, 9, bold, muted); text('DEDUCTIONS', mid + 10, 9, bold, muted); y -= 6; line(left, mid - 10); line(mid + 10, right); y -= 16;
  const rows = Math.max(d.earnings.length, d.deductions.length, 1);
  // Leave room for totals, net-pay box and footer (about 200pt); shrink rows for unusually long structures instead of running off the page.
  const rowH = Math.min(16, (y - 200) / rows);
  if (rowH < 7) throw new Error('too many salary components to fit on one payslip page');
  const size = rowH >= 14 ? 10 : rowH >= 10 ? 8 : 6;
  for (let i = 0; i < rows; i++) {
    const e = d.earnings[i]; const x = d.deductions[i];
    if (e) { text(e.label, left, size); textRight(formatInr(e.amount), mid - 10, size); }
    if (x) { text(x.label, mid + 10, size); textRight(formatInr(x.amount), right, size); }
    y -= rowH;
  }
  y -= 4; line(left, mid - 10); line(mid + 10, right); y -= 15;
  text('Gross earnings', left, 10, bold); textRight(formatInr(d.grossEarnings), mid - 10, 10, bold);
  text('Total deductions', mid + 10, 10, bold); textRight(formatInr(d.totalDeductions), right, 10, bold);
  y -= 30;

  page.drawRectangle({ x: left, y: y - 12, width: right - left, height: 34, color: rgb(0.95, 0.96, 0.98), borderColor: rule, borderWidth: 0.8 });
  y += 2; text('NET PAY', left + 12, 11, bold); textRight(`INR ${formatInr(d.netPay)}`, right - 12, 14, bold);
  y -= 46;

  text('Amounts are in Indian Rupees (INR). This is a computer-generated payslip and needs no signature.', left, 8, regular, muted); y -= 12;
  text(`Issued on ${d.issuedOn}`, left, 8, regular, muted);
  return Buffer.from(await pdf.save());
}
