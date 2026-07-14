/**
 * client/index.js — public entry point for the cloud service client.
 *
 * `ObjectId`/`Pointer` are re-exported from the same core library the
 * server embeds (src/binjson.js) rather than redefined here, so a value
 * constructed by this client and one produced by the embedded API are
 * interchangeable -- there's exactly one ObjectId implementation in this
 * project, not a client-side lookalike that happens to have the same
 * shape.
 */
export { MongoClient, Db, Collection, FindCursor, ClientChangeStream, MongoServerError } from './mongo-client.js';
export { ObjectId, Pointer } from '../src/binjson.js';
