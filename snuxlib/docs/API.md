# snuxlib API

All exports come from the package root (`import { ... } from 'snuxlib'`, or
`'./snuxlib'` when vendored). Handlers are always called **with no
arguments** (never the press event), so `onPress={refresh}` is safe even if
`refresh(silent = false)` takes optional arguments.

## Frame

### `PluginScreen`
The whole screen: black title bar, vertical tab menu, scrolling pane. Render it
as the root.

| prop | type | |
|---|---|---|
| `appName` | `string` | Next to the close button in the title bar |
| `title` | `string` | Pane title, centred in the title bar (e.g. `Inbox (2)`) |
| `onClose` | `() => void` | Normally `() => PluginManager.closePluginView()` |
| `tabs` | `TabSpec[]` | The tab menu, in order |
| `activeKey` | `string` | `key` of the selected tab |
| `children` | node | Pane content (scrolls; taps stay live while a keyboard is open) |

`TabSpec`: `{ key, label, icon, onPress, bottom? }`. `icon` is a `require()`d
image or one of `icons`. `bottom: true` pins the tab to the bottom of the menu
after the others (account/username tab). Long labels truncate to one line.

### `SideTab`
One menu row; only needed if you build your own frame. `{ label, icon, active, onPress }`.

## Lists

### `ListRow`
| prop | type | |
|---|---|---|
| `title` | `string` | up to 2 lines |
| `meta` | `string?` | grey second line (id, date, sender), 1 line |
| `detail` | `string?` | bold third line: the fact the user decides on ("9 notes waiting") |
| `onPress` | `() => void`? | makes it tappable and adds a chevron |
| `action` | `string?` | underlined text on the right instead of the chevron (needs `onPress`) |
| `solid` | `boolean?` | end with a solid rule (last row of a group) instead of dashes |

### `Dashes`, `Rule`
The dashed and solid separators, for custom layouts.

## Text

All take `children`. `SectionLabel`: small grey group heading (starts a group).
`BodyText`: paragraph. `EmptyText`: nothing-to-show message. `StatusText`:
small grey inline result/error next to the control that caused it (selectable).
`MonoText`: selectable monospace for keys, ids, hashes.

### `TextField`
`{ value, onChangeText, placeholder?, keyboardType? }`. Underlined, single line,
autocorrect and auto-capitalise off. Put it near the top of the pane: the
on-screen keyboard covers the lower half of the screen.

## Buttons

`PrimaryButton` (solid black; the one main action) and `SecondaryButton`
(outlined; secondary/cancel): `{ label, onPress }`.
`ButtonRow` wraps two or more buttons side by side. **Use it for any group of
buttons**: it supplies the spacing above them (Android drops the top margin of
children in a wrapping row, so the buttons must not carry it themselves).

## Controls

### `Toggle`
`{ label, subtext?, value, onChange(next), disabled? }`. A large bordered row
with a big ON/OFF pill (black when on). `disabled` renders dashed and grey and
ignores taps; say why in `subtext`.

### `ConfirmPanel`
`{ title, message, confirmLabel, onConfirm, onCancel, destructive? }`.
In-screen replacement for `Alert`. Render it in the pane right below the thing
being confirmed, and hide it on confirm or cancel. `destructive` makes the
confirm button red (rendered grey on e-ink; the thick border and wording carry the
meaning, so keep the message explicit about what is lost).

## Logging

### `useLog({ max?, initial?, prefix? })` -> `{ entries, log, clear }`
In-memory append-only log (default 200 lines). `log(text)` is safe from any
callback or effect, ignores empty strings (so `.then(log)` works), and, if
`prefix` is set, also `console.log`s `[prefix] text` (visible in
`logcat` as `ReactNativeJS`). The log lives only while the plugin view is open:
`closePluginView()` ends the JS runtime.

### `LogPane({ entries, onClear, diagnostics?, hint? })`
The body of a Logs tab: a Diagnostics block (`diagnostics`, one fact per line:
version, device id, user, API level...), then the log newest first with UTC
timestamps, and a Clear button. Ask users for a screenshot of this tab.

Pure helper: `appendLog(entries, text, at, max?)`.

## Helpers and constants

`formatBytes(n)` -> `"220 KB"`/`"1.4 MB"`; `formatClock(ms)` -> `"17:19:40"` (UTC);
`formatDay(ms)` -> `"2026-10-17"` (UTC). `icons.{close,chevron,back,inbox,send,
settings,pair,logs,user}`. `theme.{color,size,font}`: the measurements and colours
used above, for the rare custom view; prefer composing components.
