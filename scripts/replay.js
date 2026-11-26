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

if (process.argv[1] && process.argv[1].endsWith('replay.js')) {
  runReplay();
}
