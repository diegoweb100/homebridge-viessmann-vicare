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
  dashboardPin?: string;    // optional PIN for dashboard changes
  dashboardBind?: string;   // listen address of the dashboard (default all interfaces)
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
  // Unified web dashboard (viessmann-dashboard.js), mounted on this server by the platform
  private dashboard?: { handle: (req: any, res: any, url: URL, getAuth: () => any, getSecurity: () => any) => Promise<boolean>; page: (req: any, auth: any, security: any) => string };

  /** Mounts the dashboard (reports, flue gas analyses, status) on the OAuth port. */
  public setDashboard(d: any): void {
    this.dashboard = d;
  }

  public getDashboardUrl(): string {
    return `http://${this.hostIp}:${this.authServerPort}`;
  }

  private dashboardAuth(authUrl?: string) {
    return {
      state: this.getTokenStatus().hasTokens ? 'authenticated' : 'unauthenticated',
      authUrl, status: this.getTokenStatus(), username: this.config.username || '',
      method: this.config.authMethod || 'auto', redirectUri: this.redirectUri,
    };
  }

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
    this.pkceAt = Date.now();
    
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
        this.writeSecureJson(this.tokenStoragePath, tokenData);
        this.log.debug('💾 Saved tokens to persistent storage');
      } catch (error) {
        this.log.warn('⚠️ Failed to save tokens to persistent storage:', error);
      }
    }
  }

  /**
   * Writes a JSON file readable only by the Homebridge user (0600), atomically: temporary file,
   * fsync, rename. A power cut during the write leaves the old file, never a truncated one.
   */
  private writeSecureJson(file: string, obj: unknown): void {
    const tmp = `${file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(obj, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try { fs.chmodSync(tmp, 0o600); } catch { /* not supported on this file system */ }
    fs.renameSync(tmp, file);
    try { const d = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch { /* directory fsync not supported (e.g. Windows) */ }
  }

  private clearStoredTokens(): void {
    try {
      if (fs.existsSync(this.tokenStoragePath)) {
        const tokenData = JSON.parse(fs.readFileSync(this.tokenStoragePath, 'utf8'));
        const tokenKey = `${this.config.clientId}:${this.config.username}`;
        
        if (tokenData[tokenKey]) {
          delete tokenData[tokenKey];
          this.writeSecureJson(this.tokenStoragePath, tokenData);
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
  //   GET /           → dashboard (or the plain status page if the dashboard is not mounted)
  //   GET /?code=…    → OAuth callback (code exchange)
  //   POST /reauth    → force re-authentication: returns {authUrl} for the browser to open
  //   POST /clear     → clear stored tokens
  //   POST /api/unlock, /api/lock → dashboard PIN session (only when dashboardPin is set)
  //   GET /health     → JSON status
  //   /api, /assets, /reports → dashboard (viessmann-dashboard.js)
  //
  // Security (2.0.82):
  //   - every write (POST/PUT/DELETE) needs the per-start CSRF token (header X-Vicare-Csrf, only
  //     readable by pages served by this server) and, when the browser sends one, a same-origin
  //     Origin header. Other web sites cannot read the token, so they cannot trigger writes.
  //   - optional dashboardPin: writes also need an unlocked session (HttpOnly, SameSite=Strict
  //     cookie), so other devices on the LAN cannot change anything without the PIN.
  //   - security headers on every response; the OAuth callback URL never leaks via Referer.
  //   - listen address configurable (dashboardBind, default all interfaces).

  private readonly csrfToken = crypto.randomBytes(32).toString('base64url');
  private pkceAt = 0;
  private sessions = new Map<string, number>();        // sha256(session id) → expiry (ms)
  private sessionsLoaded = false;
  private pinFails = new Map<string, { n: number; first: number; until: number }>();
  private static readonly SESSION_TTL = 30 * 86400000;
  private static readonly PKCE_TTL = 15 * 60000;

  private dashboardPin(): string {
    const p = (this.config as any).dashboardPin;
    return (typeof p === 'string' || typeof p === 'number') ? String(p).trim() : '';
  }

  private bindAddress(): string {
    const b = String((this.config as any).dashboardBind || '').trim();
    return /^[0-9a-fA-F:.]+$/.test(b) ? b : '0.0.0.0';
  }

  /** Keeps the PKCE pair of a login in progress: opening the page again must not invalidate the link in use. */
  private ensureFreshPKCE(): void {
    if (!this.codeVerifier || Date.now() - this.pkceAt > AuthManager.PKCE_TTL) this.generatePKCECodes();
  }

  private securityHeaders(res: http.ServerResponse, strictPage = false): void {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', strictPage
      ? "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"
      : "frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
  }

  private sameOrigin(req: http.IncomingMessage): boolean {
    const host = String(req.headers.host || '').toLowerCase();
    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
      try { return new URL(origin).host.toLowerCase() === host; } catch { return false; }
    }
    if (origin === 'null') return false;
    return true;   // no Origin header (non-browser client): the CSRF token still applies
  }

  private validCsrf(req: http.IncomingMessage): boolean {
    const got = Buffer.from(String(req.headers['x-vicare-csrf'] || ''));
    const exp = Buffer.from(this.csrfToken);
    return got.length === exp.length && crypto.timingSafeEqual(got, exp);
  }

  private sessionFile(): string {
    return path.join(path.dirname(this.tokenStoragePath), 'viessmann-dashboard-sessions.json');
  }

  private loadSessions(): void {
    if (this.sessionsLoaded) return;
    this.sessionsLoaded = true;
    try {
      const j = JSON.parse(fs.readFileSync(this.sessionFile(), 'utf8'));
      const now = Date.now();
      for (const [k, v] of Object.entries(j)) if (typeof v === 'number' && v > now) this.sessions.set(k, v);
    } catch { /* no sessions yet */ }
  }

  private saveSessions(): void {
    try { this.writeSecureJson(this.sessionFile(), Object.fromEntries(this.sessions)); } catch (e: any) {
      this.log.debug(`Dashboard sessions not saved: ${e?.message || e}`);
    }
  }

  private sessionId(req: http.IncomingMessage): string | undefined {
    const m = String(req.headers.cookie || '').match(/(?:^|;\s*)vicare_session=([A-Za-z0-9_-]{20,})/);
    return m ? m[1] : undefined;
  }

  private isUnlocked(req: http.IncomingMessage): boolean {
    if (!this.dashboardPin()) return true;
    this.loadSessions();
    const id = this.sessionId(req);
    if (!id) return false;
    const h = crypto.createHash('sha256').update(id).digest('hex');
    const exp = this.sessions.get(h);
    if (!exp || exp < Date.now()) { if (exp) { this.sessions.delete(h); this.saveSessions(); } return false; }
    return true;
  }

  /** Security info for the dashboard page / status. */
  private dashboardSecurity(req: http.IncomingMessage) {
    return { csrf: this.csrfToken, pinRequired: !!this.dashboardPin(), unlocked: this.isUnlocked(req) };
  }

  private readSmallJson(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve) => {
      let n = 0; const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => { n += c.length; if (n > 4096) { req.destroy(); resolve({}); } else chunks.push(c); });
      req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { resolve({}); } });
      req.on('error', () => resolve({}));
    });
  }

  private sendJson(res: http.ServerResponse, code: number, obj: any, extra: Record<string, string> = {}): void {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.end(JSON.stringify(obj));
  }

  /** POST /api/unlock {pin}: 5 wrong PINs from one address → 15 minutes locked out. */
  private async handleUnlock(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const pin = this.dashboardPin();
    if (!pin) { this.sendJson(res, 200, { ok: true, unlocked: true }); return; }
    const ip = String(req.socket.remoteAddress || '?');
    const f = this.pinFails.get(ip);
    if (f && f.until > Date.now()) { this.sendJson(res, 429, { error: 'too many attempts', retryInSec: Math.ceil((f.until - Date.now()) / 1000) }); return; }
    const b = await this.readSmallJson(req);
    const a = crypto.createHash('sha256').update(String(b.pin ?? '')).digest();
    const e = crypto.createHash('sha256').update(pin).digest();
    if (!crypto.timingSafeEqual(a, e)) {
      const fresh = f && f.until === 0 && Date.now() - f.first < 3600000;   // count failures within one hour
      const n = (fresh ? f!.n : 0) + 1;
      this.pinFails.set(ip, { n, first: fresh ? f!.first : Date.now(), until: n >= 5 ? Date.now() + 15 * 60000 : 0 });
      if (n >= 5) this.log.warn(`🔒 Dashboard: 5 wrong PINs from ${ip}, locked for 15 minutes`);
      this.sendJson(res, 403, { error: 'wrong PIN', left: Math.max(0, 5 - n) });
      return;
    }
    this.pinFails.delete(ip);
    this.loadSessions();
    const id = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    for (const [k, v] of this.sessions) if (v < now) this.sessions.delete(k);
    this.sessions.set(crypto.createHash('sha256').update(id).digest('hex'), now + AuthManager.SESSION_TTL);
    this.saveSessions();
    this.log.info(`🔓 Dashboard unlocked from ${ip}`);
    this.sendJson(res, 200, { ok: true, unlocked: true }, {
      'Set-Cookie': `vicare_session=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${AuthManager.SESSION_TTL / 1000}`,
    });
  }

  private handleLock(req: http.IncomingMessage, res: http.ServerResponse): void {
    const id = this.sessionId(req);
    if (id) { this.sessions.delete(crypto.createHash('sha256').update(id).digest('hex')); this.saveSessions(); }
    this.sendJson(res, 200, { ok: true, unlocked: !this.dashboardPin() }, { 'Set-Cookie': 'vicare_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' });
  }

  /** Arms the OAuth callback for a login started from the browser (dashboard button or /reauth). */
  private armBrowserLogin(): void {
    if (this.pendingAuthCallback) return;   // the startup login is already waiting for the code
    this.pendingAuthCallback = (code, error) => {
      this.pendingAuthCallback = undefined;
      if (this.authTimeout) { clearTimeout(this.authTimeout); this.authTimeout = undefined; }
      if (error) { this.log.error('❌ Login failed:', error.message); return; }
      if (code) {
        this.exchangeCodeForTokens(code)
          .then(() => this.log.info('✅ Viessmann login successful'))
          .catch((err) => this.log.error('❌ Login token exchange failed:', err));
      }
    };
    const timeout = this.config.authTimeout || 300000;
    this.authTimeout = setTimeout(() => {
      this.pendingAuthCallback = undefined;
      this.log.warn('⏰ Viessmann login from the dashboard timed out');
    }, Math.max(timeout, AuthManager.PKCE_TTL));
  }

  private startPersistentAuthServer(): void {
    if (this.authServer?.listening) {
      this.log.debug('🟢 Auth server already listening — skipping restart');
      return;
    }

    this.authServer = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url ?? '/', `http://localhost:${this.authServerPort}`);
      const pathname  = parsedUrl.pathname;
      const method    = req.method?.toUpperCase() ?? 'GET';
      this.securityHeaders(res);

      // ── Write gate: CSRF token + same origin (+ PIN session when configured) ──
      if (method !== 'GET' && method !== 'HEAD') {
        if (!this.sameOrigin(req) || !this.validCsrf(req)) {
          this.sendJson(res, 403, { error: 'csrf', message: 'Reload the dashboard page and try again' });
          return;
        }
        if (pathname === '/api/unlock' && method === 'POST') { void this.handleUnlock(req, res); return; }
        if (pathname === '/api/lock' && method === 'POST') { this.handleLock(req, res); return; }
        if (!this.isUnlocked(req)) {
          this.sendJson(res, 401, { error: 'locked', message: 'Enter the dashboard PIN' });
          return;
        }
      }

      // ── Dashboard routes (/api, /assets, /reports) ───────────────────────
      if (this.dashboard && /^\/(api|assets|reports)\//.test(pathname)) {
        this.dashboard.handle(req, res, parsedUrl, () => this.dashboardAuth(), () => this.dashboardSecurity(req))
          .then((done) => { if (!done) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); } })
          .catch(() => { if (!res.headersSent) { res.writeHead(500); res.end(); } });
        return;
      }

      // ── GET /health ──────────────────────────────────────────────────────
      if (pathname === '/health' && method === 'GET') {
        const status = this.getTokenStatus();
        this.sendJson(res, 200, {
          authenticated: status.hasTokens,
          expiresInSeconds: status.expiresInSeconds,
          hasRefreshToken: status.hasRefreshToken,
          refreshTokenExpiresInDays: status.refreshTokenExpiresInDays,
          pendingAuth: !!this.pendingAuthCallback,
        });
        return;
      }

      // ── POST /reauth ────────────────────────────────────────────────────
      if (pathname === '/reauth' && method === 'POST') {
        this.log.info('🔄 Re-authentication requested from the dashboard');
        this.clearStoredTokens();
        if (this.pendingAuthCallback) { this.pendingAuthCallback = undefined; if (this.authTimeout) { clearTimeout(this.authTimeout); this.authTimeout = undefined; } }
        this.generatePKCECodes();
        const authUrl = this.buildAuthUrl();
        this.armBrowserLogin();
        this.sendJson(res, 200, { authUrl });
        this.openBrowser(authUrl);   // also in the log, for headless setups
        return;
      }

      // ── POST /clear ─────────────────────────────────────────────────────
      if (pathname === '/clear' && method === 'POST') {
        this.log.info('🗑️ Token clear requested from the dashboard');
        this.clearStoredTokens();
        if (this.pendingAuthCallback) {
          this.pendingAuthCallback = undefined;
          if (this.authTimeout) { clearTimeout(this.authTimeout); this.authTimeout = undefined; }
        }
        this.sendJson(res, 200, { ok: true });
        return;
      }

      // ── GET / and the OAuth callback ─────────────────────────────────────
      if ((pathname === '/' || pathname === '/callback') && (method === 'GET' || method === 'HEAD')) {
        const code  = parsedUrl.searchParams.get('code');
        const error = parsedUrl.searchParams.get('error');
        const errorDesc = parsedUrl.searchParams.get('error_description') || error || '';

        if (error) {
          this.log.error(`❌ OAuth error: ${errorDesc}`);
          if (this.pendingAuthCallback) this.pendingAuthCallback(undefined, new Error(errorDesc));
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(this.buildStatusPageHtml('error', errorDesc));
          return;
        }

        if (code) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          if (this.pendingAuthCallback) {
            this.log.info('✅ OAuth callback received — exchanging code for tokens...');
            res.end(this.buildStatusPageHtml('exchanging'));
            this.pendingAuthCallback(code);
          } else {
            this.log.warn('⚠️ OAuth callback received but no login is in progress (expired): press "Log in" again');
            res.end(this.buildStatusPageHtml('error', 'The login link has expired. Open the dashboard and press "Log in" again.'));
          }
          return;
        }

        // No code — render the dashboard (or the plain status page)
        res.setHeader('Cache-Control', 'no-store');
        const tokenStatus = this.getTokenStatus();
        let authUrl: string | undefined;
        if (!tokenStatus.hasTokens) { this.ensureFreshPKCE(); authUrl = this.buildAuthUrl(); this.armBrowserLogin(); }
        if (this.dashboard) {
          this.securityHeaders(res, true);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(this.dashboard.page(req, this.dashboardAuth(authUrl), this.dashboardSecurity(req)));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(tokenStatus.hasTokens ? this.buildStatusPageHtml('authenticated') : this.buildStatusPageHtml('unauthenticated', authUrl));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    });

    const bind = this.bindAddress();
    this.authServer.listen(this.authServerPort, bind, () => {
      const port = this.authServerPort;
      const local = bind === '127.0.0.1' || bind === '::1';
      const ip   = local ? bind : (bind === '0.0.0.0' || bind === '::' ? this.hostIp : bind);
      this.log.info('═'.repeat(60));
      this.log.info(`🔥 Viessmann dashboard: http://${ip}:${port}`);
      this.log.info('   Login · reports · flue gas analyses · API status');
      if (local) this.log.info('   (dashboardBind: reachable only from this computer)');
      if (this.dashboardPin()) this.log.info('   🔒 Changes need the dashboard PIN');
      this.log.info('═'.repeat(60));
    });

    this.authServer.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        this.log.warn(`⚠️ Port ${this.authServerPort} already in use — the Viessmann dashboard and the login page are not available (change redirectPort)`);
      } else if (error.code === 'EADDRNOTAVAIL') {
        this.log.warn(`⚠️ dashboardBind "${bind}" is not an address of this computer — the dashboard is not available (remove dashboardBind or use one of its IP addresses)`);
      } else {
        this.log.error('❌ Auth server error:', error.message);
      }
      this.authServer = undefined;
    });
  }

  private buildStatusPageHtml(state: 'authenticated' | 'unauthenticated' | 'exchanging' | 'error', extra?: string): string {
    const status   = this.getTokenStatus();
    const port     = this.authServerPort;
    // Everything put into the page is escaped: error_description comes from the URL (reflected XSS)
    const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
    const username = esc(this.config.username || '');
    extra = extra === undefined ? undefined : esc(extra);
    // Buttons call the API with the CSRF token (plain forms are refused since 2.0.82)
    const actions = `<script>
      function vicare(path, ask){ if (ask && !confirm(ask)) return;
        fetch(path,{method:'POST',headers:{'X-Vicare-Csrf':${JSON.stringify(this.csrfToken)}}})
          .then(function(r){return r.json();}).then(function(j){ if (j.authUrl) location.href=j.authUrl; else location.href='/'; });
      }</script>`;

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
            <button type="button" class="btn-secondary" onclick="vicare('/reauth')">🔄 Re-authenticate</button>
            <button type="button" class="btn-danger" onclick="vicare('/clear','Clear stored tokens and disconnect?')">🗑️ Clear tokens</button>
          </div>${actions}
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
          <button type="button" class="btn btn-secondary" onclick="vicare('/reauth')">🔄 Try again</button>
        </div>${actions}
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
  // Always log the URL first (issue #3): in Docker/Umbrel/other containers the
  // process runs as root without systemd variables, xdg-open does not exist and the
  // URL was never shown, making the OAuth flow unrecoverable.
  this.log.info('='.repeat(80));
  this.log.info('🔐 AUTHENTICATION REQUIRED');
  this.log.info('='.repeat(80));
  this.log.info('');
  this.log.info('📱 Open this URL from ANY device on your network:');
  this.log.info('');
  this.log.info(`   ${url}`);
  this.log.info('');
  this.log.info(`🌐 Or open the dashboard and press "Log in": http://${this.hostIp}:${this.config.redirectPort || 4200}`);
  this.log.info('⏳ Waiting for authentication...');
  this.log.info('='.repeat(80));

  // Try to open a local browser only on interactive desktop installs
  const isSystemdService = !!(process.env.SYSTEMD_EXEC_PID || process.env.INVOCATION_ID);
  const isHomebridge = process.env.USER === 'homebridge';
  const isContainer = require('fs').existsSync('/.dockerenv') || !!process.env.container;
  if (isSystemdService || isHomebridge || isContainer) {
    return;
  }
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
      this.log.info(`📱 Could not open a browser automatically — open the URL above manually: ${url}`);
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