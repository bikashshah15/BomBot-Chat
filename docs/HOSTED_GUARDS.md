# Hosted-provider guardrails

All controls in this document run on the server and apply only after a conversation's
stored provider resolves to a `hosted` profile. Local-provider conversations do not
read, increment, or acquire any hosted guard state. `ENABLE_MODEL_TOOL_CALLS` remains
the sole switch for model tools and is never read from request data.

## Demo access

When `DEMO_ACCESS_TOKEN` is set, visit:

```text
/api/demo-access?token=<DEMO_ACCESS_TOKEN>
```

The route compares the token with a timing-safe helper, sets an HttpOnly,
`SameSite=Strict` cookie containing a one-way derived value, and redirects to `/`.
In production the cookie is also `Secure`. Once the cookie exists, a supplied
`Origin` must match the request origin. When `DEMO_ACCESS_TOKEN` is unset, hosted
turns are accepted only from a loopback client address; missing or invalid address
information fails closed.

## Controls and defaults

| Control | Refusal code | Default / configuration |
| --- | --- | --- |
| Pinned upload required | `sbom_required` | Required for every hosted turn |
| Demo cookie or loopback-only fallback | `demo_access_required` | `DEMO_ACCESS_TOKEN` optional |
| Same-origin request with demo cookie | `invalid_origin` | Always enforced when cookie exists |
| Hosted turns per session per rolling hour | `hosted_rate_limited` | 20 (`HOSTED_SESSION_HOURLY_LIMIT`) |
| Hosted turns per IP per rolling hour | `hosted_rate_limited` | 60 (`HOSTED_IP_HOURLY_LIMIT`) |
| Concurrent hosted streams per session | `hosted_stream_busy` | 1 |
| Process-wide hosted turn budget | `hosted_budget_exhausted` | 200 (`HOSTED_PROCESS_REQUEST_BUDGET`) |
| Hosted turns per conversation | `hosted_turn_limit` | 20 (`HOSTED_MAX_TURNS_PER_CONVERSATION`) |
| User message length, all providers | `message_too_long` | 2,000 characters (`MAX_USER_MESSAGE_CHARACTERS`) |
| `/api/chat` parsed body | framework 413 | 32 KiB |

The process budget and rolling counters are intentionally in-process for the
single-instance demo. They reset on process restart and are not shared across
instances. The guard adds no network destination. Its logs contain only fixed
codes, counts, and the word `hosted`; they never contain request text, SBOM data,
cookies, access tokens, API keys, billing data, or account data.
