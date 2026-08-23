/** Requested presentation for the next mounted plugin view. */

export type PluginViewMode = 'config' | 'inbox';

let requestedViewMode: PluginViewMode = 'config';

export function setPluginViewMode(mode: PluginViewMode): void {
  requestedViewMode = mode;
}

export function getPluginViewMode(): PluginViewMode {
  return requestedViewMode;
}
