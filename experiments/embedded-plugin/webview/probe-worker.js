import { moduleValue } from './probe-module.js';

self.postMessage({ type: 'module-worker', moduleValue, hasCrypto: Boolean(self.crypto?.subtle) });
