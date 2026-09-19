export const LONG_RESPONSE_NOTICE_MS = 60_000;
export const STALL_NOTICE_MS = 30_000;
export const ACTIVITY_COMMIT_INTERVAL_MS = 1_000;

export type LoadingPhase = 'upload' | 'response';

interface ProgressStatusOptions {
  phase: LoadingPhase;
  elapsedMs: number;
  msSinceActivity: number;
}

interface ProgressStatus {
  primary: string;
  elapsed: string | null;
  notices: string[];
}

interface LoadingTimestamps {
  responseStartedAt: number | null;
  lastActivityAt: number | null;
}

export function shouldCommitActivity(
  lastCommittedAt: number | null,
  now: number,
): boolean {
  return lastCommittedAt === null
    || now - lastCommittedAt >= ACTIVITY_COMMIT_INTERVAL_MS;
}

export function loadingTimestamps(
  phase: LoadingPhase,
  now: number,
): LoadingTimestamps {
  if (phase === 'upload') {
    return { responseStartedAt: null, lastActivityAt: null };
  }
  return { responseStartedAt: now, lastActivityAt: now };
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

export function getProgressStatus({
  phase,
  elapsedMs,
  msSinceActivity,
}: ProgressStatusOptions): ProgressStatus {
  if (phase === 'upload') {
    return {
      primary: 'Uploading and scanning your SBOM…',
      elapsed: null,
      notices: [],
    };
  }

  const notices: string[] = [];
  if (elapsedMs >= LONG_RESPONSE_NOTICE_MS) {
    notices.push('This response is taking longer than usual. Please keep this page open.');
  }
  if (msSinceActivity >= STALL_NOTICE_MS) {
    notices.push('Still waiting for the server…');
  }

  return {
    primary: 'Preparing response…',
    elapsed: formatElapsed(elapsedMs),
    notices,
  };
}
