# SSO OpenLux Reporting Implementation Plan

**Goal:** Collect OpenLux text, image, video and embedding usage from nine confirmed SSO tools without charging duplicate costs or guessing missing Token values. TikTok Studio is excluded by the user.

**Architecture:** Child applications send authenticated metadata-only usage events to the existing main-site ledger, with durable delivery retries and one request ID per real upstream attempt. Existing business billing flows continue; a `usageReportedSeparately` flag suppresses only duplicate legacy usage entries. Main accepts pending async tasks and their first terminal update. Unknown model prices remain pending calculation.

**Stack:** Existing Next.js/Express/FastAPI apps, TypeScript/JavaScript/Python, PostgreSQL or atomic local outbox files using persistent data volumes.

## Work packages

- [x] Main: add pending SSO status and validated legacy duplicate-suppression flag in `frontend/app/api/sso/usage/route.ts` and `frontend/app/lib/sso-tool-requests.ts`; test pending→completed, duplicate delivery, mismatched identity/flag and unchanged business lifecycle.
- [x] Main: add readable labels for buyer show, shop images, copywriting and video tool IDs; document rollout order and per-tool secrets.
- [x] Knowledge: cover current chat, background text and embedding calls in `lib/server/usage-monitor.ts`, `model-text.ts`, `upload-embeddings.ts` and their callers, including authenticated/background user context; avoid counting existing chat reporting twice.
- [x] Image tools: instrument actual requests/retries and authenticated jobs in maijiaxiu/main and dianputu/master, preserving all response data and vendor fallback behavior.
- [x] Existing billing tools: instrument chanpinsheji/main, sabc/master, xiaoshou/main and baokuangaixie/main; use actual hostname and complete Token details, preserving missing values and suppressing legacy duplicate records only when canonical reporting is configured.
- [x] Other tools: instrument wenan/main and seedance/main including async task create/poll completion, text/image calls and durable reporting retry.
- [x] Verify each repo with focused regression tests and appropriate builds; use synthetic integration events against main to verify auth, unknown-price records, image per-call price and Token image pricing, first-terminal-wins and no duplicate billing.
- [x] Review all diffs, publish reviewable code, and report exact deployment variables and any missing model prices. Preserve unrelated original workspace edits and all credentials.

Detailed protocol and ownership are coordinated in `tmp/sso-price-audit/reporting-contract.md` outside production code. No production database or paid model endpoint is used for testing.

Publication: main-site main and knowledge master are pushed; eight other tools have draft PRs pending the user's branch choice. The deployment guide contains all PR links, test results and required environment variables. Live deployment is not part of this verification.
