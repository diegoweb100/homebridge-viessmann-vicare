/**
 * ViessmannRoomAccessory — one HomeKit accessory per room of a ViCare Smart Climate
 * "RoomControl" device (issue #4).
 *
 * Feature paths (confirmed on E3_RoomControl_One_05 with E3_RadiatorActuator TRVs):
 *   rooms.N.sensors.temperature        value (°C), status connected/notConnected
 *   rooms.N.sensors.humidity           value (%),  status connected/notConnected
 *   rooms.N.sensors.window.openState   value (boolean)  — optional
 *   rooms.N.temperature.levels.heating temperature (°C) — current heating setpoint
 *
 * Services per room:
 *   - TemperatureSensor (always)
 *   - HumiditySensor    (only when the room humidity sensor is connected)
 *   - ContactSensor     (window open/closed, only when the feature exists)
 *
 * Enable with:  "features": { "enableRoomSensors": true }
 * Room names:   "customNames": { "rooms": { "0": "Living room", "1": "Bedroom" } }
 */

import { PlatformAccessory, Service } from 'homebridge';
import { ViessmannPlatform } from '../platform';
import { ViessmannFeature, ViessmannDevice, ViessmannInstallation, ViessmannGateway } from '../viessmann-api-endpoints';
import { ViessmannHistoryLogger } from './history-logger';

/** Room indexes exposed by a device (rooms.N.sensors.temperature present and enabled). */
export function detectRoomIndexes(features: ViessmannFeature[]): number[] {
  const idx = new Set<number>();
  for (const f of features) {
    const m = /^rooms\.(\d+)\.sensors\.temperature$/.exec(f.feature);
    if (m && f.isEnabled !== false) idx.add(parseInt(m[1], 10));
  }
  return [...idx].sort((a, b) => a - b);
}

export class ViessmannRoomAccessory {
  private readonly tempService: Service;
  private humidityService?: Service;
  private windowService?: Service;
  private historyLogger?: ViessmannHistoryLogger;
  private readonly TAG: string;

  constructor(
    private readonly platform: ViessmannPlatform,
    private readonly accessory: PlatformAccessory,
    installation: ViessmannInstallation,
    gateway: ViessmannGateway,
    device: ViessmannDevice,
    private readonly roomIndex: number,
    features: ViessmannFeature[],
  ) {
    const { Service: Svc, Characteristic: Char } = platform;
    this.TAG = `[Room ${roomIndex}]`;

    accessory.getService(Svc.AccessoryInformation)!
      .setCharacteristic(Char.Manufacturer, 'Viessmann')
      .setCharacteristic(Char.Model, device.modelId || 'ViCare Room')
      .setCharacteristic(Char.SerialNumber, `${installation.id}-${device.id}-room${roomIndex}`);

    this.tempService = accessory.getService(Svc.TemperatureSensor)
      || accessory.addService(Svc.TemperatureSensor, accessory.displayName);
    this.tempService.getCharacteristic(Char.CurrentTemperature).setProps({ minValue: -30, maxValue: 60 });

    const feat = this.featureGetter(features);
    // Humidity only if a sensor is actually connected
    if (feat('sensors.humidity')?.properties?.status?.value === 'connected') {
      this.humidityService = accessory.getService(Svc.HumiditySensor)
        || accessory.addService(Svc.HumiditySensor, `${accessory.displayName} Humidity`);
    } else {
      const old = accessory.getService(Svc.HumiditySensor);
      if (old) accessory.removeService(old);
    }
    // Window open/closed
    if (feat('sensors.window.openState')?.properties?.value?.value !== undefined) {
      this.windowService = accessory.getService(Svc.ContactSensor)
        || accessory.addService(Svc.ContactSensor, `${accessory.displayName} Window`);
    }

    this.historyLogger = new ViessmannHistoryLogger(platform, accessory, 'thermo', `Room${roomIndex}`, installation.id, gateway.serial);

    // Hook into the platform refresh loop (it calls accessory.context.updateHandler)
    accessory.context.updateHandler = (feats: ViessmannFeature[]) => this.update(feats);
    this.update(features);
  }

  private featureGetter(features: ViessmannFeature[]) {
    const prefix = `rooms.${this.roomIndex}.`;
    return (suffix: string) => features.find(f => f.feature === prefix + suffix && f.isEnabled !== false);
  }

  public update(features: ViessmannFeature[]): void {
    const Char = this.platform.Characteristic;
    const feat = this.featureGetter(features);

    const t = feat('sensors.temperature');
    const temp = t?.properties?.value?.value;
    const connected = t?.properties?.status?.value !== 'notConnected';
    this.tempService.getCharacteristic(Char.StatusActive).updateValue(connected && typeof temp === 'number');
    if (typeof temp === 'number') {
      this.tempService.getCharacteristic(Char.CurrentTemperature).updateValue(temp);
    }

    if (this.humidityService) {
      const h = feat('sensors.humidity')?.properties?.value?.value;
      if (typeof h === 'number') this.humidityService.getCharacteristic(Char.CurrentRelativeHumidity).updateValue(Math.max(0, Math.min(100, h)));
    }

    if (this.windowService) {
      const open = feat('sensors.window.openState')?.properties?.value?.value === true;
      this.windowService.getCharacteristic(Char.ContactSensorState).updateValue(open
        ? Char.ContactSensorState.CONTACT_NOT_DETECTED
        : Char.ContactSensorState.CONTACT_DETECTED);
    }

    const setpoint = feat('temperature.levels.heating')?.properties?.temperature?.value;
    this.platform.log.debug(`${this.TAG} temp=${temp}°C setpoint=${setpoint ?? '-'}°C`);

    if (typeof temp === 'number' && this.historyLogger) {
      this.historyLogger.addThermoEntry({ currentTemp: temp, setTemp: typeof setpoint === 'number' ? setpoint : temp });
      this.historyLogger.appendRow({
        timestamp:  new Date().toISOString(),
        accessory:  `room${this.roomIndex}`,
        event_type: 'snapshot',
        room_temp:  temp,
        target_temp: typeof setpoint === 'number' ? setpoint : undefined,
      });
    }
  }
}
