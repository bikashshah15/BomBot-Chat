import 'dotenv/config';

import pg from 'pg';

import { config } from '../lib/config.ts';
import { MissingOSVSnapshotDateError } from '../lib/osv/errors.ts';
import { syncOsvSnapshot } from '../lib/osv/sync.ts';

if (!config.OSV_SNAPSHOT_DATE) {
  throw new MissingOSVSnapshotDateError();
}

const client = new pg.Client({ connectionString: config.DATABASE_URL });

try {
  await client.connect();
  const summary = await syncOsvSnapshot(client, {
    mirrorBaseUrl: config.OSV_MIRROR_BASE_URL,
    snapshotDate: config.OSV_SNAPSHOT_DATE,
    scannerCacheDirectory: config.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY,
    onProgress: message => console.log(message),
  });
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await client.end().catch(() => {});
}
