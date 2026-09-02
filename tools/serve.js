#!/usr/bin/env node
'use strict';
/*
 * tools/serve.js — the repository's own static file server.
 *
 * Usage:  node tools/serve.js [directory] [port]
 *         node tools/serve.js                 # serves site/ on http://localhost:5003
 *         node tools/serve.js . 8000          # serves the repository root on port 8000
 *         node tools/serve.js --dir=site --port=5003
 *
 * Needs: Node 18 or newer. No npm packages, ever — this file exists so that starting
 * the public site never downloads anything. The site's own contract is "no build step,
 * no external assets, works completely offline"; the server that ships it obeys the
 * same rule.
 *
 * Behaviour that matters to this site:
 *  - a request for a directory is served from that directory's index.html and the URL
 *    keeps its trailing slash. /presets/ and /presets/index.html both work and neither
 *    is collapsed to /presets — collapsing it is exactly what serve.json's
 *    "cleanUrls": false exists to prevent, because every same-directory relative
 *    reference on that page would then resolve one level too high;
 *  - /presets (no trailing slash, a real directory) gets a 301 to /presets/, which is
 *    the redirect that keeps relative links resolving correctly;
 *  - any path that would escape the served root is refused with a 404, so ../README.md
 *    or an encoded %2e%2e cannot be read;
 *  - content types are sent for the file kinds this repository actually contains;
 *    anything else is sent as application/octet-stream rather than refused.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_DIR = 'site';
const DEFAULT_PORT = 5003;

const NUL = String.fromCharCode(0);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
};
const FALLBACK_TYPE = 'application/octet-stream';

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  let dir = DEFAULT_DIR;
  let port = DEFAULT_PORT;
  const unknown = [];

  for (const raw of argv) {
    const arg = String(raw);
    let m;
    if ((m = /^--port=(.+)$/.exec(arg))) { port = Number(m[1]); continue; }
    if ((m = /^--dir=(.*)$/.exec(arg))) { dir = m[1] || '.'; continue; }
    if (/^\d+$/.test(arg)) { port = Number(arg); continue; }
    if (arg.charAt(0) === '-') { unknown.push(arg); continue; }
    dir = arg;
  }
  return { dir: dir, port: port, unknown: unknown };
}

// ------------------------------------------------------------------ helpers

function sendText(res, status, body, method) {
  const buf = Buffer.from(body, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store'
  });
  if (method === 'HEAD') return res.end();
  res.end(buf);
}

/*
 * Resolve a URL path inside the served root, or return null when it escapes it.
 * URL paths always start with "/", so posix normalisation clamps any ".." at the
 * top; the prefix test at the end is the belt to that pair of braces.
 */
function safeResolve(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch (err) {
    return null;                       // a broken %-escape is not a path
  }
  if (decoded.indexOf(NUL) !== -1) return null;
  if (decoded.charAt(0) !== '/') decoded = '/' + decoded;

  const normalised = path.posix.normalize(decoded);
  if (normalised === '..' || normalised.indexOf('../') === 0) return null;

  const full = path.resolve(root, '.' + normalised);
  if (full !== root && full.indexOf(root + path.sep) !== 0) return null;
  return full;
}

function serveFile(res, file, method, done) {
  fs.stat(file, function (err, st) {
    if (err || !st.isFile()) {
      sendText(res, 404, '404 Not Found\n', method);
      return done(404);
    }
    const type = TYPES[path.extname(file).toLowerCase()] || FALLBACK_TYPE;
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Last-Modified': st.mtime.toUTCString(),
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    if (method === 'HEAD') {
      res.end();
      return done(200);
    }
    const stream = fs.createReadStream(file);
    stream.on('error', function () { res.destroy(); });
    stream.pipe(res);
    done(200);
  });
}

// -------------------------------------------------------------------- server

function createServer(root) {
  return http.createServer(function (req, res) {
    const method = req.method || 'GET';
    const raw = req.url || '/';
    const urlPath = raw.split('#')[0].split('?')[0] || '/';
    const query = raw.indexOf('?') === -1 ? '' : raw.slice(raw.indexOf('?'));

    const log = function (status) {
      console.log('  ' + method + ' ' + urlPath + ' -> ' + status);
    };

    if (method !== 'GET' && method !== 'HEAD') {
      sendText(res, 405, '405 Method Not Allowed\n', method);
      return log(405);
    }

    const full = safeResolve(root, urlPath);
    if (!full) {
      sendText(res, 404, '404 Not Found\n', method);
      return log(404);
    }

    fs.stat(full, function (err, st) {
      if (err) {
        sendText(res, 404, '404 Not Found\n', method);
        return log(404);
      }
      if (st.isDirectory()) {
        // Keep the directory level in the URL: redirect /presets to /presets/ and
        // then serve /presets/index.html. index.html is never rewritten away.
        if (urlPath.charAt(urlPath.length - 1) !== '/') {
          res.writeHead(301, {
            Location: urlPath + '/' + query,
            'Content-Length': 0,
            'Cache-Control': 'no-store'
          });
          res.end();
          return log(301);
        }
        return serveFile(res, path.join(full, 'index.html'), method, log);
      }
      return serveFile(res, full, method, log);
    });
  });
}

// ---------------------------------------------------------------------- main

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.unknown.length) {
    console.error('serve: unknown option(s): ' + args.unknown.join(', '));
    console.error('usage: node tools/serve.js [directory] [port]');
    process.exit(2);
  }
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
    console.error('serve: port must be a whole number between 1 and 65535 (got "' + args.port + '")');
    process.exit(2);
  }

  const root = path.resolve(REPO_ROOT, args.dir);
  let st;
  try {
    st = fs.statSync(root);
  } catch (err) {
    console.error('serve: no such directory: ' + root);
    process.exit(2);
  }
  if (!st.isDirectory()) {
    console.error('serve: not a directory: ' + root);
    process.exit(2);
  }

  const server = createServer(root);

  server.on('error', function (err) {
    if (err && err.code === 'EADDRINUSE') {
      console.error('serve: port ' + args.port + ' is already in use. Stop the other process, ' +
        'or run: node tools/serve.js ' + args.dir + ' <other-port>');
    } else {
      console.error('serve: ' + (err && err.message ? err.message : String(err)));
    }
    process.exit(1);
  });

  server.listen(args.port, function () {
    const shown = path.relative(REPO_ROOT, root).split(path.sep).join('/') || '.';
    console.log('SOUNDSHOP — serving ' + shown + '/ at http://localhost:' + args.port + '/');
    console.log('No packages, no network. Ctrl-C to stop.');
  });

  const stop = function () {
    console.log('\nserve: stopping.');
    server.close(function () { process.exit(0); });
    // Do not hang on a keep-alive connection.
    setTimeout(function () { process.exit(0); }, 500).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) main();

module.exports = {
  parseArgs: parseArgs,
  safeResolve: safeResolve,
  createServer: createServer,
  TYPES: TYPES
};
