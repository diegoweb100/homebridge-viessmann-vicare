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
 * Handles energy-related Viessmann devices:
 *  - Vitocharge VX3 / photovoltaic system  (heating.solar / heating.photovoltaic)
 *  - Battery storage                        (heating.buffer / heating.powerStorage)
 *  - Wallbox / EV charger                  (charging.ev.*)
 *  - Electric DHW heater                   (heating.dhw.heating.*)
 *
 * HomeKit mapping:
 *  - PV production      → Lightbulb (Brightness = watts %)
 *  - Battery level      → Battery service
 *  - Grid feed-in       → Switch (read-only via Eve-like sensor)
 *  - Wallbox charging   → Switch (on/off) + Outlet
 *  - Electric DHW       → HeaterCooler
 */
export class ViessmannEnergyAccessory {

  // ── Services ──────────────────────────────────────────────────────────────
  private informationService: Service;

  // PV / Solar
  private pvProductionService?: Service;       // Lightbulb – brightness = production %
  private pvStatusService?: Service;           // TemperatureSensor re-used for watt value

  // Battery
  private batteryService?: Service;            // Battery
  private batteryPowerService?: Service;       // Lightbulb – brightness = charge/discharge %

  // Wallbox
  private wallboxService?: Service;            // Switch – charging on/off
  private wallboxOutletService?: Service;      // Outlet  – present = plugged in

  // Electric DHW heater
  private electricDHWService?: Service;        // HeaterCooler

  // ── Capabilities flags ────────────────────────────────────────────────────
  private hasPV = false;
  private hasBattery = false;
  private hasWallbox = false;
  private hasElectricDHW = false;

  // ── State cache ───────────────────────────────────────────────────────────
  private states = {
    // PV
    pvProductionW: 0,
    pvProductionPercent: 0,       // 0-100 mapped to Brightness
    pvActive: false,
    pvDailyYieldKwh: 0,

    // Battery
    batteryLevelPercent: 0,       // 0-100
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
    electricDHWHeatingState: 0,   // 0=OFF, 1=HEAT
  };

  constructor(
    private readonly platform: ViessmannPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly installation: ViessmannInstallation,
    private readonly gateway: ViessmannGateway,
    private readonly device: ViessmannDevice,
  ) {
    // ── Accessory Information ───────────────────────────────────────────────
    this.informationService =
      this.accessory.getService(this.platform.Service.AccessoryInformation)!;
    this.informationService
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Viessmann')
      .setCharacteristic(this.platform.Characteristic.Model, device.modelId || 'Energy System')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, gateway.serial)
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, '1.0.0');

    // Register update handler so platform can call handleUpdate()
    this.accessory.context.updateHandler = this.handleUpdate.bind(this);

    // Discover capabilities and build services
    this.initializeCapabilities();
  }

  // ── Capability discovery ───────────────────────────────────────────────────
  private async initializeCapabilities(): Promise<void> {
    try {
      const features = await this.platform.viessmannAPI.getDeviceFeatures(
        this.installation.id,
        this.gateway.serial,
        this.device.id,
      );

      this.detectCapabilities(features);
      this.setupServices();
      await this.updateFromFeatures(features);

    } catch (error) {
      this.platform.log.error(
        `[EnergyAccessory] Error initializing capabilities for ${this.device.id}:`, error,
      );
      // Fallback: build services without data
      this.setupServices();
    }
  }

  private detectCapabilities(features: any[]): void {
    const names = features.map(f => f.feature);

    // ── Log ALL features for analysis ─────────────────────────────────────
    this.platform.log.info('[EnergyAccessory] ── Feature scan start ─────────────────────────');
    this.platform.log.info(`[EnergyAccessory] Total features available: ${names.length}`);

    const energyRelated = features.filter(f =>
      f.feature.startsWith('heating.photovoltaic') ||
      f.feature.startsWith('heating.solar') ||
      f.feature.startsWith('heating.powerStorage') ||
      f.feature.startsWith('heating.battery') ||
      f.feature.startsWith('heating.buffer') ||
      f.feature.startsWith('charging.ev') ||
      f.feature.startsWith('heating.ev') ||
      f.feature.startsWith('heating.dhw.heating') ||
      f.feature === 'heating.dhw.operating.modes.electricBoost'
    );

    if (energyRelated.length > 0) {
      this.platform.log.info(`[EnergyAccessory] Energy-related features found (${energyRelated.length}):`);
      energyRelated.forEach(f => {
        this.platform.log.info(
          `[EnergyAccessory]   • ${f.feature} | enabled=${f.isEnabled} | ready=${f.isReady} | ` +
          `properties=${JSON.stringify(f.properties)} | commands=${JSON.stringify(Object.keys(f.commands || {}))}`,
        );
      });
    } else {
      this.platform.log.info('[EnergyAccessory] No energy-related features found.');
      this.platform.log.info('[EnergyAccessory] Full feature list for analysis:');
      names.forEach(n => this.platform.log.info(`[EnergyAccessory]   - ${n}`));
    }
    this.platform.log.info('[EnergyAccessory] ── Feature scan end ──────────────────────────');

    // PV / Solar
    this.hasPV =
      names.some(n => n.startsWith('heating.photovoltaic')) ||
      names.some(n => n.startsWith('heating.solar.power')) ||
      names.some(n => n === 'heating.solar');

    // Battery / power storage
    this.hasBattery =
      names.some(n => n.startsWith('heating.powerStorage')) ||
      names.some(n => n.startsWith('heating.buffer.')) ||
      names.some(n => n.startsWith('heating.battery'));

    // Wallbox / EV charging
    this.hasWallbox =
      names.some(n => n.startsWith('charging.ev')) ||
      names.some(n => n.startsWith('heating.ev'));

    // Electric DHW heater
    this.hasElectricDHW =
      names.some(n => n.startsWith('heating.dhw.heating.rod')) ||
      names.some(n => n.startsWith('heating.dhw.pumps.primary')) ||
      names.some(n => n === 'heating.dhw.operating.modes.electricBoost');

    this.platform.log.info('[EnergyAccessory] ── Capability result ──────────────────────────');
    this.platform.log.info(`[EnergyAccessory]   PV/Solar    : ${this.hasPV}`);
    this.platform.log.info(`[EnergyAccessory]   Battery     : ${this.hasBattery}`);
    this.platform.log.info(`[EnergyAccessory]   Wallbox/EV  : ${this.hasWallbox}`);
    this.platform.log.info(`[EnergyAccessory]   Electric DHW: ${this.hasElectricDHW}`);
    this.platform.log.info('[EnergyAccessory] ─────────────────────────────────────────────────');
  }

  // ── Service creation ───────────────────────────────────────────────────────
  private setupServices(): void {
    if (this.hasPV) {
      this.setupPVServices();
    }
    if (this.hasBattery) {
      this.setupBatteryServices();
    }
    if (this.hasWallbox) {
      this.setupWallboxServices();
    }
    if (this.hasElectricDHW) {
      this.setupElectricDHWService();
    }

    if (!this.hasPV && !this.hasBattery && !this.hasWallbox && !this.hasElectricDHW) {
      this.platform.log.warn(
        `[EnergyAccessory] No energy features detected for device ${this.device.id}. ` +
        'Check that the device is online and the API returns features.',
      );
    }
  }

  // ── PV ─────────────────────────────────────────────────────────────────────
  private setupPVServices(): void {
    // Use Lightbulb: On = producing, Brightness = production as % of peak
    this.pvProductionService =
      this.accessory.getService('PV Production') ||
      this.accessory.addService(this.platform.Service.Lightbulb, 'PV Production', 'pv-production');

    this.pvProductionService.setCharacteristic(
      this.platform.Characteristic.Name, 'PV Production',
    );

    this.pvProductionService
      .getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.states.pvActive)
      .onSet(async () => {
        // Read-only: restore previous state
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
        // Read-only: restore previous state
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
    // Battery service: level + charging state
    this.batteryService =
      this.accessory.getService(this.platform.Service.Battery) ||
      this.accessory.addService(this.platform.Service.Battery, 'Battery Storage', 'battery-storage');

    this.batteryService.setCharacteristic(
      this.platform.Characteristic.Name, 'Battery Storage',
    );

    this.batteryService
      .getCharacteristic(this.platform.Characteristic.BatteryLevel)
      .onGet(() => this.states.batteryLevelPercent);

    this.batteryService
      .getCharacteristic(this.platform.Characteristic.ChargingState)
      .onGet(() => {
        if (this.states.batteryCharging) {
          return this.platform.Characteristic.ChargingState.CHARGING;
        }
        return this.platform.Characteristic.ChargingState.NOT_CHARGING;
      });

    this.batteryService
      .getCharacteristic(this.platform.Characteristic.StatusLowBattery)
      .onGet(() =>
        this.states.batteryStatusLow
          ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
      );

    // Lightbulb to show charge/discharge power as brightness
    this.batteryPowerService =
      this.accessory.getService('Battery Power') ||
      this.accessory.addService(this.platform.Service.Lightbulb, 'Battery Power', 'battery-power');

    this.batteryPowerService.setCharacteristic(
      this.platform.Characteristic.Name, 'Battery Power',
    );

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
        const power = this.states.batteryCharging
          ? this.states.batteryChargingW
          : this.states.batteryDischargingW;
        return Math.min(100, Math.round(power / 50)); // 5000W peak → 100%
      })
      .onSet(async () => {
        setTimeout(() => {
          const power = this.states.batteryCharging
            ? this.states.batteryChargingW
            : this.states.batteryDischargingW;
          this.batteryPowerService!
            .getCharacteristic(this.platform.Characteristic.Brightness)
            .updateValue(Math.min(100, Math.round(power / 50)));
        }, 300);
      });

    this.platform.log.debug('[EnergyAccessory] Battery services created');
  }

  // ── Wallbox ────────────────────────────────────────────────────────────────
  private setupWallboxServices(): void {
    // Switch: enable/disable charging
    this.wallboxService =
      this.accessory.getService('EV Charging') ||
      this.accessory.addService(this.platform.Service.Switch, 'EV Charging', 'wallbox-charging');

    this.wallboxService.setCharacteristic(
      this.platform.Characteristic.Name, 'EV Charging',
    );

    this.wallboxService
      .getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.states.wallboxChargingActive)
      .onSet(async (value: CharacteristicValue) => {
        await this.setWallboxCharging(value as boolean);
      });

    // Outlet: plugged in status
    this.wallboxOutletService =
      this.accessory.getService('EV Plugged In') ||
      this.accessory.addService(this.platform.Service.Outlet, 'EV Plugged In', 'wallbox-outlet');

    this.wallboxOutletService.setCharacteristic(
      this.platform.Characteristic.Name, 'EV Plugged In',
    );

    this.wallboxOutletService
      .getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.states.wallboxPluggedIn)
      .onSet(async () => {
        // Read-only
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

    // Active
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

    // Current heater state
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

    // Target heater state — HEAT only
    this.electricDHWService
      .getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
      .setProps({
        validValues: [this.platform.Characteristic.TargetHeaterCoolerState.HEAT],
      })
      .onGet(() => this.platform.Characteristic.TargetHeaterCoolerState.HEAT)
      .onSet(async () => { /* fixed to HEAT */ });

    // Current temperature
    this.electricDHWService
      .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(() => this.states.electricDHWCurrentTemp);

    // Heating threshold = target temperature
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
    const get = (featureName: string) => features.find(f => f.feature === featureName);

    this.platform.log.debug(`[EnergyAccessory] updateFromFeatures — ${features.length} features, device=${this.device.id}`);

    // ── PV ──────────────────────────────────────────────────────────────────
    if (this.hasPV) {
      // Vitocharge VX3 / Vitovolt 300: heating.photovoltaic.production.current
      const pvCurrent = get('heating.photovoltaic.production.current') ||
                        get('heating.solar.power.production');
      const pvStatus  = get('heating.photovoltaic.status') ||
                        get('heating.solar.sensors.temperature.collector');

      this.platform.log.debug(`[EnergyAccessory] PV: pvCurrent feature=${pvCurrent?.feature ?? 'not found'} raw=${JSON.stringify(pvCurrent?.properties)}`);
      if (pvCurrent) {
        this.states.pvProductionW = pvCurrent.properties?.value?.value ?? 0;
        // Assume 10 kW peak system → express as percentage
        this.states.pvProductionPercent = Math.min(100, Math.round(this.states.pvProductionW / 100));
        this.states.pvActive = this.states.pvProductionW > 10;
        this.platform.log.info(`[EnergyAccessory] PV → production=${this.states.pvProductionW}W (${this.states.pvProductionPercent}%) active=${this.states.pvActive}`);
      }

      // Daily yield
      const pvDaily = get('heating.photovoltaic.production.day') ||
                      get('heating.solar.power.production.day');
      this.platform.log.debug(`[EnergyAccessory] PV: pvDaily feature=${pvDaily?.feature ?? 'not found'} raw=${JSON.stringify(pvDaily?.properties)}`);
      if (pvDaily) {
        this.states.pvDailyYieldKwh = pvDaily.properties?.value?.value ?? 0;
        this.platform.log.info(`[EnergyAccessory] PV → dailyYield=${this.states.pvDailyYieldKwh}kWh`);
      }

      if (this.pvProductionService) {
        this.pvProductionService
          .getCharacteristic(this.platform.Characteristic.On)
          .updateValue(this.states.pvActive);
        this.pvProductionService
          .getCharacteristic(this.platform.Characteristic.Brightness)
          .updateValue(this.states.pvProductionPercent);
      }
    }

    // ── Battery ──────────────────────────────────────────────────────────────
    if (this.hasBattery) {
      const battLevel    = get('heating.powerStorage.charging.level') ||
                           get('heating.battery.level');
      const battCharging = get('heating.powerStorage.charging.power') ||
                           get('heating.battery.charging.power');
      const battDischarge = get('heating.powerStorage.discharging.power') ||
                            get('heating.battery.discharging.power');

      this.platform.log.debug(`[EnergyAccessory] Battery: level feature=${battLevel?.feature ?? 'not found'} raw=${JSON.stringify(battLevel?.properties)}`);
      this.platform.log.debug(`[EnergyAccessory] Battery: charging feature=${battCharging?.feature ?? 'not found'} raw=${JSON.stringify(battCharging?.properties)}`);
      this.platform.log.debug(`[EnergyAccessory] Battery: discharge feature=${battDischarge?.feature ?? 'not found'} raw=${JSON.stringify(battDischarge?.properties)}`);
      if (battLevel) {
        this.states.batteryLevelPercent = Math.round(battLevel.properties?.value?.value ?? 0);
        this.states.batteryStatusLow = this.states.batteryLevelPercent < 15;
        this.platform.log.info(`[EnergyAccessory] Battery → level=${this.states.batteryLevelPercent}% low=${this.states.batteryStatusLow}`);
      }
      if (battCharging) {
        this.states.batteryChargingW = battCharging.properties?.value?.value ?? 0;
        this.states.batteryCharging = this.states.batteryChargingW > 0;
        this.platform.log.info(`[EnergyAccessory] Battery → charging=${this.states.batteryCharging} power=${this.states.batteryChargingW}W`);
      }
      if (battDischarge) {
        this.states.batteryDischargingW = battDischarge.properties?.value?.value ?? 0;
        this.platform.log.info(`[EnergyAccessory] Battery → discharging=${this.states.batteryDischargingW}W`);
      }

      if (this.batteryService) {
        this.batteryService
          .getCharacteristic(this.platform.Characteristic.BatteryLevel)
          .updateValue(this.states.batteryLevelPercent);
        this.batteryService
          .getCharacteristic(this.platform.Characteristic.ChargingState)
          .updateValue(
            this.states.batteryCharging
              ? this.platform.Characteristic.ChargingState.CHARGING
              : this.platform.Characteristic.ChargingState.NOT_CHARGING,
          );
        this.batteryService
          .getCharacteristic(this.platform.Characteristic.StatusLowBattery)
          .updateValue(
            this.states.batteryStatusLow
              ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
              : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
          );
      }
    }

    // ── Wallbox ───────────────────────────────────────────────────────────────
    if (this.hasWallbox) {
      const evStatus  = get('charging.ev.status') || get('heating.ev.status');
      const evPower   = get('charging.ev.power')  || get('heating.ev.charging.power');
      const evSession = get('charging.ev.session.charged') || get('heating.ev.session.energy');

      this.platform.log.debug(`[EnergyAccessory] Wallbox: status feature=${evStatus?.feature ?? 'not found'} raw=${JSON.stringify(evStatus?.properties)}`);
      this.platform.log.debug(`[EnergyAccessory] Wallbox: power feature=${evPower?.feature ?? 'not found'} raw=${JSON.stringify(evPower?.properties)}`);
      if (evStatus) {
        const status = evStatus.properties?.status?.value ?? '';
        this.states.wallboxPluggedIn = ['plugged', 'charging', 'connected'].includes(
          status.toLowerCase(),
        );
        this.states.wallboxChargingActive = status.toLowerCase() === 'charging';
        this.platform.log.info(`[EnergyAccessory] Wallbox → status="${status}" pluggedIn=${this.states.wallboxPluggedIn} charging=${this.states.wallboxChargingActive}`);
      }
      if (evPower) {
        this.states.wallboxChargingPowerW = evPower.properties?.value?.value ?? 0;
        this.platform.log.info(`[EnergyAccessory] Wallbox → chargingPower=${this.states.wallboxChargingPowerW}W`);
      }
      if (evSession) {
        this.states.wallboxEnergySessionKwh = evSession.properties?.value?.value ?? 0;
        this.platform.log.info(`[EnergyAccessory] Wallbox → sessionEnergy=${this.states.wallboxEnergySessionKwh}kWh`);
      }

      if (this.wallboxService) {
        this.wallboxService
          .getCharacteristic(this.platform.Characteristic.On)
          .updateValue(this.states.wallboxChargingActive);
      }
      if (this.wallboxOutletService) {
        this.wallboxOutletService
          .getCharacteristic(this.platform.Characteristic.On)
          .updateValue(this.states.wallboxPluggedIn);
        this.wallboxOutletService
          .getCharacteristic(this.platform.Characteristic.OutletInUse)
          .updateValue(this.states.wallboxChargingActive);
      }
    }

    // ── Electric DHW ──────────────────────────────────────────────────────────
    if (this.hasElectricDHW) {
      const dhwTemp    = get('heating.dhw.sensors.temperature.hotWaterStorage') ||
                         get('heating.dhw.temperature.main');
      const dhwTarget  = get('heating.dhw.temperature.main');
      const dhwRod     = get('heating.dhw.heating.rod.status') ||
                         get('heating.dhw.operating.modes.electricBoost');

      this.platform.log.debug(`[EnergyAccessory] ElecDHW: temp feature=${dhwTemp?.feature ?? 'not found'} raw=${JSON.stringify(dhwTemp?.properties)}`);
      this.platform.log.debug(`[EnergyAccessory] ElecDHW: target feature=${dhwTarget?.feature ?? 'not found'} raw=${JSON.stringify(dhwTarget?.properties)}`);
      this.platform.log.debug(`[EnergyAccessory] ElecDHW: rod/boost feature=${dhwRod?.feature ?? 'not found'} raw=${JSON.stringify(dhwRod?.properties)}`);
      if (dhwTemp) {
        this.states.electricDHWCurrentTemp = dhwTemp.properties?.value?.value ?? 20;
        this.platform.log.info(`[EnergyAccessory] ElecDHW → currentTemp=${this.states.electricDHWCurrentTemp}°C`);
      }
      if (dhwTarget) {
        this.states.electricDHWTargetTemp = dhwTarget.properties?.value?.value ?? 55;
        this.platform.log.info(`[EnergyAccessory] ElecDHW → targetTemp=${this.states.electricDHWTargetTemp}°C`);
      }
      if (dhwRod) {
        const rodActive = dhwRod.properties?.status?.value === 'on' ||
                          dhwRod.properties?.value?.value === 'electricBoost' ||
                          dhwRod.properties?.active?.value === true;
        this.states.electricDHWActive = rodActive;
        this.states.electricDHWHeatingState = rodActive ? 1 : 0;
        this.platform.log.info(`[EnergyAccessory] ElecDHW → active=${rodActive} heatingState=${this.states.electricDHWHeatingState}`);
      }

      if (this.electricDHWService) {
        this.electricDHWService
          .getCharacteristic(this.platform.Characteristic.Active)
          .updateValue(
            this.states.electricDHWActive
              ? this.platform.Characteristic.Active.ACTIVE
              : this.platform.Characteristic.Active.INACTIVE,
          );
        this.electricDHWService
          .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
          .updateValue(this.states.electricDHWCurrentTemp);
        this.electricDHWService
          .getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
          .updateValue(this.states.electricDHWTargetTemp);
      }
    }
  }

  // ── Commands ───────────────────────────────────────────────────────────────

  private async setWallboxCharging(enable: boolean): Promise<void> {
    try {
      const command = enable ? 'start' : 'stop';
      const success = await this.platform.viessmannAPI.executeCommand(
        this.installation.id,
        this.gateway.serial,
        this.device.id,
        'charging.ev',
        command,
        {},
      );
      if (success) {
        this.states.wallboxChargingActive = enable;
        this.platform.log.info(
          `[EnergyAccessory] Wallbox charging ${enable ? 'started' : 'stopped'}`,
        );
      }
    } catch (error) {
      this.platform.log.error('[EnergyAccessory] Failed to set wallbox charging:', error);
    }
  }

  private async setElectricDHWActive(active: boolean): Promise<void> {
    try {
      const mode = active ? 'electricBoost' : 'off';
      const success = await this.platform.viessmannAPI.executeCommand(
        this.installation.id,
        this.gateway.serial,
        this.device.id,
        'heating.dhw.operating.modes.active',
        'setMode',
        { mode },
      );
      if (success) {
        this.states.electricDHWActive = active;
        this.platform.log.info(
          `[EnergyAccessory] Electric DHW ${active ? 'activated (electricBoost)' : 'deactivated'}`,
        );
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
        this.platform.log.info(
          `[EnergyAccessory] Electric DHW target temperature set to ${temperature}°C`,
        );
      }
    } catch (error) {
      this.platform.log.error('[EnergyAccessory] Failed to set electric DHW temperature:', error);
    }
  }
}
