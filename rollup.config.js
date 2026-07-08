import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';

export default {
  input: 'public/worker.js',
  output: {
    file: 'site/worker.js',
    format: 'es'
  },
  plugins: [
    nodeResolve({
      browser: false, // We're in a Web Worker, not a browser main thread
      preferBuiltins: false
    }),
    commonjs()
  ]
};
