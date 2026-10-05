// Owner: Sean. Local-only transport; no global fetch/unsafe-port settings change.
import http from 'node:http';
import https from 'node:https';

export function loopbackOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('A credential-free loopback origin is required.');
  return url.origin;
}

// Node's native HTTP client supports local 4190, unlike fetch's WHATWG bad-port
// list. This adapter never follows redirects and never connects off-loopback.
export async function loopbackFetch(input, options = {}) {
  const url = new URL(input);
  loopbackOrigin(url.origin);
  if (url.username || url.password || url.hash) throw new Error('Invalid local request URL.');
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(url, { method: options.method || 'GET', headers: options.headers, signal: options.signal }, response => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400) {
        response.resume();
        reject(new Error('Local HTTP redirects are rejected.'));
        return;
      }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('Local response was interrupted.')));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status, ok: status >= 200 && status < 300, headers: response.headers, async json() { return JSON.parse(body); } });
      });
    });
    request.on('error', reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}
