import { stemmer } from 'stemmer';
import { BPlusTree } from './bplustree.js';
import { getFileHandle } from './binjson.js';

// Common English stop words that don't add semantic value to searches
const STOPWORDS = new Set([
  'a', 'about', 'after', 'all', 'also', 'am', 'an', 'and', 'another', 'any', 'are', 
  'around', 'as', 'at', 'be', 'because', 'been', 'before', 'being', 'between', 'both', 
  'but', 'by', 'came', 'can', 'come', 'could', 'did', 'do', 'each', 'for', 'from', 
  'get', 'got', 'has', 'had', 'he', 'have', 'her', 'here', 'him', 'himself', 'his', 
  'how', 'i', 'if', 'in', 'into', 'is', 'it', 'like', 'make', 'many', 'me', 'might', 
  'more', 'most', 'much', 'must', 'my', 'never', 'now', 'of', 'on', 'only', 'or', 
  'other', 'our', 'out', 'over', 'said', 'same', 'see', 'should', 'since', 'some', 
  'still', 'such', 'take', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 
  'these', 'they', 'this', 'those', 'through', 'to', 'too', 'under', 'up', 'very', 
  'was', 'way', 'we', 'well', 'were', 'what', 'where', 'which', 'while', 'who', 
  'with', 'would', 'you', 'your'
]);

/**
 * Tokenize text into individual words
 * @param {string} text - The text to tokenize
 * @returns {string[]} Array of words
 */
export function tokenize(text) {
  if (typeof text !== 'string') {
    return [];
  }
  // Split on non-word characters and filter out empty strings
  const words = text.toLowerCase()
    .split(/\W+/)
    .filter(word => word.length > 0);
  
  // Filter stop words
  return words.filter(word => !STOPWORDS.has(word));
}

/**
 * TextIndex - A text index implementation using Porter stemmer algorithm
 * 
 * This class provides full-text search capabilities by indexing terms
 * and associating them with document IDs. It uses the Porter stemmer
 * algorithm to normalize words to their root forms.
 */
export class TextIndex {
  constructor(options = {}) {
    const {
      order = 16,
      trees
    } = options;

    this.order = order;
    this.index = trees?.index || null;
    this.documentTerms = trees?.documentTerms || null;
    this.documentLengths = trees?.documentLengths || null;
    this.isOpen = false;
  }

  async open() {
    if (this.isOpen) {
      throw new Error('TextIndex is already open');
    }

    if (!this.index || !this.documentTerms || !this.documentLengths) {
      throw new Error('Trees must be initialized before opening');
    }

    await Promise.all([
      this.index.open(),
      this.documentTerms.open(),
      this.documentLengths.open()
    ]);

    this.isOpen = true;
  }

  async close() {
    if (!this.isOpen) {
      return;
    }

    await Promise.all([
      this.index.close(),
      this.documentTerms.close(),
      this.documentLengths.close()
    ]);

    this.isOpen = false;
  }

  _ensureOpen() {
    if (!this.isOpen) {
      throw new Error('TextIndex is not open');
    }
  }

  /**
   * Add terms from text to the index for a given document ID
   * @param {string} docId - The document identifier
   * @param {string} text - The text content to index
   */
  async add(docId, text) {
    this._ensureOpen();

    if (!docId) {
      throw new Error('Document ID is required');
    }

    const words = tokenize(text);
    const termFrequency = new Map();

    words.forEach(word => {
      const stem = stemmer(word);
      termFrequency.set(stem, (termFrequency.get(stem) || 0) + 1);
    });

    for (const [stem, frequency] of termFrequency.entries()) {
      const postings = (await this.index.search(stem)) || {};
      postings[docId] = frequency;
      await this.index.add(stem, postings);
    }

    const existingTerms = (await this.documentTerms.search(docId)) || {};
    const mergedTerms = { ...existingTerms };
    termFrequency.forEach((frequency, stem) => {
      mergedTerms[stem] = frequency;
    });

    const docLength = Object.values(mergedTerms).reduce((sum, count) => sum + count, 0);

    await this.documentTerms.add(docId, mergedTerms);
    await this.documentLengths.add(docId, docLength);
  }

  /**
   * Remove all indexed terms for a given document ID
   * @param {string} docId - The document identifier to remove
   * @returns {boolean} True if document was found and removed, false otherwise
   */
  async remove(docId) {
    this._ensureOpen();

    const terms = await this.documentTerms.search(docId);
    if (!terms) {
      return false;
    }

    for (const [term] of Object.entries(terms)) {
      const postings = (await this.index.search(term)) || {};
      delete postings[docId];

      if (Object.keys(postings).length === 0) {
        await this.index.delete(term);
      } else {
        await this.index.add(term, postings);
      }
    }

    await this.documentTerms.delete(docId);
    await this.documentLengths.delete(docId);
    return true;
  }

  /**
   * Query the index for documents containing the given terms with relevance scoring
   * @param {string} queryText - The search query text
   * @param {Object} options - Query options
   * @param {boolean} options.scored - If true, return scored results; if false, return just IDs (default: true)
   * @param {boolean} options.requireAll - If true, require ALL terms; if false, rank by relevance (default: false)
   * @returns {Array} Array of document IDs (if scored=false) or objects with {id, score} (if scored=true)
   */
  async query(queryText, options = { scored: true, requireAll: false }) {
    this._ensureOpen();

    const words = tokenize(queryText);
    if (words.length === 0) {
      return [];
    }

    const stemmedTerms = words.map(word => stemmer(word));
    const uniqueTerms = [...new Set(stemmedTerms)];

    if (options.requireAll) {
      const docSets = [];
      for (const term of uniqueTerms) {
        const termDocs = await this.index.search(term);
        docSets.push(new Set(Object.keys(termDocs || {})));
      }

      if (docSets.length === 0) {
        return [];
      }

      const intersection = new Set(docSets[0]);
      for (let i = 1; i < docSets.length; i++) {
        for (const docId of [...intersection]) {
          if (!docSets[i].has(docId)) {
            intersection.delete(docId);
          }
        }
      }

      return Array.from(intersection);
    }

    const docLengthEntries = await this.documentLengths.toArray();
    const docLengthMap = new Map(docLengthEntries.map(({ key, value }) => [String(key), value || 1]));
    const totalDocs = docLengthEntries.length;

    const idf = new Map();
    for (const term of uniqueTerms) {
      const termDocs = await this.index.search(term);
      const docsWithTerm = termDocs ? Object.keys(termDocs).length : 0;
      if (docsWithTerm > 0) {
        idf.set(term, Math.log(totalDocs / docsWithTerm));
      }
    }

    const docScores = new Map();
    for (const term of uniqueTerms) {
      const termDocs = await this.index.search(term);
      if (!termDocs) {
        continue;
      }

      for (const [docId, termFreq] of Object.entries(termDocs)) {
        const docLength = docLengthMap.get(docId) || 1;
        const tf = termFreq / docLength;
        const termIdf = idf.get(term) || 0;
        const prev = docScores.get(docId) || 0;
        docScores.set(docId, prev + tf * termIdf);
      }
    }

    for (const [docId, score] of docScores.entries()) {
      const docTerms = (await this.documentTerms.search(docId)) || {};
      const matchingTerms = uniqueTerms.filter(term => !!docTerms[term]).length;
      const coverage = matchingTerms / uniqueTerms.length;
      docScores.set(docId, score * (1 + coverage));
    }

    const results = Array.from(docScores.entries())
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score);

    if (options.scored === false) {
      return results.map(r => r.id);
    }
    
    return results;
  }

  /**
   * Get the number of unique terms in the index
   * @returns {number} Number of unique terms
   */
  async getTermCount() {
    this._ensureOpen();
    const terms = await this.index.toArray();
    return terms.length;
  }

  /**
   * Get the number of documents in the index
   * @returns {number} Number of indexed documents
   */
  async getDocumentCount() {
    this._ensureOpen();
    const docs = await this.documentTerms.toArray();
    return docs.length;
  }

  /**
   * Clear all data from the index
   */
  async clear() {
    this._ensureOpen();

    const [terms, docs, lengths] = await Promise.all([
      this.index.toArray(),
      this.documentTerms.toArray(),
      this.documentLengths.toArray()
    ]);

    // Run deletes sequentially to avoid overlapping writes on the same underlying file
    for (const entry of terms) {
      await this.index.delete(entry.key);
    }

    for (const entry of docs) {
      await this.documentTerms.delete(entry.key);
    }

    for (const entry of lengths) {
      await this.documentLengths.delete(entry.key);
    }
  }

  /**
   * Compact all internal B+ trees using provided destination tree instances.
   * The destination trees should be freshly created (unopened) with new sync handles.
   * After compaction completes, the destination sync handles will be closed.
   * @param {Object} options - Compaction options  
   * @param {BPlusTree} options.index - Fresh destination tree for index data
   * @param {BPlusTree} options.documentTerms - Fresh destination tree for document terms
   * @param {BPlusTree} options.documentLengths - Fresh destination tree for document lengths
   * @returns {Promise<{terms: object, documents: object, lengths: object}>}
   */
  async compact({ index: destIndex, documentTerms: destDocTerms, documentLengths: destDocLengths }) {
    this._ensureOpen();

    if (!destIndex || !destDocTerms || !destDocLengths) {
      throw new Error('Destination trees must be provided for compaction');
    }

    // Compact the trees. Note: BPlusTree.compact() will close the destination sync handle
    // when finished, so these destination trees should be disposable after this call
    const termsResult = await this.index.compact(destIndex.file.syncAccessHandle);
    const documentsResult = await this.documentTerms.compact(destDocTerms.file.syncAccessHandle);
    const lengthsResult = await this.documentLengths.compact(destDocLengths.file.syncAccessHandle);

    // Close the old trees - now the index is closed
    await this.close();
    this.isOpen = false;

    return {
      terms: termsResult,
      documents: documentsResult,
      lengths: lengthsResult
    };
  }

}

// Re-export the stemmer so consumers can share the exact same implementation
export { stemmer };
