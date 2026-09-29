import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { ViessmannHistoryLogger } from './history-logger';

// Boiler alarm: safe range for the heating-system water pressure (bar)
const ALARM_PRESSURE_MIN = 0.8;
const ALARM_PRESSURE_MAX = 3.0;
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
  private alarmService?: Service;
  private activeFaults: string[] = [];
  private malfunctionLock = false;   // device.lock.malfunction: boiler locked out after a fault
  private evePressureService?: Service;
  
  private supportsTemperatureControl = false;
  private historyLogger?: ViessmannHistoryLogger;
  private temperatureConstraints = { min: 10, max: 80 };
  private currentBurnerState = false;
  private currentModulation = 0;

  // 🆕 Command confirmation state
  private pendingTempUntil = 0;
  private pendingExpectedTemp: number | undefined = undefined;
  private pendingPreviousTemp: number | undefined = undefined;

  // Daily delta tracking for burner starts/hours — reference values reset at midnight
  private dailyRef = {
    date: '',          // 'YYYY-MM-DD' of the reference — reset when date changes
    startsRef: 0,      // BurnerStarts value at midnight
    hoursRef: 0,       // BurnerHours value at midnight
  };

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
    OutsideHumidity: undefined as number | undefined,
    GasConsumptionToday: 0,
    GasConsumptionThisMonth: 0,
    GasConsumptionThisYear: 0,
    GasConsumptionDhwToday: 0,    // heating.gas.consumption.summary.dhw.currentDay
    GasConsumptionDhwThisMonth: 0,
    HeatProductionHeatingToday: 0,   // heating.heat.production.summary.heating.currentDay (kWh)
    HeatProductionHeatingThisMonth: 0,
    HeatProductionDhwToday: 0,       // heating.heat.production.summary.dhw.currentDay (kWh)
    HeatProductionDhwThisMonth: 0,
    PowerConsumptionToday: 0,
    PowerConsumptionThisMonth: 0,
    PowerConsumptionThisYear: 0,
    BoilerSerial: '',
    BoilerEfficiency: 0, // Calculated based on consumption and temperature
    WaterPressure: 0, // Current water pressure in bar
  };

  // 📊 Extended metrics written to MySQL history only (2.0.75). undefined = feature not available.
  private extMetrics: {
    waterPressure?: number;
    gasHeatingYear?: number;
    gasDhwYear?: number;
    heatHeatingYear?: number;
    heatDhwYear?: number;
    powerHeatingDay?: number;
    powerDhwDay?: number;
    powerHeatingMonth?: number;
    powerDhwMonth?: number;
    powerHeatingYear?: number;
    powerDhwYear?: number;
    statusCode?: string;
    wifiRssi?: number;
  } = {};

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

    // Initialize history logger (FakeGato + CSV)
    this.historyLogger = new ViessmannHistoryLogger(platform, accessory, 'energy', 'Boiler', installation?.id, gateway?.serial);

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
      this.updateAlarm(features);
      
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

    // A read-only "light bulb" shows up among the home's lights and in Siri/scene lights:
    // only created when the user explicitly keeps the legacy diagnostic services.
    if (!this.legacyDiagnostics()) {
      this.modulationService = undefined;
      return;
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

    // Services 2–7 reuse HomeKit sensor types with a different meaning (occupancy = gas used today,
    // air quality = starts per hour, humidity = temperature progress, leak = pressure …). Apple Home
    // mixes them into the whole-home summaries ("Air quality: poor", "Humidity 100%") and a leak
    // sensor raises critical alerts, so they are opt-in since 2.0.80 (features.enableLegacyDiagnosticSensors).
    const legacy = this.legacyDiagnostics();

    // 2. Gas Consumption (using Occupancy Sensor)
    if (legacy && this.hasGasConsumption()) {
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
    if (legacy && this.hasPowerConsumption()) {
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
    if (legacy && (this.states.BurnerHours > 0 || this.states.BurnerStarts > 0)) {
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
    if (legacy) {
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
    }

    // 6. System Temperature Range (using Humidity Sensor)
    if (legacy && this.states.CurrentTemperature > 0 && this.states.HeatingThresholdTemperature > 0) {
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
    if (legacy && this.hasWaterPressure()) {
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

    // 8. Boiler alarm (faults / pressure) — a real alert, replaces the leak-sensor trick
    this.setupAlarmService(installationName, boilerName, subtypeVersion);

    // 9. Water pressure for the Eve app (Apple Home has no pressure sensor type)
    this.setupEvePressureService(installationName, boilerName);
  }

  /**
   * Heating-system water pressure as an Eve "Air Pressure" value. Eve shows it in hPa (mbar):
   * 1200 hPa = 1.2 bar. Apple Home does not show it (no native pressure type), Eve does and can use
   * it in its automations. Disable with features.exposeWaterPressureEve = false.
   */
  private setupEvePressureService(installationName: string, boilerName: string) {
    const old = this.accessory.services.find(x => x.subtype === 'boiler-pressure-eve');
    if ((this.platform.config as any).features?.exposeWaterPressureEve === false || !this.hasWaterPressure()) {
      if (old) this.accessory.removeService(old);
      return;
    }
    const hap = this.platform.api.hap;
    const EVE_SERVICE = 'E863F001-079E-48FF-8F27-9C2605A29F52';
    const EVE_AIR_PRESSURE = 'E863F10F-079E-48FF-8F27-9C2605A29F52';
    const name = `${installationName} ${boilerName} ${(this.platform.config as any).customNames?.waterPressure || 'Pressione impianto'}`;
    const svc = old || this.accessory.addService(new hap.Service(name, EVE_SERVICE, 'boiler-pressure-eve'));
    svc.setCharacteristic(this.platform.Characteristic.Name, name);
    let ch = svc.characteristics.find(c => c.UUID === EVE_AIR_PRESSURE);
    if (!ch) {
      ch = new hap.Characteristic('Air Pressure', EVE_AIR_PRESSURE, {
        format: hap.Formats.UINT16, unit: 'hPa' as any, minValue: 0, maxValue: 6000, minStep: 1,
        perms: [hap.Perms.PAIRED_READ, hap.Perms.NOTIFY],
      });
      svc.addCharacteristic(ch);
    }
    ch.onGet(() => this.pressureHpa());
    this.evePressureService = svc;
    this.platform.log.info(`✅ Water pressure for the Eve app: ${name} (hPa: 1200 hPa = 1.2 bar)`);
  }

  private pressureHpa(): number {
    return Math.max(0, Math.round((Number(this.states.WaterPressure) || 0) * 1000));
  }

  private refreshEvePressure() {
    const ch = this.evePressureService?.characteristics.find(c => c.UUID === 'E863F10F-079E-48FF-8F27-9C2605A29F52');
    ch?.updateValue(this.pressureHpa());
  }

  /** true when the user keeps the pre-2.0.80 "creative" diagnostic services. */
  private legacyDiagnostics(): boolean {
    return (this.platform.config as any).features?.enableLegacyDiagnosticSensors === true;
  }

  /**
   * Boiler alarm: a contact sensor that OPENS when the boiler reports a fault code (F.xx),
   * is locked out after a fault (device.lock.malfunction) or the water pressure is outside the safe range. Apple Home can notify on it and
   * it can trigger automations. Enabled by default (features.enableBoilerAlarm).
   */
  private setupAlarmService(installationName: string, boilerName: string, subtypeVersion: string) {
    if ((this.platform.config as any).features?.enableBoilerAlarm === false) return;
    const label = (this.platform.config as any).customNames?.boilerAlarm || 'Alarm';
    const name = `${installationName} ${boilerName} ${label}`;
    this.alarmService = this.accessory.addService(this.platform.Service.ContactSensor, name, `boiler-alarm-${subtypeVersion}`);
    this.alarmService.setCharacteristic(this.platform.Characteristic.Name, name);
    this.alarmService.displayName = name;
    this.alarmService.getCharacteristic(this.platform.Characteristic.ContactSensorState)
      .onGet(() => this.alarmState());
    this.platform.log.info(`✅ Boiler alarm sensor created: ${name} (opens on F.xx faults, boiler lock-out or water pressure outside ${ALARM_PRESSURE_MIN}–${ALARM_PRESSURE_MAX} bar)`);
  }

  private alarmState(): number {
    const C = this.platform.Characteristic.ContactSensorState;
    const p = this.states.WaterPressure;
    const pressureBad = p > 0 && (p < ALARM_PRESSURE_MIN || p > ALARM_PRESSURE_MAX);
    return (this.activeFaults.length > 0 || this.malfunctionLock || pressureBad) ? C.CONTACT_NOT_DETECTED : C.CONTACT_DETECTED;
  }

  /** Reads the active fault codes (F.xx …) from device.messages.errors.raw and updates the alarm sensor. */
  private updateAlarm(features: any[]) {
    const f = features.find((x: any) => x.feature === 'device.messages.errors.raw');
    const entries = f?.properties?.entries?.value;
    if (Array.isArray(entries)) {
      const codes = entries.map((e: any) => String(e?.errorCode || e?.code || '')).filter((c: string) => c.length > 0);
      const key = codes.join(',');
      if (key !== this.activeFaults.join(',')) {
        if (codes.length) this.platform.log.warn(`⚠️ Boiler fault code(s) active: ${key}`);
        else if (this.activeFaults.length) this.platform.log.info('✅ Boiler fault codes cleared');
        this.activeFaults = codes;
      }
    }
    const lock = features.find((x: any) => x.feature === 'device.lock.malfunction')?.properties?.active?.value;
    if (typeof lock === 'boolean' && lock !== this.malfunctionLock) {
      if (lock) this.platform.log.warn('⚠️ Boiler locked out (device.lock.malfunction): reset it on the boiler, or call the installer if it happens again');
      else if (this.malfunctionLock) this.platform.log.info('✅ Boiler lock-out cleared');
      this.malfunctionLock = lock;
    }
    const state = this.alarmState();
    this.alarmService?.updateCharacteristic(this.platform.Characteristic.ContactSensorState, state);
    const open = state === this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
    if (this.alarmWasOpen !== undefined && open !== this.alarmWasOpen) this.notifyAlarm(open);
    this.alarmWasOpen = open;
  }

  /**
   * Optional push message when the alarm opens or clears (features.alarmNotifyUrl).
   * URL with "{text}" → HTTP GET with the message URL-encoded in its place
   *   (e.g. Telegram: https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<ID>&text={text},
   *    ntfy: https://ntfy.sh/<topic>?message={text}).
   * URL without "{text}" → HTTP POST with a JSON body {title, text, faults, pressure, open}.
   */
  private alarmWasOpen?: boolean;
  private notifyAlarm(open: boolean) {
    const url: string | undefined = (this.platform.config as any).features?.alarmNotifyUrl;
    if (!url || typeof fetch !== 'function') return;
    const who = this.installation.description || 'Viessmann';
    const p = this.states.WaterPressure;
    const why = [this.activeFaults.length ? `fault ${this.activeFaults.join(', ')}` : '',
      this.malfunctionLock ? 'boiler locked out (reset needed)' : '',
      p > 0 && (p < ALARM_PRESSURE_MIN || p > ALARM_PRESSURE_MAX) ? `water pressure ${p} bar` : ''].filter(Boolean).join(', ');
    const text = open ? `⚠️ ${who}: boiler alarm — ${why || 'check the boiler'}` : `✅ ${who}: boiler alarm cleared`;
    const req = url.includes('{text}')
      ? fetch(url.replace('{text}', encodeURIComponent(text)))
      : fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Viessmann', text, faults: this.activeFaults, lockout: this.malfunctionLock, pressure: p, open }) });
    req.then(r => this.platform.log.info(`📣 Alarm notification sent (HTTP ${r.status})`))
      .catch(e => this.platform.log.warn(`Alarm notification failed: ${e?.message || e}`));
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
      { service: this.alarmService, subtype: 'boiler-alarm' },
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
    this.alarmService = undefined;
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

        // 🛡️ Guard: block regular update cycle from overwriting temp until API confirms
        const guardMs = this.platform.config.postCommandRetry?.guardDuration ?? 120000;
        this.pendingTempUntil = Date.now() + guardMs;
        this.pendingExpectedTemp = temperature;
        this.pendingPreviousTemp = this.states.HeatingThresholdTemperature;

        // 🆕 NEW: Schedule full state refresh from API to confirm command was accepted
        this.scheduleCommandConfirmation(temperature);
      } else {
        this.platform.log.error(`Failed to set boiler target temperature to: ${temperature}°C`);
        throw new Error('Failed to set boiler target temperature');
      }
    } catch (error) {
      this.platform.log.error('Error setting boiler target temperature:', error);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  // 🆕 Progressive command confirmation with retry.
  private scheduleCommandConfirmation(expectedTemp?: number, attemptIndex = 0): void {
    const delays = this.platform.config.postCommandRetry?.delays ?? [5000, 15000, 30000, 60000];
    if (attemptIndex >= delays.length) {
      this.platform.log.warn(`⚠️ Boiler command confirmation exhausted after ${delays.length} attempts — regular cycle will take over`);
      return;
    }

    const delayMs = delays[attemptIndex];
    setTimeout(async () => {
      try {
        this.platform.log.debug(`🔄 Boiler confirmation attempt ${attemptIndex + 1}/${delays.length} (after ${delayMs}ms)...`);
        this.platform.viessmannAPI.clearCache(`/features/installations/${this.installation.id}`);
        const features = await this.platform.viessmannAPI.getDeviceFeatures(
          this.installation.id,
          this.gateway.serial,
          this.device.id
        );

        if (expectedTemp !== undefined) {
          const targetFeature = features.find((f: any) => f.feature === 'heating.boiler.temperature');
          const apiTemp = targetFeature?.properties?.value?.value;
          if (apiTemp === expectedTemp) {
            this.platform.log.debug(`✅ Boiler temp confirmed by API: ${apiTemp}°C`);
            this.pendingTempUntil = 0;
            this.pendingExpectedTemp = undefined;
            this.pendingPreviousTemp = undefined;
            await this.updateFromFeatures(features);
            this.updateAlarm(features);
            return;
          } else if (apiTemp !== undefined && apiTemp !== this.pendingPreviousTemp) {
            this.platform.log.info(`🔀 Boiler external temp change detected: API=${apiTemp}°C (expected ${expectedTemp}°C) — applying external change`);
            this.pendingTempUntil = 0;
            this.pendingExpectedTemp = undefined;
            this.pendingPreviousTemp = undefined;
            await this.updateFromFeatures(features);
            this.updateAlarm(features);
            return;
          } else {
            const guardMs = this.platform.config.postCommandRetry?.guardDuration ?? 120000;
            this.pendingTempUntil = Date.now() + guardMs;
            this.platform.log.debug(`⏳ Boiler temp not yet propagated (API=${apiTemp}°C, expected ${expectedTemp}°C) — retry ${attemptIndex + 2}/${delays.length}`);
            this.scheduleCommandConfirmation(expectedTemp, attemptIndex + 1);
          }
        }
      } catch (error) {
        this.platform.log.warn(`⚠️ Boiler confirmation attempt ${attemptIndex + 1} failed:`, error instanceof Error ? error.message : error);
        this.scheduleCommandConfirmation(expectedTemp, attemptIndex + 1);
      }
    }, delayMs);
  }

  private async handleUpdate(features: any[]) {
    const t0 = Date.now();
    try {
      await this.updateFromFeatures(features);
      this.updateAlarm(features);
      this.platform.log.debug(`🔥 Caldaia handleUpdate OK in ${Date.now() - t0}ms`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.platform.log.error(`❌ Caldaia handleUpdate failed after ${Date.now() - t0}ms: ${msg}`);
      this.platform.log.error(`   State at failure: burner=${this.states.BurnerActive}, temp=${this.states.CurrentTemperature}°C, mod=${this.states.Modulation}%`);
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
      if (Date.now() < this.pendingTempUntil) {
        if (targetTemp !== this.pendingPreviousTemp && targetTemp !== this.pendingExpectedTemp) {
          this.platform.log.info(`🔀 Boiler external temp change while guard active: API=${targetTemp}°C — applying and resetting guard`);
          this.pendingTempUntil = 0;
          this.pendingExpectedTemp = undefined;
          this.pendingPreviousTemp = undefined;
          this.states.HeatingThresholdTemperature = targetTemp;
          this.heaterCoolerService.updateCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature, targetTemp);
        } else {
          this.platform.log.debug(`🔥 Caldaia temp: API returned ${targetTemp}°C but command guard active — keeping ${this.states.HeatingThresholdTemperature}°C`);
        }
      } else if (targetTemp >= this.temperatureConstraints.min && targetTemp <= this.temperatureConstraints.max) {
        this.states.HeatingThresholdTemperature = targetTemp;
        this.heaterCoolerService.updateCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature, targetTemp);
      }
    }

    // Update burner statistics FIRST — so the event row written on state change has current values
    const statisticsFeature = features.find(f => f.feature === 'heating.burners.0.statistics');
    if (statisticsFeature?.properties?.hours?.value !== undefined) {
      this.states.BurnerHours = statisticsFeature.properties.hours.value;
    }
    if (statisticsFeature?.properties?.starts?.value !== undefined) {
      this.states.BurnerStarts = statisticsFeature.properties.starts.value;
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

        // 📊 Write immediate event row to CSV — captures on/off transitions
        // that would otherwise be invisible at 15-min snapshot granularity
        if (this.historyLogger) {
          const startsToday = this.states.BurnerStarts - this.dailyRef.startsRef;
          const hoursToday  = this.states.BurnerHours  - this.dailyRef.hoursRef;
          this.historyLogger.appendRow({
            timestamp:            new Date().toISOString(),
            accessory:            'boiler',
            event_type:           newBurnerState ? 'burner_on' : 'burner_off',
            burner_active:        newBurnerState,
            modulation:           this.states.Modulation,
            outside_temp:         this.hasOutsideFeature ? this.states.OutsideTemperature : undefined,
            boiler_water_temp:    this.states.CurrentTemperature,
            burner_starts:        this.states.BurnerStarts,
            burner_hours:         this.states.BurnerHours,
            burner_starts_today:  startsToday >= 0 ? startsToday : undefined,
            burner_hours_today:   hoursToday  >= 0 ? hoursToday  : undefined,
          });
        }
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

    // Update outside humidity (optional — not all installations have this sensor)
    const outsideHumidityFeature = features.find(f => f.feature === 'heating.sensors.humidity.outside');
    if (outsideHumidityFeature?.properties?.value?.value !== undefined) {
      this.states.OutsideHumidity = outsideHumidityFeature.properties.value.value;
      this.platform.log.debug(`Outside humidity: ${this.states.OutsideHumidity}%`);
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

    // Update DHW gas consumption
    const gasDhwFeature = features.find(f => f.feature === 'heating.gas.consumption.summary.dhw');
    if (gasDhwFeature?.properties?.currentDay?.value !== undefined) {
      this.states.GasConsumptionDhwToday = gasDhwFeature.properties.currentDay.value;
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

    // Update heat production (heating) — available on Vitodens gen3 and heat pumps
    const heatHeatingFeature = features.find(f => f.feature === 'heating.heat.production.summary.heating');
    if (heatHeatingFeature?.properties) {
      if (heatHeatingFeature.properties.currentDay?.value !== undefined) {
        this.states.HeatProductionHeatingToday = heatHeatingFeature.properties.currentDay.value;
      }
      if (heatHeatingFeature.properties.currentMonth?.value !== undefined) {
        this.states.HeatProductionHeatingThisMonth = heatHeatingFeature.properties.currentMonth.value;
      }
    }

    // Update heat production (DHW)
    const heatDhwFeature = features.find(f => f.feature === 'heating.heat.production.summary.dhw');
    if (heatDhwFeature?.properties) {
      if (heatDhwFeature.properties.currentDay?.value !== undefined) {
        this.states.HeatProductionDhwToday = heatDhwFeature.properties.currentDay.value;
      }
      if (heatDhwFeature.properties.currentMonth?.value !== undefined) {
        this.states.HeatProductionDhwThisMonth = heatDhwFeature.properties.currentMonth.value;
      }
    }

    // Update DHW gas consumption monthly figure
    if (gasDhwFeature?.properties?.currentMonth?.value !== undefined) {
      this.states.GasConsumptionDhwThisMonth = gasDhwFeature.properties.currentMonth.value;
    }

    // 📊 Extended metrics for MySQL history (2.0.75)
    this.collectExtendedMetrics(features);

    // Update daily delta for burner starts/hours (reset reference at midnight)
    // Local calendar day (was UTC → reset happened at 01:00/02:00 local time in Europe)
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    if (this.dailyRef.date !== todayStr) {
      // New day — set reference to current cumulative values
      this.dailyRef.date     = todayStr;
      this.dailyRef.startsRef = this.states.BurnerStarts;
      this.dailyRef.hoursRef  = this.states.BurnerHours;
      this.platform.log.debug(`Boiler daily reference reset: starts=${this.dailyRef.startsRef} hours=${this.dailyRef.hoursRef}`);
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
        this.refreshEvePressure();
        
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

    const diagnosticStr = diagnosticInfo.length > 0 ? ` | ${diagnosticInfo.join(' | ')}` : '';
    // Log sempre a debug; se il bruciatore è attivo logga anche a info per visibilità
    const statusLine = `🔥 Caldaia — burner=${this.states.BurnerActive ? 'ON 🔥' : 'OFF'} | mod=${this.states.Modulation}% | temp=${this.states.CurrentTemperature}°C→${this.states.HeatingThresholdTemperature}°C${diagnosticStr}`;
    if (this.states.BurnerActive) {
      this.platform.log.info(statusLine);
    } else {
      this.platform.log.debug(statusLine);
    }

    // 📊 History logging — FakeGato energy + CSV snapshot
    if (this.historyLogger) {
      this.historyLogger.addEnergyEntry({ power: this.states.Modulation });
      const startsToday = this.states.BurnerStarts - this.dailyRef.startsRef;
      const hoursToday  = this.states.BurnerHours  - this.dailyRef.hoursRef;
      // NOTE: a real 0 (e.g. no gas used today, 0°C outside) is stored as 0.
      // Before 2.0.75 `value || undefined` turned every 0 into NULL/empty.
      // Features the device does not expose stay NULL.
      const g = this.hasGasFeature;
      const x = this.extMetrics;
      this.historyLogger.appendRow({
        timestamp:                  new Date().toISOString(),
        accessory:                  'boiler',
        event_type:                 'snapshot',
        burner_active:              this.states.BurnerActive,
        modulation:                 this.states.Modulation,
        outside_temp:               this.hasOutsideFeature ? this.states.OutsideTemperature : undefined,
        outside_humidity:           this.states.OutsideHumidity,
        burner_starts:              this.states.BurnerStarts,
        burner_hours:               this.states.BurnerHours,
        burner_starts_today:        startsToday >= 0 ? startsToday : undefined,
        burner_hours_today:         hoursToday  >= 0 ? hoursToday  : undefined,
        gas_heating_day_m3:         g ? this.states.GasConsumptionToday : undefined,
        gas_dhw_day_m3:             g ? this.states.GasConsumptionDhwToday : undefined,
        gas_heating_month_m3:       g ? this.states.GasConsumptionThisMonth : undefined,
        gas_dhw_month_m3:           g ? this.states.GasConsumptionDhwThisMonth : undefined,
        heat_heating_day_kwh:       this.hasHeatProduction ? this.states.HeatProductionHeatingToday : undefined,
        heat_dhw_day_kwh:           this.hasHeatProduction ? this.states.HeatProductionDhwToday : undefined,
        heat_heating_month_kwh:     this.hasHeatProduction ? this.states.HeatProductionHeatingThisMonth : undefined,
        heat_dhw_month_kwh:         this.hasHeatProduction ? this.states.HeatProductionDhwThisMonth : undefined,
        boiler_water_temp:          this.states.CurrentTemperature,
        // Extended (MySQL only)
        water_pressure_bar:         x.waterPressure,
        gas_heating_year_m3:        x.gasHeatingYear,
        gas_dhw_year_m3:            x.gasDhwYear,
        heat_heating_year_kwh:      x.heatHeatingYear,
        heat_dhw_year_kwh:          x.heatDhwYear,
        power_heating_day_kwh:      x.powerHeatingDay,
        power_dhw_day_kwh:          x.powerDhwDay,
        power_heating_month_kwh:    x.powerHeatingMonth,
        power_dhw_month_kwh:        x.powerDhwMonth,
        power_heating_year_kwh:     x.powerHeatingYear,
        power_dhw_year_kwh:         x.powerDhwYear,
        status_code:                x.statusCode,
        wifi_rssi:                  x.wifiRssi,
      });
    }
  }

  /** True once a heat production summary feature has been seen (Vitodens gen3 / heat pumps). */
  private hasHeatProduction = false;
  /** Feature-presence flags (a value of 0 is valid and must not mean "absent"). */
  private hasGasFeature = false;
  private hasOutsideFeature = false;

  /**
   * 📊 Collect extended metrics for MySQL history (2.0.75).
   * Values stay undefined when the feature is not exposed by the device,
   * so the DB gets NULL (unknown) instead of a misleading 0.
   */
  private collectExtendedMetrics(features: any[]): void {
    const feat = (name: string) => features.find(f => f.feature === name && f.isEnabled !== false);
    const num = (v: any): number | undefined => (typeof v === 'number' && Number.isFinite(v)) ? v : undefined;
    const x = this.extMetrics;

    const pressure = feat('heating.sensors.pressure.supply') ||
      feat('heating.boiler.sensors.pressure.supply') ||
      feat('heating.circuits.0.sensors.pressure.supply');
    x.waterPressure = num(pressure?.properties?.value?.value);

    this.hasOutsideFeature = !!feat('heating.sensors.temperature.outside');

    const gasH = feat('heating.gas.consumption.summary.heating')?.properties;
    const gasD = feat('heating.gas.consumption.summary.dhw')?.properties;
    this.hasGasFeature = !!(gasH || gasD);
    x.gasHeatingYear = num(gasH?.currentYear?.value);
    x.gasDhwYear     = num(gasD?.currentYear?.value);
    if (gasD?.currentMonth?.value !== undefined) {
      this.states.GasConsumptionDhwThisMonth = gasD.currentMonth.value;
    }

    const heatH = feat('heating.heat.production.summary.heating')?.properties;
    const heatD = feat('heating.heat.production.summary.dhw')?.properties;
    this.hasHeatProduction = !!(heatH || heatD);
    x.heatHeatingYear = num(heatH?.currentYear?.value);
    x.heatDhwYear     = num(heatD?.currentYear?.value);

    const powH = feat('heating.power.consumption.summary.heating')?.properties;
    const powD = feat('heating.power.consumption.summary.dhw')?.properties;
    x.powerHeatingDay   = num(powH?.currentDay?.value);
    x.powerDhwDay       = num(powD?.currentDay?.value);
    x.powerHeatingMonth = num(powH?.currentMonth?.value);
    x.powerDhwMonth     = num(powD?.currentMonth?.value);
    x.powerHeatingYear  = num(powH?.currentYear?.value);
    x.powerDhwYear      = num(powD?.currentYear?.value);

    // Latest status/error code (e.g. S.6 = ignition, F.xx = fault)
    const statusEntries = feat('device.messages.status.raw')?.properties?.entries?.value;
    const errorEntries = feat('device.messages.errors.raw')?.properties?.entries?.value;
    const latest = (arr: any): string | undefined => {
      if (!Array.isArray(arr) || !arr.length) return undefined;
      const sorted = [...arr].sort((a, b) => String(b.timestamp ?? '').localeCompare(String(a.timestamp ?? '')));
      return sorted[0]?.errorCode ? String(sorted[0].errorCode) : undefined;
    };
    x.statusCode = latest(errorEntries) ?? latest(statusEntries);

    x.wifiRssi = num(feat('tcu.wifi')?.properties?.strength?.value);
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