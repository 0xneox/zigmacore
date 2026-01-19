require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function getHistoricalTrades() {
  try {
    console.log('Fetching historical executable trades from Supabase...\n');

    const { data, error } = await supabase
      .from('cycle_snapshots')
      .select('data')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      console.error('Error fetching data:', error);
      return;
    }

    if (!data || data.length === 0) {
      console.log('No cycle snapshots found');
      return;
    }

    console.log(`Found ${data.length} cycle snapshots\n`);
    console.log('='.repeat(80));

    let totalExecutableTrades = 0;

    for (let i = 0; i < data.length; i++) {
      const snapshot = data[i];
      const cycleData = snapshot.data;

      if (!cycleData) continue;

      const timestamp = cycleData.lastRun || cycleData.cycleSummary?.timestamp || 'Unknown';
      const liveSignals = cycleData.liveSignals || [];
      const cycleSummary = cycleData.cycleSummary || {};

      if (liveSignals.length > 0) {
        console.log(`\n📅 Cycle: ${timestamp}`);
        console.log(`   Executable Trades: ${liveSignals.length}`);
        console.log(`   Markets Fetched: ${cycleSummary.marketsFetched || 'N/A'}`);
        console.log(`   Signals Generated: ${cycleSummary.signalsGenerated || 'N/A'}`);
        console.log('-'.repeat(80));

        liveSignals.forEach((trade, idx) => {
          totalExecutableTrades++;
          console.log(`\n   Trade #${totalExecutableTrades}:`);
          console.log(`   Market: ${trade.marketQuestion || trade.market || 'Unknown'}`);
          console.log(`   Action: ${trade.action}`);
          console.log(`   Price: ${trade.price ? (trade.price * 100).toFixed(1) + '%' : 'N/A'}`);
          console.log(`   Edge: ${trade.edgeScore ? trade.edgeScore.toFixed(2) + '%' : 'N/A'}`);
          console.log(`   Confidence: ${trade.confidence || trade.modelConfidence || 'N/A'}%`);
          console.log(`   Kelly: ${trade.kellyFraction ? (trade.kellyFraction * 100).toFixed(2) + '%' : 'N/A'}`);
          console.log(`   Trade Tier: ${trade.tradeTier || 'N/A'}`);
          console.log(`   Link: ${trade.link || 'N/A'}`);
        });

        console.log('\n' + '='.repeat(80));
      }
    }

    console.log(`\n\n📊 SUMMARY:`);
    console.log(`Total Executable Trades Found: ${totalExecutableTrades}`);
    console.log(`Total Cycles Analyzed: ${data.length}`);

    // Save all data to JSON file
    const outputFile = path.join(__dirname, 'historical_trades.json');
    const allTrades = [];

    for (let i = 0; i < data.length; i++) {
      const snapshot = data[i];
      const cycleData = snapshot.data;
      if (!cycleData) continue;

      const liveSignals = cycleData.liveSignals || [];
      if (liveSignals.length > 0) {
        liveSignals.forEach(trade => {
          allTrades.push({
            timestamp: cycleData.lastRun || cycleData.cycleSummary?.timestamp,
            marketQuestion: trade.marketQuestion || trade.market,
            action: trade.action,
            price: trade.price,
            edge: trade.edgeScore,
            confidence: trade.confidence || trade.modelConfidence,
            kelly: trade.kellyFraction,
            tradeTier: trade.tradeTier,
            link: trade.link
          });
        });
      }
    }

    fs.writeFileSync(outputFile, JSON.stringify(allTrades, null, 2));
    console.log(`\n✅ All trades saved to: ${outputFile}`);

  } catch (error) {
    console.error('Error:', error);
  }
}

getHistoricalTrades();
