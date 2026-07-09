/**
 * Runs the shared R-tree behavioral suite against the WASM tree.
 *
 * The WASM module loads asynchronously; open() awaits it, but we also await
 * ready() up front so the module is instantiated before the suite registers.
 */
import { ready, RTree } from '../src/binjson-wasm.js';
import { bootstrapOPFS } from './binjson.suite.js';
import { runRTreeSuite } from './rtree.suite.js';

await ready();
const { hasOPFS } = await bootstrapOPFS();

runRTreeSuite('WASM', RTree, hasOPFS);
