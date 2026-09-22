package com.olaink.nativeexp.e2;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Log;

import com.olaink.nativeexp.crypto.NoteV1;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Durable E2 profile: a keystore-wrapped software P-256 identity plus paired
 * account/session state, stored ONLY inside the per-plugin tree
 * (files/plugins/&lt;id&gt;/olaink-profile/) — the one location the E1 hostile
 * probe proved other plugins cannot read. Ciphertext inbox records persist
 * under inbox/. Everything is removed on logout.
 */
public final class E2Profile {
  private static final String TAG = "OlaInkNativeExp";
  private static final String KEYSTORE_WRAP_ALIAS = "olaink-e2-wrap";
  private static final String IDENTITY_FILE = "identity.json";
  private static final String INBOX_DIR = "inbox";

  private final File profileDir;
  private final File identityFile;
  private final File inboxDir;

  private String deviceId;
  private String publicSpkiB64url;
  private PrivateKey privateKey;
  private String userId;
  private String username;
  private String sessionToken;

  public E2Profile(Context context, String pluginId) {
    profileDir = new File(
        new File(context.getFilesDir(), "plugins" + File.separator + pluginId), "olaink-profile");
    identityFile = new File(profileDir, IDENTITY_FILE);
    inboxDir = new File(profileDir, INBOX_DIR);
  }

  public boolean isLoaded() {
    return deviceId != null && privateKey != null;
  }

  public boolean isPaired() {
    return isLoaded() && userId != null && sessionToken != null;
  }

  public String deviceId() { return deviceId; }
  public String userId() { return userId; }
  public String username() { return username == null ? "" : username; }
  public String sessionToken() { return sessionToken; }
  public PrivateKey privateKey() { return privateKey; }
  public String publicSpki() { return publicSpkiB64url; }

  public int inboxCount() {
    final File[] files = inboxDir == null || !inboxDir.isDirectory() ? null : inboxDir.listFiles();
    return files == null ? 0 : files.length;
  }

  /** Loads the persisted profile if present; returns whether it was loaded. */
  public boolean load() throws Exception {
    if (!identityFile.isFile()) return false;
    final Map<String, Object> data = cast(NoteV1.Json.parse(
        new String(Files.readAllBytes(identityFile.toPath()), StandardCharsets.UTF_8)));
    final String wrapped = str(data.get("wrappedPkcs8B64url"));
    final String iv = str(data.get("ivB64url"));
    deviceId = str(data.get("deviceId"));
    publicSpkiB64url = str(data.get("publicSpkiB64url"));
    userId = str(data.get("userId"));
    username = str(data.get("username"));
    sessionToken = str(data.get("sessionToken"));
    if (wrapped == null || iv == null || deviceId == null || publicSpkiB64url == null) {
      throw new IOException("profile identity fields are incomplete");
    }
    final SecretKey wrappingKey = existingWrappingKey();
    if (wrappingKey == null) throw new IOException("wrapping key is missing from keystore");
    final Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.DECRYPT_MODE, wrappingKey,
        new GCMParameterSpec(128, NoteV1.fromB64url(iv, 16)));
    final byte[] pkcs8 = cipher.doFinal(NoteV1.fromB64url(wrapped, 8192));
    privateKey = NoteV1.importPkcs8(pkcs8);
    return true;
  }

  /** Generates and persists a fresh identity if none exists. */
  public void ensureIdentity() throws Exception {
    if (load()) return;
    final NoteV1.DeviceKeyPair identity = NoteV1.generateIdentity(
        "device_e2_" + randomToken(8));
    final byte[] pkcs8 = identity.privateKey.getEncoded();
    if (pkcs8 == null) throw new IOException("software private key is not exportable");
    final SecretKey wrappingKey = ensureWrappingKey();
    final byte[] iv = new byte[12];
    new SecureRandom().nextBytes(iv);
    final Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.ENCRYPT_MODE, wrappingKey, new GCMParameterSpec(128, iv));
    final byte[] wrapped = cipher.doFinal(pkcs8);
    deviceId = identity.deviceId;
    publicSpkiB64url = identity.publicKeySpkiB64url;
    privateKey = identity.privateKey;
    userId = null;
    username = null;
    sessionToken = null;
    persistIdentity(wrapped, iv);
    Log.i(TAG, "E2 identity created deviceId=" + deviceId);
  }

  /** Stores pairing results after a successful claim. */
  public void applyPairing(String userId, String username, String sessionToken) throws Exception {
    this.userId = userId;
    this.username = username;
    this.sessionToken = sessionToken;
    final Map<String, Object> data = readIdentityMap();
    final byte[] wrapped = NoteV1.fromB64url(str(data.get("wrappedPkcs8B64url")), 8192);
    persistIdentity(wrapped, NoteV1.fromB64url(str(data.get("ivB64url")), 16));
  }

  /** Persists one ciphertext inbox record; returns its stored file name. */
  public String storeRecord(String recordId, String recordJson) throws IOException {
    if (!inboxDir.isDirectory() && !inboxDir.mkdirs()) {
      throw new IOException("could not create inbox directory");
    }
    final File file = new File(inboxDir, recordId + ".json");
    writeAtomically(file, recordJson.getBytes(StandardCharsets.UTF_8));
    return file.getName();
  }

  /** True only for a ciphertext record this device already decrypted and persisted. */
  public boolean hasStoredRecord(String recordId) {
    return recordId != null && recordId.matches("^[A-Za-z0-9_-]{1,128}$")
        && new File(inboxDir, recordId + ".json").isFile();
  }

  public List<String> storedRecordIds() {
    final List<String> ids = new ArrayList<>();
    final File[] files = inboxDir == null || !inboxDir.isDirectory() ? null : inboxDir.listFiles();
    if (files != null) {
      for (File file : files) {
        final String name = file.getName();
        if (name.endsWith(".json")) ids.add(name.substring(0, name.length() - 5));
      }
    }
    return ids;
  }

  /** Deletes the profile, inbox, and keystore wrapping alias (logout). */
  public void clear() throws Exception {
    deleteRecursive(profileDir);
    deviceId = null;
    publicSpkiB64url = null;
    privateKey = null;
    userId = null;
    username = null;
    sessionToken = null;
    try {
      final KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
      keyStore.load(null);
      if (keyStore.containsAlias(KEYSTORE_WRAP_ALIAS)) keyStore.deleteEntry(KEYSTORE_WRAP_ALIAS);
    } catch (Exception error) {
      Log.w(TAG, "could not delete E2 wrapping alias", error);
    }
  }

  // ---- internals ----------------------------------------------------------

  private Map<String, Object> readIdentityMap() throws IOException {
    if (!identityFile.isFile()) throw new IOException("identity file missing");
    return cast(NoteV1.Json.parse(
        new String(Files.readAllBytes(identityFile.toPath()), StandardCharsets.UTF_8)));
  }

  private void persistIdentity(byte[] wrappedPkcs8, byte[] iv) throws IOException {
    if (!profileDir.isDirectory() && !profileDir.mkdirs()) {
      throw new IOException("could not create profile directory");
    }
    final String json = "{\"deviceId\":" + NoteV1.jsonString(deviceId)
        + ",\"publicSpkiB64url\":" + NoteV1.jsonString(publicSpkiB64url)
        + ",\"wrappedPkcs8B64url\":" + NoteV1.jsonString(NoteV1.b64url(wrappedPkcs8))
        + ",\"ivB64url\":" + NoteV1.jsonString(NoteV1.b64url(iv))
        + ",\"userId\":" + (userId == null ? "null" : NoteV1.jsonString(userId))
        + ",\"username\":" + (username == null ? "null" : NoteV1.jsonString(username))
        + ",\"sessionToken\":" + (sessionToken == null ? "null" : NoteV1.jsonString(sessionToken))
        + "}";
    writeAtomically(identityFile, json.getBytes(StandardCharsets.UTF_8));
  }

  private static SecretKey ensureWrappingKey() throws Exception {
    final KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
    keyStore.load(null);
    final SecretKey existing = existingWrappingKey();
    if (existing != null) return existing;
    final KeyGenerator generator = KeyGenerator.getInstance("AES", "AndroidKeyStore");
    generator.init(new KeyGenParameterSpec.Builder(KEYSTORE_WRAP_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .setRandomizedEncryptionRequired(false)
        .build());
    return generator.generateKey();
  }

  private static SecretKey existingWrappingKey() throws Exception {
    final KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
    keyStore.load(null);
    if (!keyStore.containsAlias(KEYSTORE_WRAP_ALIAS)) return null;
    return (SecretKey) keyStore.getKey(KEYSTORE_WRAP_ALIAS, null);
  }

  private static void writeAtomically(File destination, byte[] data) throws IOException {
    final File parent = destination.getParentFile();
    if (parent == null || (!parent.isDirectory() && !parent.mkdirs())) {
      throw new IOException("could not create " + parent);
    }
    final File temporary = File.createTempFile("." + destination.getName(), ".tmp", parent);
    try (FileOutputStream output = new FileOutputStream(temporary)) {
      output.write(data);
      output.getFD().sync();
    } catch (IOException error) {
      temporary.delete();
      throw error;
    }
    if (destination.exists() && !destination.delete()) {
      temporary.delete();
      throw new IOException("could not replace " + destination);
    }
    if (!temporary.renameTo(destination)) {
      temporary.delete();
      throw new IOException("could not move " + destination);
    }
  }

  private static void deleteRecursive(File file) {
    if (file == null || !file.exists()) return;
    final File[] children = file.listFiles();
    if (children != null) {
      for (File child : children) deleteRecursive(child);
    }
    if (!file.delete()) Log.w(TAG, "could not delete " + file.getName());
  }

  private static String randomToken(int length) {
    final String alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    final SecureRandom random = new SecureRandom();
    final StringBuilder out = new StringBuilder(length);
    for (int i = 0; i < length; i++) {
      out.append(alphabet.charAt(random.nextInt(alphabet.length())));
    }
    return out.toString();
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> cast(Object value) {
    if (value instanceof Map) return (Map<String, Object>) value;
    throw new ClassCastException("expected object");
  }

  private static String str(Object value) {
    return value instanceof String ? (String) value : null;
  }
}
