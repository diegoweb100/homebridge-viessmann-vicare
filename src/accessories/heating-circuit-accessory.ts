import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { ViessmannPlatform, ViessmannInstallation, ViessmannGateway, ViessmannDevice } from '../platform';

export class ViessmannHeatingCircuitAccessory {
  private service: Service;
  private informationService: Service;
  private availableModes: string[] = [];
  private supportsTemperatureControl = false;
  private temperatureConstraints = { min: 5, max: 35 };
  private isCircuitEnabled = false;

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

    // Set update handler for platform to call
    this.accessory.context.updateHandler = this.handleUpdate.bind(this);

    // Initialize capabilities and setup characteristics
    this.initializeCapabilities();
  }

  private async initializeCapabilities() {
    try {
      const features = await this.platform.viessmannAPI.getDeviceFeatures(
        this.installation.id,
        this.gateway.serial,
        this.device.id
      );
      
      this.analyzeCapabilities(features);
      
      // Only setup if circuit is enabled
      if (this.isCircuitEnabled) {
        this.setupCharacteristics();
        await this.updateFromFeatures(features);
      } else {
        this.platform.log.info(`Heating circuit ${this.circuitNumber} is disabled, skipping setup`);
      }
      
    } catch (error) {
      this.platform.log.error(`Error initializing heating circuit ${this.circuitNumber} capabilities:`, error);
      // Fallback to basic setup
      this.setupCharacteristics();
    }
  }

  private analyzeCapabilities(features: any[]) {
    const circuitPrefix = `heating.circuits.${this.circuitNumber}`;

    // Check if circuit is enabled
    const circuitFeature = features.find(f => f.feature === circuitPrefix);
    this.isCircuitEnabled = circuitFeature?.isEnabled === true;
    
    if (!this.isCircuitEnabled) {
      this.platform.log.info(`Heating circuit ${this.circuitNumber} is not enabled`);
      return;
    }

    // Analyze operating modes
    const activeModesFeature = features.find(f => f.feature === `${circuitPrefix}.operating.modes.active`);
    if (activeModesFeature?.commands?.setMode?.params?.mode?.constraints?.enum) {
      this.availableModes = activeModesFeature.commands.setMode.params.mode.constraints.enum;
      this.platform.log.info(`Heating circuit ${this.circuitNumber} available modes: ${this.availableModes.join(', ')}`);
    } else {
      // Fallback: check individual mode features
      const modeFeatures = features.filter(f => 
        f.feature.startsWith(`${circuitPrefix}.operating.modes.`) && 
        f.feature !== `${circuitPrefix}.operating.modes.active` &&
        f.isEnabled
      );
      this.availableModes = modeFeatures
        .map(f => f.feature.split('.').pop())
        .filter(Boolean);
      
      this.platform.log.info(`Heating circuit ${this.circuitNumber} modes found from features: ${this.availableModes.join(', ')}`);
    }

    // Analyze temperature control capabilities
    const comfortProgram = features.find(f => f.feature === `${circuitPrefix}.operating.programs.comfort`);
    const normalProgram = features.find(f => f.feature === `${circuitPrefix}.operating.programs.normal`);
    
    if (comfortProgram?.commands?.setTemperature || normalProgram?.commands?.setTemperature) {
      this.supportsTemperatureControl = true;
      
      // Get temperature constraints from available commands
      const tempCommand = comfortProgram?.commands?.setTemperature || normalProgram?.commands?.setTemperature;
      const constraints = tempCommand?.params?.targetTemperature?.constraints || 
                         tempCommand?.params?.temperature?.constraints;
      
      if (constraints) {
        this.temperatureConstraints.min = constraints.min || 5;
        this.temperatureConstraints.max = constraints.max || 35;
      }
      
      this.platform.log.info(`Heating circuit ${this.circuitNumber} temperature control: ${this.temperatureConstraints.min}-${this.temperatureConstraints.max}°C`);
    }

    // Log capabilities summary
    this.platform.log.info(`Heating Circuit ${this.circuitNumber} Capabilities - Enabled: ${this.isCircuitEnabled}, Modes: [${this.availableModes.join(', ')}], Temperature: ${this.supportsTemperatureControl ? 'Yes' : 'No'}`);
  }

  private setupCharacteristics() {
    if (!this.isCircuitEnabled) {
      return;
    }

    // Current Heating Cooling State (read-only)
    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.getCurrentHeatingCoolingState.bind(this));

    // Target Heating Cooling State - only show if we have controllable modes
    if (this.availableModes.length > 0) {
      const validValues = [];
      
      // Map available modes to HomeKit values
      if (this.availableModes.includes('standby')) {
        validValues.push(this.platform.Characteristic.TargetHeatingCoolingState.OFF);
      }
      
      if (this.availableModes.includes('heating')) {
        validValues.push(this.platform.Characteristic.TargetHeatingCoolingState.HEAT);
      }
      
      // If we have multiple modes, provide AUTO as a general option
      if (this.availableModes.length > 1) {
        validValues.push(this.platform.Characteristic.TargetHeatingCoolingState.AUTO);
      }

      this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
        .onGet(this.getTargetHeatingCoolingState.bind(this))
        .onSet(this.setTargetHeatingCoolingState.bind(this))
        .setProps({ validValues });
    }

    // Current Temperature (read-only)
    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this))
      .setProps({
        minValue: -50,
        maxValue: 100,
        minStep: 0.1,
      });

    // Target Temperature - only if supported
    if (this.supportsTemperatureControl) {
      this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
        .onGet(this.getTargetTemperature.bind(this))
        .onSet(this.setTargetTemperature.bind(this))
        .setProps({
          minValue: this.temperatureConstraints.min,
          maxValue: this.temperatureConstraints.max,
          minStep: 0.5,
        });
    }

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
        mode = this.availableModes.includes('standby') ? 'standby' : 'off';
        break;
      case this.platform.Characteristic.TargetHeatingCoolingState.HEAT:
        mode = this.availableModes.includes('heating') ? 'heating' : this.availableModes[0];
        break;
      case this.platform.Characteristic.TargetHeatingCoolingState.AUTO:
        // For AUTO, prefer heating mode, or first available mode
        mode = this.availableModes.includes('heating') ? 'heating' : this.availableModes[0];
        break;
      default:
        mode = this.availableModes[0] || 'standby';
    }

    try {
      if (!this.availableModes.includes(mode)) {
        this.platform.log.warn(`Mode ${mode} not available for heating circuit ${this.circuitNumber}. Available: ${this.availableModes.join(', ')}`);
        return;
      }

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
      this.platform.log.error(`Error setting heating circuit ${this.circuitNumber} target heating cooling state:`, error);
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
    if (!this.supportsTemperatureControl) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.READ_ONLY_CHARACTERISTIC);
    }

    const temperature = value as number;
    this.states.TargetTemperature = temperature;

    try {
      // Try comfort program first, then normal program
      let success = false;
      
      // Method 1: Set comfort temperature
      try {
        success = await this.platform.viessmannAPI.executeCommand(
          this.installation.id,
          this.gateway.serial,
          this.device.id,
          `heating.circuits.${this.circuitNumber}.operating.programs.comfort`,
          'setTemperature',
          { targetTemperature: temperature }
        );
      } catch (error) {
        this.platform.log.debug(`Comfort setTemperature failed, trying with 'temperature' parameter`);
        try {
          success = await this.platform.viessmannAPI.executeCommand(
            this.installation.id,
            this.gateway.serial,
            this.device.id,
            `heating.circuits.${this.circuitNumber}.operating.programs.comfort`,
            'setTemperature',
            { temperature }
          );
        } catch (error2) {
          this.platform.log.debug(`Comfort program failed, trying normal program`);
        }
      }
      
      // Method 2: Set normal program temperature if comfort failed
      if (!success) {
        try {
          success = await this.platform.viessmannAPI.executeCommand(
            this.installation.id,
            this.gateway.serial,
            this.device.id,
            `heating.circuits.${this.circuitNumber}.operating.programs.normal`,
            'setTemperature',
            { targetTemperature: temperature }
          );
        } catch (error) {
          try {
            success = await this.platform.viessmannAPI.executeCommand(
              this.installation.id,
              this.gateway.serial,
              this.device.id,
              `heating.circuits.${this.circuitNumber}.operating.programs.normal`,
              'setTemperature',
              { temperature }
            );
          } catch (error2) {
            this.platform.log.debug(`Normal program also failed`);
          }
        }
      }

      if (success) {
        this.platform.log.info(`Set heating circuit ${this.circuitNumber} target temperature to: ${temperature}°C`);
      } else {
        this.platform.log.error(`Failed to set heating circuit ${this.circuitNumber} target temperature to: ${temperature}°C`);
        throw new Error('Failed to set target temperature');
      }
    } catch (error) {
      this.platform.log.error(`Error setting heating circuit ${this.circuitNumber} target temperature:`, error);
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
      this.platform.log.error(`Error handling heating circuit ${this.circuitNumber} update:`, error);
    }
  }

  private async updateFromFeatures(features: any[]) {
    if (!this.isCircuitEnabled) {
      return;
    }

    const circuitPrefix = `heating.circuits.${this.circuitNumber}`;

    // Update room temperature
    const roomTempFeature = features.find(f => f.feature === `${circuitPrefix}.sensors.temperature.room`);
    if (roomTempFeature?.properties?.value?.value !== undefined) {
      this.states.CurrentTemperature = roomTempFeature.properties.value.value;
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.states.CurrentTemperature);
    } else {
      // Update supply temperature as fallback if room temperature not available
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
      } else {
        // Fallback to normal program temperature
        const normalProgram = features.find(f => f.feature === `${circuitPrefix}.operating.programs.normal`);
        if (normalProgram?.properties?.temperature?.value !== undefined) {
          this.states.TargetTemperature = normalProgram.properties.temperature.value;
          this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, this.states.TargetTemperature);
        }
      }
    }

    // Update current heating state based on circulation pump or active programs
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
    } else {
      // Fallback: check if any heating program is active
      const comfortActive = features.find(f => f.feature === `${circuitPrefix}.operating.programs.comfort`)?.properties?.active?.value;
      const normalActive = features.find(f => f.feature === `${circuitPrefix}.operating.programs.normal`)?.properties?.active?.value;
      
      const isHeating = comfortActive || normalActive;
      this.states.CurrentHeatingCoolingState = isHeating ? 
        this.platform.Characteristic.CurrentHeatingCoolingState.HEAT : 
        this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
      
      this.service.updateCharacteristic(
        this.platform.Characteristic.CurrentHeatingCoolingState, 
        this.states.CurrentHeatingCoolingState
      );
    }

    // Update operating mode (target heating cooling state)
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
        default:
          // For other modes, determine based on whether it's heating or not
          targetState = this.states.CurrentHeatingCoolingState === this.platform.Characteristic.CurrentHeatingCoolingState.HEAT ?
            this.platform.Characteristic.TargetHeatingCoolingState.AUTO :
            this.platform.Characteristic.TargetHeatingCoolingState.OFF;
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