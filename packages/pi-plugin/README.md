# Ola Ink Pi plugin

Receives complete `.note` files sent from a paired Supernote through the Ola Ink encrypted relay. Pi decrypts locally, converts the note with [`supernote-typescript`](https://www.npmjs.com/package/supernote-typescript), saves a searchable PDF, and sends rendered page images into the conversation for the agent to inspect.

## Install

Install the Pi package, then start or restart Pi:

```sh
pi install npm:@olaink/pi-plugin
```

Pi installs the plugin's runtime dependencies and loads its `/olaink` command automatically. Only install packages you trust: a Pi plugin runs with the same permissions as Pi.

### Develop from this repository

After `npm install` at the repository root, install the local package:

```sh
pi install ./packages/pi-plugin
```

For a one-off development run, you can instead use `pi --extension ./packages/pi-plugin/index.ts`.

## Pair

1. In the authenticated Ola Ink dashboard, choose **Pair a device** and create a pairing code. The code is single-use and expires after 10 minutes.
2. In Pi, run:

   ```text
   /olaink pair 1234-5678
   ```

   For a non-production service, pass its origin as the second argument:

   ```text
   /olaink pair 1234-5678 https://relay.example.test
   ```

3. On Supernote, select Pi's device from the recipient directory when sending the note. In Pi, run `/olaink poll` to fetch it and add page images to the current conversation.

Other commands: `/olaink status` reports the pairing.

## Local security and behavior

- Device identity and session capability are written to `~/.pi/agent/olaink/device.json` with mode `0600`. The PKCS#8 private key is kept locally; the relay receives only its public key and opaque encrypted records. Treat the session token and state file as credentials.
- Polling occurs only on command. A record is acknowledged only after decryption, PDF conversion, and saving succeed. A conversion failure leaves delivery available for retry.
- PDFs are saved in `~/.pi/agent/olaink/` and page PNGs are sent to the model as user-message image content. The extension currently limits notes to 16 MiB and 20 pages to bound memory and model input.
- The PDF and images are plaintext local outputs. Protect and delete them according to your normal local data-handling policy. Pairing another device does not expose private keys to Ola Ink.

## Publishing a release

The npm package is published from a signed GitHub Actions run. Configure npm trusted publishing for `@olaink/pi-plugin` to trust the `publish-pi-plugin.yml` workflow in `philips/olaink`, then bump the package version and push a matching `pi-plugin-v<version>` tag. The workflow runs the repository checks, verifies the package tarball, and publishes with npm provenance.
