# Content-free timing logs

The server writes one `timing_v1` JSON line to stdout for each instrumented chat turn and POST upload request. These diagnostics add no stored data and no new egress.

## Schema

Every record starts with `event: "timing_v1"` and a `kind` of `chat_turn` or `upload`. A phase that did not run is `null`, not zero.

Chat-turn records contain:

- `tools_enabled`: boolean
- `outcome`: `completed`, `model_error`, `exception`, or `sequence_conflict`
- `history_load_ms`
- `rounds`: up to nine records containing `db_prep_ms`, `model_first_chunk_ms`, `model_stream_ms`, `db_append_ms`, `input_tokens`, `output_tokens`, and `tool_calls_requested`
- `tools`: up to 64 records containing `round`, `tool`, `ms`, and `ok`; `tool` is one of `query_package_vulnerabilities`, `query_cve_details`, `analyze_sbom_package`, `query_package_dependencies`, or `unknown`
- `persist_ms`
- `total_ms`

Upload records contain:

- `osv_mode`: `api` or `offline`
- `outcome`: `ok`, `client_error`, `conflict`, or `exception`
- `parse_ms`
- `scan_ms`
- `persist_ms`
- `total_ms`
- `packages_scanned`
- `packages_total`

Durations and counts are non-negative integers or `null`. The serializer constructs a new object from this allowlist. Rejected fields are omitted and cause `invalid: true` to be added.

## Data that is never logged

Timing records never include participant text, model output, SBOM content, file names, package names, versions, SBOM identifiers, tool arguments, tool results, error messages, conversation IDs, session IDs, message indexes, e-mail addresses, or hashes or other derived values from any of those fields. There is no fingerprint or correlation ID.

The package-query endpoint (`pages/api/osv-query.ts`) is not instrumented in this increment.

## Extraction and interpretation

On the Compose stack, extract timing lines with:

```sh
docker compose logs app | grep '"event":"timing_v1"'
```

Mac measurements are development-only. AWS pilot measurements come from INC-13.

## Residual risks

The log driver's own timestamp could be lined up with database timestamps to associate a timing line with a session while that session still exists. Token counts reveal message size. No retention promise is made for these lines because they contain no content.
