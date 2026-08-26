import fs from 'node:fs';

const interceptorFlag = Symbol.for('bombot.ledger.fetch-interceptor');

function addMarker(markers, value) {
  if (typeof value === 'string' && value.length >= 3) {
    markers.add(value);
  }
}

export function extractFixtureMarkers(fixture) {
  const markers = new Set();

  for (const pkg of fixture.packages || []) {
    addMarker(markers, pkg.name);
    addMarker(markers, pkg.versionInfo || pkg.version);
    addMarker(markers, pkg.SPDXID);
    for (const reference of pkg.externalRefs || []) {
      if (reference.referenceType === 'purl') addMarker(markers, reference.referenceLocator);
    }
  }

  for (const component of fixture.components || []) {
    addMarker(markers, component.name);
    addMarker(markers, component.version);
    addMarker(markers, component['bom-ref']);
    addMarker(markers, component.purl);
  }

  return [...markers].sort((left, right) => right.length - left.length);
}

async function bodyToText(input, init) {
  const body = init?.body;

  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString('utf8');
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8');
  }
  if (body instanceof Blob) return body.text();
  if (body !== undefined && body !== null) return String(body);

  if (input instanceof Request && input.body) {
    return input.clone().text();
  }

  return '';
}

function logicalDestination(transportUrl, sinkOrigin) {
  const parsed = new URL(transportUrl);
  const sink = sinkOrigin ? new URL(sinkOrigin) : null;

  if (sink && parsed.origin === sink.origin) {
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments[0] === 'proxy' && segments[1]) {
      const host = decodeURIComponent(segments[1]);
      const path = `/${segments.slice(2).join('/')}`;
      return {
        host,
        url: `https://${host}${path}${parsed.search}`,
      };
    }
  }

  return { host: parsed.host, url: parsed.href };
}

function isLoopback(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

export function installFetchInterceptor({
  fixturePath = process.env.LEDGER_FIXTURE_PATH,
  logPath = process.env.LEDGER_INTERCEPT_LOG,
  sinkOrigin = process.env.LEDGER_SINK_ORIGIN,
  blockExternal = process.env.LEDGER_BLOCK_EXTERNAL === '1',
} = {}) {
  if (globalThis[interceptorFlag]) return globalThis[interceptorFlag];
  if (!fixturePath || !logPath) return null;

  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const markers = extractFixtureMarkers(fixture);
  const originalFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async function ledgerFetch(input, init = undefined) {
    const transportUrl = input instanceof Request ? input.url : String(input);
    const transport = new URL(transportUrl);
    const method = init?.method || (input instanceof Request ? input.method : 'GET');
    const body = await bodyToText(input, init);
    const destination = logicalDestination(transportUrl, sinkOrigin);
    const matchedMarkers = markers.filter(marker => body.includes(marker));
    const record = {
      timestamp: new Date().toISOString(),
      method: method.toUpperCase(),
      url: destination.url,
      host: destination.host,
      transportUrl,
      transportHost: transport.host,
      requestBodySize: Buffer.byteLength(body),
      matchedMarkers,
      classification: matchedMarkers.length > 0
        ? 'CARRIES_INVENTORY'
        : 'INVENTORY_INDEPENDENT',
    };

    fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`);

    if (blockExternal && !isLoopback(transport.hostname)) {
      throw new Error(`Ledger blocked non-loopback transport to ${transport.host}`);
    }

    return originalFetch(input, init);
  };

  globalThis[interceptorFlag] = { markers, originalFetch };
  return globalThis[interceptorFlag];
}

installFetchInterceptor();
