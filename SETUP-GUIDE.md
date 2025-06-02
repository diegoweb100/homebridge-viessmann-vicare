# Complete Setup Guide

## Prerequisites

### 1. ViCare Account
- Create an account on [ViCare](https://www.vicare.com/)
- Register your Viessmann heating system in the ViCare app
- Verify that your system is online and functioning

### 2. Viessmann API Credentials
To obtain API credentials:

1. **Visit the Developer Portal**:
   - Go to https://developer.viessmann.com/
   - Register for a developer account

2. **Create an application**:
   - Name: `homebridge-viessmann-vicare`
   - Type: `Public Client` (for home use)
   - Redirect URI: `http://localhost:4200/`
   - Scope: `IoT User offline_access`

3. **Get your Client ID**:
   - Save the generated Client ID
   - Client Secret is not required for public clients

## Step-by-Step Installation

### 1. Install the plugin

```bash
# Via Homebridge Config UI X (recommended)
# Search for "homebridge-viessmann-vicare" in the Plugin tab

# Or via npm
sudo npm install -g homebridge-viessmann-vicare
```

### 2. Configure the plugin

Add configuration to your Homebridge `config.json` file:

```json
{
    "platform": "ViessmannPlatform",
    "name": "Viessmann",
    "clientId": "YOUR_CLIENT_ID",
    "username": "your-email@example.com",
    "password": "your-password",
    "refreshInterval": 120000,
    "enableRateLimitProtection": true,
    "debug": true
}
```

### 3. First OAuth Setup

⚠️ **Important**: The first setup requires manual OAuth configuration or automatic browser authentication.

#### Automatic OAuth (Recommended)

1. **Start Homebridge** with the configuration above
2. **Check the logs** for an authentication URL
3. **Open the URL** in your browser (may open automatically)
4. **Login with ViCare credentials**
5. **Authorize the application**
6. **Tokens are saved automatically** for future use

#### Manual OAuth (Advanced)

If automatic OAuth fails:

1. **Generate PKCE codes**:
   Use this online tool: https://tonyxu-io.github.io/pkce-generator/
   - Save the `Code Verifier` and `Code Challenge`

2. **Get Authorization Code**:
   ```
   https://iam.viessmann.com/idp/v3/authorize?
   client_id=YOUR_CLIENT_ID&
   redirect_uri=http://localhost:4200/&
   scope=IoT%20User%20offline_access&
   response_type=code&
   code_challenge_method=S256&
   code_challenge=YOUR_CODE_CHALLENGE
   ```

3. **Login and authorize**:
   - Open the link in browser
   - Login with ViCare credentials
   - Authorize the application
   - Copy the `code` from the redirect URL

4. **Exchange code for tokens**:
   ```bash
   curl -X POST "https://iam.viessmann.com/idp/v3/token" \
   -H "Content-Type: application/x-www-form-urlencoded" \
   -d "client_id=YOUR_CLIENT_ID&redirect_uri=http://localhost:4200/&grant_type=authorization_code&code_verifier=YOUR_CODE_VERIFIER&code=OBTAINED_CODE"
   ```

5. **Add tokens to config**:
   ```json
   {
       "authMethod": "manual",
       "accessToken": "obtained_access_token",
       "refreshToken": "obtained_refresh_token"
   }
   ```

### 4. Restart Homebridge

```bash
# If using systemd
sudo systemctl restart homebridge

# If using pm2
pm2 restart homebridge

# If using Docker
docker restart homebridge
```

## Advanced Configuration

### Rate Limiting Protection

The plugin includes advanced rate limiting protection to handle Viessmann API limits:

```json
{
    "platform": "ViessmannPlatform",
    "name": "Viessmann",
    "clientId": "client_id",
    "username": "email",
    "password": "password",
    
    // Update interval (minimum 60 seconds, recommended 120+ seconds)
    "refreshInterval": 120000,
    
    // Enable rate limit protection (recommended)
    "enableRateLimitProtection": true,
    
    // Maximum retry attempts
    "maxRetries": 3,
    
    // Base delay between retries (will be multiplied by backoff)
    "retryDelay": 60000,
    
    // Debug logging
    "debug": true
}
```

### Installation Filtering

Reduce API calls by filtering installations:

```json
{
    // Show only installations containing "Main House" in the name
    "installationFilter": "Main House",
    
    // Or specify exact installation IDs
    "installationIds": [2045780, 1234567]
}
```

### Configuration Examples by Use Case

#### Single Installation (Low API Usage)
```json
{
    "platform": "ViessmannPlatform",
    "name": "Viessmann",
    "clientId": "your_client_id",
    "username": "your_email",
    "password": "your_password",
    "refreshInterval": 60000,
    "enableRateLimitProtection": true
}
```

#### Multiple Installations (High API Usage)
```json
{
    "platform": "ViessmannPlatform",
    "name": "Viessmann",
    "clientId": "your_client_id",
    "username": "your_email",
    "password": "your_password",
    "refreshInterval": 300000,
    "enableRateLimitProtection": true,
    "installationFilter": "Main",
    "maxRetries": 5,
    "retryDelay": 120000
}
```

#### Recovery from Rate Limiting
```json
{
    "platform": "ViessmannPlatform",
    "name": "Viessmann",
    "clientId": "your_client_id",
    "username": "your_email",
    "password": "your_password",
    "refreshInterval": 600000,
    "enableRateLimitProtection": true,
    "maxRetries": 1,
    "retryDelay": 300000,
    "debug": true
}
```

## Accessory Customization

The plugin automatically creates accessories based on detected devices:

### Boiler Accessories
- **Main Control**: HeaterCooler service for temperature and mode control
- **Burner Status**: Switch showing burner active/inactive state
- **Modulation**: Lightbulb showing current burner modulation (0-100%)

### DHW (Hot Water) Accessories
- **Main Control**: HeaterCooler service for DHW temperature
- **Mode Switches**: Separate switches for Off/Eco/Comfort modes

### Heating Circuit Accessories
- **Main Control**: HeaterCooler service for circuit temperature
- **Temperature Programs**:
  - Reduced (Ridotta) - Switch for economy mode
  - Normal (Normale) - Switch for standard comfort
  - Comfort - Switch for maximum comfort
- **Quick Selections**:
  - Holiday Mode - Switch for 7-day holiday schedule
  - Holiday at Home - Switch for single-day reduced heating
  - Extended Heating - Switch for temporary comfort boost

## Configuration Verification

### 1. Check the logs
```bash
# Standard Homebridge
tail -f ~/.homebridge/homebridge.log

# Systemd
journalctl -u homebridge -f

# Docker
docker logs -f homebridge
```

### 2. Rate Limit Status
Look for these log messages:
- `Rate limit status: OK` - Normal operation
- `Rate limited: wait X seconds` - Temporary throttling
- `Rate limit protection activated` - Automatic backoff engaged

### 3. API Test
```bash
# Test connection to installations
curl -H "Authorization: Bearer TOKEN" \
"https://api.viessmann.com/iot/v2/equipment/installations"
```

### 4. HomeKit Verification
- Open the Home app on iOS/macOS
- Check that Viessmann accessories are visible
- Test temperature commands
- Verify mode switches work correctly

## Common Issues & Solutions

### Rate Limiting (429 Errors)

**Symptoms:**
- `Rate limit exceeded` in logs
- Accessories not updating
- `Too Many Requests` errors

**Solutions:**
1. ✅ **Increase refresh interval**: Set to 180000ms (3 minutes) or higher
2. ✅ **Enable rate limit protection**: Ensure `enableRateLimitProtection: true`
3. ✅ **Use installation filtering**: Filter to only needed installations
4. ✅ **Close ViCare app**: Temporarily close mobile app
5. ✅ **Wait for reset**: API limits reset after 24 hours

### Authentication Errors

**Error**: "Authentication failed"
- ✅ Verify ViCare credentials
- ✅ Check device is registered in ViCare
- ✅ Verify Client ID is correct
- ✅ Try manual authentication method

### No Installations Found

**Error**: "No installations found"
- ✅ Verify heating system is online in ViCare
- ✅ Check account has access to devices
- ✅ Enable debug logging for details
- ✅ Check installation filtering settings

### Commands Not Working

**Issue**: Controls don't respond
- ✅ Some devices have limited command support
- ✅ Verify supported operating modes
- ✅ Check current device state allows commands
- ✅ Review debug logs for specific errors

### Extended Heating Not Available

**Issue**: Extended heating switch doesn't work
- ✅ Feature may require specific system modes
- ✅ Check if holiday modes are active (conflicting)
- ✅ Verify comfort program is available
- ✅ Some systems require manual schedule override

## Performance Optimization

### Recommended Settings

**For minimal API usage:**
```json
{
    "refreshInterval": 300000,              // 5 minutes
    "enableRateLimitProtection": true,
    "installationFilter": "specific_name"   // Filter to one installation
}
```

**For multiple installations:**
```json
{
    "refreshInterval": 180000,     // 3 minutes
    "enableRateLimitProtection": true,
    "installationIds": [12345]    // Specify only needed installations
}
```

### Monitoring Performance

Enable debug logging to monitor:
- Rate limit status
- API call success/failure rates
- Retry attempts and backoff multipliers
- Installation filtering effectiveness

## Plugin Structure

```
homebridge-viessmann-vicare/
├── src/
│   ├── platform.ts                     # Main platform with rate limiting
│   ├── viessmann-api.ts                 # API client with retry logic
│   ├── accessories/
│   │   ├── boiler-accessory.ts          # Boiler accessory
│   │   ├── dhw-accessory.ts             # DHW accessory
│   │   └── heating-circuit-accessory.ts # Heating circuits with programs
│   ├── index.ts                         # Entry point
│   └── settings.ts                      # Constants
├── config.schema.json                   # Configuration schema
├── package.json
└── README.md
```

## Support

For specific issues:

1. **Enable debug logging**
2. **Collect complete logs**
3. **Create GitHub issue** with:
   - Configuration (without passwords)
   - Complete logs
   - Heating system model
   - Plugin version
   - Rate limit status

## Updates

The plugin supports automatic updates:

```bash
# Check for updates
npm outdated -g homebridge-viessmann-vicare

# Update
npm update -g homebridge-viessmann-vicare
```

Always restart Homebridge after updates.

## Best Practices

### Rate Limit Management
1. **Start conservative**: Use 180000ms (3 minutes) refresh interval
2. **Monitor logs**: Watch for rate limiting warnings
3. **Filter installations**: Only include needed systems
4. **Gradual adjustment**: Slowly decrease intervals if stable

### Security
1. **Protect credentials**: Never share Client ID or tokens
2. **Regular updates**: Keep plugin updated for security fixes
3. **Monitor access**: Review ViCare app for unauthorized access

### Reliability
1. **Enable protection**: Always use `enableRateLimitProtection: true`
2. **Monitor status**: Check logs for rate limit warnings
3. **Plan for limits**: Design automations considering API constraints
4. **Have backups**: Keep manual control methods available

## Advanced Features

### Temperature Program Management
- Each heating circuit supports three independent temperature programs
- Programs maintain individual temperature settings
- Switching between programs updates the main thermostat target
- Programs are mutually exclusive (only one active at a time)

### Holiday Mode Integration
- Holiday modes automatically disable conflicting programs
- Extended heating provides temporary comfort override
- Holiday at Home offers single-day reduced heating
- All modes integrate with existing schedules

### Installation Filtering Benefits
- Reduces API calls by 50-90% for multi-installation accounts
- Improves response times
- Extends API quota usage
- Simplifies HomeKit interface