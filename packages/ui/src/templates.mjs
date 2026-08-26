/** Shared static shell fragments for the marketing site and self-hosted inbox. */
function escapeAttribute(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

/** @typedef {{ homeHref?: string, logoSrc?: string, navigation?: string }} HeaderOptions */
/** @typedef {{ href: string, label: string }} NavLinkOptions */

/**
 * `navigation` is intentionally trusted markup assembled by each first-party
 * shell. Dynamic user content must never be passed here.
 * @param {HeaderOptions} options
 */
export function olaInkHeader(options = {}) {
  const { homeHref = '/', logoSrc, navigation = '' } = options;
  const logo = logoSrc
    ? `<img src="${escapeAttribute(logoSrc)}" alt="" width="42" height="42">`
    : '';
  const nav = navigation ? `<nav class="olaink-nav" aria-label="Main navigation">${navigation}</nav>` : '';
  return `<header class="olaink-header"><a class="olaink-brand" href="${escapeAttribute(homeHref)}" aria-label="Ola Ink home">${logo}<span>Ola Ink</span></a>${nav}</header>`;
}

/** @param {NavLinkOptions} options */
export function olaInkNavLink({ href, label }) {
  return `<a class="olaink-nav-link" href="${escapeAttribute(href)}">${escapeAttribute(label)}</a>`;
}
