import OpenAI from 'openai';
import { z } from 'zod';
import { config } from './config.ts';
import { dbPool } from './db/client.ts';
import type { LlmToolDef } from './llm/types.ts';
import { getOsvAdvisoryByIdentifier, type OsvQueryClient } from './osv/db.ts';
import { OSVSourceUnavailableError } from './osv/errors.ts';
import { OSV_ECOSYSTEMS } from './osv/ecosystems.ts';
import { getCurrentOsvSnapshot, matchOsvPackages } from './osv/match.ts';

export const MAX_FUNCTION_CALL_ROUNDS = 8;
export const TOOL_ROUND_METADATA_KEY = 'bombot_tool_round';

// Kept in server application code so every Responses request uses the same behavior as
// the legacy Assistant configured from Instruction Prompt.md.
export const BOMBOT_INSTRUCTIONS = `You are BOMbot, an expert cybersecurity analyst specializing in SBOM (Software Bill of Materials) analysis and vulnerability assessment. You provide comprehensive security insights with access to real-time vulnerability data through the OSV (Open Source Vulnerabilities) database.

## Core Mission:
Provide clear, actionable security analysis for software dependencies, prioritizing critical vulnerabilities and offering specific remediation guidance. Always use OSV.dev as your primary vulnerability reference source.

## Your Advanced Capabilities:

### 1. SBOM Security Analysis
- Analyze uploaded SBOM files for vulnerabilities using OSV database results
- Identify critical security risks and affected packages
- Provide prioritized, actionable remediation recommendations  
- Translate technical vulnerabilities into business impact terms
- Compare package versions and suggest safe alternatives

### 2. Real-Time Vulnerability Research
You have access to current vulnerability data through these functions:

**query_package_vulnerabilities(name, ecosystem, version?)**
- Query any package for known vulnerabilities in real-time
- Supported ecosystems: npm, PyPI, Maven, Go, Packagist, RubyGems, NuGet, crates.io, Hex, Pub
- Use when: User asks about package safety, version comparisons, or security status

**query_cve_details(cve_id)**
- Get comprehensive information about specific CVE identifiers
- Use when: User mentions CVE IDs or you need detailed vulnerability context

**analyze_sbom_package(package_name, include_dependencies?)**
- Deep analysis of specific packages from uploaded SBOM data
- Use when: User wants focused analysis of particular SBOM components

### 3. Interactive Security Consultation
- Answer follow-up questions with current vulnerability data
- Provide context-aware security recommendations
- Explain complex security issues in accessible language
- Guide users through remediation strategies

## Critical: Vulnerability Link Standards

### ALWAYS Use OSV.dev Links:
- **Primary source**: https://osv.dev/vulnerability/[VULNERABILITY-ID]
- **Format**: \`[CVE-2023-1234](https://osv.dev/vulnerability/CVE-2023-1234)\`
- **NEVER use**: NVD, MITRE, or other vulnerability databases for links
- **Why OSV.dev**: Our primary vulnerability database with comprehensive, up-to-date open-source vulnerability data

### Link Examples:
- CVE: \`[CVE-2023-37920](https://osv.dev/vulnerability/CVE-2023-37920)\`
- GHSA: \`[GHSA-9wx4-h78v-vm56](https://osv.dev/vulnerability/GHSA-9wx4-h78v-vm56)\`
- Other IDs: \`[PYSEC-2022-42986](https://osv.dev/vulnerability/PYSEC-2022-42986)\`

## Response Structure Guidelines:

### Quick Summary Responses:
For initial queries, provide brief, actionable summaries:
1. **Security Status**: Clear verdict (Safe/Vulnerable/Critical)
2. **Key Findings**: Most important vulnerabilities (limit to top 3-5)
3. **Immediate Actions**: Specific next steps
4. **Detailed Analysis Option**: Suggest asking for "detailed analysis" or "executive summary"

### Detailed Analysis Responses:
When user requests comprehensive information:
1. **Executive Summary**: High-level security assessment
2. **Critical Vulnerabilities**: Most severe issues first
3. **Technical Details**: Vulnerability mechanics and impact
4. **Remediation Plan**: Step-by-step fix instructions
5. **Risk Assessment**: Business impact and timeline recommendations

## Severity Communication:

### Severity Levels:
- **CRITICAL** (9.0-10.0): Immediate action required, active exploits likely
- **HIGH** (7.0-8.9): Priority fix within days, significant security risk
- **MEDIUM** (4.0-6.9): Important update within weeks, moderate risk
- **LOW** (0.1-3.9): Recommended update, minimal immediate risk

### Severity Presentation:
- Use clear severity tags: "HIGH severity vulnerability"
- Explain business impact: "This could allow attackers to..."
- Provide timeline guidance: "Update within 72 hours"

## Function Usage Strategy:

### Proactive Research:
- **User asks about package**: Immediately query current vulnerability data
- **CVE mentioned**: Look up details automatically for context
- **Version comparison needed**: Query specific versions to compare
- **SBOM analysis**: Cross-reference with current vulnerability database

### When to Use Each Function:
- **Package queries**: "Is lodash safe?", "What about Express 4.17.1?"
- **CVE lookups**: "CVE-2023-1234", "That vulnerability you mentioned"  
- **SBOM analysis**: "Tell me about React in our upload", "Focus on the most vulnerable packages"

## Response Examples:

### Quick Package Query:
**User**: "Is Express 4.17.1 safe?"
**Your Process**: [Call query_package_vulnerabilities("express", "npm", "4.17.1")]
**Response**: "I've checked Express 4.17.1 and found **3 HIGH severity vulnerabilities**. Most critical is [CVE-2022-24999](https://osv.dev/vulnerability/CVE-2022-24999) allowing path traversal attacks. **Immediate action needed**: Update to Express 4.18.2+ to resolve all issues."

### CVE Explanation:
**User**: "What's CVE-2023-26136?"
**Your Process**: [Call query_cve_details("CVE-2023-26136")]
**Response**: "[CVE-2023-26136](https://osv.dev/vulnerability/CVE-2023-26136) is a **HIGH severity** prototype pollution vulnerability in tough-cookie library. Allows attackers to modify application behavior through malicious cookies. **Fix**: Update to tough-cookie@4.1.3 or later."

### SBOM Package Analysis:
**User**: "What's the risk with Certifi in our SBOM?"
**Your Process**: [Call analyze_sbom_package("certifi", true)]
**Response**: "Analyzing Certifi from your SBOM data... Found **2 vulnerabilities** including [CVE-2023-37920](https://osv.dev/vulnerability/CVE-2023-37920) - **HIGH severity**. This affects certificate validation. **Recommendation**: Upgrade to certifi>=2023.7.22 immediately."

## Communication Principles:

### Be Actionable:
- Always provide specific version numbers for updates
- Include exact commands when possible: \`npm update express@4.18.2\`
- Prioritize fixes by severity and ease of implementation

### Be Clear:
- Avoid technical jargon in executive summaries
- Explain attack vectors in business terms
- Use bullet points and formatting for readability

### Be Current:
- Use your functions to get real-time data
- Reference latest vulnerability information
- Verify package safety with current database

### Be Comprehensive:
- Address both direct and transitive dependencies
- Consider ecosystem-specific security practices
- Provide alternative packages when appropriate

## Special Scenarios:

### No Vulnerabilities Found:
"✅ **Good news!** [Package] appears secure with no known vulnerabilities in the OSV database. However, always keep packages updated to the latest stable versions."

### Multiple Critical Issues:
"🚨 **CRITICAL**: Found multiple severe vulnerabilities. **Immediate priorities**: 1) [Most critical], 2) [Second priority]. Full remediation plan available - ask for 'detailed analysis'."

### Legacy Package Issues:
"⚠️ **Legacy Risk**: This package version is outdated with known vulnerabilities. **Migration needed**: Consider upgrading to [newer version] or switching to [alternative package]."

Remember: You are the user's trusted security advisor. Provide confidence through accurate, timely information and clear guidance. Always link to OSV.dev for vulnerability references and use your functions proactively to ensure your advice is current and comprehensive.

Vulnerability facts must come from OSV data supplied in the conversation or returned by the OSV-backed functions. Never invent vulnerability IDs, affected versions, severity, or remediation versions. If OSV data is unavailable or inconclusive, say so explicitly.`;

export const BOMBOT_TOOLS: OpenAI.Responses.FunctionTool[] = [
  {
    type: 'function',
    name: 'query_package_vulnerabilities',
    description: 'Query the OSV database for vulnerabilities in a specific package and version',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: "The package name (e.g., 'lodash', 'express')",
        },
        ecosystem: {
          type: 'string',
          description: 'The package ecosystem (npm, PyPI, Maven, Go, etc.)',
          enum: OSV_ECOSYSTEMS,
        },
        version: {
          type: 'string',
          description: "Optional: specific version to check (e.g., '4.17.20')",
        },
      },
      required: ['name', 'ecosystem'],
      additionalProperties: false,
    },
    strict: false,
  },
  {
    type: 'function',
    name: 'query_cve_details',
    description: 'Get detailed information about a specific CVE from the OSV database',
    parameters: {
      type: 'object',
      properties: {
        cve_id: {
          type: 'string',
          description: "The CVE identifier (e.g., 'CVE-2023-1234')",
        },
      },
      required: ['cve_id'],
      additionalProperties: false,
    },
    strict: false,
  },
  {
    type: 'function',
    name: 'analyze_sbom_package',
    description: 'Analyze a specific package from the uploaded SBOM data in detail',
    parameters: {
      type: 'object',
      properties: {
        package_name: {
          type: 'string',
          description: 'The name of the package to analyze from the SBOM',
        },
        include_dependencies: {
          type: 'boolean',
          description: 'Whether to include analysis of package dependencies',
          default: false,
        },
      },
      required: ['package_name'],
      additionalProperties: false,
    },
    strict: false,
  },
  {
    type: 'function',
    name: 'query_package_dependencies',
    description: 'Query dependency relationships for a specific package from the uploaded SBOM',
    parameters: {
      type: 'object',
      properties: {
        package_name: {
          type: 'string',
          description: 'The name of the package to query dependencies for',
        },
        direction: {
          type: 'string',
          description: "Query direction: 'dependencies' (what this package depends on) or 'dependents' (what depends on this package)",
          enum: ['dependencies', 'dependents'],
          default: 'dependencies',
        },
      },
      required: ['package_name'],
      additionalProperties: false,
    },
    strict: false,
  },
];

export const BOMBOT_LLM_TOOLS: LlmToolDef[] = BOMBOT_TOOLS.map(tool => ({
  name: tool.name,
  description: tool.description ?? undefined,
  parameters: tool.parameters ?? {},
  strict: tool.strict ?? false,
}));

const packageQuerySchema = z.object({
  name: z.string().trim().min(1),
  ecosystem: z.enum(OSV_ECOSYSTEMS),
  version: z.string().trim().min(1).optional(),
}).strict();

export const cveQuerySchema = z.object({
  cve_id: z.string().trim().regex(/^CVE-\d{4}-\d{4,}$/i, 'Expected a CVE identifier'),
}).strict();

const sbomPackageSchema = z.object({
  package_name: z.string().trim().min(1),
  include_dependencies: z.boolean().optional().default(false),
}).strict();

const dependencyQuerySchema = z.object({
  package_name: z.string().trim().min(1),
  direction: z.enum(['dependencies', 'dependents']).optional().default('dependencies'),
}).strict();

const toolArgumentSchemas = {
  query_package_vulnerabilities: packageQuerySchema,
  query_cve_details: cveQuerySchema,
  analyze_sbom_package: sbomPackageSchema,
  query_package_dependencies: dependencyQuerySchema,
} as const;

export type BombotToolName = keyof typeof toolArgumentSchemas;

export function getToolContinuationIdempotencyKey(sourceResponseId: string): string {
  return `bombot-tool-successor-${sourceResponseId}`;
}

export function getFunctionCallingRound(response: OpenAI.Responses.Response): number {
  const value = response.metadata?.[TOOL_ROUND_METADATA_KEY];
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return 0;
  }

  const round = Number.parseInt(value, 10);
  return Number.isSafeInteger(round) ? round : 0;
}

export function getFunctionCalls(response: OpenAI.Responses.Response) {
  return response.output.filter(
    (item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === 'function_call',
  );
}

export function extractResponseText(response: OpenAI.Responses.Response): string {
  if (response.output_text) {
    return response.output_text;
  }

  return response.output
    .filter((item): item is OpenAI.Responses.ResponseOutputMessage => item.type === 'message')
    .flatMap(item => item.content)
    .filter((content): content is OpenAI.Responses.ResponseOutputText => content.type === 'output_text')
    .map(content => content.text)
    .join('\n');
}

export function getResponseErrorMessage(response: OpenAI.Responses.Response): string {
  if (response.error?.message) {
    return response.error.message;
  }

  if (response.incomplete_details?.reason) {
    return `Response incomplete: ${response.incomplete_details.reason}`;
  }

  if (response.status === 'cancelled') {
    return 'Response was cancelled';
  }

  return 'Response failed with an unknown error';
}

export function getResponseUsage(response: OpenAI.Responses.Response) {
  return response.usage || null;
}

export function formatOpenAIError(error: unknown): string {
  if (error instanceof OpenAI.APIError) {
    return error.message;
  }

  return error instanceof Error ? error.message : 'Unknown OpenAI error';
}

export function parseToolArguments(functionName: string, rawArguments: string) {
  if (!(functionName in toolArgumentSchemas)) {
    throw new Error(`Unknown function: ${functionName}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    throw new Error(`Invalid JSON arguments for ${functionName}`);
  }

  const schema = toolArgumentSchemas[functionName as BombotToolName];
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid arguments for ${functionName}: ${result.error.issues.map(issue => issue.message).join(', ')}`);
  }

  return result.data;
}

async function getOSVJson(
  url: string,
  init: RequestInit,
  fetchImplementation: typeof fetch,
) {
  const response = await fetchImplementation(url, init);
  if (!response.ok) {
    throw new Error(`OSV API error: ${response.status}`);
  }
  return response.json();
}

interface FunctionCallDependencies {
  fetch: typeof fetch;
  getCurrentOsvSnapshot: typeof getCurrentOsvSnapshot;
  getOsvAdvisoryByIdentifier: typeof getOsvAdvisoryByIdentifier;
  matchOsvPackages: typeof matchOsvPackages;
  osvClient: OsvQueryClient;
  osvMode: typeof config.OSV_MODE;
  osvBaseUrl: typeof config.OSV_BASE_URL;
}

const defaultFunctionCallDependencies: FunctionCallDependencies = {
  fetch,
  getCurrentOsvSnapshot,
  getOsvAdvisoryByIdentifier,
  matchOsvPackages,
  osvClient: dbPool,
  osvMode: config.OSV_MODE,
  osvBaseUrl: config.OSV_BASE_URL,
};

const OFFLINE_OSV_SOURCE = 'offline_osv_snapshot';

function offlineSourceFailure(error: unknown, query: Record<string, unknown>) {
  console.error('Offline OSV model-tool lookup failed:', error);
  return JSON.stringify({
    success: false,
    source: OFFLINE_OSV_SOURCE,
    status: 'source_unavailable',
    error: 'The offline OSV vulnerability source is unavailable; no vulnerability lookup was performed.',
    query,
  });
}

export function createFunctionCallExecutor(
  overrides: Partial<FunctionCallDependencies> = {},
) {
  const dependencies = { ...defaultFunctionCallDependencies, ...overrides };
  return (functionName: string, rawArguments: string) => executeFunctionCallWithDependencies(
    functionName,
    rawArguments,
    dependencies,
  );
}

export async function executeFunctionCall(
  functionName: string,
  rawArguments: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<string> {
  return executeFunctionCallWithDependencies(functionName, rawArguments, {
    ...defaultFunctionCallDependencies,
    fetch: fetchImplementation,
  });
}

async function executeFunctionCallWithDependencies(
  functionName: string,
  rawArguments: string,
  dependencies: FunctionCallDependencies,
): Promise<string> {
  const args = parseToolArguments(functionName, rawArguments);
  const osvBaseUrl = dependencies.osvBaseUrl;

  if (dependencies.osvMode === 'api' && !osvBaseUrl && (
    functionName === 'query_package_vulnerabilities'
    || functionName === 'query_cve_details'
  )) {
    throw new OSVSourceUnavailableError();
  }

  switch (functionName as BombotToolName) {
    case 'query_package_vulnerabilities': {
      const packageArgs = args as z.infer<typeof packageQuerySchema>;
      if (dependencies.osvMode === 'offline') {
        const query = {
          name: packageArgs.name,
          ecosystem: packageArgs.ecosystem,
          ...(packageArgs.version ? { version: packageArgs.version } : {}),
        };
        if (!packageArgs.version) {
          return JSON.stringify({
            success: false,
            source: OFFLINE_OSV_SOURCE,
            status: 'unsupported_query',
            error: 'Offline OSV matching requires an exact package version; no vulnerability lookup was performed.',
            query,
          });
        }

        try {
          const [match] = await dependencies.matchOsvPackages(
            dependencies.osvClient,
            [{
              name: packageArgs.name,
              ecosystem: packageArgs.ecosystem,
              version: packageArgs.version,
            }],
          );
          if (!match) throw new OSVSourceUnavailableError();
          return JSON.stringify({
            success: true,
            source: OFFLINE_OSV_SOURCE,
            status: 'ok',
            query,
            vulns: match.vulnerabilities,
          });
        } catch (error) {
          return offlineSourceFailure(error, query);
        }
      }

      const queryBody: Record<string, unknown> = {
        package: {
          name: packageArgs.name,
          ecosystem: packageArgs.ecosystem,
        },
      };
      if (packageArgs.version) {
        queryBody.version = packageArgs.version;
      }

      const data = await getOSVJson(`${osvBaseUrl}/v1/query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'BOMbot-SBOM-Scanner/1.0',
        },
        body: JSON.stringify(queryBody),
      }, dependencies.fetch);
      return JSON.stringify(data);
    }

    case 'query_cve_details': {
      const cveArgs = args as z.infer<typeof cveQuerySchema>;
      const requestedIdentifier = cveArgs.cve_id.toUpperCase();
      if (dependencies.osvMode === 'offline') {
        const query = { requested_identifier: requestedIdentifier };
        try {
          await dependencies.getCurrentOsvSnapshot(dependencies.osvClient);
          const advisory = await dependencies.getOsvAdvisoryByIdentifier(
            dependencies.osvClient,
            requestedIdentifier,
          ) as { id?: unknown; aliases?: unknown } | null;
          if (!advisory) {
            return JSON.stringify({
              success: false,
              source: OFFLINE_OSV_SOURCE,
              status: 'not_found',
              error: `${requestedIdentifier} was not found in the pinned offline OSV snapshot.`,
              ...query,
            });
          }
          if (typeof advisory.id !== 'string') {
            throw new Error('Offline OSV identifier lookup returned an advisory without an id');
          }
          const resolvedViaAlias = advisory.id !== requestedIdentifier;
          if (
            resolvedViaAlias
            && (!Array.isArray(advisory.aliases) || !advisory.aliases.includes(requestedIdentifier))
          ) {
            throw new Error('Offline OSV alias resolution returned an inconsistent advisory');
          }

          return JSON.stringify({
            success: true,
            source: OFFLINE_OSV_SOURCE,
            status: 'ok',
            requested_identifier: requestedIdentifier,
            resolved_advisory_id: advisory.id,
            resolved_via_alias: resolvedViaAlias,
            ...(resolvedViaAlias ? {
              notice: `Offline snapshot substitution: requested identifier ${requestedIdentifier} is an alias of advisory ${advisory.id}; the returned details are for ${advisory.id}.`,
            } : {}),
            advisory,
          });
        } catch (error) {
          return offlineSourceFailure(error, query);
        }
      }

      const data = await getOSVJson(
        `${osvBaseUrl}/v1/vulns/${encodeURIComponent(requestedIdentifier)}`,
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'BOMbot-SBOM-Scanner/1.0',
          },
        },
        dependencies.fetch,
      );
      return JSON.stringify(data);
    }

    case 'analyze_sbom_package': {
      const sbomArgs = args as z.infer<typeof sbomPackageSchema>;
      return JSON.stringify({
        message: `Analyzing package '${sbomArgs.package_name}' from the uploaded SBOM data. Please refer to the scan results in our conversation for detailed analysis.`,
        package_name: sbomArgs.package_name,
        include_dependencies: sbomArgs.include_dependencies,
        action: 'analyze_uploaded_data',
      });
    }

    case 'query_package_dependencies': {
      const dependencyArgs = args as z.infer<typeof dependencyQuerySchema>;
      return JSON.stringify({
        message: `Querying ${dependencyArgs.direction} for package '${dependencyArgs.package_name}' from the uploaded SBOM data. Please refer to the package dependency information in our conversation.`,
        package_name: dependencyArgs.package_name,
        direction: dependencyArgs.direction,
        action: 'query_dependency_data',
      });
    }
  }
}
