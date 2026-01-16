/**
 * Distributed Caching with Redis Support
 * Provides caching layer with fallback to in-memory cache
 */

const { createClient } = require('redis');
const { BoundedMap } = require('./utils/bounded-map');

class CacheManager {
  constructor(options = {}) {
    this.redisUrl = options.redisUrl || process.env.REDIS_URL || 'redis://localhost:6379';
    this.ttl = options.ttl || 3600; // Default 1 hour TTL
    this.fallbackCache = new BoundedMap(1000); // In-memory fallback
    this.useRedis = options.useRedis !== false;
    this.redisClient = null;
    this.isConnected = false;
  }

  async connect() {
    if (!this.useRedis) {
      console.log('[Cache] Redis disabled, using in-memory cache only');
      return;
    }

    try {
      this.redisClient = createClient({
        url: this.redisUrl,
        socket: {
          reconnectStrategy: (retries) => {
            if (retries > 10) {
              console.error('[Cache] Max reconnection attempts reached');
              return new Error('Max reconnection attempts reached');
            }
            return retries * 100;
          }
        }
      });

      this.redisClient.on('error', (err) => {
        console.error('[Cache] Redis client error:', err);
        this.isConnected = false;
      });

      this.redisClient.on('connect', () => {
        console.log('[Cache] Connected to Redis');
        this.isConnected = true;
      });

      await this.redisClient.connect();
    } catch (error) {
      console.error('[Cache] Failed to connect to Redis:', error);
      console.log('[Cache] Falling back to in-memory cache');
      this.isConnected = false;
    }
  }

  async disconnect() {
    if (this.redisClient) {
      await this.redisClient.quit();
      this.isConnected = false;
    }
  }

  /**
   * Get value from cache
   */
  async get(key) {
    try {
      if (this.isConnected && this.redisClient) {
        const value = await this.redisClient.get(key);
        if (value) {
          return JSON.parse(value);
        }
      }
    } catch (error) {
      console.error('[Cache] Redis get error:', error);
    }

    // Fallback to in-memory cache
    return this.fallbackCache.get(key);
  }

  /**
   * Set value in cache
   */
  async set(key, value, ttl = this.ttl) {
    const serialized = JSON.stringify(value);

    try {
      if (this.isConnected && this.redisClient) {
        await this.redisClient.setEx(key, ttl, serialized);
      }
    } catch (error) {
      console.error('[Cache] Redis set error:', error);
    }

    // Always store in fallback cache
    this.fallbackCache.set(key, value);
  }

  /**
   * Delete value from cache
   */
  async delete(key) {
    try {
      if (this.isConnected && this.redisClient) {
        await this.redisClient.del(key);
      }
    } catch (error) {
      console.error('[Cache] Redis delete error:', error);
    }

    this.fallbackCache.delete(key);
  }

  /**
   * Clear all cache
   */
  async clear() {
    try {
      if (this.isConnected && this.redisClient) {
        await this.redisClient.flushDb();
      }
    } catch (error) {
      console.error('[Cache] Redis clear error:', error);
    }

    this.fallbackCache.clear();
  }

  /**
   * Get or set pattern (cache-aside)
   */
  async getOrSet(key, fetchFn, ttl = this.ttl) {
    let value = await this.get(key);

    if (value === undefined) {
      value = await fetchFn();
      await this.set(key, value, ttl);
    }

    return value;
  }

  /**
   * Get multiple values
   */
  async getMany(keys) {
    const results = {};

    for (const key of keys) {
      results[key] = await this.get(key);
    }

    return results;
  }

  /**
   * Set multiple values
   */
  async setMany(entries, ttl = this.ttl) {
    for (const [key, value] of Object.entries(entries)) {
      await this.set(key, value, ttl);
    }
  }

  /**
   * Increment value
   */
  async increment(key, by = 1) {
    try {
      if (this.isConnected && this.redisClient) {
        return await this.redisClient.incrBy(key, by);
      }
    } catch (error) {
      console.error('[Cache] Redis increment error:', error);
    }

    // Fallback implementation
    const current = await this.get(key) || 0;
    const newValue = current + by;
    await this.set(key, newValue);
    return newValue;
  }

  /**
   * Get cache statistics
   */
  async getStats() {
    return {
      redisEnabled: this.useRedis,
      redisConnected: this.isConnected,
      fallbackSize: this.fallbackCache.size,
      fallbackCapacity: this.fallbackCache.capacity
    };
  }
}

// Singleton instance
const cacheManager = new CacheManager();

// Initialize on module load
cacheManager.connect().catch(console.error);

module.exports = cacheManager;
