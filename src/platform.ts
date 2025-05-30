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

export interface ViessmannPlatformConfig extends PlatformConfig {
  clientId: string;
  clientSecret?: string;
  username: string;
  password: string;
  authMethod?: 'auto' | 'manual';
  accessToken?: string;
  refreshToken?: string;
  refreshInterval?: number;
  debug?: boolean;
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
      await this.viessmannAPI.authenticate();
      this.installations = await this.viessmannAPI.getInstallations();

      for (const installation of this.installations) {
        for (const gateway of installation.gateways) {
          for (const device of gateway.devices) {
            await this.setupDeviceAccessories(installation, gateway, device);
          }
        }
      }

      // Start refresh timer
      const refreshInterval = this.config.refreshInterval || 60000; // Default 1 minute
      this.refreshTimer = setInterval(() => {
        this.updateAllDevices();
      }, refreshInterval);

    } catch (error) {
      this.log.error('Failed to discover devices:', error);
    }
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
      this.api.registerPlatformAccessories('homebridge-viessmann-control', 'ViessmannPlatform', [accessory]);
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
      this.api.registerPlatformAccessories('homebridge-viessmann-control', 'ViessmannPlatform', [accessory]);
    }
  }

  async setupHeatingCircuitAccessories(
    installation: ViessmannInstallation,
    gateway: ViessmannGateway,
    device: ViessmannDevice,
    features: ViessmannFeature[]
  ) {
    const circuitFeatures = features.filter(f => f.feature.match(/heating\.circuits\.\d+/));
    const circuitNumbers = [...new Set(circuitFeatures.map(f => {
      const match = f.feature.match(/heating\.circuits\.(\d+)/);
      return match ? parseInt(match[1]) : null;
    }).filter(n => n !== null))];

    for (const circuitNumber of circuitNumbers) {
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
        this.api.registerPlatformAccessories('homebridge-viessmann-control', 'ViessmannPlatform', [accessory]);
      }
    }
  }

  async updateAllDevices() {
    this.log.debug('Updating all devices...');
    
    for (const accessory of this.accessories) {
      try {
        if (accessory.context.device) {
          const features = await this.viessmannAPI.getDeviceFeatures(
            accessory.context.installation.id,
            accessory.context.gateway.serial,
            accessory.context.device.id
          );

          // Update accessory based on its type
          const service = accessory.getService(this.Service.Thermostat) || 
                         accessory.getService(this.Service.Switch) ||
                         accessory.getService(this.Service.TemperatureSensor);

          if (service && accessory.context.updateHandler) {
            // Call the update handler if available
            accessory.context.updateHandler(features);
          }
        }
      } catch (error) {
        this.log.error(`Failed to update accessory ${accessory.displayName}:`, error);
      }
    }
  }
}