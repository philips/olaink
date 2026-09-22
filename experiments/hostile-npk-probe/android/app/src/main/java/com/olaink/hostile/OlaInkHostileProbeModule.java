package com.olaink.hostile;

import android.util.Log;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyStore;
import java.util.LinkedHashMap;
import java.util.Map;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Hostile native module for the E1 isolation gate. Every method targets only
 * the throwaway E1 state of plugin olainknativeexp1: its candidate state
 * directories and its Android Keystore wrapping alias. Results document
 * whether a different native plugin inside the same PluginHost process/UID
 * can read or destroy that state without any permission.
 */
public final class OlaInkHostileProbeModule extends ReactContextBaseJavaModule {
  private static final String TAG = "OlaInkHostileProbe";
  private static final String VICTIM_PLUGIN_ID = "olainknativeexp1";
  private static final String VICTIM_WRAP_ALIAS = "olaink-e1-wrap";
  private static final String VICTIM_CUSTOM_DIR = "olaink-e1-" + VICTIM_PLUGIN_ID;
  private static final String VICTIM_PLUGIN_STATE = "plugins/" + VICTIM_PLUGIN_ID + "/olaink-e1";

  public OlaInkHostileProbeModule(ReactApplicationContext context) {
    super(context);
    Log.i(TAG, "hostile probe module constructed revision=1");
  }

  @Override
  public String getName() {
    return "OlaInkHostileProbe";
  }

  /** Attempts to read the victim plugin's candidate durable-state files. */
  @ReactMethod
  public void hostileRead(Promise promise) {
    final WritableMap result = Arguments.createMap();
    final WritableArray attempts = Arguments.createArray();
    for (Map.Entry<String, String> target : targets().entrySet()) {
      final WritableMap attempt = Arguments.createMap();
      attempt.putString("path", target.getKey());
      final File file = new File(getReactApplicationContext().getFilesDir(), target.getKey());
      attempt.putBoolean("exists", file.isFile());
      if (file.isFile()) {
        try {
          final byte[] data = Files.readAllBytes(file.toPath());
          String text = new String(data, StandardCharsets.UTF_8);
          if (text.length() > 300) text = text.substring(0, 300) + "…";
          attempt.putBoolean("readable", true);
          attempt.putString("content", text);
        } catch (Exception error) {
          attempt.putBoolean("readable", false);
          attempt.putString("error", error.getClass().getSimpleName());
        }
      }
      attempts.pushMap(attempt);
    }
    // Build the log summary BEFORE putArray: the bridge consumes the array and
    // later reads throw/return nothing (ObjectAlreadyConsumedException hazard).
    final StringBuilder summary = new StringBuilder();
    for (int i = 0; i < attempts.size(); i++) {
      summary.append(i > 0 ? " | " : "").append(attempts.getMap(i).getString("path"))
          .append(" exists=").append(attempts.getMap(i).getBoolean("exists"))
          .append(" readable=").append(attempts.getMap(i).hasKey("readable")
              && attempts.getMap(i).getBoolean("readable"));
      if (attempts.getMap(i).hasKey("error")) {
        summary.append(" error=").append(attempts.getMap(i).getString("error"));
      }
    }
    result.putArray("attempts", attempts);
    result.putString("summary", summary.toString());
    Log.i(TAG, "hostile read: " + summary);
    promise.resolve(result);
  }

  /** Detects the victim's wrapping alias and attempts to USE it (decrypt). */
  @ReactMethod
  public void hostileKeystoreDetect(Promise promise) {
    final WritableMap result = Arguments.createMap();
    try {
      final KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
      keyStore.load(null);
      final boolean aliasPresent = keyStore.containsAlias(VICTIM_WRAP_ALIAS);
      result.putBoolean("aliasPresent", aliasPresent);
      result.putString("alias", VICTIM_WRAP_ALIAS);
      if (!aliasPresent) {
        result.putBoolean("keyUsable", false);
        result.putString("note", "alias absent (victim never created it or deleted it)");
        Log.i(TAG, "hostile keystore detect: alias absent");
        promise.resolve(result);
        return;
      }
      // Try to obtain and use the key: decrypt the victim's wrapped identity.
      final javax.crypto.SecretKey key =
          (javax.crypto.SecretKey) keyStore.getKey(VICTIM_WRAP_ALIAS, null);
      result.putBoolean("keyReadable", key != null);
      final File wrappedStore = new File(getReactApplicationContext().getFilesDir(),
          VICTIM_CUSTOM_DIR + "/e1-wrapped-identity.json");
      boolean usable = false;
      String detail = "wrapped identity file missing";
      if (key != null && wrappedStore.isFile()) {
        try {
          final Map<String, Object> data = parseJson(wrappedStore);
          final Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
          cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128,
              NoteB64.fromB64url((String) data.get("ivB64url"))));
          cipher.doFinal(NoteB64.fromB64url((String) data.get("wrappedPkcs8B64url")));
          usable = true;
          detail = "decrypted victim identity PKCS#8 with victim alias";
        } catch (Exception error) {
          detail = "alias present but use failed: " + error.getClass().getSimpleName();
        }
      }
      result.putBoolean("keyUsable", usable);
      result.putString("detail", detail);
      Log.i(TAG, "hostile keystore detect: aliasPresent=" + aliasPresent
          + " usable=" + usable + " detail=" + detail);
      promise.resolve(result);
    } catch (Exception error) {
      Log.w(TAG, "hostile keystore detect failed", error);
      promise.reject("HOSTILE_KEYSTORE_FAILED", error.getClass().getSimpleName()
          + ": " + error.getMessage(), error);
    }
  }

  /** Attempts to destroy the victim's wrapping alias outright. */
  @ReactMethod
  public void hostileKeystoreDelete(Promise promise) {
    final WritableMap result = Arguments.createMap();
    try {
      final KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
      keyStore.load(null);
      final boolean wasPresent = keyStore.containsAlias(VICTIM_WRAP_ALIAS);
      if (wasPresent) keyStore.deleteEntry(VICTIM_WRAP_ALIAS);
      final boolean stillPresent = keyStore.containsAlias(VICTIM_WRAP_ALIAS);
      result.putBoolean("wasPresent", wasPresent);
      result.putBoolean("stillPresent", stillPresent);
      result.putBoolean("deleted", wasPresent && !stillPresent);
      Log.i(TAG, "hostile keystore delete: wasPresent=" + wasPresent
          + " stillPresent=" + stillPresent);
      promise.resolve(result);
    } catch (Exception error) {
      Log.w(TAG, "hostile keystore delete failed", error);
      promise.reject("HOSTILE_DELETE_FAILED", error.getClass().getSimpleName()
          + ": " + error.getMessage(), error);
    }
  }

  private static Map<String, String> targets() {
    final Map<String, String> targets = new LinkedHashMap<>();
    targets.put(VICTIM_PLUGIN_STATE + "/e1-sentinel.json", "plugin-tree sentinel");
    targets.put(VICTIM_CUSTOM_DIR + "/e1-sentinel.json", "custom-dir sentinel");
    targets.put(VICTIM_CUSTOM_DIR + "/e1-wrapped-identity.json", "wrapped identity");
    return targets;
  }

  private static Map<String, Object> parseJson(File file) throws Exception {
    final String text = new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
    return TinyJson.object(text);
  }

  /** Minimal base64url decode (hostile side only needs decode). */
  static final class NoteB64 {
    static byte[] fromB64url(String value) {
      final String base64 = value.replace('-', '+').replace('_', '/');
      final String padded = base64 + "===".substring(0, (4 - base64.length() % 4) % 4);
      return android.util.Base64.decode(padded, android.util.Base64.DEFAULT);
    }
  }

  /** Minimal JSON object parser for the victim's fixed-shape state file. */
  static final class TinyJson {
    static Map<String, Object> object(String text) {
      final Map<String, Object> map = new LinkedHashMap<>();
      int i = text.indexOf('{') + 1;
      while (i < text.length()) {
        while (i < text.length() && text.charAt(i) != '"') i++;
        if (i >= text.length() || text.charAt(i) != '"') break;
        final int keyEnd = text.indexOf('"', i + 1);
        final String key = text.substring(i + 1, keyEnd);
        final int colon = text.indexOf(':', keyEnd);
        i = colon + 1;
        while (i < text.length() && Character.isWhitespace(text.charAt(i))) i++;
        final char c = text.charAt(i);
        final Object value;
        if (c == '"') {
          final int valueEnd = text.indexOf('"', i + 1);
          value = text.substring(i + 1, valueEnd);
          i = valueEnd + 1;
        } else {
          final int comma = Math.min(
              text.indexOf(',', i) == -1 ? text.length() : text.indexOf(',', i),
              text.indexOf('}', i) == -1 ? text.length() : text.indexOf('}', i));
          value = text.substring(i, comma).trim();
          i = comma;
        }
        map.put(key, value);
        while (i < text.length() && (text.charAt(i) == ',' || Character.isWhitespace(text.charAt(i)))) i++;
      }
      return map;
    }
  }
}
