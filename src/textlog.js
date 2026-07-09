/**
 * TextLog - Persistent text versioning system using BinJsonFile
 * 
 * This implementation stores versions of a text document in an append-only file:
 * - Entries are either full snapshots or diffs from the previous version
 * - Metadata tracks the current version, latest snapshot, latest entry, and diff count
 * - The file format is append-only for immutability and efficiency
 * 
 * File format:
 * - Entry records: {type, version, hash, data, timestamp}
 *   - type: FULL_SNAPSHOT (0x01) or DIFF (0x02)
 *   - version: version number (integer)
 *   - hash: SHA-256 hash of the full text
 *   - data: full text (for snapshot) or diff string (for diff)
 *   - timestamp: Date object
 * - Final record: Metadata {version, snapshotPointer, latestPointer, diffCount, diffsPerSnapshot}
 */

import { BinJsonFile, Pointer } from './binjson.js';
import { createPatch, applyPatch, structuredPatch } from 'diff';
import { createHash } from 'crypto';

// Entry type constants
const ENTRY_TYPE = {
  FULL_SNAPSHOT: 0x01,
  DIFF: 0x02
};

/**
 * TextLog class for versioned text storage
 */
export class TextLog {
  /**
   * Creates a new TextLog instance
   * @param {FileSystemSyncAccessHandle} syncHandle - Sync access handle to storage file
   * @param {number} diffsPerSnapshot - Number of diffs between full snapshots (default: 10)
   */
  constructor(syncHandle, diffsPerSnapshot = 10) {
    if (diffsPerSnapshot < 1) {
      throw new Error('diffsPerSnapshot must be at least 1');
    }
    
    this.file = new BinJsonFile(syncHandle);
    this.diffsPerSnapshot = diffsPerSnapshot;
    
    this.isOpen = false;
    
    // Metadata
    this.version = 0; // Current version number
    this.snapshotPointer = null; // Pointer to the latest full snapshot
    this.latestPointer = null; // Pointer to the latest entry (snapshot or diff)
    this.diffCount = 0; // Number of diffs since last snapshot
  }
  
  /**
   * Open the TextLog (load or initialize metadata)
   */
  async open() {
    if (this.isOpen) {
      throw new Error('TextLog is already open');
    }

    const fileSize = this.file.getFileSize();
    const exists = fileSize > 0;

    if (exists) {
      // Load existing log
      await this._loadMetadata();
    } else {
      // Create new log
      await this._initializeNewLog();
    }
    
    this.isOpen = true;
  }
  
  /**
   * Close the TextLog
   */
  async close() {
    if (this.isOpen) {
      await this._writeMetadata();
      if (this.file && this.file.syncAccessHandle) {
        this.file.flush();
        await this.file.syncAccessHandle.close();
      }
      this.isOpen = false;
    }
  }
  
  /**
   * Initialize a new empty log
   */
  async _initializeNewLog() {
    this.version = 0;
    this.snapshotPointer = null;
    this.latestPointer = null;
    this.diffCount = 0;
    
    // Write initial metadata
    await this._writeMetadata();
  }
  
  /**
   * Write metadata record to file
   */
  async _writeMetadata() {
    const metadata = {
      version: this.version,
      snapshotPointer: this.snapshotPointer,
      latestPointer: this.latestPointer,
      diffCount: this.diffCount,
      diffsPerSnapshot: this.diffsPerSnapshot
    };
    
    // Append metadata to file
    await this.file.append(metadata);
  }
  
  /**
   * Load metadata from existing file
   */
  async _loadMetadata() {
    // Read through the file to find the last metadata entry
    // Metadata entries are distinguished by having the exact fields we expect
    let lastMetadata = null;
    
    for (const { value: entry } of this.file.scan()) {
      // Check if this entry looks like metadata
      if (entry && 
          typeof entry.version !== 'undefined' &&
          typeof entry.diffCount !== 'undefined' &&
          typeof entry.diffsPerSnapshot !== 'undefined' &&
          (entry.snapshotPointer instanceof Pointer || entry.snapshotPointer === null) &&
          (entry.latestPointer instanceof Pointer || entry.latestPointer === null)) {
        // This looks like metadata
        lastMetadata = entry;
      }
    }
    
    if (!lastMetadata) {
      throw new Error('Failed to read metadata: no valid metadata found');
    }
    
    this.version = lastMetadata.version;
    this.snapshotPointer = lastMetadata.snapshotPointer;
    this.latestPointer = lastMetadata.latestPointer;
    this.diffCount = lastMetadata.diffCount;
    this.diffsPerSnapshot = lastMetadata.diffsPerSnapshot;
  }
  
  /**
   * Create a SHA-256 hash of text content
   * @param {string} text - Text to hash
   * @returns {string} Hex string hash
   */
  _hashText(text) {
    return createHash('sha256').update(text, 'utf8').digest('hex');
  }
  
  /**
   * Add a new version of the text
   * @param {string} text - The full text content for this version
   * @returns {number} The version number of the added entry
   */
  async addVersion(text) {
    if (!this.isOpen) {
      throw new Error('TextLog is not open');
    }
    
    if (typeof text !== 'string') {
      throw new Error('Text must be a string');
    }
    
    // Increment version number
    this.version++;
    const newVersion = this.version;
    
    // Calculate hash of the full text
    const hash = this._hashText(text);
    
    // Determine if we should write a snapshot or a diff
    const shouldSnapshot = this.diffCount >= this.diffsPerSnapshot || this.latestPointer === null;
    
    let entry;
    
    if (shouldSnapshot) {
      // Write full snapshot
      entry = {
        type: ENTRY_TYPE.FULL_SNAPSHOT,
        version: newVersion,
        hash: hash,
        data: text,
        timestamp: new Date()
      };
      
      // Reset diff counter
      this.diffCount = 0;
    } else {
      // Write diff from previous version
      const previousText = await this._getTextAtPointer(this.latestPointer);
      const diff = createPatch('document', previousText, text);
      
      entry = {
        type: ENTRY_TYPE.DIFF,
        version: newVersion,
        hash: hash,
        data: diff,
        timestamp: new Date()
      };
      
      // Increment diff counter
      this.diffCount++;
    }
    
    // Get current file size (this is where the entry will be stored)
    const offset = await this.file.getFileSize();
    
    // Append entry to file
    await this.file.append(entry);
    
    // Update pointers
    const entryPointer = new Pointer(offset);
    this.latestPointer = entryPointer;
    
    if (shouldSnapshot) {
      this.snapshotPointer = entryPointer;
    }
    
    // Write updated metadata
    await this._writeMetadata();
    
    return newVersion;
  }
  
  /**
   * Get the full text at a specific version
   * @param {number} version - Version number to retrieve
   * @returns {string} The text at that version
   */
  async getVersion(version) {
    if (!this.isOpen) {
      throw new Error('TextLog is not open');
    }
    
    if (version < 1 || version > this.version) {
      throw new Error(`Invalid version: ${version}. Valid range: 1-${this.version}`);
    }
    
    // Scan through file to collect all entries up to and including the requested version
    let targetEntry = null;
    let snapshotEntry = null;
    const entries = [];
    
    for (const { value: entry } of this.file.scan()) {
      // Skip metadata entries (they don't have a 'type' field with our values)
      if (!entry.type || (entry.type !== ENTRY_TYPE.FULL_SNAPSHOT && entry.type !== ENTRY_TYPE.DIFF)) {
        continue;
      }
      
      if (entry.version <= version) {
        entries.push(entry);
        
        if (entry.type === ENTRY_TYPE.FULL_SNAPSHOT) {
          snapshotEntry = entry;
        }
        
        if (entry.version === version) {
          targetEntry = entry;
        }
      }
      
      // Stop scanning once we've passed the target version
      if (entry.version > version) {
        break;
      }
    }
    
    if (!targetEntry) {
      throw new Error(`Version ${version} not found`);
    }
    
    // If the target is a snapshot, return it directly
    if (targetEntry.type === ENTRY_TYPE.FULL_SNAPSHOT) {
      return targetEntry.data;
    }
    
    // If it's a diff, we need to reconstruct from the latest snapshot
    if (!snapshotEntry) {
      throw new Error(`Cannot reconstruct version ${version}: no snapshot found`);
    }
    
    // Start with the snapshot
    let text = snapshotEntry.data;
    
    // Apply all diffs from snapshot to target version
    const diffsToApply = entries.filter(e => 
      e.version > snapshotEntry.version && e.version <= version && e.type === ENTRY_TYPE.DIFF
    );
    
    for (const diffEntry of diffsToApply) {
      text = applyPatch(text, diffEntry.data);
    }
    
    return text;
  }
  
  /**
   * Internal helper to get text at a pointer
   * @private
   */
  async _getTextAtPointer(pointer) {
    if (!(pointer instanceof Pointer)) {
      throw new Error('Expected Pointer object');
    }
    
    const entry = await this.file.read(pointer);
    
    if (entry.type === ENTRY_TYPE.FULL_SNAPSHOT) {
      return entry.data;
    }
    
    // If it's a diff, reconstruct from the latest snapshot
    // We need to scan backwards to find the snapshot and apply all diffs
    let snapshotEntry = null;
    const diffsToApply = [];
    
    for (const { value: e } of this.file.scan()) {
      if (!e.type || (e.type !== ENTRY_TYPE.FULL_SNAPSHOT && e.type !== ENTRY_TYPE.DIFF)) {
        continue;
      }
      
      if (e.version <= entry.version) {
        if (e.type === ENTRY_TYPE.FULL_SNAPSHOT) {
          snapshotEntry = e;
          // Clear any diffs before this snapshot
          diffsToApply.length = 0;
        } else if (e.version > (snapshotEntry ? snapshotEntry.version : 0)) {
          diffsToApply.push(e);
        }
      }
      
      if (e.version > entry.version) {
        break;
      }
    }
    
    if (!snapshotEntry) {
      throw new Error(`Cannot reconstruct: no snapshot found`);
    }
    
    let text = snapshotEntry.data;
    for (const diffEntry of diffsToApply) {
      text = applyPatch(text, diffEntry.data);
    }
    
    return text;
  }
  
  /**
   * Get a human-readable diff between two versions
   * @param {number} fromVersion - Starting version
   * @param {number} toVersion - Ending version
   * @returns {string} Human-readable diff
   */
  async getDiff(fromVersion, toVersion) {
    if (!this.isOpen) {
      throw new Error('TextLog is not open');
    }
    
    if (fromVersion < 1 || fromVersion > this.version) {
      throw new Error(`Invalid fromVersion: ${fromVersion}. Valid range: 1-${this.version}`);
    }
    
    if (toVersion < 1 || toVersion > this.version) {
      throw new Error(`Invalid toVersion: ${toVersion}. Valid range: 1-${this.version}`);
    }
    
    // Get both versions
    const fromText = await this.getVersion(fromVersion);
    const toText = await this.getVersion(toVersion);
    
    // Create a structured diff
    const patch = structuredPatch(
      `version ${fromVersion}`,
      `version ${toVersion}`,
      fromText,
      toText,
      '',
      ''
    );
    
    // Format as human-readable unified diff
    let result = `--- ${patch.oldFileName}\n`;
    result += `+++ ${patch.newFileName}\n`;
    
    for (const hunk of patch.hunks) {
      result += `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n`;
      for (const line of hunk.lines) {
        result += line + '\n';
      }
    }
    
    return result;
  }
  
  /**
   * Get current version number
   * @returns {number} Current version
   */
  getCurrentVersion() {
    return this.version;
  }
  
  /**
   * Get the SHA-256 hash of a specific version
   * @param {number} version - Version number
   * @returns {string} Hex string hash
   */
  async getVersionHash(version) {
    if (!this.isOpen) {
      throw new Error('TextLog is not open');
    }
    
    if (version < 1 || version > this.version) {
      throw new Error(`Invalid version: ${version}. Valid range: 1-${this.version}`);
    }
    
    // Scan through file to find the requested version
    for (const { value: entry } of this.file.scan()) {
      if (entry.type && entry.version === version) {
        return entry.hash;
      }
    }
    
    throw new Error(`Version ${version} not found`);
  }
}

export { ENTRY_TYPE };
