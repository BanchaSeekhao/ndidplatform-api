/**
 * Copyright (c) 2018, 2019 National Digital ID COMPANY LIMITED
 *
 * This file is part of NDID software.
 *
 * NDID is the free software: you can redistribute it and/or modify it under
 * the terms of the Affero GNU General Public License as published by the
 * Free Software Foundation, either version 3 of the License, or any later
 * version.
 *
 * NDID is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the Affero GNU General Public License for more details.
 *
 * You should have received a copy of the Affero GNU General Public License
 * along with the NDID source code. If not, see https://www.gnu.org/licenses/agpl.txt.
 *
 * Please contact info@ndid.co.th for any further questions
 *
 */

import express from 'express';

import { validateBody } from './middleware/validation';
import * as ndid from '../core/ndid';

const router = express.Router();

router.post('/initNDID', async (req, res, next) => {
  try {
    const {
      public_key,
      public_key_type,
      master_public_key,
      master_public_key_type,
    } = req.body;

    await ndid.initNDID({
      public_key,
      public_key_type,
      master_public_key,
      master_public_key_type,
    });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.post('/approveService', async (req, res, next) => {
  try {
    await ndid.approveService(req.body);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.post('/registerNode', async (req, res, next) => {
  try {
    const {
      node_id,
      node_name,
      public_key,
      public_key_type,
      master_public_key,
      master_public_key_type,
      role,
      max_aal,
      max_ial,
    } = req.body;

    await ndid.registerNode(
      {
        node_id,
        node_name,
        public_key,
        public_key_type,
        master_public_key,
        master_public_key_type,
        role,
        max_aal,
        max_ial,
      },
      { synchronous: true }
    );

    res.status(201).end();
  } catch (error) {
    next(error);
  }
});

router.post('/updateNode', async (req, res, next) => {
  try {
    const {
      node_id,
      node_name,
      // role,
      max_aal,
      max_ial,
    } = req.body;

    await ndid.updateNode(
      {
        node_id,
        node_name,
        // role,
        max_aal,
        max_ial,
      },
      { synchronous: true }
    );

    res.status(200).end();
  } catch (error) {
    next(error);
  }
});

router.post('/setNodeToken', async (req, res, next) => {
  try {
    const { node_id, amount } = req.body;

    await ndid.setNodeToken({
      node_id,
      amount,
    });

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.post('/addNodeToken', async (req, res, next) => {
  try {
    const { node_id, amount } = req.body;

    await ndid.addNodeToken({
      node_id,
      amount,
    });

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.post('/reduceNodeToken', async (req, res, next) => {
  try {
    const { node_id, amount } = req.body;

    await ndid.reduceNodeToken({
      node_id,
      amount,
    });

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.post('/namespaces', async (req, res, next) => {
  try {
    const { namespace, description } = req.body;

    if (namespace === 'requests' || namespace === 'housekeeping') {
      res.status(400).json({
        message:
          'Input namespace cannot be reserved words ("requests" and "housekeeping")',
      });
      return;
    }

    await ndid.addNamespace({
      namespace,
      description,
    });
    res.status(201).end();
  } catch (error) {
    next(error);
  }
});

router.delete('/namespaces/:namespace', async (req, res, next) => {
  try {
    const { namespace } = req.params;

    await ndid.deleteNamespace({
      namespace,
    });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.post('/services', async (req, res, next) => {
  try {
    const { service_id, service_name } = req.body;

    await ndid.addService({
      service_id,
      service_name,
    });
    res.status(201).end();
  } catch (error) {
    next(error);
  }
});

router.post('/services/:service_id', async (req, res, next) => {
  try {
    const { service_name } = req.body;
    const { service_id } = req.params;

    await ndid.updateService({
      service_id,
      service_name,
    });
    res.status(201).end();
  } catch (error) {
    next(error);
  }
});

router.delete('/services/:service_id', async (req, res, next) => {
  try {
    const { service_id } = req.params;

    await ndid.deleteService({
      service_id,
    });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.post('/validator', async (req, res, next) => {
  try {
    const { public_key, power } = req.body;

    await ndid.setValidator({
      public_key,
      power,
    });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.post('/setTimeoutBlockRegisterMqDestination', async (req, res, next) => {
  try {
    const { blocks_to_timeout } = req.body;

    await ndid.setTimeoutBlockRegisterMqDestination({
      blocks_to_timeout,
    });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.post('/enableServiceDestination', async (req, res, next) => {
  try {
    const { service_id, node_id } = req.body;

    await ndid.enableServiceDestination({
      service_id,
      node_id,
    });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.post('/disableServiceDestination', async (req, res, next) => {
  try {
    const { service_id, node_id } = req.body;

    await ndid.disableServiceDestination({
      service_id,
      node_id,
    });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

export default router;
