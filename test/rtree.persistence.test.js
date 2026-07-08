/** Runs the shared R-tree persistence suite against the pure-JS tree. */
import { RTree } from '../src/rtree.js';
import { bootstrapOPFS } from './binjson.suite.js';
import { runRTreePersistenceSuite } from './rtree.persistence.suite.js';

const { hasOPFS } = await bootstrapOPFS();

runRTreePersistenceSuite('JS', RTree, hasOPFS);
