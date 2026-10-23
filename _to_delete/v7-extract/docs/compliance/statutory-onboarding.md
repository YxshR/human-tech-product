# Statutory rule onboarding (required before any tenant activates payroll)

1. Preparer drafts a rule set from the official notification; records `source_url`, `source_reference`, `source_published_on`.
2. A **different** reviewer (qualified payroll/compliance professional) checks it against the source and moves it to `approved`.
3. Run the golden-test fixtures for that rule group (add new fixtures from official worked examples).
4. Tenant payroll activation (`payroll_activated_at`, platform-only) happens only after the pay group's states and groups have approved rules.

The product must never imply that built-in rates are legal advice. Rates in tests are fictional.
