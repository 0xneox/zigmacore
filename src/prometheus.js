/**
 * Prometheus Monitoring Integration
 * Provides metrics endpoints for observability with Prometheus/Grafana
 */

class PrometheusMetrics {
  constructor() {
    this.metrics = {
      counters: {},
      gauges: {},
      histograms: {},
      summaries: {}
    };
    
    this.labels = {};
    this.startTime = Date.now();
  }

  /**
   * Increment a counter metric
   */
  incrementCounter(name, value = 1, labels = {}) {
    const key = this.getMetricKey(name, labels);
    if (!this.metrics.counters[key]) {
      this.metrics.counters[key] = { name, value: 0, labels };
    }
    this.metrics.counters[key].value += value;
  }

  /**
   * Set a gauge metric value
   */
  setGauge(name, value, labels = {}) {
    const key = this.getMetricKey(name, labels);
    this.metrics.gauges[key] = { name, value, labels };
  }

  /**
   * Observe a value for a histogram
   */
  observeHistogram(name, value, labels = {}, buckets = [0.1, 0.5, 1, 2.5, 5, 10]) {
    const key = this.getMetricKey(name, labels);
    if (!this.metrics.histograms[key]) {
      this.metrics.histograms[key] = { name, values: [], labels, buckets };
    }
    this.metrics.histograms[key].values.push(value);
  }

  /**
   * Observe a value for a summary
   */
  observeSummary(name, value, labels = {}) {
    const key = this.getMetricKey(name, labels);
    if (!this.metrics.summaries[key]) {
      this.metrics.summaries[key] = { name, values: [], labels };
    }
    this.metrics.summaries[key].values.push(value);
  }

  /**
   * Get metric key with labels
   */
  getMetricKey(name, labels) {
    const labelStr = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');
    return labelStr ? `${name}{${labelStr}}` : name;
  }

  /**
   * Format labels for Prometheus
   */
  formatLabels(labels) {
    if (!labels || Object.keys(labels).length === 0) return '';
    const labelStr = Object.entries(labels)
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');
    return `{${labelStr}}`;
  }

  /**
   * Generate Prometheus format output
   */
  generatePrometheusOutput() {
    let output = [];
    
    // Add metadata
    output.push('# HELP zigma_uptime_seconds Uptime of the Zigma server in seconds');
    output.push('# TYPE zigma_uptime_seconds gauge');
    output.push(`zigma_uptime_seconds ${(Date.now() - this.startTime) / 1000}`);
    output.push('');

    // Counters
    Object.values(this.metrics.counters).forEach(metric => {
      const labels = this.formatLabels(metric.labels);
      output.push(`# HELP zigma_${metric.name}_total Total count of ${metric.name}`);
      output.push(`# TYPE zigma_${metric.name}_total counter`);
      output.push(`zigma_${metric.name}_total${labels} ${metric.value}`);
    });

    // Gauges
    Object.values(this.metrics.gauges).forEach(metric => {
      const labels = this.formatLabels(metric.labels);
      output.push(`# HELP zigma_${metric.name} Current value of ${metric.name}`);
      output.push(`# TYPE zigma_${metric.name} gauge`);
      output.push(`zigma_${metric.name}${labels} ${metric.value}`);
    });

    // Histograms
    Object.values(this.metrics.histograms).forEach(metric => {
      const labels = this.formatLabels(metric.labels);
      const sortedValues = metric.values.sort((a, b) => a - b);
      
      output.push(`# HELP zigma_${metric.name} Histogram of ${metric.name}`);
      output.push(`# TYPE zigma_${metric.name} histogram`);
      
      // Bucket counts
      metric.buckets.forEach(bucket => {
        const count = sortedValues.filter(v => v <= bucket).length;
        output.push(`zigma_${metric.name}_bucket${labels} ${count}`);
      });
      
      // +Inf bucket
      output.push(`zigma_${metric.name}_bucket${labels} ${sortedValues.length}`);
      output.push(`zigma_${metric.name}_sum${labels} ${sortedValues.reduce((a, b) => a + b, 0)}`);
      output.push(`zigma_${metric.name}_count${labels} ${sortedValues.length}`);
    });

    // Summaries
    Object.values(this.metrics.summaries).forEach(metric => {
      const labels = this.formatLabels(metric.labels);
      const sortedValues = metric.values.sort((a, b) => a - b);
      const count = sortedValues.length;
      
      output.push(`# HELP zigma_${metric.name} Summary of ${metric.name}`);
      output.push(`# TYPE zigma_${metric.name} summary`);
      
      // Quantiles
      const quantiles = [0.5, 0.9, 0.95, 0.99];
      quantiles.forEach(q => {
        const index = Math.floor(q * (count - 1));
        const value = count > 0 ? sortedValues[index] : 0;
        output.push(`zigma_${metric.name}{quantile="${q}"${labels.length > 0 ? ', ' + labels.slice(1, -1) : ''}} ${value}`);
      });
      
      output.push(`zigma_${metric.name}_sum${labels} ${sortedValues.reduce((a, b) => a + b, 0)}`);
      output.push(`zigma_${metric.name}_count${labels} ${count}`);
    });

    return output.join('\n');
  }

  /**
   * Record HTTP request
   */
  recordHttpRequest(method, route, statusCode, duration) {
    this.incrementCounter('http_requests_total', 1, { method, route, status: statusCode });
    this.observeHistogram('http_request_duration_seconds', duration / 1000, { method, route });
  }

  /**
   * Record LLM request
   */
  recordLLMRequest(provider, model, tokens, duration, success) {
    this.incrementCounter('llm_requests_total', 1, { provider, model, success: success.toString() });
    this.incrementCounter('llm_tokens_total', tokens, { provider, model });
    this.observeHistogram('llm_request_duration_seconds', duration / 1000, { provider, model });
  }

  /**
   * Record market data fetch
   */
  recordMarketDataFetch(source, markets, duration, success) {
    this.incrementCounter('market_data_fetches_total', 1, { source, success: success.toString() });
    this.setGauge('market_data_markets_fetched', markets, { source });
    this.observeHistogram('market_data_fetch_duration_seconds', duration / 1000, { source });
  }

  /**
   * Record user analysis
   */
  recordUserAnalysis(duration, positions, trades) {
    this.incrementCounter('user_analyses_total', 1);
    this.setGauge('user_analysis_positions', positions);
    this.setGauge('user_analysis_trades', trades);
    this.observeHistogram('user_analysis_duration_seconds', duration / 1000);
  }

  /**
   * Record error
   */
  recordError(code, message) {
    this.incrementCounter('errors_total', 1, { code });
  }

  /**
   * Get current metrics as JSON
   */
  getMetricsJSON() {
    return {
      uptime: (Date.now() - this.startTime) / 1000,
      counters: this.metrics.counters,
      gauges: this.metrics.gauges,
      histograms: this.metrics.histograms,
      summaries: this.metrics.summaries
    };
  }

  /**
   * Reset all metrics
   */
  reset() {
    this.metrics = {
      counters: {},
      gauges: {},
      histograms: {},
      summaries: {}
    };
    this.startTime = Date.now();
  }
}

// Singleton instance
const prometheusMetrics = new PrometheusMetrics();

module.exports = prometheusMetrics;
