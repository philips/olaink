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
    expect(size.success && size.result).toEqual({ width: 1920, height: 2560 });

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
    expect(el?.stroke).not.toBeNull();
    if (!el?.stroke) return;

    await el.stroke.points.setRange(0, 1, [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
    await el.stroke.pressures.setRange(0, 1, [10, 20]);

    const inserted = await stub.insertElements('/Note/B.note', 0, [el]);
    expect(inserted.success && inserted.result).toBe(true);

    const elements = await stub.getElements(0, '/Note/B.note');
    const got = elements.success ? elements.result : [];
    expect(got).toHaveLength(1);
    const first = got?.[0];
    expect(first?.numInPage).toBe(0);
    expect(first?.stroke).not.toBeNull();

    const pts = await first!.stroke!.points.getRange(0, 10);
    expect(pts).toEqual([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
    const prs = await first!.stroke!.pressures.getRange(0, 10);
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

  it('insertNotePage appends/inserts a blank page with the note\'s size', async () => {
    const stub = new StubDevice();
    stub.t.openNote('/Note/D.note', 2);

    const append = await stub.insertNotePage({ notePath: '/Note/D.note', page: 2, template: 'blank' });
    expect(append.success && append.result).toBe(true);
    expect((await stub.getNoteTotalPageNum('/Note/D.note')).result).toBe(3);
    expect((await stub.getPageSize('/Note/D.note', 2)).result).toEqual({ width: 1920, height: 2560 });
    expect((await stub.getElements(2, '/Note/D.note')).result).toHaveLength(0);

    // Insert in the middle: pages shift, content preserved.
    const insert = await stub.insertNotePage({ notePath: '/Note/D.note', page: 1, template: 'blank' });
    expect(insert.success).toBe(true);
    expect((await stub.getNoteTotalPageNum('/Note/D.note')).result).toBe(4);

    // The original first page is still first, the new one is page 1.
    expect((await stub.getElements(0, '/Note/D.note')).result).toHaveLength(0);
    expect((await stub.getElements(1, '/Note/D.note')).result).toHaveLength(0);
  });

  it('insertNotePage rejects bad template, index, and missing note', async () => {
    const stub = new StubDevice();
    stub.t.openNote('/Note/E.note');

    const badTemplate = await stub.insertNotePage({ notePath: '/Note/E.note', page: 1, template: 'sparkles' });
    expect(badTemplate.success).toBe(false);

    const badIndex = await stub.insertNotePage({ notePath: '/Note/E.note', page: 5, template: 'blank' });
    expect(badIndex.success).toBe(false);

    const noNote = await stub.insertNotePage({ notePath: '/Note/Gone.note', page: 0, template: 'blank' });
    expect(noNote.success).toBe(false);
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

describe('StubDevice on-device fidelity (2026-08-23 probes)', () => {
  it('createNote rejects relative note-root paths with 1204', async () => {
    const stub = new StubDevice();
    const r = await stub.createNote({ notePath: '/MyStyle/x.note', template: 'style_white', isPortrait: true });
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe(1204);

    const okR = await stub.createNote({ notePath: '/storage/emulated/0/MyStyle/x.note', template: 'style_white', isPortrait: true });
    expect(okR.success).toBe(true);
  });

  it('getNoteSystemTemplates fails in the settings context (102)', async () => {
    const stub = new StubDevice({ settingsContext: true });
    const r = await stub.getNoteSystemTemplates();
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe(102);
  });

  it('getNoteSystemTemplates lists style_white first in the note context', async () => {
    const stub = new StubDevice();
    const r = await stub.getNoteSystemTemplates();
    expect(r.success).toBe(true);
    expect(r.result?.[0]?.name).toBe('style_white');
  });
});
