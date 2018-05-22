import express from 'express';

import { validateBody } from './middleware/validation';
import * as abciAppRpApi from '../main/rp';
import * as abciAppCommonApi from '../main/common';
import * as db from '../db';

const router = express.Router();

router.post(
  '/requests/:namespace/:identifier',
  validateBody,
  async (req, res, next) => {
    try {
      const { namespace, identifier } = req.params;
      const {
        reference_id,
        idp_list,
        callback_url,
        data_request_list,
        request_message,
        min_ial,
        min_aal,
        min_idp,
        request_timeout,
      } = req.body;

      const requestId = await abciAppRpApi.createRequest({
        namespace,
        identifier,
        reference_id,
        idp_list,
        callback_url,
        data_request_list,
        request_message,
        min_ial,
        min_aal,
        min_idp,
        request_timeout,
      });

      if (!requestId) throw 'Cannot create request';
      res.status(200).json({ requestId });
    } catch (error) {
      res.status(500).end();
    }
  }
);

router.get('/requests/:request_id', async (req, res, next) => {
  try {
    const { request_id } = req.params;

    const request = await abciAppCommonApi.getRequest({
      requestId: request_id,
    });

    res.status(200).json(request);
  } catch (error) {
    res.status(500).end();
  }
});

router.get('/requests/reference/:reference_number', async (req, res, next) => {
  try {
    const { reference_number } = req.params;

    const requestId = await db.getRequestIdByReferenceId(reference_number);
    const status = requestId ? 200 : 404;

    res.status(status).json(requestId);
  } catch (error) {
    res.status(500).end();
  }
});

router.get('/requests/data/:request_id', async (req, res, next) => {
  try {
    const { request_id } = req.params;

    const data = await abciAppRpApi.getDataFromAS(request_id);
    res.status(200).json(data);
  } catch (error) {
    res.status(500).end();
  }
});

router.delete('/requests/data/:request_id', async (req, res, next) => {
  try {
    const { request_id } = req.params;

    await abciAppRpApi.removeDataFromAS(request_id);
    res.status(200).end();
  } catch (error) {
    res.status(500).end();
  }
});

router.delete('/requests/data', async (req, res, next) => {
  try {
    await abciAppRpApi.removeAllDataFromAS();
    res.status(200).end();
  } catch (error) {
    res.status(500).end();
  }
});

export default router;
