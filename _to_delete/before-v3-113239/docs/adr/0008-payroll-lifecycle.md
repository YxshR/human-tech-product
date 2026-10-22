# ADR-0008: Payroll lifecycle is a database-enforced state machine

Status: accepted

`draft → validated → calculated → under_review → approved → locked → payslips_generated`, plus `rejected` and `cancelled`. Illegal moves, edits after lock, self-approval, locking with unreconciled totals and calculating without engine version / input hash / rule-bundle hash all raise typed SQLSTATEs (`HT002`–`HT004`). Payment is a **separate** `payment_status`, because "approved" and "paid" are different facts.

Corrections never edit history: a new revision (`correction_of_run_id`, reason required) may only follow a finalised run of the same period. Only one in-flight run per period (partial unique index).
