# Ola Ink Pi plugin

Receives complete `.note` files sent from a paired Supernote through the Ola Ink encrypted relay. Pi decrypts locally, converts the note with [`supernote-typescript`](https://www.npmjs.com/package/supernote-typescript), saves a searchable PDF, and sends rendered page images into the conversation for the agent to inspect.

## Install

Install the Pi package, then start or restart Pi:

```sh
pi install npm:@olaink/pi-plugin
```

Pi installs the plugin's runtime dependencies and loads its `/olaink` command automatically. Only install packages you trust: a Pi plugin runs with the same permissions as Pi.

## Pair

**We recommend a separate Ola Ink account and recognizable username rather than your personal address. For example, username-clanker is a good way to differentiate the accounts.**

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

## Conversation mode (`/olaink converse`)

Conversation mode turns Pi into a pen pal. You write a note on your Supernote and send it to Pi's username. Pi reads it and answers, and the answer comes back to your Supernote as a `.note`. You write the next note, and so on.

```text
/olaink converse on yourusername   # allow yourusername, then start
/olaink converse                   # what is it doing?
/olaink converse off
```

While it is on, Pi does the following:

- **Polls** every 20 seconds, and only while it is idle. It never interrupts you or a running agent.
- **Handles one note at a time.** Pi shows the agent the page images, plus any exact text from typed text boxes and recognized handwriting.
- **Takes the agent's final message as the answer.** Pi typesets it into editable Supernote text boxes, one per page, capped at 10 pages. It sends the result back to the sender as `Re-<name>.note`.

On the Supernote, the reply appears in the Ola Ink inbox. It saves to `Note/OlaInk/` like any received note, and the text boxes can be edited there.

- **An allowlist is required.** Every received note becomes a prompt to an agent that can use tools. Pi therefore refuses to start conversation mode until the sender allowlist names who may write to it. Replies only ever go back to the allowlisted sender, and the reply address is checked again before sending.
- **Pi must keep running.** Polling happens only while this Pi session is open; run it in `tmux` for a long conversation. Notes that arrive while Pi is closed wait on the relay.
- **Nothing is lost if Pi stops mid-answer.** Each note is saved (decrypted, mode `0600`) under `~/.pi/agent/olaink/conversation/` before the relay is told to forget it. The same place keeps a journal and a copy of every reply. `/olaink converse on` resumes interrupted notes first; `/olaink converse drop` abandons them.
- `/olaink reply USERNAME TEXT` sends a one-off typeset note to an allowlisted user.

## Local security and behavior

- Device identity, session capability, and the sender allowlist are written to `~/.pi/agent/olaink/device.json` with mode `0600`. The PKCS#8 private key is kept locally; the relay receives only its public key and opaque encrypted records. Treat the session token and state file as credentials.
- Polling occurs only on command. A record is acknowledged only after decryption, PDF conversion, and saving succeed (rejected/allowlist-blocked records are acknowledged immediately instead). A conversion failure leaves delivery available for retry.
- PDFs are saved in `~/.pi/agent/olaink/` and page PNGs are sent to the model as user-message image content. The extension currently limits notes to 16 MiB and 20 pages to bound memory and model input.
- The PDF and images are plaintext local outputs. Protect and delete them according to your normal local data-handling policy. Pairing another device does not expose private keys to Ola Ink.

### Develop from this repository

After `npm install` at the repository root, install the local package:

```sh
pi install ./packages/pi-plugin
```

For a one-off development run, you can instead use `pi --extension ./packages/pi-plugin/index.ts`. Set `OLAINK_PI_STATE_DIR` to keep a development pairing apart from your real one; `OLAINK_PI_POLL_MS` changes the conversation polling interval.

### End-to-end test

`e2e/conversation-e2e.ts` runs the whole loop against a throwaway local relay. It needs Bun, a JDK (`$JAVA_HOME` or `~/jdk17`), and a model Pi can use:

```sh
bun packages/pi-plugin/e2e/conversation-e2e.ts --out /tmp/olaink-e2e \
  [--model anthropic/claude-haiku-4-5] [-e path/to/auth-extension]
```

The harness first starts the real relay in-process, with SQLite in a temp directory and a stub AuthGravity. It creates the accounts `@alice`, `@pi-bot` and `@mallory`, and pairs Pi with `--mode rpc`. It then plays Alice against it:

- **Typed question:** a note of typed text boxes.
- **Blocked sender:** a note from the unallowed `@mallory`, which must be consumed without an answer.
- **Follow-up:** a question that needs the previous answer.
- **Ink-only question:** a page with no machine-readable text, which the agent must read from the image.
- **Long answer:** a request whose answer runs to several pages.

Each reply is checked in two ways. It is decrypted by the Supernote plugin's own `NoteV1.java`, and it must parse as a note with an editable text box on every page. Notes, replies, page renders and Pi's event stream are written to `--out`.

## Publishing a release

The npm package is published from a signed GitHub Actions run. Configure npm trusted publishing for `@olaink/pi-plugin` to trust the `publish-pi-plugin.yml` workflow in `philips/olaink`, then bump the package version and push a matching `pi-plugin-v<version>` tag. The workflow runs the repository checks, verifies the package tarball, and publishes with npm provenance.
