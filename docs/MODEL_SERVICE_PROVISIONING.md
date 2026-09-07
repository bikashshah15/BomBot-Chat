# Model service provisioning

The Linux/AWS topology runs an OpenAI-compatible server on the Compose
`model_private` network. That network is marked `internal: true`, and the model
service is attached to no other network. It therefore has no default route to
the internet at runtime. The application reaches it at
`http://model:11434/v1`; the model port is not published to the host.

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

Container-image downloads and the provisioning-only weight download are
provisioning-time egress. They must be accounted for in the egress table from
INC-11 and the AWS provisioning network and records built in INC-13; they are
not runtime application egress and carry no participant inventory.

This increment verifies the Compose configuration and isolation topology only.
The volume population, GPU attachment, model health check against real weights,
and absence of an AWS route to the internet cannot be executed or verified
until the NVIDIA AWS host and its provisioning topology exist.
