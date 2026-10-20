package com.olaink.nativeclient.e2;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.olaink.nativeclient.crypto.NoteV1;

import org.junit.Test;

import java.util.Map;

public class MutedSenderTest {
  @SuppressWarnings("unchecked")
  private static Map<String, Object> journal(String json) throws Exception {
    return (Map<String, Object>) NoteV1.Json.parse(json);
  }

  @Test
  public void matchesTheLowerCasedMuteListCaseInsensitively() throws Exception {
    final Map<String, Object> root = journal("{\"inbox\":[],\"muted\":[\"bob-inbox\",\"mallory\"]}");
    assertTrue(E2Controller.isMutedSender(root, "bob-inbox"));
    assertTrue(E2Controller.isMutedSender(root, "Bob-Inbox"));
    assertFalse(E2Controller.isMutedSender(root, "alice"));
  }

  @Test
  public void anEmptyMissingOrMalformedListMutesNobody() throws Exception {
    assertFalse(E2Controller.isMutedSender(journal("{\"muted\":[]}"), "bob"));
    assertFalse(E2Controller.isMutedSender(journal("{\"inbox\":[]}"), "bob"));
    assertFalse(E2Controller.isMutedSender(journal("{\"muted\":\"bob\"}"), "bob"));
    assertFalse(E2Controller.isMutedSender(journal("{\"muted\":[\"bob\"]}"), null));
  }
}
