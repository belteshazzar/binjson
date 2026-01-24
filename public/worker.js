// Web Worker for handling OPFS file operations with sync access handles
// This worker handles file operations that require FileSystemSyncAccessHandle

import { encode, decode, getFileHandle, deleteFile, ObjectId } from '../src/binjson.js';
import { BPlusTree } from '../src/bplustree.js';
import { RTree } from '../src/rtree.js';
import { TextIndex } from '../src/textindex.js';

// Helper function to read all data from sync handle
function readAllData(syncHandle) {
  const size = syncHandle.getSize();
  if (size === 0) return new Uint8Array(0);
  
  const buffer = new Uint8Array(size);
  const view = new DataView(buffer.buffer);
  syncHandle.read(view, { at: 0 });
  return buffer;
}

// Handle messages from the main thread
self.addEventListener('message', async (event) => {
  const { id, operation, filename, data } = event.data;
  
  try {
    let result;
    
    switch (operation) {
      case 'write': {
        const dirHandle = await navigator.storage.getDirectory();
        const fileHandle = await getFileHandle(dirHandle, filename, { create: true });
        const syncHandle = await fileHandle.createSyncAccessHandle();
        
        // Truncate and write
        syncHandle.truncate(0);
        const buffer = new Uint8Array(data);
        const view = new DataView(buffer.buffer);
        syncHandle.write(view, { at: 0 });
        
        const finalSize = syncHandle.getSize();
        await syncHandle.close();
        result = { success: true, size: finalSize };
        break;
      }
      
      case 'read': {
        const dirHandle = await navigator.storage.getDirectory();
        const fileHandle = await getFileHandle(dirHandle, filename, { create: false });
        const syncHandle = await fileHandle.createSyncAccessHandle();
        
        const buffer = readAllData(syncHandle);
        const decoded = buffer.length > 0 ? decode(buffer) : null;
        
        await syncHandle.close();
        result = decoded;
        break;
      }
      
      case 'append': {
        const dirHandle = await navigator.storage.getDirectory();
        const fileHandle = await getFileHandle(dirHandle, filename, { create: true });
        const syncHandle = await fileHandle.createSyncAccessHandle();
        
        const currentSize = syncHandle.getSize();
        const buffer = new Uint8Array(data);
        const view = new DataView(buffer.buffer);
        syncHandle.write(view, { at: currentSize });
        
        const finalSize = syncHandle.getSize();
        await syncHandle.close();
        result = { success: true, size: finalSize };
        break;
      }
      
      case 'scan': {
        const dirHandle = await navigator.storage.getDirectory();
        const fileHandle = await getFileHandle(dirHandle, filename, { create: false });
        const syncHandle = await fileHandle.createSyncAccessHandle();
        
        const buffer = readAllData(syncHandle);
        const records = [];
        
        let offset = 0;
        while (offset < buffer.length) {
          try {
            const view = new DataView(buffer.buffer, buffer.byteOffset + offset);
            const decoded = decode(new Uint8Array(buffer.buffer, buffer.byteOffset + offset));
            records.push(decoded);
            
            // Estimate how many bytes were read (simple heuristic)
            // This is a simplified version - a more robust implementation would
            // need to track the actual bytes consumed by decode
            const reencoded = encode(decoded);
            offset += reencoded.length;
          } catch (err) {
            break; // End of valid data
          }
        }
        
        await syncHandle.close();
        result = records;
        break;
      }
      
      case 'delete': {
        const dirHandle = await navigator.storage.getDirectory();
        try {
          await dirHandle.removeEntry(filename);
        } catch (err) {
          if (err.name !== 'NotFoundError') {
            throw err;
          }
        }
        result = { success: true };
        break;
      }
      
      case 'exists': {
        const dirHandle = await navigator.storage.getDirectory();
        let exists = false;
        try {
          // Explicitly use create: false to avoid creating the file
          const handle = await dirHandle.getFileHandle(filename, { create: false });
          exists = true;
        } catch (err) {
          // Any error means file doesn't exist
          exists = false;
        }
        result = exists;
        break;
      }
      
      case 'bplustree-create': {
        const dirHandle = await navigator.storage.getDirectory();
        const fileHandle = await getFileHandle(dirHandle, filename, { create: true });
        const syncHandle = await fileHandle.createSyncAccessHandle();
        
        const order = data?.order || 3;
        const tree = new BPlusTree(syncHandle, order);
        await tree.open();
        await tree.close();
        
        result = { success: true };
        break;
      }
      
      case 'bplustree-add': {
        const dirHandle = await navigator.storage.getDirectory();
        const fileHandle = await getFileHandle(dirHandle, filename, { create: false });
        const syncHandle = await fileHandle.createSyncAccessHandle();
        
        const { key, value } = data;
        const tree = new BPlusTree(syncHandle);
        await tree.open();
        await tree.add(key, value);
        await tree.close();
        
        result = { success: true };
        break;
      }
      
      case 'bplustree-toArray': {
        const dirHandle = await navigator.storage.getDirectory();
        const fileHandle = await getFileHandle(dirHandle, filename, { create: false });
        const syncHandle = await fileHandle.createSyncAccessHandle();
        
        const tree = new BPlusTree(syncHandle);
        await tree.open();
        const array = await tree.toArray();
        await tree.close();
        
        result = array;
        break;
      }
      
      case 'bplustree-compact': {
        const dirHandle = await navigator.storage.getDirectory();
        const fileHandle = await getFileHandle(dirHandle, filename, { create: false });
        const syncHandle = await fileHandle.createSyncAccessHandle();
        
        const { compactFilename } = data;
        
        // Create sync handle for destination file
        const destFileHandle = await getFileHandle(dirHandle, compactFilename, { create: true });
        const destSyncHandle = await destFileHandle.createSyncAccessHandle();
        
        const tree = new BPlusTree(syncHandle);
        await tree.open();
        const stats = await tree.compact(destSyncHandle);
        await tree.close();
        
        result = stats;
        break;
      }
      
      case 'rtree-create': {
        const dirHandle = await navigator.storage.getDirectory();
        const fileHandle = await getFileHandle(dirHandle, filename, { create: true });
        const syncHandle = await fileHandle.createSyncAccessHandle();
        
        const order = data?.order || 4;
        const tree = new RTree(syncHandle, order);
        await tree.open();
        await tree.close();
        
        result = { success: true };
        break;
      }
      
      case 'rtree-insert': {
        const dirHandle = await navigator.storage.getDirectory();
        const fileHandle = await getFileHandle(dirHandle, filename, { create: false });
        const syncHandle = await fileHandle.createSyncAccessHandle();
        
        const { lat, lng, objectId } = data;
        // Convert string to ObjectId if needed
        const oid = typeof objectId === 'string' ? new ObjectId(objectId) : objectId;
        
        const tree = new RTree(syncHandle);
        await tree.open();
        await tree.insert(lat, lng, oid);
        await tree.close();
        
        result = { success: true };
        break;
      }
      
      case 'rtree-searchRadius': {
        const dirHandle = await navigator.storage.getDirectory();
        const fileHandle = await getFileHandle(dirHandle, filename, { create: false });
        const syncHandle = await fileHandle.createSyncAccessHandle();
        
        const { lat, lng, radiusKm } = data;
        const tree = new RTree(syncHandle);
        await tree.open();
        const results = await tree.searchRadius(lat, lng, radiusKm);
        await tree.close();
        
        result = results;
        break;
      }
      
      case 'rtree-searchBBox': {
        const dirHandle = await navigator.storage.getDirectory();
        const fileHandle = await getFileHandle(dirHandle, filename, { create: false });
        const syncHandle = await fileHandle.createSyncAccessHandle();
        
        const { bbox } = data;
        const tree = new RTree(syncHandle);
        await tree.open();
        const results = await tree.searchBBox(bbox);
        await tree.close();
        
        result = results;
        break;
      }
      
      case 'rtree-compact': {
        const dirHandle = await navigator.storage.getDirectory();
        const fileHandle = await getFileHandle(dirHandle, filename, { create: false });
        const syncHandle = await fileHandle.createSyncAccessHandle();
        
        const { compactFilename } = data;
        
        // Create sync handle for destination file
        const destFileHandle = await getFileHandle(dirHandle, compactFilename, { create: true });
        const destSyncHandle = await destFileHandle.createSyncAccessHandle();
        
        const tree = new RTree(syncHandle);
        await tree.open();
        const stats = await tree.compact(destSyncHandle);
        await tree.close();
        
        result = stats;
        break;
      }
      
      case 'textindex-create': {
        const dirHandle = await navigator.storage.getDirectory();
        const { baseName, order } = data;
        
        // Create three BPlusTree files for TextIndex
        const indexFile = await getFileHandle(dirHandle, `${baseName}-terms.bj`, { create: true });
        const indexHandle = await indexFile.createSyncAccessHandle();
        
        const docTermsFile = await getFileHandle(dirHandle, `${baseName}-documents.bj`, { create: true });
        const docTermsHandle = await docTermsFile.createSyncAccessHandle();
        
        const docLengthsFile = await getFileHandle(dirHandle, `${baseName}-lengths.bj`, { create: true });
        const docLengthsHandle = await docLengthsFile.createSyncAccessHandle();
        
        // Create three BPlusTree instances
        const indexTree = new BPlusTree(indexHandle, order || 16);
        const docTermsTree = new BPlusTree(docTermsHandle, order || 16);
        const docLengthsTree = new BPlusTree(docLengthsHandle, order || 16);
        
        await indexTree.open();
        await docTermsTree.open();
        await docLengthsTree.open();
        
        await indexTree.close();
        await docTermsTree.close();
        await docLengthsTree.close();
        
        result = { success: true };
        break;
      }
      
      case 'textindex-add': {
        const dirHandle = await navigator.storage.getDirectory();
        const { baseName, docId, text } = data;
        
        // Open the three BPlusTree files
        const indexFile = await getFileHandle(dirHandle, `${baseName}-terms.bj`, { create: false });
        const indexHandle = await indexFile.createSyncAccessHandle();
        const indexTree = new BPlusTree(indexHandle);
        
        const docTermsFile = await getFileHandle(dirHandle, `${baseName}-documents.bj`, { create: false });
        const docTermsHandle = await docTermsFile.createSyncAccessHandle();
        const docTermsTree = new BPlusTree(docTermsHandle);
        
        const docLengthsFile = await getFileHandle(dirHandle, `${baseName}-lengths.bj`, { create: false });
        const docLengthsHandle = await docLengthsFile.createSyncAccessHandle();
        const docLengthsTree = new BPlusTree(docLengthsHandle);
        
        // Create TextIndex with the trees
        const textIndex = new TextIndex({
          trees: {
            index: indexTree,
            documentTerms: docTermsTree,
            documentLengths: docLengthsTree
          }
        });
        
        await textIndex.open();
        await textIndex.add(docId, text);
        await textIndex.close();
        
        result = { success: true };
        break;
      }
      
      case 'textindex-query': {
        const dirHandle = await navigator.storage.getDirectory();
        const { baseName, queryText, options } = data;
        
        // Open the three BPlusTree files
        const indexFile = await getFileHandle(dirHandle, `${baseName}-terms.bj`, { create: false });
        const indexHandle = await indexFile.createSyncAccessHandle();
        const indexTree = new BPlusTree(indexHandle);
        
        const docTermsFile = await getFileHandle(dirHandle, `${baseName}-documents.bj`, { create: false });
        const docTermsHandle = await docTermsFile.createSyncAccessHandle();
        const docTermsTree = new BPlusTree(docTermsHandle);
        
        const docLengthsFile = await getFileHandle(dirHandle, `${baseName}-lengths.bj`, { create: false });
        const docLengthsHandle = await docLengthsFile.createSyncAccessHandle();
        const docLengthsTree = new BPlusTree(docLengthsHandle);
        
        // Create TextIndex with the trees
        const textIndex = new TextIndex({
          trees: {
            index: indexTree,
            documentTerms: docTermsTree,
            documentLengths: docLengthsTree
          }
        });
        
        await textIndex.open();
        const results = await textIndex.query(queryText, options || {});
        await textIndex.close();
        
        result = results;
        break;
      }
      
      case 'textindex-compact': {
        const dirHandle = await navigator.storage.getDirectory();
        const { baseName, compactBaseName } = data;
        
        // Open source trees
        const indexFile = await getFileHandle(dirHandle, `${baseName}-terms.bj`, { create: false });
        const indexHandle = await indexFile.createSyncAccessHandle();
        const indexTree = new BPlusTree(indexHandle);
        
        const docTermsFile = await getFileHandle(dirHandle, `${baseName}-documents.bj`, { create: false });
        const docTermsHandle = await docTermsFile.createSyncAccessHandle();
        const docTermsTree = new BPlusTree(docTermsHandle);
        
        const docLengthsFile = await getFileHandle(dirHandle, `${baseName}-lengths.bj`, { create: false });
        const docLengthsHandle = await docLengthsFile.createSyncAccessHandle();
        const docLengthsTree = new BPlusTree(docLengthsHandle);
        
        // Create destination BPlusTree instances
        const compactIndexFile = await getFileHandle(dirHandle, `${compactBaseName}-terms.bj`, { create: true });
        const compactIndexHandle = await compactIndexFile.createSyncAccessHandle();
        const compactIndexTree = new BPlusTree(compactIndexHandle);
        
        const compactDocTermsFile = await getFileHandle(dirHandle, `${compactBaseName}-documents.bj`, { create: true });
        const compactDocTermsHandle = await compactDocTermsFile.createSyncAccessHandle();
        const compactDocTermsTree = new BPlusTree(compactDocTermsHandle);
        
        const compactDocLengthsFile = await getFileHandle(dirHandle, `${compactBaseName}-lengths.bj`, { create: true });
        const compactDocLengthsHandle = await compactDocLengthsFile.createSyncAccessHandle();
        const compactDocLengthsTree = new BPlusTree(compactDocLengthsHandle);
        
        await compactIndexTree.open();
        await compactDocTermsTree.open();
        await compactDocLengthsTree.open();
        
        // Create TextIndex with source trees
        const textIndex = new TextIndex({
          trees: {
            index: indexTree,
            documentTerms: docTermsTree,
            documentLengths: docLengthsTree
          }
        });
        
        await textIndex.open();
        const stats = await textIndex.compact({
          index: compactIndexTree,
          documentTerms: compactDocTermsTree,
          documentLengths: compactDocLengthsTree
        });
        
        result = stats;
        break;
      }
      
      default:
        throw new Error(`Unknown operation: ${operation}`);
    }
    
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
});
