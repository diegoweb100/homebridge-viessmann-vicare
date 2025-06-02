# homebridge-viessmann-vicare

[![npm](https://img.shields.io/npm/v/homebridge-viessmann-vicare.svg)](https://www.npmjs.com/package/homebridge-viessmann-vicare)
[![GitHub release](https://img.shields.io/github/release/diegoweb100/homebridge-viessmann-vicare.svg)](https://github.com/diegoweb100/homebridge-viessmann-vicare/releases)
[![npm downloads](https://img.shields.io/npm/dt/homebridge-viessmann-vicare.svg)](https://www.npmjs.com/package/homebridge-viessmann-vicare)
[![GitHub stars](https://img.shields.io/github/stars/diegoweb100/homebridge-viessmann-vicare.svg)](https://github.com/diegoweb100/homebridge-viessmann-vicare/stargazers)
[![GitHub issues](https://img.shields.io/github/issues/diegoweb100/homebridge-viessmann-vicare.svg)](https://github.com/diegoweb100/homebridge-viessmann-vicare/issues)

A comprehensive Homebridge plugin for Viessmann heating systems with **full control capabilities** including boilers, domestic hot water (DHW), and heating circuits through Apple HomeKit. Features advanced rate limiting protection and intelligent retry logic.

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
- **🔐 Secure authentication**: OAuth2 with automatic token refresh
- **📊 Real-time updates**: Continuous monitoring with adaptive refresh intervals
- **🎯 Installation filtering**: Show only specific installations or filter by name
- **🎛️ Easy configuration**: Full support for Homebridge Config UI X
- **🎯 Native integration**: Complete compatibility with Apple Home app and Siri controls

## 🆕 What's New in v2.0

- **🛡️ Advanced Rate Limiting Protection**: Intelligent handling of Viessmann API rate limits (429 errors)
- **🔄 Smart Retry Logic**: Exponential backoff with alternative API endpoints
- **📊 Adaptive Refresh Intervals**: Automatic adjustment based on API availability
- **🎯 Installation Filtering**: Filter installations by name or ID to reduce API calls
- **🎛️ Individual Temperature Programs**: Separate controls for Reduced/Normal/Comfort modes
- **🏖️ Enhanced Holiday Modes**: Full support for Holiday and Holiday at Home programs
- **⚡ Extended Heating Mode**: Quick comfort boost functionality
- **🔧 Improved Error Recovery**: Better handling of temporary API issues
- **📈 Performance Monitoring**: Real-time rate limit status and diagnostics

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
3. Configure the plugin through the web interface

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

### Example Configuration (OAuth Automatic - Recommended)

```json
{
    "platform": "ViessmannPlatform",
    "name": "Viessmann",
    "clientId": "your_client_id_here",
    "username": "your_email@example.com",
    "password": "your_vicare_password",
    "authMethod": "auto",
    "refreshInterval": 120000,
    "enableRateLimitProtection": true,
    "installationFilter": "Main House",
    "debug": false
}
```

### Example Configuration (Manual Authentication)

```json
{
    "platform": "ViessmannPlatform",
    "name": "Viessmann",
    "clientId": "your_client_id_here", 
    "username": "your_email@example.com",
    "password": "your_vicare_password",
    "authMethod": "manual",
    "accessToken": "your_access_token",
    "refreshToken": "your_refresh_token",
    "refreshInterval": 180000,
    "enableRateLimitProtection": true,
    "debug": false
}
```

### Configuration Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `platform` | string | ✅ | Must be "**ViessmannPlatform**" |
| `name` | string | ✅ | Platform name in HomeKit |
| `clientId` | string | ✅ | Client ID from Viessmann API |
| `username` | string | ✅ | Your ViCare account email |
| `password` | string | ✅ | Your ViCare account password |
| `authMethod` | string | ❌ | Authentication method: `auto` (default) or `manual` |
| `hostIp` | string | ❌ | IP for OAuth redirect (auto-detected if omitted) |
| `redirectPort` | number | ❌ | Port for OAuth callback (default: 4200) |
| `accessToken` | string | ❌ | Access token (manual auth only) |
| `refreshToken` | string | ❌ | Refresh token (manual auth only) |
| `installationFilter` | string | ❌ | Filter installations by name (case-insensitive) |
| `installationIds` | array | ❌ | Array of specific installation IDs to include |
| `refreshInterval` | number | ❌ | Update interval in ms (default: 60000, recommended: 120000+) |
| `enableRateLimitProtection` | boolean | ❌ | Enable rate limit protection (default: true) |
| `maxRetries` | number | ❌ | Maximum retry attempts (default: 3) |
| `retryDelay` | number | ❌ | Base retry delay in ms (default: 30000) |
| `debug` | boolean | ❌ | Enable debug logging (default: false) |

## 🛡️ Rate Limiting Protection

The plugin includes advanced protection against Viessmann API rate limits:

### Features

- **🔍 Rate Limit Detection**: Automatic detection of 429 (Too Many Requests) errors
- **⏱️ Exponential Backoff**: Intelligent retry delays that increase with each failure
- **🔄 Alternative Endpoints**: Fallback to different API methods when primary endpoints fail
- **📊 Adaptive Intervals**: Automatic adjustment of refresh intervals based on API availability
- **🚫 Request Blocking**: Prevention of additional requests when rate limited
- **📈 Status Monitoring**: Real-time monitoring of rate limit status

### Configuration for Rate Limit Protection

```json
{
    "refreshInterval": 180000,          // 3 minutes (recommended for multiple installations)
    "enableRateLimitProtection": true,  // Enable protection (default: true)
    "maxRetries": 3,                   // Maximum retry attempts
    "retryDelay": 60000,               // Base delay: 1 minute
    "installationFilter": "Main"       // Reduce API calls by filtering
}
```

### Recommended Settings by Usage

**Single Installation (Low API Usage):**
```json
{
    "refreshInterval": 60000,    // 1 minute
    "enableRateLimitProtection": true
}
```

**Multiple Installations (High API Usage):**
```json
{
    "refreshInterval": 300000,   // 5 minutes
    "enableRateLimitProtection": true,
    "installationFilter": "Main House"  // Filter to reduce calls
}
```

**Recovery from Rate Limiting:**
```json
{
    "refreshInterval": 600000,   // 10 minutes
    "enableRateLimitProtection": true,
    "maxRetries": 1,
    "retryDelay": 300000        // 5 minute delays
}
```

## 🔐 Authentication Methods

### 🚀 Automatic OAuth (Recommended)

The plugin handles OAuth authentication automatically:

1. **First run** shows an authentication URL in logs
2. **Browser opens automatically** (on desktop systems)
3. **Login with ViCare credentials**
4. **Authorize the application** 
5. **Tokens are saved automatically** for future use

```json
{
    "authMethod": "auto"  // Default, can be omitted
}
```

### 🔧 Manual Authentication

For server/headless environments or if automatic OAuth fails:

1. **Get tokens manually** following instructions in logs
2. **Add tokens to configuration**

```json
{
    "authMethod": "manual",
    "accessToken": "eyJ...",
    "refreshToken": "abc123..."
}
```

### 🔄 Intelligent Fallback Logic

The plugin automatically uses the best method:

- ✅ **Manual tokens in config** → uses those
- ✅ **Desktop environment** → tries automatic OAuth  
- ✅ **Headless/Docker environment** → uses manual authentication
- ✅ **OAuth fails** → falls back to manual instructions

## 🏠 HomeKit Accessories Created

The plugin automatically creates these accessories:

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
    "installationFilter": "Main House",     // Show only installations containing "Main House"
    "installationIds": [123456, 789012]    // Or specify exact installation IDs
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
4. ✅ **Close ViCare app**: Temporarily close mobile app to reduce API usage
5. ✅ **Wait for reset**: API limits typically reset after 24 hours

### Authentication Issues

1. ✅ Verify ViCare credentials are correct
2. ✅ Check that devices are registered in ViCare
3. ✅ Ensure Client ID is valid
4. ✅ Try manual authentication method

### Devices Not Found

1. ✅ Verify heating system is online in ViCare app
2. ✅ Check that installation has active gateways
3. ✅ Ensure devices support required features
4. ✅ Enable debug logging for details

### Commands Not Working

1. ✅ Verify device supports specific commands
2. ✅ Check device is in correct operating mode
3. ✅ Some features require specific system states
4. ✅ Enable debug logging to see API responses

### Debug Logging

Enable comprehensive debug logging:

```json
{
    "platform": "ViessmannPlatform",
    "debug": true,
    // ... other configuration
}
```

Debug logs show:
- 📊 Rate limit status
- 🔄 API call attempts and retries
- 🛡️ Rate limit protection actions
- 📈 Performance metrics
- 🔍 Detailed error information

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

## 📊 Performance Optimization

### Recommended Settings

**For minimal API usage:**
```json
{
    "refreshInterval": 300000,           // 5 minutes
    "enableRateLimitProtection": true,
    "installationFilter": "specific_name" // Filter to one installation
}
```

**For multiple installations:**
```json
{
    "refreshInterval": 180000,    // 3 minutes
    "enableRateLimitProtection": true,
    "installationIds": [12345]   // Specify only needed installations
}
```

### Monitoring

Check rate limit status in debug logs:
- Current rate limit state
- Time until reset
- Retry attempts
- Backoff multipliers

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

- Based on the plugin structure of [homebridge-melcloud-control](https://github.com/grzegorz914/homebridge-melcloud-control)
- Viessmann API documentation available at [Viessmann Developer Portal](https://developer.viessmann.com/)
- Community feedback and contributions

## 📞 Support

For issues and questions:

1. Check the [🔧 Troubleshooting](#🔧-troubleshooting) section
2. Search [existing issues](https://github.com/diegoweb100/homebridge-viessmann-vicare/issues)
3. Create a new issue with:
   - Complete configuration (without passwords)
   - Full debug logs
   - Device model information
   - Plugin version

## 📈 Changelog

### v2.0.0
- ✨ Advanced rate limiting protection with exponential backoff
- ✨ Installation filtering by name or ID
- ✨ Individual temperature programs (Reduced/Normal/Comfort)
- ✨ Holiday and quick selection modes
- ✨ Extended heating (comfort boost) functionality
- ✨ Intelligent retry logic with alternative API endpoints
- ✨ Adaptive refresh intervals based on API availability
- ✨ Enhanced error handling and recovery
- ✨ Real-time rate limit monitoring and diagnostics
- 🐛 Improved token refresh mechanism
- 🐛 Better handling of device feature detection
- 🐛 Fixed temperature constraint validation

---

**Note**: This plugin is not officially affiliated with Viessmann. It's a community open-source project.