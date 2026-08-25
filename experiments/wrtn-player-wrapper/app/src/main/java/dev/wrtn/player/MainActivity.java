package dev.wrtn.player;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

/**
 * Local-only fixture player for proving both the PluginHost → companion
 * hand-off and the pinned browser viewer on the device WebView. Production
 * uses a browser session and an opaque draft/launch ID, never intent
 * credentials or note bytes.
 */
public final class MainActivity extends Activity {
  public static final String ACTION_OPEN_SHARE = "dev.wrtn.OPEN_SHARE";
  public static final String EXTRA_DRAFT_ID = "draftId";
  private static final String TAG = "WrtnPlayerProbe";
  // WebView modules/workers require an http(s) origin. WebViewAssetLoader maps
  // this HTTPS-looking origin entirely to this APK's assets; no network is used.
  private static final String ASSET_BASE_URL = "https://appassets.androidplatform.net/assets/";
  private static final String PLAYER_URL = ASSET_BASE_URL + "player.html";

  private WebView webView;
  private WebViewAssetLoader assetLoader;

  @Override
  @SuppressLint("SetJavaScriptEnabled")
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    assetLoader = new WebViewAssetLoader.Builder()
        .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
        .build();

    webView = new WebView(this);
    webView.setBackgroundColor(Color.rgb(247, 244, 237));
    webView.getSettings().setJavaScriptEnabled(true);
    webView.getSettings().setDomStorageEnabled(true);
    webView.getSettings().setAllowFileAccess(false);
    webView.getSettings().setAllowContentAccess(false);
    webView.addJavascriptInterface(new ProbeBridge(), "WrtnPlayer");
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
    final Uri data = intent == null ? null : intent.getData();
    Log.i(TAG, "opened action=" + action + " draftId=" + draftId + " data=" + data);

    final String selectedDraftId = draftId != null
        ? draftId
        : data != null ? data.getQueryParameter(EXTRA_DRAFT_ID) : null;
    final String url = selectedDraftId == null
        ? PLAYER_URL
        : PLAYER_URL + "?" + EXTRA_DRAFT_ID + "=" + Uri.encode(selectedDraftId);
    webView.loadUrl(url);
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

  private static final class ProbeBridge {
    @JavascriptInterface
    public void postMessage(String message) {
      Log.i(TAG, "page " + message);
    }
  }
}
