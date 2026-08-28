# Context Minimization Measurements

INC-08 Part B replaces the upload prompt's three pretty-printed JSON data sections with one
compactly serialized `SoftwareContext`. The measurements below use the same normalized package
and dependency shapes as `pages/api/upload.ts` and the deterministic synthetic OSV responses
from the egress-ledger sink. Counts cover the data payload headings and JSON, not the unchanged
quick-summary or instruction prose.

Token counts are estimates calculated as `ceil(UTF-8 bytes / 4)`; they are not provider
tokenizer output.

| Fixture | Packages | Normalized edges | Before bytes | Before tokens (est.) | After bytes | After tokens (est.) | Reduction |
|---|---:|---:|---:|---:|---:|---:|---:|
| `small-spdx.json` | 12 | 6 | 6,518 | 1,630 | 2,495 | 624 | 61.7% |
| `small-cyclonedx.json` | 12 | 6 (from 5 fan-out records) | 6,766 | 1,692 | 2,494 | 624 | 63.1% |
| `oversize-spdx.json` | 200 | 0 | 29,006 | 7,252 | 23,033 | 5,759 | 20.6% |

`malformed.json` has no row because it is deliberately rejected as a parse-failure fixture and
never produces model context.

The oversize result measures scale and truncation signaling, not dependency preservation: that
fixture contains no dependency edges. Edge preservation is asserted against both small fixtures,
which encode the same six-edge graph in SPDX and CycloneDX forms.

## Ledger prediction

Before regeneration, the hosted ledger recorded 176,959 total OpenAI request-body bytes across
9 requests. Because the pinned small-fixture upload context is replayed throughout its
conversation, the predicted reduction is roughly 60–90 KB total (about 34–51%), not merely one
4 KB context reduction. Counts are expected to remain 9 OpenAI requests, 164 OSV requests, 12
small-fixture OSV queries, and 2 of 2 inventory-carrying hosts.

## Ledger result

Regeneration preserved those request counts and reduced total OpenAI request-body bytes from
176,959 to 133,578: 43,381 bytes, or 24.5%. The largest OpenAI body fell from 42,091 to
34,198 bytes. The original 60–90 KB estimate was high because it overestimated the saving in
each replayed small-fixture context.

The raw-payload table and the wire ledger measure different serialization layers. The first
eight OpenAI requests belong to the small-SPDX conversation; each replays the same pinned upload
prompt and saves 4,436 wire bytes, for 35,488 bytes total. Request 9 is the separate oversize
upload request. It contains one input item and one oversize context, and saves 7,893 wire bytes.
Thus `8 × 4,436 + 7,893 = 43,381`, which reconciles the aggregate exactly.

For the oversize row, the table's data-only reduction is 5,973 raw UTF-8 bytes. At full-prompt
scope, adding the new prose truncation warning makes the raw reduction 5,879 bytes. Serializing
that prompt as a JSON string for the provider body increases the reduction to 7,893 bytes,
because the old pretty-printed payload has 1,218 newline characters and 3,214 quote characters
that require JSON escaping, while the compact minimized data has 1 newline and 2,416 quotes.
The data blocks therefore differ by 1,217 newlines, but the new full prompt adds one newline for
the prose truncation warning, making the full-prompt difference 1,216 escaped newlines and 798
escaped quotes. This reconciles exactly: `5,879 + 1,216 + 798 = 7,893`. The wire figure is
therefore larger without implying that the request carries multiple small contexts.
