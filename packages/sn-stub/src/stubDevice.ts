/**
 * In-memory test double of the sn-plugin-lib surface the WRTN plugin uses.
 *
 * The plugin talks to the device through a narrow `DeviceBridge` interface
 * (defined in the plugin). On-device it is implemented by an adapter over
 * sn-plugin-lib; in tests it is implemented by `StubDevice` below. The stub
 * models the semantics that matter to WRTN:
 *
 *  - elements live in pages; strokes carry points/pressures behind async
 *    accessors (like ElementDataAccessor) inside `element.stroke`
 *  - createElement mints an element in a native-side cache addressed by uuid;
 *    insertElements commits cached elements into a note page — and, like the
 *    real device, fires event_pen_up for the inserted elements
 *  - getLastElement returns the last committed element on the current page
 *  - every call is recorded for assertions (calls array)
 *
 * Test helpers (not part of the real API) are grouped on `t`:
 * `stub.t.drawStroke(...)`, `stub.t.openNote(...)`, `stub.t.pressButton()`.
 */

export interface Point {
  x: number;
  y: number;
}

export interface APIResponse<T> {
  success: boolean;
  result: T | null;
  error: { code: number; message: string } | null;
}

export const TYPE_STROKE = 0;

export interface PenState {
  penColor: number;
  penType: number;
  thickness: number;
}

/**
 * Mirrors the SDK Stroke: pen params plus async point/pressure accessors
 * backed by plain arrays.
 */
export interface StubStrokeData {
  penColor: number;
  penType: number;
  points: StubAccessor<Point>;
  pressures: StubAccessor<number>;
}

function makeStroke(pen: Pick<PenState, 'penColor' | 'penType'>, pts: Point[], prs: number[]): StubStrokeData {
  return {
    penColor: pen.penColor,
    penType: pen.penType,
    points: new StubAccessor<Point>(() => pts),
    pressures: new StubAccessor<number>(() => prs),
  };
}

export interface StubTextBoxData {
  fontSize: number;
  textContentFull: string | null;
  textRect: { left: number; top: number; right: number; bottom: number };
  textAlign: number;
  textFrameWidthType: number;
}

export interface StubElement {
  uuid: string;
  type: number;
  pageNum: number;
  layerNum: number;
  thickness: number;
  numInPage: number;
  maxX: number;
  maxY: number;
  stroke: StubStrokeData | null;
  textBox: StubTextBoxData | null;
}

export interface PenUpEvent {
  pageNum: number;
  filePath: string;
}

export interface DeviceCall {
  method: string;
  args: unknown[];
}

function ok<T>(result: T): APIResponse<T> {
  return { success: true, result, error: null };
}

function fail<T = null>(code: number, message: string): APIResponse<T> {
  return { success: false, result: null, error: { code, message } };
}

let uuidCounter = 0;
function newUuid(): string {
  uuidCounter += 1;
  return `stub-uuid-${uuidCounter}`;
}

/**
 * Mirrors ElementDataAccessor's async surface.
 */
export class StubAccessor<T> {
  constructor(private readonly getData: () => T[]) {}

  async size(): Promise<number> {
    return this.getData().length;
  }

  async getRange(start: number, count: number): Promise<T[]> {
    return this.getData().slice(start, start + count);
  }

  async add(index: number, value: T): Promise<boolean> {
    this.getData().splice(index, 0, value);
    return true;
  }

  async setRange(_start: number, _end: number, values: T[]): Promise<boolean> {
    const data = this.getData();
    data.length = 0;
    data.push(...values);
    return true;
  }
}

export const SYSTEM_TEMPLATES = [
  { name: 'blank', hUri: 'templates/blank_h.png', vUri: 'templates/blank_v.png' },
] as const;

// Verified on-device 2026-08-21 (see AGENTS.md): Nomad A6X2 is 1920×2560
// px with EMR 21632×16224; A5X is 1404×1872 px with EMR 15819×11864.
export const NOMAD_EMR = { width: 21632, height: 16224 } as const;
export const NOMAD_PAGE = { width: 1920, height: 2560 } as const;
export const A5X_EMR = { width: 15819, height: 11864 } as const;
export const A5X_PAGE = { width: 1404, height: 1872 } as const;

interface PageData {
  width: number;
  height: number;
  emrWidth: number;
  emrHeight: number;
  elements: StubElement[];
}

interface NoteData {
  pages: PageData[];
}

type Listener = { id: number; cb: (payload: unknown) => void };
type LifeListener = { onStart?: () => void; onStop?: () => void };

export interface StubOptions {
  deviceType?: number;
  emrWidth?: number;
  emrHeight?: number;
}

export class StubDevice {
  public readonly deviceType: number;
  public readonly emr: { width: number; height: number };
  public readonly calls: DeviceCall[] = [];

  private readonly notes = new Map<string, NoteData>();
  private readonly cache = new Map<string, StubElement>();
  private currentFilePath: string | null = null;
  private currentPage = 0;
  private pen: PenState = { penColor: 0x00, penType: 10, thickness: 300 };
  private nextListenerId = 1;
  private readonly eventListeners = new Map<string, Map<number, Listener>>();
  private readonly buttonListeners = new Map<number, (msg: unknown) => void>();
  private readonly lifeListeners = new Set<LifeListener>();
  private savedCount = 0;
  private reloadedCount = 0;
  private pluginViewOpen = false;
  private inited = false;
  private readonly buttonStates = new Map<number, boolean>();

  /** Test-only helpers. */
  public readonly t: {
    openNote: (path: string, pages?: number) => void;
    goToPage: (page: number) => void;
    setPen: (pen: Partial<PenState>) => void;
    drawStroke: (points: Point[], opts?: Partial<PenState>) => StubElement;
    pressButton: (buttonId: number) => void;
    startPlugin: () => void;
    stopPlugin: () => void;
    savedCount: () => number;
    reloadedCount: () => number;
    isPluginViewOpen: () => boolean;
    buttonState: (id: number) => boolean;
  };

  constructor(opts: StubOptions = {}) {
    this.deviceType = opts.deviceType ?? 4; // A6X2 Nomad
    this.emr = { width: opts.emrWidth ?? NOMAD_EMR.width, height: opts.emrHeight ?? NOMAD_EMR.height };

    const self = this;
    this.t = {
      openNote(path, pages = 1) {
        if (!self.notes.has(path)) {
          self.notes.set(path, {
            pages: Array.from({ length: pages }, () => ({
              width: NOMAD_PAGE.width,
              height: NOMAD_PAGE.height,
              emrWidth: self.emr.width,
              emrHeight: self.emr.height,
              elements: [],
            })),
          });
        }
        self.currentFilePath = path;
        self.currentPage = 0;
      },
      goToPage(page) {
        self.currentPage = page;
      },
      setPen(pen) {
        self.pen = { ...self.pen, ...pen };
      },
      drawStroke(points, opts) {
        if (self.currentFilePath === null) throw new Error('no note open');
        const el = self.commitStroke(self.currentFilePath, self.currentPage, {
          penColor: opts?.penColor ?? self.pen.penColor,
          penType: opts?.penType ?? self.pen.penType,
          thickness: opts?.thickness ?? self.pen.thickness,
          points,
        });
        self.firePenUp();
        return el;
      },
      pressButton(buttonId) {
        for (const cb of self.buttonListeners.values()) cb({ id: buttonId });
      },
      startPlugin() {
        for (const l of self.lifeListeners) l.onStart?.();
      },
      stopPlugin() {
        for (const l of self.lifeListeners) l.onStop?.();
      },
      savedCount: () => self.savedCount,
      reloadedCount: () => self.reloadedCount,
      isPluginViewOpen: () => self.pluginViewOpen,
      buttonState: (id) => self.buttonStates.get(id) ?? true,
    };
  }

  // -- PluginManager surface --------------------------------------------

  async init(): Promise<void> {
    this.inited = true;
  }

  addPluginLifeListener(listener: LifeListener): { remove: () => void } {
    this.lifeListeners.add(listener);
    return { remove: () => this.lifeListeners.delete(listener) };
  }

  registerButtonListener(cb: (msg: unknown) => void): { remove: () => void } {
    const id = this.nextListenerId++;
    this.buttonListeners.set(id, cb);
    return { remove: () => this.buttonListeners.delete(id) };
  }

  registerEventListener(
    event: string,
    _registerType: number,
    cb: (payload: unknown) => void,
  ): { remove: () => void } {
    let subs = this.eventListeners.get(event);
    if (!subs) {
      subs = new Map();
      this.eventListeners.set(event, subs);
    }
    const id = this.nextListenerId++;
    subs.set(id, { id, cb });
    return {
      remove: () => {
        subs!.delete(id);
      },
    };
  }

  async registerButton(_type: number, _appTypes: string[], _button: object): Promise<boolean> {
    this.calls.push({ method: 'registerButton', args: [_type, _appTypes, _button] });
    return true;
  }

  async closePluginView(): Promise<boolean> {
    this.pluginViewOpen = false;
    this.calls.push({ method: 'closePluginView', args: [] });
    return true;
  }

  async showPluginView(): Promise<boolean> {
    this.pluginViewOpen = true;
    this.calls.push({ method: 'showPluginView', args: [] });
    return true;
  }

  async setButtonState(id: number, state: boolean): Promise<boolean> {
    this.buttonStates.set(id, state);
    this.calls.push({ method: 'setButtonState', args: [id, state] });
    return true;
  }

  async getDeviceType(): Promise<number> {
    return this.deviceType;
  }

  async getPluginDirPath(): Promise<string | null> {
    return '/stub/plugin-dir';
  }

  // -- PluginCommAPI surface --------------------------------------------

  async getCurrentFilePath(): Promise<APIResponse<string>> {
    if (this.currentFilePath === null) return fail(101, 'no file open');
    return ok(this.currentFilePath);
  }

  async getCurrentPageNum(): Promise<APIResponse<number>> {
    if (this.currentFilePath === null) return fail(101, 'no file open');
    return ok(this.currentPage);
  }

  async createElement(type: number): Promise<APIResponse<StubElement>> {
    this.calls.push({ method: 'createElement', args: [type] });
    const el: StubElement = {
      uuid: newUuid(),
      type,
      pageNum: this.currentPage,
      layerNum: 0,
      thickness: this.pen.thickness,
      numInPage: -1,
      maxX: 0,
      maxY: 0,
      stroke: type === TYPE_STROKE ? makeStroke(this.pen, [], []) : null,
      textBox:
        type === 500
          ? {
              fontSize: 24,
              textContentFull: null,
              textRect: { left: 0, top: 0, right: 800, bottom: 200 },
              textAlign: 0,
              textFrameWidthType: 1,
            }
          : null,
    };
    this.cache.set(el.uuid, el);
    return ok(el);
  }

  async getLastElement(): Promise<APIResponse<StubElement>> {
    const page = this.currentPageData();
    if (page === null || page.elements.length === 0) return fail(102, 'no elements');
    return ok(page.elements[page.elements.length - 1]!);
  }

  async recycleElement(uuid: string): Promise<void> {
    this.cache.delete(uuid);
    this.calls.push({ method: 'recycleElement', args: [uuid] });
  }

  async reloadFile(): Promise<APIResponse<boolean>> {
    this.reloadedCount++;
    this.calls.push({ method: 'reloadFile', args: [] });
    return ok(true);
  }

  // -- PluginFileAPI surface --------------------------------------------

  async getElements(page: number, notePath: string): Promise<APIResponse<StubElement[]>> {
    const note = this.notes.get(notePath);
    if (!note) return fail(103, 'no such note');
    const pageData = note.pages[page];
    if (!pageData) return fail(104, 'no such page');
    return ok(pageData.elements);
  }

  async insertElements(
    notePath: string,
    page: number,
    elements: StubElement[],
  ): Promise<APIResponse<boolean>> {
    this.calls.push({ method: 'insertElements', args: [notePath, page, elements.length] });
    const note = this.notes.get(notePath);
    if (!note) return fail(103, 'no such note');
    const pageData = note.pages[page];
    if (!pageData) return fail(104, 'no such page');
    for (const el of elements) {
      // Resolve from the cache (createElement products) or accept inline.
      const resolved = this.cache.get(el.uuid) ?? el;
      resolved.pageNum = page;
      if (resolved.numInPage < 0) resolved.numInPage = pageData.elements.length;
      pageData.elements.push(resolved);
      this.cache.delete(resolved.uuid);
    }
    // Like the real device, inserting elements triggers a pen-up event.
    this.firePenUp();
    return ok(true);
  }

  async getPageSize(
    notePath: string,
    page: number,
  ): Promise<APIResponse<{ width: number; height: number }>> {
    const note = this.notes.get(notePath);
    if (!note) return fail(103, 'no such note');
    const pageData = note.pages[page];
    if (!pageData) return fail(104, 'no such page');
    return ok({ width: pageData.width, height: pageData.height });
  }

  async getNoteTotalPageNum(notePath: string): Promise<APIResponse<number>> {
    const note = this.notes.get(notePath);
    if (!note) return fail(103, 'no such note');
    return ok(note.pages.length);
  }

  async getNoteSystemTemplates(): Promise<APIResponse<Array<{ name: string }>>> {
    return ok(SYSTEM_TEMPLATES.map((t) => ({ ...t })));
  }

  async createNote(opts: {
    notePath: string;
    template: string;
    isPortrait: boolean;
  }): Promise<APIResponse<boolean>> {
    this.calls.push({ method: 'createNote', args: [opts.notePath, opts.template] });
    const valid = SYSTEM_TEMPLATES.some((t) => t.name === opts.template);
    if (!valid) return fail(802, 'invalid template');
    if (this.notes.has(opts.notePath)) return ok(true); // idempotent
    this.notes.set(opts.notePath, {
      pages: [
        {
          width: opts.isPortrait ? NOMAD_PAGE.width : NOMAD_PAGE.height,
          height: opts.isPortrait ? NOMAD_PAGE.height : NOMAD_PAGE.width,
          emrWidth: this.emr.width,
          emrHeight: this.emr.height,
          elements: [],
        },
      ],
    });
    return ok(true);
  }

  // -- PluginNoteAPI surface --------------------------------------------

  async saveCurrentNote(): Promise<APIResponse<boolean>> {
    this.savedCount++;
    this.calls.push({ method: 'saveCurrentNote', args: [] });
    return ok(true);
  }

  // -- internals ---------------------------------------------------------

  private currentPageData(): PageData | null {
    if (this.currentFilePath === null) return null;
    const note = this.notes.get(this.currentFilePath);
    if (!note) return null;
    return note.pages[this.currentPage] ?? null;
  }

  private commitStroke(
    filePath: string,
    page: number,
    stroke: PenState & { points: Point[] },
  ): StubElement {
    const note = this.notes.get(filePath);
    if (!note) throw new Error(`no note at ${filePath}`);
    const pageData = note.pages[page];
    if (!pageData) throw new Error(`no page ${page} in ${filePath}`);
    const maxX = stroke.points.reduce((m, p) => Math.max(m, p.x), 0);
    const maxY = stroke.points.reduce((m, p) => Math.max(m, p.y), 0);
    const el: StubElement = {
      uuid: newUuid(),
      type: TYPE_STROKE,
      pageNum: page,
      layerNum: 0,
      thickness: stroke.thickness,
      numInPage: pageData.elements.length,
      maxX,
      maxY,
      stroke: makeStroke(
        stroke,
        [...stroke.points],
        stroke.points.map(() => 2048),
      ),
      textBox: null,
    };
    pageData.elements.push(el);
    return el;
  }

  private firePenUp(): void {
    const subs = this.eventListeners.get('event_pen_up');
    if (!subs) return;
    const payload: PenUpEvent = {
      pageNum: this.currentPage,
      filePath: this.currentFilePath ?? '',
    };
    for (const { cb } of subs.values()) cb(payload);
  }
}
