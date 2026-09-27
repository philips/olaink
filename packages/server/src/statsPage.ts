/**
 * Renders GET /stats: a public, read-only operational dashboard. Every
 * number here is an aggregate count or byte total (see
 * plans/service-stats.md for the full list and the "why this is safe to
 * publish" reasoning) -- no usernames, device IDs, filenames, or ciphertext
 * ever reach this page.
 */
import type { ServiceStats } from './d1Store.ts';
import { summarizeDistribution } from './statsMath.ts';

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function formatInt(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function formatMB(bytes: number): string {
  return `${(bytes / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MB`;
}

function stat(label: string, value: string, help?: string): string {
  return `<div class="stat"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>${
    help ? `<p class="help">${escapeHtml(help)}</p>` : ''
  }</div>`;
}

export function renderStatsPage(stats: ServiceStats, generatedAt: number): string {
  const distribution = summarizeDistribution(stats.storageByAccountBytes);
  const averageMessageBytes = stats.pendingMessages > 0 ? stats.pendingBytes / stats.pendingMessages : 0;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ola Ink — Service stats</title>
  <style>
    :root {
      --olaink-paper: #F6F4EF; --olaink-ink: #233329; --olaink-sage: #7A8A80;
      --olaink-line: #E2DDD3; --olaink-muted: #526158;
      color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--olaink-ink); background: var(--olaink-paper);
    }
    * { box-sizing: border-box; }
    body { margin: 0; }
    main { max-width: 880px; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }
    a { color: inherit; }
    header { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: .5rem; margin-bottom: .25rem; }
    h1 { font-family: Georgia, "Times New Roman", serif; font-weight: 500; letter-spacing: -.02em; font-size: 1.9rem; margin: 0; }
    .home-link { font-size: .9rem; text-underline-offset: 4px; }
    .intro { max-width: 640px; color: var(--olaink-muted); line-height: 1.55; margin: .75rem 0 2.25rem; }
    section { margin-bottom: 2.25rem; }
    h2 { font-size: 1.05rem; letter-spacing: .04em; text-transform: uppercase; color: var(--olaink-sage); margin: 0 0 1rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1px; background: var(--olaink-line); border: 1px solid var(--olaink-line); }
    .stat { background: #fffdf8; padding: 1rem 1.1rem; margin: 0; }
    .stat dt { font-size: .8rem; color: var(--olaink-muted); margin: 0 0 .3rem; }
    .stat dd { font-size: 1.5rem; font-weight: 600; margin: 0; font-variant-numeric: tabular-nums; }
    .stat .help { margin: .35rem 0 0; font-size: .74rem; color: var(--olaink-muted); line-height: 1.4; }
    footer { color: var(--olaink-muted); font-size: .82rem; border-top: 1px solid var(--olaink-line); padding-top: 1.25rem; line-height: 1.5; }
    footer a { text-underline-offset: 4px; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Service stats</h1>
      <a class="home-link" href="/">← Ola Ink</a>
    </header>
    <p class="intro">
      Live, aggregate counts only. The relay stores ciphertext and cannot read
      note content, filenames, or sender/recipient names, and this page never
      lists individual accounts -- only totals and a size distribution across
      them.
    </p>

    <section aria-labelledby="accounts-heading">
      <h2 id="accounts-heading">Accounts</h2>
      <dl class="grid">
        ${stat('Active users', formatInt(stats.activeUsers), 'Accounts with a claimed, non-retired Ola Ink address.')}
        ${stat('All-time accounts', formatInt(stats.totalAccounts), 'AuthGravity-linked accounts ever created, with or without an address.')}
        ${stat('Enrolled devices', formatInt(stats.totalDevices), 'Primary/browser inbox devices currently enrolled.')}
        ${stat('Paired companions', formatInt(stats.companionSessions), 'Supernote/Pi device sessions currently paired.')}
      </dl>
    </section>

    <section aria-labelledby="messages-heading">
      <h2 id="messages-heading">Messages</h2>
      <dl class="grid">
        ${stat('Currently queued', formatInt(stats.pendingMessages), 'Sent, not yet fully delivered/acknowledged or purged.')}
        ${stat('Sent all-time', formatInt(stats.lifetimeMessages), 'Includes delivered and 14-day-retention-purged notes.')}
        ${stat('Accounts with queued mail', formatInt(stats.accountsWithPendingMessages))}
        ${stat('Avg. queued message size', formatMB(averageMessageBytes))}
      </dl>
    </section>

    <section aria-labelledby="storage-heading">
      <h2 id="storage-heading">Object storage</h2>
      <dl class="grid">
        ${stat('Currently stored', formatMB(stats.pendingBytes), 'Sum of ciphertext object sizes for queued messages.')}
        ${stat('Sent all-time', formatMB(stats.lifetimeBytes))}
      </dl>
    </section>

    <section aria-labelledby="distribution-heading">
      <h2 id="distribution-heading">Storage by account</h2>
      <p class="intro" style="margin-top:0">
        Across all ${formatInt(distribution.count)} active accounts, including 0 for
        accounts with nothing currently queued.
      </p>
      <dl class="grid">
        ${stat('Minimum', formatMB(distribution.minBytes))}
        ${stat('Median', formatMB(distribution.medianBytes))}
        ${stat('Mean', formatMB(distribution.meanBytes))}
        ${stat('Maximum', formatMB(distribution.maxBytes))}
      </dl>
    </section>

    <footer>
      Generated ${escapeHtml(new Date(generatedAt).toISOString())}. Sizes are
      ciphertext byte counts (1 MB = 1,000,000 bytes); Ola Ink cannot see
      inside them. See <a href="https://github.com/philips/olaink/blob/main/plans/service-stats.md">plans/service-stats.md</a> for methodology.
    </footer>
  </main>
</body>
</html>
`;
}
