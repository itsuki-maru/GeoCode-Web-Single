import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureResponse } from './fixtures.mjs';

const repository = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const securitySource = await readFile(resolve(repository, 'src/middleware/security.rs'), 'utf8');
const productionPolicy = /const PRODUCTION_CONTENT_SECURITY_POLICY: &str = "([^"]+)"/.exec(securitySource)?.[1];
if (!productionPolicy) throw new Error('Production Content-Security-Policy was not found');
export function createPrototypeContentSecurityPolicy(allowedOrigins = []) {
  if (!Array.isArray(allowedOrigins)) throw new Error('Allowed origins must be an array');
  for (const value of allowedOrigins) {
    let url;
    try { url = new URL(value); } catch { throw new Error('Invalid HTTPS origin'); }
    if (url.protocol !== 'https:' || url.origin !== value || url.hostname.includes('*') || url.username || url.password)
      throw new Error('Only explicit HTTPS origins are allowed');
  }
  const origins = [...new Set(allowedOrigins)];
  const connect = "connect-src 'self' https://cloudflareinsights.com https://www.jma.go.jp;";
  if (!productionPolicy.includes(connect)) throw new Error('Production connect-src was not found');
  const policy = origins.length
    ? productionPolicy.replace(connect, `${connect.slice(0, -1)} ${origins.join(' ')};`)
    : productionPolicy;
  return `${policy}; worker-src 'self'`;
}

// 既存の自作検証データには、従来の同一オリジン制約を適用する。
export const prototypeContentSecurityPolicy = createPrototypeContentSecurityPolicy();

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.pbf': 'application/x-protobuf', '.wasm': 'application/wasm' };

export async function createPrototypeServer({ root, port = 0, allowedOrigins = [] } = {}) {
  const staticRoot = resolve(root ?? resolve(repository, 'target/vector-basemap-poc/site'));
  const policy = createPrototypeContentSecurityPolicy(allowedOrigins);
  const requests = [];
  let origin;
  const server = createServer(async (request, response) => {
    let pathname = '/';
    const send = (status, type, body) => {
      requests.push({ method: request.method, path: pathname, status });
      response.writeHead(status, {
        'Content-Type': type,
        'Content-Security-Policy': policy,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Cache-Control': 'no-store',
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    try {
      pathname = decodeURIComponent(new URL(request.url, origin).pathname);
      if (!['GET', 'HEAD'].includes(request.method)) return send(405, 'text/plain', 'Method not allowed');
      if (pathname === '/tile-proxy-revision.js')
        return send(200, types['.js'], 'window.__GEOCODE_TILE_PROXY_REVISION__ = null;');
      const fixture = fixtureResponse(pathname, origin);
      if (fixture) return send(fixture.status ?? 200, fixture.type, fixture.body);
      if (pathname.startsWith('/fixtures/')) return send(404, 'text/plain', 'Fixture not found');
      const filename = resolve(staticRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!filename.startsWith(`${staticRoot}${sep}`) || !(await stat(filename)).isFile()) return send(404, 'text/plain', 'Not found');
      send(200, types[extname(filename)] ?? 'application/octet-stream', await readFile(filename));
    } catch (error) {
      send(error.code === 'ENOENT' ? 404 : 400, 'text/plain', 'Not found');
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolveListen);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    server, url: origin, requests, policy,
    close: () => new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const instance = await createPrototypeServer({ root: process.argv[2], port: Number(process.env.PROTOTYPE_PORT || 4187) });
  console.log(`Vector basemap prototype: ${instance.url}`);
}
