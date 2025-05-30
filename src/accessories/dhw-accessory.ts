import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { ViessmannPlatform, ViessmannInstallation, ViessmannGateway, ViessmannDevice } from '../platform';

export class ViessmannDHWAccessory {
  private temperatureService: Service;
  private informationService: Service;
  private comfortService?: Service;
  private ecoService?: Service;
  private offService?: Service;
  
  private availableModes: string[] = [];
  private supportsTemperatureControl = false;
  private temperatureConstraints = { min: 35, max: 65 };
  private currentMode = 'off';

  private states = {
    CurrentTemperature: 40,
    TargetTemperature: 50,
    TemperatureDisplayUnits: 0, // Celsius
    ComfortOn: false,
    EcoOn: false,
    OffOn: true,
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

    // Create temperature sensor service instead of thermostat
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
      this.setupCharacteristics();
      await this.updateFromFeatures(features);
      
    } catch (error) {
      this.platform.log.error('Error initializing DHW capabilities:', error);
      // Fallback to basic setup
      this.setupCharacteristics();
    }
  }

  private analyzeCapabilities(features: any[]) {
    // Analyze DHW operating modes
    const dhwActiveModesFeature = features.find(f => f.feature === 'heating.dhw.operating.modes.active');
    if (dhwActiveModesFeature?.commands?.setMode?.params?.mode?.constraints?.enum) {
      this.availableModes = dhwActiveModesFeature.commands.setMode.params.mode.constraints.enum;
      this.platform.log.info(`DHW available modes: ${this.availableModes.join(', ')}`);
    } else {
      // Fallback: check individual mode features
      const modeFeatures = features.filter(f => f.feature.startsWith('heating.dhw.operating.modes.'));
      this.availableModes = modeFeatures
        .map(f => f.feature.split('.').pop())
        .filter(mode => mode && mode !== 'active' && mode !== 'balanced')
        .filter(Boolean);
      
      this.platform.log.info(`DHW modes found from features: ${this.availableModes.join(', ')}`);
    }

    // Analyze temperature control capabilities
    const dhwTempFeature = features.find(f => f.feature === 'heating.dhw.temperature.main');
    if (dhwTempFeature?.commands?.setTargetTemperature) {
      this.supportsTemperatureControl = true;
      const constraints = dhwTempFeature.commands.setTargetTemperature.params?.temperature?.constraints;
      if (constraints) {
        this.temperatureConstraints.min = constraints.min || 35;
        this.temperatureConstraints.max = constraints.max || 65;
      }
      this.platform.log.info(`DHW temperature control: ${this.temperatureConstraints.min}-${this.temperatureConstraints.max}°C`);
    }

    this.platform.log.info(`DHW Capabilities - Modes: [${this.availableModes.join(', ')}], Temperature: ${this.supportsTemperatureControl ? 'Yes' : 'No'}`);
  }

  private setupCharacteristics() {
    // Temperature sensor for current temperature
    this.temperatureService.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this))
      .setProps({
        minValue: 0,
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
    // Remove any existing mode services that are no longer available
    this.removeUnusedServices();

    // Create services for each available mode
    if (this.availableModes.includes('comfort')) {
      this.comfortService = this.accessory.getService('DHW Comfort') || 
                           this.accessory.addService(this.platform.Service.Switch, 'DHW Comfort', 'dhw-comfort');
      this.comfortService.setCharacteristic(this.platform.Characteristic.Name, 'DHW Comfort');
      this.comfortService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(() => this.currentMode === 'comfort')
        .onSet(this.setComfortMode.bind(this));
    }

    if (this.availableModes.includes('eco')) {
      this.ecoService = this.accessory.getService('DHW Eco') || 
                      this.accessory.addService(this.platform.Service.Switch, 'DHW Eco', 'dhw-eco');
      this.ecoService.setCharacteristic(this.platform.Characteristic.Name, 'DHW Eco');
      this.ecoService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(() => this.currentMode === 'eco')
        .onSet(this.setEcoMode.bind(this));
    }

    if (this.availableModes.includes('off')) {
      this.offService = this.accessory.getService('DHW Off') || 
                      this.accessory.addService(this.platform.Service.Switch, 'DHW Off', 'dhw-off');
      this.offService.setCharacteristic(this.platform.Characteristic.Name, 'DHW Off');
      this.offService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(() => this.currentMode === 'off')
        .onSet(this.setOffMode.bind(this));
    }
  }

  private setupTargetTemperatureService() {
    // Create a separate service for target temperature using a thermostat with minimal controls
    const targetTempServiceName = 'DHW Target Temperature';
    let targetTempService = this.accessory.getService(targetTempServiceName);
    
    if (!targetTempService) {
      targetTempService = this.accessory.addService(this.platform.Service.Thermostat, targetTempServiceName, 'dhw-target-temp');
    }

    targetTempService.setCharacteristic(this.platform.Characteristic.Name, targetTempServiceName);

    // Set to heating only mode and disable state controls
    targetTempService.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .onGet(() => this.platform.Characteristic.TargetHeatingCoolingState.HEAT)
      .onSet(() => {}) // Do nothing - we control modes via switches
      .setProps({
        validValues: [this.platform.Characteristic.TargetHeatingCoolingState.HEAT],
      });

    targetTempService.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(() => this.currentMode === 'off' ? 
        this.platform.Characteristic.CurrentHeatingCoolingState.OFF : 
        this.platform.Characteristic.CurrentHeatingCoolingState.HEAT);

    targetTempService.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this));

    targetTempService.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .onGet(this.getTargetTemperature.bind(this))
      .onSet(this.setTargetTemperature.bind(this))
      .setProps({
        minValue: this.temperatureConstraints.min,
        maxValue: this.temperatureConstraints.max,
        minStep: 1,
      });

    targetTempService.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onGet(() => 0) // Celsius
      .onSet(() => {}); // Do nothing
  }

  private removeUnusedServices() {
    // Remove services for modes that are no longer available
    const servicesToCheck = [
      { service: this.comfortService, mode: 'comfort', name: 'DHW Comfort' },
      { service: this.ecoService, mode: 'eco', name: 'DHW Eco' },
      { service: this.offService, mode: 'off', name: 'DHW Off' },
    ];

    for (const { service, mode, name } of servicesToCheck) {
      if (service && !this.availableModes.includes(mode)) {
        this.accessory.removeService(service);
        this.platform.log.info(`Removed ${name} service - mode no longer available`);
      }
    }
  }

  async setComfortMode(value: CharacteristicValue) {
    const on = value as boolean;
    
    if (on) {
      // User wants to turn ON comfort mode
      if (this.currentMode !== 'comfort') {
        await this.setMode('comfort');
      }
    } else {
      // User wants to turn OFF comfort mode
      if (this.currentMode === 'comfort') {
        // Can't turn off comfort without selecting another mode
        // Force it back to ON and show a warning
        setTimeout(() => {
          this.comfortService?.updateCharacteristic(this.platform.Characteristic.On, true);
        }, 100);
        this.platform.log.warn('Cannot turn off Comfort mode. Please select Eco or Off mode instead.');
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
      }
    }
  }

  async setEcoMode(value: CharacteristicValue) {
    const on = value as boolean;
    
    if (on) {
      // User wants to turn ON eco mode
      if (this.currentMode !== 'eco') {
        await this.setMode('eco');
      }
    } else {
      // User wants to turn OFF eco mode
      if (this.currentMode === 'eco') {
        // Can't turn off eco without selecting another mode
        // Force it back to ON and show a warning
        setTimeout(() => {
          this.ecoService?.updateCharacteristic(this.platform.Characteristic.On, true);
        }, 100);
        this.platform.log.warn('Cannot turn off Eco mode. Please select Comfort or Off mode instead.');
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
      }
    }
  }

  async setOffMode(value: CharacteristicValue) {
    const on = value as boolean;
    
    if (on) {
      // User wants to turn ON off mode (i.e., turn off the DHW)
      if (this.currentMode !== 'off') {
        await this.setMode('off');
      }
    } else {
      // User wants to turn OFF off mode (i.e., turn on the DHW)
      if (this.currentMode === 'off') {
        // Can't turn off "off mode" without selecting another mode
        // Force it back to ON and show a warning
        setTimeout(() => {
          this.offService?.updateCharacteristic(this.platform.Characteristic.On, true);
        }, 100);
        this.platform.log.warn('Cannot deactivate Off mode. Please select Comfort or Eco mode instead.');
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
      }
    }
  }

  private async setMode(mode: string) {
    try {
      // First, validate that the mode is available
      if (!this.availableModes.includes(mode)) {
        this.platform.log.error(`Mode ${mode} is not available. Available modes: ${this.availableModes.join(', ')}`);
        throw new Error(`Mode ${mode} not available`);
      }

      const success = await this.executeDHWCommand(mode);
      
      if (success) {
        const oldMode = this.currentMode;
        this.currentMode = mode;
        this.platform.log.info(`DHW mode changed: ${oldMode.toUpperCase()} → ${mode.toUpperCase()}`);
        
        // CRITICAL: Update all switch states with proper exclusivity
        this.updateAllSwitchStatesExclusive();
      } else {
        this.platform.log.error(`Failed to set DHW mode to: ${mode}`);
        // Restore the previous switch state
        this.updateAllSwitchStatesExclusive();
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
    } catch (error) {
      this.platform.log.error(`Error setting DHW mode to ${mode}:`, error);
      // Restore the previous switch state
      this.updateAllSwitchStatesExclusive();
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private updateAllSwitchStatesExclusive() {
    // ENSURE MUTUAL EXCLUSION: Only one switch can be ON at a time
    const isComfort = this.currentMode === 'comfort';
    const isEco = this.currentMode === 'eco';
    const isOff = this.currentMode === 'off';
    
    if (this.comfortService) {
      this.comfortService.updateCharacteristic(this.platform.Characteristic.On, isComfort);
    }
    
    if (this.ecoService) {
      this.ecoService.updateCharacteristic(this.platform.Characteristic.On, isEco);
    }
    
    if (this.offService) {
      this.offService.updateCharacteristic(this.platform.Characteristic.On, isOff);
    }
    
    // Logging for verification
    this.platform.log.debug(`DHW Switch States - Comfort: ${isComfort}, Eco: ${isEco}, Off: ${isOff} (Mode: ${this.currentMode.toUpperCase()})`);
    
    // Safety check: Verify exactly one switch is ON
    const activeSwitches = [isComfort, isEco, isOff].filter(state => state).length;
    if (activeSwitches !== 1) {
      this.platform.log.error(`CRITICAL: Multiple switches active! Comfort: ${isComfort}, Eco: ${isEco}, Off: ${isOff}`);
    }
  }

  private async executeDHWCommand(mode: string): Promise<boolean> {
    try {
      const success = await this.platform.viessmannAPI.executeCommand(
        this.installation.id,
        this.gateway.serial,
        this.device.id,
        'heating.dhw.operating.modes.active',
        'setMode',
        { mode }
      );
      
      if (success) {
        this.platform.log.debug(`Successfully set DHW mode to: ${mode}`);
      }
      return success;
    } catch (error) {
      this.platform.log.debug(`Failed to set DHW mode to ${mode}:`, error instanceof Error ? error.message : error);
      return false;
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
    
    if (temperature < this.temperatureConstraints.min || temperature > this.temperatureConstraints.max) {
      this.platform.log.error(`Invalid DHW temperature: ${temperature}°C (must be between ${this.temperatureConstraints.min}-${this.temperatureConstraints.max}°C)`);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
    }
    
    this.states.TargetTemperature = temperature;

    try {
      const success = await this.platform.viessmannAPI.setDHWTemperature(
        this.installation.id,
        this.gateway.serial,
        this.device.id,
        temperature
      );

      if (success) {
        this.platform.log.info(`DHW target temperature: ${temperature}°C (Mode: ${this.currentMode.toUpperCase()})`);
      } else {
        this.platform.log.error(`Failed to set DHW target temperature to: ${temperature}°C`);
        throw new Error('Failed to set DHW target temperature');
      }
    } catch (error) {
      this.platform.log.error('Error setting DHW target temperature:', error);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private async handleUpdate(features: any[]) {
    try {
      await this.updateFromFeatures(features);
    } catch (error) {
      this.platform.log.error('Error handling DHW update:', error);
    }
  }

  private async updateFromFeatures(features: any[]) {
    // Update DHW current temperature
    const dhwTempFeature = features.find(f => 
      f.feature === 'heating.dhw.sensors.temperature.dhwCylinder' ||
      f.feature === 'heating.dhw.sensors.temperature.hotWaterStorage' ||
      f.feature === 'heating.dhw.sensors.temperature.outlet'
    );
    if (dhwTempFeature?.properties?.value?.value !== undefined) {
      this.states.CurrentTemperature = dhwTempFeature.properties.value.value;
      this.temperatureService.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.states.CurrentTemperature);
    }

    // Update DHW target temperature
    const dhwTargetTempFeature = features.find(f => f.feature === 'heating.dhw.temperature.main');
    if (dhwTargetTempFeature?.properties?.value?.value !== undefined && this.supportsTemperatureControl) {
      const targetTemp = dhwTargetTempFeature.properties.value.value;
      if (targetTemp >= this.temperatureConstraints.min && targetTemp <= this.temperatureConstraints.max) {
        this.states.TargetTemperature = targetTemp;
      }
    }

    // Update DHW operating mode
    const dhwOperatingModeFeature = features.find(f => f.feature === 'heating.dhw.operating.modes.active');
    if (dhwOperatingModeFeature?.properties?.value?.value !== undefined) {
      const newMode = dhwOperatingModeFeature.properties.value.value;
      if (newMode !== this.currentMode) {
        this.platform.log.debug(`DHW mode updated: ${this.currentMode.toUpperCase()} → ${newMode.toUpperCase()}`);
        this.currentMode = newMode;
        this.updateAllSwitchStatesExclusive();
      }
    }

    this.platform.log.debug(`DHW Status - Mode: ${this.currentMode.toUpperCase()}, Temp: ${this.states.CurrentTemperature}°C → ${this.states.TargetTemperature}°C`);
  }
}