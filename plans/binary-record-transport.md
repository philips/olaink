# Binary record transport — removing the base64/JSON encoding tax

> **Status: implemented** (relay, reference codec + vectors, browser inbox,
> Pi extension, plugin NPK + React transport; all suites green). Remaining:
> on-device verification of the RN blob/FileReader download path (the plan's
> one flagged spike — a failed blob fetch leaves the record queued on the
> relay, so nothing is lost), and the eventual v1 retirement per the rollout
> order below.

## Problem

Today a `.note` is base64url-encoded **twice** on its way through the system
(see `packages/server/src/prototypeNoteCrypto.ts` and
`packages/plugin/android/.../crypto/NoteV1.java`):

```
.note bytes → gzip → base64url → payload JSON → AES-GCM → base64url → record JSON
                4/3×                              4/3×
```

For an N-byte note the record is ~16/9·N (~1.78×) even when gzip saves
nothing. What that costs, concretely:

- **Wire**: a 40 MiB note uploads and downloads as a ~72 MiB record (+78%).
- **R2**: `R2NotePayloads.put(recordId, JSON.stringify(record))` stores the
  full record JSON as *text* — the same +78% on every stored object, and it
  is what the stats page reports as pending/lifetime bytes.
- **Device heap**: the record JSON crosses the NPK→React bridge as a string
  (`e2CreateFileRecord` returns it; App.tsx then `JSON.parse`s it and
  `JSON.stringify`s it again into the POST body) — several live copies of a
  ~72 MiB string in a constrained RN heap. Poll is worse: every waiting
  record arrives in one response (`prototypeNoteRelay.poll` inlines all R2
  payloads), which is exactly why `RELAY_POLL_MAX_RESPONSE` exists.
- **Relay CPU**: `JSON.stringify(record)` per send for the size check, plus a
  parse/serialize round trip per record per poll.

## Non-negotiables

- The relay stays ciphertext-only: no note bytes, filenames, or keys, ever.
- Exchange stays whole-`.note` files only (no page/stroke format).
- React owns HTTPS transport; the NPK owns keys, crypto, and file I/O.
- **Old clients keep working.** Plugins lag the service by design (see
  `limits.ts`); this migration must be negotiated, not cut over.

## Design: two independent format changes

The crypto does not change at all — ECDH P-256 + HKDF-SHA-256 + AES-256-GCM,
the AAD strings, the key slots, the journal, retention, acks, and rate limits
all stay exactly as they are. Only the *framing* around the ciphertext
changes, in two layers that can ship separately.

### 1. Payload v2 — JSON header + trailing note bytes (relay-invisible)

Today the note is a base64url string *inside* a JSON payload. Instead: a
length-prefixed JSON header, then the raw (optionally gzipped) note bytes as
the rest of the AES plaintext — deliberately **no hand-built parser**:

```
 0   02             payload tag (v2)                      1 B
 1   xx xx xx xx    headerLen                             u32 LE
 5   {"version":2,"filename":"todo.note",
     "mime":"application/x-supernote","sender":"maya",
     "sha256":"qL0…","encoding":"gzip"}              headerLen B
     <gzip(note)>   rest of the buffer                    to EOF
```

- ~1.0× the (optionally gzipped) note + a ~200-byte header, instead of 4/3×.
- Decoding is one tag check, one u32 read + bounds check, then the same
  `JSON.parse`/`org.json` the v1 path already runs, then "rest of buffer".
  No per-field length walks, offsets, or endianness beyond one integer.
- Fields stay named and self-describing (a hexdump is readable), and
  **forward-compatible**: old receivers ignore unknown JSON fields for free —
  a fixed TLV frame could not offer that.
- No `noteLen` field: GCM authenticates the exact plaintext length and
  `sha256` still covers the original pre-gzip bytes, checked after inflation;
  the device-side decompression-bomb ceilings (`MAX_RECEIVED_NOTE_BYTES`
  etc.) are unchanged and still required — the relay cannot bound inflation.
- Legacy detection is unambiguous: byte 0 == `{` (0x7B) → v1 JSON payload;
  `0x02` → v2; anything else invalid (JSON must start with `{`). Both decoders
  live side by side.
- The payload version lives *inside* the encrypted blob, so the relay never
  knows it exists. Rollout safety comes from capability negotiation (below).

### 2. Record v2 — routing header + raw ciphertext blob (relay-facing)

Split the record into a small JSON header and raw bytes:

```
header (JSON, ≤ 4 KiB): { version: 2, id, fromUserId, fromDeviceId, toUserId,
                          toDirectoryVersion, contentIv, keySlots: [...],
                          ciphertextBytes: n }
blob: n raw bytes of AES-GCM ciphertext || tag
```

- Routing, validation, and key slots need only the header; the blob is
  opaque. `keySlots` stay base64url (they are ~hundreds of bytes).
- Wire form: `multipart/form-data` with a `header` part (JSON) and a `blob`
  part (octet-stream). All three clients get this natively: RN
  `FormData` + file URI, browser `FormData` + `Blob`, Node/undici `FormData`.
  Workers and Bun both implement `request.formData()` — no new parsing code
  on the relay.
- Storage: the R2 object becomes the **raw blob** (binary `put`/`get` —
  extend `R2BucketLike`/`NotePayloadStore` with a bytes mode). The header
  moves to a `header_json` column on `prototype_notes` (additive D1
  migration), so v2 polls read D1 only and never touch R2.
- Size limits become honest: the blob cap ≈ the (compressed) note cap, 1:1
  instead of 16:9. `limits.ts` gets simpler; either storage drops ~44% at the
  current product limit, or the same caps admit ~1.8× larger notes.

### Endpoints (v2 alongside v1; v1 served until retirement)

```
POST /v2/notes            multipart { header, blob }   (AuthGravity account auth)
POST /v2/companion/notes  multipart { header, blob }   (device session)
POST /v2/companion/poll   → { ok, records: [headers] } — headers only, tiny
GET  /v2/companion/records/:id/blob → raw bytes (device session + delivery ACL)
```

- v2 poll responses are O(headers) — the whole "poll returns everything at
  once" heap problem, and `RELAY_POLL_MAX_RESPONSE` with it, quietly dies.
- The client loop becomes: poll → per record: GET blob → decrypt → save →
  ack. One record in memory at a time, per-record acks, resumable.
- v1 endpoints and the v1 R2 text objects keep working unchanged; a record is
  stored in whichever form it arrived in. `purgeExpired` deletes by record
  ID either way.

## Capability negotiation (why old receivers never break)

A record's payload is one blob shared by all the recipient's devices (only
the key wrap differs per device), so a sender may only emit a format *every*
recipient device can read. The directory — already fetched at send time —
becomes the negotiation channel:

- `prototype_devices` gains a `payload_versions` column; enrollment
  (`registerDevice`) accepts an optional list, defaulting to `[1]`.
- Directory responses include it per device:
  `{ deviceId, publicKeySpki, payloadVersions: [1, 2] }`.
- Senders pick the highest version common to **all** of the recipient's
  devices, and fall back to v1 otherwise. Old devices advertise nothing →
  they only ever receive v1 payloads.
- Record transport (header+blob vs inline JSON) needs no negotiation at all:
  a client simply calls v2 endpoints when it supports them; the relay serves
  both stores.

## Client impact

- **Plugin (NPK + React)** — biggest win, needs a small spike:
  - Send: `NoteV1` writes the ciphertext blob to a plugin-private temp file
    and returns `{ header, blobPath, recordId, ... }`; React uploads
    `FormData` with the file URI. The ~72 MiB bridge string disappears —
    the bridge carries only the small header.
  - Receive: fetch the blob per record. Preferred: XHR `responseType:
    'blob'` (file-backed on Android) and hand the NPK the backing path;
    fallback: one ~40 MiB buffer across the bridge (still 1.78× better than
    today, one record at a time).
  - `NoteV1` gains the payload v2 codec (tag + u32 + JSON header + trailing
    bytes) + legacy JSON fallback.
  - Spike first: RN 0.79 multipart file upload and blob-to-path on the
    Supernote runtime. Fallback if the spike fails: keep the bridge crossing
    base64 — the wire and R2 savings still land.
- **Browser inbox**: native `FormData`/`Blob`; payload v2 encode/decode next
  to the existing JSON path; advertise `[1, 2]` at enrollment.
- **Pi extension**: Node Buffers; `recordCrypto` gains the v2 codec; `relay.ts`
  switches to v2 endpoints. Both formats supported for received records.

## Rollout (receivers before senders; relay first)

1. **Relay**: v2 endpoints + binary R2 + D1 header column + directory
   capability field. No client has changed — zero wire behavior change.
2. **Reference implementation**: payload v2 in `prototypeNoteCrypto`, new
   deterministic interop vectors (the Java/WebCrypto/Node parity suite), and
   `webCryptoInterop` tests for both directions and both formats.
3. **Receivers ship v2 decode** and start advertising `[1, 2]`: browser
   inbox (deploys with the relay), Pi extension, then a plugin release.
   Nothing emits v2 yet, so no user-visible change.
4. **Senders emit v2** when every recipient device advertises ≥ 2: browser
   and Pi first; the plugin in the same or the next release (its sender is
   gated by the recipient's advertisement, so shipping both at once is
   safe).
5. **Retire v1** only when directory data shows no active device still
   advertises `[1]`-only; a final plugin release sets the drop-dead date.

## Testing

- Interop vectors pin the payload layout byte-for-byte across Java, WebCrypto,
  and Node (same harness as today's record-v1 vectors).
- Adversarial: truncated payloads, lying `headerLen` values, header/blob length
  mismatch, oversized blobs (413), unauthenticated blob GETs, gzip bombs
  against the unchanged device ceilings, mixed v1/v2 inboxes.
- e2e: plugin ⇄ browser ⇄ Pi across the full v1/v2 sender×receiver matrix.
- `check:generated` keeps the embedded browser page in sync.

## Costs and risks

- This is a **one-time coordinated migration** — unlike limit bumps, the
  encoding is end-to-end, so every surface touches the wire once. The
  capability negotiation + dual endpoints are what make it safe; the cost is
  relay complexity serving two formats until step 5.
- The RN file-upload/blob spike is the only real unknown; the plan degrades
  gracefully (base64 bridge only) if it fails.
- D1 schema change (additive) and a `NotePayloadStore` bytes mode touch
  pinned generated files (`migrations.ts`); both are additive.
- Stats semantics shift: pending/lifetime bytes start counting blob bytes
  (~44% lower for identical traffic) — worth a note on the stats page when
  v2 traffic starts.

## Expected result (40 MiB note)

| | today | after |
|---|---|---|
| Upload/download | ~72 MiB | ~40 MiB (−44%) |
| R2 per record | ~72 MiB text | ~40 MiB binary (−44%) |
| NPK→RN bridge (send) | ~72 MiB JSON string | a file path + ~1 KiB header |
| Poll response | every record inline (512 MiB guard) | headers only (~KiB) |
| Record cap ↔ note cap | 16:9 | ~1:1 |
