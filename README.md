# homebridge-viessmann-vicare

[![npm](https://img.shields.io/npm/v/homebridge-viessmann-vicare.svg)](https://www.npmjs.com/package/homebridge-viessmann-vicare)
[![GitHub release](https://img.shields.io/github/release/diegoweb100/homebridge-viessmann-vicare.svg)](https://github.com/diegoweb100/homebridge-viessmann-vicare/releases)
[![npm downloads](https://img.shields.io/npm/dt/homebridge-viessmann-vicare.svg)](https://www.npmjs.com/package/homebridge-viessmann-vicare)
[![GitHub stars](https://img.shields.io/github/stars/diegoweb100/homebridge-viessmann-vicare.svg)](https://github.com/diegoweb100/homebridge-viessmann-vicare/stargazers)
[![GitHub issues](https://img.shields.io/github/issues/diegoweb100/homebridge-viessmann-vicare.svg)](https://github.com/diegoweb100/homebridge-viessmann-vicare/issues)

A comprehensive Homebridge plugin for Viessmann heating systems with **full control capabilities** including boilers, domestic hot water (DHW), and heating circuits through Apple HomeKit. Features advanced rate limiting protection, intelligent cache management, and automatic retry logic.

## 🚀 Key Features

- **🔥 Complete boiler control**: Temperature, operating modes, burner status, modulation
- **🚿 DHW management**: Temperature control and operating modes for domestic hot water
- **🏠 Individual heating circuits**: Full control of each circuit with temperature programs
- **🎛️ Advanced temperature programs**: Reduced, Normal, Comfort modes with individual temperatures
- **🏖️ Holiday and quick selection modes**: Holiday, Holiday at Home, Extended Heating programs
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

For detailed architecture documentation, see [ARCHITECTURE.md](ARCHITECTURE.md).

## 🆕 What's New in v2.0

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

1. Visit the [**Viessmann Developer Portal**](https://developer.viessmann.com/)
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
        "userAgent": "homebridge-viessmann-vicare/2.0.0"
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
- **Name**: `[Installation] Boiler`
- **Type**: HeaterCooler
- **Controls**: Target temperature, active state
- **Sensors**: Current temperature, heating state, burner status
- **Additional**: Modulation level (as Lightbulb brightness)

### 🚿 Domestic Hot Water (DHW)
- **Name**: `[Installation] Hot Water`
- **Type**: HeaterCooler
- **Controls**: DHW temperature (30-60°C), operating modes
- **Modes**: Off, Eco, Comfort (as separate switches)
- **Sensors**: Current DHW temperature, heating state

### 🏠 Heating Circuits
- **Name**: `[Installation] Heating Circuit X`
- **Type**: HeaterCooler (main control)
- **Controls**: Circuit temperature, operating modes
- **Temperature Programs**: 
  - Reduced Mode (Ridotta) - Switch
  - Normal Mode (Normale) - Switch  
  - Comfort Mode - Switch
- **Quick Selections**:
  - Holiday Mode - Switch (7-day schedule)
  - Holiday at Home - Switch (today only)
  - Extended Heating - Switch (comfort boost)
- **Sensors**: Room temperature, supply temperature

## 🎯 Advanced Features

### Temperature Programs

Each heating circuit supports individual temperature programs:

- **🌙 Reduced (Ridotta)**: Low temperature for unoccupied periods
- **🏠 Normal (Normale)**: Standard comfort temperature
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

## 🔧 Troubleshooting

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

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Test your changes thoroughly
4. Submit a pull request with detailed description

## 📋 Compatibility

- **Homebridge**: >= 1.8.0 or >= 2.0.0-beta.0
- **Node.js**: >= 18.15.0
- **Viessmann API**: v1 and v2
- **iOS**: All HomeKit-supported devices

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Viessmann API documentation available at [Viessmann Developer Portal](https://developer.viessmann.com/)
- Community feedback and contributions

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

## 📈 Changelog

### v2.0.0
- ✨ **Major Release**: Complete rewrite with advanced features
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

**Note**: This plugin is not officially affiliated with Viessmann. It's a community open-source project.