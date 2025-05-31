import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { ViessmannPlatform, ViessmannInstallation, ViessmannGateway, ViessmannDevice } from '../platform';

export class ViessmannHeatingCircuitAccessory {
  private temperatureService: Service;
  private informationService: Service;
  
  // Temperature Program Services
  private comfortTempService?: Service;
  private normalTempService?: Service;
  private reducedTempService?: Service;
  
  private availableModes: string[] = [];
  private availablePrograms: string[] = [];
  private supportsTemperatureControl = false;
  private temperatureConstraints = { min: 5, max: 35 };
  private isCircuitEnabled = false;
  private currentMode = 'standby';

  private states = {
    CurrentTemperature: 20,
    ComfortTemperature: 19,
    NormalTemperature: 18,
    ReducedTemperature: 16,
    TemperatureDisplayUnits: 0, // Celsius
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

    // Create temperature sensor service for current temp
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
      // Fallback: check individual mode features that are enabled
      const modeFeatures = features.filter(f => 
        f.feature.startsWith(`${circuitPrefix}.operating.modes.`) && 
        f.feature !== `${circuitPrefix}.operating.modes.active` &&
        f.isEnabled === true
      );
      this.availableModes = modeFeatures
        .map(f => f.feature.split('.').pop())
        .filter(Boolean);
      
      this.platform.log.info(`Heating circuit ${this.circuitNumber} modes found from enabled features: ${this.availableModes.join(', ')}`);
    }

    // Get current mode
    if (activeModesFeature?.properties?.value?.value) {
      this.currentMode = activeModesFeature.properties.value.value;
      this.platform.log.info(`Heating circuit ${this.circuitNumber} current mode: ${this.currentMode}`);
    }

    // Analyze temperature programs (comfort, normal, reduced)
    const programTypes = ['comfort', 'normal', 'reduced'];
    for (const programType of programTypes) {
      const programFeature = features.find(f => f.feature === `${circuitPrefix}.operating.programs.${programType}`);
      if (programFeature?.isEnabled === true) {
        this.availablePrograms.push(programType);
        
        // Get current temperature for this program
        if (programFeature.properties?.temperature?.value !== undefined) {
          const temp = programFeature.properties.temperature.value;
          switch (programType) {
            case 'comfort':
              this.states.ComfortTemperature = temp;
              break;
            case 'normal':
              this.states.NormalTemperature = temp;
              break;
            case 'reduced':
              this.states.ReducedTemperature = temp;
              break;
          }
        }

        // Check if we can set temperature for this program
        if (programFeature.commands?.setTemperature) {
          this.supportsTemperatureControl = true;
          const constraints = programFeature.commands.setTemperature.params?.targetTemperature?.constraints;
          if (constraints) {
            this.temperatureConstraints.min = Math.min(this.temperatureConstraints.min, constraints.min || 5);
            this.temperatureConstraints.max = Math.max(this.temperatureConstraints.max, constraints.max || 35);
          }
        }
      }
    }

    // Log capabilities summary
    this.platform.log.info(`Heating Circuit ${this.circuitNumber} Capabilities - Enabled: ${this.isCircuitEnabled}, Modes: [${this.availableModes.join(', ')}], Programs: [${this.availablePrograms.join(', ')}], Temperature: ${this.supportsTemperatureControl ? 'Yes' : 'No'}`);
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

    // Add temperature program services if supported
    if (this.supportsTemperatureControl && this.availablePrograms.length > 0) {
      this.setupTemperatureProgramServices();
    }
  }

  private setupModeServices() {
    const installationName = this.installation.description;

    // First, remove ALL existing mode services to avoid conflicts
    this.removeAllModeServices();

    // Create services for each available mode
    for (const mode of this.availableModes) {
      const serviceDisplayName = this.getModeDisplayName(mode);
      const serviceName = `${installationName} ${serviceDisplayName}`;
      const serviceSubtype = `hc${this.circuitNumber}-${mode}`;
      
      const service = this.accessory.addService(this.platform.Service.Switch, serviceName, serviceSubtype);
      service.setCharacteristic(this.platform.Characteristic.Name, serviceName);
      service.getCharacteristic(this.platform.Characteristic.On)
        .onGet(() => this.currentMode === mode)
        .onSet(this.createModeSetHandler(mode));

      this.platform.log.info(`Created mode service: ${serviceName} (${mode})`);
    }
  }

  private setupTemperatureProgramServices() {
    const installationName = this.installation.description;

    // Remove existing temperature program services first
    this.removeAllTemperatureProgramServices();

    // Create services for each available temperature program
    if (this.availablePrograms.includes('comfort')) {
      const serviceName = `${installationName} Heating Circuit ${this.circuitNumber} Comfort Temperature`;
      this.comfortTempService = this.accessory.addService(this.platform.Service.Thermostat, serviceName, `hc${this.circuitNumber}-comfort-temp`);
      this.setupSingleTemperatureProgramService(this.comfortTempService, 'comfort', this.states.ComfortTemperature);
    }

    if (this.availablePrograms.includes('normal')) {
      const serviceName = `${installationName} Heating Circuit ${this.circuitNumber} Normal Temperature`;
      this.normalTempService = this.accessory.addService(this.platform.Service.Thermostat, serviceName, `hc${this.circuitNumber}-normal-temp`);
      this.setupSingleTemperatureProgramService(this.normalTempService, 'normal', this.states.NormalTemperature);
    }

    if (this.availablePrograms.includes('reduced')) {
      const serviceName = `${installationName} Heating Circuit ${this.circuitNumber} Reduced Temperature`;
      this.reducedTempService = this.accessory.addService(this.platform.Service.Thermostat, serviceName, `hc${this.circuitNumber}-reduced-temp`);
      this.setupSingleTemperatureProgramService(this.reducedTempService, 'reduced', this.states.ReducedTemperature);
    }
  }

  private setupSingleTemperatureProgramService(service: Service, programType: string, currentTemp: number) {
    service.setCharacteristic(this.platform.Characteristic.Name, service.displayName);

    // Set heating only mode
    service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .onGet(() => this.currentMode === 'heating' ? 
        this.platform.Characteristic.TargetHeatingCoolingState.HEAT : 
        this.platform.Characteristic.TargetHeatingCoolingState.OFF)
      .onSet(() => {}) // Read-only
      .setProps({
        validValues: [
          this.platform.Characteristic.TargetHeatingCoolingState.OFF,
          this.platform.Characteristic.TargetHeatingCoolingState.HEAT
        ],
      });

    service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(() => this.currentMode === 'heating' ? 
        this.platform.Characteristic.CurrentHeatingCoolingState.HEAT : 
        this.platform.Characteristic.CurrentHeatingCoolingState.OFF);

    // Current temperature (same for all programs)
    service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this));

    // Target temperature (specific to each program)
    service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .onGet(() => this.getTemperatureForProgram(programType))
      .onSet((value: CharacteristicValue) => this.setTemperatureForProgram(programType, value as number))
      .setProps({
        minValue: this.temperatureConstraints.min,
        maxValue: this.temperatureConstraints.max,
        minStep: 1,
      });

    service.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onGet(() => 0) // Celsius
      .onSet(() => {}); // Read-only
  }

  private getModeDisplayName(mode: string): string {
    const displayNames: { [key: string]: string } = {
      'heating': `Heating Circuit ${this.circuitNumber} On`,
      'standby': `Heating Circuit ${this.circuitNumber} Off`,
    };
    
    return displayNames[mode] || `Heating Circuit ${this.circuitNumber} ${mode.charAt(0).toUpperCase() + mode.slice(1)}`;
  }

  private createModeSetHandler(targetMode: string) {
    return async (value: CharacteristicValue) => {
      const on = value as boolean;
      
      if (on) {
        // User wants to turn ON this mode
        if (this.currentMode !== targetMode) {
          await this.setMode(targetMode);
        }
      } else {
        // User wants to turn OFF this mode
        if (this.currentMode === targetMode) {
          // Can't turn off current mode without selecting another mode
          // Force it back to ON and show a warning
          setTimeout(() => {
            const service = this.findServiceForMode(targetMode);
            service?.updateCharacteristic(this.platform.Characteristic.On, true);
          }, 100);
          this.platform.log.warn(`Cannot turn off ${targetMode} mode for circuit ${this.circuitNumber}. Please select another mode instead.`);
          throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
        }
      }
    };
  }

  private findServiceForMode(mode: string): Service | undefined {
    return this.accessory.services.find(service => 
      service.UUID === this.platform.Service.Switch.UUID && 
      service.subtype === `hc${this.circuitNumber}-${mode}`
    );
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
  }

  private removeAllTemperatureProgramServices() {
    // Get all thermostat services and remove them (except the main one we might create later)
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

    // Clear references
    this.comfortTempService = undefined;
    this.normalTempService = undefined;
    this.reducedTempService = undefined;
  }

  private getTemperatureForProgram(programType: string): number {
    switch (programType) {
      case 'comfort':
        return this.states.ComfortTemperature;
      case 'normal':
        return this.states.NormalTemperature;
      case 'reduced':
        return this.states.ReducedTemperature;
      default:
        return 20;
    }
  }

  private async setTemperatureForProgram(programType: string, temperature: number) {
    try {
      // Update local state first
      switch (programType) {
        case 'comfort':
          this.states.ComfortTemperature = temperature;
          break;
        case 'normal':
          this.states.NormalTemperature = temperature;
          break;
        case 'reduced':
          this.states.ReducedTemperature = temperature;
          break;
      }

      // Try to set the temperature via API
      const success = await this.platform.viessmannAPI.executeCommand(
        this.installation.id,
        this.gateway.serial,
        this.device.id,
        `heating.circuits.${this.circuitNumber}.operating.programs.${programType}`,
        'setTemperature',
        { targetTemperature: temperature }
      );

      if (success) {
        this.platform.log.info(`Heating circuit ${this.circuitNumber} ${programType} temperature set to: ${temperature}°C`);
      } else {
        this.platform.log.error(`Failed to set heating circuit ${this.circuitNumber} ${programType} temperature to: ${temperature}°C`);
        throw new Error('Failed to set temperature');
      }
    } catch (error) {
      this.platform.log.error(`Error setting heating circuit ${this.circuitNumber} ${programType} temperature:`, error);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
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
        
        // Update all switch states with proper exclusivity
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
    for (const mode of this.availableModes) {
      const service = this.findServiceForMode(mode);
      if (service) {
        const isActive = this.currentMode === mode;
        service.updateCharacteristic(this.platform.Characteristic.On, isActive);
      }
    }
    
    // Logging for verification
    this.platform.log.debug(`Heating Circuit ${this.circuitNumber} Switch States - Current Mode: ${this.currentMode.toUpperCase()}, Available: [${this.availableModes.join(', ')}]`);
  }

  async getCurrentTemperature(): Promise<CharacteristicValue> {
    return this.states.CurrentTemperature;
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

    // Update temperature programs
    const programTypes = ['comfort', 'normal', 'reduced'];
    let programUpdated = false;

    for (const programType of programTypes) {
      const programFeature = features.find(f => f.feature === `${circuitPrefix}.operating.programs.${programType}`);
      if (programFeature?.properties?.temperature?.value !== undefined) {
        const newTemp = programFeature.properties.temperature.value;
        const oldTemp = this.getTemperatureForProgram(programType);
        
        if (newTemp !== oldTemp) {
          switch (programType) {
            case 'comfort':
              this.states.ComfortTemperature = newTemp;
              if (this.comfortTempService) {
                this.comfortTempService.updateCharacteristic(this.platform.Characteristic.TargetTemperature, newTemp);
              }
              break;
            case 'normal':
              this.states.NormalTemperature = newTemp;
              if (this.normalTempService) {
                this.normalTempService.updateCharacteristic(this.platform.Characteristic.TargetTemperature, newTemp);
              }
              break;
            case 'reduced':
              this.states.ReducedTemperature = newTemp;
              if (this.reducedTempService) {
                this.reducedTempService.updateCharacteristic(this.platform.Characteristic.TargetTemperature, newTemp);
              }
              break;
          }
          programUpdated = true;
        }
      }
    }

    // Update operating mode
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

    if (programUpdated) {
      this.platform.log.debug(`Heating Circuit ${this.circuitNumber} Programs - Comfort: ${this.states.ComfortTemperature}°C, Normal: ${this.states.NormalTemperature}°C, Reduced: ${this.states.ReducedTemperature}°C`);
    }

    this.platform.log.debug(`Heating Circuit ${this.circuitNumber} Status - Mode: ${this.currentMode.toUpperCase()}, Room Temp: ${this.states.CurrentTemperature}°C`);
  }
}