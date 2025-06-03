import { Logger } from 'homebridge';
import { AxiosError } from 'axios';
import { APICache } from './api-cache';

interface RateLimitInfo {
  retryAfter: number;
  blockedUntil: number;
  retryCount: number;
  lastError?: string;
  dailyQuotaExceeded?: boolean;
  resetTime?: number;
}

export interface RateLimitConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  rateLimitResetBuffer: number;
}

export class RateLimitManager {
  private rateLimitInfo: RateLimitInfo = {
    retryAfter: 0,
    blockedUntil: 0,
    retryCount: 0,
    dailyQuotaExceeded: false
  };

  constructor(
    private readonly log: Logger,
    private readonly config: RateLimitConfig,
    private readonly cache?: APICache
  ) {}

  public isRateLimited(): boolean {
    return Date.now() < this.rateLimitInfo.blockedUntil;
  }

  public handleRateLimit(error: AxiosError): void {
    const response = error.response;
    const retryAfter = this.parseRetryAfter(response?.headers?.['retry-after'] || response?.headers?.['Retry-After']);
    
    // Check for daily quota exceeded (usually much longer rate limits)
    const isDailyQuotaExceeded = retryAfter > 3600 || this.rateLimitInfo.retryCount > 10;
    
    // Default to exponential backoff if no Retry-After header
    const backoffDelay = retryAfter || Math.min(
      this.config.baseDelay * Math.pow(2, this.rateLimitInfo.retryCount),
      this.config.maxDelay
    );

    // For daily quota exceeded, use much longer delays
    const finalDelay = isDailyQuotaExceeded ? Math.max(backoffDelay, 3600000) : backoffDelay; // Min 1 hour for daily quota

    this.rateLimitInfo = {
      retryAfter: finalDelay,
      blockedUntil: Date.now() + finalDelay + this.config.rateLimitResetBuffer,
      retryCount: this.rateLimitInfo.retryCount + 1,
      lastError: this.getErrorMessage(error),
      dailyQuotaExceeded: isDailyQuotaExceeded,
      resetTime: isDailyQuotaExceeded ? Date.now() + 86400000 : undefined // 24 hours for daily reset
    };

    if (isDailyQuotaExceeded) {
      this.log.error(`🚫 Daily API quota exceeded. Blocked for ${Math.ceil(finalDelay / 3600000)} hours.`);
      this.log.error('📅 The API will automatically resume tomorrow. Consider reducing refresh frequency.');
    } else {
      this.log.warn(`⚠️ Rate limit exceeded (429). Blocked for ${Math.ceil(finalDelay / 1000)} seconds.`);
    }
    
    this.log.warn(`📊 Rate limit details: ${this.rateLimitInfo.lastError}`);
    
    // Adjust cache TTL to be more aggressive during rate limiting
    if (this.cache) {
      const currentStats = this.cache.getStats();
      this.log.info(`📈 Cache stats - Hit rate: ${(currentStats.hitRate * 100).toFixed(1)}%, Entries: ${currentStats.totalEntries}`);
      
      // Increase cache TTL significantly during rate limiting
      const multiplier = isDailyQuotaExceeded ? 10 : 3;
      this.cache.updateConfig({
        features: Math.min(2 * 60 * 1000 * multiplier, 30 * 60 * 1000) // Max 30 minutes
      });
    }
    
    // Log user-friendly advice
    this.logRateLimitAdvice(isDailyQuotaExceeded);
  }

  private parseRetryAfter(retryAfter: string | undefined): number {
    if (!retryAfter) return 0;
    
    const seconds = parseInt(retryAfter, 10);
    return isNaN(seconds) ? 0 : seconds * 1000; // Convert to milliseconds
  }

  private getErrorMessage(error: AxiosError): string {
    if (error.response?.data && typeof error.response.data === 'object') {
      const data = error.response.data as any;
      if (data.message) {
        return data.message;
      }
      if (data.errorType && data.message) {
        return `${data.errorType}: ${data.message}`;
      }
      if (data.error && data.error_description) {
        return `${data.error}: ${data.error_description}`;
      }
    }
    return error.message || 'Unknown rate limit error';
  }

  private logRateLimitAdvice(isDailyQuotaExceeded: boolean): void {
    const cacheStats = this.cache?.getStats();
    
    this.log.warn('='.repeat(80));
    this.log.warn('🚫 VIESSMANN API RATE LIMIT EXCEEDED');
    this.log.warn('='.repeat(80));
    
    if (isDailyQuotaExceeded) {
      this.log.warn('📊 DAILY API QUOTA EXCEEDED:');
      this.log.warn('  • Your daily API request limit has been reached');
      this.log.warn('  • This typically resets at midnight (Viessmann time)');
      this.log.warn('  • Plugin will automatically resume when quota resets');
    } else {
      this.log.warn('⏱️ TEMPORARY RATE LIMIT:');
      this.log.warn('  • Too many requests sent in a short time period');
      this.log.warn('  • This is a temporary throttling measure');
    }
    
    this.log.warn('');
    this.log.warn('📈 Current performance metrics:');
    if (cacheStats) {
      this.log.warn(`  • Cache hit rate: ${(cacheStats.hitRate * 100).toFixed(1)}%`);
      this.log.warn(`  • Cached entries: ${cacheStats.totalEntries}`);
      this.log.warn(`  • Memory usage: ${(cacheStats.memoryUsage / 1024).toFixed(1)}KB`);
    }
    this.log.warn('');
    this.log.warn('💡 To reduce API calls:');
    this.log.warn('  1. Increase refreshInterval to 300000ms (5 minutes) or higher');
    this.log.warn('  2. Enable longer cache TTL values in configuration');
    this.log.warn('  3. Use installation filtering to reduce device count');
    this.log.warn('  4. Close ViCare mobile app and other integrations temporarily');
    this.log.warn('  5. Enable intelligent prefetch and compression in cache settings');
    this.log.warn('  6. Consider upgrading to a higher API plan if available');
    this.log.warn('');
    this.log.warn(`⏰ Plugin will automatically retry after: ${new Date(this.rateLimitInfo.blockedUntil).toLocaleString()}`);
    this.log.warn('='.repeat(80));
  }

  public resetRateLimit(): void {
    this.rateLimitInfo = {
      retryAfter: 0,
      blockedUntil: 0,
      retryCount: 0,
      dailyQuotaExceeded: false
    };
    
    // Reset cache TTL to normal values
    if (this.cache) {
      // Reset to default values
      this.cache.updateConfig({
        features: 2 * 60 * 1000 // Reset to 2 minutes default
      });
    }
    
    this.log.info('✅ Rate limit has been reset - API calls can resume');
  }

  public getRateLimitStatus(): {
    isLimited: boolean;
    blockedUntil?: Date;
    waitSeconds?: number;
    retryCount: number;
    lastError?: string;
    dailyQuotaExceeded: boolean;
    resetTime?: Date;
  } {
    const now = Date.now();
    const isLimited = this.isRateLimited();
    
    return {
      isLimited,
      blockedUntil: isLimited ? new Date(this.rateLimitInfo.blockedUntil) : undefined,
      waitSeconds: isLimited ? Math.ceil((this.rateLimitInfo.blockedUntil - now) / 1000) : undefined,
      retryCount: this.rateLimitInfo.retryCount,
      lastError: this.rateLimitInfo.lastError,
      dailyQuotaExceeded: this.rateLimitInfo.dailyQuotaExceeded || false,
      resetTime: this.rateLimitInfo.resetTime ? new Date(this.rateLimitInfo.resetTime) : undefined
    };
  }

  public shouldRetry(retryCount: number): boolean {
    if (this.isRateLimited()) {
      return false;
    }
    
    if (this.rateLimitInfo.dailyQuotaExceeded) {
      return false;
    }
    
    return retryCount < this.config.maxRetries;
  }

  public getRetryDelay(retryCount: number): number {
    if (this.isRateLimited()) {
      return this.rateLimitInfo.blockedUntil - Date.now();
    }
    
    return Math.min(
      this.config.baseDelay * Math.pow(2, retryCount),
      this.config.maxDelay
    );
  }

  public recordSuccessfulRequest(): void {
    // Reset retry count on successful request
    if (this.rateLimitInfo.retryCount > 0) {
      this.rateLimitInfo.retryCount = 0;
    }
  }

  public checkAndResetIfExpired(): void {
    // Check if rate limit has expired
    if (this.rateLimitInfo.blockedUntil > 0 && Date.now() >= this.rateLimitInfo.blockedUntil) {
      this.resetRateLimit();
    }
  }
}