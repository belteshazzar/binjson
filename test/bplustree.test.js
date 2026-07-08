/** Runs the shared BPlusTree behavioral suite against the pure-JS tree. */
import { BPlusTree } from '../src/bplustree.js';
import { bootstrapOPFS } from './binjson.suite.js';
import { runBPlusTreeSuite } from './bplustree.suite.js';

const { hasOPFS } = await bootstrapOPFS();

runBPlusTreeSuite('JS', BPlusTree, hasOPFS);
