/**
 * ViessmannHistoryLogger
 * Handles dual logging: FakeGato (Eve app graphs) + CSV file (export/analysis)
 *
 * Setup (one time, via SSH on Raspberry Pi / Homebridge system):
 *   sudo npm install --prefix /usr/local fakegato-history
 *
 * Note: use --prefix /usr/local (not -g). On these systems -g installs to
 * /usr/lib/node_modules which is NOT on Node's require path.
 *
 * FakeGato types used:
 *   - 'thermo'  → currentTemp + setTemp  (HC, DHW)
 *   - 'energy'  → power (0-100%)          (Boiler modulation)
 *
 * CSV file: /var/lib/homebridge/viessmann-history.csv
 * One row per accessory per refresh cycle (~15min).
 */

import * as fs from 'fs';
import * as path from 'path';

export type HistoryType = 'thermo' | 'energy';

export interface ThermoEntry {
  currentTemp: number;
  setTemp: number;
  valvePosition?: number; // 0-100, optional
}

export interface EnergyEntry {
  power: number; // 0-100
}

export interface CsvRow {
  timestamp: string;
  accessory: string;
  burner_active?: boolean;
  modulation?: number;
  room_temp?: number;
  target_temp?: number;
  outside_temp?: number;
  outside_humidity?: number;
  dhw_temp?: number;
  dhw_target?: number;
  program?: string;
  mode?: string;
  burner_starts?: number;
  burner_hours?: number;
  flow_temp?: number;           // heating.circuits.N.sensors.temperature.supply
  gas_heating_day_m3?: number;  // heating.gas.consumption.summary.heating.currentDay
  gas_dhw_day_m3?: number;      // heating.gas.consumption.summary.dhw.currentDay
  // Energy accessory fields
  pv_production_w?: number;
  pv_daily_kwh?: number;
  battery_level?: number;
  battery_charging_w?: number;
  battery_discharging_w?: number;
  grid_feedin_w?: number;
  grid_draw_w?: number;
  wallbox_charging?: boolean;
  wallbox_power_w?: number;
}

const CSV_HEADER = 'timestamp,accessory,burner_active,modulation,room_temp,target_temp,outside_temp,outside_humidity,dhw_temp,dhw_target,program,mode,burner_starts,burner_hours,flow_temp,gas_heating_day_m3,gas_dhw_day_m3,pv_production_w,pv_daily_kwh,battery_level,battery_charging_w,battery_discharging_w,grid_feedin_w,grid_draw_w,wallbox_charging,wallbox_power_w\n';

export class ViessmannHistoryLogger {
  private fakeGatoService: any = null;
  private fakeGatoAvailable = false;
  private csvPath: string;
  private logName: string;

  constructor(
    private readonly platform: any,
    private readonly accessory: any,
    private readonly historyType: HistoryType,
    logName: string,
  ) {
    this.logName = logName;
    this.csvPath = path.join(
      platform.api?.user?.storagePath?.() || '/var/lib/homebridge',
      'viessmann-history.csv',
    );
    this.initFakeGato();
  }

  private initFakeGato() {
    try {
      const FakeGatoHistoryService = require('fakegato-history')(this.platform.api);
      this.fakeGatoService = new FakeGatoHistoryService(
        this.historyType,
        this.accessory,
        { storage: 'fs', path: this.platform.api?.user?.storagePath?.() || '/var/lib/homebridge' },
      );
      this.fakeGatoAvailable = true;
      this.platform.log.info(`📊 ${this.logName}: FakeGato history enabled (type: ${this.historyType})`);
    } catch {
      this.platform.log.debug(`📊 ${this.logName}: FakeGato not available — install fakegato-history for Eve graphs`);
      this.fakeGatoAvailable = false;
    }
  }

  /**
   * Log a thermo entry (HC or DHW)
   */
  public addThermoEntry(entry: ThermoEntry) {
    const time = Math.round(Date.now() / 1000);
    if (this.fakeGatoAvailable && this.fakeGatoService) {
      try {
        this.fakeGatoService.addEntry({
          time,
          currentTemp: entry.currentTemp,
          setTemp: entry.setTemp,
          valvePosition: entry.valvePosition ?? 0,
        });
      } catch (e) {
        this.platform.log.debug(`📊 ${this.logName}: FakeGato addEntry failed: ${e}`);
      }
    }
  }

  /**
   * Log an energy entry (Boiler modulation)
   */
  public addEnergyEntry(entry: EnergyEntry) {
    const time = Math.round(Date.now() / 1000);
    if (this.fakeGatoAvailable && this.fakeGatoService) {
      try {
        this.fakeGatoService.addEntry({ time, power: entry.power });
      } catch (e) {
        this.platform.log.debug(`📊 ${this.logName}: FakeGato addEntry failed: ${e}`);
      }
    }
  }

  /**
   * Append a row to the shared CSV file
   */
  public appendCsvRow(row: CsvRow) {
    try {
      const exists = fs.existsSync(this.csvPath);
      if (!exists) {
        fs.writeFileSync(this.csvPath, CSV_HEADER, 'utf8');
      }
      const line = [
        row.timestamp,
        row.accessory,
        row.burner_active ?? '',
        row.modulation ?? '',
        row.room_temp ?? '',
        row.target_temp ?? '',
        row.outside_temp ?? '',
        row.outside_humidity ?? '',
        row.dhw_temp ?? '',
        row.dhw_target ?? '',
        row.program ?? '',
        row.mode ?? '',
        row.burner_starts ?? '',
        row.burner_hours ?? '',
        row.flow_temp ?? '',
        row.gas_heating_day_m3 ?? '',
        row.gas_dhw_day_m3 ?? '',
        row.pv_production_w ?? '',
        row.pv_daily_kwh ?? '',
        row.battery_level ?? '',
        row.battery_charging_w ?? '',
        row.battery_discharging_w ?? '',
        row.grid_feedin_w ?? '',
        row.grid_draw_w ?? '',
        row.wallbox_charging ?? '',
        row.wallbox_power_w ?? '',
      ].join(',') + '\n';
      fs.appendFileSync(this.csvPath, line, 'utf8');
    } catch (e) {
      this.platform.log.debug(`📊 ${this.logName}: CSV append failed: ${e}`);
    }
  }
}
