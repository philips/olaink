/**
 * Converting between Supernote `.note` files and agent messages: what the
 * agent sees of a received note, and the `.note` a reply is typeset into.
 */
import { readFileSync } from "node:fs";
import { encodePng } from "image-js";
import {
  SupernoteX,
  extractTextBoxes,
  flattenToWhite,
  layoutTextPages,
  toImage,
  toPdf,
  writeNote,
  type WritablePage,
} from "supernote-typescript";

export const MAX_NOTE_BYTES = 16 * 1024 * 1024;
export const MAX_PAGES = 20;
/** Upper bound on a typeset reply, so a runaway answer stays reviewable. */
export const MAX_REPLY_PAGES = 10;
/**
 * Largest single reply note: under the Supernote plugin's 5 MiB note limit,
 * and about 7 MiB once encrypted and encoded, under the relay's 8 MiB record
 * limit. A 10-page reply is about 3 MiB, so splitting is a safety net.
 * Multi-page replies need the Supernote plugin's larger inbox-sync limit
 * (philips/olaink#47).
 */
export const MAX_REPLY_NOTE_BYTES = 4 * 1024 * 1024;

export type MessageContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export type ReadNote = {
  pageCount: number;
  /** Exact text from text boxes, then recognized handwriting, per page. */
  pageText: string[];
  /** One PNG (flattened onto white) per page. */
  images: MessageContent[];
};

export function parseNote(bytes: Uint8Array): SupernoteX {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_NOTE_BYTES) throw new Error("Received note exceeds the supported size limit");
  const note = new SupernoteX(bytes);
  if (note.pages.length > MAX_PAGES) throw new Error(`Note has ${note.pages.length} pages; limit is ${MAX_PAGES} to keep model input bounded`);
  return note;
}

/**
 * Reads a note for the agent: page images plus any machine-readable text.
 * `scale` downsamples the page images (2 turns a 1920x2560 page into
 * 960x1280, plenty for handwriting and far cheaper as model input).
 */
export async function readNote(bytes: Uint8Array, options: { scale?: number } = {}): Promise<ReadNote> {
  const note = parseNote(bytes);
  const pageText = note.pages.map((page) => {
    const boxes = extractTextBoxes(page.totalPathBuffer).map((box) => box.text.trim()).filter(Boolean);
    const handwriting = (page.paragraphs || page.text || "").trim();
    return [...boxes, ...(handwriting ? [`(handwriting, recognized) ${handwriting}`] : [])].join("\n");
  });
  const images = (await toImage(note, undefined, { scale: options.scale ?? 1 })).map((image) => ({
    type: "image" as const,
    data: Buffer.from(encodePng(flattenToWhite(image))).toString("base64"),
    mimeType: "image/png",
  }));
  return { pageCount: note.pages.length, pageText, images };
}

export async function noteToPdf(bytes: Uint8Array): Promise<Uint8Array> {
  return toPdf(parseNote(bytes));
}

/**
 * Flattens Markdown to the plain text a Supernote text box can hold:
 * headings, emphasis, and code fences lose their markers; bullets become
 * "•"; links keep their URL in parentheses.
 */
export function markdownToPlainText(markdown: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(`    ${raw}`);
      continue;
    }
    let line = raw
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/^(\s*)[-*+]\s+\[( |x|X)\]\s+/, (_m, indent: string, mark: string) => `${indent}${mark === " " ? "☐" : "☑"} `)
      .replace(/^(\s*)[-*+]\s+/, "$1• ")
      .replace(/^\s{0,3}>\s?/, "│ ")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => (text === url ? url : `${text} (${url})`))
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/(?<![\w*])([*_])(?!\s)(.+?)(?<!\s)\1(?![\w*])/g, "$2")
      .replace(/`([^`]+)`/g, "$1");
    if (/^\s*([-*_]\s*){3,}$/.test(line)) line = "―――――";
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

let bundledFont: Uint8Array | undefined;

/** Droid Sans (Apache-2.0): the metrics of the device's own text-box font. */
function replyFont(): Uint8Array {
  bundledFont ??= new Uint8Array(readFileSync(new URL("./assets/DroidSans.ttf", import.meta.url)));
  return bundledFont;
}

/** `Re-<stem>.note`, without piling up `Re-Re-` prefixes. */
export function replyFilename(original: string): string {
  const stem = original.replace(/\.note$/i, "").replace(/^(Re-)+/i, "").replace(/[^\p{L}\p{N}._ -]+/gu, "_").slice(0, 200) || "note";
  return `Re-${stem}.note`;
}

/** One note of a (possibly split) typeset reply. */
export type ReplyPart = { note: Uint8Array; pages: number };

/** Lays text out into reply pages, ending on a marker if it had to be cut short. */
function replyPages(text: string, maxPages: number): { pages: WritablePage[]; truncated: boolean } {
  const pages = layoutTextPages(text, { fontBytes: replyFont() });
  if (pages.length <= maxPages) return { pages, truncated: false };
  const marker = "\n\n[Reply truncated here. The full answer is in Pi.]";
  let kept = pages.slice(0, maxPages).map((page) => page.textBoxes?.map((box) => box.text ?? "").join("\n") ?? "").join("\n");
  // Drop trailing lines until the marker fits on the last page.
  for (;;) {
    const cut = kept.lastIndexOf("\n");
    kept = cut > 0 ? kept.slice(0, cut) : kept.slice(0, -1);
    const shorter = layoutTextPages(kept + marker, { fontBytes: replyFont() });
    if (shorter.length <= maxPages || kept.length === 0) return { pages: shorter, truncated: true };
  }
}

/**
 * Typesets an agent reply into editable Supernote text boxes, one per page,
 * as one note or, when it would exceed `maxNoteBytes`, several consecutive
 * notes. Pages are never split across notes.
 */
export function buildReplyNotes(
  markdown: string, options: { maxPages?: number; maxNoteBytes?: number } = {},
): { parts: ReplyPart[]; pages: number; truncated: boolean } {
  const maxNoteBytes = options.maxNoteBytes ?? MAX_REPLY_NOTE_BYTES;
  const text = markdownToPlainText(markdown) || "(Pi sent an empty reply.)";
  const { pages, truncated } = replyPages(text, options.maxPages ?? MAX_REPLY_PAGES);
  // A page's one-page note size, summed, is an upper bound on any group's
  // note size (the header and background bitmap are shared), so each page
  // is encoded once to measure it and each group once more to write it.
  const parts: ReplyPart[] = [];
  let group: WritablePage[] = [];
  let groupBytes = 0;
  const flush = () => {
    if (group.length > 0) parts.push({ note: writeNote({ pages: group }), pages: group.length });
    group = [];
    groupBytes = 0;
  };
  for (const page of pages) {
    const bytes = writeNote({ pages: [page] }).byteLength;
    if (group.length > 0 && groupBytes + bytes > maxNoteBytes) flush();
    group.push(page);
    groupBytes += bytes;
  }
  flush();
  return { parts, pages: pages.length, truncated };
}

/** A single-note reply, for callers that never split. */
export function buildReplyNote(markdown: string, options: { maxPages?: number } = {}): { note: Uint8Array; pages: number; truncated: boolean } {
  const built = buildReplyNotes(markdown, { ...options, maxNoteBytes: Number.POSITIVE_INFINITY });
  return { note: built.parts[0]!.note, pages: built.pages, truncated: built.truncated };
}

/** `Re-<stem>.note`, or `Re-<stem> (2 of 3).note` for one part of a split reply. */
export function replyPartFilename(original: string, part: number, parts: number): string {
  const name = replyFilename(original);
  return parts === 1 ? name : name.replace(/\.note$/, ` (${part} of ${parts}).note`);
}
