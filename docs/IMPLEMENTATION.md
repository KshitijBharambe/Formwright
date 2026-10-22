# Formwright implementation direction

Build a deterministic engine that discovers controls, resolves approved facts,
fills, verifies, recovers, and leaves unresolved work open for review.
Fifty applications per day is a throughput goal, not an established rate.

## Existing foundation

| Capability | Implementation | Next work |
| --- | --- | --- |
| Job selection | `job-source.ts`, `job-queue.ts`, `notion.ts` | Preserve live Notion refresh and selection rules |
| ATS entry | `application-entry.ts`, `form-detection.ts`, `simplify.ts`, `sites.ts` | Fixtures for unsupported layouts |
| Approved facts | `answers.ts`, `profile-values.ts`, `field-matching.ts` | Reviewed explicit aliases; ambiguous questions stay unresolved |
| Form execution | `form.ts`, `form-stability.ts`, Workday adapters | Stable field identities and richer verification evidence |
| Session reuse | Persistent `.browser` context, shared account handler with origin locks | More ATS layouts and resumable checkpoints |
| Workflow | `journey.ts`, `run.ts` | Persist checkpoints and guarded state transitions |
| Review | Local dashboard and retained tabs | Actionable exceptions and supported resumption |

## 1. Verification and recovery

Implemented locally:

- Rediscover after interactions and audit again after a bounded quiet window.
  Read DOM properties so resets without mutation events are visible.
- Repeat the full audit after each recovery interaction. Stop for review if
  controls keep changing or the existing 90-pass/two-attempt bounds are exhausted.
- Verify an approved unchecked checkbox as `No`; native required validation still
  blocks an unchecked required consent field.
- Check the requested filename before reusing an existing accepted résumé and
  recheck attachment state before counting it as complete.
- Leave unknown required questions unresolved and count final verified fills.

Run `npm run test:verification` plus recovery/upload and affected adapter tests.
These use synthetic data and do not establish live ATS or server-side acceptance.
The quiet window is 450 ms, polled every 100 ms, with a 2-second bound. Changes
arriving after that observation window remain possible.

## 2. Authentication and resumption

Implemented locally in `auth-settings.ts` and `account-auth.ts`: one shared
credential pair, write-only dashboard credential entry, explicit HTTPS hostname
restrictions, email/password and email-first login, opt-in signup on identified
registration forms, and same-origin authentication serialization. Existing sessions
are reused first. Required unknowns/consent, rejected login, SSO, password reset,
CAPTCHA, MFA and email verification remain handoffs. Failed login never triggers
signup. Local credentials use a Git-ignored 0600 file; macOS Keychain integration
and inbox verification are still planned. Tests use synthetic intercepted pages;
live employer account compatibility remains unverified.

Parallel autofill is implemented in `concurrency.ts`, `run.ts`, and the dashboard:
1–8 concurrent applications with ordered Notion selection, per-job input snapshots,
owned tabs/popups, serialized result persistence, active employer reservations,
and pause/drain semantics. The shared dashboard browser is opened once even when
several workers start together. Run `test:auth`, `test:parallel`, and
`test:dashboard` for local regression coverage.

## 3. Common form model and workflow states

Extract discovery, resolution, execution, and verification from `form.ts` along
its actual responsibilities. ATS adapters own navigation and unusual widgets.
Model repeated rows, stable identity, approved mapping source, verification
evidence, attempt counts, and precise exceptions. Omit answer values from new
diagnostic records.

Introduce guarded states for discovered, needs_auth, filling, needs_answers,
verification_required, ready_for_review, submitting, confirmed, and failed.
Preserve compatibility with existing result statuses and duplicate/uncertain
submission protection. A click establishes an attempt; a new explicit confirmation
establishes submission. The dashboard continues to require manual submission.

## 4. Reliability benchmark

Build a reviewed, redacted dataset from real unresolved patterns and synthetic
regressions. Measure correct verified fields, wrong fills, unresolved required
fields, authentication completion, manual interventions, and confirmed submissions
separately. Require zero wrong consequential answers and zero false submission
confirmations in that dataset. Track coverage by ATS and widget type.

Keep local fixture results separate from authorized live observations. Measure
throughput after quality gates pass. Promote mappings only after review and a
regression case.

## Deferred decisions

- Deterministic mode remains the default. Expanding the existing optional local
  classifier requires a reviewed dataset and demonstrated improvement.
- Extract modules when they hide a concrete responsibility; a target directory
  diagram alone does not justify a new manager or class.
- Revisit portable candidate profiles when current official documentation and an
  available employer flow establish support. No rollout date is assumed.
