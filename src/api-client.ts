import { Logger } from 'homebridge';
import axios, { AxiosInstance, AxiosResponse, AxiosError, InternalAxiosRequestConfig } from 'axios';
import { AuthManager } from './auth-manager';
import { RateLimitManager, RateLimitConfig } from './rate-limit-manager';
import { APICache, CacheConfig } from './api-cache';

// Create our own interface that extends the Axios config
interface AxiosRequestConfigWithMetadata extends InternalAxiosRequestConfig {
  metadata?: {
    startTime: number;
  };
}

// Simplified health monitor to avoid import issues
interface APIMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  rateLimitHits: number;
  averageResponseTime: number;
  lastSuccessfulRequest: number;
  lastFailedRequest: number;
  healthScore: number;
  uptime: number;
  requestsPerMinute: number;
  errorRate: number;
  lastResetTime: number;
}

class SimpleAPIHealthMonitor {
  private metrics!: APIMetrics;
  private responseTimes: number[] = [];
  private requestTimestamps: number[] = [];
  private readonly maxResponseTimeHistory = 50;
  private readonly startTime: number;

  constructor(private readonly log?: Logger) {
    this.startTime = Date.now();
    this.resetMetrics();
  }

  private resetMetrics(): void {
    this.metrics = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      rateLimitHits: 0,
      averageResponseTime: 0,
      lastSuccessfulRequest: 0,
      lastFailedRequest: 0,
      healthScore: 100,
      uptime: 0,
      requestsPerMinute: 0,
      errorRate: 0,
      lastResetTime: Date.now()
    };
  }

  public recordRequest(success: boolean, responseTime: number): void {
    const now = Date.now();
    
    this.metrics.totalRequests++;
    this.requestTimestamps.push(now);
    
    if (success) {
      this.metrics.successfulRequests++;
      this.metrics.lastSuccessfulRequest = now;
    } else {
      this.metrics.failedRequests++;
      this.metrics.lastFailedRequest = now;
    }
    
    // Track response times
    this.responseTimes.push(responseTime);
    if (this.responseTimes.length > this.maxResponseTimeHistory) {
      this.responseTimes.shift();
    }
    
    // Clean old request timestamps (keep only last hour)
    const oneHourAgo = now - (60 * 60 * 1000);
    this.requestTimestamps = this.requestTimestamps.filter(timestamp => timestamp > oneHourAgo);
    
    this.updateCalculatedMetrics();
  }

  public recordRateLimit(): void {
    this.metrics.rateLimitHits++;
    this.updateCalculatedMetrics();
  }

  private updateCalculatedMetrics(): void {
    const now = Date.now();
    
    // Calculate average response time
    if (this.responseTimes.length > 0) {
      this.metrics.averageResponseTime = this.responseTimes.reduce((sum, time) => sum + time, 0) / this.responseTimes.length;
    }
    
    // Calculate error rate
    if (this.metrics.totalRequests > 0) {
      this.metrics.errorRate = (this.metrics.failedRequests / this.metrics.totalRequests) * 100;
    }
    
    // Calculate requests per minute (based on last hour)
    const oneMinuteAgo = now - (60 * 1000);
    const recentRequests = this.requestTimestamps.filter(timestamp => timestamp > oneMinuteAgo);
    this.metrics.requestsPerMinute = recentRequests.length;
    
    // Calculate uptime
    this.metrics.uptime = now - this.startTime;
    
    // Calculate health score (simplified)
    const recentWindow = 5 * 60 * 1000; // 5 minutes
    const recentRequests2 = this.requestTimestamps.filter(timestamp => timestamp > (now - recentWindow));
    
    if (recentRequests2.length === 0) {
      this.metrics.healthScore = 75;
      return;
    }
    
    let score = 100;
    
    // Success rate impact
    const successRate = this.metrics.totalRequests > 0 ? (this.metrics.successfulRequests / this.metrics.totalRequests) : 1;
    score -= (1 - successRate) * 40;
    
    // Response time impact
    if (this.metrics.averageResponseTime > 5000) {
      score -= 20;
    } else if (this.metrics.averageResponseTime > 2000) {
      score -= 10;
    }
    
    this.metrics.healthScore = Math.max(0, Math.min(100, score));
  }

  public getHealthScore(): number {
    return Math.round(this.metrics.healthScore);
  }

  public getMetrics(): APIMetrics {
    this.updateCalculatedMetrics();
    return { ...this.metrics };
  }
}

export interface APIClientConfig extends RateLimitConfig {
  requestTimeout: number;
  enableApiMetrics: boolean;
  enableRateLimitProtection: boolean;
  userAgent?: string;
  cache?: CacheConfig;
}

export class APIClient {
  private readonly baseURL = 'https://api.viessmann.com';
  private readonly httpClient: AxiosInstance;
  private readonly healthMonitor: SimpleAPIHealthMonitor;
  private readonly rateLimitManager: RateLimitManager;
  private readonly cache: APICache;

  constructor(
    private readonly log: Logger,
    private readonly config: APIClientConfig,
    private readonly authManager: AuthManager
  ) {
    // Initialize health monitor
    this.healthMonitor = new SimpleAPIHealthMonitor(this.log);
    
    // Initialize cache system
    this.cache = new APICache(config.cache || this.getDefaultCacheConfig(), this.log);
    
    // Initialize rate limit manager
    this.rateLimitManager = new RateLimitManager(this.log, config, this.cache);
    
    // Setup HTTP client with proper base URL
    this.httpClient = axios.create({
      baseURL: this.baseURL, // This is the critical fix!
      timeout: this.config.requestTimeout,
      headers: {
        'User-Agent': this.config.userAgent || 'homebridge-viessmann-vicare/2.0.0',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
      },
    });

    this.log.debug(`🔗 API Client initialized with base URL: ${this.baseURL}`);
    this.setupInterceptors();
  }

  private getDefaultCacheConfig(): CacheConfig {
    return {
      installations: 24 * 60 * 60 * 1000, // 24 hours
      gateways: 12 * 60 * 60 * 1000,     // 12 hours
      devices: 6 * 60 * 60 * 1000,       // 6 hours
      features: 2 * 60 * 1000,           // 2 minutes
      commands: 0,                        // Never cache commands
      maxEntries: 1000,
      enableInstallationsCache: true,
      enableFeaturesCache: true,
      enableConditionalRequests: false,
      enableIntelligentPrefetch: false,
      compressionEnabled: false,
    };
  }

  private setupInterceptors(): void {
    // Add request interceptor for rate limiting and caching
    this.httpClient.interceptors.request.use(
      (config: AxiosRequestConfigWithMetadata) => {
        const startTime = Date.now();
        config.metadata = { startTime };
        
        // Log the full URL being requested for debugging
        const fullUrl = (config.baseURL || this.baseURL) + (config.url || '');
        this.log.debug(`🌐 Making API request: ${config.method?.toUpperCase()} ${fullUrl}`);
        
        // Check if we're currently rate limited
        if (this.rateLimitManager.isRateLimited()) {
          const status = this.rateLimitManager.getRateLimitStatus();
          this.log.warn(`API is rate limited. Waiting ${status.waitSeconds} seconds before next request.`);
          return Promise.reject(new Error(`Rate limited. Wait ${status.waitSeconds} seconds.`));
        }

        // Add conditional request headers if cache supports it
        if (config.url && this.cache) {
          const conditionalHeaders = this.cache.getConditionalHeaders(config.url, config.params);
          Object.assign(config.headers, conditionalHeaders);
        }

        // Add authentication header if available
        const accessToken = this.authManager.getAccessToken();
        if (accessToken && !config.url?.includes('/token') && !config.url?.includes('/authorize')) {
          config.headers!['Authorization'] = `Bearer ${accessToken}`;
        }

        return config;
      },
      (error) => Promise.reject(error)
    );

    // Add response interceptor for handling rate limit responses and caching
    this.httpClient.interceptors.response.use(
      (response) => {
        // Track metrics
        const config = response.config as AxiosRequestConfigWithMetadata;
        const duration = Date.now() - (config.metadata?.startTime || Date.now());
        this.healthMonitor.recordRequest(true, duration);

        // Reset rate limit info on successful requests
        this.rateLimitManager.recordSuccessfulRequest();

        // Cache successful responses
        if (response.config.url && this.cache && response.config.method?.toLowerCase() === 'get') {
          this.cache.set(response.config.url, response.data, response.config.params, response.headers);
        }
        return response;
      },
      (error: AxiosError) => {
        // Track metrics
        const config = error.config as AxiosRequestConfigWithMetadata;
        const duration = Date.now() - (config?.metadata?.startTime || Date.now());
        this.healthMonitor.recordRequest(false, duration);

        if (error.response?.status === 429) {
          this.healthMonitor.recordRateLimit();
          this.rateLimitManager.handleRateLimit(error);
        } else if (error.response?.status === 304) {
          // Handle 304 Not Modified
          const cachedData = this.cache?.handleNotModified(error.config?.url || '', error.config?.params);
          if (cachedData) {
            return Promise.resolve({
              ...error.response,
              status: 200,
              data: cachedData
            });
          }
        } else if (error.response?.status === 401 || error.response?.status === 403) {
          // Token expired or invalid - will be handled by the API layer
          this.log.warn('Authentication error detected - tokens may be expired');
        }
        return Promise.reject(error);
      }
    );
  }

  public async makeAPICall<T>(
    requestFn: () => Promise<AxiosResponse<T>>,
    operationName: string,
    cacheKey?: string,
    retryCount: number = 0
  ): Promise<AxiosResponse<T>> {
    try {
      // Check cache first for GET requests
      if (cacheKey && this.cache) {
        const cachedData = this.cache.getWithStats<T>(cacheKey);
        if (cachedData !== null) {
          this.log.debug(`💨 Cache hit for ${operationName}`);
          // Return cached data as a mock response
          return {
            data: cachedData,
            status: 200,
            statusText: 'OK (Cached)',
            headers: {},
            config: {}
          } as AxiosResponse<T>;
        }
        this.log.debug(`💔 Cache miss for ${operationName}`);
      }

      // Check if rate limit has expired
      this.rateLimitManager.checkAndResetIfExpired();

      // Don't proceed if still rate limited
      if (this.rateLimitManager.isRateLimited()) {
        const status = this.rateLimitManager.getRateLimitStatus();
        throw new Error(`Rate limited: wait ${status.waitSeconds} seconds`);
      }

      const response = await requestFn();
      
      // Reset retry count on successful request
      if (retryCount > 0) {
        this.log.info(`✅ API call '${operationName}' succeeded after ${retryCount} retries`);
      }

      return response;

    } catch (error) {
      const axiosError = error as AxiosError;
      
      if (axiosError.response?.status === 429) {
        this.rateLimitManager.handleRateLimit(axiosError);
        
        if (this.rateLimitManager.shouldRetry(retryCount)) {
          const delay = this.rateLimitManager.getRetryDelay(retryCount);
          this.log.warn(`🔄 Retrying '${operationName}' in ${delay / 1000} seconds (attempt ${retryCount + 1}/${this.config.maxRetries})`);
          
          await this.sleep(delay);
          return this.makeAPICall(requestFn, operationName, cacheKey, retryCount + 1);
        } else {
          const status = this.rateLimitManager.getRateLimitStatus();
          const reason = status.dailyQuotaExceeded ? 'Daily quota exceeded' : 'Max retries exceeded';
          throw new Error(`${reason} for '${operationName}': ${status.lastError}`);
        }
      } else if (axiosError.response?.status === 401 || axiosError.response?.status === 403) {
        // Token might be expired, try to refresh
        if (retryCount === 0) {
          try {
            this.log.warn(`🔑 Authentication error for '${operationName}', attempting token refresh...`);
            await this.authManager.refreshAccessToken();
            return this.makeAPICall(requestFn, operationName, cacheKey, retryCount + 1);
          } catch (refreshError) {
            this.log.error('❌ Token refresh failed:', refreshError);
            throw error;
          }
        } else {
          throw error;
        }
      } else {
        // For other errors, retry with exponential backoff
        if (retryCount < this.config.maxRetries) {
          const delay = Math.min(this.config.baseDelay * Math.pow(2, retryCount), 30000); // Max 30 seconds for non-rate-limit retries
          this.log.warn(`⚠️ Error in '${operationName}': ${axiosError.message}. Retrying in ${delay / 1000} seconds...`);
          
          await this.sleep(delay);
          return this.makeAPICall(requestFn, operationName, cacheKey, retryCount + 1);
        } else {
          throw error;
        }
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // HTTP method wrappers
  public async get<T>(url: string, params?: any): Promise<AxiosResponse<T>> {
    return this.makeAPICall(
      () => this.httpClient.get<T>(url, { params }),
      `GET ${url}`,
      url
    );
  }

  public async post<T>(url: string, data?: any, config?: any): Promise<AxiosResponse<T>> {
    return this.makeAPICall(
      () => this.httpClient.post<T>(url, data, config),
      `POST ${url}`
      // No cache key for POST requests
    );
  }

  public async put<T>(url: string, data?: any, config?: any): Promise<AxiosResponse<T>> {
    return this.makeAPICall(
      () => this.httpClient.put<T>(url, data, config),
      `PUT ${url}`
      // No cache key for PUT requests
    );
  }

  public async delete<T>(url: string, config?: any): Promise<AxiosResponse<T>> {
    return this.makeAPICall(
      () => this.httpClient.delete<T>(url, config),
      `DELETE ${url}`
      // No cache key for DELETE requests
    );
  }

  // Status and monitoring methods
  public getRateLimitStatus() {
    return this.rateLimitManager.getRateLimitStatus();
  }

  public getAPIMetrics() {
    return this.healthMonitor.getMetrics();
  }

  public getCacheStats() {
    return this.cache.getStats();
  }

  public clearCache(pattern?: string) {
    this.cache.invalidate(pattern);
    this.log.info(pattern ? `🗑️ Cache cleared for pattern: ${pattern}` : '🗑️ Cache completely cleared');
  }

  public updateCacheConfig(config: Partial<CacheConfig>) {
    this.cache.updateConfig(config);
    this.log.info('⚙️ Cache configuration updated');
  }

  public cleanup(): void {
    this.cache.cleanup();
    this.log.debug('🧹 APIClient cleanup completed');
  }
}