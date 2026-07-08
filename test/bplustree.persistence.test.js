/** Runs the shared BPlusTree persistence suite against the pure-JS tree. */
import { BPlusTree } from '../src/bplustree.js';
import { bootstrapOPFS } from './binjson.suite.js';
import { runBPlusTreePersistenceSuite } from './bplustree.persistence.suite.js';

const { hasOPFS } = await bootstrapOPFS();

runBPlusTreePersistenceSuite('JS', BPlusTree, hasOPFS);
