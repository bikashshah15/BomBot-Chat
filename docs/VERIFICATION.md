# Verification

The Mac stack is the development environment. The AWS stack is where the research measurement
is taken. A convenient local recording must not be reported as evidence for the AWS containment
claim.

## Evidence classes

Every recorded run must be labelled with exactly one of these rows.

| Run | What it demonstrates | What it does NOT demonstrate |
|---|---|---|
| Airplane mode on the **Mac**, model host-native | The *machine* completes the full workflow with no network. A real and citable result. | That the model service is **contained**. The model is outside every compose network; there is no boundary around it to test. |
| **AWS**, model containerized, no IGW and no NAT | Model-service containment, evidenced by the route table and VPC Flow Logs. **This is `V1`.** | Nothing further — this is the claim. |

## Airplane-mode development demonstration

Before disconnecting the workstation, ensure the pinned OSV snapshot, its scanner cache, and the
model weights are already present on disk. Start the development stack while connected only if
those cached prerequisites need to be checked, then stop it. Physically disconnect the Mac from
all networks, start the development stack, upload the verification fixture, complete its generated
analysis, submit a follow-up chat question, and exercise both a package lookup and an identifier
lookup. Record the complete procedure and result, including the absence of network connectivity.

Label this evidence **“Airplane mode on the Mac, model host-native.”** It demonstrates whole-machine
offline completion in the development environment. It does not demonstrate model-service
containment because host-native Ollama is outside the Compose network boundary.

## AWS research measurement (`V1`)

Run `scripts/verify-egress.sh` only on the Linux/AWS stack after its model weights and required
images are provisioned. Retain the generated `docs/verification/v1-<date>.json` together with the
AWS route table and VPC Flow Logs for the same run. The script must report failure if the workflow
does not complete, if any blocked or unexpected connection attempt occurs, or if the application
attempts to use the hosted profile after the local model is unreachable.

Label this evidence **“AWS, model containerized, no IGW and no NAT.”** This is the research
measurement and the `V1` containment result.

### Status of the verification harness

`scripts/verify-egress.sh` has never been executed on any machine. Static inspection checked two
of its API-shape assumptions against the application routes: the upload response fields used by
the harness, and the stream endpoint's query parameters and SSE `event`/`data` framing. Its other
request and response assumptions have not been exercised. The script is therefore a specification
of the intended procedure, not a tested artifact; the first AWS run will also be its first
execution.

The packet capture is the guard against a hosted-profile fallback: an attempted connection outside
the OSV-mirror allowlist is evidence of the attempt even when the firewall blocks it. The app-log
text match is secondary. It can produce a false negative if fallback-related logging is absent or
its wording changes, and a false positive if a harmless diagnostic or quoted error contains one of
the matched hosted-profile strings. A clean log match cannot override a captured unexpected
connection.

### Measurement-time policy boundary

`docker-compose.yml` does not deny application egress by itself. The application and `osv-sync`
share `app_runtime`, the sole non-internal network, and the deny-all firewall rule exists only while
`scripts/verify-egress.sh` is running. A successful `V1` run may therefore claim that the restrictive
policy was enforced and observed for that measured run, with the route table and VPC Flow Logs as
the AWS evidence. It may not claim that an ordinary Compose launch is deny-all by construction or
that the application remains egress-contained after the script removes its temporary firewall
rule.

## Build-context isolation (`INC-11a.2`, Mac development build, 2026-09-18)

This is build/image evidence, not an AWS `V1` containment measurement. The scope
extension declared in workplan §7 assigns `Dockerfile` and `.dockerignore` to this
increment; this section records its verification.

At parent `9faa314`, executed `docker build --no-cache --progress=plain --target
builder -t bombot-inc11a2-before .`: its application-context line printed
`transferring context: 4.69MB`. Running that builder image confirmed `/app/study`
existed and contained six files.

Round 1 built exact parent plus this increment's Docker paths in an isolated clone with
`docker build --no-cache --progress=plain -t bombot-inc11a2 .` (exit 0). The clone
also held a read-only copy of the excluded study inputs. BuildKit's final image
build printed a **6.34kB incremental sync**, not the full context size. To measure
and inspect the complete filtered context, refreshed only isolated input
timestamps and executed a diagnostic Dockerfile containing `FROM scratch` and
`COPY . /context`, with `--no-cache --output type=local`. That printed
`transferring context: 1.64MB` and exported **134 files / 1,635,836 payload bytes**.
The exported inventory contained no study/planning documents, Markdown,
`docs/`, `tests/`, test files, environment files, dumps, archives or build outputs.

Executed `docker run --rm --entrypoint sh bombot-inc11a2 -c 'ls -R /app'` and
retained its listing. Also executed `find /app -type f | sort` inside the image
to cover hidden directories. Both inspections found no `study/`, planning
document or `*.test.mjs`/`*.test.ts`. Round 1's empty Markdown inventory
was superseded by the notice-preserving runtime below.
`/app/lib` contained **all 29 non-test project files**, not just the mechanically
derived 12-file retention-worker closure. All 12 closure files were present.

A TypeScript-AST traversal of runtime imports derived that closure with zero
reachable tests; OSV sync resolved to six project files. The migration script
reads `db/schema.sql`, so both remain available. Runtime scripts are limited to
`osv-sync.mjs` and `db-migrate.mjs`; `build.js` stays in the builder. The egress
harness runs on the AWS host, and model-evaluation scripts are development tools.
Observed build file reads included the three tsconfigs, Next/Vite/PostCSS/
Tailwind configs, `next-env.d.ts`, package manifests and `index.html`; no access
to `components.json` or `eslint.config.js` was recorded, and neither is admitted.

Using disposable containers on an internal Docker network, the actual app
command `node server.js` returned **HTTP 200** at `/`; the source retention-worker
command remained running with a Postgres connection; `node scripts/osv-sync.mjs`
exited **0**, ingesting ten synthetic ecosystem archives into ten vulnerability
rows. `node scripts/db-migrate.mjs` exited **0** against that disposable database.
These are startup/fixture checks, not a production snapshot or GPU/model run.
No Compose launch was used. Evidence is retained under
`/private/tmp/inc11a2-build/`; no environment values are included in this record.

### Notice retention and layer recovery (round 2)

Before edits, executed `docker save bombot-inc11a2 -o
/private/tmp/inc11a2-round2-before.tar`, then `python3
/private/tmp/inc11a2-round2/recover-layer.py`. It recovered
`app/node_modules/dotenv/README.md` (**22,894 bytes**) from layer **14**;
layer **15** contained `app/node_modules/dotenv/.wh.README.md` (**0 bytes**).
The round-1 filesystem inventory lacked that README. Deletion masked the file;
it did not remove its bytes from the saved image.

Admitted root `LICENSE`, copied it into builder and runtime, and removed the
runtime deletion instruction entirely. No narrower deletion rule is used:
notices may be embedded in README files. Next standalone tracing also omits
installed notices, so the builder preserves all installed dependency files
matching case-insensitive `*.md`, `LICENSE*`, `LICENCE*`, `COPYING*`, or `NOTICE*`
in `dependency-notices/`, which is copied into runtime. Hash inventories from
builder `/app/node_modules` and runtime `/app/dependency-notices` matched all
**5,086 paths and SHA256 hashes** exactly.

Round 2 executed `docker build --no-cache --progress=plain -t bombot-inc11a2 .`
(exit 0), then the same `ls -R /app` and hidden-file `find` inventories.
`/app/LICENSE` is present and byte-identical to the repository. The complete
Markdown inventory now contains **3,154 files**, all under dependency notice or
`node_modules` paths; the full list is `markdown-inventory.json` in the evidence
directory below. They contain dependency documentation/notices only: no project
planning document, `STIMULUS_CHANGELOG.md`, `Instruction Prompt.md`, or material
from project `study/` or `docs/`. Test-file count remains **0**, all **29/29**
non-test project lib sources match repository bytes, and worker closure **12/12**
remains present. The diagnostic context export printed **1.66MB** (round-1
baseline **4.69MB**); root LICENSE is admitted, research inputs remain excluded.

The disposable internal-network smoke rerun passed: app **HTTP 200**, worker
running with a Postgres connection, OSV sync **exit 0 / 10 synthetic rows**,
and migration **exit 0**. No Compose or model launch was used. G1/G2 and ledger
checks passed; bare root `node --test` passed in up/down/clean environments:
**148/148/0**, **145/123/22**, **148/148/0** collected/pass/skip, respectively;
fail/cancelled and the specified diagnostics grep were **0** in every run.
All 22 down skip names and full TAP logs are retained in the round-2 report.
No model-facing path is in scope. Exact-parent rollback build/type check passed.
Evidence: `/private/tmp/inc11a2-round2/`; round-1 evidence remains unchanged.
