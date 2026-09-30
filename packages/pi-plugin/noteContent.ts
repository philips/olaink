/**
 * Converting between Supernote `.note` files and agent messages: what the
 * agent sees of a received note, and the `.note` a reply is typeset into.
 */
import { readFileSync } from "node:fs";
import { encodePng } from "image-js";
import {
  SupernoteX,
  createTextNote,
  extractTextBoxes,
  flattenToWhite,
  toImage,
  toPdf,
} from "supernote-typescript";

export const MAX_NOTE_BYTES = 16 * 1024 * 1024;
export const MAX_PAGES = 20;
/** Upper bound on a typeset reply, so a runaway answer stays reviewable. */
export const MAX_REPLY_PAGES = 10;

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

/** Typesets an agent reply into a `.note` of editable Supernote text boxes. */
export function buildReplyNote(markdown: string, options: { maxPages?: number } = {}): { note: Uint8Array; pages: number; truncated: boolean } {
  const maxPages = options.maxPages ?? MAX_REPLY_PAGES;
  let text = markdownToPlainText(markdown) || "(Pi sent an empty reply.)";
  let note = createTextNote({ text, fontBytes: replyFont() });
  let parsed = new SupernoteX(note);
  let truncated = false;
  if (parsed.pages.length > maxPages) {
    // Keep the pages that fit, then end on a marker the user can act on.
    const kept = parsed.pages.slice(0, maxPages).flatMap((page) => extractTextBoxes(page.totalPathBuffer).map((box) => box.text));
    const marker = "\n\n[Reply truncated here. The full answer is in Pi.]";
    text = kept.join("\n");
    // Drop trailing lines until the marker fits on the last page.
    do {
      text = text.slice(0, text.lastIndexOf("\n") > 0 ? text.lastIndexOf("\n") : text.length - 1);
      note = createTextNote({ text: text + marker, fontBytes: replyFont() });
      parsed = new SupernoteX(note);
    } while (parsed.pages.length > maxPages && text.length > 0);
    truncated = true;
  }
  return { note, pages: parsed.pages.length, truncated };
}
