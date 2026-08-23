# Issue #5 — Plugin Manager config button

Issue: <https://github.com/philips/wrtn/issues/5>

## Goal

Expose SwapNote configuration from the Supernote Plugin Manager while retaining
the existing `.note`-backed server URL and username persistence.

## Implementation

1. Add a small Plugin Manager config-button registration module.
   - Call `registerConfigButton()` before adding its listener, as required by
     the SDK.
   - Make setup idempotent per JS runtime so repeated startup paths do not add
     duplicate listeners.
   - On click call `showPluginView()`, which opens the existing SwapNote setup
     UI containing the relay URL and username status.
   - Log registration and view-opening failures without crashing plugin startup.
2. Invoke registration after `PluginManager.init()` from the plugin entry point.
3. Unit-test ordering, idempotency, failed registration, retry behavior, and
   view routing using a fake Plugin Manager.
4. Document the Plugin Manager entry point and run typecheck, tests, and a
   plugin build.

## Implementation status

Completed 2026-08-23. Typechecking and all 72 unit tests pass; the release
plugin bundle also builds successfully. On-device Plugin Manager validation is
the remaining manual check.

## Acceptance checks

- Config button registration precedes listener creation.
- A click calls `showPluginView()` exactly once per listener invocation.
- Repeated registration attempts share one listener; a failed setup can retry.
- The existing setup view remains the configuration surface and persistence
  implementation is unchanged.
