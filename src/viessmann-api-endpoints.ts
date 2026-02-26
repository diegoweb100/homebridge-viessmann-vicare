import { Logger } from 'homebridge';
import { APIClient } from './api-client';
import { BURNER_UPDATE_CONFIG } from './settings';

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

// 🆕 NEW: Interface for burner status
export interface BurnerStatus {
  burnerActive: boolean;
  modulation: number;
  boilerTemp: number;
  dhwActive: boolean;
  timestamp: number;
  supplyTemp?: number;
  pressure?: number;
}

interface ViessmannAPIResponse<T> {
  data: T;
}

export class ViessmannAPIEndpoints {
  // 🆕 NEW: Callback for burner status updates
  private burnerUpdateCallback?: (
    installationId: number,
    gatewaySerial: string,
    deviceId: string,
    status: BurnerStatus,
    reason: string
  ) => void;

  constructor(
    private readonly log: Logger,
    private readonly apiClient: APIClient
  ) {}

  // 🆕 NEW: Set callback for burner status updates
  public setBurnerUpdateCallback(
    callback: (
      installationId: number,
      gatewaySerial: string,
      deviceId: string,
      status: BurnerStatus,
      reason: string
    ) => void
  ): void {
    this.burnerUpdateCallback = callback;
  }

  async getInstallations(): Promise<ViessmannInstallation[]> {
    const response = await this.apiClient.get<ViessmannAPIResponse<any[]>>(
      '/iot/v2/equipment/installations?includeGateways=true'
    );

    // Type assertion with proper error handling
    const responseData = response.data as ViessmannAPIResponse<any[]>;
    if (!responseData || !responseData.data || !Array.isArray(responseData.data)) {
      this.log.error('Invalid installations response format:', responseData);
      throw new Error('Invalid installations response format');
    }

    const installations: ViessmannInstallation[] = responseData.data.map((installation: any) => {
      // Get gateways for this installation
      const gateways = installation.gateways || [];
      
      return {
        id: installation.id,
        description: installation.description || `Installation ${installation.id}`,
        gateways: gateways.map((gateway: any) => ({
          serial: gateway.serial,
          devices: [], // Will be populated by getGatewayDevices
        })),
      };
    });

    // Get devices for each gateway (these will be cached individually)
    for (const installation of installations) {
      for (const gateway of installation.gateways) {
        try {
          gateway.devices = await this.getGatewayDevices(installation.id, gateway.serial);
        } catch (error) {
          this.log.warn(`⚠️ Failed to get devices for gateway ${gateway.serial}:`, error);
          gateway.devices = []; // Continue with empty devices array
        }
      }
    }

    return installations;
  }

  async getGatewayDevices(installationId: number, gatewaySerial: string): Promise<ViessmannDevice[]> {
    const response = await this.apiClient.get<ViessmannAPIResponse<any[]>>(
      `/iot/v2/equipment/installations/${installationId}/gateways/${gatewaySerial}/devices`
    );

    // Type assertion with proper error handling
    const responseData = response.data as ViessmannAPIResponse<any[]>;
    if (!responseData || !responseData.data || !Array.isArray(responseData.data)) {
      this.log.error('Invalid devices response format:', responseData);
      throw new Error('Invalid devices response format');
    }

    return responseData.data.map((device: any) => ({
      id: device.id,
      deviceType: device.deviceType,
      modelId: device.modelId,
      status: device.status,
      gatewaySerial: device.gatewaySerial,
    }));
  }

  async getDeviceFeatures(installationId: number, gatewaySerial: string, deviceId: string): Promise<ViessmannFeature[]> {
    const response = await this.apiClient.get<any>(
      `/iot/v2/features/installations/${installationId}/gateways/${gatewaySerial}/devices/${deviceId}/features`
    );

    // The response.data should be a JSON string that needs parsing
    let featuresData;
    if (typeof response.data === 'string') {
      try {
        featuresData = JSON.parse(response.data);
      } catch (error) {
        this.log.error('Failed to parse features response as JSON:', error);
        throw new Error('Invalid features response format');
      }
    } else {
      featuresData = response.data;
    }

    // Convert the features object to array
    const features: ViessmannFeature[] = [];
    
    if (featuresData && featuresData.data && Array.isArray(featuresData.data)) {
      features.push(...featuresData.data);
    } else if (typeof featuresData === 'object' && featuresData !== null) {
      // Handle case where features are returned as object properties
      for (const [featureName, featureData] of Object.entries(featuresData)) {
        if (typeof featureData === 'object' && featureData !== null) {
          features.push({
            feature: featureName,
            properties: (featureData as any).properties || {},
            commands: (featureData as any).commands || {},
            isEnabled: (featureData as any).isEnabled || true,
            isReady: (featureData as any).isReady || true,
            timestamp: (featureData as any).timestamp || new Date().toISOString(),
          });
        }
      }
    }

    return features;
  }

  // 🆕 NEW: Get only burner-related features for quick status updates
  async getBurnerStatus(installationId: number, gatewaySerial: string, deviceId: string): Promise<BurnerStatus> {
    try {
      // Get specific burner-related features with a targeted request
      const features = await this.getDeviceFeatures(installationId, gatewaySerial, deviceId);
      
      // Extract burner status from features
      const burnerFeature = features.find(f => f.feature === 'heating.burners.0');
      const modulationFeature = features.find(f => f.feature === 'heating.burners.0.modulation');
      const boilerTempFeature = features.find(f => 
        f.feature === 'heating.boiler.sensors.temperature.commonSupply' ||
        f.feature === 'heating.boiler.temperature'
      );
      const dhwModeFeature = features.find(f => f.feature === 'heating.dhw.operating.modes.active');
      const supplyTempFeature = features.find(f => 
        f.feature === 'heating.circuits.0.sensors.temperature.supply'
      );
      const pressureFeature = features.find(f => 
        f.feature === 'heating.sensors.pressure.supply' ||
        f.feature === 'heating.boiler.sensors.pressure.supply'
      );

      const burnerStatus: BurnerStatus = {
        burnerActive: burnerFeature?.properties?.active?.value || false,
        modulation: modulationFeature?.properties?.value?.value || 0,
        boilerTemp: boilerTempFeature?.properties?.value?.value || 0,
        dhwActive: dhwModeFeature?.properties?.value?.value !== 'off',
        timestamp: Date.now(),
        supplyTemp: supplyTempFeature?.properties?.value?.value,
        pressure: pressureFeature?.properties?.value?.value,
      };

      this.log.debug(`🔥 Burner status retrieved: Active=${burnerStatus.burnerActive}, Modulation=${burnerStatus.modulation}%, BoilerTemp=${burnerStatus.boilerTemp}°C, DHW=${burnerStatus.dhwActive}`);
      
      return burnerStatus;

    } catch (error) {
      this.log.error(`Failed to get burner status for device ${deviceId}:`, error);
      
      // Return default status on error
      return {
        burnerActive: false,
        modulation: 0,
        boilerTemp: 0,
        dhwActive: false,
        timestamp: Date.now(),
      };
    }
  }

  async getFeature(installationId: number, gatewaySerial: string, deviceId: string, featureName: string): Promise<ViessmannFeature | null> {
    try {
      const response = await this.apiClient.get<any>(
        `/iot/v2/features/installations/${installationId}/gateways/${gatewaySerial}/devices/${deviceId}/features/${featureName}`
      );

      let featureData;
      if (typeof response.data === 'string') {
        try {
          featureData = JSON.parse(response.data);
        } catch (error) {
          this.log.error('Failed to parse feature response as JSON:', error);
          return null;
        }
      } else {
        featureData = response.data;
      }

      if (featureData && featureData.data) {
        return {
          feature: featureName,
          properties: featureData.data.properties || {},
          commands: featureData.data.commands || {},
          isEnabled: featureData.data.isEnabled || true,
          isReady: featureData.data.isReady || true,
          timestamp: featureData.data.timestamp || new Date().toISOString(),
        };
      }

      return null;

    } catch (error) {
      this.log.error(`❌ Failed to get feature ${featureName}:`, error);
      return null;
    }
  }

  async executeCommand(
    installationId: number,
    gatewaySerial: string,
    deviceId: string,
    featureName: string,
    commandName: string,
    params: any = {}
  ): Promise<boolean> {
    try {
      // Commands are never cached, always execute fresh
      const response = await this.apiClient.post(
        `/iot/v2/features/installations/${installationId}/gateways/${gatewaySerial}/devices/${deviceId}/features/${featureName}/commands/${commandName}`,
        params,
        {
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );

      const success = response.status === 200 || response.status === 202;
      
      if (success) {
        // Invalidate related cache entries after successful command
        this.apiClient.clearCache(`/features/installations/${installationId}/gateways/${gatewaySerial}/devices/${deviceId}`);
        this.log.debug(`🗑️ Cache invalidated for device ${deviceId} after command execution`);
      }

      return success;

    } catch (error) {
      this.log.error(`❌ Failed to execute command ${commandName} on feature ${featureName}:`, error);
      return false;
    }
  }

  // 🆕 NEW: Schedule a delayed burner update and notify platform
  private async scheduleDelayedBurnerUpdate(
    installationId: number, 
    gatewaySerial: string, 
    deviceId: string, 
    delayMs: number,
    reason: string
  ): Promise<void> {
    if (!this.burnerUpdateCallback) {
      this.log.debug('🔥 No burner update callback registered, skipping immediate update');
      return;
    }

	setTimeout(async () => {
	  try {
		this.log.debug(`🔥 Executing delayed burner update for device ${deviceId} (reason: ${reason})`);
		
		const burnerStatus = await this.getBurnerStatus(installationId, gatewaySerial, deviceId);
		
		// Notify platform via callback (with null check)
		if (this.burnerUpdateCallback) {
		  this.burnerUpdateCallback(installationId, gatewaySerial, deviceId, burnerStatus, reason);
		}
		
	  } catch (error) {
		this.log.warn('Delayed burner status update failed:', error);
	  }
	}, delayMs);
  }

  // 🔧 ENHANCED: Modified command execution methods with immediate burner update
  async setDHWTemperature(installationId: number, gatewaySerial: string, deviceId: string, temperature: number): Promise<boolean> {
    const success = await this.executeCommand(
      installationId,
      gatewaySerial,
      deviceId,
      'heating.dhw.temperature.main',
      'setTargetTemperature',
      { temperature }
    );
    
    if (success) {
      // 🆕 NEW: Schedule immediate burner status check after DHW command
      this.log.debug('🔥 Scheduling burner status check after DHW temperature command...');
      await this.scheduleDelayedBurnerUpdate(
        installationId, 
        gatewaySerial, 
        deviceId, 
        BURNER_UPDATE_CONFIG.delays.dhwTemperatureChange,
        `DHW temperature change: ${temperature}°C`
      );
      
      // Invalidate DHW-related cache
      this.apiClient.clearCache('heating.dhw');
    }
    
    return success;
  }

  async setHeatingCircuitTemperature(
    installationId: number,
    gatewaySerial: string,
    deviceId: string,
    circuitNumber: number,
    temperature: number
  ): Promise<boolean> {
    const success = await this.executeCommand(
      installationId,
      gatewaySerial,
      deviceId,
      `heating.circuits.${circuitNumber}.heating.curve`,
      'setCurve',
      { temperature }
    );
    
    if (success) {
      // 🆕 NEW: Schedule immediate burner status check after circuit temperature command
      this.log.debug('🔥 Scheduling burner status check after heating circuit temperature command...');
      await this.scheduleDelayedBurnerUpdate(
        installationId, 
        gatewaySerial, 
        deviceId, 
        BURNER_UPDATE_CONFIG.delays.heatingTemperatureChange,
        `HC${circuitNumber} temperature change: ${temperature}°C`
      );
      
      // Invalidate circuit-related cache
      this.apiClient.clearCache(`heating.circuits.${circuitNumber}`);
    }
    
    return success;
  }

  async setOperatingMode(
    installationId: number,
    gatewaySerial: string,
    deviceId: string,
    circuitNumber: number,
    mode: string
  ): Promise<boolean> {
    const success = await this.executeCommand(
      installationId,
      gatewaySerial,
      deviceId,
      `heating.circuits.${circuitNumber}.operating.modes.active`,
      'setMode',
      { mode }
    );
    
    if (success) {
      // 🆕 NEW: Schedule immediate burner status check after operating mode change
      this.log.debug('🔥 Scheduling burner status check after operating mode change...');
      await this.scheduleDelayedBurnerUpdate(
        installationId, 
        gatewaySerial, 
        deviceId, 
        BURNER_UPDATE_CONFIG.delays.heatingModeChange,
        `HC${circuitNumber} mode change: ${mode}`
      );
      
      // Invalidate circuit operating modes cache
      this.apiClient.clearCache(`heating.circuits.${circuitNumber}.operating`);
    }
    
    return success;
  }

  async setTemperatureProgram(
    installationId: number,
    gatewaySerial: string,
    deviceId: string,
    circuitNumber: number,
    program: string,
    temperature?: number
  ): Promise<boolean> {
    const commandData: any = { program };
    if (temperature !== undefined) {
      commandData.temperature = temperature;
    }

    const success = await this.executeCommand(
      installationId,
      gatewaySerial,
      deviceId,
      `heating.circuits.${circuitNumber}.operating.programs.active`,
      'setProgram',
      commandData
    );
    
    if (success) {
      // 🆕 NEW: Schedule immediate burner status check after program change
      this.log.debug('🔥 Scheduling burner status check after temperature program change...');
      await this.scheduleDelayedBurnerUpdate(
        installationId, 
        gatewaySerial, 
        deviceId, 
        BURNER_UPDATE_CONFIG.delays.programChange,
        `HC${circuitNumber} program change: ${program}${temperature ? ` (${temperature}°C)` : ''}`
      );
      
      // Invalidate circuit programs cache
      this.apiClient.clearCache(`heating.circuits.${circuitNumber}.operating.programs`);
    }
    
    return success;
  }

  async activateHolidayMode(
    installationId: number,
    gatewaySerial: string,
    deviceId: string,
    circuitNumber: number,
    startDate: Date,
    endDate: Date
  ): Promise<boolean> {
    const success = await this.executeCommand(
      installationId,
      gatewaySerial,
      deviceId,
      `heating.circuits.${circuitNumber}.operating.programs.holiday`,
      'schedule',
      {
        start: startDate.toISOString().split('T')[0],
        end: endDate.toISOString().split('T')[0]
      }
    );
    
    if (success) {
      // 🆕 NEW: Schedule immediate burner status check after holiday mode activation
      this.log.debug('🔥 Scheduling burner status check after holiday mode activation...');
      await this.scheduleDelayedBurnerUpdate(
        installationId, 
        gatewaySerial, 
        deviceId, 
        BURNER_UPDATE_CONFIG.delays.holidayModeChange,
        `HC${circuitNumber} holiday mode activated`
      );
      
      // Invalidate holiday programs cache
      this.apiClient.clearCache(`heating.circuits.${circuitNumber}.operating.programs.holiday`);
    }
    
    return success;
  }

  async deactivateHolidayMode(
    installationId: number,
    gatewaySerial: string,
    deviceId: string,
    circuitNumber: number
  ): Promise<boolean> {
    const success = await this.executeCommand(
      installationId,
      gatewaySerial,
      deviceId,
      `heating.circuits.${circuitNumber}.operating.programs.holiday`,
      'unschedule',
      {}
    );
    
    if (success) {
      // 🆕 NEW: Schedule immediate burner status check after holiday mode deactivation
      this.log.debug('🔥 Scheduling burner status check after holiday mode deactivation...');
      await this.scheduleDelayedBurnerUpdate(
        installationId, 
        gatewaySerial, 
        deviceId, 
        BURNER_UPDATE_CONFIG.delays.holidayModeChange,
        `HC${circuitNumber} holiday mode deactivated`
      );
      
      // Invalidate holiday programs cache
      this.apiClient.clearCache(`heating.circuits.${circuitNumber}.operating.programs.holiday`);
    }
    
    return success;
  }

  async setDHWMode(
    installationId: number,
    gatewaySerial: string,
    deviceId: string,
    mode: string
  ): Promise<boolean> {
    const success = await this.executeCommand(
      installationId,
      gatewaySerial,
      deviceId,
      'heating.dhw.operating.modes.active',
      'setMode',
      { mode }
    );
    
    if (success) {
      // 🆕 NEW: Schedule immediate burner status check after DHW mode change
      this.log.debug('🔥 Scheduling burner status check after DHW mode change...');
      await this.scheduleDelayedBurnerUpdate(
        installationId, 
        gatewaySerial, 
        deviceId, 
        BURNER_UPDATE_CONFIG.delays.dhwModeChange,
        `DHW mode change: ${mode}`
      );
      
      // Invalidate DHW modes cache
      this.apiClient.clearCache('heating.dhw.operating.modes');
    }
    
    return success;
  }

  // 🆕 NEW: Enhanced command for extended heating (comfort program) with burner update
  async setExtendedHeatingMode(
    installationId: number,
    gatewaySerial: string,
    deviceId: string,
    circuitNumber: number,
    activate: boolean,
    temperature?: number
  ): Promise<boolean> {
    const commandName = activate ? 'activate' : 'deactivate';
    const commandData = activate && temperature ? { temperature } : {};

    const success = await this.executeCommand(
      installationId,
      gatewaySerial,
      deviceId,
      `heating.circuits.${circuitNumber}.operating.programs.comfort`,
      commandName,
      commandData
    );
    
    if (success) {
      // 🆕 NEW: Schedule immediate burner status check after extended heating change
      this.log.debug('🔥 Scheduling burner status check after extended heating change...');
      await this.scheduleDelayedBurnerUpdate(
        installationId, 
        gatewaySerial, 
        deviceId, 
        BURNER_UPDATE_CONFIG.delays.extendedHeatingChange,
        `HC${circuitNumber} extended heating ${activate ? 'activated' : 'deactivated'}${temperature ? ` (${temperature}°C)` : ''}`
      );
      
      // Invalidate comfort programs cache
      this.apiClient.clearCache(`heating.circuits.${circuitNumber}.operating.programs.comfort`);
    }
    
    return success;
  }

  // 🆕 NEW: Manual burner status refresh (for platform use)
  async refreshBurnerStatus(
    installationId: number,
    gatewaySerial: string,
    deviceId: string,
    reason: string = 'Manual refresh'
  ): Promise<BurnerStatus | null> {
    try {
      this.log.debug(`🔥 Manual burner status refresh for device ${deviceId} (reason: ${reason})`);
      
      const burnerStatus = await this.getBurnerStatus(installationId, gatewaySerial, deviceId);
      
      // Notify platform if callback is available
      if (this.burnerUpdateCallback) {
        this.burnerUpdateCallback(installationId, gatewaySerial, deviceId, burnerStatus, reason);
      }
      
      return burnerStatus;
      
    } catch (error) {
      this.log.error(`Failed manual burner status refresh for device ${deviceId}:`, error);
      return null;
    }
  }

  // 🆕 NEW: Check if device supports burner monitoring
  async checkBurnerSupport(installationId: number, gatewaySerial: string, deviceId: string): Promise<{
    hasMainBurner: boolean;
    hasModulation: boolean;
    hasStatistics: boolean;
    hasTemperatureSensors: boolean;
    supportedFeatures: string[];
  }> {
    try {
      const features = await this.getDeviceFeatures(installationId, gatewaySerial, deviceId);
      
      const burnerFeatures = features.filter(f => f.feature.includes('heating.burners'));
      const hasMainBurner = features.some(f => f.feature === 'heating.burners.0');
      const hasModulation = features.some(f => f.feature === 'heating.burners.0.modulation');
      const hasStatistics = features.some(f => f.feature === 'heating.burners.0.statistics');
      const hasTemperatureSensors = features.some(f => 
        f.feature.includes('heating.boiler.sensors.temperature') ||
        f.feature.includes('heating.circuits.0.sensors.temperature')
      );
      
      const supportedFeatures = burnerFeatures.map(f => f.feature);
      
      this.log.debug(`🔥 Burner support check for device ${deviceId}: MainBurner=${hasMainBurner}, Modulation=${hasModulation}, Statistics=${hasStatistics}, TempSensors=${hasTemperatureSensors}`);
      
      return {
        hasMainBurner,
        hasModulation,
        hasStatistics,
        hasTemperatureSensors,
        supportedFeatures
      };
      
    } catch (error) {
      this.log.error(`Failed to check burner support for device ${deviceId}:`, error);
      
      return {
        hasMainBurner: false,
        hasModulation: false,
        hasStatistics: false,
        hasTemperatureSensors: false,
        supportedFeatures: []
      };
    }
  }
}