/**
 * swaptest — server-side test bot (issue #2).
 *
 * "For testing please create a 'swaptest' user that generates new pages by
 * hitting a testing endpoint on the server." Hitting
 * POST /v1/test/swaptest/page { to } generates a plausible handwritten page
 * (a few random-walk strokes) and routes it to `to` exactly like a real
 * client's page.send: mailbox + immediate delivery when online.
 */

import type { PageElement } from '@olaink/protocol';

export interface RandomSource {
  (): number;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Generate a page of random-walk strokes. Deterministic given `rand`, so
 * tests can seed it. Points are normalized 0..1 with a 5% margin so the
 * page renders fully inside the margin on any device.
 */
export function generateSwapTestPage(rand: RandomSource = Math.random): PageElement[] {
  const strokeCount = 3 + Math.floor(rand() * 4); // 3..6 strokes
  const els: PageElement[] = [];
  for (let s = 0; s < strokeCount; s++) {
    const pointCount = 6 + Math.floor(rand() * 10); // 6..15 points
    // sid is dedup/debug-only, but keep it a pure function of `rand` so a
    // seeded source is fully deterministic (Date.now() here broke the
    // determinism test at millisecond boundaries).
    const sidToken = Math.floor(rand() * 0xffffff).toString(36);
    let x = 0.1 + rand() * 0.3;
    let y = 0.1 + rand() * 0.3;
    const pts: number[] = [];
    for (let i = 0; i < pointCount; i++) {
      x = clamp01(x + (rand() - 0.5) * 0.08);
      y = clamp01(y + (rand() - 0.5) * 0.08);
      pts.push(round3(x), round3(y));
    }
    els.push({
      kind: 'stroke',
      stroke: {
        sid: `swap-${sidToken}-${s}`,
        penColor: 0x00,
        penType: 10,
        thickness: 300,
        pts,
      },
    });
  }
  return els;
}
