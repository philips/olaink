# Ola Ink Pi extension

Receives complete `.note` files sent from a paired Supernote through the Ola Ink encrypted relay. Pi decrypts locally, converts the note with [`supernote-typescript`](https://www.npmjs.com/package/supernote-typescript), saves a searchable PDF, and sends rendered page images into the conversation for the agent to inspect.

## Install / run locally

From this repository, install the package dependency and load the extension:

```sh
npm install
pi --extension ./packages/pi-plugin/index.ts
```

The package is TypeScript and uses the extension runtime's `jiti` loader. No background polling is used; use `/olaink poll` while Pi is running.

## Pair

1. Create an Ola Ink pairing code for this Pi device from the authenticated Ola Ink pairing screen/API.
2. In Pi, run:

   ```text
   /olaink pair 1234-5678
   ```

   For a non-production service, pass its origin as the second argument:

   ```text
   /olaink pair 1234-5678 https://relay.example.test
   ```

3. On Supernote, select Pi's device from the recipient directory when sending the note. In Pi, run `/olaink poll` to fetch it and add page images to the current conversation.

Other commands: `/olaink status` reports the pairing. A pairing code is single-use and expires; request another if it fails.

## Local security and behavior

- Device identity and session capability are written to `~/.pi/agent/olaink/device.json` with mode `0600`. The PKCS#8 private key is kept locally; the relay receives only its public key and opaque encrypted records. Treat the session token and state file as credentials.
- Polling occurs only on command. A record is acknowledged only after decryption, PDF conversion, and saving succeed. A conversion failure leaves delivery available for retry.
- PDFs are saved in `~/.pi/agent/olaink/` and page PNGs are sent to the model as user-message image content. The extension currently limits notes to 16 MiB and 20 pages to bound memory and model input.
- The PDF and images are plaintext local outputs. Protect and delete them according to your normal local data-handling policy. Pairing another device does not expose private keys to Ola Ink.
