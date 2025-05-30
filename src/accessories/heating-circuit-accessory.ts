import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { ViessmannPlatform, ViessmannInstallation, ViessmannGateway, ViessmannDevice } from '../platform';

export class ViessmannHeatingCircuitAccessory {
  private service: Service;
  private informationService: Service;

  private states = {
    On: false,
    CurrentTemperature: 20,
    TargetTemperature: 21,
    TemperatureDisplayUnits: 0, // Celsius
    CurrentHeatingCoolingState: 0, // Off
    TargetHeatingCoolingState: 3, // Auto
    CurrentRelativeHumidity: 50,
  };

  constructor(
    private readonly platform: ViessmannPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly installation: ViessmannInstallation,
    private readonly gateway: ViessmannGateway,
    private readonly device: ViessmannDevice,
    private readonly circuitNumber: number,
  ) {
    // Set accessory information
    this.informationService = this.accessory.getService(this.platform.Service.AccessoryInformation)!;
    this.informationService
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Viessmann')
      .setCharacteristic(this.platform.Characteristic.Model, `Heating Circuit ${circuitNumber}`)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, `${gateway.serial}-HC${circuitNumber}`)
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
        maxValue: 100,
        minStep: 0.1,
      });

    // Target Temperature
    this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .onGet(this.getTargetTemperature.bind(this))
      .onSet(this.setTargetTemperature.bind(this))
      .setProps({
        minValue: 5,
        maxValue: 35,
        minStep: 0.5,
      });

    // Temperature Display Units
    this.service.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onGet(this.getTemperatureDisplayUnits.bind(this))
      .onSet(this.setTemperatureDisplayUnits.bind(this));

    // Current Relative Humidity (if available)
    this.service.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
      .onGet(this.getCurrentRelativeHumidity.bind(this))
      .setProps({
        minValue: 0,
        maxValue: 100,
        minStep: 1,
      });
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
      const success = await this.platform.viessmannAPI.setOperatingMode(
        this.installation.id,
        this.gateway.serial,
        this.device.id,
        this.circuitNumber,
        mode
      );

      if (success) {
        this.platform.log.info(`Set heating circuit ${this.circuitNumber} operating mode to: ${mode}`);
      } else {
        this.platform.log.error(`Failed to set heating circuit ${this.circuitNumber} operating mode to: ${mode}`);
        throw new Error('Failed to set operating mode');
      }
    } catch (error) {
      this.platform.log.error('Error setting heating circuit target heating cooling state:', error);
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
      // Set active program temperature (comfort mode)
      const success = await this.platform.viessmannAPI.executeCommand(
        this.installation.id,
        this.gateway.serial,
        this.device.id,
        `heating.circuits.${this.circuitNumber}.operating.programs.comfort`,
        'setTemperature',
        { temperature }
      );

      if (success) {
        this.platform.log.info(`Set heating circuit ${this.circuitNumber} target temperature to: ${temperature}°C`);
        
        // Also activate comfort mode if not already active
        await this.platform.viessmannAPI.executeCommand(
          this.installation.id,
          this.gateway.serial,
          this.device.id,
          `heating.circuits.${this.circuitNumber}.operating.programs.comfort`,
          'activate',
          {}
        );
      } else {
        this.platform.log.error(`Failed to set heating circuit ${this.circuitNumber} target temperature to: ${temperature}°C`);
        throw new Error('Failed to set target temperature');
      }
    } catch (error) {
      this.platform.log.error('Error setting heating circuit target temperature:', error);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async getTemperatureDisplayUnits(): Promise<CharacteristicValue> {
    return this.states.TemperatureDisplayUnits;
  }

  async setTemperatureDisplayUnits(value: CharacteristicValue) {
    this.states.TemperatureDisplayUnits = value as number;
  }

  async getCurrentRelativeHumidity(): Promise<CharacteristicValue> {
    return this.states.CurrentRelativeHumidity;
  }

  private async handleUpdate(features: any[]) {
    try {
      await this.updateFromFeatures(features);
    } catch (error) {
      this.platform.log.error('Error handling heating circuit update:', error);
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
      this.platform.log.error('Error updating heating circuit status:', error);
    }
  }

  private async updateFromFeatures(features: any[]) {
    const circuitPrefix = `heating.circuits.${this.circuitNumber}`;

    // Update room temperature
    const roomTempFeature = features.find(f => f.feature === `${circuitPrefix}.sensors.temperature.room`);
    if (roomTempFeature?.properties?.value?.value !== undefined) {
      this.states.CurrentTemperature = roomTempFeature.properties.value.value;
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.states.CurrentTemperature);
    }

    // Update supply temperature as fallback if room temperature not available
    if (this.states.CurrentTemperature === 20) { // Default value, meaning not updated
      const supplyTempFeature = features.find(f => f.feature === `${circuitPrefix}.sensors.temperature.supply`);
      if (supplyTempFeature?.properties?.value?.value !== undefined) {
        // Convert supply temperature to approximate room temperature (rough estimate)
        this.states.CurrentTemperature = Math.max(15, supplyTempFeature.properties.value.value - 15);
        this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.states.CurrentTemperature);
      }
    }

    // Update target temperature from active program
    const activeProgram = features.find(f => f.feature === `${circuitPrefix}.operating.programs.active`);
    if (activeProgram?.properties?.temperature?.value !== undefined) {
      this.states.TargetTemperature = activeProgram.properties.temperature.value;
      this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, this.states.TargetTemperature);
    } else {
      // Fallback to comfort program temperature
      const comfortProgram = features.find(f => f.feature === `${circuitPrefix}.operating.programs.comfort`);
      if (comfortProgram?.properties?.temperature?.value !== undefined) {
        this.states.TargetTemperature = comfortProgram.properties.temperature.value;
        this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, this.states.TargetTemperature);
      }
    }

    // Update current heating state based on circulation pump
    const circulationPump = features.find(f => f.feature === `${circuitPrefix}.circulation.pump`);
    if (circulationPump?.properties?.status?.value !== undefined) {
      const isActive = circulationPump.properties.status.value === 'on';
      this.states.CurrentHeatingCoolingState = isActive ? 
        this.platform.Characteristic.CurrentHeatingCoolingState.HEAT : 
        this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
      
      this.service.updateCharacteristic(
        this.platform.Characteristic.CurrentHeatingCoolingState, 
        this.states.CurrentHeatingCoolingState
      );
    }

    // Update operating mode
    const operatingModeFeature = features.find(f => f.feature === `${circuitPrefix}.operating.modes.active`);
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
          targetState = this.platform.Characteristic.TargetHeatingCoolingState.AUTO;
      }
      
      this.states.TargetHeatingCoolingState = targetState;
      this.service.updateCharacteristic(
        this.platform.Characteristic.TargetHeatingCoolingState, 
        this.states.TargetHeatingCoolingState
      );
    }

    // Update humidity if available
    const humidityFeature = features.find(f => f.feature.includes('sensors.humidity'));
    if (humidityFeature?.properties?.value?.value !== undefined) {
      this.states.CurrentRelativeHumidity = humidityFeature.properties.value.value;
      this.service.updateCharacteristic(
        this.platform.Characteristic.CurrentRelativeHumidity, 
        this.states.CurrentRelativeHumidity
      );
    }

    this.platform.log.debug(`Updated heating circuit ${this.circuitNumber} accessory state:`, this.states);
  }
}