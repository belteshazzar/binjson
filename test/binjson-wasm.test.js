/**
 * Runs the shared binjson conformance suite against the WASM codec.
 *
 * The WASM module loads asynchronously, so we await ready() at module scope
 * before registering the (synchronous) test bodies.
 */
import * as codec from '../src/binjson-wasm.js';
import { bootstrapOPFS, runCodecSuite, runFileSuite } from './binjson.suite.js';

await codec.ready();
const { hasOPFS } = await bootstrapOPFS();

runCodecSuite('WASM', codec);
runFileSuite('WASM', codec, hasOPFS);
