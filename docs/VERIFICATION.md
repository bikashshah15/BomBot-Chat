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
