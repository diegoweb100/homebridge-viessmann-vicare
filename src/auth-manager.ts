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
  private envDiagnosticsLogged = false; // FIX#4: log once at startup only
  // Persistent auth server fields
  private authServerPort: number = 4200;
  private pendingAuthCallback?: (code?: string, error?: Error) => void;

  constructor(
    private readonly log: Logger,
    private readonly config: AuthConfig,
    private readonly httpClient: AxiosInstance,
    private readonly hostIp: string,
    storagePath?: string
  ) {
    this.redirectUri = `http://${this.hostIp}:${this.config.redirectPort || 4200}/`;
    this.tokenStoragePath = storagePath || path.join(process.cwd(), '.homebridge', 'viessmann-tokens.json');
    
    this.log.debug(`Using redirect URI: ${this.redirectUri}`);
    this.log.debug(`Token storage path: ${this.tokenStoragePath}`);
    
    this.authServerPort = this.config.redirectPort || 4200;
    this.validateAuthConfiguration();
    this.generatePKCECodes();
    this.initializeTokens();
    // Start the persistent auth/status server immediately so the URL is
    // always reachable — even when already authenticated.
    this.startPersistentAuthServer();
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
    
    const buffer = this.config.tokenRefreshBuffer || 300000;
    const refreshTime = this.tokenExpiresAt - buffer - Date.now();
    
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
      
      const refreshInMin = Math.round(refreshTime / 60000);
      const atTime = new Date(Date.now() + refreshTime).toLocaleTimeString('it-IT');
      this.log.info(`⏰ Next token refresh scheduled in ${refreshInMin} min (at ${atTime}, buffer: ${buffer/1000}s)`);
    } else {
      this.log.warn(`⚠️ Token expires in ${Math.round((this.tokenExpiresAt - Date.now())/1000)}s — immediate refresh needed`);
    }
  }

  public async authenticate(): Promise<void> {
    try {
      // FIX#4: log env diagnostics only once at startup
      if (!this.envDiagnosticsLogged) {
        this.logEnvDiagnostics();
        this.envDiagnosticsLogged = true;
      }

      if (this.isTokenValid()) {
        const remaining = Math.round((this.tokenExpiresAt! - Date.now()) / 1000);
        this.log.debug(`🔑 Token valid — ${remaining}s remaining, skipping authenticate`);
        return;
      }

      this.log.debug(`🔑 Token invalid or missing — attempting authentication...`);
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

      const authMethod = this.config.authMethod || 'auto';
      if (authMethod === 'manual') {
        await this.handleManualAuth();
        return;
      }

      try {
        await this.performAutoAuth();
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

  private shouldUseManualAuth(): boolean {
    if (this.config.authMethod === 'manual') return true;
    return false;
  }

  private async performAutoAuth(): Promise<void> {
    this.log.info('🚀 Starting automatic OAuth authentication...');
    await this.performFullAuth();
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
    this.log.error('   }');
    this.log.error('');
    this.log.error('📖 For detailed instructions, visit:');
    this.log.error('https://github.com/diegoweb100/homebridge-viessmann-vicare#manual-authentication');
    this.log.error('='.repeat(80));
    throw new Error('Manual authentication required - see logs for detailed instructions');
  }

  private async performFullAuth(): Promise<void> {
    return new Promise((resolve, reject) => {
      const authUrl = this.buildAuthUrl();

      // Set the pending callback so the persistent server can resolve this promise
      this.pendingAuthCallback = (code, error) => {
        this.pendingAuthCallback = undefined;
        if (this.authTimeout) {
          clearTimeout(this.authTimeout);
          this.authTimeout = undefined;
        }
        if (error) { reject(error); return; }
        if (code) {
          this.exchangeCodeForTokens(code)
            .then(() => resolve())
            .catch((err) => reject(err));
        }
      };

      // Auth timeout
      const authTimeout = this.config.authTimeout || 300000;
      this.authTimeout = setTimeout(() => {
        this.pendingAuthCallback = undefined;
        reject(new Error(`Authentication timeout after ${authTimeout / 1000}s`));
      }, authTimeout);

      // Log the auth URL prominently (FIX#5: unconditional)
      this.openBrowser(authUrl);
    });
  }

  private buildAuthUrl(): string {
    const params = new URLSearchParams({
      client_id:             this.config.clientId,
      redirect_uri:          this.redirectUri,
      scope:                 'IoT User offline_access',
      response_type:         'code',
      code_challenge_method: 'S256',
      code_challenge:        this.codeChallenge!,
    });
    return `${this.authURL}/authorize?${params.toString()}`;
  }

  private isTokenValid(): boolean {
    if (!this.accessToken || !this.tokenExpiresAt) {
      return false;
    }
    // Use configured refresh buffer
    const tokenRefreshBuffer = this.config.tokenRefreshBuffer || 300000;
    return Date.now() < (this.tokenExpiresAt - tokenRefreshBuffer);
  }

  // ─── Persistent auth/status server ────────────────────────────────────────
  // Started once in the constructor and never closed while Homebridge is running.
  // Routes:
  //   GET /           → token status page (or "authenticate" page if no tokens)
  //   GET /callback   → OAuth callback (code exchange)
  //   POST /reauth    → force re-authentication (regenerates PKCE + redirects)
  //   POST /clear     → clear stored tokens
  //   GET /health     → JSON status

  private startPersistentAuthServer(): void {
    if (this.authServer?.listening) {
      this.log.debug('🟢 Auth server already listening — skipping restart');
      return;
    }

    this.authServer = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url ?? '/', `http://localhost:${this.authServerPort}`);
      const pathname  = parsedUrl.pathname;
      const method    = req.method?.toUpperCase() ?? 'GET';

      // ── GET /health ──────────────────────────────────────────────────────
      if (pathname === '/health' && method === 'GET') {
        const status = this.getTokenStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          authenticated: status.hasTokens,
          expiresInSeconds: status.expiresInSeconds,
          hasRefreshToken: status.hasRefreshToken,
          refreshTokenExpiresInDays: status.refreshTokenExpiresInDays,
          pendingAuth: !!this.pendingAuthCallback,
        }));
        return;
      }

      // ── POST /reauth ────────────────────────────────────────────────────
      if (pathname === '/reauth' && method === 'POST') {
        this.log.info('🔄 Re-authentication requested from auth status page');
        this.clearStoredTokens();
        this.generatePKCECodes();
        const authUrl = this.buildAuthUrl();

        // Set pending callback — whoever opened /reauth will be redirected to Viessmann
        // The promise is not awaited here; Homebridge will pick up new tokens on next authenticate()
        this.pendingAuthCallback = (code, error) => {
          this.pendingAuthCallback = undefined;
          if (this.authTimeout) { clearTimeout(this.authTimeout); this.authTimeout = undefined; }
          if (error) { this.log.error('❌ Re-auth failed:', error.message); return; }
          if (code) {
            this.exchangeCodeForTokens(code)
              .then(() => this.log.info('✅ Re-authentication successful'))
              .catch((err) => this.log.error('❌ Re-auth token exchange failed:', err));
          }
        };

        const timeout = this.config.authTimeout || 300000;
        this.authTimeout = setTimeout(() => {
          this.pendingAuthCallback = undefined;
          this.log.warn('⏰ Re-authentication timed out');
        }, timeout);

        // Redirect the browser to Viessmann OAuth
        res.writeHead(302, { Location: authUrl });
        res.end();
        // Also log the URL for headless environments
        this.openBrowser(authUrl);
        return;
      }

      // ── POST /clear ─────────────────────────────────────────────────────
      if (pathname === '/clear' && method === 'POST') {
        this.log.info('🗑️ Token clear requested from auth status page');
        this.clearStoredTokens();
        if (this.pendingAuthCallback) {
          this.pendingAuthCallback = undefined;
          if (this.authTimeout) { clearTimeout(this.authTimeout); this.authTimeout = undefined; }
        }
        res.writeHead(302, { Location: '/' });
        res.end();
        return;
      }

      // ── GET /callback ────────────────────────────────────────────────────
      if (pathname === '/' || pathname === '/callback') {
        const code  = parsedUrl.searchParams.get('code');
        const error = parsedUrl.searchParams.get('error');
        const errorDesc = parsedUrl.searchParams.get('error_description') || error || '';

        if (error) {
          this.log.error(`❌ OAuth error: ${errorDesc}`);
          if (this.pendingAuthCallback) this.pendingAuthCallback(undefined, new Error(errorDesc));
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(this.buildStatusPageHtml('error', errorDesc));
          return;
        }

        if (code && this.pendingAuthCallback) {
          this.log.info('✅ OAuth callback received — exchanging code for tokens...');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(this.buildStatusPageHtml('exchanging'));
          this.pendingAuthCallback(code);
          return;
        }

        // No code — render status page
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        const tokenStatus = this.getTokenStatus();
        if (tokenStatus.hasTokens) {
          res.end(this.buildStatusPageHtml('authenticated'));
        } else {
          // Not authenticated: show "click to authenticate" page
          this.generatePKCECodes();
          const authUrl = this.buildAuthUrl();
          res.end(this.buildStatusPageHtml('unauthenticated', authUrl));
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    });

    this.authServer.listen(this.authServerPort, '0.0.0.0', () => {
      const port = this.authServerPort;
      const ip   = this.hostIp;
      this.log.info('═'.repeat(60));
      this.log.info('🔐 Viessmann Auth Manager');
      this.log.info(`   Status page: http://${ip}:${port}`);
      this.log.info('═'.repeat(60));
    });

    this.authServer.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        this.log.warn(`⚠️ Auth server port ${this.authServerPort} already in use — auth status page unavailable`);
      } else {
        this.log.error('❌ Auth server error:', error.message);
      }
      this.authServer = undefined;
    });
  }

  private buildStatusPageHtml(state: 'authenticated' | 'unauthenticated' | 'exchanging' | 'error', extra?: string): string {
    const status   = this.getTokenStatus();
    const port     = this.authServerPort;
    const username = this.config.username || '';

    const css = `
      <style>
        :root{--bg:#0d1117;--surface:#161b22;--border:#21262d;--accent:#f97316;--text:#e6edf3;--muted:#7d8590;--good:#3fb950;--bad:#f85149;--warn:#e3b341;--r:10px}
        *{box-sizing:border-box;margin:0;padding:0}
        body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:40px 16px 60px}
        .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:28px 32px;width:100%;max-width:520px;margin-bottom:14px}
        h1{font-size:22px;font-weight:700;letter-spacing:-.3px;margin-bottom:4px}
        h1 span{color:var(--accent)}
        .sub{color:var(--muted);font-size:13px;margin-bottom:24px}
        .badge{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:20px;font-size:13px;font-weight:600;margin-bottom:20px}
        .badge.ok{background:rgba(63,185,80,.15);color:var(--good);border:1px solid rgba(63,185,80,.3)}
        .badge.no{background:rgba(248,81,73,.15);color:var(--bad);border:1px solid rgba(248,81,73,.3)}
        .badge.wait{background:rgba(227,179,65,.15);color:var(--warn);border:1px solid rgba(227,179,65,.3)}
        .row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);font-size:14px}
        .row:last-child{border-bottom:none}
        .lbl{color:var(--muted);font-size:12px}
        .val{font-weight:500;text-align:right;max-width:300px;word-break:break-all}
        .val.ok{color:var(--good)} .val.warn{color:var(--warn)} .val.bad{color:var(--bad)}
        .btns{display:flex;gap:10px;flex-wrap:wrap;margin-top:6px}
        button,a.btn{display:inline-flex;align-items:center;gap:7px;padding:11px 20px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;text-decoration:none;transition:opacity .15s}
        button:hover,a.btn:hover{opacity:.85}
        .btn-primary{background:var(--accent);color:#fff}
        .btn-danger{background:rgba(248,81,73,.15);color:var(--bad);border:1px solid rgba(248,81,73,.3)}
        .btn-secondary{background:rgba(249,115,22,.12);color:var(--accent);border:1px solid rgba(249,115,22,.3)}
        .url-box{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px 16px;font-family:monospace;font-size:11px;word-break:break-all;color:var(--muted);margin:14px 0}
        footer{font-size:11px;color:var(--muted);opacity:.5;margin-top:20px}
        .spinner{display:inline-block;width:16px;height:16px;border:2px solid rgba(249,115,22,.3);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite}
        @keyframes spin{to{transform:rotate(360deg)}}
      </style>`;

    const header = `
      <h1>🔐 Viessmann <span>ViCare</span></h1>
      <div class="sub">Authentication Manager &nbsp;·&nbsp; port ${port}</div>`;

    if (state === 'authenticated') {
      const expiresIn = status.expiresInSeconds ?? 0;
      const expiresAt = status.expiresAt ? status.expiresAt.toLocaleString('it-IT') : '—';
      const rtDays    = status.refreshTokenExpiresInDays ?? 0;
      const rtAt      = status.refreshTokenExpiresAt ? status.refreshTokenExpiresAt.toLocaleDateString('it-IT') : '—';
      const exClass   = expiresIn < 300 ? 'bad' : expiresIn < 900 ? 'warn' : 'ok';
      const rtClass   = rtDays < 7 ? 'bad' : rtDays < 30 ? 'warn' : 'ok';
      const exLabel   = expiresIn < 3600
        ? `in ${Math.round(expiresIn / 60)} min`
        : `in ${Math.round(expiresIn / 3600)} h`;

      return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Viessmann Auth</title>${css}</head><body>
        <div class="card">
          ${header}
          <div class="badge ok">✅ Authenticated</div>
          <div class="row"><span class="lbl">Account</span><span class="val">${username}</span></div>
          <div class="row"><span class="lbl">Access token</span><span class="val ${exClass}">Expires ${exLabel} (${expiresAt})</span></div>
          <div class="row"><span class="lbl">Refresh token</span><span class="val ${rtClass}">${status.hasRefreshToken ? `${rtDays} days left (${rtAt})` : 'not present'}</span></div>
        </div>
        <div class="card">
          <div class="btns">
            <form method="POST" action="/reauth" style="margin:0">
              <button type="submit" class="btn-secondary">🔄 Re-authenticate</button>
            </form>
            <form method="POST" action="/clear" style="margin:0" onsubmit="return confirm('Clear stored tokens and disconnect?')">
              <button type="submit" class="btn-danger">🗑️ Clear tokens</button>
            </form>
          </div>
        </div>
        <footer>homebridge-viessmann-vicare &nbsp;·&nbsp; auth status</footer>
      </body></html>`;
    }

    if (state === 'unauthenticated') {
      const authUrl = extra ?? '';
      return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Viessmann Auth</title>${css}</head><body>
        <div class="card">
          ${header}
          <div class="badge no">❌ Not authenticated</div>
          <p style="font-size:14px;color:var(--muted);margin-bottom:12px">
            Click the button below to log in with your Viessmann ViCare account.<br>
            Or open the URL manually from any browser on your network:
          </p>
          <div class="url-box">${authUrl}</div>
          <div class="btns">
            <a href="${authUrl}" class="btn btn-primary" target="_blank">🔗 Authenticate with Viessmann</a>
          </div>
        </div>
        <footer>homebridge-viessmann-vicare &nbsp;·&nbsp; auth status</footer>
      </body></html>`;
    }

    if (state === 'exchanging') {
      return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Viessmann Auth</title>${css}<meta http-equiv="refresh" content="3;url=/"></head><body>
        <div class="card">
          ${header}
          <div class="badge wait"><span class="spinner"></span> Exchanging tokens…</div>
          <p style="font-size:14px;color:var(--muted)">Authentication successful — saving tokens. This page will refresh in a moment.</p>
        </div>
      </body></html>`;
    }

    // error
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Viessmann Auth</title>${css}</head><body>
      <div class="card">
        ${header}
        <div class="badge no">❌ Authentication error</div>
        <p style="font-size:14px;color:var(--bad);margin-bottom:16px">${extra ?? 'Unknown error'}</p>
        <div class="btns">
          <a href="/reauth" class="btn btn-secondary" onclick="event.preventDefault();fetch('/reauth',{method:'POST'}).then(r=>r.ok?window.location.href='/':null)">🔄 Try again</a>
        </div>
      </div>
    </body></html>`;
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


private openBrowser(url: string): void {
  // 🆕 Per servizi systemd: NON tentare di aprire automaticamente
  // L'utente può aprire da qualsiasi dispositivo sulla rete
  
  const isSystemdService = !!(process.env.SYSTEMD_EXEC_PID || process.env.INVOCATION_ID);
  const isHomebridge = process.env.USER === 'homebridge';
  
  // Se siamo in un servizio systemd o utente homebridge, non aprire automaticamente
  if (isSystemdService || isHomebridge) {
    this.log.info('='.repeat(80));
    this.log.info('🔐 AUTHENTICATION REQUIRED');
    this.log.info('='.repeat(80));
    this.log.info('');
    this.log.info('📱 Open this URL from ANY device on your network:');
    this.log.info('');
    this.log.info(`   ${url}`);
    this.log.info('');
    this.log.info('✅ You can open it from:');
    this.log.info('   • Your computer/laptop');
    this.log.info('   • Your smartphone/tablet');
    this.log.info('   • This Raspberry Pi (if you have a browser)');
    this.log.info('');
    this.log.info(`🌐 Auth server is listening on: ${this.hostIp}:${this.config.redirectPort || 4200}`);
    this.log.info('⏳ Waiting for authentication...');
    this.log.info('='.repeat(80));
    return;
  }

  // Solo per installazioni non-systemd (es. macOS, sviluppo locale)
  this.tryOpenBrowserDirect(url);
}

private tryOpenBrowserDirect(url: string): void {
  const { exec } = require('child_process');
  
  let command: string;
  
  switch (process.platform) {
    case 'darwin':
      command = `open "${url}"`;
      break;
    case 'win32':
      command = `start "" "${url}"`;
      break;
    default: // Linux desktop (non-systemd)
      command = `xdg-open "${url}" 2>/dev/null || firefox "${url}" 2>/dev/null || chromium-browser "${url}" 2>/dev/null`;
  }

  exec(command, (error: Error | null) => {
    if (error) {
      this.log.info('📱 Please open the authentication URL manually in your browser');
    } else {
      this.log.info('🌐 Opening browser...');
    }
  });
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

    if (this.refreshTokenExpiresAt) {
      const daysLeft = Math.round((this.refreshTokenExpiresAt - Date.now()) / (24 * 60 * 60 * 1000));
      this.log.debug(`🔑 Using refresh token (${daysLeft} days until expiry)`);
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
    // FIX#2: store the REAL expiry time — do NOT subtract buffer here.
    // The buffer is applied exclusively in isTokenValid() and scheduleTokenRefresh().
    // Previously the buffer was subtracted twice, causing refresh ~2x too early.
    this.tokenExpiresAt = now + (authData.expires_in * 1000);
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
    
    const realExpiryInMin = Math.round(authData.expires_in / 60);
    const effectiveWindowSec = Math.round((authData.expires_in * 1000 - tokenRefreshBuffer) / 1000);
    const refreshTokenDays = this.refreshTokenExpiresAt ? Math.round((this.refreshTokenExpiresAt - now) / (24 * 60 * 60 * 1000)) : 'unknown';
    this.log.info(`🔑 Tokens acquired — real expiry: ${realExpiryInMin}min | effective window: ${effectiveWindowSec}s (buffer: ${tokenRefreshBuffer/1000}s) | refresh token: ${refreshTokenDays} days`);
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
  // FIX#4: changed from warn to debug — called once at startup only
  this.log.debug(
    [
      '🧪 ENV DIAGNOSTICS (startup)',
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