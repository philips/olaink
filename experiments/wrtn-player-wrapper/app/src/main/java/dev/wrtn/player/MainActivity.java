package dev.wrtn.player;

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
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.UUID;

/**
 * Local PWA wrapper for the PluginHost → companion hand-off, WebView crypto
 * prototype, and pinned browser viewer. The normal source path is a
 * user-selected scoped content URI. This beta prototype additionally accepts a
 * raw note path intent extra; it is deliberately unsafe and works only with a
 * developer-enabled all-files permission. Both source forms are exposed to the
 * pinned PWA origin through a one-shot opaque local URL.
 */
public final class MainActivity extends Activity {
  public static final String ACTION_OPEN_SHARE = "dev.wrtn.OPEN_SHARE";
  public static final String EXTRA_DRAFT_ID = "draftId";
  public static final String EXTRA_NOTE_PATH = "notePath";
  private static final String NOTE_ROOT = "/storage/emulated/0/Note";
  private static final String TAG = "WrtnPlayerProbe";
  private static final int REQUEST_OPEN_NOTE = 42;
  private static final long MAX_NOTE_BYTES = 100L * 1024L * 1024L;
  // WebView modules/workers require an http(s) origin. WebViewAssetLoader maps
  // this HTTPS-looking origin entirely to this APK's assets; no network is used.
  private static final String ASSET_BASE_URL = "https://appassets.androidplatform.net/assets/";
  private static final String PLAYER_URL = ASSET_BASE_URL + "player.html";
  private static final String RETURN_TO_SUPERNOTE = "return-to-supernote";

  private WebView webView;
  private WebViewAssetLoader assetLoader;
  @Nullable private SelectedSource selectedSource;
  @Nullable private String sourceError;

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
        .addPathHandler("/wrtn-drafts/", this::openSelectedSource)
        .build();

    webView = new WebView(this);
    webView.setBackgroundColor(Color.rgb(247, 244, 237));
    webView.getSettings().setJavaScriptEnabled(true);
    webView.getSettings().setDomStorageEnabled(true);
    webView.getSettings().setAllowFileAccess(false);
    webView.getSettings().setAllowContentAccess(false);
    webView.addJavascriptInterface(new CompanionBridge(), "WrtnPlayer");
    webView.setWebViewClient(new LocalOnlyClient());
    webView.setWebChromeClient(new ProbeChromeClient());
    if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true);
    setContentView(webView);

    openFromIntent(getIntent());
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
    // Do not log Intent data, including the deliberately unsafe prototype path.
    Log.i(TAG, "opened action=" + action + " hasDraftId=" + (draftId != null)
        + " hasNotePath=" + (notePath != null));
    if (notePath != null) selectUnsafePath(notePath);
    final String url = draftId == null
        ? PLAYER_URL
        : PLAYER_URL + "?" + EXTRA_DRAFT_ID + "=" + Uri.encode(draftId);
    webView.loadUrl(url);
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
      notifySourceChanged();
      return;
    }

    final SourceMetadata metadata = readSourceMetadata(uri);
    if (metadata == null || !metadata.filename.toLowerCase().endsWith(".note")
        || metadata.size < 0 || metadata.size > MAX_NOTE_BYTES) {
      selectedSource = null;
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
   * Unsafe beta-only compatibility path for PluginCommAPI.getCurrentFilePath().
   * A filesystem path carries no Android grant, so reject it unless the device
   * developer has explicitly enabled the manifest's all-files app-op.
   */
  private void selectUnsafePath(String rawPath) {
    selectedSource = null;
    sourceError = null;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && !Environment.isExternalStorageManager()) {
      sourceError = "The prototype direct-path mode needs developer-enabled all-files access.";
    } else {
      try {
        final File root = new File(NOTE_ROOT).getCanonicalFile();
        final File file = new File(rawPath).getCanonicalFile();
        final String rootPath = root.getPath() + File.separator;
        if (!file.getPath().startsWith(rootPath) || !file.getName().toLowerCase().endsWith(".note")
            || !file.isFile() || file.length() > MAX_NOTE_BYTES) {
          sourceError = "The supplied active-note path is not a readable .note file.";
        } else {
          selectedSource = new SelectedSource(file, UUID.randomUUID().toString(), file.getName(), file.length());
        }
      } catch (IOException | SecurityException ignored) {
        sourceError = "The supplied active-note path could not be validated.";
      }
    }
    notifySourceChanged();
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
    webView.evaluateJavascript("window.dispatchEvent(new Event('wrtn-source-changed'))", null);
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
    @JavascriptInterface
    public void selectNote() {
      runOnUiThread(MainActivity.this::selectNote);
    }

    /** Metadata only: the URI or raw prototype path stays private to native code. */
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
