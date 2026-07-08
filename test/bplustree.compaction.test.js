/** Runs the shared BPlusTree compaction suite against the pure-JS tree. */
import { BPlusTree } from '../src/bplustree.js';
import { bootstrapOPFS } from './binjson.suite.js';
import { runBPlusTreeCompactionSuite } from './bplustree.compaction.suite.js';

const { hasOPFS } = await bootstrapOPFS();

runBPlusTreeCompactionSuite('JS', BPlusTree, hasOPFS);
