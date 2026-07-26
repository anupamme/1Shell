'use strict';

const express = require('express');
const {
  validateCompletionRequestBody,
  validateAnalyzeSelectionBody,
} = require('../utils/validators');
const { createRateLimiter } = require('../middleware/rate-limiter.middleware');

function createAiRouter(aiService) {
  const router = express.Router();

  // AI 接口限流：每 IP 每分钟最多 30 次请求
  const aiLimiter = createRateLimiter({ windowMs: 60000, maxRequests: 30 });

  router.post('/complete', aiLimiter, async (req, res, next) => {
    try {
      const completion = await aiService.requestCompletion(validateCompletionRequestBody(req.body));
      res.json({ completion });
    } catch (error) {
      next(error);
    }
  });

  router.post('/ai/terminal/analyze-selection', aiLimiter, async (req, res, next) => {
    try {
      const result = await aiService.analyzeSelection(validateAnalyzeSelectionBody(req.body));
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = {
  createAiRouter,
};
