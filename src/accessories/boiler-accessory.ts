import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { ViessmannPlatform, ViessmannInstallation, ViessmannGateway, ViessmannDevice, ViessmannPlatformConfig } from '../platform';

export class ViessmannBoilerAccessory {
  private heaterCoolerService: Service;
  private informationService: Service;
  private modulationService?: Service;
  private burnerService?: Service;
  
  // 🆕 NEW: Diagnostic Services
  private outsideTemperatureService?: Service;
  private gasConsumptionService?: Service;
  private powerConsumptionService?: Service;
  private burnerStatisticsService?: Service;
  private burnerActivityService?: Service;
  private temperatureRangeService?: Service;
  private waterPressureService?: Service;
  
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
    
    // 🆕 NEW: Diagnostic states
    OutsideTemperature: 0,
    GasConsumptionToday: 0,
    GasConsumptionThisMonth: 0,
    GasConsumptionThisYear: 0,
    PowerConsumptionToday: 0,
    PowerConsumptionThisMonth: 0,
    PowerConsumptionThisYear: 0,
    BoilerSerial: '',
    BoilerEfficiency: 0, // Calculated based on consumption and temperature
    WaterPressure: 0, // Current water pressure in bar
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

    // 🆕 NEW: Analyze diagnostic capabilities
    const outsideTempFeature = features.find(f => f.feature === 'heating.sensors.temperature.outside');
    const gasConsumptionFeature = features.find(f => f.feature === 'heating.gas.consumption.summary.heating');
    const powerConsumptionFeature = features.find(f => f.feature === 'heating.power.consumption.summary.heating');
    const boilerSerialFeature = features.find(f => f.feature === 'heating.boiler.serial');
    const waterPressureFeature = features.find(f => 
      f.feature === 'heating.sensors.pressure.supply' ||
      f.feature === 'heating.boiler.sensors.pressure.supply' ||
      f.feature === 'heating.circuits.0.sensors.pressure.supply'
    );

    // Extract diagnostic data
    if (outsideTempFeature?.properties?.value?.value !== undefined) {
      this.states.OutsideTemperature = outsideTempFeature.properties.value.value;
    }

    if (gasConsumptionFeature?.properties) {
      this.states.GasConsumptionToday = gasConsumptionFeature.properties.currentDay?.value || 0;
      this.states.GasConsumptionThisMonth = gasConsumptionFeature.properties.currentMonth?.value || 0;
      this.states.GasConsumptionThisYear = gasConsumptionFeature.properties.currentYear?.value || 0;
    }

    if (powerConsumptionFeature?.properties) {
      this.states.PowerConsumptionToday = powerConsumptionFeature.properties.currentDay?.value || 0;
      this.states.PowerConsumptionThisMonth = powerConsumptionFeature.properties.currentMonth?.value || 0;
      this.states.PowerConsumptionThisYear = powerConsumptionFeature.properties.currentYear?.value || 0;
    }

    if (boilerSerialFeature?.properties?.value?.value) {
      this.states.BoilerSerial = boilerSerialFeature.properties.value.value;
    }

    if (waterPressureFeature?.properties?.value?.value !== undefined) {
      this.states.WaterPressure = waterPressureFeature.properties.value.value;
    }

    // Get current boiler temperature
    if (boilerTempFeature?.properties?.value?.value !== undefined) {
      this.states.HeatingThresholdTemperature = boilerTempFeature.properties.value.value;
    }

    this.platform.log.info(`Boiler Capabilities - Temperature: ${this.supportsTemperatureControl ? 'Yes' : 'No'}, Burner: ${burnerFeature ? 'Yes' : 'No'}, Modulation: ${modulationFeature ? 'Yes' : 'No'}, Diagnostics: ${outsideTempFeature ? 'Outside Temp, ' : ''}${gasConsumptionFeature ? 'Gas Consumption, ' : ''}${powerConsumptionFeature ? 'Power Consumption, ' : ''}${waterPressureFeature ? 'Water Pressure' : ''}`);
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
    
    // 🆕 NEW: Setup diagnostic services
    this.setupDiagnosticServices();
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
  
    // Use custom names properly with fallbacks
    const installationName = customNames.installationPrefix || this.installation.description;
    const boilerName = customNames.boiler || 'Boiler';
    const burnerName = customNames.burner || 'Burner';

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

    // Use timestamp-based version for automatic recreation
    const subtypeVersion = config.forceServiceRecreation ? 
      Date.now().toString().slice(-8) : // Last 8 digits of timestamp
      'stable'; // Use stable version normally
    
    // Create burner status service (read-only switch)  
    const burnerServiceName = `${installationName} ${boilerName} ${burnerName}`;
    
    this.burnerService = this.accessory.addService(
      this.platform.Service.Switch, 
      burnerServiceName, 
      `boiler-burner-${subtypeVersion}`
    );
    
    // Set both Name characteristic AND displayName
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
  
    // Use custom names properly with fallbacks
    const installationName = customNames.installationPrefix || this.installation.description;
    const boilerName = customNames.boiler || 'Boiler';
    const modulationName = customNames.modulation || 'Modulation';

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

    // Use timestamp-based version for automatic recreation
    const subtypeVersion = config.forceServiceRecreation ? 
      Date.now().toString().slice(-8) : // Last 8 digits of timestamp
      'stable'; // Use stable version normally

    // Create modulation service using Lightbulb with brightness (read-only)
    const modulationServiceName = `${installationName} ${boilerName} ${modulationName}`;
    
    this.modulationService = this.accessory.addService(
      this.platform.Service.Lightbulb, 
      modulationServiceName, 
      `boiler-modulation-${subtypeVersion}`
    );
    
    // Set both Name characteristic AND displayName
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

  // 🆕 NEW: Setup diagnostic services
  private setupDiagnosticServices() {
    const config = this.platform.config as ViessmannPlatformConfig;
    const customNames = config.customNames || {};
    
    const installationName = customNames.installationPrefix || this.installation.description;
    const boilerName = customNames.boiler || 'Boiler';

    // Remove existing diagnostic services first
    this.removeExistingDiagnosticServices();

    const subtypeVersion = config.forceServiceRecreation ? 
      Date.now().toString().slice(-8) : 'stable';

    // 1. Outside Temperature Sensor
    if (this.states.OutsideTemperature !== 0 || this.hasOutsideTemperatureSensor()) {
      const outsideTempServiceName = `${installationName} ${boilerName} Outside`;
      
      this.outsideTemperatureService = this.accessory.addService(
        this.platform.Service.TemperatureSensor,
        outsideTempServiceName,
        `boiler-outside-temp-${subtypeVersion}`
      );
      
      this.outsideTemperatureService.setCharacteristic(this.platform.Characteristic.Name, outsideTempServiceName);
      this.outsideTemperatureService.displayName = outsideTempServiceName;
      
      this.outsideTemperatureService.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
        .onGet(() => this.states.OutsideTemperature)
        .setProps({
          minValue: -50,
          maxValue: 50,
          minStep: 0.1,
        });

      this.platform.log.info(`✅ Outside temperature sensor created: ${outsideTempServiceName}`);
    }

    // 2. Gas Consumption (using Occupancy Sensor)
    if (this.hasGasConsumption()) {
      const gasConsumptionServiceName = `${installationName} ${boilerName} Gas Usage`;
      
      this.gasConsumptionService = this.accessory.addService(
        this.platform.Service.OccupancySensor,
        gasConsumptionServiceName,
        `boiler-gas-consumption-${subtypeVersion}`
      );
      
      this.gasConsumptionService.setCharacteristic(this.platform.Characteristic.Name, gasConsumptionServiceName);
      this.gasConsumptionService.displayName = gasConsumptionServiceName;
      
      // Occupancy = true when gas is being consumed today
      this.gasConsumptionService.getCharacteristic(this.platform.Characteristic.OccupancyDetected)
        .onGet(() => {
          // Active consumption if > 0.1 m³ today
          return this.states.GasConsumptionToday > 0.1 ? 
            this.platform.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED :
            this.platform.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED;
        });

      this.platform.log.info(`✅ Gas consumption sensor created: ${gasConsumptionServiceName}`);
    }

    // 3. Power Consumption (using Motion Sensor)
    if (this.hasPowerConsumption()) {
      const powerConsumptionServiceName = `${installationName} ${boilerName} Power Activity`;
      
      this.powerConsumptionService = this.accessory.addService(
        this.platform.Service.MotionSensor,
        powerConsumptionServiceName,
        `boiler-power-consumption-${subtypeVersion}`
      );
      
      this.powerConsumptionService.setCharacteristic(this.platform.Characteristic.Name, powerConsumptionServiceName);
      this.powerConsumptionService.displayName = powerConsumptionServiceName;
      
      // Motion detected when power consumption is active
      this.powerConsumptionService.getCharacteristic(this.platform.Characteristic.MotionDetected)
        .onGet(() => {
          // Motion = true when power consumed today > 0.5 kWh
          return this.states.PowerConsumptionToday > 0.5;
        });

      this.platform.log.info(`✅ Power consumption sensor created: ${powerConsumptionServiceName}`);
    }

    // 4. Burner Efficiency (using Air Quality Sensor)
    if (this.states.BurnerHours > 0 || this.states.BurnerStarts > 0) {
      const efficiencyServiceName = `${installationName} ${boilerName} Performance`;
      
      this.burnerStatisticsService = this.accessory.addService(
        this.platform.Service.AirQualitySensor,
        efficiencyServiceName,
        `boiler-efficiency-${subtypeVersion}`
      );
      
      this.burnerStatisticsService.setCharacteristic(this.platform.Characteristic.Name, efficiencyServiceName);
      this.burnerStatisticsService.displayName = efficiencyServiceName;
      
      // Air Quality based on burner efficiency
      this.burnerStatisticsService.getCharacteristic(this.platform.Characteristic.AirQuality)
        .onGet(() => {
          if (this.states.BurnerHours === 0) {
            return this.platform.Characteristic.AirQuality.UNKNOWN;
          }
          
          const startsPerHour = this.states.BurnerStarts / this.states.BurnerHours;
          
          if (startsPerHour < 1) {
            return this.platform.Characteristic.AirQuality.EXCELLENT; // 🟢 Excellent efficiency
          } else if (startsPerHour < 2) {
            return this.platform.Characteristic.AirQuality.GOOD; // 🟡 Good efficiency  
          } else if (startsPerHour < 3) {
            return this.platform.Characteristic.AirQuality.FAIR; // 🟠 Fair efficiency
          } else if (startsPerHour < 5) {
            return this.platform.Characteristic.AirQuality.INFERIOR; // 🔴 Poor efficiency
          } else {
            return this.platform.Characteristic.AirQuality.POOR; // 💀 Very poor efficiency
          }
        });

      // Optional: Add PM2.5 density as "efficiency score" (0-100)
      this.burnerStatisticsService.getCharacteristic(this.platform.Characteristic.PM2_5Density)
        .onGet(() => {
          if (this.states.BurnerHours === 0) return 0;
          
          const startsPerHour = this.states.BurnerStarts / this.states.BurnerHours;
          // Invert the scale: lower starts/hour = better efficiency = lower "pollution"
          const efficiencyScore = Math.min(100, Math.max(0, startsPerHour * 20));
          return Math.round(efficiencyScore);
        })
        .setProps({
          minValue: 0,
          maxValue: 100,
          minStep: 1,
        });

      this.platform.log.info(`✅ Burner efficiency sensor created: ${efficiencyServiceName}`);
    }

    // 5. Burner Activity (using Contact Sensor)
    const burnerActivityServiceName = `${installationName} ${boilerName} Burner Activity`;
    
    this.burnerActivityService = this.accessory.addService(
      this.platform.Service.ContactSensor,
      burnerActivityServiceName,
      `boiler-burner-activity-${subtypeVersion}`
    );
    
    this.burnerActivityService.setCharacteristic(this.platform.Characteristic.Name, burnerActivityServiceName);
    this.burnerActivityService.displayName = burnerActivityServiceName;
    
    // Contact State: Open = Burner Active, Closed = Burner Inactive
    this.burnerActivityService.getCharacteristic(this.platform.Characteristic.ContactSensorState)
      .onGet(() => {
        return this.currentBurnerState ? 
          this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED : // Open = Active
          this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED;      // Closed = Inactive
      });

    this.platform.log.info(`✅ Burner activity sensor created: ${burnerActivityServiceName}`);

    // 6. System Temperature Range (using Humidity Sensor)
    if (this.states.CurrentTemperature > 0 && this.states.HeatingThresholdTemperature > 0) {
      const tempRangeServiceName = `${installationName} ${boilerName} Temp Range`;
      
      this.temperatureRangeService = this.accessory.addService(
        this.platform.Service.HumiditySensor,
        tempRangeServiceName,
        `boiler-temp-range-${subtypeVersion}`
      );
      
      this.temperatureRangeService.setCharacteristic(this.platform.Characteristic.Name, tempRangeServiceName);
      this.temperatureRangeService.displayName = tempRangeServiceName;
      
      // Use humidity to show temperature "progress" toward target
      this.temperatureRangeService.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
        .onGet(() => {
          const current = this.states.CurrentTemperature;
          const target = this.states.HeatingThresholdTemperature;
          const min = this.temperatureConstraints.min;
          const max = this.temperatureConstraints.max;
          
          // Calculate "progress" as percentage
          if (target <= min) return 0;
          if (current >= target) return 100;
          
          const progress = ((current - min) / (target - min)) * 100;
          return Math.min(100, Math.max(0, Math.round(progress)));
        })
        .setProps({
          minValue: 0,
          maxValue: 100,
          minStep: 1,
        });

      this.platform.log.info(`✅ Temperature range indicator created: ${tempRangeServiceName}`);
    }

    // 7. Water Pressure (using Leak Sensor)
    if (this.hasWaterPressure()) {
      const waterPressureServiceName = `${installationName} ${boilerName} Water Pressure`;
      
      this.waterPressureService = this.accessory.addService(
        this.platform.Service.LeakSensor,
        waterPressureServiceName,
        `boiler-water-pressure-${subtypeVersion}`
      );
      
      this.waterPressureService.setCharacteristic(this.platform.Characteristic.Name, waterPressureServiceName);
      this.waterPressureService.displayName = waterPressureServiceName;
      
      // Leak Detected = Pressure outside optimal range (1.0-2.5 bar)
      this.waterPressureService.getCharacteristic(this.platform.Characteristic.LeakDetected)
        .onGet(() => {
          const pressure = this.states.WaterPressure;
          // Optimal pressure: 1.0-2.5 bar
          const isOptimal = pressure >= 1.0 && pressure <= 2.5;
          
          return isOptimal ? 
            this.platform.Characteristic.LeakDetected.LEAK_NOT_DETECTED :  // Good pressure
            this.platform.Characteristic.LeakDetected.LEAK_DETECTED;       // Pressure issue
        });

      this.platform.log.info(`✅ Water pressure sensor created: ${waterPressureServiceName}`);
    }
  }

  private removeExistingDiagnosticServices() {
    const servicesToRemove = [
      { service: this.outsideTemperatureService, subtype: 'boiler-outside-temp' },
      { service: this.gasConsumptionService, subtype: 'boiler-gas-consumption' },
      { service: this.powerConsumptionService, subtype: 'boiler-power-consumption' },
      { service: this.burnerStatisticsService, subtype: 'boiler-efficiency' },
      { service: this.burnerActivityService, subtype: 'boiler-burner-activity' },
      { service: this.temperatureRangeService, subtype: 'boiler-temp-range' },
      { service: this.waterPressureService, subtype: 'boiler-water-pressure' },
    ];

    for (const { subtype } of servicesToRemove) {
      const existingServices = this.accessory.services.filter(service => 
        service.subtype?.startsWith(subtype)
      );
      
      for (const service of existingServices) {
        try {
          this.accessory.removeService(service);
          this.platform.log.debug(`Removed existing diagnostic service: ${service.displayName}`);
        } catch (error) {
          this.platform.log.debug(`Could not remove diagnostic service: ${error}`);
        }
      }
    }

    // Clear references
    this.outsideTemperatureService = undefined;
    this.gasConsumptionService = undefined;
    this.powerConsumptionService = undefined;
    this.burnerStatisticsService = undefined;
    this.burnerActivityService = undefined;
    this.temperatureRangeService = undefined;
    this.waterPressureService = undefined;
  }

  // Helper methods to check if diagnostic features are available
  private hasOutsideTemperatureSensor(): boolean {
    return this.states.OutsideTemperature !== 0;
  }

  private hasGasConsumption(): boolean {
    return this.states.GasConsumptionToday > 0 || this.states.GasConsumptionThisYear > 0;
  }

  private hasPowerConsumption(): boolean {
    return this.states.PowerConsumptionToday > 0 || this.states.PowerConsumptionThisYear > 0;
  }

  private hasWaterPressure(): boolean {
    return this.states.WaterPressure > 0;
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
        
        // Update burner activity contact sensor
        if (this.burnerActivityService) {
          this.burnerActivityService.updateCharacteristic(
            this.platform.Characteristic.ContactSensorState,
            newBurnerState ? 
              this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED : // Open = Active
              this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED       // Closed = Inactive
          );
          
          this.platform.log.debug(`Burner activity: ${newBurnerState ? 'OPEN (Active)' : 'CLOSED (Inactive)'}`);
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

    // 🆕 NEW: Update diagnostic information
    
    // Update outside temperature
    const outsideTempFeature = features.find(f => f.feature === 'heating.sensors.temperature.outside');
    if (outsideTempFeature?.properties?.value?.value !== undefined) {
      const newOutsideTemp = outsideTempFeature.properties.value.value;
      if (newOutsideTemp !== this.states.OutsideTemperature) {
        this.states.OutsideTemperature = newOutsideTemp;
        
        if (this.outsideTemperatureService) {
          this.outsideTemperatureService.updateCharacteristic(
            this.platform.Characteristic.CurrentTemperature, 
            newOutsideTemp
          );
        }
        
        this.platform.log.debug(`Outside temperature: ${newOutsideTemp}°C`);
      }
    }

    // Update gas consumption
    const gasConsumptionFeature = features.find(f => f.feature === 'heating.gas.consumption.summary.heating');
    let gasDataUpdated = false;
    
    if (gasConsumptionFeature?.properties) {
      if (gasConsumptionFeature.properties.currentDay?.value !== undefined) {
        const newValue = gasConsumptionFeature.properties.currentDay.value;
        if (newValue !== this.states.GasConsumptionToday) {
          this.states.GasConsumptionToday = newValue;
          gasDataUpdated = true;
        }
      }
      
      if (gasConsumptionFeature.properties.currentMonth?.value !== undefined) {
        this.states.GasConsumptionThisMonth = gasConsumptionFeature.properties.currentMonth.value;
      }
      
      if (gasConsumptionFeature.properties.currentYear?.value !== undefined) {
        this.states.GasConsumptionThisYear = gasConsumptionFeature.properties.currentYear.value;
      }
    }

    // Update gas consumption occupancy sensor
    if (gasDataUpdated && this.gasConsumptionService) {
      const hasActiveConsumption = this.states.GasConsumptionToday > 0.1;
      
      this.gasConsumptionService.updateCharacteristic(
        this.platform.Characteristic.OccupancyDetected,
        hasActiveConsumption ? 
          this.platform.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED :
          this.platform.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED
      );
      
      this.platform.log.debug(`Gas consumption ${hasActiveConsumption ? 'ACTIVE' : 'INACTIVE'}: ${this.states.GasConsumptionToday} m³`);
    }

    // Update power consumption
    const powerConsumptionFeature = features.find(f => f.feature === 'heating.power.consumption.summary.heating');
    let powerDataUpdated = false;
    
    if (powerConsumptionFeature?.properties) {
      if (powerConsumptionFeature.properties.currentDay?.value !== undefined) {
        const newValue = powerConsumptionFeature.properties.currentDay.value;
        if (newValue !== this.states.PowerConsumptionToday) {
          this.states.PowerConsumptionToday = newValue;
          powerDataUpdated = true;
        }
      }
      
      if (powerConsumptionFeature.properties.currentMonth?.value !== undefined) {
        this.states.PowerConsumptionThisMonth = powerConsumptionFeature.properties.currentMonth.value;
      }
      
      if (powerConsumptionFeature.properties.currentYear?.value !== undefined) {
        this.states.PowerConsumptionThisYear = powerConsumptionFeature.properties.currentYear.value;
      }
    }

    // Update power consumption motion sensor
    if (powerDataUpdated && this.powerConsumptionService) {
      const hasActiveConsumption = this.states.PowerConsumptionToday > 0.5;
      
      this.powerConsumptionService.updateCharacteristic(
        this.platform.Characteristic.MotionDetected,
        hasActiveConsumption
      );
      
      this.platform.log.debug(`Power consumption ${hasActiveConsumption ? 'DETECTED' : 'IDLE'}: ${this.states.PowerConsumptionToday} kWh`);
    }

    // Update water pressure
    const waterPressureFeature = features.find(f => 
      f.feature === 'heating.sensors.pressure.supply' ||
      f.feature === 'heating.boiler.sensors.pressure.supply' ||
      f.feature === 'heating.circuits.0.sensors.pressure.supply'
    );
    
    if (waterPressureFeature?.properties?.value?.value !== undefined) {
      const newPressure = waterPressureFeature.properties.value.value;
      if (newPressure !== this.states.WaterPressure) {
        this.states.WaterPressure = newPressure;
        
        if (this.waterPressureService) {
          const isOptimal = newPressure >= 1.0 && newPressure <= 2.5;
          
          this.waterPressureService.updateCharacteristic(
            this.platform.Characteristic.LeakDetected,
            isOptimal ? 
              this.platform.Characteristic.LeakDetected.LEAK_NOT_DETECTED :
              this.platform.Characteristic.LeakDetected.LEAK_DETECTED
          );
          
          let pressureStatus;
          if (newPressure < 1.0) {
            pressureStatus = 'LOW';
          } else if (newPressure > 2.5) {
            pressureStatus = 'HIGH';  
          } else {
            pressureStatus = 'OPTIMAL';
          }
          
          this.platform.log.debug(`Water pressure: ${newPressure} bar = ${pressureStatus}`);
        }
      }
    }

    // Update boiler serial number in accessory information if available
    const boilerSerialFeature = features.find(f => f.feature === 'heating.boiler.serial');
    if (boilerSerialFeature?.properties?.value?.value && this.states.BoilerSerial !== boilerSerialFeature.properties.value.value) {
      this.states.BoilerSerial = boilerSerialFeature.properties.value.value;
      
      // Update accessory information with actual boiler serial
      this.informationService.setCharacteristic(
        this.platform.Characteristic.SerialNumber, 
        this.states.BoilerSerial
      );
      
      this.platform.log.debug(`Boiler serial number updated: ${this.states.BoilerSerial}`);
    }

    // Update burner efficiency air quality sensor
    if (this.burnerStatisticsService && (this.states.BurnerHours > 0 || this.states.BurnerStarts > 0)) {
      const startsPerHour = this.states.BurnerHours > 0 ? this.states.BurnerStarts / this.states.BurnerHours : 0;
      
      let airQuality;
      let qualityText;
      
      if (startsPerHour < 1) {
        airQuality = this.platform.Characteristic.AirQuality.EXCELLENT;
        qualityText = 'EXCELLENT';
      } else if (startsPerHour < 2) {
        airQuality = this.platform.Characteristic.AirQuality.GOOD;
        qualityText = 'GOOD';
      } else if (startsPerHour < 3) {
        airQuality = this.platform.Characteristic.AirQuality.FAIR; 
        qualityText = 'FAIR';
      } else if (startsPerHour < 5) {
        airQuality = this.platform.Characteristic.AirQuality.INFERIOR;
        qualityText = 'POOR';
      } else {
        airQuality = this.platform.Characteristic.AirQuality.POOR;
        qualityText = 'VERY POOR';
      }
      
      this.burnerStatisticsService.updateCharacteristic(this.platform.Characteristic.AirQuality, airQuality);
      
      // Update PM2.5 density (efficiency score)
      const efficiencyScore = Math.min(100, Math.max(0, startsPerHour * 20));
      this.burnerStatisticsService.updateCharacteristic(this.platform.Characteristic.PM2_5Density, Math.round(efficiencyScore));
      
      this.platform.log.debug(`Burner efficiency: ${startsPerHour.toFixed(2)} starts/hour = ${qualityText} (${efficiencyScore}/100)`);
    }

    // Update temperature range humidity sensor
    if (this.temperatureRangeService) {
      const current = this.states.CurrentTemperature;
      const target = this.states.HeatingThresholdTemperature;
      const min = this.temperatureConstraints.min;
      
      let progress = 0;
      if (target > min && current >= min) {
        if (current >= target) {
          progress = 100;
        } else {
          progress = ((current - min) / (target - min)) * 100;
        }
      }
      
      this.temperatureRangeService.updateCharacteristic(
        this.platform.Characteristic.CurrentRelativeHumidity,
        Math.min(100, Math.max(0, Math.round(progress)))
      );
      
      this.platform.log.debug(`Temperature progress: ${current}°C/${target}°C = ${progress.toFixed(1)}%`);
    }

    // Enhanced status logging with diagnostic info
    const diagnosticInfo = [];
    if (this.states.OutsideTemperature !== 0) {
      diagnosticInfo.push(`Outside: ${this.states.OutsideTemperature}°C`);
    }
    if (this.states.GasConsumptionToday > 0) {
      diagnosticInfo.push(`Gas: ${this.states.GasConsumptionToday}m³`);
    }
    if (this.states.PowerConsumptionToday > 0) {
      diagnosticInfo.push(`Power: ${this.states.PowerConsumptionToday}kWh`);
    }
    if (this.states.WaterPressure > 0) {
      const pressureStatus = this.states.WaterPressure >= 1.0 && this.states.WaterPressure <= 2.5 ? 'OK' : 'WARN';
      diagnosticInfo.push(`Pressure: ${this.states.WaterPressure}bar(${pressureStatus})`);
    }
    if (this.states.BurnerHours > 0) {
      const startsPerHour = (this.states.BurnerStarts / this.states.BurnerHours).toFixed(1);
      const efficiency = parseFloat(startsPerHour) < 2 ? 'Good' : 'Poor';
      diagnosticInfo.push(`Efficiency: ${startsPerHour}starts/h(${efficiency})`);
    }

    const diagnosticStr = diagnosticInfo.length > 0 ? `, ${diagnosticInfo.join(', ')}` : '';
    
    this.platform.log.debug(`Boiler Status - Temp: ${this.states.CurrentTemperature}°C → ${this.states.HeatingThresholdTemperature}°C, Burner: ${this.states.BurnerActive ? 'ON' : 'OFF'}, Modulation: ${this.states.Modulation}%${diagnosticStr}`);
  }

  // 🆕 NEW: Public method to get diagnostic summary for platform health reports
  public getDiagnosticSummary(): {
    burnerHours: number;
    burnerStarts: number;
    startsPerHour: number;
    efficiency: 'Good' | 'Poor' | 'Unknown';
    gasConsumptionToday: number;
    gasConsumptionThisYear: number;
    powerConsumptionToday: number;
    powerConsumptionThisYear: number;
    outsideTemperature: number;
    waterPressure: number;
    boilerSerial: string;
  } {
    const startsPerHour = this.states.BurnerHours > 0 ? this.states.BurnerStarts / this.states.BurnerHours : 0;
    let efficiency: 'Good' | 'Poor' | 'Unknown' = 'Unknown';
    
    if (this.states.BurnerHours > 0) {
      efficiency = startsPerHour < 2 ? 'Good' : 'Poor';
    }

    return {
      burnerHours: this.states.BurnerHours,
      burnerStarts: this.states.BurnerStarts,
      startsPerHour,
      efficiency,
      gasConsumptionToday: this.states.GasConsumptionToday,
      gasConsumptionThisYear: this.states.GasConsumptionThisYear,
      powerConsumptionToday: this.states.PowerConsumptionToday,
      powerConsumptionThisYear: this.states.PowerConsumptionThisYear,
      outsideTemperature: this.states.OutsideTemperature,
      waterPressure: this.states.WaterPressure,
      boilerSerial: this.states.BoilerSerial,
    };
  }
}