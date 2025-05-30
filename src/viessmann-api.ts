import { Logger } from 'homebridge';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { URLSearchParams } from 'url';
import * as crypto from 'crypto';
import { ViessmannPlatformConfig, ViessmannInstallation, ViessmannFeature } from './platform';

interface AuthResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
}

export class ViessmannAPI {
  private readonly baseURL = 'https://api.viessmann.com';
  private readonly authURL = 'https://iam.viessmann.com/idp/v3';
  private readonly httpClient: AxiosInstance;
  
  private accessToken?: string;
  private refreshToken?: string;
  private tokenExpiresAt?: number;
  private codeVerifier?: string;
  private codeChallenge?: string;

  constructor(
    private readonly log: Logger,
    private readonly config: ViessmannPlatformConfig,
  ) {
    this.httpClient = axios.create({
      timeout: 30000,
      headers: {
        'User-Agent': 'homebridge-viessmann-control/1.0.0',
        'Content-Type': 'application/json',
      },
    });

    // Generate PKCE codes
    this.generatePKCECodes();
  }

  private generatePKCECodes() {
    this.codeVerifier = crypto.randomBytes(32).toString('base64url');
    this.codeChallenge = crypto.createHash('sha256').update(this.codeVerifier).digest('base64url');
  }

  async authenticate(): Promise<void> {
    try {
      if (this.isTokenValid()) {
        this.log.debug('Using existing valid token');
        return;
      }

      if (this.refreshToken) {
        this.log.debug('Attempting to refresh token');
        await this.refreshAccessToken();
        return;
      }

      this.log.debug('Performing full authentication');
      await this.performFullAuth();

    } catch (error) {
      this.log.error('Authentication failed:', error);
      throw error;
    }
  }

  private isTokenValid(): boolean {
    return !!(this.accessToken && this.tokenExpiresAt && Date.now() < this.tokenExpiresAt);
  }

  private async performFullAuth(): Promise<void> {
    try {
      // Step 1: Get authorization code
      const authCode = await this.getAuthorizationCode();
      
      // Step 2: Exchange code for tokens
      await this.exchangeCodeForTokens(authCode);

    } catch (error) {
      this.log.error('Full authentication failed:', error);
      throw error;
    }
  }

  private async getAuthorizationCode(): Promise<string> {
    // For automation purposes, we'll simulate the OAuth flow
    // In a real scenario, this would involve browser interaction
    
    const authParams = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: 'http://localhost:4200/',
      scope: 'IoT User offline_access',
      response_type: 'code',
      code_challenge_method: 'S256',
      code_challenge: this.codeChallenge!,
    });

    // This is a simplified version - in practice you'd need to handle the full OAuth flow
    // For now, we'll assume you have the authorization code from manual process
    throw new Error('Authorization code must be obtained manually. Please check documentation.');
  }

  private async exchangeCodeForTokens(authCode: string): Promise<void> {
    const tokenData = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: 'http://localhost:4200/',
      grant_type: 'authorization_code',
      code_verifier: this.codeVerifier!,
      code: authCode,
    });

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
  }

  private setTokens(authData: AuthResponse): void {
    this.accessToken = authData.access_token;
    this.refreshToken = authData.refresh_token || this.refreshToken;
    this.tokenExpiresAt = Date.now() + (authData.expires_in * 1000) - 60000; // 1 minute buffer
    
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