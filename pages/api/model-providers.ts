import type { NextApiRequest, NextApiResponse } from 'next';
import { config } from '../../lib/config.ts';
import {
  isProviderAvailable,
  providerLabel,
  PROVIDER_IDS,
} from '../../lib/llm/providerRegistry.ts';
import {
  getConversationProviderId,
  getConversationSessionId,
} from '../../lib/db/conversations.ts';
import { hostedGuardVisibility } from '../../lib/security/hostedGuards.ts';

interface Dependencies {
  getConversationProviderId: typeof getConversationProviderId;
  getConversationSessionId: typeof getConversationSessionId;
}

export function createModelProvidersHandler(overrides: Partial<Dependencies> = {}) {
  const dependencies: Dependencies = {
    getConversationProviderId,
    getConversationSessionId,
    ...overrides,
  };
  return async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const sessionId = Array.isArray(req.query?.sessionId) ? req.query.sessionId[0] : req.query?.sessionId;
  const conversationId = Array.isArray(req.query?.conversationId)
    ? req.query.conversationId[0] : req.query?.conversationId;
  let activeProviderId = 'primary';
  if (sessionId && conversationId
    && await dependencies.getConversationSessionId(conversationId) === sessionId) {
    activeProviderId = await dependencies.getConversationProviderId(conversationId) ?? 'primary';
  }
  const visibility = hostedGuardVisibility(sessionId);

  return res.status(200).json({
    toggleEnabled: config.ENABLE_MODEL_TOGGLE,
    providers: PROVIDER_IDS.map(id => ({
      id,
      label: isProviderAvailable(id) ? providerLabel(id) : id === 'primary' ? 'Primary' : 'Alternate',
      available: isProviderAvailable(id),
    })),
    ...visibility,
    activeProviderLabel: providerLabel(activeProviderId),
  });
  };
}

export default createModelProvidersHandler();
