# snuxlib design notes

## What it imitates

The Supernote system **Settings** app (and InkHub): a 71-unit black title bar
with the close button and app name on the left and the pane title in the
middle; a 294-unit tab column with a 5-unit black selection bar on its right
edge, dashed rules between tabs; a white pane with 82-unit rows separated by
dashed rules (solid for the last row of a group); 22-unit body text, 20-unit
section labels in grey. Units are React Native density-independent units; the
device is 1920x2560 px at 1.875 px per unit. All numbers live in `src/theme.ts`.

Account/user settings are a tab pinned to the bottom of the menu and labelled
with the username, as in InkHub's Upload / username group.

## E-ink rules

- Large touch targets (>= 82 units tall), black on white, no colour reliance
  (greys and red come out as dithered grey), no animation, no shadows.
- No platform `Alert`, `Switch`, `Modal`, `Picker`: they are tiny and low
  contrast on this screen. Use `ConfirmPanel` and `Toggle`.
- Do not make the user hunt for status text: all of it goes to the Logs tab.
  Keep only an inline result when the user must see it next to the control (a
  rejected pairing code).
- Text fields near the top of the pane; the keyboard covers the lower half.
- Prefer one tab per task, and keep tabs few (the menu shows 4 to 6 comfortably).

## Gotchas (each cost a debugging session)

- **Dashed borders on one side are ignored on Android**, so `Dashes` draws the
  rule with small Views. Do not use `borderStyle: 'dashed'` on a single border.
- **Children of a `flexWrap: 'wrap'` row lose their top margin.** Buttons go in
  `ButtonRow`, which owns the spacing.
- **Call handlers without the press event.** The components do; if you write a
  `Pressable`, call `onPress()` not `onPress`.
- **`closePluginView()` and `openFile()` stop the JS runtime**: component state
  and the log reset on next open. Persist what matters in the plugin's own
  store; do not rely on state.
- **Images must be `require()`d** and the bundle built with `--assets-dest`,
  or they are missing at runtime. snuxlib's icons are named
  `__snuxlib_assets_icons_*.png` in the output.
- **TSX parse quirk:** `await x()` followed by a newline and `as T` does not
  parse; assign to a variable first.
- **The first React Native render can differ from your mental layout** because
  Yoga on Android drops margins in some cases (above). Always check on the device.

## Verifying on a device

There is no desktop renderer for these screens; look at the real thing.

1. Build and install the plugin (`scripts/snplg-deploy.sh packages/plugin`; the
   versionCode must be higher than what is installed; see the olaink AGENTS.md).
2. Open a note, tap the plugins (puzzle) icon, tap the plugin.
3. Screenshot with `adb exec-out screencap -p > shot.png`. **The e-ink panel
   redraws late: a screenshot taken right after a tap can show the previous
   frame.** Wait 3 s and capture twice, or confirm with
   `adb shell uiautomator dump` (the text of the current React tree is in it).
4. Do not tap through the device while someone is using it; take screenshots
   first and tap by coordinates you have seen on a screenshot.

To prove a refactor changed nothing, compare screenshots byte for byte
(`cmp before.png after.png`); the olaink move onto snuxlib did exactly that.
