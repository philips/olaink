package com.olaink.svgprobe;

import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.uimanager.ViewManager;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** Entry point named by the disposable probe's PluginConfig.json. */
public final class OlaInkSvgProbePackage implements ReactPackage {
  @Override
  public List<NativeModule> createNativeModules(ReactApplicationContext context) {
    return Collections.emptyList();
  }

  @Override
  public List<ViewManager> createViewManagers(ReactApplicationContext context) {
    return Arrays.asList(
        new OlaInkAnimatedSvgSceneManager(),
        new OlaInkAnimatedSvgSpeedGridManager(),
        new OlaInkAnimatedSvgRasterWipeManager(),
        new OlaInkAnimatedSvgPageTurnManager(),
        new OlaInkAnimatedSvgDocumentManager());
  }
}
