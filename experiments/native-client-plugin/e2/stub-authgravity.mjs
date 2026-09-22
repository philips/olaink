#!/usr/bin/env node
// Minimal AuthGravity /v1/whoami stub for the E2 staging relay.
// Accepts exactly one bearer token and maps it to one subject.
import { createServer } from 'node:http';

const PORT = Number(process.env.STUB_PORT ?? 8011);
const TOKEN = 'e2-stub-token';
const SUBJECT = 'e2-subject-1';

const server = createServer((req, res) => {
  if (req.url !== '/v1/whoami') {
    res.writeHead(404).end();
    return;
  }
  const auth = req.headers.authorization ?? '';
  if (auth !== `Bearer ${TOKEN}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid session' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ user_id: SUBJECT }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[e2-stub] whoami stub on http://127.0.0.1:${PORT} (token ${TOKEN})`);
});
