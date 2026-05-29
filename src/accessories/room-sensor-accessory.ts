/**
 * ViessmannRoomSensorAccessory
 *
 * DISCOVERY / DIAGNOSTIC STUB — v2.0.69
 *
 * Enabled via: features.enableRoomSensorDiscovery = true
 *
 * Purpose:
 *   Users with Viessmann ViCare Smart Climate thermostatic radiator valves (TRVs)
 *   or per-room temperature sensors can enable this mode to:
 *     1. Log ALL feature paths of every non-main device in the gateway.
 *     2. Create a HomeKit TemperatureSensor accessory for every device that
 *        exposes at least one numeric temperature value.
 *
 * What this solves:
 *   The exact API feature paths for TRVs vary by model/generation. By running
 *   this discovery mode and sharing the Homebridge logs, users provide the data
 *   needed to implement full per-room control in a future release.
 *
 * How to use:
 *   1. Set features.enableRoomSensorDiscovery: true in plugin config.
 *   2. Restart Homebridge.
 *   3. Check logs for lines starting with "[RoomDiscovery]".
 *   4. Share the log output in a GitHub issue — it contains all feature paths
 *      and property values for your TRV devices.
 *
 * HomeKit accessories created:
 *   - One TemperatureSensor per discovered device with a temperature reading.
 *   - Name: "<InstallationPrefix> Room <modelId|deviceId>"
 *   - The sensor shows the best available temperature (room > supply > general).
 *
 * This file will be replaced by a full implementation once the API paths
 * are known for common TRV models (Viessmann ViCare Smart Thermostat, etc.).
 */

import { PlatformAccessory, Service } from 'homebridge';
import { ViessmannPlatform } from '../platform';
import { ViessmannFeature, ViessmannDevice, ViessmannInstallation, ViessmannGateway } from '../viessmann-api-endpoints';

// ── Candidate feature paths for room/zone temperature, in priority order ──────
// Extend this list as new devices are discovered.
const TEMP_PATH_CANDIDATES: Array<{ path: string; prop: string; label: string }> = [
  // Zone-based (ViCare Smart Climate typical)
  { path: 'heating.zones.0.sensors.temperature.room',   prop: 'value',   label: 'zone0.room' },
  { path: 'heating.zones.1.sensors.temperature.room',   prop: 'value',   label: 'zone1.room' },
  { path: 'heating.zones.2.sensors.temperature.room',   prop: 'value',   label: 'zone2.room' },
  { path: 'heating.zones.3.sensors.temperature.room',   prop: 'value',   label: 'zone3.room' },
  // Circuit-based (standard HC)
  { path: 'heating.circuits.0.sensors.temperature.room', prop: 'value',  label: 'hc0.room' },
  { path: 'heating.circuits.1.sensors.temperature.room', prop: 'value',  label: 'hc1.room' },
  // Generic device-level temperature (TRV models)
  { path: 'temperature.current',                         prop: 'value',   label: 'temp.current' },
  { path: 'temperature.value',                           prop: 'value',   label: 'temp.value' },
  { path: 'temperature.basic',                           prop: 'value',   label: 'temp.basic' },
  // Setpoint (secondary interest)
  { path: 'temperature.setpoint',                        prop: 'value',   label: 'temp.setpoint' },
  { path: 'heating.zones.0.temperature.setpoint',        prop: 'value',   label: 'zone0.setpoint' },
];

// Valve/TRV-specific feature paths we want to capture but not display
const VALVE_PATH_PATTERNS = ['valve', 'opening', 'position', 'level'];

// Roles that indicate a TRV or room sensor device
const ROOM_DEVICE_ROLES = [
  'room', 'remote-control', 'remote', 'sensor',
  'valve', 'thermostat', 'zone',
];

// ─────────────────────────────────────────────────────────────────────────────

export interface RoomSensorDiscoveryResult {
  device: ViessmannDevice;
  tempFeaturePath?: string;
  tempPropName?: string;
  tempLabel?: string;
  currentTemp?: number;
  allTempFeatures: Array<{ path: string; prop: string; value: number; unit: string }>;
  allFeatureCount: number;
  matchedRole?: string;
}

/**
 * Scan a device's features and return structured discovery data.
 * Also dumps a detailed log to help reverse-engineer unknown TRV models.
 */
export function discoverRoomSensorData(
  platform: ViessmannPlatform,
  device: ViessmannDevice,
  features: ViessmannFeature[],
): RoomSensorDiscoveryResult {
  const log = platform.log;
  const TAG  = '[RoomDiscovery]';

  const roles    = device.roles ?? [];
  const modelId  = device.modelId || device.id;
  const matchedRole = roles.find(r => ROOM_DEVICE_ROLES.some(k => r.toLowerCase().includes(k)));

  log.info(`${TAG} ──────────────────────────────────────────────`);
  log.info(`${TAG} Device id=${device.id} model=${modelId}`);
  log.info(`${TAG}   deviceType: ${device.deviceType}`);
  log.info(`${TAG}   roles: [${roles.join(', ')}]`);
  log.info(`${TAG}   status: ${device.status}`);
  log.info(`${TAG}   matched role: ${matchedRole ?? '(none — showing all features anyway)'}`);
  log.info(`${TAG}   total features: ${features.length}`);
  log.info(`${TAG} ── Enabled features with properties ──────────`);

  const allTempFeatures: RoomSensorDiscoveryResult['allTempFeatures'] = [];

  // Log ALL enabled features — this is the diagnostic payload
  for (const f of features.filter(x => x.isEnabled)) {
    const props  = f.properties ?? {};
    const cmds   = Object.keys(f.commands ?? {});
    const pKeys  = Object.keys(props);

    log.info(`${TAG}   [${f.isEnabled ? '✓' : '✗'}] ${f.feature}`);

    for (const pk of pKeys) {
      const p     = props[pk];
      const val   = p?.value;
      const unit  = p?.unit ?? '';
      const type  = p?.type ?? typeof val;

      if (val !== undefined && val !== null) {
        // Collect numeric temperature-range values
        if (typeof val === 'number' && val > -30 && val < 100 && unit !== '%') {
          allTempFeatures.push({ path: f.feature, prop: pk, value: val, unit });
        }
        const display = Array.isArray(val)
          ? `[${val.slice(0, 4).join(', ')}${val.length > 4 ? '…' : ''}]`
          : String(val);
        log.info(`${TAG}     ${pk}: ${display} ${unit} (type:${type})`);
      }
    }

    if (cmds.length > 0) {
      log.info(`${TAG}     commands: ${cmds.join(', ')}`);
    }
  }

  // Try to match a known temperature path
  let bestPath: string | undefined;
  let bestProp: string | undefined;
  let bestLabel: string | undefined;
  let bestValue: number | undefined;

  const featureMap = new Map<string, ViessmannFeature>(
    features.map(f => [f.feature, f])
  );

  for (const candidate of TEMP_PATH_CANDIDATES) {
    const feat = featureMap.get(candidate.path);
    if (feat?.isEnabled) {
      const val = feat.properties?.[candidate.prop]?.value;
      if (typeof val === 'number' && val > -30 && val < 100) {
        bestPath  = candidate.path;
        bestProp  = candidate.prop;
        bestLabel = candidate.label;
        bestValue = val;
        log.info(`${TAG}   → MATCH: ${candidate.path}.${candidate.prop} = ${val}°C [${candidate.label}]`);
        break;
      }
    }
  }

  // Fallback: use first discovered temp feature in range
  if (!bestPath && allTempFeatures.length > 0) {
    const fb   = allTempFeatures[0];
    bestPath   = fb.path;
    bestProp   = fb.prop;
    bestLabel  = 'auto-detected';
    bestValue  = fb.value;
    log.info(`${TAG}   → FALLBACK: ${fb.path}.${fb.prop} = ${fb.value}${fb.unit}`);
  }

  if (!bestPath) {
    log.info(`${TAG}   → No temperature feature found for device ${device.id}`);
    log.info(`${TAG}   ℹ️ Share these logs in a GitHub issue to help implement full TRV support`);
  }

  log.info(`${TAG} ──────────────────────────────────────────────`);

  return {
    device,
    tempFeaturePath: bestPath,
    tempPropName:    bestProp,
    tempLabel:       bestLabel,
    currentTemp:     bestValue,
    allTempFeatures,
    allFeatureCount: features.length,
    matchedRole,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

export class ViessmannRoomSensorAccessory {
  private temperatureService: Service;
  private readonly TAG = '[RoomSensor]';

  // Discovery result: saved at init, updated at each refresh
  private discoveryResult: RoomSensorDiscoveryResult;

  constructor(
    private readonly platform: ViessmannPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly installation: ViessmannInstallation,
    private readonly gateway: ViessmannGateway,
    device: ViessmannDevice,
    features: ViessmannFeature[],
  ) {
    const { Service: Svc, Characteristic: Char } = platform;

    // Run discovery scan
    this.discoveryResult = discoverRoomSensorData(platform, device, features);

    // AccessoryInformation
    accessory.getService(Svc.AccessoryInformation)!
      .setCharacteristic(Char.Manufacturer, 'Viessmann')
      .setCharacteristic(Char.Model, device.modelId || 'Room Sensor (Discovery)')
      .setCharacteristic(Char.SerialNumber, `${installation.id}-${device.id}`);

    // TemperatureSensor service
    this.temperatureService =
      accessory.getService(Svc.TemperatureSensor) ||
      accessory.addService(Svc.TemperatureSensor, accessory.displayName);

    // Initial value
    const initTemp = this.discoveryResult.currentTemp ?? 20;
    this.temperatureService
      .getCharacteristic(Char.CurrentTemperature)
      .updateValue(initTemp);

    // StatusActive: true if we found a temperature path
    this.temperatureService
      .getCharacteristic(Char.StatusActive)
      .updateValue(!!this.discoveryResult.tempFeaturePath);

    if (this.discoveryResult.tempFeaturePath) {
      platform.log.info(
        `${this.TAG} "${accessory.displayName}" — ` +
        `reading ${this.discoveryResult.tempLabel} (${this.discoveryResult.tempFeaturePath}) ` +
        `= ${initTemp}°C`
      );
    } else {
      platform.log.warn(
        `${this.TAG} "${accessory.displayName}" — no temperature feature found. ` +
        `Check logs for full feature list and open a GitHub issue.`
      );
    }
  }

  /**
   * Called by the platform update loop at each refresh cycle.
   */
  public update(features: ViessmannFeature[]): void {
    const { Characteristic: Char } = this.platform;
    const { tempFeaturePath, tempPropName } = this.discoveryResult;

    if (!tempFeaturePath || !tempPropName) {
      this.platform.log.debug(`${this.TAG} "${this.accessory.displayName}" — no path, skipping update`);
      return;
    }

    const feat = features.find(f => f.feature === tempFeaturePath);
    if (!feat?.isEnabled) {
      this.platform.log.debug(`${this.TAG} "${this.accessory.displayName}" — feature not found/enabled`);
      this.temperatureService.getCharacteristic(Char.StatusActive).updateValue(false);
      return;
    }

    const raw = feat.properties?.[tempPropName]?.value;
    if (typeof raw !== 'number') {
      this.platform.log.debug(`${this.TAG} "${this.accessory.displayName}" — non-numeric value: ${raw}`);
      return;
    }

    const temp = Math.max(-270, Math.min(100, raw));
    this.temperatureService.getCharacteristic(Char.CurrentTemperature).updateValue(temp);
    this.temperatureService.getCharacteristic(Char.StatusActive).updateValue(true);
    this.platform.log.debug(`${this.TAG} "${this.accessory.displayName}" — temp: ${temp}°C [${this.discoveryResult.tempLabel}]`);
  }
}
