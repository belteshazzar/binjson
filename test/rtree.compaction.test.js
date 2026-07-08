/** Runs the shared R-tree compaction suite against the pure-JS tree. */
import { RTree } from '../src/rtree.js';
import { bootstrapOPFS } from './binjson.suite.js';
import { runRTreeCompactionSuite } from './rtree.compaction.suite.js';

const { hasOPFS } = await bootstrapOPFS();

runRTreeCompactionSuite('JS', RTree, hasOPFS);
