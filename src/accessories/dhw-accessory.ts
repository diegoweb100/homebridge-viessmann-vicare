import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { ViessmannPlatform, ViessmannInstallation, ViessmannGateway, ViessmannDevice } from '../platform';

export class ViessmannDHWAccessory {
  private service: Service;
  private informationService: Service;

  private states = {
    On: false,
    CurrentTemperature: 40,
    TargetTemperature: 50,
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
      .setCharacteristic(this.platform.Characteristic.Model, 'DHW Tank')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, gateway.serial + '-DHW')
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, '1.0.0');

    // Get or create the Thermostat service for DHW
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
        ],
      });

    // Current Temperature (read-only)
    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this))
      .setProps({
        minValue: 0,
        maxValue: 100,
        minStep: 0.1,
      });

    // Target Temperature
    this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .onGet(this.getTargetTemperature.bind(this))
      .onSet(this.setTargetTemperature.bind(this))
      .setProps({
        minValue: 35,
        maxValue: 65,
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

    try {
      let success: boolean;
      
      if (targetState === this.platform.Characteristic.TargetHeatingCoolingState.OFF) {
        // Turn off DHW
        success = await this.platform.viessmannAPI.executeCommand(
          this.installation.id,
          this.gateway.serial,
          this.device.id,
          'heating.dhw.operating.modes.active',
          'setMode',
          { mode: 'off' }
        );
      } else {
        // Turn on DHW
        success = await this.platform.viessmannAPI.executeCommand(
          this.installation.id,
          this.gateway.serial,
          this.device.id,
          'heating.dhw.operating.modes.active',
          'setMode',
          { mode: 'balanced' }
        );
      }

      if (success) {
        this.platform.log.info(`Set DHW state to: ${targetState === 0 ? 'OFF' : 'ON'}`);
      } else {
        this.platform.log.error(`Failed to set DHW state to: ${targetState === 0 ? 'OFF' : 'ON'}`);
        throw new Error('Failed to set DHW state');
      }
    } catch (error) {
      this.platform.log.error('Error setting DHW target heating cooling state:', error);
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
      // Set DHW target temperature
      const success = await this.platform.viessmannAPI.setDHWTemperature(
        this.installation.id,
        this.gateway.serial,
        this.device.id,
        temperature
      );

      if (success) {
        this.platform.log.info(`Set DHW target temperature to: ${temperature}°C`);
      } else {
        this.platform.log.error(`Failed to set DHW target temperature to: ${temperature}°C`);
        throw new Error('Failed to set DHW target temperature');
      }
    } catch (error) {
      this.platform.log.error('Error setting DHW target temperature:', error);
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
      this.platform.log.error('Error handling DHW update:', error);
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
      this.platform.log.error('Error updating DHW status:', error);
    }
  }

  private async updateFromFeatures(features: any[]) {
    // Update DHW current temperature
    const dhwTempFeature = features.find(f => 
      f.feature === 'heating.dhw.sensors.temperature.hotWaterStorage' ||
      f.feature === 'heating.dhw.sensors.temperature.outlet'
    );
    if (dhwTempFeature?.properties?.value?.value !== undefined) {
      this.states.CurrentTemperature = dhwTempFeature.properties.value.value;
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.states.CurrentTemperature);
    }

    // Update DHW target temperature
    const dhwTargetTempFeature = features.find(f => f.feature === 'heating.dhw.temperature.main');
    if (dhwTargetTempFeature?.properties?.value?.value !== undefined) {
      this.states.TargetTemperature = dhwTargetTempFeature.properties.value.value;
      this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, this.states.TargetTemperature);
    }

    // Update DHW charging state
    const dhwChargingFeature = features.find(f => f.feature === 'heating.dhw.charging');
    if (dhwChargingFeature?.properties?.active?.value !== undefined) {
      const isCharging = dhwChargingFeature.properties.active.value;
      this.states.CurrentHeatingCoolingState = isCharging ? 
        this.platform.Characteristic.CurrentHeatingCoolingState.HEAT : 
        this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
      
      this.service.updateCharacteristic(
        this.platform.Characteristic.CurrentHeatingCoolingState, 
        this.states.CurrentHeatingCoolingState
      );
    }

    // Update DHW operating mode
    const dhwOperatingModeFeature = features.find(f => f.feature === 'heating.dhw.operating.modes.active');
    if (dhwOperatingModeFeature?.properties?.value?.value !== undefined) {
      const mode = dhwOperatingModeFeature.properties.value.value;
      const targetState = (mode === 'off') ? 
        this.platform.Characteristic.TargetHeatingCoolingState.OFF : 
        this.platform.Characteristic.TargetHeatingCoolingState.HEAT;
      
      this.states.TargetHeatingCoolingState = targetState;
      this.service.updateCharacteristic(
        this.platform.Characteristic.TargetHeatingCoolingState, 
        this.states.TargetHeatingCoolingState
      );
    }

    // Update DHW enabled state
    const dhwFeature = features.find(f => f.feature === 'heating.dhw');
    if (dhwFeature?.properties?.active?.value !== undefined) {
      this.states.On = dhwFeature.properties.active.value;
    }

    this.platform.log.debug('Updated DHW accessory state:', this.states);
  }
}