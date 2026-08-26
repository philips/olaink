# Ola Ink - Pass Supernote `.note` files to your friends.

Try it out and sign up at https://olaink.com

## Architecture

- **Supernote plugin:** share your current note directly from the plugin menu.
- **Ola Ink Android application:** an Android application that does encrypted note sharing and note viewing in an inbox.
- **Service:** persists opaque encrypted file records and per-device delivery state. It never receives extracted strokes, text, a plaintext filename, or content key.
