# Architecture

```text
Browser (Next.js client)                 Server (Next.js route handlers)            Supabase
------------------------                 -------------------------------            --------
guided capture ─ resize, quality,  ──►   /images: validate, sha256, upload   ──►   storage: receiving-evidence/<org-slug>/...
  local OCR + barcode (free, hints)      /inspect: performInspection               tables (RLS enabled + forced)
                                           ├ load images via caller session
                                           ├ ONE Gemini call (temp 0, JSON schema) ──► Google AI (free tier)
                                           ├ zod-validate observations
                                           ├ runChecks (deterministic)
                                           ├ decide (FAIL→EXCEPTION, else UNCERTAIN, else PASS)
                                           └ persist checks, attempt, content hash
```

## Modules

- `src/lib/ai/` — prompt (versioned), response schema, Gemini REST client. No verdicts from the model.
- `src/lib/inspection/checks.ts` — 12 checks: identity, carton count, units/carton, total quantity, colour,
  variant, components, carton crushing, water damage, tears, unit damage, obvious defect.
- `src/lib/inspection/decision.ts` — overall decision, pending outcome, per-group coverage.
- `src/lib/evidence/record.ts` — evidence record (`cube.receiving.evidence/1.0`) and SHA-256 over canonical JSON.
  The hash is an integrity reference, not a tamper-proof guarantee.
- `src/lib/server/receiving.ts` — orchestration, attempt limit, daily quota, pending handling.
- `supabase/migrations/0001_init.sql` — schema, helper functions, RLS, storage policies.

## Failure handling

Timeout, rate limit, quota, auth error or malformed output → record `pending`, reason stored, attempt logged,
operator can retry up to `MAX_INSPECTION_ATTEMPTS`. Daily cap: `INSPECTION_DAILY_LIMIT`.

## Tenancy

`organization_id` on every row; policies compare it to `app_org_id()` (security definer, from `profiles`).
Roles live in `user_roles`. Storage policies require the first path segment to equal the caller's org slug.
The service-role key is used only by the seed script.
