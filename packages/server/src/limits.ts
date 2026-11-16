/**
 * The service's size limits — the only place the maximum note size is
 * defined. Clients enforce nothing but their own device-memory ceilings (the
 * plugin's NoteV1 constants, the Pi extension's recordCrypto), so raising the
 * service's limit is a relay deploy alone: bump MAX_RECORD_BYTES, keep
 * MAX_BODY_BYTES above it plus the JSON envelope, regenerate the embedded
 * onboard page (node scripts/embed-onboard-page.mjs), and deploy.
 *
 * The relay only ever sees ciphertext, so the product limit is expressed as a
 * cap on one record's JSON: a whole .note is gzipped, encrypted, and
 * base64url encoded — roughly 16/9x the plaintext even before compression
 * savings — so MAX_RECORD_BYTES = 64 MiB admits notes up to about 40 MiB.
 */

/** Cap on one request body; must stay above MAX_RECORD_BYTES + envelope. */
export const MAX_BODY_BYTES = 80 * 1024 * 1024;

/** Cap on one record's JSON — this is the service's maximum note size. */
export const MAX_RECORD_BYTES = 64 * 1024 * 1024;

/** The note size the record cap implies; bounds the reference decoder's gunzip. */
export const MAX_NOTE_BYTES = 40 * 1024 * 1024;

/*
 * Record v2 (plans/binary-record-transport.md): a small JSON routing header
 * plus the ciphertext as raw bytes, ~1:1 with the note instead of 16:9. The
 * v1 caps above keep serving legacy clients unchanged.
 */

/** Cap on one v2 record's routing-header JSON. */
export const MAX_HEADER_BYTES = 4 * 1024;
/** Cap on one v2 record's ciphertext blob — the v2 maximum note size. */
export const MAX_CIPHERTEXT_BYTES = 64 * 1024 * 1024;
