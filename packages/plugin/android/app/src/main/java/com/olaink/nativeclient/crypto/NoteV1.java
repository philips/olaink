package com.olaink.nativeclient.crypto;

import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.interfaces.ECKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Ola Ink EncryptedNoteRecordV1 in pure Java (JCA), byte-compatible with the
 * production WebCrypto client:
 *
 *   P-256 ECDH -> HKDF-SHA-256 (empty salt, content AAD as info)
 *   AES-256-GCM (12-byte IV, 128-bit tag) for the content key wrap and payload
 *   SHA-256 over the complete original .note bytes
 *   canonical unpadded base64url
 *
 * No Android types so the same class runs in host-JVM interop tests and in the
 * PluginHost NPK. The wire contract lives in
 * packages/server/src/prototypeNoteCrypto.ts and the committed vectors in
 * experiments/native-client-plugin/vectors/note-v1-vectors.json.
 */
public final class NoteV1 {
  public static final int VERSION = 1;
  public static final int GCM_TAG_BYTES = 16;
  public static final int GCM_IV_BYTES = 12;
  public static final int CONTENT_KEY_BYTES = 32;
  /** Product plaintext-note cap (matches the companion's 5 MiB source limit). */
  public static final int MAX_NOTE_BYTES = 5 * 1024 * 1024;
  /** Ciphertext-record decode cap (matches the browser inbox's limit). */
  public static final int MAX_CIPHERTEXT_BYTES = 8 * 1024 * 1024;
  private static final String CURVE = "secp256r1";
  private static final String AAD_PREFIX = "olaink.note.v1";
  private static final String IDENTIFIER = "^[A-Za-z0-9_-]{1,128}$";
  private static final char[] B64_CHARS =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".toCharArray();

  /** Thrown for any validation, format, or cryptographic failure. */
  public static final class ProtocolException extends Exception {
    ProtocolException(String message) { super(message); }
    ProtocolException(String message, Throwable cause) { super(message, cause); }
  }

  /** Decrypted, fully validated payload. */
  public static final class Payload {
    public final String filename;
    public final String mime;
    public final byte[] note;
    public final String sha256;
    public final String senderUsername;

    Payload(String filename, String mime, byte[] note, String sha256, String senderUsername) {
      this.filename = filename;
      this.mime = mime;
      this.note = note;
      this.sha256 = sha256;
      this.senderUsername = senderUsername;
    }
  }

  /** Recipient public key directory entry. */
  public static final class Recipient {
    public final String deviceId;
    public final String publicKeySpkiB64url;

    public Recipient(String deviceId, String publicKeySpkiB64url) {
      this.deviceId = deviceId;
      this.publicKeySpkiB64url = publicKeySpkiB64url;
    }
  }

  /** Fixed cryptographic material for deterministic vector reproduction. */
  public static final class FixedMaterial {
    public final byte[] contentKey;
    public final byte[] contentIv;
    /** Per-recipient ephemeral key material: PKCS#8 and matching SPKI DER. */
    public final List<byte[]> ephemeralPkcs8;
    public final List<byte[]> ephemeralSpki;
    public final List<byte[]> wrapIvs;

    public FixedMaterial(byte[] contentKey, byte[] contentIv,
        List<byte[]> ephemeralPkcs8, List<byte[]> ephemeralSpki, List<byte[]> wrapIvs) {
      this.contentKey = contentKey;
      this.contentIv = contentIv;
      this.ephemeralPkcs8 = ephemeralPkcs8;
      this.ephemeralSpki = ephemeralSpki;
      this.wrapIvs = wrapIvs;
    }
  }

  public static final class DeviceKeyPair {
    public final String deviceId;
    public final PrivateKey privateKey;
    public final String publicKeySpkiB64url;

    DeviceKeyPair(String deviceId, PrivateKey privateKey, String publicKeySpkiB64url) {
      this.deviceId = deviceId;
      this.privateKey = privateKey;
      this.publicKeySpkiB64url = publicKeySpkiB64url;
    }
  }

  private NoteV1() {}

  // ---- base64url ----------------------------------------------------------

  public static String b64url(byte[] data) {
    final StringBuilder out = new StringBuilder((data.length * 4 + 2) / 3);
    int i = 0;
    while (i + 2 < data.length) {
      final int v = (data[i] & 0xff) << 16 | (data[i + 1] & 0xff) << 8 | data[i + 2] & 0xff;
      out.append(B64_CHARS[v >>> 18]).append(B64_CHARS[v >>> 12 & 63])
          .append(B64_CHARS[v >>> 6 & 63]).append(B64_CHARS[v & 63]);
      i += 3;
    }
    final int rest = data.length - i;
    if (rest == 1) {
      final int v = (data[i] & 0xff) << 16;
      out.append(B64_CHARS[v >>> 18]).append(B64_CHARS[v >>> 12 & 63]);
    } else if (rest == 2) {
      final int v = (data[i] & 0xff) << 16 | (data[i + 1] & 0xff) << 8;
      out.append(B64_CHARS[v >>> 18]).append(B64_CHARS[v >>> 12 & 63]).append(B64_CHARS[v >>> 6 & 63]);
    }
    return out.toString();
  }

  public static byte[] fromB64url(String value, int maxBytes) throws ProtocolException {
    if (value == null || value.isEmpty()) throw new ProtocolException("empty base64url value");
    for (int i = 0; i < value.length(); i++) {
      final char c = value.charAt(i);
      if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_')) {
        throw new ProtocolException("invalid base64url character");
      }
    }
    if (value.length() > (maxBytes + 2) / 3 * 4 + 3 || value.length() > 4 * maxBytes + 3) {
      throw new ProtocolException("base64url value exceeds size limit");
    }
    final int leftover = value.length() % 4;
    if (leftover == 1) throw new ProtocolException("invalid base64url length");
    final int outLength = value.length() / 4 * 3 + (leftover == 2 ? 1 : leftover == 3 ? 2 : 0);
    if (outLength > maxBytes) throw new ProtocolException("base64url value exceeds size limit");
    final byte[] out = new byte[outLength];
    int outIndex = 0;
    int buffer = 0;
    int bits = 0;
    for (int i = 0; i < value.length(); i++) {
      final int v = b64Value(value.charAt(i));
      buffer = buffer << 6 | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[outIndex++] = (byte) (buffer >> bits);
      }
    }
    if (outIndex != outLength) throw new ProtocolException("invalid base64url length");
    if (!b64url(out).equals(value)) throw new ProtocolException("non-canonical base64url value");
    return out;
  }

  private static int b64Value(char c) throws ProtocolException {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '-') return 62;
    if (c == '_') return 63;
    throw new ProtocolException("invalid base64url character");
  }

  // ---- keys and crypto primitives -----------------------------------------

  public static DeviceKeyPair generateIdentity(String deviceId) throws ProtocolException {
    try {
      final KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
      generator.initialize(new ECGenParameterSpec(CURVE));
      final KeyPair pair = generator.generateKeyPair();
      return new DeviceKeyPair(deviceId, pair.getPrivate(), b64url(pair.getPublic().getEncoded()));
    } catch (Exception error) {
      throw new ProtocolException("identity generation failed", error);
    }
  }

  public static PrivateKey importPkcs8(byte[] pkcs8) throws ProtocolException {
    try {
      return KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(pkcs8));
    } catch (Exception error) {
      throw new ProtocolException("invalid PKCS#8 private key", error);
    }
  }

  public static PublicKey importSpki(byte[] spki) throws ProtocolException {
    if (spki.length < 60 || spki.length > 140) {
      throw new ProtocolException("public key has unexpected P-256 SPKI size");
    }
    try {
      return KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(spki));
    } catch (Exception error) {
      throw new ProtocolException("invalid public key", error);
    }
  }

  /** Raw ECDH shared secret: the fixed-size x coordinate (32 bytes for P-256). */
  static byte[] ecdh(PrivateKey privateKey, PublicKey publicKey) throws ProtocolException {
    try {
      final KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
      agreement.init(privateKey);
      agreement.doPhase(publicKey, true);
      final byte[] secret = agreement.generateSecret();
      if (secret.length != CONTENT_KEY_BYTES) {
        throw new ProtocolException("unexpected ECDH secret length " + secret.length);
      }
      return secret;
    } catch (ProtocolException error) {
      throw error;
    } catch (Exception error) {
      throw new ProtocolException("ECDH failed", error);
    }
  }

  /** HKDF-SHA-256 (RFC 5869) with an empty salt. */
  static byte[] hkdfSha256(byte[] secret, byte[] info, int length) throws ProtocolException {
    try {
      final Mac mac = Mac.getInstance("HmacSHA256");
      mac.init(new SecretKeySpec(new byte[32], "HmacSHA256")); // extract with zero salt
      mac.update(secret);
      final byte[] prk = mac.doFinal();
      mac.init(new SecretKeySpec(prk, "HmacSHA256"));
      final byte[] out = new byte[length];
      int produced = 0;
      byte counter = 1;
      byte[] previous = new byte[0];
      while (produced < length) {
        mac.reset();
        mac.update(previous);
        mac.update(info);
        mac.update(counter);
        previous = mac.doFinal();
        final int take = Math.min(previous.length, length - produced);
        System.arraycopy(previous, 0, out, produced, take);
        produced += take;
        counter++;
      }
      return out;
    } catch (Exception error) {
      throw new ProtocolException("HKDF failed", error);
    }
  }

  static byte[] aesGcmEncrypt(byte[] key, byte[] iv, byte[] plaintext, byte[] aad) throws ProtocolException {
    try {
      final Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
      if (aad != null) cipher.updateAAD(aad);
      return cipher.doFinal(plaintext);
    } catch (Exception error) {
      throw new ProtocolException("AES-GCM encrypt failed", error);
    }
  }

  static byte[] aesGcmDecrypt(byte[] key, byte[] iv, byte[] ciphertextAndTag, byte[] aad) throws ProtocolException {
    if (ciphertextAndTag.length < GCM_TAG_BYTES) throw new ProtocolException("ciphertext missing GCM tag");
    try {
      final Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
      if (aad != null) cipher.updateAAD(aad);
      return cipher.doFinal(ciphertextAndTag);
    } catch (Exception error) {
      throw new ProtocolException("AES-GCM decrypt failed", error);
    }
  }

  public static byte[] sha256(byte[] data) throws ProtocolException {
    try {
      return java.security.MessageDigest.getInstance("SHA-256").digest(data);
    } catch (Exception error) {
      throw new ProtocolException("SHA-256 failed", error);
    }
  }

  // ---- AAD ----------------------------------------------------------------

  static byte[] contentAad(String recordId, String toUserId, long toDirectoryVersion) {
    return (AAD_PREFIX + "\u0000" + recordId + "\u0000" + toUserId + "\u0000" + toDirectoryVersion)
        .getBytes(StandardCharsets.UTF_8);
  }

  static byte[] slotAad(String recordId, String toUserId, long toDirectoryVersion, String deviceId) {
    return (AAD_PREFIX + "\u0000" + recordId + "\u0000" + toUserId + "\u0000" + toDirectoryVersion
        + "\u0000" + deviceId).getBytes(StandardCharsets.UTF_8);
  }

  // ---- payload ------------------------------------------------------------

  static byte[] payloadPlaintext(String filename, byte[] note, String senderUsername) throws ProtocolException {
    if (filename == null || filename.isEmpty() || filename.length() > 512) {
      throw new ProtocolException("invalid filename");
    }
    if (senderUsername == null || senderUsername.isEmpty()) {
      throw new ProtocolException("invalid sender username");
    }
    return ("{\"version\":1,\"filename\":" + jsonString(filename)
        + ",\"mime\":\"application/x-supernote\",\"note\":" + jsonString(b64url(note))
        + ",\"sha256\":" + jsonString(b64url(sha256(note)))
        + ",\"senderUsername\":" + jsonString(senderUsername) + "}")
        .getBytes(StandardCharsets.UTF_8);
  }

  static Payload parsePayload(byte[] plaintext) throws ProtocolException {
    final Object parsed;
    try {
      parsed = Json.parse(new String(plaintext, StandardCharsets.UTF_8));
    } catch (RuntimeException error) {
      throw new ProtocolException("invalid encrypted note payload");
    }
    if (!(parsed instanceof Map)) throw new ProtocolException("invalid encrypted note payload");
    final Map<?, ?> payload = (Map<?, ?>) parsed;
    if (!Long.valueOf(VERSION).equals(payload.get("version"))
        || !(payload.get("filename") instanceof String)
        || !(payload.get("mime") instanceof String)
        || !(payload.get("note") instanceof String)
        || !(payload.get("sha256") instanceof String)) {
      throw new ProtocolException("invalid encrypted note payload");
    }
    final String filename = (String) payload.get("filename");
    final String mime = (String) payload.get("mime");
    if (!filename.toLowerCase().endsWith(".note") || filename.length() > 512
        || !"application/x-supernote".equals(mime)) {
      throw new ProtocolException("unsupported encrypted note metadata");
    }
    final byte[] note = fromB64url((String) payload.get("note"), MAX_NOTE_BYTES);
    final String sha256 = (String) payload.get("sha256");
    if (!b64url(sha256(note)).equals(sha256)) throw new ProtocolException("note integrity check failed");
    final Object sender = payload.get("senderUsername");
    return new Payload(filename, mime, note, sha256,
        sender instanceof String && !((String) sender).isEmpty() ? (String) sender : "Unknown sender");
  }

  // ---- record encryption --------------------------------------------------

  /** Production path: fresh random content key, IVs, and ephemeral keys. */
  public static String encryptNoteForDevices(
      String filename, byte[] note, String senderUsername,
      String recordId, String fromUserId, String fromDeviceId,
      String toUserId, long toDirectoryVersion, List<Recipient> recipients) throws ProtocolException {
    final SecureRandom random = new SecureRandom();
    final byte[] contentKey = new byte[CONTENT_KEY_BYTES];
    random.nextBytes(contentKey);
    final byte[] contentIv = new byte[GCM_IV_BYTES];
    random.nextBytes(contentIv);
    return encrypt(filename, note, senderUsername, recordId, fromUserId, fromDeviceId,
        toUserId, toDirectoryVersion, recipients,
        new FixedMaterial(contentKey, contentIv, new ArrayList<>(), new ArrayList<>(), new ArrayList<>()),
        random);
  }

  /** Deterministic path used only for committed interop vectors. */
  public static String encryptWithFixedMaterial(
      String filename, byte[] note, String senderUsername,
      String recordId, String fromUserId, String fromDeviceId,
      String toUserId, long toDirectoryVersion, List<Recipient> recipients,
      FixedMaterial material) throws ProtocolException {
    return encrypt(filename, note, senderUsername, recordId, fromUserId, fromDeviceId,
        toUserId, toDirectoryVersion, recipients, material, null);
  }

  private static byte[] newRandomIv(SecureRandom random) {
    if (random == null) return null;
    final byte[] iv = new byte[GCM_IV_BYTES];
    random.nextBytes(iv);
    return iv;
  }

  private static String encrypt(
      String filename, byte[] note, String senderUsername,
      String recordId, String fromUserId, String fromDeviceId,
      String toUserId, long toDirectoryVersion, List<Recipient> recipients,
      FixedMaterial material, SecureRandom random) throws ProtocolException {
    requireIdentifier(recordId, "record id");
    requireIdentifier(fromUserId, "from user id");
    requireIdentifier(fromDeviceId, "from device id");
    requireIdentifier(toUserId, "to user id");
    if (toDirectoryVersion < 1) throw new ProtocolException("invalid directory version");
    if (recipients == null || recipients.isEmpty()) throw new ProtocolException("recipient list is empty");
    if (note == null || note.length == 0 || note.length > MAX_NOTE_BYTES) {
      throw new ProtocolException("invalid note size");
    }
    if (material.contentKey.length != CONTENT_KEY_BYTES) throw new ProtocolException("invalid content key");
    if (material.contentIv.length != GCM_IV_BYTES) throw new ProtocolException("invalid content IV");

    final byte[] plaintext = payloadPlaintext(filename, note, senderUsername);
    final byte[] aad = contentAad(recordId, toUserId, toDirectoryVersion);
    final byte[] ciphertext = aesGcmEncrypt(material.contentKey, material.contentIv, plaintext, aad);

    final StringBuilder slots = new StringBuilder("[");
    for (int i = 0; i < recipients.size(); i++) {
      final Recipient recipient = recipients.get(i);
      requireIdentifier(recipient.deviceId, "recipient device id");
      final PublicKey recipientPublic = importSpki(fromB64url(recipient.publicKeySpkiB64url, 512));
      if (!(recipientPublic instanceof ECKey)) throw new ProtocolException("public key is not EC");
      PrivateKey ephemeralPrivate;
      byte[] ephemeralSpki;
      if (i < material.ephemeralPkcs8.size()) {
        ephemeralPrivate = importPkcs8(material.ephemeralPkcs8.get(i));
        if (i >= material.ephemeralSpki.size()) throw new ProtocolException("missing ephemeral SPKI");
        ephemeralSpki = material.ephemeralSpki.get(i);
      } else {
        try {
          final KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
          generator.initialize(new ECGenParameterSpec(CURVE));
          final KeyPair pair = generator.generateKeyPair();
          ephemeralPrivate = pair.getPrivate();
          ephemeralSpki = pair.getPublic().getEncoded();
        } catch (Exception error) {
          throw new ProtocolException("ephemeral key generation failed", error);
        }
      }
      final byte[] wrapKey = hkdfSha256(ecdh(ephemeralPrivate, recipientPublic), aad, CONTENT_KEY_BYTES);
      final byte[] wrapIv = i < material.wrapIvs.size() && material.wrapIvs.get(i) != null
          ? material.wrapIvs.get(i) : newRandomIv(random);
      if (wrapIv == null || wrapIv.length != GCM_IV_BYTES) throw new ProtocolException("invalid wrap IV");
      final byte[] wrapped = aesGcmEncrypt(wrapKey, wrapIv, material.contentKey,
          slotAad(recordId, toUserId, toDirectoryVersion, recipient.deviceId));
      if (i > 0) slots.append(',');
      slots.append("{\"deviceId\":").append(jsonString(recipient.deviceId))
          .append(",\"ephemeralPublicKeySpki\":").append(jsonString(b64url(ephemeralSpki)))
          .append(",\"wrapIv\":").append(jsonString(b64url(wrapIv)))
          .append(",\"wrappedContentKey\":").append(jsonString(b64url(wrapped))).append('}');
    }
    slots.append(']');

    return "{\"version\":1,\"id\":" + jsonString(recordId)
        + ",\"fromUserId\":" + jsonString(fromUserId)
        + ",\"fromDeviceId\":" + jsonString(fromDeviceId)
        + ",\"toUserId\":" + jsonString(toUserId)
        + ",\"toDirectoryVersion\":" + toDirectoryVersion
        + ",\"contentIv\":" + jsonString(b64url(material.contentIv))
        + ",\"ciphertext\":" + jsonString(b64url(ciphertext))
        + ",\"keySlots\":" + slots + "}";
  }

  public static Payload decryptForDevice(String recordJson, String deviceId, PrivateKey privateKey)
      throws ProtocolException {
    requireIdentifier(deviceId, "device id");
    final Object parsed;
    try {
      parsed = Json.parse(recordJson);
    } catch (RuntimeException error) {
      throw new ProtocolException("malformed encrypted delivery");
    }
    if (!(parsed instanceof Map)) throw new ProtocolException("malformed encrypted delivery");
    final Map<?, ?> record = (Map<?, ?>) parsed;
    if (!Long.valueOf(VERSION).equals(record.get("version"))
        || !(record.get("id") instanceof String)
        || !(record.get("toUserId") instanceof String)
        || !(record.get("toDirectoryVersion") instanceof Long)) {
      throw new ProtocolException("malformed encrypted delivery");
    }
    final String recordId = (String) record.get("id");
    final String toUserId = (String) record.get("toUserId");
    final long directoryVersion = (Long) record.get("toDirectoryVersion");
    requireIdentifier(recordId, "record id");
    requireIdentifier(toUserId, "to user id");
    if (directoryVersion < 1) throw new ProtocolException("malformed encrypted delivery");
    if (!(record.get("contentIv") instanceof String) || !(record.get("ciphertext") instanceof String)
        || !(record.get("keySlots") instanceof List) || ((List<?>) record.get("keySlots")).isEmpty()) {
      throw new ProtocolException("malformed encrypted delivery");
    }
    final byte[] contentIv = fromB64url((String) record.get("contentIv"), GCM_IV_BYTES);
    if (contentIv.length != GCM_IV_BYTES) throw new ProtocolException("invalid content IV");
    final byte[] ciphertext = fromB64url((String) record.get("ciphertext"), MAX_CIPHERTEXT_BYTES);

    Map<?, ?> deviceSlot = null;
    for (Object slot : (List<?>) record.get("keySlots")) {
      if (slot instanceof Map && deviceId.equals(((Map<?, ?>) slot).get("deviceId"))) {
        deviceSlot = (Map<?, ?>) slot;
        break;
      }
    }
    if (deviceSlot == null) throw new ProtocolException("delivery has no key slot for this device");
    if (!(deviceSlot.get("ephemeralPublicKeySpki") instanceof String)
        || !(deviceSlot.get("wrapIv") instanceof String)
        || !(deviceSlot.get("wrappedContentKey") instanceof String)) {
      throw new ProtocolException("malformed key slot");
    }
    final PublicKey ephemeralPublic = importSpki(
        fromB64url((String) deviceSlot.get("ephemeralPublicKeySpki"), 512));
    final byte[] wrapIv = fromB64url((String) deviceSlot.get("wrapIv"), GCM_IV_BYTES);
    if (wrapIv.length != GCM_IV_BYTES) throw new ProtocolException("invalid wrap IV");
    final byte[] wrapped = fromB64url((String) deviceSlot.get("wrappedContentKey"), 1024);

    final byte[] aad = contentAad(recordId, toUserId, directoryVersion);
    final byte[] wrapKey = hkdfSha256(ecdh(privateKey, ephemeralPublic), aad, CONTENT_KEY_BYTES);
    final byte[] contentKey = aesGcmDecrypt(wrapKey, wrapIv, wrapped,
        slotAad(recordId, toUserId, directoryVersion, deviceId));
    if (contentKey.length != CONTENT_KEY_BYTES) throw new ProtocolException("invalid wrapped content key");
    final byte[] plaintext = aesGcmDecrypt(contentKey, contentIv, ciphertext, aad);
    return parsePayload(plaintext);
  }

  static void requireIdentifier(String value, String name) throws ProtocolException {
    if (value == null || !value.matches(IDENTIFIER)) throw new ProtocolException("invalid " + name);
  }

  public static String randomRecordId() {
    return UUID.randomUUID().toString();
  }

  // ---- JSON ---------------------------------------------------------------

  public static String jsonString(String value) {
    final StringBuilder out = new StringBuilder(value.length() + 2);
    out.append('"');
    for (int i = 0; i < value.length(); i++) {
      final char c = value.charAt(i);
      switch (c) {
        case '"': out.append("\\\""); break;
        case '\\': out.append("\\\\"); break;
        case '\b': out.append("\\b"); break;
        case '\f': out.append("\\f"); break;
        case '\n': out.append("\\n"); break;
        case '\r': out.append("\\r"); break;
        case '\t': out.append("\\t"); break;
        default:
          if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
          else out.append(c);
      }
    }
    return out.append('"').toString();
  }

  /**
   * Strict minimal JSON parser: objects (ordered, duplicate keys rejected),
   * arrays, strings with escapes, integral/decimal numbers, booleans, null.
   */
  public static final class Json {
    private final String text;
    private int position;

    private Json(String text) { this.text = text; }

    public static Object parse(String text) {
      final Json parser = new Json(text);
      parser.skipWhitespace();
      final Object value = parser.value();
      parser.skipWhitespace();
      if (parser.position != parser.text.length()) throw new IllegalArgumentException("trailing content");
      return value;
    }

    /** Canonical serializer: preserves parse order; String/Boolean/Long/Double/Map/List/null. */
    public static String write(Object value) {
      final StringBuilder out = new StringBuilder();
      writeValue(value, out);
      return out.toString();
    }

    private static void writeValue(Object value, StringBuilder out) {
      if (value == null) {
        out.append("null");
      } else if (value instanceof String) {
        out.append(jsonString((String) value));
      } else if (value instanceof Boolean || value instanceof Long) {
        out.append(value);
      } else if (value instanceof Double) {
        final double d = (Double) value;
        if (d != d || Double.isInfinite(d)) throw new IllegalArgumentException("unserializable number");
        out.append(d % 1 == 0 ? Long.toString((long) d) : Double.toString(d));
      } else if (value instanceof Map) {
        out.append('{');
        boolean first = true;
        for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
          if (!first) out.append(',');
          first = false;
          writeValue(String.valueOf(entry.getKey()), out);
          out.append(':');
          writeValue(entry.getValue(), out);
        }
        out.append('}');
      } else if (value instanceof List) {
        out.append('[');
        boolean first = true;
        for (Object item : (List<?>) value) {
          if (!first) out.append(',');
          first = false;
          writeValue(item, out);
        }
        out.append(']');
      } else {
        throw new IllegalArgumentException("unserializable value " + value.getClass().getSimpleName());
      }
    }

    private Object value() {
      if (position >= text.length()) throw new IllegalArgumentException("unexpected end");
      final char c = text.charAt(position);
      switch (c) {
        case '{': return object();
        case '[': return array();
        case '"': return string();
        case 't': expect("true"); return Boolean.TRUE;
        case 'f': expect("false"); return Boolean.FALSE;
        case 'n': expect("null"); return null;
        default: return number();
      }
    }

    private Map<String, Object> object() {
      final Map<String, Object> map = new LinkedHashMap<>();
      position++; // {
      skipWhitespace();
      if (peek() == '}') { position++; return map; }
      while (true) {
        skipWhitespace();
        if (peek() != '"') throw new IllegalArgumentException("expected key");
        final String key = string();
        if (map.containsKey(key)) throw new IllegalArgumentException("duplicate key");
        skipWhitespace();
        if (peek() != ':') throw new IllegalArgumentException("expected colon");
        position++;
        skipWhitespace();
        map.put(key, value());
        skipWhitespace();
        final char next = peek();
        if (next == ',') { position++; continue; }
        if (next == '}') { position++; return map; }
        throw new IllegalArgumentException("expected comma or brace");
      }
    }

    private List<Object> array() {
      final List<Object> list = new ArrayList<>();
      position++; // [
      skipWhitespace();
      if (peek() == ']') { position++; return list; }
      while (true) {
        skipWhitespace();
        list.add(value());
        skipWhitespace();
        final char next = peek();
        if (next == ',') { position++; continue; }
        if (next == ']') { position++; return list; }
        throw new IllegalArgumentException("expected comma or bracket");
      }
    }

    private String string() {
      position++; // "
      final StringBuilder out = new StringBuilder();
      while (true) {
        if (position >= text.length()) throw new IllegalArgumentException("unterminated string");
        final char c = text.charAt(position++);
        if (c == '"') return out.toString();
        if (c < 0x20) throw new IllegalArgumentException("unescaped control character");
        if (c != '\\') { out.append(c); continue; }
        final char escape = text.charAt(position++);
        switch (escape) {
          case '"': out.append('"'); break;
          case '\\': out.append('\\'); break;
          case '/': out.append('/'); break;
          case 'b': out.append('\b'); break;
          case 'f': out.append('\f'); break;
          case 'n': out.append('\n'); break;
          case 'r': out.append('\r'); break;
          case 't': out.append('\t'); break;
          case 'u':
            if (position + 4 > text.length()) throw new IllegalArgumentException("bad unicode escape");
            out.append((char) Integer.parseInt(text.substring(position, position + 4), 16));
            position += 4;
            break;
          default: throw new IllegalArgumentException("bad escape");
        }
      }
    }

    private Number number() {
      final int start = position;
      if (peek() == '-') position++;
      while (position < text.length() && "0123456789.eE+-".indexOf(text.charAt(position)) >= 0) position++;
      final String token = text.substring(start, position);
      if (token.isEmpty() || token.equals("-")) throw new IllegalArgumentException("bad number");
      try {
        if (token.matches("-?\\d+")) {
          return Long.parseLong(token);
        }
        return Double.parseDouble(token);
      } catch (NumberFormatException error) {
        throw new IllegalArgumentException("bad number");
      }
    }

    private void expect(String literal) {
      if (!text.startsWith(literal, position)) throw new IllegalArgumentException("bad literal");
      position += literal.length();
    }

    private char peek() {
      if (position >= text.length()) throw new IllegalArgumentException("unexpected end");
      return text.charAt(position);
    }

    private void skipWhitespace() {
      while (position < text.length() && " \t\r\n".indexOf(text.charAt(position)) >= 0) position++;
    }
  }
}
