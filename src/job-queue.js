/**
 * Job Queue for Async Processing
 * Provides a queue system for background tasks with priority and retry logic
 */

const EventEmitter = require('events');

class Job {
  constructor(id, type, data, options = {}) {
    this.id = id;
    this.type = type;
    this.data = data;
    this.priority = options.priority || 'normal';
    this.attempts = 0;
    this.maxAttempts = options.maxAttempts || 3;
    this.delay = options.delay || 0;
    this.timeout = options.timeout || 30000;
    this.createdAt = Date.now();
    this.startedAt = null;
    this.completedAt = null;
    this.status = 'pending';
    this.result = null;
    this.error = null;
  }
}

class JobQueue extends EventEmitter {
  constructor(options = {}) {
    super();
    this.concurrency = options.concurrency || 3;
    this.maxQueueSize = options.maxQueueSize || 1000;
    this.queues = {
      high: [],
      normal: [],
      low: []
    };
    this.activeJobs = new Map();
    this.completedJobs = new Map();
    this.failedJobs = new Map();
    this.isProcessing = false;
    this.jobIdCounter = 0;
  }

  /**
   * Add a job to the queue
   */
  async add(type, data, options = {}) {
    if (this.getTotalQueueSize() >= this.maxQueueSize) {
      throw new Error('Queue is full');
    }

    const jobId = `job_${++this.jobIdCounter}_${Date.now()}`;
    const job = new Job(jobId, type, data, options);

    const priority = job.priority || 'normal';
    this.queues[priority].push(job);

    this.emit('job:added', job);
    this.process();

    return jobId;
  }

  /**
   * Process jobs from the queue
   */
  async process() {
    if (this.isProcessing || this.activeJobs.size >= this.concurrency) {
      return;
    }

    this.isProcessing = true;

    while (this.activeJobs.size < this.concurrency) {
      const job = this.getNextJob();
      if (!job) {
        break;
      }

      this.activeJobs.set(job.id, job);
      this.runJob(job);
    }

    this.isProcessing = false;
  }

  /**
   * Get next job from queue (priority-based)
   */
  getNextJob() {
    if (this.queues.high.length > 0) {
      return this.queues.high.shift();
    }
    if (this.queues.normal.length > 0) {
      return this.queues.normal.shift();
    }
    if (this.queues.low.length > 0) {
      return this.queues.low.shift();
    }
    return null;
  }

  /**
   * Run a single job
   */
  async runJob(job) {
    job.status = 'running';
    job.startedAt = Date.now();
    this.emit('job:started', job);

    try {
      const handler = this.getJobHandler(job.type);
      if (!handler) {
        throw new Error(`No handler for job type: ${job.type}`);
      }

      const result = await Promise.race([
        handler(job.data),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Job timeout')), job.timeout)
        )
      ]);

      job.status = 'completed';
      job.completedAt = Date.now();
      job.result = result;
      this.completedJobs.set(job.id, job);
      this.emit('job:completed', job);

    } catch (error) {
      job.attempts++;
      job.error = error;

      if (job.attempts < job.maxAttempts) {
        job.status = 'retrying';
        this.emit('job:retry', job);
        
        // Re-queue with delay
        setTimeout(() => {
          this.queues[job.priority].push(job);
          this.process();
        }, job.delay * job.attempts);

      } else {
        job.status = 'failed';
        job.completedAt = Date.now();
        this.failedJobs.set(job.id, job);
        this.emit('job:failed', job);
      }
    } finally {
      this.activeJobs.delete(job.id);
      this.process();
    }
  }

  /**
   * Register a job handler
   */
  registerHandler(type, handler) {
    this.handlers = this.handlers || {};
    this.handlers[type] = handler;
  }

  /**
   * Get job handler
   */
  getJobHandler(type) {
    return this.handlers?.[type];
  }

  /**
   * Get job status
   */
  getJobStatus(jobId) {
    const active = this.activeJobs.get(jobId);
    if (active) return active;

    const completed = this.completedJobs.get(jobId);
    if (completed) return completed;

    const failed = this.failedJobs.get(jobId);
    if (failed) return failed;

    // Check queues
    for (const priority of ['high', 'normal', 'low']) {
      const job = this.queues[priority].find(j => j.id === jobId);
      if (job) return job;
    }

    return null;
  }

  /**
   * Get queue statistics
   */
  getStats() {
    return {
      queueSize: this.getTotalQueueSize(),
      activeJobs: this.activeJobs.size,
      completedJobs: this.completedJobs.size,
      failedJobs: this.failedJobs.size,
      queues: {
        high: this.queues.high.length,
        normal: this.queues.normal.length,
        low: this.queues.low.length
      },
      concurrency: this.concurrency
    };
  }

  /**
   * Get total queue size
   */
  getTotalQueueSize() {
    return this.queues.high.length + this.queues.normal.length + this.queues.low.length;
  }

  /**
   * Clear completed jobs
   */
  clearCompleted() {
    this.completedJobs.clear();
  }

  /**
   * Clear failed jobs
   */
  clearFailed() {
    this.failedJobs.clear();
  }

  /**
   * Pause processing
   */
  pause() {
    this.isPaused = true;
    this.emit('queue:paused');
  }

  /**
   * Resume processing
   */
  resume() {
    this.isPaused = false;
    this.emit('queue:resumed');
    this.process();
  }
}

// Singleton instance
const jobQueue = new JobQueue();

// Register default handlers
jobQueue.registerHandler('fetch-market-data', async (data) => {
  // Handler for fetching market data
  const { fetcher } = require('./fetcher');
  return await fetcher.fetchMarketData(data.marketId);
});

jobQueue.registerHandler('analyze-user', async (data) => {
  // Handler for user analysis
  const { analyzeUserProfile } = require('./user_analysis');
  return await analyzeUserProfile(data.walletAddress);
});

jobQueue.registerHandler('generate-signals', async (data) => {
  // Handler for signal generation
  const { generateSignals } = require('./market_analysis');
  return await generateSignals(data.markets);
});

jobQueue.registerHandler('send-notification', async (data) => {
  // Handler for sending notifications
  console.log('[JobQueue] Sending notification:', data);
  return { sent: true };
});

module.exports = jobQueue;
