import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import {
  ViessmannPlatform,
  ViessmannInstallation,
  ViessmannGateway,
  ViessmannDevice,
} from '../platform';

/**
 * ViessmannEnergyAccessory
 *
 * Handles energy-related and heat pump Viessmann devices:
 *  - Heat pump (Wärmepumpe)          (heating.compressor.*, heating.heatpump.*)
 *  - Vitocharge VX3 / photovoltaic   (heating.solar / heating.photovoltaic)
 *  - Battery storage                 (heating.buffer / heating.powerStorage)
 *  - Wallbox / EV charger            (charging.ev.*)
 *  - Electric DHW heater             (heating.dhw.heating.*)
 *
 * Device detection via device.roles:
 *  - ["type:heatpump"] (exact) or modelId contains "vitocal" → heat pump path
 *  - ["type:ess"] / ["type:photovoltaic;integrated"] → energy device path
 *  NOTE: "type:E3" is present on ALL gen3 devices — NOT a heat pump indicator
 *
 * On first run ALL feature paths are logged at INFO level so unknown
 * device types can be reverse-engineered from user logs.
 */
export class ViessmannEnergyAccessory {

  // ── Services ──────────────────────────────────────────────────────────────

  private informationService: Service;

  // Heat pump
  private heatpumpService?: Service;         // HeaterCooler — main HP on/off + temperature
  private heatpumpCOPService?: Service;       // Lightbulb — Brightness = COP × 10 (0-100)

  // PV / Solar
  private pvProductionService?: Service;
  private pvStatusService?: Service;

  // Battery
  private batteryService?: Service;
  private batteryPowerService?: Service;

  // Wallbox
  private wallboxService?: Service;
  private wallboxOutletService?: Service;

  // Electric DHW heater
  private electricDHWService?: Service;

  // ── Capability flags ──────────────────────────────────────────────────────

  private isHeatPump      = false;
  private hasPV           = false;
  private hasBattery      = false;
  private hasWallbox      = false;
  private hasElectricDHW  = false;

  // ── Known heat pump feature path variants (populated at runtime) ──────────
  // We try several known paths; whichever resolves first is stored here.
  private hpPaths = {
    compressorActive:   '' as string,   // e.g. heating.compressor.0
    compressorMod:      '' as string,   // e.g. heating.compressor.0.statistics
    outsideTemp:        '' as string,
    supplyTemp:         '' as string,
    returnTemp:         '' as string,
    cop:                '' as string,
  };

  // ── State cache ───────────────────────────────────────────────────────────
  private states = {
    // Heat pump
    hpActive: false,
    hpCurrentTemp: 20,
    hpTargetTemp: 20,
    hpHeatingState: 0,    // 0=INACTIVE 1=IDLE 2=HEATING 3=COOLING
    hpCOP: 0,
    hpOutsideTemp: 0,
    hpSupplyTemp: 0,
    hpReturnTemp: 0,
    hpModulation: 0,

    // PV
    pvProductionW: 0,
    pvProductionPercent: 0,
    pvActive: false,
    pvDailyYieldKwh: 0,

    // Battery
    batteryLevelPercent: 0,
    batteryCharging: false,
    batteryChargingW: 0,
    batteryDischargingW: 0,
    batteryStatusLow: false,

    // Grid
    gridFeedInW: 0,
    gridDrawW: 0,

    // Wallbox
    wallboxChargingActive: false,
    wallboxPluggedIn: false,
    wallboxChargingPowerW: 0,
    wallboxEnergySessionKwh: 0,

    // Electric DHW
    electricDHWCurrentTemp: 20,
    electricDHWTargetTemp: 55,
    electricDHWActive: false,
    electricDHWHeatingState: 0,
  };

  constructor(
    private readonly platform: ViessmannPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly installation: ViessmannInstallation,
    private readonly gateway: ViessmannGateway,
    private readonly device: ViessmannDevice,
  ) {
    this.informationService =
      this.accessory.getService(this.platform.Service.AccessoryInformation)!;

    const modelLabel = device.modelId || (this.isHeatPumpDevice() ? 'Heat Pump' : 'Energy System');
    this.informationService
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Viessmann')
      .setCharacteristic(this.platform.Characteristic.Model, modelLabel)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, gateway.serial)
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, '1.0.0');

    // Register update handler
    this.accessory.context.updateHandler = this.handleUpdate.bind(this);

    this.initializeCapabilities();
  }

  // ── Device type helpers ───────────────────────────────────────────────────

  private isHeatPumpDevice(): boolean {
    const roles = this.device.roles ?? [];
    // IMPORTANT: 'type:E3' is a gen3 architecture marker present on ALL Viessmann gen3 devices.
    // Only 'type:heatpump' (exact) correctly identifies the actual heat pump (e.g. Vitocal 250A).
    return roles.includes('type:heatpump') ||
      (this.device.modelId ?? '').toLowerCase().includes('vitocal');
  }

  // ── Capability discovery ───────────────────────────────────────────────────

  private async initializeCapabilities(): Promise<void> {
    try {
      const features = await this.platform.viessmannAPI.getDeviceFeatures(
        this.installation.id,
        this.gateway.serial,
        this.device.id,
      );

      this.logAllFeatures(features);
      this.detectCapabilities(features);
      this.setupServices();
      await this.updateFromFeatures(features);

    } catch (error) {
      this.platform.log.error(
        `[EnergyAccessory] Error initializing capabilities for device ${this.device.id}:`, error,
      );
      this.setupServices();
    }
  }

  // ── Full feature dump (debug only) ────────────────────────────────────────

  private logAllFeatures(features: any[]): void {
    if (!this.platform.config.debug) return;
    const tag = '[EnergyAccessory]';
    const deviceLabel = `device=${this.device.id} model=${this.device.modelId ?? '?'} roles=${JSON.stringify(this.device.roles ?? [])}`;

    this.platform.log.debug(`${tag} ════════════════════════════════════════════════`);
    this.platform.log.debug(`${tag} FULL FEATURE DUMP — ${deviceLabel}`);
    this.platform.log.debug(`${tag} Total features: ${features.length}`);
    this.platform.log.debug(`${tag} ────────────────────────────────────────────────`);

    // Sort features alphabetically for readability
    const sorted = [...features].sort((a, b) => a.feature.localeCompare(b.feature));

    for (const f of sorted) {
      const propKeys  = Object.keys(f.properties  ?? {}).join(', ') || '—';
      const cmdKeys   = Object.keys(f.commands    ?? {}).join(', ') || '—';
      const enabled   = f.isEnabled ? '✓' : '✗';
      const ready     = f.isReady   ? '✓' : '✗';
      const propVals  = JSON.stringify(f.properties ?? {});

      this.platform.log.debug(
        `${tag}   [${enabled}${ready}] ${f.feature}`,
      );
      this.platform.log.debug(
        `${tag}        props=(${propKeys}) values=${propVals.substring(0, 120)}`,
      );
      if (cmdKeys !== '—') {
        this.platform.log.debug(`${tag}        commands=(${cmdKeys})`);
      }
    }

    this.platform.log.debug(`${tag} ════════════════════════════════════════════════`);
  }

  // ── Capability detection ──────────────────────────────────────────────────

  private detectCapabilities(features: any[]): void {
    const names = features.map(f => f.feature);
    const tag = '[EnergyAccessory]';

    // ── Heat pump ──
    if (this.isHeatPumpDevice()) {
      this.isHeatPump = true;
      this.platform.log.info(`${tag} Device identified as HEAT PUMP via roles/modelId`);
      this.resolveHeatPumpPaths(names);
    } else {
      // ── Energy devices: detect from roles (primary) and feature paths (fallback) ──
      const roles = this.device.roles ?? [];
      const hasPVRole = roles.some(r => r === 'type:photovoltaic;integrated' || r.startsWith('type:photovoltaic'));
      const hasBatteryRole = roles.some(r => r === 'type:ess' || r.startsWith('type:ess;'));
      const hasWallboxRole = roles.some(r => r === 'type:accessory;vehicleChargingStation' || r === 'interface:battery;vehicleChargingStation');

      this.hasPV =
        hasPVRole ||
        names.some(n => n.startsWith('heating.photovoltaic')) ||
        names.some(n => n.startsWith('heating.solar.power')) ||
        names.some(n => n === 'heating.solar') ||
        names.some(n => n.startsWith('photovoltaic.')) ||
        names.some(n => n.startsWith('pcc.'));

      this.hasBattery =
        hasBatteryRole ||
        names.some(n => n.startsWith('heating.powerStorage')) ||
        names.some(n => n.startsWith('heating.battery')) ||
        names.some(n => n.startsWith('ess.'));

      this.hasWallbox =
        hasWallboxRole ||
        names.some(n => n.startsWith('charging.ev')) ||
        names.some(n => n.startsWith('heating.ev')) ||
        names.some(n => n.startsWith('vcs.'));

      this.hasElectricDHW =
        names.some(n => n.startsWith('heating.dhw.heating.rod')) ||
        names.some(n => n.startsWith('heating.dhw.pumps.primary')) ||
        names.some(n => n === 'heating.dhw.operating.modes.electricBoost');
    }

    const caps = [
      this.isHeatPump     ? 'HeatPump' : null,
      this.hasPV          ? 'PV'       : null,
      this.hasBattery     ? 'Battery'  : null,
      this.hasWallbox     ? 'Wallbox'  : null,
      this.hasElectricDHW ? 'ElecDHW'  : null,
    ].filter(Boolean).join(', ') || 'none';
    this.platform.log.info(`${tag} Capabilities detected: ${caps}`);
    this.platform.log.debug(`${tag}    isHeatPump   : ${this.isHeatPump}`);
    this.platform.log.debug(`${tag}    PV/Solar     : ${this.hasPV}`);
    this.platform.log.debug(`${tag}    Battery      : ${this.hasBattery}`);
    this.platform.log.debug(`${tag}    Wallbox/EV   : ${this.hasWallbox}`);
    this.platform.log.debug(`${tag}    Electric DHW : ${this.hasElectricDHW}`);
  }

  /**
   * Tries multiple known path variants for heat pump features.
   * Whichever variant exists in the feature list is stored for later use.
   * Unknown devices will show all paths as empty → logged, visible in dump.
   */
  private resolveHeatPumpPaths(names: string[]): void {
    const tag = '[EnergyAccessory][HP]';

    const pick = (...candidates: string[]): string =>
      candidates.find(c => names.includes(c)) ?? '';

    this.hpPaths.compressorActive = pick(
      'heating.compressors.0',
      'heating.compressor.0',
      'heating.compressor',
      'heating.heatpump.operating.state',
      'heating.heatpump.status',
    );
    this.hpPaths.compressorMod = pick(
      'heating.compressors.0.speed.current',
      'heating.compressor.0.statistics',
      'heating.compressor.statistics',
      'heating.heatpump.statistics',
    );
    this.hpPaths.outsideTemp = pick(
      'heating.sensors.temperature.outside',
      'heating.heatpump.sensors.temperature.outside',
      'heating.outdoor.sensors.temperature',
    );
    this.hpPaths.supplyTemp = pick(
      'heating.circuits.0.sensors.temperature.supply',
      'heating.primaryCircuit.sensors.temperature.supply',
      'heating.heatpump.sensors.temperature.flow',
    );
    this.hpPaths.returnTemp = pick(
      'heating.sensors.temperature.return',
      'heating.secondaryCircuit.sensors.temperature.return',
      'heating.primaryCircuit.sensors.temperature.return',
      'heating.heatpump.sensors.temperature.return',
      'heating.circuits.0.sensors.temperature.return',
    );
    this.hpPaths.cop = pick(
      'heating.scop.heating',
      'heating.spf.heating',
      'heating.scop.total',
      'heating.heatpump.cop',
      'heating.compressor.0.cop',
    );

    this.platform.log.debug(`${tag} Resolved paths:`);
    for (const [key, val] of Object.entries(this.hpPaths)) {
      const status = val ? `✓ ${val}` : '✗ not found';
      this.platform.log.debug(`${tag}   ${key.padEnd(18)}: ${status}`);
    }
  }

  // ── Service creation ───────────────────────────────────────────────────────

  private setupServices(): void {
    if (this.isHeatPump) {
      this.setupHeatPumpServices();
    } else {
      if (this.hasPV)          { this.setupPVServices(); }
      if (this.hasBattery)     { this.setupBatteryServices(); }
      if (this.hasWallbox)     { this.setupWallboxServices(); }
      if (this.hasElectricDHW) { this.setupElectricDHWService(); }
    }

    if (!this.isHeatPump && !this.hasPV && !this.hasBattery && !this.hasWallbox && !this.hasElectricDHW) {
      this.platform.log.warn(
        `[EnergyAccessory] No known features detected for device ${this.device.id}. ` +
        'Review the FULL FEATURE DUMP above and report to the plugin maintainer.',
      );
    }
  }

  // ── Heat pump services ────────────────────────────────────────────────────

  private setupHeatPumpServices(): void {
    // Main HeaterCooler: represents the compressor unit
    this.heatpumpService =
      this.accessory.getService('Heat Pump') ||
      this.accessory.addService(this.platform.Service.HeaterCooler, 'Heat Pump', 'heatpump-main');

    this.heatpumpService.setCharacteristic(this.platform.Characteristic.Name, 'Heat Pump');

    this.heatpumpService
      .getCharacteristic(this.platform.Characteristic.Active)
      .onGet(() =>
        this.states.hpActive
          ? this.platform.Characteristic.Active.ACTIVE
          : this.platform.Characteristic.Active.INACTIVE,
      )
      .onSet(async () => {
        // Read-only — restore
        setTimeout(() => {
          this.heatpumpService!
            .getCharacteristic(this.platform.Characteristic.Active)
            .updateValue(
              this.states.hpActive
                ? this.platform.Characteristic.Active.ACTIVE
                : this.platform.Characteristic.Active.INACTIVE,
            );
        }, 300);
      });

    this.heatpumpService
      .getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
      .onGet(() => {
        if (!this.states.hpActive) {
          return this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE;
        }
        return this.states.hpHeatingState === 2
          ? this.platform.Characteristic.CurrentHeaterCoolerState.HEATING
          : this.platform.Characteristic.CurrentHeaterCoolerState.IDLE;
      });

    this.heatpumpService
      .getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
      .setProps({ validValues: [this.platform.Characteristic.TargetHeaterCoolerState.HEAT] })
      .onGet(() => this.platform.Characteristic.TargetHeaterCoolerState.HEAT)
      .onSet(async () => { /* fixed */ });

    this.heatpumpService
      .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(() => this.states.hpCurrentTemp);

    this.heatpumpService
      .getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
      .setProps({ minValue: -30, maxValue: 50, minStep: 0.5 })
      .onGet(() => this.states.hpOutsideTemp);

    // COP as Lightbulb brightness (COP 1.0→5.0 mapped to 20→100%)
    this.heatpumpCOPService =
      this.accessory.getService('COP') ||
      this.accessory.addService(this.platform.Service.Lightbulb, 'COP', 'heatpump-cop');

    this.heatpumpCOPService.setCharacteristic(this.platform.Characteristic.Name, 'COP');

    this.heatpumpCOPService
      .getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.states.hpActive)
      .onSet(async () => {
        setTimeout(() => {
          this.heatpumpCOPService!
            .getCharacteristic(this.platform.Characteristic.On)
            .updateValue(this.states.hpActive);
        }, 300);
      });

    this.heatpumpCOPService
      .getCharacteristic(this.platform.Characteristic.Brightness)
      .onGet(() => Math.min(100, Math.round(this.states.hpCOP * 20)))  // COP 5 = 100%
      .onSet(async () => {
        setTimeout(() => {
          this.heatpumpCOPService!
            .getCharacteristic(this.platform.Characteristic.Brightness)
            .updateValue(Math.min(100, Math.round(this.states.hpCOP * 20)));
        }, 300);
      });

    this.platform.log.debug('[EnergyAccessory] Heat pump services created');
  }

  // ── PV ─────────────────────────────────────────────────────────────────────

  private setupPVServices(): void {
    this.pvProductionService =
      this.accessory.getService('PV Production') ||
      this.accessory.addService(this.platform.Service.Lightbulb, 'PV Production', 'pv-production');

    this.pvProductionService.setCharacteristic(this.platform.Characteristic.Name, 'PV Production');

    this.pvProductionService
      .getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.states.pvActive)
      .onSet(async () => {
        setTimeout(() => {
          this.pvProductionService!
            .getCharacteristic(this.platform.Characteristic.On)
            .updateValue(this.states.pvActive);
        }, 300);
      });

    this.pvProductionService
      .getCharacteristic(this.platform.Characteristic.Brightness)
      .onGet(() => this.states.pvProductionPercent)
      .onSet(async () => {
        setTimeout(() => {
          this.pvProductionService!
            .getCharacteristic(this.platform.Characteristic.Brightness)
            .updateValue(this.states.pvProductionPercent);
        }, 300);
      });

    this.platform.log.debug('[EnergyAccessory] PV Production service created');
  }

  // ── Battery ────────────────────────────────────────────────────────────────

  private setupBatteryServices(): void {
    this.batteryService =
      this.accessory.getService(this.platform.Service.Battery) ||
      this.accessory.addService(this.platform.Service.Battery, 'Battery Storage', 'battery-storage');

    this.batteryService.setCharacteristic(this.platform.Characteristic.Name, 'Battery Storage');

    this.batteryService
      .getCharacteristic(this.platform.Characteristic.BatteryLevel)
      .onGet(() => this.states.batteryLevelPercent);

    this.batteryService
      .getCharacteristic(this.platform.Characteristic.ChargingState)
      .onGet(() =>
        this.states.batteryCharging
          ? this.platform.Characteristic.ChargingState.CHARGING
          : this.platform.Characteristic.ChargingState.NOT_CHARGING,
      );

    this.batteryService
      .getCharacteristic(this.platform.Characteristic.StatusLowBattery)
      .onGet(() =>
        this.states.batteryStatusLow
          ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
      );

    this.batteryPowerService =
      this.accessory.getService('Battery Power') ||
      this.accessory.addService(this.platform.Service.Lightbulb, 'Battery Power', 'battery-power');

    this.batteryPowerService.setCharacteristic(this.platform.Characteristic.Name, 'Battery Power');

    this.batteryPowerService
      .getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.states.batteryCharging || this.states.batteryDischargingW > 0)
      .onSet(async () => {
        setTimeout(() => {
          this.batteryPowerService!
            .getCharacteristic(this.platform.Characteristic.On)
            .updateValue(this.states.batteryCharging || this.states.batteryDischargingW > 0);
        }, 300);
      });

    this.batteryPowerService
      .getCharacteristic(this.platform.Characteristic.Brightness)
      .onGet(() => {
        const power = this.states.batteryCharging ? this.states.batteryChargingW : this.states.batteryDischargingW;
        return Math.min(100, Math.round(power / 50));
      })
      .onSet(async () => {
        setTimeout(() => {
          const power = this.states.batteryCharging ? this.states.batteryChargingW : this.states.batteryDischargingW;
          this.batteryPowerService!
            .getCharacteristic(this.platform.Characteristic.Brightness)
            .updateValue(Math.min(100, Math.round(power / 50)));
        }, 300);
      });

    this.platform.log.debug('[EnergyAccessory] Battery services created');
  }

  // ── Wallbox ────────────────────────────────────────────────────────────────

  private setupWallboxServices(): void {
    this.wallboxService =
      this.accessory.getService('EV Charging') ||
      this.accessory.addService(this.platform.Service.Switch, 'EV Charging', 'wallbox-charging');

    this.wallboxService.setCharacteristic(this.platform.Characteristic.Name, 'EV Charging');

    this.wallboxService
      .getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.states.wallboxChargingActive)
      .onSet(async (value: CharacteristicValue) => {
        await this.setWallboxCharging(value as boolean);
      });

    this.wallboxOutletService =
      this.accessory.getService('EV Plugged In') ||
      this.accessory.addService(this.platform.Service.Outlet, 'EV Plugged In', 'wallbox-outlet');

    this.wallboxOutletService.setCharacteristic(this.platform.Characteristic.Name, 'EV Plugged In');

    this.wallboxOutletService
      .getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.states.wallboxPluggedIn)
      .onSet(async () => {
        setTimeout(() => {
          this.wallboxOutletService!
            .getCharacteristic(this.platform.Characteristic.On)
            .updateValue(this.states.wallboxPluggedIn);
        }, 300);
      });

    this.wallboxOutletService
      .getCharacteristic(this.platform.Characteristic.OutletInUse)
      .onGet(() => this.states.wallboxChargingActive);

    this.platform.log.debug('[EnergyAccessory] Wallbox services created');
  }

  // ── Electric DHW heater ────────────────────────────────────────────────────

  private setupElectricDHWService(): void {
    this.electricDHWService =
      this.accessory.getService('Electric Hot Water') ||
      this.accessory.addService(
        this.platform.Service.HeaterCooler, 'Electric Hot Water', 'electric-dhw',
      );

    this.electricDHWService.setCharacteristic(
      this.platform.Characteristic.Name, 'Electric Hot Water',
    );

    this.electricDHWService
      .getCharacteristic(this.platform.Characteristic.Active)
      .onGet(() =>
        this.states.electricDHWActive
          ? this.platform.Characteristic.Active.ACTIVE
          : this.platform.Characteristic.Active.INACTIVE,
      )
      .onSet(async (value: CharacteristicValue) => {
        await this.setElectricDHWActive(value === this.platform.Characteristic.Active.ACTIVE);
      });

    this.electricDHWService
      .getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
      .onGet(() => {
        if (!this.states.electricDHWActive) {
          return this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE;
        }
        return this.states.electricDHWHeatingState === 1
          ? this.platform.Characteristic.CurrentHeaterCoolerState.HEATING
          : this.platform.Characteristic.CurrentHeaterCoolerState.IDLE;
      });

    this.electricDHWService
      .getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
      .setProps({ validValues: [this.platform.Characteristic.TargetHeaterCoolerState.HEAT] })
      .onGet(() => this.platform.Characteristic.TargetHeaterCoolerState.HEAT)
      .onSet(async () => { /* fixed to HEAT */ });

    this.electricDHWService
      .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(() => this.states.electricDHWCurrentTemp);

    this.electricDHWService
      .getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
      .setProps({ minValue: 10, maxValue: 85, minStep: 1 })
      .onGet(() => this.states.electricDHWTargetTemp)
      .onSet(async (value: CharacteristicValue) => {
        await this.setElectricDHWTemperature(value as number);
      });

    this.platform.log.debug('[EnergyAccessory] Electric DHW service created');
  }

  // ── Data update ────────────────────────────────────────────────────────────

  public async handleUpdate(): Promise<void> {
    try {
      const features = await this.platform.viessmannAPI.getDeviceFeatures(
        this.installation.id,
        this.gateway.serial,
        this.device.id,
      );
      await this.updateFromFeatures(features);
    } catch (error) {
      this.platform.log.warn(`[EnergyAccessory] Update failed for ${this.device.id}:`, error);
    }
  }

  private async updateFromFeatures(features: any[]): Promise<void> {
    const get = (name: string) => features.find(f => f.feature === name);
    const tag = '[EnergyAccessory]';

    if (this.isHeatPump) {
      await this.updateHeatPump(features, get, tag);
    } else {
      await this.updateEnergyDevices(features, get, tag);
    }
  }

  // ── Heat pump update ───────────────────────────────────────────────────────

  private async updateHeatPump(
    features: any[],
    get: (name: string) => any,
    tag: string,
  ): Promise<void> {

    // Compressor active state
    if (this.hpPaths.compressorActive) {
      const f = get(this.hpPaths.compressorActive);
      if (f) {
        // heating.compressors.0 has an 'active' boolean property
        const active =
          f.properties?.active?.value === true ||
          f.properties?.status?.value === 'on' ||
          f.properties?.status?.value === 'active' ||
          f.properties?.value?.value === 'on';
        this.states.hpActive = active;
        this.states.hpHeatingState = active ? 2 : 1;
        this.platform.log.debug(`${tag}[HP] compressor active=${active} raw=${JSON.stringify(f.properties)}`);
      }
    } else {
      // Path unknown — try generic compressor scan
      const anyCompressor = features.find(f =>
        f.feature.includes('compressor') || f.feature.includes('heatpump'),
      );
      if (anyCompressor) {
        this.platform.log.info(
          `${tag}[HP] Unknown compressor path — found candidate: ${anyCompressor.feature} ` +
          `props=${JSON.stringify(anyCompressor.properties)}`,
        );
      }
    }

    // Compressor modulation / speed
    if (this.hpPaths.compressorMod) {
      const f = get(this.hpPaths.compressorMod);
      if (f) {
        // heating.compressors.0.speed.current → value in revolutionsPerSecond
        // Normalize to 0–100%: use config.maxCompressorRps (default 50 rps for Vitocal 250A).
        // Set maxCompressorRps in plugin config if modulation shows >100% or compressed values.
        const maxRps = this.platform.config.maxCompressorRps ?? 50;
        const rps = f.properties?.value?.value ?? 0;
        this.states.hpModulation = rps > 0 ? Math.min(100, Math.round((rps / maxRps) * 100)) : 0;

        // Log setpoint alongside current for calibration visibility
        const fSetpoint = get('heating.compressors.0.speed.setpoint');
        const setpointRps = fSetpoint?.properties?.value?.value ?? null;
        this.platform.log.debug(
          `${tag}[HP] compressor current=${rps}rps setpoint=${setpointRps ?? '?'}rps` +
          ` → modulation=${this.states.hpModulation}% (maxRps=${maxRps})`,
        );

        // Warn if measured rps exceeds configured max — modulation is capped but likely wrong
        if (rps > maxRps) {
          this.platform.log.warn(
            `[HP] Compressor speed ${rps}rps exceeds maxCompressorRps=${maxRps}. ` +
            `Modulation capped at 100%. Set "maxCompressorRps": ${Math.ceil(rps * 1.2)} in plugin config to fix.`,
          );
        }
      }
    }

    // Outside temperature
    if (this.hpPaths.outsideTemp) {
      const f = get(this.hpPaths.outsideTemp);
      if (f) {
        this.states.hpOutsideTemp = f.properties?.value?.value ?? 0;
        this.states.hpCurrentTemp = this.states.hpOutsideTemp; // show outside temp in HeaterCooler
        this.platform.log.debug(`${tag}[HP] outsideTemp=${this.states.hpOutsideTemp}°C`);
      }
    }

    // Supply temperature
    if (this.hpPaths.supplyTemp) {
      const f = get(this.hpPaths.supplyTemp);
      if (f) {
        this.states.hpSupplyTemp = f.properties?.value?.value ?? 0;
        this.platform.log.debug(`${tag}[HP] supplyTemp=${this.states.hpSupplyTemp}°C`);
      }
    }

    // Return temperature
    if (this.hpPaths.returnTemp) {
      const f = get(this.hpPaths.returnTemp);
      if (f) {
        this.states.hpReturnTemp = f.properties?.value?.value ?? 0;
        this.platform.log.debug(`${tag}[HP] returnTemp=${this.states.hpReturnTemp}°C`);
      }
    }

    // COP
    if (this.hpPaths.cop) {
      const f = get(this.hpPaths.cop);
      if (f) {
        this.states.hpCOP = f.properties?.value?.value ?? 0;
        this.platform.log.debug(`${tag}[HP] COP=${this.states.hpCOP}`);
      }
    }

    this.platform.log.info(
      `${tag}[HP] active=${this.states.hpActive} outside=${this.states.hpOutsideTemp}°C ` +
      `supply=${this.states.hpSupplyTemp}°C return=${this.states.hpReturnTemp}°C COP=${this.states.hpCOP}`,
    );

    // Push to HomeKit
    if (this.heatpumpService) {
      this.heatpumpService
        .getCharacteristic(this.platform.Characteristic.Active)
        .updateValue(
          this.states.hpActive
            ? this.platform.Characteristic.Active.ACTIVE
            : this.platform.Characteristic.Active.INACTIVE,
        );
      this.heatpumpService
        .getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
        .updateValue(
          this.states.hpActive
            ? this.platform.Characteristic.CurrentHeaterCoolerState.HEATING
            : this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE,
        );
      this.heatpumpService
        .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
        .updateValue(this.states.hpOutsideTemp);
      this.heatpumpService
        .getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
        .updateValue(this.states.hpOutsideTemp);
    }

    if (this.heatpumpCOPService) {
      this.heatpumpCOPService
        .getCharacteristic(this.platform.Characteristic.On)
        .updateValue(this.states.hpActive);
      this.heatpumpCOPService
        .getCharacteristic(this.platform.Characteristic.Brightness)
        .updateValue(Math.min(100, Math.round(this.states.hpCOP * 20)));
    }
  }

  // ── Energy devices update ─────────────────────────────────────────────────

  private async updateEnergyDevices(
    features: any[],
    get: (name: string) => any,
    tag: string,
  ): Promise<void> {

    // PV
    if (this.hasPV) {
      const pvCurrent = get('heating.photovoltaic.production.current') ||
                        get('heating.solar.power.production');
      const pvDaily   = get('heating.photovoltaic.production.day') ||
                        get('heating.solar.power.production.day');

      if (pvCurrent) {
        this.states.pvProductionW       = pvCurrent.properties?.value?.value ?? 0;
        this.states.pvProductionPercent = Math.min(100, Math.round(this.states.pvProductionW / 100));
        this.states.pvActive            = this.states.pvProductionW > 10;
        this.platform.log.info(`${tag} PV → ${this.states.pvProductionW}W (${this.states.pvProductionPercent}%)`);
      }
      if (pvDaily) {
        this.states.pvDailyYieldKwh = pvDaily.properties?.value?.value ?? 0;
        this.platform.log.debug(`${tag} PV → dailyYield=${this.states.pvDailyYieldKwh}kWh`);
      }

      this.pvProductionService?.getCharacteristic(this.platform.Characteristic.On)
        .updateValue(this.states.pvActive);
      this.pvProductionService?.getCharacteristic(this.platform.Characteristic.Brightness)
        .updateValue(this.states.pvProductionPercent);
    }

    // Battery
    if (this.hasBattery) {
      const battLevel    = get('heating.powerStorage.charging.level') || get('heating.battery.level');
      const battCharging = get('heating.powerStorage.charging.power') || get('heating.battery.charging.power');
      const battDischarge= get('heating.powerStorage.discharging.power') || get('heating.battery.discharging.power');

      if (battLevel) {
        this.states.batteryLevelPercent = Math.round(battLevel.properties?.value?.value ?? 0);
        this.states.batteryStatusLow    = this.states.batteryLevelPercent < 15;
        this.platform.log.info(`${tag} Battery → ${this.states.batteryLevelPercent}% low=${this.states.batteryStatusLow}`);
      }
      if (battCharging) {
        this.states.batteryChargingW = battCharging.properties?.value?.value ?? 0;
        this.states.batteryCharging  = this.states.batteryChargingW > 0;
      }
      if (battDischarge) {
        this.states.batteryDischargingW = battDischarge.properties?.value?.value ?? 0;
      }

      if (this.batteryService) {
        this.batteryService.getCharacteristic(this.platform.Characteristic.BatteryLevel)
          .updateValue(this.states.batteryLevelPercent);
        this.batteryService.getCharacteristic(this.platform.Characteristic.ChargingState)
          .updateValue(
            this.states.batteryCharging
              ? this.platform.Characteristic.ChargingState.CHARGING
              : this.platform.Characteristic.ChargingState.NOT_CHARGING,
          );
        this.batteryService.getCharacteristic(this.platform.Characteristic.StatusLowBattery)
          .updateValue(
            this.states.batteryStatusLow
              ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
              : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
          );
      }
    }

    // Wallbox
    if (this.hasWallbox) {
      const evStatus  = get('charging.ev.status') || get('heating.ev.status');
      const evPower   = get('charging.ev.power')  || get('heating.ev.charging.power');
      const evSession = get('charging.ev.session.charged') || get('heating.ev.session.energy');

      if (evStatus) {
        const status = evStatus.properties?.status?.value ?? '';
        this.states.wallboxPluggedIn      = ['plugged', 'charging', 'connected'].includes(status.toLowerCase());
        this.states.wallboxChargingActive = status.toLowerCase() === 'charging';
        this.platform.log.info(`${tag} Wallbox → status="${status}" pluggedIn=${this.states.wallboxPluggedIn} charging=${this.states.wallboxChargingActive}`);
      }
      if (evPower) {
        this.states.wallboxChargingPowerW = evPower.properties?.value?.value ?? 0;
      }
      if (evSession) {
        this.states.wallboxEnergySessionKwh = evSession.properties?.value?.value ?? 0;
      }

      this.wallboxService?.getCharacteristic(this.platform.Characteristic.On)
        .updateValue(this.states.wallboxChargingActive);
      this.wallboxOutletService?.getCharacteristic(this.platform.Characteristic.On)
        .updateValue(this.states.wallboxPluggedIn);
      this.wallboxOutletService?.getCharacteristic(this.platform.Characteristic.OutletInUse)
        .updateValue(this.states.wallboxChargingActive);
    }

    // Electric DHW
    if (this.hasElectricDHW) {
      const dhwTemp   = get('heating.dhw.sensors.temperature.hotWaterStorage') ||
                        get('heating.dhw.temperature.main');
      const dhwTarget = get('heating.dhw.temperature.main');
      const dhwRod    = get('heating.dhw.heating.rod.status') ||
                        get('heating.dhw.operating.modes.electricBoost');

      if (dhwTemp) {
        this.states.electricDHWCurrentTemp = dhwTemp.properties?.value?.value ?? 20;
      }
      if (dhwTarget) {
        this.states.electricDHWTargetTemp = dhwTarget.properties?.value?.value ?? 55;
      }
      if (dhwRod) {
        const rodActive =
          dhwRod.properties?.status?.value === 'on' ||
          dhwRod.properties?.value?.value === 'electricBoost' ||
          dhwRod.properties?.active?.value === true;
        this.states.electricDHWActive       = rodActive;
        this.states.electricDHWHeatingState = rodActive ? 1 : 0;
        this.platform.log.info(`${tag} ElecDHW → active=${rodActive} temp=${this.states.electricDHWCurrentTemp}°C`);
      }

      if (this.electricDHWService) {
        this.electricDHWService.getCharacteristic(this.platform.Characteristic.Active)
          .updateValue(
            this.states.electricDHWActive
              ? this.platform.Characteristic.Active.ACTIVE
              : this.platform.Characteristic.Active.INACTIVE,
          );
        this.electricDHWService.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
          .updateValue(this.states.electricDHWCurrentTemp);
        this.electricDHWService.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
          .updateValue(this.states.electricDHWTargetTemp);
      }
    }
  }

  // ── Commands ───────────────────────────────────────────────────────────────

  private async setWallboxCharging(enable: boolean): Promise<void> {
    try {
      const success = await this.platform.viessmannAPI.executeCommand(
        this.installation.id,
        this.gateway.serial,
        this.device.id,
        'charging.ev',
        enable ? 'start' : 'stop',
        {},
      );
      if (success) {
        this.states.wallboxChargingActive = enable;
        this.platform.log.info(`[EnergyAccessory] Wallbox charging ${enable ? 'started' : 'stopped'}`);
      }
    } catch (error) {
      this.platform.log.error('[EnergyAccessory] Failed to set wallbox charging:', error);
    }
  }

  private async setElectricDHWActive(active: boolean): Promise<void> {
    try {
      const success = await this.platform.viessmannAPI.executeCommand(
        this.installation.id,
        this.gateway.serial,
        this.device.id,
        'heating.dhw.operating.modes.active',
        'setMode',
        { mode: active ? 'electricBoost' : 'off' },
      );
      if (success) {
        this.states.electricDHWActive = active;
        this.platform.log.info(`[EnergyAccessory] Electric DHW ${active ? 'activated' : 'deactivated'}`);
      }
    } catch (error) {
      this.platform.log.error('[EnergyAccessory] Failed to set electric DHW active:', error);
    }
  }

  private async setElectricDHWTemperature(temperature: number): Promise<void> {
    try {
      const success = await this.platform.viessmannAPI.setDHWTemperature(
        this.installation.id,
        this.gateway.serial,
        this.device.id,
        temperature,
      );
      if (success) {
        this.states.electricDHWTargetTemp = temperature;
        this.platform.log.info(`[EnergyAccessory] Electric DHW temp set to ${temperature}°C`);
      }
    } catch (error) {
      this.platform.log.error('[EnergyAccessory] Failed to set electric DHW temperature:', error);
    }
  }
}
