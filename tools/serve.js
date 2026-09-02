#!/usr/bin/env node
// Minimal zero-dependency static file server for Node 18+.
// Usage: node tools/serve.js [root] [port]

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

function contentTypeFor(ext) {
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml; charset=utf-8';
    case '.ico': return 'image/x-icon';
    case '.txt': return 'text/plain; charset=utf-8';
    case '.md': return 'text/markdown; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

function makeHandler(root) {
  root = path.resolve(root || 'site');

  return async function handler(req, res) {
    try {
      // Allow only GET and HEAD
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(req.method + ' not allowed');
        return;
      }

      const parsed = url.parse(req.url || '/');
      let rawPath = parsed.pathname || '/';

      // Reject malformed percent-escapes
      try {
        rawPath = decodeURIComponent(rawPath);
      } catch (e) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Not found');
        return;
      }

      // Reject NUL bytes
      if (rawPath.indexOf('\0') !== -1) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Not found');
        return;
      }

      // Construct fs path and prevent traversal
      const joined = path.join(root, '.' + rawPath);
      const normalized = path.normalize(joined);

      if (!normalized.startsWith(root + path.sep) && normalized !== root) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Not found');
        return;
      }

      let stat;
      try {
        stat = await fs.promises.stat(normalized);
      } catch (e) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Not found');
        return;
      }

      if (stat.isDirectory()) {
        // If path doesn't end with slash, redirect to path + '/'
        if (!rawPath.endsWith('/')) {
          res.statusCode = 301;
          res.setHeader('Location', rawPath + '/');
          res.end('Moved permanently');
          return;
        }
        // Serve index.html inside directory
        const indexPath = path.join(normalized, 'index.html');
        try {
          const istat = await fs.promises.stat(indexPath);
          if (!istat.isFile()) throw new Error('no index');
          const ext = '.html';
          res.statusCode = 200;
          res.setHeader('Content-Type', contentTypeFor(ext));
          if (req.method === 'HEAD') return res.end();
          const rs = fs.createReadStream(indexPath);
          rs.pipe(res);
          return;
        } catch (e) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Not found');
          return;
        }
      }

      // Serve a file
      if (!stat.isFile()) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Not found');
        return;
      }

      const ext = path.extname(normalized).toLowerCase();
      res.statusCode = 200;
      res.setHeader('Content-Type', contentTypeFor(ext));
      if (req.method === 'HEAD') return res.end();
      const rs = fs.createReadStream(normalized);
      rs.on('error', function () {
        if (!res.headersSent) res.statusCode = 500;
        try { res.end('Internal error'); } catch (e) {}
      });
      rs.pipe(res);
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Internal error');
      } else {
        try { res.end(); } catch (e) {}
      }
    }
  };
}

function createServer(root, port) {
  const handler = makeHandler(root);
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.on('error', function (err) {
      reject(err);
    });
    server.listen(port, function () {
      resolve(server);
    });
  });
}

if (require.main === module) {
  const root = process.argv[2] || 'site';
  const port = parseInt(process.argv[3] || process.env.PORT || '5003', 10);
  createServer(root, port).then((server) => {
    const addr = server.address();
    console.log('Serving', path.resolve(root), 'on port', addr.port);
    server.on('error', function (err) {
      if (err && err.code === 'EADDRINUSE') {
        console.error('ERROR: port ' + port + ' already in use');
        process.exit(1);
      }
    });
    process.on('SIGINT', function () {
      console.log('\nShutting down...');
      server.close(function () { process.exit(0); });
    });
  }).catch(function (err) {
    if (err && err.code === 'EADDRINUSE') {
      console.error('ERROR: port ' + (process.argv[3] || '5003') + ' already in use');
      process.exit(1);
    }
    console.error('ERROR: could not start server:', err && err.message);
    process.exit(1);
  });
} else {
  // when required, export the createServer function
  module.exports = { createServer };
}
