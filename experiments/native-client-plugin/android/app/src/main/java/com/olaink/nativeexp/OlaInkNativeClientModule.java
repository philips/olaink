package com.olaink.nativeexp;

import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Log;

import androidx.annotation.Nullable;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;
import com.olaink.nativeexp.crypto.NoteV1;
import com.olaink.nativeexp.e2.E2Controller;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.spec.ECGenParameterSpec;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * E1 probe surface: protocol interop, Android Keystore capability discovery,
 * wrapped-key fallback, and durable-state sentinels. Every method reports
 * evidence; none of them contacts the network, reads a note, or creates a
 * production identity. All key material in this phase is throwaway.
 */
public final class OlaInkNativeClientModule extends ReactContextBaseJavaModule {
  private static final String TAG = "OlaInkNativeExp";
  private static final String PLUGIN_ID = "olainknativeexp1";
  private static final int NATIVE_REVISION = 11;
  private static final String KEYSTORE_ECDH_ALIAS = "olaink-e1-ecdh-probe";
  private static final String KEYSTORE_WRAP_ALIAS = "olaink-e1-wrap";
  private static final String F0_NOTE_ROOT = "/storage/emulated/0/Note";
  private static final long F0_MAX_NOTE_BYTES = 5L * 1024L * 1024L;
  private static final String SENTINEL_NAME = "e1-sentinel.json";
  private static final String WRAPPED_IDENTITY_NAME = "e1-wrapped-identity.json";

  @Nullable
  private E2Controller e2;

  public OlaInkNativeClientModule(ReactApplicationContext context) {
    super(context);
    Log.i(TAG, "native module constructed phase=file-exchange revision=" + NATIVE_REVISION);
  }

  @Override
  public String getName() {
    return "OlaInkNativeClient";
  }

  @ReactMethod
  public void describe(Promise promise) {
    final WritableMap result = Arguments.createMap();
    result.putString("packageName", getReactApplicationContext().getPackageName());
    result.putInt("apiLevel", Build.VERSION.SDK_INT);
    result.putInt("experimentPhase", 4);
    result.putInt("nativeRevision", NATIVE_REVISION);
    result.putString("pluginId", PLUGIN_ID);
    result.putString("sceneViewName", "none");
    Log.i(TAG, "describe invoked phase=file-exchange revision=" + NATIVE_REVISION
        + " (no in-plugin renderer or converter)");
    promise.resolve(result);
  }

  // ---- F0: scoped current-note read / atomic Note-folder copy ------------

  /** Reads only metadata and a digest from a React-obtained current note path. */
  @ReactMethod
  public void f0InspectCurrentNote(String sourcePath, Promise promise) {
    try {
      final File source = f0Source(sourcePath);
      final long length = source.length();
      final String digest = NoteV1.b64url(NoteV1.sha256(readBounded(source, length)));
      promise.resolve("{\"ok\":true,\"filename\":" + NoteV1.jsonString(source.getName())
          + ",\"bytes\":" + length + ",\"sha256\":" + NoteV1.jsonString(digest) + "}");
    } catch (Exception error) {
      Log.w(TAG, "F0 read probe failed: " + error.getClass().getSimpleName());
      promise.reject("F0_READ", "current note was rejected", error);
    }
  }

  /** Copies an approved current note atomically into Note/ and returns that one destination for openFile. */
  @ReactMethod
  public void f0CopyCurrentNote(String sourcePath, Promise promise) {
    try {
      final File source = f0Source(sourcePath);
      final File root = new File(F0_NOTE_ROOT).getCanonicalFile();
      final String filename = "OlaInk-F0-" + System.currentTimeMillis() + ".note";
      final File destination = new File(root, filename).getCanonicalFile();
      if (!destination.getParentFile().equals(root)) throw new IOException("destination escaped Note root");
      final File temporary = new File(root, "." + filename + ".tmp");
      copyAndSync(source, temporary, source.length());
      if (!temporary.renameTo(destination)) {
        temporary.delete();
        throw new IOException("atomic rename failed");
      }
      promise.resolve("{\"ok\":true,\"destinationPath\":" + NoteV1.jsonString(destination.getPath())
          + ",\"filename\":" + NoteV1.jsonString(filename) + ",\"bytes\":" + destination.length() + "}");
    } catch (Exception error) {
      Log.w(TAG, "F0 copy probe failed: " + error.getClass().getSimpleName());
      promise.reject("F0_WRITE", "current note copy failed", error);
    }
  }

  private static File f0Source(String sourcePath) throws IOException {
    if (sourcePath == null || sourcePath.isEmpty()) throw new IOException("missing source");
    final File root = new File(F0_NOTE_ROOT).getCanonicalFile();
    final File source = new File(sourcePath).getCanonicalFile();
    if (!source.isFile() || !source.getName().endsWith(".note")
        || !source.getParentFile().equals(root)) throw new IOException("source outside Note root");
    final long length = source.length();
    if (length < 1 || length > F0_MAX_NOTE_BYTES) throw new IOException("source size rejected");
    return source;
  }

  private static byte[] readBounded(File source, long length) throws IOException {
    if (length > Integer.MAX_VALUE) throw new IOException("source too large");
    final byte[] bytes = new byte[(int) length];
    try (java.io.FileInputStream input = new java.io.FileInputStream(source)) {
      int offset = 0;
      while (offset < bytes.length) {
        final int count = input.read(bytes, offset, bytes.length - offset);
        if (count < 0) throw new IOException("source changed while reading");
        offset += count;
      }
      if (input.read() != -1 || source.length() != length) throw new IOException("source changed while reading");
    }
    return bytes;
  }

  private static void copyAndSync(File source, File temporary, long expectedLength) throws IOException {
    long copied = 0;
    try (java.io.FileInputStream input = new java.io.FileInputStream(source);
         FileOutputStream output = new FileOutputStream(temporary)) {
      final byte[] buffer = new byte[16 * 1024];
      int count;
      while ((count = input.read(buffer)) != -1) {
        copied += count;
        if (copied > F0_MAX_NOTE_BYTES) throw new IOException("source size rejected");
        output.write(buffer, 0, count);
      }
      output.getFD().sync();
    } catch (IOException error) {
      temporary.delete();
      throw error;
    }
    if (copied != expectedLength || source.length() != expectedLength) {
      temporary.delete();
      throw new IOException("source changed while copying");
    }
  }

  // ---- F2: React relay transport / NPK crypto-file bridge ----------------

  private E2Controller e2Controller() throws Exception {
    if (e2 == null) {
      e2 = new E2Controller(getReactApplicationContext(), PLUGIN_ID);
    }
    return e2;
  }

  /** Exposes only the fixed WebPKI staging origin for React's F2 transport. */
  @ReactMethod
  public void e2RelayBase(Promise promise) {
    try {
      final String[] relay = E2Controller.relayConfig(getReactApplicationContext(), PLUGIN_ID);
      promise.resolve(relay[0]);
    } catch (Exception error) {
      promise.reject("E2_RELAY_CONFIG", "staging relay configuration is unavailable", error);
    }
  }

  @ReactMethod
  public void e2Status(Promise promise) {
    runE2("status", controller -> controller.status(), promise);
  }

  @ReactMethod
  public void e2EnsureIdentity(Promise promise) {
    runE2("ensureIdentity", controller -> controller.ensureIdentity(), promise);
  }

  @ReactMethod
  public void e2SessionForReact(Promise promise) {
    runE2("sessionForReact", controller -> controller.sessionForReact(), promise);
  }

  @ReactMethod
  public void e2ApplyReactPairing(String userId, String username, String sessionToken, Promise promise) {
    runE2("applyReactPairing", controller -> controller.applyReactPairing(userId, username, sessionToken), promise);
  }

  @ReactMethod
  public void e2CreateFileRecord(String sourcePath, String directoryJson, Promise promise) {
    runE2("createFileRecord", controller -> controller.createFileRecord(sourcePath, directoryJson), promise);
  }

  @ReactMethod
  public void e2DecryptRecordToNote(String recordJson, Promise promise) {
    runE2("decryptRecordToNote", controller -> controller.decryptRecordToNote(recordJson), promise);
  }

  @ReactMethod
  public void e2ClearLocal(Promise promise) {
    runE2("clearLocal", controller -> controller.clearLocal(), promise);
  }

  private interface E2Call {
    String call(E2Controller controller) throws Exception;
  }

  /** Never let an E2 failure throw on the bridge thread: redact and reject. */
  private void runE2(String operation, E2Call call, Promise promise) {
    try {
      promise.resolve(call.call(e2Controller()));
    } catch (Exception error) {
      final String reason = error.getClass().getSimpleName();
      Log.w(TAG, "E2 " + operation + " failed: " + reason);
      promise.reject("E2_" + operation.toUpperCase(java.util.Locale.ROOT), reason, error);
    }
  }

  // ---- E1: protocol interop ----------------------------------------------

  /** Runs the committed vector suite on-device against the same oracle as the host-JVM tests. */
  @ReactMethod
  public void protocolSelfTest(Promise promise) {
    final long started = SystemClock();
    final WritableMap result = Arguments.createMap();
    int passed = 0;
    int failed = 0;
    final StringBuilder details = new StringBuilder();
    try {
      final Map<String, Object> vectors = loadVectors();
      final Map<String, Object> deterministic = cast(vectors.get("deterministic"));
      final Map<String, Object> randomCase = cast(vectors.get("randomWebCrypto"));

      // 1. Deterministic Java encrypt must reproduce the WebCrypto record byte-for-byte.
      try {
        final String produced = NoteV1.encryptWithFixedMaterial(
            str(inputs(deterministic).get("filename")),
            NoteV1.fromB64url(str(inputs(deterministic).get("noteB64url")), NoteV1.MAX_NOTE_BYTES),
            str(inputs(deterministic).get("senderUsername")),
            str(routing(deterministic).get("recordId")),
            str(routing(deterministic).get("fromUserId")),
            str(routing(deterministic).get("fromDeviceId")),
            str(routing(deterministic).get("toUserId")),
            (Long) routing(deterministic).get("toDirectoryVersion"),
            vectorRecipients(deterministic),
            vectorMaterial(deterministic));
        if (produced.equals(str(deterministic.get("expectedRecordJson")))) {
          passed++;
          details.append("deterministic-encrypt:byte-identical; ");
        } else {
          failed++;
          details.append("deterministic-encrypt:MISMATCH; ");
        }
      } catch (Exception error) {
        failed++;
        details.append("deterministic-encrypt:").append(error.getClass().getSimpleName()).append("; ");
      }

      // 2. Java decrypt of the WebCrypto record for every committed recipient.
      try {
        boolean allMatch = true;
        for (Map<String, Object> recipient : vectorRecipientMaps(deterministic)) {
          final PrivateKey privateKey = NoteV1.importPkcs8(
              NoteV1.fromB64url(str(recipient.get("privatePkcs8B64url")), 4096));
          final NoteV1.Payload payload = NoteV1.decryptForDevice(
              str(deterministic.get("expectedRecordJson")), str(recipient.get("deviceId")), privateKey);
          allMatch &= str(inputs(deterministic).get("filename")).equals(payload.filename)
              && str(inputs(deterministic).get("senderUsername")).equals(payload.senderUsername);
        }
        if (allMatch) {
          passed++;
          details.append("decrypt-webcrypto:ok-both-recipients; ");
        } else {
          failed++;
          details.append("decrypt-webcrypto:payload-mismatch; ");
        }
      } catch (Exception error) {
        failed++;
        details.append("decrypt-webcrypto:").append(error.getClass().getSimpleName()).append("; ");
      }

      // 3. Random-ephemeral WebCrypto record decrypts on-device.
      try {
        final PrivateKey privateKey = NoteV1.importPkcs8(
            NoteV1.fromB64url(str(randomCase.get("recipientPrivatePkcs8B64url")), 4096));
        final NoteV1.Payload payload = NoteV1.decryptForDevice(
            str(randomCase.get("recordJson")), str(randomCase.get("recipientDeviceId")), privateKey);
        if (str(inputs(randomCase).get("filename")).equals(payload.filename)) {
          passed++;
          details.append("decrypt-random-ephemeral:ok; ");
        } else {
          failed++;
          details.append("decrypt-random-ephemeral:mismatch; ");
        }
      } catch (Exception error) {
        failed++;
        details.append("decrypt-random-ephemeral:").append(error.getClass().getSimpleName()).append("; ");
      }

      // 4. Tamper rejection: flipped ciphertext char must fail authentication.
      try {
        final String record = str(deterministic.get("expectedRecordJson"));
        final int valueStart = record.indexOf("\"ciphertext\":\"") + "\"ciphertext\":\"".length();
        final int valueEnd = record.indexOf('"', valueStart);
        final char last = record.charAt(valueEnd - 1);
        final String flipped = record.substring(0, valueEnd - 1) + (last == 'A' ? 'B' : 'A')
            + record.substring(valueEnd);
        final Map<String, Object> recipient = vectorRecipientMaps(deterministic).get(0);
        final PrivateKey privateKey = NoteV1.importPkcs8(
            NoteV1.fromB64url(str(recipient.get("privatePkcs8B64url")), 4096));
        try {
          NoteV1.decryptForDevice(flipped, str(recipient.get("deviceId")), privateKey);
          failed++;
          details.append("tamper-ciphertext:NOT-REJECTED; ");
        } catch (NoteV1.ProtocolException expected) {
          passed++;
          details.append("tamper-ciphertext:rejected; ");
        }
      } catch (Exception error) {
        failed++;
        details.append("tamper-ciphertext:").append(error.getClass().getSimpleName()).append("; ");
      }
    } catch (Exception error) {
      failed++;
      details.append("vectors-load:").append(error.getClass().getSimpleName())
          .append(' ').append(String.valueOf(error.getMessage()));
      Log.w(TAG, "protocol self-test could not load vectors", error);
    }
    result.putInt("passed", passed);
    result.putInt("failed", failed);
    result.putString("details", details.toString());
    result.putDouble("elapsedMs", SystemClock() - started);
    Log.i(TAG, "protocol self-test passed=" + passed + " failed=" + failed + " details=" + details);
    promise.resolve(result);
  }

  // ---- E1: Android Keystore capability discovery --------------------------

  /** Determines whether this firmware's Android Keystore can perform P-256 ECDH itself. */
  @ReactMethod
  public void keystoreEcdhProbe(Promise promise) {
    final WritableMap result = Arguments.createMap();
    result.putBoolean("apiSupportsAgreePurpose", Build.VERSION.SDK_INT >= 31);
    result.putString("apiLevel", String.valueOf(Build.VERSION.SDK_INT));

    // (a) generate an AndroidKeyStore EC key with PURPOSE_AGREE_KEY
    boolean agreeKeyGenerated = false;
    String agreeKeyError = null;
    try {
      final KeyPairGenerator generator = KeyPairGenerator.getInstance("EC", "AndroidKeyStore");
      generator.initialize(new KeyGenParameterSpec.Builder(KEYSTORE_ECDH_ALIAS,
          KeyProperties.PURPOSE_AGREE_KEY)
          .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
          .build());
      generator.generateKeyPair();
      agreeKeyGenerated = true;
    } catch (Exception error) {
      agreeKeyError = error.getClass().getSimpleName() + ": " + error.getMessage();
    }
    result.putBoolean("agreeKeyGenerated", agreeKeyGenerated);
    result.putString("agreeKeyError", agreeKeyError);

    // (b) attempt an ECDH KeyAgreement through the AndroidKeyStore provider
    boolean agreementSucceeded = false;
    String agreementError = null;
    try {
      final KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
      keyStore.load(null);
      final PrivateKey privateKey = (PrivateKey) keyStore.getKey(KEYSTORE_ECDH_ALIAS, null);
      if (privateKey == null) throw new IllegalStateException("keystore key missing");
      final java.security.PublicKey publicKey =
          keyStore.getCertificate(KEYSTORE_ECDH_ALIAS).getPublicKey();
      final KeyAgreement agreement = KeyAgreement.getInstance("ECDH", "AndroidKeyStore");
      agreement.init(privateKey);
      agreement.doPhase(publicKey, true);
      agreement.generateSecret();
      agreementSucceeded = true;
    } catch (Exception error) {
      agreementError = error.getClass().getSimpleName() + ": " + error.getMessage();
    }
    result.putBoolean("ecdhAgreementSucceeded", agreementSucceeded);
    result.putString("agreementError", agreementError);

    // (c) KeyAgreement through the default (software) provider with a keystore key
    boolean softwareAgreementSucceeded = false;
    String softwareAgreementError = null;
    try {
      final KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
      keyStore.load(null);
      final PrivateKey privateKey = (PrivateKey) keyStore.getKey(KEYSTORE_ECDH_ALIAS, null);
      if (privateKey == null) throw new IllegalStateException("keystore key missing");
      final java.security.PublicKey publicKey =
          keyStore.getCertificate(KEYSTORE_ECDH_ALIAS).getPublicKey();
      final KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
      agreement.init(privateKey);
      agreement.doPhase(publicKey, true);
      agreement.generateSecret();
      softwareAgreementSucceeded = true;
    } catch (Exception error) {
      softwareAgreementError = error.getClass().getSimpleName() + ": " + error.getMessage();
    }
    result.putBoolean("softwareAgreementWithKeystoreKey", softwareAgreementSucceeded);
    result.putString("softwareAgreementError", softwareAgreementError);

    // Cleanup the probe alias so repeated runs start clean.
    try {
      final KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
      keyStore.load(null);
      keyStore.deleteEntry(KEYSTORE_ECDH_ALIAS);
    } catch (Exception error) {
      Log.w(TAG, "could not delete keystore probe alias", error);
    }

    result.putString("conclusion", agreementSucceeded
        ? "keystore-native ECDH available; non-extractable identity possible"
        : softwareAgreementSucceeded
            ? "keystore key usable via software KeyAgreement (unexpected; verify extractability)"
            : "keystore ECDH unavailable; wrapped-software-key fallback required");
    Log.i(TAG, "keystore ECDH probe: " + str(result.getString("conclusion")));
    promise.resolve(result);
  }

  // ---- E1: wrapped-software-key fallback ----------------------------------

  /**
   * Generates a throwaway software P-256 identity, wraps its PKCS#8 with an
   * AndroidKeyStore AES-GCM key, persists the wrapped blob in the candidate
   * state directory, then unwraps and verifies it. Non-secret evidence only.
   */
  @ReactMethod
  public void wrappedKeySelfTest(Promise promise) {
    final WritableMap result = Arguments.createMap();
    try {
      final NoteV1.DeviceKeyPair identity = NoteV1.generateIdentity("e1-throwaway-device");
      final byte[] pkcs8 = identity.privateKey.getEncoded();
      if (pkcs8 == null) throw new IOException("software private key is not exportable");

      final SecretKey wrappingKey = ensureWrappingKey();
      final byte[] iv = new byte[12];
      new SecureRandom().nextBytes(iv);
      final Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.ENCRYPT_MODE, wrappingKey, new GCMParameterSpec(128, iv));
      final byte[] wrapped = cipher.doFinal(pkcs8);

      final File store = new File(customStateDir(), WRAPPED_IDENTITY_NAME);
      writeAtomically(store, ("{\"wrappedPkcs8B64url\":\"" + NoteV1.b64url(wrapped)
          + "\",\"ivB64url\":\"" + NoteV1.b64url(iv)
          + "\",\"publicSpkiB64url\":\"" + identity.publicKeySpkiB64url
          + "\",\"deviceId\":\"" + identity.deviceId + "\"}").getBytes(StandardCharsets.UTF_8));

      final Map<String, Object> reloaded = cast(NoteV1.Json.parse(
          new String(Files.readAllBytes(store.toPath()), StandardCharsets.UTF_8)));
      final Cipher unwrap = Cipher.getInstance("AES/GCM/NoPadding");
      unwrap.init(Cipher.DECRYPT_MODE, wrappingKey,
          new GCMParameterSpec(128, NoteV1.fromB64url(str(reloaded.get("ivB64url")), 16)));
      final byte[] recovered = unwrap.doFinal(
          NoteV1.fromB64url(str(reloaded.get("wrappedPkcs8B64url")), 8192));
      final boolean roundTrip = java.util.Arrays.equals(pkcs8, recovered);
      result.putBoolean("wrapRoundTrip", roundTrip);
      result.putString("statePath", relativeToFilesDir(store));
      result.putString("wrappingAlias", KEYSTORE_WRAP_ALIAS);
      result.putString("deviceId", identity.deviceId);
      Log.i(TAG, "wrapped-key self-test roundTrip=" + roundTrip
          + " path=" + relativeToFilesDir(store));
      if (roundTrip) promise.resolve(result);
      else promise.reject("WRAP_ROUND_TRIP_FAILED", "unwrapped PKCS#8 did not match");
    } catch (Exception error) {
      Log.w(TAG, "wrapped-key self-test failed", error);
      promise.reject("WRAP_KEY_FAILED", error.getClass().getSimpleName() + ": " + error.getMessage(), error);
    }
  }

  private SecretKey ensureWrappingKey() throws Exception {
    final KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
    keyStore.load(null);
    if (keyStore.containsAlias(KEYSTORE_WRAP_ALIAS)) {
      // Regenerate on every self-test run so a stale alias generated with
      // different parameters can never mask the current specification.
      keyStore.deleteEntry(KEYSTORE_WRAP_ALIAS);
    }
    final KeyGenerator generator = KeyGenerator.getInstance("AES", "AndroidKeyStore");
    generator.init(new KeyGenParameterSpec.Builder(KEYSTORE_WRAP_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        // We supply a fresh random GCM IV per wrap; without this flag the
        // keystore rejects caller IVs ("Caller-provided IV not permitted").
        .setRandomizedEncryptionRequired(false)
        .build());
    return generator.generateKey();
  }

  // ---- E1: durable state sentinels ----------------------------------------

  /** Writes sentinels into both candidate durable-state directories. */
  @ReactMethod
  public void stateSentinelWrite(Promise promise) {
    final WritableMap result = Arguments.createMap();
    final WritableArray written = Arguments.createArray();
    final String marker = "e1-write-" + System.currentTimeMillis();
    try {
      for (File dir : candidateStateDirs()) {
        try {
          final File sentinel = new File(dir, SENTINEL_NAME);
          writeAtomically(sentinel, ("{\"marker\":\"" + marker + "\"}").getBytes(StandardCharsets.UTF_8));
          written.pushString(relativeToFilesDir(sentinel));
        } catch (Exception error) {
          written.pushString(relativeToFilesDir(new File(dir, SENTINEL_NAME))
              + " FAILED " + error.getClass().getSimpleName());
          Log.w(TAG, "sentinel write failed in " + dir, error);
        }
      }
      result.putString("marker", marker);
      result.putArray("written", written);
      result.putString("filesDir", relativeToFilesDir(getFilesDir()));
      Log.i(TAG, "state sentinels written marker=" + marker);
      promise.resolve(result);
    } catch (Exception error) {
      promise.reject("STATE_WRITE_FAILED", error.getMessage(), error);
    }
  }

  /** Reads sentinels back; used across close, force-stop, reboot, and upgrade. */
  @ReactMethod
  public void stateSentinelRead(Promise promise) {
    final WritableMap result = Arguments.createMap();
    final WritableArray entries = Arguments.createArray();
    for (File dir : candidateStateDirs()) {
      final WritableMap entry = Arguments.createMap();
      entry.putString("dir", relativeToFilesDir(dir));
      final File sentinel = new File(dir, SENTINEL_NAME);
      entry.putBoolean("dirExists", dir.isDirectory());
      entry.putBoolean("sentinelExists", sentinel.isFile());
      if (sentinel.isFile()) {
        try {
          final Map<String, Object> data = cast(NoteV1.Json.parse(
              new String(Files.readAllBytes(sentinel.toPath()), StandardCharsets.UTF_8)));
          entry.putString("marker", str(data.get("marker")));
        } catch (Exception error) {
          entry.putString("marker", "UNREADABLE " + error.getClass().getSimpleName());
        }
      }
      final File wrapped = new File(dir, WRAPPED_IDENTITY_NAME);
      entry.putBoolean("wrappedIdentityExists", wrapped.isFile());
      if (wrapped.isFile() && dir.getPath().equals(customStateDir().getPath())) {
        entry.putBoolean("wrappedIdentityDecryptable", wrappedIdentityDecryptable(wrapped));
      }
      entries.pushMap(entry);
    }
    final StringBuilder summary = new StringBuilder();
    for (int i = 0; i < entries.size(); i++) {
      if (i > 0) summary.append(" | ");
      final com.facebook.react.bridge.ReadableMap entry = entries.getMap(i);
      summary.append(entry.getString("dir"))
          .append(" sentinel=").append(entry.getBoolean("sentinelExists"))
          .append(" marker=").append(entry.getString("marker"))
          .append(" wrapped=").append(entry.getBoolean("wrappedIdentityExists"));
      if (entry.hasKey("wrappedIdentityDecryptable")) {
        summary.append(" decryptable=").append(entry.getBoolean("wrappedIdentityDecryptable"));
      }
    }
    result.putArray("entries", entries);
    result.putString("summary", summary.toString());
    // Never call toString() on a bridge array after putArray: the bridge
    // consumes it and throws ObjectAlreadyConsumedException.
    Log.i(TAG, "state sentinels read: " + summary);
    promise.resolve(result);
  }

  /** Deletes sentinels and the wrapped identity (logout/uninstall simulation). */
  @ReactMethod
  public void stateSentinelClear(Promise promise) {
    final WritableMap result = Arguments.createMap();
    final WritableArray removed = Arguments.createArray();
    for (File dir : candidateStateDirs()) {
      for (String name : new String[] {SENTINEL_NAME, WRAPPED_IDENTITY_NAME}) {
        final File file = new File(dir, name);
        if (file.isFile() && file.delete()) removed.pushString(relativeToFilesDir(file));
      }
    }
    boolean wrapAliasDeleted = false;
    try {
      final KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
      keyStore.load(null);
      if (keyStore.containsAlias(KEYSTORE_WRAP_ALIAS)) {
        keyStore.deleteEntry(KEYSTORE_WRAP_ALIAS);
        wrapAliasDeleted = true;
      }
    } catch (Exception error) {
      Log.w(TAG, "could not delete wrapping alias", error);
    }
    final int removedCount = removed.size();
    result.putArray("removed", removed);
    result.putBoolean("wrapAliasDeleted", wrapAliasDeleted);
    Log.i(TAG, "state sentinels cleared removed=" + removedCount
        + " wrapAliasDeleted=" + wrapAliasDeleted);
    promise.resolve(result);
  }

  /** Attempts to unwrap the persisted identity without regenerating the keystore key. */
  private boolean wrappedIdentityDecryptable(File store) {
    try {
      final KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
      keyStore.load(null);
      final SecretKey wrappingKey = (SecretKey) keyStore.getKey(KEYSTORE_WRAP_ALIAS, null);
      if (wrappingKey == null) return false;
      final Map<String, Object> data = cast(NoteV1.Json.parse(
          new String(Files.readAllBytes(store.toPath()), StandardCharsets.UTF_8)));
      final Cipher unwrap = Cipher.getInstance("AES/GCM/NoPadding");
      unwrap.init(Cipher.DECRYPT_MODE, wrappingKey,
          new GCMParameterSpec(128, NoteV1.fromB64url(str(data.get("ivB64url")), 16)));
      unwrap.doFinal(NoteV1.fromB64url(str(data.get("wrappedPkcs8B64url")), 8192));
      return true;
    } catch (Exception error) {
      Log.w(TAG, "wrapped identity is not decryptable: " + error.getClass().getSimpleName());
      return false;
    }
  }

  // ---- helpers ------------------------------------------------------------

  private File getFilesDir() {
    return getReactApplicationContext().getFilesDir();
  }

  /** Inside PluginHost's per-plugin extraction tree (may be replaced on upgrade). */
  private File pluginStateDir() {
    return new File(new File(getFilesDir(), "plugins" + File.separator + PLUGIN_ID), "olaink-e1");
  }

  /** Sibling directory owned by our naming convention under the host filesDir. */
  private File customStateDir() {
    return new File(getFilesDir(), "olaink-e1-" + PLUGIN_ID);
  }

  private File[] candidateStateDirs() {
    return new File[] {pluginStateDir(), customStateDir()};
  }

  private String relativeToFilesDir(File file) {
    final String root = getFilesDir().getPath() + File.separator;
    final String path = file.getPath();
    return path.startsWith(root) ? path.substring(root.length()) : path;
  }

  private static void writeAtomically(File destination, byte[] data) throws IOException {
    final File parent = destination.getParentFile();
    if (parent == null || (!parent.isDirectory() && !parent.mkdirs())) {
      throw new IOException("could not create " + destination.getParentFile());
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

  private Map<String, Object> loadVectors() throws IOException {
    final File vectors = new File(
        new File(getFilesDir(), "plugins" + File.separator + PLUGIN_ID),
        "vectors" + File.separator + "note-v1-vectors.json");
    final String text = new String(Files.readAllBytes(vectors.toPath()), StandardCharsets.UTF_8);
    return cast(NoteV1.Json.parse(text));
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> cast(Object value) {
    if (value instanceof Map) return (Map<String, Object>) value;
    throw new ClassCastException("expected object");
  }

  private static String str(Object value) {
    return value == null ? null : String.valueOf(value);
  }

  private static Map<String, Object> inputs(Map<String, Object> source) {
    return cast(source.get("payloadInputs"));
  }

  private static Map<String, Object> routing(Map<String, Object> source) {
    return cast(source.get("routing"));
  }

  @SuppressWarnings("unchecked")
  private static List<Map<String, Object>> vectorRecipientMaps(Map<String, Object> deterministic) {
    final List<Map<String, Object>> out = new ArrayList<>();
    for (Object recipient : (List<Object>) deterministic.get("recipients")) {
      out.add(cast(recipient));
    }
    return out;
  }

  private static List<NoteV1.Recipient> vectorRecipients(Map<String, Object> deterministic) throws Exception {
    final List<NoteV1.Recipient> out = new ArrayList<>();
    for (Map<String, Object> recipient : vectorRecipientMaps(deterministic)) {
      out.add(new NoteV1.Recipient(str(recipient.get("deviceId")), str(recipient.get("publicSpkiB64url"))));
    }
    return out;
  }

  private static NoteV1.FixedMaterial vectorMaterial(Map<String, Object> deterministic) throws Exception {
    final List<byte[]> pkcs8 = new ArrayList<>();
    final List<byte[]> spki = new ArrayList<>();
    final List<byte[]> wrapIvs = new ArrayList<>();
    for (Map<String, Object> recipient : vectorRecipientMaps(deterministic)) {
      pkcs8.add(NoteV1.fromB64url(str(recipient.get("ephemeralPrivatePkcs8B64url")), 4096));
      spki.add(NoteV1.fromB64url(str(recipient.get("ephemeralPublicSpkiB64url")), 4096));
      wrapIvs.add(NoteV1.fromB64url(str(recipient.get("wrapIvB64url")), 16));
    }
    return new NoteV1.FixedMaterial(
        NoteV1.fromB64url(str(deterministic.get("contentKeyB64url")), 64),
        NoteV1.fromB64url(str(deterministic.get("contentIvB64url")), 16),
        pkcs8, spki, wrapIvs);
  }

  private static long SystemClock() {
    return android.os.SystemClock.uptimeMillis();
  }
}
