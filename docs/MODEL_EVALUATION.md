# Local model quality evaluation

## Scope and reference

This evaluation compares three locally served instruction models using the pinned local OSV
snapshot dated `2026-09-07` as the answer key for package identification, severity, emitted
identifier, and mitigation scoring. It does not use the hosted model or the hosted OSV API.

The canonical study SBOMs are not in this workspace.
This evaluation therefore runs on synthetic repository fixtures and cannot establish quality on
the study corpus.

The evaluated models and the metadata reported by `ollama show` are:

| Model | Exact parameters | Quantization | Served context |
|---|---:|---|---:|
| `bombot-qwen2.5-7b-instruct-q4_K_M:latest` | 7.6B | Q4_K_M | 16,384 tokens |
| `bombot-qwen2.5-14b-instruct-q4_K_M:latest` | 14.8B | Q4_K_M | 16,384 tokens |
| `bombot-mistral-nemo-12b-instruct-2407-q4_K_M:latest` | 12.2B | Q4_K_M | 16,384 tokens |

All requests use the application's offline BOMbot system instructions and upload prompt, with
temperature 0, top-p 1, a 4,096-token output limit, and no seed. These settings reduce variance;
they do not make generation deterministic. Each fixture is evaluated three times per model, and
the three observed values plus their minimum-to-maximum spread are reported for every aggregate
measure.

The 16,384-token served context is a declared, pinned stimulus parameter.
It is carried by `PARAMETER num_ctx 16384` in each derived model and was verified from the live
server with `ollama ps` reporting `CONTEXT 16384`.

## Observation point and truncation guard

The evaluation observes the terminal `LlmResult` returned by the local gateway stream. The
OpenAI-compatible provider requests streaming usage from Ollama and maps the server's
`prompt_tokens` field to `usage.inputTokens`; the gateway preserves that result. The participant
SSE route consumes the result but does not expose usage, so observing the gateway result gives the
harness the server-reported count without changing a participant-facing path.

Every evaluated turn records that count. Two independent deliberately oversize probes against the
16,384-token served window both returned 8,194 processed prompt tokens. The collapse value is
therefore derived as `floor(served context / 2) + 2 observed server offset tokens`, which gives
`floor(16,384 / 2) + 2 = 8,194`. The cause of the two-token offset is not established, and the
offset must be reverified if the context pin or server changes.

The standing guard uses a tight tolerance of one token around 8,194. Counts from 8,193 through
8,195 escalate to a calibrated two-marker diagnostic; counts clearly below or above that interval
pass. The tolerance covers a one-token framing-accounting movement while avoiding the invalid broad
band that rejected legitimate prompts at 8,288 through 8,470. A marker escalation passes only when
both unique endpoint markers return, confirms front truncation when only the trailing marker
returns, and stops as inconclusive for any other result. The marker check is an escalation rather
than the standing guard because model copy failures can create false results in both directions.
The calibrated manual diagnostic is retained as `scripts/model-evaluation-truncation-probe.mjs`;
its `--probes-only` mode reproduces the target, below-window, and far-above marker controls.

No token-level guard can detect a semantic attention failure in which every token was processed
and the model still ignored part of the prompt.

## Operational definitions

The repaired definitions in this section were fixed before the replacement run was generated or
scored. The earlier instrument-invalid run is not included in the results.

### Emitted identifiers and D4 alias resolution

An emitted identifier is each case-insensitive occurrence in the response of a CVE, GHSA, PYSEC,
RUSTSEC, MAL, or another supported OSV-style identifier consisting of a database prefix, a
four-digit year, and a serial. Markdown link text and destinations count as separate occurrences if
the model emits the identifier in both places; this measures what the response actually repeats.

This synthetic fixture corpus contains no `MAL-` identifiers.
That absence does not make the prefix optional: 221,441 of the 228,760 distinct npm advisory IDs
in the pinned snapshot are `MAL-` IDs, so omitting the prefix would materially undercount emitted
identifiers on representative real npm inventories.

The harness normalizes emitted identifiers, reference primary IDs, and resolved primary IDs to
uppercase at their respective extraction, reference-construction, and resolver-result boundaries.
Its harness-only SQL resolver compares both advisory primary IDs and alias values case-insensitively;
the shipped `lib/osv/db.ts` lookup is not changed by this measurement.

An occurrence is grounded immediately when its normalized identifier directly matches a normalized
primary advisory ID in that fixture's pinned-snapshot match. Alias resolution is an additional path:
an occurrence that is not a direct match is grounded when its case-insensitive advisory lookup
returns a primary ID in the normalized fixture reference set. The D4 reclassification count is the
number of emitted occurrences that were not direct matches and became grounded through that alias
route. The evaluation separately reports direct matches, alias-resolved matches, and identifiers
grounded by neither route.

### Fixture-package vulnerability classification F1

The reference positives are the scanned fixture package entries for which the pinned local OSV
matcher returns at least one advisory. A model emits a positive package identification when an
exact fixture package name occurs in a sentence or Markdown line that also contains either an
emitted vulnerability identifier, or both a severity word and a vulnerability-risk word. Package
identity is the fixture entry's ecosystem, name, and version; package entries are not deduplicated.

Fixture-package vulnerability classification is micro-averaged F1 over all evaluated fixtures in
one repeat:
`2TP / (2TP + FP + FN)`. An empty reference paired with no emitted positives is a perfect match for
that fixture. A named clean package is a false positive, and a reference-vulnerable package not
named under the rule is a false negative.

This closed-world measure only searches for package names already present in the fixture inventory.
It cannot detect or count a model claim about a package absent from that inventory, so it is not an
open-world package-hallucination measure.

### Severity-class exact-match agreement

The reference severity of a vulnerable package is the highest severity among its matched
advisories. Numeric CVSS base scores use the standard bands: critical 9.0–10.0, high 7.0–8.9,
medium 4.0–6.9, and low 0.1–3.9. When the stored score is a vector rather than a numeric base score,
the advisory's database-specific `CRITICAL`, `HIGH`, `MODERATE`/`MEDIUM`, or `LOW` label supplies
the rank; advisories without either are unranked. The model-side rank is the highest explicit
severity word associated with that exact package name in one sentence or Markdown line, using the
same four-level ordering.

The summary measure is the number of comparable package observations for which the model-assigned
severity class exactly equals the reference severity class, reported as `k/n` and as a fraction.
Spearman rank correlations are retained only in the diagnostic appendix because 4–7 observations
with heavy ties do not support a rank-correlation interpretation.

### Identifier-grounding diagnostic

An emitted identifier occurrence is grounded when it either directly matches a fixture reference
primary ID or reaches one through the D4 alias-resolution route. Every other emitted occurrence is
non-matching for that fixture, including a real advisory unrelated to the matched fixture inventory.
The diagnostic records direct, alias-resolved, and non-matching occurrence counts and the
non-matching fraction, but this corpus design does not support interpreting that fraction as a
model's hallucination propensity.

### Mitigation-advice specificity

A reference-vulnerable package is eligible when at least one of its matched advisories supplies a
fixed version. Advice for that package is specific only when a sentence or Markdown line contains
the exact package name, an update/upgrade/fix/patch/remediation cue, and an exact fixed-version
string from the pinned reference. A version that is merely plausible, newer, or attached to a
different package does not count.

Specificity is eligible package observations with at least one specific mitigation divided by all
eligible reference-vulnerable package observations, micro-averaged over fixtures in one repeat. It
is reported as not defined when there are no eligible observations.

## Withdrawn first run

The first scoring run is withdrawn because its case-sensitive harness resolver and incorrect
grounding predicate labelled direct GHSA reference matches as hallucinations. Its result tables are
intentionally removed rather than retained as findings.

## Repaired results

All 63 replacement generations completed with server-reported prompt usage. The collapse guard
passed all 63 turns directly and escalated zero turns. Across the Qwen models, the seven fixture
prompts reported 2,145, 2,809, 3,532, 6,333, 8,288, 8,290, and 8,470 tokens. Across Mistral-Nemo
they ranged from 2,243 to 9,205 tokens. None fell inside the 8,193-to-8,195 escalation interval.

The tables report the three repeat-level observations in run order. “Spread” gives the observed
minimum–maximum followed by its width.

### Fixture-package vulnerability classification F1

Each repeat contains 331 fixture-package observations: 13 reference-positive and 318
reference-negative observations. False positives here mean only clean packages already present in
the fixture inventory; absent-package claims remain outside the measure.

| Model | Repeat observations | Spread | TP / within-fixture FP / FN observations |
|---|---|---|---|
| Qwen2.5 7.6B | 0.631579, 0.631579, 0.631579 | 0.631579–0.631579; width 0 | 6/0/7, 6/0/7, 6/0/7 |
| Qwen2.5 14.8B | 0.700000, 0.700000, 0.700000 | 0.700000–0.700000; width 0 | 7/0/6, 7/0/6, 7/0/6 |
| Mistral-Nemo 12.2B | 0.555556, 0.761905, 0.761905 | 0.555556–0.761905; width 0.206349 | 5/0/8, 8/0/5, 8/0/5 |

The 331-observation denominator is large enough to report this closed-world corpus result, but only
13 observations are positive. It is therefore descriptive evidence with limited power to
distinguish models on vulnerable-package detection, not a precise estimate of general performance.

### Severity-class exact-match agreement

| Model | Exact-match fraction observations | Spread | Exact / comparable observations |
|---|---|---|---|
| Qwen2.5 7.6B | 0.666667, 0.666667, 0.666667 | 0.666667–0.666667; width 0 | 4/6, 4/6, 4/6 |
| Qwen2.5 14.8B | 0.166667, 0.166667, 0.166667 | 0.166667–0.166667; width 0 | 1/6, 1/6, 1/6 |
| Mistral-Nemo 12.2B | 0.000000, 0.000000, 0.000000 | 0.000000–0.000000; width 0 | 0/4, 0/7, 0/7 |

The exact-match denominators remain small, so these are transparent corpus counts rather than
stable general severity estimates. They avoid implying that a rank correlation is meaningful at
n=4–7 with only a few distinct severity classes.

### Identifier grounding and D4 exercise

| Model | Non-matching fraction observations | Spread | n: emitted / direct / alias / neither observations |
|---|---|---|---|
| Qwen2.5 7.6B | 0.000000, 0.000000, 0.000000 | 0.000000–0.000000; width 0 | 22/22/0/0, 22/22/0/0, 22/22/0/0 |
| Qwen2.5 14.8B | 0.069767, 0.069767, 0.069767 | 0.069767–0.069767; width 0 | 172/160/0/12, 172/160/0/12, 172/160/0/12 |
| Mistral-Nemo 12.2B | 0.000000, 0.000000, 0.000000 | 0.000000–0.000000; width 0 | 33/33/0/0, 36/36/0/0, 36/36/0/0 |

Across the full run, 687 emitted occurrences divide into 651 direct matches, zero alias-resolved
matches, and 36 grounded by neither route. The D4 reclassification count is therefore zero. Now
that direct matches are independently grounded, this zero means exactly that no non-direct emitted
identifier became fixture-grounded through alias resolution; it no longer includes direct GHSA
matches rejected because of resolver casing.

D4 is implemented but unexercised in this evaluation: alias resolution fired for 0 of 687 emitted
occurrences, so this corpus provides no evidence that the rule works on model output.

This corpus cannot support a hallucination-rate claim. Every correct identifier appears verbatim in
the prompt, and 651 of 687 emitted occurrences are direct matches, so the diagnostic primarily
measures copying fidelity rather than hallucination propensity. All 36 non-matching occurrences
come from Qwen2.5 14.8B. In each repeat they are three identifier strings repeated four times, with
Markdown link text and destinations contributing duplicated, non-independent occurrences.

### Mitigation-advice specificity

| Model | Repeat observations | Spread | n: specific / eligible observations |
|---|---|---|---|
| Qwen2.5 7.6B | 0.538462, 0.538462, 0.538462 | 0.538462–0.538462; width 0 | 7/13, 7/13, 7/13 |
| Qwen2.5 14.8B | 0.923077, 0.923077, 0.923077 | 0.923077–0.923077; width 0 | 12/13, 12/13, 12/13 |
| Mistral-Nemo 12.2B | 0.307692, 0.538462, 0.538462 | 0.307692–0.538462; width 0.230769 | 4/13, 7/13, 7/13 |

Thirteen eligible observations per repeat are enough to report the observed corpus fractions, but
not enough for a stable general mitigation-specificity estimate. These figures are descriptive and
should not alone decide model selection.

### Metric coarseness and repeat variation

Metric output can remain unchanged when model text changes. Qwen2.5 14.8B again produced two
byte-distinct responses for `small-cyclonedx.json`—5,551 bytes in repeat 1 and 5,509 bytes in
repeats 2 and 3—but all four score summaries for that fixture were identical. Mistral-Nemo likewise
produced two byte-distinct `small-cyclonedx.json` responses with identical score summaries. Its two
byte-distinct `small-spdx.json` responses did change the score summary. A zero metric spread can
therefore mean either identical output or output variation that falls outside these coarse
extractors; it must not be read as proof of identical generations.

There are only three repeat-level observations per model. Their observed spread describes these
three runs and is not a sufficiently large sample for a variance or reproducibility claim.

These results support carrying Qwen2.5 7.6B forward as the conservative model-selection direction
for INC-10b because it has the strongest severity-class exact-match result and no non-matching
identifier occurrences, while its weaker fixture-package classification and mitigation results
remain explicit tradeoffs. These results do not support any published quality claim.

## Diagnostic appendix: severity-rank correlation

The machine-readable artifact retains the Spearman values. They are excluded from the results
summary because n=4–7 with heavy ties does not support a rank-correlation interpretation.
Tie structures use `severity=count`; the ranks are low 1, medium/moderate 2, high 3, and critical 4.

| Model | Spearman observations | Spread | n observations | Reference ties by repeat | Model ties by repeat |
|---|---|---|---|---|---|
| Qwen2.5 7.6B | -0.632456, -0.632456, -0.632456 | -0.632456–-0.632456; width 0 | 6, 6, 6 | `2=2, 3=4` each | `3=5, 4=1` each |
| Qwen2.5 14.8B | -0.539360, -0.539360, -0.539360 | -0.539360–-0.539360; width 0 | 6, 6, 6 | `2=1, 3=5` each | `1=1, 2=2, 3=1, 4=2` each |
| Mistral-Nemo 12.2B | 0.577350, 0.645497, 0.645497 | 0.577350–0.645497; width 0.068147 | 4, 7, 7 | R1 `2=2, 3=2`; R2/R3 `2=2, 3=5` | R1 `3=1, 4=3`; R2/R3 `3=1, 4=6` |

The complete per-turn responses, prompt-token counts, guard decisions, reference package records,
grounding routes, and unrounded score components are stored in `docs/model-evaluation-runs.json`.
