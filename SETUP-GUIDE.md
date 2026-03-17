# Complete Setup Guide - v2.0.53

## Overview

This guide will walk you through setting up the Viessmann ViCare plugin v2.0.52 for Homebridge, including all the advanced features like intelligent caching, rate limiting protection, comprehensive configuration options, **complete localization support with custom names**, **CSV history logging**, **HTML diagnostic reports**, **energy system monitoring** (PV, battery, wallbox), and **heating schedule awareness** with visual bands in the HTML report, and **heat pump (Wärmepumpe) support** with automatic device detection.

## Prerequisites

### 1. ViCare Account
- Create an account on [ViCare](https://www.vicare.com/)
- Register your Viessmann heating system in the ViCare app
- Verify that your system is online and functioning properly
- Test the ViCare mobile app to ensure you can control your heating system

### 2. Viessmann API Credentials

To obtain API credentials:

1. **Visit the Developer Portal**:
   - Go to https://developer.viessmann-climatesolutions.com/
   - Register for a developer account using your email

2. **Create an application**:
   - Click "Create Application"
   - **Name**: `homebridge-viessmann-vicare`
   - **Type**: `Public Client` (important for home use)
   - **Redirect URI**: `http://localhost:4200/` (exactly as shown)
   - **Scope**: `IoT User offline_access` (exactly as shown)
   - **Description**: Optional, e.g., "Homebridge integration for home automation"

3. **Save your credentials**:
   - **Copy the Client ID** - you'll need this for configuration
   - **Client Secret is NOT required** for public clients
   - Keep these credentials secure and private

## Step-by-Step Installation

### 1. Install the Plugin

#### Via Homebridge Config UI X (Strongly Recommended)
1. Open your Homebridge Config UI X web interface
2. Navigate to the "**Plugins**" tab
3. Search for "**homebridge-viessmann-vicare**"
4. Click "**Install**"
5. Wait for installation to complete

#### Via npm (Command Line)
```bash
# Install via npm prefix (recommended for Raspberry Pi / Linux)
sudo npm install --prefix /usr/local homebridge-viessmann-vicare

# Always restart Homebridge after install
sudo systemctl restart homebridge
```

### 2. Initial Configuration

After installation, configure the plugin through the **Homebridge Config UI X interface**:

1. Go to the "**Plugins**" tab
2. Find "**Viessmann ViCare**" in your installed plugins
3. Click "**Settings**" (gear icon)
4. Fill in the **Basic Configuration** section:

#### **Required Basic Settings**
```
Platform Name: Viessmann
Client ID: [Your Client ID from step 2.3]
Username/Email: [Your ViCare account email]
Password: [Your ViCare account password]
```

#### **Recommended Initial Settings**
```
Authentication Method: auto
Data Refresh Interval: 120000 (2 minutes)
Enable Rate Limit Protection: ✅ (checked)
Enable API Caching: ✅ (checked)
Enable Debug Logging: ✅ (checked for initial setup)
Nominal Boiler Power (kW): 24 (adjust to your boiler's nominal output)
```

5. Click "**Save**" to apply the configuration

### 3. 🌍 Custom Names & Localization Setup

**NEW in v2.0**: Complete localization support for any language!

#### **Configure Custom Names (Optional but Recommended)**

In the plugin settings, navigate to the "**Custom Names & Localization**" section:

#### 🇮🇹 **For Italian Users:**
```
Installation Prefix: Casa Mia
Boiler Name: Caldaia
Hot Water Name: Acqua Calda
Heating Circuit Name: Riscaldamento
Reduced Program Name: Ridotto
Normal Program Name: Normale
Comfort Program Name: Comfort
Eco Mode Name: Eco
Off Mode Name: Spento
Burner Name: Bruciatore
Modulation Name: Modulazione
Holiday Mode Name: Vacanza
Holiday At Home Name: Vacanza Casa
Extended Heating Name: Riscaldamento Extra
```

#### 🇩🇪 **For German Users:**
```
Installation Prefix: Mein Haus
Boiler Name: Kessel
Hot Water Name: Warmwasser
Heating Circuit Name: Heizkreis
Reduced Program Name: Reduziert
Normal Program Name: Normal
Comfort Program Name: Komfort
Eco Mode Name: Eco
Off Mode Name: Aus
Burner Name: Brenner
Modulation Name: Modulation
Holiday Mode Name: Urlaub
Holiday At Home Name: Urlaub Zuhause
Extended Heating Name: Zusatzheizung
```

#### 🇫🇷 **For French Users:**
```
Installation Prefix: Ma Maison
Boiler Name: Chaudière
Hot Water Name: Eau Chaude
Heating Circuit Name: Circuit Chauffage
Reduced Program Name: Réduit
Normal Program Name: Normal
Comfort Program Name: Confort
Eco Mode Name: Eco
Off Mode Name: Arrêt
Burner Name: Brûleur
Modulation Name: Modulation
Holiday Mode Name: Vacances
Holiday At Home Name: Vacances Maison
Extended Heating Name: Chauffage Prolongé
```

#### 🇪🇸 **For Spanish Users:**
```
Installation Prefix: Mi Casa
Boiler Name: Caldera
Hot Water Name: Agua Caliente
Heating Circuit Name: Circuito Calefacción
Reduced Program Name: Reducido
Normal Program Name: Normal
Comfort Program Name: Confort
Eco Mode Name: Eco
Off Mode Name: Apagado
Burner Name: Quemador
Modulation Name: Modulación
Holiday Mode Name: Vacaciones
Holiday At Home Name: Vacaciones Casa
Extended Heating Name: Calefacción Extra
```

#### **Custom Names Tips:**
- **Leave fields empty** to use default English names
- **Mix languages** if desired (e.g., English + local temperature programs)
- **Use your own names** for personalized setup
- **Keep names short** for better display in HomeKit
- **Avoid special characters** that might cause issues

#### **Testing Name Changes (Development):**
1. **Enable Force Service Recreation**: Check the box for `Force Service Recreation`
2. **Save configuration** and restart Homebridge
3. **Check if names appear** correctly in HomeKit
4. **Disable Force Service Recreation**: Uncheck the box for production use

### 4. First Authentication & Setup

⚠️ **Important**: The first setup requires OAuth authentication which will happen automatically.

#### Automatic OAuth Process (Default)

1. **Restart Homebridge** after saving the configuration:
   ```bash
   # Via systemd
   sudo systemctl restart homebridge
   
   # Via pm2
   pm2 restart homebridge
   
   # Via Docker
   docker restart homebridge
   ```

2. **Monitor the logs** for authentication messages:
   ```bash
   # Homebridge Config UI X: Go to Logs tab
   # Or via command line:
   tail -f ~/.homebridge/homebridge.log
   ```

3. **Look for authentication URL** in the logs:
   ```
   [Viessmann] Please open this URL in your browser to authenticate:
   [Viessmann] https://iam.viessmann-climatesolutions.com/idp/v3/authorize?client_id=...
   ```

4. **Complete authentication**:
   - The URL may open automatically in your browser
   - If not, copy and paste the URL into your browser
   - **Login with your ViCare credentials**
   - **Authorize the application** when prompted
   - You should see a success message in the browser

5. **Verify successful authentication**:
   ```
   [Viessmann] Authentication successful! Tokens acquired.
   [Viessmann] Starting device discovery...
   ```

#### Manual OAuth (Fallback)

If automatic OAuth fails, follow the manual process:

1. **Check the logs** for detailed manual instructions
2. **Follow the step-by-step process** provided in the logs
3. **Update configuration** with manual tokens:
   - Go back to plugin settings
   - Change "Authentication Method" to "manual"
   - Add the obtained access token and refresh token
   - Save and restart Homebridge

### 5. Device Discovery & Verification

After successful authentication:

1. **Check discovery logs**:
   ```
   [Viessmann] Setting up installation: [Installation Name] (ID: 12345)
   [Viessmann] 🏷️ Boiler Setup - Installation: "Casa Mia", Boiler: "Caldaia"
   [Viessmann] Adding new accessory: Casa Mia Caldaia
   [Viessmann] Adding new accessory: Casa Mia Acqua Calda
   [Viessmann] Adding new accessory: Casa Mia Riscaldamento 1
   ```

2. **Verify custom names in logs**:
   ```
   [Viessmann] 🏷️ Creating Comfort service: "Casa Mia Acqua Calda Comfort"
   [Viessmann] 🏷️ Creating Reduced service: "Casa Mia Riscaldamento 1 Ridotto 18C"
   [Viessmann] ✅ DHW mode services setup completed
   ```

3. **Verify in HomeKit**:
   - Open the **Home app** on your iOS device
   - Look for accessories with your custom names
   - Test basic controls (temperature adjustment)

4. **Check for errors**:
   - Look for rate limiting warnings
   - Verify all expected accessories are created
   - Test individual accessory functions

### 6. Final Name Verification & Production Setup

1. **Verify all names are correct** in HomeKit:
   - Check boiler accessories: `[Installation] [Custom Boiler Name]`
   - Check DHW accessories: `[Installation] [Custom DHW Name] [Mode]`
   - Check heating circuits: `[Installation] [Custom HC Name] X [Program] XXC`

2. **Disable development settings**:
   - **Uncheck Force Service Recreation**: Set to `false`
   - **Disable debug logging**: Set to `false` for production
   - **Save configuration**

3. **Restart Homebridge** one final time for production configuration

---

### 7. 📊 CSV History Logging & HTML Reports

Starting from v2.0.26, the plugin automatically logs heating data to a CSV file and includes a standalone HTML report generator.

#### **What is logged (every ~15 minutes)**

| Column | Source | Description |
|---|---|---|
| `burner_active`, `modulation` | Boiler | Burner state and modulation % |
| `outside_temp`, `outside_humidity` | Boiler | Outdoor sensors (if available) |
| `gas_heating_day_m3`, `gas_dhw_day_m3` | Boiler | Daily gas consumption in m³ |
| `burner_starts`, `burner_hours` | Boiler | Lifetime statistics |
| `room_temp`, `target_temp` | HC0 | Room temperature and setpoint |
| `flow_temp` | HC0 | Supply/flow temperature |
| `program`, `mode` | HC0 | Active heating program and mode |
| `dhw_temp`, `dhw_target` | ACS | DHW temperature and setpoint |
| `pv_production_w`, `pv_daily_kwh` | Energy | PV production (if available) |
| `battery_level`, `battery_charging_w` | Energy | Battery state (if available) |
| `wallbox_charging`, `wallbox_power_w` | Energy | Wallbox state (if available) |

CSV files location: `/var/lib/homebridge/viessmann-history-<installationId>.csv` (one file per installation)

> ⚠️ **Upgrading from v2.0.34 or earlier**: rename your existing files to include the installation ID (v2.0.37+):
> ```bash
> mv /var/lib/homebridge/viessmann-history.csv /var/lib/homebridge/viessmann-history-2045571.csv
> mv /var/lib/homebridge/viessmann-schedule.json /var/lib/homebridge/viessmann-schedule-2045571.json
> ```
> Replace `2045571` with your actual installation ID (visible in Homebridge logs on startup).
>
> ⚠️ **Upgrading from v2.0.25 or earlier**: also update the CSV header:
> ```bash
> sed -i '1s/.*/timestamp,accessory,burner_active,modulation,room_temp,target_temp,outside_temp,outside_humidity,dhw_temp,dhw_target,program,mode,burner_starts,burner_hours,flow_temp,gas_heating_day_m3,gas_dhw_day_m3,pv_production_w,pv_daily_kwh,battery_level,battery_charging_w,battery_discharging_w,grid_feedin_w,grid_draw_w,wallbox_charging,wallbox_power_w/' /var/lib/homebridge/viessmann-history-2045571.csv
> ```

#### **Heating schedule file (v2.0.31+)**

Starting from v2.0.31, the plugin automatically saves the weekly heating schedule to a JSON file after every API refresh:

```
/var/lib/homebridge/viessmann-schedule-<installationId>.json
```

This file is read by the HTML report generator to:
- Show a **"Today's schedule"** stat card in the HC0 section (e.g. `06:00–07:30 normal, 17:00–23:00 normal · rest: reduced`)
- Render **schedule bands** as subtle background overlays on the overview chart (blue = normal, orange = comfort, grey = reduced/off)

The file is created automatically after the first Homebridge restart — no manual action required. Example content:

```json
{
  "circuit": 0,
  "updatedAt": "2026-03-10T13:00:00.000Z",
  "entries": {
    "mon": [{"mode":"normal","start":"06:00","end":"07:30","position":0}, {"mode":"normal","start":"17:00","end":"23:00","position":1}],
    "sat": [{"mode":"normal","start":"06:00","end":"22:00","position":0}],
    ...
  }
}
```

> If the file does not exist (e.g. first install), the report works normally without schedule overlays.

#### **Generate HTML report**

```bash
# Last 7 days — basic (cycling, flow temp, schedule analysis)
node /usr/local/lib/node_modules/homebridge-viessmann-vicare/viessmann-report.js --installation 2045571

# Full analysis — recommended (add your boiler's nominal kW from the ViCare app)
node /usr/local/lib/node_modules/homebridge-viessmann-vicare/viessmann-report.js --installation 2045571 --boilerKW 25 --designTemp -10

# Last 30 days
node /usr/local/lib/node_modules/homebridge-viessmann-vicare/viessmann-report.js --installation 2045571 --days 30 --boilerKW 25 --designTemp -10

# Custom output path
node /usr/local/lib/node_modules/homebridge-viessmann-vicare/viessmann-report.js --installation 2045571 --days 7 --out /tmp/report.html
```

| Parameter | Description | Default |
|---|---|---|
| `--installation <ID>` | Installation ID (required) | — |
| `--days <N>` | Number of days | `7` |
| `--boilerKW <kW>` | Boiler nominal power — enables heat demand, efficiency, peak load, scatter plot | disabled |
| `--designTemp <°C>` | Design outdoor temp for peak load calculation | `-7` |
| `--path <dir>` | Homebridge storage path | `/var/lib/homebridge` |
| `--out <file>` | Output HTML file | auto-generated |

> 💡 Find your boiler's nominal kW in the ViCare app under **Caldaia → Nome del prodotto** (e.g. Vitodens 100-W B1KF-25 = 25 kW max). For design temperature, use -7°C for Central Europe, -10°C for Northern Italy/Alpine areas.

**Copy to Mac and open in browser**:
```bash
scp user@raspberry:/tmp/report.html ~/Desktop/viessmann-report.html && open ~/Desktop/viessmann-report.html
```

The report includes:
- **Overview chart** — all series on unified timeline (room temp, flow temp, setpoint, DHW, outdoor, modulation, burner)
- **Boiler stat cards** — starts/hour efficiency, avg heat demand (kW), gas consumption, condensing mode badge, burner cycle stats
- **🔍 System Analysis** — cycling severity score, comfort stability, estimated efficiency, heating curve behaviour, heat demand vs outdoor scatter plot with balance point, human-readable insight cards (requires `--boilerKW` for kW-based metrics)
- **Daily gas consumption chart** — stacked bar (heating + DHW) with total line overlay, aggregated per calendar day
- **Cycle duration histogram** — distribution of burner ON durations, highlights short-cycling
- **Flow temperature chart** — with 55°C condensing threshold line
- **DHW chart** — temperature vs setpoint over time
- **Program distribution** — bar chart of normal/reduced/comfort usage %


**Preview:**

![Viessmann Report Full Preview](https://raw.githubusercontent.com/diegoweb100/homebridge-viessmann-vicare/main/docs/report_preview_full.png)

#### **Automated email report via crontab**

Create `/home/pi/Scripts/viessmann-report.sh`:

```bash
#!/bin/bash
REPORT="/tmp/report.html"
DAYS="${1:-30}"
EMAIL="$2"
INSTALLATION_ID="${3:-2045571}"  # your installation ID
BOILER_KW="${4:-0}"       # nominal boiler power in kW (e.g. 25) — 0 = disabled
DESIGN_TEMP="${5:--7}"    # design outdoor temperature for peak load calculation
LOG="/var/log/viessmann-report.log"

if [ -z "$EMAIL" ]; then
  echo "[$(date)] ERROR: email not specified." >> "$LOG"
  exit 1
fi

echo "[$(date)] Generating report for last $DAYS days..." >> "$LOG"

EXTRA_ARGS=""
[ "$BOILER_KW" != "0" ] && EXTRA_ARGS="$EXTRA_ARGS --boilerKW $BOILER_KW"
[ -n "$DESIGN_TEMP" ]   && EXTRA_ARGS="$EXTRA_ARGS --designTemp $DESIGN_TEMP"

node /usr/local/lib/node_modules/homebridge-viessmann-vicare/viessmann-report.js \
  --installation "${INSTALLATION_ID}" --days "$DAYS" $EXTRA_ARGS --out "$REPORT" >> "$LOG" 2>&1

if [ ! -f "$REPORT" ]; then
  echo "[$(date)] ERROR: report.html not found." >> "$LOG"
  exit 1
fi

mail -s "Viessmann Report - $(date +'%B %Y')" -A "$REPORT" "$EMAIL" \
  <<< "Please find attached the Viessmann ViCare report for the last $DAYS days."

rm -f "$REPORT"
echo "[$(date)] Report sent and cleaned up." >> "$LOG"
```

```bash
chmod +x /home/pi/Scripts/viessmann-report.sh
```

Schedule with crontab — 1st of every month at 08:00:
```bash
crontab -e
# Add:
0 8 1 * * /home/pi/Scripts/viessmann-report.sh 30 your@email.com
```

> Requires `mailutils` (`sudo apt install mailutils`) and a working mail relay (e.g. Postfix).

## Advanced Configuration

### 🛡️ Rate Limiting Protection

Configure advanced rate limiting protection:

```json
{
    "refreshInterval": 180000,
    "enableRateLimitProtection": true,
    "maxRetries": 3,
    "retryDelay": 60000,
    "rateLimitResetBuffer": 120000
}
```

**Settings explanation:**
- `refreshInterval`: How often to update data (3 minutes recommended)
- `maxRetries`: Maximum retry attempts before giving up
- `retryDelay`: Base delay between retries (will increase exponentially)
- `rateLimitResetBuffer`: Extra wait time after rate limit expires

### 💾 Intelligent Cache Configuration

Configure the multi-layer caching system:

```json
{
    "cache": {
        "enabled": true,
        "installationsTTL": 86400000,
        "featuresTTL": 120000,
        "devicesTTL": 21600000,
        "gatewaysTTL": 43200000,
        "maxEntries": 1000,
        "enableSmartRefresh": false,
        "enableConditionalRequests": false
    }
}
```

**Cache TTL Guidelines:**
- **Installations** (24h): Rarely change, can be cached for a long time
- **Gateways** (12h): Stable information, moderate caching
- **Devices** (6h): Occasionally change, moderate caching  
- **Features** (2min): Frequently updated, short caching

### 🎯 Installation Filtering

Reduce API calls by filtering installations:

#### Option 1: Filter by Name
```json
{
    "installationFilter": "Main House"
}
```

#### Option 2: Filter by Specific IDs
```json
{
    "installationIds": [2045780, 1234567]
}
```

**To find installation IDs:**
1. Enable debug logging
2. Check logs for: `Available installations: [Name] (ID: 12345)`
3. Use the ID numbers in your configuration

### 🎛️ Feature Control

Enable/disable specific accessory types:

```json
{
    "features": {
        "enableBoilerAccessories": true,
        "enableDHWAccessories": true,
        "enableHeatingCircuitAccessories": true,
        "enableTemperaturePrograms": true,
        "enableQuickSelections": true,
        "enableBurnerStatus": false
    }
}
```

**Use cases:**
- Disable unnecessary accessories to reduce clutter
- Reduce API calls by disabling unused features
- Simplify interface for basic heating control

## Configuration Examples by Use Case

### 🇮🇹 🏠 Italian Single Installation (Complete Localization)
```json
{
    "platform": "ViessmannPlatform",
    "name": "Viessmann",
    "clientId": "your_client_id",
    "username": "your_email@example.com",
    "password": "your_password",
    "refreshInterval": 120000,
    "enableRateLimitProtection": true,
    "nominalPowerKw": 24,
    "customNames": {
        "installationPrefix": "Casa Principale",
        "boiler": "Caldaia Viessmann",
        "dhw": "Acqua Calda Sanitaria",
        "heatingCircuit": "Zona Riscaldamento",
        "reduced": "Temperatura Ridotta",
        "normal": "Temperatura Normale",
        "comfort": "Temperatura Comfort",
        "eco": "Modalità Eco",
        "off": "Spento",
        "burner": "Stato Bruciatore",
        "modulation": "Modulazione Fiamma",
        "holiday": "Modalità Vacanza",
        "holidayAtHome": "Vacanza in Casa",
        "extendedHeating": "Riscaldamento Potenziato"
    },
    "cache": {
        "enabled": true,
        "featuresTTL": 120000
    },
    "debug": false
}
```

### 🇩🇪 🏠 German Single Installation (Complete Localization)
```json
{
    "platform": "ViessmannPlatform",
    "name": "Viessmann",
    "clientId": "your_client_id",
    "username": "your_email@example.com",
    "password": "your_password",
    "refreshInterval": 120000,
    "enableRateLimitProtection": true,
    "customNames": {
        "installationPrefix": "Mein Zuhause",
        "boiler": "Heizkessel",
        "dhw": "Warmwasserbereitung",
        "heatingCircuit": "Heizkreis",
        "reduced": "Reduzierte Temperatur",
        "normal": "Normale Temperatur",
        "comfort": "Komfort Temperatur",
        "eco": "Öko-Modus",
        "off": "Ausgeschaltet",
        "burner": "Brennerstatus",
        "modulation": "Modulationsgrad",
        "holiday": "Urlaubsmodus",
        "holidayAtHome": "Heimaturlaub",
        "extendedHeating": "Zusatzheizung"
    },
    "cache": {
        "enabled": true,
        "featuresTTL": 120000
    },
    "debug": false
}
```

### 🏢 Multiple Installations (High API Usage)
```json
{
    "platform": "ViessmannPlatform",
    "name": "Viessmann",
    "clientId": "your_client_id",
    "username": "your_email@example.com",
    "password": "your_password",
    "refreshInterval": 300000,
    "enableRateLimitProtection": true,
    "installationFilter": "Main",
    "maxRetries": 5,
    "retryDelay": 120000,
    "customNames": {
        "installationPrefix": "Building",
        "boiler": "Boiler",
        "dhw": "Hot Water"
    },
    "cache": {
        "enabled": true,
        "featuresTTL": 300000,
        "enableSmartRefresh": true
    },
    "features": {
        "enableTemperaturePrograms": false,
        "enableQuickSelections": false,
        "enableBurnerStatus": false
    }
}
```

### 🚨 Recovery from Rate Limiting
```json
{
    "platform": "ViessmannPlatform",
    "name": "Viessmann",
    "clientId": "your_client_id",
    "username": "your_email@example.com",
    "password": "your_password",
    "refreshInterval": 900000,
    "enableRateLimitProtection": true,
    "maxRetries": 1,
    "retryDelay": 600000,
    "cache": {
        "enabled": true,
        "featuresTTL": 1800000,
        "installationsTTL": 604800000
    },
    "features": {
        "enableBoilerAccessories": true,
        "enableDHWAccessories": true,
        "enableHeatingCircuitAccessories": true,
        "enableTemperaturePrograms": false,
        "enableQuickSelections": false,
        "enableBurnerStatus": false
    },
    "debug": true
}
```

### 🔧 Development/Testing Configuration
```json
{
    "platform": "ViessmannPlatform",
    "name": "Viessmann",
    "clientId": "your_client_id",
    "username": "your_email@example.com",
    "password": "your_password",
    "refreshInterval": 60000,
    "requestTimeout": 20000,
    "enableRateLimitProtection": true,
    "forceServiceRecreation": true,
    "customNames": {
        "installationPrefix": "Test House",
        "boiler": "Test Boiler",
        "dhw": "Test DHW"
    },
    "cache": {
        "enabled": true,
        "featuresTTL": 30000,
        "maxEntries": 100
    },
    "advanced": {
        "deviceUpdateDelay": 500,
        "maxConsecutiveErrors": 10
    },
    "debug": true
}
```

## Accessory Overview

The plugin creates different types of accessories based on your heating system. **All names can be customized!**

### 🌡️ Heat Pump Accessories (Auto-detected, v2.0.38+)

These accessories are created **only if your device is detected as a heat pump** (Vitocal or any device with `type:heatpump` / `type:E3` role). Gas boiler installations are unaffected.

- **Compressor**: `[Installation] Heat Pump` — HeaterCooler service showing compressor state (Active/Idle) and outside temperature
- **COP Indicator**: `[Installation] Heat Pump COP` — Lightbulb service where Brightness = COP × 20% (e.g. COP 4.0 → 80%)

On first startup the plugin logs a **full dump of all feature paths** at INFO level — this is intentional and helps identify the correct API paths for your specific heat pump model. The dump only runs once per restart.

### ⚡ Energy System Accessories (Auto-detected, v2.0.27+)

These accessories are created **only if your installation has the corresponding features** — they are silently skipped if not present.

- **PV Production**: `[Installation] Energy PV` — Lightbulb service, brightness = production %
- **Battery Storage**: `[Installation] Energy Battery` — Battery service + level %
- **Wallbox / EV Charger**: `[Installation] Energy Wallbox` — Switch + Outlet service
- **Electric DHW Heater**: `[Installation] Energy DHW Heater` — HeaterCooler service

All energy data is also logged to the CSV history file and included in the HTML report.

### 🔥 Boiler Accessories
- **Main Boiler Control**: `[Installation Prefix] [Custom Boiler Name]` - HeaterCooler service for temperature and mode control
- **Burner Status**: `[Installation Prefix] [Custom Boiler Name] [Custom Burner Name]` - Switch showing burner active/inactive state
- **Modulation Level**: `[Installation Prefix] [Custom Boiler Name] [Custom Modulation Name]` - Lightbulb showing current burner modulation (0-100%)

### 🚿 DHW (Hot Water) Accessories
- **Main DHW Control**: `[Installation Prefix] [Custom DHW Name]` - HeaterCooler service for DHW temperature
- **Operating Mode Switches**: 
  - `[Installation Prefix] [Custom DHW Name] [Custom Comfort Name]` - Comfort Mode Switch
  - `[Installation Prefix] [Custom DHW Name] [Custom Eco Name]` - Eco Mode Switch
  - `[Installation Prefix] [Custom DHW Name] [Custom Off Name]` - Off Mode Switch

### 🏠 Heating Circuit Accessories
- **Main Circuit Control**: `[Installation Prefix] [Custom Heating Circuit Name] X` - HeaterCooler service for circuit temperature
- **Temperature Programs** (if enabled):
  - `[Installation Prefix] [Custom Heating Circuit Name] X [Custom Reduced Name] XXC` - Switch for economy mode with temperature display
  - `[Installation Prefix] [Custom Heating Circuit Name] X [Custom Normal Name] XXC` - Switch for standard comfort with temperature display
  - `[Installation Prefix] [Custom Heating Circuit Name] X [Custom Comfort Name] XXC` - Switch for maximum comfort with temperature display
- **Quick Selections** (if enabled):
  - `[Installation Prefix] [Custom Heating Circuit Name] X [Custom Holiday Name]` - Switch for 7-day holiday schedule
  - `[Installation Prefix] [Custom Heating Circuit Name] X [Custom Holiday At Home Name]` - Switch for single-day reduced heating
  - `[Installation Prefix] [Custom Heating Circuit Name] X [Custom Extended Heating Name]` - Switch for temporary comfort boost

## Verification & Testing

### 1. Check Homebridge Logs
```bash
# Via Homebridge Config UI X
# Go to "Logs" tab and look for Viessmann entries

# Via command line
tail -f ~/.homebridge/homebridge.log | grep Viessmann

# Via systemd
journalctl -u homebridge -f | grep Viessmann

# Via Docker
docker logs -f homebridge | grep Viessmann
```

### 2. Key Log Messages to Look For

**✅ Successful Messages:**
```
[Viessmann] Authentication successful! Tokens acquired.
[Viessmann] Setting up installation: [Name] (ID: 12345)
[Viessmann] 🏷️ Boiler Setup - Installation: "Casa Mia", Boiler: "Caldaia"
[Viessmann] Adding new accessory: Casa Mia Caldaia
[Viessmann] Update cycle completed: X/Y successful, 0 errors
[Viessmann] Cache stats - Hit rate: 85.2%, Entries: 45
```

**🌍 Custom Names Messages:**
```
[Viessmann] 🏷️ DHW Setup - Installation: "Casa Mia", DHW: "Acqua Calda"
[Viessmann] 🏷️ Creating Comfort service: "Casa Mia Acqua Calda Comfort"
[Viessmann] 🏷️ Creating Reduced service: "Casa Mia Riscaldamento 1 Ridotto 18C"
[Viessmann] ✅ DHW mode services setup completed with subtype version: stable
```

**⚠️ Warning Messages (Normal):**
```
[Viessmann] Rate limit protection activated
[Viessmann] Cache miss for getDeviceFeatures
[Viessmann] Token refreshed successfully
```

**❌ Error Messages (Need Attention):**
```
[Viessmann] Authentication failed: Invalid credentials
[Viessmann] Rate limit exceeded (429). Blocked for X seconds
[Viessmann] No installations found
[Viessmann] Max retries exceeded
```

### 3. HomeKit Verification
1. **Open Home app** on iOS/macOS
2. **Check for new accessories**:
   - Look for accessories with your custom installation name prefix
   - Verify all expected accessories are present with custom names
   - Check that names match your configuration
3. **Test basic functionality**:
   - Try adjusting boiler temperature
   - Test DHW mode switches with custom names
   - Try heating circuit controls
4. **Check responsiveness**:
   - Commands should execute within 5-10 seconds
   - Status updates should appear within refresh interval

### 4. Custom Names Verification
1. **Check accessory names** in HomeKit:
   - Boiler: `[Your Installation Prefix] [Your Boiler Name]`
   - DHW: `[Your Installation Prefix] [Your DHW Name]`
   - DHW Modes: `[Your Installation Prefix] [Your DHW Name] [Your Mode Names]`
   - Heating Circuits: `[Your Installation Prefix] [Your HC Name] X`
   - Temperature Programs: Include temperature in name (e.g., `Ridotto 18C`)

2. **If names don't appear correctly**:
   - Enable `forceServiceRecreation: true` temporarily
   - Restart Homebridge
   - Check logs for service creation messages
   - Disable `forceServiceRecreation: false` after verification

### 5. API Rate Limit Status
Monitor rate limit status in logs:
```
[Viessmann] Rate limit status: OK
[Viessmann] Cache stats - Hit rate: 85.2%, Entries: 45
[Viessmann] API call succeeded after 0 retries
```

## Common Issues & Solutions

### 🌍 Custom Names Not Working

**Symptoms:**
- Accessories still show English names
- New custom names don't appear
- Services have old names

**Solutions:**
1. ✅ **Verify configuration**: Check `customNames` section is properly configured
2. ✅ **Check for typos**: Ensure no spelling errors in custom name fields
3. ✅ **Restart Homebridge**: Full restart required for name changes
4. ✅ **Enable force recreation**: Set `forceServiceRecreation: true` temporarily
5. ✅ **Check logs**: Look for service creation messages with your custom names
6. ✅ **Disable force recreation**: Set to `false` after successful update
7. ✅ **Clear HomeKit cache**: Remove and re-add bridge in Home app if needed

### 🚨 Rate Limiting (429 Errors)

**Symptoms:**
- `Rate limit exceeded` messages in logs
- Accessories not updating
- `Too Many Requests` errors

**Immediate Solutions:**
1. ✅ **Increase refresh interval**: Set to 300000ms (5 minutes) or higher
2. ✅ **Enable rate limit protection**: Ensure `enableRateLimitProtection: true`
3. ✅ **Use installation filtering**: Filter to only needed installations
4. ✅ **Increase cache TTL**: Set longer cache durations
5. ✅ **Close ViCare app**: Temporarily close mobile app to reduce API usage
6. ✅ **Wait for reset**: API limits typically reset after 24 hours

### 🔐 Authentication Errors

**Symptoms:**
- `Authentication failed` messages
- 401/403 HTTP errors
- Login prompts not working

**Solutions:**
1. ✅ **Verify credentials**: Double-check ViCare username/password
2. ✅ **Check Client ID**: Ensure Client ID is correct
3. ✅ **Check API application**: Verify redirect URI: `http://localhost:4200/`
4. ✅ **Try manual authentication**: Change `authMethod` to `"manual"`
5. ✅ **Network issues**: Check firewall settings and port 4200 accessibility

### 🏠 No Installations/Devices Found

**Symptoms:**
- `No installations found` message
- Empty accessory list in HomeKit
- Discovery completes but no devices

**Solutions:**
1. ✅ **Verify ViCare setup**: Check devices are online in ViCare app
2. ✅ **Check filtering settings**: Remove `installationFilter` temporarily
3. ✅ **Enable debug logging**: Look for `Available installations:` messages
4. ✅ **Check account access**: Ensure account has access to installations

### ⚡ Performance Issues

**Symptoms:**
- Slow response times
- Timeout errors
- Connection failures

**Solutions:**
1. ✅ **Increase timeouts**: Set `requestTimeout: 45000`
2. ✅ **Optimize caching**: Enable with appropriate TTL values
3. ✅ **Reduce API load**: Disable unused accessories via feature flags
4. ✅ **Use installation filtering**: Filter to specific installations

### 🎛️ Accessories Not Working

**Symptoms:**
- Commands don't execute
- Switches don't respond
- Temperature changes ignored

**Solutions:**
1. ✅ **Check device capabilities**: Not all devices support all features
2. ✅ **Verify system state**: Check heating system is in correct mode
3. ✅ **Test individual features**: Try each accessory type separately
4. ✅ **Check temperature ranges**: Verify within device limits

## Performance Optimization

### 📊 Monitoring Performance

Enable debug logging and monitor these metrics:

1. **Cache Hit Rate**: Should be >80% for optimal performance
   ```
   [Viessmann] Cache stats - Hit rate: 85.2%
   ```

2. **API Response Times**: Should be <5 seconds normally
   ```
   [Viessmann] API call 'getDeviceFeatures' succeeded after 0 retries
   ```

3. **Rate Limit Status**: Should show "OK" most of the time
   ```
   [Viessmann] Rate limit status: OK
   ```

4. **Custom Names Application**: Should show successful service creation
   ```
   [Viessmann] 🏷️ Creating service: "Casa Mia Caldaia"
   [Viessmann] ✅ Service setup completed
   ```

### 🎯 Optimization Strategies

1. **Start Conservative**: Begin with longer refresh intervals and adjust down
2. **Monitor Logs**: Watch for rate limiting warnings
3. **Filter Aggressively**: Only include needed installations
4. **Use Caching**: Enable with appropriate TTL values
5. **Gradual Adjustment**: Make small changes and monitor impact
6. **Test Custom Names**: Use force recreation during testing only

### 📈 Performance Profiles

**Real-Time Profile** (High API usage, fast updates):
```json
{
    "refreshInterval": 60000,
    "cache": { "featuresTTL": 60000 }
}
```

**Balanced Profile** (Recommended for most users):
```json
{
    "refreshInterval": 120000,
    "cache": { "featuresTTL": 120000 }
}
```

**Conservative Profile** (Low API usage, slower updates):
```json
{
    "refreshInterval": 300000,
    "cache": { 
        "featuresTTL": 300000,
        "enableSmartRefresh": true
    }
}
```

## Security Best Practices

### 🔒 Credential Protection
1. **Never share** your Client ID or tokens publicly
2. **Use strong passwords** for your ViCare account
3. **Enable two-factor authentication** if available
4. **Regularly update** plugin to latest version
5. **Monitor access** in ViCare app for unauthorized usage

### 🔐 Network Security
1. **Secure your Homebridge server** with proper firewall rules
2. **Use HTTPS** for Homebridge Config UI X
3. **Restrict access** to port 4200 during OAuth setup
4. **Consider VPN** for remote Homebridge access

## Advanced Topics

### 🏗️ Plugin Architecture

The plugin has been completely refactored into a modular architecture for better maintainability and debugging:

#### Core Modules

```
src/
├── 🔐 auth-manager.ts              # OAuth2 authentication & token management
├── 🛡️ rate-limit-manager.ts       # API rate limiting protection
├── 📡 api-client.ts                # HTTP client with retry logic
├── 🌐 viessmann-api-endpoints.ts   # Viessmann-specific API calls
├── 🔧 network-utils.ts             # Network utilities (IP, browser)
├── 💾 api-cache.ts                 # Intelligent multi-layer caching
├── 📊 api-health-monitor.ts        # Performance monitoring
├── 🎯 viessmann-api.ts             # Main API facade
├── 🏠 platform.ts                  # Main platform with custom names support
├── ⚙️ settings.ts                  # Constants and configuration
├── 🚀 index.ts                     # Plugin entry point
└── accessories/
    ├── 🔥 boiler-accessory.ts              # Boiler control, gas consumption, diagnostics
    ├── 🚿 dhw-accessory.ts                 # DHW temperature and modes
    ├── 🏠 heating-circuit-accessory.ts     # Circuit control, flow temp, programs, schedule persistence
    ├── ⚡ energy-accessory.ts              # PV, battery, wallbox (auto-detected)
    └── 📋 history-logger.ts               # CSV logging + FakeGato Eve history
```

#### Module Responsibilities

**🔐 Authentication Layer:**
- `auth-manager.ts`: OAuth2 flow, token management, persistence
- `network-utils.ts`: IP detection, browser launching, environment detection

**🛡️ Protection Layer:**
- `rate-limit-manager.ts`: 429 error handling, exponential backoff
- `api-health-monitor.ts`: Performance tracking, health scoring

**📡 Communication Layer:**
- `api-client.ts`: HTTP client with retry logic and interceptors
- `viessmann-api-endpoints.ts`: Viessmann-specific API implementations
- `viessmann-api.ts`: Main API facade and orchestration

**💾 Caching Layer:**
- `api-cache.ts`: Multi-layer intelligent caching with LRU eviction

**🏠 Platform Layer:**
- `platform.ts`: Homebridge platform, device discovery, custom names
- `settings.ts`: Configuration constants and defaults
- `index.ts`: Plugin registration and entry point

**🎛️ Accessory Layer:**
- `boiler-accessory.ts`: Boiler temperature, burner status, modulation, gas consumption logging
- `dhw-accessory.ts`: DHW temperature, operating modes (comfort/eco/off)
- `heating-circuit-accessory.ts`: Heating circuits, flow temperature, temperature programs, holiday modes, weekly schedule persistence to `viessmann-schedule.json`
- `energy-accessory.ts`: PV production, battery storage, wallbox/EV charger (auto-detected, silently skipped if not present)
- `history-logger.ts`: CSV logging to `viessmann-history.csv`, FakeGato Eve history entries

#### Benefits

- **🐛 Better Debugging**: Each module handles specific errors with targeted logging
- **🚀 Improved Performance**: Specialized caching and retry logic per component
- **🛡️ Enhanced Reliability**: Advanced rate limiting protection with smart recovery
- **🔧 Easier Maintenance**: Modular, testable code structure with clear responsibilities
- **📊 Better Monitoring**: Real-time performance metrics and health scoring
- **🌍 Localization Support**: Custom names integrated throughout the accessory layer

#### Debugging by Module

**Authentication Issues** → Check `auth-manager.ts` logs:
```
[AuthManager] 🔑 Using existing valid token
[AuthManager] ⚠️ Token refresh failed, will try to get new tokens
[AuthManager] ✅ Authentication successful! Access and refresh tokens acquired
```

**Rate Limiting Issues** → Monitor `rate-limit-manager.ts`:
```
[RateLimitManager] ⚠️ Rate limit exceeded (429). Blocked for X seconds
[RateLimitManager] 🚫 Daily API quota exceeded
[RateLimitManager] ✅ Rate limit has been reset - API calls can resume
```

**Performance Issues** → Review `api-client.ts` and `api-health-monitor.ts`:
```
[APIClient] 💨 Cache hit for getDeviceFeatures
[APIHealthMonitor] 📊 API Health: 85/100 (good)
[APIClient] ✅ API call succeeded after 0 retries
```

**Custom Names Issues** → Check platform and accessory logs:
```
[Platform] 🏷️ DHW Setup - Installation: "Casa Mia", DHW: "Acqua Calda"
[BoilerAccessory] 🏷️ Creating Burner service: "Casa Mia Caldaia Bruciatore"
[Platform] ✅ Service setup completed with custom names
```

**API Errors** → Debug `viessmann-api-endpoints.ts`:
```
[APIEndpoints] 🌐 Making API request: GET /features/installations/12345
[APIEndpoints] ❌ Failed to get feature heating.boiler.temperature
[APIEndpoints] ✅ Successfully executed command setTargetTemperature
```

**Network Issues** → Examine `network-utils.ts`:
```
[NetworkUtils] 🖥️ Detected headless Linux environment
[NetworkUtils] 🐳 Detected container environment
[NetworkUtils] 🌐 Opening browser for authentication
```

### 🌍 Custom Names Implementation
- **Service Creation**: Custom names applied during service creation
- **Dynamic Subtypes**: Optional service recreation for immediate name updates
- **Sanitization**: Names cleaned for HomeKit compatibility
- **Temperature Display**: Program temperatures included in names
- **Localization**: Full support for any language

### 🔧 Custom Development
If you need to modify the plugin:

1. **Clone the repository**:
   ```bash
   git clone https://github.com/diegoweb100/homebridge-viessmann-vicare.git
   cd homebridge-viessmann-vicare
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Build the project**:
   ```bash
   npm run build
   ```

4. **Link for development**:
   ```bash
   npm link
   ```

## Support & Troubleshooting

### 📞 Getting Help

1. **Check this guide** and the README first
2. **Enable debug logging** and collect logs
3. **Search existing issues** on GitHub
4. **Create new issue** with:
   - Complete configuration (remove passwords)
   - Full debug logs
   - Heating system model and details
   - Plugin version
   - Custom names configuration (if used)
   - Steps to reproduce the issue

### 🔍 Debug Information to Collect

When reporting issues, include:

```json
{
    "plugin_version": "2.0.49",
    "homebridge_version": "1.8.x",
    "node_version": "18.x.x",
    "heating_system": "Viessmann Model",
    "installation_count": 1,
    "gateway_count": 1,
    "device_count": 3,
    "cache_hit_rate": "85%",
    "rate_limit_status": "OK",
    "authentication_method": "auto",
    "custom_names_used": true,
    "force_service_recreation": false,
    "csv_logging_active": true,
    "csv_header_version": "v2.0.28",
    "schedule_file_present": true,
    "schedule_last_updated": "2026-03-10T...",
    "energy_accessory_present": false,
    "nominal_power_kw": 24
}
```

### 🚀 Updates & Maintenance

Keep your plugin updated:

```bash
# Check for updates
npm outdated -g homebridge-viessmann-vicare

# Update to latest version
npm update -g homebridge-viessmann-vicare

# Always restart Homebridge after updates
sudo systemctl restart homebridge
```

---

## Quick Start Checklist

- [ ] ViCare account created and heating system registered
- [ ] API credentials obtained from developer portal
- [ ] Plugin installed via Homebridge Config UI X or `sudo npm install --prefix /usr/local homebridge-viessmann-vicare`
- [ ] Basic configuration completed (Client ID, username, password)
- [ ] `nominalPowerKw` set to your boiler's nominal output (default: 24 kW)
- [ ] 🌍 Custom names configured (optional but recommended for non-English users)
- [ ] Rate limiting protection enabled
- [ ] Caching enabled with default settings
- [ ] Authentication completed successfully
- [ ] Devices discovered and accessories created with custom names
- [ ] HomeKit testing completed with custom names verified
- [ ] Force service recreation disabled for production use
- [ ] Debug logging disabled for production use
- [ ] CSV history logging verified (`tail -5 /var/lib/homebridge/viessmann-history.csv`)
- [ ] Schedule file created after first restart (`cat /var/lib/homebridge/viessmann-schedule.json`)
- [ ] CSV header updated if upgrading from v2.0.25 or earlier (see step 7)
- [ ] HTML report generated and verified
- [ ] Automated report script configured (optional)
- [ ] Performance monitoring configured

**Estimated setup time**:
- **Basic setup**: 15-30 minutes for new users
- **With custom names**: Add 5-10 minutes for localization
- **With report automation**: Add 5 minutes for crontab setup
- **Experienced users**: 5-10 minutes total

**Need help?** Visit our [GitHub repository](https://github.com/diegoweb100/homebridge-viessmann-vicare) for support and updates.
---

## Changelog

### v2.0.53 (2026-03-17)
- feat: new script viessmann-sync-events.js for precise burner event history from API
- fix: Device Messages layout fixed (inside wrap container)

### v2.0.52 (2026-03-17)
- feat: 3 new report sections — hourly heatmap, daily efficiency chart, energy flow
- feat: icons on all report section headers
- fix: CSV migration corrected for hc0/dhw post-deploy rows

### v2.0.51 (2026-03-16)
- fix: viessmann-report-server.js missing from npm package

### v2.0.50 (2026-03-16)
- feat: Report web server on configurable port; all params from browser UI
- feat: CSV 9 new columns — burner event rows, heat production, monthly gas, daily deltas
- fix: Burner state changes logged immediately to CSV with event_type=burner_on/off
- fix: Statistics read order corrected — event rows have accurate burner_starts/hours

### v2.0.49 (2026-03-16)
- fix: battery standby=0W; PV daily unit-aware; COP comment

### v2.0.48 (2026-03-16)
- fix: VitoCharge ESS battery/PV paths, eebus wallbox vcs.* paths, PV unit conversion

### v2.0.47 (2026-03-15)
**Multi-device robustness + API-driven feature discovery:**
- **Comfort program discovery: API-driven** — scans actual device features instead of hardcoded name list. Supports Vitodens, Vitocal gen3, and future devices automatically.
- **HC program normalisation: pattern-based** — `comfort*`/`normal*`/`reduced*` prefix matching instead of fixed map.
- **Device messages: per-device file** — `viessmann-messages-<installationId>-<deviceId>.json`, one per device. Report aggregates all files.
- **Device messages written at startup** — available immediately, not only after first update cycle.
- **Compressor setpoint path: dynamic** — derived from resolved `hpPaths.compressorMod`, no hardcoded device index.

### v2.0.48 (2026-03-15)
*(published separately)*

### v2.0.49 (2026-03-16)
- fix: battery standby=0W; PV daily unit-aware; COP comment

### v2.0.48 (2026-03-16)
- fix: VitoCharge ESS battery/PV paths, eebus wallbox vcs.* paths, PV unit conversion

### v2.0.47 (2026-03-15)
*(published separately)*

### v2.0.46 (2026-03-15)
*(published separately)*

### v2.0.45 (2026-03-15)
*(published separately)*

### v2.0.44 (2026-03-15)
*(published separately)*

### v2.0.43 (2026-03-15)
*(published separately)*

### v2.0.42 (2026-03-15)
**HC program fix + messages JSON + maxCompressorRps + gas forecast threshold:**
- **Fixed: Extended Heating HomeKit OFF / ViCare ON** — `forcedLastFromSchedule.active` is always True (schedule artifact), not an Extended Heating indicator. State now uses `comfort.active OR programs.active===comfortFeature`. Deactivation uses `setTemperature` fallback when `deactivate` not executable.
- **Fixed: HC program names on heat pump** — `normalHeating`, `reducedEnergySaving` etc. now correctly mapped to `normal`/`reduced`/`comfort`. Previously ignored, leaving program switches stale.
- **Fixed: gas forecast annual threshold** — requires 14+ days before showing annual estimate. Fewer days shows "Need N days" badge.
- **Added: `maxCompressorRps` config option** — normalises heat pump compressor speed to 0–100% modulation. Default 50 rps. Warning logged if exceeded with suggested value. Add to config: `"maxCompressorRps": 60`.
- **Added: compressor setpoint in debug log** — shows `current=Xrps setpoint=Yrps → modulation=Z% (maxRps=50)`.
- **Added: device messages JSON** — plugin writes `viessmann-messages-<ID>.json` on every update cycle. Powers the Device Messages section in `viessmann-report.js`.

**Config example for heat pump users:**
```json
{
  "platform": "ViessmannPlatform",
  "maxCompressorRps": 50
}
```

### v2.0.41 (2026-03-15)
**Fix duplicate Boiler accessory + gas forecast + error code translations:**
- **Fixed: duplicate "Boiler 2" on heat pump installations** — `setupBoilerAccessory` was matching `heating.boiler.serial` present on VitoCharge and other gen3 devices. Filter now requires actual burner operation features. Fixes accessory naming confusion on Windows installs with Vitocal 250A.
- **Report: Gas forecast** — new section projecting 30-day and annual gas consumption via linear regression on CSV history. Cost estimate in € with `--gasPriceEur` parameter (default 0.90 €/m³). Trend indicator (rising/stable/falling).
- **Report: Device messages** — new section with 80+ Viessmann S./F./I. code translations (English). Reads `viessmann-messages-<ID>.json` when available.
- **`--gasPriceEur <price>`** new CLI parameter for `viessmann-report.js`.

### v2.0.40 (2026-03-15)
**Critical bug fix + log noise reduction:**
- **Fixed: accessories not updating after restart** — all four restore-from-cache paths (Boiler, DHW, HC, Energy) were missing `context.device/installation/gateway` assignment. This caused `updateAllDevices` to skip every accessory silently on every restart after the first, showing `0 device(s) fetched`. Affected all users.
- Full feature dump moved to `DEBUG` level (only shown when `debug: true`).
- Capability detail and resolved HP paths moved to `DEBUG`; single compact `INFO` line shows detected capabilities.
- `updateHandler not set` per-device warning downgraded to `DEBUG`; update cycle summary count retained.
- **Note:** Users upgrading from ≤v2.0.38 with a heat pump may have ghost "Heat Pump" accessories in cache — remove via Homebridge UI → Settings → Remove Single Accessory.

### v2.0.39 (2026-03-11)
**Critical fix** — Heat pump device detection overhaul:
- Fixed `isHeatPumpDevice()`: removed `type:E3` which matched ALL gen3 devices. Now requires `type:heatpump` (exact) or Vitocal modelId.
- Fixed HP path resolution for Vitocal 250A: `heating.compressors.0` (active), `heating.compressors.0.speed.current` (speed/mod), `heating.sensors.temperature.return` (return temp), `heating.scop.heating` (COP/SCOP).
- Added compressor speed modulation read (rps → %).
- Energy device role detection: VitoCharge (`type:ess`, `type:photovoltaic;integrated`) and wallbox (`type:accessory;vehicleChargingStation`) now correctly identified from roles.

### v2.0.38 (2026-03-11)
Heat pump support: full feature dump logging, `type:heatpump` role detection, `roles`/`brand` fields in device interface, HeaterCooler + COP Lightbulb services.
