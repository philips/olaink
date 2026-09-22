package com.olaink.nativeclient;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import com.olaink.nativeclient.crypto.NoteV1;

import org.junit.BeforeClass;
import org.junit.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.PrivateKey;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Scanner;

/**
 * WebCrypto/Java interoperability for EncryptedNoteRecordV1, driven entirely by
 * the committed vectors in experiments/native-client-plugin/vectors/. The
 * vectors are the oracle; this test proves the pure-Java implementation
 * produces and consumes byte-compatible records.
 */
public final class NoteV1InteropTest {
  private static Map<String, Object> vectors;
  private static Map<String, Object> deterministic;
  private static Map<String, Object> randomCase;

  @BeforeClass
  public static void loadVectors() throws Exception {
    try (InputStream stream = NoteV1InteropTest.class.getResourceAsStream("/note-v1-vectors.json")) {
      if (stream == null) throw new IllegalStateException("note-v1-vectors.json not on the test classpath");
      final String text;
      try (Scanner scanner = new Scanner(stream, StandardCharsets.UTF_8).useDelimiter("\\A")) {
        text = scanner.hasNext() ? scanner.next() : "";
      }
      vectors = (Map<String, Object>) NoteV1.Json.parse(text);
    }
    deterministic = (Map<String, Object>) vectors.get("deterministic");
    randomCase = (Map<String, Object>) vectors.get("randomWebCrypto");
  }

  private static byte[] b64(String value) throws Exception {
    return NoteV1.fromB64url(value, 16 * 1024 * 1024);
  }

  private static NoteV1.FixedMaterial fixedMaterial() throws Exception {
    final List<Map<String, Object>> recipients = (List<Map<String, Object>>) deterministic.get("recipients");
    final List<byte[]> pkcs8 = new ArrayList<>();
    final List<byte[]> spki = new ArrayList<>();
    final List<byte[]> wrapIvs = new ArrayList<>();
    for (Map<String, Object> recipient : recipients) {
      pkcs8.add(b64((String) recipient.get("ephemeralPrivatePkcs8B64url")));
      spki.add(b64((String) recipient.get("ephemeralPublicSpkiB64url")));
      wrapIvs.add(b64((String) recipient.get("wrapIvB64url")));
    }
    return new NoteV1.FixedMaterial(
        b64((String) deterministic.get("contentKeyB64url")),
        b64((String) deterministic.get("contentIvB64url")),
        pkcs8, spki, wrapIvs);
  }

  private static List<NoteV1.Recipient> recipients() throws Exception {
    final List<NoteV1.Recipient> out = new ArrayList<>();
    for (Map<String, Object> recipient : (List<Map<String, Object>>) deterministic.get("recipients")) {
      out.add(new NoteV1.Recipient(
          (String) recipient.get("deviceId"), (String) recipient.get("publicSpkiB64url")));
    }
    return out;
  }

  private static Map<String, Object> payloadInputs(Map<String, Object> source) {
    return (Map<String, Object>) source.get("payloadInputs");
  }

  private static Map<String, Object> routing(Map<String, Object> source) {
    return (Map<String, Object>) source.get("routing");
  }

  @Test
  public void deterministicEncryptMatchesWebCryptoRecord() throws Exception {
    final Map<String, Object> inputs = payloadInputs(deterministic);
    final Map<String, Object> routing = routing(deterministic);
    final byte[] note = b64((String) inputs.get("noteB64url"));
    final String produced = NoteV1.encryptWithFixedMaterial(
        (String) inputs.get("filename"), note, (String) inputs.get("senderUsername"),
        (String) routing.get("recordId"), (String) routing.get("fromUserId"),
        (String) routing.get("fromDeviceId"), (String) routing.get("toUserId"),
        (Long) routing.get("toDirectoryVersion"), recipients(), fixedMaterial());
    assertEquals((String) deterministic.get("expectedRecordJson"), produced);
  }

  @Test
  public void decryptsWebCryptoRecordForBothRecipients() throws Exception {
    final String record = (String) deterministic.get("expectedRecordJson");
    final Map<String, Object> inputs = payloadInputs(deterministic);
    final List<Map<String, Object>> recipients = (List<Map<String, Object>>) deterministic.get("recipients");
    for (Map<String, Object> recipient : recipients) {
      final PrivateKey privateKey = NoteV1.importPkcs8(b64((String) recipient.get("privatePkcs8B64url")));
      final NoteV1.Payload payload = NoteV1.decryptForDevice(record, (String) recipient.get("deviceId"), privateKey);
      assertEquals(inputs.get("filename"), payload.filename);
      assertEquals(inputs.get("senderUsername"), payload.senderUsername);
      assertEquals(inputs.get("noteSha256B64url"), payload.sha256);
      assertArrayEquals(b64((String) inputs.get("noteB64url")), payload.note);
    }
  }

  @Test
  public void decryptsRealRandomWebCryptoRecord() throws Exception {
    final PrivateKey privateKey = NoteV1.importPkcs8(b64((String) randomCase.get("recipientPrivatePkcs8B64url")));
    final NoteV1.Payload payload = NoteV1.decryptForDevice(
        (String) randomCase.get("recordJson"), (String) randomCase.get("recipientDeviceId"), privateKey);
    final Map<String, Object> inputs = payloadInputs(randomCase);
    assertEquals(inputs.get("filename"), payload.filename);
    assertEquals(inputs.get("senderUsername"), payload.senderUsername);
    assertArrayEquals(b64((String) inputs.get("noteB64url")), payload.note);
  }

  @Test
  public void productionEncryptRoundTripsThroughThePureJavaDecryptPath() throws Exception {
    final byte[] note = new byte[2048];
    new java.security.SecureRandom().nextBytes(note);
    final NoteV1.DeviceKeyPair identity = NoteV1.generateIdentity("device_roundtrip_1");
    final List<NoteV1.Recipient> recipients = new ArrayList<>();
    recipients.add(new NoteV1.Recipient(identity.deviceId, identity.publicKeySpkiB64url));
    final String record = NoteV1.encryptNoteForDevices(
        "roundtrip.note", note, "roundtrip-sender", "roundtriprecord0000000000000000003",
        "account_sender", "device_sender", "account_receiver", 2, recipients);
    final NoteV1.Payload payload = NoteV1.decryptForDevice(record, identity.deviceId, identity.privateKey);
    assertEquals("roundtrip.note", payload.filename);
    assertEquals("roundtrip-sender", payload.senderUsername);
    assertArrayEquals(note, payload.note);
    assertEquals(NoteV1.b64url(NoteV1.sha256(note)), payload.sha256);
  }

  @Test
  public void rejectsTamperedCiphertext() throws Exception {
    final String record = (String) deterministic.get("expectedRecordJson");
    final int valueStart = record.indexOf("\"ciphertext\":\"") + "\"ciphertext\":\"".length();
    final int valueEnd = record.indexOf('"', valueStart);
    final char last = record.charAt(valueEnd - 1);
    final char replacement = last == 'A' ? 'B' : 'A';
    final String flipped = record.substring(0, valueEnd - 1) + replacement + record.substring(valueEnd);
    assertNotEquals(record, flipped);
    final Map<String, Object> recipients = (Map<String, Object>) ((List<?>) deterministic.get("recipients")).get(0);
    final PrivateKey privateKey = NoteV1.importPkcs8(b64((String) recipients.get("privatePkcs8B64url")));
    assertThrows(NoteV1.ProtocolException.class,
        () -> NoteV1.decryptForDevice(flipped, (String) recipients.get("deviceId"), privateKey));
  }

  @Test
  public void rejectsAlteredRoutingMetadata() throws Exception {
    final String record = (String) deterministic.get("expectedRecordJson");
    final long version = (Long) routing(deterministic).get("toDirectoryVersion");
    final String tampered = record.replace(
        "\"toDirectoryVersion\":" + version, "\"toDirectoryVersion\":" + (version + 1));
    final Map<String, Object> recipient = (Map<String, Object>) ((List<?>) deterministic.get("recipients")).get(0);
    final PrivateKey privateKey = NoteV1.importPkcs8(b64((String) recipient.get("privatePkcs8B64url")));
    assertThrows(NoteV1.ProtocolException.class,
        () -> NoteV1.decryptForDevice(tampered, (String) recipient.get("deviceId"), privateKey));
  }

  @Test
  public void rejectsMissingSlotWrongDeviceAndBadBase64() throws Exception {
    final String record = (String) deterministic.get("expectedRecordJson");
    final Map<String, Object> recipient = (Map<String, Object>) ((List<?>) deterministic.get("recipients")).get(0);
    final PrivateKey privateKey = NoteV1.importPkcs8(b64((String) recipient.get("privatePkcs8B64url")));
    assertThrows(NoteV1.ProtocolException.class,
        () -> NoteV1.decryptForDevice(record, "device_not_in_slots", privateKey));

    final String trailingGarbage = record + "x";
    assertThrows(NoteV1.ProtocolException.class,
        () -> NoteV1.decryptForDevice(trailingGarbage, (String) recipient.get("deviceId"), privateKey));

    final String nonCanonical = record.replaceFirst("\"contentIv\":\"([A-Za-z0-9_-])", "\"contentIv\":\"0$1");
    assertThrows(NoteV1.ProtocolException.class,
        () -> NoteV1.decryptForDevice(nonCanonical, (String) recipient.get("deviceId"), privateKey));
  }

  @Test
  public void rejectsTruncatedCiphertextAndDuplicateKeys() throws Exception {
    final String record = (String) deterministic.get("expectedRecordJson");
    final Map<String, Object> recipient = (Map<String, Object>) ((List<?>) deterministic.get("recipients")).get(0);
    final PrivateKey privateKey = NoteV1.importPkcs8(b64((String) recipient.get("privatePkcs8B64url")));
    final int tagStart = record.indexOf("\"ciphertext\":\"") + "\"ciphertext\":\"".length();
    final int tagEnd = record.indexOf('"', tagStart);
    final String truncated = record.substring(0, tagStart) + record.substring(tagStart, tagStart + 8)
        + record.substring(tagEnd);
    assertThrows(NoteV1.ProtocolException.class,
        () -> NoteV1.decryptForDevice(truncated, (String) recipient.get("deviceId"), privateKey));

    assertThrows(RuntimeException.class,
        () -> NoteV1.Json.parse("{\"version\":1,\"version\":1}"));
  }

  @Test
  public void base64urlIsCanonicalAndStrict() throws Exception {
    assertEquals("AAEC", NoteV1.b64url(new byte[] {0, 1, 2}));
    assertThrows(NoteV1.ProtocolException.class, () -> NoteV1.fromB64url("", 16));
    assertThrows(NoteV1.ProtocolException.class, () -> NoteV1.fromB64url("AA=E", 16));
    assertThrows(NoteV1.ProtocolException.class, () -> NoteV1.fromB64url("A/AE", 16));
    assertThrows(NoteV1.ProtocolException.class, () -> NoteV1.fromB64url("AAECA", 16)); // non-canonical tail
    assertArrayEquals(new byte[] {0, 1, 2}, NoteV1.fromB64url("AAEC", 16));
    assertArrayEquals(new byte[] {0, 1}, NoteV1.fromB64url("AAE", 16));
  }

  private static void assertArrayEquals(byte[] expected, byte[] actual) {
    assertTrue("arrays differ", java.util.Arrays.equals(expected, actual));
  }
}
