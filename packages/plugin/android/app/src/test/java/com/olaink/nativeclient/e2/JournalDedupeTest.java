package com.olaink.nativeclient.e2;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.olaink.nativeclient.crypto.NoteV1;

import org.junit.Test;

import java.util.Map;

public class JournalDedupeTest {
  @Test
  @SuppressWarnings("unchecked")
  public void keepsTheFirstEntryPerRecordSoReopeningDoesNotReorder() throws Exception {
    final Map<String, Object> root = (Map<String, Object>) NoteV1.Json.parse(
        "{\"inbox\":[{\"id\":\"a\",\"at\":1},{\"id\":\"b\",\"at\":2},{\"id\":\"a\",\"at\":3}]}");
    assertTrue(E2Controller.dedupeJournalEntries(root, "inbox"));
    assertEquals("{\"inbox\":[{\"id\":\"a\",\"at\":1},{\"id\":\"b\",\"at\":2}]}", NoteV1.Json.write(root));
    assertFalse(E2Controller.dedupeJournalEntries(root, "inbox"));
  }
}
