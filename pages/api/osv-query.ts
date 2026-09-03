import type { NextApiRequest, NextApiResponse } from 'next';
import { config as environmentConfig } from '../../lib/config.ts';
import { dbPool } from '../../lib/db/client.ts';
import {
  ConversationSequenceConflictError,
  getConversationSessionId,
} from '../../lib/db/conversations.ts';
import { appendConversationMessages } from '../../lib/llm/conversationHistory.ts';
import { cveQuerySchema } from '../../lib/openai-responses.ts';
import { getOsvAdvisoryByIdentifier, type OsvQueryClient } from '../../lib/osv/db.ts';
import { OSV_ECOSYSTEMS, type OsvEcosystem } from '../../lib/osv/ecosystems.ts';
import { OSVSourceUnavailableError } from '../../lib/osv/errors.ts';
import { getCurrentOsvSnapshot, matchOsvPackages } from '../../lib/osv/match.ts';

interface OSVQueryRequest {
  version?: string;
  name?: string;
  ecosystem?: string;
  cve?: string;
  conversationId?: string;
  threadId?: string;
  sessionId: string;
  userEmail?: string;
}

interface OSVVulnerability {
  id: string;
  summary: string;
  details: string;
  aliases?: string[];
  modified: string;
  published: string;
  severity?: Array<{
    type: string;
    score: string;
  }>;
  affected: Array<{
    package: {
      name: string;
      ecosystem: string;
    };
    ranges: Array<{
      type: string;
      events: Array<{
        introduced?: string;
        fixed?: string;
        last_affected?: string;
      }>;
    }>;
    versions?: string[];
  }>;
  references: Array<{
    type: string;
    url: string;
  }>;
  database_specific?: any;
}

interface OSVQueryResponse {
  vulns: OSVVulnerability[];
}

interface IdentifierResolution {
  requestedIdentifier: string;
  resolvedAdvisoryId: string;
  resolvedViaAlias: boolean;
}

interface OsvQueryHandlerDependencies {
  fetch: typeof fetch;
  getConversationSessionId: typeof getConversationSessionId;
  appendConversationMessages: typeof appendConversationMessages;
  getCurrentOsvSnapshot: typeof getCurrentOsvSnapshot;
  getOsvAdvisoryByIdentifier: typeof getOsvAdvisoryByIdentifier;
  matchOsvPackages: typeof matchOsvPackages;
  osvClient: OsvQueryClient;
  osvMode: typeof environmentConfig.OSV_MODE;
  osvBaseUrl: typeof environmentConfig.OSV_BASE_URL;
}

const defaultHandlerDependencies: OsvQueryHandlerDependencies = {
  fetch,
  getConversationSessionId,
  appendConversationMessages,
  getCurrentOsvSnapshot,
  getOsvAdvisoryByIdentifier,
  matchOsvPackages,
  osvClient: dbPool,
  osvMode: environmentConfig.OSV_MODE,
  osvBaseUrl: environmentConfig.OSV_BASE_URL,
};

function isOsvEcosystem(ecosystem: string): ecosystem is OsvEcosystem {
  return (OSV_ECOSYSTEMS as readonly string[]).includes(ecosystem);
}

export function createOsvQueryHandler(
  overrides: Partial<OsvQueryHandlerDependencies> = {},
) {
  const dependencies = { ...defaultHandlerDependencies, ...overrides };
  return (req: NextApiRequest, res: NextApiResponse) => handleOsvQuery(req, res, dependencies);
}

async function handleOsvQuery(
  req: NextApiRequest,
  res: NextApiResponse,
  dependencies: OsvQueryHandlerDependencies,
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { version, name, ecosystem, cve, conversationId: requestedConversationId, threadId, sessionId }: OSVQueryRequest = req.body;
  const conversationId = requestedConversationId || threadId;

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  if (!cve && (!name || !ecosystem)) {
    return res.status(400).json({ 
      error: 'Either CVE ID or both package name and ecosystem are required' 
    });
  }

  let cveId: string | undefined;
  if (cve) {
    const parsedCve = cveQuerySchema.safeParse({ cve_id: cve });
    if (!parsedCve.success) {
      return res.status(400).json({
        error: 'Invalid CVE ID',
        details: parsedCve.error.issues.map(issue => issue.message).join(', '),
      });
    }
    cveId = parsedCve.data.cve_id;
  }

  try {
    if (conversationId) {
      // This session UUID is a bearer capability, not authentication. It limits practical
      // conversation enumeration but does not protect a capability obtained by another party.
      if (await dependencies.getConversationSessionId(conversationId) !== sessionId) {
        return res.status(403).json({ error: 'Conversation does not belong to this session' });
      }
    }

    let data: OSVVulnerability | OSVQueryResponse;
    let identifierResolution: IdentifierResolution | undefined;
    if (dependencies.osvMode === 'offline') {
      if (cveId) {
        // Confirm the pinned source is readable before interpreting a null lookup as not found.
        await dependencies.getCurrentOsvSnapshot(dependencies.osvClient);
        const advisory = await dependencies.getOsvAdvisoryByIdentifier(
          dependencies.osvClient,
          cveId,
        );
        if (!advisory) {
          return res.status(404).json({
            error: `CVE ${cveId} not found in OSV database`
          });
        }
        const vulnerability = advisory as OSVVulnerability;
        if (typeof vulnerability.id !== 'string') {
          throw new Error('Offline OSV identifier lookup returned an advisory without an id');
        }
        const resolvedViaAlias = vulnerability.id !== cveId;
        if (resolvedViaAlias && !vulnerability.aliases?.includes(cveId)) {
          throw new Error('Offline OSV alias resolution returned an inconsistent advisory');
        }
        identifierResolution = {
          requestedIdentifier: cveId,
          resolvedAdvisoryId: vulnerability.id,
          resolvedViaAlias,
        };
        data = vulnerability;
      } else {
        if (!version) {
          return res.status(400).json({
            error: 'Package version is required when OSV_MODE=offline',
          });
        }
        if (!isOsvEcosystem(ecosystem!)) {
          return res.status(400).json({
            error: `Ecosystem ${ecosystem} is not supported when OSV_MODE=offline`,
          });
        }

        const [match] = await dependencies.matchOsvPackages(
          dependencies.osvClient,
          [{ name: name!, version, ecosystem }],
        );
        if (!match) throw new OSVSourceUnavailableError();
        data = { vulns: match.vulnerabilities as unknown as OSVVulnerability[] };
      }
    } else {
      const osvBaseUrl = dependencies.osvBaseUrl;
      if (!osvBaseUrl) {
        throw new OSVSourceUnavailableError();
      }

      let response: Response;
      if (cveId) {
        // Query specific CVE
        response = await dependencies.fetch(`${osvBaseUrl}/v1/vulns/${encodeURIComponent(cveId)}`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'BOMbot-SBOM-Scanner/1.0'
          }
        });

        if (!response.ok) {
          if (response.status === 404) {
            return res.status(404).json({
              error: `CVE ${cveId} not found in OSV database`
            });
          }
          throw new Error(`OSV API error: ${response.status}`);
        }

        data = await response.json() as OSVVulnerability;
      } else {
        // Query by package name and version
        const queryBody: any = {
          package: { name, ecosystem }
        };

        if (version) {
          queryBody.version = version;
        }

        response = await dependencies.fetch(`${osvBaseUrl}/v1/query`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'BOMbot-SBOM-Scanner/1.0'
          },
          body: JSON.stringify(queryBody)
        });

        if (!response.ok) {
          throw new Error(`OSV API error: ${response.status}`);
        }

        data = await response.json() as OSVQueryResponse;
      }
    }

    // If a conversation is provided, send the authoritative OSV result into it.
    if (conversationId) {
      try {
        let messageContent: string;
        
        if (cveId) {
          const vuln = data as OSVVulnerability;
          const resolutionNote = identifierResolution?.resolvedViaAlias
            ? `\n\nOffline snapshot note: Requested identifier ${cveId} is an alias of advisory ${identifierResolution.resolvedAdvisoryId}; the details below are for ${identifierResolution.resolvedAdvisoryId}.`
            : '';
          messageContent = `Here are the details for CVE ${cveId}:${resolutionNote}\n\n${JSON.stringify(vuln, null, 2)}\n\nPlease provide a QUICK summary with OSV.dev links (NOT NVD links). Use osv.dev format for vulnerability links. Keep it brief and suggest I can ask for "detailed analysis" if needed.`;
        } else {
          const queryResult = data as OSVQueryResponse;
          const vulnCount = queryResult.vulns?.length || 0;
          
          if (vulnCount === 0) {
            messageContent = `I queried the OSV database for package "${name}" in ecosystem "${ecosystem}"${version ? ` version "${version}"` : ''} and found no known vulnerabilities. ✅ This package appears to be safe!`;
          } else {
            messageContent = `I found ${vulnCount} vulnerability/vulnerabilities for package "${name}" in ecosystem "${ecosystem}"${version ? ` version "${version}"` : ''}:\n\n${JSON.stringify(queryResult, null, 2)}\n\nPlease provide a QUICK summary with OSV.dev links (NOT NVD links). Use osv.dev format for vulnerability links. Keep it brief and suggest I can ask for "detailed analysis" if needed.`;
          }
        }

        await dependencies.appendConversationMessages({
          conversationId,
          messages: [{ role: 'user', content: messageContent }],
        });

        return res.status(200).json({ 
          success: true,
          result: data,
          conversationId,
          threadId: conversationId,
          ...(identifierResolution ? { identifierResolution } : {}),
          query: cveId ? { cve: cveId } : { name, ecosystem, version }
        });
      } catch (assistantError) {
        if (assistantError instanceof ConversationSequenceConflictError) {
          return res.status(409).json({ error: 'Conversation changed while this query was submitted' });
        }
        console.error('Failed to send to assistant:', assistantError);
        // Still return the OSV data even if assistant fails
        return res.status(200).json({ 
          result: data,
          assistantError: 'Failed to send to AI assistant',
          ...(identifierResolution ? { identifierResolution } : {}),
          query: cveId ? { cve: cveId } : { name, ecosystem, version }
        });
      }
    }

    // Return raw OSV data
    res.status(200).json({ 
      success: true,
      result: data,
      ...(identifierResolution ? { identifierResolution } : {}),
      query: cveId ? { cve: cveId } : { name, ecosystem, version }
    });

  } catch (error) {
    console.error('OSV query error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch data from OSV database',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

export default createOsvQueryHandler();
