import { Logger } from 'homebridge';
import axios, { AxiosInstance, AxiosResponse, AxiosError, InternalAxiosRequestConfig } from 'axios';
import { AuthManager } from './auth-manager';
import { RateLimitManager, RateLimitConfig } from './rate-limit-manager';
import { APICache, CacheConfig } from './api-cache';
import { APIHealthMonitor, APIMetrics } from './api-health-monitor';

// Create our own interface that extends the Axios config
interface AxiosRequestConfigWithMetadata extends InternalAxiosRequestConfig {
  metadata?: {
    startTime: number;
  };
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
  private readonly healthMonitor: APIHealthMonitor;
  private readonly rateLimitManager: RateLimitManager;
  private readonly cache: APICache;

  constructor(
    private readonly log: Logger,
    private readonly config: APIClientConfig,
    private readonly authManager: AuthManager
  ) {
    // Initialize advanced health monitor
    this.healthMonitor = new APIHealthMonitor(this.log);
    
    // Initialize cache system
    this.cache = new APICache(config.cache || this.getDefaultCacheConfig(), this.log);
    
    // Initialize rate limit manager
    this.rateLimitManager = new RateLimitManager(this.log, config, this.cache);
    
    // Setup HTTP client with proper base URL
    this.httpClient = axios.create({
      baseURL: this.baseURL,
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
    
    // Start periodic health monitoring
    this.startHealthMonitoring();
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
        // Track metrics with advanced health monitor
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
        // Track metrics with advanced health monitor
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

  private startHealthMonitoring(): void {
    // Reset metrics daily to prevent memory bloat
    setInterval(() => {
      this.healthMonitor.resetMetricsIfNeeded();
    }, 60 * 60 * 1000); // Check every hour

    // Log detailed health report every 6 hours
    setInterval(() => {
      if (this.config.enableApiMetrics) {
        this.healthMonitor.logHealthReport();
      }
    }, 6 * 60 * 60 * 1000); // Every 6 hours
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

  public getAPIMetrics(): APIMetrics {
    return this.healthMonitor.getMetrics();
  }

  public getAPIHealthScore(): number {
    return this.healthMonitor.getHealthScore();
  }

  public getAPIHealthStatus(): 'excellent' | 'good' | 'fair' | 'poor' | 'critical' {
    return this.healthMonitor.getHealthStatus();
  }

  public getDetailedHealthStatus() {
    return this.healthMonitor.getDetailedStatus();
  }

  public getPerformanceHistory() {
    return this.healthMonitor.getPerformanceHistory();
  }

  public exportPerformanceData() {
    return this.healthMonitor.exportPerformanceData();
  }

  public logHealthReport(): void {
    this.healthMonitor.logHealthReport();
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