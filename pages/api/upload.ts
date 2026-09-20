import { safeLog, safeValue, errorClass } from '../../lib/logging/redact.ts';
import { createTimer, logTiming } from '../../lib/logging/timing.ts';
import formidable from 'formidable';
import fs from 'fs';
import type { NextApiRequest, NextApiResponse } from 'next';
import tmp from 'tmp';
import path from 'path';
import { config as environmentConfig } from '../../lib/config.ts';
import { buildSoftwareContext, minimizeVulnerability } from '../../lib/context/softwareContext.ts';
import { insertLog } from '../../lib/db/chatLogs.ts';
import { dbPool } from '../../lib/db/client.ts';
import { captureScanSource, withCapturedScanSource } from '../../lib/db/scanProvenance.ts';
import type { ScanSkipCounts } from '../../lib/context/scanProvenance.ts';
import {
  ConversationSequenceConflictError,
  createConversation,
  getConversationSessionId,
} from '../../lib/db/conversations.ts';
import { appendConversationMessages } from '../../lib/llm/conversationHistory.ts';
import {
  formatOpenAIError,
} from '../../lib/openai-responses.ts';
import { OSV_ECOSYSTEMS } from '../../lib/osv/ecosystems.ts';
import { OSVSourceUnavailableError } from '../../lib/osv/errors.ts';
import { matchOsvPackages } from '../../lib/osv/match.ts';
import type { OsvEcosystem } from '../../lib/osv/ecosystems.ts';
import type { OsvQueryClient } from '../../lib/osv/db.ts';
import { v4 as uuidv4 } from 'uuid';
import {
  isProviderId,
  resolveProviderSettings,
  type ProviderId,
} from '../../lib/llm/providerRegistry.ts';

export const config = {
  api: {
    bodyParser: false, // Required for formidable
    externalResolver: true,
  },
};

interface SBOMPackage {
  name: string;
  version?: string;
  ecosystem: string;
  id?: string; // SPDX ID or component reference
  scanSkipReason?: 'unsupported_purl_type' | 'undeterminable_ecosystem';
}

interface DependencyRelationship {
  parent: string; // Package ID or name
  child: string;  // Dependency ID or name
  relationship: string; // Type: 'DEPENDS_ON', 'BUILD_DEPENDS_ON', etc.
}

interface DependencyGraphNode {
  id: string;
  label: string;
  version?: string;
  ecosystem: string;
  hasVulnerabilities: boolean;
  vulnerabilityCount: number;
  scanned: boolean;
  skipReason?: string;
}

interface DependencyGraphEdge {
  from: string;
  to: string;
  label: string;
  relationship: string;
}

interface DependencyGraph {
  nodes: DependencyGraphNode[];
  edges: DependencyGraphEdge[];
}

interface OSVVulnerability {
  id: string;
  summary: string;
  details: string;
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
      }>;
    }>;
  }>;
  references: Array<{
    type: string;
    url: string;
  }>;
}

const PURL_TYPE_TO_OSV_ECOSYSTEM: Readonly<Record<string, OsvEcosystem>> = {
  npm: 'npm',
  pypi: 'PyPI',
  maven: 'Maven',
  golang: 'Go',
  composer: 'Packagist',
  gem: 'RubyGems',
  nuget: 'NuGet',
  cargo: 'crates.io',
  hex: 'Hex',
  pub: 'Pub',
};

function ecosystemFromPurl(purl: unknown): OsvEcosystem | 'unknown' {
  if (typeof purl !== 'string') return 'unknown';

  const match = /^pkg:([^/]+)\//i.exec(purl);
  if (!match) return 'unknown';

  return PURL_TYPE_TO_OSV_ECOSYSTEM[match[1].toLowerCase()] ?? 'unknown';
}

function ecosystemFromDownloadLocation(downloadLocation: unknown): OsvEcosystem | 'unknown' {
  if (typeof downloadLocation !== 'string') return 'unknown';

  const location = downloadLocation.toLowerCase();
  if (location.includes('pypi') || location.includes('python')) return 'PyPI';
  if (location.includes('maven')) return 'Maven';
  if (location.includes('nuget')) return 'NuGet';
  if (location.includes('golang') || location.includes('go.mod')) return 'Go';
  if (location.includes('rubygems')) return 'RubyGems';
  if (location.includes('cargo') || location.includes('crates')) return 'crates.io';

  try {
    if (new URL(downloadLocation).hostname.toLowerCase() === 'registry.npmjs.org') return 'npm';
  } catch {
    // The existing substring rules above also support non-URL location strings.
  }

  return 'unknown';
}

// Parse SBOM file to extract packages and dependencies
export function parseSBOMData(sbomContent: string, fileName: string): { packages: SBOMPackage[], dependencies: DependencyRelationship[] } {
  try {
    const sbom = JSON.parse(sbomContent);
    const packages: SBOMPackage[] = [];
    const dependencies: DependencyRelationship[] = [];

    // Handle SPDX format
    if (sbom.spdxVersion || sbom.SPDXID) {
      // Parse packages
      if (sbom.packages) {
        sbom.packages.forEach((pkg: any) => {
          if (pkg.name && pkg.name !== 'NOASSERTION') {
            const purlReference = Array.isArray(pkg.externalRefs)
              ? pkg.externalRefs.find((reference: any) => reference?.referenceType === 'purl')
              : undefined;
            const ecosystem = purlReference
              ? ecosystemFromPurl(purlReference.referenceLocator)
              : ecosystemFromDownloadLocation(pkg.downloadLocation);
            
            packages.push({
              name: pkg.name,
              version: pkg.versionInfo || pkg.version,
              ecosystem: ecosystem,
              id: pkg.SPDXID,
              ...(ecosystem === 'unknown' ? { scanSkipReason: purlReference
                && /^pkg:[^/]+\//iu.test(purlReference.referenceLocator)
                ? 'unsupported_purl_type' as const : 'undeterminable_ecosystem' as const } : {})
            });
          }
        });
      }

      // Parse relationships for dependencies
      if (sbom.relationships) {
        sbom.relationships.forEach((rel: any) => {
          // SPDX CONTAINS describes file containment and OTHER carries generator evidence
          // linkage; neither is a package dependency and both must remain excluded here.
          if (rel.relationshipType === 'DEPENDENCY_OF') {
            dependencies.push({
              parent: rel.relatedSpdxElement,
              child: rel.spdxElementId,
              relationship: 'DEPENDS_ON'
            });
            return;
          }

          if (rel.relationshipType && (
            rel.relationshipType === 'DEPENDS_ON' || 
            rel.relationshipType === 'BUILD_DEPENDS_ON' ||
            rel.relationshipType === 'DEV_DEPENDS_ON' ||
            rel.relationshipType === 'RUNTIME_DEPENDS_ON'
          )) {
            dependencies.push({
              parent: rel.spdxElementId,
              child: rel.relatedSpdxElement,
              relationship: rel.relationshipType
            });
          }
        });
      }
    }
    // Handle CycloneDX format
    else if (sbom.bomFormat === 'CycloneDX' || sbom.components) {
      // Parse components
      if (sbom.components) {
        sbom.components.forEach((component: any) => {
          if (component.name && component.purl) {
            const ecosystem = ecosystemFromPurl(component.purl);
            packages.push({
              name: component.name,
              version: component.version,
              ecosystem,
              id: component['bom-ref'] || component.purl,
              ...(ecosystem === 'unknown' ? { scanSkipReason: /^pkg:[^/]+\//iu.test(component.purl)
                ? 'unsupported_purl_type' as const : 'undeterminable_ecosystem' as const } : {})
            });
          }
        });
      }

      // Parse dependencies from CycloneDX
      if (sbom.dependencies) {
        sbom.dependencies.forEach((dep: any) => {
          if (dep.ref && dep.dependsOn) {
            dep.dependsOn.forEach((childRef: string) => {
              dependencies.push({
                parent: dep.ref,
                child: childRef,
                relationship: 'DEPENDS_ON'
              });
            });
          }
        });
      }
    }
    // Handle generic JSON SBOM
    else if (sbom.packages || sbom.dependencies) {
      const packageList = sbom.packages || sbom.dependencies || [];
      packageList.forEach((pkg: any) => {
        if (pkg.name) {
          packages.push({
            name: pkg.name,
            version: pkg.version,
            ecosystem: pkg.ecosystem || 'unknown',
            id: pkg.id || pkg.purl || pkg.name
          });
        }
      });

      // Parse dependencies from generic format
      if (sbom.dependencyGraph || sbom.relationships) {
        const depData = sbom.dependencyGraph || sbom.relationships;
        if (Array.isArray(depData)) {
          depData.forEach((rel: any) => {
            if (rel.from && rel.to) {
              dependencies.push({
                parent: rel.from,
                child: rel.to,
                relationship: rel.type || 'DEPENDS_ON'
              });
            }
          });
        }
      }
    }

    return { packages, dependencies };
  } catch (error) {
    safeLog('error', safeValue("Error parsing SBOM:"), safeValue(errorClass(error)));
    throw new Error('Invalid SBOM format. Please ensure the file is valid JSON.');
  }
}

// Helper function to extract simple severity from OSV data
export function extractSeverity(vuln: any) {
  const databaseSeverity = vuln.database_specific?.severity;
  if (typeof databaseSeverity === 'string' && databaseSeverity.trim().length > 0) {
    return databaseSeverity.trim().toUpperCase();
  }

  if (Array.isArray(vuln.severity)) {
    for (const sev of vuln.severity) {
      if (sev.type === 'CVSS_V3' || sev.type === 'CVSS_V4') {
        const rawScore = typeof sev.score === 'string' ? sev.score.trim() : '';
        if (!/^(?:10(?:\.0+)?|[0-9](?:\.\d+)?)$/.test(rawScore)) continue;

        const score = Number(rawScore);
        if (score >= 9.0) return 'CRITICAL';
        if (score >= 7.0) return 'HIGH';
        if (score >= 4.0) return 'MEDIUM';
        if (score > 0) return 'LOW';
      }
    }
  }

  return 'Not provided';
}

// Generate dependency graph from packages and dependencies
function generateDependencyGraph(
  packages: SBOMPackage[], 
  dependencies: DependencyRelationship[], 
  vulnerabilityResults: Array<{ package: SBOMPackage; vulnerabilities: OSVVulnerability[] }>
): DependencyGraph {
  const vulnMap = new Map<SBOMPackage, number>(vulnerabilityResults.map(vr => [vr.package, vr.vulnerabilities.length]));
  
  // Create nodes for all packages
  const nodes: DependencyGraphNode[] = packages.map(pkg => {
    const wasScanned = vulnMap.has(pkg);
    const vulnCount = wasScanned ? vulnMap.get(pkg)! : -1; // -1 indicates not scanned
    
    return {
      id: pkg.id || pkg.name,
      label: pkg.name,
      version: pkg.version,
      ecosystem: pkg.ecosystem,
      hasVulnerabilities: wasScanned && vulnCount > 0,
      vulnerabilityCount: vulnCount,
      scanned: wasScanned,
      ...(pkg.scanSkipReason ? { skipReason: pkg.scanSkipReason } : {})
    };
  });

  // Create edges for dependencies
  const packageIdMap = new Map(packages.map(pkg => [pkg.id || pkg.name, pkg]));
  const edges: DependencyGraphEdge[] = dependencies
    .filter(dep => packageIdMap.has(dep.parent) && packageIdMap.has(dep.child))
    .map(dep => {
      const parentPkg = packageIdMap.get(dep.parent)!;
      const childPkg = packageIdMap.get(dep.child)!;
      return {
        from: dep.parent,
        to: dep.child,
        label: dep.relationship.replace('_', ' '),
        relationship: dep.relationship
      };
    });

  return { nodes, edges };
}

// Query OSV API for package vulnerabilities
async function queryOSVForPackage(pkg: SBOMPackage): Promise<OSVVulnerability[]> {
  try {
    const queryBody: any = {
      package: { 
        name: pkg.name, 
        ecosystem: pkg.ecosystem 
      }
    };
    
    if (pkg.version) {
      queryBody.version = pkg.version;
    }

    const osvBaseUrl = environmentConfig.OSV_BASE_URL;
    if (!osvBaseUrl) {
      throw new OSVSourceUnavailableError();
    }

    const response = await fetch(`${osvBaseUrl}/v1/query`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'User-Agent': 'BOMbot-SBOM-Scanner/1.0'
      },
      body: JSON.stringify(queryBody)
    });

    if (!response.ok) {
      safeLog('warn', safeValue("OSV query failed"), safeValue(response.status));
      return [];
    }

    const result = await response.json();
    return result.vulns || [];
  } catch (error) {
    if (error instanceof OSVSourceUnavailableError) {
      throw error;
    }
    safeLog('warn', safeValue("Error querying OSV"), safeValue(errorClass(error)));
    return [];
  }
}

interface UploadHandlerDependencies {
  parseForm: (
    req: NextApiRequest,
    uploadDir: string,
  ) => Promise<{ fields: any; files: any }>;
  queryOSVForPackage: typeof queryOSVForPackage;
  matchOsvPackages: typeof matchOsvPackages;
  osvClient: OsvQueryClient;
  osvMode: typeof environmentConfig.OSV_MODE;
  captureScanSource: typeof captureScanSource;
  createConversation: typeof createConversation;
  getConversationSessionId: typeof getConversationSessionId;
  appendConversationMessages: typeof appendConversationMessages;
  insertLog: typeof insertLog;
  wait: (milliseconds: number) => Promise<void>;
  now?: () => number;
  enableModelToggle: boolean;
  isProviderId: typeof isProviderId;
  resolveProviderSettings: typeof resolveProviderSettings;
}

async function parseUploadForm(req: NextApiRequest, uploadDir: string) {
  const form = formidable({
    uploadDir,
    keepExtensions: true,
    maxFileSize: 10 * 1024 * 1024,
  });
  return new Promise<{ fields: any; files: any }>((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

export function createUploadHandler(
  overrides: Partial<UploadHandlerDependencies> = {},
) {
  const handlerDependencies: UploadHandlerDependencies = {
    parseForm: parseUploadForm,
    queryOSVForPackage,
    matchOsvPackages,
    osvClient: dbPool,
    osvMode: environmentConfig.OSV_MODE,
    captureScanSource,
    createConversation,
    getConversationSessionId,
    appendConversationMessages,
    insertLog,
    wait: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    now: () => performance.now(),
    enableModelToggle: environmentConfig.ENABLE_MODEL_TOGGLE,
    isProviderId,
    resolveProviderSettings,
    ...overrides,
  };

  return async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const timer = createTimer(handlerDependencies.now ?? (() => performance.now()));
  const totalStartedAt = timer.start();
  let parseMs: number | null = null;
  let scanMs: number | null = null;
  let persistMs: number | null = null;
  let packagesScanned: number | null = null;
  let packagesTotal: number | null = null;
  const parseStartedAt = timer.start();

  // Create temporary directory for uploads
  const tmpDir = tmp.dirSync({ unsafeCleanup: true });
  
  try {
    const { fields, files } = await handlerDependencies.parseForm(req, tmpDir.name);

    const file = Array.isArray(files.file) ? files.file[0] : files.file;
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filePath = file.filepath;
    const fileName = file.originalFilename || 'uploaded-sbom';
    
    // Extract session and message info from fields
    const sessionId = Array.isArray(fields.sessionId) ? fields.sessionId[0] : fields.sessionId;
    const messageIndex = Array.isArray(fields.messageIndex) ? 
      parseInt(fields.messageIndex[0]) : 
      parseInt(fields.messageIndex || '0');
    const conversationField = fields.conversationId || fields.threadId;
    const existingConversationId = Array.isArray(conversationField) ? conversationField[0] : conversationField;
    const providerField = Array.isArray(fields.providerId) ? fields.providerId[0] : fields.providerId;

    if (providerField !== undefined && !handlerDependencies.isProviderId(providerField)) {
      return res.status(400).json({ error: 'Unknown model provider' });
    }
    const providerId: ProviderId = providerField ?? 'primary';
    if (existingConversationId && providerField !== undefined) {
      return res.status(400).json({ error: 'Provider may only be selected when creating a conversation' });
    }
    if (!handlerDependencies.enableModelToggle && providerId !== 'primary') {
      return res.status(403).json({ error: 'Model provider selection is disabled' });
    }
    handlerDependencies.resolveProviderSettings(providerId);

    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    if (existingConversationId) {
      // This session UUID is a bearer capability, not authentication. It limits practical
      // conversation enumeration but does not protect a capability obtained by another party.
      if (await handlerDependencies.getConversationSessionId(existingConversationId) !== sessionId) {
        return res.status(403).json({ error: 'Conversation does not belong to this session' });
      }
    }

    // Validate file type (basic check for SBOM files)
    const validExtensions = ['.json', '.xml', '.spdx', '.cyclonedx'];
    const fileExt = path.extname(fileName).toLowerCase();
    
    if (!validExtensions.includes(fileExt) && !fileName.includes('sbom') && !fileName.includes('spdx')) {
      return res.status(400).json({ 
        error: 'Invalid file type. Please upload a valid SBOM file (.json, .xml, .spdx, .cyclonedx)' 
      });
    }

    // Read and parse SBOM file
    const sbomContent = fs.readFileSync(filePath, 'utf-8');
    let packages: SBOMPackage[];
    let dependencies: DependencyRelationship[];
    
    try {
      const parsedData = parseSBOMData(sbomContent, fileName);
      packages = parsedData.packages;
      dependencies = parsedData.dependencies;
      parseMs = timer.since(parseStartedAt);
      packagesTotal = packages.length;
    } catch (parseError) {
      return res.status(400).json({ 
        error: 'Failed to parse SBOM file. Please ensure it follows SPDX or CycloneDX format.',
        details: parseError instanceof Error ? parseError.message : 'Unknown parsing error'
      });
    }

    if (packages.length === 0) {
      return res.status(400).json({ 
        error: 'No packages found in SBOM file. Please verify the file format.' 
      });
    }

    // Query OSV for vulnerabilities (limit to first 150 packages to avoid timeout)
    const recognizedEcosystems = new Set<string>(OSV_ECOSYSTEMS);
    const packagesWithinScanCap = packages.slice(0, 150);
    const unrecognizedEcosystemCount = packagesWithinScanCap.filter(
      pkg => !recognizedEcosystems.has(pkg.ecosystem),
    ).length;
    const packagesToScan = packagesWithinScanCap
      .filter(pkg => recognizedEcosystems.has(pkg.ecosystem));
    packagesScanned = packagesToScan.length;
    const uniqueScannedPairs = new Set(packagesToScan.map(
      pkg => `${pkg.ecosystem}\u0000${pkg.name}\u0000${pkg.version ?? ''}`,
    )).size;
    const skipCounts: ScanSkipCounts = { cap: packages.length - packagesWithinScanCap.length,
      unsupported_purl_type: 0, undeterminable_ecosystem: 0, unsupported_ecosystem: 0 };
    for (const pkg of packagesWithinScanCap) {
      if (!recognizedEcosystems.has(pkg.ecosystem)) {
        skipCounts[pkg.scanSkipReason ?? (pkg.ecosystem === 'unknown'
          ? 'undeterminable_ecosystem' : 'unsupported_ecosystem')]++;
      }
    }
    safeLog('log', safeValue("Scanning packages for vulnerabilities"), safeValue(packagesToScan.length));
    const vulnerabilityResults: Array<{
      package: SBOMPackage;
      vulnerabilities: OSVVulnerability[];
    }> = [];

    const scanStartedAt = timer.start();
    let scanSource: Awaited<ReturnType<typeof captureScanSource>>;
    try {
      scanSource = await handlerDependencies.captureScanSource(
        handlerDependencies.osvMode, handlerDependencies.osvClient, async scanClient => {
    if (handlerDependencies.osvMode === 'offline') {
      const offlinePackages = packagesToScan.map(pkg => ({
        name: pkg.name,
        version: pkg.version as string,
        ecosystem: pkg.ecosystem as OsvEcosystem,
      }));
      const offlineMatches = await handlerDependencies.matchOsvPackages(
        scanClient,
        offlinePackages,
      );
      vulnerabilityResults.push(...offlineMatches.map((match, index) => ({
        package: packagesToScan[index],
        vulnerabilities: match.vulnerabilities as unknown as OSVVulnerability[],
      })));
    } else {
      // Process packages in batches to avoid rate limiting
      for (let i = 0; i < packagesToScan.length; i += 5) {
        const batch = packagesToScan.slice(i, i + 5);
        const batchPromises = batch.map(pkg =>
          handlerDependencies.queryOSVForPackage(pkg).then(vulns => ({ package: pkg, vulnerabilities: vulns }))
        );

        const batchResults = await Promise.all(batchPromises);
        vulnerabilityResults.push(...batchResults);

        // Small delay between batches
        if (i + 5 < packagesToScan.length) {
          await handlerDependencies.wait(100);
        }
      }
    }

      });
    } finally {
      scanMs = timer.since(scanStartedAt);
    }

    // Send the scan results to the assistant
    const totalVulns = vulnerabilityResults.reduce((sum, result) => sum + result.vulnerabilities.length, 0);
    const vulnPackages = vulnerabilityResults.filter(result => result.vulnerabilities.length > 0).length;
    
    // Generate dependency graph for visualization
    const dependencyGraph = generateDependencyGraph(packages, dependencies, vulnerabilityResults);

    const parsedSbomForContext = JSON.parse(sbomContent) as {
      name?: string;
      metadata?: { component?: { name?: string } };
    };
    const softwareContext = buildSoftwareContext({
      softwareName: parsedSbomForContext.name
        ?? parsedSbomForContext.metadata?.component?.name
        ?? fileName,
      sbomContent,
      packages,
      dependencies,
      vulnerabilityResults,
      scannedPackageCount: packagesToScan.length,
    });
    const truncationStatement = skipCounts.cap > 0
      ? `- Scan coverage warning: ${skipCounts.cap} of ${softwareContext.total_package_count} packages were excluded by the 150-package cap.`
      : '';
    const unrecognizedEcosystemStatement = unrecognizedEcosystemCount > 0
      ? `- Ecosystem coverage warning: ${([
        ['unsupported_purl_type', 'unsupported purl type'],
        ['undeterminable_ecosystem', 'ecosystem could not be derived'],
        ['unsupported_ecosystem', 'unsupported ecosystem'],
      ] as const).filter(([cause]) => skipCounts[cause] > 0).map(([cause, explanation]) =>
        `${skipCounts[cause]} package${skipCounts[cause] === 1 ? '' : 's'} not scanned: ${explanation}`).join('; ')}.`
      : '';

    const responseInput = `I've uploaded ${existingConversationId ? 'an additional' : 'an'} SBOM file "${fileName}" with ${packages.length} packages${existingConversationId ? ' for comparison with the previous SBOM(s)' : ''}. Here's the comprehensive analysis data:

**Quick Scan Summary:**
- Total packages scanned: ${packagesToScan.length}
- Packages with vulnerabilities: ${vulnPackages}
- Total vulnerabilities found: ${totalVulns}
- Dependency relationships found: ${dependencies.length}
${truncationStatement}
${unrecognizedEcosystemStatement}

**Minimized Software Context:**
${JSON.stringify(softwareContext)}

${existingConversationId ?
  'Please provide a QUICK summary of the most critical findings with OSV.dev links (NOT NVD links). Since this is an additional SBOM, you can also compare it with previously uploaded SBOMs. Use osv.dev format for vulnerability links. Keep it brief and actionable. Suggest that I can ask for "executive summary", "detailed analysis", "dependency analysis", or "SBOM comparison" for comprehensive information.' :
  'Please provide a QUICK summary of the most critical findings with OSV.dev links (NOT NVD links). Use osv.dev format for vulnerability links. Keep it brief and actionable. Suggest that I can ask for "executive summary", "detailed analysis", or "dependency analysis" for comprehensive information.'}`;

    const persistStartedAt = timer.start();
    let conversationId: string;
    try {
      conversationId = existingConversationId
        ?? (await handlerDependencies.createConversation(sessionId, providerId)).id;
      await withCapturedScanSource({ ...scanSource, scanned_package_count: softwareContext.scanned_package_count,
        scan_truncated: softwareContext.scan_truncated, skip_counts: skipCounts }, async () =>
        handlerDependencies.appendConversationMessages({
        conversationId,
        messages: [{ role: 'user', content: responseInput }],
        pinned: true,
      }));

      if (existingConversationId) {
        safeLog('log', safeValue("Reusing existing conversation for SBOM upload"));
      } else {
        safeLog('log', safeValue("Created new conversation for SBOM upload"));
      }

      // Log file upload to the application-owned datastore if session info is provided.
      if (sessionId && messageIndex !== undefined) {
        try {
          const now = new Date().toISOString();
          await handlerDependencies.insertLog({
            id: uuidv4(),
            session_id: sessionId,
            conversation_id: conversationId,
            message_index: messageIndex,
            message_type: 'file_upload',
            user_message: `Uploaded SBOM file: ${fileName}`,
            ai_response: null,
            file_name: fileName,
            file_size: file.size,
            vulnerability_count: totalVulns,
            user_email: null,
            created_at: now,
            updated_at: now,
          });
        } catch (logError) {
          safeLog('error', safeValue("Error logging file upload:"), safeValue(errorClass(logError)));
          // Continue even if logging fails
        }
      }
    } finally {
      persistMs = timer.since(persistStartedAt);
    }

    // Clean up the uploaded file
    try {
      fs.unlinkSync(filePath);
    } catch (cleanupError) {
      safeLog('warn', safeValue("Failed to cleanup uploaded file:"), safeValue(errorClass(cleanupError)));
    }

    res.status(200).json({ 
      success: true,
      conversationId,
      threadId: conversationId,
      fileName: fileName,
      packagesScanned: packagesToScan.length,
      totalPackages: packages.length,
      unrecognizedEcosystemCount,
      skipCounts,
      uniqueScannedPairs,
      vulnerabilitiesFound: totalVulns,
      dependencyRelationships: dependencies.length,
      dependencyGraph: dependencyGraph,
      sessionId: sessionId,
      messageIndex: messageIndex,
      quickSummary: {
        packagesWithVulns: vulnPackages,
        totalVulns: totalVulns,
        dependenciesFound: dependencies.length,
        topVulnerabilities: vulnerabilityResults
          .filter(result => result.vulnerabilities.length > 0)
          .slice(0, 5)
          .map(result => ({
            package: result.package.name,
            version: result.package.version || 'unknown',
            vulns: result.vulnerabilities.slice(0, 3).map(vuln => {
              const minimized = minimizeVulnerability(vuln);
              return {
                id: vuln.id,
                severity: extractSeverity(vuln),
                summary: vuln.summary || 'No summary available',
                fixedVersions: minimized.fixed_versions,
                affectedRanges: minimized.affected_version_ranges,
              };
            })
          }))
      }
    });

  } catch (error) {
    if (error instanceof ConversationSequenceConflictError) {
      return res.status(409).json({ error: 'Conversation changed while this upload was submitted' });
    }
    safeLog('error', safeValue("Upload handler error:"), safeValue(errorClass(error)));
    res.status(500).json({ 
      error: 'Internal server error',
      details: formatOpenAIError(error)
    });
  } finally {
    // Cleanup temporary directory
    try {
      tmpDir.removeCallback();
    } catch (cleanupError) {
      safeLog('warn', safeValue("Failed to cleanup temp directory:"), safeValue(errorClass(cleanupError)));
    }
    const outcome = res.statusCode >= 200 && res.statusCode < 300
      ? 'ok'
      : res.statusCode === 400 || res.statusCode === 403
        ? 'client_error'
        : res.statusCode === 409
          ? 'conflict'
          : 'exception';
    logTiming({
      kind: 'upload',
      osv_mode: handlerDependencies.osvMode,
      outcome,
      parse_ms: parseMs,
      scan_ms: scanMs,
      persist_ms: persistMs,
      total_ms: timer.since(totalStartedAt),
      packages_scanned: packagesScanned,
      packages_total: packagesTotal,
    });
  }
  };
}

export default createUploadHandler();
