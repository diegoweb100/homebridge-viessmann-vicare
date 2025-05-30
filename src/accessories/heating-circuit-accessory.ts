import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { ViessmannPlatform, ViessmannInstallation, ViessmannGateway, ViessmannDevice } from '../platform';

export class ViessmannHeatingCircuitAccessory {
  private temperatureService: Service;
  private informationService: Service;
  private heatingService?: Service;
  private standbyService?: Service;
  private offService?: Service;
  
  private availableModes: string[] = [];
  private supportsTemperatureControl = false;
  private temperatureConstraints = { min: 5, max: 35 };
  private isCircuitEnabled = false;
  private currentMode = 'standby';

  private states = {
    CurrentTemperature: 20,
    TargetTemperature: 21,
    TemperatureDisplayUnits: 0, // Celsius
    CurrentRelativeHumidity: 50,
    HeatingOn: false,
    StandbyOn: true,
    OffOn: false,
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

    // Create temperature sensor service instead of thermostat for current temp
    this.temperatureService = this.accessory.getService(this.platform.Service.TemperatureSensor) || 
                              this.accessory.addService(this.platform.Service.TemperatureSensor);

    this.temperatureService.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

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

    // Temperature sensor for current temperature
    this.temperatureService.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this))
      .setProps({
        minValue: -50,
        maxValue: 100,
        minStep: 0.1,
      });

    // Create mode switches
    this.setupModeServices();

    // Add target temperature service if supported
    if (this.supportsTemperatureControl) {
      this.setupTargetTemperatureService();
    }
  }

  private setupModeServices() {
    const installationName = this.installation.description;

    // First, remove ALL existing mode services to avoid conflicts
    this.removeAllModeServices();

    // Create services for each available mode with unique subtypes
    if (this.availableModes.includes('heating')) {
      const heatingServiceName = `${installationName} Heating Circuit ${this.circuitNumber} Heating`;
      this.heatingService = this.accessory.addService(this.platform.Service.Switch, heatingServiceName, `hc${this.circuitNumber}-heating`);
      this.heatingService.setCharacteristic(this.platform.Characteristic.Name, heatingServiceName);
      this.heatingService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(() => this.currentMode === 'heating')
        .onSet(this.setHeatingMode.bind(this));
    }

    if (this.availableModes.includes('standby')) {
      const standbyServiceName = `${installationName} Heating Circuit ${this.circuitNumber} Standby`;
      this.standbyService = this.accessory.addService(this.platform.Service.Switch, standbyServiceName, `hc${this.circuitNumber}-standby`);
      this.standbyService.setCharacteristic(this.platform.Characteristic.Name, standbyServiceName);
      this.standbyService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(() => this.currentMode === 'standby')
        .onSet(this.setStandbyMode.bind(this));
    }

    // Add "off" mode if not in available modes but we want manual control
    if (!this.availableModes.includes('off') && this.availableModes.length > 0) {
      const offServiceName = `${installationName} Heating Circuit ${this.circuitNumber} Off`;
      this.offService = this.accessory.addService(this.platform.Service.Switch, offServiceName, `hc${this.circuitNumber}-off`);
      this.offService.setCharacteristic(this.platform.Characteristic.Name, offServiceName);
      this.offService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(() => this.currentMode === 'off')
        .onSet(this.setOffMode.bind(this));
    }
  }

  private removeAllModeServices() {
    // Get all switch services and remove them
    const switchServices = this.accessory.services.filter(service => 
      service.UUID === this.platform.Service.Switch.UUID
    );

    for (const service of switchServices) {
      try {
        this.accessory.removeService(service);
        this.platform.log.debug(`Removed existing switch service: ${service.displayName || 'Unknown'}`);
      } catch (error) {
        this.platform.log.debug(`Could not remove service: ${error}`);
      }
    }

    // Clear references
    this.heatingService = undefined;
    this.standbyService = undefined;
    this.offService = undefined;
  }

  private setupTargetTemperatureService() {
    // Remove existing thermostat services first
    const thermostatServices = this.accessory.services.filter(service => 
      service.UUID === this.platform.Service.Thermostat.UUID
    );

    for (const service of thermostatServices) {
      try {
        this.accessory.removeService(service);
        this.platform.log.debug(`Removed existing thermostat service: ${service.displayName || 'Unknown'}`);
      } catch (error) {
        this.platform.log.debug(`Could not remove thermostat service: ${error}`);
      }
    }

    // Create a separate service for target temperature
    const installationName = this.installation.description;
    const targetTempServiceName = `${installationName} Heating Circuit ${this.circuitNumber} Temperature`;
    const targetTempService = this.accessory.addService(this.platform.Service.Thermostat, targetTempServiceName, `hc${this.circuitNumber}-temp`);

    targetTempService.setCharacteristic(this.platform.Characteristic.Name, targetTempServiceName);

    // Set to heating only mode and disable state controls
    targetTempService.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .onGet(() => this.platform.Characteristic.TargetHeatingCoolingState.HEAT)
      .onSet(() => {}) // Do nothing - we control modes via switches
      .setProps({
        validValues: [this.platform.Characteristic.TargetHeatingCoolingState.HEAT],
      });

    targetTempService.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(() => this.currentMode === 'heating' ? 
        this.platform.Characteristic.CurrentHeatingCoolingState.HEAT : 
        this.platform.Characteristic.CurrentHeatingCoolingState.OFF);

    targetTempService.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this));

    targetTempService.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .onGet(this.getTargetTemperature.bind(this))
      .onSet(this.setTargetTemperature.bind(this))
      .setProps({
        minValue: this.temperatureConstraints.min,
        maxValue: this.temperatureConstraints.max,
        minStep: 0.5,
      });

    targetTempService.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onGet(() => 0) // Celsius
      .onSet(() => {}); // Do nothing
  }

  async setHeatingMode(value: CharacteristicValue) {
    const on = value as boolean;
    
    if (on) {
      // User wants to turn ON heating mode
      if (this.currentMode !== 'heating') {
        await this.setMode('heating');
      }
    } else {
      // User wants to turn OFF heating mode
      if (this.currentMode === 'heating') {
        // Can't turn off heating without selecting another mode
        // Force it back to ON and show a warning
        setTimeout(() => {
          this.heatingService?.updateCharacteristic(this.platform.Characteristic.On, true);
        }, 100);
        this.platform.log.warn(`Cannot turn off Heating mode for circuit ${this.circuitNumber}. Please select Standby mode instead.`);
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
      }
    }
  }

  async setStandbyMode(value: CharacteristicValue) {
    const on = value as boolean;
    
    if (on) {
      // User wants to turn ON standby mode
      if (this.currentMode !== 'standby') {
        await this.setMode('standby');
      }
    } else {
      // User wants to turn OFF standby mode
      if (this.currentMode === 'standby') {
        // Can't turn off standby without selecting another mode
        // Force it back to ON and show a warning
        setTimeout(() => {
          this.standbyService?.updateCharacteristic(this.platform.Characteristic.On, true);
        }, 100);
        this.platform.log.warn(`Cannot turn off Standby mode for circuit ${this.circuitNumber}. Please select Heating mode instead.`);
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
      }
    }
  }

  async setOffMode(value: CharacteristicValue) {
    const on = value as boolean;
    
    if (on) {
      // User wants to turn circuit completely off (standby is the closest we can get)
      if (this.currentMode !== 'standby') {
        await this.setMode('standby');
      }
    } else {
      // User wants to turn on circuit from off state
      if (this.currentMode === 'standby') {
        // Force it back to ON
        setTimeout(() => {
          this.offService?.updateCharacteristic(this.platform.Characteristic.On, true);
        }, 100);
        this.platform.log.warn(`Cannot deactivate Off mode for circuit ${this.circuitNumber}. Please select Heating mode instead.`);
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
      }
    }
  }

  private async setMode(mode: string) {
    try {
      // First, validate that the mode is available
      if (!this.availableModes.includes(mode)) {
        this.platform.log.error(`Mode ${mode} is not available for heating circuit ${this.circuitNumber}. Available modes: ${this.availableModes.join(', ')}`);
        throw new Error(`Mode ${mode} not available`);
      }

      const success = await this.platform.viessmannAPI.setOperatingMode(
        this.installation.id,
        this.gateway.serial,
        this.device.id,
        this.circuitNumber,
        mode
      );

      if (success) {
        const oldMode = this.currentMode;
        this.currentMode = mode;
        this.platform.log.info(`Heating circuit ${this.circuitNumber} mode changed: ${oldMode.toUpperCase()} → ${mode.toUpperCase()}`);
        
        // CRITICAL: Update all switch states with proper exclusivity
        this.updateAllSwitchStatesExclusive();
      } else {
        this.platform.log.error(`Failed to set heating circuit ${this.circuitNumber} mode to: ${mode}`);
        // Restore the previous switch state
        this.updateAllSwitchStatesExclusive();
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
    } catch (error) {
      this.platform.log.error(`Error setting heating circuit ${this.circuitNumber} mode to ${mode}:`, error);
      // Restore the previous switch state
      this.updateAllSwitchStatesExclusive();
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private updateAllSwitchStatesExclusive() {
    // ENSURE MUTUAL EXCLUSION: Only one switch can be ON at a time
    const isHeating = this.currentMode === 'heating';
    const isStandby = this.currentMode === 'standby';
    const isOff = this.currentMode === 'off' || (!isHeating && !isStandby);
    
    if (this.heatingService) {
      this.heatingService.updateCharacteristic(this.platform.Characteristic.On, isHeating);
    }
    
    if (this.standbyService) {
      this.standbyService.updateCharacteristic(this.platform.Characteristic.On, isStandby);
    }
    
    if (this.offService) {
      this.offService.updateCharacteristic(this.platform.Characteristic.On, isOff);
    }
    
    // Logging for verification
    this.platform.log.debug(`Heating Circuit ${this.circuitNumber} Switch States - Heating: ${isHeating}, Standby: ${isStandby}, Off: ${isOff} (Mode: ${this.currentMode.toUpperCase()})`);
    
    // Safety check: Verify exactly one switch is ON
    const activeSwitches = [isHeating, isStandby, isOff].filter(state => state).length;
    if (activeSwitches !== 1) {
      this.platform.log.error(`CRITICAL: Multiple switches active for circuit ${this.circuitNumber}! Heating: ${isHeating}, Standby: ${isStandby}, Off: ${isOff}`);
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
        this.platform.log.debug(`Comfort setTemperature failed for circuit ${this.circuitNumber}, trying with 'temperature' parameter`);
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
          this.platform.log.debug(`Comfort program failed for circuit ${this.circuitNumber}, trying normal program`);
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
            this.platform.log.debug(`Normal program also failed for circuit ${this.circuitNumber}`);
          }
        }
      }

      if (success) {
        this.platform.log.info(`Heating circuit ${this.circuitNumber} target temperature: ${temperature}°C (Mode: ${this.currentMode.toUpperCase()})`);
      } else {
        this.platform.log.error(`Failed to set heating circuit ${this.circuitNumber} target temperature to: ${temperature}°C`);
        throw new Error('Failed to set target temperature');
      }
    } catch (error) {
      this.platform.log.error(`Error setting heating circuit ${this.circuitNumber} target temperature:`, error);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
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
      this.temperatureService.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.states.CurrentTemperature);
    } else {
      // Update supply temperature as fallback if room temperature not available
      const supplyTempFeature = features.find(f => f.feature === `${circuitPrefix}.sensors.temperature.supply`);
      if (supplyTempFeature?.properties?.value?.value !== undefined) {
        // Convert supply temperature to approximate room temperature (rough estimate)
        this.states.CurrentTemperature = Math.max(15, supplyTempFeature.properties.value.value - 15);
        this.temperatureService.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.states.CurrentTemperature);
      }
    }

    // Update target temperature from active program
    const activeProgram = features.find(f => f.feature === `${circuitPrefix}.operating.programs.active`);
    if (activeProgram?.properties?.temperature?.value !== undefined) {
      this.states.TargetTemperature = activeProgram.properties.temperature.value;
    } else {
      // Fallback to comfort program temperature
      const comfortProgram = features.find(f => f.feature === `${circuitPrefix}.operating.programs.comfort`);
      if (comfortProgram?.properties?.temperature?.value !== undefined) {
        this.states.TargetTemperature = comfortProgram.properties.temperature.value;
      } else {
        // Fallback to normal program temperature
        const normalProgram = features.find(f => f.feature === `${circuitPrefix}.operating.programs.normal`);
        if (normalProgram?.properties?.temperature?.value !== undefined) {
          this.states.TargetTemperature = normalProgram.properties.temperature.value;
        }
      }
    }

    // Update operating mode (most important)
    const operatingModeFeature = features.find(f => f.feature === `${circuitPrefix}.operating.modes.active`);
    if (operatingModeFeature?.properties?.value?.value !== undefined) {
      const newMode = operatingModeFeature.properties.value.value;
      if (newMode !== this.currentMode) {
        this.platform.log.debug(`Heating circuit ${this.circuitNumber} mode updated: ${this.currentMode.toUpperCase()} → ${newMode.toUpperCase()}`);
        this.currentMode = newMode;
        this.updateAllSwitchStatesExclusive();
      }
    }

    // Update humidity if available
    const humidityFeature = features.find(f => f.feature.includes('sensors.humidity'));
    if (humidityFeature?.properties?.value?.value !== undefined) {
      this.states.CurrentRelativeHumidity = humidityFeature.properties.value.value;
    }

    this.platform.log.debug(`Heating Circuit ${this.circuitNumber} Status - Mode: ${this.currentMode.toUpperCase()}, Temp: ${this.states.CurrentTemperature}°C → ${this.states.TargetTemperature}°C`);
  }
}