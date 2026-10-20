const { test, expect } = require('@playwright/test');
const express = require('express');
const contract = require('../../fixtures/ai-impact/strategy-review-architecture-skipped.json');

test('completed strategy review retains skip and dissent through bulk ingest @ai-impact', async ({ request }) => {
  // Isolated HTTP integration: actual feature router and internal forwarding,
  // with a local releases receiver. No deployed service or credentials needed.
  const app = express();
  app.use(express.json());
  const forwarded = [];
  app.post('/api/modules/releases/execution/ai-review/bulk', (req, res) => {
    forwarded.push(req.body);
    res.json({ created: 0, updated: 1, unchanged: 0 });
  });
  const server = await new Promise(resolve => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value));
  });
  const previousPort = process.env.API_PORT;
  const previousDemo = process.env.DEMO_MODE;
  process.env.API_PORT = String(server.address().port);
  process.env.DEMO_MODE = 'false';
  try {
    const register = require('../../modules/ai-impact/server/features/routes');
    const router = express.Router();
    register(router, {
      storage: { readFromStorage: async () => null },
      requireAdmin: (req, res, next) => next(),
      requireScope: () => (req, res, next) => next()
    });
    app.use('/api/modules/ai-impact', router);
    const url = `http://127.0.0.1:${server.address().port}/api/modules/ai-impact/features/bulk`;
    const response = await request.post(url, { data: structuredClone(contract) });
    expect(response.ok()).toBe(true);
    expect(await response.json()).toMatchObject({ updated: 1, errors: [] });
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].features[0].aiReview).toMatchObject({
      recommendation: 'approve', needsAttention: false, reviewers: contract.features[0].reviewers
    });
    const pending = structuredClone(contract);
    pending.features[0].reviewers.feasibility = 'pending';
    const rejected = await request.post(url, { data: pending });
    const result = await rejected.json();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].errors.join(' ')).toContain('reviewers.feasibility');
    expect(forwarded).toHaveLength(1);
  } finally {
    if (previousPort === undefined) delete process.env.API_PORT;
    else process.env.API_PORT = previousPort;
    if (previousDemo === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = previousDemo;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
