
import { useEffect, useState } from 'react';
import { useChat } from '@/contexts/ChatContext';
import { getProgressStatus } from '@/hooks/progressStatus';

const StatusIndicator = () => {
  const { loadingPhase, responseStartedAt, lastActivityAt } = useChat();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const interval = globalThis.setInterval(() => setNow(Date.now()), 1_000);
    return () => globalThis.clearInterval(interval);
  }, []);

  const status = getProgressStatus({
    phase: loadingPhase ?? 'response',
    elapsedMs: responseStartedAt === null ? 0 : now - responseStartedAt,
    msSinceActivity: lastActivityAt === null ? 0 : now - lastActivityAt,
  });

  return (
    <div className="flex items-start space-x-3 text-gray-600 py-2">
      <div className="animate-pulse flex space-x-1 pt-1.5" aria-hidden="true">
        <div className="w-2 h-2 bg-blue-400 rounded-full animate-bounce"></div>
        <div className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
        <div className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
      </div>
      <div className="text-sm">
        <div role="status" aria-live="polite">
          <div className="font-medium">{status.primary}</div>
          {status.notices.map((notice) => (
            <div key={notice}>{notice}</div>
          ))}
        </div>
        {status.elapsed !== null ? <div>{status.elapsed}</div> : null}
      </div>
    </div>
  );
};

export default StatusIndicator;
