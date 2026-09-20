import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import 'dotenv/config';
import pg from 'pg';

const { createUploadHandler, parseSBOMData } = await import('./upload.ts');
const { OSVSourceUnavailableError } = await import('../../lib/osv/errors.ts');
const { matchOsvPackages: realMatchOsvPackages } = await import('../../lib/osv/match.ts');

const UNREACHABLE_DATABASE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPERM',
  'ETIMEDOUT',
]);

function isDatabaseUnreachable(error) {
  if (error instanceof AggregateError) {
    return error.errors.length > 0 && error.errors.every(isDatabaseUnreachable);
  }
  return Boolean(
    error
    && typeof error === 'object'
    && UNREACHABLE_DATABASE_CODES.has(error.code),
  );
}

function responseRecorder() {
  return {
    statusCode: 200,
    jsonBody: undefined,
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.jsonBody = body;
      return this;
    },
  };
}

test('dependency graph keeps vulnerability results distinct for duplicate package versions', async () => {
  const fixturePath = new URL('../../tests/fixtures/duplicate-versions-spdx.json', import.meta.url);
  const fixtureContent = await readFile(fixturePath, 'utf8');
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'bombot-upload-duplicate-versions-test-'));
  const uploadPath = path.join(tempDir, 'duplicate-versions-spdx.json');
  await copyFile(fixturePath, uploadPath);

  const handler = createUploadHandler({
    osvMode: 'offline',
    async captureScanSource(mode, client, scan) {
      await scan(client);
      return { osv_mode: mode, snapshot_date: 'synthetic' };
    },
    async parseForm() {
      return {
        fields: {
          sessionId: '00000000-0000-4000-8000-000000000001',
          messageIndex: '1',
        },
        files: {
          file: {
            filepath: uploadPath,
            originalFilename: 'duplicate-versions-spdx.json',
            size: Buffer.byteLength(fixtureContent),
          },
        },
      };
    },
    async matchOsvPackages(_client, packages) {
      return packages.map(package_ => ({
        package: package_,
        vulnerabilities: package_.name === 'acme-lib' && package_.version === '2.0.0'
          ? [{
            id: 'OSV-TEST-1',
            summary: 'Synthetic advisory for the higher version',
            details: 'Synthetic test data',
            affected: [],
            references: [],
          }]
          : [],
      }));
    },
    async createConversation() {
      return { id: 'conversation_duplicate_versions_synthetic' };
    },
    async appendConversationMessages() {
      return [];
    },
    async insertLog() {},
    async wait() {},
  });

  try {
    const response = responseRecorder();
    await handler({ method: 'POST' }, response);

    assert.equal(response.statusCode, 200);
    const duplicateNodes = response.jsonBody.dependencyGraph.nodes
      .filter(node => node.label === 'acme-lib');
    assert.equal(duplicateNodes.length, 2);

    const lowerVersion = duplicateNodes.find(node => node.version === '1.0.0');
    const higherVersion = duplicateNodes.find(node => node.version === '2.0.0');
    assert.equal(lowerVersion.vulnerabilityCount, 0);
    assert.equal(lowerVersion.hasVulnerabilities, false);
    assert.equal(higherVersion.vulnerabilityCount, 1);
    assert.equal(higherVersion.hasVulnerabilities, true);
    assert.notEqual(lowerVersion.vulnerabilityCount, higherVersion.vulnerabilityCount);

    const githubNode = response.jsonBody.dependencyGraph.nodes
      .find(node => node.label === 'github-only');
    assert.equal(githubNode.vulnerabilityCount, -1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('upload wiring retains the full oversize inventory and exposes scan truncation in the prompt', async () => {
  const fixturePath = new URL('../../tests/fixtures/oversize-spdx.json', import.meta.url);
  const fixtureContent = await readFile(fixturePath, 'utf8');
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'bombot-upload-test-'));
  const uploadPath = path.join(tempDir, 'oversize-spdx.json');
  await copyFile(fixturePath, uploadPath);

  let capturedAppend;
  let osvQueries = 0;
  const handler = createUploadHandler({
    async parseForm() {
      return {
        fields: {
          sessionId: '00000000-0000-4000-8000-000000000001',
          messageIndex: '1',
        },
        files: {
          file: {
            filepath: uploadPath,
            originalFilename: 'oversize-spdx.json',
            size: Buffer.byteLength(fixtureContent),
          },
        },
      };
    },
    async queryOSVForPackage() {
      osvQueries += 1;
      return [];
    },
    async createConversation() {
      return { id: 'conversation_oversize_synthetic' };
    },
    async appendConversationMessages(options) {
      capturedAppend = options;
      return [];
    },
    async insertLog() {},
    async wait() {},
  });

  try {
    const response = responseRecorder();
    await handler({ method: 'POST' }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.jsonBody.totalPackages, 200);
    assert.equal(response.jsonBody.packagesScanned, 150);
    assert.equal(response.jsonBody.unrecognizedEcosystemCount, 0);
    assert.equal(osvQueries, 150);
    assert.equal(capturedAppend.pinned, true);
    assert.equal(capturedAppend.messages.length, 1);

    const oversizePrompt = capturedAppend.messages[0].content;
    assert.equal(typeof oversizePrompt, 'string');
    const serializedPrompt = JSON.stringify(oversizePrompt);
    assert.equal(serializedPrompt.includes('**Vulnerability Scan Data:**'), false);
    assert.equal(serializedPrompt.includes('**Package Dependency Information:**'), false);
    assert.equal(serializedPrompt.includes('**All Packages in SBOM:**'), false);

    const contextHeading = '**Minimized Software Context:**\n';
    const contextStart = oversizePrompt.indexOf(contextHeading) + contextHeading.length;
    const contextEnd = oversizePrompt.indexOf('\n\nPlease provide a QUICK summary', contextStart);
    assert.ok(contextStart >= contextHeading.length);
    assert.ok(contextEnd > contextStart);
    const oversizeContext = JSON.parse(oversizePrompt.slice(contextStart, contextEnd));
    assert.equal(oversizeContext.total_package_count, 200);
    assert.equal(oversizeContext.scanned_package_count, 150);
    assert.equal(oversizeContext.scan_truncated, true);
    assert.equal(oversizeContext.packages_depends_on.length, 200);
    assert.match(
      oversizePrompt,
      /Scan coverage warning: 50 of 200 packages were excluded by the 150-package cap\./,
    );
    assert.equal(
      oversizeContext.sbom_hash,
      createHash('sha3-256').update(fixtureContent, 'utf8').digest('hex'),
    );
    assert.ok(oversizePrompt.endsWith(
      'Please provide a QUICK summary of the most critical findings with OSV.dev links (NOT NVD links). Use osv.dev format for vulnerability links. Keep it brief and actionable. Suggest that I can ask for "executive summary", "detailed analysis", or "dependency analysis" for comprehensive information.',
    ));
    await assert.rejects(access(uploadPath), { code: 'ENOENT' }, 'successful upload removes its raw fixture');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('offline upload batch-matches the oversize scan window once without API pacing', async () => {
  const fixturePath = new URL('../../tests/fixtures/oversize-spdx.json', import.meta.url);
  const fixtureContent = await readFile(fixturePath, 'utf8');
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'bombot-upload-offline-batch-test-'));
  const uploadPath = path.join(tempDir, 'oversize-spdx.json');
  await copyFile(fixturePath, uploadPath);

  let matcherInvocations = 0;
  let waits = 0;
  const handler = createUploadHandler({
    osvMode: 'offline',
    async captureScanSource(mode, client, scan) {
      await scan(client); return { osv_mode: mode, snapshot_date: '2026-09-07' };
    },
    async parseForm() {
      return {
        fields: {
          sessionId: '00000000-0000-4000-8000-000000000001',
          messageIndex: '1',
        },
        files: {
          file: {
            filepath: uploadPath,
            originalFilename: 'oversize-spdx.json',
            size: Buffer.byteLength(fixtureContent),
          },
        },
      };
    },
    async queryOSVForPackage() {
      throw new Error('offline upload must not call the hosted OSV API seam');
    },
    async matchOsvPackages(_client, packages) {
      matcherInvocations += 1;
      assert.equal(packages.length, 150);
      return packages.map(package_ => ({ package: package_, vulnerabilities: [] }));
    },
    async createConversation() {
      return { id: 'conversation_offline_batch_synthetic' };
    },
    async appendConversationMessages() {
      return [];
    },
    async insertLog() {},
    async wait() {
      waits += 1;
    },
  });

  try {
    const response = responseRecorder();
    await handler({ method: 'POST' }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.jsonBody.totalPackages, 200);
    assert.equal(response.jsonBody.packagesScanned, 150);
    assert.equal(response.jsonBody.unrecognizedEcosystemCount, 0);
    assert.equal(matcherInvocations, 1);
    assert.equal(waits, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('offline upload returns real vulnerabilities from the pinned local snapshot', async context => {
  if (!process.env.DATABASE_URL) {
    context.skip('DATABASE_URL is not configured; skipping offline upload snapshot test');
    return;
  }

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
  } catch (error) {
    if (isDatabaseUnreachable(error)) {
      context.skip('DATABASE_URL is configured but Postgres is unreachable; skipping offline upload snapshot test');
      return;
    }
    throw error;
  } finally {
    await client.end().catch(() => {});
  }

  const fixturePath = new URL('../../tests/fixtures/small-spdx.json', import.meta.url);
  const fixtureContent = await readFile(fixturePath, 'utf8');
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'bombot-upload-offline-real-test-'));
  const uploadPath = path.join(tempDir, 'small-spdx.json');
  await copyFile(fixturePath, uploadPath);

  let matcherInvocations = 0;
  const handler = createUploadHandler({
    osvMode: 'offline',
    async parseForm() {
      return {
        fields: {
          sessionId: '00000000-0000-4000-8000-000000000001',
          messageIndex: '1',
        },
        files: {
          file: {
            filepath: uploadPath,
            originalFilename: 'small-spdx.json',
            size: Buffer.byteLength(fixtureContent),
          },
        },
      };
    },
    async queryOSVForPackage() {
      throw new Error('offline upload must not call the hosted OSV API seam');
    },
    async matchOsvPackages(client, packages, options) {
      matcherInvocations += 1;
      return realMatchOsvPackages(client, packages, options);
    },
    async createConversation() {
      return { id: 'conversation_offline_real' };
    },
    async appendConversationMessages() {
      return [];
    },
    async insertLog() {},
    async wait() {
      throw new Error('offline upload must not apply hosted API pacing');
    },
  });

  try {
    const response = responseRecorder();
    await handler({ method: 'POST' }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.jsonBody.totalPackages, 12);
    assert.equal(response.jsonBody.packagesScanned, 12);
    assert.equal(response.jsonBody.unrecognizedEcosystemCount, 0);
    assert.equal(matcherInvocations, 1);
    assert.ok(response.jsonBody.vulnerabilitiesFound > 0);
    const lodashNode = response.jsonBody.dependencyGraph.nodes.find(node => node.label === 'lodash');
    assert.ok(lodashNode?.hasVulnerabilities);
    assert.ok(lodashNode.vulnerabilityCount > 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('valid CycloneDX upload extracts packages and reaches the scanner', async () => {
  const fixturePath = new URL('../../tests/fixtures/small-cyclonedx.json', import.meta.url);
  const fixtureContent = await readFile(fixturePath, 'utf8');
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'bombot-upload-cyclonedx-test-'));
  const uploadPath = path.join(tempDir, 'small-cyclonedx.json');
  await copyFile(fixturePath, uploadPath);

  const queriedPackages = [];
  const handler = createUploadHandler({
    async parseForm() {
      return {
        fields: {
          sessionId: '00000000-0000-4000-8000-000000000001',
          messageIndex: '1',
        },
        files: {
          file: {
            filepath: uploadPath,
            originalFilename: 'small-cyclonedx.json',
            size: Buffer.byteLength(fixtureContent),
          },
        },
      };
    },
    async queryOSVForPackage(package_) {
      queriedPackages.push(package_);
      return [];
    },
    async createConversation() {
      return { id: 'conversation_cyclonedx_synthetic' };
    },
    async appendConversationMessages() {
      return [];
    },
    async insertLog() {},
    async wait() {},
  });

  try {
    const response = responseRecorder();
    await handler({ method: 'POST' }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.jsonBody.totalPackages, 12);
    assert.equal(response.jsonBody.packagesScanned, 12);
    assert.equal(response.jsonBody.unrecognizedEcosystemCount, 0);
    assert.equal(queriedPackages.length, 12);
    assert.ok(queriedPackages.every(package_ => package_.ecosystem === 'npm'));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('closed Hex and Pub purl mapping gap scans all mixed CycloneDX ecosystems', async () => {
  const fixturePath = new URL('../../tests/fixtures/mixed-ecosystems-cyclonedx.json', import.meta.url);
  const fixtureContent = await readFile(fixturePath, 'utf8');
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'bombot-upload-ecosystem-test-'));
  const uploadPath = path.join(tempDir, 'mixed-ecosystems-cyclonedx.json');
  await copyFile(fixturePath, uploadPath);

  let capturedAppend;
  const queriedPackages = [];
  const handler = createUploadHandler({
    async parseForm() {
      return {
        fields: {
          sessionId: '00000000-0000-4000-8000-000000000001',
          messageIndex: '1',
        },
        files: {
          file: {
            filepath: uploadPath,
            originalFilename: 'mixed-ecosystems-cyclonedx.json',
            size: Buffer.byteLength(fixtureContent),
          },
        },
      };
    },
    async queryOSVForPackage(package_) {
      queriedPackages.push(package_);
      return [];
    },
    async createConversation() {
      return { id: 'conversation_ecosystem_synthetic' };
    },
    async appendConversationMessages(options) {
      capturedAppend = options;
      return [];
    },
    async insertLog() {},
    async wait() {},
  });

  try {
    const response = responseRecorder();
    await handler({ method: 'POST' }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.jsonBody.totalPackages, 3);
    assert.equal(response.jsonBody.packagesScanned, 3);
    assert.equal(response.jsonBody.unrecognizedEcosystemCount, 0);
    assert.deepEqual(
      queriedPackages.map(package_ => ({ name: package_.name, ecosystem: package_.ecosystem })),
      [
        { name: 'requests', ecosystem: 'PyPI' },
        { name: 'jason', ecosystem: 'Hex' },
        { name: 'http', ecosystem: 'Pub' },
      ],
    );
    assert.doesNotMatch(
      capturedAppend.messages[0].content,
      /Ecosystem coverage warning:/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('over-150 upload keeps cap truncation and unrecognized ecosystem counts disjoint', async () => {
  const fixturePath = new URL('../../tests/fixtures/over-150-mixed-ecosystems.json', import.meta.url);
  const fixtureContent = await readFile(fixturePath, 'utf8');
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'bombot-upload-over-cap-test-'));
  const uploadPath = path.join(tempDir, 'over-150-mixed-ecosystems.json');
  await copyFile(fixturePath, uploadPath);

  let capturedAppend;
  let osvQueries = 0;
  const handler = createUploadHandler({
    async parseForm() {
      return {
        fields: {
          sessionId: '00000000-0000-4000-8000-000000000001',
          messageIndex: '1',
        },
        files: {
          file: {
            filepath: uploadPath,
            originalFilename: 'over-150-mixed-ecosystems.json',
            size: Buffer.byteLength(fixtureContent),
          },
        },
      };
    },
    async queryOSVForPackage() {
      osvQueries += 1;
      return [];
    },
    async createConversation() {
      return { id: 'conversation_over_cap_synthetic' };
    },
    async appendConversationMessages(options) {
      capturedAppend = options;
      return [];
    },
    async insertLog() {},
    async wait() {},
  });

  try {
    const response = responseRecorder();
    await handler({ method: 'POST' }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.jsonBody.totalPackages, 152);
    assert.equal(response.jsonBody.packagesScanned, 149);
    assert.equal(response.jsonBody.unrecognizedEcosystemCount, 1);
    assert.equal(osvQueries, 149);
    assert.match(
      capturedAppend.messages[0].content,
      /Scan coverage warning: 2 of 152 packages were excluded by the 150-package cap\./,
    );
    assert.match(
      capturedAppend.messages[0].content,
      /Ecosystem coverage warning: 1 package not scanned: unsupported ecosystem\./,
    );

    const contextHeading = '**Minimized Software Context:**\n';
    const contextStart = capturedAppend.messages[0].content.indexOf(contextHeading)
      + contextHeading.length;
    const contextEnd = capturedAppend.messages[0].content.indexOf(
      '\n\nPlease provide a QUICK summary',
      contextStart,
    );
    const softwareContext = JSON.parse(
      capturedAppend.messages[0].content.slice(contextStart, contextEnd),
    );
    assert.equal(softwareContext.total_package_count, 152);
    assert.equal(softwareContext.scanned_package_count, 149);
    assert.equal(softwareContext.scan_truncated, true);
    assert.equal(softwareContext.packages_depends_on.length, 152);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('mixed SPDX purls derive ecosystems end to end and keep unknown packages from the scanner', async () => {
  const fixturePath = new URL('../../tests/fixtures/mixed-ecosystems-spdx.json', import.meta.url);
  const fixtureContent = await readFile(fixturePath, 'utf8');
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'bombot-upload-spdx-ecosystem-test-'));
  const uploadPath = path.join(tempDir, 'mixed-ecosystems-spdx.json');
  await copyFile(fixturePath, uploadPath);

  let capturedAppend;
  const queriedPackages = [];
  const handler = createUploadHandler({
    async parseForm() {
      return {
        fields: {
          sessionId: '00000000-0000-4000-8000-000000000001',
          messageIndex: '1',
        },
        files: {
          file: {
            filepath: uploadPath,
            originalFilename: 'mixed-ecosystems-spdx.json',
            size: Buffer.byteLength(fixtureContent),
          },
        },
      };
    },
    async queryOSVForPackage(package_) {
      queriedPackages.push(package_);
      return [];
    },
    async createConversation() {
      return { id: 'conversation_spdx_ecosystem_synthetic' };
    },
    async appendConversationMessages(options) {
      capturedAppend = options;
      return [];
    },
    async insertLog() {},
    async wait() {},
  });

  try {
    const response = responseRecorder();
    await handler({ method: 'POST' }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.jsonBody.totalPackages, 5);
    assert.equal(response.jsonBody.packagesScanned, 3);
    assert.equal(response.jsonBody.unrecognizedEcosystemCount, 2);
    assert.deepEqual(
      queriedPackages.map(package_ => ({ name: package_.name, ecosystem: package_.ecosystem })),
      [
        { name: 'requests', ecosystem: 'PyPI' },
        { name: 'lodash', ecosystem: 'npm' },
        { name: 'log4j-core', ecosystem: 'Maven' },
      ],
    );
    assert.match(
      capturedAppend.messages[0].content,
      /Ecosystem coverage warning: 1 package not scanned: unsupported purl type; 1 package not scanned: ecosystem could not be derived\./,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('offline upload timing reports counts and a 400 path without logging canaries (no Postgres)', async () => {
  const canaries = [
    'CANARY-participant-text',
    'lodash@4.17.20',
    'pkg:npm/left-pad@1.3.0',
    'CVE-2021-44228',
    '{"package":"x"}',
    'session-7f3c',
  ];
  const fixture = JSON.stringify({
    bomFormat: 'CycloneDX',
    metadata: { component: { name: canaries[0] } },
    components: [{
      name: canaries[1],
      version: '4.17.20',
      purl: canaries[2],
      'bom-ref': canaries[3],
    }, {
      name: canaries[4],
      version: '1.0.0',
      purl: 'pkg:npm/canary-package@1.0.0',
      'bom-ref': canaries[5],
    }],
    dependencies: [],
  });
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'bombot-upload-timing-test-'));
  const fileName = `${canaries[0]}-${canaries[5]}.json`;
  const uploadPath = path.join(tempDir, fileName);
  await writeFile(uploadPath, fixture);

  const entries = [];
  const originals = {};
  for (const level of ['log', 'warn', 'error']) {
    originals[level] = console[level];
    console[level] = (...values) => entries.push(values.map(String).join(' '));
  }
  let tick = 0;
  try {
    const successHandler = createUploadHandler({
      osvMode: 'offline',
      async captureScanSource(mode, client, scan) {
        await scan(client);
        return { osv_mode: mode, snapshot_date: '2026-09-07' };
      },
      async parseForm() {
        return {
          fields: { sessionId: canaries[5], messageIndex: '1' },
          files: {
            file: {
              filepath: uploadPath,
              originalFilename: fileName,
              size: Buffer.byteLength(fixture),
            },
          },
        };
      },
      async matchOsvPackages(_client, packages) {
        return packages.map(package_ => ({ package: package_, vulnerabilities: [] }));
      },
      async createConversation() {
        return { id: canaries[5] };
      },
      async appendConversationMessages() {},
      async insertLog() {},
      async wait() {},
      now: () => tick++,
    });
    const successResponse = responseRecorder();
    await successHandler({ method: 'POST' }, successResponse);
    assert.equal(successResponse.statusCode, 200);

    const clientErrorHandler = createUploadHandler({
      osvMode: 'offline',
      async parseForm() {
        return { fields: {}, files: {} };
      },
      now: () => tick++,
    });
    const clientErrorResponse = responseRecorder();
    await clientErrorHandler({ method: 'POST' }, clientErrorResponse);
    assert.equal(clientErrorResponse.statusCode, 400);
  } finally {
    for (const level of ['log', 'warn', 'error']) console[level] = originals[level];
    await rm(tempDir, { recursive: true, force: true });
  }

  const timingLines = entries
    .filter(line => line.includes('"event":"timing_v1"'))
    .map(line => JSON.parse(line));
  assert.equal(timingLines.length, 2);
  assert.equal(timingLines[0].kind, 'upload');
  assert.equal(timingLines[0].outcome, 'ok');
  assert.equal(timingLines[0].osv_mode, 'offline');
  assert.equal(timingLines[0].packages_scanned, 2);
  assert.equal(timingLines[0].packages_total, 2);
  assert.equal(timingLines[1].outcome, 'client_error');
  for (const canary of canaries) {
    assert.equal(entries.some(line => line.includes(canary)), false);
  }
});

test('generic JSON packages without an ecosystem remain unknown', () => {
  const parsed = parseSBOMData(JSON.stringify({
    packages: [{ name: 'generic-without-ecosystem', version: '1.0.0' }],
  }), 'generic.json');

  assert.equal(parsed.packages[0].ecosystem, 'unknown');
});

test('SPDX DEPENDENCY_OF and swapped DEPENDS_ON stay directionally identical downstream', async () => {
  const fixtureContent = await readFile(
    new URL('../../tests/fixtures/dependency-of-spdx.json', import.meta.url),
    'utf8',
  );
  const dependencyOfDocument = JSON.parse(fixtureContent);
  const dependsOnDocument = structuredClone(dependencyOfDocument);
  const dependencyRelationship = dependsOnDocument.relationships.find(
    relationship => relationship.relationshipType === 'DEPENDENCY_OF',
  );
  [dependencyRelationship.spdxElementId, dependencyRelationship.relatedSpdxElement] = [
    dependencyRelationship.relatedSpdxElement,
    dependencyRelationship.spdxElementId,
  ];
  dependencyRelationship.relationshipType = 'DEPENDS_ON';

  const dependencyOfParsed = parseSBOMData(JSON.stringify(dependencyOfDocument), 'dependency-of.spdx.json');
  const dependsOnParsed = parseSBOMData(JSON.stringify(dependsOnDocument), 'depends-on.spdx.json');
  assert.deepEqual(dependencyOfParsed.dependencies, dependsOnParsed.dependencies);
  assert.deepEqual(dependencyOfParsed.dependencies, [{
    parent: 'SPDXRef-Package-application',
    child: 'SPDXRef-Package-library',
    relationship: 'DEPENDS_ON',
  }]);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'bombot-upload-dependency-direction-test-'));
  async function uploadDocument(document, suffix) {
    const content = JSON.stringify(document);
    const uploadPath = path.join(tempDir, `${suffix}.spdx.json`);
    await writeFile(uploadPath, content);
    let capturedAppend;
    const handler = createUploadHandler({
      async parseForm() {
        return {
          fields: {
            sessionId: '00000000-0000-4000-8000-000000000001',
            messageIndex: '1',
          },
          files: {
            file: {
              filepath: uploadPath,
              originalFilename: `${suffix}.spdx.json`,
              size: Buffer.byteLength(content),
            },
          },
        };
      },
      async queryOSVForPackage() {
        return [];
      },
      async createConversation() {
        return { id: `conversation_${suffix}` };
      },
      async appendConversationMessages(options) {
        capturedAppend = options;
        return [];
      },
      async insertLog() {},
      async wait() {},
    });
    const response = responseRecorder();
    await handler({ method: 'POST' }, response);
    assert.equal(response.statusCode, 200);

    const prompt = capturedAppend.messages[0].content;
    const contextHeading = '**Minimized Software Context:**\n';
    const contextStart = prompt.indexOf(contextHeading) + contextHeading.length;
    const contextEnd = prompt.indexOf('\n\nPlease provide a QUICK summary', contextStart);
    return {
      dependencyGraphEdges: response.jsonBody.dependencyGraph.edges,
      dependencyRelationships: response.jsonBody.dependencyRelationships,
      dependenciesFound: response.jsonBody.quickSummary.dependenciesFound,
      contextDependencies: JSON.parse(prompt.slice(contextStart, contextEnd)).packages_depends_on
        .map(package_ => ({
          packageName: package_.package_name,
          dependencies: package_.dependencies,
        })),
      prompt,
    };
  }

  try {
    const dependencyOfResult = await uploadDocument(dependencyOfDocument, 'dependency_of');
    const dependsOnResult = await uploadDocument(dependsOnDocument, 'depends_on');
    assert.deepEqual(dependencyOfResult.dependencyGraphEdges, dependsOnResult.dependencyGraphEdges);
    assert.deepEqual(dependencyOfResult.dependencyGraphEdges, [{
      from: 'SPDXRef-Package-application',
      to: 'SPDXRef-Package-library',
      label: 'DEPENDS ON',
      relationship: 'DEPENDS_ON',
    }]);
    assert.deepEqual(dependencyOfResult.contextDependencies, dependsOnResult.contextDependencies);
    assert.deepEqual(dependencyOfResult.contextDependencies, [
      {
        packageName: 'example-application',
        dependencies: [{
          package_name: 'example-library',
          package_version: '2.0.0',
          relationship: 'DEPENDS_ON',
        }],
      },
      { packageName: 'example-library', dependencies: [] },
    ]);
    for (const result of [dependencyOfResult, dependsOnResult]) {
      assert.equal(result.dependencyRelationships, 1);
      assert.equal(result.dependenciesFound, 1);
      assert.match(result.prompt, /Dependency relationships found: 1/);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('shared purl mapping covers configured OSV ecosystems and rejects non-OSV purl types', () => {
  const mappedTypes = [
    ['npm', 'npm'],
    ['pypi', 'PyPI'],
    ['maven', 'Maven'],
    ['golang', 'Go'],
    ['composer', 'Packagist'],
    ['gem', 'RubyGems'],
    ['nuget', 'NuGet'],
    ['cargo', 'crates.io'],
    ['hex', 'Hex'],
    ['pub', 'Pub'],
  ];
  const unmappedTypes = ['github', 'generic', 'deb', 'apk', 'docker'];
  const parsed = parseSBOMData(JSON.stringify({
    bomFormat: 'CycloneDX',
    components: [
      ...mappedTypes.map(([type, ecosystem]) => ({
        name: `mapped-${ecosystem}`,
        version: '1.0.0',
        purl: `pkg:${type}/example@1.0.0`,
      })),
      ...unmappedTypes.map(type => ({
        name: `unmapped-${type}`,
        version: '1.0.0',
        purl: `pkg:${type}/example@1.0.0`,
      })),
    ],
  }), 'purl-map.cdx.json');

  assert.deepEqual(
    parsed.packages.map(package_ => package_.ecosystem),
    [...mappedTypes.map(([, ecosystem]) => ecosystem), ...unmappedTypes.map(() => 'unknown')],
  );
});

test('upload fails when offline mode has no vulnerability matcher', async () => {
  const fixturePath = new URL('../../tests/fixtures/small-spdx.json', import.meta.url);
  const fixtureContent = await readFile(fixturePath, 'utf8');
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'bombot-upload-offline-test-'));
  let uploadPath = path.join(tempDir, 'small-spdx.json');
  await copyFile(fixturePath, uploadPath);

  let appended = false;
  const handler = createUploadHandler({
    osvMode: 'offline',
    async captureScanSource(mode, client, scan) {
      await scan(client); return { osv_mode: mode, snapshot_date: '2026-09-07' };
    },
    async parseForm(_request, handlerDirectory) {
      uploadPath = path.join(handlerDirectory, 'small-spdx.json');
      await copyFile(fixturePath, uploadPath);
      return {
        fields: {
          sessionId: '00000000-0000-4000-8000-000000000001',
          messageIndex: '1',
        },
        files: {
          file: {
            filepath: uploadPath,
            originalFilename: 'small-spdx.json',
            size: Buffer.byteLength(fixtureContent),
          },
        },
      };
    },
    async matchOsvPackages() {
      throw new OSVSourceUnavailableError();
    },
    async createConversation() {
      throw new Error('conversation must not be created after OSV source failure');
    },
    async appendConversationMessages() {
      appended = true;
      return [];
    },
    async insertLog() {},
    async wait() {},
  });

  try {
    const response = responseRecorder();
    await handler({ method: 'POST' }, response);

    assert.equal(response.statusCode, 500);
    assert.equal(response.jsonBody.error, 'Internal server error');
    assert.match(response.jsonBody.details, /OSV vulnerability source is unavailable/);
    assert.equal(appended, false);
    await assert.rejects(access(uploadPath), { code: 'ENOENT' }, 'failed scan removes its raw fixture too');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
