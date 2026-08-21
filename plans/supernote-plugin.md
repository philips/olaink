# Supernote Plugin

A plugin for Supernote tablets to send and receive WRTN messages.

Basic plugin workflow
- User launches the plugin on a note
- User connects to a simple server with a random short unique username that is persisted to a local config file
- User adds another user to their current note session by username
- There is a built-in "echo" user on the server that receives the users strokes and translates them as an end to end test

# Technical Philosophy

- Use unit testing and stubbing to minimize manual on device testing
- Use existing protocols as much as practicable
- Create a tool or tools to utilize adb for install/testing `adb connect 100.103.149.40:5555`

# Relevant Links

https://www.npmjs.com/package/sn-plugin-lib
https://www.npmjs.com/package/@supernote-plugin/template
https://docs.supernote.com/en
https://github.com/apclark31/supernote-plugin-research
https://github.com/guibor/supernote-endpoint-lasso (proof of plugin `fetch`)
https://github.com/facebook/hermes/issues/429 (Hermes lacks WebAssembly)
https://github.com/cawfree/react-native-webassembly (JSI wasm, needs new arch)
