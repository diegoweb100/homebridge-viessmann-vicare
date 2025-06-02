# Complete Setup Guide - v2.0.0

## Overview

This guide will walk you through setting up the Viessmann ViCare plugin v2.0 for Homebridge, including all the new advanced features like intelligent caching, rate limiting protection, and comprehensive configuration options.

## Prerequisites

### 1. ViCare Account
- Create an account on [ViCare](https://www.vicare.com/)
- Register your Viessmann heating system in the ViCare app
- Verify that your system is online and functioning properly
- Test the ViCare mobile app to ensure you can control your heating system

### 2. Viessmann API Credentials

To obtain API credentials:

1. **Visit the Developer Portal**:
   - Go to https://developer.viessmann.com/
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
# Install globally
sudo npm install -g homebridge-viessmann-vicare

# Or install in Homebridge directory
npm install homebridge-viessmann-vicare
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
```

5. Click "**Save**" to apply the configuration

### 3. First Authentication & Setup

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
   [Viessmann] https://iam.viessmann.com/idp/v3/authorize?client_id=...
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

### 4. Device Discovery & Verification

After successful authentication:

1. **Check discovery logs**:
   ```
   [Viessmann] Setting up installation: [Installation Name] (ID: 12345)
   [Viessmann] Adding new accessory: [Installation] Boiler
   [Viessmann] Adding new accessory: [Installation] Hot Water
   [Viessmann] Adding new accessory: [Installation] Heating Circuit 1
   ```

2. **Verify in HomeKit**:
   - Open the **Home app** on your iOS device
   - Look for new Viessmann accessories
   - Test basic controls (temperature adjustment)

3. **Check for errors**:
   - Look for rate limiting warnings
   - Verify all expected accessories are created
   - Test individual accessory functions

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

### 🏠 Single Installation (Recommended Starting Point)
```json
{
    "platform": "ViessmannPlatform",
    "name": "Viessmann",
    "clientId": "your_client_id",
    "username": "your_email@example.com",
    "password": "your_password",
    "refreshInterval": 120000,
    "enableRateLimitProtection": true,
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

The plugin creates different types of accessories based on your heating system:

### 🔥 Boiler Accessories
- **Main Boiler Control**: HeaterCooler service for temperature and mode control
- **Burner Status**: Switch showing burner active/inactive state
- **Modulation Level**: Lightbulb showing current burner modulation (0-100%)

### 🚿 DHW (Hot Water) Accessories
- **Main DHW Control**: HeaterCooler service for DHW temperature
- **Operating Mode Switches**: 
  - Off Mode Switch
  - Eco Mode Switch
  - Comfort Mode Switch

### 🏠 Heating Circuit Accessories
- **Main Circuit Control**: HeaterCooler service for circuit temperature
- **Temperature Programs** (if enabled):
  - Reduced (Ridotta) - Switch for economy mode
  - Normal (Normale) - Switch for standard comfort
  - Comfort - Switch for maximum comfort
- **Quick Selections** (if enabled):
  - Holiday Mode - Switch for 7-day holiday schedule
  - Holiday at Home - Switch for single-day reduced heating
  - Extended Heating - Switch for temporary comfort boost

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
[Viessmann] Adding new accessory: [Installation] Boiler
[Viessmann] Update cycle completed: X/Y successful, 0 errors
[Viessmann] Cache stats - Hit rate: 85.2%, Entries: 45
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
   - Look for accessories with your installation name
   - Verify all expected accessories are present
3. **Test basic functionality**:
   - Try adjusting boiler temperature
   - Test DHW mode switches
   - Try heating circuit controls
4. **Check responsiveness**:
   - Commands should execute within 5-10 seconds
   - Status updates should appear within refresh interval

### 4. API Rate Limit Status
Monitor rate limit status in logs:
```
[Viessmann] Rate limit status: OK
[Viessmann] Cache stats - Hit rate: 85.2%, Entries: 45
[Viessmann] API call succeeded after 0 retries
```

## Common Issues & Solutions

### 🚨 Rate Limiting (429 Errors)

**Symptoms:**
- `Rate limit exceeded` messages in logs
- Accessories not updating
- `Too Many Requests` errors

**Immediate Solutions:**
1. **Increase refresh interval**:
   ```json
   "refreshInterval": 300000
   ```

2. **Enable aggressive caching**:
   ```json
   "cache": {
       "enabled": true,
       "featuresTTL": 600000
   }
   ```

3. **Use installation filtering**:
   ```json
   "installationFilter": "Main House"
   ```

4. **Close ViCare mobile app** temporarily

5. **Wait for reset** (typically 24 hours)

### 🔐 Authentication Errors

**Symptoms:**
- `Authentication failed` messages
- 401/403 HTTP errors
- Login prompts not working

**Solutions:**
1. **Verify credentials**:
   - Double-check ViCare username/password
   - Ensure Client ID is correct
   - Test login in ViCare mobile app

2. **Check API application**:
   - Verify redirect URI: `http://localhost:4200/`
   - Ensure scope: `IoT User offline_access`
   - Check application is "Public Client" type

3. **Try manual authentication**:
   - Change `authMethod` to `"manual"`
   - Follow manual token instructions in logs

4. **Network issues**:
   - Check firewall settings
   - Verify port 4200 is accessible
   - Try different host IP if auto-detection fails

### 🏠 No Installations/Devices Found

**Symptoms:**
- `No installations found` message
- Empty accessory list in HomeKit
- Discovery completes but no devices

**Solutions:**
1. **Verify ViCare setup**:
   - Check devices are online in ViCare app
   - Ensure account has access to installations
   - Verify heating system is registered

2. **Check filtering settings**:
   - Remove `installationFilter` temporarily
   - Clear `installationIds` array
   - Enable debug logging to see available installations

3. **Enable debug logging**:
   ```json
   "debug": true
   ```
   - Look for `Available installations:` messages
   - Check installation names and IDs

### ⚡ Performance Issues

**Symptoms:**
- Slow response times
- Timeout errors
- Connection failures

**Solutions:**
1. **Increase timeouts**:
   ```json
   "requestTimeout": 45000,
   "refreshInterval": 180000
   ```

2. **Optimize caching**:
   ```json
   "cache": {
       "enabled": true,
       "featuresTTL": 300000,
       "enableSmartRefresh": true
   }
   ```

3. **Reduce API load**:
   - Disable unused accessories via feature flags
   - Use installation filtering
   - Increase device update delay

4. **Network optimization**:
   - Check internet connection stability
   - Consider using wired connection for Homebridge
   - Monitor network latency to Viessmann servers

### 🎛️ Accessories Not Working

**Symptoms:**
- Commands don't execute
- Switches don't respond
- Temperature changes ignored

**Solutions:**
1. **Check device capabilities**:
   - Not all devices support all features
   - Some features require specific system modes
   - Enable debug logging to see command responses

2. **Verify system state**:
   - Check heating system is in correct mode
   - Some commands require manual schedule override
   - Holiday modes may block normal operations

3. **Test individual features**:
   - Try each accessory type separately
   - Check if basic controls work before advanced features
   - Verify temperature ranges are within device limits

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

### 🎯 Optimization Strategies

1. **Start Conservative**: Begin with longer refresh intervals and adjust down
2. **Monitor Logs**: Watch for rate limiting warnings
3. **Filter Aggressively**: Only include needed installations
4. **Use Caching**: Enable with appropriate TTL values
5. **Gradual Adjustment**: Make small changes and monitor impact

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
```
src/
├── platform.ts              # Main platform with rate limiting
├── viessmann-api.ts         # API client with cache and retry logic
├── api-cache.ts             # Intelligent caching system
├── accessories/
│   ├── boiler-accessory.ts          # Boiler control and monitoring
│   ├── dhw-accessory.ts             # DHW temperature and modes
│   └── heating-circuit-accessory.ts # Circuit control with programs
├── index.ts                 # Plugin entry point
└── settings.ts              # Constants and configuration
```

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
   - Steps to reproduce the issue

### 🔍 Debug Information to Collect

When reporting issues, include:

```json
{
    "plugin_version": "2.0.0",
    "homebridge_version": "1.8.x",
    "node_version": "18.x.x",
    "heating_system": "Viessmann Model",
    "installation_count": 1,
    "gateway_count": 1,
    "device_count": 3,
    "cache_hit_rate": "85%",
    "rate_limit_status": "OK",
    "authentication_method": "auto"
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
- [ ] Plugin installed via Homebridge Config UI X
- [ ] Basic configuration completed (Client ID, username, password)
- [ ] Rate limiting protection enabled
- [ ] Caching enabled with default settings
- [ ] Authentication completed successfully
- [ ] Devices discovered and accessories created
- [ ] HomeKit testing completed
- [ ] Debug logging disabled for production use
- [ ] Performance monitoring configured

**Estimated setup time**: 15-30 minutes for new users, 5-10 minutes for experienced users.

**Need help?** Visit our [GitHub repository](https://github.com/diegoweb100/homebridge-viessmann-vicare) for support and updates.