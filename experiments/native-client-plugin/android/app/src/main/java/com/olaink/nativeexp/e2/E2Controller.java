package com.olaink.nativeexp.e2;

import android.content.Context;
import android.util.Log;

import com.olaink.nativeexp.crypto.NoteV1;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * NPK-only portion of the disposable file-exchange protocol.
 *
 * React owns every relay HTTP request and all inbox/send UI. This class holds
 * the wrapped device identity and performs only record cryptography plus the
 * bounded file I/O inseparable from encrypting/decrypting whole .note bytes.
 * It deliberately has no HTTP, TLS, URL, or relay-client dependency.
 */
public final class E2Controller {
  private static final String TAG = "OlaInkNativeExp";
  private static final File NOTE_ROOT = new File("/storage/emulated/0/Note");

  private final E2Profile profile;

  public E2Controller(Context context, String pluginId) {
    this.profile = new E2Profile(context, pluginId);
  }

  /** Reads the fixed React relay origin embedded in the installed archive. */
  public static String[] relayConfig(Context context, String pluginId) throws Exception {
    final File file = new File(
        new File(context.getFilesDir(), "plugins" + File.separator + pluginId), "relay.json");
    final Map<String, Object> data = cast(NoteV1.Json.parse(
        new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8)));
    final String base = str(data.get("base"));
    final String pin = str(data.get("certSha256"));
    if (base == null || !base.matches("^https://[0-9A-Za-z.:-]+$")) {
      throw new IllegalStateException("relay.json has no fixed HTTPS base");
    }
    return new String[] {base, pin};
  }

  public String status() throws Exception {
    final boolean loaded = profile.load();
    return "{\"paired\":" + profile.isPaired()
        + ",\"identityReady\":" + loaded
        + ",\"deviceId\":" + json(profile.deviceId())
        + ",\"username\":" + json(profile.username())
        + ",\"inboxCount\":" + profile.inboxCount()
        + ",\"storedRecords\":" + profile.storedRecordIds().size() + "}";
  }

  /** Creates or restores only the wrapped local device identity. */
  public String ensureIdentity() throws Exception {
    profile.ensureIdentity();
    Log.i(TAG, "F2 identity ready deviceId=" + profile.deviceId());
    return "{\"identityReady\":true,\"deviceId\":" + json(profile.deviceId())
        + ",\"publicKeySpki\":" + json(profile.publicSpki()) + "}";
  }

  /** The foreground capability enters React memory but is never displayed. */
  public String sessionForReact() throws Exception {
    profile.load();
    return "{\"paired\":" + profile.isPaired() + ",\"deviceId\":" + json(profile.deviceId())
        + ",\"userId\":" + json(profile.userId()) + ",\"username\":" + json(profile.username())
        + ",\"sessionToken\":" + json(profile.isPaired() ? profile.sessionToken() : null) + "}";
  }

  /** Persists a pairing result that React claimed over its own HTTPS transport. */
  public String applyReactPairing(String userId, String username, String sessionToken) throws Exception {
    profile.ensureIdentity();
    if (userId == null || userId.isEmpty() || username == null || sessionToken == null || sessionToken.isEmpty()) {
      throw new IllegalArgumentException("incomplete pairing claim");
    }
    profile.applyPairing(userId, username, sessionToken);
    Log.i(TAG, "F2 React pairing applied userId=" + userId + " username=" + username);
    return "{\"paired\":true,\"deviceId\":" + json(profile.deviceId())
        + ",\"username\":" + json(username) + "}";
  }

  /** Encrypts one stable, root-constrained complete note for a React-fetched directory. */
  public String createFileRecord(String sourcePath, String directoryJson) throws Exception {
    requirePaired();
    final File source = approvedNote(sourcePath);
    final byte[] note = readStable(source);
    final Map<String, Object> directory = cast(NoteV1.Json.parse(directoryJson));
    final String toUserId = requireString(directory.get("userId"), "directory userId");
    final Long version = (Long) directory.get("version");
    if (version == null || version < 1) throw new IllegalStateException("invalid directory version");
    final List<NoteV1.Recipient> recipients = recipientsForDirectory(directory);
    final String recordId = NoteV1.randomRecordId();
    final String record = NoteV1.encryptNoteForDevices(
        source.getName(), note, profile.username(), recordId,
        profile.userId(), profile.deviceId(), toUserId, version, recipients);
    Log.i(TAG, "F2 encrypted file recordId=" + recordId + " slots=" + recipients.size()
        + " noteBytes=" + note.length);
    return "{\"record\":" + json(record) + ",\"recordId\":" + json(recordId)
        + ",\"noteSha256\":" + json(NoteV1.b64url(NoteV1.sha256(note)))
        + ",\"noteBytes\":" + note.length + ",\"slots\":" + recipients.size() + "}";
  }

  /** Decrypts one React-polled opaque record to Note/ with no network side effect. */
  public String decryptRecordToNote(String recordJson) throws Exception {
    requirePaired();
    final Object recordValue = NoteV1.Json.parse(recordJson);
    final Map<String, Object> record = cast(recordValue);
    final String id = requireString(record.get("id"), "record id");
    final NoteV1.Payload payload = NoteV1.decryptForDevice(
        NoteV1.Json.write(recordValue), profile.deviceId(), profile.privateKey());
    final File output = writeReceivedNote(payload.filename, payload.note);
    profile.storeRecord(id, NoteV1.Json.write(recordValue));
    Log.i(TAG, "F2 decrypted file pending-react-ack recordId=" + id + " bytes=" + payload.note.length);
    return "{\"saved\":true,\"ackPending\":true,\"recordId\":" + json(id) + ",\"filename\":"
        + json(output.getName()) + ",\"destinationPath\":" + json(output.getPath())
        + ",\"noteBytes\":" + payload.note.length + ",\"sha256\":" + json(payload.sha256) + "}";
  }

  /** Deletes local identity, session capability, and stored ciphertext; React performs relay logout. */
  public String clearLocal() throws Exception {
    profile.clear();
    Log.i(TAG, "F2 local profile cleared");
    return "{\"cleared\":true}";
  }

  private void requirePaired() throws Exception {
    profile.load();
    if (!profile.isPaired()) throw new IllegalStateException("device is not paired");
  }

  private static File approvedNote(String sourcePath) throws Exception {
    if (sourcePath == null || sourcePath.isEmpty()) throw new IllegalArgumentException("missing source");
    final File root = NOTE_ROOT.getCanonicalFile();
    final File source = new File(sourcePath).getCanonicalFile();
    if (!source.isFile() || !source.getName().endsWith(".note")
        || !source.getParentFile().equals(root)) throw new IllegalArgumentException("source outside Note root");
    if (source.length() < 1 || source.length() > NoteV1.MAX_NOTE_BYTES) {
      throw new IllegalArgumentException("source size rejected");
    }
    return source;
  }

  private static byte[] readStable(File source) throws Exception {
    final long length = source.length();
    final byte[] bytes = Files.readAllBytes(source.toPath());
    if (bytes.length != length || source.length() != length || bytes.length > NoteV1.MAX_NOTE_BYTES) {
      throw new IllegalStateException("source changed while reading");
    }
    return bytes;
  }

  private static File writeReceivedNote(String requestedName, byte[] note) throws Exception {
    if (note.length < 1 || note.length > NoteV1.MAX_NOTE_BYTES) throw new IOException("note size rejected");
    final String base = requestedName == null ? "received.note" : requestedName.replaceAll("[^A-Za-z0-9._-]", "_");
    final String safe = base.endsWith(".note") ? base : base + ".note";
    final File root = NOTE_ROOT.getCanonicalFile();
    final File output = new File(root, "OlaInk-Received-" + System.currentTimeMillis() + "-" + safe).getCanonicalFile();
    if (!output.getParentFile().equals(root)) throw new IOException("output escaped Note root");
    final File temporary = new File(root, "." + output.getName() + ".tmp");
    try (FileOutputStream stream = new FileOutputStream(temporary)) {
      stream.write(note);
      stream.getFD().sync();
    } catch (Exception error) {
      temporary.delete();
      throw error;
    }
    if (!temporary.renameTo(output)) {
      temporary.delete();
      throw new IOException("output rename failed");
    }
    return output;
  }

  private static List<NoteV1.Recipient> recipientsForDirectory(Map<String, Object> directory) {
    if (!(directory.get("devices") instanceof List)) throw new IllegalStateException("directory devices missing");
    final List<NoteV1.Recipient> recipients = new ArrayList<>();
    for (Object entry : (List<?>) directory.get("devices")) {
      final Map<String, Object> device = cast(entry);
      recipients.add(new NoteV1.Recipient(
          requireString(device.get("deviceId"), "directory deviceId"),
          requireString(device.get("publicKeySpki"), "directory publicKeySpki")));
    }
    if (recipients.isEmpty()) throw new IllegalStateException("recipient directory is empty");
    return recipients;
  }

  private static String requireString(Object value, String name) {
    if (value instanceof String && !((String) value).isEmpty()) return (String) value;
    throw new IllegalStateException("missing " + name);
  }

  private static String json(String value) {
    return value == null ? "null" : NoteV1.jsonString(value);
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> cast(Object value) {
    if (value instanceof Map) return (Map<String, Object>) value;
    throw new ClassCastException("expected object");
  }

  private static String str(Object value) {
    return value instanceof String ? (String) value : null;
  }
}
