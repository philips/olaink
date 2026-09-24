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

Other commands: `/olaink status` reports the pairing and current allowlist.

## Restrict senders (`/olaink allow`)

Anyone who knows your Ola Ink username can address a note to this device by default — the same as an email address. If you only expect notes from your own Supernote (or a short list of trusted accounts), restrict who this device will accept from:

```text
/olaink allow add yourusername
```

- `/olaink allow` or `/olaink allow list` — show the current restriction.
- `/olaink allow add USERNAME` — add one sender to the allowlist.
- `/olaink allow remove USERNAME` — remove one sender.
- `/olaink allow USERNAME [USERNAME...]` — replace the allowlist wholesale.
- `/olaink allow clear` — remove the restriction (accept from anyone again).

Usernames are resolved to the sender's stable account ID at the time you run `/olaink allow`, using the same directory lookup a sender uses to address a note; the resolved ID, not the username string, is what is actually checked (Ola Ink usernames are never reused once retired, so this stays correct even if you rename your own account later). Once configured, **an empty allowlist blocks every sender** — removing your only trusted username does not reopen the inbox to everyone. `/olaink allow clear` is the explicit way back to accepting from anyone.

Filtering happens on `/olaink poll`, before decryption: `fromUserId` is authenticated by the relay itself (it only accepts a send whose `fromUserId` matches the sending device's own account), so a disallowed record is dropped without ever being decrypted or parsed. Blocked records are still consumed (acknowledged) so a disallowed sender cannot pile up an inbox this device will never surface, and each poll reports how many notes were blocked.

## Local security and behavior

- Device identity, session capability, and the sender allowlist are written to `~/.pi/agent/olaink/device.json` with mode `0600`. The PKCS#8 private key is kept locally; the relay receives only its public key and opaque encrypted records. Treat the session token and state file as credentials.
- Polling occurs only on command. A record is acknowledged only after decryption, PDF conversion, and saving succeed (rejected/allowlist-blocked records are acknowledged immediately instead). A conversion failure leaves delivery available for retry.
- PDFs are saved in `~/.pi/agent/olaink/` and page PNGs are sent to the model as user-message image content. The extension currently limits notes to 16 MiB and 20 pages to bound memory and model input.
- The PDF and images are plaintext local outputs. Protect and delete them according to your normal local data-handling policy. Pairing another device does not expose private keys to Ola Ink.
- A Pi agent is often the device most likely to go unpolled for a while. Ola Ink deletes a note automatically 14 days after it was sent if it hasn't been received by every device it was addressed to — including this one, if you haven't run `/olaink poll` — with no way to recover it after that. See [olaink.com/privacy](https://olaink.com/privacy/).

## Publishing a release

The npm package is published from a signed GitHub Actions run. Configure npm trusted publishing for `@olaink/pi-plugin` to trust the `publish-pi-plugin.yml` workflow in `philips/olaink`, then bump the package version and push a matching `pi-plugin-v<version>` tag. The workflow runs the repository checks, verifies the package tarball, and publishes with npm provenance.
