import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { ViessmannPlatform, ViessmannInstallation, ViessmannGateway, ViessmannDevice, ViessmannPlatformConfig } from '../platform';


export class ViessmannBoilerAccessory {
  private heaterCoolerService: Service;
  private informationService: Service;
  private modulationService?: Service;
  private burnerService?: Service;
  
  private supportsTemperatureControl = false;
  private temperatureConstraints = { min: 10, max: 80 };
  private currentBurnerState = false;
  private currentModulation = 0;

  private states = {
    CurrentTemperature: 20,
    HeatingThresholdTemperature: 20,
    TemperatureDisplayUnits: 0, // Celsius
    BurnerActive: false,
    Modulation: 0,
    BurnerHours: 0,
    BurnerStarts: 0,
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

    // Main HeaterCooler service for boiler
    this.heaterCoolerService = this.accessory.getService(this.platform.Service.HeaterCooler) || 
                               this.accessory.addService(this.platform.Service.HeaterCooler);

    this.heaterCoolerService.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

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
      this.platform.log.error('Error initializing boiler capabilities:', error);
      // Fallback to basic setup
      this.setupCharacteristics();
    }
  }

  private analyzeCapabilities(features: any[]) {
    // Analyze boiler temperature control
    const boilerTempFeature = features.find(f => f.feature === 'heating.boiler.temperature');
    if (boilerTempFeature?.commands?.setTargetTemperature) {
      this.supportsTemperatureControl = true;
      const constraints = boilerTempFeature.commands.setTargetTemperature.params?.temperature?.constraints;
      if (constraints) {
        this.temperatureConstraints.min = constraints.min || 10;
        this.temperatureConstraints.max = constraints.max || 80;
      }
      this.platform.log.info(`Boiler temperature control: ${this.temperatureConstraints.min}-${this.temperatureConstraints.max}°C`);
    }

    // Check burner capabilities
    const burnerFeature = features.find(f => f.feature === 'heating.burners.0');
    const modulationFeature = features.find(f => f.feature === 'heating.burners.0.modulation');
    const statisticsFeature = features.find(f => f.feature === 'heating.burners.0.statistics');

    if (burnerFeature) {
      this.currentBurnerState = burnerFeature.properties?.active?.value || false;
    }

    if (modulationFeature) {
      this.currentModulation = modulationFeature.properties?.value?.value || 0;
    }

    if (statisticsFeature) {
      this.states.BurnerHours = statisticsFeature.properties?.hours?.value || 0;
      this.states.BurnerStarts = statisticsFeature.properties?.starts?.value || 0;
    }

    // Get current boiler temperature
    if (boilerTempFeature?.properties?.value?.value !== undefined) {
      this.states.HeatingThresholdTemperature = boilerTempFeature.properties.value.value;
    }

    this.platform.log.info(`Boiler Capabilities - Temperature: ${this.supportsTemperatureControl ? 'Yes' : 'No'}, Burner: ${burnerFeature ? 'Yes' : 'No'}, Modulation: ${modulationFeature ? 'Yes' : 'No'}`);
  }

  private setupCharacteristics() {
    // Remove any existing conflicting services
    this.removeConflictingServices();

    // Configure HeaterCooler service
    this.setupHeaterCoolerService();

    // Setup burner status service
    this.setupBurnerService();

    // Setup modulation service
    this.setupModulationService();
  }

  private removeConflictingServices() {
    // Remove existing thermostat, temperature sensor services
    const servicesToRemove = [
      this.platform.Service.Thermostat,
      this.platform.Service.TemperatureSensor
    ];

    for (const serviceType of servicesToRemove) {
      const services = this.accessory.services.filter(service => service.UUID === serviceType.UUID);
      for (const service of services) {
        try {
          this.accessory.removeService(service);
          this.platform.log.debug(`Removed existing ${service.constructor.name} service for boiler`);
        } catch (error) {
          this.platform.log.debug(`Could not remove service: ${error}`);
        }
      }
    }
  }

  private setupHeaterCoolerService() {
    // Active characteristic (On/Off) - based on burner state
    this.heaterCoolerService.getCharacteristic(this.platform.Characteristic.Active)
      .onGet(() => this.currentBurnerState ? 
        this.platform.Characteristic.Active.ACTIVE : 
        this.platform.Characteristic.Active.INACTIVE)
      .onSet(async (value: CharacteristicValue) => {
        // Boiler active state is read-only, controlled by system
        setTimeout(() => {
          this.heaterCoolerService.updateCharacteristic(this.platform.Characteristic.Active, 
            this.currentBurnerState ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE);
        }, 100);
        this.platform.log.warn('Boiler active state is read-only and controlled automatically by the system');
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.READ_ONLY_CHARACTERISTIC);
      });

    // Current Heater Cooler State (read-only)
    this.heaterCoolerService.getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
      .onGet(() => {
        if (!this.currentBurnerState) {
          return this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE;
        }
        // Boiler is always in heating mode when active
        return this.platform.Characteristic.CurrentHeaterCoolerState.HEATING;
      });

    // Target Heater Cooler State
    this.heaterCoolerService.getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
      .updateValue(this.platform.Characteristic.TargetHeaterCoolerState.HEAT) // Set valid value FIRST
      .onGet(() => this.platform.Characteristic.TargetHeaterCoolerState.HEAT) // Boilers are always heating
      .onSet(() => {}) // Read-only - always heat for boilers
      .setProps({
        validValues: [this.platform.Characteristic.TargetHeaterCoolerState.HEAT],
      });

    // Current Temperature
    this.heaterCoolerService.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this))
      .setProps({
        minValue: -50,
        maxValue: 150,
        minStep: 0.1,
      });

    // Heating Threshold Temperature (target temperature for heating)
    if (this.supportsTemperatureControl) {
      const validTemp = Math.min(Math.max(this.states.HeatingThresholdTemperature, this.temperatureConstraints.min), this.temperatureConstraints.max);
      
      this.heaterCoolerService.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
        .updateValue(validTemp) // Set valid value FIRST
        .onGet(this.getHeatingThresholdTemperature.bind(this))
        .onSet(this.setHeatingThresholdTemperature.bind(this))
        .setProps({
          minValue: this.temperatureConstraints.min,
          maxValue: this.temperatureConstraints.max,
          minStep: 1,
        });

      // Update internal state
      this.states.HeatingThresholdTemperature = validTemp;
    }

    // Temperature Display Units
    this.heaterCoolerService.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onGet(() => this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS)
      .onSet(() => {}); // Read-only
  }

private setupBurnerService() {
    const config = this.platform.config as ViessmannPlatformConfig;
    const customNames = config.customNames || {};
  
    // 🔧 FIXED: Use custom names properly with fallbacks
    const installationName = customNames.installationPrefix || this.installation.description;
    const boilerName = customNames.boiler || 'Boiler';
    const burnerName = customNames.burner || 'Burner';

    // 🔍 DEBUG: Log dei nomi per verificare la generazione
    this.platform.log.info(`🏷️ Boiler Setup - Installation: "${installationName}", Boiler: "${boilerName}", Burner: "${burnerName}"`);
    
    // Remove existing burner services first
    const existingBurnerService = this.accessory.services.find(service => 
      service.UUID === this.platform.Service.Switch.UUID && 
      (service.subtype === 'boiler-burner' || service.subtype?.startsWith('boiler-burner-'))
    );

    if (existingBurnerService) {
      try {
        this.accessory.removeService(existingBurnerService);
        this.platform.log.debug('Removed existing burner service');
      } catch (error) {
        this.platform.log.debug(`Could not remove burner service: ${error}`);
      }
    }

    // 🔧 DYNAMIC: Use timestamp-based version for automatic recreation
    const subtypeVersion = config.forceServiceRecreation ? 
      Date.now().toString().slice(-8) : // Last 8 digits of timestamp
      'stable'; // Use stable version normally
    
    this.platform.log.info(`🔧 Boiler Burner using service subtype version: ${subtypeVersion}`);

    // Create burner status service (read-only switch)  
    const burnerServiceName = `${installationName} ${boilerName} ${burnerName}`;
    this.platform.log.info(`🏷️ Creating Burner service: "${burnerServiceName}"`);
    
    this.burnerService = this.accessory.addService(
      this.platform.Service.Switch, 
      burnerServiceName, 
      `boiler-burner-${subtypeVersion}` // 🔧 DYNAMIC SUBTYPE
    );
    
    // 🔧 CRITICAL: Set both Name characteristic AND displayName
    this.burnerService.setCharacteristic(this.platform.Characteristic.Name, burnerServiceName);
    this.burnerService.displayName = burnerServiceName;
    
    this.burnerService.getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.states.BurnerActive)
      .onSet(async (value: CharacteristicValue) => {
        // Burner is read-only, restore previous state
        setTimeout(() => {
          this.burnerService?.updateCharacteristic(this.platform.Characteristic.On, this.states.BurnerActive);
        }, 100);
        this.platform.log.warn('Burner state is read-only and controlled automatically by the system');
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.READ_ONLY_CHARACTERISTIC);
      });

    this.platform.log.info(`✅ Boiler burner service setup completed with subtype version: ${subtypeVersion}`);
  }

  private setupModulationService() {
    const config = this.platform.config as ViessmannPlatformConfig;
    const customNames = config.customNames || {};
  
    // 🔧 FIXED: Use custom names properly with fallbacks
    const installationName = customNames.installationPrefix || this.installation.description;
    const boilerName = customNames.boiler || 'Boiler';
    const modulationName = customNames.modulation || 'Modulation';

    // 🔍 DEBUG: Log dei nomi per verificare la generazione
    this.platform.log.info(`🏷️ Boiler Setup - Installation: "${installationName}", Boiler: "${boilerName}", Modulation: "${modulationName}"`);
    
    // Remove existing modulation services first
    const existingModulationService = this.accessory.services.find(service => 
      service.UUID === this.platform.Service.Lightbulb.UUID && 
      (service.subtype === 'boiler-modulation' || service.subtype?.startsWith('boiler-modulation-'))
    );

    if (existingModulationService) {
      try {
        this.accessory.removeService(existingModulationService);
        this.platform.log.debug('Removed existing modulation service');
      } catch (error) {
        this.platform.log.debug(`Could not remove modulation service: ${error}`);
      }
    }

    // 🔧 DYNAMIC: Use timestamp-based version for automatic recreation
    const subtypeVersion = config.forceServiceRecreation ? 
      Date.now().toString().slice(-8) : // Last 8 digits of timestamp
      'stable'; // Use stable version normally
    
    this.platform.log.info(`🔧 Boiler Modulation using service subtype version: ${subtypeVersion}`);

    // Create modulation service using Lightbulb with brightness (read-only)
    const modulationServiceName = `${installationName} ${boilerName} ${modulationName}`;
    this.platform.log.info(`🏷️ Creating Modulation service: "${modulationServiceName}"`);
    
    this.modulationService = this.accessory.addService(
      this.platform.Service.Lightbulb, 
      modulationServiceName, 
      `boiler-modulation-${subtypeVersion}` // 🔧 DYNAMIC SUBTYPE
    );
    
    // 🔧 CRITICAL: Set both Name characteristic AND displayName
    this.modulationService.setCharacteristic(this.platform.Characteristic.Name, modulationServiceName);
    this.modulationService.displayName = modulationServiceName;
    
    this.modulationService.getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.states.Modulation > 0)
      .onSet(async (value: CharacteristicValue) => {
        // Modulation is read-only, restore previous state
        setTimeout(() => {
          this.modulationService?.updateCharacteristic(this.platform.Characteristic.On, this.states.Modulation > 0);
        }, 100);
        this.platform.log.warn('Modulation is read-only and controlled automatically by the system');
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.READ_ONLY_CHARACTERISTIC);
      });

    this.modulationService.getCharacteristic(this.platform.Characteristic.Brightness)
      .onGet(() => this.states.Modulation)
      .onSet(async (value: CharacteristicValue) => {
        // Modulation is read-only, restore previous state
        setTimeout(() => {
          this.modulationService?.updateCharacteristic(this.platform.Characteristic.Brightness, this.states.Modulation);
        }, 100);
        this.platform.log.warn('Modulation level is read-only and controlled automatically by the system');
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.READ_ONLY_CHARACTERISTIC);
      })
      .setProps({
        minValue: 0,
        maxValue: 100,
        minStep: 1,
      });

    this.platform.log.info(`✅ Boiler modulation service setup completed with subtype version: ${subtypeVersion}`);
  }

  async getCurrentTemperature(): Promise<CharacteristicValue> {
    return this.states.CurrentTemperature;
  }

  async getHeatingThresholdTemperature(): Promise<CharacteristicValue> {
    return Math.min(Math.max(this.states.HeatingThresholdTemperature, this.temperatureConstraints.min), this.temperatureConstraints.max);
  }

  async setHeatingThresholdTemperature(value: CharacteristicValue) {
    if (!this.supportsTemperatureControl) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.READ_ONLY_CHARACTERISTIC);
    }

    const temperature = value as number;
    
    if (temperature < this.temperatureConstraints.min || temperature > this.temperatureConstraints.max) {
      this.platform.log.error(`Invalid boiler temperature: ${temperature}°C (must be between ${this.temperatureConstraints.min}-${this.temperatureConstraints.max}°C)`);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
    }
    
    this.states.HeatingThresholdTemperature = temperature;

    try {
      const success = await this.platform.viessmannAPI.executeCommand(
        this.installation.id,
        this.gateway.serial,
        this.device.id,
        'heating.boiler.temperature',
        'setTargetTemperature',
        { temperature }
      );

      if (success) {
        this.platform.log.info(`Boiler target temperature set to: ${temperature}°C`);
      } else {
        this.platform.log.error(`Failed to set boiler target temperature to: ${temperature}°C`);
        throw new Error('Failed to set boiler target temperature');
      }
    } catch (error) {
      this.platform.log.error('Error setting boiler target temperature:', error);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private async handleUpdate(features: any[]) {
    try {
      await this.updateFromFeatures(features);
    } catch (error) {
      this.platform.log.error('Error handling boiler update:', error);
    }
  }

  private async updateFromFeatures(features: any[]) {
    // Update boiler current temperature (common supply temperature)
    const boilerTempFeature = features.find(f => f.feature === 'heating.boiler.sensors.temperature.commonSupply');
    if (boilerTempFeature?.properties?.value?.value !== undefined) {
      this.states.CurrentTemperature = boilerTempFeature.properties.value.value;
      this.heaterCoolerService.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.states.CurrentTemperature);
    }

    // Update boiler target temperature
    const boilerTargetTempFeature = features.find(f => f.feature === 'heating.boiler.temperature');
    if (boilerTargetTempFeature?.properties?.value?.value !== undefined && this.supportsTemperatureControl) {
      const targetTemp = boilerTargetTempFeature.properties.value.value;
      if (targetTemp >= this.temperatureConstraints.min && targetTemp <= this.temperatureConstraints.max) {
        this.states.HeatingThresholdTemperature = targetTemp;
        this.heaterCoolerService.updateCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature, targetTemp);
      }
    }

    // Update burner status
    const burnerFeature = features.find(f => f.feature === 'heating.burners.0');
    if (burnerFeature?.properties?.active?.value !== undefined) {
      const newBurnerState = burnerFeature.properties.active.value;
      if (newBurnerState !== this.states.BurnerActive) {
        this.states.BurnerActive = newBurnerState;
        this.currentBurnerState = newBurnerState;
        
        // Update HeaterCooler active state
        this.heaterCoolerService.updateCharacteristic(this.platform.Characteristic.Active, 
          newBurnerState ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE);
        
        this.heaterCoolerService.updateCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState,
          newBurnerState ? this.platform.Characteristic.CurrentHeaterCoolerState.HEATING : 
                           this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE);
        
        if (this.burnerService) {
          this.burnerService.updateCharacteristic(this.platform.Characteristic.On, newBurnerState);
        }
        
        this.platform.log.debug(`Boiler burner ${newBurnerState ? 'activated' : 'deactivated'}`);
      }
    }

    // Update modulation
    const modulationFeature = features.find(f => f.feature === 'heating.burners.0.modulation');
    if (modulationFeature?.properties?.value?.value !== undefined) {
      const newModulation = modulationFeature.properties.value.value;
      if (newModulation !== this.states.Modulation) {
        this.states.Modulation = newModulation;
        this.currentModulation = newModulation;
        
        if (this.modulationService) {
          this.modulationService.updateCharacteristic(this.platform.Characteristic.On, newModulation > 0);
          this.modulationService.updateCharacteristic(this.platform.Characteristic.Brightness, newModulation);
        }
        
        this.platform.log.debug(`Boiler modulation: ${newModulation}%`);
      }
    }

    // Update burner statistics
    const statisticsFeature = features.find(f => f.feature === 'heating.burners.0.statistics');
    if (statisticsFeature?.properties?.hours?.value !== undefined) {
      this.states.BurnerHours = statisticsFeature.properties.hours.value;
    }
    if (statisticsFeature?.properties?.starts?.value !== undefined) {
      this.states.BurnerStarts = statisticsFeature.properties.starts.value;
    }

    this.platform.log.debug(`Boiler Status - Temp: ${this.states.CurrentTemperature}°C → ${this.states.HeatingThresholdTemperature}°C, Burner: ${this.states.BurnerActive ? 'ON' : 'OFF'}, Modulation: ${this.states.Modulation}%`);
  }
}