import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { ViessmannPlatform, ViessmannInstallation, ViessmannGateway, ViessmannDevice, ViessmannPlatformConfig } from '../platform';
import { BURNER_UPDATE_CONFIG } from '../settings';

export class ViessmannDHWAccessory {
  private heaterCoolerService: Service;
  private informationService: Service;
  private comfortService?: Service;
  private ecoService?: Service;
  private offService?: Service;
  
  private availableModes: string[] = [];
  private supportsTemperatureControl = false;
  private temperatureConstraints = { min: 30, max: 60 }; // Default DHW temperature range
  private currentMode = 'off';

  private states = {
    CurrentTemperature: 40,
    HeatingThresholdTemperature: 50,
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

    // Create HeaterCooler service (configured for DHW use)
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

    // Get current mode
    if (dhwActiveModesFeature?.properties?.value?.value) {
      this.currentMode = dhwActiveModesFeature.properties.value.value;
      this.platform.log.info(`DHW current mode: ${this.currentMode}`);
    }

    // Analyze temperature control capabilities
    const dhwTempFeature = features.find(f => f.feature === 'heating.dhw.temperature.main');
    if (dhwTempFeature?.commands?.setTargetTemperature) {
      this.supportsTemperatureControl = true;
      const constraints = dhwTempFeature.commands.setTargetTemperature.params?.temperature?.constraints;
      if (constraints) {
        // Ensure constraints are valid and in the right order
        const minTemp = constraints.min || 30;
        const maxTemp = constraints.max || 60;
        
        // Validate constraints
        if (minTemp < maxTemp && minTemp >= 10 && maxTemp <= 80) {
          this.temperatureConstraints.min = minTemp;
          this.temperatureConstraints.max = maxTemp;
        } else {
          this.platform.log.warn(`Invalid DHW temperature constraints from API: min=${minTemp}, max=${maxTemp}. Using defaults: 30-60°C`);
          this.temperatureConstraints = { min: 30, max: 60 };
        }
      } else {
        this.platform.log.warn('No temperature constraints found in DHW API response. Using defaults: 30-60°C');
        this.temperatureConstraints = { min: 30, max: 60 };
      }
      this.platform.log.info(`DHW temperature control: ${this.temperatureConstraints.min}-${this.temperatureConstraints.max}°C`);
    } else {
      // Set reasonable defaults even if no temperature control
      this.temperatureConstraints.min = 30;
      this.temperatureConstraints.max = 60;
      this.platform.log.info('DHW temperature control not available');
    }

    // Get current target temperature and validate it
    if (dhwTempFeature?.properties?.value?.value !== undefined) {
      const currentTarget = dhwTempFeature.properties.value.value;
      if (currentTarget >= this.temperatureConstraints.min && currentTarget <= this.temperatureConstraints.max) {
        this.states.HeatingThresholdTemperature = currentTarget;
      } else {
        this.platform.log.warn(`DHW target temperature ${currentTarget}°C is outside valid range. Using default: 50°C`);
        this.states.HeatingThresholdTemperature = 50;
      }
    }

    this.platform.log.info(`DHW Capabilities - Modes: [${this.availableModes.join(', ')}], Temperature: ${this.supportsTemperatureControl ? 'Yes' : 'No'}`);
  }

private setupCharacteristics() {
    // Remove any existing conflicting services
    this.removeConflictingServices();

    // Configure HeaterCooler service (optimized for DHW)
    this.setupHeaterCoolerService();

    // Create mode switches
    this.setupModeServices();
  }

  private removeConflictingServices() {
    // Remove existing thermostat, temperature sensor, and lightbulb services
    const servicesToRemove = [
      this.platform.Service.Thermostat,
      this.platform.Service.TemperatureSensor,
      this.platform.Service.Lightbulb
    ];

    for (const serviceType of servicesToRemove) {
      const services = this.accessory.services.filter(service => service.UUID === serviceType.UUID);
      for (const service of services) {
        try {
          this.accessory.removeService(service);
          this.platform.log.debug(`Removed existing ${service.constructor.name} service`);
        } catch (error) {
          this.platform.log.debug(`Could not remove service: ${error}`);
        }
      }
    }
  }

  private setupHeaterCoolerService() {
    // Active characteristic (On/Off)
    this.heaterCoolerService.getCharacteristic(this.platform.Characteristic.Active)
      .onGet(() => this.currentMode !== 'off' ? 
        this.platform.Characteristic.Active.ACTIVE : 
        this.platform.Characteristic.Active.INACTIVE)
      .onSet(this.setActive.bind(this));

    // Current Heater Cooler State (read-only)
    this.heaterCoolerService.getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
      .onGet(() => {
        if (this.currentMode === 'off') {
          return this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE;
        }
        // For DHW, we're always in heating mode when active
        return this.platform.Characteristic.CurrentHeaterCoolerState.HEATING;
      });

    // Target Heater Cooler State
    this.heaterCoolerService.getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
      .updateValue(this.platform.Characteristic.TargetHeaterCoolerState.HEAT) // Set valid value FIRST
      .onGet(() => this.platform.Characteristic.TargetHeaterCoolerState.HEAT) // DHW is always heating
      .onSet(() => {}) // Read-only - always heat for DHW
      .setProps({
        validValues: [this.platform.Characteristic.TargetHeaterCoolerState.HEAT],
      });

    // Current Temperature
    this.heaterCoolerService.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this))
      .setProps({
        minValue: 0,
        maxValue: 100,
        minStep: 0.1,
      });

    // 🔧 CORRECTED: Use HeatingThresholdTemperature with proper range configuration
    if (this.supportsTemperatureControl) {
      // Validate and fix temperature constraints
      let minTemp = this.temperatureConstraints.min;
      let maxTemp = this.temperatureConstraints.max;
      
      // Ensure constraints are valid
      if (minTemp >= maxTemp || minTemp < 0 || maxTemp > 100) {
        this.platform.log.warn(`Invalid DHW temperature constraints from API: min=${minTemp}, max=${maxTemp}. Using safe defaults.`);
        minTemp = 30;
        maxTemp = 60;
        this.temperatureConstraints = { min: minTemp, max: maxTemp };
      }
      
      // Ensure the current target temperature is within valid bounds
      let targetTemp = this.states.HeatingThresholdTemperature;
      if (targetTemp < minTemp || targetTemp > maxTemp) {
        targetTemp = Math.max(minTemp, Math.min(maxTemp, 50)); // Default to 50°C if out of range
        this.states.HeatingThresholdTemperature = targetTemp;
        this.platform.log.warn(`DHW target temperature was out of range, set to ${targetTemp}°C`);
      }
      
      // Use HeatingThresholdTemperature with CORRECT range setup
      const heatingThresholdChar = this.heaterCoolerService.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature);
      
      // CRITICAL FIX: Set default value to minimum before setting props to avoid 0°C validation error
      heatingThresholdChar.value = Math.max(targetTemp, minTemp);
      
      // THEN: Set properties with correct range
      heatingThresholdChar.setProps({
        minValue: minTemp,
        maxValue: maxTemp,
        minStep: 1,
      });
      
      // FINALLY: Update value and set handlers
      heatingThresholdChar
        .updateValue(targetTemp)
        .onGet(() => this.states.HeatingThresholdTemperature)
        .onSet(this.setHeatingThresholdTemperature.bind(this));
      
      this.platform.log.debug(`DHW HeatingThresholdTemperature configured: value=${targetTemp}°C, range=${minTemp}-${maxTemp}°C`);
    }

    // Temperature Display Units
    this.heaterCoolerService.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onGet(() => this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS)
      .onSet(() => {}); // Read-only
  }

  private setupModeServices() {
    const config = this.platform.config as ViessmannPlatformConfig;
    const customNames = config.customNames || {};  
    
    // 🔧 FIXED: Use custom names properly with fallbacks - KEEPING installation name
    const installationName = customNames.installationPrefix || this.installation.description;
    const dhwName = customNames.dhw || 'DHW';
    const comfortName = customNames.comfort || 'Comfort';
    const ecoName = customNames.eco || 'Eco';
    const offName = customNames.off || 'Off';

    // 🔍 DEBUG: Log dei nomi per verificare la generazione
    this.platform.log.info(`🏷️ DHW Setup - Installation: "${installationName}", DHW: "${dhwName}"`);
    this.platform.log.info(`🏷️ DHW Setup - Comfort: "${comfortName}", Eco: "${ecoName}", Off: "${offName}"`);

    // First, remove ALL existing mode services to avoid conflicts
    this.removeAllModeServices();

    // 🔧 DYNAMIC: Use timestamp-based version for automatic recreation
    const subtypeVersion = config.forceServiceRecreation ? 
      Date.now().toString().slice(-8) : // Last 8 digits of timestamp
      'stable'; // Use stable version normally
    
    this.platform.log.info(`🔧 DHW using service subtype version: ${subtypeVersion}`);

    // 🔧 FIXED: Create services with installation name like other accessories
    if (this.availableModes.includes('comfort')) {
      // Format with installation name: "Casa Mia DHW Comfort"
      const comfortServiceName = `${installationName} ${dhwName} ${comfortName}`;
      this.platform.log.info(`🏷️ Creating Comfort service: "${comfortServiceName}"`);
      
      this.comfortService = this.accessory.addService(
        this.platform.Service.Switch, 
        comfortServiceName, 
        `dhw-comfort-${subtypeVersion}` // 🔧 DYNAMIC SUBTYPE
      );
      
      // 🔧 CRITICAL: Set displayName immediately
      this.comfortService.displayName = comfortServiceName;
      
      // 🔧 IMPROVED: Set Name characteristic with delay and safety check
      setTimeout(() => {
        if (this.comfortService) { // 🛡️ SAFETY CHECK - prevents undefined error
          this.comfortService.setCharacteristic(this.platform.Characteristic.Name, comfortServiceName);
          this.comfortService.updateCharacteristic(this.platform.Characteristic.Name, comfortServiceName);
        }
      }, 1000);
      
      this.comfortService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(() => this.currentMode === 'comfort')
        .onSet(this.setComfortMode.bind(this));
    }

    if (this.availableModes.includes('eco')) {
      // Format with installation name: "Casa Mia DHW Eco"
      const ecoServiceName = `${installationName} ${dhwName} ${ecoName}`;
      this.platform.log.info(`🏷️ Creating Eco service: "${ecoServiceName}"`);
      
      this.ecoService = this.accessory.addService(
        this.platform.Service.Switch, 
        ecoServiceName, 
        `dhw-eco-${subtypeVersion}` // 🔧 DYNAMIC SUBTYPE
      );
      
      // 🔧 CRITICAL: Set both Name characteristic AND displayName
      this.ecoService.setCharacteristic(this.platform.Characteristic.Name, ecoServiceName);
      this.ecoService.displayName = ecoServiceName;
      
      this.ecoService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(() => this.currentMode === 'eco')
        .onSet(this.setEcoMode.bind(this));
    }

    if (this.availableModes.includes('off')) {
      // Format with installation name: "Casa Mia DHW Off"
      const offServiceName = `${installationName} ${dhwName} ${offName}`;
      this.platform.log.info(`🏷️ Creating Off service: "${offServiceName}"`);
      
      this.offService = this.accessory.addService(
        this.platform.Service.Switch, 
        offServiceName, 
        `dhw-off-${subtypeVersion}` // 🔧 DYNAMIC SUBTYPE
      );
      
      // 🔧 CRITICAL: Set both Name characteristic AND displayName  
      this.offService.setCharacteristic(this.platform.Characteristic.Name, offServiceName);
      this.offService.displayName = offServiceName;
      
      this.offService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(() => this.currentMode === 'off')
        .onSet(this.setOffMode.bind(this));
    }

    this.platform.log.info(`✅ DHW mode services setup completed for modes: [${this.availableModes.join(', ')}] with subtype version: ${subtypeVersion}`);
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
    this.comfortService = undefined;
    this.ecoService = undefined;
    this.offService = undefined;
  }
  
async setActive(value: CharacteristicValue) {
    const active = value as number;
    
    if (active === this.platform.Characteristic.Active.ACTIVE) {
      // User wants to activate DHW - set to default mode (eco or comfort)
      const defaultMode = this.availableModes.includes('eco') ? 'eco' : 
                         this.availableModes.includes('comfort') ? 'comfort' : 
                         this.availableModes[0];
      
      if (this.currentMode === 'off' && defaultMode) {
        await this.setMode(defaultMode);
      }
    } else {
      // User wants to deactivate DHW
      if (this.currentMode !== 'off' && this.availableModes.includes('off')) {
        await this.setMode('off');
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
        
        // 🆕 NEW: Request immediate burner update after mode change
        if (this.platform.config.enableImmediateBurnerUpdates !== false) {
          this.platform.requestImmediateBurnerUpdate(
            this.installation.id,
            this.gateway.serial,
            this.device.id,
            `DHW mode change: ${oldMode} → ${mode}`,
            BURNER_UPDATE_CONFIG.delays.dhwModeChange
          );
        }
        
        // Update all characteristics
        this.updateAllCharacteristics();
      } else {
        this.platform.log.error(`Failed to set DHW mode to: ${mode}`);
        // Restore the previous state
        this.updateAllCharacteristics();
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
    } catch (error) {
      this.platform.log.error(`Error setting DHW mode to ${mode}:`, error);
      // Restore the previous state
      this.updateAllCharacteristics();
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private updateAllCharacteristics() {
    // Update HeaterCooler characteristics
    const isActive = this.currentMode !== 'off';
    this.heaterCoolerService.updateCharacteristic(this.platform.Characteristic.Active, 
      isActive ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE);
    
    this.heaterCoolerService.updateCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState,
      isActive ? this.platform.Characteristic.CurrentHeaterCoolerState.HEATING : 
                 this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE);

    // Update switch states (ensure mutual exclusion)
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
    
    this.platform.log.debug(`DHW States - Mode: ${this.currentMode.toUpperCase()}, Active: ${isActive}, Comfort: ${isComfort}, Eco: ${isEco}, Off: ${isOff}`);
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

  async getHeatingThresholdTemperature(): Promise<CharacteristicValue> {
    // Always return a value within valid constraints
    return Math.min(Math.max(this.states.HeatingThresholdTemperature, this.temperatureConstraints.min), this.temperatureConstraints.max);
  }

  async setHeatingThresholdTemperature(value: CharacteristicValue) {
    if (!this.supportsTemperatureControl) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.READ_ONLY_CHARACTERISTIC);
    }

    const temperature = value as number;
    
    if (temperature < this.temperatureConstraints.min || temperature > this.temperatureConstraints.max) {
      this.platform.log.error(`Invalid DHW temperature: ${temperature}°C (must be between ${this.temperatureConstraints.min}-${this.temperatureConstraints.max}°C)`);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
    }
    
    this.states.HeatingThresholdTemperature = temperature;

    try {
      const success = await this.platform.viessmannAPI.setDHWTemperature(
        this.installation.id,
        this.gateway.serial,
        this.device.id,
        temperature
      );

      if (success) {
        this.platform.log.info(`DHW target temperature: ${temperature}°C (Mode: ${this.currentMode.toUpperCase()})`);
        
        // 🆕 NEW: Request immediate burner update after temperature change
        if (this.platform.config.enableImmediateBurnerUpdates !== false) {
          this.platform.requestImmediateBurnerUpdate(
            this.installation.id,
            this.gateway.serial,
            this.device.id,
            `DHW temperature change: ${temperature}°C`,
            BURNER_UPDATE_CONFIG.delays.dhwTemperatureChange
          );
        }
        
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
    // FIX#6: log entry/exit with timing so stale states are immediately visible in logs
    const t0 = Date.now();
    try {
      await this.updateFromFeatures(features);
      this.platform.log.debug(`🚿 ACS handleUpdate OK in ${Date.now() - t0}ms`);
    } catch (error) {
      // FIX#6: was silently swallowing errors — now logs full context so stale state is diagnosable
      const msg = error instanceof Error ? error.message : String(error);
      this.platform.log.error(`❌ ACS handleUpdate failed after ${Date.now() - t0}ms: ${msg}`);
      this.platform.log.error(`   State at failure: mode=${this.currentMode}, temp=${this.states.CurrentTemperature}°C, target=${this.states.HeatingThresholdTemperature}°C`);
    }
  }

  private async updateFromFeatures(features: any[]) {
    let changed = false;

    // Update DHW current temperature
    const dhwTempFeature = features.find(f => 
      f.feature === 'heating.dhw.sensors.temperature.dhwCylinder' ||
      f.feature === 'heating.dhw.sensors.temperature.hotWaterStorage' ||
      f.feature === 'heating.dhw.sensors.temperature.outlet'
    );
    if (dhwTempFeature?.properties?.value?.value !== undefined) {
      const newTemp = dhwTempFeature.properties.value.value;
      if (newTemp !== this.states.CurrentTemperature) {
        this.platform.log.debug(`🌡️ ACS current temp: ${this.states.CurrentTemperature}°C → ${newTemp}°C`);
        this.states.CurrentTemperature = newTemp;
        changed = true;
      }
      this.heaterCoolerService.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.states.CurrentTemperature);
    } else {
      this.platform.log.debug(`🌡️ ACS current temp: no sensor feature found (checked dhwCylinder/hotWaterStorage/outlet)`);
    }

    // Update DHW target temperature
    const dhwTargetTempFeature = features.find(f => f.feature === 'heating.dhw.temperature.main');
    if (dhwTargetTempFeature?.properties?.value?.value !== undefined && this.supportsTemperatureControl) {
      const targetTemp = dhwTargetTempFeature.properties.value.value;
      if (targetTemp >= this.temperatureConstraints.min && targetTemp <= this.temperatureConstraints.max) {
        if (targetTemp !== this.states.HeatingThresholdTemperature) {
          this.platform.log.debug(`🎯 ACS target temp: ${this.states.HeatingThresholdTemperature}°C → ${targetTemp}°C`);
          this.states.HeatingThresholdTemperature = targetTemp;
          changed = true;
        }
        this.heaterCoolerService.updateCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature, targetTemp);
      } else {
        this.platform.log.warn(`🎯 ACS target temp ${targetTemp}°C out of range ${this.temperatureConstraints.min}-${this.temperatureConstraints.max}°C — ignored`);
      }
    }

    // Update DHW operating mode — THE MOST CRITICAL UPDATE
    const dhwOperatingModeFeature = features.find(f => f.feature === 'heating.dhw.operating.modes.active');
    if (dhwOperatingModeFeature?.properties?.value?.value !== undefined) {
      const newMode = dhwOperatingModeFeature.properties.value.value;
      if (newMode !== this.currentMode) {
        this.platform.log.info(`🚿 ACS mode changed: ${this.currentMode.toUpperCase()} → ${newMode.toUpperCase()}`);
        this.currentMode = newMode;
        this.updateAllCharacteristics();
        changed = true;
      } else {
        this.platform.log.debug(`🚿 ACS mode unchanged: ${this.currentMode.toUpperCase()}`);
      }
    } else {
      this.platform.log.warn(`🚿 ACS mode: feature 'heating.dhw.operating.modes.active' not found in ${features.length} features — state NOT updated`);
    }

    // Summary log — always visible at debug, visible at info only when something changed
    const summary = `mode=${this.currentMode.toUpperCase()} | temp=${this.states.CurrentTemperature}°C | target=${this.states.HeatingThresholdTemperature}°C`;
    if (changed) {
      this.platform.log.info(`🚿 ACS state updated: ${summary}`);
    } else {
      this.platform.log.debug(`🚿 ACS state unchanged: ${summary}`);
    }
  }
  
// 🆕 NEW: Handle immediate burner status updates from platform
  public handleImmediateBurnerUpdate(burnerStatus: any): void {
    try {
      // Update DHW characteristics based on burner status
      if (burnerStatus.dhwActive !== undefined) {
        const wasDHWActive = this.currentMode !== 'off';
        const isDHWActive = burnerStatus.dhwActive;
        
        if (wasDHWActive !== isDHWActive) {
          // DHW mode changed, update our state accordingly
          if (!isDHWActive && this.currentMode !== 'off') {
            // DHW turned off
            this.currentMode = 'off';
            this.updateAllCharacteristics();
            this.platform.log.debug(`🔥 DHW immediate update: DHW turned OFF`);
          } else if (isDHWActive && this.currentMode === 'off') {
            // DHW turned on - we don't know which mode, but we can set to a default
            const defaultMode = this.availableModes.includes('eco') ? 'eco' : 
                               this.availableModes.includes('comfort') ? 'comfort' : 
                               this.availableModes[0];
            if (defaultMode && defaultMode !== 'off') {
              this.currentMode = defaultMode;
              this.updateAllCharacteristics();
              this.platform.log.debug(`🔥 DHW immediate update: DHW turned ON (mode: ${defaultMode})`);
            }
          }
        }
      }
      
      // Update HeaterCooler state based on combined DHW and burner activity
      if (burnerStatus.burnerActive !== undefined && burnerStatus.dhwActive !== undefined) {
        const isHeating = burnerStatus.dhwActive && burnerStatus.burnerActive;
        
        this.heaterCoolerService.updateCharacteristic(
          this.platform.Characteristic.CurrentHeaterCoolerState,
          isHeating ? 
            this.platform.Characteristic.CurrentHeaterCoolerState.HEATING : 
            this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE
        );
        
        this.platform.log.debug(`🔥 DHW immediate update: Heating state = ${isHeating ? 'HEATING' : 'INACTIVE'} (DHW: ${burnerStatus.dhwActive}, Burner: ${burnerStatus.burnerActive})`);
      }
      
      // Update temperature if available
      if (burnerStatus.boilerTemp && burnerStatus.boilerTemp > 0) {
        // For DHW, we can use boiler temperature as an indicator, but we should still prefer DHW-specific sensors
        // Only update if we don't have a recent DHW temperature reading
        if (this.states.CurrentTemperature === 40) { // Default value, likely not real
          this.states.CurrentTemperature = Math.max(20, burnerStatus.boilerTemp - 10); // Rough estimate
          this.heaterCoolerService.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.states.CurrentTemperature);
          this.platform.log.debug(`🔥 DHW immediate update: Estimated temp from boiler = ${this.states.CurrentTemperature}°C`);
        }
      }
      
    } catch (error) {
      this.platform.log.error('Error handling immediate DHW burner update:', error);
    }
  }

  // 🆕 NEW: Public method to check if DHW supports specific features for platform optimization
  public getDHWCapabilities(): {
    availableModes: string[];
    supportsTemperatureControl: boolean;
    temperatureRange: { min: number; max: number };
    currentMode: string;
    hasComfortMode: boolean;
    hasEcoMode: boolean;
    hasOffMode: boolean;
  } {
    return {
      availableModes: [...this.availableModes],
      supportsTemperatureControl: this.supportsTemperatureControl,
      temperatureRange: { ...this.temperatureConstraints },
      currentMode: this.currentMode,
      hasComfortMode: this.availableModes.includes('comfort'),
      hasEcoMode: this.availableModes.includes('eco'),
      hasOffMode: this.availableModes.includes('off'),
    };
  }

  // 🆕 NEW: Get current DHW status for platform health reports
  public getDHWStatus(): {
    isActive: boolean;
    currentMode: string;
    currentTemperature: number;
    targetTemperature: number;
    temperatureInRange: boolean;
    modesAvailable: number;
    lastModeChange?: number;
  } {
    const isActive = this.currentMode !== 'off';
    const temperatureInRange = this.states.HeatingThresholdTemperature >= this.temperatureConstraints.min && 
                              this.states.HeatingThresholdTemperature <= this.temperatureConstraints.max;

    return {
      isActive,
      currentMode: this.currentMode,
      currentTemperature: this.states.CurrentTemperature,
      targetTemperature: this.states.HeatingThresholdTemperature,
      temperatureInRange,
      modesAvailable: this.availableModes.length,
    };
  }

  // 🆕 NEW: Force DHW mode sync (for troubleshooting)
  public async forceModeSync(): Promise<boolean> {
    try {
      this.platform.log.debug(`🔄 Force syncing DHW mode for device ${this.device.id}`);
      
      // Get fresh features to determine current mode
      const features = await this.platform.viessmannAPI.getDeviceFeatures(
        this.installation.id,
        this.gateway.serial,
        this.device.id
      );
      
      const dhwOperatingModeFeature = features.find(f => f.feature === 'heating.dhw.operating.modes.active');
      if (dhwOperatingModeFeature?.properties?.value?.value !== undefined) {
        const actualMode = dhwOperatingModeFeature.properties.value.value;
        
        if (actualMode !== this.currentMode) {
          this.platform.log.info(`🔄 DHW mode sync: ${this.currentMode} → ${actualMode}`);
          this.currentMode = actualMode;
          this.updateAllCharacteristics();
          return true;
        }
      }
      
      return false;
    } catch (error) {
      this.platform.log.error('Failed to force DHW mode sync:', error);
      return false;
    }
  }

  // 🆕 NEW: Validate and fix DHW temperature constraints (for robustness)
  private validateTemperatureConstraints(): void {
    // Ensure constraints are sane
    if (this.temperatureConstraints.min >= this.temperatureConstraints.max) {
      this.platform.log.warn(`Invalid DHW temperature constraints: min=${this.temperatureConstraints.min}, max=${this.temperatureConstraints.max}. Fixing to 30-60°C`);
      this.temperatureConstraints = { min: 30, max: 60 };
    }

    if (this.temperatureConstraints.min < 10 || this.temperatureConstraints.max > 80) {
      this.platform.log.warn(`DHW temperature constraints out of safe range: min=${this.temperatureConstraints.min}, max=${this.temperatureConstraints.max}. Clamping to 10-80°C`);
      this.temperatureConstraints.min = Math.max(this.temperatureConstraints.min, 10);
      this.temperatureConstraints.max = Math.min(this.temperatureConstraints.max, 80);
    }

    // Ensure current target temperature is within bounds
    if (this.states.HeatingThresholdTemperature < this.temperatureConstraints.min || 
        this.states.HeatingThresholdTemperature > this.temperatureConstraints.max) {
      const newTarget = Math.max(this.temperatureConstraints.min, 
                                Math.min(this.temperatureConstraints.max, 50));
      this.platform.log.warn(`DHW target temperature ${this.states.HeatingThresholdTemperature}°C out of range. Setting to ${newTarget}°C`);
      this.states.HeatingThresholdTemperature = newTarget;
    }
  }

  // 🆕 NEW: Emergency mode reset (for critical issues)
  public async emergencyReset(): Promise<boolean> {
    try {
      this.platform.log.warn(`🚨 Emergency reset for DHW device ${this.device.id}`);
      
      // Reset to safe defaults
      this.currentMode = 'off';
      this.states.HeatingThresholdTemperature = 50;
      this.validateTemperatureConstraints();
      
      // Force set to off mode
      const success = await this.executeDHWCommand('off');
      
      if (success) {
        this.updateAllCharacteristics();
        this.platform.log.info(`✅ DHW emergency reset completed - set to OFF mode`);
        return true;
      } else {
        this.platform.log.error(`❌ DHW emergency reset failed - could not set to OFF mode`);
        return false;
      }
      
    } catch (error) {
      this.platform.log.error('DHW emergency reset failed:', error);
      return false;
    }
  }

  // 🆕 NEW: Cleanup method for proper resource management
  public cleanup(): void {
    // Clear any pending timers or callbacks
    // Remove service references
    this.comfortService = undefined;
    this.ecoService = undefined;
    this.offService = undefined;
    
    this.platform.log.debug(`🧹 DHW accessory cleanup completed for device ${this.device.id}`);
  }
}    