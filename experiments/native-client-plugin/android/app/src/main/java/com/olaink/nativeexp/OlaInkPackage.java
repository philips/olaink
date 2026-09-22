package com.olaink.nativeexp;

import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import java.util.Collections;
import java.util.List;

/** Entry point named by the disposable experiment's PluginConfig.json. */
public final class OlaInkPackage implements ReactPackage {
  @Override
  public List<NativeModule> createNativeModules(ReactApplicationContext context) {
    return Collections.singletonList(new OlaInkNativeClientModule(context));
  }

  @Override
  public List<com.facebook.react.uimanager.ViewManager> createViewManagers(
      ReactApplicationContext context) {
    return Collections.emptyList();
  }
}
