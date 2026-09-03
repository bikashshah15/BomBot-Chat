import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import 'dotenv/config';
import pg from 'pg';

const { createUploadHandler } = await import('./upload.ts');
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

test('mixed CycloneDX ecosystems are correctly scanned or counted as unrecognized', async () => {
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
    assert.equal(response.jsonBody.totalPackages, 2);
    assert.equal(response.jsonBody.packagesScanned, 1);
    assert.equal(response.jsonBody.unrecognizedEcosystemCount, 1);
    assert.deepEqual(
      queriedPackages.map(package_ => ({ name: package_.name, ecosystem: package_.ecosystem })),
      [{ name: 'requests', ecosystem: 'PyPI' }],
    );
    // Hex and Pub are valid OSV ecosystems but are absent from the route's map. This pins
    // current behavior, not correct behavior, and must change when those mappings are fixed.
    assert.match(
      capturedAppend.messages[0].content,
      /Ecosystem coverage warning: 1 package admitted by the 150-package cap could not be scanned because the ecosystem was unrecognized\./,
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
      /Ecosystem coverage warning: 1 package admitted by the 150-package cap could not be scanned because the ecosystem was unrecognized\./,
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
    assert.equal(softwareContext.scanned_package_count, 150);
    assert.equal(softwareContext.scan_truncated, true);
    assert.equal(softwareContext.packages_depends_on.length, 152);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('upload fails when offline mode has no vulnerability matcher', async () => {
  const fixturePath = new URL('../../tests/fixtures/small-spdx.json', import.meta.url);
  const fixtureContent = await readFile(fixturePath, 'utf8');
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'bombot-upload-offline-test-'));
  const uploadPath = path.join(tempDir, 'small-spdx.json');
  await copyFile(fixturePath, uploadPath);

  let appended = false;
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
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
