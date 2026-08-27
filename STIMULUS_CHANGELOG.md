# Stimulus Changelog

Every entry records a change to participant-facing system behavior.
Columns: date · increment · what changed · why · effect on the study.

## 2026-08-18 — pre-INC-00 (Responses API migration)
- Assistants API → Responses + Conversations API. Reason: OpenAI sunset 2026-08-26.
  Effect: transport change; conversation state remains OpenAI-hosted.
- Model gpt-4-turbo-preview → gpt-4o. Reason: turbo-preview unavailable in the new
  OpenAI project. Effect: THE FIELDED MODEL IS NOT THE EVALUATED MODEL. Must be
  disclosed in the methods section.
- Added instruction line forbidding invented vulnerability facts when OSV data is
  unavailable (lib/openai-responses.ts:154). Effect: prompt differs from the
  evaluated system's prompt.
- Tool-calling capped at 8 successor rounds. Effect: bounds a previously unbounded loop.

## 2026-08-25 — post-INC-00 (deployment configuration documentation)
- Added the three required Supabase variable placeholders to env.example and documented
  the Vercel Production variable checklist. Effect: no participant-facing behavior
  change; runtime code, model, prompt, tools, and scan coverage are unchanged. Vercel
  console variables were not changed in this repository-only step.

## 2026-08-25 — post-INC-00 (build reproducibility)
- Changed Vercel dependency installation from npm install to npm ci so deployments use
  the exact package-lock.json captured by the baseline. Effect: no participant-facing
  behavior change; application runtime behavior and experimental stimulus are unchanged.

## 2026-08-26 — INC-01 (egress ledger regression guard)
- The synthetic 200-package oversize SPDX fixture produced exactly 150 OSV package
  queries, making the existing upload scan cap observable as a regression guard. This
  is not evidence that the cap fired on a live or study input, and INC-01 does not change
  the cap, scan behavior, or participant-facing stimulus.

## 2026-08-26 — INC-02 (declared LLM sampling configuration)
- Declared `LLM_MODEL=gpt-4o`, `LLM_TEMPERATURE=0`, `LLM_TOP_P=1`, and
  `LLM_MAX_OUTPUT_TOKENS=4096`; `LLM_SEED` remains unset/null.
- The evaluated system ran at the vendor default temperature of 1.0. Temperature 0 is a
  deliberate declared deviation, not a bug fix, and belongs in the methods section beside
  the gpt-4-turbo-preview to gpt-4o model change.
- No application code reads the validated config yet. These values first reach requests
  through the INC-03 gateway, so participant-facing behavior remains unchanged in INC-02
  and the disclosure ledger must remain unchanged.
- Temperature 0 reduces variance but does not guarantee determinism. Floating-point
  non-associativity and backend routing can still produce run-to-run differences; the
  instrument must be described as variance-reduced, not deterministic.

## 2026-08-26 — INC-03 Part B step 1 (initial LLM gateway routing)
- Routed upload, chat, and direct OSV-query model requests through the LLM gateway, so
  the declared sampling parameters now reach those participant-facing requests.
- This is the first increment to alter participant-facing behavior: temperature moves
  from the vendor default 1.0 to the declared value 0; top-p is pinned to 1 and maximum
  output tokens to 4096.
- The disclosure ledger is unchanged by design because the same inventory-derived bytes
  still reach the same hosts. A green ledger is not evidence of stimulus preservation;
  the stimulus changed even though the disclosure boundary did not.
- Tool-continuation requests from `run-status.ts` are not yet routed through the gateway
  and therefore are not yet pinned at this step. The following step completes that path.

## 2026-08-26 — INC-03 Part B step 2 (tool-continuation gateway routing)
- Routed `run-status.ts` retrieval and tool-continuation successors through the LLM
  gateway. Every model request path, including continuation requests after tool output,
  now applies temperature 0, top-p 1, and maximum output tokens 4096.
- This completes the participant-facing sampling change begun in step 1. The disclosure
  boundary remains unchanged by design: the same hosts receive the same data classes,
  while request bodies grow because the pinned fields are now present on continuations.
- Failed, cancelled, and incomplete Responses remain terminal with no retry, including a
  rate-limit failure returned inside a Response. Their distinct status and structured
  error details remain available for the later R-8 fix; this step adds no retry behavior.

## 2026-08-27 — INC-04 Part A (unwired self-hosted Postgres scaffold)
- Added local Postgres infrastructure, schema, and data-access scaffolding without importing
  it from application code. Supabase remains the active logging path. Effect: no
  participant-facing change and no stimulus delta.

## 2026-08-27 — INC-04 Part B (application-owned logging path)
- Replaced browser and server writes to hosted Supabase with server-mediated writes to
  self-hosted Postgres. This changes the participant-facing system surface and removes the
  Supabase disclosure destination; model behavior, prompt, and scan coverage are unchanged.
- Added `PARTICIPANT_ID_MODE`, defaulting to `email` to preserve current participant-ID
  behavior. The `pseudonymous` salted-hash path is implemented but not selected because
  open decision #3 remains unanswered and requires Bikash/IRB direction.
- Session UUIDs are bearer capabilities that prevent practical enumeration, not identity
  proof; disclosure of a UUID defeats the check and must be reflected in IRB materials.
