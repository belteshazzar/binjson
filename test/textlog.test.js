/** Runs the shared TextLog behavioral suite against the pure-JS implementation. */
import { TextLog } from '../src/textlog.js';
import { bootstrapOPFS } from './binjson.suite.js';
import { runTextLogSuite } from './textlog.suite.js';

const { hasOPFS } = await bootstrapOPFS();

runTextLogSuite('JS', TextLog, hasOPFS);
