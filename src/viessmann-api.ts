import { Logger } from 'homebridge';
import { AuthManager, AuthConfig } from './auth-manager';
import { APIClient, APIClientConfig } from './api-client';
import { ViessmannAPIEndpoints, ViessmannInstallation, ViessmannFeature, ViessmannGateway, ViessmannDevice } from './viessmann-api-endpoints';
import { CacheConfig, CacheStats } from './api-cache';
import { APIMetrics } from './api-health-monitor';
import axios from 'axios';

// Simple network utility functions inline (avoiding external dependency)
function detectLocalIP(): string {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  
  // Try to find the first non-internal IPv4 address
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      // Skip over non-IPv4 and internal (i.e. 127.0.0.1) addresses
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  
  // Fallback to localhost
  return 'localhost';
}

export interface ViessmannPlatformConfig extends AuthConfig {
  // Platform name
  name?: string;
  
  // Rate limiting options
  maxRetries?: number;
  retryDelay?: number;
  enableRateLimitProtection?: boolean;
  requestTimeout?: number;
  rateLimitResetBuffer?: number;
  
  // Performance options
  refreshInterval?: number;
  debug?: boolean;
  enableApiMetrics?: boolean;
  
  // Installation filtering
  installationFilter?: string;
  installationIds?: number[];
  
  // 🔧 NEW: Dynamic service recreation control
  forceServiceRecreation?: boolean;  
  
  // Advanced settings
  advanced?: {
    baseDelay?: number;
    maxDelay?: number;
    maxConsecutiveErrors?: number;
    deviceUpdateDelay?: number;
    userAgent?: string;
  };
  
// 🆕 NUOVA SEZIONE per nomi personalizzati
  customNames?: {
    installationPrefix?: string;           // "Casa" invece di "HomeName/ID"
    boiler?: string;                      // "Caldaia" invece di "Boiler"
    dhw?: string;                         // "Acqua Calda" invece di "Hot Water"
    heatingCircuit?: string;              // "Riscaldamento" invece di "Heating Circuit"
    
    // Programmi temperatura
    reduced?: string;                     // "Ridotto" invece di "Reduced"
    normal?: string;                      // "Normale" invece di "Normal"
    comfort?: string;                     // "Comfort" (stesso)
    
    // Modalità DHW
    eco?: string;                         // "Eco" (stesso)
    off?: string;                         // "Spento" invece di "Off"
    
    // Altri componenti
    burner?: string;                      // "Bruciatore" invece di "Burner"
    modulation?: string;                  // "Modulazione" invece di "Modulation"
    
    // Quick selections
    holiday?: string;                     // "Vacanza" invece di "Holiday Mode"
    holidayAtHome?: string;               // "Vacanza Casa" invece di "Holiday At Home"
    extendedHeating?: string;             // "Riscaldamento Extra" invece di "Extended Heating"
  }; 
   
  // Cache configuration
  cache?: {
    enabled?: boolean;
    installationsTTL?: number;
    featuresTTL?: number;
    devicesTTL?: number;
    gatewaysTTL?: number;
    maxEntries?: number;
    enableSmartRefresh?: boolean;
    enableConditionalRequests?: boolean;
    enableIntelligentPrefetch?: boolean;
    compressionEnabled?: boolean;
  };
}

// Re-export types for backward compatibility
export { ViessmannInstallation, ViessmannFeature, ViessmannGateway, ViessmannDevice };

export class ViessmannAPI {
  private readonly authManager: AuthManager;
  private readonly apiClient: APIClient;
  private readonly endpoints: ViessmannAPIEndpoints;

  constructor(
    private readonly log: Logger,
    private readonly config: ViessmannPlatformConfig,
  ) {
    // Detect host IP if not provided
    const hostIp = this.config.hostIp || detectLocalIP();
    
    // Initialize auth manager
    this.authManager = new AuthManager(
      this.log,
      this.config,
      this.createHttpClient(),
      hostIp
    );
    
    // Initialize API client
    const apiClientConfig: APIClientConfig = {
      requestTimeout: this.config.requestTimeout || 30000,
      enableApiMetrics: this.config.enableApiMetrics !== false,
      enableRateLimitProtection: this.config.enableRateLimitProtection !== false,
      maxRetries: this.config.maxRetries || 3,
      baseDelay: this.config.advanced?.baseDelay || 1000,
      maxDelay: this.config.advanced?.maxDelay || 300000,
      rateLimitResetBuffer: this.config.rateLimitResetBuffer || 60000,
      userAgent: this.config.advanced?.userAgent || 'homebridge-viessmann-vicare/2.0.0',
      cache: this.buildCacheConfig()
    };
    
    this.apiClient = new APIClient(this.log, apiClientConfig, this.authManager);
    
    // Initialize endpoints
    this.endpoints = new ViessmannAPIEndpoints(this.log, this.apiClient);
    
    this.log.debug('✅ ViessmannAPI initialized successfully');
  }

  private createHttpClient() {
    return axios.create({
      timeout: this.config.requestTimeout || 30000,
    });
  }

  private buildCacheConfig(): CacheConfig {
    const cacheConfig = this.config.cache || {};
    
    return {
      installations: cacheConfig.installationsTTL || 24 * 60 * 60 * 1000, // 24 hours
      gateways: 12 * 60 * 60 * 1000,                                     // 12 hours
      devices: cacheConfig.devicesTTL || 6 * 60 * 60 * 1000,             // 6 hours
      features: cacheConfig.featuresTTL || 2 * 60 * 1000,                // 2 minutes
      commands: 0,                                                        // Never cache commands
      
      maxEntries: cacheConfig.maxEntries || 1000,
      
      enableInstallationsCache: cacheConfig.enabled !== false,
      enableFeaturesCache: cacheConfig.enabled !== false,
      enableConditionalRequests: cacheConfig.enableConditionalRequests || false,
      enableIntelligentPrefetch: cacheConfig.enableIntelligentPrefetch || false,
      compressionEnabled: cacheConfig.compressionEnabled || false,
    };
  }

  // Authentication methods
  public async authenticate(): Promise<void> {
    return this.authManager.authenticate();
  }

  // Installation and device discovery methods
  public async getInstallations(): Promise<ViessmannInstallation[]> {
    await this.authenticate();
    return this.endpoints.getInstallations();
  }

  public async getGatewayDevices(installationId: number, gatewaySerial: string) {
    await this.authenticate();
    return this.endpoints.getGatewayDevices(installationId, gatewaySerial);
  }

  public async getDeviceFeatures(installationId: number, gatewaySerial: string, deviceId: string): Promise<ViessmannFeature[]> {
    await this.authenticate();
    return this.endpoints.getDeviceFeatures(installationId, gatewaySerial, deviceId);
  }

  public async getFeature(installationId: number, gatewaySerial: string, deviceId: string, featureName: string): Promise<ViessmannFeature | null> {
    await this.authenticate();
    return this.endpoints.getFeature(installationId, gatewaySerial, deviceId, featureName);
  }

  // Command execution methods
  public async executeCommand(
    installationId: number,
    gatewaySerial: string,
    deviceId: string,
    featureName: string,
    commandName: string,
    params: any = {}
  ): Promise<boolean> {
    await this.authenticate();
    return this.endpoints.executeCommand(installationId, gatewaySerial, deviceId, featureName, commandName, params);
  }

  // Convenience methods for common operations
  public async setDHWTemperature(installationId: number, gatewaySerial: string, deviceId: string, temperature: number): Promise<boolean> {
    await this.authenticate();
    return this.endpoints.setDHWTemperature(installationId, gatewaySerial, deviceId, temperature);
  }

  public async setHeatingCircuitTemperature(
    installationId: number,
    gatewaySerial: string,
    deviceId: string,
    circuitNumber: number,
    temperature: number
  ): Promise<boolean> {
    await this.authenticate();
    return this.endpoints.setHeatingCircuitTemperature(installationId, gatewaySerial, deviceId, circuitNumber, temperature);
  }

  public async setOperatingMode(
    installationId: number,
    gatewaySerial: string,
    deviceId: string,
    circuitNumber: number,
    mode: string
  ): Promise<boolean> {
    await this.authenticate();
    return this.endpoints.setOperatingMode(installationId, gatewaySerial, deviceId, circuitNumber, mode);
  }

  public async setTemperatureProgram(
    installationId: number,
    gatewaySerial: string,
    deviceId: string,
    circuitNumber: number,
    program: string,
    temperature?: number
  ): Promise<boolean> {
    await this.authenticate();
    return this.endpoints.setTemperatureProgram(installationId, gatewaySerial, deviceId, circuitNumber, program, temperature);
  }

  public async activateHolidayMode(
    installationId: number,
    gatewaySerial: string,
    deviceId: string,
    circuitNumber: number,
    startDate: Date,
    endDate: Date
  ): Promise<boolean> {
    await this.authenticate();
    return this.endpoints.activateHolidayMode(installationId, gatewaySerial, deviceId, circuitNumber, startDate, endDate);
  }

  public async deactivateHolidayMode(
    installationId: number,
    gatewaySerial: string,
    deviceId: string,
    circuitNumber: number
  ): Promise<boolean> {
    await this.authenticate();
    return this.endpoints.deactivateHolidayMode(installationId, gatewaySerial, deviceId, circuitNumber);
  }

  public async setDHWMode(
    installationId: number,
    gatewaySerial: string,
    deviceId: string,
    mode: string
  ): Promise<boolean> {
    await this.authenticate();
    return this.endpoints.setDHWMode(installationId, gatewaySerial, deviceId, mode);
  }

  // Status and monitoring methods
  public getRateLimitStatus() {
    return this.apiClient.getRateLimitStatus();
  }

  public getTokenStatus() {
    return this.authManager.getTokenStatus();
  }

  public getAPIMetrics(): APIMetrics {
    return this.apiClient.getAPIMetrics();
  }

  // 🆕 NEW: Advanced Health Monitoring Methods
  public getAPIHealthScore(): number {
    return this.apiClient.getAPIHealthScore();
  }

  public getAPIHealthStatus(): 'excellent' | 'good' | 'fair' | 'poor' | 'critical' {
    return this.apiClient.getAPIHealthStatus();
  }

  public getDetailedHealthStatus() {
    return this.apiClient.getDetailedHealthStatus();
  }

  public getPerformanceHistory() {
    return this.apiClient.getPerformanceHistory();
  }

  public exportPerformanceData() {
    return this.apiClient.exportPerformanceData();
  }

  public logHealthReport(): void {
    this.apiClient.logHealthReport();
  }

  // 🆕 NEW: Complete System Status Overview
  public getSystemStatus() {
    const rateLimitStatus = this.getRateLimitStatus();
    const tokenStatus = this.getTokenStatus();
    const healthStatus = this.getDetailedHealthStatus();
    const cacheStats = this.getCacheStats();

    return {
      overall: {
        status: healthStatus.status,
        score: healthStatus.score,
        emoji: healthStatus.emoji
      },
      authentication: {
        hasTokens: tokenStatus.hasTokens,
        expiresInSeconds: tokenStatus.expiresInSeconds,
        hasRefreshToken: tokenStatus.hasRefreshToken
      },
      rateLimiting: {
        isLimited: rateLimitStatus.isLimited,
        waitSeconds: rateLimitStatus.waitSeconds,
        retryCount: rateLimitStatus.retryCount,
        dailyQuotaExceeded: rateLimitStatus.dailyQuotaExceeded
      },
      performance: {
        healthScore: healthStatus.score,
        issues: healthStatus.issues,
        recommendations: healthStatus.recommendations
      },
      cache: cacheStats ? {
        hitRate: cacheStats.hitRate,
        totalEntries: cacheStats.totalEntries,
        memoryUsage: cacheStats.memoryUsage
      } : null
    };
  }

  public getCacheStats(): CacheStats | null {
    return this.apiClient.getCacheStats();
  }

  public clearCache(pattern?: string) {
    this.apiClient.clearCache(pattern);
  }

  public updateCacheConfig(config: Partial<CacheConfig>) {
    this.apiClient.updateCacheConfig(config);
  }

  // Cleanup method
  public cleanup(): void {
    this.authManager.cleanup();
    this.apiClient.cleanup();
    this.log.debug('🧹 ViessmannAPI cleanup completed');
  }
}