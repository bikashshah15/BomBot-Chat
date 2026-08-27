import http from 'node:http';

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Connection': 'close',
  });
  response.end(body);
}

function syntheticVulnerability(name, ecosystem, id = 'GHSA-ledger-0000-0000') {
  return {
    id,
    summary: `Synthetic vulnerability for ${name}`,
    details: 'Synthetic OSV prose used only by the local egress ledger harness.',
    aliases: id.startsWith('CVE-') ? [] : ['CVE-2099-0001'],
    modified: '2026-08-25T00:00:00Z',
    published: '2026-08-25T00:00:00Z',
    affected: [{
      package: { name, ecosystem },
      ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '99.0.0' }] }],
      versions: [],
    }],
    references: [{ type: 'ADVISORY', url: `https://osv.dev/vulnerability/${id}` }],
    database_specific: { synthetic: true },
  };
}

function openAIResponse(id) {
  return {
    id,
    object: 'response',
    created_at: 1787616000,
    completed_at: 1787616001,
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    model: 'gpt-4o',
    output_text: 'Synthetic ledger assistant response.',
    output: [{
      id: `msg_${id}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{
        type: 'output_text',
        text: 'Synthetic ledger assistant response.',
        annotations: [],
      }],
    }],
    parallel_tool_calls: true,
    temperature: 1,
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    conversation: null,
    usage: {
      input_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 2,
    },
  };
}

function openAIToolResponse(id) {
  return {
    ...openAIResponse(id),
    output_text: '',
    output: [{
      id: `fc_${id}`,
      type: 'function_call',
      status: 'completed',
      call_id: `call_${id}`,
      name: 'query_package_vulnerabilities',
      arguments: JSON.stringify({
        name: 'lodash',
        ecosystem: 'npm',
        version: '4.17.20',
      }),
    }],
  };
}

export async function startLedgerSink() {
  const requests = [];
  let responseCounter = 0;

  const server = http.createServer(async (request, response) => {
    try {
      const body = await readRequestBody(request);
      const parsedUrl = new URL(request.url || '/', 'http://127.0.0.1');
      const segments = parsedUrl.pathname.split('/').filter(Boolean);
      const logicalHost = segments[0] === 'proxy' && segments[1]
        ? decodeURIComponent(segments[1])
        : '127.0.0.1';
      const logicalPath = `/${segments.slice(2).join('/')}`;

      requests.push({
        timestamp: new Date().toISOString(),
        method: request.method || 'GET',
        path: logicalPath,
        host: logicalHost,
        headers: request.headers,
        body,
      });

      if (logicalHost === 'api.openai.com' && logicalPath === '/v1/responses' && request.method === 'POST') {
        const requestBody = body ? JSON.parse(body) : {};
        responseCounter += 1;
        const id = `resp_ledger_${responseCounter}`;
        const requestsLodashTool = requestBody.input?.some(item => (
            item.role === 'user'
            && item.content === 'What vulnerabilities affect lodash 4.17.20?'
          )) && !requestBody.input?.some(item => item.type === 'function_call_output');
        const value = requestsLodashTool
          ? openAIToolResponse(id)
          : openAIResponse(id);
        return sendJson(response, 200, value);
      }

      if (logicalHost === 'api.osv.dev' && logicalPath === '/v1/query' && request.method === 'POST') {
        const query = body ? JSON.parse(body) : {};
        const name = query.package?.name || 'synthetic-package';
        const ecosystem = query.package?.ecosystem || 'npm';
        const vulnerable = new Map([
          ['lodash@4.17.20', 'GHSA-ledger-lodash'],
          ['minimist@1.2.5', 'GHSA-ledger-minimist'],
          ['axios@0.21.1', 'GHSA-ledger-axios'],
        ]);
        const id = vulnerable.get(`${name}@${query.version}`);
        return sendJson(response, 200, {
          vulns: id ? [syntheticVulnerability(name, ecosystem, id)] : [],
        });
      }

      if (logicalHost === 'api.osv.dev' && logicalPath.startsWith('/v1/vulns/') && request.method === 'GET') {
        const id = decodeURIComponent(logicalPath.slice('/v1/vulns/'.length));
        return sendJson(response, 200, syntheticVulnerability('lodash', 'npm', id));
      }

      if (logicalHost.endsWith('.supabase.co') && logicalPath.startsWith('/rest/v1/chat_logs')) {
        response.writeHead(request.method === 'POST' ? 201 : 204, {
          'Content-Type': 'application/json',
          'Connection': 'close',
        });
        return response.end(request.method === 'POST' ? '[]' : '');
      }

      return sendJson(response, 404, {
        error: `No synthetic sink response for ${request.method} ${logicalHost}${logicalPath}`,
      });
    } catch (error) {
      return sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Ledger sink did not expose a TCP address');

  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}
