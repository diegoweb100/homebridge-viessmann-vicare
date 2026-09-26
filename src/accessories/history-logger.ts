/**
 * ViessmannHistoryLogger
 * Triple logging: FakeGato (Eve app graphs) + CSV file + optional MySQL/MariaDB.
 *
 * CSV (default on):
 *   /var/lib/homebridge/viessmann-history-<installationId>.csv
 *   Column layout is frozen (35 columns) for backward compatibility with
 *   viessmann-report.js / viessmann-sync-events.js and existing user scripts.
 *
 * MySQL / MariaDB (optional, logging.mysql.enabled = true):
 *   - mysql2 is a regular dependency since 2.0.75 (no manual install needed).
 *   - Table is created automatically on first run and the existing CSV is imported.
 *   - Since 2.0.75 missing columns are added automatically (ALTER TABLE ... ADD COLUMN)
 *     when the plugin is upgraded. If the MySQL user lacks ALTER privilege the plugin
 *     keeps writing the columns that exist and logs the SQL to run manually.
 *
 * Logging config (plugin config.json):
 *   logging.csv.enabled    — default true
 *   logging.mysql.enabled  — default false
 *   If both are false, history is disabled (warning logged once at startup).
 *
 * FakeGato types used:
 *   - 'thermo'  → currentTemp + setTemp  (HC, DHW, room sensors)
 *   - 'energy'  → power (0-100%)          (Boiler modulation, battery %)
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
  // 'snapshot' = regular poll (default); 'burner_on'/'burner_off' = state change events
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
  burner_starts_today?: number;  // delta since midnight reference
  burner_hours_today?: number;   // delta since midnight reference
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

/**
 * DbRow — superset of CsvRow. Extended fields are written to MySQL only
 * (the CSV layout stays unchanged).
 */
export interface DbRow extends CsvRow {
  installation_id?: number;
  gateway_serial?: string;
  // 2.0.74
  boiler_water_temp?: number;
  hc_operating_mode?: string;
  hc_comfort_temp?: number;
  hc_normal_temp?: number;
  hc_reduced_temp?: number;
  hc_slope?: number;
  hc_shift?: number;
  holiday_mode_active?: boolean;
  extended_heating_active?: boolean;
  dhw_mode?: string;
  dhw_circulation_pump?: boolean;
  // 2.0.75
  water_pressure_bar?: number;       // heating.sensors.pressure.supply
  gas_heating_year_m3?: number;      // heating.gas.consumption.summary.heating.currentYear
  gas_dhw_year_m3?: number;          // heating.gas.consumption.summary.dhw.currentYear
  heat_heating_year_kwh?: number;    // heating.heat.production.summary.heating.currentYear
  heat_dhw_year_kwh?: number;        // heating.heat.production.summary.dhw.currentYear
  power_heating_day_kwh?: number;    // heating.power.consumption.summary.heating.currentDay (electricity)
  power_dhw_day_kwh?: number;        // heating.power.consumption.summary.dhw.currentDay
  power_heating_month_kwh?: number;
  power_dhw_month_kwh?: number;
  power_heating_year_kwh?: number;
  power_dhw_year_kwh?: number;
  status_code?: string;              // device.messages.status.raw → latest errorCode (e.g. S.6)
  wifi_rssi?: number;                // tcu.wifi strength (dBm)
}

// ── CSV column order (FROZEN — do not change) ────────────────────────────────
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

// ── DB schema: single source of truth (column → SQL type) ────────────────────
type ColKind = 'ts' | 'str' | 'num' | 'bool' | 'int';
interface ColDef { name: string; sql: string; kind: ColKind }

const DB_COLUMNS: ColDef[] = [
  { name: 'ts',                      sql: 'DATETIME(3) NOT NULL', kind: 'ts' },
  { name: 'accessory',               sql: 'VARCHAR(64)',  kind: 'str' },
  { name: 'event_type',              sql: 'VARCHAR(32)',  kind: 'str' },
  { name: 'burner_active',           sql: 'TINYINT(1)',   kind: 'bool' },
  { name: 'modulation',              sql: 'DOUBLE',       kind: 'num' },
  { name: 'room_temp',               sql: 'DOUBLE',       kind: 'num' },
  { name: 'target_temp',             sql: 'DOUBLE',       kind: 'num' },
  { name: 'outside_temp',            sql: 'DOUBLE',       kind: 'num' },
  { name: 'outside_humidity',        sql: 'DOUBLE',       kind: 'num' },
  { name: 'dhw_temp',                sql: 'DOUBLE',       kind: 'num' },
  { name: 'dhw_target',              sql: 'DOUBLE',       kind: 'num' },
  { name: 'program',                 sql: 'VARCHAR(32)',  kind: 'str' },
  { name: 'mode',                    sql: 'VARCHAR(32)',  kind: 'str' },
  { name: 'burner_starts',           sql: 'DOUBLE',       kind: 'num' },
  { name: 'burner_hours',            sql: 'DOUBLE',       kind: 'num' },
  { name: 'burner_starts_today',     sql: 'DOUBLE',       kind: 'num' },
  { name: 'burner_hours_today',      sql: 'DOUBLE',       kind: 'num' },
  { name: 'flow_temp',               sql: 'DOUBLE',       kind: 'num' },
  { name: 'gas_heating_day_m3',      sql: 'DOUBLE',       kind: 'num' },
  { name: 'gas_dhw_day_m3',          sql: 'DOUBLE',       kind: 'num' },
  { name: 'gas_heating_month_m3',    sql: 'DOUBLE',       kind: 'num' },
  { name: 'gas_dhw_month_m3',        sql: 'DOUBLE',       kind: 'num' },
  { name: 'heat_heating_day_kwh',    sql: 'DOUBLE',       kind: 'num' },
  { name: 'heat_dhw_day_kwh',        sql: 'DOUBLE',       kind: 'num' },
  { name: 'heat_heating_month_kwh',  sql: 'DOUBLE',       kind: 'num' },
  { name: 'heat_dhw_month_kwh',      sql: 'DOUBLE',       kind: 'num' },
  { name: 'pv_production_w',         sql: 'DOUBLE',       kind: 'num' },
  { name: 'pv_daily_kwh',            sql: 'DOUBLE',       kind: 'num' },
  { name: 'battery_level',           sql: 'DOUBLE',       kind: 'num' },
  { name: 'battery_charging_w',      sql: 'DOUBLE',       kind: 'num' },
  { name: 'battery_discharging_w',   sql: 'DOUBLE',       kind: 'num' },
  { name: 'grid_feedin_w',           sql: 'DOUBLE',       kind: 'num' },
  { name: 'grid_draw_w',             sql: 'DOUBLE',       kind: 'num' },
  { name: 'wallbox_charging',        sql: 'TINYINT(1)',   kind: 'bool' },
  { name: 'wallbox_power_w',         sql: 'DOUBLE',       kind: 'num' },
  // ── Extended (MySQL only) — 2.0.74 ──
  { name: 'installation_id',         sql: 'INT',          kind: 'int' },
  { name: 'gateway_serial',          sql: 'VARCHAR(64)',  kind: 'str' },
  { name: 'boiler_water_temp',       sql: 'DOUBLE',       kind: 'num' },
  { name: 'hc_operating_mode',       sql: 'VARCHAR(32)',  kind: 'str' },
  { name: 'hc_comfort_temp',         sql: 'DOUBLE',       kind: 'num' },
  { name: 'hc_normal_temp',          sql: 'DOUBLE',       kind: 'num' },
  { name: 'hc_reduced_temp',         sql: 'DOUBLE',       kind: 'num' },
  { name: 'hc_slope',                sql: 'DOUBLE',       kind: 'num' },
  { name: 'hc_shift',                sql: 'DOUBLE',       kind: 'num' },
  { name: 'holiday_mode_active',     sql: 'TINYINT(1)',   kind: 'bool' },
  { name: 'extended_heating_active', sql: 'TINYINT(1)',   kind: 'bool' },
  { name: 'dhw_mode',                sql: 'VARCHAR(32)',  kind: 'str' },
  { name: 'dhw_circulation_pump',    sql: 'TINYINT(1)',   kind: 'bool' },
  // ── Extended (MySQL only) — 2.0.75 ──
  { name: 'water_pressure_bar',      sql: 'DOUBLE',       kind: 'num' },
  { name: 'gas_heating_year_m3',     sql: 'DOUBLE',       kind: 'num' },
  { name: 'gas_dhw_year_m3',         sql: 'DOUBLE',       kind: 'num' },
  { name: 'heat_heating_year_kwh',   sql: 'DOUBLE',       kind: 'num' },
  { name: 'heat_dhw_year_kwh',       sql: 'DOUBLE',       kind: 'num' },
  { name: 'power_heating_day_kwh',   sql: 'DOUBLE',       kind: 'num' },
  { name: 'power_dhw_day_kwh',       sql: 'DOUBLE',       kind: 'num' },
  { name: 'power_heating_month_kwh', sql: 'DOUBLE',       kind: 'num' },
  { name: 'power_dhw_month_kwh',     sql: 'DOUBLE',       kind: 'num' },
  { name: 'power_heating_year_kwh',  sql: 'DOUBLE',       kind: 'num' },
  { name: 'power_dhw_year_kwh',      sql: 'DOUBLE',       kind: 'num' },
  { name: 'status_code',             sql: 'VARCHAR(16)',  kind: 'str' },
  { name: 'wifi_rssi',               sql: 'SMALLINT',     kind: 'int' },
];

/** Base columns = CSV columns mapped to DB names (timestamp → ts). */
const DB_BASE_COLUMNS = CSV_COLUMNS.map(c => (c === 'timestamp' ? 'ts' : c)) as string[];

export interface MysqlConfig {
  enabled: boolean;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  table: string;
  autoCreateTable: boolean;
}

// ── MariaDB CREATE TABLE ─────────────────────────────────────────────────────
function buildCreateTableSQL(table: string): string {
  const cols = DB_COLUMNS.map(c => `  \`${c.name}\` ${c.sql}`).join(',\n');
  return `CREATE TABLE IF NOT EXISTS \`${table}\` (
  \`id\` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
${cols},
  UNIQUE KEY \`uq_ts_acc_evt\` (\`ts\`, \`accessory\`, \`event_type\`),
  KEY \`idx_ts\` (\`ts\`),
  KEY \`idx_inst_ts\` (\`installation_id\`, \`ts\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
}

// ── Type helpers ─────────────────────────────────────────────────────────────
function toTs(iso: string | undefined | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const pad = (n: number, z = 2) => String(n).padStart(z, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.` +
    `${pad(d.getUTCMilliseconds(), 3)}`;
}

function toBool(v: unknown): number | null {
  if (v === true) return 1;
  if (v === false) return 0;
  return null;
}

/** Numeric value or NULL. NOTE: 0 is a valid value and is preserved. */
function toF(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function toS(v: unknown): string | null {
  return (v !== undefined && v !== null && v !== '') ? String(v) : null;
}

function convert(kind: ColKind, v: unknown): unknown {
  switch (kind) {
    case 'ts': return toTs(v as string);
    case 'str': return toS(v);
    case 'bool': return toBool(v);
    case 'int': { const n = toF(v); return n === null ? null : Math.round(n); }
    default: return toF(v);
  }
}

// ── Main logger class ────────────────────────────────────────────────────────
export class ViessmannHistoryLogger {
  // ── Static shared state ──
  /** One pool per connection string (host:port/db), shared across all instances. */
  private static pools = new Map<string, Promise<any>>();
  /** Per "database:table": promise resolving to the list of columns actually present. */
  private static schemaReady = new Map<string, Promise<Set<string>>>();
  /** Tracks which "database:table" combos have already initiated a CSV import. */
  private static importStarted = new Set<string>();
  private static loggedBothDisabledWarning = false;
  private static loggedMysql2MissingWarning = false;

  // ── Instance state ──
  private fakeGatoService: any = null;
  private fakeGatoAvailable = false;
  private readonly csvPath: string;
  private readonly logName: string;
  private csvEnabled = true;
  private mysqlEnabled = false;
  private mysqlAvailable = false;
  private pool: any = null;
  private insertSql = '';
  private insertCols: ColDef[] = [];

  constructor(
    private readonly platform: any,
    private readonly accessory: any,
    private readonly historyType: HistoryType,
    logName: string,
    private readonly installationId?: number,
    private readonly gatewaySerial?: string,
  ) {
    this.logName = logName;
    const basePath = platform.api?.user?.storagePath?.() || '/var/lib/homebridge';
    const suffix = installationId ? `-${installationId}` : '';
    this.csvPath = path.join(basePath, `viessmann-history${suffix}.csv`);

    // ── Resolve logging config ──
    const loggingCfg = platform.config?.logging;
    this.csvEnabled = loggingCfg?.csv?.enabled !== false;   // default true
    this.mysqlEnabled = loggingCfg?.mysql?.enabled === true; // default false

    if (!this.csvEnabled && !this.mysqlEnabled && !ViessmannHistoryLogger.loggedBothDisabledWarning) {
      ViessmannHistoryLogger.loggedBothDisabledWarning = true;
      this.platform.log.warn('⚠️ [History] Both CSV and MySQL logging are disabled — no history will be recorded. ' +
        'Set logging.csv.enabled=true to restore defaults.');
    }

    this.initFakeGato();

    if (this.mysqlEnabled) {
      const mysqlCfg: MysqlConfig = {
        enabled: true,
        host: loggingCfg?.mysql?.host || 'localhost',
        port: loggingCfg?.mysql?.port || 3306,
        database: loggingCfg?.mysql?.database || 'homebridge',
        user: loggingCfg?.mysql?.user || 'viessmann_rw',
        password: loggingCfg?.mysql?.password || '',
        table: loggingCfg?.mysql?.table || 'viessmann_history',
        autoCreateTable: loggingCfg?.mysql?.autoCreateTable !== false,
      };
      this.setupMysql(mysqlCfg).catch((err: any) =>
        this.platform.log.warn(`[History] MySQL init error: ${err.message}`));
    }
  }

  // ── FakeGato ──
  private initFakeGato() {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const FakeGatoHistoryService = require('fakegato-history')(this.platform.api);
      this.fakeGatoService = new FakeGatoHistoryService(
        this.historyType,
        this.accessory,
        { storage: 'fs', path: this.platform.api?.user?.storagePath?.() || '/var/lib/homebridge' },
      );
      this.fakeGatoAvailable = true;
      this.platform.log.info(`📊 ${this.logName}: FakeGato history enabled (type: ${this.historyType})`);
    } catch {
      this.platform.log.debug(`📊 ${this.logName}: FakeGato not available`);
    }
  }

  public addThermoEntry(entry: ThermoEntry) {
    if (!this.fakeGatoAvailable || !this.fakeGatoService) return;
    try {
      this.fakeGatoService.addEntry({
        time: Math.round(Date.now() / 1000),
        currentTemp: entry.currentTemp,
        setTemp: entry.setTemp,
        valvePosition: entry.valvePosition ?? 0,
      });
    } catch (e) {
      this.platform.log.debug(`📊 ${this.logName}: FakeGato addEntry failed: ${e}`);
    }
  }

  public addEnergyEntry(entry: EnergyEntry) {
    if (!this.fakeGatoAvailable || !this.fakeGatoService) return;
    try {
      this.fakeGatoService.addEntry({ time: Math.round(Date.now() / 1000), power: entry.power });
    } catch (e) {
      this.platform.log.debug(`📊 ${this.logName}: FakeGato addEntry failed: ${e}`);
    }
  }

  // ── MySQL setup ──
  private async setupMysql(cfg: MysqlConfig): Promise<void> {
    const poolKey = `${cfg.host}:${cfg.port}/${cfg.database}`;
    const schemaKey = `${cfg.database}:${cfg.table}`;

    // One pool per connection, created once even when several accessories start in parallel
    let poolPromise = ViessmannHistoryLogger.pools.get(poolKey);
    if (!poolPromise) {
      poolPromise = this.createPool(cfg);
      ViessmannHistoryLogger.pools.set(poolKey, poolPromise);
    }
    const pool = await poolPromise;
    if (!pool) return;
    this.pool = pool;

    // Schema check / creation / migration runs once per table, shared by all instances
    let ready = ViessmannHistoryLogger.schemaReady.get(schemaKey);
    if (!ready) {
      ready = this.prepareSchema(cfg);
      ViessmannHistoryLogger.schemaReady.set(schemaKey, ready);
    }
    const present = await ready;
    if (!present.size) return; // table missing and could not be created

    this.insertCols = DB_COLUMNS.filter(c => present.has(c.name));
    this.insertSql = `INSERT IGNORE INTO \`${cfg.table}\` ` +
      `(${this.insertCols.map(c => `\`${c.name}\``).join(', ')}) ` +
      `VALUES (${this.insertCols.map(() => '?').join(', ')})`;
    this.mysqlAvailable = true;
  }

  /** Creates and tests the connection pool. Resolves to null when MySQL is not usable. */
  private async createPool(cfg: MysqlConfig): Promise<any> {
    let mysql2: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      mysql2 = require('mysql2/promise');
    } catch {
      if (!ViessmannHistoryLogger.loggedMysql2MissingWarning) {
        ViessmannHistoryLogger.loggedMysql2MissingWarning = true;
        this.platform.log.warn('[History] mysql2 module not found — MySQL logging disabled. ' +
          'Reinstall the plugin (mysql2 is a regular dependency since 2.0.75).');
      }
      return null;
    }
    try {
      const pool = mysql2.createPool({
        host: cfg.host,
        port: cfg.port,
        database: cfg.database,
        user: cfg.user,
        password: cfg.password,
        waitForConnections: true,
        connectionLimit: 3,
        queueLimit: 50,
      });
      const conn = await pool.getConnection();
      conn.release();
      this.platform.log.info(`📊 MySQL logging enabled → ${cfg.database}.${cfg.table}`);
      return pool;
    } catch (err: any) {
      this.platform.log.warn(`[History] MySQL connection failed: ${err.message} — MySQL logging disabled`);
      return null;
    }
  }

  /** Returns the set of columns present in the table after create/migration. */
  private async prepareSchema(cfg: MysqlConfig): Promise<Set<string>> {
    const readColumns = async (): Promise<Set<string>> => {
      const [rows] = await this.pool.query(
        'SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?',
        [cfg.table]);
      return new Set((rows as any[]).map(r => String(r.c ?? r.C ?? r.COLUMN_NAME)));
    };

    let present = await readColumns();

    if (!present.size) {
      if (!cfg.autoCreateTable) {
        this.platform.log.warn(`[History] MySQL table \`${cfg.table}\` does not exist and autoCreateTable=false — MySQL logging disabled`);
        return present;
      }
      await this.pool.query(buildCreateTableSQL(cfg.table));
      this.platform.log.info(`[History] MySQL table \`${cfg.table}\` created`);
      present = await readColumns();
      const importKey = `${cfg.database}:${cfg.table}`;
      if (!ViessmannHistoryLogger.importStarted.has(importKey) && fs.existsSync(this.csvPath)) {
        ViessmannHistoryLogger.importStarted.add(importKey);
        this.platform.log.info(`[History] Starting background CSV→MySQL import from ${this.csvPath}`);
        setImmediate(() => this.importCsvToDb(cfg.table).catch((err: any) =>
          this.platform.log.warn(`[History] CSV import error: ${err.message}`)));
      }
      return present;
    }

    // ── Auto-migration: add columns introduced by newer plugin versions ──
    const missing = DB_COLUMNS.filter(c => !present.has(c.name));
    if (missing.length) {
      const sql = `ALTER TABLE \`${cfg.table}\` ` +
        missing.map(c => `ADD COLUMN \`${c.name}\` ${c.sql.replace(' NOT NULL', '')}`).join(', ');
      if (cfg.autoCreateTable) {
        try {
          await this.pool.query(sql);
          this.platform.log.info(`[History] MySQL table \`${cfg.table}\` migrated: added ${missing.map(c => c.name).join(', ')}`);
          present = await readColumns();
        } catch (err: any) {
          this.platform.log.warn(`[History] Could not add new columns (${err.message}). ` +
            `History keeps working with the existing columns. To enable the new fields run as DB admin:\n  ${sql};`);
        }
      } else {
        this.platform.log.info(`[History] autoCreateTable=false — new columns not added. To enable them run:\n  ${sql};`);
      }
    }
    return present;
  }

  private async importCsvToDb(table: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const readline = require('readline');
    const rl = readline.createInterface({ input: fs.createReadStream(this.csvPath, 'utf8'), crlfDelay: Infinity });
    let header: string[] | null = null;
    let batch: unknown[][] = [];
    let imported = 0;
    let errors = 0;
    const BATCH_SIZE = 500;
    const baseDefs = DB_COLUMNS.filter(c => DB_BASE_COLUMNS.includes(c.name));

    const flushBatch = async () => {
      if (!batch.length) return;
      try {
        await this.pool.query(
          `INSERT IGNORE INTO \`${table}\` (${baseDefs.map(c => `\`${c.name}\``).join(', ')}) VALUES ?`, [batch]);
        imported += batch.length;
      } catch (err: any) {
        errors += batch.length;
        this.platform.log.debug(`[History] CSV import batch error: ${err.message}`);
      }
      batch = [];
    };

    for await (const line of rl) {
      if (!header) { header = (line as string).split(','); continue; }
      const vals = (line as string).split(',');
      const row: Record<string, string> = {};
      header.forEach((h, i) => row[h] = vals[i] ?? '');
      if (!toTs(row['timestamp'])) { errors++; continue; }
      batch.push(baseDefs.map(c => {
        const v = row[c.name === 'ts' ? 'timestamp' : c.name] ?? '';
        if (c.kind === 'bool') return v === 'true' ? 1 : v === 'false' ? 0 : null;
        return convert(c.kind, v);
      }));
      if (batch.length >= BATCH_SIZE) await flushBatch();
    }
    await flushBatch();
    this.platform.log.info(`[History] CSV→MySQL import complete: ${imported} rows imported, ${errors} errors`);
  }

  // ── Writers ──
  private writeCsvRow(row: CsvRow) {
    try {
      if (!fs.existsSync(this.csvPath)) {
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

  private writeMysqlRow(row: DbRow) {
    if (!this.mysqlAvailable || !this.pool) return;
    const src: Record<string, unknown> = {
      ...row,
      ts: row.timestamp,
      installation_id: row.installation_id ?? this.installationId,
      gateway_serial: row.gateway_serial ?? this.gatewaySerial,
    };
    const params = this.insertCols.map(c => convert(c.kind, src[c.name]));
    this.pool.execute(this.insertSql, params).catch((err: any) =>
      this.platform.log.debug(`📊 ${this.logName}: MySQL write error: ${err.message}`));
  }

  // ── Public API ──
  /** Write a history row to CSV and/or MySQL. DbRow is a superset of CsvRow. */
  public appendRow(row: DbRow) {
    if (this.csvEnabled) this.writeCsvRow(row);
    if (this.mysqlAvailable) this.writeMysqlRow(row);
  }

  /** @deprecated Use appendRow() — kept for backward compatibility. */
  public appendCsvRow(row: DbRow) {
    this.appendRow(row);
  }
}
