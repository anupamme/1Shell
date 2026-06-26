'use strict';

const express = require('express');

function createPanelWorkloadsRouter({ panelWorkloadsService }) {
  const router = express.Router();

  router.get('/panel/workloads/summary', async (req, res, next) => {
    try {
      const result = await panelWorkloadsService.getWorkloadsSummary({
        includeArchived: req.query.includeArchived === '1',
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/panel/hosts/:hostId/workloads', async (req, res, next) => {
    try {
      const result = await panelWorkloadsService.getHostWorkloads(req.params.hostId);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/panel/hosts/:hostId/workloads/:workloadId/actions', async (req, res, next) => {
    try {
      const result = await panelWorkloadsService.runWorkloadAction(
        req.params.hostId,
        req.params.workloadId,
        req.body?.action,
        {
          workload: req.body?.workload,
          timeoutMs: req.body?.timeoutMs,
          clientIp: req.ip,
        },
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/panel/containers/summary', async (req, res, next) => {
    try {
      const result = await panelWorkloadsService.getWorkloadsSummary({
        includeArchived: req.query.includeArchived === '1',
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/panel/hosts/:hostId/containers', async (req, res, next) => {
    try {
      const result = await panelWorkloadsService.getHostWorkloads(req.params.hostId);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = {
  createPanelWorkloadsRouter,
};
