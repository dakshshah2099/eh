// Zero-dependency local static server for demo harness & redaction testing
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8080', 10);
const PUBLIC_DIR = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  // Enable CORS for testing
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Mock telemetry endpoint for Ticket 19 redaction eval testing
  if (req.method === 'POST' && req.url.startsWith('/api/telemetry')) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      console.log(`[${new Date().toISOString()}] Intercepted /api/telemetry submission:`);
      try {
        const json = JSON.parse(body);
        console.log(JSON.stringify(json, null, 2));
      } catch {
        console.log(body);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', receivedAt: new Date().toISOString() }));
    });
    return;
  }

  // Static file serving
  const reqUrl = req.url.split('?')[0];
  let relativePath = reqUrl === '/' ? '/index.html' : reqUrl;
  let safePath = path.normalize(path.join(PUBLIC_DIR, relativePath));

  if (!safePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(safePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(safePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    const stream = fs.createReadStream(safePath);
    stream.pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`[Demo Test Harness Server] Running at: http://localhost:${PORT}`);
  console.log(`[Demo Test Harness Server] Serving directory: ${PUBLIC_DIR}`);
});
