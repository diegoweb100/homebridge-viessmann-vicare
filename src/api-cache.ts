import { Logger } from 'homebridge';
import * as crypto from 'crypto';
import * as zlib from 'zlib';

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
  enableIntelligentPrefetch?: boolean;
  compressionEnabled?: boolean;
}

interface CacheEntry<T> {
  data: T;
  compressedData?: Buffer;
  timestamp: number;
  expiresAt: number;
  etag?: string;
  lastModified?: string;
  hitCount: number;
  size: number;
  checksum: string;
  priority: number;
  accessPattern: number[];
  isCompressed: boolean;
}

interface PrefetchRule {
  pattern: string;
  dependencies: string[];
  probability: number;
  lastUsed: number;
}

export interface CacheStats {
  totalEntries: number;
  memoryUsage: number;
  compressedSize: number;
  hitRate: number;
  totalHits: number;
  totalMisses: number;
  compressionRatio: number;
  prefetchHits: number;
  evictions: number;
  memoryEfficiency: number;
}

export class APICache {
  private cache: Map<string, CacheEntry<any>> = new Map();
  private hitCount = 0;
  private missCount = 0;
  private prefetchHits = 0;
  private evictions = 0;
  private warmingTimer?: NodeJS.Timeout;
  private prefetchRules: Map<string, PrefetchRule> = new Map();
  private accessPatterns: Map<string, number[]> = new Map();

  constructor(
    private config: CacheConfig,
    private log?: Logger
  ) {
    this.initializePrefetchRules();
    this.startMaintenanceTimer();
  }

  private initializePrefetchRules(): void {
    if (!this.config.enableIntelligentPrefetch) return;

    // Define intelligent prefetch rules based on typical usage patterns
    const rules: PrefetchRule[] = [
      {
        pattern: '/installations',
        dependencies: ['/gateways', '/devices'],
        probability: 0.9,
        lastUsed: 0
      },
      {
        pattern: '/gateways/{gatewayId}/devices',
        dependencies: ['/devices/{deviceId}/features'],
        probability: 0.8,
        lastUsed: 0
      },
      {
        pattern: '/devices/{deviceId}/features',
        dependencies: [
          '/features/heating.boiler',
          '/features/heating.dhw',
          '/features/heating.circuits'
        ],
        probability: 0.7,
        lastUsed: 0
      }
    ];

    rules.forEach(rule => {
      this.prefetchRules.set(rule.pattern, rule);
    });

    this.log?.debug('🧠 Intelligent prefetch rules initialized');
  }

  private startMaintenanceTimer(): void {
    // Run maintenance every 5 minutes
    this.warmingTimer = setInterval(() => {
      this.performMaintenance();
    }, 5 * 60 * 1000);
  }

  private performMaintenance(): void {
    this.cleanupExpiredEntries();
    this.updateAccessPatterns();
    this.optimizeMemoryUsage();
    
    if (this.config.enableIntelligentPrefetch) {
      this.updatePrefetchProbabilities();
    }
  }

  private cleanupExpiredEntries(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.log?.debug(`🧹 Cleaned ${cleaned} expired cache entries`);
    }
  }

  private updateAccessPatterns(): void {
    const now = Date.now();
    const windowSize = 10; // Track last 10 accesses

    for (const [key, pattern] of this.accessPatterns.entries()) {
      // Keep only recent access times (last hour)
      const recentAccesses = pattern.filter(time => (now - time) < 3600000);
      this.accessPatterns.set(key, recentAccesses.slice(-windowSize));
    }
  }

  private optimizeMemoryUsage(): void {
    if (this.cache.size <= this.config.maxEntries * 0.8) return;

    // Calculate memory pressure
    const totalMemory = this.calculateTotalMemoryUsage();
    const maxMemory = this.config.maxEntries * 1024 * 10; // Rough estimate: 10KB per entry

    if (totalMemory > maxMemory) {
      this.performIntelligentEviction();
    }
  }

  private performIntelligentEviction(): void {
    // Sort entries by priority (combination of access frequency, recency, and size)
    const entries = Array.from(this.cache.entries()).map(([key, entry]) => {
      const accessFrequency = entry.hitCount;
      const recency = Date.now() - entry.timestamp;
      const sizePenalty = entry.size / 1024; // Size in KB
      
      // Calculate priority score (higher = more likely to be evicted)
      const score = (recency / 3600000) + (sizePenalty * 0.1) - (accessFrequency * 10);
      
      return { key, entry, score };
    });

    entries.sort((a, b) => b.score - a.score);

    // Evict bottom 20% or until we're under memory pressure
    const evictionCount = Math.min(
      Math.ceil(entries.length * 0.2),
      entries.length - Math.floor(this.config.maxEntries * 0.7)
    );

    for (let i = 0; i < evictionCount; i++) {
      this.cache.delete(entries[i].key);
      this.evictions++;
    }

    this.log?.debug(`🗑️ Evicted ${evictionCount} cache entries for memory optimization`);
  }

  private updatePrefetchProbabilities(): void {
    if (!this.config.enableIntelligentPrefetch) return;

    const now = Date.now();
    const recentWindow = 3600000; // 1 hour

    for (const [pattern, rule] of this.prefetchRules.entries()) {
      // Update probability based on recent usage
      const recentUsage = Array.from(this.accessPatterns.entries())
        .filter(([key, times]) => {
          return key.includes(pattern.replace(/{.*?}/g, '')) &&
                 times.some(time => (now - time) < recentWindow);
        }).length;

      if (recentUsage > 0) {
        rule.probability = Math.min(0.95, rule.probability + 0.05);
        rule.lastUsed = now;
      } else {
        rule.probability = Math.max(0.1, rule.probability - 0.02);
      }
    }
  }

  /**
   * Get data from cache if valid, otherwise return null
   */
  get<T>(key: string, params?: any): T | null {
    const cacheKey = this.generateCacheKey(key, params);
    const entry = this.cache.get(cacheKey);

    if (!entry) {
      this.missCount++;
      this.triggerIntelligentPrefetch(key);
      return null;
    }

    // Check if entry has expired
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(cacheKey);
      this.missCount++;
      return null;
    }

    // Update hit statistics and access pattern
    entry.hitCount++;
    this.hitCount++;
    this.recordAccess(cacheKey);
    
    // Decompress data if needed
    const data = entry.isCompressed ? this.decompressData(entry.compressedData!) : entry.data;
    
    return data;
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
    const checksum = this.generateChecksum(data);
    
    // Check if data actually changed
    const existingEntry = this.cache.get(cacheKey);
    if (existingEntry && existingEntry.checksum === checksum) {
      // Data hasn't changed, just extend TTL
      existingEntry.expiresAt = now + ttl;
      existingEntry.hitCount++;
      this.log?.debug(`♻️ Cache entry refreshed (no data change): ${cacheKey}`);
      return;
    }

    const serializedData = JSON.stringify(data);
    const originalSize = Buffer.byteLength(serializedData, 'utf8');
    
    let compressedData: Buffer | undefined;
    let finalData: T = data;
    let isCompressed = false;
    let finalSize = originalSize;

    // Compress large entries if compression is enabled
    if (this.config.compressionEnabled && originalSize > 1024) { // > 1KB
      try {
        compressedData = zlib.gzipSync(serializedData);
        const compressionRatio = compressedData.length / originalSize;
        
        if (compressionRatio < 0.8) { // Only use compression if it saves >20%
          isCompressed = true;
          finalSize = compressedData.length;
          this.log?.debug(`🗜️ Compressed cache entry: ${originalSize} → ${finalSize} bytes (${(compressionRatio * 100).toFixed(1)}%)`);
        }
      } catch (error) {
        this.log?.warn(`⚠️ Compression failed for ${cacheKey}:`, error);
      }
    }

    const priority = this.calculatePriority(key, originalSize);
    
    const entry: CacheEntry<T> = {
      data: isCompressed ? null as any : finalData,
      compressedData: isCompressed ? compressedData : undefined,
      timestamp: now,
      expiresAt: now + ttl,
      etag: headers?.etag || headers?.ETag,
      lastModified: headers?.['last-modified'] || headers?.['Last-Modified'],
      hitCount: 0,
      size: finalSize,
      checksum,
      priority,
      accessPattern: [],
      isCompressed
    };

    this.cache.set(cacheKey, entry);
    this.recordAccess(cacheKey);
    this.enforceMaxEntries();
    
    this.log?.debug(`💾 Cached: ${cacheKey} (${finalSize} bytes, TTL: ${ttl/1000}s, compressed: ${isCompressed})`);
  }

  private generateChecksum(data: any): string {
    const serialized = JSON.stringify(data);
    return crypto.createHash('md5').update(serialized).digest('hex');
  }

  private calculatePriority(key: string, size: number): number {
    let priority = 50; // Base priority
    
    // Higher priority for smaller data
    if (size < 1024) priority += 20;
    else if (size > 10240) priority -= 20;
    
    // Higher priority for frequently accessed endpoints
    if (key.includes('/installations')) priority += 30;
    else if (key.includes('/features')) priority += 10;
    else if (key.includes('/devices')) priority += 20;
    
    return Math.max(0, Math.min(100, priority));
  }

  private decompressData(compressedData: Buffer): any {
    try {
      const decompressed = zlib.gunzipSync(compressedData);
      return JSON.parse(decompressed.toString('utf8'));
    } catch (error) {
      this.log?.error('❌ Failed to decompress cache data:', error);
      return null;
    }
  }

  private recordAccess(cacheKey: string): void {
    const now = Date.now();
    
    if (!this.accessPatterns.has(cacheKey)) {
      this.accessPatterns.set(cacheKey, []);
    }
    
    const pattern = this.accessPatterns.get(cacheKey)!;
    pattern.push(now);
    
    // Keep only last 20 accesses
    if (pattern.length > 20) {
      pattern.shift();
    }
  }

  private triggerIntelligentPrefetch(missedKey: string): void {
    if (!this.config.enableIntelligentPrefetch) return;

    for (const [pattern, rule] of this.prefetchRules.entries()) {
      if (missedKey.includes(pattern.replace(/{.*?}/g, '')) && Math.random() < rule.probability) {
        // Schedule prefetch for dependencies
        setTimeout(() => {
          this.executePrefetch(rule.dependencies, missedKey);
        }, 100); // Small delay to avoid blocking
        break;
      }
    }
  }

  private async executePrefetch(dependencies: string[], context: string): Promise<void> {
    // This would need to be implemented with access to the API instance
    // For now, just log the intent
    this.log?.debug(`🔮 Intelligent prefetch triggered for context: ${context}`);
    this.log?.debug(`📋 Dependencies to prefetch: ${dependencies.join(', ')}`);
    
    // In a real implementation, this would make API calls to warm the cache
    // The API instance would need to be passed to the cache for this to work
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
      
      // Return decompressed data
      const data = entry.isCompressed ? this.decompressData(entry.compressedData!) : entry.data;
      
      this.log?.debug(`🔄 304 Not Modified - cache refreshed: ${cacheKey}`);
      return data;
    }

    return null;
  }

  /**
   * Invalidate cache entries matching a pattern
   */
  invalidate(pattern?: string): void {
    if (!pattern) {
      // Clear all cache
      const count = this.cache.size;
      this.cache.clear();
      this.accessPatterns.clear();
      this.log?.debug(`🗑️ Cleared entire cache (${count} entries)`);
      return;
    }

    // Remove entries matching pattern
    let removed = 0;
    for (const [key] of this.cache) {
      if (key.includes(pattern)) {
        this.cache.delete(key);
        this.accessPatterns.delete(key);
        removed++;
      }
    }
    
    if (removed > 0) {
      this.log?.debug(`🗑️ Invalidated ${removed} cache entries matching pattern: ${pattern}`);
    }
  }

  /**
   * Update cache configuration
   */
  updateConfig(newConfig: Partial<CacheConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.log?.debug('⚙️ Cache configuration updated');
  }

  /**
   * Get comprehensive cache statistics
   */
  getStats(): CacheStats {
    let totalMemory = 0;
    let compressedSize = 0;
    let uncompressedSize = 0;
    
    for (const entry of this.cache.values()) {
      totalMemory += entry.size;
      if (entry.isCompressed && entry.compressedData) {
        compressedSize += entry.size;
        // Calculate uncompressed size for compression ratio
        const estimatedUncompressed = entry.compressedData.length * 3; // Rough estimate
        uncompressedSize += estimatedUncompressed;
      }
    }

    const totalRequests = this.hitCount + this.missCount;
    const hitRate = totalRequests > 0 ? this.hitCount / totalRequests : 0;
    const compressionRatio = uncompressedSize > 0 ? compressedSize / uncompressedSize : 1;
    const memoryEfficiency = totalMemory > 0 ? (this.cache.size * 1024) / totalMemory : 1;

    return {
      totalEntries: this.cache.size,
      memoryUsage: totalMemory,
      compressedSize,
      hitRate,
      totalHits: this.hitCount,
      totalMisses: this.missCount,
      compressionRatio,
      prefetchHits: this.prefetchHits,
      evictions: this.evictions,
      memoryEfficiency
    };
  }

  /**
   * Get detailed cache analysis
   */
  getDetailedAnalysis(): {
    topEntries: { key: string; hitCount: number; size: number }[];
    accessPatterns: { key: string; frequency: number; lastAccess: number }[];
    compressionStats: { totalCompressed: number; averageRatio: number };
    memoryDistribution: { features: number; installations: number; devices: number; other: number };
  } {
    const entries = Array.from(this.cache.entries());
    
    // Top entries by hit count
    const topEntries = entries
      .map(([key, entry]) => ({ key, hitCount: entry.hitCount, size: entry.size }))
      .sort((a, b) => b.hitCount - a.hitCount)
      .slice(0, 10);

    // Access patterns
    const accessPatterns = Array.from(this.accessPatterns.entries())
      .map(([key, times]) => ({
        key,
        frequency: times.length,
        lastAccess: Math.max(...times, 0)
      }))
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, 10);

    // Compression stats
    const compressedEntries = entries.filter(([, entry]) => entry.isCompressed);
    const compressionStats = {
      totalCompressed: compressedEntries.length,
      averageRatio: compressedEntries.length > 0 
        ? compressedEntries.reduce((sum, [, entry]) => {
            // Estimate compression ratio
            const estimatedOriginal = entry.compressedData ? entry.compressedData.length * 3 : entry.size;
            return sum + (entry.size / estimatedOriginal);
          }, 0) / compressedEntries.length
        : 1
    };

    // Memory distribution
    const memoryDistribution = {
      features: 0,
      installations: 0,
      devices: 0,
      other: 0
    };

    for (const [key, entry] of entries) {
      if (key.includes('/features')) memoryDistribution.features += entry.size;
      else if (key.includes('/installations')) memoryDistribution.installations += entry.size;
      else if (key.includes('/devices')) memoryDistribution.devices += entry.size;
      else memoryDistribution.other += entry.size;
    }

    return {
      topEntries,
      accessPatterns,
      compressionStats,
      memoryDistribution
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
   * Calculate total memory usage
   */
  private calculateTotalMemoryUsage(): number {
    let total = 0;
    for (const entry of this.cache.values()) {
      total += entry.size;
    }
    return total;
  }

  /**
   * Enforce maximum cache entries using intelligent LRU strategy
   */
  private enforceMaxEntries(): void {
    if (this.cache.size <= this.config.maxEntries) {
      return;
    }

    // Sort by intelligent score combining hit count, recency, size, and priority
    const entries = Array.from(this.cache.entries()).sort((a, b) => {
      const scoreA = this.calculateEvictionScore(a[1]);
      const scoreB = this.calculateEvictionScore(b[1]);
      return scoreB - scoreA; // Higher score = more likely to be evicted
    });

    // Remove oldest/least valuable entries
    const toRemove = entries.slice(0, this.cache.size - this.config.maxEntries);
    for (const [key] of toRemove) {
      this.cache.delete(key);
      this.accessPatterns.delete(key);
      this.evictions++;
    }

    this.log?.debug(`🗑️ Evicted ${toRemove.length} entries to maintain max size`);
  }

  private calculateEvictionScore(entry: CacheEntry<any>): number {
    const now = Date.now();
    const age = (now - entry.timestamp) / 3600000; // Age in hours
    const hitCount = entry.hitCount;
    const sizePenalty = entry.size / 1024; // Size in KB
    const priority = entry.priority;
    
    // Calculate access frequency (accesses per hour)
    const accessFrequency = hitCount / Math.max(age, 0.1);
    
    // Score calculation (higher = more likely to evict)
    // - Penalize old entries
    // - Penalize large entries
    // - Favor frequently accessed entries
    // - Favor high priority entries
    const score = (age * 2) + (sizePenalty * 0.5) - (accessFrequency * 10) - (priority * 0.1);
    
    return score;
  }

  /**
   * Perform cache warming for frequently accessed endpoints
   */
  private async performCacheWarming(api: any): Promise<void> {
    try {
      if (!this.config.enableIntelligentPrefetch) return;

      const stats = this.getStats();
      if (stats.hitRate < 0.7) { // Only warm cache if hit rate is low
        this.log?.debug('🔥 Performing intelligent cache warming...');
        
        // Identify frequently accessed but recently expired entries
        const now = Date.now();
        const recentlyExpired: string[] = [];
        
        for (const [key, times] of this.accessPatterns.entries()) {
          const isRecentlyAccessed = times.some(time => (now - time) < 300000); // 5 minutes
          const isCached = this.cache.has(key);
          
          if (isRecentlyAccessed && !isCached) {
            recentlyExpired.push(key);
          }
        }
        
        // Log warming intent (actual implementation would require API access)
        if (recentlyExpired.length > 0) {
          this.log?.debug(`🎯 Would warm ${recentlyExpired.length} recently expired entries`);
        }
      }
    } catch (error) {
      // Silently fail cache warming to not disrupt normal operation
      this.log?.debug('⚠️ Cache warming failed:', error);
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
    this.accessPatterns.clear();
    this.prefetchRules.clear();
    this.log?.debug('🧹 Cache cleanup completed');
  }

  /**
   * Export cache for analysis or backup
   */
  exportCache(): {
    entries: Array<{ key: string; size: number; hitCount: number; expiresAt: number }>;
    stats: CacheStats;
    config: CacheConfig;
  } {
    const entries = Array.from(this.cache.entries()).map(([key, entry]) => ({
      key,
      size: entry.size,
      hitCount: entry.hitCount,
      expiresAt: entry.expiresAt
    }));

    return {
      entries,
      stats: this.getStats(),
      config: this.config
    };
  }
}