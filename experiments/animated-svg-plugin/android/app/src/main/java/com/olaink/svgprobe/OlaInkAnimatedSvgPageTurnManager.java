package com.olaink.svgprobe;

import androidx.annotation.NonNull;

import com.facebook.react.uimanager.SimpleViewManager;
import com.facebook.react.uimanager.ThemedReactContext;
import com.facebook.react.uimanager.annotations.ReactProp;

/** Exposes the native two-page, one-second-turn-hold timeline test. */
public final class OlaInkAnimatedSvgPageTurnManager extends SimpleViewManager<AnimatedSvgPageTurnView> {
  private static final String NAME = "OlaInkAnimatedSvgPageTurn";

  @Override
  @NonNull
  public String getName() {
    return NAME;
  }

  @Override
  @NonNull
  protected AnimatedSvgPageTurnView createViewInstance(@NonNull ThemedReactContext context) {
    return new AnimatedSvgPageTurnView(context);
  }

  @ReactProp(name = "playing", defaultBoolean = true)
  public void setPlaying(AnimatedSvgPageTurnView view, boolean playing) {
    view.setPlaying(playing);
  }

  @ReactProp(name = "restartToken", defaultInt = 0)
  public void setRestartToken(AnimatedSvgPageTurnView view, int restartToken) {
    view.restart();
  }

  @Override
  public void onDropViewInstance(@NonNull AnimatedSvgPageTurnView view) {
    view.dispose();
    super.onDropViewInstance(view);
  }
}
