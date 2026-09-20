import type { NextApiRequest, NextApiResponse } from 'next';
import { config } from '../../lib/config.ts';
import {
  DEMO_ACCESS_COOKIE,
  demoCookieValue,
  timingSafeSecretMatch,
} from '../../lib/security/hostedGuards.ts';

export function createDemoAccessHandler(demoToken = config.DEMO_ACCESS_TOKEN) {
  return function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ code: 'method_not_allowed', error: 'Method not allowed.' });
  }
  const candidate = Array.isArray(req.query.token) ? req.query.token[0] : req.query.token;
  if (!demoToken || typeof candidate !== 'string'
    || !timingSafeSecretMatch(candidate, demoToken)) {
    return res.status(403).json({ code: 'demo_access_required', error: 'Hosted model access is not available for this request.' });
  }

  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${DEMO_ACCESS_COOKIE}=${encodeURIComponent(demoCookieValue(demoToken))}; Path=/; HttpOnly; SameSite=Strict${secure}`,
  );
  return res.redirect(303, '/');
  };
}

export default createDemoAccessHandler();
