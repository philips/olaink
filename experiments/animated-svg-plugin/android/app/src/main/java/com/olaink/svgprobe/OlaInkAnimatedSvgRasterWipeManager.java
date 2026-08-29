package com.olaink.svgprobe;

import androidx.annotation.NonNull;

import com.facebook.react.uimanager.SimpleViewManager;
import com.facebook.react.uimanager.ThemedReactContext;
import com.facebook.react.uimanager.annotations.ReactProp;

/** Exposes the supplied raster-backed SVG's honest image-wipe experiment. */
public final class OlaInkAnimatedSvgRasterWipeManager extends SimpleViewManager<AnimatedSvgRasterWipeView> {
  private static final String NAME = "OlaInkAnimatedSvgRasterWipe";

  @Override
  @NonNull
  public String getName() {
    return NAME;
  }

  @Override
  @NonNull
  protected AnimatedSvgRasterWipeView createViewInstance(@NonNull ThemedReactContext context) {
    return new AnimatedSvgRasterWipeView(context);
  }

  @ReactProp(name = "playing", defaultBoolean = true)
  public void setPlaying(AnimatedSvgRasterWipeView view, boolean playing) {
    view.setPlaying(playing);
  }

  @ReactProp(name = "restartToken", defaultInt = 0)
  public void setRestartToken(AnimatedSvgRasterWipeView view, int restartToken) {
    view.restart();
  }

  @Override
  public void onDropViewInstance(@NonNull AnimatedSvgRasterWipeView view) {
    view.dispose();
    super.onDropViewInstance(view);
  }
}
