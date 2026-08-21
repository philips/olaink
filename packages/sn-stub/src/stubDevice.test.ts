import { describe, expect, it } from 'vitest';
import { StubDevice } from './stubDevice.ts';

describe('StubDevice', () => {
  it('tracks current file/page and elements', async () => {
    const stub = new StubDevice();
    stub.t.openNote('/Note/Test.note', 3);
    stub.t.goToPage(1);

    const path = await stub.getCurrentFilePath();
    expect(path.success && path.result).toBe('/Note/Test.note');
    const page = await stub.getCurrentPageNum();
    expect(page.success && page.result).toBe(1);

    const size = await stub.getPageSize('/Note/Test.note', 0);
    expect(size.success && size.result).toEqual({ width: 1404, height: 1872 });

    const total = await stub.getNoteTotalPageNum('/Note/Test.note');
    expect(total.success && total.result).toBe(3);
  });

  it('drawStroke commits an element and fires pen-up listeners', async () => {
    const stub = new StubDevice();
    stub.t.openNote('/Note/A.note');

    const seen: unknown[] = [];
    stub.registerEventListener('event_pen_up', 1, (p) => seen.push(p));

    const el = stub.t.drawStroke([
      { x: 100, y: 100 },
      { x: 200, y: 300 },
    ]);

    expect(seen).toHaveLength(1);
    expect(el.numInPage).toBe(0);

    const last = await stub.getLastElement();
    expect(last.success && last.result?.uuid).toBe(el.uuid);

    const elements = await stub.getElements(0, '/Note/A.note');
    expect(elements.success && elements.result).toHaveLength(1);
  });

  it('createElement + accessor setRange + insertElements round-trips', async () => {
    const stub = new StubDevice();
    stub.t.openNote('/Note/B.note');

    const created = await stub.createElement(0 /* stroke */);
    const el = created.success ? created.result : null;
    expect(el).not.toBeNull();
    if (!el) return;

    await el.points.setRange(0, 1, [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
    await el.pressures.setRange(0, 1, [10, 20]);

    const inserted = await stub.insertElements('/Note/B.note', 0, [el]);
    expect(inserted.success && inserted.result).toBe(true);

    const elements = await stub.getElements(0, '/Note/B.note');
    const got = elements.success ? elements.result : [];
    expect(got).toHaveLength(1);
    const first = got?.[0];
    expect(first?.numInPage).toBe(0);

    const pts = await first!.points.getRange(0, 10);
    expect(pts).toEqual([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
    const prs = await first!.pressures.getRange(0, 10);
    expect(prs).toEqual([10, 20]);
  });

  it('records save/reload counts and button presses', async () => {
    const stub = new StubDevice();
    stub.t.openNote('/Note/C.note');

    await stub.saveCurrentNote();
    await stub.reloadFile();
    expect(stub.t.savedCount()).toBe(1);
    expect(stub.t.reloadedCount()).toBe(1);

    const presses: unknown[] = [];
    stub.registerButtonListener((m) => presses.push(m));
    stub.t.pressButton(42);
    expect(presses).toEqual([{ id: 42 }]);
  });

  it('life listeners fire on start/stop', () => {
    const stub = new StubDevice();
    const events: string[] = [];
    stub.addPluginLifeListener({
      onStart: () => events.push('start'),
      onStop: () => events.push('stop'),
    });
    stub.t.startPlugin();
    stub.t.stopPlugin();
    expect(events).toEqual(['start', 'stop']);
  });
});
