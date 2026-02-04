/**
 * Test script for historical calibration system
 * Run: node src/test-calibration.js
 */

require('dotenv').config();
const { logCalibrationReport, getCalibrationSummary, calculateConfidenceBinCalibration } = require('./historical-calibration');

async function testCalibration() {
  console.log('🧪 Testing Historical Calibration System\n');
  
  try {
    // Test 1: Get calibration summary
    console.log('Test 1: Fetching calibration summary...');
    const summary = await getCalibrationSummary();
    console.log('Summary:', JSON.stringify(summary, null, 2));
    
    // Test 2: Calculate bin calibration for all categories
    console.log('\nTest 2: Calculating confidence bin calibration (all categories)...');
    await calculateConfidenceBinCalibration();
    
    // Test 3: Calculate bin calibration for specific categories
    console.log('\nTest 3: Calculating confidence bin calibration by category...');
    const categories = ['CRYPTO', 'POLITICS', 'SPORTS_FUTURES', 'EVENT'];
    
    for (const category of categories) {
      console.log(`\n--- ${category} ---`);
      try {
        await calculateConfidenceBinCalibration(category);
      } catch (error) {
        console.log(`No data for ${category}: ${error.message}`);
      }
    }
    
    // Test 4: Full calibration report
    console.log('\nTest 4: Generating full calibration report...');
    await logCalibrationReport();
    
    console.log('\n✅ All tests completed successfully!');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    console.error(error.stack);
  }
  
  process.exit(0);
}

testCalibration();
