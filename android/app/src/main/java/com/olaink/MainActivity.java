package com.olaink;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.util.Base64;
import android.util.Log;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.annotation.Nullable;
import androidx.webkit.WebViewAssetLoader;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.UUID;

/**
 * Local PWA wrapper for the PluginHost → companion hand-off, WebView crypto
 * prototype, and pinned browser viewer. A user-selected scoped content URI is
 * normally exposed to the pinned PWA origin through a one-shot opaque local
 * URL. TODO: replace the temporary unscoped note-path intent with a supported
 * Supernote-provided content:// grant when one becomes available.
 */
public final class MainActivity extends Activity {
  public static final String ACTION_OPEN_SHARE = BuildConfig.COMPANION_SHARE_ACTION;
  public static final String EXTRA_DRAFT_ID = "draftId";
  /** Plugin/App version parity is required before accepting a share hand-off. */
  public static final String EXTRA_PLUGIN_VERSION_NAME = "pluginVersionName";
  public static final String EXTRA_PLUGIN_VERSION_CODE = "pluginVersionCode";
  /** Temporary filesystem-path hand-off; it is not an Android URI grant. */
  public static final String EXTRA_NOTE_PATH = "notePath";
  private static final String NOTE_ROOT = "/storage/emulated/0/Note";
  private static final String TAG = "OlainkPlayerProbe";
  private static final int REQUEST_OPEN_NOTE = 42;
  // Base64 and authenticated-encryption framing must fit the relay's 8 MiB
  // ciphertext-record limit; keep selected plaintext below 5 MiB.
  private static final long MAX_NOTE_BYTES = 5L * 1024L * 1024L;
  private static final String PLUGIN_ASSET = "olainkplugin.snplg";
  private static final File PLUGIN_DESTINATION = new File(
      "/storage/emulated/0/MyStyle", PLUGIN_ASSET);
  // WebView modules/workers require an http(s) origin. WebViewAssetLoader maps
  // this HTTPS-looking origin entirely to this APK's assets; no network is used.
  private static final String ASSET_BASE_URL = "https://appassets.androidplatform.net/assets/";
  private static final String PLAYER_URL = ASSET_BASE_URL + "player.html";
  private static final String RETURN_TO_SUPERNOTE = "return-to-supernote";

  private WebView webView;
  private WebViewAssetLoader assetLoader;
  @Nullable private SelectedSource selectedSource;
  @Nullable private String sourceError;
  private boolean stagePluginAfterStoragePermission;

  private static final class SelectedSource {
    @Nullable final Uri uri;
    @Nullable final File file;
    final String id;
    final String filename;
    final long size;

    SelectedSource(Uri uri, String id, String filename, long size) {
      this.uri = uri;
      this.file = null;
      this.id = id;
      this.filename = filename;
      this.size = size;
    }

    SelectedSource(File file, String id, String filename, long size) {
      this.uri = null;
      this.file = file;
      this.id = id;
      this.filename = filename;
      this.size = size;
    }
  }

  @Override
  @SuppressLint("SetJavaScriptEnabled")
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    assetLoader = new WebViewAssetLoader.Builder()
        .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
        .addPathHandler("/olaink-drafts/", this::openSelectedSource)
        .build();

    webView = new WebView(this);
    webView.setBackgroundColor(Color.rgb(247, 244, 237));
    webView.getSettings().setJavaScriptEnabled(true);
    webView.getSettings().setDomStorageEnabled(true);
    webView.getSettings().setAllowFileAccess(false);
    webView.getSettings().setAllowContentAccess(false);
    webView.addJavascriptInterface(new CompanionBridge(), "OlainkPlayer");
    webView.setWebViewClient(new LocalOnlyClient());
    webView.setWebChromeClient(new ProbeChromeClient());
    if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true);
    setContentView(webView);

    openFromIntent(getIntent());
  }

  @Override
  protected void onResume() {
    super.onResume();
    if (!stagePluginAfterStoragePermission) return;
    stagePluginAfterStoragePermission = false;
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R || Environment.isExternalStorageManager()) {
      installBundledPlugin();
    } else {
      notifyPluginInstallStatus("Allow All files access for Ola Ink, then try Install Supernote plugin again.");
    }
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    openFromIntent(intent);
  }

  private void openFromIntent(Intent intent) {
    final String action = intent == null ? null : intent.getAction();
    final String draftId = intent == null ? null : intent.getStringExtra(EXTRA_DRAFT_ID);
    final String notePath = intent == null ? null : intent.getStringExtra(EXTRA_NOTE_PATH);
    final boolean pluginUpdateRequired = ACTION_OPEN_SHARE.equals(action) && !pluginMatchesCompanion(intent);
    // Do not log intent data, including the unscoped path or plugin version.
    Log.i(TAG, "opened action=" + action + " hasDraftId=" + (draftId != null)
        + " hasNotePath=" + (notePath != null) + " pluginUpdateRequired=" + pluginUpdateRequired);
    if (pluginUpdateRequired) {
      selectedSource = null;
      sourceError = "The Ola Ink plugin must be updated before sharing a note.";
    } else if (notePath != null) {
      selectUnscopedPath(notePath);
    }
    final Uri.Builder player = Uri.parse(PLAYER_URL).buildUpon();
    if (draftId != null) player.appendQueryParameter(EXTRA_DRAFT_ID, draftId);
    if (pluginUpdateRequired) player.appendQueryParameter("pluginUpdateRequired", "1");
    webView.loadUrl(player.build().toString());
  }

  private static boolean pluginMatchesCompanion(@Nullable Intent intent) {
    if (intent == null) return false;
    return BuildConfig.VERSION_NAME.equals(intent.getStringExtra(EXTRA_PLUGIN_VERSION_NAME))
        && Integer.toString(BuildConfig.VERSION_CODE)
            .equals(intent.getStringExtra(EXTRA_PLUGIN_VERSION_CODE));
  }

  /**
   * Stages the bundled plugin in Supernote's conventional MyStyle directory,
   * then opens Plugin Manager. Supernote owns the final explicit installation.
   */
  private void installBundledPlugin() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && !Environment.isExternalStorageManager()) {
      stagePluginAfterStoragePermission = true;
      notifyPluginInstallStatus("Ola Ink will place its plugin in MyStyle. Allow All files access, then return here.");
      try {
        startActivity(new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
            Uri.parse("package:" + getPackageName())));
      } catch (RuntimeException error) {
        stagePluginAfterStoragePermission = false;
        notifyPluginInstallStatus("Allow All files access for Ola Ink, then try Install Supernote plugin again.");
      }
      return;
    }

    final File directory = PLUGIN_DESTINATION.getParentFile();
    final File temporary = new File(directory, PLUGIN_ASSET + ".tmp");
    try {
      if (directory == null || (!directory.isDirectory() && !directory.mkdirs())) {
        throw new IOException("could not create MyStyle");
      }
      try (InputStream input = getAssets().open(PLUGIN_ASSET);
           FileOutputStream output = new FileOutputStream(temporary)) {
        byte[] buffer = new byte[16 * 1024];
        int count;
        while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
        output.getFD().sync();
      }
      if (PLUGIN_DESTINATION.exists() && !PLUGIN_DESTINATION.delete()) {
        throw new IOException("could not replace existing plugin");
      }
      if (!temporary.renameTo(PLUGIN_DESTINATION)) {
        throw new IOException("could not stage plugin");
      }
      notifyPluginInstallStatus("Plugin placed in MyStyle. Choose olainkplugin.snplg, then tap Install.");
      Intent pluginManager = new Intent("com.ratta.settings.application.PluginManagerFragment")
          .setClassName("com.ratta.settings", "com.ratta.settings.SettingsActivity");
      startActivity(pluginManager);
    } catch (IOException | RuntimeException error) {
      temporary.delete();
      Log.w(TAG, "could not stage bundled plugin", error);
      notifyPluginInstallStatus("Could not place the plugin in MyStyle. Check All files access and try again.");
    }
  }

  /** Launch Android's user-mediated document picker; no raw storage path is requested. */
  private void selectNote() {
    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT)
        .addCategory(Intent.CATEGORY_OPENABLE)
        .setType("*/*")
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    startActivityForResult(intent, REQUEST_OPEN_NOTE);
  }

  @Override
  @SuppressWarnings("deprecation")
  protected void onActivityResult(int requestCode, int resultCode, @Nullable Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    if (requestCode != REQUEST_OPEN_NOTE || resultCode != RESULT_OK || data == null) return;

    final Uri uri = data.getData();
    if (uri == null || !"content".equals(uri.getScheme())) {
      selectedSource = null;
      sourceError = "Ola Ink can only read a document selected through Android’s protected picker.";
      notifySourceChanged();
      return;
    }

    final SourceMetadata metadata = readSourceMetadata(uri);
    if (metadata == null || !metadata.filename.toLowerCase().endsWith(".note")
        || metadata.size < 0 || metadata.size > MAX_NOTE_BYTES) {
      selectedSource = null;
      sourceError = "Select a .note file no larger than 5 MiB.";
      notifySourceChanged();
      return;
    }

    // The temporary grant from ACTION_OPEN_DOCUMENT lasts for this app process.
    // We intentionally do not persist it: a source must be selected again after
    // process death rather than silently retaining access to a personal note.
    sourceError = null;
    selectedSource = new SelectedSource(uri, UUID.randomUUID().toString(), metadata.filename, metadata.size);
    notifySourceChanged();
  }

  /**
   * Temporary compatibility source for PluginCommAPI.getCurrentFilePath().
   * It is constrained to Supernote's note directory and requires the explicit
   * Android all-files permission declared by this companion.
   */
  private void selectUnscopedPath(String rawPath) {
    selectedSource = null;
    sourceError = null;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && !Environment.isExternalStorageManager()) {
      sourceError = "Direct active-note sharing needs All files access for Ola Ink.";
    } else {
      try {
        final File root = new File(NOTE_ROOT).getCanonicalFile();
        final File file = new File(rawPath).getCanonicalFile();
        final String rootPath = root.getPath() + File.separator;
        if (!file.getPath().startsWith(rootPath) || !file.getName().toLowerCase().endsWith(".note")
            || !file.isFile() || file.length() > MAX_NOTE_BYTES) {
          sourceError = "The supplied active-note path is not a readable .note file up to 5 MiB.";
        } else {
          selectedSource = new SelectedSource(file, UUID.randomUUID().toString(), file.getName(), file.length());
        }
      } catch (IOException | SecurityException ignored) {
        sourceError = "The supplied active-note path could not be validated.";
      }
    }
    notifySourceChanged();
  }

  /** Writes a decrypted inbox note only to Supernote's conventional Note folder. */
  private String saveInboxNote(String senderUsername, String sourceFilename, String encodedNote)
      throws IOException {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && !Environment.isExternalStorageManager()) {
      throw new IOException("All files access is required to save notes");
    }
    if (encodedNote == null || encodedNote.length() > (MAX_NOTE_BYTES * 4 + 2) / 3
        || !encodedNote.matches("[A-Za-z0-9_-]*")) {
      throw new IOException("invalid note data");
    }

    final byte[] note;
    try {
      note = Base64.decode(encodedNote, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    } catch (IllegalArgumentException error) {
      throw new IOException("invalid note data", error);
    }
    if (note.length > MAX_NOTE_BYTES) throw new IOException("note exceeds 5 MiB");

    final String destinationName = inboxFilename(senderUsername, sourceFilename);
    final File root = new File(NOTE_ROOT).getCanonicalFile();
    if (!root.isDirectory() && !root.mkdirs()) throw new IOException("could not create Note folder");
    File destination = new File(root, destinationName).getCanonicalFile();
    if (!root.equals(destination.getParentFile())) throw new IOException("invalid destination");
    for (int suffix = 2; destination.exists(); suffix++) {
      destination = new File(root, inboxFilename(senderUsername, sourceFilename, suffix)).getCanonicalFile();
    }

    final File temporary = new File(root, "." + destination.getName() + "."
        + UUID.randomUUID() + ".tmp");
    try (FileOutputStream output = new FileOutputStream(temporary)) {
      output.write(note);
      output.getFD().sync();
    } catch (IOException error) {
      temporary.delete();
      throw error;
    }
    if (destination.exists() || !temporary.renameTo(destination)) {
      temporary.delete();
      throw new IOException("could not save note");
    }
    return destination.getName();
  }

  private static String inboxFilename(String senderUsername, String sourceFilename) throws IOException {
    return inboxFilename(senderUsername, sourceFilename, 1);
  }

  private static String inboxFilename(String senderUsername, String sourceFilename, int suffix)
      throws IOException {
    if (sourceFilename == null || !sourceFilename.toLowerCase().endsWith(".note")) {
      throw new IOException("invalid inbox filename");
    }
    String sender = senderUsername == null ? "sender" : senderUsername.replaceAll("[^A-Za-z0-9-]", "-");
    sender = sender.replaceAll("^-+|-+$", "");
    if (sender.isEmpty()) sender = "sender";
    String stem = sourceFilename.substring(0, sourceFilename.length() - 5)
        .replaceAll("[^A-Za-z0-9._ -]", "_");
    if (stem.isEmpty()) stem = "note";
    final String prefix = "ola-ink-" + sender + "-";
    final String postfix = suffix == 1 ? ".note" : "-" + suffix + ".note";
    final int maximumStemLength = 240 - prefix.length() - postfix.length();
    if (maximumStemLength < 1) throw new IOException("inbox filename is too long");
    if (stem.length() > maximumStemLength) stem = stem.substring(0, maximumStemLength);
    return prefix + stem + postfix;
  }

  private static final class SourceMetadata {
    final String filename;
    final long size;

    SourceMetadata(String filename, long size) {
      this.filename = filename;
      this.size = size;
    }
  }

  @Nullable
  private SourceMetadata readSourceMetadata(Uri uri) {
    try (Cursor cursor = getContentResolver().query(uri,
        new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE }, null, null, null)) {
      if (cursor == null || !cursor.moveToFirst()) return null;
      final int nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
      final int sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE);
      if (nameColumn < 0 || sizeColumn < 0 || cursor.isNull(nameColumn) || cursor.isNull(sizeColumn)) return null;
      return new SourceMetadata(cursor.getString(nameColumn), cursor.getLong(sizeColumn));
    } catch (SecurityException ignored) {
      return null;
    }
  }

  @Nullable
  private WebResourceResponse openSelectedSource(String path) {
    final SelectedSource source = selectedSource;
    if (source == null || !source.id.equals(path)) return null;
    try {
      final InputStream stream = source.uri != null
          ? getContentResolver().openInputStream(source.uri)
          : new FileInputStream(source.file);
      if (stream == null) return null;
      return new WebResourceResponse("application/octet-stream", null,
          new LimitedInputStream(stream, MAX_NOTE_BYTES));
    } catch (SecurityException | IOException error) {
      return null;
    }
  }

  /** Enforces the same hard size cap even if a malicious provider lies about metadata. */
  private static final class LimitedInputStream extends FilterInputStream {
    private long remaining;

    LimitedInputStream(InputStream input, long maxBytes) {
      super(input);
      remaining = maxBytes;
    }

    @Override
    public int read() throws IOException {
      if (remaining == 0) return -1;
      int value = super.read();
      if (value >= 0) remaining--;
      return value;
    }

    @Override
    public int read(byte[] buffer, int offset, int length) throws IOException {
      if (remaining == 0) return -1;
      int count = super.read(buffer, offset, (int) Math.min(length, remaining));
      if (count > 0) remaining -= count;
      return count;
    }
  }

  private void notifySourceChanged() {
    if (webView == null) return;
    webView.evaluateJavascript("window.dispatchEvent(new Event('olaink-source-changed'))", null);
  }

  private void notifyPluginInstallStatus(String message) {
    Log.i(TAG, message);
    if (webView == null) return;
    webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('olaink-plugin-install-status', {detail: \""
        + jsonString(message) + "\"}))", null);
  }

  private final class LocalOnlyClient extends WebViewClient {
    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
      return assetLoader.shouldInterceptRequest(request.getUrl());
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
      return blockNonAssetNavigation(request.getUrl());
    }

    @Override
    @SuppressWarnings("deprecation")
    public boolean shouldOverrideUrlLoading(WebView view, String url) {
      return blockNonAssetNavigation(Uri.parse(url));
    }

    private boolean blockNonAssetNavigation(Uri uri) {
      final boolean localAsset = uri.toString().startsWith(ASSET_BASE_URL);
      if (!localAsset) Log.w(TAG, "blocked navigation to " + uri);
      return !localAsset;
    }
  }

  private static final class ProbeChromeClient extends WebChromeClient {
    @Override
    public boolean onConsoleMessage(ConsoleMessage message) {
      Log.i(TAG, "web " + message.message() + " (" + message.sourceId()
          + ":" + message.lineNumber() + ")");
      return true;
    }
  }

  private final class CompanionBridge {
    /** Used only to require re-installing the bundled plugin after an app upgrade. */
    @JavascriptInterface
    public String appVersion() {
      return BuildConfig.VERSION_NAME + ":" + BuildConfig.VERSION_CODE;
    }

    @JavascriptInterface
    public void selectNote() {
      runOnUiThread(MainActivity.this::selectNote);
    }

    @JavascriptInterface
    public void installSupernotePlugin() {
      runOnUiThread(MainActivity.this::installBundledPlugin);
    }

    /** Metadata only: the URI or temporary unscoped path stays private to native code. */
    @JavascriptInterface
    public String selectedNote() {
      final SelectedSource source = selectedSource;
      if (source == null) {
        return sourceError == null ? "null" : "{\"error\":\"" + jsonString(sourceError) + "\"}";
      }
      return "{\"id\":\"" + source.id + "\",\"filename\":\""
          + jsonString(source.filename) + "\",\"size\":" + source.size + "}";
    }

    @JavascriptInterface
    public void clearSelectedNote() {
      selectedSource = null;
      sourceError = null;
      runOnUiThread(MainActivity.this::notifySourceChanged);
    }

    /** The page provides authenticated local plaintext; this never leaves the device. */
    @JavascriptInterface
    public String saveInboxNote(String senderUsername, String sourceFilename, String encodedNote) {
      try {
        return MainActivity.this.saveInboxNote(senderUsername, sourceFilename, encodedNote);
      } catch (IOException | SecurityException error) {
        Log.w(TAG, "could not save inbox note", error);
        return "";
      }
    }

    @JavascriptInterface
    public void postMessage(String message) {
      if (RETURN_TO_SUPERNOTE.equals(message)) {
        runOnUiThread(() -> {
          Log.i(TAG, "returning to Supernote");
          finish();
        });
        return;
      }
      Log.i(TAG, "page " + message);
    }
  }

  private static String jsonString(String value) {
    return value.replace("\\", "\\\\").replace("\"", "\\\"")
        .replace("\n", "\\n").replace("\r", "\\r");
  }
}
