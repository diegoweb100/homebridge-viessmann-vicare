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

import * as path from 'path';
import { ViessmannAPI, ViessmannPlatformConfig } from './viessmann-api';
// Export types from viessmann-api-endpoints for accessories
export { ViessmannInstallation, ViessmannFeature, ViessmannGateway, ViessmannDevice, BurnerStatus } from './viessmann-api-endpoints';
export { ViessmannPlatformConfig } from './viessmann-api';
import { ViessmannInstallation, ViessmannFeature, ViessmannGateway, ViessmannDevice, BurnerStatus } from './viessmann-api-endpoints';
import { ViessmannBoilerAccessory } from './accessories/boiler-accessory';
import { ViessmannDHWAccessory } from './accessories/dhw-accessory';
import { ViessmannHeatingCircuitAccessory } from './accessories/heating-circuit-accessory';
import { PLUGIN_NAME, BURNER_UPDATE_CONFIG } from './settings';

export class ViessmannPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: PlatformAccessory[] = [];
  public readonly viessmannAPI: ViessmannAPI;

  private installations: ViessmannInstallation[] = [];
  private refreshTimer?: NodeJS.Timeout;
  private healthMonitoringTimer?: NodeJS.Timeout;
  private isUpdating = false;
  private consecutiveErrors = 0;
  private maxConsecutiveErrors = 5;
  private backoffMultiplier = 1;

  // 🆕 NEW: Burner update system
  private pendingBurnerUpdates: Map<string, NodeJS.Timeout> = new Map();
  private burnerUpdateStats = {
    totalUpdates: 0,
    successfulUpdates: 0,
    failedUpdates: 0,
    lastUpdateTime: 0,
    debounceSkips: 0,
  };

  constructor(
    public readonly log: Logger,
    public readonly config: ViessmannPlatformConfig & PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;
    this.viessmannAPI = new ViessmannAPI(this.log, this.config, path.join(this.api.user.storagePath(), 'viessmann-tokens.json'));

    // 🆕 NEW: Setup burner update callback
    this.setupBurnerUpdateSystem();

    this.log.debug('Finished initializing platform:', this.config.name || 'Viessmann');

    this.api.on(APIEvent.DID_FINISH_LAUNCHING, () => {
      log.debug('Executed didFinishLaunching callback');
      this.discoverDevices();
      
      // Initialize health monitoring
      this.startHealthMonitoring();
    });

    this.api.on(APIEvent.SHUTDOWN, () => {
      if (this.refreshTimer) {
        clearInterval(this.refreshTimer);
      }
      
      // Cleanup health monitoring
      if (this.healthMonitoringTimer) {
        clearInterval(this.healthMonitoringTimer);
      }
      
      // 🆕 NEW: Cleanup burner update system
      this.cleanupBurnerUpdateSystem();
      
      this.viessmannAPI.cleanup();
    });
  }

  // 🆕 NEW: Setup burner update system
  private setupBurnerUpdateSystem(): void {
    // Set callback in API endpoints to receive burner status updates
    this.viessmannAPI.setBurnerUpdateCallback(this.handleBurnerStatusUpdate.bind(this));
    
    this.log.debug('🔥 Burner update system initialized');
  }

  // 🆕 NEW: Handle burner status updates from API
  private async handleBurnerStatusUpdate(
    installationId: number,
    gatewaySerial: string,
    deviceId: string,
    burnerStatus: BurnerStatus,
    reason: string
  ): Promise<void> {
    const updateKey = `${installationId}-${gatewaySerial}-${deviceId}`;
    
    try {
      // 🛡️ Debounce multiple updates for the same device
      if (this.pendingBurnerUpdates.has(updateKey)) {
        if (BURNER_UPDATE_CONFIG.debounce.enabled) {
          clearTimeout(this.pendingBurnerUpdates.get(updateKey)!);
          this.burnerUpdateStats.debounceSkips++;
          this.log.debug(`🔥 Debouncing burner update for device ${deviceId} (reason: ${reason})`);
        }
      }

      const timeoutId = setTimeout(async () => {
        try {
          this.log.debug(`🔥 Processing burner update for device ${deviceId} (reason: ${reason})`);
          
          // Find and update affected accessories
          await this.updateAccessoriesWithBurnerStatus(installationId, gatewaySerial, deviceId, burnerStatus, reason);
          
          this.burnerUpdateStats.successfulUpdates++;
          this.burnerUpdateStats.lastUpdateTime = Date.now();
          this.pendingBurnerUpdates.delete(updateKey);
          
        } catch (error) {
          this.log.error(`Failed to process burner update for device ${deviceId}:`, error);
          this.burnerUpdateStats.failedUpdates++;
          this.pendingBurnerUpdates.delete(updateKey);
        }
      }, BURNER_UPDATE_CONFIG.debounce.enabled ? BURNER_UPDATE_CONFIG.debounce.windowMs : 0);

      this.pendingBurnerUpdates.set(updateKey, timeoutId);
      this.burnerUpdateStats.totalUpdates++;
      
    } catch (error) {
      this.log.error(`Error handling burner status update for device ${deviceId}:`, error);
    }
  }

  // 🆕 NEW: Update accessories with fresh burner status
  private async updateAccessoriesWithBurnerStatus(
    installationId: number,
    gatewaySerial: string,
    deviceId: string,
    burnerStatus: BurnerStatus,
    reason: string
  ): Promise<void> {
    // Find accessories for this device
    const affectedAccessories = this.accessories.filter(accessory => 
      accessory.context.installation?.id === installationId &&
      accessory.context.gateway?.serial === gatewaySerial &&
      accessory.context.device?.id === deviceId
    );

    let updatedCount = 0;

    for (const accessory of affectedAccessories) {
      try {
        // Determine accessory type and update accordingly
        const isBoilerAccessory = accessory.UUID.includes('-boiler');
        const isDHWAccessory = accessory.UUID.includes('-dhw');
        const isHeatingCircuitAccessory = accessory.UUID.includes('-circuit');
        
        if (isBoilerAccessory) {
          await this.updateBoilerAccessoryBurnerStatus(accessory, burnerStatus);
          updatedCount++;
        } else if (isDHWAccessory) {
          await this.updateDHWAccessoryBurnerStatus(accessory, burnerStatus);
          updatedCount++;
        } else if (isHeatingCircuitAccessory) {
          await this.updateHeatingCircuitAccessoryBurnerStatus(accessory, burnerStatus);
          updatedCount++;
        }
        
        this.log.debug(`🔥 Updated ${accessory.displayName} with fresh burner status`);
        
      } catch (error) {
        this.log.error(`Failed to update accessory ${accessory.displayName} with burner status:`, error);
      }
    }
    
    if (updatedCount > 0) {
      this.log.info(`🔥 IMMEDIATE UPDATE: Burner ${burnerStatus.burnerActive ? 'ACTIVATED' : 'DEACTIVATED'} (${burnerStatus.modulation}% modulation) - Updated ${updatedCount} accessories (reason: ${reason})`);
    }
  }

  // 🆕 NEW: Update boiler accessory with immediate burner status
  private async updateBoilerAccessoryBurnerStatus(
    accessory: PlatformAccessory,
    burnerStatus: BurnerStatus
  ): Promise<void> {
    // Find HeaterCooler service
    const heaterCoolerService = accessory.getService(this.Service.HeaterCooler);
    if (heaterCoolerService) {
      // Update Active state
      heaterCoolerService.updateCharacteristic(
        this.Characteristic.Active,
        burnerStatus.burnerActive ? 
          this.Characteristic.Active.ACTIVE : 
          this.Characteristic.Active.INACTIVE
      );
      
      // Update CurrentHeaterCoolerState
      heaterCoolerService.updateCharacteristic(
        this.Characteristic.CurrentHeaterCoolerState,
        burnerStatus.burnerActive ? 
          this.Characteristic.CurrentHeaterCoolerState.HEATING : 
          this.Characteristic.CurrentHeaterCoolerState.INACTIVE
      );
      
      // Update temperature if available
      if (burnerStatus.boilerTemp > 0) {
        heaterCoolerService.updateCharacteristic(
          this.Characteristic.CurrentTemperature,
          burnerStatus.boilerTemp
        );
      }
    }

    // Find Burner Switch service (if exists)
    const burnerSwitchService = accessory.services.find(service => 
      service.UUID === this.Service.Switch.UUID && 
      service.subtype?.includes('burner')
    );
    
    if (burnerSwitchService) {
      burnerSwitchService.updateCharacteristic(
        this.Characteristic.On,
        burnerStatus.burnerActive
      );
    }

    // Find Modulation Lightbulb service (if exists)
    const modulationService = accessory.services.find(service => 
      service.UUID === this.Service.Lightbulb.UUID && 
      service.subtype?.includes('modulation')
    );
    
    if (modulationService) {
      modulationService.updateCharacteristic(
        this.Characteristic.On,
        burnerStatus.modulation > 0
      );
      
      modulationService.updateCharacteristic(
        this.Characteristic.Brightness,
        burnerStatus.modulation
      );
    }

    // 🆕 NEW: Update diagnostic services if they exist
    
    // Update Burner Activity Contact Sensor
    const burnerActivityService = accessory.services.find(service => 
      service.UUID === this.Service.ContactSensor.UUID && 
      service.subtype?.includes('burner-activity')
    );
    
    if (burnerActivityService) {
      burnerActivityService.updateCharacteristic(
        this.Characteristic.ContactSensorState,
        burnerStatus.burnerActive ? 
          this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED : // Open = Active
          this.Characteristic.ContactSensorState.CONTACT_DETECTED       // Closed = Inactive
      );
    }

    // Update Outside Temperature if available
    if (burnerStatus.supplyTemp && burnerStatus.supplyTemp > 0) {
      const outsideTempService = accessory.services.find(service => 
        service.UUID === this.Service.TemperatureSensor.UUID && 
        service.subtype?.includes('outside-temp')
      );
      
      if (outsideTempService) {
        outsideTempService.updateCharacteristic(
          this.Characteristic.CurrentTemperature,
          burnerStatus.supplyTemp
        );
      }
    }

    // Update Water Pressure if available
    if (burnerStatus.pressure && burnerStatus.pressure > 0) {
      const waterPressureService = accessory.services.find(service => 
        service.UUID === this.Service.LeakSensor.UUID && 
        service.subtype?.includes('water-pressure')
      );
      
      if (waterPressureService) {
        const isOptimal = burnerStatus.pressure >= 1.0 && burnerStatus.pressure <= 2.5;
        
        waterPressureService.updateCharacteristic(
          this.Characteristic.LeakDetected,
          isOptimal ? 
            this.Characteristic.LeakDetected.LEAK_NOT_DETECTED :
            this.Characteristic.LeakDetected.LEAK_DETECTED
        );
      }
    }
  }

  // 🆕 NEW: Update DHW accessory with immediate burner status 
  private async updateDHWAccessoryBurnerStatus(
    accessory: PlatformAccessory,
    burnerStatus: BurnerStatus
  ): Promise<void> {
    // Find HeaterCooler service
    const heaterCoolerService = accessory.getService(this.Service.HeaterCooler);
    if (heaterCoolerService) {
      // Update Active state based on DHW mode
      heaterCoolerService.updateCharacteristic(
        this.Characteristic.Active,
        burnerStatus.dhwActive ? 
          this.Characteristic.Active.ACTIVE : 
          this.Characteristic.Active.INACTIVE
      );
      
      // Update CurrentHeaterCoolerState - only show heating if DHW is active AND burner is running
      const isDHWActiveAndBurnerRunning = burnerStatus.dhwActive && burnerStatus.burnerActive;
      
      heaterCoolerService.updateCharacteristic(
        this.Characteristic.CurrentHeaterCoolerState,
        isDHWActiveAndBurnerRunning ? 
          this.Characteristic.CurrentHeaterCoolerState.HEATING : 
          this.Characteristic.CurrentHeaterCoolerState.INACTIVE
      );
    }

    // Update DHW mode switches based on dhwActive status
    const dhwOffService = accessory.services.find(service => 
      service.UUID === this.Service.Switch.UUID && 
      service.subtype?.includes('dhw-off')
    );
    
    if (dhwOffService) {
      dhwOffService.updateCharacteristic(
        this.Characteristic.On,
        !burnerStatus.dhwActive
      );
    }

    // Update other DHW mode switches (comfort/eco) - mark as active if DHW is on
    const dhwModeServices = accessory.services.filter(service => 
      service.UUID === this.Service.Switch.UUID && 
      (service.subtype?.includes('dhw-comfort') || service.subtype?.includes('dhw-eco'))
    );
    
    for (const modeService of dhwModeServices) {
      // If DHW became active and this mode was previously on, keep it on
      // If DHW became inactive, turn off all modes except off
      const currentlyOn = modeService.getCharacteristic(this.Characteristic.On).value as boolean;
      
      if (!burnerStatus.dhwActive && currentlyOn) {
        // DHW turned off, disable this mode
        modeService.updateCharacteristic(this.Characteristic.On, false);
      }
      // If DHW is active, we don't change mode switches as we don't know which specific mode is active
    }
  }

  // 🆕 NEW: Update heating circuit accessory with immediate burner status
  private async updateHeatingCircuitAccessoryBurnerStatus(
    accessory: PlatformAccessory,
    burnerStatus: BurnerStatus
  ): Promise<void> {
    // Find HeaterCooler service
    const heaterCoolerService = accessory.getService(this.Service.HeaterCooler);
    if (heaterCoolerService) {
      // For heating circuits, we mainly update based on burner activity
      // The specific circuit mode logic is too complex for immediate updates
      
      // Update temperature if available
      if (burnerStatus.supplyTemp && burnerStatus.supplyTemp > 0) {
        heaterCoolerService.updateCharacteristic(
          this.Characteristic.CurrentTemperature,
          burnerStatus.supplyTemp
        );
      } else if (burnerStatus.boilerTemp > 0) {
        // Use boiler temp as fallback, but adjust for circuit (rough estimate)
        const estimatedCircuitTemp = Math.max(15, burnerStatus.boilerTemp - 10);
        heaterCoolerService.updateCharacteristic(
          this.Characteristic.CurrentTemperature,
          estimatedCircuitTemp
        );
      }
    }
  }

  // 🆕 NEW: Public method to request immediate burner update (for accessories)
  public requestImmediateBurnerUpdate(
    installationId: number,
    gatewaySerial: string,
    deviceId: string,
    reason: string,
    delayMs: number = BURNER_UPDATE_CONFIG.delays.dhwModeChange
  ): void {
    // Request immediate refresh from API
    this.viessmannAPI.refreshBurnerStatus(installationId, gatewaySerial, deviceId, reason)
      .then(burnerStatus => {
        if (burnerStatus) {
          this.log.debug(`🔥 Immediate burner update completed for device ${deviceId}`);
        }
      })
      .catch(error => {
        this.log.error(`Failed immediate burner update for device ${deviceId}:`, error);
      });
    
    this.log.debug(`🔥 Requested immediate burner update for device ${deviceId} (reason: ${reason}, delay: ${delayMs}ms)`);
  }

  // 🆕 NEW: Cleanup burner update system
  private cleanupBurnerUpdateSystem(): void {
    // Clear all pending burner updates
    for (const [key, timeoutId] of this.pendingBurnerUpdates.entries()) {
      clearTimeout(timeoutId);
    }
    this.pendingBurnerUpdates.clear();
    
    this.log.debug('🔥 Burner update system cleaned up');
  }

  // 🆕 NEW: Get burner update statistics
  public getBurnerUpdateStats(): {
    totalUpdates: number;
    successfulUpdates: number;
    failedUpdates: number;
    successRate: number;
    pendingUpdates: number;
    lastUpdateTime: number;
    debounceSkips: number;
  } {
    const successRate = this.burnerUpdateStats.totalUpdates > 0 ? 
      (this.burnerUpdateStats.successfulUpdates / this.burnerUpdateStats.totalUpdates) * 100 : 0;

    return {
      ...this.burnerUpdateStats,
      successRate,
      pendingUpdates: this.pendingBurnerUpdates.size,
    };
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
    const baseInterval = this.config.refreshInterval || 60000; // Default 1 minute
    let refreshInterval = baseInterval;
    
    if (this.config.enableRateLimitProtection !== false) {
      refreshInterval = Math.max(baseInterval * this.backoffMultiplier, 60000); // min 1 minute
    }

    const intervalSec = Math.round(refreshInterval / 1000);
    const nextAtTime = new Date(Date.now() + refreshInterval).toLocaleTimeString('it-IT');
    this.log.info(`⏱️ Refresh timer started — interval: ${intervalSec}s (backoff: ×${this.backoffMultiplier.toFixed(2)}) | next update at ${nextAtTime}`);
    
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
    const customNames = this.config.customNames || {};
    const boilerName = customNames.boiler || 'Boiler';
    const displayName = `${installation.description} ${boilerName}`;

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
    
    // 🆕 AGGIUNTO: Supporto customNames per DHW
    const customNames = this.config.customNames || {};
    const dhwName = customNames.dhw || 'Hot Water';
    const displayName = `${installation.description} ${dhwName}`;

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
      
      // 🆕 AGGIUNTO: Supporto customNames per Heating Circuit
      const customNames = this.config.customNames || {};
      const heatingCircuitName = customNames.heatingCircuit || 'Heating Circuit';
      const displayName = `${installation.description} ${heatingCircuitName} ${circuitNumber}`;

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
      this.log.debug('⏭️ Skipping update cycle — previous update still in progress');
      return;
    }

    // Check rate limit status before updating
    const rateLimitStatus = this.viessmannAPI.getRateLimitStatus();
    if (rateLimitStatus.isLimited) {
      this.log.warn(`⛔ Skipping update cycle — API rate limited for ${rateLimitStatus.waitSeconds}s`);
      this.adjustRefreshInterval(true);
      return;
    }

    this.isUpdating = true;
    const cycleStart = Date.now();
    this.log.debug('🔄 Starting device update cycle...');

    // FIX#5: Deduplicate API calls — build a map of unique deviceKey → features.
    // Previously we called getDeviceFeatures once per accessory, but Caldaia/ACS/Risc all
    // share the same installation+gateway+device, causing 3 redundant API calls per cycle.
    // Now we fetch features ONCE per device and dispatch to all matching accessories.
    const deviceFeatureCache = new Map<string, any[]>();
    let successfulDevices = 0;
    let rateLimitedDevices = 0;
    let errorDevices = 0;
    let skippedForBurnerUpdates = 0;
    let handlersCalled = 0;
    let handlersSkipped = 0;

    try {
      for (const accessory of this.accessories) {
        if (!accessory.context.device) {
          this.log.debug(`⚠️ Accessory "${accessory.displayName}" has no device context — skipping`);
          continue;
        }

        const deviceKey = `${accessory.context.installation.id}-${accessory.context.gateway.serial}-${accessory.context.device.id}`;

        // Skip if a recent immediate burner update is pending for this device
        const hasRecentBurnerUpdate = this.pendingBurnerUpdates.has(deviceKey);
        if (hasRecentBurnerUpdate && this.config.enableImmediateBurnerUpdates !== false) {
          this.log.debug(`⚡ "${accessory.displayName}" — skipping full update, immediate burner update in progress`);
          skippedForBurnerUpdates++;
          continue;
        }

        try {
          // FIX#5: fetch features only once per unique device, reuse for other accessories
          let features: any[];
          if (deviceFeatureCache.has(deviceKey)) {
            features = deviceFeatureCache.get(deviceKey)!;
            this.log.debug(`📋 "${accessory.displayName}" — using already-fetched features for device ${accessory.context.device.id}`);
          } else {
            this.log.debug(`🌐 "${accessory.displayName}" — fetching features for device ${accessory.context.device.id}...`);
            const timeoutId = setTimeout(() => {
              this.log.warn(`⏱️ API timeout after 25s for device ${accessory.context.device.id}`);
            }, 25000);

            features = await this.viessmannAPI.getDeviceFeatures(
              accessory.context.installation.id,
              accessory.context.gateway.serial,
              accessory.context.device.id
            );
            clearTimeout(timeoutId);
            deviceFeatureCache.set(deviceKey, features);
            successfulDevices++;
            this.log.debug(`✅ Fetched ${features.length} features for device ${accessory.context.device.id}`);

            // Small delay between distinct device API calls only
            if (this.config.enableRateLimitProtection !== false) {
              await this.sleep(500);
            }
          }

          // FIX#1: Call updateHandler directly — no longer gating on service type.
          // Previously the code checked for Thermostat/Switch/TemperatureSensor, but
          // DHW/Boiler/HC all use HeaterCooler as their primary service, so the condition
          // could silently skip the handler if services were mid-recreation during async init.
          if (accessory.context.updateHandler) {
            accessory.context.updateHandler(features);
            handlersCalled++;
            this.log.debug(`📡 "${accessory.displayName}" — updateHandler dispatched`);
          } else {
            handlersSkipped++;
            this.log.warn(`⚠️ "${accessory.displayName}" — updateHandler not set (accessory still initializing?)`);
          }

        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (msg.includes('Rate limited') || msg.includes('429')) {
            rateLimitedDevices++;
            this.log.warn(`🚫 "${accessory.displayName}" — rate limited during update, stopping cycle`);
            break;
          } else if (msg.includes('ECONNABORTED') || msg.includes('ABORT_ERR') || msg.includes('timeout')) {
            this.log.warn(`⏱️ "${accessory.displayName}" — API timeout, will retry next cycle`);
            errorDevices++;
          } else if (msg.includes('401') || msg.includes('403') || msg.includes('Unauthorized')) {
            this.log.error(`🔑 "${accessory.displayName}" — auth error during update (${msg}). Token refresh may be needed.`);
            errorDevices++;
          } else {
            this.log.error(`❌ "${accessory.displayName}" — update failed: ${msg}`);
            errorDevices++;
          }
        }
      }

      const elapsed = Date.now() - cycleStart;
      this.updateCycleComplete(successfulDevices, rateLimitedDevices, errorDevices, skippedForBurnerUpdates, handlersCalled, handlersSkipped, elapsed);

    } catch (error) {
      this.log.error('❌ Fatal error during device update cycle:', error);
      this.adjustRefreshInterval(true);
    } finally {
      this.isUpdating = false;
    }
  }

  private updateCycleComplete(
    successful: number,
    rateLimited: number,
    errors: number,
    skipped: number,
    handlersCalled: number,
    handlersSkipped: number,
    elapsedMs: number
  ) {
    const totalAccessories = this.accessories.length;
    const elapsedSec = (elapsedMs / 1000).toFixed(1);

    if (rateLimited > 0) {
      this.log.warn(`🔄 Update cycle done in ${elapsedSec}s — ${successful} device(s) fetched, ${rateLimited} rate-limited, ${errors} errors | handlers: ${handlersCalled} called, ${handlersSkipped} skipped | accessories: ${totalAccessories}`);
      this.adjustRefreshInterval(true);
      this.consecutiveErrors++;
    } else if (errors > totalAccessories / 2) {
      this.log.warn(`🔄 Update cycle done in ${elapsedSec}s — ${successful} device(s) fetched, ${errors} errors (>50%) | handlers: ${handlersCalled} called | accessories: ${totalAccessories}`);
      this.adjustRefreshInterval(true);
      this.consecutiveErrors++;
    } else {
      // Success path — log at info level so it's visible without debug mode
      const skippedMsg = skipped > 0 ? `, ${skipped} skipped (burner update)` : '';
      const handlersMsg = handlersSkipped > 0 ? ` ⚠️ ${handlersSkipped} handler(s) not set yet` : '';
      this.log.info(`🔄 Update cycle done in ${elapsedSec}s — ${successful} device(s) fetched, ${handlersCalled}/${totalAccessories} accessories updated${skippedMsg}${handlersMsg}`);

      if (successful > 0 && errors === 0) {
        this.consecutiveErrors = 0;
        this.adjustRefreshInterval(false);

        const healthScore = this.viessmannAPI.getAPIHealthScore();
        const healthStatus = this.viessmannAPI.getAPIHealthStatus();
        this.log.debug(`📊 API Health: ${healthScore}/100 (${healthStatus})`);
      }
    }
  }

  private adjustRefreshInterval(increase: boolean) {
    if (this.config.enableRateLimitProtection === false) {
      return;
    }

    const prevMultiplier = this.backoffMultiplier;

    if (increase) {
      this.backoffMultiplier = Math.min(this.backoffMultiplier * 1.5, 10);
    } else {
      // FIX#3: clamp to 1 — multiplier will always be 1 after the first successful cycle,
      // so the old condition (!increase && multiplier < 2) was always true and restarted
      // the timer on every single successful cycle. Now we only restart when the multiplier
      // actually changes by more than 10% from its previous value.
      this.backoffMultiplier = Math.max(this.backoffMultiplier * 0.9, 1);
    }

    const changeRatio = Math.abs(this.backoffMultiplier - prevMultiplier) / Math.max(prevMultiplier, 1);
    const significantChange = changeRatio > 0.1; // >10% change

    if (significantChange && this.refreshTimer) {
      this.log.info(`⏱️ Refresh interval adjusted: backoff ×${prevMultiplier.toFixed(2)} → ×${this.backoffMultiplier.toFixed(2)} (${increase ? 'backing off' : 'recovering'})`);
      clearInterval(this.refreshTimer);
      this.startRefreshTimer();
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Health Monitoring Methods
  private startHealthMonitoring(): void {
    if (!this.config.enableApiMetrics) {
      return;
    }

    // Log health status every hour
    this.healthMonitoringTimer = setInterval(() => {
      this.logSystemHealth();
    }, 60 * 60 * 1000); // 1 hour

    this.log.info('🩺 Health monitoring started - reports every hour');
  }

  private logSystemHealth(): void {
    try {
      const systemStatus = this.viessmannAPI.getSystemStatus();
      const burnerStats = this.getBurnerUpdateStats();
      
      this.log.info('='.repeat(60));
      this.log.info(`${systemStatus.overall.emoji} SYSTEM HEALTH STATUS - ${systemStatus.overall.status} (${systemStatus.overall.score}/100)`);
      this.log.info('='.repeat(60));
      
      // Authentication Status
      this.log.info(`🔐 Authentication: ${systemStatus.authentication.hasTokens ? 'OK' : 'FAILED'}`);
      if (systemStatus.authentication.expiresInSeconds) {
        const hoursRemaining = Math.round(systemStatus.authentication.expiresInSeconds / 3600);
        this.log.info(`   Token expires in: ${hoursRemaining} hours`);
      }
      
      // Rate Limiting Status
      if (systemStatus.rateLimiting.isLimited) {
        this.log.warn(`🛡️ Rate Limited: Wait ${systemStatus.rateLimiting.waitSeconds} seconds`);
        if (systemStatus.rateLimiting.dailyQuotaExceeded) {
          this.log.warn('   Daily quota exceeded - will reset in 24 hours');
        }
      } else {
        this.log.info(`🛡️ Rate Limiting: OK (${systemStatus.rateLimiting.retryCount} total hits)`);
      }
      
      // 🆕 NEW: Burner Update Status
      if (this.config.enableImmediateBurnerUpdates !== false) {
        this.log.info(`🔥 Burner Updates: ${burnerStats.successfulUpdates}/${burnerStats.totalUpdates} successful (${burnerStats.successRate.toFixed(1)}% success rate)`);
        if (burnerStats.pendingUpdates > 0) {
          this.log.info(`   Pending updates: ${burnerStats.pendingUpdates}`);
        }
        if (burnerStats.debounceSkips > 0) {
          this.log.info(`   Debounce optimizations: ${burnerStats.debounceSkips}`);
        }
      }
      
      // Performance Status
      if (systemStatus.performance.issues.length > 0) {
        this.log.warn(`⚠️ Performance Issues (${systemStatus.performance.issues.length}):`);
        systemStatus.performance.issues.forEach(issue => {
          this.log.warn(`   • ${issue}`);
        });
        
        if (systemStatus.performance.recommendations.length > 0) {
          this.log.info(`💡 Recommendations:`);
          systemStatus.performance.recommendations.forEach(rec => {
            this.log.info(`   • ${rec}`);
          });
        }
      } else {
        this.log.info(`⚡ Performance: Excellent (Score: ${systemStatus.performance.healthScore})`);
      }
      
      // Cache Status
      if (systemStatus.cache) {
        const hitRatePercent = (systemStatus.cache.hitRate * 100).toFixed(1);
        const memoryMB = (systemStatus.cache.memoryUsage / 1024 / 1024).toFixed(1);
        this.log.info(`💾 Cache: ${hitRatePercent}% hit rate, ${systemStatus.cache.totalEntries} entries, ${memoryMB}MB`);
      }
      
      // System Summary
      this.log.info(`🏠 Accessories: ${this.accessories.length} total, ${this.installations.length} installations`);
      this.log.info(`🔄 Update Status: ${this.isUpdating ? 'In Progress' : 'Idle'}, Errors: ${this.consecutiveErrors}/${this.maxConsecutiveErrors}`);
      
      this.log.info('='.repeat(60));
      
      // Take action based on health score
      if (systemStatus.overall.score < 50) {
        this.log.error('🚨 CRITICAL: System health is poor - consider immediate optimization');
        this.adjustRefreshInterval(true); // Increase intervals to reduce load
      } else if (systemStatus.overall.score < 70) {
        this.log.warn('⚠️ WARNING: System health is degraded - optimization recommended');
      }
      
    } catch (error) {
      this.log.error('❌ Failed to generate health report:', error);
    }
  }

  // Public method to get rate limit status for diagnostics
  public getRateLimitStatus() {
    return this.viessmannAPI.getRateLimitStatus();
  }

  // Public method to get enhanced platform status
  public getPlatformStatus() {
    const systemStatus = this.viessmannAPI.getSystemStatus();
    const burnerStats = this.getBurnerUpdateStats();
    
    return {
      platform: {
        isUpdating: this.isUpdating,
        consecutiveErrors: this.consecutiveErrors,
        backoffMultiplier: this.backoffMultiplier,
        accessoryCount: this.accessories.length,
        installationCount: this.installations.length,
      },
      burnerUpdates: burnerStats, // 🆕 NEW
      system: systemStatus,
      summary: {
        overallHealth: systemStatus.overall.status,
        healthScore: systemStatus.overall.score,
        isHealthy: systemStatus.overall.score >= 70,
        needsAttention: systemStatus.performance.issues.length > 0,
        recommendations: systemStatus.performance.recommendations
      }
    };
  }
}