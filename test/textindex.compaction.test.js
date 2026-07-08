/** Runs the shared TextIndex compaction suite against the pure-JS implementation. */
import { TextIndex } from '../src/textindex.js';
import { BPlusTree } from '../src/bplustree.js';
import { bootstrapOPFS } from './binjson.suite.js';
import { runTextIndexCompactionSuite } from './textindex.compaction.suite.js';

const { hasOPFS } = await bootstrapOPFS();

runTextIndexCompactionSuite('JS', { TextIndex, BPlusTree }, hasOPFS);
