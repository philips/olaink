# Pi plugin: conversation mode

Status: **implemented on branch `pi-plugin/conversation-mode`, tested end to
end against a local relay** (`packages/pi-plugin/e2e/conversation-e2e.ts`). It
needs the `supernote-typescript` note writer (branch `feat/note-writer`)
published before the Pi package can be released.

## Goal

Let a Supernote user carry on a handwritten conversation with a Pi agent:

1. In Pi, the user runs `/olaink converse on`.
2. Pi polls the relay in the background for new notes.
3. When a note arrives, Pi decrypts it, gives the page images to the agent, and
   waits for the agent run to finish.
4. Pi typesets the agent's final answer into a **`.note` file**, encrypts it to
   the sender's devices, and sends it through the relay.
5. The Supernote plugin shows the reply in its Inbox. Opening it saves it as
   `Note/OlaInk/<pi-username>-<name>.note`, which opens in Notes. Pi goes back
   to polling for the next note.

Handwriting on the Supernote → agent → typeset `.note` → Supernote, and repeat.

## What exists today (`packages/pi-plugin`)

- `/olaink pair | poll | status | allow` (`index.ts`). Polling only happens
  when the user runs a command.
- `receive()` polls `/v1/companion/poll` and drops records from senders not on
  the allowlist. It then decrypts (`recordCrypto.ts`, **decrypt only**),
  converts with `supernote-typescript` (`toPdf`, `toImage`), acks the records,
  and calls `pi.sendUserMessage()` with text plus PNG pages.
- The relay already lets a paired companion **send**:
  `/v1/companion/directory` (username → `{version, devices}`) and
  `/v1/companion/notes` (`{deviceId, username, record}`). The Supernote plugin
  uses the same flow (`App.tsx` `sendCurrentNote`). The relay needs no changes.
- `supernote-typescript` **reads** `.note` files only. Nothing in the repo or
  its dependencies writes one. This is the main new piece of work.

## Design

### Commands and state

```
/olaink converse on [USERNAME]   # start; optional reply-to / allowed sender
/olaink converse off
/olaink converse                 # status
```

- Conversation mode **requires a configured, non-empty allowlist**. In this
  mode, content an untrusted person wrote goes straight into an agent that has
  tools. Allowing anyone to send is a prompt-injection hole, so it is refused.
  `converse on USERNAME` is shorthand for `allow add USERNAME` followed by
  `converse on`.
- **Reply target:** the record's authenticated `fromUserId`, mapped to a
  username through the allowlist entries (`AllowedSender.{userId, username}`).
  The relay has no reverse lookup, so the allowlist doubles as the address
  book. Before each send, the username is resolved again through
  `/v1/companion/directory`. If it no longer maps to the same `userId`, Pi
  refuses to send, so a renamed or retired username cannot be used to redirect
  replies.
- The mode is in-memory and scoped to the session. It does not resume on its
  own after a restart, because the user should opt in each time. The work
  journal (below) is persisted, so an interrupted exchange can be finished.
- `ctx.ui.setStatus("olaink", …)` shows the current state, e.g.
  `✉ @alice · waiting`, `✉ @alice · thinking`, `✉ @alice · sending`.

### Loop (state machine)

```
idle ──timer──▶ polling ──no allowed record──▶ idle
                   │
                   └─record─▶ staged ─▶ prompted ─▶ (agent run) ─▶ replying ─▶ sent ─▶ idle
```

- Start the timer from the command handler, not from the extension factory
  (see the pi lifecycle rules). Clear it in an idempotent `session_shutdown`
  handler and in `converse off`.
- Poll every 20 s ± jitter. After an error, back off exponentially up to 5
  minutes. Skip a tick unless `ctx.isIdle()` is true and no exchange is in
  flight. Pi never interrupts the user or a running agent.
- **Handle one record per cycle**: the oldest allowed record, since the relay
  orders by `created_at`. Later records stay on the relay for later cycles.
  Blocked records are acked right away, as they are today.
- Refactor `receive()` into `pollRecords()`, `decryptAndRender(record)`, and
  `ack(ids)`. Then `/olaink poll` and conversation mode share the same code.

### Delivery guarantees (local journal)

Agent runs take minutes and may run tools, so acking after the agent finishes
could run the agent twice on the same record. Instead:

1. Decrypt the record. Write `~/.pi/agent/olaink/conversation/<recordId>.note`
   (mode 0600) and a journal entry `{recordId, fromUserId, filename, state:
   "staged"}`. Only then **ack**.
2. Move the entry to `prompted` when calling `sendUserMessage`, to `replied`
   (with the outgoing record id) after `/v1/companion/notes` returns 202, and
   to `failed` together with the error.
3. On `converse on`, any `staged` or `prompted` entries are shown to the user,
   who can resume or drop them. They are never replayed automatically.

### Handing the note to the agent

- Reuse the current rendering (PNG per page, PDF saved locally). Frame the
  message: *"Handwritten message from @alice via Supernote (N pages). Your
  final response will be typeset and sent back to her Supernote as a .note.
  Answer concisely in plain text or light Markdown (headings, lists, code); no
  tables or images. Stay under ~N pages."*
- Optionally add a `before_agent_start` guideline while the mode is on, so the
  agent treats the note as the user's request.
- Correlation: set `pendingExchange = recordId` just before `sendUserMessage`.
  Since this only happens when Pi is idle, the next run is ours. On
  `agent_end`, take the text of the **last assistant message** from
  `event.messages` as the reply. On `agent_settled`, which fires once no retry
  or continuation is pending, start `replying`.
- If the outcome is `aborted` or `error`, or there is no text, mark the entry
  `failed` and notify locally. Optionally send a one-line "Pi couldn't answer
  this note" reply (config flag, default off).

### Building the reply `.note` (`supernote-typescript` writer)

**Prototyped** on `supernote-typescript` branch `feat/note-writer` (see its
`plans/note-writer.md`). `createTextNote({ text, fontBytes })` typesets the
reply into real, **editable Supernote text boxes**, one per page. Each box
consists of:

- a `TOTALPATH` text-box record carrying the Unicode text;
- its anti-aliased pixels in MAINLAYER;
- a `DISABLE` rect.

The writer emits `SN_FILE_VER_20260016` / N5 / 1920×2560. That is what
current firmware creates on both the Manta and the Nomad. It uses the pure-JS
`@pdf-lib/fontkit` (already a dependency), so installing it needs no native
build.

Verified on the Nomad (Chauvet 2608):

- A blank page is byte-identical to a device-created note.
- The text-box record matches a device-created one field for field.
- The note opens on the device, and the device keeps our box when it
  re-renders the page. A pixels-only "text box" is dropped when the device
  redraws, which is why the record matters.

Remaining for Pi:

1. **Layout:** Flatten the reply Markdown to plain text: headings, bullets,
   and code as plain lines. Cap the reply at about 10 pages, and past that
   truncate with a note like "Full answer in Pi".
2. **Font:** Bundle an OFL/Apache font that is metrically close to the
   device's DroidSansFallbackFull, e.g. Noto Sans. The device re-lays out the
   text in its own font once the user edits it.
3. **Size budget:** The relay caps records at 8 MiB of JSON, so a note can be
   at most about 4.5 MiB. A text page is roughly 60 KB.
4. **Older devices:** The writer is not yet tested on a Manta, or on older
   firmware (A6X/A5X 1404×1872). If needed, fall back to the received note's
   header and page size.

Filename: `Re-<original stem>.note`. The Supernote plugin saves it as
`Note/OlaInk/<pi-username>-Re-<stem>.note` and adds `-2`, `-3`, … on name
clashes. The Supernote plugin needs no changes.

### Encrypting and sending

- Port `encryptNoteForDevices` from `packages/server/src/prototypeNoteCrypto.ts`
  into `recordCrypto.ts`, keeping the package self-contained. Add an interop
  test in which the server's `decryptNoteForDevice` opens a record that
  pi-plugin encrypted.
- Send flow: `directory(username)` → encrypt to every device in the directory,
  with `toDirectoryVersion` taken from the response →
  `POST /v1/companion/notes`. Retry once on `invalid_note`, which covers a
  stale directory version, after fetching the directory again.

## Phases

1. **Spike the writer (risk gate).** ✅ Done: see the
   `supernote-typescript` branch `feat/note-writer`. Still to do: a Manta
   check, and the round trip of pen strokes written on a reply (`adb` cannot
   inject pen input, so this needs a person with a stylus).
2. **Encryption and send.** Add `encryptNoteForDevices` with interop tests,
   plus a manual `/olaink reply USERNAME "text"` debug command that runs
   end to end.
3. **Conversation loop.** Add the command, the timer and state machine, the
   journal, agent correlation, and the status line. Add unit tests for the
   state machine using fake relay responses and fake agent events.
4. **Docs and release.** Update the README (security warning, allowlist
   requirement, Pi must stay running, e.g. in tmux) and bump the pi-plugin
   version.

## Future work (out of scope for v1)

- **Thread mode:** append the reply pages to the received note, so the user
  keeps writing in one file. This needs address rewriting for the copied
  pages, links, titles, and keywords, and page-level dedupe using the `PAGEID`s
  already seen, so the agent only gets new pages.
- Replies as real vector strokes (`TOTALPATH`) or Supernote text boxes, so the
  text can be lassoed and edited on the device.
- A `olaink_reply` tool, so the agent can send an explicit reply (or several)
  in place of its final message.
- In-place replacement of a thread note on the Supernote. This would need a
  change to the Supernote plugin.

## Open questions

1. Is a standalone reply note acceptable for v1, or is thread mode (appending
   to the same note) essential for the experience?
2. Reply content: always the final assistant message, or a dedicated reply
   tool from the start?
3. ~~Rasterizer choice~~: resolved. The prototype uses pure-JS
   `@pdf-lib/fontkit` and a scanline filler (about 0.3 s per page).
4. ~~Where the writer lives~~: resolved. It lives in `supernote-typescript`
   (`feat/note-writer`).
