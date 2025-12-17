const { fetchMarkets } = require('../src/fetcher');
const axios = require('axios');

// Mock axios
jest.mock('axios');
const mockedAxios = axios;

describe('fetchMarkets', () => {
  it('should fetch markets from Gamma API', async () => {
    const mockData = [{ id: '1', question: 'Test market' }];
    mockedAxios.get.mockResolvedValue({ data: mockData });

    const result = await fetchMarkets(50);
    expect(mockedAxios.get).toHaveBeenCalledWith('https://gamma-api.polymarket.com/markets?closed=false&limit=50', { timeout: 8000 });
    expect(result).toEqual(mockData);
  });
});
