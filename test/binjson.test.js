/**
 * Test suite for the binjson encoder/decoder (pure-JS codec).
 *
 * The assertions live in test/binjson.suite.js so the identical suite can also
 * run against the WASM codec (see test/binjson-wasm.test.js).
 */
import * as codec from '../src/binjson.js';
import { bootstrapOPFS, runCodecSuite, runFileSuite } from './binjson.suite.js';

const { hasOPFS } = await bootstrapOPFS();

runCodecSuite('JS', codec);
runFileSuite('JS', codec, hasOPFS);
