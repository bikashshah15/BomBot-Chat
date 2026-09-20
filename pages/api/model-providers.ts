import type { NextApiRequest, NextApiResponse } from 'next';
import { config } from '../../lib/config.ts';
import {
  isProviderAvailable,
  providerLabel,
  PROVIDER_IDS,
} from '../../lib/llm/providerRegistry.ts';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  return res.status(200).json({
    toggleEnabled: config.ENABLE_MODEL_TOGGLE,
    providers: PROVIDER_IDS.map(id => ({
      id,
      label: isProviderAvailable(id) ? providerLabel(id) : id === 'primary' ? 'Primary' : 'Alternate',
      available: isProviderAvailable(id),
    })),
  });
}
