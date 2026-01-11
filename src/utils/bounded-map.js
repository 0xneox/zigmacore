/**
 * Bounded Map with automatic size limit enforcement to prevent memory leaks
 * When the map exceeds maxSize, oldest entries are evicted using LRU policy
 */
class BoundedMap {
  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
    this.map = new Map();
    this.accessOrder = new Map(); // Tracks access order for LRU
  }

  set(key, value) {
    if (this.map.has(key)) {
      this.map.set(key, value);
      this.accessOrder.delete(key);
      this.accessOrder.set(key, Date.now());
      return this;
    }

    if (this.map.size >= this.maxSize) {
      this.evictOldest();
    }

    this.map.set(key, value);
    this.accessOrder.set(key, Date.now());
    return this;
  }

  get(key) {
    if (!this.map.has(key)) {
      return undefined;
    }

    this.accessOrder.delete(key);
    this.accessOrder.set(key, Date.now());
    return this.map.get(key);
  }

  has(key) {
    return this.map.has(key);
  }

  delete(key) {
    this.accessOrder.delete(key);
    return this.map.delete(key);
  }

  clear() {
    this.map.clear();
    this.accessOrder.clear();
  }

  get size() {
    return this.map.size;
  }

  evictOldest() {
    if (this.accessOrder.size === 0) return;

    let oldestKey = null;
    let oldestTime = Infinity;

    for (const [key, time] of this.accessOrder.entries()) {
      if (time < oldestTime) {
        oldestTime = time;
        oldestKey = key;
      }
    }

    if (oldestKey !== null) {
      this.map.delete(oldestKey);
      this.accessOrder.delete(oldestKey);
    }
  }

  keys() {
    return this.map.keys();
  }

  values() {
    return this.map.values();
  }

  entries() {
    return this.map.entries();
  }

  forEach(callback) {
    this.map.forEach(callback);
  }
}

module.exports = { BoundedMap };
