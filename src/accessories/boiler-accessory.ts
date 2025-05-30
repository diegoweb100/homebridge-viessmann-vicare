import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { ViessmannPlatform, ViessmannInstallation, ViessmannGateway, ViessmannDevice } from '../platform';

export class ViessmannBoilerAccessory {
  private service: Service;
  private informationService: Service;

  private states = {
    On: false,
    CurrentTemperature: 20,
    TargetTemperature: 20,
    TemperatureDisplayUnits: 0, // Celsius
    CurrentHeatingCoolingState: 0, // Off
    TargetHeatingCoolingState: 0, // Off
  };

  constructor(
    private readonly platform: ViessmannPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly installation: ViessmannInstallation,
    private readonly gateway: ViessmannGateway,
    private readonly device: ViessmannDevice,
  ) {
    // Set accessory information
    this.informationService = this.accessory.getService(this.platform.Service.AccessoryInformation)!;
    this.informationService
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Viessmann')
      .setCharacteristic(this.platform.Characteristic.Model, device.modelId || 'Boiler')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, gateway.serial)
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, '1.0.0');

    // Get or create the Thermostat service
    this.service = this.accessory.getService(this.platform.Service.Thermostat) || 
                   this.accessory.addService(this.platform.Service.Thermostat);

    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

    // Configure characteristics
    this.setupCharacteristics();

    // Set update handler for platform to call
    this.accessory.context.updateHandler = this.handleUpdate.bind(this);

    // Initial update
    this.updateStatus();
  }

  private setupCharacteristics() {
    // Current Heating Cooling State (read-only)
    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.getCurrentHeatingCoolingState.bind(this));

    // Target Heating Cooling State
    this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .onGet(this.getTargetHeatingCoolingState.bind(this))
      .onSet(this.setTargetHeatingCoolingState.bind(this))
      .setProps({
        validValues: [
          this.platform.Characteristic.TargetHeatingCoolingState.OFF,
          this.platform.Characteristic.TargetHeatingCoolingState.HEAT,
          this.platform.Characteristic.TargetHeatingCoolingState.AUTO,
        ],
      });

    // Current Temperature (read-only)
    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this))
      .setProps({
        minValue: -50,
        maxValue: 150,
        minStep: 0.1,
      });

    // Target Temperature
    this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .onGet(this.getTargetTemperature.bind(this))
      .onSet(this.setTargetTemperature.bind(this))
      .setProps({
        minValue: 10,
        maxValue: 80,
        minStep: 1,
      });

    // Temperature Display Units
    this.service.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onGet(this.getTemperatureDisplayUnits.bind(this))
      .onSet(this.setTemperatureDisplayUnits.bind(this));
  }

  async getCurrentHeatingCoolingState(): Promise<CharacteristicValue> {
    return this.states.CurrentHeatingCoolingState;
  }

  async getTargetHeatingCoolingState(): Promise<CharacteristicValue> {
    return this.states.TargetHeatingCoolingState;
  }

  async setTargetHeatingCoolingState(value: CharacteristicValue) {
    const targetState = value as number;
    this.states.TargetHeatingCoolingState = targetState;

    // Map HomeKit states to Viessmann operating modes
    let mode: string;
    switch (targetState) {
      case this.platform.Characteristic.TargetHeatingCoolingState.OFF:
        mode = 'standby';
        break;
      case this.platform.Characteristic.TargetHeatingCoolingState.HEAT:
        mode = 'heating';
        break;
      case this.platform.Characteristic.TargetHeatingCoolingState.AUTO:
        mode = 'dhwAndHeating';
        break;
      default:
        mode = 'standby';
    }

    try {
      // Set operating mode for circuit 0 (main circuit)
      const success = await this.platform.viessmannAPI.setOperatingMode(
        this.installation.id,
        this.gateway.serial,
        this.device.id,
        0,
        mode
      );

      if (success) {
        this.platform.log.info(`Set boiler operating mode to: ${mode}`);
      } else {
        this.platform.log.error(`Failed to set boiler operating mode to: ${mode}`);
        throw new Error('Failed to set operating mode');
      }
    } catch (error) {
      this.platform.log.error('Error setting target heating cooling state:', error);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async getCurrentTemperature(): Promise<CharacteristicValue> {
    return this.states.CurrentTemperature;
  }

  async getTargetTemperature(): Promise<CharacteristicValue> {
    return this.states.TargetTemperature;
  }

  async setTargetTemperature(value: CharacteristicValue) {
    const temperature = value as number;
    this.states.TargetTemperature = temperature;

    try {
      // Set boiler temperature
      const success = await this.platform.viessmannAPI.executeCommand(
        this.installation.id,
        this.gateway.serial,
        this.device.id,
        'heating.boiler.temperature',
        'setTargetTemperature',
        { temperature }
      );

      if (success) {
        this.platform.log.info(`Set boiler target temperature to: ${temperature}°C`);
      } else {
        this.platform.log.error(`Failed to set boiler target temperature to: ${temperature}°C`);
        throw new Error('Failed to set target temperature');
      }
    } catch (error) {
      this.platform.log.error('Error setting target temperature:', error);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async getTemperatureDisplayUnits(): Promise<CharacteristicValue> {
    return this.states.TemperatureDisplayUnits;
  }

  async setTemperatureDisplayUnits(value: CharacteristicValue) {
    this.states.TemperatureDisplayUnits = value as number;
  }

  private async handleUpdate(features: any[]) {
    try {
      await this.updateFromFeatures(features);
    } catch (error) {
      this.platform.log.error('Error handling update:', error);
    }
  }

  private async updateStatus() {
    try {
      const features = await this.platform.viessmannAPI.getDeviceFeatures(
        this.installation.id,
        this.gateway.serial,
        this.device.id
      );
      
      await this.updateFromFeatures(features);
    } catch (error) {
      this.platform.log.error('Error updating boiler status:', error);
    }
  }

  private async updateFromFeatures(features: any[]) {
    // Update boiler temperature
    const boilerTempFeature = features.find(f => f.feature === 'heating.boiler.sensors.temperature.main');
    if (boilerTempFeature?.properties?.value?.value !== undefined) {
      this.states.CurrentTemperature = boilerTempFeature.properties.value.value;
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.states.CurrentTemperature);
    }

    // Update boiler target temperature
    const boilerTargetTempFeature = features.find(f => f.feature === 'heating.boiler.temperature');
    if (boilerTargetTempFeature?.properties?.value?.value !== undefined) {
      this.states.TargetTemperature = boilerTargetTempFeature.properties.value.value;
      this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, this.states.TargetTemperature);
    }

    // Update operating state based on burner status
    const burnerFeature = features.find(f => f.feature.includes('heating.burners.0'));
    if (burnerFeature?.properties?.active?.value !== undefined) {
      const isActive = burnerFeature.properties.active.value;
      this.states.CurrentHeatingCoolingState = isActive ? 
        this.platform.Characteristic.CurrentHeatingCoolingState.HEAT : 
        this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
      
      this.service.updateCharacteristic(
        this.platform.Characteristic.CurrentHeatingCoolingState, 
        this.states.CurrentHeatingCoolingState
      );
    }

    // Update operating mode
    const operatingModeFeature = features.find(f => f.feature === 'heating.circuits.0.operating.modes.active');
    if (operatingModeFeature?.properties?.value?.value !== undefined) {
      const mode = operatingModeFeature.properties.value.value;
      let targetState: number;
      
      switch (mode) {
        case 'standby':
          targetState = this.platform.Characteristic.TargetHeatingCoolingState.OFF;
          break;
        case 'heating':
          targetState = this.platform.Characteristic.TargetHeatingCoolingState.HEAT;
          break;
        case 'dhwAndHeating':
        case 'dhwAndHeatingCooling':
          targetState = this.platform.Characteristic.TargetHeatingCoolingState.AUTO;
          break;
        default:
          targetState = this.platform.Characteristic.TargetHeatingCoolingState.OFF;
      }
      
      this.states.TargetHeatingCoolingState = targetState;
      this.service.updateCharacteristic(
        this.platform.Characteristic.TargetHeatingCoolingState, 
        this.states.TargetHeatingCoolingState
      );
    }

    this.platform.log.debug('Updated boiler accessory state:', this.states);
  }
}