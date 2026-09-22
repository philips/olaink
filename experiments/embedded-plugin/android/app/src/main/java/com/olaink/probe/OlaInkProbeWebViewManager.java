package com.olaink.probe;

import android.annotation.SuppressLint;
import android.net.Uri;
import android.os.Build;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.annotation.NonNull;

import com.facebook.react.uimanager.SimpleViewManager;
import com.facebook.react.uimanager.ThemedReactContext;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Phase 0.3 local-only WebView. It serves a fixed allowlist from this probe's
 * PluginHost-private installation directory and blocks every other navigation.
 * It is not the production Ola Ink player or a general file browser.
 */
public final class OlaInkProbeWebViewManager extends SimpleViewManager<WebView> {
  private static final String TAG = "OlaInkEmbeddedProbe";
  private static final String NAME = "OlaInkProbeWebView";
  private static final String PLUGIN_ID = "olainknativeprobe1";
  private static final String HOST = "olaink-probe.local";
  private static final String BASE_URL = "https://" + HOST + "/webview/probe.html";

  @Override
  @NonNull
  public String getName() {
    return NAME;
  }

  @Override
  @SuppressLint("SetJavaScriptEnabled")
  @NonNull
  protected WebView createViewInstance(@NonNull ThemedReactContext context) {
    final WebView view = new WebView(context);
    view.setBackgroundColor(0xfff7f4ed);
    view.getSettings().setJavaScriptEnabled(true);
    view.getSettings().setDomStorageEnabled(true);
    view.getSettings().setAllowFileAccess(false);
    view.getSettings().setAllowContentAccess(false);
    view.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      view.getSettings().setSafeBrowsingEnabled(true);
    }
    view.addJavascriptInterface(new ProbeBridge(), "OlaInkProbeWeb");
    view.setWebViewClient(new LocalOnlyClient(pluginRoot(context)));
    view.loadUrl(BASE_URL);
    return view;
  }

  @Override
  public void onDropViewInstance(@NonNull WebView view) {
    view.removeJavascriptInterface("OlaInkProbeWeb");
    view.stopLoading();
    view.loadUrl("about:blank");
    view.clearHistory();
    view.destroy();
    super.onDropViewInstance(view);
  }

  private static File pluginRoot(ThemedReactContext context) {
    return new File(context.getFilesDir(), "plugins" + File.separator + PLUGIN_ID);
  }

  private static final class ProbeBridge {
    @JavascriptInterface
    public void postStatus(String status) {
      final String safe = status == null ? "" : status.replaceAll("[\r\n]", " ");
      Log.i(TAG, "web " + safe.substring(0, Math.min(safe.length(), 400)));
    }
  }

  private static final class LocalOnlyClient extends WebViewClient {
    private final File root;

    LocalOnlyClient(File root) {
      this.root = root;
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
      return serve(request.getUrl());
    }

    @Override
    @SuppressWarnings("deprecation")
    public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
      return serve(Uri.parse(url));
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
      return !isAllowed(request.getUrl());
    }

    @Override
    @SuppressWarnings("deprecation")
    public boolean shouldOverrideUrlLoading(WebView view, String url) {
      return !isAllowed(Uri.parse(url));
    }

    private WebResourceResponse serve(Uri uri) {
      if (!isAllowed(uri)) return blocked("navigation is not allowed");
      final String path = uri.getPath();
      if (path == null || !path.startsWith("/webview/")) return blocked("invalid asset path");
      try {
        final File canonicalRoot = root.getCanonicalFile();
        final File file = new File(canonicalRoot, path.substring(1)).getCanonicalFile();
        final String rootPrefix = canonicalRoot.getPath() + File.separator;
        if (!file.getPath().startsWith(rootPrefix) || !file.isFile()) return blocked("asset not found");
        return new WebResourceResponse(mimeType(file.getName()), "UTF-8", new FileInputStream(file));
      } catch (IOException | SecurityException error) {
        Log.w(TAG, "local asset load failed " + error.getClass().getSimpleName());
        return blocked("asset unavailable");
      }
    }

    private static boolean isAllowed(Uri uri) {
      if (!"https".equals(uri.getScheme()) || !HOST.equals(uri.getHost())) return false;
      final String path = uri.getPath();
      return "/webview/probe.html".equals(path)
          || "/webview/probe-module.js".equals(path)
          || "/webview/probe-worker.js".equals(path);
    }

    private static WebResourceResponse blocked(String message) {
      final Map<String, String> headers = new HashMap<>();
      headers.put("Cache-Control", "no-store");
      return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", headers,
          new ByteArrayInputStream(message.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    }

    private static String mimeType(String name) {
      final String lower = name.toLowerCase(Locale.ROOT);
      if (lower.endsWith(".html")) return "text/html";
      if (lower.endsWith(".js")) return "text/javascript";
      return "application/octet-stream";
    }
  }
}
