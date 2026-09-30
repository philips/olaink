import com.olaink.nativeclient.crypto.NoteV1;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Opens one encrypted delivery with the Supernote plugin's own record code
 * (packages/plugin/android/.../crypto/NoteV1.java), exactly as the plugin
 * does before saving a note to Note/OlaInk/.
 *
 *   java SupernoteOpen.java DEVICE_ID PKCS8_B64URL OUT.note < record.json
 *
 * Prints the accepted payload's metadata as JSON; exits 1 if the plugin
 * would reject the record.
 */
public final class SupernoteOpen {
  public static void main(String[] args) throws Exception {
    final String record = new String(System.in.readAllBytes(), StandardCharsets.UTF_8);
    try {
      final NoteV1.Payload payload = NoteV1.decryptForDevice(
          record, args[0], NoteV1.importPkcs8(NoteV1.fromB64url(args[1], 1024)));
      Files.write(Path.of(args[2]), payload.note);
      System.out.println("{\"filename\":" + NoteV1.jsonString(payload.filename)
          + ",\"mime\":" + NoteV1.jsonString(payload.mime)
          + ",\"senderUsername\":" + NoteV1.jsonString(payload.senderUsername)
          + ",\"bytes\":" + payload.note.length + "}");
    } catch (NoteV1.ProtocolException error) {
      System.err.println("rejected: " + error.getMessage());
      System.exit(1);
    }
  }
}
