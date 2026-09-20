import type { NextApiRequest, NextApiResponse } from 'next';
import { config as appConfig } from '../../lib/config.ts';
import {
  ConversationCopySessionMismatchError,
  createConversation,
} from '../../lib/db/conversations.ts';
import {
  isProviderId,
  resolveProviderSettings,
} from '../../lib/llm/providerRegistry.ts';

interface Dependencies {
  createConversation: typeof createConversation;
  enableModelToggle: boolean;
  isProviderId: typeof isProviderId;
  resolveProviderSettings: typeof resolveProviderSettings;
}

export function createConversationsHandler(overrides: Partial<Dependencies> = {}) {
  const dependencies: Dependencies = {
    createConversation,
    enableModelToggle: appConfig.ENABLE_MODEL_TOGGLE,
    isProviderId,
    resolveProviderSettings,
    ...overrides,
  };

  return async function handler(req: NextApiRequest, res: NextApiResponse) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    const { sessionId, providerId, copyFromConversationId } = req.body ?? {};
    if (typeof sessionId !== 'string' || !sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    if (!dependencies.isProviderId(providerId)) {
      return res.status(400).json({ error: 'Unknown model provider' });
    }
    if (copyFromConversationId !== undefined
      && (typeof copyFromConversationId !== 'string' || !copyFromConversationId)) {
      return res.status(400).json({ error: 'Invalid source conversation' });
    }
    if (!dependencies.enableModelToggle && providerId !== 'primary') {
      return res.status(403).json({ error: 'Model provider selection is disabled' });
    }
    try {
      dependencies.resolveProviderSettings(providerId);
      const conversation = await dependencies.createConversation(
        sessionId,
        providerId,
        copyFromConversationId,
      );
      return res.status(201).json({ conversationId: conversation.id });
    } catch (error) {
      if (error instanceof ConversationCopySessionMismatchError) {
        return res.status(403).json({ error: 'Source conversation does not belong to this session' });
      }
      if (error instanceof Error && error.message === 'Alternate model provider is unavailable') {
        return res.status(409).json({ error: 'Selected model provider is unavailable' });
      }
      throw error;
    }
  };
}

export default createConversationsHandler();

export const config = { api: { bodyParser: { sizeLimit: '4kb' } } };
