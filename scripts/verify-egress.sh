#!/usr/bin/env bash
set -Eeuo pipefail

# Linux/AWS acceptance harness for V1. Do not treat a Mac run as acceptance.
# The script installs a deny rule before any compose service starts, permits only
# HTTPS to the resolved OSV mirror addresses on the egress-capable network, and
# records every TCP SYN or UDP packet that crosses that boundary.

readonly COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
readonly PROJECT_NAME="${COMPOSE_PROJECT_NAME:-bombot-v1}"
readonly APP_ORIGIN="${APP_ORIGIN:-http://127.0.0.1:3000}"
readonly MIRROR_HOST="storage.googleapis.com"
readonly RUN_DATE="$(date -u +%F)"
readonly REPORT_PATH="docs/verification/v1-${RUN_DATE}.json"
readonly TEMP_DIRECTORY="$(mktemp -d)"
readonly CAPTURE_PATH="${TEMP_DIRECTORY}/egress.pcap"
readonly CAPTURE_TEXT_PATH="${TEMP_DIRECTORY}/egress.txt"
readonly WORKFLOW_PATH="${TEMP_DIRECTORY}/workflow.mjs"
readonly OVERRIDE_PATH="${TEMP_DIRECTORY}/mirror-hosts.yml"
readonly APP_LOG_PATH="${TEMP_DIRECTORY}/app.log"
readonly FIREWALL_CHAIN="BOMBOT_V1_${$}"

COMPOSE=(docker compose --project-name "${PROJECT_NAME}" --file "${COMPOSE_FILE}")
CAPTURE_PID=""
EGRESS_NETWORK=""
EGRESS_SUBNET=""

fail() {
  echo "V1 verification failed: $*" >&2
  exit 1
}

cleanup() {
  local exit_status=$?
  if [[ -n "${CAPTURE_PID}" ]] && kill -0 "${CAPTURE_PID}" 2>/dev/null; then
    kill -INT "${CAPTURE_PID}" 2>/dev/null || true
    wait "${CAPTURE_PID}" 2>/dev/null || true
  fi
  if [[ -n "${EGRESS_SUBNET}" ]]; then
    iptables --delete DOCKER-USER --source "${EGRESS_SUBNET}" --jump "${FIREWALL_CHAIN}" 2>/dev/null || true
    iptables --flush "${FIREWALL_CHAIN}" 2>/dev/null || true
    iptables --delete-chain "${FIREWALL_CHAIN}" 2>/dev/null || true
  fi
  "${COMPOSE[@]}" --profile maintenance down >/dev/null 2>&1 || true
  rm -rf "${TEMP_DIRECTORY}"
  exit "${exit_status}"
}
trap cleanup EXIT

[[ "$(uname -s)" == "Linux" ]] || fail "this acceptance harness must run on Linux/AWS"
[[ "${EUID}" -eq 0 ]] || fail "root is required to install and inspect the egress firewall"
[[ ! -e "${REPORT_PATH}" ]] || fail "refusing to overwrite ${REPORT_PATH}"

for command_name in docker iptables tcpdump getent curl node; do
  command -v "${command_name}" >/dev/null || fail "required command is unavailable: ${command_name}"
done

mapfile -t MIRROR_ADDRESSES < <(
  getent ahostsv4 "${MIRROR_HOST}" | awk '{ print $1 }' | sort -u
)
[[ "${#MIRROR_ADDRESSES[@]}" -gt 0 ]] || fail "could not resolve the OSV mirror before enforcing the policy"

{
  echo 'services:'
  echo '  osv-sync:'
  echo '    extra_hosts:'
  echo "      ${MIRROR_HOST}: \"${MIRROR_ADDRESSES[0]}\""
} >"${OVERRIDE_PATH}"
COMPOSE+=(--file "${OVERRIDE_PATH}")

# Image/package/model acquisition is provisioning-time egress. Container start
# and the measured workflow begin only after the policy and capture are active.
"${COMPOSE[@]}" --profile maintenance create

EGRESS_NETWORK="$(
  docker network ls \
    --filter "label=com.docker.compose.project=${PROJECT_NAME}" \
    --filter 'label=com.docker.compose.network=app_runtime' \
    --format '{{.ID}}'
)"
[[ -n "${EGRESS_NETWORK}" ]] || fail "could not identify the compose egress network"
EGRESS_SUBNET="$(docker network inspect --format '{{(index .IPAM.Config 0).Subnet}}' "${EGRESS_NETWORK}")"
[[ -n "${EGRESS_SUBNET}" ]] || fail "could not identify the compose egress subnet"

iptables --new-chain "${FIREWALL_CHAIN}"
iptables --insert DOCKER-USER 1 --source "${EGRESS_SUBNET}" --jump "${FIREWALL_CHAIN}"
iptables --append "${FIREWALL_CHAIN}" --match conntrack --ctstate ESTABLISHED,RELATED --jump ACCEPT
for mirror_address in "${MIRROR_ADDRESSES[@]}"; do
  iptables --append "${FIREWALL_CHAIN}" \
    --destination "${mirror_address}" --protocol tcp --dport 443 --jump ACCEPT
done
iptables --append "${FIREWALL_CHAIN}" --jump LOG --log-prefix 'BOMBot V1 blocked: '
iptables --append "${FIREWALL_CHAIN}" --jump REJECT --reject-with icmp-port-unreachable

tcpdump --interface any --numeric --unbuffered \
  --write-file "${CAPTURE_PATH}" \
  "src net ${EGRESS_SUBNET} and ((tcp[tcpflags] & tcp-syn != 0) or udp)" \
  >/dev/null 2>&1 &
CAPTURE_PID=$!
kill -0 "${CAPTURE_PID}" 2>/dev/null || fail "tcpdump did not start"

"${COMPOSE[@]}" start postgres model
for service_name in postgres model; do
  container_id="$("${COMPOSE[@]}" ps --quiet "${service_name}")"
  [[ -n "${container_id}" ]] || fail "${service_name} container was not created"
  for _ in $(seq 1 120); do
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${container_id}")"
    [[ "${health}" == 'healthy' ]] && break
    [[ "${health}" == 'exited' || "${health}" == 'dead' ]] && fail "${service_name} exited before becoming healthy"
    sleep 2
  done
  [[ "${health}" == 'healthy' ]] || fail "${service_name} did not become healthy"
done

"${COMPOSE[@]}" start osv-sync
sync_container_id="$("${COMPOSE[@]}" ps --all --quiet osv-sync)"
[[ -n "${sync_container_id}" ]] || fail "osv-sync container was not created"
sync_exit_status="$(docker wait "${sync_container_id}")"
[[ "${sync_exit_status}" == '0' ]] || fail "osv-sync exited with status ${sync_exit_status}"

"${COMPOSE[@]}" start app
for _ in $(seq 1 120); do
  if curl --silent --output /dev/null "${APP_ORIGIN}/api/stream"; then
    break
  fi
  app_container_id="$("${COMPOSE[@]}" ps --all --quiet app)"
  app_state="$(docker inspect --format '{{.State.Status}}' "${app_container_id}")"
  [[ "${app_state}" == 'exited' || "${app_state}" == 'dead' ]] && fail "app exited before becoming ready"
  sleep 2
done
curl --silent --output /dev/null "${APP_ORIGIN}/api/stream" || fail "app did not become ready"

"${COMPOSE[@]}" exec --no-TTY app sh -eu -c \
  'test "$PROFILE" = local; test "$OSV_MODE" = offline; test "$LLM_BASE_URL" = http://model:11434/v1' \
  || fail "app is not locked to the local model and offline OSV profile"

cat >"${WORKFLOW_PATH}" <<'NODE'
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const origin = process.env.APP_ORIGIN;
const sessionId = randomUUID();

async function jsonResponse(response, label) {
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  assert.equal(response.ok, true, `${label} returned HTTP ${response.status}: ${text}`);
  return body;
}

async function streamToCompletion(conversationId, messageIndex) {
  const query = new URLSearchParams({ conversationId, sessionId, messageIndex: String(messageIndex) });
  const response = await fetch(`${origin}/api/stream?${query}`);
  assert.equal(response.ok, true, `stream ${messageIndex} returned HTTP ${response.status}`);
  const frames = (await response.text()).split(/\r?\n\r?\n/).filter(Boolean);
  const events = frames.flatMap((frame) => {
    if (frame.startsWith(':')) return [];
    const event = frame.split(/\r?\n/).find(line => line.startsWith('event:'))?.slice(6).trim();
    const data = frame.split(/\r?\n/).find(line => line.startsWith('data:'))?.slice(5).trim();
    return event && data ? [{ event, data: JSON.parse(data) }] : [];
  });
  const failure = events.find(({ event }) => event === 'error');
  assert.equal(failure, undefined, `stream ${messageIndex} failed: ${JSON.stringify(failure?.data)}`);
  const done = events.find(({ event }) => event === 'done');
  assert.ok(done?.data?.response, `stream ${messageIndex} did not complete with a response`);
}

const fixtureBytes = await readFile('tests/fixtures/small-spdx.json');
const fixture = JSON.parse(fixtureBytes);
const expectedPackageCount = fixture.packages?.length;
assert.ok(Number.isInteger(expectedPackageCount), 'Small SPDX fixture must contain packages');
const form = new FormData();
form.append('file', new Blob([fixtureBytes], { type: 'application/json' }), 'small-spdx.json');
form.append('sessionId', sessionId);
form.append('messageIndex', '1');
const upload = await jsonResponse(
  await fetch(`${origin}/api/upload`, { method: 'POST', body: form }),
  'fixture upload',
);
assert.equal(upload.packagesScanned, expectedPackageCount);
assert.ok(upload.vulnerabilitiesFound > 0, 'offline fixture scan returned no vulnerabilities');
await streamToCompletion(upload.conversationId, 1);

const chat = await jsonResponse(await fetch(`${origin}/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    message: 'Summarize the highest-priority vulnerability in this SBOM.',
    conversationId: upload.conversationId,
    sessionId,
    messageIndex: 2,
  }),
}), 'follow-up chat');
await streamToCompletion(chat.conversationId, 2);

const packageQuery = await jsonResponse(await fetch(`${origin}/api/osv-query`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'lodash', version: '4.17.20', ecosystem: 'npm',
    conversationId: upload.conversationId, sessionId,
  }),
}), 'package query');
assert.ok(packageQuery.result?.vulns?.length > 0, 'offline package query returned no vulnerabilities');
await streamToCompletion(packageQuery.conversationId, 3);

const identifierQuery = await jsonResponse(await fetch(`${origin}/api/osv-query`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ cve: 'CVE-2021-23337', conversationId: upload.conversationId, sessionId }),
}), 'identifier query');
assert.ok(identifierQuery.result, 'offline identifier query returned no advisory');
await streamToCompletion(identifierQuery.conversationId, 4);
NODE

set +e
APP_ORIGIN="${APP_ORIGIN}" node "${WORKFLOW_PATH}"
workflow_status=$?
set -e

"${COMPOSE[@]}" logs --no-color app >"${APP_LOG_PATH}" 2>&1
if grep -Eq 'api\.openai\.com|PROFILE[=: ]+hosted|hosted profile' "${APP_LOG_PATH}"; then
  hosted_fallback_detected=true
else
  hosted_fallback_detected=false
fi

kill -INT "${CAPTURE_PID}"
wait "${CAPTURE_PID}" || true
CAPTURE_PID=""
tcpdump --numeric --tttt --read-file "${CAPTURE_PATH}" >"${CAPTURE_TEXT_PATH}" 2>/dev/null

mkdir -p "$(dirname "${REPORT_PATH}")"
MIRROR_ADDRESSES_CSV="$(IFS=,; echo "${MIRROR_ADDRESSES[*]}")" \
CAPTURE_TEXT_PATH="${CAPTURE_TEXT_PATH}" \
REPORT_PATH="${REPORT_PATH}" \
RUN_DATE="${RUN_DATE}" \
WORKFLOW_STATUS="${workflow_status}" \
HOSTED_FALLBACK_DETECTED="${hosted_fallback_detected}" \
node --input-type=module - <<'NODE'
import { readFile, writeFile } from 'node:fs/promises';

const mirrorAddresses = process.env.MIRROR_ADDRESSES_CSV.split(',').filter(Boolean);
const lines = (await readFile(process.env.CAPTURE_TEXT_PATH, 'utf8')).split('\n').filter(Boolean);
const attempts = lines.map((line) => {
  const match = line.match(/^(.+?) IP ([^ ]+) > ([^:]+):/);
  const destination = match?.[3] ?? null;
  const destinationAddress = destination?.replace(/\.\d+$/, '') ?? null;
  const destinationPort = destination?.match(/\.(\d+)$/)?.[1] ?? null;
  const allowed = destinationAddress !== null
    && mirrorAddresses.includes(destinationAddress)
    && destinationPort === '443';
  return { captured: line, destinationAddress, destinationPort, allowed };
});
const unexpectedAttempts = attempts.filter(attempt => !attempt.allowed);
const report = {
  schemaVersion: 1,
  run: 'AWS, model containerized, no IGW and no NAT',
  date: process.env.RUN_DATE,
  demonstrates: 'Model-service containment under the Linux/AWS compose boundary.',
  doesNotDemonstrate: 'No additional claim; this is V1.',
  policy: {
    default: 'deny',
    allowedOperationalDestination: 'storage.googleapis.com:443',
    resolvedAllowedAddresses: mirrorAddresses,
  },
  workflowCompleted: process.env.WORKFLOW_STATUS === '0',
  hostedFallbackDetected: process.env.HOSTED_FALLBACK_DETECTED === 'true',
  connectionAttempts: attempts,
  unexpectedConnectionAttemptCount: unexpectedAttempts.length,
};
await writeFile(process.env.REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
NODE

[[ "${workflow_status}" -eq 0 ]] || fail "the full fixture workflow did not complete"
[[ "${hosted_fallback_detected}" == false ]] || fail "the app attempted or announced a hosted-profile fallback"
unexpected_count="$(REPORT_PATH="${REPORT_PATH}" node --input-type=module -e \
  "import { readFileSync } from 'node:fs'; const r=JSON.parse(readFileSync(process.env.REPORT_PATH, 'utf8')); process.stdout.write(String(r.unexpectedConnectionAttemptCount));")"
[[ "${unexpected_count}" == '0' ]] \
  || fail "${unexpected_count} blocked or unexpected connection attempt(s) were captured; inspect ${REPORT_PATH}"

echo "V1 verification passed; evidence written to ${REPORT_PATH}"
