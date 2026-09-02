export interface OsvVulnerabilityRow {
  id: string;
  ecosystem: string;
  packageName: string;
  ranges: unknown;
  severity: unknown | null;
  summary: string | null;
  modified: string;
}

export interface OsvQueryClient {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

const INSERT_BATCH_SIZE = 500;

export async function clearOsvSnapshot(client: OsvQueryClient) {
  await client.query('DELETE FROM osv_vulns');
  await client.query('DELETE FROM osv_snapshots');
}

export async function insertOsvVulnerabilityRows(
  client: OsvQueryClient,
  rows: OsvVulnerabilityRow[],
) {
  for (let offset = 0; offset < rows.length; offset += INSERT_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + INSERT_BATCH_SIZE);
    const values: unknown[] = [];
    const placeholders = batch.map((row, index) => {
      const position = index * 7;
      values.push(
        row.id,
        row.ecosystem,
        row.packageName,
        JSON.stringify(row.ranges),
        row.severity === null ? null : JSON.stringify(row.severity),
        row.summary,
        row.modified,
      );
      return `($${position + 1}, $${position + 2}, $${position + 3}, $${position + 4}::jsonb, $${position + 5}::jsonb, $${position + 6}, $${position + 7}::timestamptz)`;
    });

    await client.query(
      `INSERT INTO osv_vulns (id, ecosystem, package, ranges, severity, summary, modified)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (id, ecosystem, package) DO UPDATE SET
         ranges = EXCLUDED.ranges,
         severity = EXCLUDED.severity,
         summary = EXCLUDED.summary,
         modified = EXCLUDED.modified`,
      values,
    );
  }
}

export async function insertOsvSnapshot(
  client: OsvQueryClient,
  snapshotDate: string,
  sourceUrl: string,
  ecosystemRecordCounts: Record<string, number>,
  ecosystemDroppedCounts: Record<string, number>,
  ecosystemDroppedReasonCounts: Record<string, unknown>,
  ecosystemDroppedSamples: Record<string, unknown[]>,
  maxModified: string,
) {
  const result = await client.query(
    `INSERT INTO osv_snapshots (
       snapshot_date,
       source_url,
       ecosystem_record_counts,
       ecosystem_dropped_counts,
       ecosystem_dropped_reason_counts,
       ecosystem_dropped_samples,
       max_modified
     ) VALUES ($1::date, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7::timestamptz)
     RETURNING ingested_at`,
    [
      snapshotDate,
      sourceUrl,
      JSON.stringify(ecosystemRecordCounts),
      JSON.stringify(ecosystemDroppedCounts),
      JSON.stringify(ecosystemDroppedReasonCounts),
      JSON.stringify(ecosystemDroppedSamples),
      maxModified,
    ],
  ) as { rows: Array<{ ingested_at: Date | string }> };

  return new Date(result.rows[0].ingested_at).toISOString();
}
