# No Participant Identifiers

BOMbot does not ask for, receive, store, or link any participant identifier.
Sessions are anonymous and cannot be matched to an external survey.

Older database schemas retain the `user_email` and related ciphertext columns so
legacy rows remain readable until retention removes them. New application routes
always write `user_email` as null. `PARTICIPANT_ID_MODE`,
`PARTICIPANT_ID_SALT`, and the conditional handling in `lib/db/chatLogs.ts` are
therefore inert and may be removed in a later schema cleanup.

On every client load, BOMbot removes the legacy `bombot-user-email` localStorage
entry so an email saved by an older version is purged from shared machines. No
replacement identifier is collected.
