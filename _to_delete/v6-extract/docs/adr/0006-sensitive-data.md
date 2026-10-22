# ADR-0006: Sensitive identifiers

Status: accepted

- **Aadhaar numbers are not stored.** Only a "verified" flag and last four digits would ever be needed; storing the number creates liability with no payroll benefit.
- PAN, UAN, ESIC, bank account and IFSC are stored as ciphertext with a separate blind index for lookup; the API returns masked values and only to callers with `employee.read_identifiers` / `employee.read_bank`.
- Bank detail changes are maker-checker: the person who entered them cannot verify them (`employee.update_bank` vs `employee.verify_bank`; no role holds both).
- Ciphertext columns are redacted before reaching the audit log.
