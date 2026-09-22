# E2 disposable relay harness

This harness is only for the `olainknativeexp1` staging experiment. It creates
throwaway keys and a local SQLite database; never point it at production.

## npm targets

From the repository root:

```sh
npm run native:e2:relay:start       # preserves existing disposable state
npm run native:e2:relay:status
npm run native:e2:relay:pin
# One-time host setup, then issue a WebPKI certificate for React Native fetch:
sudo tailscale set --operator="$USER"
npm run native:e2:relay:tailscale-cert
OLAINK_RELAY_HOST=<this-machine>.ts.net npm run native:e2:deploy
npm run native:e2:peer:reset
npm run native:e2:peer:setup
npm run native:e2:peer:pairing
npm run native:e2:peer:send-back
npm run native:e2:relay:stop
```

`native:e2:relay:reset` intentionally deletes the disposable certificate,
database, peer state, and logs before starting a fresh relay. Rebuild and pair
the plugin again after a reset because its TLS pin and server account are new.
`native:e2:build` chooses `tailscale ip -4` by default; set
`OLAINK_RELAY_HOST` when that is not the address reachable from the Nomad.

The lower-level equivalent is:

```sh
cd experiments/native-client-plugin/e2
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout tls-key.pem -out tls-cert.pem -subj '/CN=olaink-e2-staging'
node stub-authgravity.mjs >stub.log 2>&1 & echo $! >stub.pid
cd ../../..
AUTHGRAVITY_WHOAMI_URL=http://127.0.0.1:8011/v1/whoami \
OLAINK_HOST=0.0.0.0 OLAINK_PORT=8010 \
OLAINK_DATABASE=experiments/native-client-plugin/e2/olaink-e2.sqlite \
  bun packages/server/src/main.ts >experiments/native-client-plugin/e2/server.log 2>&1 &
echo $! >experiments/native-client-plugin/e2/server.pid
cd experiments/native-client-plugin/e2
node tls-proxy.mjs >tls.log 2>&1 & echo $! >tls.pid
```

Build the plugin with the host's reachable Tailscale IP and the generated leaf
pin:

```sh
PIN=$(openssl x509 -in tls-cert.pem -outform DER | sha256sum | awk '{print $1}')
cd ../../..
OLAINK_RELAY_BASE=https://<tailscale-ip>:8443 \
OLAINK_RELAY_CERT_SHA256="$PIN" experiments/native-client-plugin/buildPlugin.sh
```

Use the independent WebCrypto peer against `https://127.0.0.1:8443` (Node needs
the explicit temporary self-signed exception):

```sh
cd experiments/native-client-plugin/e2
NODE_TLS_REJECT_UNAUTHORIZED=0 node peer.mjs setup https://127.0.0.1:8443
NODE_TLS_REJECT_UNAUTHORIZED=0 node peer.mjs pairing
NODE_TLS_REJECT_UNAUTHORIZED=0 node peer.mjs receive
NODE_TLS_REJECT_UNAUTHORIZED=0 node peer.mjs send-back
NODE_TLS_REJECT_UNAUTHORIZED=0 node peer.mjs send-tampered
```

`send-tampered` flips an AES-GCM ciphertext bit after normal encryption. The
plugin must report it failed and must not acknowledge it. Stop the three
listeners and delete generated `*.pem`, `*.pid`, `*.log`, peer state, and SQLite
files after each run; they are ignored by Git.
