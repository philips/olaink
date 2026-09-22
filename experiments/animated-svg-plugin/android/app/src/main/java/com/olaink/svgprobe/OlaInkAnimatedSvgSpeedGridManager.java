package com.olaink.svgprobe;

import androidx.annotation.NonNull;

import com.facebook.react.uimanager.SimpleViewManager;
import com.facebook.react.uimanager.ThemedReactContext;
import com.facebook.react.uimanager.annotations.ReactProp;

/** Exposes one fixed native Canvas containing all six e-ink timing presets. */
public final class OlaInkAnimatedSvgSpeedGridManager extends SimpleViewManager<AnimatedSvgSpeedGridView> {
  private static final String NAME = "OlaInkAnimatedSvgSpeedGrid";

  @Override
  @NonNull
  public String getName() {
    return NAME;
  }

  @Override
  @NonNull
  protected AnimatedSvgSpeedGridView createViewInstance(@NonNull ThemedReactContext context) {
    return new AnimatedSvgSpeedGridView(context);
  }

  @ReactProp(name = "playing", defaultBoolean = true)
  public void setPlaying(AnimatedSvgSpeedGridView view, boolean playing) {
    view.setPlaying(playing);
  }

  @ReactProp(name = "restartToken", defaultInt = 0)
  public void setRestartToken(AnimatedSvgSpeedGridView view, int restartToken) {
    view.restart();
  }

  @Override
  public void onDropViewInstance(@NonNull AnimatedSvgSpeedGridView view) {
    view.dispose();
    super.onDropViewInstance(view);
  }
}
