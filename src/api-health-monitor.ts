import { Logger } from 'homebridge';

export interface APIMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  rateLimitHits: number;
  averageResponseTime: number;
  lastSuccessfulRequest: number;
  lastFailedRequest: number;
  healthScore: number;
  uptime: number;
  requestsPerMinute: number;
  errorRate: number;
  lastResetTime: number;
}

export interface PerformanceSnapshot {
  timestamp: number;
  healthScore: number;
  responseTime: number;
  successRate: number;
  rateLimitActive: boolean;
}

export class APIHealthMonitor {
  private metrics: APIMetrics = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    rateLimitHits: 0,
    averageResponseTime: 0,
    lastSuccessfulRequest: 0,
    lastFailedRequest: 0,
    healthScore: 100,
    uptime: 0,
    requestsPerMinute: 0,
    errorRate: 0,
    lastResetTime: Date.now()
  };
  private responseTimes: number[] = [];
  private requestTimestamps: number[] = [];
  private performanceHistory: PerformanceSnapshot[] = [];
  private readonly maxHistorySize = 100;
  private readonly maxResponseTimeHistory = 50;
  private readonly startTime: number;

  constructor(private readonly log: Logger) {
    this.startTime = Date.now();
    this.resetMetrics();
  }

  private resetMetrics(): void {
    this.metrics = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      rateLimitHits: 0,
      averageResponseTime: 0,
      lastSuccessfulRequest: 0,
      lastFailedRequest: 0,
      healthScore: 100,
      uptime: 0,
      requestsPerMinute: 0,
      errorRate: 0,
      lastResetTime: Date.now()
    };
  }

  public recordRequest(success: boolean, responseTime: number): void {
    const now = Date.now();
    
    // Validazione input
    if (typeof success !== 'boolean' || typeof responseTime !== 'number' || responseTime < 0) {
      this.log.warn('Invalid parameters passed to recordRequest');
      return;
    }
    
    this.metrics.totalRequests++;
    this.requestTimestamps.push(now);
    
    if (success) {
      this.metrics.successfulRequests++;
      this.metrics.lastSuccessfulRequest = now;
    } else {
      this.metrics.failedRequests++;
      this.metrics.lastFailedRequest = now;
    }
    
    // Track response times
    this.responseTimes.push(responseTime);
    if (this.responseTimes.length > this.maxResponseTimeHistory) {
      this.responseTimes.shift();
    }
    
    // Clean old request timestamps (keep only last hour)
    const oneHourAgo = now - (60 * 60 * 1000);
    this.requestTimestamps = this.requestTimestamps.filter(timestamp => timestamp > oneHourAgo);
    
    this.updateCalculatedMetrics();
    this.recordPerformanceSnapshot();
  }

  public recordRateLimit(): void {
    this.metrics.rateLimitHits++;
    this.updateCalculatedMetrics();
  }

  private updateCalculatedMetrics(): void {
    const now = Date.now();
    
    // Calculate average response time
    if (this.responseTimes.length > 0) {
      this.metrics.averageResponseTime = this.responseTimes.reduce((sum, time) => sum + time, 0) / this.responseTimes.length;
    }
    
    // Calculate error rate
    if (this.metrics.totalRequests > 0) {
      this.metrics.errorRate = (this.metrics.failedRequests / this.metrics.totalRequests) * 100;
    }
    
    // Calculate requests per minute (based on last hour)
    const oneMinuteAgo = now - (60 * 1000);
    const recentRequests = this.requestTimestamps.filter(timestamp => timestamp > oneMinuteAgo);
    this.metrics.requestsPerMinute = recentRequests.length;
    
    // Calculate uptime
    this.metrics.uptime = now - this.startTime;
    
    // Calculate health score
    this.metrics.healthScore = this.calculateHealthScore();
  }

  private calculateHealthScore(): number {
    const now = Date.now();
    const recentWindow = 5 * 60 * 1000; // 5 minutes
    const recentRequests = this.requestTimestamps.filter(timestamp => timestamp > (now - recentWindow));
    
    if (recentRequests.length === 0) {
      // No recent activity - neutral score
      return 75;
    }
    
    // Calculate success rate for recent requests - FIX: Migliorata la logica
    const recentWindowStart = now - recentWindow;
    const recentSuccesses = this.requestTimestamps.filter(timestamp => {
      return timestamp > recentWindowStart && timestamp <= this.metrics.lastSuccessfulRequest;
    }).length;
    
    const recentSuccessRate = recentRequests.length > 0 ? recentSuccesses / recentRequests.length : 0;
    
    // Factors affecting health score
    let score = 100;
    
    // Success rate impact (0-40 points)
    score -= (1 - recentSuccessRate) * 40;
    
    // Response time impact (0-20 points)
    if (this.metrics.averageResponseTime > 5000) { // > 5 seconds
      score -= 20;
    } else if (this.metrics.averageResponseTime > 2000) { // > 2 seconds
      score -= 10;
    }
    
    // Rate limiting impact (0-30 points)
    const recentRateLimitWindow = 10 * 60 * 1000; // 10 minutes
    const hasRecentRateLimit = this.metrics.rateLimitHits > 0 && 
      (this.metrics.lastFailedRequest > (now - recentRateLimitWindow));
    
    if (hasRecentRateLimit) {
      score -= 30;
    }
    
    // Recent activity impact (0-10 points)
    const timeSinceLastSuccess = now - this.metrics.lastSuccessfulRequest;
    if (timeSinceLastSuccess > 10 * 60 * 1000) { // > 10 minutes
      score -= 10;
    }
    
    return Math.max(0, Math.min(100, score));
  }

  private recordPerformanceSnapshot(): void {
    const now = Date.now();
    const snapshot: PerformanceSnapshot = {
      timestamp: now,
      healthScore: this.metrics.healthScore,
      responseTime: this.metrics.averageResponseTime,
      successRate: this.metrics.totalRequests > 0 ? (this.metrics.successfulRequests / this.metrics.totalRequests) * 100 : 0,
      rateLimitActive: (now - this.metrics.lastFailedRequest) < (5 * 60 * 1000) && this.metrics.rateLimitHits > 0
    };
    
    this.performanceHistory.push(snapshot);
    
    if (this.performanceHistory.length > this.maxHistorySize) {
      this.performanceHistory.shift();
    }
  }

  public getHealthScore(): number {
    return Math.round(this.metrics.healthScore);
  }

  public getMetrics(): APIMetrics {
    this.updateCalculatedMetrics();
    return { ...this.metrics };
  }

  public getPerformanceHistory(): PerformanceSnapshot[] {
    return [...this.performanceHistory];
  }

  public getHealthStatus(): 'excellent' | 'good' | 'fair' | 'poor' | 'critical' {
    const score = this.getHealthScore();
    
    if (score >= 95) return 'excellent';
    if (score >= 85) return 'good';
    if (score >= 70) return 'fair';
    if (score >= 50) return 'poor';
    return 'critical';
  }

  public getDetailedStatus(): {
    status: string;
    score: number;
    issues: string[];
    recommendations: string[];
    emoji: string;
  } {
    const score = this.getHealthScore();
    const metrics = this.getMetrics();
    const issues: string[] = [];
    const recommendations: string[] = [];
    const now = Date.now();
    
    // Analyze issues
    if (metrics.errorRate > 10) {
      issues.push(`High error rate: ${metrics.errorRate.toFixed(1)}%`);
      recommendations.push('Check API credentials and network connectivity');
    }
    
    if (metrics.averageResponseTime > 5000) {
      issues.push(`Slow response times: ${(metrics.averageResponseTime / 1000).toFixed(1)}s average`);
      recommendations.push('Consider increasing cache TTL or reducing refresh frequency');
    }
    
    if (metrics.rateLimitHits > 0 && (now - metrics.lastFailedRequest) < (10 * 60 * 1000)) {
      issues.push('Recent rate limiting detected');
      recommendations.push('Increase refresh intervals and enable aggressive caching');
    }
    
    if (metrics.lastSuccessfulRequest > 0 && (now - metrics.lastSuccessfulRequest) > (10 * 60 * 1000)) {
      issues.push('No recent successful requests');
      recommendations.push('Check authentication status and API connectivity');
    }
    
    if (metrics.requestsPerMinute > 10) {
      issues.push(`High request rate: ${metrics.requestsPerMinute} requests/minute`);
      recommendations.push('Consider implementing more aggressive caching');
    }
    
    // Determine status and emoji
    let status: string;
    let emoji: string;
    
    if (score >= 95) {
      status = 'Excellent';
      emoji = '🟢';
    } else if (score >= 85) {
      status = 'Good';
      emoji = '🟡';
    } else if (score >= 70) {
      status = 'Fair';
      emoji = '🟠';
    } else if (score >= 50) {
      status = 'Poor';
      emoji = '🔴';
    } else {
      status = 'Critical';
      emoji = '💀';
    }
    
    return {
      status,
      score,
      issues,
      recommendations,
      emoji
    };
  }

  public logHealthReport(): void {
    const status = this.getDetailedStatus();
    const metrics = this.getMetrics();
    
    this.log.info('='.repeat(60));
    this.log.info(`${status.emoji} API HEALTH REPORT - ${status.status} (${status.score}/100)`);
    this.log.info('='.repeat(60));
    
    // Basic metrics
    this.log.info(`📊 Request Statistics:`);
    this.log.info(`  • Total requests: ${metrics.totalRequests}`);
    this.log.info(`  • Success rate: ${metrics.totalRequests > 0 ? ((metrics.successfulRequests / metrics.totalRequests) * 100).toFixed(1) : 0}%`);
    this.log.info(`  • Error rate: ${metrics.errorRate.toFixed(1)}%`);
    this.log.info(`  • Rate limit hits: ${metrics.rateLimitHits}`);
    
    // Performance metrics
    this.log.info(`⚡ Performance:`);
    this.log.info(`  • Average response time: ${(metrics.averageResponseTime / 1000).toFixed(2)}s`);
    this.log.info(`  • Requests per minute: ${metrics.requestsPerMinute}`);
    this.log.info(`  • Uptime: ${this.formatUptime(metrics.uptime)}`);
    
    // Last activity
    if (metrics.lastSuccessfulRequest > 0) {
      const lastSuccessAgo = (Date.now() - metrics.lastSuccessfulRequest) / 1000;
      this.log.info(`  • Last successful request: ${lastSuccessAgo < 60 ? `${lastSuccessAgo.toFixed(0)}s` : `${(lastSuccessAgo / 60).toFixed(1)}m`} ago`);
    }
    
    // Issues and recommendations
    if (status.issues.length > 0) {
      this.log.info(`⚠️ Issues Detected:`);
      status.issues.forEach(issue => this.log.info(`  • ${issue}`));
      
      this.log.info(`💡 Recommendations:`);
      status.recommendations.forEach(rec => this.log.info(`  • ${rec}`));
    } else {
      this.log.info(`✅ No issues detected - API is performing well`);
    }
    
    this.log.info('='.repeat(60));
  }

  private formatUptime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) {
      return `${days}d ${hours % 24}h ${minutes % 60}m`;
    } else if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  public resetMetricsIfNeeded(): void {
    const now = Date.now();
    const resetInterval = 24 * 60 * 60 * 1000; // 24 hours
    
    if ((now - this.metrics.lastResetTime) > resetInterval) {
      this.log.info('📊 Daily metrics reset');
      this.resetMetrics();
    }
  }

  public exportPerformanceData(): {
    summary: APIMetrics;
    history: PerformanceSnapshot[];
    healthTrend: { timestamp: number; score: number }[];
  } {
    const healthTrend = this.performanceHistory.map(snapshot => ({
      timestamp: snapshot.timestamp,
      score: snapshot.healthScore
    }));
    
    return {
      summary: this.getMetrics(),
      history: this.getPerformanceHistory(),
      healthTrend
    };
  }

  /**
   * Cleanup method to free resources
   */
  public cleanup(): void {
    this.responseTimes = [];
    this.requestTimestamps = [];
    this.performanceHistory = [];
    this.log.debug('🧹 APIHealthMonitor cleanup completed');
  }
}