package com.olaink.svgprobe;

import androidx.annotation.NonNull;

import com.facebook.react.uimanager.SimpleViewManager;
import com.facebook.react.uimanager.ThemedReactContext;
import com.facebook.react.uimanager.annotations.ReactProp;

/** Exposes the fixtures embedded-scene document player to the probe app. */
public final class OlaInkAnimatedSvgDocumentManager extends SimpleViewManager<AnimatedSvgDocumentView> {
  private static final String NAME = "OlaInkAnimatedSvgDocument";

  @Override
  @NonNull
  public String getName() {
    return NAME;
  }

  @Override
  @NonNull
  protected AnimatedSvgDocumentView createViewInstance(@NonNull ThemedReactContext context) {
    return new AnimatedSvgDocumentView(context);
  }

  @ReactProp(name = "pagesJson")
  public void setPagesJson(AnimatedSvgDocumentView view, String pagesJson) {
    view.setPages(pagesJson, view.getDocumentTitle());
  }

  @ReactProp(name = "title")
  public void setTitle(AnimatedSvgDocumentView view, String title) {
    view.setPages(view.getPagesJson(), title);
  }

  @ReactProp(name = "playing", defaultBoolean = true)
  public void setPlaying(AnimatedSvgDocumentView view, boolean playing) {
    view.setPlaying(playing);
  }

  @ReactProp(name = "playbackSpeed", defaultFloat = 1f)
  public void setPlaybackSpeed(AnimatedSvgDocumentView view, float speed) {
    view.setSpeed(speed);
  }

  @ReactProp(name = "restartToken", defaultInt = 0)
  public void setRestartToken(AnimatedSvgDocumentView view, int restartToken) {
    view.restart();
  }

  @Override
  public void onDropViewInstance(@NonNull AnimatedSvgDocumentView view) {
    view.dispose();
    super.onDropViewInstance(view);
  }
}
