# ADR-0005: Money is exact decimal, rounding is explicit

Status: accepted

- Stored: final amounts `numeric(14,2)` (totals `numeric(16,2)`), rates `numeric(12,6)`. Intermediate precision (19,4) lives in the calculation trace. (The blueprint's `numeric(19,4)` for all money was narrowed: storing 4 dp on final payable amounts invites sub-paisa drift between payslip, register and bank file.)
- Transport: decimal **strings** in JSON. Zod rejects numbers and exponents.
- Code: `decimal.js` in an isolated constructor; `parseFloat` is banned by ESLint; a DB test asserts no column uses float or `money`.
- Rounding is a property of the component (`mode` + `places`), applied once per line. Net pay = gross − deductions is a DB `CHECK`; line items must reconcile with employee totals and run totals before a run can lock.
