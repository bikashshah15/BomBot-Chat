import formidable from 'formidable';
import fs from 'fs';
import type { NextApiRequest, NextApiResponse } from 'next';
import tmp from 'tmp';
import path from 'path';
import { config as environmentConfig } from '../../lib/config.ts';
import { buildSoftwareContext } from '../../lib/context/softwareContext.ts';
import { insertLog } from '../../lib/db/chatLogs.ts';
import { dbPool } from '../../lib/db/client.ts';
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
            // Extract ecosystem from package manager or downloadLocation
            let ecosystem = 'npm'; // default
            if (pkg.downloadLocation) {
              const url = pkg.downloadLocation.toLowerCase();
              if (url.includes('pypi') || url.includes('python')) ecosystem = 'PyPI';
              else if (url.includes('maven')) ecosystem = 'Maven';
              else if (url.includes('nuget')) ecosystem = 'NuGet';
              else if (url.includes('golang') || url.includes('go.mod')) ecosystem = 'Go';
              else if (url.includes('rubygems')) ecosystem = 'RubyGems';
              else if (url.includes('cargo') || url.includes('crates')) ecosystem = 'crates.io';
            }
            
            packages.push({
              name: pkg.name,
              version: pkg.versionInfo || pkg.version,
              ecosystem: ecosystem,
              id: pkg.SPDXID
            });
          }
        });
      }

      // Parse relationships for dependencies
      if (sbom.relationships) {
        sbom.relationships.forEach((rel: any) => {
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
            // Parse package URL (purl) to extract ecosystem
            const typeEnd = component.purl.indexOf('/', 4);
            if (component.purl.startsWith('pkg:') && typeEnd > 4) {
              const ecosystem = component.purl.slice(4, typeEnd).toLowerCase();
              const ecosystemMap: { [key: string]: string } = {
                'npm': 'npm',
                'pypi': 'PyPI', 
                'maven': 'Maven',
                'nuget': 'NuGet',
                'golang': 'Go',
                'gem': 'RubyGems',
                'cargo': 'crates.io',
                'composer': 'Packagist'
              };
              
              packages.push({
                name: component.name,
                version: component.version,
                ecosystem: ecosystemMap[ecosystem] || ecosystem,
                id: component['bom-ref'] || component.purl
              });
            }
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
            ecosystem: pkg.ecosystem || 'npm', // default to npm
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
    console.error('Error parsing SBOM:', error);
    throw new Error('Invalid SBOM format. Please ensure the file is valid JSON.');
  }
}

// Helper function to extract simple severity from OSV data
function extractSeverity(vuln: any) {
  // Try to find CVSS severity first
  if (vuln.severity && vuln.severity.length > 0) {
    for (const sev of vuln.severity) {
      if (sev.type === 'CVSS_V3') {
        const score = parseFloat(sev.score?.split('/')[0] || '0');
        if (score >= 9.0) return 'CRITICAL';
        if (score >= 7.0) return 'HIGH';
        if (score >= 4.0) return 'MEDIUM';
        if (score > 0) return 'LOW';
      }
    }
  }
  
  // Try database_specific for GHSA severity
  if (vuln.database_specific?.severity) {
    return vuln.database_specific.severity.toUpperCase();
  }
  
  // Fallback to parsing from summary or other fields
  const content = (vuln.summary || vuln.details || '').toUpperCase();
  if (content.includes('CRITICAL')) return 'CRITICAL';
  if (content.includes('HIGH')) return 'HIGH';
  if (content.includes('MEDIUM') || content.includes('MODERATE')) return 'MEDIUM';
  if (content.includes('LOW')) return 'LOW';
  
  return 'Unknown';
}

// Generate dependency graph from packages and dependencies
function generateDependencyGraph(
  packages: SBOMPackage[], 
  dependencies: DependencyRelationship[], 
  vulnerabilityResults: Array<{ package: SBOMPackage; vulnerabilities: OSVVulnerability[] }>
): DependencyGraph {
  const vulnMap = new Map(vulnerabilityResults.map(vr => [vr.package.name, vr.vulnerabilities.length]));
  
  // Create nodes for all packages
  const nodes: DependencyGraphNode[] = packages.map(pkg => {
    const wasScanned = vulnMap.has(pkg.name);
    const vulnCount = wasScanned ? vulnMap.get(pkg.name)! : -1; // -1 indicates not scanned
    
    return {
      id: pkg.id || pkg.name,
      label: pkg.name,
      version: pkg.version,
      ecosystem: pkg.ecosystem,
      hasVulnerabilities: wasScanned && vulnCount > 0,
      vulnerabilityCount: vulnCount
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
      console.warn(`OSV query failed for ${pkg.name}: ${response.status}`);
      return [];
    }

    const result = await response.json();
    return result.vulns || [];
  } catch (error) {
    if (error instanceof OSVSourceUnavailableError) {
      throw error;
    }
    console.warn(`Error querying OSV for ${pkg.name}:`, error);
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
  createConversation: typeof createConversation;
  getConversationSessionId: typeof getConversationSessionId;
  appendConversationMessages: typeof appendConversationMessages;
  insertLog: typeof insertLog;
  wait: (milliseconds: number) => Promise<void>;
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
    createConversation,
    getConversationSessionId,
    appendConversationMessages,
    insertLog,
    wait: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    ...overrides,
  };

  return async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

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
    const userEmail = Array.isArray(fields.userEmail) ? fields.userEmail[0] : fields.userEmail;
    const conversationField = fields.conversationId || fields.threadId;
    const existingConversationId = Array.isArray(conversationField) ? conversationField[0] : conversationField;

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
    console.log(`Scanning ${packagesToScan.length} packages for vulnerabilities...`);
    const vulnerabilityResults: Array<{
      package: SBOMPackage;
      vulnerabilities: OSVVulnerability[];
    }> = [];

    if (handlerDependencies.osvMode === 'offline') {
      const offlinePackages = packagesToScan.map(pkg => ({
        name: pkg.name,
        version: pkg.version as string,
        ecosystem: pkg.ecosystem as OsvEcosystem,
      }));
      const offlineMatches = await handlerDependencies.matchOsvPackages(
        handlerDependencies.osvClient,
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
      scannedPackageCount: packagesWithinScanCap.length,
    });
    const truncationStatement = softwareContext.scan_truncated
      ? `- Scan coverage warning: ${softwareContext.total_package_count - softwareContext.scanned_package_count} of ${softwareContext.total_package_count} packages were excluded by the 150-package cap.`
      : '';
    const unrecognizedEcosystemStatement = unrecognizedEcosystemCount > 0
      ? `- Ecosystem coverage warning: ${unrecognizedEcosystemCount} package${unrecognizedEcosystemCount === 1 ? '' : 's'} admitted by the 150-package cap could not be scanned because the ecosystem was unrecognized.`
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

    const conversationId = existingConversationId
      ?? (await handlerDependencies.createConversation(sessionId)).id;
    await handlerDependencies.appendConversationMessages({
      conversationId,
      messages: [{ role: 'user', content: responseInput }],
      pinned: true,
    });

    if (existingConversationId) {
      console.log(`Reusing existing conversation: ${conversationId} for SBOM upload`);
    } else {
      console.log(`Created new conversation: ${conversationId} for SBOM upload`);
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
          user_email: userEmail ?? null,
          created_at: now,
          updated_at: now,
        });
      } catch (logError) {
        console.error('Error logging file upload:', logError);
        // Continue even if logging fails
      }
    }

    // Clean up the uploaded file
    try {
      fs.unlinkSync(filePath);
    } catch (cleanupError) {
      console.warn('Failed to cleanup uploaded file:', cleanupError);
    }

    res.status(200).json({ 
      success: true,
      conversationId,
      threadId: conversationId,
      fileName: fileName,
      packagesScanned: packagesToScan.length,
      totalPackages: packages.length,
      unrecognizedEcosystemCount,
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
            vulns: result.vulnerabilities.slice(0, 3).map(vuln => ({
              id: vuln.id,
              severity: extractSeverity(vuln),
              summary: vuln.summary || 'No summary available'
            }))
          }))
      }
    });

  } catch (error) {
    if (error instanceof ConversationSequenceConflictError) {
      return res.status(409).json({ error: 'Conversation changed while this upload was submitted' });
    }
    console.error('Upload handler error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: formatOpenAIError(error)
    });
  } finally {
    // Cleanup temporary directory
    try {
      tmpDir.removeCallback();
    } catch (cleanupError) {
      console.warn('Failed to cleanup temp directory:', cleanupError);
    }
  }
  };
}

export default createUploadHandler();
