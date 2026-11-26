/**
 * Replay script: benchmarks simulated router savings by evaluating ~30 varied prompts.
 * Compares total cost using the cheap-vs-capable router vs routing all requests to always-capable tier.
 * 
 * NOTE ON SIMULATION:
 * This benchmark calculates estimated cost savings based on an assumed 150 output tokens
 * per response without performing automated qualitative evaluation of response accuracy.
 */

import { route } from '../src/router/route.js';
import { calculateCostPaise, estimateInputTokens } from '../src/budget/estimate.js';
import { env } from '../src/config/env.js';

// 30 varied prompts
const PROMPTS = [
  // 1-10: Simple / short queries (ideal for cheap tier)
  { id: 1, text: 'What is the capital of France?' },
  { id: 2, text: 'Translate "hello" to Spanish.' },
  { id: 3, text: 'Give me 3 synonyms for happy.' },
  { id: 4, text: 'What is 15 * 8?' },
  { id: 5, text: 'Who wrote Hamlet?' },
  { id: 6, text: 'Tell me a one-liner programming joke.' },
  { id: 7, text: 'What year did the Titanic sink?' },
  { id: 8, text: 'Define photosynthesis in one sentence.' },
  { id: 9, text: 'Convert 100 Celsius to Fahrenheit.' },
  { id: 10, text: 'Name three primary colors.' },

  // 11-18: Code and debugging prompts (capable tier)
  { id: 11, text: 'Write a python function to reverse a linked list in-place.' },
  { id: 12, text: 'Here is my code:\n```javascript\nfunction add(a, b) { return a + b; }\n```\nHow do I test this?' },
  { id: 13, text: 'Can you debug why this SQL query is throwing a syntax error?' },
  { id: 14, text: 'Design a database schema for an e-commerce shopping cart system.' },
  { id: 15, text: 'Explain how class inheritance works in ES6 JavaScript.' },
  { id: 16, text: 'import express from "express"; how do I write a rate-limiting middleware?' },
  { id: 17, text: 'Write a regex to validate an email address.' },
  { id: 18, text: 'Compare Docker containers with virtual machines in terms of kernel isolation.' },

  // 19-25: Multi-step reasoning / math / analysis (capable tier)
  { id: 19, text: 'Please analyze the macroeconomic effects of quantitative easing on developing economies.' },
  { id: 20, text: 'Prove mathematically that the square root of 2 is irrational step by step.' },
  { id: 21, text: 'Step by step solve this riddle: I speak without a mouth and hear without ears.' },
  { id: 22, text: 'Compare and contrast optimistic vs pessimistic locking with concrete PostgreSQL examples.' },
  { id: 23, text: 'Design a microservices architecture that handles 50,000 orders per second.' },
  { id: 24, text: 'Analyze this business contract clause for potential IP ownership liabilities.' },
  { id: 25, text: 'Debug this concurrency race condition where two bank transfers deadlock.' },

  // 26-30: Miscellaneous prompts
  { id: 26, text: 'Write a polite thank-you email for a job interview.' },
  { id: 27, text: 'Summarize the plot of Inception in two sentences.' },
  { id: 28, text: 'What is the speed of sound in dry air at 20 degrees Celsius?' },
  { id: 29, text: 'What are the main ingredients in a traditional pizza Margherita?' },
  { id: 30, text: 'Give me 5 tips to improve sleep hygiene.' }
];

export function runReplay() {
  let routerTotalCostPaise = 0;
  let alwaysCapableTotalCostPaise = 0;
  let cheapTierCount = 0;
  let capableTierCount = 0;

  console.log('='.repeat(70));
  console.log('SIMULATED ROUTER REPLAY BENCHMARK: 30 VARIED PROMPTS');
  console.log('(Assumes 150 output tokens; qualitative response check not performed)');
  console.log('='.repeat(70));

  for (const item of PROMPTS) {
    const messages = [{ role: 'user', content: item.text }];
    const routing = route({ messages }, env);
    const estIn = estimateInputTokens(messages);
    const estOut = 150; // Constant assumption

    const costPaise = calculateCostPaise(routing.model, estIn, estOut);
    routerTotalCostPaise += costPaise;

    const capableCostPaise = calculateCostPaise(env.MODEL_CAPABLE, estIn, estOut);
    alwaysCapableTotalCostPaise += capableCostPaise;

    if (routing.tier === 'cheap') {
      cheapTierCount++;
    } else {
      capableTierCount++;
    }

    console.log(
      `[#${item.id.toString().padStart(2)}] Tier: ${routing.tier.padEnd(7)} | Model: ${routing.model.padEnd(21)} | Reason: ${routing.reason.padEnd(25)} | Cost: ${costPaise}p`
    );
  }

  const savingsPaise = alwaysCapableTotalCostPaise - routerTotalCostPaise;
  const savingsPercent = ((savingsPaise / alwaysCapableTotalCostPaise) * 100).toFixed(1);

  console.log('='.repeat(70));
  console.log(`Total Prompts Evaluated:   ${PROMPTS.length}`);
  console.log(`Routed to Cheap Tier:      ${cheapTierCount} (${((cheapTierCount / PROMPTS.length) * 100).toFixed(1)}%)`);
  console.log(`Routed to Capable Tier:    ${capableTierCount} (${((capableTierCount / PROMPTS.length) * 100).toFixed(1)}%)`);
  console.log(`Always-Capable Spend:      ${alwaysCapableTotalCostPaise} paise (₹${(alwaysCapableTotalCostPaise / 100).toFixed(2)})`);
  console.log(`Routed Gateway Spend:      ${routerTotalCostPaise} paise (₹${(routerTotalCostPaise / 100).toFixed(2)})`);
  console.log(`Net Simulated Savings:     ${savingsPaise} paise (₹${(savingsPaise / 100).toFixed(2)}) -> ${savingsPercent}% SAVINGS`);
  console.log('QUALITY CAVEAT: Response quality was NOT evaluated. This benchmark measures cost and token metrics only.');
  console.log('='.repeat(70));

  return {
    totalPrompts: PROMPTS.length,
    cheapCount: cheapTierCount,
    capableCount: capableTierCount,
    routerSpendPaise: routerTotalCostPaise,
    alwaysCapableSpendPaise: alwaysCapableTotalCostPaise,
    savingsPaise,
    savingsPercent
  };
}

export async function runLiveReplay() {
  const { app } = await import('../src/server.js');
  const { pool } = await import('../src/db/pool.js');
  const request = (await import('supertest')).default;

  console.log('='.repeat(70));
  console.log('LIVE GATEWAY REPLAY BENCHMARK (MEASURED VIA POSTGRES USAGE_LOGS)');
  console.log('QUALITY CAVEAT: Response quality was NOT qualitatively evaluated.');
  console.log('='.repeat(70));

  // 1. Create a temporary benchmark virtual key with 50,000 paise (₹500) budget
  const createRes = await request(app)
    .post('/admin/keys')
    .set('Authorization', `Bearer ${env.ADMIN_SECRET}`)
    .send({ name: 'benchmark-replay-key', budget_paise: 50000 });

  const testKey = createRes.body.key;
  const testKeyId = createRes.body.id;

  try {
    let cheapCount = 0;
    let capableCount = 0;

    for (const item of PROMPTS) {
      const messages = [{ role: 'user', content: item.text }];
      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${testKey}`)
        .send({ model: 'auto', messages });

      const model = res.headers['x-gateway-model'];
      const reason = res.headers['x-gateway-route-reason'];
      const cost = Number(res.headers['x-gateway-cost-paise'] || 0);

      if (model === env.MODEL_CHEAP) cheapCount++;
      else capableCount++;

      console.log(
        `[#${item.id.toString().padStart(2)}] Model: ${(model || 'err').padEnd(21)} | Reason: ${(reason || 'err').padEnd(25)} | Cost: ${cost}p | Status: ${res.status}`
      );
    }

    // Query usage_logs table to verify source of truth in PostgreSQL
    const logSum = await pool.query(
      'SELECT COUNT(*)::int as count, SUM(cost_paise)::bigint as total_cost, SUM(tokens_in)::int as tokens_in, SUM(tokens_out)::int as tokens_out FROM usage_logs WHERE api_key_id = $1',
      [testKeyId]
    );
    const row = logSum.rows[0];

    console.log('='.repeat(70));
    console.log(`Live Replay Finished (${row.count} requests executed through gateway)`);
    console.log(`Measured Total Cost from usage_logs: ${row.total_cost} paise (₹${(Number(row.total_cost) / 100).toFixed(2)})`);
    console.log(`Total Tokens: In=${row.tokens_in}, Out=${row.tokens_out}`);
    console.log(`Routed to Cheap: ${cheapCount}, Capable: ${capableCount}`);
    console.log('QUALITY CAVEAT: Response quality was NOT evaluated across tiers.');
    console.log('='.repeat(70));
  } finally {
    // Teardown temporary benchmark records
    await pool.query('DELETE FROM usage_logs WHERE api_key_id = $1', [testKeyId]);
    await pool.query('DELETE FROM api_keys WHERE id = $1', [testKeyId]);
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith('replay.js')) {
  if (process.argv.includes('--live')) {
    runLiveReplay();
  } else {
    runReplay();
  }
}
