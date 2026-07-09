/** Runs the shared BPlusTree persistence suite against the WASM tree. */
import { ready, BPlusTree } from '../src/binjson-wasm.js';
import { bootstrapOPFS } from './binjson.suite.js';
import { runBPlusTreePersistenceSuite } from './bplustree.persistence.suite.js';

await ready();
const { hasOPFS } = await bootstrapOPFS();

runBPlusTreePersistenceSuite('WASM', BPlusTree, hasOPFS);
