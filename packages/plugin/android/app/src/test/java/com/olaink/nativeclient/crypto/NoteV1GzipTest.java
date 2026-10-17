package com.olaink.nativeclient.crypto;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.spec.ECGenParameterSpec;
import java.util.Collections;
import java.util.Random;

import org.junit.Test;

/** Payload gzip: production sends compress; receivers accept both forms. */
public final class NoteV1GzipTest {
  private static byte[] noteLike(int size) {
    // Long runs with some noise, like a Ratta RLE note.
    final byte[] bytes = new byte[size];
    final Random random = new Random(7);
    for (int i = 0; i < size; i++) bytes[i] = (byte) (i % 97 < 90 ? 0x62 : random.nextInt(256));
    return bytes;
  }

  private static String payloadJson(byte[] plaintext) {
    return new String(plaintext, StandardCharsets.UTF_8);
  }

  @Test
  public void productionRecordsAreGzippedAndRoundTrip() throws Exception {
    final KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
    generator.initialize(new ECGenParameterSpec("secp256r1"));
    final KeyPair device = generator.generateKeyPair();
    final byte[] note = noteLike(400_000);
    final String record = NoteV1.encryptNoteForDevices("q.note", note, "philips",
        "rec-1", "acct_from", "dev_from", "acct_to", 3,
        Collections.singletonList(new NoteV1.Recipient("dev_to", NoteV1.b64url(device.getPublic().getEncoded()))));
    // The record is far smaller than the note would be base64-encoded raw.
    assertTrue("record should be compressed, was " + record.length(), record.length() < note.length / 2);
    final NoteV1.Payload payload = NoteV1.decryptForDevice(record, "dev_to", device.getPrivate());
    assertArrayEquals(note, payload.note);
    assertEquals("philips", payload.senderUsername);
  }

  @Test
  public void acceptsBothEncodingsWithTheSameHash() throws Exception {
    final byte[] note = noteLike(10_000);
    final NoteV1.Payload raw = NoteV1.parsePayload(NoteV1.payloadPlaintext("a.note", note, "p", false));
    final NoteV1.Payload gzipped = NoteV1.parsePayload(NoteV1.payloadPlaintext("a.note", note, "p", true));
    assertArrayEquals(note, raw.note);
    assertArrayEquals(note, gzipped.note);
    assertEquals(raw.sha256, gzipped.sha256);
    assertTrue(payloadJson(NoteV1.payloadPlaintext("a.note", note, "p", true)).contains("\"encoding\":\"gzip\""));
  }

  @Test
  public void rejectsADecompressionBomb() throws Exception {
    // 6 MiB of zeros compresses to a few KB but inflates past the 5 MiB cap.
    final byte[] bomb = NoteV1.gzip(new byte[6 * 1024 * 1024]);
    final String json = "{\"version\":1,\"filename\":\"a.note\",\"mime\":\"application/x-supernote\","
        + "\"encoding\":\"gzip\",\"note\":\"" + NoteV1.b64url(bomb) + "\",\"sha256\":\"x\"}";
    final NoteV1.ProtocolException error = assertThrows(NoteV1.ProtocolException.class,
        () -> NoteV1.parsePayload(json.getBytes(StandardCharsets.UTF_8)));
    assertEquals("note exceeds size limit", error.getMessage());
  }

  @Test
  public void rejectsUnknownEncodings() {
    final String json = "{\"version\":1,\"filename\":\"a.note\",\"mime\":\"application/x-supernote\","
        + "\"encoding\":\"br\",\"note\":\"AA\",\"sha256\":\"x\"}";
    assertThrows(NoteV1.ProtocolException.class, () -> NoteV1.parsePayload(json.getBytes(StandardCharsets.UTF_8)));
  }
}
