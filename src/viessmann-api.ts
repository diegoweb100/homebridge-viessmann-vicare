import { Logger } from 'homebridge';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { URLSearchParams } from 'url';
import * as crypto from 'crypto';
import * as http from 'http';
import { ViessmannPlatformConfig, ViessmannInstallation, ViessmannFeature } from './platform';

interface AuthResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
}

interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export class ViessmannAPI {
  private readonly baseURL = 'https://api.viessmann.com';
  private readonly authURL = 'https://iam.viessmann.com/idp/v3';
  private readonly redirectPort = 4200;
  private readonly redirectUri = `http://localhost:${this.redirectPort}/`;
  private readonly httpClient: AxiosInstance;
  
  private accessToken?: string;
  private refreshToken?: string;
  private tokenExpiresAt?: number;
  private codeVerifier?: string;
  private codeChallenge?: string;
  private authServer?: http.Server;
  
  // In-memory token storage (in a real implementation, you'd want persistent storage)
  private tokenStorage: Map<string, StoredTokens> = new Map();

  constructor(
    private readonly log: Logger,
    private readonly config: ViessmannPlatformConfig,
  ) {
    this.httpClient = axios.create({
      timeout: 30000,
      headers: {
        'User-Agent': 'homebridge-viessmann-vicare/1.0.0',
        'Content-Type': 'application/json',
      },
    });

    // Generate PKCE codes for OAuth
    this.generatePKCECodes();
    
    // Load stored tokens or use manual tokens from config
    this.initializeTokens();
  }

  private initializeTokens() {
    // Priority 1: Manual tokens from config
    if (this.config.accessToken) {
      this.log.debug('Using manual tokens from configuration');
      this.accessToken = this.config.accessToken;
      this.refreshToken = this.config.refreshToken;
      // Assume tokens are valid for now, will be validated on first API call
      this.tokenExpiresAt = Date.now() + (3600 * 1000); // 1 hour default
      return;
    }

    // Priority 2: Load stored tokens from previous OAuth flow
    this.loadStoredTokens();
  }

  private generatePKCECodes() {
    this.codeVerifier = crypto.randomBytes(32).toString('base64url');
    this.codeChallenge = crypto.createHash('sha256').update(this.codeVerifier).digest('base64url');
  }

  private loadStoredTokens() {
    const tokenKey = `${this.config.clientId}:${this.config.username}`;
    const stored = this.tokenStorage.get(tokenKey);
    
    if (stored && stored.expiresAt > Date.now()) {
      this.accessToken = stored.accessToken;
      this.refreshToken = stored.refreshToken;
      this.tokenExpiresAt = stored.expiresAt;
      this.log.debug('Loaded valid tokens from storage');
    }
  }

  private saveTokens() {
    if (this.accessToken && this.tokenExpiresAt) {
      const tokenKey = `${this.config.clientId}:${this.config.username}`;
      this.tokenStorage.set(tokenKey, {
        accessToken: this.accessToken,
        refreshToken: this.refreshToken,
        expiresAt: this.tokenExpiresAt,
      });
      this.log.debug('Saved tokens to storage');
    }
  }

  async authenticate(): Promise<void> {
    try {
      if (this.isTokenValid()) {
        this.log.debug('Using existing valid token');
        return;
      }

      if (this.refreshToken) {
        this.log.debug('Attempting to refresh token');
        try {
          await this.refreshAccessToken();
          return;
        } catch (error) {
          this.log.warn('Token refresh failed, will try to get new tokens');
          // Clear invalid tokens
          this.accessToken = undefined;
          this.refreshToken = undefined;
          this.tokenExpiresAt = undefined;
        }
      }

      // Determine authentication method
      const authMethod = this.config.authMethod || 'auto';
      
      if (authMethod === 'manual' || this.shouldUseManualAuth()) {
        await this.handleManualAuth();
      } else {
        await this.performAutoAuth();
      }

    } catch (error) {
      this.log.error('Authentication failed:', error);
      throw error;
    }
  }

  private shouldUseManualAuth(): boolean {
    // Use manual auth if:
    // 1. Explicitly configured
    // 2. Running in headless environment
    // 3. No display available
    
    if (this.config.authMethod === 'manual') {
      return true;
    }

    // Check if we're in a headless environment
    if (!process.env.DISPLAY && process.platform === 'linux') {
      this.log.debug('Detected headless Linux environment, using manual auth');
      return true;
    }

    // Check if we're in Docker
    if (process.env.DOCKER || process.env.CONTAINER) {
      this.log.debug('Detected container environment, using manual auth');
      return true;
    }

    return false;
  }

  private async performAutoAuth(): Promise<void> {
    try {
      this.log.info('Starting automatic OAuth authentication...');
      await this.performFullAuth();
    } catch (error) {
      this.log.warn('Automatic OAuth failed, falling back to manual authentication');
      this.log.warn('Error:', error instanceof Error ? error.message : String(error));
      await this.handleManualAuth();
    }
  }

  private async handleManualAuth(): Promise<void> {
    this.log.error('='.repeat(80));
    this.log.error('MANUAL AUTHENTICATION REQUIRED');
    this.log.error('='.repeat(80));
    this.log.error('Automatic OAuth authentication is not available.');
    this.log.error('Please obtain tokens manually and add them to your configuration:');
    this.log.error('');
    this.log.error('1. Visit: https://developer.viessmann.com/');
    this.log.error('2. Create an application with these settings:');
    this.log.error('   - Name: homebridge-viessmann-vicare');
    this.log.error('   - Type: Public Client');
    this.log.error('   - Redirect URI: http://localhost:4200/');
    this.log.error('   - Scope: IoT User offline_access');
    this.log.error('');
    this.log.error('3. Get authorization code using this URL:');
    
    const authUrl = this.buildAuthUrl();
    this.log.error(`   ${authUrl}`);
    this.log.error('');
    this.log.error('4. Exchange authorization code for tokens using curl:');
    this.log.error('   curl -X POST "https://iam.viessmann.com/idp/v3/token" \\');
    this.log.error('   -H "Content-Type: application/x-www-form-urlencoded" \\');
    this.log.error('   -d "client_id=YOUR_CLIENT_ID&redirect_uri=http://localhost:4200/&grant_type=authorization_code&code_verifier=YOUR_CODE_VERIFIER&code=YOUR_AUTH_CODE"');
    this.log.error('');
    this.log.error('5. Add tokens to your Homebridge configuration:');
    this.log.error('   {');
    this.log.error('     "platform": "ViessmannPlatform",');
    this.log.error('     "authMethod": "manual",');
    this.log.error('     "accessToken": "YOUR_ACCESS_TOKEN",');
    this.log.error('     "refreshToken": "YOUR_REFRESH_TOKEN",');
    this.log.error('     // ... other config');
    this.log.error('   }');
    this.log.error('');
    this.log.error('For detailed instructions, visit:');
    this.log.error('https://github.com/diegoweb100/homebridge-viessmann-vicare#manual-authentication');
    this.log.error('='.repeat(80));
    
    throw new Error('Manual authentication required - see logs for detailed instructions');
  }

  private isTokenValid(): boolean {
    return !!(this.accessToken && this.tokenExpiresAt && Date.now() < this.tokenExpiresAt);
  }

  private async performFullAuth(): Promise<void> {
    return new Promise((resolve, reject) => {
      const authUrl = this.buildAuthUrl();
      
      this.log.info('='.repeat(80));
      this.log.info('VIESSMANN OAUTH AUTHENTICATION');
      this.log.info('='.repeat(80));
      this.log.info('Please open this URL in your browser to authenticate:');
      this.log.info('');
      this.log.info(authUrl);
      this.log.info('');
      this.log.info('Waiting for authentication callback...');
      this.log.info('='.repeat(80));

      // Start local server to capture callback
      this.startAuthServer((code, error) => {
        if (error) {
          reject(error);
          return;
        }

        if (code) {
          this.exchangeCodeForTokens(code)
            .then(() => resolve())
            .catch(reject);
        }
      });

      // Auto-open browser if possible
      this.openBrowser(authUrl);
    });
  }

  private buildAuthUrl(): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.redirectUri,
      scope: 'IoT User offline_access',
      response_type: 'code',
      code_challenge_method: 'S256',
      code_challenge: this.codeChallenge!,
    });

    return `${this.authURL}/authorize?${params.toString()}`;
  }

  private startAuthServer(callback: (code?: string, error?: Error) => void) {
    this.authServer = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:${this.redirectPort}`);
      
      if (url.pathname === '/') {
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        if (error) {
          const errorDescription = url.searchParams.get('error_description') || error;
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body style="font-family: Arial; text-align: center; padding: 50px;">
                <h1 style="color: red;">Authentication Failed</h1>
                <p>${errorDescription}</p>
                <p>Please close this window and check your Homebridge logs.</p>
              </body>
            </html>
          `);
          callback(undefined, new Error(`OAuth error: ${errorDescription}`));
          this.stopAuthServer();
          return;
        }

        if (code) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body style="font-family: Arial; text-align: center; padding: 50px;">
                <h1 style="color: green;">✅ Authentication Successful!</h1>
                <p>You can now close this window.</p>
                <p>Homebridge will continue setup automatically.</p>
              </body>
            </html>
          `);
          callback(code);
          this.stopAuthServer();
          return;
        }
      }

      // Handle other requests
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
          <body style="font-family: Arial; text-align: center; padding: 50px;">
            <h1>Homebridge Viessmann Authentication</h1>
            <p>Waiting for authentication...</p>
          </body>
        </html>
      `);
    });

    this.authServer.listen(this.redirectPort, 'localhost', () => {
      this.log.debug(`Auth server listening on port ${this.redirectPort}`);
    });

    this.authServer.on('error', (error) => {
      this.log.error('Auth server error:', error);
      callback(undefined, error);
    });
  }

  private stopAuthServer() {
    if (this.authServer) {
      this.authServer.close(() => {
        this.log.debug('Auth server stopped');
      });
      this.authServer = undefined;
    }
  }

  private openBrowser(url: string) {
    const { exec } = require('child_process');
    
    try {
      let command: string;
      
      switch (process.platform) {
        case 'darwin': // macOS
          command = `open "${url}"`;
          break;
        case 'win32': // Windows
          command = `start "${url}"`;
          break;
        case 'linux': // Linux
          command = `xdg-open "${url}"`;
          break;
        default:
          this.log.warn('Cannot auto-open browser on this platform. Please open the URL manually.');
          return;
      }

      exec(command, (error: any) => {
        if (error) {
          this.log.warn('Could not auto-open browser:', error.message);
          this.log.info('Please open the authentication URL manually in your browser.');
        } else {
          this.log.info('Opening browser for authentication...');
        }
      });
    } catch (error) {
      this.log.warn('Error opening browser:', error);
    }
  }

  private async exchangeCodeForTokens(authCode: string): Promise<void> {
    const tokenData = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: this.codeVerifier!,
      code: authCode,
    });

    try {
      const response: AxiosResponse<AuthResponse> = await this.httpClient.post(
        `${this.authURL}/token`,
        tokenData,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      this.setTokens(response.data);
      this.log.info('✅ Authentication successful! Tokens acquired.');
      
    } catch (error) {
      this.log.error('Token exchange failed:', error);
      throw new Error('Failed to exchange authorization code for tokens');
    }
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.refreshToken) {
      throw new Error('No refresh token available');
    }

    const tokenData = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.config.clientId,
      refresh_token: this.refreshToken,
    });

    try {
      const response: AxiosResponse<AuthResponse> = await this.httpClient.post(
        `${this.authURL}/token`,
        tokenData,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      this.setTokens(response.data);
      this.log.debug('Token refreshed successfully');
      
    } catch (error) {
      this.log.error('Token refresh failed:', error);
      throw error;
    }
  }

  private setTokens(authData: AuthResponse): void {
    this.accessToken = authData.access_token;
    this.refreshToken = authData.refresh_token || this.refreshToken;
    this.tokenExpiresAt = Date.now() + (authData.expires_in * 1000) - 60000; // 1 minute buffer
    
    // Save tokens for persistence
    this.saveTokens();
    
    this.log.debug('Tokens updated successfully');
  }

  async getInstallations(): Promise<ViessmannInstallation[]> {
    await this.authenticate();

    try {
      const response = await this.httpClient.get(
        `${this.baseURL}/iot/v2/equipment/installations?includeGateways=true`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
          },
        }
      );

      const installations: ViessmannInstallation[] = response.data.data.map((installation: any) => {
        // Get gateways for this installation
        const gateways = installation.gateways || [];
        
        return {
          id: installation.id,
          description: installation.description || `Installation ${installation.id}`,
          gateways: gateways.map((gateway: any) => ({
            serial: gateway.serial,
            devices: [], // Will be populated by getGatewayDevices
          })),
        };
      });

      // Get devices for each gateway
      for (const installation of installations) {
        for (const gateway of installation.gateways) {
          gateway.devices = await this.getGatewayDevices(installation.id, gateway.serial);
        }
      }

      return installations;

    } catch (error) {
      this.log.error('Failed to get installations:', error);
      throw error;
    }
  }

  async getGatewayDevices(installationId: number, gatewaySerial: string) {
    await this.authenticate();

    try {
      const response = await this.httpClient.get(
        `${this.baseURL}/iot/v2/equipment/installations/${installationId}/gateways/${gatewaySerial}/devices`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
          },
        }
      );

      return response.data.data.map((device: any) => ({
        id: device.id,
        deviceType: device.deviceType,
        modelId: device.modelId,
        status: device.status,
        gatewaySerial: device.gatewaySerial,
      }));

    } catch (error) {
      this.log.error(`Failed to get devices for gateway ${gatewaySerial}:`, error);
      throw error;
    }
  }

  async getDeviceFeatures(installationId: number, gatewaySerial: string, deviceId: string): Promise<ViessmannFeature[]> {
    await this.authenticate();

    try {
      const response = await this.httpClient.get(
        `${this.baseURL}/iot/v2/features/installations/${installationId}/gateways/${gatewaySerial}/devices/${deviceId}/features`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
          },
        }
      );

      // The response.data should be a JSON string that needs parsing
      let featuresData;
      if (typeof response.data === 'string') {
        featuresData = JSON.parse(response.data);
      } else {
        featuresData = response.data;
      }

      // Convert the features object to array
      const features: ViessmannFeature[] = [];
      
      if (featuresData.data && Array.isArray(featuresData.data)) {
        features.push(...featuresData.data);
      } else if (typeof featuresData === 'object') {
        // Handle case where features are returned as object properties
        for (const [featureName, featureData] of Object.entries(featuresData)) {
          if (typeof featureData === 'object' && featureData !== null) {
            features.push({
              feature: featureName,
              properties: (featureData as any).properties || {},
              commands: (featureData as any).commands || {},
              isEnabled: (featureData as any).isEnabled || true,
              isReady: (featureData as any).isReady || true,
              timestamp: (featureData as any).timestamp || new Date().toISOString(),
            });
          }
        }
      }

      return features;

    } catch (error) {
      this.log.error(`Failed to get features for device ${deviceId}:`, error);
      throw error;
    }
  }

  async getFeature(installationId: number, gatewaySerial: string, deviceId: string, featureName: string): Promise<ViessmannFeature | null> {
    await this.authenticate();

    try {
      const response = await this.httpClient.get(
        `${this.baseURL}/iot/v2/features/installations/${installationId}/gateways/${gatewaySerial}/devices/${deviceId}/features/${featureName}`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
          },
        }
      );

      let featureData;
      if (typeof response.data === 'string') {
        featureData = JSON.parse(response.data);
      } else {
        featureData = response.data;
      }

      if (featureData.data) {
        return {
          feature: featureName,
          properties: featureData.data.properties || {},
          commands: featureData.data.commands || {},
          isEnabled: featureData.data.isEnabled || true,
          isReady: featureData.data.isReady || true,
          timestamp: featureData.data.timestamp || new Date().toISOString(),
        };
      }

      return null;

    } catch (error) {
      this.log.error(`Failed to get feature ${featureName}:`, error);
      return null;
    }
  }

  async executeCommand(
    installationId: number,
    gatewaySerial: string,
    deviceId: string,
    featureName: string,
    commandName: string,
    params: any = {}
  ): Promise<boolean> {
    await this.authenticate();

    try {
      const response = await this.httpClient.post(
        `${this.baseURL}/iot/v2/features/installations/${installationId}/gateways/${gatewaySerial}/devices/${deviceId}/features/${featureName}/commands/${commandName}`,
        params,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      return response.status === 200 && response.data?.data?.success === true;

    } catch (error) {
      this.log.error(`Failed to execute command ${commandName} on feature ${featureName}:`, error);
      return false;
    }
  }

  async setDHWTemperature(installationId: number, gatewaySerial: string, deviceId: string, temperature: number): Promise<boolean> {
    return this.executeCommand(
      installationId,
      gatewaySerial,
      deviceId,
      'heating.dhw.temperature.main',
      'setTargetTemperature',
      { temperature }
    );
  }

  async setHeatingCircuitTemperature(
    installationId: number,
    gatewaySerial: string,
    deviceId: string,
    circuitNumber: number,
    temperature: number
  ): Promise<boolean> {
    return this.executeCommand(
      installationId,
      gatewaySerial,
      deviceId,
      `heating.circuits.${circuitNumber}.heating.curve`,
      'setCurve',
      { temperature }
    );
  }

  async setOperatingMode(
    installationId: number,
    gatewaySerial: string,
    deviceId: string,
    circuitNumber: number,
    mode: string
  ): Promise<boolean> {
    return this.executeCommand(
      installationId,
      gatewaySerial,
      deviceId,
      `heating.circuits.${circuitNumber}.operating.modes.active`,
      'setMode',
      { mode }
    );
  }
}