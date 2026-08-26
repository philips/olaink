// Build-time tokens replaced in the release bundle by buildPlugin.sh.
// Keeping this source static prevents build metadata from dirtying the checkout.
export const BUILD_STAMP = {
  git: '__OLAINK_BUILD_GIT__',
  builtAt: '__OLAINK_BUILD_TIME__',
} as const;
