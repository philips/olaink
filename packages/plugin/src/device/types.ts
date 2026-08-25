/**
 * The narrow device surface Ola Ink needs from the Supernote SDK.
 *
 * On-device this is implemented by `snDevice.ts` over sn-plugin-lib; in
 * tests by the StubDevice from @olaink/sn-stub (structurally compatible).
 * Keeping the port RN-free lets all core logic run under Vitest/Node.
 */

export interface BridgePoint {
  x: number;
  y: number;
}

export interface BridgeRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface BridgeAccessor<T> {
  size(): Promise<number>;
  getRange(start: number, count: number): Promise<T[]>;
  add(index: number, value: T): Promise<boolean>;
  setRange(start: number, end: number, values: T[]): Promise<boolean>;
}

export interface BridgeStroke {
  penColor: number;
  penType: number;
  thickness?: number;
  points: BridgeAccessor<BridgePoint>;
  pressures: BridgeAccessor<number>;
}

export interface BridgeTextBox {
  fontSize?: number;
  textContentFull: string | null;
  textRect?: BridgeRect;
  textAlign?: number;
  textFrameWidthType?: number;
}

export interface BridgeElement {
  uuid: string;
  type: number;
  pageNum: number;
  layerNum: number;
  thickness: number;
  numInPage: number;
  /** Bounding-box maxima; insertElements drops trails with maxX/maxY = 0. */
  maxX: number;
  maxY: number;
  stroke: BridgeStroke | null;
  textBox: BridgeTextBox | null;
  recycle?(): Promise<void>;
}

export interface NoteTemplate {
  name: string;
  hUri?: string;
  vUri?: string;
}

export interface DeviceBridge {
  getDeviceType(): Promise<number>;

  /** Max EMR digitizer coordinates ({width, height}) for this device.
   * Used to normalize stroke points to 0..1 on the wire. */
  getEmrSize(): Promise<{ width: number; height: number }>;

  getCurrentFilePath(): Promise<string | null>;
  getCurrentPageNum(): Promise<number | null>;

  createElement(type: number): Promise<BridgeElement | null>;

  insertElements(notePath: string, page: number, elements: BridgeElement[]): Promise<boolean>;

  getElements(page: number, notePath: string): Promise<BridgeElement[]>;

  /** Page pixel size (for normalizing/denormalizing text-box rects). */
  getPageSize(notePath: string, page: number): Promise<{ width: number; height: number } | null>;

  /**
   * Insert a blank page (system template) at `page` — pass the note's total
   * page count to append. Required for SwapNote page appends (issue #2);
   * there is no other SDK path to grow a note's page count.
   */
  insertNotePage(notePath: string, page: number, template: string): Promise<boolean>;

  saveCurrentNote(): Promise<boolean>;
  reloadFile(): Promise<boolean>;
  recycleElement(uuid: string): void;

  getNoteTotalPageNum(notePath: string): Promise<number | null>;
  getNoteSystemTemplates(): Promise<NoteTemplate[]>;
  createNote(opts: { notePath: string; template: string; isPortrait: boolean }): Promise<boolean>;
}

export const TYPE_STROKE = 0;
export const TYPE_TEXT = 500;
