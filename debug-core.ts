import { WrtnServer } from '@wrtn/server';
import { StubDevice } from '@wrtn/sn-stub';
import { HttpPollTransport } from '@wrtn/protocol';
import { createStubBridge } from './packages/plugin/src/device/stubBridge.ts';
import { WrtnCore } from './packages/plugin/src/core/wrtnCore.ts';

const server = new WrtnServer();
await server.listen({ port: 0, host: '127.0.0.1' });
const baseUrl = `http://127.0.0.1:${server.address()!.port}`;

const stub = new StubDevice();
stub.t.openNote('/Note/Session.note');
const bridge = createStubBridge(stub);
const transport = new HttpPollTransport({
  baseUrl,
  username: '',
  deviceType: 4,
  client: 'debug',
  waitMs: 30,
  initialBackoffMs: 1,
  requestTimeoutMs: 2000,
});
const core = new WrtnCore({ bridge, transport, defaultServerUrl: baseUrl });
await core.start();
await new Promise((r) => setTimeout(r, 100));

console.log('phase:', core.state.phase, 'user:', core.state.username);
core.addUser('echo');
await new Promise((r) => setTimeout(r, 150));
console.log('members:', core.state.members, 'sent:', core.state.sent);

stub.t.drawStroke([{ x: 1000, y: 2000 }, { x: 1200, y: 2200 }]);
await new Promise((r) => setTimeout(r, 400));
console.log('after draw — sent:', core.state.sent, 'received:', core.state.received);
console.log('log:', core.state.log);

const els = await stub.getElements(0, '/Note/Session.note');
console.log('elements:', els.success ? els.result?.length : els.error);

core.stop();
await server.close();
process.exit(0);
