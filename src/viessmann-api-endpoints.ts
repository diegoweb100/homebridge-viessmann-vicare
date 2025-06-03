import { Logger } from 'homebridge';
import { APIClient } from './api-client';

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

interface ViessmannAPIResponse<T> {
  data: T;
}

export class ViessmannAPIEndpoints {
  constructor(
    private readonly log: Logger,
    private readonly apiClient: APIClient
  ) {}

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

  async setDHWTemperature(installationId: number, gatewaySerial: string, deviceId: string, temperature: number): Promise<boolean> {
    const success = await this.executeCommand(
      installationId,
      gatewaySerial,
      deviceId,
      'heating.dhw.temperature.main',
      'setTargetTemperature',
      { temperature }
    );
    
    // Invalidate DHW-related cache
    if (success) {
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
    
    // Invalidate circuit-related cache
    if (success) {
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
    
    // Invalidate circuit operating modes cache
    if (success) {
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
    
    // Invalidate circuit programs cache
    if (success) {
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
    
    // Invalidate holiday programs cache
    if (success) {
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
    
    // Invalidate holiday programs cache
    if (success) {
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
    
    // Invalidate DHW modes cache
    if (success) {
      this.apiClient.clearCache('heating.dhw.operating.modes');
    }
    
    return success;
  }
}