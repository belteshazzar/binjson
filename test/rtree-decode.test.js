/** Runs the shared rtree-decode CLI suite against files written by the pure-JS tree. */
import { RTree } from '../src/rtree.js';
import { bootstrapOPFS } from './binjson.suite.js';
import { runRTreeDecodeSuite } from './rtree-decode.suite.js';

const { hasOPFS } = await bootstrapOPFS();

runRTreeDecodeSuite('JS', RTree, hasOPFS);
