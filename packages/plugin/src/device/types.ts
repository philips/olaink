/**
 * The narrow device surface WRTN needs from the Supernote SDK.
 *
 * On-device this is implemented by `snDevice.ts` over sn-plugin-lib; in
 * tests by the StubDevice from @wrtn/sn-stub (structurally compatible).
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

  /** Subscribe to pen-up events. Returns an unsubscribe function. */
  registerPenUp(cb: () => void): () => void;

  getCurrentFilePath(): Promise<string | null>;
  getCurrentPageNum(): Promise<number | null>;

  /** Last committed element on the current page (the just-drawn stroke). */
  getLastElement(): Promise<BridgeElement | null>;

  createElement(type: number): Promise<BridgeElement | null>;

  insertElements(notePath: string, page: number, elements: BridgeElement[]): Promise<boolean>;
  getElements(page: number, notePath: string): Promise<BridgeElement[]>;

  saveCurrentNote(): Promise<boolean>;
  reloadFile(): Promise<boolean>;
  recycleElement(uuid: string): void;

  getNoteTotalPageNum(notePath: string): Promise<number | null>;
  getNoteSystemTemplates(): Promise<NoteTemplate[]>;
  createNote(opts: { notePath: string; template: string; isPortrait: boolean }): Promise<boolean>;
}

export const TYPE_STROKE = 0;
export const TYPE_TEXT = 500;
