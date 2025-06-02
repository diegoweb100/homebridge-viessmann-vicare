import {
  API,
  APIEvent,
  CharacteristicValue,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';

import { ViessmannAPI } from './viessmann-api';
import { ViessmannBoilerAccessory } from './accessories/boiler-accessory';
import { ViessmannDHWAccessory } from './accessories/dhw-accessory';
import { ViessmannHeatingCircuitAccessory } from './accessories/heating-circuit-accessory';
import { PLUGIN_NAME } from './settings'; // Import the plugin name

export interface ViessmannPlatformConfig extends PlatformConfig {
  clientId: string;
  clientSecret?: string;
  username: string;
  password: string;
  authMethod?: 'auto' | 'manual';
  hostIp?: string;
  redirectPort?: number;
  accessToken?: string;
  refreshToken?: string;
  installationFilter?: string; // NEW: Filter installations by name
  installationIds?: number[]; // NEW: Specific installation IDs to include
  refreshInterval?: number;
  debug?: boolean;
  // NEW: Rate limiting options
  maxRetries?: number;
  retryDelay?: number;
  enableRateLimitProtection?: boolean;
}

export interface ViessmannInstallation {
  id: number;
  description: string;
  gateways: ViessmannGateway[];
}

export interface ViessmannGateway {
  serial: string;
  devices: ViessmannDevice[];
}

export interface ViessmannDevice {
  id: string;
  deviceType: string;
  modelId: string;
  status: string;
  gatewaySerial: string;
}

export interface ViessmannFeature {
  feature: string;
  properties: any;
  commands: any;
  isEnabled: boolean;
  isReady: boolean;
  timestamp: string;
}

export class ViessmannPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: PlatformAccessory[] = [];
  public readonly viessmannAPI: ViessmannAPI;

  private installations: ViessmannInstallation[] = [];
  private refreshTimer?: NodeJS.Timeout;
  private isUpdating = false;
  private consecutiveErrors = 0;
  private maxConsecutiveErrors = 5;
  private backoffMultiplier = 1;

  constructor(
    public readonly log: Logger,
    public readonly config: ViessmannPlatformConfig,
    public readonly api: API,
  ) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;
    this.viessmannAPI = new ViessmannAPI(this.log, this.config);

    this.log.debug('Finished initializing platform:', this.config.name);

    this.api.on(APIEvent.DID_FINISH_LAUNCHING, () => {
      log.debug('Executed didFinishLaunching callback');
      this.discoverDevices();
    });

    this.api.on(APIEvent.SHUTDOWN, () => {
      if (this.refreshTimer) {
        clearInterval(this.refreshTimer);
      }
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  async discoverDevices() {
    try {
      // Check rate limit status before attempting discovery
      const rateLimitStatus = this.viessmannAPI.getRateLimitStatus();
      if (rateLimitStatus.isLimited) {
        this.log.warn(`Cannot discover devices: API is rate limited for ${rateLimitStatus.waitSeconds} seconds`);
        this.scheduleRetryDiscovery(rateLimitStatus.waitSeconds! * 1000);
        return;
      }

      await this.viessmannAPI.authenticate();
      const allInstallations = await this.viessmannAPI.getInstallations();

      // Apply installation filtering
      this.installations = this.filterInstallations(allInstallations);
      
      // Log filtering results
      if (allInstallations.length !== this.installations.length) {
        this.log.info(`Installation filtering applied: ${this.installations.length}/${allInstallations.length} installations selected`);
        this.log.info(`Selected installations: ${this.installations.map(i => `${i.description} (ID: ${i.id})`).join(', ')}`);
        
        const excluded = allInstallations.filter(all => !this.installations.some(selected => selected.id === all.id));
        if (excluded.length > 0) {
          this.log.info(`Excluded installations: ${excluded.map(i => `${i.description} (ID: ${i.id})`).join(', ')}`);
        }
      } else {
        this.log.info(`No filtering applied - showing all ${this.installations.length} installations`);
      }

      for (const installation of this.installations) {
        this.log.info(`Setting up installation: ${installation.description} (ID: ${installation.id})`);
        
        for (const gateway of installation.gateways) {
          for (const device of gateway.devices) {
            await this.setupDeviceAccessories(installation, gateway, device);
          }
        }
      }

      // Reset error counter on successful discovery
      this.consecutiveErrors = 0;
      this.backoffMultiplier = 1;

      // Start refresh timer with adaptive interval based on rate limiting
      this.startRefreshTimer();

    } catch (error) {
      this.handleDiscoveryError(error);
    }
  }

  private handleDiscoveryError(error: any) {
    this.consecutiveErrors++;
    
    if (error.message && error.message.includes('Rate limited')) {
      this.log.error('Device discovery failed due to rate limiting:', error.message);
      
      // Extract wait time from error message if available
      const waitMatch = error.message.match(/wait (\d+) seconds/);
      const waitTime = waitMatch ? parseInt(waitMatch[1]) * 1000 : 300000; // Default 5 minutes
      
      this.scheduleRetryDiscovery(waitTime);
    } else {
      this.log.error('Failed to discover devices:', error);
      
      // Use exponential backoff for other errors
      const retryDelay = Math.min(
        (this.config.retryDelay || 30000) * Math.pow(2, this.consecutiveErrors - 1),
        300000 // Max 5 minutes
      );
      
      if (this.consecutiveErrors <= this.maxConsecutiveErrors) {
        this.log.warn(`Will retry discovery in ${retryDelay / 1000} seconds (attempt ${this.consecutiveErrors}/${this.maxConsecutiveErrors})`);
        this.scheduleRetryDiscovery(retryDelay);
      } else {
        this.log.error(`Max discovery retries (${this.maxConsecutiveErrors}) exceeded. Manual restart may be required.`);
        this.log.error('Consider increasing refreshInterval or checking your API quotas.');
      }
    }
  }

  private scheduleRetryDiscovery(delay: number) {
    setTimeout(() => {
      this.log.info('Retrying device discovery...');
      this.discoverDevices();
    }, delay);
  }

  private startRefreshTimer() {
    // Calculate refresh interval with rate limit protection
    let refreshInterval = this.config.refreshInterval || 60000; // Default 1 minute
    
    if (this.config.enableRateLimitProtection !== false) { // Enabled by default
      // Apply backoff multiplier based on previous errors
      refreshInterval *= this.backoffMultiplier;
      
      // Ensure minimum interval to prevent rate limiting
      const minInterval = 60000; // 1 minute minimum
      refreshInterval = Math.max(refreshInterval, minInterval);
      
      // Warn if interval was adjusted
      if (refreshInterval !== (this.config.refreshInterval || 60000)) {
        this.log.warn(`Refresh interval adjusted to ${refreshInterval / 1000} seconds for rate limit protection`);
      }
    }

    this.log.info(`Starting refresh timer with ${refreshInterval / 1000} second interval`);
    
    this.refreshTimer = setInterval(() => {
      this.updateAllDevices();
    }, refreshInterval);
  }

  /**
   * Filter installations based on configuration
   */
  private filterInstallations(installations: ViessmannInstallation[]): ViessmannInstallation[] {
    // Priority 1: Use specific installation IDs if provided
    if (this.config.installationIds && this.config.installationIds.length > 0) {
      this.log.info(`Filtering by installation IDs: ${this.config.installationIds.join(', ')}`);
      
      const filtered = installations.filter(installation => 
        this.config.installationIds!.includes(installation.id)
      );
      
      if (filtered.length === 0) {
        this.log.warn(`No installations found matching IDs: ${this.config.installationIds.join(', ')}`);
        this.log.warn(`Available installations: ${installations.map(i => `${i.description} (ID: ${i.id})`).join(', ')}`);
      }
      
      return filtered;
    }
    
    // Priority 2: Use name filter if provided
    if (this.config.installationFilter && this.config.installationFilter.trim() !== '') {
      const filterTerm = this.config.installationFilter.trim().toLowerCase();
      this.log.info(`Filtering installations by name containing: "${filterTerm}"`);
      
      const filtered = installations.filter(installation => {
        const installationName = installation.description.toLowerCase();
        const matches = installationName.includes(filterTerm);
        
        if (this.config.debug) {
          this.log.debug(`Installation "${installation.description}" ${matches ? 'matches' : 'does not match'} filter "${filterTerm}"`);
        }
        
        return matches;
      });
      
      if (filtered.length === 0) {
        this.log.warn(`No installations found matching filter: "${this.config.installationFilter}"`);
        this.log.warn(`Available installations: ${installations.map(i => i.description).join(', ')}`);
        this.log.warn('Check your installationFilter setting or remove it to show all installations');
      }
      
      return filtered;
    }
    
    // Priority 3: No filter - return all installations
    this.log.info('No installation filter configured - showing all installations');
    return installations;
  }

  async setupDeviceAccessories(installation: ViessmannInstallation, gateway: ViessmannGateway, device: ViessmannDevice) {
    try {
      const features = await this.viessmannAPI.getDeviceFeatures(
        installation.id,
        gateway.serial,
        device.id
      );

      // Setup Boiler accessory
      await this.setupBoilerAccessory(installation, gateway, device, features);

      // Setup DHW (Domestic Hot Water) accessory
      await this.setupDHWAccessory(installation, gateway, device, features);

      // Setup Heating Circuits accessories
      await this.setupHeatingCircuitAccessories(installation, gateway, device, features);

    } catch (error) {
      this.log.error(`Failed to setup accessories for device ${device.id}:`, error);
    }
  }

  async setupBoilerAccessory(
    installation: ViessmannInstallation,
    gateway: ViessmannGateway,
    device: ViessmannDevice,
    features: ViessmannFeature[]
  ) {
    const boilerFeatures = features.filter(f => 
      f.feature.includes('heating.boiler') || 
      f.feature.includes('heating.burners')
    );

    if (boilerFeatures.length === 0) {
      return;
    }

    const uuid = this.api.hap.uuid.generate(`${installation.id}-${gateway.serial}-${device.id}-boiler`);
    const displayName = `${installation.description} Boiler`;

    const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

    if (existingAccessory) {
      this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
      new ViessmannBoilerAccessory(this, existingAccessory, installation, gateway, device);
    } else {
      this.log.info('Adding new accessory:', displayName);
      const accessory = new this.api.platformAccessory(displayName, uuid);
      accessory.context.device = device;
      accessory.context.installation = installation;
      accessory.context.gateway = gateway;

      new ViessmannBoilerAccessory(this, accessory, installation, gateway, device);
      this.api.registerPlatformAccessories(PLUGIN_NAME, 'ViessmannPlatform', [accessory]);
    }
  }

  async setupDHWAccessory(
    installation: ViessmannInstallation,
    gateway: ViessmannGateway,
    device: ViessmannDevice,
    features: ViessmannFeature[]
  ) {
    const dhwFeatures = features.filter(f => f.feature.includes('heating.dhw'));

    if (dhwFeatures.length === 0) {
      return;
    }

    const uuid = this.api.hap.uuid.generate(`${installation.id}-${gateway.serial}-${device.id}-dhw`);
    const displayName = `${installation.description} Hot Water`;

    const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

    if (existingAccessory) {
      this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
      new ViessmannDHWAccessory(this, existingAccessory, installation, gateway, device);
    } else {
      this.log.info('Adding new accessory:', displayName);
      const accessory = new this.api.platformAccessory(displayName, uuid);
      accessory.context.device = device;
      accessory.context.installation = installation;
      accessory.context.gateway = gateway;

      new ViessmannDHWAccessory(this, accessory, installation, gateway, device);
      this.api.registerPlatformAccessories(PLUGIN_NAME, 'ViessmannPlatform', [accessory]);
    }
  }

  async setupHeatingCircuitAccessories(
    installation: ViessmannInstallation,
    gateway: ViessmannGateway,
    device: ViessmannDevice,
    features: ViessmannFeature[]
  ) {
    // Find enabled circuits only
    const enabledCircuits = features.filter(f => 
      f.feature.match(/^heating\.circuits\.\d+$/) && 
      f.isEnabled === true
    );

    for (const circuitFeature of enabledCircuits) {
      const match = circuitFeature.feature.match(/heating\.circuits\.(\d+)/);
      if (!match) continue;
      
      const circuitNumber = parseInt(match[1]);
      const uuid = this.api.hap.uuid.generate(`${installation.id}-${gateway.serial}-${device.id}-circuit-${circuitNumber}`);
      const displayName = `${installation.description} Heating Circuit ${circuitNumber}`;

      const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

      if (existingAccessory) {
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
        new ViessmannHeatingCircuitAccessory(this, existingAccessory, installation, gateway, device, circuitNumber);
      } else {
        this.log.info('Adding new accessory:', displayName);
        const accessory = new this.api.platformAccessory(displayName, uuid);
        accessory.context.device = device;
        accessory.context.installation = installation;
        accessory.context.gateway = gateway;
        accessory.context.circuitNumber = circuitNumber;

        new ViessmannHeatingCircuitAccessory(this, accessory, installation, gateway, device, circuitNumber);
        this.api.registerPlatformAccessories(PLUGIN_NAME, 'ViessmannPlatform', [accessory]);
      }
    }
  }

  async updateAllDevices() {
    // Prevent overlapping updates
    if (this.isUpdating) {
      this.log.debug('Skipping update cycle - previous update still in progress');
      return;
    }

    // Check rate limit status before updating
    const rateLimitStatus = this.viessmannAPI.getRateLimitStatus();
    if (rateLimitStatus.isLimited) {
      this.log.warn(`Skipping update cycle: API is rate limited for ${rateLimitStatus.waitSeconds} seconds`);
      this.adjustRefreshInterval(true);
      return;
    }

    this.isUpdating = true;
    this.log.debug('Starting device update cycle...');
    
    let successfulUpdates = 0;
    let rateLimitedUpdates = 0;
    let errorUpdates = 0;
    
    try {
      for (const accessory of this.accessories) {
        try {
          if (accessory.context.device) {
            // Add timeout handling per device
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 25000); // 25s timeout per device
            
            try {
              const features = await this.viessmannAPI.getDeviceFeatures(
                accessory.context.installation.id,
                accessory.context.gateway.serial,
                accessory.context.device.id
              );

              clearTimeout(timeoutId);
              successfulUpdates++;

              // Update accessory based on its type
              const service = accessory.getService(this.Service.Thermostat) || 
                             accessory.getService(this.Service.Switch) ||
                             accessory.getService(this.Service.TemperatureSensor);

              if (service && accessory.context.updateHandler) {
                // Call the update handler if available
                accessory.context.updateHandler(features);
              }
            } catch (error) {
              clearTimeout(timeoutId);
              throw error;
            }
          }
        } catch (error) {
          // Enhanced error handling with rate limit detection
          if (error && typeof error === 'object' && 'message' in error) {
            const errorMessage = (error as { message: string }).message;
            
            if (errorMessage.includes('Rate limited') || errorMessage.includes('429')) {
              rateLimitedUpdates++;
              this.log.warn(`Rate limited updating accessory ${accessory.displayName}`);
              // Break the loop if we hit rate limits to avoid further API calls
              break;
            } else if (errorMessage.includes('ECONNABORTED') || errorMessage.includes('ABORT_ERR')) {
              this.log.warn(`Timeout updating accessory ${accessory.displayName} - API may be slow, will retry next cycle`);
              errorUpdates++;
            } else {
              this.log.error(`Failed to update accessory ${accessory.displayName}: ${errorMessage}`);
              errorUpdates++;
            }
          } else {
            this.log.error(`Failed to update accessory ${accessory.displayName}:`, error);
            errorUpdates++;
          }
        }

        // Add small delay between accessory updates to be gentle on the API
        if (this.config.enableRateLimitProtection !== false) {
          await this.sleep(1000); // 1 second delay between accessories
        }
      }

      // Update statistics and adjust refresh interval if needed
      this.updateCycleComplete(successfulUpdates, rateLimitedUpdates, errorUpdates);

    } catch (error) {
      this.log.error('Error during device update cycle:', error);
      this.adjustRefreshInterval(true);
    } finally {
      this.isUpdating = false;
    }
  }

  private updateCycleComplete(successful: number, rateLimited: number, errors: number) {
    const total = this.accessories.length;
    
    if (rateLimited > 0) {
      this.log.warn(`Update cycle completed: ${successful}/${total} successful, ${rateLimited} rate limited, ${errors} errors`);
      this.adjustRefreshInterval(true);
      this.consecutiveErrors++;
    } else if (errors > total / 2) {
      this.log.warn(`Update cycle completed with many errors: ${successful}/${total} successful, ${errors} errors`);
      this.adjustRefreshInterval(true);
      this.consecutiveErrors++;
    } else {
      this.log.debug(`Update cycle completed: ${successful}/${total} successful, ${errors} errors`);
      // Reset error tracking on successful cycle
      if (successful > 0 && errors === 0) {
        this.consecutiveErrors = 0;
        this.adjustRefreshInterval(false);
      }
    }
  }

  private adjustRefreshInterval(increase: boolean) {
    if (this.config.enableRateLimitProtection === false) {
      return; // Don't adjust if protection is disabled
    }

    if (increase) {
      this.backoffMultiplier = Math.min(this.backoffMultiplier * 1.5, 10); // Max 10x increase
    } else {
      this.backoffMultiplier = Math.max(this.backoffMultiplier * 0.9, 1); // Gradually return to normal
    }

    // Restart timer with new interval if multiplier changed significantly
    if ((increase && this.backoffMultiplier > 2) || (!increase && this.backoffMultiplier < 2)) {
      if (this.refreshTimer) {
        clearInterval(this.refreshTimer);
        this.startRefreshTimer();
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Public method to get rate limit status for diagnostics
  public getRateLimitStatus() {
    return this.viessmannAPI.getRateLimitStatus();
  }

  // Public method to get platform status
  public getPlatformStatus() {
    return {
      isUpdating: this.isUpdating,
      consecutiveErrors: this.consecutiveErrors,
      backoffMultiplier: this.backoffMultiplier,
      accessoryCount: this.accessories.length,
      installationCount: this.installations.length,
      rateLimitStatus: this.getRateLimitStatus()
    };
  }
}