import { AsyncLocalStorage } from 'node:async_hooks';
import type { CapturedScanSource } from '../context/scanProvenance.ts';
import { getCurrentOsvSnapshot } from '../osv/match.ts';
import type { OsvQueryClient } from '../osv/db.ts';
import { dbPool } from './client.ts';
const writeContext = new AsyncLocalStorage<CapturedScanSource>();
export function currentScanSource(): CapturedScanSource | undefined { return writeContext.getStore(); }
export function withCapturedScanSource(source: CapturedScanSource, append: () => Promise<void>): Promise<void> {
  return writeContext.run(source, append);
}
/** Production offline scans bind source and matcher reads to one database view.
 * API scans have no local-snapshot date: record not_applicable explicitly.
 */
export async function captureScanSource(mode: 'api' | 'offline', client: OsvQueryClient,
  scan: (client: OsvQueryClient) => Promise<void>,
): Promise<Pick<CapturedScanSource, 'osv_mode' | 'snapshot_date'>> {
  if (mode === 'api') { await scan(client); return { osv_mode: 'api', snapshot_date: 'not_applicable' }; }
  const connection = client === dbPool ? await dbPool.connect() : null;
  const pinnedClient = connection ?? client;
  try {
    if (connection) await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = await getCurrentOsvSnapshot(pinnedClient);
    await scan(pinnedClient);
    if (connection) await connection.query('COMMIT');
    return { osv_mode: 'offline', snapshot_date: snapshot.snapshotDate };
  } catch (error) {
    if (connection) await connection.query('ROLLBACK');
    throw error;
  } finally { connection?.release(); }
}
