# Ola Ink - Pass Supernote `.note` files to your friends.

Try it out and sign up at https://olaink.com
Install the Supernote plugin at https://olaink.com/install/

## Architecture

- **Supernote plugin:** a single `olainkplugin.snplg` with Inbox, Send, and
  Settings screens. Open it from the NOTE sidebar to send the currently open
  note or to open encrypted notes that were sent to you.
- **Service:** persists opaque encrypted file records and per-device delivery
  state at app.olaink.com. It never receives extracted strokes, text, a
  plaintext filename, or content key.
