package com.olaink.probe;

import android.util.Log;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Phase 0.2 PluginHost permission probe. It deliberately returns neither a
 * note path nor note bytes. The real product must use a narrower source-token
 * bridge still; this module only determines whether PluginHost permits direct
 * Java access after the user has granted its scoped permissions.
 */
public final class OlaInkProbeModule extends ReactContextBaseJavaModule {
  private static final String TAG = "OlaInkEmbeddedProbe";
  private static final File NOTE_ROOT = new File("/storage/emulated/0/Note");
  private static final long MAX_NOTE_BYTES = 5L * 1024L * 1024L;
  private static final String FIXTURE_NAME = "ola-ink-probe-permission.txt";

  public OlaInkProbeModule(ReactApplicationContext context) {
    super(context);
    Log.i(TAG, "OlaInkProbeModule constructed revision=2");
  }

  @Override
  public String getName() {
    return "OlaInkProbe";
  }

  @ReactMethod
  public void describe(Promise promise) {
    WritableMap result = Arguments.createMap();
    result.putString("packageName", getReactApplicationContext().getPackageName());
    result.putInt("apiLevel", android.os.Build.VERSION.SDK_INT);
    result.putInt("probeRevision", 2);
    Log.i(TAG, "describe invoked revision=2");
    promise.resolve(result);
  }

  /** Opens and reads one byte from a validated current-note path; no bytes leave Java. */
  @ReactMethod
  public void openCurrentNote(String rawPath, Promise promise) {
    try {
      final File note = checkedNote(rawPath);
      try (FileInputStream input = new FileInputStream(note)) {
        input.read();
      }
      WritableMap result = Arguments.createMap();
      result.putBoolean("opened", true);
      result.putDouble("size", note.length());
      Log.i(TAG, "openCurrentNote succeeded bytes=" + note.length());
      promise.resolve(result);
    } catch (IOException | SecurityException error) {
      Log.w(TAG, "openCurrentNote failed " + error.getClass().getSimpleName());
      promise.reject("NOTE_READ_FAILED", "native note open failed: " + error.getClass().getSimpleName(), error);
    }
  }

  /**
   * Writes a harmless fixed marker in Note to exercise scoped direct Java
   * writes. It intentionally does not delete the marker: FILE:DELETE is not a
   * production permission and test cleanup is performed over developer ADB.
   */
  @ReactMethod
  public void writeNoteFixture(Promise promise) {
    try {
      final File root = canonicalNoteRoot();
      if (!root.isDirectory() && !root.mkdirs()) throw new IOException("could not create note root");
      final File destination = new File(root, FIXTURE_NAME).getCanonicalFile();
      if (!root.equals(destination.getParentFile())) throw new IOException("invalid fixture destination");
      try (FileOutputStream output = new FileOutputStream(destination, false)) {
        output.write("Ola Ink scoped-permission probe; safe to remove.\n".getBytes(StandardCharsets.UTF_8));
        output.getFD().sync();
      }
      WritableMap result = Arguments.createMap();
      result.putString("filename", FIXTURE_NAME);
      result.putDouble("size", destination.length());
      Log.i(TAG, "writeNoteFixture succeeded bytes=" + destination.length());
      promise.resolve(result);
    } catch (IOException | SecurityException error) {
      Log.w(TAG, "writeNoteFixture failed " + error.getClass().getSimpleName());
      promise.reject("NOTE_WRITE_FAILED", "native note write failed: " + error.getClass().getSimpleName(), error);
    }
  }

  /** Makes a HEAD request only; no response body, account state, or note data is sent. */
  @ReactMethod
  public void requestHttps(Promise promise) {
    new Thread(() -> {
      HttpURLConnection connection = null;
      try {
        connection = (HttpURLConnection) new URL("https://app.olaink.com/").openConnection();
        connection.setRequestMethod("HEAD");
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(10_000);
        connection.setInstanceFollowRedirects(false);
        final int status = connection.getResponseCode();
        WritableMap result = Arguments.createMap();
        result.putInt("status", status);
        Log.i(TAG, "requestHttps succeeded status=" + status);
        promise.resolve(result);
      } catch (IOException | SecurityException error) {
        Log.w(TAG, "requestHttps failed " + error.getClass().getSimpleName());
        promise.reject("HTTPS_FAILED", "native HTTPS request failed: " + error.getClass().getSimpleName(), error);
      } finally {
        if (connection != null) connection.disconnect();
      }
    }, "olaink-permission-probe").start();
  }

  private static File canonicalNoteRoot() throws IOException {
    return NOTE_ROOT.getCanonicalFile();
  }

  private static File checkedNote(String rawPath) throws IOException {
    if (rawPath == null || rawPath.isEmpty()) throw new IOException("missing note path");
    final File root = canonicalNoteRoot();
    final File note = new File(rawPath).getCanonicalFile();
    final String prefix = root.getPath() + File.separator;
    if (!note.getPath().startsWith(prefix) || !note.getName().toLowerCase().endsWith(".note")
        || !note.isFile() || note.length() < 0 || note.length() > MAX_NOTE_BYTES) {
      throw new IOException("invalid note source");
    }
    return note;
  }
}
