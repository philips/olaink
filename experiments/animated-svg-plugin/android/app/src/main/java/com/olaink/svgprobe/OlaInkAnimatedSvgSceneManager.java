package com.olaink.svgprobe;

import androidx.annotation.NonNull;

import com.facebook.react.uimanager.SimpleViewManager;
import com.facebook.react.uimanager.ThemedReactContext;
import com.facebook.react.uimanager.annotations.ReactProp;

/** Exposes the constrained native SVG-path scene to the React Native probe. */
public final class OlaInkAnimatedSvgSceneManager extends SimpleViewManager<AnimatedSvgSceneView> {
  private static final String NAME = "OlaInkAnimatedSvgScene";

  @Override
  @NonNull
  public String getName() {
    return NAME;
  }

  @Override
  @NonNull
  protected AnimatedSvgSceneView createViewInstance(@NonNull ThemedReactContext context) {
    return new AnimatedSvgSceneView(context);
  }

  @ReactProp(name = "technique")
  public void setTechnique(AnimatedSvgSceneView view, String technique) {
    view.setTechnique(technique == null ? "prefix" : technique);
  }

  @ReactProp(name = "durationMs", defaultInt = 6000)
  public void setDurationMs(AnimatedSvgSceneView view, int durationMs) {
    view.setTiming(durationMs, view.getFramesPerSecond());
  }

  @ReactProp(name = "framesPerSecond", defaultInt = 10)
  public void setFramesPerSecond(AnimatedSvgSceneView view, int framesPerSecond) {
    view.setTiming(view.getDurationMs(), framesPerSecond);
  }

  @ReactProp(name = "playing", defaultBoolean = true)
  public void setPlaying(AnimatedSvgSceneView view, boolean playing) {
    view.setPlaying(playing);
  }

  @ReactProp(name = "restartToken", defaultInt = 0)
  public void setRestartToken(AnimatedSvgSceneView view, int restartToken) {
    view.restart();
  }

  @Override
  public void onDropViewInstance(@NonNull AnimatedSvgSceneView view) {
    view.dispose();
    super.onDropViewInstance(view);
  }
}
