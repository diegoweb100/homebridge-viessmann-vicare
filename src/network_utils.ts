import { Logger } from 'homebridge';

export class NetworkUtils {
  constructor(private readonly log: Logger) {}

  /**
   * Detect the local IP address for OAuth redirect
   */
  public detectLocalIP(): string {
    const { networkInterfaces } = require('os');
    const nets = networkInterfaces();
    
    // Try to find the first non-internal IPv4 address
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        // Skip over non-IPv4 and internal (i.e. 127.0.0.1) addresses
        if (net.family === 'IPv4' && !net.internal) {
          this.log.debug(`Detected local IP: ${net.address}`);
          return net.address;
        }
      }
    }
    
    // Fallback to localhost
    this.log.warn('Could not detect local IP, using localhost');
    return 'localhost';
  }

  /**
   * Open browser for OAuth authentication
   */
  public openBrowser(url: string): void {
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
          // Try multiple browsers
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

  /**
   * Validate IP address format
   */
  public isValidIPv4(ip: string): boolean {
    const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    return ipv4Regex.test(ip);
  }

  /**
   * Validate port number
   */
  public isValidPort(port: number): boolean {
    return port >= 1024 && port <= 65535;
  }

  /**
   * Check if running in headless environment
   */
  public isHeadlessEnvironment(): boolean {
    // Check if we're in a headless environment
    if (!process.env.DISPLAY && process.platform === 'linux') {
      return true;
    }

    // Check if we're in Docker
    if (process.env.DOCKER || process.env.CONTAINER) {
      return true;
    }

    // Check if we're running as a service (systemd)
    if (process.env.SYSTEMD_EXEC_PID || process.env.INVOCATION_ID) {
      return true;
    }

    return false;
  }

  /**
   * Get environment info for logging
   */
  public getEnvironmentInfo(): {
    platform: string;
    isHeadless: boolean;
    hasDisplay: boolean;
    isDocker: boolean;
    isSystemd: boolean;
  } {
    return {
      platform: process.platform,
      isHeadless: this.isHeadlessEnvironment(),
      hasDisplay: !!process.env.DISPLAY,
      isDocker: !!(process.env.DOCKER || process.env.CONTAINER),
      isSystemd: !!(process.env.SYSTEMD_EXEC_PID || process.env.INVOCATION_ID)
    };
  }
}