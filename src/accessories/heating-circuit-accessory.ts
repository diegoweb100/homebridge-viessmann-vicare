import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { ViessmannPlatform, ViessmannInstallation, ViessmannGateway, ViessmannDevice, ViessmannPlatformConfig } from '../platform';

type ProgramType = 'reduced' | 'normal' | 'comfort';

export class ViessmannHeatingCircuitAccessory {
  private heaterCoolerService: Service;
  private informationService: Service;
  
  // Quick Selection Services
  private holidayService?: Service;
  private holidayAtHomeService?: Service;
  private extendedHeatingService?: Service;
  
  // Temperature Program Services (NEW)
  private ridottaService?: Service;
  private normaleService?: Service;
  private comfortService?: Service;
  
  private availableModes: string[] = [];
  private availablePrograms: string[] = [];
  private availableQuickSelections: string[] = [];
  private supportsTemperatureControl = false;
  private temperatureConstraints = { min: 3, max: 37 }; // Will be updated from API constraints
  private isCircuitEnabled = false;
  private currentMode = 'standby';
  private currentProgram = 'normal'; // Track which temperature program is active

  private states = {
    CurrentTemperature: 20,
    HeatingThresholdTemperature: 20,
    CoolingThresholdTemperature: 24,
    TemperatureDisplayUnits: 0, // Celsius
    CurrentRelativeHumidity: 50,
    HolidayActive: false,
    HolidayAtHomeActive: false,
    ExtendedHeatingActive: false,
    // Temperature program states
    RidottaActive: false,
    NormaleActive: true, // Default
    ComfortActiveAsProgram: false, // Different from ExtendedHeatingActive
  };

  // Store temperatures for each program
  private programTemperatures = {
    reduced: 16,
    normal: 18,
    comfort: 19,
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

    // Create HeaterCooler service for heating circuit
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

    // Reset temperature constraints to find the actual range from API
    this.temperatureConstraints = { min: 37, max: 3 }; // Start with inverted values to find actual min/max

    // Analyze temperature programs (comfort, normal, reduced)
    const programTypes = ['comfort', 'normal', 'reduced'];
    for (const programType of programTypes) {
      const programFeature = features.find(f => f.feature === `${circuitPrefix}.operating.programs.${programType}`);
      if (programFeature?.isEnabled === true) {
        this.availablePrograms.push(programType);
        
        // Get current temperature for this program and store it
        if (programFeature.properties?.temperature?.value !== undefined) {
          const temp = programFeature.properties.temperature.value;
          
          // Store temperature for this specific program
          switch (programType) {
            case 'comfort':
              this.programTemperatures.comfort = temp;
              break;
            case 'normal':
              this.programTemperatures.normal = temp;
              break;
            case 'reduced':
              this.programTemperatures.reduced = temp;
              break;
          }
          
          // Use the temperature from the currently active program for HeaterCooler
          // We'll determine which is active later
          this.states.HeatingThresholdTemperature = temp;
        }

        // Check if we can set temperature for this program and get constraints
        if (programFeature.commands?.setTemperature) {
          this.supportsTemperatureControl = true;
          const constraints = programFeature.commands.setTemperature.params?.targetTemperature?.constraints;
          if (constraints) {
            this.temperatureConstraints.min = Math.min(this.temperatureConstraints.min, constraints.min || 3);
            this.temperatureConstraints.max = Math.max(this.temperatureConstraints.max, constraints.max || 37);
          }
        }
      }
    }

    // Fallback to reasonable defaults if no constraints found
    if (this.temperatureConstraints.min > this.temperatureConstraints.max) {
      this.temperatureConstraints = { min: 3, max: 37 }; // Default heating circuit range
    }

    // Analyze quick selection programs (holiday, holidayAtHome, etc.)
    const quickSelectionTypes = ['holiday', 'holidayAtHome'];
    for (const selectionType of quickSelectionTypes) {
      const selectionFeature = features.find(f => f.feature === `heating.operating.programs.${selectionType}`);
      if (selectionFeature?.isEnabled === true) {
        this.availableQuickSelections.push(selectionType);
        
        // Get current status for this quick selection
        if (selectionFeature.properties?.active?.value !== undefined) {
          const isActive = selectionFeature.properties.active.value;
          switch (selectionType) {
            case 'holiday':
              this.states.HolidayActive = isActive;
              break;
            case 'holidayAtHome':
              this.states.HolidayAtHomeActive = isActive;
              break;
          }
        }
      }
    }

    // Enhanced analysis for extended heating (comfort program activation)
    const comfortProgram = features.find(f => f.feature === `${circuitPrefix}.operating.programs.comfort`);
    if (comfortProgram?.isEnabled === true) {
      const hasActivate = comfortProgram.commands?.activate;
      const hasDeactivate = comfortProgram.commands?.deactivate;
      const hasSetTemperature = comfortProgram.commands?.setTemperature;
      
      // Check for alternative methods
      const forcedProgram = features.find(f => f.feature === `${circuitPrefix}.operating.programs.forcedLastFromSchedule`);
      const hasForcedActivate = forcedProgram?.commands?.activate;
      const hasForcedDeactivate = forcedProgram?.commands?.deactivate;
      
      // Extended heating is available if we have ANY way to control comfort/boost
      const hasAnyMethod = (hasActivate && hasDeactivate) || 
                          hasSetTemperature || 
                          (hasForcedActivate && hasForcedDeactivate);
      
      if (hasAnyMethod) {
        this.availableQuickSelections.push('extendedHeating');
        this.states.ExtendedHeatingActive = comfortProgram.properties?.active?.value || false;
        
        const activateExecutable = hasActivate?.isExecutable || false;
        const deactivateExecutable = hasDeactivate?.isExecutable || false;
        const setTempExecutable = hasSetTemperature?.isExecutable || false;
        const forcedActivateExecutable = hasForcedActivate?.isExecutable || false;
        const forcedDeactivateExecutable = hasForcedDeactivate?.isExecutable || false;
        
        this.platform.log.info(`Extended Heating available for circuit ${this.circuitNumber}`);
        this.platform.log.debug(`Methods available - comfort activate: ${activateExecutable}, comfort deactivate: ${deactivateExecutable}, comfort setTemp: ${setTempExecutable}, forced activate: ${forcedActivateExecutable}, forced deactivate: ${forcedDeactivateExecutable}`);
        
        if (!activateExecutable && !deactivateExecutable && !setTempExecutable && !forcedActivateExecutable && !forcedDeactivateExecutable) {
          this.platform.log.warn(`Extended Heating methods exist but none are currently executable for circuit ${this.circuitNumber}. Current mode: ${this.currentMode}. This feature may become available when conditions change.`);
        }
      } else {
        this.platform.log.debug(`Extended Heating not available for circuit ${this.circuitNumber} - insufficient control methods`);
      }
    }

    // Log capabilities summary
    this.platform.log.info(`Heating Circuit ${this.circuitNumber} Capabilities - Enabled: ${this.isCircuitEnabled}, Modes: [${this.availableModes.join(', ')}], Programs: [${this.availablePrograms.join(', ')}], Quick Selections: [${this.availableQuickSelections.join(', ')}], Temperature: ${this.supportsTemperatureControl ? 'Yes' : 'No'}`);
    this.platform.log.info(`Program temperatures - Reduced: ${this.programTemperatures.reduced}°C, Normal: ${this.programTemperatures.normal}°C, Comfort: ${this.programTemperatures.comfort}°C`);
  }

  private setupCharacteristics() {
    if (!this.isCircuitEnabled) {
      return;
    }

    // Remove any existing conflicting services
    this.removeConflictingServices();

    // Configure HeaterCooler service
    this.setupHeaterCoolerService();

    // Add temperature program services
    this.setupTemperatureProgramServices();

    // Add quick selection services if available
    if (this.availableQuickSelections.length > 0) {
      this.setupQuickSelectionServices();
    }
  }

  private removeConflictingServices() {
    // Remove existing thermostat, temperature sensor, and switch services
    const servicesToRemove = [
      this.platform.Service.Thermostat,
      this.platform.Service.TemperatureSensor,
      this.platform.Service.Switch
    ];

    for (const serviceType of servicesToRemove) {
      const services = this.accessory.services.filter(service => service.UUID === serviceType.UUID);
      for (const service of services) {
        try {
          this.accessory.removeService(service);
          this.platform.log.debug(`Removed existing ${service.constructor.name} service for circuit ${this.circuitNumber}`);
        } catch (error) {
          this.platform.log.debug(`Could not remove service: ${error}`);
        }
      }
    }
  }

  private setupHeaterCoolerService() {
    // Active characteristic (On/Off)
    this.heaterCoolerService.getCharacteristic(this.platform.Characteristic.Active)
      .onGet(() => this.currentMode === 'heating' ? 
        this.platform.Characteristic.Active.ACTIVE : 
        this.platform.Characteristic.Active.INACTIVE)
      .onSet(this.setActive.bind(this));

    // Current Heater Cooler State (read-only)
    this.heaterCoolerService.getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
      .onGet(() => {
        if (this.currentMode === 'standby' || this.currentMode === 'off') {
          return this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE;
        }
        // For heating circuits, we're always in heating mode when active
        return this.platform.Characteristic.CurrentHeaterCoolerState.HEATING;
      });

    // Target Heater Cooler State
    this.heaterCoolerService.getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
      .updateValue(this.platform.Characteristic.TargetHeaterCoolerState.HEAT) // Set valid value FIRST
      .onGet(() => this.platform.Characteristic.TargetHeaterCoolerState.HEAT) // Heating circuits are always heating
      .onSet(this.setTargetHeaterCoolerState.bind(this))
      .setProps({
        validValues: [this.platform.Characteristic.TargetHeaterCoolerState.HEAT],
      });

    // Current Temperature
    this.heaterCoolerService.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this))
      .setProps({
        minValue: -50,
        maxValue: 100,
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

private setupTemperatureProgramServices() {
    const config = this.platform.config as ViessmannPlatformConfig;
    const customNames = config.customNames || {};
    
    // 🔧 FIXED: Use custom names properly with fallbacks
    const installationName = customNames.installationPrefix || this.installation.description;
    const heatingCircuitName = customNames.heatingCircuit || 'Heating Circuit';
    const reducedName = customNames.reduced || 'Reduced';
    const normalName = customNames.normal || 'Normal';
    const comfortName = customNames.comfort || 'Comfort';

    // 🔍 DEBUG: Log dei nomi per verificare la generazione
    this.platform.log.info(`🏷️ HC${this.circuitNumber} Setup - Installation: "${installationName}", HC: "${heatingCircuitName}"`);
    this.platform.log.info(`🏷️ HC${this.circuitNumber} Setup - Reduced: "${reducedName}", Normal: "${normalName}", Comfort: "${comfortName}"`);

    // Remove existing temperature program services first
    this.removeAllTemperatureProgramServices();

    // 🔧 DYNAMIC: Use timestamp-based version for automatic recreation
    const subtypeVersion = config.forceServiceRecreation ? 
      Date.now().toString().slice(-8) : // Last 8 digits of timestamp
      'stable'; // Use stable version normally
    
    this.platform.log.info(`🔧 HC${this.circuitNumber} Using service subtype version: ${subtypeVersion}`);

    // Helper function to sanitize service names for HomeKit
    const sanitizeName = (name: string): string => {
      return name
        .replace(/[^\w\s']/g, ' ') // Replace special chars with spaces
        .replace(/\s+/g, ' ')      // Collapse multiple spaces
        .trim();                   // Remove leading/trailing spaces
    };

    // Create services for each available temperature program - KEEPING installation name
    if (this.availablePrograms.includes('reduced')) {
      const serviceName = sanitizeName(`${installationName} ${heatingCircuitName} ${this.circuitNumber} ${reducedName} ${this.programTemperatures.reduced}C`);
      this.platform.log.info(`🏷️ Creating Reduced service: "${serviceName}"`);
      
      this.ridottaService = this.accessory.addService(
        this.platform.Service.Switch, 
        serviceName, 
        `hc${this.circuitNumber}-reduced-${subtypeVersion}` // 🔧 DYNAMIC SUBTYPE
      );

      // 🔧 CRITICAL: Set both Name characteristic AND displayName
      this.ridottaService.setCharacteristic(this.platform.Characteristic.Name, serviceName);
      this.ridottaService.displayName = serviceName;
      
      this.ridottaService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(() => this.currentProgram === 'reduced')
        .onSet(this.setReducedProgram.bind(this));
    }

    if (this.availablePrograms.includes('normal')) {
      const serviceName = sanitizeName(`${installationName} ${heatingCircuitName} ${this.circuitNumber} ${normalName} ${this.programTemperatures.normal}C`);
      this.platform.log.info(`🏷️ Creating Normal service: "${serviceName}"`);
      
      this.normaleService = this.accessory.addService(
        this.platform.Service.Switch, 
        serviceName, 
        `hc${this.circuitNumber}-normal-${subtypeVersion}` // 🔧 DYNAMIC SUBTYPE
      );
 
      // 🔧 CRITICAL: Set both Name characteristic AND displayName
      this.normaleService.setCharacteristic(this.platform.Characteristic.Name, serviceName);
      this.normaleService.displayName = serviceName;
      
      this.normaleService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(() => this.currentProgram === 'normal')
        .onSet(this.setNormalProgram.bind(this));
    }

    if (this.availablePrograms.includes('comfort')) {
      const serviceName = sanitizeName(`${installationName} ${heatingCircuitName} ${this.circuitNumber} ${comfortName} ${this.programTemperatures.comfort}C`);
      this.platform.log.info(`🏷️ Creating Comfort service: "${serviceName}"`);
      
      this.comfortService = this.accessory.addService(
        this.platform.Service.Switch, 
        serviceName, 
        `hc${this.circuitNumber}-comfort-${subtypeVersion}` // 🔧 DYNAMIC SUBTYPE
      );
      
      // 🔧 CRITICAL: Set both Name characteristic AND displayName
      this.comfortService.setCharacteristic(this.platform.Characteristic.Name, serviceName);
      this.comfortService.displayName = serviceName;
      
      this.comfortService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(() => this.currentProgram === 'comfort')
        .onSet(this.setComfortProgram.bind(this));
    }

    this.platform.log.info(`✅ HC${this.circuitNumber} temperature program services setup completed for programs: [${this.availablePrograms.join(', ')}] with subtype version: ${subtypeVersion}`);
  }

  private setupQuickSelectionServices() {
    const config = this.platform.config as ViessmannPlatformConfig;
    const customNames = config.customNames || {};
    
    // 🔧 FIXED: Use custom names - KEEPING installation name
    const installationName = customNames.installationPrefix || this.installation.description;
    const holidayName = customNames.holiday || 'Holiday Mode';
    const holidayAtHomeName = customNames.holidayAtHome || 'Holiday At Home';
    const extendedHeatingName = customNames.extendedHeating || 'Extended Heating';

    // 🔍 DEBUG: Log dei nomi
    this.platform.log.info(`🏷️ HC${this.circuitNumber} Quick Selections - Holiday: "${holidayName}", HolidayAtHome: "${holidayAtHomeName}", Extended: "${extendedHeatingName}"`);

    // Remove existing quick selection services first
    this.removeAllQuickSelectionServices();

    // 🔧 DYNAMIC: Use timestamp-based version for automatic recreation
    const subtypeVersion = config.forceServiceRecreation ? 
      Date.now().toString().slice(-8) : // Last 8 digits of timestamp
      'stable'; // Use stable version normally
    
    this.platform.log.info(`🔧 HC${this.circuitNumber} Quick Selections using service subtype version: ${subtypeVersion}`);

    // Create services for each available quick selection - KEEPING installation name
    if (this.availableQuickSelections.includes('holiday')) {
      const serviceName = `${installationName} Heating Circuit ${this.circuitNumber} ${holidayName}`;
      this.platform.log.info(`🏷️ Creating Holiday service: "${serviceName}"`);
      
      this.holidayService = this.accessory.addService(
        this.platform.Service.Switch, 
        serviceName, 
        `hc${this.circuitNumber}-holiday-${subtypeVersion}` // 🔧 DYNAMIC SUBTYPE
      );
      
      // 🔧 CRITICAL: Set both Name characteristic AND displayName
      this.holidayService.setCharacteristic(this.platform.Characteristic.Name, serviceName);
      this.holidayService.displayName = serviceName;
      
      this.holidayService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(() => this.states.HolidayActive)
        .onSet(this.setHolidayMode.bind(this));
    }

    if (this.availableQuickSelections.includes('holidayAtHome')) {
      const serviceName = `${installationName} Heating Circuit ${this.circuitNumber} ${holidayAtHomeName}`;
      this.platform.log.info(`🏷️ Creating Holiday At Home service: "${serviceName}"`);
      
      this.holidayAtHomeService = this.accessory.addService(
        this.platform.Service.Switch, 
        serviceName, 
        `hc${this.circuitNumber}-holiday-at-home-${subtypeVersion}` // 🔧 DYNAMIC SUBTYPE
      );
      
      // 🔧 CRITICAL: Set both Name characteristic AND displayName
      this.holidayAtHomeService.setCharacteristic(this.platform.Characteristic.Name, serviceName);
      this.holidayAtHomeService.displayName = serviceName;
      
      this.holidayAtHomeService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(() => this.states.HolidayAtHomeActive)
        .onSet(this.setHolidayAtHomeMode.bind(this));
    }

    if (this.availableQuickSelections.includes('extendedHeating')) {
      const serviceName = `${installationName} Heating Circuit ${this.circuitNumber} ${extendedHeatingName}`;
      this.platform.log.info(`🏷️ Creating Extended Heating service: "${serviceName}"`);
      
      this.extendedHeatingService = this.accessory.addService(
        this.platform.Service.Switch, 
        serviceName, 
        `hc${this.circuitNumber}-extended-heating-${subtypeVersion}` // 🔧 DYNAMIC SUBTYPE
      );
      
      // 🔧 CRITICAL: Set both Name characteristic AND displayName
      this.extendedHeatingService.setCharacteristic(this.platform.Characteristic.Name, serviceName);
      this.extendedHeatingService.displayName = serviceName;
      
      this.extendedHeatingService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(() => this.states.ExtendedHeatingActive)
        .onSet(this.setExtendedHeatingMode.bind(this));
    }

    this.platform.log.info(`✅ HC${this.circuitNumber} quick selection services setup completed for selections: [${this.availableQuickSelections.join(', ')}] with subtype version: ${subtypeVersion}`);
  }


  private removeAllTemperatureProgramServices() {
    // Remove existing temperature program switch services
    const tempProgramSubtypes = [`hc${this.circuitNumber}-reduced`, `hc${this.circuitNumber}-normal`, `hc${this.circuitNumber}-comfort`];
    
    for (const subtype of tempProgramSubtypes) {
      const service = this.accessory.services.find(service => 
        service.UUID === this.platform.Service.Switch.UUID && 
        service.subtype === subtype
      );
      
      if (service) {
        try {
          this.accessory.removeService(service);
          this.platform.log.debug(`Removed existing temperature program service: ${service.displayName || 'Unknown'}`);
        } catch (error) {
          this.platform.log.debug(`Could not remove temperature program service: ${error}`);
        }
      }
    }

    // Clear references
    this.ridottaService = undefined;
    this.normaleService = undefined;
    this.comfortService = undefined;
  }

  private removeAllQuickSelectionServices() {
    // Remove existing quick selection switch services
    const quickSelectionSubtypes = [`hc${this.circuitNumber}-holiday`, `hc${this.circuitNumber}-holiday-at-home`, `hc${this.circuitNumber}-extended-heating`];
    
    for (const subtype of quickSelectionSubtypes) {
      const service = this.accessory.services.find(service => 
        service.UUID === this.platform.Service.Switch.UUID && 
        service.subtype === subtype
      );
      
      if (service) {
        try {
          this.accessory.removeService(service);
          this.platform.log.debug(`Removed existing quick selection service: ${service.displayName || 'Unknown'}`);
        } catch (error) {
          this.platform.log.debug(`Could not remove quick selection service: ${error}`);
        }
      }
    }

    // Clear references
    this.holidayService = undefined;
    this.holidayAtHomeService = undefined;
    this.extendedHeatingService = undefined;
  }

  // Temperature Program Handlers
  private async setReducedProgram(value: CharacteristicValue) {
    const on = value as boolean;
    
    if (on && this.currentProgram !== 'reduced') {
      await this.changeTemperatureProgram('reduced');
    } else if (!on && this.currentProgram === 'reduced') {
      // Can't turn off without selecting another - revert
      setTimeout(() => {
        this.ridottaService?.updateCharacteristic(this.platform.Characteristic.On, true);
      }, 100);
      this.platform.log.warn('Cannot turn off Reduced program. Please select Normal or Comfort instead.');
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }
  }

  private async setNormalProgram(value: CharacteristicValue) {
    const on = value as boolean;
    
    if (on && this.currentProgram !== 'normal') {
      await this.changeTemperatureProgram('normal');
    } else if (!on && this.currentProgram === 'normal') {
      // Can't turn off without selecting another - revert
      setTimeout(() => {
        this.normaleService?.updateCharacteristic(this.platform.Characteristic.On, true);
      }, 100);
      this.platform.log.warn('Cannot turn off Normal program. Please select Reduced or Comfort instead.');
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }
  }

  private async setComfortProgram(value: CharacteristicValue) {
    const on = value as boolean;
    
    if (on && this.currentProgram !== 'comfort') {
      await this.changeTemperatureProgram('comfort');
    } else if (!on && this.currentProgram === 'comfort') {
      // Can't turn off without selecting another - revert
      setTimeout(() => {
        this.comfortService?.updateCharacteristic(this.platform.Characteristic.On, true);
      }, 100);
      this.platform.log.warn('Cannot turn off Comfort program. Please select Reduced or Normal instead.');
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }
  }

  private async changeTemperatureProgram(newProgram: 'reduced' | 'normal' | 'comfort') {
    try {
      const programMap = {
        'reduced': 'reduced',
        'normal': 'normal', 
        'comfort': 'comfort'
      };
      
      const targetTemperature = this.programTemperatures[newProgram];
      
      // Set the temperature for the selected program
      const success = await this.platform.viessmannAPI.executeCommand(
        this.installation.id,
        this.gateway.serial,
        this.device.id,
        `heating.circuits.${this.circuitNumber}.operating.programs.${programMap[newProgram]}`,
        'setTemperature',
        { targetTemperature }
      );

      if (success) {
        this.currentProgram = newProgram;
        this.states.HeatingThresholdTemperature = targetTemperature;
        
        // Update HeaterCooler temperature display
        this.heaterCoolerService.updateCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature, targetTemperature);
        
        this.platform.log.info(`Heating circuit ${this.circuitNumber} program changed to: ${newProgram.toUpperCase()} (${targetTemperature}°C)`);
        
        // Update all temperature program switches
        this.updateTemperatureProgramSwitches();
      } else {
        this.platform.log.error(`Failed to set heating circuit ${this.circuitNumber} to ${newProgram} program`);
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
    } catch (error) {
      this.platform.log.error(`Error changing temperature program for circuit ${this.circuitNumber}:`, error);
      // Restore previous state
      this.updateTemperatureProgramSwitches();
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private updateTemperatureProgramSwitches() {
    // Update temperature program switches (ensure mutual exclusion)
    const isReduced = this.currentProgram === 'reduced';
    const isNormal = this.currentProgram === 'normal';
    const isComfort = this.currentProgram === 'comfort';
    
    if (this.ridottaService) {
      this.ridottaService.updateCharacteristic(this.platform.Characteristic.On, isReduced);
    }
    
    if (this.normaleService) {
      this.normaleService.updateCharacteristic(this.platform.Characteristic.On, isNormal);
    }
    
    if (this.comfortService) {
      this.comfortService.updateCharacteristic(this.platform.Characteristic.On, isComfort);
    }
    
    this.platform.log.debug(`Circuit ${this.circuitNumber} temperature program: ${this.currentProgram.toUpperCase()} (${this.states.HeatingThresholdTemperature}°C)`);
  }

  async setActive(value: CharacteristicValue) {
    const active = value as number;
    
    if (active === this.platform.Characteristic.Active.ACTIVE) {
      // User wants to activate heating circuit
      if (this.currentMode === 'standby' && this.availableModes.includes('heating')) {
        await this.setMode('heating');
      }
    } else {
      // User wants to deactivate heating circuit
      if (this.currentMode === 'heating' && this.availableModes.includes('standby')) {
        await this.setMode('standby');
      }
    }
  }

  async setTargetHeaterCoolerState(value: CharacteristicValue) {
    // For heating circuits, we only support HEAT mode
    // This is mostly read-only but we can handle it gracefully
    const targetState = value as number;
    
    if (targetState === this.platform.Characteristic.TargetHeaterCoolerState.HEAT) {
      // User wants heating mode - ensure circuit is active
      if (this.currentMode !== 'heating' && this.availableModes.includes('heating')) {
        await this.setMode('heating');
      }
    }
  }

  private async setHolidayMode(value: CharacteristicValue) {
    const on = value as boolean;
    
    try {
      if (on) {
        // ACTIVATING Holiday Mode - deactivate conflicting programs first
        await this.deactivateConflictingQuickSelections(['extendedHeating', 'holidayAtHome']);
        
        // Schedule holiday mode - need start and end dates
        // For now, set a 7-day holiday starting tomorrow
        const startDate = new Date();
        startDate.setDate(startDate.getDate() + 1);
        const endDate = new Date(startDate);
        endDate.setDate(endDate.getDate() + 7);
        
        const success = await this.platform.viessmannAPI.executeCommand(
          this.installation.id,
          this.gateway.serial,
          this.device.id,
          'heating.operating.programs.holiday',
          'schedule',
          {
            start: startDate.toISOString().split('T')[0],
            end: endDate.toISOString().split('T')[0]
          }
        );
        
        if (success) {
          this.states.HolidayActive = true;
          this.platform.log.info(`Heating circuit ${this.circuitNumber} holiday mode activated (7 days)`);
          // Update other switches to reflect mutual exclusion
          this.updateMutuallyExclusiveSwitches();
        } else {
          throw new Error('Failed to activate holiday mode');
        }
      } else {
        // Unschedule holiday mode
        const success = await this.platform.viessmannAPI.executeCommand(
          this.installation.id,
          this.gateway.serial,
          this.device.id,
          'heating.operating.programs.holiday',
          'unschedule',
          {}
        );
        
        if (success) {
          this.states.HolidayActive = false;
          this.platform.log.info(`Heating circuit ${this.circuitNumber} holiday mode deactivated`);
        } else {
          throw new Error('Failed to deactivate holiday mode');
        }
      }
    } catch (error) {
      this.platform.log.error(`Error setting holiday mode for circuit ${this.circuitNumber}:`, error);
      // Restore previous state
      setTimeout(() => {
        this.holidayService?.updateCharacteristic(this.platform.Characteristic.On, this.states.HolidayActive);
      }, 100);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private async setHolidayAtHomeMode(value: CharacteristicValue) {
    const on = value as boolean;
    
    try {
      if (on) {
        // ACTIVATING Holiday At Home Mode - deactivate conflicting programs first
        await this.deactivateConflictingQuickSelections(['extendedHeating', 'holiday']);
        
        // Schedule holiday at home mode - typically for today
        const today = new Date();
        const todayString = today.toISOString().split('T')[0];
        
        const success = await this.platform.viessmannAPI.executeCommand(
          this.installation.id,
          this.gateway.serial,
          this.device.id,
          'heating.operating.programs.holidayAtHome',
          'schedule',
          {
            start: todayString,
            end: todayString
          }
        );
        
        if (success) {
          this.states.HolidayAtHomeActive = true;
          this.platform.log.info(`Heating circuit ${this.circuitNumber} holiday at home mode activated`);
          // Update other switches to reflect mutual exclusion
          this.updateMutuallyExclusiveSwitches();
        } else {
          throw new Error('Failed to activate holiday at home mode');
        }
      } else {
        // Unschedule holiday at home mode
        const success = await this.platform.viessmannAPI.executeCommand(
          this.installation.id,
          this.gateway.serial,
          this.device.id,
          'heating.operating.programs.holidayAtHome',
          'unschedule',
          {}
        );
        
        if (success) {
          this.states.HolidayAtHomeActive = false;
          this.platform.log.info(`Heating circuit ${this.circuitNumber} holiday at home mode deactivated`);
        } else {
          throw new Error('Failed to deactivate holiday at home mode');
        }
      }
    } catch (error) {
      this.platform.log.error(`Error setting holiday at home mode for circuit ${this.circuitNumber}:`, error);
      // Restore previous state
      setTimeout(() => {
        this.holidayAtHomeService?.updateCharacteristic(this.platform.Characteristic.On, this.states.HolidayAtHomeActive);
      }, 100);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private async setExtendedHeatingMode(value: CharacteristicValue) {
    const on = value as boolean;
    
    try {
      // First, get the latest features to check current executability
      const features = await this.platform.viessmannAPI.getDeviceFeatures(
        this.installation.id,
        this.gateway.serial,
        this.device.id
      );
      
      const comfortProgram = features.find(f => f.feature === `heating.circuits.${this.circuitNumber}.operating.programs.comfort`);
      if (!comfortProgram) {
        this.platform.log.warn(`Comfort program not found for circuit ${this.circuitNumber}`);
        this.restoreExtendedHeatingState();
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
      }

      if (on) {
        // ACTIVATING Extended Heating - deactivate conflicting programs first
        await this.deactivateConflictingPrograms(features);
        
        const commandName = 'activate';
        const command = comfortProgram.commands?.[commandName];
        
        if (!command) {
          this.platform.log.warn(`Extended heating ${commandName} command not available for circuit ${this.circuitNumber}`);
          this.restoreExtendedHeatingState();
          throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
        }

        if (!command.isExecutable) {
          // Try alternative approach: use forced programs or temperature-based activation
          const success = await this.tryAlternativeExtendedHeating(true, comfortProgram, features);
          
          if (success) {
            this.states.ExtendedHeatingActive = true;
            this.platform.log.info(`Heating circuit ${this.circuitNumber} extended heating activated using alternative method`);
            // Update other switches to reflect mutual exclusion
            this.updateMutuallyExclusiveSwitches();
            return;
          }
          
          // If alternative methods fail, provide helpful error message
          let suggestion = this.getExtendedHeatingSuggestion(features);
          
          this.platform.log.warn(`Extended heating ${commandName} command is not executable for circuit ${this.circuitNumber}. Current circuit mode: ${this.currentMode}.${suggestion}`);
          
          this.restoreExtendedHeatingState();
          throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
        }
        
        // Execute the primary command with proper parameters
        const success = await this.executeComfortCommand(commandName, comfortProgram, true);
        
        if (success) {
          this.states.ExtendedHeatingActive = true;
          this.platform.log.info(`Heating circuit ${this.circuitNumber} extended heating (comfort) activated`);
          // Update other switches to reflect mutual exclusion
          this.updateMutuallyExclusiveSwitches();
        } else {
          throw new Error(`Failed to ${commandName} extended heating mode`);
        }
      } else {
        // DEACTIVATING Extended Heating
        const commandName = 'deactivate';
        const command = comfortProgram.commands?.[commandName];
        
        if (command?.isExecutable) {
          // Use primary deactivate command
          const success = await this.executeComfortCommand(commandName, comfortProgram, false);
          
          if (success) {
            this.states.ExtendedHeatingActive = false;
            this.platform.log.info(`Heating circuit ${this.circuitNumber} extended heating (comfort) deactivated`);
            return;
          }
        }
        
        // Try alternative deactivation methods
        const success = await this.tryAlternativeExtendedHeating(false, comfortProgram, features);
        
        if (success) {
          this.states.ExtendedHeatingActive = false;
          this.platform.log.info(`Heating circuit ${this.circuitNumber} extended heating deactivated using alternative method`);
        } else {
          throw new Error('Failed to deactivate extended heating mode');
        }
      }
    } catch (error) {
      this.platform.log.error(`Error setting extended heating mode for circuit ${this.circuitNumber}:`, error);
      this.restoreExtendedHeatingState();
      
      if (error instanceof this.platform.api.hap.HapStatusError) {
        throw error;
      } else {
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
    }
  }

  private async tryAlternativeExtendedHeating(activate: boolean, comfortProgram: any, features: any[]): Promise<boolean> {
    const circuitPrefix = `heating.circuits.${this.circuitNumber}`;
    
    if (activate) {
      // Method 1: Try using forcedLastFromSchedule program
      const forcedProgram = features.find(f => f.feature === `${circuitPrefix}.operating.programs.forcedLastFromSchedule`);
      if (forcedProgram?.commands?.activate?.isExecutable) {
        this.platform.log.info(`Trying alternative: forcedLastFromSchedule activation for circuit ${this.circuitNumber}`);
        
        const success = await this.platform.viessmannAPI.executeCommand(
          this.installation.id,
          this.gateway.serial,
          this.device.id,
          `${circuitPrefix}.operating.programs.forcedLastFromSchedule`,
          'activate',
          {}
        );
        
        if (success) {
          this.platform.log.info(`Alternative method successful: forcedLastFromSchedule activated for circuit ${this.circuitNumber}`);
          return true;
        }
      }

      // Method 2: Try setting comfort temperature directly (temperature boost)
      if (comfortProgram.commands?.setTemperature?.isExecutable) {
        const currentTemp = comfortProgram.properties?.temperature?.value || this.states.HeatingThresholdTemperature;
        const boostTemp = Math.min(currentTemp + 2, this.temperatureConstraints.max); // Boost by 2°C
        
        this.platform.log.info(`Trying alternative: comfort temperature boost to ${boostTemp}°C for circuit ${this.circuitNumber}`);
        
        const success = await this.platform.viessmannAPI.executeCommand(
          this.installation.id,
          this.gateway.serial,
          this.device.id,
          `${circuitPrefix}.operating.programs.comfort`,
          'setTemperature',
          { targetTemperature: boostTemp }
        );
        
        if (success) {
          this.platform.log.info(`Alternative method successful: comfort temperature set to ${boostTemp}°C for circuit ${this.circuitNumber}`);
          return true;
        }
      }

      // Method 3: Try normal program temperature boost
      const normalProgram = features.find(f => f.feature === `${circuitPrefix}.operating.programs.normal`);
      if (normalProgram?.commands?.setTemperature?.isExecutable) {
        const currentTemp = normalProgram.properties?.temperature?.value || this.states.HeatingThresholdTemperature;
        const boostTemp = Math.min(currentTemp + 3, this.temperatureConstraints.max); // Boost by 3°C
        
        this.platform.log.info(`Trying alternative: normal program temperature boost to ${boostTemp}°C for circuit ${this.circuitNumber}`);
        
        const success = await this.platform.viessmannAPI.executeCommand(
          this.installation.id,
          this.gateway.serial,
          this.device.id,
          `${circuitPrefix}.operating.programs.normal`,
          'setTemperature',
          { targetTemperature: boostTemp }
        );
        
        if (success) {
          this.platform.log.info(`Alternative method successful: normal program temperature boosted to ${boostTemp}°C for circuit ${this.circuitNumber}`);
          return true;
        }
      }

    } else {
      // Deactivation alternatives
      
      // Method 1: Try deactivating forcedLastFromSchedule
      const forcedProgram = features.find(f => f.feature === `${circuitPrefix}.operating.programs.forcedLastFromSchedule`);
      if (forcedProgram?.commands?.deactivate?.isExecutable) {
        this.platform.log.info(`Trying alternative: forcedLastFromSchedule deactivation for circuit ${this.circuitNumber}`);
        
        const success = await this.platform.viessmannAPI.executeCommand(
          this.installation.id,
          this.gateway.serial,
          this.device.id,
          `${circuitPrefix}.operating.programs.forcedLastFromSchedule`,
          'deactivate',
          {}
        );
        
        if (success) {
          this.platform.log.info(`Alternative method successful: forcedLastFromSchedule deactivated for circuit ${this.circuitNumber}`);
          return true;
        }
      }

      // Method 2: Reset to normal temperature
      if (comfortProgram.commands?.setTemperature?.isExecutable) {
        const normalProgram = features.find(f => f.feature === `${circuitPrefix}.operating.programs.normal`);
        const normalTemp = normalProgram?.properties?.temperature?.value || (this.states.HeatingThresholdTemperature - 1);
        
        this.platform.log.info(`Trying alternative: reset comfort temperature to normal ${normalTemp}°C for circuit ${this.circuitNumber}`);
        
        const success = await this.platform.viessmannAPI.executeCommand(
          this.installation.id,
          this.gateway.serial,
          this.device.id,
          `${circuitPrefix}.operating.programs.comfort`,
          'setTemperature',
          { targetTemperature: normalTemp }
        );
        
        if (success) {
          this.platform.log.info(`Alternative method successful: comfort temperature reset to ${normalTemp}°C for circuit ${this.circuitNumber}`);
          return true;
        }
      }
    }

    return false;
  }

  private async executeComfortCommand(commandName: string, comfortProgram: any, activate: boolean): Promise<boolean> {
    let commandParams = {};
    
    // For activate command, check if we need to provide temperature parameter
    if (activate && comfortProgram.commands.activate.params?.temperature) {
      // Use current comfort temperature or a sensible default
      const comfortTemp = comfortProgram.properties?.temperature?.value || 
                         (this.states.HeatingThresholdTemperature + 1); // 1°C above current target
      commandParams = { temperature: comfortTemp };
      this.platform.log.debug(`Using temperature ${comfortTemp}°C for comfort program activation`);
    }
    
    return await this.platform.viessmannAPI.executeCommand(
      this.installation.id,
      this.gateway.serial,
      this.device.id,
      `heating.circuits.${this.circuitNumber}.operating.programs.comfort`,
      commandName,
      commandParams
    );
  }

  private getExtendedHeatingSuggestion(features: any[]): string {
    const suggestions: string[] = [];
    
    // Check what might be preventing execution
    const circuitPrefix = `heating.circuits.${this.circuitNumber}`;
    
    // Check if other programs are active
    const activePrograms = features.filter(f => 
      f.feature.startsWith(`${circuitPrefix}.operating.programs.`) &&
      f.properties?.active?.value === true
    );
    
    if (activePrograms.length > 0) {
      suggestions.push(`Other programs may be active: ${activePrograms.map(p => p.feature.split('.').pop()).join(', ')}`);
    }
    
    // Check if schedule is active
    const scheduleFeature = features.find(f => f.feature === `${circuitPrefix}.heating.schedule`);
    if (scheduleFeature?.properties?.active?.value === true) {
      suggestions.push('Heating schedule is active and may prevent manual comfort activation');
    }
    
    // Check system-level holiday programs
    const holidayFeature = features.find(f => f.feature === 'heating.operating.programs.holiday');
    const holidayAtHomeFeature = features.find(f => f.feature === 'heating.operating.programs.holidayAtHome');
    
    if (holidayFeature?.properties?.active?.value === true) {
      suggestions.push('Holiday mode is active');
    }
    
    if (holidayAtHomeFeature?.properties?.active?.value === true) {
      suggestions.push('Holiday at home mode is active');
    }
    
    if (suggestions.length === 0) {
      suggestions.push('The system may require specific conditions or timing to activate comfort mode');
    }
    
    return suggestions.length > 0 ? ` Possible reasons: ${suggestions.join('; ')}.` : '';
  }

  private restoreExtendedHeatingState() {
    setTimeout(() => {
      this.extendedHeatingService?.updateCharacteristic(this.platform.Characteristic.On, this.states.ExtendedHeatingActive);
    }, 100);
  }

  /**
   * Deactivate conflicting quick selection programs before activating a new one
   */
  private async deactivateConflictingQuickSelections(conflictingMethods: string[]) {
    for (const method of conflictingMethods) {
      try {
        switch (method) {
          case 'extendedHeating':
            if (this.states.ExtendedHeatingActive) {
              this.platform.log.info(`Deactivating Extended Heating to avoid conflicts for circuit ${this.circuitNumber}`);
              // Directly call the deactivation logic without going through the switch
              await this.deactivateExtendedHeatingDirect();
            }
            break;
            
          case 'holiday':
            if (this.states.HolidayActive) {
              this.platform.log.info(`Deactivating Holiday Mode to avoid conflicts for circuit ${this.circuitNumber}`);
              await this.platform.viessmannAPI.executeCommand(
                this.installation.id,
                this.gateway.serial,
                this.device.id,
                'heating.operating.programs.holiday',
                'unschedule',
                {}
              );
              this.states.HolidayActive = false;
            }
            break;
            
          case 'holidayAtHome':
            if (this.states.HolidayAtHomeActive) {
              this.platform.log.info(`Deactivating Holiday At Home Mode to avoid conflicts for circuit ${this.circuitNumber}`);
              await this.platform.viessmannAPI.executeCommand(
                this.installation.id,
                this.gateway.serial,
                this.device.id,
                'heating.operating.programs.holidayAtHome',
                'unschedule',
                {}
              );
              this.states.HolidayAtHomeActive = false;
            }
            break;
        }
      } catch (error) {
        this.platform.log.warn(`Failed to deactivate conflicting method ${method} for circuit ${this.circuitNumber}:`, error);
        // Continue with activation even if deactivation fails
      }
    }
  }

  /**
   * Deactivate conflicting programs at the circuit level (for Extended Heating activation)
   */
  private async deactivateConflictingPrograms(features: any[]) {
    const circuitPrefix = `heating.circuits.${this.circuitNumber}`;
    
    // Deactivate forced programs that might conflict
    const forcedProgram = features.find(f => f.feature === `${circuitPrefix}.operating.programs.forcedLastFromSchedule`);
    if (forcedProgram?.properties?.active?.value === true && forcedProgram.commands?.deactivate?.isExecutable) {
      try {
        this.platform.log.info(`Deactivating forcedLastFromSchedule to avoid conflicts for circuit ${this.circuitNumber}`);
        await this.platform.viessmannAPI.executeCommand(
          this.installation.id,
          this.gateway.serial,
          this.device.id,
          `${circuitPrefix}.operating.programs.forcedLastFromSchedule`,
          'deactivate',
          {}
        );
      } catch (error) {
        this.platform.log.warn(`Failed to deactivate forcedLastFromSchedule for circuit ${this.circuitNumber}:`, error);
      }
    }
    
    // Deactivate system-level holiday programs
    await this.deactivateConflictingQuickSelections(['holiday', 'holidayAtHome']);
  }

  /**
   * Direct deactivation of Extended Heating without going through the switch handler
   */
  private async deactivateExtendedHeatingDirect() {
    try {
      const features = await this.platform.viessmannAPI.getDeviceFeatures(
        this.installation.id,
        this.gateway.serial,
        this.device.id
      );
      
      const comfortProgram = features.find(f => f.feature === `heating.circuits.${this.circuitNumber}.operating.programs.comfort`);
      if (comfortProgram?.commands?.deactivate?.isExecutable) {
        await this.executeComfortCommand('deactivate', comfortProgram, false);
      } else {
        // Try alternative deactivation
        await this.tryAlternativeExtendedHeating(false, comfortProgram, features);
      }
      
      this.states.ExtendedHeatingActive = false;
    } catch (error) {
      this.platform.log.warn(`Failed to directly deactivate Extended Heating for circuit ${this.circuitNumber}:`, error);
    }
  }

  /**
   * Update all switch characteristics to reflect mutual exclusion
   */
  private updateMutuallyExclusiveSwitches() {
    // Update Extended Heating switch
    if (this.extendedHeatingService) {
      this.extendedHeatingService.updateCharacteristic(this.platform.Characteristic.On, this.states.ExtendedHeatingActive);
    }
    
    // Update Holiday switch
    if (this.holidayService) {
      this.holidayService.updateCharacteristic(this.platform.Characteristic.On, this.states.HolidayActive);
    }
    
    // Update Holiday At Home switch
    if (this.holidayAtHomeService) {
      this.holidayAtHomeService.updateCharacteristic(this.platform.Characteristic.On, this.states.HolidayAtHomeActive);
    }
    
    // Log current state for debugging
    const activePrograms = [];
    if (this.states.ExtendedHeatingActive) activePrograms.push('Extended Heating');
    if (this.states.HolidayActive) activePrograms.push('Holiday');
    if (this.states.HolidayAtHomeActive) activePrograms.push('Holiday At Home');
    
    this.platform.log.debug(`Circuit ${this.circuitNumber} active programs: ${activePrograms.length > 0 ? activePrograms.join(', ') : 'None'}`);
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
        
        // Update all characteristics
        this.updateAllCharacteristics();
      } else {
        this.platform.log.error(`Failed to set heating circuit ${this.circuitNumber} mode to: ${mode}`);
        // Restore the previous state
        this.updateAllCharacteristics();
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
    } catch (error) {
      this.platform.log.error(`Error setting heating circuit ${this.circuitNumber} mode to ${mode}:`, error);
      // Restore the previous state
      this.updateAllCharacteristics();
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private updateAllCharacteristics() {
    // Update HeaterCooler characteristics
    const isActive = this.currentMode === 'heating';
    this.heaterCoolerService.updateCharacteristic(this.platform.Characteristic.Active, 
      isActive ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE);
    
    this.heaterCoolerService.updateCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState,
      isActive ? this.platform.Characteristic.CurrentHeaterCoolerState.HEATING : 
                 this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE);
    
    this.platform.log.debug(`Heating Circuit ${this.circuitNumber} States - Mode: ${this.currentMode.toUpperCase()}, Active: ${isActive}`);
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
      this.platform.log.error(`Invalid heating circuit ${this.circuitNumber} temperature: ${temperature}°C (must be between ${this.temperatureConstraints.min}-${this.temperatureConstraints.max}°C)`);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
    }

    this.states.HeatingThresholdTemperature = temperature;

    try {
      // Set temperature for the currently active program
      const programToUse = this.currentProgram;
      
      if (this.availablePrograms.includes(programToUse)) {
        const success = await this.platform.viessmannAPI.executeCommand(
          this.installation.id,
          this.gateway.serial,
          this.device.id,
          `heating.circuits.${this.circuitNumber}.operating.programs.${programToUse}`,
          'setTemperature',
          { targetTemperature: temperature }
        );

        if (success) {
          // Update the stored temperature for this program
          this.programTemperatures[programToUse as ProgramType] = temperature;
          
          this.platform.log.info(`Heating circuit ${this.circuitNumber} temperature set to: ${temperature}°C (program: ${programToUse})`);
          
          // Update service names to reflect new temperatures
          this.updateServiceNames();
        } else {
          throw new Error(`Failed to set temperature for program ${programToUse}`);
        }
      } else {
        throw new Error('Current program not available for temperature setting');
      }
    } catch (error) {
      this.platform.log.error(`Error setting heating circuit ${this.circuitNumber} temperature:`, error);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private updateServiceNames() {
    const installationName = this.installation.description;
    
    // Helper function to sanitize service names for HomeKit
    const sanitizeName = (name: string): string => {
      return name
        .replace(/[^\w\s']/g, ' ') // Replace special chars with spaces
        .replace(/\s+/g, ' ')      // Collapse multiple spaces
        .trim();                   // Remove leading/trailing spaces
    };
    
    // Update service names to show current temperatures
    if (this.ridottaService) {
      const serviceName = sanitizeName(`${installationName} HC${this.circuitNumber} Reduced ${this.programTemperatures.reduced}C`);
      this.ridottaService.setCharacteristic(this.platform.Characteristic.Name, serviceName);
    }
    
    if (this.normaleService) {
      const serviceName = sanitizeName(`${installationName} HC${this.circuitNumber} Normal ${this.programTemperatures.normal}C`);
      this.normaleService.setCharacteristic(this.platform.Characteristic.Name, serviceName);
    }
    
    if (this.comfortService) {
      const serviceName = sanitizeName(`${installationName} HC${this.circuitNumber} Comfort ${this.programTemperatures.comfort}C`);
      this.comfortService.setCharacteristic(this.platform.Characteristic.Name, serviceName);
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
    let anyProgramStateChanged = false;
    let anyTemperatureChanged = false;

    // Update room temperature
    const roomTempFeature = features.find(f => f.feature === `${circuitPrefix}.sensors.temperature.room`);
    if (roomTempFeature?.properties?.value?.value !== undefined) {
      this.states.CurrentTemperature = roomTempFeature.properties.value.value;
      this.heaterCoolerService.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.states.CurrentTemperature);
    } else {
      // Update supply temperature as fallback if room temperature not available
      const supplyTempFeature = features.find(f => f.feature === `${circuitPrefix}.sensors.temperature.supply`);
      if (supplyTempFeature?.properties?.value?.value !== undefined) {
        // Convert supply temperature to approximate room temperature (rough estimate)
        this.states.CurrentTemperature = Math.max(15, supplyTempFeature.properties.value.value - 15);
        this.heaterCoolerService.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.states.CurrentTemperature);
      }
    }

    // Update temperature programs and detect which one is currently active
    const programTypes = ['comfort', 'normal', 'reduced'];
    let activeProgram = 'normal'; // Default fallback

    for (const programType of programTypes) {
      const programFeature = features.find(f => f.feature === `${circuitPrefix}.operating.programs.${programType}`);
      if (programFeature?.properties?.temperature?.value !== undefined) {
        const newTemp = programFeature.properties.temperature.value;
        const oldTemp = this.programTemperatures[programType as ProgramType];
        
        // Update stored temperature for this program
        if (newTemp !== oldTemp) {
          this.programTemperatures[programType as ProgramType] = newTemp;
          anyTemperatureChanged = true;
          this.platform.log.debug(`Program ${programType} temperature updated: ${oldTemp}°C → ${newTemp}°C`);
        }
        
        // Determine which program is currently active based on the HeatingThresholdTemperature
        // The active program is likely the one whose temperature matches the current target
        if (Math.abs(newTemp - this.states.HeatingThresholdTemperature) < 0.5) {
          activeProgram = programType;
        }
      }
    }

    // Update current program if it changed
    if (activeProgram !== this.currentProgram) {
      this.currentProgram = activeProgram;
      this.platform.log.debug(`Active temperature program changed to: ${activeProgram.toUpperCase()}`);
      this.updateTemperatureProgramSwitches();
    }

    // Update service names if temperatures changed
    if (anyTemperatureChanged) {
      this.updateServiceNames();
    }

    // Update HeatingThresholdTemperature to match the active program
    const activeTemp = this.programTemperatures[activeProgram as ProgramType];
    if (activeTemp !== this.states.HeatingThresholdTemperature) {
      this.states.HeatingThresholdTemperature = activeTemp;
      this.heaterCoolerService.updateCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature, activeTemp);
    }

    // Update quick selection programs with mutual exclusion logic
    const holidayFeature = features.find(f => f.feature === 'heating.operating.programs.holiday');
    if (holidayFeature?.properties?.active?.value !== undefined) {
      const newState = holidayFeature.properties.active.value;
      if (newState !== this.states.HolidayActive) {
        this.states.HolidayActive = newState;
        anyProgramStateChanged = true;
        
        // If holiday becomes active, deactivate conflicting programs
        if (newState) {
          this.states.ExtendedHeatingActive = false;
          this.states.HolidayAtHomeActive = false;
          this.platform.log.debug(`Holiday mode activated - deactivated conflicting programs for circuit ${this.circuitNumber}`);
        }
      }
    }

    const holidayAtHomeFeature = features.find(f => f.feature === 'heating.operating.programs.holidayAtHome');
    if (holidayAtHomeFeature?.properties?.active?.value !== undefined) {
      const newState = holidayAtHomeFeature.properties.active.value;
      if (newState !== this.states.HolidayAtHomeActive) {
        this.states.HolidayAtHomeActive = newState;
        anyProgramStateChanged = true;
        
        // If holiday at home becomes active, deactivate conflicting programs
        if (newState) {
          this.states.ExtendedHeatingActive = false;
          this.states.HolidayActive = false;
          this.platform.log.debug(`Holiday at home mode activated - deactivated conflicting programs for circuit ${this.circuitNumber}`);
        }
      }
    }

    const comfortProgram = features.find(f => f.feature === `${circuitPrefix}.operating.programs.comfort`);
    if (comfortProgram?.properties?.active?.value !== undefined) {
      const newState = comfortProgram.properties.active.value;
      if (newState !== this.states.ExtendedHeatingActive) {
        this.states.ExtendedHeatingActive = newState;
        anyProgramStateChanged = true;
        
        // If extended heating becomes active, deactivate conflicting programs
        if (newState) {
          this.states.HolidayActive = false;
          this.states.HolidayAtHomeActive = false;
          this.platform.log.debug(`Extended heating activated - deactivated conflicting programs for circuit ${this.circuitNumber}`);
        }
      }
    }

    // Update all switch characteristics if any program state changed
    if (anyProgramStateChanged) {
      this.updateMutuallyExclusiveSwitches();
    }

    // Update operating mode
    const operatingModeFeature = features.find(f => f.feature === `${circuitPrefix}.operating.modes.active`);
    if (operatingModeFeature?.properties?.value?.value !== undefined) {
      const newMode = operatingModeFeature.properties.value.value;
      if (newMode !== this.currentMode) {
        this.platform.log.debug(`Heating circuit ${this.circuitNumber} mode updated: ${this.currentMode.toUpperCase()} → ${newMode.toUpperCase()}`);
        this.currentMode = newMode;
        this.updateAllCharacteristics();
      }
    }

    // Update humidity if available
    const humidityFeature = features.find(f => f.feature.includes('sensors.humidity'));
    if (humidityFeature?.properties?.value?.value !== undefined) {
      this.states.CurrentRelativeHumidity = humidityFeature.properties.value.value;
    }

    this.platform.log.debug(`Heating Circuit ${this.circuitNumber} Status - Mode: ${this.currentMode.toUpperCase()}, Room Temp: ${this.states.CurrentTemperature}°C, Target: ${this.states.HeatingThresholdTemperature}°C, Program: ${this.currentProgram.toUpperCase()}`);
  }
}