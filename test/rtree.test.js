/** Runs the shared R-tree behavioral suite against the pure-JS tree. */
import { RTree } from '../src/rtree.js';
import { bootstrapOPFS } from './binjson.suite.js';
import { runRTreeSuite } from './rtree.suite.js';

const { hasOPFS } = await bootstrapOPFS();

runRTreeSuite('JS', RTree, hasOPFS);
