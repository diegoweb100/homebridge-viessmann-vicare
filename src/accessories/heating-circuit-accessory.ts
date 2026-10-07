import { PLUGIN_NAME } from '../settings';
import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { ViessmannHistoryLogger } from './history-logger';
import { ViessmannPlatform, ViessmannInstallation, ViessmannGateway, ViessmannDevice, ViessmannPlatformConfig } from '../platform';

type HeatingPlan = 'off' | 'normal' | 'comfort' | 'extended' | 'holiday' | 'holidayAtHome';
type ProgramType = 'reduced' | 'normal' | 'comfort';

export class ViessmannHeatingCircuitAccessory {
  private heaterCoolerService: Service;
  private informationService: Service;
  
  // Quick Selection Services
  private holidayService?: Service;
  private holidayAtHomeService?: Service;
  private extendedHeatingService?: Service;
  
  // Temperature Program Services (NEW)
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
  // Resolved comfort program feature suffix: 'comfort' (Vitodens) or 'comfortHeating' (Vitocal gen3)
  private comfortFeatureSuffix = 'comfort';


  // 🆕 Command confirmation state
  private pendingModeUntil = 0;
  private pendingProgramUntil = 0;
  private pendingTempUntil = 0;
  private pendingExpectedMode: string | undefined = undefined;
  private pendingPreviousMode: string | undefined = undefined;
  private pendingExpectedProgram: string | undefined = undefined;
  private pendingPreviousProgram: string | undefined = undefined;
  private pendingExpectedTemp: number | undefined = undefined;
  private pendingPreviousTemp: number | undefined = undefined;

  // 🛡️ HAP feedback loop guard — see DHW accessory for explanation
  private _updatingCharacteristics = false;

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
    // Flow temperature (heating.circuits.N.sensors.temperature.supply)
    FlowTemperature: undefined as number | undefined,
  };

  // Store temperatures for each program
  private programTemperatures = {
    reduced: 16,
    normal: 18,
    comfort: 19,
  };

  private historyLogger?: ViessmannHistoryLogger;
  private curveSlope?: number;
  private curveShift?: number;

  // 🗓️ Schedule-aware refresh
  private heatingSchedule: Record<string, Array<{mode: string; start: string; end: string}>> = {};
  private scheduleRefreshTimer: ReturnType<typeof setTimeout> | null = null;

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

    // Initialize history logger (FakeGato + CSV)
    this.historyLogger = new ViessmannHistoryLogger(platform, accessory, 'thermo', `HC${circuitNumber}`, installation?.id, gateway?.serial);

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
          const endStr = String(selectionFeature.properties?.end?.value || '');
          const nowD = new Date();
          const todayStr = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, '0')}-${String(nowD.getDate()).padStart(2, '0')}`;
          const isActive = selectionFeature.properties.active.value === true
            || (/^\d{4}-\d{2}-\d{2}/.test(endStr) && endStr.slice(0, 10) >= todayStr);   // scheduled counts as ON
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
    // Feature name varies by device model:
    //   Vitodens (gen2):  programs.comfort
    //   Vitocal (gen3):   programs.comfortHeating
    //   Future devices:   unknown
    // Strategy: discover from actual features — find any enabled programs.* that has an
    // 'activate' command, excluding known non-comfort program names.
    const NON_COMFORT_PROGRAMS = new Set([
      'normal', 'normalHeating', 'normalEnergySaving',
      'reduced', 'reducedHeating', 'reducedEnergySaving',
      'standby', 'fixed', 'frostprotection', 'summerEco',
      'holidayAtHome', 'holiday', 'forcedLastFromSchedule',
      'normalCooling', 'reducedCooling', 'comfortCooling',
      'normalCoolingEnergySaving', 'reducedCoolingEnergySaving', 'comfortCoolingEnergySaving',
      'comfortEnergySaving', // cooling-only variant, not heating comfort
    ]);
    const programsPrefix = `${circuitPrefix}.operating.programs.`;
    const discoveredComfort = features.find(f =>
      f.feature.startsWith(programsPrefix) &&
      f.isEnabled === true &&
      f.commands?.activate !== undefined &&
      !NON_COMFORT_PROGRAMS.has(f.feature.slice(programsPrefix.length)),
    );
    if (discoveredComfort) {
      const suffix = discoveredComfort.feature.slice(programsPrefix.length);
      this.comfortFeatureSuffix = suffix;
      this.platform.log.debug(`HC${this.circuitNumber} comfort feature discovered: programs.${suffix}`);
    } else {
      this.platform.log.debug(`HC${this.circuitNumber} no comfort program with activate command found`);
    }
    const comfortProgram = features.find(f => f.feature === `${circuitPrefix}.operating.programs.${this.comfortFeatureSuffix}`);
    if (comfortProgram?.isEnabled === true) {
      const hasActivate = comfortProgram.commands?.activate;
      const hasDeactivate = comfortProgram.commands?.deactivate;
      const hasSetTemperature = comfortProgram.commands?.setTemperature;
      
      // Extended heating: forcedLastFromSchedule (Vitodens) or comfort activate/deactivate
      const forcedProgram = features.find(f => f.feature === `${circuitPrefix}.operating.programs.forcedLastFromSchedule`);
      const hasForcedActivate = forcedProgram?.commands?.activate;
      const hasForcedDeactivate = forcedProgram?.commands?.deactivate;
      
      // Extended heating is available if we have ANY way to control comfort/boost
      const hasAnyMethod = (hasActivate && hasDeactivate) || 
                          hasSetTemperature || 
                          (hasForcedActivate && hasForcedDeactivate);
      
      // Real, separately controllable functions (only these are published to HomeKit)
      this.hasComfortActivate = !!(hasActivate && hasDeactivate);
      this.hasForcedActivate = !!(hasForcedActivate && hasForcedDeactivate);
      if (hasAnyMethod) {
        this.availableQuickSelections.push('extendedHeating');
        // Initial state: OR of all three signals (same logic as update cycle).
        const comfortActive   = comfortProgram.properties?.active?.value || false;
        const forcedActive    = forcedProgram?.properties?.active?.value  || false;
        const activeProg      = features.find(f => f.feature === `${circuitPrefix}.operating.programs.active`);
        const activeIsComfort = activeProg?.properties?.value?.value === this.comfortFeatureSuffix;
        this.states.ExtendedHeatingActive = comfortActive || forcedActive || activeIsComfort;
        this.comfortOn = !!(comfortActive || activeIsComfort);
        this.forcedOn = !!forcedActive;
        this.platform.log.debug(
          `HC${this.circuitNumber} ExtendedHeating initial:` +
          ` comfort=${comfortActive} forced=${forcedActive} active=${activeProg?.properties?.value?.value}` +
          ` → ${this.states.ExtendedHeatingActive}`,
        );
        
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

    // Dial at startup: the temperature of the program really in force (not the last one read)
    {
      const ap = String(features.find(f => f.feature === `${circuitPrefix}.operating.programs.active`)?.properties?.value?.value || '').toLowerCase();
      const hol = features.find(f => f.feature === 'heating.operating.programs.holiday')?.properties?.active?.value;
      const key: ProgramType = hol || ap.startsWith('reduced') ? 'reduced' : ap.startsWith('comfort') ? 'comfort' : 'normal';
      const t = this.programTemperatures[key];
      if (typeof t === 'number' && t > 0) { this.currentProgram = key; this.states.HeatingThresholdTemperature = t; }
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
    this.setupFaultStatus();

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

  /**
   * "Heating" / "Idle" under the tile in Apple Home. HEATING only while the burner is really
   * heating this circuit: burner on, circuit in a heating program (not Off / Holiday / standby),
   * circuit pump running when the boiler reports it, and not busy with a hot-water charge.
   * Otherwise IDLE (the circuit is on, but nothing is being heated right now), or INACTIVE when off.
   */
  private burnerOn = false;
  private circuitPumpOn?: boolean;
  private dhwCharging = false;
  private heaterState(): number {
    const S = this.platform.Characteristic.CurrentHeaterCoolerState;
    const p = this.plan();
    if (p === 'off' || p === 'holiday' || this.currentMode === 'standby') return S.INACTIVE;
    const heating = this.burnerOn && !this.dhwCharging && this.circuitPumpOn !== false;
    return heating ? S.HEATING : S.IDLE;
  }

  /** Reads burner / circuit pump / hot-water charging from the device features. */
  private updateHeatingActivity(features: any[]) {
    const val = (name: string, prop: string) => features.find((f: any) => f.feature === name)?.properties?.[prop]?.value;
    const burner = val('heating.burners.0', 'active') ?? val('heating.burner', 'active');
    if (typeof burner === 'boolean') this.burnerOn = burner;
    const pump = val(`heating.circuits.${this.circuitNumber}.circulation.pump`, 'status');
    this.circuitPumpOn = pump === undefined ? undefined : pump === 'on';
    const charging = val('heating.dhw.charging', 'active');
    this.dhwCharging = charging === true;
    const before = this.lastHeaterState;
    const now = this.heaterState();
    this.lastHeaterState = now;
    this.heaterCoolerService.updateCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState, now);
    if (before !== now) this.refreshLevelThermostats();
    if (before !== undefined && before !== now) {
      const S = this.platform.Characteristic.CurrentHeaterCoolerState;
      const txt = now === S.HEATING ? 'HEATING (burner on for this circuit)' : now === S.IDLE ? 'IDLE (circuit on, burner not heating it)' : 'INACTIVE';
      this.platform.log.info(`🔥 Riscaldamento ${this.circuitNumber}: ${txt}`);
    }
  }
  private lastHeaterState?: number;

  /** StatusFault is not allowed on HeaterCooler by HAP: removes it if a pre-release build added it. */
  private setupFaultStatus() {
    const ch = this.heaterCoolerService.characteristics.find(c => c.UUID === this.platform.Characteristic.StatusFault.UUID);
    if (ch) this.heaterCoolerService.removeCharacteristic(ch);
  }

  private setupHeaterCoolerService() {
    // Active characteristic (On/Off)
    this.heaterCoolerService.getCharacteristic(this.platform.Characteristic.Active)
      .onGet(() => (this.plan() !== 'off' && this.plan() !== 'holiday') ?
        this.platform.Characteristic.Active.ACTIVE :
        this.platform.Characteristic.Active.INACTIVE)
      .onSet(this.setActive.bind(this));

    // Current Heater Cooler State (read-only)
    this.heaterCoolerService.getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
      .onGet(() => {
        return this.heaterState();
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

// ─── Temperature levels (Reduced / Normal / Comfort) ─────────────────────────
  // The boiler's time schedule uses three temperature levels. They cannot be "switched on",
  // only changed (setTemperature), so each one is a thermostat in Home: its dial changes the
  // level. Usable in automations ("cold outside → Normal to 20°").
  private levelServices: Partial<Record<ProgramType, Service>> = {};

  /** Each level is its own accessory (own tile and name in Home), not a service of the circuit. */
  private levelUuid(prog: ProgramType): string {
    return this.platform.api.hap.uuid.generate(`${this.installation.id}-${this.gateway.serial}-${this.device.id}-hc${this.circuitNumber}-level-${prog}`);
  }

  private removeLevelAccessory(prog: ProgramType) {
    const acc = this.platform.accessories.find(a => a.UUID === this.levelUuid(prog));
    if (acc) {
      this.platform.api.unregisterPlatformAccessories(PLUGIN_NAME, 'ViessmannPlatform', [acc]);
      this.platform.accessories.splice(this.platform.accessories.indexOf(acc), 1);
    }
  }

  private addLevelThermostat(prog: ProgramType, name: string) {
    const C = this.platform.Characteristic;
    const S = this.platform.Service;
    const uuid = this.levelUuid(prog);
    let acc = this.platform.accessories.find(a => a.UUID === uuid);
    const isNew = !acc;
    if (!acc) {
      acc = new this.platform.api.platformAccessory(name, uuid);
      this.platform.accessories.push(acc);
    }
    acc.getService(S.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, 'Viessmann')
      .setCharacteristic(C.Model, `Heating circuit ${this.circuitNumber} – ${prog} temperature`)
      .setCharacteristic(C.SerialNumber, `${this.gateway.serial}-hc${this.circuitNumber}-${prog}`);
    const svc = acc.getService(S.Thermostat) || acc.addService(S.Thermostat, name);
    svc.setCharacteristic(C.Name, name);
    const lim = this.temperatureConstraints;
    const temp = () => {
      const t = Number(this.programTemperatures[prog]);
      return Math.min(Math.max(Number.isFinite(t) && t > 0 ? t : 20, lim.min), lim.max);
    };
    // On = the level the boiler uses right now (time schedule); the others are Off. Switching a tile
    // to Heat shows its dial so its temperature can be changed; it returns to the real state
    // two minutes later (a level cannot be forced on — ViCare has no such command).
    const isOn = () => this.levelInForce() === prog || (this.levelEditUntil[prog] ?? 0) > Date.now();
    svc.getCharacteristic(C.CurrentHeatingCoolingState)
      .onGet(() => this.levelInForce() === prog && this.heaterState() === this.platform.Characteristic.CurrentHeaterCoolerState.HEATING ? C.CurrentHeatingCoolingState.HEAT : C.CurrentHeatingCoolingState.OFF);
    const tgt = svc.getCharacteristic(C.TargetHeatingCoolingState);
    tgt.setProps({ validValues: [C.TargetHeatingCoolingState.OFF, C.TargetHeatingCoolingState.HEAT] });
    tgt.onGet(() => isOn() ? C.TargetHeatingCoolingState.HEAT : C.TargetHeatingCoolingState.OFF)
      .onSet((v: CharacteristicValue) => {
        if (v === C.TargetHeatingCoolingState.HEAT && this.levelInForce() !== prog) {
          this.levelEditUntil[prog] = Date.now() + 120000;
          setTimeout(() => this.refreshLevelThermostats(), 121000);
        } else if (v === C.TargetHeatingCoolingState.OFF) {
          this.levelEditUntil[prog] = 0;
          setTimeout(() => this.refreshLevelThermostats(), 300);   // the level in force cannot be switched off
        }
      });
    svc.getCharacteristic(C.CurrentTemperature)
      .setProps({ minValue: 0, maxValue: 100, minStep: 0.5 })
      .onGet(temp);
    svc.getCharacteristic(C.TargetTemperature)
      .setProps({ minValue: lim.min, maxValue: lim.max, minStep: 1 })
      .onGet(temp)
      .onSet(async (v: CharacteristicValue) => this.setLevelTemperature(prog, Number(v)));
    svc.getCharacteristic(C.TemperatureDisplayUnits)
      .onGet(() => C.TemperatureDisplayUnits.CELSIUS)
      .onSet(() => {});
    this.levelServices[prog] = svc;
    if (isNew) this.platform.api.registerPlatformAccessories(PLUGIN_NAME, 'ViessmannPlatform', [acc]);
    else this.platform.api.updatePlatformAccessories([acc]);
  }

  /** Level in force now: follows the time schedule (programs.active) and the special programs. */
  private levelInForce(): ProgramType | null {
    const p = this.plan();
    if (p === 'off') return null;
    if (p === 'holiday') return 'reduced';          // Holiday: reduced temperature
    if (p === 'holidayAtHome') return 'normal';     // Holiday at home: normal all day
    if (p === 'extended' || p === 'comfort') return 'comfort';
    return (['reduced', 'normal', 'comfort'] as string[]).includes(this.currentProgram) ? this.currentProgram as ProgramType : null;
  }

  private levelEditUntil: Partial<Record<ProgramType, number>> = {};

  private async setLevelTemperature(prog: ProgramType, value: number) {
    const t = Math.round(Math.min(Math.max(value, this.temperatureConstraints.min), this.temperatureConstraints.max));
    const feature = `heating.circuits.${this.circuitNumber}.operating.programs.${prog === 'comfort' ? this.comfortFeatureSuffix : prog}`;
    this.platform.log.info(`🌡️ HC${this.circuitNumber} ${prog} temperature ${this.programTemperatures[prog]}°C → ${t}°C`);
    try {
      await this.cmd(feature, 'setTemperature', { targetTemperature: t });
    } catch (e: any) {
      this.platform.log.error(`❌ HC${this.circuitNumber} ${prog} temperature not changed: ${e?.message || e}`);
      setTimeout(() => this.refreshLevelThermostats(), 1500);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    this.programTemperatures[prog] = t;
    if (this.currentProgram === prog) {
      this.states.HeatingThresholdTemperature = t;
      this.heaterCoolerService.updateCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature, this.getThresholdForDisplay());
    }
    this.refreshLevelThermostats();
  }

  private refreshLevelThermostats() {
    const C = this.platform.Characteristic;
    for (const [prog, svc] of Object.entries(this.levelServices) as [ProgramType, Service][]) {
      const t = Number(this.programTemperatures[prog]);
      if (!Number.isFinite(t) || t <= 0) continue;
      const v = Math.min(Math.max(t, this.temperatureConstraints.min), this.temperatureConstraints.max);
      svc.updateCharacteristic(C.CurrentTemperature, v);
      svc.updateCharacteristic(C.TargetTemperature, v);
      const inForce = this.levelInForce() === prog;
      const on = inForce || (this.levelEditUntil[prog] ?? 0) > Date.now();
      svc.updateCharacteristic(C.CurrentHeatingCoolingState, inForce && this.heaterState() === this.platform.Characteristic.CurrentHeaterCoolerState.HEATING ? C.CurrentHeatingCoolingState.HEAT : C.CurrentHeatingCoolingState.OFF);
      svc.updateCharacteristic(C.TargetHeatingCoolingState, on ? C.TargetHeatingCoolingState.HEAT : C.TargetHeatingCoolingState.OFF);
    }
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
        .replace(/[^\p{L}\p{N}\s']/gu, ' ') // keep letters of any language (è, ü …), digits, spaces, apostrophes
        .replace(/\s+/g, ' ')      // Collapse multiple spaces
        .trim();                   // Remove leading/trailing spaces
    };

    // No "Reduced" switch: the reduced temperature cannot be selected on the boiler (the time
    // schedule decides it, ViCare has no "activate reduced"). Its temperature is still readable.
    if (this.availablePrograms.includes('normal')) {
      const serviceName = sanitizeName(`${installationName} ${heatingCircuitName} ${this.circuitNumber} ${normalName}`);
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
        .onGet(() => this.plan() === 'normal')
        .onSet((v: CharacteristicValue) => this.onPlanSwitch('normal', v));
    }

    // No separate heating "Comfort" switch: ViCare offers only Heating/Off plus the quick selections
    // (Extended heating, Holiday, Holiday at home). comfort.activate, where it is the only way to
    // extend heating, is driven by the Extended heating switch. Opt-in: features.exposeComfortProgram.
    if (this.availablePrograms.includes('comfort') && this.hasComfortActivate && this.hasForcedActivate
        && (this.platform.config as any).features?.exposeComfortProgram === true) {
      const serviceName = sanitizeName(`${installationName} ${heatingCircuitName} ${this.circuitNumber} ${comfortName}`);
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
        .onGet(() => this.plan() === 'comfort')
        .onSet((v: CharacteristicValue) => this.onPlanSwitch('comfort', v));
    }

    if ((this.platform.config as any).features?.exposeProgramTemperatures !== false) {
      for (const [prog, label] of [['reduced', reducedName], ['normal', normalName], ['comfort', comfortName]] as [ProgramType, string][]) {
        if (!this.availablePrograms.includes(prog)) continue;
        this.addLevelThermostat(prog, sanitizeName(`${installationName} ${heatingCircuitName} ${this.circuitNumber} Temp ${label}`));
      }
    } else {
      for (const prog of ['reduced', 'normal', 'comfort'] as ProgramType[]) this.removeLevelAccessory(prog);
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
      const serviceName = `${installationName} ${customNames.heatingCircuit || 'Heating Circuit'} ${this.circuitNumber} ${holidayName}`;
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
        .onGet(() => this.plan() === 'holiday')
        .onSet((v: CharacteristicValue) => this.onPlanSwitch('holiday', v));
    }

    if (this.availableQuickSelections.includes('holidayAtHome')) {
      const serviceName = `${installationName} ${customNames.heatingCircuit || 'Heating Circuit'} ${this.circuitNumber} ${holidayAtHomeName}`;
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
        .onGet(() => this.plan() === 'holidayAtHome')
        .onSet((v: CharacteristicValue) => this.onPlanSwitch('holidayAtHome', v));
    }

    if (this.availableQuickSelections.includes('extendedHeating')) {
      const serviceName = `${installationName} ${customNames.heatingCircuit || 'Heating Circuit'} ${this.circuitNumber} ${extendedHeatingName}`;
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
        .onGet(() => this.plan() === this.extendedPlan())
        .onSet((v: CharacteristicValue) => this.onPlanSwitch(this.extendedPlan(), v));
    }

    // 🛠️ Push initial state to HomeKit — onGet alone is not enough because HAP uses
    // the cached accessory value until an explicit updateCharacteristic is called.
    if (this.holidayService) {
      this.holidayService.updateCharacteristic(this.platform.Characteristic.On, this.states.HolidayActive);
    }
    if (this.holidayAtHomeService) {
      this.holidayAtHomeService.updateCharacteristic(this.platform.Characteristic.On, this.states.HolidayAtHomeActive);
    }
    if (this.extendedHeatingService) {
      this.extendedHeatingService.updateCharacteristic(this.platform.Characteristic.On, this.states.ExtendedHeatingActive);
      this.platform.log.info(`ExtendedHeating initial state: ${this.states.ExtendedHeatingActive ? 'ON' : 'OFF'}`);
    }

    this.platform.log.info(`✅ HC${this.circuitNumber} quick selection services setup completed for selections: [${this.availableQuickSelections.join(', ')}] with subtype version: ${subtypeVersion}`);
  }


  private removeAllTemperatureProgramServices() {
    // Remove existing temperature program switch services
    const tempProgramSubtypes = [`hc${this.circuitNumber}-reduced`, `hc${this.circuitNumber}-normal`, `hc${this.circuitNumber}-comfort`];
    
    for (const subtype of tempProgramSubtypes) {
      const service = this.accessory.services.find(service => 
        service.UUID === this.platform.Service.Switch.UUID && 
        !!service.subtype && (service.subtype === subtype || /^-(stable|\d{8})$/.test(service.subtype.slice(subtype.length)) && service.subtype.startsWith(subtype))
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
    this.normaleService = undefined;
    this.comfortService = undefined;
  }

  private removeAllQuickSelectionServices() {
    // Remove existing quick selection switch services
    const quickSelectionSubtypes = [`hc${this.circuitNumber}-holiday`, `hc${this.circuitNumber}-holiday-at-home`, `hc${this.circuitNumber}-extended-heating`];
    
    for (const subtype of quickSelectionSubtypes) {
      const service = this.accessory.services.find(service => 
        service.UUID === this.platform.Service.Switch.UUID && 
        !!service.subtype && (service.subtype === subtype || /^-(stable|\d{8})$/.test(service.subtype.slice(subtype.length)) && service.subtype.startsWith(subtype))
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






  private updateTemperatureProgramSwitches() {
    this.refreshPlanSwitches();
  }


  async setActive(value: CharacteristicValue) {
    if (this._updatingCharacteristics) return;
    const on = value === this.platform.Characteristic.Active.ACTIVE;
    if (on && this.plan() === 'off') await this.applyPlan(this.defaultPlan());
    else if (!on && this.plan() !== 'off') await this.applyPlan('off');
  }

  // ─── Heating "plans" ────────────────────────────────────────────────────────
  // The boiler's own mutually exclusive choices (ViCare itself asks to replace one with the
  // other), verified with the ViCare app on an E3 Vitodens. Only those the boiler really has
  // are published to HomeKit:
  //   off            → operating mode "standby"
  //   normal         → mode "heating", no special program: the time schedule (Normal/Reduced)
  //   extended       → "Extended heating": forcedLastFromSchedule (keeps the comfort slot going)
  //   comfort        → comfort.activate, when the boiler has it (if there is no
  //                    forcedLastFromSchedule, the Extended heating switch drives this one)
  //   holiday        → "Holiday": every circuit at the REDUCED temperature, hot water OFF,
  //                    frost protection, 00:00 of the first day to 23:59 of the last
  //   holidayAtHome  → "Holiday at home": the NORMAL temperature is kept all day (no reduced
  //                    periods); hot water as usual
  // Switching one on switches all the others off; switching the active one off returns to
  // Normal. ViCare reports a scheduled holiday as active=false until it starts: scheduled = ON.
  private planLock: Promise<void> = Promise.resolve();
  private pendingPlan?: HeatingPlan;
  private pendingPlanUntil = 0;
  private hasComfortActivate = false;
  private hasForcedActivate = false;
  private comfortOn = false;
  private forcedOn = false;

  /** The Extended heating switch: forcedLastFromSchedule when it exists, else comfort. */
  private extendedPlan(): HeatingPlan {
    return this.hasForcedActivate ? 'extended' : 'comfort';
  }

  private defaultPlan(): HeatingPlan {
    return 'normal';
  }

  /** Current plan as seen by HomeKit (the expected one while a command is being confirmed). */
  private plan(): HeatingPlan {
    const real = this.statesPlan();
    if (this.pendingPlan && Date.now() < this.pendingPlanUntil) {
      if (real === this.pendingPlan) this.pendingPlan = undefined;   // API confirmed
      else return this.pendingPlan;
    }
    return real;
  }

  private statesPlan(): HeatingPlan {
    // Special programs win over the operating mode: ViCare runs them even with the circuit in
    // standby (verified: programs.active = holidayAtHome with modes.active = standby).
    if (this.states.HolidayActive) return 'holiday';
    if (this.states.HolidayAtHomeActive) return 'holidayAtHome';
    if (this.forcedOn) return 'extended';
    if (this.comfortOn) return 'comfort';
    if (this.currentMode === 'standby') return 'off';
    return 'normal';
  }

  private async onPlanSwitch(target: HeatingPlan, value: CharacteristicValue) {
    if (this._updatingCharacteristics) return;
    const on = value as boolean;
    const cur = this.plan();
    if (on && cur !== target) await this.applyPlan(target);
    else if (!on && cur === target) await this.applyPlan(target === this.defaultPlan() ? 'off' : this.defaultPlan());
    else setTimeout(() => this.refreshPlanSwitches(), 200);   // nothing to do: re-sync the switch
  }

  private applyPlan(target: HeatingPlan): Promise<void> {
    const run = this.planLock.then(() => this.doApplyPlan(target));
    this.planLock = run.catch(() => undefined);
    return run;
  }

  private async cmd(feature: string, command: string, params: any = {}): Promise<void> {
    const ok = await this.platform.viessmannAPI.executeCommand(this.installation.id, this.gateway.serial, this.device.id, feature, command, params);
    if (!ok) throw new Error(`${feature}.${command} refused by the Viessmann API`);
  }

  private async doApplyPlan(target: HeatingPlan) {
    const from = this.plan();
    if (from === target) { this.refreshPlanSwitches(); return; }
    const hc = `heating.circuits.${this.circuitNumber}`;
    const day = (offset: number) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const f = (this.platform.config as any).features || {};
    const days = (v: any, def: number) => Math.max(1, Math.round(Number(v)) || def);
    this.platform.log.info(`🎛️ HC${this.circuitNumber} plan ${from.toUpperCase()} → ${target.toUpperCase()}`);
    try {
      // 1. switch off every special program that is not the target
      if (this.states.HolidayActive && target !== 'holiday') { await this.cmd('heating.operating.programs.holiday', 'unschedule'); this.states.HolidayActive = false; }
      if (this.states.HolidayAtHomeActive && target !== 'holidayAtHome') { await this.cmd('heating.operating.programs.holidayAtHome', 'unschedule'); this.states.HolidayAtHomeActive = false; }
      if ((this.forcedOn || this.comfortOn || this.states.ExtendedHeatingActive) && target !== 'extended' && target !== 'comfort') {
        await this.stopComfort(); this.forcedOn = false; this.comfortOn = false; this.states.ExtendedHeatingActive = false;
      } else if (this.forcedOn && target === 'comfort') { await this.cmd(`${hc}.operating.programs.forcedLastFromSchedule`, 'deactivate'); this.forcedOn = false; }
      else if (this.comfortOn && target === 'extended') { await this.cmd(`${hc}.operating.programs.${this.comfortFeatureSuffix}`, 'deactivate'); this.comfortOn = false; }
      this.states.ExtendedHeatingActive = this.forcedOn || this.comfortOn;
      // 2. operating mode
      if (target === 'off' && this.currentMode !== 'standby') await this.setMode('standby');
      if (['normal', 'comfort', 'extended'].includes(target) && this.currentMode !== 'heating' && this.availableModes.includes('heating')) await this.setMode('heating');
      // 3. the target itself
      if (target === 'holidayAtHome') {
        await this.cmd('heating.operating.programs.holidayAtHome', 'schedule', { start: day(0), end: day(days(f.holidayAtHomeDays ?? f.awayDays /* pre-release name */, 7)) });
        this.states.HolidayAtHomeActive = true;
      } else if (target === 'holiday') {
        await this.cmd('heating.operating.programs.holiday', 'schedule', { start: day(0), end: day(days(f.holidayDays, 7)) });
        this.states.HolidayActive = true;
      } else if (target === 'extended') {
        await this.activateWhenExecutable(`${hc}.operating.programs.forcedLastFromSchedule`, 'Extended heating');
        this.forcedOn = true;
      } else if (target === 'comfort') {
        await this.activateWhenExecutable(`${hc}.operating.programs.${this.comfortFeatureSuffix}`, 'Comfort');
        this.comfortOn = true;
      }
      this.states.ExtendedHeatingActive = this.forcedOn || this.comfortOn;
      this.pendingPlan = target;
      this.pendingPlanUntil = Date.now() + (this.platform.config.postCommandRetry?.guardDuration ?? 120000);
      this.platform.log.info(`✅ HC${this.circuitNumber} plan now ${target.toUpperCase()}`);
    } catch (e: any) {
      this.pendingPlan = undefined;
      this.states.ExtendedHeatingActive = this.forcedOn || this.comfortOn;
      this.platform.log.error(`❌ HC${this.circuitNumber} plan ${target.toUpperCase()} failed: ${e?.message || e} — now ${this.statesPlan().toUpperCase()}`);
      setTimeout(() => this.refreshPlanSwitches(), 1500);   // HomeKit keeps the tapped value right after an error
      this.refreshPlanSwitches();
      this.scheduleCommandConfirmation();
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    this.refreshPlanSwitches();
    this.scheduleCommandConfirmation();
  }

  /** "activate" becomes executable a few seconds after the circuit is switched to heating. */
  private async activateWhenExecutable(feature: string, label: string) {
    for (let i = 0; i < 4; i++) {
      this.platform.viessmannAPI.clearCache(`/features/installations/${this.installation.id}`);
      const feats = await this.platform.viessmannAPI.getDeviceFeatures(this.installation.id, this.gateway.serial, this.device.id);
      const ft = feats.find(x => x.feature === feature);
      if (ft?.commands?.activate?.isExecutable) { await this.cmd(feature, 'activate'); return; }
      await new Promise(r => setTimeout(r, 5000));
    }
    throw new Error(`the boiler does not accept ${label} right now (activate not executable, e.g. in summer / standby)`);
  }

  private async stopComfort() {
    const hc = `heating.circuits.${this.circuitNumber}`;
    this.platform.viessmannAPI.clearCache(`/features/installations/${this.installation.id}`);
    const feats = await this.platform.viessmannAPI.getDeviceFeatures(this.installation.id, this.gateway.serial, this.device.id);
    const forced = feats.find(x => x.feature === `${hc}.operating.programs.forcedLastFromSchedule`);
    if (forced?.properties?.active?.value && forced?.commands?.deactivate?.isExecutable) await this.cmd(`${hc}.operating.programs.forcedLastFromSchedule`, 'deactivate');
    const comfort = feats.find(x => x.feature === `${hc}.operating.programs.${this.comfortFeatureSuffix}`);
    if (comfort?.properties?.active?.value && comfort?.commands?.deactivate?.isExecutable) await this.cmd(`${hc}.operating.programs.${this.comfortFeatureSuffix}`, 'deactivate');
  }

  private getThresholdForDisplay(): number {
    return Math.min(Math.max(this.states.HeatingThresholdTemperature, this.temperatureConstraints.min), this.temperatureConstraints.max);
  }

  /** Puts every plan switch (and the Active characteristic) in line with plan(). */
  private refreshPlanSwitches() {
    const p = this.plan();
    const C = this.platform.Characteristic;
    this._updatingCharacteristics = true;
    try {
      this.normaleService?.updateCharacteristic(C.On, p === 'normal');
      this.comfortService?.updateCharacteristic(C.On, p === 'comfort');
      this.extendedHeatingService?.updateCharacteristic(C.On, p === this.extendedPlan());
      this.holidayService?.updateCharacteristic(C.On, p === 'holiday');
      this.holidayAtHomeService?.updateCharacteristic(C.On, p === 'holidayAtHome');
      // The dial shows the temperature in force: Holiday → reduced, Holiday at home → normal,
      // Comfort / Extended heating → comfort (extended heating runs at the comfort temperature). Otherwise it keeps what the schedule reports.
      const t = p === 'holiday' ? this.programTemperatures.reduced
        : p === 'holidayAtHome' ? this.programTemperatures.normal
        : p === 'comfort' || p === 'extended' ? this.programTemperatures.comfort : undefined;
      if (t) {
        this.states.HeatingThresholdTemperature = t;
        this.heaterCoolerService.updateCharacteristic(C.HeatingThresholdTemperature, this.getThresholdForDisplay());
      }
      const active = p !== 'off' && p !== 'holiday';
      this.heaterCoolerService.updateCharacteristic(C.Active, active ? C.Active.ACTIVE : C.Active.INACTIVE);
      this.heaterCoolerService.updateCharacteristic(C.CurrentHeaterCoolerState, this.heaterState());
      this.refreshLevelThermostats();
    } finally {
      setImmediate(() => { this._updatingCharacteristics = false; });
    }
  }

  async setTargetHeaterCoolerState(value: CharacteristicValue) {
    // Heating circuits only support HEAT: selecting it while off switches the default plan on
    if (value === this.platform.Characteristic.TargetHeaterCoolerState.HEAT && this.plan() === 'off') {
      await this.applyPlan(this.defaultPlan());
    }
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
      `heating.circuits.${this.circuitNumber}.operating.programs.${this.comfortFeatureSuffix}`,
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





  /**
   * Update all switch characteristics to reflect mutual exclusion
   */
  private updateMutuallyExclusiveSwitches() {
    this.refreshPlanSwitches();
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
        
        // 🛡️ Guard: block regular update cycle from overwriting mode until API confirms
        const guardMsMode = this.platform.config.postCommandRetry?.guardDuration ?? 120000;
        this.pendingModeUntil = Date.now() + guardMsMode;
        this.pendingExpectedMode = mode;
        this.pendingPreviousMode = oldMode;

        // Update all characteristics
        this.updateAllCharacteristics();

        // 🆕 NEW: Schedule full state refresh from API to confirm command was accepted
        this.scheduleCommandConfirmation(mode);
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
    if (Date.now() >= this.pendingPlanUntil || !this.pendingPlan) { this.refreshPlanSwitches(); return; }
    // Update HeaterCooler characteristics
    const isActive = this.currentMode === 'heating';
    this.heaterCoolerService.updateCharacteristic(this.platform.Characteristic.Active, 
      isActive ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE);
    
    this.heaterCoolerService.updateCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState, this.heaterState());
    
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

          // 🛡️ Guard: block regular update cycle from overwriting temp until API confirms
          const guardMsTemp = this.platform.config.postCommandRetry?.guardDuration ?? 120000;
          this.pendingTempUntil = Date.now() + guardMsTemp;
          this.pendingExpectedTemp = temperature;
          this.pendingPreviousTemp = this.states.HeatingThresholdTemperature;
          
          // Keep the Reduced / Normal / Comfort tiles in line with the main dial
          this.refreshLevelThermostats();

          // 🆕 NEW: Schedule full state refresh from API to confirm command was accepted
          this.scheduleCommandConfirmation(undefined, temperature);
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
    // Since 2.0.80 service names no longer contain the program temperature: renaming services
    // at runtime overrode the names users set in Apple Home and the values went stale anyway.
  }

  async getCurrentRelativeHumidity(): Promise<CharacteristicValue> {
    return this.states.CurrentRelativeHumidity;
  }

  // 🆕 Progressive command confirmation with retry.
  private scheduleCommandConfirmation(
    expectedMode?: string,
    expectedTemp?: number,
    attemptIndex = 0
  ): void {
    const delays = this.platform.config.postCommandRetry?.delays ?? [5000, 15000, 30000, 60000];
    if (attemptIndex >= delays.length) {
      this.platform.log.warn(`⚠️ HC${this.circuitNumber} command confirmation exhausted after ${delays.length} attempts — regular cycle will take over`);
      return;
    }

    const delayMs = delays[attemptIndex];
    const circuitPrefix = `heating.circuits.${this.circuitNumber}`;

    setTimeout(async () => {
      try {
        this.platform.log.debug(`🔄 HC${this.circuitNumber} confirmation attempt ${attemptIndex + 1}/${delays.length} (after ${delayMs}ms)...`);
        this.platform.viessmannAPI.clearCache(`/features/installations/${this.installation.id}`);
        const features = await this.platform.viessmannAPI.getDeviceFeatures(
          this.installation.id,
          this.gateway.serial,
          this.device.id
        );

        // --- Mode confirmation ---
        if (expectedMode !== undefined) {
          const modeFeature = features.find((f: any) => f.feature === `${circuitPrefix}.operating.modes.active`);
          const apiMode = modeFeature?.properties?.value?.value;
          if (apiMode === expectedMode) {
            this.platform.log.debug(`✅ HC${this.circuitNumber} mode confirmed by API: "${apiMode}"`);
            this.pendingModeUntil = 0;
            this.pendingExpectedMode = undefined;
            this.pendingPreviousMode = undefined;
            await this.updateFromFeatures(features);
            return;
          } else if (apiMode !== undefined && apiMode !== this.pendingPreviousMode) {
            this.platform.log.info(`🔀 HC${this.circuitNumber} external mode change: API="${apiMode}" (expected "${expectedMode}") — applying`);
            this.pendingModeUntil = 0;
            this.pendingExpectedMode = undefined;
            this.pendingPreviousMode = undefined;
            await this.updateFromFeatures(features);
            return;
          } else {
            const guardMs = this.platform.config.postCommandRetry?.guardDuration ?? 120000;
            this.pendingModeUntil = Date.now() + guardMs;
            this.platform.log.debug(`⏳ HC${this.circuitNumber} mode not yet propagated (API="${apiMode}", expected "${expectedMode}") — retry ${attemptIndex + 2}/${delays.length}`);
            this.scheduleCommandConfirmation(expectedMode, expectedTemp, attemptIndex + 1);
            return;
          }
        }

        // --- Temp confirmation ---
        if (expectedTemp !== undefined) {
          const programFeature = features.find((f: any) =>
            f.feature === `${circuitPrefix}.operating.programs.${this.currentProgram}`
          );
          const apiTemp = programFeature?.properties?.temperature?.value;
          if (apiTemp === expectedTemp) {
            this.platform.log.debug(`✅ HC${this.circuitNumber} temp confirmed by API: ${apiTemp}°C`);
            this.pendingTempUntil = 0;
            this.pendingProgramUntil = 0;
            this.pendingExpectedTemp = undefined;
            this.pendingPreviousTemp = undefined;
            this.pendingExpectedProgram = undefined;
            this.pendingPreviousProgram = undefined;
            await this.updateFromFeatures(features);
            return;
          } else if (apiTemp !== undefined && apiTemp !== this.pendingPreviousTemp) {
            this.platform.log.info(`🔀 HC${this.circuitNumber} external temp change: API=${apiTemp}°C (expected ${expectedTemp}°C) — applying`);
            this.pendingTempUntil = 0;
            this.pendingProgramUntil = 0;
            this.pendingExpectedTemp = undefined;
            this.pendingPreviousTemp = undefined;
            await this.updateFromFeatures(features);
            return;
          } else {
            const guardMs = this.platform.config.postCommandRetry?.guardDuration ?? 120000;
            this.pendingTempUntil = Date.now() + guardMs;
            this.pendingProgramUntil = Date.now() + guardMs;
            this.platform.log.debug(`⏳ HC${this.circuitNumber} temp not yet propagated (API=${apiTemp}°C, expected ${expectedTemp}°C) — retry ${attemptIndex + 2}/${delays.length}`);
            this.scheduleCommandConfirmation(expectedMode, expectedTemp, attemptIndex + 1);
            return;
          }
        }

      } catch (error) {
        this.platform.log.warn(`⚠️ HC${this.circuitNumber} confirmation attempt ${attemptIndex + 1} failed:`, error instanceof Error ? error.message : error);
        this.scheduleCommandConfirmation(expectedMode, expectedTemp, attemptIndex + 1);
      }
    }, delayMs);
  }

  // 🗓️ Schedule-aware refresh — fires a proactive update at each program boundary
  private scheduleNextProgramBoundary() {
    // Clear any existing timer
    if (this.scheduleRefreshTimer !== null) {
      clearTimeout(this.scheduleRefreshTimer);
      this.scheduleRefreshTimer = null;
    }

    const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const now = new Date();
    const todayKey = days[now.getDay()];
    const tomorrowKey = days[(now.getDay() + 1) % 7];

    // Collect all boundary times for today and tomorrow
    const boundaries: Date[] = [];

    for (const [dayKey, offset] of [[todayKey, 0], [tomorrowKey, 1]] as [string, number][]) {
      const entries = this.heatingSchedule[dayKey] || [];
      for (const entry of entries) {
        for (const timeStr of [entry.start, entry.end]) {
          const [h, m] = timeStr.split(':').map(Number);
          const boundary = new Date(now);
          boundary.setDate(boundary.getDate() + offset);
          boundary.setHours(h, m, 5, 0); // +5s margin so schedule is already active
          if (boundary > now) {
            boundaries.push(boundary);
          }
        }
      }
    }

    if (boundaries.length === 0) {
      this.platform.log.debug(`HC${this.circuitNumber} schedule-aware refresh: no upcoming boundaries found`);
      return;
    }

    // Find the nearest boundary
    boundaries.sort((a, b) => a.getTime() - b.getTime());
    const next = boundaries[0];
    const msUntil = next.getTime() - now.getTime();
    const label = next.toLocaleTimeString('it-IT', {hour: '2-digit', minute: '2-digit'});

    this.platform.log.debug(`HC${this.circuitNumber} schedule-aware refresh: next boundary at ${label} (in ${Math.round(msUntil/1000)}s)`);

    this.scheduleRefreshTimer = setTimeout(async () => {
      this.scheduleRefreshTimer = null;
      this.platform.log.info(`🗓️ HC${this.circuitNumber} proactive refresh at schedule boundary (${label})`);
      try {
        const features = await this.platform.viessmannAPI.getDeviceFeatures(
          this.installation.id,
          this.gateway.serial,
          this.device.id
        );
        await this.updateFromFeatures(features);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.platform.log.warn(`HC${this.circuitNumber} proactive refresh failed: ${msg}`);
      }
      // Schedule the next boundary after this one
      this.scheduleNextProgramBoundary();
    }, msUntil);
  }

  private async handleUpdate(features: any[]) {
    const t0 = Date.now();
    try {
      await this.updateFromFeatures(features);
      this.platform.log.debug(`🌡️ Riscaldamento ${this.circuitNumber} handleUpdate OK in ${Date.now() - t0}ms`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.platform.log.error(`❌ Riscaldamento ${this.circuitNumber} handleUpdate failed after ${Date.now() - t0}ms: ${msg}`);
      this.platform.log.error(`   State at failure: mode=${this.currentMode}, program=${this.currentProgram}, temp=${this.states.CurrentTemperature}°C`);
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

    // Always read flow temperature (supply) independently for CSV logging and diagnostics
    const flowTempFeature = features.find(f => f.feature === `${circuitPrefix}.sensors.temperature.supply`);
    if (flowTempFeature?.properties?.value?.value !== undefined) {
      this.states.FlowTemperature = flowTempFeature.properties.value.value;
    }

    // Update temperature programs
    const programTypes = ['comfort', 'normal', 'reduced'];

    for (const programType of programTypes) {
      const programFeature = features.find(f => f.feature === `${circuitPrefix}.operating.programs.${programType}`);
      if (programFeature?.properties?.temperature?.value !== undefined) {
        const newTemp = programFeature.properties.temperature.value;
        const oldTemp = this.programTemperatures[programType as ProgramType];

        if (newTemp !== oldTemp) {
          this.programTemperatures[programType as ProgramType] = newTemp;
          anyTemperatureChanged = true;
          this.platform.log.debug(`Program ${programType} temperature updated: ${oldTemp}°C → ${newTemp}°C`);
        }
      }
    }

    // Read active program directly from API (operating.programs.active) — authoritative source
    const activeProgramFeature = features.find(f => f.feature === `${circuitPrefix}.operating.programs.active`);
    let activeProgram = activeProgramFeature?.properties?.value?.value as string || this.currentProgram;
    // Normalize: heat pump devices return 'normalHeating', 'reducedHeating', 'comfortHeating',
    // 'normalEnergySaving', 'reducedEnergySaving', 'comfortEnergySaving' instead of plain
    // 'normal', 'reduced', 'comfort'. Map them to our canonical set.
    // Vitocal gen3 returns compound program names — normalise to canonical set.
    // Note: 'forcedLastFromSchedule' appears as a separate feature (active=true/false),
    // NOT as a value of programs.active — so it is intentionally excluded here.
    // Pattern-based normalisation — works for any current or future device variant
    // (normalHeating, normalEnergySaving, normalV2... all start with 'normal' → 'normal').
    // Fixed map would break on unknown future variants from new device models.
    function normaliseProgramName(name: string): string | null {
      const l = name.toLowerCase();
      if (l.startsWith('comfort')) return 'comfort';
      if (l.startsWith('normal'))  return 'normal';
      if (l.startsWith('reduced')) return 'reduced';
      if (l === 'holidayathome') return 'normal';     // Holiday at home keeps the normal temperature all day
      if (l.startsWith('holiday')) return 'reduced';   // Holiday runs the reduced temperature
      return null;
    }
    const normalised = normaliseProgramName(activeProgram);
    if (normalised && normalised !== activeProgram) {
      this.platform.log.debug(`HC${this.circuitNumber} program "${activeProgram}" → normalised to "${normalised}"`);
      activeProgram = normalised;
    } else if (!['comfort', 'normal', 'reduced'].includes(activeProgram)) {
      this.platform.log.debug(`HC${this.circuitNumber} active program "${activeProgram}" not in known set — keeping ${this.currentProgram}`);
      activeProgram = this.currentProgram;
    }
    this.platform.log.debug(`HC${this.circuitNumber} active program from API: ${activeProgram.toUpperCase()}`);

    // Update current program if it changed
    if (Date.now() < this.pendingProgramUntil) {
      if (activeProgram !== this.pendingPreviousProgram && activeProgram !== this.pendingExpectedProgram) {
        this.platform.log.info(`🔀 HC${this.circuitNumber} external program change while guard active: API="${activeProgram}" — applying and resetting guard`);
        this.pendingProgramUntil = 0;
        this.pendingExpectedProgram = undefined;
        this.pendingPreviousProgram = undefined;
        this.currentProgram = activeProgram;
        this.updateTemperatureProgramSwitches();
      } else {
        this.platform.log.debug(`🌡️ HC${this.circuitNumber} program: API returned ${activeProgram.toUpperCase()} but command guard active — keeping ${this.currentProgram.toUpperCase()}`);
      }
    } else if (activeProgram !== this.currentProgram) {
      this.currentProgram = activeProgram;
      this.platform.log.debug(`Active temperature program changed to: ${activeProgram.toUpperCase()}`);
      this.updateTemperatureProgramSwitches();
    }

    // Update service names if temperatures changed
    this.refreshLevelThermostats();   // temperatures and the level in force (time schedule)
    if (anyTemperatureChanged) {
      this.updateServiceNames();
    }

    // HeatingThresholdTemperature = temperature in force (Extended heating / Comfort → comfort,
    // Holiday → reduced, Holiday at home → normal, otherwise the program of the time schedule)
    const activeTemp = this.programTemperatures[(this.levelInForce() ?? activeProgram) as ProgramType];
    if (Date.now() < this.pendingTempUntil) {
      if (activeTemp !== this.pendingPreviousTemp && activeTemp !== this.pendingExpectedTemp) {
        this.platform.log.info(`🔀 HC${this.circuitNumber} external temp change while guard active: API=${activeTemp}°C — applying and resetting guard`);
        this.pendingTempUntil = 0;
        this.pendingExpectedTemp = undefined;
        this.pendingPreviousTemp = undefined;
        this.states.HeatingThresholdTemperature = activeTemp;
        this.heaterCoolerService.updateCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature, activeTemp);
      } else {
        this.platform.log.debug(`🌡️ HC${this.circuitNumber} temp: API returned ${activeTemp}°C but command guard active — keeping ${this.states.HeatingThresholdTemperature}°C`);
      }
    } else if (typeof activeTemp === 'number' && activeTemp > 0 && activeTemp !== this.states.HeatingThresholdTemperature) {
      this.states.HeatingThresholdTemperature = activeTemp;
      this.heaterCoolerService.updateCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature, activeTemp);
    }

    // Update quick selection programs with mutual exclusion logic
    // A holiday / holiday-at-home program counts as ON when it is running (active) OR scheduled
    // with dates that include today or the future: ViCare reports active=false for a scheduled
    // program until it actually runs (e.g. while the circuit is in standby).
    const scheduledOn = (f: any): boolean | undefined => {
      if (f?.properties?.active?.value === undefined) return undefined;
      if (f.properties.active.value === true) return true;
      const end = String(f.properties?.end?.value || '');
      const d = new Date();
      const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return /^\d{4}-\d{2}-\d{2}/.test(end) && end.slice(0, 10) >= today;
    };
    const holidayFeature = features.find(f => f.feature === 'heating.operating.programs.holiday');
    if (scheduledOn(holidayFeature) !== undefined) {
      const newState = scheduledOn(holidayFeature) as boolean;
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
    if (scheduledOn(holidayAtHomeFeature) !== undefined) {
      const newState = scheduledOn(holidayAtHomeFeature) as boolean;
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

    // Extended heating state — three signals in OR, all verified via live API:
    //
    // Vitodens (confirmed on a real installation):
    //   programs.active stays 'normal', comfort.active stays False
    //   forcedLastFromSchedule.active = True when ON, False when OFF  ← real indicator here
    //
    // Vitocal gen3 / other devices:
    //   programs.active may change to comfortFeatureSuffix
    //   comfort.active may become True
    //
    // Using OR of all three signals covers all known device behaviours without assumptions.
    const comfortProgram  = features.find(f => f.feature === `${circuitPrefix}.operating.programs.${this.comfortFeatureSuffix}`);
    const forcedProgram   = features.find(f => f.feature === `${circuitPrefix}.operating.programs.forcedLastFromSchedule`);
    const activeProg      = features.find(f => f.feature === `${circuitPrefix}.operating.programs.active`);
    const comfortActive   = comfortProgram?.properties?.active?.value  ?? false;
    const forcedActive    = forcedProgram?.properties?.active?.value   ?? false;
    const activeIsComfort = activeProg?.properties?.value?.value === this.comfortFeatureSuffix;
    const extendedActive  = comfortActive || forcedActive || activeIsComfort;
    this.comfortOn = !!(comfortActive || activeIsComfort);
    this.forcedOn = !!forcedActive;
    if (extendedActive !== this.states.ExtendedHeatingActive) {
      this.states.ExtendedHeatingActive = extendedActive;
      anyProgramStateChanged = true;
      this.platform.log.debug(
        `HC${this.circuitNumber} ExtendedHeating:` +
        ` comfort=${comfortActive} forced=${forcedActive} active=${activeProg?.properties?.value?.value}` +
        ` → ${extendedActive}`,
      );
      if (extendedActive) {
        this.states.HolidayActive = false;
        this.states.HolidayAtHomeActive = false;
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
      if (Date.now() < this.pendingModeUntil) {
        if (newMode !== this.pendingPreviousMode && newMode !== this.pendingExpectedMode) {
          this.platform.log.info(`🔀 HC${this.circuitNumber} external mode change while guard active: API="${newMode}" — applying and resetting guard`);
          this.pendingModeUntil = 0;
          this.pendingExpectedMode = undefined;
          this.pendingPreviousMode = undefined;
          this.currentMode = newMode;
          this.updateAllCharacteristics();
          anyProgramStateChanged = true;
        } else {
          this.platform.log.debug(`🌡️ HC${this.circuitNumber} mode: API returned ${newMode.toUpperCase()} but command guard active — keeping ${this.currentMode.toUpperCase()}`);
        }
      } else if (newMode !== this.currentMode) {
        this.platform.log.info(`🌡️ Riscaldamento ${this.circuitNumber} mode changed: ${this.currentMode.toUpperCase()} → ${newMode.toUpperCase()}`);
        this.currentMode = newMode;
        this.updateAllCharacteristics();
        anyProgramStateChanged = true;
      } else {
        this.platform.log.debug(`🌡️ Riscaldamento ${this.circuitNumber} mode unchanged: ${this.currentMode.toUpperCase()}`);
      }
    } else {
      this.platform.log.warn(`🌡️ Riscaldamento ${this.circuitNumber}: feature '${circuitPrefix}.operating.modes.active' not found — mode NOT updated`);
    }

    // "Heating" only while the burner is really heating this circuit
    this.updateHeatingActivity(features);

    // Update humidity if available
    const humidityFeature = features.find(f => f.feature.includes('sensors.humidity'));
    if (humidityFeature?.properties?.value?.value !== undefined) {
      this.states.CurrentRelativeHumidity = humidityFeature.properties.value.value;
    }

    // Summary: log at info when mode or program changed, debug otherwise
    const summaryLine = `🌡️ Riscaldamento ${this.circuitNumber} — mode=${this.currentMode.toUpperCase()} | prog=${this.currentProgram.toUpperCase()} | room=${this.states.CurrentTemperature}°C | target=${this.states.HeatingThresholdTemperature}°C`;
    if (anyProgramStateChanged || anyTemperatureChanged) {
      this.platform.log.info(summaryLine);
    } else {
      this.platform.log.debug(summaryLine);
    }

    // 🗓️ Update heating schedule and reschedule boundary timer
    const circuitPrefixForSchedule = `heating.circuits.${this.circuitNumber}`;
    const scheduleFeatureData = features.find(f => f.feature === `${circuitPrefixForSchedule}.heating.schedule`);
    if (scheduleFeatureData?.properties?.entries?.value) {
      this.heatingSchedule = scheduleFeatureData.properties.entries.value;
      // Persist schedule to JSON for HTML report
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('fs');
        const basePath2 = this.platform.api?.user?.storagePath?.() || '/var/lib/homebridge';
        const schedPath = require('path').join(basePath2, `viessmann-schedule-${this.installation.id}.json`);
        fs.writeFileSync(schedPath, JSON.stringify({
          circuit: this.circuitNumber,
          updatedAt: new Date().toISOString(),
          entries: this.heatingSchedule,
        }, null, 2), 'utf8');
      } catch (_) { /* non-critical */ }
    }
    this.scheduleNextProgramBoundary();

    // 📊 History logging — FakeGato thermo + CSV/MySQL
    if (this.historyLogger) {
      // Heating curve slope/shift (model-dependent — may be absent)
      const curveFeature = features.find(f => f.feature === `heating.circuits.${this.circuitNumber}.heating.curve`);
      if (curveFeature?.isEnabled) {
        this.curveSlope = curveFeature.properties?.slope?.value;
        this.curveShift = curveFeature.properties?.shift?.value;
      }
      this.historyLogger.addThermoEntry({
        currentTemp: this.states.CurrentTemperature,
        setTemp: this.states.HeatingThresholdTemperature,
      });
      this.historyLogger.appendRow({
        timestamp:   new Date().toISOString(),
        accessory:   `hc${this.circuitNumber}`,
        event_type:  'snapshot',
        room_temp:   this.states.CurrentTemperature,
        target_temp: this.states.HeatingThresholdTemperature,
        flow_temp:   this.states.FlowTemperature,
        program:     this.currentProgram,
        mode:        this.currentMode,
        hc_operating_mode:       this.currentMode,
        hc_comfort_temp:         this.programTemperatures.comfort,
        hc_normal_temp:          this.programTemperatures.normal,
        hc_reduced_temp:         this.programTemperatures.reduced,
        hc_slope:                this.curveSlope,
        hc_shift:                this.curveShift,
        holiday_mode_active:     this.states.HolidayActive,
        extended_heating_active: this.states.ExtendedHeatingActive,
      });
    }
  }
}