/** Runs the shared R-tree soak suite against the pure-JS tree. */
import { RTree } from '../src/rtree.js';
import { bootstrapOPFS } from './binjson.suite.js';
import { runRTreeSoakSuite } from './rtree.soak.suite.js';

const { hasOPFS } = await bootstrapOPFS();

runRTreeSoakSuite('JS', RTree, hasOPFS);
