package com.olaink.nativeclient.crypto;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import com.olaink.nativeclient.crypto.NoteV1.ProtocolException;

import org.junit.Test;

/**
 * The record-v2 payload frame's only hand-rolled surface: one tag byte, one
 * u32 length. Forged frames — a lying length, truncation, a bad tag byte —
 * must fail before any field is trusted.
 */
public final class NoteV2FrameTest {
  private static byte[] frame(int declaredLength, byte[] header, int noteLength) {
    final byte[] out = new byte[5 + header.length + noteLength];
    out[0] = 0x02;
    out[1] = (byte) (declaredLength & 0xff);
    out[2] = (byte) ((declaredLength >>> 8) & 0xff);
    out[3] = (byte) ((declaredLength >>> 16) & 0xff);
    out[4] = (byte) ((declaredLength >>> 24) & 0xff);
    System.arraycopy(header, 0, out, 5, header.length);
    return out;
  }

  @Test
  public void rejectsALyingHeaderLength() {
    final byte[] plain = frame(0x7fffffff, "{\"version\":2}".getBytes(), 4);
    final ProtocolException error = assertThrows(NoteV1.ProtocolException.class,
        () -> NoteV1.parsePayload(plain));
    assertEquals("invalid encrypted note payload", error.getMessage());
  }

  @Test
  public void rejectsTruncatedFramesAndBadTagBytes() {
    assertEquals("invalid encrypted note payload", assertThrows(NoteV1.ProtocolException.class,
        () -> NoteV1.parsePayload(new byte[] {0x02, 0x7f})).getMessage());
    assertEquals("invalid encrypted note payload", assertThrows(NoteV1.ProtocolException.class,
        () -> NoteV1.parsePayload(new byte[] {0x7b, 0x01})).getMessage());
  }

  @Test
  public void rejectsAHeaderThatIsNotValidJson() {
    final byte[] header = "not json".getBytes();
    final ProtocolException error = assertThrows(NoteV1.ProtocolException.class,
        () -> NoteV1.parsePayload(frame(header.length, header, 4)));
    assertEquals("invalid encrypted note payload", error.getMessage());
  }
}
