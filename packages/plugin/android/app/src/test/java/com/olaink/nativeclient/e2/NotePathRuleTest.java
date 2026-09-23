package com.olaink.nativeclient.e2;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/** The FILE:READ capability rule for notes React asks the NPK to send. */
public class NotePathRuleTest {
  @Rule public TemporaryFolder temp = new TemporaryFolder();

  private File note(File directory, String name) throws Exception {
    directory.mkdirs();
    final File file = new File(directory, name);
    Files.write(file.toPath(), "note bytes".getBytes(StandardCharsets.UTF_8));
    return file;
  }

  private String rejection(File root, String path) {
    return assertThrows(IllegalArgumentException.class, () -> E2Controller.approvedNote(root, path)).getMessage();
  }

  @Test
  public void acceptsNotesAtTheRootAndInFolders() throws Exception {
    final File root = temp.newFolder("Note");
    final File top = note(root, "Top.note");
    final File nested = note(new File(root, "Projects/2026"), "Nested.note");
    final File received = note(new File(root, "OlaInk"), "Received-1-x.note");
    assertEquals(top.getCanonicalFile(), E2Controller.approvedNote(root, top.getPath()));
    assertEquals(nested.getCanonicalFile(), E2Controller.approvedNote(root, nested.getPath()));
    assertEquals(received.getCanonicalFile(), E2Controller.approvedNote(root, received.getPath()));
  }

  @Test
  public void rejectsPathsThatResolveOutsideTheRoot() throws Exception {
    final File root = temp.newFolder("Note");
    final File outside = note(temp.newFolder("Private"), "secret.note");
    // A sibling that merely shares the root's name as a prefix.
    final File sibling = note(temp.newFolder("Note-evil"), "x.note");
    assertEquals("source outside Note root", rejection(root, outside.getPath()));
    assertEquals("source outside Note root", rejection(root, sibling.getPath()));
    assertEquals("source outside Note root",
        rejection(root, new File(root, "../Private/secret.note").getPath()));
    final File link = new File(root, "link.note");
    Files.createSymbolicLink(link.toPath(), outside.toPath());
    assertEquals("source outside Note root", rejection(root, link.getPath()));
    assertEquals("source outside Note root", rejection(root, root.getPath()));
  }

  @Test
  public void rejectsNonNotesEmptyFilesAndMissingPaths() throws Exception {
    final File root = temp.newFolder("Note");
    final File text = new File(root, "plain.txt");
    Files.write(text.toPath(), "x".getBytes(StandardCharsets.UTF_8));
    final File empty = new File(root, "Empty.note");
    Files.write(empty.toPath(), new byte[0]);
    new File(root, "Folder.note").mkdirs();
    assertEquals("source is not a .note file", rejection(root, text.getPath()));
    assertEquals("source is not a .note file", rejection(root, new File(root, "Folder.note").getPath()));
    assertEquals("source is not a .note file", rejection(root, new File(root, "missing.note").getPath()));
    assertEquals("source size rejected", rejection(root, empty.getPath()));
    assertEquals("missing source", rejection(root, ""));
  }

  @Test
  public void failureReasonKeepsTheMessageOnOneBoundedLine() {
    assertEquals("IllegalArgumentException: source outside Note root",
        E2Controller.failureReason(new IllegalArgumentException("source outside Note root")));
    assertEquals("IllegalStateException", E2Controller.failureReason(new IllegalStateException()));
    assertEquals("IllegalStateException: a b", E2Controller.failureReason(new IllegalStateException("a\n  b")));
    final String reason = E2Controller.failureReason(new IllegalStateException("x".repeat(500)));
    assertEquals("IllegalStateException: ".length() + 161, reason.length());
  }
}
