# BOMbot - Advanced AI-Powered SBOM Security Analysis Platform

> **Internal Technical Documentation**  
> A hybrid-architecture full-stack security analysis platform that combines intelligent templated responses with advanced AI consultation for comprehensive SBOM vulnerability assessment.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/kakderishikesh/BomBot-Chat)

## System Architecture

BOMbot implements a sophisticated hybrid response system that provides both instant vulnerability analysis and deep AI-powered security consultation:

```
┌─────────────────────────────────────────────────────────────┐
│                     BOMbot Platform                         │
├─────────────────────────────────────────────────────────────┤
│  React UI (Vite)              Next.js API Routes     │
│  ├── ChatInterface.tsx           ├── /api/upload           │
│  ├── PackageQueryForm.tsx        ├── /api/osv-query        │
│  ├── ChatMessage.tsx             ├── /api/chat             │
│  ├── VulnerabilityCards          └── /api/run-status       │
│  └── Real-time Polling                                     │
├─────────────────────────────────────────────────────────────┤
│  Hybrid Response Engine                                 │
│  ├── Quick Templated Responses   ├── AI Thread Management │
│  ├── OSV Data Transformation     ├── Polling Architecture │
│  └── Vulnerability Card Gen.     └── Context Preservation │
└─────────────────┬───────────────────────────────────────────┘
                  │
    ┌─────────────▼─────────────────────────────────────┐
    │              External Integrations                │
    ├───────────────────────────────────────────────────┤
    │  OpenAI GPT-4 Assistant    OSV.dev API      │
    │  ├── Function Calling         ├── Package Queries │
    │  ├── Thread Conversations     ├── CVE Lookups     │
    │  └── Markdown Responses       └── Real-time Data  │
    └───────────────────────────────────────────────────┘
```

## Advanced Features

### **Hybrid Response System**
- **Instant Templated Responses**: Sub-second vulnerability summaries with interactive cards
- **AI Deep Analysis**: Comprehensive security assessment with remediation guidance
- **Seamless Transition**: Users get immediate feedback, then enhanced AI insights
- **Context Preservation**: Maintains conversation flow across response types

### **Intelligent Package Analysis**
- **Multi-Ecosystem Support**: npm, PyPI, Maven, Go, NuGet, RubyGems, Cargo, Composer, Hex, SwiftPM
- **Version-Specific Queries**: Precise vulnerability matching for specific package versions
- **Severity Intelligence**: CVSS score parsing to clean severity levels (CRITICAL/HIGH/MEDIUM/LOW)
- **CVE Cross-Reference**: Direct OSV.dev integration for authoritative vulnerability data

### **SBOM Processing Engine**
- **Multi-Format Support**: SPDX, CycloneDX, Generic JSON schemas
- **Batch Processing**: Concurrent vulnerability scanning with rate limiting
- **Dependency Mapping**: Package ecosystem detection from PURL and metadata
- **Scalable Architecture**: Handles up to 50 packages per SBOM (serverless optimization)

### **Advanced Chat System**
- **Persistent Conversations**: OpenAI Conversations API continuity
- **Real-time Polling**: Non-blocking response delivery with status tracking
- **Markdown Rendering**: Rich formatted responses with proper spacing
- **File Upload Integration**: Drag-and-drop SBOM processing with progress tracking

### **Smart Vulnerability Cards**
- **Interactive UI**: Clickable cards with direct OSV.dev links
- **Severity Visualization**: Color-coded badges with appropriate icons
- **Package Context**: Version-aware vulnerability attribution
- **Export Ready**: Structured data for reporting and integration

## Technical Implementation

### Frontend Architecture (React + TypeScript)

#### **Core Components**
```typescript
// ChatInterface.tsx - Main orchestration component
- File upload handling (drag-and-drop + file picker)
- Real-time message polling with exponential backoff
- Thread management and context preservation
- Hybrid response coordination

// PackageQueryForm.tsx - Package analysis interface  
- Ecosystem selection with validation
- Real-time Google Open Source Vulnerability Database (OSV DB) integration
- Severity extraction and normalization
- Thread setup for AI Deep Dive

// ChatMessage.tsx - Dynamic message rendering
- Markdown vs HTML conditional rendering
- Vulnerability card generation
- Copy-to-clipboard functionality
- Responsive design with accessibility

// VulnerabilityCard Component
- Interactive severity badges
- Direct OSV.dev linking
- Package version display
- Description truncation with expansion
```

#### **State Management**
```typescript
// ChatContext.tsx - Centralized state
interface ChatState {
  messages: Message[];
  isLoading: boolean;
  currentThreadId: string | null;
  uploadedFiles: UploadedFile[];
}

interface Message {
  id: string;
  type: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  vulnerabilities?: Vulnerability[];
  useMarkdown?: boolean; // Controls rendering strategy
}
```

#### **Severity Processing Pipeline**
```typescript
// Enhanced severity extraction with multiple fallbacks
function extractSeverity(vuln: OSVVulnerability): string {
  // 1. CVSS v3 score parsing (primary)
  if (vuln.severity?.find(s => s.type === 'CVSS_V3')) {
    const score = parseFloat(cvssVector.split('/')[0]);
    return scoreToBracket(score); // 9.0+ = CRITICAL, 7.0+ = HIGH, etc.
  }
  
  // 2. Database-specific severity (GHSA, etc.)
  if (vuln.database_specific?.severity) {
    return vuln.database_specific.severity.toUpperCase();
  }
  
  // 3. Content analysis fallback
  return analyzeSeverityFromContent(vuln.summary, vuln.details);
}
```

### Backend Architecture (Next.js API)

#### **API Route Specifications**

##### `/api/upload` - SBOM Processing Pipeline
```typescript
interface UploadFlow {
  1. File validation (type, size, structure)
  2. Multi-format SBOM parsing (SPDX/CycloneDX/Generic)
  3. Package extraction with ecosystem mapping
  4. Batch OSV API queries (rate-limited)
  5. Vulnerability aggregation and severity normalization
  6. OpenAI Conversation creation with structured prompt
  7. Quick summary generation for instant UI response
  8. Thread management for follow-up conversations
}

// Response includes both quick data and AI thread setup
interface UploadResponse {
  success: boolean;
  threadId: string;
  runId: string;
  vulnerabilitiesFound: number;
  quickSummary: QuickSummaryData; // For immediate UI display
  packagesScanned: number;
}
```

##### `/api/osv-query` - Package Intelligence
```typescript
interface QueryCapabilities {
  packageQueries: {
    ecosystems: string[]; // 11 supported ecosystems
    versionSupport: boolean;
    realTimeData: boolean;
  };
  
  cveQueries: {
    directLookup: boolean;
    aliasResolution: boolean;
    affectedPackages: boolean;
  };
  
  aiIntegration: {
    threadAttachment: boolean;
    contextPreservation: boolean;
    followUpQuestions: boolean;
  };
}
```

##### `/api/run-status` - AI Response Polling
```typescript
interface PollingStrategy {
  maxAttempts: 20;           // Configurable timeout
  pollingInterval: 1000;     // 1s for chat, 2s for uploads
  exponentialBackoff: false; // Linear for predictable UX
  silentTimeout: true;       // No timeout messages
  statusTracking: {
    queued: 'waiting';
    in_progress: 'processing';  
    completed: 'success';
    failed: 'error';
  };
}
```

#### **OpenAI Responses Integration**

##### **Function Capabilities**
```typescript
interface AssistantFunctions {
  query_package_vulnerabilities: {
    description: "Real-time OSV database package queries";
    parameters: {
      name: string;
      ecosystem: EcosystemType;
      version?: string;
    };
  };
  
  query_cve_details: {
    description: "CVE-specific vulnerability lookups";
    parameters: {
      cve_id: string; // CVE-YYYY-NNNN format
    };
  };
  
  analyze_sbom_package: {
    description: "Deep-dive SBOM component analysis";
    parameters: {
      package_name: string;
      include_dependencies?: boolean;
    };
  };
}
```

##### **Response Quality Control**
```typescript
interface ResponsesConfig {
  model: "gpt-4o";            // Or the OPENAI_MODEL value
  instructions: string;       // Comprehensive security expert prompt
  tools: ResponseFunction[];
  background: true;           // Preserve status polling
  conversation: string;       // Durable multi-turn state
}
```

## Configuration & Deployment

### Environment Variables
```bash
# Required - OpenAI Integration
OPENAI_API_KEY=sk-proj-xxxxx           # OpenAI API access
OPENAI_MODEL=gpt-4o                    # Responses API model (compatibility default)

# Optional - Development
OSV_SCANNER_PATH=/usr/local/bin/osv-scanner  # Local binary path
NODE_ENV=production                     # Runtime environment
```

### Retention Modes

`RETENTION` records the policy under which each conversation runs and accepts two values:

- `study` is the configuration default and rollback mode. It retains encrypted raw session content under the applicable IRB protocol and participant consent. It is not the fielded participant mode.
- `ephemeral` is the fielded participant mode. Raw session content becomes unrecoverable within 24 hours of the participant's last activity by destroying its per-session encryption key.

Key destruction after the idle window is owned by the retention scheduler and is not implemented in this increment; until that scheduler is deployed, selecting `ephemeral` records the intended policy but does not by itself enforce the 24-hour deadline.

### Derived Session Measures (Callable, No Caller)

INC-12c-2 provides `extractAndStoreSessionMeasures(sessionId)` in `lib/db/sessionMeasures.ts`, backed by the per-session pass in `lib/measures/`. It has **no production caller** and performs **zero per-turn work**. INC-12c-3 will invoke it before destroying a key; failures must prevent destruction. No retention window, deletion or expiry is implemented here.

The pass reads full stored history, unions primary identifiers from all pinned pre-scans in the session, and counts advisory-identifier occurrences in assistant text (including repeated Markdown labels/destinations, as in the evaluation harness). It resolves aliases against the local snapshot only, never through HTTP. A configured snapshot-pin mismatch or missing snapshot is recorded as unavailable; absent/invalid scans are explicitly unresolved rather than negative evidence.

`session_measures` retains only counts and completed categorical resolution outcomes (direct, alias-grounded, resolved-ungrounded, not-found, unresolved), not identifier strings, messages, filenames, hashes or package lists. These categories store the resolution result immediately; no later lookup is needed. Each result carries the reference definition, separate scan-source and resolution-source provenance, and scan coverage. Scan source is explicitly `unknown` for every session in this increment; known coverage is read from the stored pre-scan. INC-12c-2.1 owns future scan-source capture. Multiple scans retain separate coverage entries.

Reading, local resolution and storage share a repeatable-read transaction. Re-running the pass replaces that session's result using the then-current local snapshot and records its source anew; a stored result itself needs no corpus to interpret. The date-granular snapshot pin cannot distinguish different ingests on the same date. The measure row has no cascading foreign key to raw content, so future content removal does not remove the result.

### OpenAI Responses Configuration
```yaml
Responses API:
  model: "gpt-4o"
  state: "Conversations API"
  background: true
  
Instructions: |
  You are BOMbot, an expert cybersecurity analyst specializing in SBOM analysis and vulnerability assessment. 
  
  Core Capabilities:
  1. Real-time vulnerability research using OSV.dev database
  2. Comprehensive security analysis with business impact assessment
  3. Prioritized remediation recommendations
  4. Interactive security consultation with context preservation
  
  Link Standards:
  - ALWAYS use OSV.dev links: https://osv.dev/vulnerability/{ID}
  - NEVER reference NVD or other databases for links
  - Maintain consistency across all vulnerability references
  
  Response Structure:
  - Quick summaries for initial queries (brief, actionable)
  - Detailed analysis when requested (comprehensive, prioritized)
  - Clear severity communication (CRITICAL/HIGH/MEDIUM/LOW)
  - Specific remediation steps with version numbers
  
  Function Usage:
  - Proactively query packages when mentioned
  - Cross-reference CVEs automatically
  - Provide current vulnerability data
  - Maintain conversation context across queries

Functions:
  - query_package_vulnerabilities(name, ecosystem, version?)
  - query_cve_details(cve_id)
  - analyze_sbom_package(package_name, include_dependencies?)
```

## Performance Metrics

### Bundle Analysis
```
Production Build:
├── UI Assets
│   ├── JavaScript: 520KB → 163KB gzipped (-69%)
│   ├── CSS: 90KB → 14KB gzipped (-84%)
│   └── Total: 177KB gzipped (acceptable for feature set)
│
├── API Routes
│   ├── Shared Runtime: 79.7KB
│   ├── Cold Start: <2s on Vercel
│   └── Memory Usage: ~128MB per function
│
└── External Dependencies
    ├── React/UI: ~40KB gzipped
    ├── OpenAI SDK: ~35KB gzipped  
    ├── Form Processing: ~25KB gzipped
    └── Markdown Rendering: ~20KB gzipped
```

### Runtime Performance
```
Response Times (95th percentile):
├── Package Queries: <500ms (OSV API latency)
├── SBOM Processing: 2-8s (size dependent)
├── AI Responses: 5-30s (complexity dependent)
├── Real-time Polling: 1s intervals
└── UI Interactions: <100ms (client-side)

Scalability Limits:
├── File Size: 10MB (Vercel function limit)
├── SBOM Packages: 50 (rate limiting optimization)
├── Concurrent Users: Unlimited (serverless)
└── API Rate Limits: OpenAI tier dependent
```

## Usage Patterns

### Enterprise SBOM Analysis
```typescript
// Typical enterprise workflow
1. Upload company SBOM file (SPDX/CycloneDX)
2. Receive instant vulnerability summary with priority rankings
3. Review interactive vulnerability cards with OSV.dev links
4. Ask AI: "What should we prioritize for our next sprint?"
5. Get detailed remediation plan with business impact assessment
6. Export findings for security team review
```

### Developer Package Research
```typescript
// Developer security research workflow  
1. Query specific package: "Is express 4.17.1 safe?"
2. Get immediate vulnerability status with severity badges
3. Ask follow-up: "What about the latest version?"
4. Receive comparative analysis with upgrade recommendations
5. Deep-dive: "Give me detailed analysis of these vulnerabilities"
6. Get technical implementation guidance
```

## Development Workflow

### Local Development Setup
```bash
# Complete development environment
git clone https://github.com/kakderishikesh/BomBot-Chat.git
cd BomBot-Chat

# Install dependencies
npm install

# Environment setup
cp .env.example .env
# Configure OPENAI_API_KEY and OPENAI_MODEL

# Optional: Install OSV Scanner locally
brew install osv-scanner  # macOS

# Start development servers
npm run dev          # Full-stack development (recommended)
```

### Development Commands
```bash
# Development
npm run dev          # Full-stack with hot reload
npm run dev:ui       # UI development server only

# Building
npm run build        # Production build (UI + API)
npm run build:ui     # UI build only
npm run build:api    # API build only

# Quality Assurance
npm run type-check   # TypeScript validation
npm run lint         # Code quality checks
```

## Security Features

### Data Handling
```typescript
Security Measures:
├── File Processing
│   ├── Temporary file creation in isolated containers
│   ├── Automatic cleanup after processing
│   ├── Size and type validation (10MB limit)
│   └── No persistent storage of uploaded content
│
├── API Security  
│   ├── Environment variable encryption (Vercel)
│   ├── No API key exposure to client
│   ├── Request validation and sanitization
│   └── Rate limiting on OSV API calls
│
├── OpenAI Integration
│   ├── Isolated thread creation per session
│   ├── Function call validation
│   └── Response content filtering
│
└── Client-Side Security
    ├── Secure API communication (HTTPS)
    ├── Input validation on all forms
    └── XSS protection via React's built-in escaping
```

## Key Features Summary

### **Current Capabilities**
- **Hybrid Response System**: Instant templated responses + AI deep analysis
- **Multi-Format SBOM Support**: SPDX, CycloneDX, Generic JSON
- **11 Package Ecosystems**: npm, PyPI, Maven, Go, NuGet, RubyGems, etc.
- **Real-time OSV.dev Integration**: Authoritative vulnerability data
- **Clean Severity Tags**: CRITICAL/HIGH/MEDIUM/LOW (not CVSS vectors)
- **Interactive Vulnerability Cards**: Clickable, exportable, OSV.dev linked
- **Persistent AI Conversations**: Thread-based context preservation
- **Markdown Rich Responses**: Properly formatted AI analysis
- **Drag-and-Drop File Upload**: 10MB limit with progress tracking
- **Silent Polling**: No timeout interruptions for better UX

### **Technical Stack**
- **Frontend**: React 18 + TypeScript + Vite + TailwindCSS + Radix UI
- **Backend**: Next.js 14 + TypeScript + OpenAI API + OSV.dev API
- **Deployment**: Vercel Serverless with optimized build pipeline
- **AI**: GPT-4o through the Responses and Conversations APIs
- **State Management**: React Context with custom hooks
- **File Processing**: Multi-format parsing with batch vulnerability scanning

---

## Quick Start

1. **Deploy**: [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/kakderishikesh/BomBot-Chat)
2. **Configure**: Add `OPENAI_API_KEY` and `OPENAI_MODEL` to the Vercel environment
3. **Use**: Upload SBOM files and start chatting with your AI security expert!

---

## License

This project is licensed under the **Mozilla Public License 2.0** - see the [LICENSE](LICENSE) file for details.

### Key License Features:
- **Open Source**: Free to use, modify, and distribute
- **Copyleft**: Modifications must be shared under the same license
- **Patent Protection**: Includes patent licensing provisions
- **Commercial Use**: Allowed with proper attribution
- **Compatible**: Works with many other open source licenses

For more information about MPL-2.0, visit: https://mozilla.org/MPL/2.0/

---

*Last Updated: October 2025 | Version: 2.0.0*
