#!/usr/bin/env node
// Behavioural test for tools/serve.js. Starts the server on port 0 and runs
// a set of requests to assert the expected behaviour. Exit 0 on success,
// 2 with a human-readable failure list otherwise.

const cp = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

const serverModule = path.join(__dirname, 'serve.js');
if (!fs.existsSync(serverModule)) {
  console.error('ERROR: tools/serve.js not found');
  process.exit(2);
}

let failures = [];
function fail(msg) { failures.push(msg); console.error('FAIL:', msg); }
function ok(msg) { console.log('OK:', msg); }

(async function () {
  // start server programmatically by requiring createServer
  const serv = require('./serve.js');
  let server;
  try {
    server = await serv.createServer(path.join(__dirname, '..', 'site'), 0);
  } catch (e) {
    console.error('ERROR: could not start server:', e && e.message);
    process.exit(2);
  }
  const port = server.address().port;
  ok('server started on port ' + port);

  function req(pathname, opts) {
    opts = opts || {};
    const reqOpts = { hostname: '127.0.0.1', port: port, path: pathname, method: opts.method || 'GET' };
    return new Promise((resolve) => {
      const r = http.request(reqOpts, function (res) {
        let body = '';
        res.on('data', (d) => { body += d.toString(); });
        res.on('end', () => { resolve({ status: res.statusCode, headers: res.headers, body: body }); });
      });
      r.on('error', (e) => { resolve({ error: e }); });
      if (opts.body) r.write(opts.body);
      r.end();
    });
  }

  // 1. index.html 200
  let r = await req('/');
  if (r.status === 200) ok('/ -> 200'); else fail('/ -> ' + r.status);

  // 2. /presets/ 200 and contains the gallery markup (check for "preset-grid")
  r = await req('/presets/');
  if (r.status === 200 && r.body.indexOf('preset-grid') !== -1) ok('/presets/ -> 200 and has gallery'); else fail('/presets/ not served correctly');

  // 3. /presets (no trailing slash) -> 301
  r = await req('/presets');
  if (r.status === 301) ok('/presets -> 301'); else fail('/presets did not redirect (status ' + r.status + ')');

  // 4. directory traversal attempts 404
  r = await req('/../README.md');
  if (r.status === 404) ok('.. raw rejected'); else fail('.. raw returned ' + r.status);
  r = await req('/..%2fREADME.md');
  if (r.status === 404) ok('..%2f rejected'); else fail('..%2f returned ' + r.status);

  // 5. HEAD should return headers and no body
  r = await req('/index.html', { method: 'HEAD' });
  if (r.status === 200 && (!r.body || r.body.length === 0)) ok('HEAD returns no body'); else fail('HEAD returned body or bad status');

  // 6. POST rejected
  r = await req('/index.html', { method: 'POST' });
  if (r.status === 405) ok('POST rejected'); else fail('POST returned ' + r.status);

  // 7. content types: .css and .json
  r = await req('/assets/style.css');
  if (r.status === 200 && r.headers['content-type'] && r.headers['content-type'].indexOf('text/css') !== -1) ok('style.css content-type'); else fail('style.css missing or wrong content-type');
  r = await req('/presets/flagship-presets.json');
  if (r.status === 200 && r.headers['content-type'] && r.headers['content-type'].indexOf('application/json') !== -1) ok('json content-type'); else fail('json missing or wrong content-type');

  // shutdown
  server.close(() => {
    if (failures.length) {
      console.error('\nTest failed with', failures.length, 'failure(s)');
      process.exit(2);
    }
    console.log('\nAll tests passed');
    process.exit(0);
  });
})();
