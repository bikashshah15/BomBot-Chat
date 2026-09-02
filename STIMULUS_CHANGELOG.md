# Stimulus Changelog

Every entry records a change to participant-facing system behavior.
Columns: date · increment · what changed · why · effect on the study.

## 2026-09-02 — INC-09 Part B1a (unwired OSV result-shape parity)
- Advanced the pinned local OSV snapshot to `2026-09-02` and retained advisory aliases,
  affected ranges, and database-specific metadata so later offline wiring can preserve the
  same minimized vulnerability fields as raw OSV results. A canonical raw-advisory table
  preserves package-less ranges and complete multi-package records without duplicating them
  across package-index rows; because the snapshot now stores the complete raw advisory record,
  an offline lookup by CVE id or alias returns the same object the live `/v1/vulns/{id}` endpoint
  returns, rather than a reconstruction. Added CVE-alias lookup without connecting it to a route.
  This part makes no participant-facing change: routes still use the existing live OSV API path,
  and no request bytes or model stimulus move. The declared pin alone does not identify the
  snapshot and must be cited together with `max_modified`: `snapshot_date` `2026-09-02`,
  `max_modified` `2026-09-02T19:45:05.400430762Z`.
- Per-ecosystem record counts sum to 286,695 while `osv_advisories` holds 286,252; the 443-row
  difference is cross-bucket de-duplication, not data loss or a drop, because advisories listed
  in two ecosystem buckets are counted once per bucket but stored once by advisory-id primary
  key. Every ecosystem reported zero dropped advisories and all four drop-reason counts are zero.

## 2026-09-01 — INC-09 Part A (unwired local OSV snapshot machinery)
- Declared `2026-09-01` as the study snapshot pin shared by both evaluation profiles. The
  sync now requires that declaration, rejects a pin older than the newest advisory, and
  records database-clock ingestion time, newest advisory modification time, and per-ecosystem
  record/drop/reason counts plus bounded diagnostic samples as provenance. Part A adds only
  unwired storage, synchronization, OSV-Scanner-backed version matching, configuration,
  and fail-loud safety machinery. The verified archives are also installed into a versioned
  local scanner cache so the database and authoritative matcher use the same snapshot.
  Namespaced OSV ecosystems are admitted by their base bucket while their complete source
  namespace is preserved in storage; the production sync recorded zero dropped advisories
  and zero drop reasons in every ecosystem after that correction. It makes no
  participant-facing change: routes still use the existing live OSV API path, and no
  request bytes or model stimulus move.

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

## 2026-08-27 — INC-05 Part A (unwired conversation-store scaffolding)
- Added the app-owned conversation schema, migration path, data-access module, and bounded
  history configuration without wiring them into any route or client code. Effect: zero
  participant-facing change; no request, prompt, decoding parameter, or UI behavior changes.

## 2026-08-27 — INC-05 Part B (app-owned conversation history)
- Replaced OpenAI-hosted Conversations with application-owned history that is replayed
  explicitly on every model turn. OpenAI still receives the conversation content in transit,
  but no longer receives requests to create a persistent Conversation object.
- Removed background Responses. Existing client polling remains in place and now receives a
  synchronously completed result on its first successful poll; the polling transport itself
  is removed in INC-06.
- Prompt content and prompt delivery through the `instructions` field are unchanged. Model,
  temperature, top-p, maximum output tokens, and seed behavior are also unchanged.

## 2026-08-27 — INC-06 Part A (Vercel Analytics removal)
- Removed the participant-facing Vercel Analytics client beacon. A beacon stops firing.
  No visible behavior changes.

## 2026-08-27 — INC-06 Part B (SSE transport and unified timeout)
- Replaced the post-request polling handshake with one long-lived SSE connection and one
  shared 3-minute client timeout. The package-query path previously tolerated up to 6
  minutes while both chat paths tolerated 3; all three now use the same limit.
- The server emits incremental deltas, but the client buffers them and renders the assistant
  message once, complete, at `done`. Message rendering, visible status text, spinner
  placement, prompt content, and decoding parameters did not change.

## 2026-08-28 — INC-07 (deterministic pre-scan becomes authoritative)
- Model-initiated tool calling now defaults off, so the upload-time OSV pre-scan is the only
  vulnerability-data path used by default. The comparison arm remains available through
  `ENABLE_MODEL_TOOL_CALLS=true`. This is the largest stimulus change since INC-03: the
  pipeline that answers a participant's question is different by default.
- The authoritative upload scan row is pinned into model context after it would otherwise
  leave the 20-message replay window, previously at roughly the tenth subsequent question.
  This context-composition change affects the default and tool-enabled arms identically.
- Direct CVE-form input is now validated and URL-encoded before an OSV request. Letter casing
  is deliberately preserved, so lower-case identifiers do not gain new resolution behavior.

## 2026-08-28 — INC-08 Part A (unwired context builder)
- Added and tested the pure `SoftwareContext` builder without importing or calling it from any
  application route. Effect: no participant-facing stimulus change; prompt content, model
  parameters, tool availability, OSV scan coverage, and outbound request behavior are unchanged.

## 2026-08-28 — INC-08 Part B (minimized upload context)
- Replaced the upload prompt's three raw JSON data dumps with one minimized structured
  `SoftwareContext`. Package inventory, versions, and normalized dependency edges remain, while
  verbose vulnerability details, references, database metadata, and credits are omitted.
- The participant-facing instruction text is unchanged; only its preceding data payload changed.
  The payload now states total and scanned package counts, exposes truncation as a boolean, and
  adds a prose warning when the 150-package scan cap leaves packages unscanned.
