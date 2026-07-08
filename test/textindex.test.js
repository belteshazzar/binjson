/** Runs the shared TextIndex suite against the pure-JS implementation. */
import { TextIndex } from '../src/textindex.js';
import { BPlusTree } from '../src/bplustree.js';
import { bootstrapOPFS } from './binjson.suite.js';
import { runTextIndexSuite } from './textindex.suite.js';

const { hasOPFS } = await bootstrapOPFS();

runTextIndexSuite('JS', { TextIndex, BPlusTree }, hasOPFS);
