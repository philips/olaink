package com.olaink.nativeclient.e2;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/** Received notes land as Note/OlaInk/<sender>-<note name>.note. */
public class ReceivedNoteNameTest {
  @Rule public TemporaryFolder temp = new TemporaryFolder();

  private static byte[] bytes(String value) {
    return value.getBytes(StandardCharsets.UTF_8);
  }

  @Test
  public void namesTheFileAfterSenderAndNote() throws Exception {
    final File root = temp.newFolder("Note");
    final File saved = E2Controller.writeReceivedNote(root, "philips", "20260922_224425.note", bytes("v1"));
    assertEquals(new File(root, "OlaInk/philips-20260922_224425.note").getCanonicalFile(), saved);
    assertArrayEquals(bytes("v1"), Files.readAllBytes(saved.toPath()));
  }

  @Test
  public void reusesIdenticalBytesAndNeverOverwritesDifferentOnes() throws Exception {
    final File root = temp.newFolder("Note");
    final File first = E2Controller.writeReceivedNote(root, "philips", "math.note", bytes("v1"));
    // Re-opening the same record from the Inbox: same file, no copy.
    assertEquals(first, E2Controller.writeReceivedNote(root, "philips", "math.note", bytes("v1")));
    // A different note (or the user edited the saved copy) under a taken name.
    final File second = E2Controller.writeReceivedNote(root, "philips", "math.note", bytes("v2"));
    assertEquals("philips-math-2.note", second.getName());
    assertArrayEquals(bytes("v1"), Files.readAllBytes(first.toPath()));
    assertEquals("philips-math-3.note",
        E2Controller.writeReceivedNote(root, "philips", "math.note", bytes("v3")).getName());
    assertEquals(second, E2Controller.writeReceivedNote(root, "philips", "math.note", bytes("v2")));
    assertEquals(3, new File(root, "OlaInk").list((dir, name) -> name.endsWith(".note")).length);
  }

  @Test
  public void sanitizesSenderControlledParts() {
    assertEquals("philips-math", E2Controller.receivedNoteStem("philips", "math.NOTE"));
    assertEquals("_.._evil-_.._x", E2Controller.receivedNoteStem("/../evil", "../../x.note"));
    assertEquals("unknown-note", E2Controller.receivedNoteStem("", ".note"));
    assertEquals("bob-hidden", E2Controller.receivedNoteStem("bob", "...hidden.note"));
    assertEquals("bob-My_Note__1_", E2Controller.receivedNoteStem("bob", "My Note (1).note"));
    assertEquals(32 + 1 + 120, E2Controller.receivedNoteStem("s".repeat(99), "n".repeat(999)).length());
  }
}
