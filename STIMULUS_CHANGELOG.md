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
