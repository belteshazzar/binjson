/** Runs the shared R-tree node-size suite against the pure-JS tree. */
import { RTree } from '../src/rtree.js';
import { bootstrapOPFS } from './binjson.suite.js';
import { runRTreeNodeSizesSuite } from './rtree.node-sizes.suite.js';

const { hasOPFS } = await bootstrapOPFS();

runRTreeNodeSizesSuite('JS', RTree, hasOPFS);
