/** Runs the shared R-tree persistence suite against the WASM tree. */
import { ready, RTree } from '../src/rtree-wasm.js';
import { bootstrapOPFS } from './binjson.suite.js';
import { runRTreePersistenceSuite } from './rtree.persistence.suite.js';

await ready();
const { hasOPFS } = await bootstrapOPFS();

runRTreePersistenceSuite('WASM', RTree, hasOPFS);
