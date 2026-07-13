// Worker-side half of the change-streams (watch()) multi-tab demo
// (public/db.html). Runs the real document database + coordinator inside a
// dedicated Worker -- required by src/db-coordinator.js's own doc comment
// (OPFS + navigator.locks + BroadcastChannel all need to run off the main
// thread), same reasoning public/worker.js already follows for the other
// OPFS-backed demos.
//
// Every tab that opens public/db.html spins up its own instance of this
// worker; connectShared('watch-demo', ...) elects exactly one of them the
// leader (see src/db-coordinator.js), so all tabs share one underlying
// `notes` collection no matter how many are open.
//
// Wire protocol: {id, cmd, argsPayload} in, {id, ok, result, error} out for
// request/response calls; unsolicited {change: <encoded change event>}
// messages (no id) stream out once `watch` has been started.
import { ready, OPFSStorageProvider } from '../src/binjson-wasm.js';
import { encode, decode } from '../src/binjson.js';
import { connectShared } from '../src/db-coordinator.js';

let notes = null;
let watchStream = null;

async function getNotes() {
  if (notes) return notes;
  await ready();
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('binjson-watch-demo', { create: true });
  const db = await connectShared('watch-demo', new OPFSStorageProvider(dir), {});
  notes = await db.collection('notes');
  return notes;
}

async function run(cmd, args) {
  const coll = await getNotes();
  switch (cmd) {
    case 'insertOne':
      return coll.insertOne(args[0]);
    case 'find':
      return coll.find({}).toArray();
    case 'deleteOne':
      return coll.deleteOne({ _id: args[0] });
    case 'watch': {
      if (watchStream) return null; // already watching (e.g. a page reload of the same worker)
      watchStream = coll.watch();
      (async () => {
        for await (const change of watchStream) {
          self.postMessage({ change: encode(change) });
        }
      })();
      return null;
    }
    default:
      throw new Error(`db-worker: unknown cmd "${cmd}"`);
  }
}

self.addEventListener('message', async (event) => {
  const { id, cmd, argsPayload } = event.data;
  const args = argsPayload ? decode(argsPayload) : [];
  try {
    const result = await run(cmd, args);
    self.postMessage({ id, ok: true, result: encode(result === undefined ? null : result) });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message });
  }
});
