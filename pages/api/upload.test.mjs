import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import 'dotenv/config';

const { createUploadHandler } = await import('./upload.ts');
const { OSVSourceUnavailableError } = await import('../../lib/osv/errors.ts');

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
      /Scan coverage warning: only 150 of 200 packages were scanned; 50 packages were not scanned\./,
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

test('upload fails when offline mode has no vulnerability matcher', async () => {
  const fixturePath = new URL('../../tests/fixtures/small-spdx.json', import.meta.url);
  const fixtureContent = await readFile(fixturePath, 'utf8');
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'bombot-upload-offline-test-'));
  const uploadPath = path.join(tempDir, 'small-spdx.json');
  await copyFile(fixturePath, uploadPath);

  let appended = false;
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
            originalFilename: 'small-spdx.json',
            size: Buffer.byteLength(fixtureContent),
          },
        },
      };
    },
    async queryOSVForPackage() {
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
