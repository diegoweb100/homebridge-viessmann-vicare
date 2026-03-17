# homebridge-viessmann-vicare

[![npm](https://img.shields.io/npm/v/homebridge-viessmann-vicare.svg)](https://www.npmjs.com/package/homebridge-viessmann-vicare)
[![GitHub release](https://img.shields.io/github/release/diegoweb100/homebridge-viessmann-vicare.svg)](https://github.com/diegoweb100/homebridge-viessmann-vicare/releases)
[![npm downloads](https://img.shields.io/npm/dt/homebridge-viessmann-vicare.svg)](https://www.npmjs.com/package/homebridge-viessmann-vicare)
[![GitHub stars](https://img.shields.io/github/stars/diegoweb100/homebridge-viessmann-vicare.svg)](https://github.com/diegoweb100/homebridge-viessmann-vicare/stargazers)
[![GitHub issues](https://img.shields.io/github/issues/diegoweb100/homebridge-viessmann-vicare.svg)](https://github.com/diegoweb100/homebridge-viessmann-vicare/issues)
[![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/diegoweb100)

A comprehensive Homebridge plugin for Viessmann heating systems with **full control capabilities** including boilers, domestic hot water (DHW), and heating circuits through Apple HomeKit. Features advanced rate limiting protection, intelligent cache management, automatic retry logic, and **complete localization support**.

## 🚀 Key Features

- **🔥 Complete boiler control**: Temperature, operating modes, burner status, modulation
- **🚿 DHW management**: Temperature control and operating modes for domestic hot water
- **🏠 Individual heating circuits**: Full control of each circuit with temperature programs
- **🎛️ Advanced temperature programs**: Reduced, Normal, Comfort modes with individual temperatures
- **🏖️ Holiday and quick selection modes**: Holiday, Holiday at Home, Extended Heating programs
- **🌍 Complete localization**: Custom names for all accessories in your preferred language
- **↔️ Bidirectional commands**: Read **AND** write all supported parameters
- **⚡ Intelligent rate limiting**: Advanced protection against API throttling with exponential backoff
- **🔄 Automatic retry logic**: Smart retry mechanism with alternative API endpoints
- **🛡️ Robust error handling**: Graceful degradation and recovery from API limitations
- **💾 Intelligent cache management**: Advanced caching system with configurable TTL and smart refresh
- **🔐 Secure authentication**: OAuth2 with automatic token refresh
- **📊 Real-time updates**: Continuous monitoring with adaptive refresh intervals
- **🎯 Installation filtering**: Show only specific installations or filter by name
- **🎛️ Easy configuration**: Full support for Homebridge Config UI X with all parameters exposed
- **🎯 Native integration**: Complete compatibility with Apple Home app and Siri controls

## 🌍 Localization & Custom Names

**NEW in v2.0**: Complete support for custom accessory names in any language! Perfect for Italian, German, French, Spanish users or custom naming schemes.

### 🇮🇹 Italian Example
```json
{
  "customNames": {
    "installationPrefix": "Casa Mia",
    "boiler": "Caldaia",
    "dhw": "Acqua Calda",
    "heatingCircuit": "Riscaldamento",
    "reduced": "Ridotto",
    "normal": "Normale",
    "comfort": "Comfort",
    "eco": "Eco",
    "off": "Spento",
    "burner": "Bruciatore",
    "modulation": "Modulazione",
    "holiday": "Vacanza",
    "holidayAtHome": "Vacanza Casa",
    "extendedHeating": "Riscaldamento Extra"
  }
}
```

**Resulting HomeKit names:**
- `Casa Mia Caldaia` (Main boiler control)
- `Casa Mia Caldaia Bruciatore` (Burner status)
- `Casa Mia Caldaia Modulazione` (Modulation level)
- `Casa Mia Acqua Calda` (DHW control)
- `Casa Mia Acqua Calda Comfort` (DHW comfort mode)
- `Casa Mia Riscaldamento 1 Ridotto 18C` (Reduced program)
- `Casa Mia Riscaldamento 1 Normale 20C` (Normal program)
- `Casa Mia Riscaldamento 1 Comfort 22C` (Comfort program)

### 🇩🇪 German Example
```json
{
  "customNames": {
    "installationPrefix": "Mein Haus",
    "boiler": "Kessel",
    "dhw": "Warmwasser",
    "heatingCircuit": "Heizkreis",
    "reduced": "Reduziert",
    "normal": "Normal",
    "comfort": "Komfort"
  }
}
```

### 🇫🇷 French Example
```json
{
  "customNames": {
    "installationPrefix": "Ma Maison",
    "boiler": "Chaudière",
    "dhw": "Eau Chaude",
    "heatingCircuit": "Circuit Chauffage",
    "reduced": "Réduit",
    "normal": "Normal",
    "comfort": "Confort"
  }
}
```

### 🇪🇸 Spanish Example
```json
{
  "customNames": {
    "installationPrefix": "Mi Casa",
    "boiler": "Caldera",
    "dhw": "Agua Caliente",
    "heatingCircuit": "Circuito Calefacción",
    "reduced": "Reducido",
    "normal": "Normal",
    "comfort": "Confort"
  }
}
```

## 🏗️ Plugin Architecture (v2.0)

The plugin has been completely refactored into a modular architecture for better maintainability and debugging:

### Core Modules

```
src/
├── 🔐 auth-manager.ts           # OAuth2 authentication & token management
├── 🛡️ rate-limit-manager.ts    # API rate limiting protection
├── 📡 api-client.ts             # HTTP client with retry logic
├── 🌐 viessmann-api-endpoints.ts # Viessmann-specific API calls
├── 🔧 network-utils.ts          # Network utilities (IP, browser)
├── 💾 api-cache.ts              # Intelligent multi-layer caching
├── 📊 api-health-monitor.ts     # Performance monitoring
└── 🎯 viessmann-api.ts          # Main API facade
```

### Benefits

- **🐛 Better Debugging**: Each module handles specific errors
- **🚀 Improved Performance**: Specialized caching and retry logic  
- **🛡️ Enhanced Reliability**: Advanced rate limiting protection
- **🔧 Easier Maintenance**: Modular, testable code structure
- **📊 Better Monitoring**: Real-time performance metrics

### Debugging Guide

**Authentication Issues** → Check `auth-manager.ts` logs
**Rate Limiting** → Monitor `rate-limit-manager.ts` output  
**Performance** → Review `api-client.ts` and cache metrics
**API Errors** → Debug `viessmann-api-endpoints.ts` parsing
**Network Issues** → Examine `network-utils.ts` detection

For detailed architecture documentation, see the [Plugin Architecture](#%EF%B8%8F-plugin-architecture-v20) section above.

## 🆕 What's New in v2.0

- **🌍 Complete Localization Support**: Custom names for all accessories in any language
- **🛡️ Advanced Rate Limiting Protection**: Intelligent handling of Viessmann API rate limits (429 errors)
- **💾 Intelligent Cache Management**: Multi-layer caching with configurable TTL for different data types
- **🔄 Smart Retry Logic**: Exponential backoff with alternative API endpoints
- **📊 Adaptive Refresh Intervals**: Automatic adjustment based on API availability
- **🎯 Enhanced Installation Filtering**: Filter installations by name or ID to reduce API calls
- **🎛️ Individual Temperature Programs**: Separate controls for Reduced/Normal/Comfort modes
- **🏖️ Enhanced Holiday Modes**: Full support for Holiday and Holiday at Home programs
- **⚡ Extended Heating Mode**: Quick comfort boost functionality
- **🔧 Improved Error Recovery**: Better handling of temporary API issues
- **📈 Performance Monitoring**: Real-time rate limit status and diagnostics
- **⚙️ Complete UI Configuration**: All parameters configurable through Homebridge Config UI X
- **🎚️ Feature Toggle Controls**: Enable/disable specific accessory types
- **🔧 Advanced Timeout Controls**: Configurable timeouts and retry mechanisms


## 📊 HTML Report Preview

![Viessmann ViCare History Report](https://raw.githubusercontent.com/diegoweb100/homebridge-viessmann-vicare/main/docs/report_preview_hero.png)

> Interactive HTML report generated by the plugin — 7 days of boiler data including overview chart, heating schedule bar, stat cards, gas consumption, flow temperature and more. [Full report preview ↓](https://raw.githubusercontent.com/diegoweb100/homebridge-viessmann-vicare/main/docs/report_preview_full.png)


## 🏠 Supported Devices

All Viessmann heating systems compatible with ViCare API:

- **Gas and oil boilers** (Vitodens, Vitoladens, Vitocrossal)
- **Heat pumps** (air-to-water, ground-source, hybrid systems)
- **Hybrid systems** (boiler + heat pump combinations)
- **Pellet and biomass boilers** (Vitoligno)
- **Combined heating/cooling systems**
- **Solar thermal systems** (Vitosol)
- **Ventilation systems** (Vitovent)
- **Multi-zone systems** (multiple heating circuits)

## 📦 Installation

### Via Homebridge Config UI X (Recommended)

1. Search for "**homebridge-viessmann-vicare**" in the Plugin tab
2. Click "**Install**"
3. Configure the plugin through the web interface using the comprehensive configuration form

### Via npm

```bash
npm install -g homebridge-viessmann-vicare
```

## 📊 History & Graphs

Starting from v2.0.25 the plugin automatically records historical data at every refresh cycle (~15 min).

### What is recorded
| Data | Source | Available in |
|---|---|---|
| Burner state + modulation % | Boiler | Eve app, CSV, HTML report |
| Room temperature + setpoint | HC0 | Eve app, CSV, HTML report |
| DHW temperature + setpoint | ACS | Eve app, CSV, HTML report |
| Active program (normal/reduced/comfort) | HC0 | CSV, HTML report |
| Burner starts + hours (lifetime) | Boiler | CSV, HTML report |
| Outside temperature | Boiler | CSV, HTML report |
| Outside humidity (if sensor present) | Boiler | CSV, HTML report |
| Flow temperature / supply temp (HC0) | HC0 | CSV, HTML report |
| Gas consumption heating (m³/day) | Boiler | CSV, HTML report |
| Gas consumption DHW/ACS (m³/day) | Boiler | CSV, HTML report |
| PV production (W) + daily yield (kWh) | Energy | CSV, HTML report |
| Battery level (%) + charge/discharge (W) | Energy | CSV, HTML report |
| Grid feed-in / draw (W) | Energy | CSV, HTML report |
| Wallbox charging state + power (W) | Energy | CSV, HTML report |

---

### 📱 Eve app graphs (FakeGato)

Graphs are visible in the **Eve** app (free, App Store / Google Play).

**Step 1 — Install fakegato-history** (one time, via SSH):
```bash
sudo npm install --prefix /usr/local fakegato-history
```

**Step 2 — Restart Homebridge** from the UI.

**Step 3 — Verify** in Homebridge logs:
```
📊 Boiler: FakeGato history enabled (type: energy)
📊 ACS: FakeGato history enabled (type: thermo)
📊 HC0: FakeGato history enabled (type: thermo)
```

**Step 4 — Open Eve app** → tap the accessory → tap the graph icon.
Data accumulates over time — after a few hours you will see the first trends.

> **Note**: `fakegato-history` is an `optionalDependency`. If not installed, the plugin works normally — you simply won't have Eve graphs. When you install or update the plugin via npm, `fakegato-history` is installed automatically.

---

### 📁 CSV file

Every refresh appends a row to:
```
/var/lib/homebridge/viessmann-history.csv
```

Columns: `timestamp, accessory, burner_active, modulation, room_temp, target_temp, outside_temp, dhw_temp, dhw_target, program, mode, burner_starts, burner_hours`

Open directly in **Excel** or **Google Sheets** for custom analysis.

---

### 🌐 Interactive HTML report (Chart.js)

No extra dependencies — Chart.js is loaded from CDN. Open the generated file in any browser.

**Generate report**:
```bash
# Last 7 days — replace YOUR_INSTALLATION_ID with your actual ID (visible in Homebridge logs)
node /usr/local/lib/node_modules/homebridge-viessmann-vicare/viessmann-report.js --installation YOUR_INSTALLATION_ID

# With full system analysis (recommended — add your boiler's nominal kW from the ViCare app)
node /usr/local/lib/node_modules/homebridge-viessmann-vicare/viessmann-report.js --installation YOUR_INSTALLATION_ID --boilerKW 25 --designTemp -10

# Last 30 days
node /usr/local/lib/node_modules/homebridge-viessmann-vicare/viessmann-report.js --installation YOUR_INSTALLATION_ID --days 30 --boilerKW 25 --designTemp -10

# Custom output path
node /usr/local/lib/node_modules/homebridge-viessmann-vicare/viessmann-report.js --installation YOUR_INSTALLATION_ID --days 7 --out /tmp/report.html
```

| Parameter | Description | Default |
|---|---|---|
| `--installation <ID>` | Installation ID (required) | — |
| `--days <N>` | Number of days to include | `7` |
| `--boilerKW <kW>` | Boiler nominal power (enables kW analysis) | disabled |
| `--designTemp <°C>` | Design outdoor temperature for peak load calc | `-7` |
| `--path <dir>` | Homebridge storage path | `/var/lib/homebridge` |
| `--out <file>` | Output HTML file path | auto-generated |

**Copy to your Mac and open in browser**:
```bash
scp user@raspberry:/tmp/report.html ~/Desktop/viessmann-report.html && open ~/Desktop/viessmann-report.html
```

The report includes:
- **Overview chart**: all series on a unified timeline — room temp, flow temp, setpoint, DHW temp, outside temp, modulation (%), burner ON/OFF, humidity. Linearly interpolated for continuous lines.
- **Heating schedule bar**: HTML/CSS bar showing the programmed weekly schedule (normal/reduced/comfort/off segments)
- **Boiler stat cards**: starts/hour, avg/max modulation, heat demand (kW), gas consumption, condensing badge, cycle count and durations
- **Daily gas consumption chart**: stacked bar (heating + DHW) with daily total line
- **Cycle duration histogram**: distribution across 5 buckets — highlights short-cycling at a glance
- **🔍 System Analysis section** (v2.0.36+):
  - Heat demand (kW), house heat loss coefficient (kW/°C), estimated peak load, house efficiency rating
  - Boiler sizing check, cycling severity score, comfort stability (room temp stddev)
  - Estimated system efficiency (%), heating curve behaviour (weather-compensated vs fixed flow)
  - **Heat Demand vs Outdoor Temperature** scatter plot with regression line and balance point
  - Human-readable insight cards (✅ / ⚠️ / ℹ️) with actionable diagnostics
- **Heating Circuit (HC0)**: room temp vs setpoint chart, flow temperature chart, program distribution
- **DHW chart**: temperature vs setpoint over time
- Works offline once downloaded — no server required, all data is embedded

---

### 📧 Automated email report via crontab

You can schedule the report to be generated and emailed automatically using a shell script on your Raspberry Pi (or any Linux host running Homebridge).

**Create the script** at `/home/pi/Scripts/viessmann-report.sh`:

```bash
#!/bin/bash

REPORT="/tmp/report.html"
DAYS="${1:-30}"
EMAIL="$2"
INSTALLATION_ID="${3:-YOUR_INSTALLATION_ID}"
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
  --installation "$INSTALLATION_ID" \
  --days "$DAYS" \
  $EXTRA_ARGS \
  --out "$REPORT" >> "$LOG" 2>&1

if [ ! -f "$REPORT" ]; then
  echo "[$(date)] ERROR: report.html not found." >> "$LOG"
  exit 1
fi

mail -s "Viessmann Monthly Report - $(date +'%B %Y')" \
  -A "$REPORT" \
  "$EMAIL" <<< "Please find attached the Viessmann ViCare report for the last $DAYS days."

rm -f "$REPORT"
echo "[$(date)] Report sent and cleaned up." >> "$LOG"
```

Make it executable:
```bash
chmod +x /home/pi/Scripts/viessmann-report.sh
```

**Schedule with crontab** — send on the 1st of every month at 08:00:
```bash
crontab -e
```
Add:
```
0 8 1 * * /home/pi/Scripts/viessmann-report.sh 30 your@email.com YOUR_INSTALLATION_ID 25 -10
```

Or weekly every Monday at 07:00:
```
0 7 * * 1 /home/pi/Scripts/viessmann-report.sh 7 your@email.com YOUR_INSTALLATION_ID 25 -10
```

> **Note**: requires `mailutils` installed on the Pi (`sudo apt install mailutils`) and a working mail relay (e.g. Postfix with SMTP configured).

---

## 🔧 Configuration

### Prerequisites

1. **ViCare Account**: Active Viessmann ViCare account with registered devices
2. **API Credentials**: Client ID from Viessmann Developer Portal
3. **System Online**: Heating system must be online and accessible via ViCare

### Getting API Credentials

1. Visit the [**Viessmann Developer Portal**](https://developer.viessmann-climatesolutions.com)
2. Register a developer account
3. **Create a new application**:
   - Name: `homebridge-viessmann-vicare`
   - Type: **Public Client**
   - Redirect URI: `http://localhost:4200/`
   - Scope: `IoT User offline_access`
4. Save the generated **Client ID**

### Example Configuration (Complete)

```json
{
    "platform": "ViessmannPlatform",
    "name": "Viessmann",
    "clientId": "your_client_id_here",
    "username": "your_email@example.com",
    "password": "your_vicare_password",
    "authMethod": "auto",
    "refreshInterval": 120000,
    "requestTimeout": 30000,
    "enableRateLimitProtection": true,
    "maxRetries": 3,
    "retryDelay": 30000,
    "rateLimitResetBuffer": 60000,
    "installationFilter": "Main House",
    "customNames": {
        "installationPrefix": "My Home",
        "boiler": "Boiler",
        "dhw": "Hot Water",
        "heatingCircuit": "Heating Circuit",
        "reduced": "Reduced",
        "normal": "Normal",
        "comfort": "Comfort",
        "eco": "Eco",
        "off": "Off",
        "burner": "Burner",
        "modulation": "Modulation",
        "holiday": "Holiday Mode",
        "holidayAtHome": "Holiday At Home",
        "extendedHeating": "Extended Heating"
    },
    "cache": {
        "enabled": true,
        "installationsTTL": 86400000,
        "featuresTTL": 120000,
        "devicesTTL": 21600000,
        "gatewaysTTL": 43200000,
        "maxEntries": 1000,
        "enableSmartRefresh": false,
        "enableConditionalRequests": false
    },
    "features": {
        "enableBoilerAccessories": true,
        "enableDHWAccessories": true,
        "enableHeatingCircuitAccessories": true,
        "enableTemperaturePrograms": true,
        "enableQuickSelections": true,
        "enableBurnerStatus": true
    },
    "advanced": {
        "baseDelay": 1000,
        "maxDelay": 300000,
        "maxConsecutiveErrors": 5,
        "deviceUpdateDelay": 1000,
        "userAgent": "homebridge-viessmann-vicare/2.0.8"
    },
    "debug": false
}
```

### 🎛️ Configuration Parameters

All parameters are now configurable through the Homebridge Config UI X interface:

#### **Basic Configuration**
- `platform`: Must be "ViessmannPlatform"
- `name`: Platform name in HomeKit
- `clientId`: Client ID from Viessmann API
- `username`: Your ViCare account email
- `password`: Your ViCare account password

#### **Authentication Method**
- `authMethod`: "auto" (recommended) or "manual"
- `hostIp`: IP for OAuth redirect (auto-detected)
- `redirectPort`: Port for OAuth callback (default: 4200)
- `accessToken`: Manual access token (manual auth only)
- `refreshToken`: Manual refresh token (manual auth only)

#### **🌍 Custom Names & Localization**
- `customNames.installationPrefix`: Custom prefix instead of full installation name
- `customNames.boiler`: Custom name for boiler accessories
- `customNames.dhw`: Custom name for DHW accessories
- `customNames.heatingCircuit`: Custom name for heating circuit accessories
- `customNames.reduced`: Custom name for reduced temperature program
- `customNames.normal`: Custom name for normal temperature program
- `customNames.comfort`: Custom name for comfort temperature program
- `customNames.eco`: Custom name for DHW eco mode
- `customNames.off`: Custom name for off mode
- `customNames.burner`: Custom name for burner accessories
- `customNames.modulation`: Custom name for modulation accessories
- `customNames.holiday`: Custom name for holiday mode
- `customNames.holidayAtHome`: Custom name for holiday at home mode
- `customNames.extendedHeating`: Custom name for extended heating mode

#### **Installation Filtering**
- `installationFilter`: Filter by name (case-insensitive)
- `installationIds`: Array of specific installation IDs

#### **Performance & Rate Limiting**
- `refreshInterval`: Update interval in ms (default: 120000)
- `requestTimeout`: API request timeout in ms (default: 30000)
- `enableRateLimitProtection`: Enable rate limit protection (default: true)
- `maxRetries`: Maximum retry attempts (default: 3)
- `retryDelay`: Base retry delay in ms (default: 30000)
- `rateLimitResetBuffer`: Buffer after rate limit expires (default: 60000)

#### **API Caching**
- `cache.enabled`: Enable caching (default: true)
- `cache.installationsTTL`: Installations cache TTL (default: 24h)
- `cache.featuresTTL`: Features cache TTL (default: 2min)
- `cache.devicesTTL`: Devices cache TTL (default: 6h)
- `cache.gatewaysTTL`: Gateways cache TTL (default: 12h)
- `cache.maxEntries`: Maximum cache entries (default: 1000)
- `cache.enableSmartRefresh`: Background cache warming (default: false)
- `cache.enableConditionalRequests`: Use ETags (default: false)

#### **Feature Control**
- `features.enableBoilerAccessories`: Enable boiler controls
- `features.enableDHWAccessories`: Enable DHW controls
- `features.enableHeatingCircuitAccessories`: Enable heating circuits
- `features.enableTemperaturePrograms`: Enable temperature programs
- `features.enableQuickSelections`: Enable holiday modes
- `features.enableBurnerStatus`: Enable burner status accessories

#### **Advanced Settings**
- `advanced.baseDelay`: Base exponential backoff delay
- `advanced.maxDelay`: Maximum backoff delay
- `advanced.maxConsecutiveErrors`: Max consecutive errors
- `advanced.deviceUpdateDelay`: Delay between device updates
- `advanced.userAgent`: Custom User-Agent string

### 🔧 Custom Names Setup Guide

1. **Configure in Homebridge Config UI X**: Navigate to the "Custom Names & Localization" section
2. **Set your language**: Use the examples above for common languages
3. **Enable Force Service Recreation**: Set `forceServiceRecreation: true` **temporarily** to test changes
4. **Restart Homebridge**: Full restart required for names to take effect
5. **Disable Force Recreation**: Set `forceServiceRecreation: false` for production use

**Important Notes:**
- Custom names require a Homebridge restart to take effect
- Use `forceServiceRecreation: true` only for testing, then disable it
- Names include temperatures automatically (e.g., "Ridotto 18C")
- All names are sanitized for HomeKit compatibility

## 🔧 Advanced Troubleshooting (v2.0)

### 🔍 Modular Debugging

With the new modular architecture, you can pinpoint issues more precisely:

#### 🔐 Authentication Issues
**Module**: `auth-manager.ts`
```bash
# Check debug logs for:
[AuthManager] 🔑 Using existing valid token
[AuthManager] ⚠️ Token refresh failed, will try to get new tokens
[AuthManager] ✅ Authentication successful! Access and refresh tokens acquired
```

**Solutions:**
- Check token storage: `~/.homebridge/viessmann-tokens.json`
- Verify OAuth redirect URI configuration
- Try manual authentication method

#### 🛡️ Rate Limiting Protection  
**Module**: `rate-limit-manager.ts`
```bash
# Look for these patterns:
[RateLimitManager] ⚠️ Rate limit exceeded (429). Blocked for X seconds
[RateLimitManager] 🚫 Daily API quota exceeded
[RateLimitManager] ✅ Rate limit has been reset - API calls can resume
```

**Auto-Recovery Features:**
- Automatic exponential backoff
- Cache TTL extension during rate limiting
- Daily quota detection and management
- Intelligent retry scheduling

#### 🌍 Custom Names Issues
**Module**: `platform.ts`, accessory files
```bash
# Check for name application:
[Platform] 🏷️ DHW Setup - Installation: "Casa Mia", DHW: "Acqua Calda"
[Platform] 🏷️ Creating Comfort service: "Casa Mia Acqua Calda Comfort"
[Platform] ✅ DHW mode services setup completed
```

**Solutions:**
- Verify `customNames` configuration is correct
- Check for typos in custom name fields
- Enable `forceServiceRecreation: true` temporarily
- Restart Homebridge completely
- Check logs for service creation messages

#### 📡 API Client Issues
**Module**: `api-client.ts`
```bash
# Monitor for:
[APIClient] 💨 Cache hit for getDeviceFeatures
[APIClient] 🔄 Retrying 'getInstallations' in X seconds
[APIClient] ✅ API call succeeded after X retries
```

**Performance Metrics:**
- Cache hit rates (target: >80%)
- Response times and retry counts
- Health scores and success rates

#### 🌐 Network & Environment
**Module**: `network-utils.ts`
```bash
# Environment detection:
[NetworkUtils] 🖥️ Detected headless Linux environment
[NetworkUtils] 🐳 Detected container environment  
[NetworkUtils] 🌐 Opening browser for authentication
```

### 📊 Real-Time Monitoring

Enable comprehensive monitoring with:
```json
{
    "debug": true,
    "enableApiMetrics": true,
    "cache": {
        "enabled": true
    }
}
```

**Key Metrics to Watch:**
- **Cache Hit Rate**: Should be >70% for optimal performance
- **Rate Limit Status**: Should show "OK" most of the time
- **API Health Score**: Should be >85 for good performance
- **Response Times**: Should be <5 seconds typically

### 🔧 Module-Specific Debug Commands

**Check Authentication Status:**
```javascript
// Available in debug logs
this.viessmannAPI.getTokenStatus()
```

**Monitor Rate Limiting:**
```javascript
// Real-time rate limit status
this.viessmannAPI.getRateLimitStatus()
```

**Cache Performance:**
```javascript
// Cache statistics and hit rates
this.viessmannAPI.getCacheStats()
```

**API Health:**
```javascript
// Overall API performance metrics
this.viessmannAPI.getAPIMetrics()
```

## 🛡️ Rate Limiting Protection

The plugin includes advanced protection against Viessmann API rate limits:

### Features

- **🔍 Rate Limit Detection**: Automatic detection of 429 (Too Many Requests) errors
- **⏱️ Exponential Backoff**: Intelligent retry delays that increase with each failure
- **🔄 Alternative Endpoints**: Fallback to different API methods when primary endpoints fail
- **📊 Adaptive Intervals**: Automatic adjustment of refresh intervals based on API availability
- **🚫 Request Blocking**: Prevention of additional requests when rate limited
- **📈 Status Monitoring**: Real-time monitoring of rate limit status
- **💾 Cache Integration**: Automatic cache TTL extension during rate limiting

### Recommended Settings by Usage

**Single Installation (Low API Usage):**
```json
{
    "refreshInterval": 60000,
    "enableRateLimitProtection": true,
    "cache": {
        "enabled": true,
        "featuresTTL": 120000
    }
}
```

**Multiple Installations (High API Usage):**
```json
{
    "refreshInterval": 300000,
    "enableRateLimitProtection": true,
    "installationFilter": "Main House",
    "cache": {
        "enabled": true,
        "featuresTTL": 300000,
        "enableSmartRefresh": true
    }
}
```

**Recovery from Rate Limiting:**
```json
{
    "refreshInterval": 900000,
    "enableRateLimitProtection": true,
    "maxRetries": 1,
    "retryDelay": 300000,
    "cache": {
        "enabled": true,
        "featuresTTL": 1800000
    }
}
```

## 💾 Intelligent Cache Management

### Multi-Layer Caching System

The plugin implements a sophisticated caching system with different TTL values for different data types:

- **Installations**: Cached for 24 hours (rarely change)
- **Gateways**: Cached for 12 hours (stable data)
- **Devices**: Cached for 6 hours (moderate stability)
- **Features**: Cached for 2 minutes (frequently changing data)
- **Commands**: Never cached (always fresh execution)

### Cache Features

- **LRU Eviction**: Least Recently Used items are removed when cache is full
- **Smart Refresh**: Optional background warming of frequently accessed data
- **Conditional Requests**: ETags and Last-Modified headers support
- **Memory Monitoring**: Track cache size and hit rates
- **Pattern Invalidation**: Selective cache clearing on commands

### Cache Performance Estimates

- **Aggressive Caching**: 70-90% API call reduction
- **Conservative Caching**: 40-60% API call reduction
- **Minimal Caching**: 20-40% API call reduction

## 🔐 Authentication Methods

### 🚀 Automatic OAuth (Recommended)

The plugin handles OAuth authentication automatically:

1. **First run** shows an authentication URL in logs
2. **Browser opens automatically** (on desktop systems)
3. **Login with ViCare credentials**
4. **Authorize the application** 
5. **Tokens are saved automatically** for future use

### 🔧 Manual Authentication

For server/headless environments or if automatic OAuth fails:

1. **Get tokens manually** following instructions in logs
2. **Add tokens to configuration**

### 🔄 Intelligent Fallback Logic

The plugin automatically uses the best method:

- ✅ **Manual tokens in config** → uses those
- ✅ **Desktop environment** → tries automatic OAuth  
- ✅ **Headless/Docker environment** → uses manual authentication
- ✅ **OAuth fails** → falls back to manual instructions

## 🏠 HomeKit Accessories Created

The plugin automatically creates these accessories (configurable via feature flags):

### 🔥 Boiler
- **Name**: `[Installation] [Custom Boiler Name]`
- **Type**: HeaterCooler
- **Controls**: Target temperature, active state
- **Sensors**: Current temperature, heating state, burner status
- **Additional**: Modulation level (as Lightbulb brightness)
- **Additional Services**: 
  - `[Installation] [Custom Boiler Name] [Custom Burner Name]` (Switch)
  - `[Installation] [Custom Boiler Name] [Custom Modulation Name]` (Lightbulb)

### 🚿 Domestic Hot Water (DHW)
- **Name**: `[Installation] [Custom DHW Name]`
- **Type**: HeaterCooler
- **Controls**: DHW temperature (30-60°C), operating modes
- **Mode Services**: 
  - `[Installation] [Custom DHW Name] [Custom Comfort Name]` (Switch)
  - `[Installation] [Custom DHW Name] [Custom Eco Name]` (Switch)
  - `[Installation] [Custom DHW Name] [Custom Off Name]` (Switch)
- **Sensors**: Current DHW temperature, heating state

### 🏠 Heating Circuits
- **Name**: `[Installation] [Custom Heating Circuit Name] X`
- **Type**: HeaterCooler (main control)
- **Controls**: Circuit temperature, operating modes
- **Temperature Programs**: 
  - `[Installation] [Custom Heating Circuit Name] X [Custom Reduced Name] XXC` (Switch)
  - `[Installation] [Custom Heating Circuit Name] X [Custom Normal Name] XXC` (Switch)
  - `[Installation] [Custom Heating Circuit Name] X [Custom Comfort Name] XXC` (Switch)
- **Quick Selections**:
  - `[Installation] [Custom Heating Circuit Name] X [Custom Holiday Name]` (Switch)
  - `[Installation] [Custom Heating Circuit Name] X [Custom Holiday At Home Name]` (Switch)
  - `[Installation] [Custom Heating Circuit Name] X [Custom Extended Heating Name]` (Switch)
- **Sensors**: Room temperature, supply temperature

## 🎯 Advanced Features

### Temperature Programs

Each heating circuit supports individual temperature programs:

- **🌙 Reduced**: Low temperature for unoccupied periods
- **🏠 Normal**: Standard comfort temperature
- **☀️ Comfort**: Higher temperature for maximum comfort

Each program maintains its own temperature setting and can be activated independently.

### Quick Selection Programs

- **🏖️ Holiday Mode**: 7-day holiday schedule starting tomorrow
- **🏠 Holiday at Home**: Single-day reduced heating for today
- **⚡ Extended Heating**: Temporary comfort boost (activates comfort program)

### Installation Filtering

Reduce API calls by filtering installations:

```json
{
    "installationFilter": "Main House",
    "installationIds": [123456, 789012]
}
```

### Custom Names Examples

**🇮🇹 Complete Italian Setup:**
```json
{
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
    }
}
```

## 🔧 Troubleshooting

### 🌍 Custom Names Not Updating

**Symptoms:**
- Accessories still show English names
- New names don't appear in HomeKit
- Services have old names

**Solutions:**
1. ✅ **Verify configuration**: Check `customNames` is properly configured
2. ✅ **Restart Homebridge**: Full restart required for name changes
3. ✅ **Enable force recreation**: Set `forceServiceRecreation: true` temporarily
4. ✅ **Check logs**: Look for service creation messages
5. ✅ **Disable force recreation**: Set to `false` after successful update
6. ✅ **Clear HomeKit cache**: Remove and re-add accessories if needed

### Rate Limiting (429 Errors)

**Symptoms:**
- Log messages about rate limiting
- Accessories not updating
- "Too Many Requests" errors

**Solutions:**
1. ✅ **Increase refresh interval**: Set to 180000ms (3 minutes) or higher
2. ✅ **Enable rate limit protection**: Ensure `enableRateLimitProtection: true`
3. ✅ **Use installation filtering**: Filter to only needed installations
4. ✅ **Increase cache TTL**: Set longer cache durations
5. ✅ **Close ViCare app**: Temporarily close mobile app to reduce API usage
6. ✅ **Wait for reset**: API limits typically reset after 24 hours

### Authentication Issues

1. ✅ Verify ViCare credentials are correct
2. ✅ Check that devices are registered in ViCare
3. ✅ Ensure Client ID is valid
4. ✅ Try manual authentication method
5. ✅ Check redirect URI configuration

### Performance Issues

1. ✅ Enable caching with appropriate TTL values
2. ✅ Increase request timeout for slow connections
3. ✅ Use installation filtering to reduce load
4. ✅ Disable unnecessary accessory types via feature flags
5. ✅ Monitor cache hit rates in debug logs

### Debug Logging

Enable comprehensive debug logging:

```json
{
    "debug": true
}
```

Debug logs show:
- 📊 Rate limit status and cache statistics
- 🔄 API call attempts and retries
- 🛡️ Rate limit protection actions
- 📈 Performance metrics and cache hit rates
- 🔍 Detailed error information
- 🏷️ Custom name application and service creation

## 📊 Performance Optimization

### Performance Profiles

**Real-Time Profile (High API Usage):**
```json
{
    "refreshInterval": 60000,
    "cache": {
        "featuresTTL": 60000
    }
}
```

**Balanced Profile (Recommended):**
```json
{
    "refreshInterval": 120000,
    "cache": {
        "featuresTTL": 120000
    }
}
```

**Conservative Profile (Low API Usage):**
```json
{
    "refreshInterval": 300000,
    "cache": {
        "featuresTTL": 300000,
        "enableSmartRefresh": true
    }
}
```

### Monitoring Performance

Check these metrics in debug logs:
- Cache hit rates (target: >80%)
- API response times
- Rate limit status
- Memory usage

## 🔧 Viessmann APIs Used

- **IoT Equipment API v2**: Installation, gateway, and device management
- **IoT Features API v2**: Feature control and command execution
- **IAM Authentication v3**: OAuth2 authentication with PKCE

## ⚠️ Known Limitations

1. **API Rate Limits**: Viessmann enforces daily request limits (varies by plan)
2. **Feature Availability**: Not all devices support all features
3. **Command Latency**: Commands may take several seconds to execute
4. **Regional Differences**: Some features may vary by region/device model
5. **Initial Setup**: First-time OAuth setup requires manual browser interaction
6. **Name Changes**: Custom names require Homebridge restart to take effect

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Test your changes thoroughly
4. Submit a pull request with detailed description

## 📋 Compatibility

- **Homebridge**: >= 1.8.0 or >= 2.0.0-beta.0
- **Node.js**: >= 20.0.0
- **Viessmann API**: v1 and v2
- **iOS**: All HomeKit-supported devices
- **Languages**: All languages supported via custom names

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Viessmann API documentation available at [Viessmann Developer Portal](https://developer.viessmann-climatesolutions.com/)
- Community feedback and contributions
- International user community for localization feedback

## 📞 Support

For issues and questions:

1. Check the [🔧 Troubleshooting](#🔧-advanced-troubleshooting-v20) section
2. Search [existing issues](https://github.com/diegoweb100/homebridge-viessmann-vicare/issues)
3. Create a new issue with:
   - Complete configuration (without passwords)
   - Full debug logs
   - Device model information
   - Plugin version
   - Cache statistics
   - Custom names configuration (if applicable)

## 📈 Changelog

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
- fix: viessmann-history-2045571.csv migration script updated (re-run if needed)

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
mv /var/lib/homebridge/viessmann-history.csv /var/lib/homebridge/viessmann-history-2045571.csv
mv /var/lib/homebridge/viessmann-schedule.json /var/lib/homebridge/viessmann-schedule-2045571.json
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

## Support

If you find this plugin useful, consider buying me a coffee ☕

[![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/diegoweb100)

---
**Note**: This plugin is not officially affiliated with Viessmann. It's a community open-source project.