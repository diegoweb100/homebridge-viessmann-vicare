export interface CacheConfig {
  installations: number;
  gateways: number;
  devices: number;
  features: number;
  commands: number;
  maxEntries: number;
  enableInstallationsCache: boolean;
  enableFeaturesCache: boolean;
  enableConditionalRequests: boolean;
}

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  expiresAt: number;
  etag?: string;
  lastModified?: string;
  hitCount: number;
  size: number;
}

export interface CacheStats {
  totalEntries: number;
  memoryUsage: number;
  hitRate: number;
  totalHits: number;
  totalMisses: number;
}

export class APICache {
  private cache: Map<string, CacheEntry<any>> = new Map();
  private hitCount = 0;
  private missCount = 0;
  private config: CacheConfig;
  private warmingTimer?: NodeJS.Timeout;

  constructor(config: CacheConfig) {
    this.config = config;
  }

  /**
   * Get data from cache if valid, otherwise return null
   */
  get<T>(key: string, params?: any): T | null {
    const cacheKey = this.generateCacheKey(key, params);
    const entry = this.cache.get(cacheKey);

    if (!entry) {
      this.missCount++;
      return null;
    }

    // Check if entry has expired
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(cacheKey);
      this.missCount++;
      return null;
    }

    // Update hit statistics
    entry.hitCount++;
    this.hitCount++;
    
    return entry.data;
  }

  /**
   * Get data from cache with statistics tracking
   */
  getWithStats<T>(key: string, params?: any): T | null {
    return this.get<T>(key, params);
  }

  /**
   * Store data in cache with TTL based on URL pattern
   */
  set<T>(key: string, data: T, params?: any, headers?: any): void {
    if (!this.shouldCache(key)) {
      return;
    }

    const cacheKey = this.generateCacheKey(key, params);
    const ttl = this.getTTLForEndpoint(key);
    
    if (ttl === 0) {
      return; // Don't cache commands
    }

    const now = Date.now();
    const entry: CacheEntry<T> = {
      data,
      timestamp: now,
      expiresAt: now + ttl,
      etag: headers?.etag || headers?.ETag,
      lastModified: headers?.['last-modified'] || headers?.['Last-Modified'],
      hitCount: 0,
      size: this.estimateSize(data)
    };

    this.cache.set(cacheKey, entry);
    this.enforceMaxEntries();
  }

  /**
   * Get conditional request headers (ETags, Last-Modified)
   */
  getConditionalHeaders(key: string, params?: any): { [key: string]: string } {
    if (!this.config.enableConditionalRequests) {
      return {};
    }

    const cacheKey = this.generateCacheKey(key, params);
    const entry = this.cache.get(cacheKey);

    if (!entry) {
      return {};
    }

    const headers: { [key: string]: string } = {};
    
    if (entry.etag) {
      headers['If-None-Match'] = entry.etag;
    }
    
    if (entry.lastModified) {
      headers['If-Modified-Since'] = entry.lastModified;
    }

    return headers;
  }

  /**
   * Handle 304 Not Modified response by returning cached data
   */
  handleNotModified<T>(key: string, params?: any): T | null {
    const cacheKey = this.generateCacheKey(key, params);
    const entry = this.cache.get(cacheKey);

    if (entry) {
      // Extend the expiration time since server confirmed data hasn't changed
      const ttl = this.getTTLForEndpoint(key);
      entry.expiresAt = Date.now() + ttl;
      entry.hitCount++;
      this.hitCount++;
      return entry.data;
    }

    return null;
  }

  /**
   * Invalidate cache entries matching a pattern
   */
  invalidate(pattern?: string): void {
    if (!pattern) {
      // Clear all cache
      this.cache.clear();
      return;
    }

    // Remove entries matching pattern
    for (const [key] of this.cache) {
      if (key.includes(pattern)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Update cache configuration
   */
  updateConfig(newConfig: Partial<CacheConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    let totalMemory = 0;
    
    for (const entry of this.cache.values()) {
      totalMemory += entry.size;
    }

    const totalRequests = this.hitCount + this.missCount;
    const hitRate = totalRequests > 0 ? this.hitCount / totalRequests : 0;

    return {
      totalEntries: this.cache.size,
      memoryUsage: totalMemory,
      hitRate,
      totalHits: this.hitCount,
      totalMisses: this.missCount
    };
  }

  /**
   * Schedule cache warming for frequently accessed data
   */
  scheduleWarming(api: any, intervalMs: number): NodeJS.Timeout {
    this.warmingTimer = setInterval(async () => {
      await this.performCacheWarming(api);
    }, intervalMs);
    
    return this.warmingTimer;
  }

  /**
   * Generate cache key from URL and parameters
   */
  private generateCacheKey(key: string, params?: any): string {
    let cacheKey = key;
    
    if (params) {
      const sortedParams = Object.keys(params).sort().map(k => `${k}=${params[k]}`);
      cacheKey += '?' + sortedParams.join('&');
    }
    
    return cacheKey;
  }

  /**
   * Get TTL for specific endpoint based on data type
   */
  private getTTLForEndpoint(endpoint: string): number {
    if (endpoint.includes('/installations')) {
      return this.config.installations;
    }
    
    if (endpoint.includes('/gateways') && !endpoint.includes('/devices')) {
      return this.config.gateways;
    }
    
    if (endpoint.includes('/devices') && !endpoint.includes('/features')) {
      return this.config.devices;
    }
    
    if (endpoint.includes('/features')) {
      return this.config.features;
    }
    
    if (endpoint.includes('/commands')) {
      return this.config.commands; // Usually 0 (no caching)
    }
    
    // Default to features TTL
    return this.config.features;
  }

  /**
   * Check if endpoint should be cached
   */
  private shouldCache(endpoint: string): boolean {
    // Never cache commands/POST requests
    if (endpoint.includes('/commands') || endpoint.includes('setMode') || endpoint.includes('setTemperature')) {
      return false;
    }

    // Check if installations caching is enabled
    if (endpoint.includes('/installations') && !this.config.enableInstallationsCache) {
      return false;
    }

    // Check if features caching is enabled
    if (endpoint.includes('/features') && !this.config.enableFeaturesCache) {
      return false;
    }

    return true;
  }

  /**
   * Estimate memory size of cached data
   */
  private estimateSize(data: any): number {
    try {
      return JSON.stringify(data).length * 2; // Rough estimate (UTF-16)
    } catch {
      return 1000; // Fallback estimate
    }
  }

  /**
   * Enforce maximum cache entries using LRU strategy
   */
  private enforceMaxEntries(): void {
    if (this.cache.size <= this.config.maxEntries) {
      return;
    }

    // Sort by hit count (ascending) and timestamp (ascending) for LRU
    const entries = Array.from(this.cache.entries()).sort((a, b) => {
      const hitDiff = a[1].hitCount - b[1].hitCount;
      if (hitDiff !== 0) return hitDiff;
      return a[1].timestamp - b[1].timestamp;
    });

    // Remove oldest/least used entries
    const toRemove = entries.slice(0, this.cache.size - this.config.maxEntries);
    for (const [key] of toRemove) {
      this.cache.delete(key);
    }
  }

  /**
   * Perform cache warming for frequently accessed endpoints
   */
  private async performCacheWarming(api: any): Promise<void> {
    try {
      // This would warm up installations cache
      // Implementation depends on having access to the API instance
      // For now, this is a placeholder for future enhancement
    } catch (error) {
      // Silently fail cache warming to not disrupt normal operation
    }
  }

  /**
   * Cleanup method
   */
  cleanup(): void {
    if (this.warmingTimer) {
      clearInterval(this.warmingTimer);
      this.warmingTimer = undefined;
    }
    this.cache.clear();
  }
}