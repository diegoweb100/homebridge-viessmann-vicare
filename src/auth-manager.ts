import { Logger } from 'homebridge';
import { AxiosInstance, AxiosResponse } from 'axios';
import * as crypto from 'crypto';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { URLSearchParams } from 'url';

export interface AuthConfig {
  clientId: string;
  clientSecret?: string;
  username: string;
  password: string;
  authMethod?: 'auto' | 'manual';
  hostIp?: string;
  redirectPort?: number;
  accessToken?: string;
  refreshToken?: string;
  tokenRefreshBuffer?: number;
  authTimeout?: number;
  enableTokenPersistence?: boolean;
}

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
  issuedAt: number;
  scope: string;
  refreshTokenExpiresAt?: number;
}

export class AuthManager {
  private readonly authURL = 'https://iam.viessmann-climatesolutions.com/idp/v3';
  private readonly redirectUri: string;
  private readonly tokenStoragePath: string;
  
  // TTL Constants from Viessmann API documentation
  private readonly AUTHORIZATION_CODE_TTL = 20000; // 20 seconds - CRITICAL!
  private readonly REFRESH_TOKEN_TTL = 15552000000; // 180 days in ms
  private readonly ACCESS_TOKEN_DEFAULT_TTL = 3600000; // 1 hour in ms
  
  private accessToken?: string;
  private refreshToken?: string;
  private tokenExpiresAt?: number;
  private tokenIssuedAt?: number;
  private tokenScope?: string;
  private refreshTokenExpiresAt?: number;
  private codeVerifier?: string;
  private codeChallenge?: string;
  private authServer?: http.Server;
  private authTimeout?: NodeJS.Timeout;
  private tokenRefreshTimer?: NodeJS.Timeout;

  constructor(
    private readonly log: Logger,
    private readonly config: AuthConfig,
    private readonly httpClient: AxiosInstance,
    private readonly hostIp: string
  ) {
    this.redirectUri = `http://${this.hostIp}:${this.config.redirectPort || 4200}/`;
    this.tokenStoragePath = path.join(process.cwd(), '.homebridge', 'viessmann-tokens.json');
    
    this.log.debug(`Using redirect URI: ${this.redirectUri}`);
    this.log.debug(`Token storage path: ${this.tokenStoragePath}`);
    
    this.validateAuthConfiguration();
    this.generatePKCECodes();
    this.initializeTokens();
  }

  private validateAuthConfiguration(): void {
    const errors: string[] = [];
    
    if (!this.config.clientId?.match(/^[a-zA-Z0-9_-]+$/)) {
      errors.push('Invalid Client ID format - must contain only alphanumeric characters, underscores, and hyphens');
    }
    
    if (!this.config.username?.includes('@')) {
      errors.push('Username must be a valid email address');
    }
    
    if (this.config.authMethod === 'manual') {
      if (!this.config.accessToken) errors.push('Access token required for manual auth method');
      if (!this.config.refreshToken) errors.push('Refresh token required for manual auth method');
    }
    
    const redirectPort = this.config.redirectPort || 4200;
    if (redirectPort < 1024 || redirectPort > 65535) {
      errors.push('Invalid redirect port (must be between 1024-65535)');
    }
    
    const tokenRefreshBuffer = this.config.tokenRefreshBuffer || 300000;
    if (tokenRefreshBuffer < 60000 || tokenRefreshBuffer > 1800000) {
      errors.push('Token refresh buffer must be between 1-30 minutes');
    }
    
    if (errors.length > 0) {
      throw new Error(`Configuration validation failed: ${errors.join('; ')}`);
    }
    
    this.log.debug('✅ Authentication configuration validated successfully');
  }

  private generatePKCECodes(): void {
    // Generate code verifier with proper length according to RFC 7636
    // The code verifier must be 43-128 characters long
    // Using 96 bytes of random data results in 128 characters when base64url encoded
    // (96 bytes * 4/3 = 128 characters)
    this.codeVerifier = crypto.randomBytes(96).toString('base64url');
    
    // Verify the length is within RFC 7636 limits
    if (this.codeVerifier.length < 43 || this.codeVerifier.length > 128) {
      this.log.error(`Generated code verifier length ${this.codeVerifier.length} is outside RFC 7636 limits (43-128 characters)`);
      // Fallback: generate exactly 43 characters
      this.codeVerifier = crypto.randomBytes(32).toString('base64url').substring(0, 43);
    }
    
    // Generate code challenge (SHA256 hash of code verifier, base64url encoded)
    this.codeChallenge = crypto.createHash('sha256').update(this.codeVerifier).digest('base64url');
    
    this.log.debug(`🔐 Generated PKCE codes - verifier length: ${this.codeVerifier.length}, challenge length: ${this.codeChallenge.length}`);
  }

  private initializeTokens(): void {
    // Priority 1: Manual tokens from config
    if (this.config.accessToken) {
      this.log.debug('🔑 Using manual tokens from configuration');
      this.accessToken = this.config.accessToken;
      this.refreshToken = this.config.refreshToken;
      // Assume tokens are valid for now, will be validated on first API call
      this.tokenExpiresAt = Date.now() + this.ACCESS_TOKEN_DEFAULT_TTL;
      this.tokenScope = 'IoT User offline_access';
      this.scheduleTokenRefresh();
      return;
    }

    // Priority 2: Load stored tokens from previous OAuth flow
    this.loadStoredTokens();
  }

  private loadStoredTokens(): void {
    try {
      if (!this.config.enableTokenPersistence && this.config.enableTokenPersistence !== undefined) {
        this.log.debug('Token persistence disabled, skipping load');
        return;
      }

      if (fs.existsSync(this.tokenStoragePath)) {
        const tokenData = JSON.parse(fs.readFileSync(this.tokenStoragePath, 'utf8'));
        const stored = tokenData[`${this.config.clientId}:${this.config.username}`];
        
        if (stored && stored.expiresAt > Date.now()) {
          this.accessToken = stored.accessToken;
          this.refreshToken = stored.refreshToken;
          this.tokenExpiresAt = stored.expiresAt;
          this.tokenIssuedAt = stored.issuedAt;
          this.tokenScope = stored.scope || 'IoT User offline_access';
          this.refreshTokenExpiresAt = stored.refreshTokenExpiresAt;
          
          const validFor = Math.round((stored.expiresAt - Date.now()) / 1000);
          this.log.debug(`🔑 Loaded valid tokens from persistent storage (valid for ${validFor} seconds)`);
          
          // Check refresh token expiry
          if (this.refreshTokenExpiresAt && this.refreshTokenExpiresAt < Date.now()) {
            this.log.warn('⚠️ Refresh token has expired, will need full re-authentication');
            this.clearStoredTokens();
            return;
          }
          
          // Schedule proactive refresh
          this.scheduleTokenRefresh();
        } else if (stored) {
          this.log.debug('🔑 Stored tokens have expired, will need to re-authenticate');
          this.clearStoredTokens();
        }
      }
    } catch (error) {
      this.log.warn('⚠️ Failed to load stored tokens:', error);
      this.clearStoredTokens();
    }
  }

  private saveTokens(): void {
    if (!this.config.enableTokenPersistence && this.config.enableTokenPersistence !== undefined) {
      this.log.debug('Token persistence disabled, skipping save');
      return;
    }

    if (this.accessToken && this.tokenExpiresAt) {
      try {
        // Ensure directory exists
        const dir = path.dirname(this.tokenStoragePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        // Load existing token data or create new
        let tokenData: any = {};
        if (fs.existsSync(this.tokenStoragePath)) {
          try {
            tokenData = JSON.parse(fs.readFileSync(this.tokenStoragePath, 'utf8'));
          } catch (error) {
            this.log.warn('⚠️ Failed to parse existing token file, creating new one');
            tokenData = {};
          }
        }

        // Calculate refresh token expiry if not set
        if (!this.refreshTokenExpiresAt && this.tokenIssuedAt) {
          this.refreshTokenExpiresAt = this.tokenIssuedAt + this.REFRESH_TOKEN_TTL;
        }

        // Save tokens with user/client key
        const tokenKey = `${this.config.clientId}:${this.config.username}`;
        tokenData[tokenKey] = {
          accessToken: this.accessToken,
          refreshToken: this.refreshToken,
          expiresAt: this.tokenExpiresAt,
          issuedAt: this.tokenIssuedAt || Date.now(),
          scope: this.tokenScope || 'IoT User offline_access',
          refreshTokenExpiresAt: this.refreshTokenExpiresAt
        };

        // Write to file with proper permissions
        fs.writeFileSync(this.tokenStoragePath, JSON.stringify(tokenData, null, 2), { mode: 0o600 });
        this.log.debug('💾 Saved tokens to persistent storage');
      } catch (error) {
        this.log.warn('⚠️ Failed to save tokens to persistent storage:', error);
      }
    }
  }

  private clearStoredTokens(): void {
    try {
      if (fs.existsSync(this.tokenStoragePath)) {
        const tokenData = JSON.parse(fs.readFileSync(this.tokenStoragePath, 'utf8'));
        const tokenKey = `${this.config.clientId}:${this.config.username}`;
        
        if (tokenData[tokenKey]) {
          delete tokenData[tokenKey];
          fs.writeFileSync(this.tokenStoragePath, JSON.stringify(tokenData, null, 2), { mode: 0o600 });
          this.log.debug('🗑️ Cleared expired tokens from persistent storage');
        }
      }
    } catch (error) {
      this.log.warn('⚠️ Failed to clear stored tokens:', error);
    }
    
    // Clear in-memory tokens
    this.accessToken = undefined;
    this.refreshToken = undefined;
    this.tokenExpiresAt = undefined;
    this.tokenIssuedAt = undefined;
    this.refreshTokenExpiresAt = undefined;
    
    // Clear refresh timer
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = undefined;
    }
  }

  private scheduleTokenRefresh(): void {
    if (!this.tokenExpiresAt || !this.refreshToken) {
      this.log.debug('⏰ Cannot schedule token refresh - missing tokens or expiry');
      return;
    }
    
    // Clear existing timer
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
    }
    
    const refreshTime = this.tokenExpiresAt - (this.config.tokenRefreshBuffer || 300000) - Date.now();
    
    if (refreshTime > 0) {
      this.tokenRefreshTimer = setTimeout(async () => {
        try {
          this.log.info('🔄 Performing proactive token refresh...');
          await this.refreshAccessToken();
          this.scheduleTokenRefresh(); // Schedule next refresh
        } catch (error) {
          this.log.error('❌ Proactive token refresh failed:', error);
          // Don't clear tokens yet, let normal auth flow handle it
        }
      }, refreshTime);
      
      const refreshInMinutes = Math.ceil(refreshTime / 60000);
      this.log.debug(`⏰ Token refresh scheduled in ${refreshInMinutes} minutes`);
    } else {
      this.log.warn('⚠️ Token expires soon, immediate refresh needed');
    }
  }

  public async authenticate(): Promise<void> {
    try {
    this.logEnvDiagnostics();
      if (this.isTokenValid()) {
        this.log.debug('✅ Using existing valid token');
        return;
      }

      if (this.refreshToken) {
        this.log.debug('🔄 Attempting to refresh token');
        try {
          await this.refreshAccessToken();
          return;
        } catch (error) {
          this.log.warn('⚠️ Token refresh failed, will try to get new tokens');
          this.clearStoredTokens();
        }
      }

      // Determine authentication method
      const authMethod = this.config.authMethod || 'auto';
      
      /**
      if (authMethod === 'manual' || this.shouldUseManualAuth()) {
        await this.handleManualAuth();
      } else {
        await this.performAutoAuth();
      }
      **/
		if (authMethod === 'manual') {
		  await this.handleManualAuth();
		  return;
		}
		
		// Prova sempre l'auto-auth; se fallisce, fallback a manual
		try {
		  await this.performAutoAuth();   // avvia server di callback + openBrowser()
		} catch (e) {
		  this.log.warn(
			'⚠️ Auto auth failed, falling back to manual:',
			e instanceof Error ? e.message : String(e)
		  );
		  await this.handleManualAuth();
		}      

    } catch (error) {
      this.log.error('❌ Authentication failed:', error);
      throw error;
    }
  }
/**
  private shouldUseManualAuth(): boolean {
    if (this.config.authMethod === 'manual') {
      return true;
    }

    // Check if we're in a headless environment
    if (!process.env.DISPLAY && process.platform === 'linux') {
      this.log.debug('🖥️ Detected headless Linux environment, using manual auth');
      return true;
    }

    // Check if we're in Docker
    if (process.env.DOCKER || process.env.CONTAINER) {
      this.log.debug('🐳 Detected container environment, using manual auth');
      return true;
    }

    // Check if we're running as a service (systemd)
    if (process.env.SYSTEMD_EXEC_PID || process.env.INVOCATION_ID) {
      this.log.debug('⚙️ Detected systemd service environment, using manual auth');
      return true;
    }

    return false;
  }
**/
private shouldUseManualAuth(): boolean {
  // Rispetta la scelta esplicita dell’utente
  if (this.config.authMethod === 'manual') {
    this.log.debug('🔧 Auth method explicitly set to "manual" in config.');
    return true;
  }

  // Diagnostica non-bloccante: non forziamo più il manual in headless/systemd/container
  const isHeadlessLinux = (process.platform === 'linux' && !process.env.DISPLAY);
  const isContainer = !!(process.env.DOCKER || process.env.CONTAINER);
  const isSystemd = !!(process.env.SYSTEMD_EXEC_PID || process.env.INVOCATION_ID);

  if (isHeadlessLinux || isContainer || isSystemd) {
    this.log.debug(
      `ℹ️ Environment detected (headlessLinux=${isHeadlessLinux}, container=${isContainer}, systemd=${isSystemd}) — ` +
      'proceeding with AUTO auth first; will fallback to MANUAL if AUTO fails.'
    );
  }

  // Di default tentiamo sempre AUTO
  return false;
}

  private async performAutoAuth(): Promise<void> {
    try {
      this.log.info('🚀 Starting automatic OAuth authentication...');
      await this.performFullAuth();
    } catch (error) {
      this.log.warn('⚠️ Automatic OAuth failed, falling back to manual authentication');
      this.log.warn('Error:', error instanceof Error ? error.message : String(error));
      await this.handleManualAuth();
    }
  }

  private async handleManualAuth(): Promise<void> {
    this.log.error('='.repeat(80));
    this.log.error('🔧 MANUAL AUTHENTICATION REQUIRED');
    this.log.error('='.repeat(80));
    this.log.error('⚠️ CRITICAL: Authorization codes expire in 20 seconds!');
    this.log.error('');
    this.log.error('📋 Follow these steps:');
    this.log.error('');
    this.log.error('1. 🌐 Visit: https://developer.viessmann-climatesolutions.com/');
    this.log.error('2. 📝 Create an application with these settings:');
    this.log.error('   • Name: homebridge-viessmann-vicare');
    this.log.error('   • Type: Public Client');
    this.log.error(`   • Redirect URI: ${this.redirectUri}`);
    this.log.error('   • Scope: IoT User offline_access');
    this.log.error('');
    this.log.error('3. 🔗 Get authorization code using this URL:');
    
    const authUrl = this.buildAuthUrl();
    this.log.error(`   ${authUrl}`);
    this.log.error('');
    this.log.error('4. ⚡ QUICKLY exchange authorization code for tokens (20 second limit!):');
    this.log.error('   curl -X POST "https://iam.viessmann-climatesolutions.com/idp/v3/token" \\');
    this.log.error('   -H "Content-Type: application/x-www-form-urlencoded" \\');
    this.log.error(`   -d "client_id=${this.config.clientId}&redirect_uri=${encodeURIComponent(this.redirectUri)}&grant_type=authorization_code&code_verifier=${this.codeVerifier}&code=YOUR_AUTH_CODE"`);
    this.log.error('');
    this.log.error('5. 💾 Add tokens to your Homebridge configuration:');
    this.log.error('   {');
    this.log.error('     "platform": "ViessmannPlatform",');
    this.log.error('     "authMethod": "manual",');
    this.log.error('     "accessToken": "YOUR_ACCESS_TOKEN",');
    this.log.error('     "refreshToken": "YOUR_REFRESH_TOKEN",');
    this.log.error('     // ... other config');
    this.log.error('   }');
    this.log.error('');
    this.log.error('📖 For detailed instructions, visit:');
    this.log.error('https://github.com/diegoweb100/homebridge-viessmann-vicare#manual-authentication');
    this.log.error('='.repeat(80));
    
    throw new Error('Manual authentication required - see logs for detailed instructions');
  }

  private isTokenValid(): boolean {
    if (!this.accessToken || !this.tokenExpiresAt) {
      return false;
    }
    
    // Use configured refresh buffer
    const tokenRefreshBuffer = this.config.tokenRefreshBuffer || 300000;
    return Date.now() < (this.tokenExpiresAt - tokenRefreshBuffer);
  }

  private async performFullAuth(): Promise<void> {
    return new Promise((resolve, reject) => {
      const authUrl = this.buildAuthUrl();
      
      this.log.info('='.repeat(80));
      this.log.info('🔐 VIESSMANN OAUTH AUTHENTICATION');
      this.log.info('='.repeat(80));
      this.log.info('⚠️ CRITICAL: You have only 20 seconds after browser authorization!');
      this.log.info('');
      this.log.info('🔗 Please open this URL in your browser to authenticate:');
      this.log.info('');
      this.log.info(authUrl);
      this.log.info('');
      this.log.info('⏳ Waiting for authentication callback...');
      const authTimeout = this.config.authTimeout || 300000;
      this.log.info(`⏰ This process will timeout after ${authTimeout / 1000} seconds.`);
      this.log.info('='.repeat(80));

      // Set timeout for authentication process
      this.authTimeout = setTimeout(() => {
        this.stopAuthServer();
        reject(new Error(`Authentication timeout - no response received within ${authTimeout / 1000} seconds`));
      }, authTimeout);

      // Start local server to capture callback
      this.startAuthServer((code, error) => {
        if (this.authTimeout) {
          clearTimeout(this.authTimeout);
          this.authTimeout = undefined;
        }

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

  private startAuthServer(callback: (code?: string, error?: Error) => void): void {
    this.authServer = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:${this.config.redirectPort || 4200}`);
        this.log.warn(`🟢 Auth server listening on http://${this.hostIp}:${this.config.redirectPort || 4200}/`);
  		this.log.warn(`👉 If the browser does not open automatically, open this URL manually from another device:\nhttp://${this.hostIp}:${this.config.redirectPort || 4200}/login`);

      if (url.pathname === '/') {
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        if (error) {
          const errorDescription = url.searchParams.get('error_description') || error;
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <html>
              <head><title>Authentication Failed</title></head>
              <body style="font-family: -apple-system, sans-serif; text-align: center; padding: 50px;">
                <h1 style="color: #ff4757;">❌ Authentication Failed</h1>
                <p>${errorDescription}</p>
                <p>Please close this window and check your Homebridge logs.</p>
              </body>
            </html>
          `);
          callback(undefined, new Error(`OAuth error: ${errorDescription}`));
          //this.stopAuthServer();
          return;
        }

        if (code) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <html>
              <head><title>Authentication Successful</title></head>
              <body style="font-family: -apple-system, sans-serif; text-align: center; padding: 50px;">
                <h1 style="color: #2ed573;">✅ Authentication Successful!</h1>
                <p>You can now close this window.</p>
                <p>Homebridge will continue setup automatically.</p>
              </body>
            </html>
          `);
          callback(code);
          //this.stopAuthServer();
          return;
        }
      }

      // Handle other requests
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    });

    this.authServer.listen(this.config.redirectPort || 4200, '0.0.0.0', () => {
      this.log.debug(`🌐 Auth server listening on ${this.hostIp}:${this.config.redirectPort || 4200}`);
    });

    this.authServer.on('error', (error) => {
      this.log.error('❌ Auth server error:', error);
      callback(undefined, error);
    });
  }

  private stopAuthServer(): void {
    if (this.authServer) {
      this.authServer.close(() => {
        this.log.debug('🔌 Auth server stopped');
      });
      this.authServer = undefined;
    }
    
    if (this.authTimeout) {
      clearTimeout(this.authTimeout);
      this.authTimeout = undefined;
    }
  }

 /** private openBrowser(url: string): void {
    const { exec } = require('child_process');
    
    try {
      let command: string;
      
      switch (process.platform) {
        case 'darwin': // macOS
          command = `open "${url}"`;
          break;
        case 'win32': // Windows
          command = `start "" "${url}"`;
          break;
        case 'linux': // Linux
          command = `xdg-open "${url}" || firefox "${url}" || google-chrome "${url}" || chromium "${url}"`;
          break;
        default:
          this.log.warn('⚠️ Cannot auto-open browser on this platform. Please open the URL manually.');
          return;
      }

      exec(command, (error: any) => {
        if (error) {
          this.log.warn('⚠️ Could not auto-open browser:', error.message);
          this.log.info('📝 Please open the authentication URL manually in your browser.');
        } else {
          this.log.info('🌐 Opening browser for authentication...');
        }
      });
    } catch (error) {
      this.log.warn('⚠️ Error opening browser:', error);
    }
  }

private openBrowser(url: string): void {
  const { execFile, exec } = require('child_process');

  const tryExecFile = (cmd: string, args: string[], env: NodeJS.ProcessEnv) =>
    new Promise<void>((resolve, reject) => {
      execFile(cmd, args, { env }, (err: any) => err ? reject(err) : resolve());
    });

  const tryExec = (command: string, env: NodeJS.ProcessEnv) =>
    new Promise<void>((resolve, reject) => {
      exec(command, { env }, (err: any) => err ? reject(err) : resolve());
    });

  // Copia pulita dell'ambiente
  const env: NodeJS.ProcessEnv = { ...process.env };

  // Migliora compatibilità Linux (X/Wayland) senza toccare il servizio
  if (process.platform === 'linux') {
    if (!env.DISPLAY) {
      // fallback tipico X11
      env.DISPLAY = ':0';
    }
    if (!env.XDG_RUNTIME_DIR && typeof process.getuid === 'function') {
      env.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`;
    }
  }


  const tryLinux = async () => {
    // 1) Standard freedesktop
    try { await tryExecFile('xdg-open', [url], env); this.log.debug('🌐 xdg-open OK'); return; } catch {}

    // 2) Gio / GVFS
    try { await tryExec(`gio open "${url}"`, env); this.log.debug('🌐 gio open OK'); return; } catch {}

    // 3) Debian-like helpers
    try { await tryExecFile('sensible-browser', [url], env); this.log.debug('🌐 sensible-browser OK'); return; } catch {}
    try { await tryExecFile('x-www-browser', [url], env); this.log.debug('🌐 x-www-browser OK'); return; } catch {}

    // 4) xdg-desktop-portal (DBus OpenURI) — compatibile Wayland/X
    try {
      await tryExec(
        `gdbus call --session ` +
        `--dest org.freedesktop.portal.Desktop ` +
        `--object-path /org/freedesktop/portal/desktop ` +
        `--method org.freedesktop.portal.OpenURI.OpenURI "" "${url}" "{}"`,
        env
      );
      this.log.debug('🌐 xdg-desktop-portal OpenURI OK');
      return;
    } catch {}

    // 5) backend specifici (best-effort, non bloccanti)
    try { await tryExecFile('kde-open5', [url], env); this.log.debug('🌐 kde-open5 OK'); return; } catch {}
    try { await tryExecFile('gnome-open', [url], env); this.log.debug('🌐 gnome-open OK'); return; } catch {}

    // Nessun metodo disponibile/riuscito
    throw new Error('No Linux opener succeeded');
  };

  (async () => {
    try {
      switch (process.platform) {
        case 'darwin':
          await tryExec(`open "${url}"`, env);
          break;
        case 'win32':
          await tryExec(`start "" "${url}"`, env);
          break;
        default:
          await tryLinux();
      }
      this.log.info('✅ Tentativo di apertura browser completato');
    } catch (e: any) {
      this.log.warn(`⚠️ Impossibile aprire automaticamente il browser (${e?.message || e}). Apri l’URL manualmente.`);
    }
  })();
}
**/
private openBrowser(url: string): void {
  const { execFile, exec } = require('child_process');

  // Ambiente pulito senza toccare DISPLAY
  const env: NodeJS.ProcessEnv = { ...process.env };

  // Helper per eseguire comandi con timeout
  const execWithTimeout = (command: string, args: string[] = [], timeout = 5000): Promise<void> => {
    return new Promise((resolve, reject) => {
      const child = args.length > 0 
        ? execFile(command, args, { env, timeout })
        : exec(command, { env, timeout });

      child.on('error', reject);
      child.on('exit', (code: number | null) => {
        if (code === 0) resolve();
        else reject(new Error(`Exit code ${code}`));
      });
    });
  };

  const detectDesktopEnvironment = (): string => {
    const xdg = env.XDG_CURRENT_DESKTOP?.toLowerCase() || '';
    const session = env.DESKTOP_SESSION?.toLowerCase() || '';
    const gdmsession = env.GDMSESSION?.toLowerCase() || '';
    
    // Controlla tutti i possibili indicatori
    const indicators = [xdg, session, gdmsession].join(':');
    
    if (indicators.includes('gnome')) return 'gnome';
    if (indicators.includes('kde') || indicators.includes('plasma')) return 'kde';
    if (indicators.includes('xfce')) return 'xfce';
    if (indicators.includes('lxde') || indicators.includes('lxqt')) return 'lxde';
    if (indicators.includes('mate')) return 'mate';
    if (indicators.includes('cinnamon')) return 'cinnamon';
    if (indicators.includes('labwc') || indicators.includes('wlroots')) return 'wayland';
    if (indicators.includes('wayfire') || indicators.includes('sway')) return 'wayland';
    
    return 'unknown';
  };

  const tryLinuxMethods = async () => {
    const desktop = detectDesktopEnvironment();
    this.log.debug(`🖥️ Desktop environment detected: ${desktop} (XDG_CURRENT_DESKTOP=${env.XDG_CURRENT_DESKTOP})`);

    // 1. Metodo universale - xdg-open (funziona con tutti i DE moderni)
    try {
      await execWithTimeout('xdg-open', [url]);
      this.log.info('✅ Browser aperto con xdg-open');
      return true;
    } catch {}

    // 2. Metodi specifici per desktop environment
    switch (desktop) {
      case 'gnome':
        try {
          await execWithTimeout('gnome-open', [url]);
          this.log.info('✅ Browser aperto con gnome-open');
          return true;
        } catch {}
        try {
          await execWithTimeout('gio', ['open', url]);
          this.log.info('✅ Browser aperto con gio open');
          return true;
        } catch {}
        break;

      case 'kde':
        try {
          await execWithTimeout('kde-open5', [url]);
          this.log.info('✅ Browser aperto con kde-open5');
          return true;
        } catch {}
        try {
          await execWithTimeout('kde-open', [url]);
          this.log.info('✅ Browser aperto con kde-open');
          return true;
        } catch {}
        break;

      case 'xfce':
        try {
          await execWithTimeout('exo-open', [url]);
          this.log.info('✅ Browser aperto con exo-open');
          return true;
        } catch {}
        break;

      case 'lxde':
        try {
          await execWithTimeout('pcmanfm', [url]);
          this.log.info('✅ Browser aperto con pcmanfm');
          return true;
        } catch {}
        break;

      case 'mate':
        try {
          await execWithTimeout('mate-open', [url]);
          this.log.info('✅ Browser aperto con mate-open');
          return true;
        } catch {}
        break;

      case 'cinnamon':
        try {
          await execWithTimeout('cinnamon-open', [url]);
          this.log.info('✅ Browser aperto con cinnamon-open');
          return true;
        } catch {}
        break;

      case 'wayland':
        // Portal DBus (metodo nativo Wayland - funziona con labwc)
        try {
          const escapedUrl = url.replace(/"/g, '\\"');
          await execWithTimeout('gdbus', [
            'call', '--session',
            '--dest', 'org.freedesktop.portal.Desktop',
            '--object-path', '/org/freedesktop/portal/desktop',
            '--method', 'org.freedesktop.portal.OpenURI.OpenURI',
            '', escapedUrl, '{}'
          ]);
          this.log.info('✅ Browser aperto con xdg-desktop-portal (Wayland)');
          return true;
        } catch {}
        break;
    }

    // 3. Fallback: Helper generici Debian/Ubuntu/Raspberry Pi OS
    const helpers = ['sensible-browser', 'x-www-browser', 'www-browser'];
    for (const helper of helpers) {
      try {
        await execWithTimeout(helper, [url]);
        this.log.info(`✅ Browser aperto con ${helper}`);
        return true;
      } catch {}
    }

    // 4. Ultimo tentativo: Browser diretti
    const browsers = [
      'chromium-browser',  // Raspberry Pi OS default
      'chromium',
      'firefox',
      'firefox-esr',       // Debian/Raspberry Pi OS
      'google-chrome',
      'microsoft-edge',
      'brave-browser',
      'opera'
    ];
    
    for (const browser of browsers) {
      try {
        await execWithTimeout(browser, [url]);
        this.log.info(`✅ Browser aperto con ${browser}`);
        return true;
      } catch {}
    }

    return false;
  };

  (async () => {
    try {
      let success = false;

      switch (process.platform) {
        case 'darwin':
          await execWithTimeout('open', [url]);
          success = true;
          break;
          
        case 'win32':
          await execWithTimeout(`start "" "${url}"`);
          success = true;
          break;
          
        default: // Linux
          success = await tryLinuxMethods();
      }

      if (success) {
        this.log.info('🌐 Browser aperto con successo');
      } else {
        throw new Error('Tutti i metodi di apertura browser falliti');
      }
    } catch (e: any) {
      this.log.warn('='.repeat(80));
      this.log.warn('⚠️  IMPOSSIBILE APRIRE IL BROWSER AUTOMATICAMENTE');
      this.log.warn('='.repeat(80));
      this.log.warn('📱 Apri manualmente questo URL da QUALSIASI dispositivo nella tua rete:');
      this.log.warn('');
      this.log.warn(`   ${url}`);
      this.log.warn('');
      this.log.warn('💡 Puoi usare:');
      this.log.warn('   • Computer/laptop sulla stessa rete');
      this.log.warn('   • Smartphone/tablet');
      this.log.warn('   • Qualsiasi browser moderno');
      this.log.warn('='.repeat(80));
    }
  })();
}

  private async exchangeCodeForTokens(authCode: string): Promise<void> {
    const tokenData = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: this.codeVerifier!,
      code: authCode,
    });

    const exchangeTimeout = setTimeout(() => {
      throw new Error('⚠️ Authorization code expired (20 seconds limit exceeded)!');
    }, 18000); // 18 seconds of safety

    try {
      this.log.info('⚡ Exchanging authorization code for access tokens (20 second window)...');
      
      const response: AxiosResponse<AuthResponse> = await this.httpClient.post(
        `${this.authURL}/token`,
        tokenData.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      clearTimeout(exchangeTimeout);
      this.setTokens(response.data);
      this.log.info('✅ Authentication successful! Access and refresh tokens acquired.');
    } catch (error) {
      clearTimeout(exchangeTimeout);
      this.log.error('❌ Failed to exchange authorization code for tokens:', error);
      throw new Error(`Token exchange failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public async refreshAccessToken(): Promise<void> {
    if (!this.refreshToken) {
      throw new Error('No refresh token available');
    }

    // Check if refresh token is still valid
    if (this.refreshTokenExpiresAt && this.refreshTokenExpiresAt < Date.now()) {
      throw new Error('Refresh token has expired (180 days TTL exceeded)');
    }

    const tokenData = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.config.clientId,
      refresh_token: this.refreshToken,
    });

    try {
      this.log.info('🔄 Refreshing access token...');
      
      const response: AxiosResponse<AuthResponse> = await this.httpClient.post(
        `${this.authURL}/token`,
        tokenData.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      this.setTokens(response.data);
      this.log.info('✅ Access token refreshed successfully');
    } catch (error) {
      this.log.error('❌ Failed to refresh access token:', error);
      throw new Error(`Token refresh failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private setTokens(authData: AuthResponse): void {
    const now = Date.now();
    const tokenRefreshBuffer = this.config.tokenRefreshBuffer || 300000;
    
    this.accessToken = authData.access_token;
    this.refreshToken = authData.refresh_token || this.refreshToken;
    this.tokenExpiresAt = now + (authData.expires_in * 1000) - tokenRefreshBuffer;
    this.tokenIssuedAt = now;
    this.tokenScope = 'IoT User offline_access';
    
    // Set refresh token expiry if we got a new refresh token
    if (authData.refresh_token) {
      this.refreshTokenExpiresAt = now + this.REFRESH_TOKEN_TTL;
    }
    
    // Save tokens for persistence
    this.saveTokens();
    
    // Schedule proactive refresh
    this.scheduleTokenRefresh();
    
    const expiresIn = Math.round((this.tokenExpiresAt - now) / 1000);
    const refreshTokenDays = this.refreshTokenExpiresAt ? Math.round((this.refreshTokenExpiresAt - now) / (24 * 60 * 60 * 1000)) : 'unknown';
    this.log.debug(`🔑 Tokens updated successfully (expires in ${expiresIn} seconds, refresh token valid for ${refreshTokenDays} days)`);
  }

  public getAccessToken(): string | undefined {
    return this.accessToken;
  }

  public getTokenStatus(): {
    hasTokens: boolean;
    expiresAt?: Date;
    expiresInSeconds?: number;
    hasRefreshToken: boolean;
    refreshTokenExpiresAt?: Date;
    refreshTokenExpiresInDays?: number;
    scope?: string;
    issuedAt?: Date;
  } {
    const now = Date.now();
    
    return {
      hasTokens: !!this.accessToken,
      expiresAt: this.tokenExpiresAt ? new Date(this.tokenExpiresAt) : undefined,
      expiresInSeconds: this.tokenExpiresAt ? Math.max(0, Math.ceil((this.tokenExpiresAt - now) / 1000)) : undefined,
      hasRefreshToken: !!this.refreshToken,
      refreshTokenExpiresAt: this.refreshTokenExpiresAt ? new Date(this.refreshTokenExpiresAt) : undefined,
      refreshTokenExpiresInDays: this.refreshTokenExpiresAt ? Math.max(0, Math.ceil((this.refreshTokenExpiresAt - now) / (24 * 60 * 60 * 1000))) : undefined,
      scope: this.tokenScope,
      issuedAt: this.tokenIssuedAt ? new Date(this.tokenIssuedAt) : undefined
    };
  }

private logEnvDiagnostics(): void {
  const env = process.env;
  this.log.warn(
    [
      '🧪 ENV DIAGNOSTICS',
      `platform=${process.platform}`,
      `DISPLAY=${env.DISPLAY ?? '(unset)'}`,
      `WAYLAND_DISPLAY=${env.WAYLAND_DISPLAY ?? '(unset)'}`,
      `XDG_RUNTIME_DIR=${env.XDG_RUNTIME_DIR ?? '(unset)'}`,
      `DBUS_SESSION_BUS_ADDRESS=${env.DBUS_SESSION_BUS_ADDRESS ? '(set)' : '(unset)'}`,
      `SYSTEMD_EXEC_PID=${env.SYSTEMD_EXEC_PID ? '(set)' : '(unset)'}`,
      `INVOCATION_ID=${env.INVOCATION_ID ? '(set)' : '(unset)'}`
    ].join(' | ')
  );
}

  public cleanup(): void {
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = undefined;
    }
    
    if (this.authServer) {
      this.stopAuthServer();
    }
    
    if (this.authTimeout) {
      clearTimeout(this.authTimeout);
      this.authTimeout = undefined;
    }
    
    this.log.debug('🧹 AuthManager cleanup completed');
  }
}