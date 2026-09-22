#!/usr/bin/env node
// TLS front-end for the E2 staging relay: terminates HTTPS with the
// self-signed staging certificate and forwards to the HTTP relay.
import { readFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const TLS_PORT = Number(process.env.TLS_PORT ?? 8443);
const UPSTREAM = process.env.UPSTREAM ?? 'http://127.0.0.1:8010';

const options = {
  key: readFileSync(join(here, 'tls-key.pem')),
  cert: readFileSync(join(here, 'tls-cert.pem')),
};

const server = createHttpsServer(options, (req, res) => {
  const upstream = httpRequest(
    new URL(req.url, UPSTREAM),
    { method: req.method, headers: { ...req.headers, host: new URL(UPSTREAM).host } },
    upstreamRes => {
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on('error', () => res.writeHead(502).end('upstream unavailable'));
  req.pipe(upstream);
});

server.listen(TLS_PORT, '0.0.0.0', () => {
  console.log(`[e2-tls] https on :${TLS_PORT} -> ${UPSTREAM}`);
});
