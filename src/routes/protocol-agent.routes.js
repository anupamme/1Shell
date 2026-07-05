'use strict';

const { Router } = require('express');

// 协议 agent 目录 REST 面：Agent 板块的 agent 切换器数据源（M2）。
function createProtocolAgentRouter({ protocolAgentService }) {
  const router = Router();

  router.get('/agent/protocol/agents', (req, res, next) => {
    try {
      res.json({ ok: true, agents: protocolAgentService.listAgents() });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createProtocolAgentRouter };
