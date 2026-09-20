# Model service provisioning

The Linux/AWS topology runs an OpenAI-compatible server on the Compose
`model_private` network. That network is marked `internal: true`, and the model
service is attached to no other network. It therefore has no default route to
the internet at runtime. The application reaches it at
`http://model:11434/v1`; the model port is not published to the host.

Under `PROFILE=local`, the application sends the fixed, non-secret placeholder
`local-openai-compatible` and never sends `LLM_API_KEY` to the model server.
Compose's `env_file` still places that key in the app container environment,
where the local profile leaves it unused.

## Weight delivery decision

Model weights will be stored in the external `bombot_model_weights` volume.
Provisioning must happen before the runtime stack starts:

1. Set `OLLAMA_IMAGE` to an Ollama image pinned by immutable digest, pull it,
   and create the external `bombot_model_weights` volume. Compose deliberately
   has no floating-tag default.
2. In a provisioning-only job with explicit outbound access, mount that volume
   at `/root/.ollama` and pull the model named by `LLM_MODEL`.
3. Record the image digest and model artifact identity, remove the provisioning
   job's outbound access, and start the runtime Compose topology.

The runtime `model` service runs only `ollama serve`; it never runs a pull. Its
health check uses `ollama show` for `LLM_MODEL`, so a missing or mismatched
pre-provisioned model leaves the service unhealthy and prevents the app from
starting instead of silently attempting a download or falling back to a hosted
provider.

## Bounded model keep-alive

The runtime service sets `OLLAMA_KEEP_ALIVE=12h`, replacing Ollama's five-minute
idle default. A loaded model can therefore preserve its prompt cache across the
pauses expected while a participant reads, thinks, and completes questionnaire
pages. This changes timing only: it does not alter application requests, model
weights, instructions, decoding, or generated output.

The value is deliberately bounded. While the model is loaded, cached prompt
tokens remain in memory and can be decoded back to text. An indefinite value
such as `-1` could retain the last participant's context indefinitely, which is
incompatible with the promise that raw session content becomes unrecoverable
within 24 hours of last activity. Twelve hours covers a study block while still
forcing unload twelve hours after the model's last request, which keeps the last
session before an idle period inside that 24-hour bound. While other sessions
keep using the model it stays loaded under any keep-alive value, exactly as it
did under the five-minute default; whether an earlier session's cached tokens
are then overwritten depends on the runtime's cache reuse, which this
repository neither controls nor verifies.

## Operator preload before a study block

After the stack is healthy and before each study block, issue this request from
an operator-controlled HTTP client already attached to the internal
`model_private` network (replace `<LLM_MODEL>` with the provisioned model name):

```sh
curl --fail --show-error --silent \
  -H 'Content-Type: application/json' \
  --data '{"model":"<LLM_MODEL>","keep_alive":"12h"}' \
  http://model:11434/api/generate
```

The omitted `prompt` is intentional: this preload loads weights and carries no
participant content. Do not publish the model port merely to perform preload.

For the host-native Mac development setup, the operator must set
`OLLAMA_KEEP_ALIVE=12h` in the Ollama app's launch environment and restart the
app before the study block. This is an operator action; repository setup does
not change the Mac's global Ollama configuration.

Container-image downloads and the provisioning-only weight download are
provisioning-time egress. They must be accounted for in the egress table from
INC-11 and the AWS provisioning network and records built in INC-13; they are
not runtime application egress and carry no participant inventory.

This increment verifies the Compose configuration and isolation topology only.
The volume population, GPU attachment, model health check against real weights,
and absence of an AWS route to the internet cannot be executed or verified
until the NVIDIA AWS host and its provisioning topology exist.
