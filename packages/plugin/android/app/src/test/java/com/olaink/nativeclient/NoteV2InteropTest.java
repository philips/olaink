package com.olaink.nativeclient;

import static org.junit.Assert.assertArrayEquals;
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
 * WebCrypto/Java interoperability for record v2 (header + raw blob), driven
 * entirely by the committed vectors in vectors/. The deterministic case
 * reuses the record-v1 vectors' fixed material, so both suites prove the
 * framing is the only difference; the random case is a real WebCrypto
 * reference encryption. The vectors are the oracle.
 */
public final class NoteV2InteropTest {
  private static Map<String, Object> deterministic;
  private static Map<String, Object> randomCase;

  @BeforeClass
  public static void loadVectors() throws Exception {
    try (InputStream stream = NoteV2InteropTest.class.getResourceAsStream("/note-v2-vectors.json")) {
      if (stream == null) throw new IllegalStateException("note-v2-vectors.json not on the test classpath");
      final String text;
      try (Scanner scanner = new Scanner(stream, StandardCharsets.UTF_8).useDelimiter("\\A")) {
        text = scanner.hasNext() ? scanner.next() : "";
      }
      final Map<String, Object> vectors = (Map<String, Object>) NoteV1.Json.parse(text);
      deterministic = (Map<String, Object>) vectors.get("deterministic");
      randomCase = (Map<String, Object>) vectors.get("randomWebCrypto");
    }
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

  private static List<NoteV1.Recipient> recipients() {
    final List<NoteV1.Recipient> out = new ArrayList<>();
    for (Map<String, Object> recipient : (List<Map<String, Object>>) deterministic.get("recipients")) {
      out.add(new NoteV1.Recipient(
          (String) recipient.get("deviceId"), (String) recipient.get("publicSpkiB64url")));
    }
    return out;
  }

  private static Map<String, Object> payloadInputs() {
    return (Map<String, Object>) deterministic.get("payloadInputs");
  }

  private static Map<String, Object> routing() {
    return (Map<String, Object>) deterministic.get("routing");
  }

  @Test
  public void deterministicV2EncryptMatchesWebCryptoVector() throws Exception {
    final Map<String, Object> inputs = payloadInputs();
    final Map<String, Object> routing = routing();
    final NoteV1.EncryptedNoteV2 produced = NoteV1.encryptV2WithFixedMaterial(
        (String) inputs.get("filename"), b64((String) inputs.get("noteB64url")),
        (String) inputs.get("senderUsername"),
        (String) routing.get("recordId"), (String) routing.get("fromUserId"),
        (String) routing.get("fromDeviceId"), (String) routing.get("toUserId"),
        (Long) routing.get("toDirectoryVersion"), recipients(), fixedMaterial());
    assertEquals((String) deterministic.get("expectedHeaderJson"), produced.headerJson);
    assertArrayEquals(b64((String) deterministic.get("expectedBlobB64url")), produced.blob);
  }

  @Test
  public void decryptsWebCryptoV2VectorForBothRecipients() throws Exception {
    final String headerJson = (String) deterministic.get("expectedHeaderJson");
    final byte[] blob = b64((String) deterministic.get("expectedBlobB64url"));
    final Map<String, Object> inputs = payloadInputs();
    for (Map<String, Object> recipient : (List<Map<String, Object>>) deterministic.get("recipients")) {
      final PrivateKey privateKey = NoteV1.importPkcs8(b64((String) recipient.get("privatePkcs8B64url")));
      final NoteV1.Payload payload = NoteV1.decryptForDeviceV2(
          headerJson, blob, (String) recipient.get("deviceId"), privateKey);
      assertEquals(inputs.get("filename"), payload.filename);
      assertEquals(inputs.get("senderUsername"), payload.senderUsername);
      assertEquals(inputs.get("noteSha256B64url"), payload.sha256);
      assertArrayEquals(b64((String) inputs.get("noteB64url")), payload.note);
    }
  }

  @Test
  public void decryptsRealRandomWebCryptoV2Record() throws Exception {
    final PrivateKey privateKey = NoteV1.importPkcs8(b64((String) randomCase.get("recipientPrivatePkcs8B64url")));
    final NoteV1.Payload payload = NoteV1.decryptForDeviceV2(
        (String) randomCase.get("headerJson"), b64((String) randomCase.get("blobB64url")),
        (String) randomCase.get("recipientDeviceId"), privateKey);
    final Map<String, Object> inputs = (Map<String, Object>) randomCase.get("payloadInputs");
    assertEquals(inputs.get("filename"), payload.filename);
    assertEquals(inputs.get("senderUsername"), payload.senderUsername);
    assertArrayEquals(b64((String) inputs.get("noteB64url")), payload.note);
  }

  @Test
  public void productionV2RoundTripAndTamperRejection() throws Exception {
    final java.security.KeyPairGenerator generator = java.security.KeyPairGenerator.getInstance("EC");
    generator.initialize(new java.security.spec.ECGenParameterSpec("secp256r1"));
    final java.security.KeyPair pair = generator.generateKeyPair();
    final byte[] spki = pair.getPublic().getEncoded();
    final String recordId = "v2roundtrip000000000000000000000001";
    final byte[] note = "whole .note bytes for the Java v2 round trip".getBytes(StandardCharsets.UTF_8);
    final NoteV1.EncryptedNoteV2 encrypted = NoteV1.encryptNoteForDevicesV2(
        "round-trip.note", note, "round-trip-sender", recordId,
        "account_v2_sender", "device_v2_sender", "account_v2_receiver", 2L,
        List.of(new NoteV1.Recipient("device_v2_recv_1", NoteV1.b64url(spki))));
    final Map<?, ?> header = (Map<?, ?>) NoteV1.Json.parse(encrypted.headerJson);
    assertEquals(2L, header.get("version"));
    final NoteV1.Payload payload = NoteV1.decryptForDeviceV2(
        encrypted.headerJson, encrypted.blob, "device_v2_recv_1", pair.getPrivate());
    assertEquals("round-trip.note", payload.filename);
    assertArrayEquals(note, payload.note);

    // A tampered byte in the blob must fail authentication.
    final byte[] tampered = java.util.Arrays.copyOf(encrypted.blob, encrypted.blob.length);
    tampered[0] ^= 0x55;
    final NoteV1.ProtocolException error = assertThrows(NoteV1.ProtocolException.class,
        () -> NoteV1.decryptForDeviceV2(encrypted.headerJson, tampered, "device_v2_recv_1", pair.getPrivate()));
    assertNotEquals("note integrity check failed", error.getMessage());
    assertTrue(error.getMessage(), error.getMessage().contains("invalid") || error.getMessage().contains("failed"));
  }
}
