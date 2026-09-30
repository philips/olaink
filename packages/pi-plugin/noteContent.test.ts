import { describe, expect, test } from "vitest";
import { SupernoteX, extractTextBoxes } from "supernote-typescript";
import { buildReplyNote, markdownToPlainText, readNote, replyFilename } from "./noteContent.ts";

describe("markdownToPlainText", () => {
  test("flattens the Markdown a model typically writes", () => {
    expect(markdownToPlainText([
      "## Answer",
      "",
      "**17 × 23 = 391.** It's *easy* with `mental math`:",
      "- 17 × 20 = 340",
      "* 17 × 3 = 51",
      "- [ ] check",
      "1. keep numbers",
      "> quoted",
      "See [the docs](https://example.com) or <https://x.y>.",
      "---",
      "```js",
      "const x = 1;",
      "```",
      "",
      "",
      "",
      "snake_case_stays and 2*3*4 too",
    ].join("\n"))).toBe([
      "Answer",
      "",
      "17 × 23 = 391. It's easy with mental math:",
      "• 17 × 20 = 340",
      "• 17 × 3 = 51",
      "☐ check",
      "1. keep numbers",
      "│ quoted",
      "See the docs (https://example.com) or <https://x.y>.",
      "―――――",
      "    const x = 1;",
      "",
      "snake_case_stays and 2*3*4 too",
    ].join("\n"));
  });
});

describe("replyFilename", () => {
  test("prefixes once and stays a safe .note name", () => {
    expect(replyFilename("20260930_101500.note")).toBe("Re-20260930_101500.note");
    expect(replyFilename("Re-Re-question.note")).toBe("Re-question.note");
    expect(replyFilename("../../etc/passwd")).toBe("Re-.._.._etc_passwd.note");
    expect(replyFilename(".note")).toBe("Re-note.note");
  });
});

describe("buildReplyNote", () => {
  test("typesets an editable text box holding the reply", async () => {
    const built = buildReplyNote("# Result\n\n**391**, because 17 × 23 = 391.");
    expect(built).toMatchObject({ pages: 1, truncated: false });
    const note = new SupernoteX(built.note);
    expect(extractTextBoxes(note.pages[0]!.totalPathBuffer).map((b) => b.text)).toEqual(["Result\n\n391, because 17 × 23 = 391."]);
    // What the agent would see if this note came back.
    const read = await readNote(built.note, { scale: 2 });
    expect(read.pageText).toEqual(["Result\n\n391, because 17 × 23 = 391."]);
    expect(read.images).toHaveLength(1);
  });

  test("caps runaway replies and says so", () => {
    const long = Array.from({ length: 200 }, (_, i) => `Line ${i + 1}`).join("\n");
    const built = buildReplyNote(long, { maxPages: 2 });
    expect(built).toMatchObject({ pages: 2, truncated: true });
    const note = new SupernoteX(built.note);
    const last = extractTextBoxes(note.pages[1]!.totalPathBuffer)[0]!.text;
    expect(last.endsWith("[Reply truncated here. The full answer is in Pi.]")).toBe(true);
  });
});
