import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { ViessmannPlatform, ViessmannInstallation, ViessmannGateway, ViessmannDevice } from '../platform';

export class ViessmannDHWAccessory {
  private service: Service;
  private informationService: Service;
  private availableModes: string[] = [];
  private supportsTemperatureControl = false;
  private temperatureConstraints = { min: 35, max: 65 };

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
        .filter(mode => mode && mode !== 'active' && mode !== 'balanced') // Remove non-selectable modes
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

    // Log capabilities summary
    this.platform.log.info(`DHW Capabilities - Modes: [${this.availableModes.join(', ')}], Temperature: ${this.supportsTemperatureControl ? 'Yes' : 'No'}`);
  }

  private setupCharacteristics() {
    // Current Heating Cooling State (read-only)
    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.getCurrentHeatingCoolingState.bind(this));

    // Target Heating Cooling State - only show if we have controllable modes
    if (this.availableModes.length > 0) {
      const validValues = [];
      
      // Always include OFF if we have controllable modes
      validValues.push(this.platform.Characteristic.TargetHeatingCoolingState.OFF);
      
      // Add HEAT if we have modes other than 'off'
      if (this.availableModes.some(mode => mode !== 'off')) {
        validValues.push(this.platform.Characteristic.TargetHeatingCoolingState.HEAT);
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
        minValue: 0,
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
          minStep: 1,
        });
    }

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
      let success = false;
      let mode: string;
      
      if (targetState === this.platform.Characteristic.TargetHeatingCoolingState.OFF) {
        // Try to turn off DHW
        mode = 'off';
        if (this.availableModes.includes('off')) {
          success = await this.executeDHWCommand(mode);
        }
      } else {
        // Try to turn on DHW - prefer comfort, then eco, then any available mode
        const preferredModes = ['comfort', 'eco'];
        
        for (const preferredMode of preferredModes) {
          if (this.availableModes.includes(preferredMode)) {
            mode = preferredMode;
            success = await this.executeDHWCommand(mode);
            if (success) break;
          }
        }
        
        // If preferred modes failed, try any non-off mode
        if (!success) {
          const otherModes = this.availableModes.filter(m => m !== 'off');
          for (const otherMode of otherModes) {
            mode = otherMode;
            success = await this.executeDHWCommand(mode);
            if (success) break;
          }
        }
      }

      if (success) {
        this.platform.log.info(`Set DHW mode to: ${mode}`);
      } else {
        this.platform.log.warn(`Failed to set DHW state. Available modes: ${this.availableModes.join(', ')}`);
        // Don't throw error as device might not support mode changes
      }
    } catch (error) {
      this.platform.log.error('Error setting DHW target heating cooling state:', error);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
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
    
    // Validate temperature range
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

  private async updateFromFeatures(features: any[]) {
    // Update DHW current temperature
    const dhwTempFeature = features.find(f => 
      f.feature === 'heating.dhw.sensors.temperature.dhwCylinder' ||
      f.feature === 'heating.dhw.sensors.temperature.hotWaterStorage' ||
      f.feature === 'heating.dhw.sensors.temperature.outlet'
    );
    if (dhwTempFeature?.properties?.value?.value !== undefined) {
      this.states.CurrentTemperature = dhwTempFeature.properties.value.value;
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.states.CurrentTemperature);
    }

    // Update DHW target temperature
    const dhwTargetTempFeature = features.find(f => f.feature === 'heating.dhw.temperature.main');
    if (dhwTargetTempFeature?.properties?.value?.value !== undefined && this.supportsTemperatureControl) {
      const targetTemp = dhwTargetTempFeature.properties.value.value;
      // Ensure target temperature is within valid range
      if (targetTemp >= this.temperatureConstraints.min && targetTemp <= this.temperatureConstraints.max) {
        this.states.TargetTemperature = targetTemp;
        this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, this.states.TargetTemperature);
      }
    }

    // Update DHW charging state (current heating state)
    const dhwChargingFeature = features.find(f => f.feature === 'heating.dhw.charging');
    const dhwActiveFeature = features.find(f => f.feature === 'heating.dhw');
    
    let isHeating = false;
    if (dhwChargingFeature?.properties?.active?.value !== undefined) {
      isHeating = dhwChargingFeature.properties.active.value;
    } else if (dhwActiveFeature?.properties?.status?.value !== undefined) {
      // Fallback: check if DHW status indicates heating
      isHeating = dhwActiveFeature.properties.status.value !== 'off';
    }
    
    this.states.CurrentHeatingCoolingState = isHeating ? 
      this.platform.Characteristic.CurrentHeatingCoolingState.HEAT : 
      this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
      
    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentHeatingCoolingState, 
      this.states.CurrentHeatingCoolingState
    );

    // Update DHW operating mode (target heating state)
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