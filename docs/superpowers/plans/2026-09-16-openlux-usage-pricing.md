# OpenLux usage pricing implementation plan

**Goal:** Show screenshot-based OpenLux estimates for main-site and SSO usage, including recorded calls that have not yet been priced. Never apply these screenshot rates to Yunwu calls.

**Architecture:** Seed a shared, explicitly sourced rate catalog. Saved provider/model overrides take priority. New calls store rate snapshots; dashboard queries project estimates only for unpriced historical completed calls, leaving stored amounts unchanged. Unknown rate components remain unknown rather than zero. Knowledge-base OpenLux reports use the existing authenticated SSO usage protocol.

**Stack:** Next.js, TypeScript, Prisma/PostgreSQL, Node tests.

- [x] Transcribe every fully visible price card into identical frontend/backend catalogs; check exact model IDs, per-million units, per-call units, and unspecified rates.
- [x] Test then implement partial-rate and image-input calculation, provider normalization, and administrator overrides in `usage-values.ts`, `usage-ledger.ts` and `usage-pricing.ts`.
- [x] Test historical estimates, preserved actual amounts, filters and grouping against PostgreSQL; add a reusable SQL projection in `usage-report-pricing.ts` and integrate it into the admin endpoint.
- [x] Show default rates, missing-price explanations, detailed token buckets and history-estimation labels on `/admin/usage`; support editing and restoring screenshot defaults.
- [x] Align knowledge-base OpenLux reporting with `/api/sso/usage`; document matching per-tool secrets and keep unrelated provider reporting unchanged.
- [x] Run pricing/unit/integration tests, frontend/backend builds, knowledge-base tests and browser checks with synthetic data.

## Validation results

- Pricing, catalog, attribution and PostgreSQL tests: 24 passed, no skips.
- Main frontend/backend builds and changed TypeScript file ESLint passed.
- Knowledge reporting tests: 11 passed; knowledge full suite: 98 passed, 1 skipped; build and ESLint passed.
- Main full suite: 208 passed, 2 existing failures, 1 skipped. The two failing text assertions in adminConsoleUi and conversationImageJobs and their source files are unchanged from the base commit.
- Browser verification with synthetic data: live knowledge reporting, historical USD calculation, Yunwu exclusion, stored actual/estimated amounts preserved, edited/restored rates and source filters.

Publication targets: main-site main and knowledge-base master, as authorized by the user. No production database was modified.
