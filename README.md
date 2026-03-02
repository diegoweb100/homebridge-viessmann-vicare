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

### [2.0.19] - 2026-03-02
**Fixed**
- 🐛 **Progressive command confirmation replaces single-shot refresh**: after every command all accessories now retry API confirmation up to 4 times (at 5s, 15s, 30s, 60s) instead of a single check. Each retry extends the pending guard, preventing the regular update cycle from overwriting the local state while the Viessmann backend propagates.
- 🐛 **External change detection during guard window**: if the API returns a value that is neither the pre-command value nor the expected post-command value (i.e. someone changed the setting from the ViCare app), the guard is immediately reset and the external change is applied. This ensures the app and HomeKit stay in sync even when commands arrive from multiple sources.
- 🐛 **Guard duration now covers the full retry window**: `pendingXxxUntil` is set to `guardDuration` (default 120s) instead of the previous hardcoded 10s, preventing the regular 15-minute cycle from overwriting state before confirmation retries complete.

**Changed**
- 🔧 `postCommandRefreshDelay` config parameter removed and replaced by `postCommandRetry.delays` (array of ms, default `[5000, 15000, 30000, 60000]`) and `postCommandRetry.guardDuration` (ms, default `120000`).
- 🔧 `scheduleStateRefresh()` replaced by `scheduleCommandConfirmation()` in all three accessories.
- 🔧 Applied uniformly to `dhw-accessory`, `boiler-accessory`, and `heating-circuit-accessory`.

### [2.0.18] - 2026-03-02
**Fixed**
- 🐛 **Double `handleManualAuth()` call eliminated**: when auto-auth failed, `handleManualAuth()` was being called twice — once inside `performAutoAuth()` and again in the outer `catch` of `authenticate()`. This caused the `MANUAL AUTHENTICATION REQUIRED` block to appear twice in logs and could produce confusing error chains. `performAutoAuth()` now simply rethrows, leaving `authenticate()` as the single point of fallback control.

**Changed**
- 🔧 Removed all commented-out dead code from `auth-manager.ts` (old `shouldUseManualAuth()`, old `openBrowser()`, old `if (authMethod === 'manual' || this.shouldUseManualAuth())` block). No functional change, cleaner codebase.

### [2.0.17] - 2026-03-02
**Fixed**
- 🐛 Post-command state refresh delay is now configurable via `postCommandRefreshDelay` (default **5000ms**). The previous hardcoded 1 second was too short for the Viessmann backend to propagate commands, causing the refresh to fetch the old state and overwrite the correct local state in HomeKit.
- 🐛 Added anti-overwrite guard to all post-command refreshes: if the API still returns the pre-command value when the refresh fires (backend not yet propagated), the update is skipped and a warning is logged — protecting the optimistic local state from being silently reverted.

**Changed**
- 🔧 `DEFAULT_CONFIG.postCommandRefreshDelay` added to `settings.ts` (5000ms).
- 🔧 `postCommandRefreshDelay` exposed in `ViessmannPlatformConfig` interface.

### [2.0.16] - 2026-03-02
**Added**
- ✨ Post-command state refresh: all accessories now automatically re-fetch device features from the API ~1 second after every command (mode change, temperature set). This confirms the command was accepted by the Viessmann backend and syncs HomeKit state immediately, without waiting for the next scheduled update cycle.
  - `dhw-accessory.ts`: refresh triggered after DHW mode change and DHW target temperature change.
  - `heating-circuit-accessory.ts`: refresh triggered after temperature program change, operating mode change, and threshold temperature change.
  - `boiler-accessory.ts`: refresh triggered after boiler target temperature change.

### [2.0.15] - 2026-02-28
**Fixed**
- 🐛 Token storage now uses `api.user.storagePath()` (Homebridge storage directory) instead of `process.cwd()`, as required by Homebridge plugin verification guidelines.
- 🐛 Early config validation in `ViessmannPlatform` constructor: plugin exits cleanly if `clientId` or `username` are missing, instead of crashing on first API call.
**Changed**
- 🔧 `PLUGIN_VERSION` updated to `2.0.8` in `settings.ts` (User-Agent and logs now reflect the correct version).
- 🔧 `ViessmannAPI` constructor now accepts optional `storagePath` parameter passed from Homebridge.
- 🔧 `AuthManager` constructor accepts optional `storagePath` parameter (fallback to `.homebridge` in cwd for backward compatibility).

### [2.0.7] - 2025-10-07
**Fixed**
- 🐛 Minor stability improvements and internal code cleanup.

### [2.0.6] - 2025-10-07
**Fixed**
- 🐛 Improved error handling for edge cases in token refresh flow.

### [2.0.5] - 2025-10-07
**Fixed**
- 🐛 Additional resilience improvements for authentication on headless systems.

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