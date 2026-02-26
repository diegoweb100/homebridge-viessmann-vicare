/**
 * This is the name of the platform that users will use to register the plugin in the Homebridge config.json
 */
export const PLATFORM_NAME = 'ViessmannPlatform';

/**
 * This must match the name of your plugin as defined the package.json
 */
export const PLUGIN_NAME = 'homebridge-viessmann-vicare';

/**
 * Plugin version for User-Agent and logging
 */
export const PLUGIN_VERSION = '2.0.13';

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG = {
  refreshInterval: 120000, // 2 minutes
  requestTimeout: 30000, // 30 seconds
  redirectPort: 4200,
  maxRetries: 3,
  baseDelay: 1000, // 1 second
  maxDelay: 300000, // 5 minutes
  rateLimitResetBuffer: 60000, // 1 minute
  tokenRefreshBuffer: 300000, // 5 minutes
  authTimeout: 300000, // 5 minutes
  enableRateLimitProtection: true,
  enableApiMetrics: true,
  enableTokenPersistence: true,
  cache: {
    enabled: true,
    installationsTTL: 86400000, // 24 hours
    featuresTTL: 120000, // 2 minutes
    devicesTTL: 21600000, // 6 hours
    gatewaysTTL: 43200000, // 12 hours
    maxEntries: 1000,
    enableSmartRefresh: false,
    enableConditionalRequests: false,
    enableIntelligentPrefetch: false,
    compressionEnabled: false,
  },
  features: {
    enableBoilerAccessories: true,
    enableDHWAccessories: true,
    enableHeatingCircuitAccessories: true,
    enableTemperaturePrograms: true,
    enableQuickSelections: true,
    enableBurnerStatus: true,
  },
  advanced: {
    maxConsecutiveErrors: 5,
    deviceUpdateDelay: 1000,
    userAgent: `homebridge-viessmann-vicare/${PLUGIN_VERSION}`,
  },
  monitoring: {
    enableHealthReports: true,
    healthReportInterval: 3600000, // 1 hour
    enablePerformanceTracking: true,
    maxPerformanceHistory: 100,
  },  
};

/**
 * Viessmann API endpoints
 */
export const VIESSMANN_API = {
  baseURL: 'https://api.viessmann-climatesolutions.com',
  authURL: 'https://iam.viessmann-climatesolutions.com/idp/v3',
  scope: 'IoT User offline_access',
  
  endpoints: {
    installations: '/iot/v2/equipment/installations',
    gateways: (installationId: number) => `/iot/v2/equipment/installations/${installationId}/gateways`,
    devices: (installationId: number, gatewaySerial: string) => 
      `/iot/v2/equipment/installations/${installationId}/gateways/${gatewaySerial}/devices`,
    features: (installationId: number, gatewaySerial: string, deviceId: string) =>
      `/iot/v2/features/installations/${installationId}/gateways/${gatewaySerial}/devices/${deviceId}/features`,
    feature: (installationId: number, gatewaySerial: string, deviceId: string, featureName: string) =>
      `/iot/v2/features/installations/${installationId}/gateways/${gatewaySerial}/devices/${deviceId}/features/${featureName}`,
    command: (installationId: number, gatewaySerial: string, deviceId: string, featureName: string, commandName: string) =>
      `/iot/v2/features/installations/${installationId}/gateways/${gatewaySerial}/devices/${deviceId}/features/${featureName}/commands/${commandName}`,
  },
};

/**
 * Common feature names used by Viessmann devices
 */
export const VIESSMANN_FEATURES = {
  // Boiler features
  boiler: {
    temperature: 'heating.boiler.temperature',
    modulation: 'heating.burners.0.modulation',
    statistics: 'heating.burners.0.statistics',
    active: 'heating.burners.0.active',
  },
  
  // DHW (Domestic Hot Water) features
  dhw: {
    temperature: 'heating.dhw.temperature.main',
    operatingModes: 'heating.dhw.operating.modes.active',
    pumps: 'heating.dhw.pumps.circulation',
    sensors: 'heating.dhw.sensors.temperature.hotWaterStorage',
  },
  
  // Heating circuit features
  circuits: {
    operating: (circuit: number) => `heating.circuits.${circuit}.operating`,
    temperature: (circuit: number) => `heating.circuits.${circuit}.temperature`,
    heating: (circuit: number) => `heating.circuits.${circuit}.heating`,
    sensors: (circuit: number) => `heating.circuits.${circuit}.sensors`,
  },
  
  // System features
  system: {
    sensors: 'heating.sensors.temperature.outside',
    compressor: 'heating.compressors.0',
    solar: 'heating.solar',
  },
};

/**
 * HomeKit service and characteristic mappings
 */
export const HOMEKIT_MAPPING = {
  services: {
    thermostat: 'Thermostat',
    heaterCooler: 'HeaterCooler',
    temperatureSensor: 'TemperatureSensor',
    switch: 'Switch',
    lightbulb: 'Lightbulb', // For modulation level
  },
  
  characteristics: {
    currentTemperature: 'CurrentTemperature',
    targetTemperature: 'TargetTemperature',
    heatingThresholdTemperature: 'HeatingThresholdTemperature',
    currentHeatingCoolingState: 'CurrentHeatingCoolingState',
    targetHeatingCoolingState: 'TargetHeatingCoolingState',
    active: 'Active',
    on: 'On',
    brightness: 'Brightness', // For modulation level
  },
};

/**
 * Error codes and messages
 */
export const ERROR_CODES = {
  AUTHENTICATION_FAILED: 'VIESSMANN_AUTH_FAILED',
  RATE_LIMITED: 'VIESSMANN_RATE_LIMITED',
  API_ERROR: 'VIESSMANN_API_ERROR',
  NETWORK_ERROR: 'VIESSMANN_NETWORK_ERROR',
  INVALID_CONFIG: 'VIESSMANN_INVALID_CONFIG',
  TOKEN_EXPIRED: 'VIESSMANN_TOKEN_EXPIRED',
  DEVICE_NOT_FOUND: 'VIESSMANN_DEVICE_NOT_FOUND',
  FEATURE_NOT_SUPPORTED: 'VIESSMANN_FEATURE_NOT_SUPPORTED',
};

/**
 * Log levels and formatting
 */
export const LOG_CONFIG = {
  levels: {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
  },
  
  prefixes: {
    auth: '[AuthManager]',
    api: '[APIClient]',
    cache: '[APICache]',
    rateLimit: '[RateLimitManager]',
    endpoints: '[APIEndpoints]',
    network: '[NetworkUtils]',
    platform: '[Platform]',
    accessory: '[Accessory]',
  },
  
  emojis: {
    success: '✅',
    error: '❌',
    warning: '⚠️',
    info: 'ℹ️',
    debug: '🔍',
    auth: '🔐',
    api: '📡',
    cache: '💾',
    rateLimit: '🛡️',
    network: '🌐',
    platform: '🏠',
  },
};

/**
 * Performance thresholds and monitoring
 */
export const PERFORMANCE_THRESHOLDS = {
  cache: {
    goodHitRate: 0.8, // 80%
    excellentHitRate: 0.9, // 90%
    maxMemoryUsage: 50 * 1024 * 1024, // 50MB
  },
  
  api: {
    goodResponseTime: 2000, // 2 seconds
    slowResponseTime: 5000, // 5 seconds
    goodHealthScore: 85,
    excellentHealthScore: 95,
  },
  
  rateLimit: {
    warningRetryCount: 3,
    dangerRetryCount: 10,
    dailyQuotaThreshold: 3600, // 1 hour delay indicates daily quota
  },
};

/**
 * Regular expressions for validation
 */
export const VALIDATION_PATTERNS = {
  clientId: /^[a-zA-Z0-9_-]+$/,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  ipv4: /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/,
  installationName: /^[a-zA-Z0-9\s_-]+$/,
};

/**
 * Cache key patterns for different data types
 */
export const CACHE_PATTERNS = {
  installations: '/installations',
  gateways: '/gateways',
  devices: '/devices',
  features: '/features',
  commands: '/commands',
  
  // Specific feature patterns
  boiler: 'heating.boiler',
  dhw: 'heating.dhw',
  circuits: 'heating.circuits',
  sensors: 'heating.sensors',
};

/**
 * 🆕 NEW: Burner update configuration for immediate status updates
 */
export const BURNER_UPDATE_CONFIG = {
  delays: {
    dhwModeChange: 2000,        // 2 seconds after DHW mode change
    dhwTemperatureChange: 3000, // 3 seconds after DHW temperature change
    heatingModeChange: 2000,    // 2 seconds after heating mode change
    heatingTemperatureChange: 3000, // 3 seconds after heating temperature change
    programChange: 2000,        // 2 seconds after program change
    holidayModeChange: 5000,    // 5 seconds after holiday mode change
    extendedHeatingChange: 2000, // 2 seconds after extended heating change
  },
  debounce: {
    enabled: true,
    windowMs: 1000,             // 1 second debounce window
  },
  maxRetries: 3,
  retryDelay: 1000,             // 1 second between retries
};