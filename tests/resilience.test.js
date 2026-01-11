const { safeApiCall, getCircuitBreakerStatus } = require('../src/resilience');

describe('resilience', () => {
  describe('safeApiCall', () => {
    it('should successfully execute API call', async () => {
      const mockApiCall = jest.fn().mockResolvedValue({ success: true });
      const result = await safeApiCall('test', mockApiCall);
      expect(result).toEqual({ success: true });
    });

    it('should retry on failure', async () => {
      const mockApiCall = jest.fn()
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValue({ success: true });
      
      const result = await safeApiCall('test', mockApiCall);
      expect(result).toEqual({ success: true });
      expect(mockApiCall).toHaveBeenCalledTimes(2);
    });

    it('should throw error after max retries', async () => {
      const mockApiCall = jest.fn().mockRejectedValue(new Error('Persistent error'));
      
      await expect(safeApiCall('test', mockApiCall)).rejects.toThrow();
      expect(mockApiCall).toHaveBeenCalledTimes(4); // initial + 3 retries
    });

    it('should open circuit breaker after threshold failures', async () => {
      const mockApiCall = jest.fn().mockRejectedValue(new Error('Service down'));
      
      // Trigger circuit breaker
      for (let i = 0; i < 5; i++) {
        try {
          await safeApiCall('test', mockApiCall);
        } catch (e) {
          // Expected to fail
        }
      }
      
      const status = getCircuitBreakerStatus();
      expect(status.test?.state).toBe('open');
    });
  });

  describe('getCircuitBreakerStatus', () => {
    it('should return circuit breaker status for all services', () => {
      const status = getCircuitBreakerStatus();
      expect(status).toHaveProperty('polymarket');
      expect(status).toHaveProperty('x');
      expect(status).toHaveProperty('llm');
      expect(status).toHaveProperty('acp');
    });

    it('should return state object with required properties', () => {
      const status = getCircuitBreakerStatus();
      expect(status.polymarket).toHaveProperty('failures');
      expect(status.polymarket).toHaveProperty('lastFailure');
      expect(status.polymarket).toHaveProperty('state');
    });
  });
});
