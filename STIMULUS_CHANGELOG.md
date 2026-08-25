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
