/**
 * Toolbar wiring (the only place besides snDevice.ts that registers
 * buttons). Registered at runtime boot from index.js.
 *
 *  - 101 "WRTN Setup" (showType 1): fullscreen setup/status view.
 *  - 102 "WRTN" (showType 0): headless session entry point. Tapping it in a
 *    note boots the runtime, which auto-starts the session — then just draw.
 *  - 103 "WRTN Pull" (showType 0): headless manual pull. Tapping it flushes
 *    the queued remote strokes into the current page (one screen flash per
 *    pull). The button doubles as the "notification symbol": the core keeps
 *    it disabled (grayed) while idle and enables it (lit) while strokes are
 *    waiting — the SDK exposes no icon/badge update API, only setButtonState.
 */

import { Image } from 'react-native';
import { PluginManager } from 'sn-plugin-lib';

import { BUTTON_ID } from './buttonIds.ts';
import { getCore, startSession } from './headless.ts';

export function registerToolbarButtons(): void {
  const icon = Image.resolveAssetSource(require('../assets/icon.png')).uri;
  const pullIcon = Image.resolveAssetSource(require('../assets/icon-pull.png')).uri;

  void PluginManager.registerButton(1, ['NOTE'], {
    id: BUTTON_ID.setup,
    name: 'WRTN Setup',
    icon,
    showType: 1,
  });
  void PluginManager.registerButton(1, ['NOTE'], {
    id: BUTTON_ID.session,
    name: 'WRTN',
    icon,
    showType: 0,
  });
  void PluginManager.registerButton(1, ['NOTE'], {
    id: BUTTON_ID.pull,
    name: 'WRTN Pull',
    icon: pullIcon,
    showType: 0,
  });

  // Headless buttons still deliver press events (docs: showType 0 — "the
  // plugin still receives the button event and can run background logic").
  PluginManager.registerButtonListener({
    // Annotated structurally: the SDK d.ts fails to contextually type this
    // callback under our tsconfig (implicit-any), and ButtonEvent is not
    // exported from the package index.
    onButtonPress: (event: { id: number; name: string; icon: string }) => {
      if (event.id !== BUTTON_ID.pull) return;
      // Tapping the pull button also (re)starts the session if the runtime
      // just booted; pullPending is a no-op when nothing is queued.
      void startSession()
        .then(() => getCore().pullPending())
        .catch((err: Error) => console.log(`[wrtn] pull failed: ${err.message}`));
    },
  });
}
