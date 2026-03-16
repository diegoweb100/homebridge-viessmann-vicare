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
  // 'event' = immediate burner state change; 'snapshot' = regular 15-min poll (default)
  event_type?: string;
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
  burner_starts?: number;        // lifetime cumulative — use delta columns for daily analysis
  burner_hours?: number;         // lifetime cumulative
  burner_starts_today?: number;  // delta since midnight reference — precise daily count
  burner_hours_today?: number;   // delta since midnight reference — precise daily hours
  flow_temp?: number;            // heating.circuits.N.sensors.temperature.supply
  gas_heating_day_m3?: number;   // heating.gas.consumption.summary.heating.currentDay
  gas_dhw_day_m3?: number;       // heating.gas.consumption.summary.dhw.currentDay
  gas_heating_month_m3?: number; // heating.gas.consumption.summary.heating.currentMonth
  gas_dhw_month_m3?: number;     // heating.gas.consumption.summary.dhw.currentMonth
  heat_heating_day_kwh?: number; // heating.heat.production.summary.heating.currentDay
  heat_dhw_day_kwh?: number;     // heating.heat.production.summary.dhw.currentDay
  heat_heating_month_kwh?: number;
  heat_dhw_month_kwh?: number;
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

const CSV_COLUMNS = [
  'timestamp', 'accessory', 'event_type',
  'burner_active', 'modulation',
  'room_temp', 'target_temp', 'outside_temp', 'outside_humidity',
  'dhw_temp', 'dhw_target', 'program', 'mode',
  'burner_starts', 'burner_hours', 'burner_starts_today', 'burner_hours_today',
  'flow_temp',
  'gas_heating_day_m3', 'gas_dhw_day_m3',
  'gas_heating_month_m3', 'gas_dhw_month_m3',
  'heat_heating_day_kwh', 'heat_dhw_day_kwh',
  'heat_heating_month_kwh', 'heat_dhw_month_kwh',
  'pv_production_w', 'pv_daily_kwh',
  'battery_level', 'battery_charging_w', 'battery_discharging_w',
  'grid_feedin_w', 'grid_draw_w',
  'wallbox_charging', 'wallbox_power_w',
] as const;

const CSV_HEADER = CSV_COLUMNS.join(',') + '\n';

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
    installationId?: number,
  ) {
    this.logName = logName;
    const basePath = platform.api?.user?.storagePath?.() || '/var/lib/homebridge';
    const suffix = installationId ? `-${installationId}` : '';
    this.csvPath = path.join(basePath, `viessmann-history${suffix}.csv`);
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
      const line = CSV_COLUMNS.map(col => {
        const val = (row as any)[col];
        return val === undefined || val === null ? '' : val;
      }).join(',') + '\n';
      fs.appendFileSync(this.csvPath, line, 'utf8');
    } catch (e) {
      this.platform.log.debug(`📊 ${this.logName}: CSV append failed: ${e}`);
    }
  }
}
