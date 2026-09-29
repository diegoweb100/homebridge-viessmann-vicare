# Changelog

All notable changes to homebridge-viessmann-vicare.


### [2.0.81] - 2026-09-29
- feat: **one Viessmann dashboard** at `http://<homebridge-ip>:4200` (the OAuth `redirectPort`) replaces the separate login status page and report server:
  - Viessmann login with a clear *Log in to Viessmann* button, token and renewal status, *Log in again* / *Disconnect*
  - connection status: daily API usage, rate limit, response time, errors, age of the collected history
  - report generation in the background; reports are **saved** and listed until they expire (`reportRetentionDays`, default 30), with Open / Delete
  - **flue gas analyses**: add, edit and delete the installer's values with the same labels as the analyser printout; last result and due dates
  - Italian / English from the browser language, dark mode, phone layout
- feat: **automatic heating-curve optimisation** (`features.curveAutoTune`, off by default): once a day it compares the room with the program temperature over 48 h and corrects the curve by one step (slope ±0.1 when the error grows with the cold, otherwise shift ±1), within ±0.3 slope / ±3 shift from the starting curve, at most once every 48 h, only on heating days (outside the heating season: no API call, nothing written). Changes are logged and listed in the dashboard with *Restore the starting curve*
- feat: the dashboard shows the heating curve read from the boiler; the report's curve fields are only needed for boilers that do not report it
- change: the report and the dashboard adapt to any screen (phone, computer, TV): the whole layout — text, boxes, margins and charts — scales smoothly with the window width, side margins are small, boxes stretch to fill the row and long values wrap instead of spilling out (the page was limited to 1180 px)
- feat: report section **Outdoor sensor and area weather**: the boiler sensor compared with the Open-Meteo estimate for the installation coordinates (from ViCare), by day (maxima) and by night (minima), with the last 14 days; the average alone hid large night differences. "Real temperature" is now called **area weather (estimate)**: the sensor measures its own spot, the estimate describes open air around the house
- fix: report charts readable in light and dark mode: validated colour palette, solid dots with an outline, gas and outdoor temperature in separate charts (no double scale; area weather and boiler sensor side by side), temperature in the bar tooltips, and daily charts always show at least 14 days so short reports keep context
- change: the report server on `reportServerPort` (e.g. 3001) is no longer started, so only one port is used; `reportServerPort` is ignored (a log line says where the reports are now)
- feat: **flue gas analysis in the report**: values checked against the legal limits (CO air-free ≤ 1000 ppm, minimum efficiency by nominal power — Italy DPR 74/2013) and typical ranges, explained in plain words, compared over the years (rising CO or flue temperature = dirty heat exchanger/burner), next efficiency check (default every 4 years) and maintenance (default yearly), with advice when something is out of limits or due
- change (log): one clear block at startup with the dashboard address; the 🔐 AUTHENTICATION REQUIRED block with the full login URL is unchanged and now also points to the dashboard
- security: dashboard write actions need a custom header, so other web sites cannot change data on your network (CSRF)
- fix (HomeKit): the heating-circuit tile says **Heating** only while the burner is really heating that circuit (burner on, circuit pump running when the boiler reports it, no hot-water charge in progress); otherwise **Idle**, and **Off** in Off / Holiday / standby. It said "Heating" whenever the circuit was on. The Reduced / Normal / Comfort tiles follow the same rule; during Extended heating the dial shows the Comfort temperature, the one the boiler uses
- feat (HomeKit): the boiler alarm also opens when the boiler is **locked out after a fault** (`device.lock.malfunction`, reset needed); the optional notification says so
- feat (Eve app): **water pressure** of the heating system as Eve "Air pressure" in hPa (**1200 hPa = 1.2 bar**). Apple Home has no pressure sensor type, so it only appears in Eve (`features.exposeWaterPressureEve`, on by default)
- feat (HomeKit, #5): VitoCharge **grid exchange**: *Grid Draw*, *Grid Feed-in* and *House Consumption* power sensors (W) for automations (e.g. "feed-in above 2000 W → start the washing machine"). Before, the grid values were never read and were always 0. Sign checked on real VitoCharge data (positive = drawing from the grid)
- fix: each energy device writes only its own values to the history, so a separate wallbox no longer writes PV 0 W between the PV readings (averages were halved)
- feat (report, #1 #2 #5): new **Electricity: solar, battery, grid and car** section, shown only for installations that have these devices: kWh produced, home consumption, taken from and fed into the grid (with cost), **self-consumption** and **self-sufficiency**, battery average/minimum and kWh charged/discharged, car energy and charging sessions; daily energy chart, power through the day and battery charge. New advice when much solar power goes to the grid (move appliances and car charging to sunny hours, Apple Home automation) and when the battery never goes below a high level (backup reserve); menu entries for Energy and Rooms

### [2.0.80] - 2026-09-27
- feat: **report redesigned** for technicians and non-technical users alike (IT/EN):
  - an illustrated drawing of the system (outdoor, house, radiator, boiler, hot water, gas meter) with the period values
  - an overall score plus scores for comfort, efficiency, boiler, hot water and reliability
  - **assistant advice**: for each point, why it happens, what to do step by step, who does it and the estimated yearly saving in m³ and €; plus a "What is going well" list
  - in summer the advice uses the last heating season, so it stays useful all year
  - plain-language explanation under every value; glossary; sticky section menu; zoomable charts; dark mode
  - all the previous sections are kept: period overview with weekly schedule, gas & costs with monthly table and forecast, heating, heating curve, burner with heatmap, hot water, house heat loss and sizing, official Viessmann counters, solar/battery, rooms, boiler messages
- fix: every report value was checked against the raw data and against real gas bills:
  - burner starts, hours and run length now come from the boiler counters; ignition events were being counted as burner states
  - daily gas is taken from the monthly counters on local days (it was about 50% too high); partial months are marked
  - heating comfort only uses days when gas was really burned for heating (summer "heating" mode gave +11 °C "overheating")
  - modulation leaves out repeated stale values
  - Comfort-vs-Efficiency and "thermal efficiency" were removed: the boiler computes its heat figure from gas, so they were meaningless
  - hot water on combi/Eco boilers is judged on its peak temperature
  - device message times are shown in local time, and undocumented codes are labelled as such
  - the period is clamped to the first data
- feat: the report compares the boiler outdoor sensor with the real local temperature (Open-Meteo) and flags a biased sensor
- feat (HomeKit): new **boiler alarm** contact sensor. It opens on boiler fault codes (F.xx) or water pressure outside 0.8–3.0 bar, so Apple Home can notify you and run automations (`features.enableBoilerAlarm`, on by default)
- fix (HomeKit): the "creative" boiler sensors are no longer created by default and are removed from existing setups. These were gas as occupancy, starts per hour as air quality, temperature progress as humidity, pressure as a leak sensor and modulation as a light bulb. They made Apple Home report "Air quality: poor" and "Humidity 100%" for the whole home, and the leak sensor could raise false critical alerts. `features.enableLegacyDiagnosticSensors: true` restores them
- fix (HomeKit): heating **plans are mutually exclusive**, as in ViCare: Off, Normal (time schedule), Extended heating, Holiday at home and Holiday. Switching one on switches all the others off; switching the active one off returns to Normal. The plans now really change the boiler, so automations such as "last person leaves → Off" work. Only the programs the boiler really has are created:
  - Extended heating = `forcedLastFromSchedule` (Vitodens); `comfort.activate` on boilers without it
  - no separate heating Comfort switch (ViCare has none; the boiler refuses `comfort.activate` when extended heating exists). The switches match ViCare's list
  - Holiday at home = normal temperature all day, hot water as usual, `holidayAtHomeDays` (default 7)
  - Holiday = reduced temperature on every circuit, hot water off, frost protection, `holidayDays` (default 7)
  - Off = standby, from the heating-circuit tile or the Off entry in its mode menu
  - the Reduced switch is gone: the boiler has no command to select the reduced temperature
  - before, the program switches only re-sent the program's own temperature and flipped back after ~2 minutes
- feat (HomeKit): the Reduced / Normal / Comfort temperatures can be changed from Apple Home: one separate thermostat tile per level that follows the time schedule (only the level in force is on), usable in automations (`features.exposeProgramTemperatures`, on by default)
- fix: the heating dial shows the temperature of the program in force right after a restart (it showed the last program read, e.g. Comfort)
- fix: extended heating no longer uses the "alternative method" that set the Comfort temperature to 37 °C when the boiler refused the command. **If your Comfort temperature shows 37 °C, set it back** (Apple Home "Temp Comfort" tile or ViCare). If extended heating cannot be activated right now (e.g. standby / summer eco), the switch returns to its previous state and the log says why
- fix (HomeKit): **hot water modes are mutually exclusive**: Comfort, Eco and Off (plus extra modes). Switching the active one off returns to the default mode (`features.dhwDefaultMode`, default Eco); switching Eco off turns hot water off. No more "not responding" errors from scenes
- fix (HomeKit): the Holiday switch starts today (it started tomorrow) and lasts `holidayDays` days (default 7)
- fix (HomeKit): service names keep accented letters (a trailing "è" was dropped). The temperatures were removed from the program switch names: they went stale and renamed services at runtime. Names are consistent (custom heating-circuit name for Holiday / Holiday at home / Extended heating)
- feat (HomeKit): hot water temperature also as a temperature sensor (automation trigger, `features.exposeDhwTemperatureSensor`)
- feat (HomeKit, #1 #2 #5): Vitocharge / PV / battery / wallbox / heat-pump **power values as sensors** (W): PV production, battery charging, battery discharging, EV charging power, COP. They can trigger Apple Home automations (e.g. "PV above 3000 W → start the dishwasher") and no longer appear among the lights (the light bulbs remain with `enableLegacyDiagnosticSensors`). Created only for the devices the installation really has
- feat (HomeKit, #4): ViCare Smart Climate **room sensors are on by default** (`enableRoomSensors`). Accessories are created only for rooms that really exist
- feat: optional push message when the boiler alarm opens or clears (`features.alarmNotifyUrl`: Telegram, ntfy or any webhook)
- feat (HomeKit): `features.dhwTemperatureDisplay: "peak"` shows the highest hot-water temperature of the last hours, for combi boilers whose outlet sensor is lukewarm at rest
- feat: new `--elPriceEur` option (electricity price, default 0.30 €/kWh)
- feat: nothing in the report is tied to one location: the design temperature (coldest 3-day mean of the last 12 months) and the length of the heating-free season are derived from each installation's own weather; `--designTemp` still overrides
- feat: Grafana dashboard uses the ViCare names (Extended heating / Riscaldamento ampliato, Holiday at home / Ferie a casa) and marks water pressure above 3.0 bar in red like the boiler alarm. Re-import `grafana/viessmann-dashboard.json` to update
- chore: the pre-2.0.80 program handlers (the fake Reduced/Normal/Comfort switches and the 37 °C "alternative method") were removed from the code

### [2.0.79] - 2026-09-26
- fix: **report gas forecast** rewritten: weather-normalised degree-day model (real outdoor temperatures from Open-Meteo for the installation location, calibrated on the boiler yearly counters), daily gas from the monthly counters over the whole history. Works with any amount of data (was "0 m³" / "needs 300 days"). Options `--lat/--lon` and `--hddBase`

### [2.0.78] - 2026-09-26
- fix: **report "Device messages" were frozen**: the plugin stopped writing `viessmann-messages-<installation>-<device>.json` in 2.0.50, so the report showed months-old codes. The writer is back, now also includes fault codes (`device.messages.errors.raw`) and keeps a history (the API only returns current messages)
- fix: report heating-curve analysis uses only heating-season samples (outdoor < 16 °C): no more "weather compensation not active" advice in summer
- fix: report annual gas estimate requires ~a full year of data (a few summer weeks gave e.g. 52 m³/year)
- fix: report comfort-vs-efficiency is not evaluated when there is no space-heating gas in the period (it claimed "system optimisation is working" in summer)
- fix: report burner runtime shows one decimal below 1 %

### [2.0.77] - 2026-09-26
- fix: **30/90/365-day reports failed with "Load failed"**: report generation was O(n²) (90 days took ~3 min on a Raspberry Pi, now a few seconds), the browser request stayed open for minutes, and the report tab was opened after the wait (blocked as a pop-up by Safari). Reports now run as background jobs polled by the page, and the tab is opened at click time
- fix: report analysis: no false "short cycling" alarm when burner hours changed by less than 2 h (integer counter), heating-curve check uses only samples with the circuit in heating mode, 30-day gas forecast uses the period average with fewer than 14 days of data
- fix (#3): the OAuth authorization URL is now always printed in the log (Docker/Umbrel installs never showed it)
- fix (#6): no more empty extra "Boiler" accessory for energy devices (e.g. VitoCharge); a stale one is removed automatically
- fix: room-sensor discovery accessories were never refreshed, and could show a non-temperature value (e.g. 0 °C from heatingCircuitId)
- feat (#4): **ViCare Smart Climate rooms**: one HomeKit accessory per room (temperature, humidity when connected, window open/closed) with `features.enableRoomSensors: true`; names via `customNames.roomNames`
- feat (#8): DHW modes other than comfort/eco/off (e.g. `balanced`, `efficient`, `efficientWithMinComfort`) get their own switch; new **one-time hot water charge** switch ("Warm water once") when the device supports `heating.dhw.oneTimeCharge`
- feat: Grafana dashboard: text tiles (burner, program, modes, status code) no longer show "No data", state timelines stop at "now", sparse series show points

### [2.0.76] - 2026-09-26
- fix: report web server (`reportServerPort`) could stop silently: it was started with `execFile`, which buffers the child output (1 MB max) and kills it when the buffer is full, especially with `debug: true`. It could also fail with the port still held by an orphan process after a restart. The server now runs as a supervised child process: output goes to the Homebridge log, errors and exits are logged, it restarts automatically with back-off (max 5 attempts) and it is stopped when Homebridge shuts down

### [2.0.75] - 2026-09-26
- fix: history values equal to **0** were written as empty/NULL (`value || undefined`): daily/monthly gas, heat production and outside temperature of 0 now stored correctly (e.g. heating gas in summer)
- fix: burner update statistics counted debounced updates as attempts (success rate shown ~50%): now only processed updates are counted
- fix: `viessmann-api-status.json` reported a hard-coded plugin version (2.0.71): now uses the real version
- fix: daily burner starts/hours reference now resets at local midnight (was UTC)
- fix: **live data was cached for hours/days**: device feature URLs (`/features/installations/.../features`) matched the *installations* cache rule first, so temperatures, burner state and counters were served from cache with the installations TTL (24 h by default) and only refreshed after a command or a restart. Feature data now uses `featuresTTL`, always shorter than `refreshInterval`. Note: the plugin now really polls the API every `refreshInterval` (≈720 requests/day per device at the 2-min default; Viessmann free plan allows 1450/day)
- feat: new MySQL-only columns: `water_pressure_bar`, `gas_heating/dhw_year_m3`, `heat_heating/dhw_year_kwh`, `power_heating/dhw_day/month/year_kwh` (boiler electricity), `status_code` (latest S.xx/F.xx message), `wifi_rssi`
- feat: automatic schema migration: missing columns are added on startup (`ALTER TABLE`, requires ALTER privilege, otherwise the SQL to run is logged)
- feat: `viessmann-sync-events.js` also writes burner ON/OFF and demand events to MySQL when `logging.mysql.enabled` is true (`--no-mysql` to skip)
- feat: bilingual Grafana dashboard (Italian default / English) shipped in `grafana/viessmann-dashboard.json`
- chore: `mysql2` moved from `optionalDependencies` to `dependencies`: no more manual `npm install mysql2`
- chore: TypeScript sources of 2.0.72–2.0.74 realigned in the repository

### [2.0.74] - 2026-06-23
- feat: optional MySQL/MariaDB history logging (`logging.mysql.*` config section) — direct Grafana integration without import scripts
- feat: 13 extra DB-only columns: `boiler_water_temp`, `hc_operating_mode`, `hc_comfort/normal/reduced_temp`, `hc_slope/shift`, `holiday_mode_active`, `extended_heating_active`, `dhw_mode`, `dhw_circulation_pump`, `installation_id`, `gateway_serial`
- feat: table auto-created on first run; existing CSV imported automatically in background
- feat: `logging.csv.enabled` flag (default `true`) — CSV can now be disabled if using MySQL exclusively
- chore: `mysql2 ^3.11.0` added as `optionalDependencies`

### [2.0.73] - 2026-06-23
- fix: report server timeout default corrected from 300 s to 600 s; max raised from 1800 s to 3600 s
- fix: `platform.ts` timeout fallback corrected from 300 s to 600 s

### [2.0.72] - 2026-06-23
- fix: `readApiStatus` function missing from report server — caused crash on every `GET /` request (`ReferenceError: readApiStatus is not defined`)
- chore: axios updated to `^1.17.0`

### [2.0.71] - 2026-05-30
- feat: API usage dashboard card in report server UI (daily usage bar, health score, rate limit status)
- feat: `writeApiStatusFile` writes `viessmann-api-status.json` after each update cycle

### [2.0.70] - 2026-05-29
- feat: TRV / Room Sensor discovery mode (`features.enableRoomSensorDiscovery`) — scans all gateway devices, logs every API feature path+value tagged `[RoomDiscovery]`, creates a provisional HomeKit `TemperatureSensor` for each device with a temperature reading
- feat: report generation timeout now configurable (`reportServerTimeout`, default 300 s, range 60–1800 s) — exposed in Homebridge Config UI X
- fix: report server `--timeout` arg forwarded from plugin config to child process

### [2.0.68] - 2026-05-29
- fix: report server now logs actual LAN IP (`http://192.168.x.x:PORT`) instead of `localhost`/`0.0.0.0` — URL is reachable from any device on the network
- fix: report generation timeout raised from 60 s to 300 s — fixes timeout error with large CSV files (90+ days, 26 000+ rows)
- fix: error response from report server now includes full stderr so the UI displays the actual cause
- feat: comprehensive debug logging in report server (`--debug` flag, forwarded automatically when plugin `debug: true`)
- fix: `platform.ts` log messages no longer have redundant `[Viessmann]` prefix (Homebridge already adds it)

### [2.0.67] - 2026-05-29
- fix: OAuth authentication URL never shown in Docker/Umbrel/container environments — URL now printed unconditionally before any environment check (FIX#5)
- fix: improved headless detection: `DISPLAY`/`WAYLAND_DISPLAY` check and `DOCKER`/`CONTAINER` env vars — covers Docker, Umbrel, and headless Linux
- fix: `tryOpenBrowserDirect()` error callback now also emits the URL as fallback for undetected environments

### [2.0.66] - 2026-03-19
- fix: HTTP 400 (gateway offline / boiler off) no longer causes log spam — strengthened detection via both response.status and message string fallback

### [2.0.65] - 2026-03-19
- fix: HTTP 400 (gateway offline / boiler off) no longer triggers aggressive retry and error logs
- fix: api-client.ts — 400 responses skip retry loop, logged at debug level only
- fix: platform.ts — 400 during update cycle logged as debug "⏸️ gateway offline", not error
- fix: platform.ts — 400 during initial setup logged as debug, not error

### [2.0.64] - 2026-03-18
- fix: CSV cleanup — 4 rows with invalid program='heating' (from first run on 10/03) corrected to empty string
- fix: version bump (v2.0.63 was already published)

### [2.0.63] - 2026-03-18
- fix: ReferenceError T() in browser — chart labels now evaluated at build time via \${} wrapper
- fix: tooltip callbacks use pre-injected _tooltip object with _tt() helper
- fix: thermal efficiency note still hardcoded in Energy Summary section

### [2.0.63] - 2026-03-18
- fix: SyntaxError "Unexpected identifier" in browser — chart labels T() values were emitted without quotes (label:Temp. ambiente (°C) instead of label:"Temp. ambiente (°C)")
- fix: all 40 chart label and axis T() expressions now correctly wrapped in quotes in generated HTML

### [2.0.62] - 2026-03-18
- fix: report server UI — Language selector now always visible as dedicated card (was hidden inside Advanced panel)
- fix: Advanced panel — curve slope and shift now have separate labeled fields
- fix: report server UI card order: Period → Installation → Language → Advanced

### [2.0.62] - 2026-03-18
- fix: all remaining hardcoded English strings in IT report (Cycle performance, Modulation & gas, Burner activity by hour, Daily gas consumption, Flow temperature note, Reset zoom, trend: label)
- fix: report server language selector moved to correct position in Advanced panel (col 1, below Boiler KW)

### [2.0.62] - 2026-03-18
- feat: complete i18n — 100% of visible text translated, zero English strings in Italian report
- feat: all Chart.js dataset labels translated (Room temp, Flow temp, Heat demand, Heating curve, Condensing limit, Trend, etc.)
- feat: program schedule labels translated (Normal→Normale, Reduced→Ridotto, Heating→Riscaldamento, Off→Spento)
- feat: report header period/generated/samples line translated
- feat: heatmap legend (Low/High) translated
- fix: condensing mode/score unit shows "100% del tempo" correctly
- fix: houseEff comparison uses CSS class instead of translated label
- fix: effLabel badge uses T() for High/Severe
- fix: report server language selector in correct position

### [2.0.61] - 2026-03-17
- feat: complete i18n — all report strings translated (section headers, KPI labels, badges, chart notes, boiler notes, forecast, device messages)
- fix: self-referencing T() calls inside STRINGS block
- fix: broken forecast note template literal
- fix: unescaped apostrophes in EN/IT string literals

### [2.0.60] - 2026-03-17
- feat: Heat Demand scatter now includes theoretical heat loss line Q=H×(Ti-To) in green
- feat: Estimated condensing score (return temp model) added to HC0 section
- feat: Comfort vs Efficiency section — shows placeholder with data accumulation progress when < 30 days
- fix: i18n strings — escaped apostrophes in Italian strings

### [2.0.59] - 2026-03-17
- feat: i18n system — English and Italian with --lang CLI param (extensible to any language)
- feat: all section titles, KPI labels and insight strings translated
- feat: actionable recommendations with concrete actions and estimated impact
- feat: --lang selector in report server web UI

### [2.0.58] - 2026-03-17
- fix: TypeError "c.canvas.addEventListener is not an object" in scatter charts (zoom feature)

### [2.0.57] - 2026-03-17
- feat: zoom & pan on Heat Demand and Flow Temperature scatter charts (scroll wheel, pinch, drag, double-click reset)

### [2.0.56] - 2026-03-17
- feat: new chart "Flow Temperature vs Outdoor — Actual vs Heating Curve" (separate from heat demand scatter)
- fix: removed heating curve from heat demand scatter (incompatible units on same axis)
- fix: scatter chart restored to single Y axis

### [2.0.56] - 2026-03-17
- fix: heating curve moved to dedicated "Flow Temperature vs Outdoor" chart (scatter chart restored to single Y axis)
- feat: flow temp chart shows actual flow temp points + theoretical heating curve + 55°C condensing limit line

### [2.0.55] - 2026-03-17
- feat: heating curve overlay on Heat Demand vs Outdoor Temperature scatter chart (non-linear, fitted from ViCare app data)
- feat: heating curve slope/shift auto-read from viessmann-history-explore JSON per installation/circuit
- feat: viessmann-explore-history.js now reads heating.circuits.*.heating.curve for all circuits
- fix: curve formula uses cubic polynomial fit (±2°C accuracy) instead of linear approximation

### [2.0.54] - 2026-03-17
- fix: viessmann-explore-history.js added to npm package files (was missing since initial release)

### [2.0.53] - 2026-03-17
- feat: viessmann-sync-events.js — fetches burner ON/OFF events from API events-history with second-precision timestamps
- fix: Device Messages section now correctly inside max-width container
- fix: viessmann-sync-events.js added to npm package files

### [2.0.52] - 2026-03-17
- feat: hourly burner heatmap in report (24-cell grid, runtime %, outdoor temp on hover)
- feat: daily thermal efficiency chart from CSV (heat_heating_day_kwh / gas × 10.55)
- feat: energy flow chart for PV/battery/grid/wallbox installations
- feat: emoji icons on all report section headers
- fix: CSV migration — hc0/dhw post-deploy rows now correctly detected (35-col format)
- fix: hc0/dhw appendCsvRow now includes event_type='snapshot' for future-proof migration
- fix: viessmann-history-YOUR_INSTALLATION_ID.csv migration script updated (re-run if needed)

### [2.0.51] - 2026-03-16
- fix: viessmann-report-server.js missing from npm package (added to files field)

### [2.0.50] - 2026-03-16
- feat: Report web server (viessmann-report-server.js) — configurable port, auto-detect installations, all params from UI
- feat: reportServerPort + reportServerPath in plugin config and Homebridge UI
- feat: CSV — 9 new columns: event_type, burner_starts/hours_today (delta), gas/heat monthly, heat production day/month
- fix: Burner on/off events written to CSV immediately (not only at 15-min snapshot)
- fix: Statistics read before burner state change detection — event row has accurate starts/hours

### [2.0.49] - 2026-03-16
- fix: battery standby state now correctly shows 0W (not discharge)
- fix: PV daily yield unit-aware conversion (wattHour vs kilowattHour)
- fix: COP service comment corrected (×20 not ×10)

### [2.0.48] - 2026-03-16
- fix: VitoCharge ESS battery/PV paths; eebus wallbox vcs.* paths
- fix: PV kilowatt→watt conversion; activePower property; daily yield from cumulated

### [2.0.47] - 2026-03-15
#### Fixed
- **Extended Heating state: HomeKit OFF while ViCare ON** — confirmed via live API: `forcedLastFromSchedule.active=True` is a schedule management artifact (always present), not an Extended Heating indicator. State now reads `comfort.active OR (programs.active === comfortFeatureSuffix)`. Deactivation uses `comfort.setTemperature` as fallback when `deactivate` is not executable (Vitodens).
- **Extended Heating / comfort program: API-driven feature discovery** — removed hardcoded candidate list `['comfort', 'comfortHeating']`. Plugin now discovers the comfort program by scanning actual device features for any enabled `programs.*` that has an `activate` command, excluding known non-comfort programs. Works for Vitodens (`programs.comfort`), Vitocal gen3 (`programs.comfortHeating`), and any future device model without code changes.
- **HC active program normalisation: pattern-based** — replaced fixed `programNormMap` with `startsWith` pattern matching (`comfort*` → `comfort`, `normal*` → `normal`, `reduced*` → `reduced`). Handles any future variants from new device models automatically.
- **Device messages: per-device file** — `writeDeviceMessages` now writes `viessmann-messages-<installationId>-<deviceId>.json` (previously single file per installation, causing overwrite when multiple devices present, e.g. Vitocal + VitoCharge). Report aggregates all matching files.
- **Device messages written at startup** — `setupDeviceAccessories` now calls `writeDeviceMessages` so the file exists immediately on startup, not only after the first update cycle.
- **Compressor setpoint path: dynamic** — `heating.compressors.0.speed.setpoint` was hardcoded. Now derived from resolved `hpPaths.compressorMod` by replacing `.current` with `.setpoint` — correct for any device/compressor index.

### [2.0.48] - 2026-03-15
*(published separately)*

### [2.0.49] - 2026-03-16
- fix: battery standby state now correctly shows 0W (not discharge)
- fix: PV daily yield unit-aware conversion (wattHour vs kilowattHour)
- fix: COP service comment corrected (×20 not ×10)

### [2.0.48] - 2026-03-16
- fix: VitoCharge ESS battery/PV paths; eebus wallbox vcs.* paths
- fix: PV kilowatt→watt conversion; activePower property; daily yield from cumulated

### [2.0.47] - 2026-03-15
*(published separately)*

### [2.0.46] - 2026-03-15
*(published separately)*

### [2.0.45] - 2026-03-15
*(published separately)*

### [2.0.44] - 2026-03-15
*(published separately)*

### [2.0.43] - 2026-03-15
*(published separately)*

### [2.0.42] - 2026-03-15
#### Fixed
- **Extended Heating always OFF on heat pump installations** — the entire Extended Heating (comfort boost) feature was conditioned on `programs.comfort` existing in the device features. Vitocal gen3 uses `programs.comfortHeating` instead. The plugin now resolves the correct feature name once at setup (`comfortFeatureSuffix`), trying `comfort` first then `comfortHeating`. All API calls — setup detection, update cycle state reading, activate/deactivate commands, temperature changes — use the resolved name. Fixes HomeKit showing OFF while ViCare app shows ON.
- **HC program names on heat pump installations** — Vitocal 250A returns `normalHeating`, `reducedEnergySaving`, `comfortHeating` etc. instead of plain `normal`/`reduced`/`comfort`. These were silently ignored, leaving `currentProgram` stale. A normalisation map now converts all HP program variants to the canonical set used by HomeKit switches.
- **Gas forecast annual estimate threshold** — minimum 14 days of gas data required before showing annual projection. With fewer days the estimate was unreliable. Report now shows a "Need N days" badge and a clear message when threshold not met.

#### Added
- **`maxCompressorRps` config option** — configures the maximum compressor speed (rps) used to normalise heat pump modulation to 0–100% in HomeKit. Default: 50 rps (Vitocal 250A). If measured rps exceeds this value the plugin logs a warning with a suggested corrected value. Set in Homebridge config: `"maxCompressorRps": 60`.
- **Compressor setpoint logging** — debug log now shows both `current` and `setpoint` rps alongside the normalised modulation % for calibration visibility.
- **Device messages JSON** — plugin now writes `viessmann-messages-<installationId>.json` to Homebridge storage on every update cycle. Contains S./F./I. codes with timestamps from `device.messages.status/info/service.raw` features. Used by the `viessmann-report.js` Device Messages section.

### [2.0.41] - 2026-03-15
#### Fixed
- **Duplicate Boiler accessory on heat pump installations** — `setupBoilerAccessory` was matching `heating.boiler.serial` which is present on VitoCharge and other gen3 devices as a system identifier. Filter now requires actual burner/boiler operation features (`heating.burners.*`, `heating.boiler.temperature.current`, etc.). Fixes "Boiler 2" / "Energy 2" confusion reported on Windows installations with Vitocal 250A.

#### Added — `viessmann-report.js`
- **Gas forecast section** — projects next-30-day and annual gas consumption using linear regression on historical CSV data. Shows cost estimate in € with configurable tariff via `--gasPriceEur` (default: 0.90 €/m³). Includes trend indicator (rising/stable/falling).
- **Device messages section** — reads `viessmann-messages-<ID>.json` (written by plugin, future) and displays S./F./I. codes with English translations from Viessmann service documentation (80+ codes covered).
- **`--gasPriceEur`** CLI parameter for gas cost calculation.

### [2.0.40] - 2026-03-15
#### Fixed
- **Critical: Accessories not updating after Homebridge restart** — when restoring accessories from cache, `device`, `installation`, and `gateway` were not written to `accessory.context`. The update loop silently skipped all accessories on every subsequent restart, showing `0 device(s) fetched, 0/0 accessories updated`. All four restore-from-cache paths (Boiler, DHW, Heating Circuit, Energy/Heat Pump) are now fixed.

#### Changed
- **Full feature dump** — moved from `INFO` to `DEBUG` level; only visible when `debug: true` is set in plugin config.
- **Capability detail log** — resolved HP paths and capability breakdown moved to `DEBUG`; single compact `INFO` line now summarises detected capabilities (e.g. `Capabilities detected: HeatPump`).
- **`updateHandler not set` warning** — downgraded from `WARN` to `DEBUG`. Per-device spam eliminated; update cycle summary still shows the count when non-zero.

#### Notes
- Users upgrading from ≤ v2.0.38 with a heat pump may see ghost "Heat Pump" accessories in Homebridge cache. Remove via Homebridge UI → Settings → Remove Single Accessory.

### [2.0.39] - 2026-03-11
#### Fixed
- **Critical: Heat pump device detection** — `isHeatPumpDevice()` was incorrectly matching ALL Viessmann gen3 devices because `type:E3` is a gen3 architecture marker present on every device (TCU gateway, TRVs, room sensors, repeaters, VitoCharge, HEMS, wallbox, etc.). Detection now requires `type:heatpump` (exact role) or modelId containing `vitocal`. This was causing spurious "Adding new energy accessory: … Heat Pump" log entries for every device.
- **Heat pump path resolution** — Fixed `compressorActive` path to use `heating.compressors.0` (correct for Vitocal 250A gen3), `compressorMod` to use `heating.compressors.0.speed.current`, `returnTemp` to use `heating.sensors.temperature.return`, `cop` to use `heating.scop.heating` / `heating.spf.heating`.
- **Energy device detection** — PV/Battery/Wallbox capabilities now also detected from device roles (`type:photovoltaic;integrated`, `type:ess`, `type:accessory;vehicleChargingStation`) in addition to feature path scanning. VitoCharge ESS+PV and wallbox now correctly identified.
- Added compressor speed modulation read (`heating.compressors.0.speed.current` in rps, normalised to 0–100%).

### [2.0.38] - 2026-03-11
#### Added
- **Heat pump support (Wärmepumpe)** — automatic device detection via `roles` field (`type:heatpump`, `type:E3`, Vitocal modelId); creates a dedicated HomeKit HeaterCooler accessory (compressor state, outside temp) and a COP Lightbulb (Brightness = COP × 20%)
- **Energy / Heat Pump accessory** fully integrated into the standard discovery flow — no separate config required
- **Full feature dump** — on first startup every device logs ALL feature paths (name, enabled state, property values, available commands) at INFO level; essential for reverse-engineering unknown device types
- **Automatic path resolution for heat pumps** — tries multiple known path variants for compressor, outside temp, supply/return temp and COP; logs which paths were found and which were not
- **`roles` and `brand` fields** added to `ViessmannDevice` interface and device mapping (previously discarded from API response)
- **PV, battery, wallbox, electric DHW** accessories now properly integrated in main discovery (were previously only in beta branch)

#### Changed
- `setupDeviceAccessories` in `platform.ts` now calls `setupEnergyAccessory` as the last step — gas boiler users see zero impact (silent `return` if no energy features found)

### [2.0.37] - 2026-03-10
#### Added
- **Comfort stability** — standard deviation of room temperature samples, rated Excellent (<0.2°C) / Good (<0.5°C) / Unstable
- **Cycling severity score** — composite score (cycles/hour × 10/avgDuration): Excellent <1, Acceptable 1–3, Severe >3
- **Minimum modulation check** — detects boiler operating near minimum modulation with short cycles (possible oversizing)
- **Estimated system efficiency** — heatProduced(kWh) ÷ gasUsed(m³ × 10.6 kWh/m³), shown as % (requires `--boilerKW` + gas data)
- **Heating curve behaviour** — Pearson correlation between outdoor temp and flow temp: weather-compensated / fixed flow / misconfigured
- **Heat Demand vs Outdoor Temperature scatter plot** — each point is one burner-active sample; red regression line shows heating curve slope and estimated balance point (outdoor temp where heating demand = 0)

### [2.0.36] - 2026-03-10
#### Added
- **Heating System Assistant** — new *System Analysis* section in the HTML report with deterministic diagnostics:
  - **Heat demand** (kW): avg modulation × nominal power (requires `--boilerKW`)
  - **House heat loss coefficient** (kW/°C): heat demand ÷ ΔT (room vs outdoor)
  - **Estimated peak load** (kW): heat loss × (room setpoint − design temp, default −7°C)
  - **House efficiency rating**: Excellent / Good / Average / Poor based on heat loss coefficient
  - **Boiler sizing check**: warns if nominal power > 2× estimated peak load
  - **Cycling diagnostics**: cycles/hour, short-cycling detection (avg < 5 min), excessive cycling (> 6/hr)
  - **Flow temperature heuristic**: suggests lowering heating curve if flow > 55°C when outdoor > 5°C
  - **Human-readable insight cards**: ✅ / ⚠️ / ℹ️ with actionable explanations
- **New CLI parameters**: `--boilerKW <kW>` (nominal boiler power), `--designTemp <°C>` (design outdoor temp, default −7°C)
- All kW-based calculations gracefully hidden if `--boilerKW` is not provided — report works for all users

### [2.0.35] - 2026-03-10
#### Added
- **Multi-installation support** — CSV and schedule files are now per-installation: `viessmann-history-<ID>.csv` and `viessmann-schedule-<ID>.json`. Each installation writes its own file, no data mixing.
- **`--installation <ID>` parameter** for report generator — selects the correct CSV and schedule file for the specified installation ID.

#### Migration
Rename existing CSV and schedule files to include your installation ID:
```bash
mv /var/lib/homebridge/viessmann-history.csv /var/lib/homebridge/viessmann-history-YOUR_INSTALLATION_ID.csv
mv /var/lib/homebridge/viessmann-schedule.json /var/lib/homebridge/viessmann-schedule-YOUR_INSTALLATION_ID.json
```

### [2.0.34] - 2026-03-10
#### Fixed
- **Schedule bands overlay removed** — Canvas-based overlay approach caused all charts to break across multiple attempts. Replaced entirely with a pure HTML/CSS horizontal bar below the overview chart.
- **Schedule bands wrong position** — band X positions were calculated using string comparison which matched label indices incorrectly. Replaced with numeric minutes-since-midnight comparison so bands align precisely to the actual schedule times.

#### Added
- **Heating schedule bar** — A pure HTML/CSS bar under the overview chart shows the full 24h schedule split into colored segments: 🟢 Normal, ⬜ Reduced, 🟠 Comfort, 🔴 Off. Computed server-side at report generation time, zero JavaScript, zero Chart.js interference. Tooltip on hover shows mode and duration in hours.

### [2.0.33] - 2026-03-10
#### Fixed
- **All charts broken in v2.0.32** — `Chart.register()` approach caused re-render interference. Removed all canvas overlay attempts entirely, replaced with server-side HTML/CSS schedule bar (implemented in v2.0.34).

### [2.0.32] - 2026-03-10
#### Fixed
- **All charts broken in v2.0.31** — the schedule bands overlay used `plugins:[{...}]` at the Chart.js root level which is invalid syntax in Chart.js 3/4 and caused all charts to fail silently. Replaced with `Chart.register()` + `Chart.getChart()` approach called after chart instantiation. Also fixed band positioning to use label index lookup instead of ISO string matching.

### [2.0.31] - 2026-03-10
#### Added
- **Heating schedule awareness** — the plugin now persists the weekly heating schedule to `viessmann-schedule-<ID>.json` after every API refresh, reading `heating.circuits.0.heating.schedule` (timeslots with `mode`, `start`, `end` per weekday).
- **HTML report: Today's schedule stat card** — shows the active timeslots for the current day (e.g. `06:00–07:30 normal, 17:00–23:00 normal · rest: reduced`) in the HC0 section.
- **HTML report: Schedule bands overlay** — the overview chart renders subtle background bands to visually align temperature/burner data with the programmed schedule.

### [2.0.30] - 2026-03-10
#### Fixed
- **Daily gas chart not rendering** — the Chart.js initializer for `cGas` was nested inside the `cycleCount>=3` conditional block. If fewer than 3 burner cycles were present the gas chart canvas was drawn but never initialized. Extracted as independent block, now renders whenever gas data is available (`hasGasChart=true`).

### [2.0.29] - 2026-03-10
#### Fixed
- **Outdoor temperature chart** — `outside_temp` is written by boiler accessory but was incorrectly read from `hcRows` in the report; fixed to read from `boilerRows`. Outdoor temp now appears correctly in overview chart and dedicated series.

#### Added
- **Daily gas consumption chart** — stacked bar chart (heating = dark blue, DHW = teal) + red line overlay for daily total. Aggregates `max(gas_*_day_m3)` per calendar day so the daily reset at midnight is handled correctly.
- README: expanded HTML report section, added automated email script + crontab scheduling examples, updated "What is recorded" table.

### [2.0.28] - 2026-03-10
#### Added
- **Flow temperature logging** — `heating.circuits.N.sensors.temperature.supply` now read and logged to CSV as `flow_temp` column from HC0 accessory.
- **HTML report** — interactive multi-chart report (`viessmann-report.js`) with overview chart, burner cycles, temperature history, condensing analysis, flow temp, gas consumption, and stat cards. Run with `node viessmann-report.js --installation YOUR_INSTALLATION_ID --days 7`.
- Condensing badge in report: shows % time in condensing mode (flow temp ≤ 57°C).
- Cache statistics and custom names in report header.

### [2.0.27] - 2026-03-10
#### Added
- **Energy accessory** (`energy-accessory.ts`) — auto-detected from `heating.solar`, `heating.circuits.0.circulation.pump`, PV/battery/grid features. Exposes ContactSensor services for each detected energy device.
- Energy data columns in CSV: `pv_production_w`, `pv_daily_kwh`, `battery_level`, `battery_charging_w`, `battery_discharging_w`, `grid_feedin_w`, `grid_draw_w`, `wallbox_charging`, `wallbox_power_w`.

### [2.0.26] - 2026-03-10
#### Added
- **Gas consumption logging** — `gas_heating_day_m3` and `gas_dhw_day_m3` columns added to CSV, read from `heating.gas.consumption.heating` and `heating.gas.consumption.dhw` features.

### [2.0.25] - 2026-03-10
#### Fixed
- **DHW state update delays** — DHW target temp and program now update within 2s of API confirmation instead of waiting for the next full refresh cycle.

### [2.0.24] - 2026-03-10
#### Fixed
- **HAP feedback loop on ExtendedHeating switch** — incorrect initial state after restart caused HomeKit to immediately call `setExtendedHeating(false)` on load, triggering an unwanted API command. Fixed with proper state initialization guard.

### [2.0.23] - 2026-03-09
#### Fixed
- **Auth token refresh race condition** — concurrent requests could trigger multiple simultaneous refresh attempts. Added mutex lock around token refresh logic.

### [2.0.22]
#### Fixed
- **`updateAllCharacteristics()` HAP feedback loop** — when characteristic values were pushed to HomeKit, HAP called back the setter synchronously. Fixed with `_updatingCharacteristics` guard flag cleared via `setImmediate()`.

### [2.0.21] - 2026-03-05
#### Fixed
- **`ExtendedHeating` incorrect initial state after restart** — switch showed wrong state on Homebridge startup, causing immediate unwanted command. Fixed with proper cache-aware initialization.

### [2.0.20] - 2026-03-05
#### Fixed
- 🐛 **Stale cache read in command confirmation retry** — `scheduleCommandConfirmation` was calling `getDeviceFeatures()` without invalidating the cache first. Fixed by adding `clearCache()` before each retry, on all three accessories (DHW, HC, Boiler).

### [2.0.19] - 2026-03-05
#### Fixed
- 🐛 **HAP feedback loop on `updateAllCharacteristics()`** — when switch states were pushed to HomeKit, HAP called back `setEcoMode(false)` / `setOffMode(false)` synchronously, triggering redundant API commands and repeated `Cannot deactivate Off mode` warnings. Fixed by adding a `_updatingCharacteristics` guard flag; cleared via `setImmediate()` after HAP processes all synchronous callbacks.

#### Changed
- 🔧 `postCommandRefreshDelay` config parameter removed and replaced by `postCommandRetry.delays` (array of ms, default `[5000, 15000, 30000, 60000]`) and `postCommandRetry.guardDuration` (ms, default `120000`).
- 🔧 `scheduleStateRefresh()` replaced by `scheduleCommandConfirmation()` in all three accessories.
- 🔧 Applied uniformly to `dhw-accessory`, `boiler-accessory`, and `heating-circuit-accessory`.

### [2.0.18] - 2026-03-02
#### Fixed
- 🐛 **Double `handleManualAuth()` call eliminated** — when auto-auth failed, `handleManualAuth()` was being called twice. Fixed: `performAutoAuth()` now simply rethrows, leaving `authenticate()` as the single point of fallback control.

#### Changed
- 🔧 Removed all commented-out dead code from `auth-manager.ts`. No functional change, cleaner codebase.

### [2.0.17] - 2026-03-02
#### Fixed
- 🐛 **Progressive command confirmation replaces single-shot refresh** — after every command all accessories now retry API confirmation up to 4 times (at 5s, 15s, 30s, 60s). Each retry extends the pending guard, preventing the regular update cycle from overwriting local state while the Viessmann backend propagates.
- 🐛 **External change detection during guard window** — if the API returns a value that is neither the pre-command nor the expected post-command value, the guard is immediately reset and the external change is applied.
- 🐛 **Guard duration now covers the full retry window** — `pendingXxxUntil` is set to `guardDuration` (default 120s) instead of the previous hardcoded 10s.

### [2.0.16] - 2026-03-02
#### Fixed
- 🐛 Cache invalidation on command — `clearCache()` now called before each confirmation retry to prevent stale reads masking actual state changes.

### [2.0.15] - 2026-02-28
#### Added
- ✨ **Boiler accessory** (`boiler-accessory.ts`) — exposes burner active status, modulation, outside temperature, humidity, and DHW temperature as HomeKit sensors.
- ✨ **History logger** (`history-logger.ts`) — logs all sensor data to CSV every refresh cycle with FakeGato support for Eve app graphs.


### [2.0.4] - 2025-10-06
**Added**
- ✨ `logEnvDiagnostics()` for better detection of graphical environment (X11, Wayland, systemd, headless).
- ✨ New fallback page `/login` for authentication via another device on the same LAN.
- ✨ Auto-authentication now supported even in headless environments (Raspberry Pi, systemd, Docker).
**Changed**
- ✨ Default `authMethod` is now `"auto"` in all examples and documentation.
- ✨ Improved resilience in `openBrowser()` on Linux with fallback to `xdg-open`, `gio`, and `xdg-desktop-portal`.
**Fixed**
- 🐛 Timeout and fallback flow now properly logged when auto-auth fails.
- 🐛 Documentation and setup guide reflect the new authentication behavior.

### v2.0.0
- ✨ **Major Release**: Complete rewrite with advanced features
- ✨ **Complete Localization Support**: Custom names for all accessories in any language
- ✨ **Intelligent Cache Management**: Multi-layer caching with configurable TTL
- ✨ **Advanced Rate Limiting Protection**: Exponential backoff with smart recovery
- ✨ **Complete UI Configuration**: All parameters exposed in Homebridge Config UI X
- ✨ **Enhanced Installation Filtering**: Filter by name or ID with debug information
- ✨ **Feature Toggle Controls**: Enable/disable specific accessory types
- ✨ **Individual Temperature Programs**: Separate controls for Reduced/Normal/Comfort modes
- ✨ **Enhanced Holiday Modes**: Full support for Holiday and Holiday at Home programs
- ✨ **Extended Heating Mode**: Quick comfort boost functionality
- ✨ **Advanced Timeout Controls**: Configurable timeouts and retry mechanisms
- ✨ **Intelligent Retry Logic**: Alternative API endpoints and smart backoff
- ✨ **Performance Monitoring**: Real-time diagnostics and cache statistics
- ✨ **Improved Error Recovery**: Better handling of temporary API issues
- 🐛 **Enhanced Token Management**: More robust token refresh mechanism
- 🐛 **Better Device Detection**: Improved handling of device feature detection
- 🐛 **Fixed Temperature Constraints**: Proper validation of temperature ranges
- 🔧 **Code Refactoring**: Complete modularization and improved maintainability

### v1.0.0
- 🎉 **Initial Release**: Basic functionality with boiler, DHW, and heating circuit support
- 🔐 **OAuth Authentication**: Automatic and manual authentication methods
- 📊 **Basic Rate Limiting**: Simple retry logic
- 🏠 **HomeKit Integration**: Full compatibility with Apple Home app

---
---
