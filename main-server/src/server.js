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

import 'source-map-support/register';

import 'dotenv/config';
import mkdirp from 'mkdirp';

import './env_var_validate';

import * as httpServer from './http_server';
import * as node from './node';
import * as coreCommon from './core/common';
import * as rp from './core/rp';
import * as idp from './core/idp';
import * as as from './core/as';
import * as proxy from './core/proxy';
import * as nodeKey from './utils/node_key';
import { getFunction } from './functions';

import * as cacheDb from './db/cache';
import * as longTermDb from './db/long_term';
import * as dataDb from './db/data';
import * as tendermint from './tendermint';
import * as tendermintWsPool from './tendermint/ws_pool';
import * as mq from './mq';
import * as callbackUtil from './callback';
import * as externalCryptoService from './external_crypto_service';
import * as jobMaster from './master-worker-interface/server';
import * as jobWorker from './master-worker-interface/client';
import * as prometheus from './prometheus';

import logger from './logger';

import { version } from './version';
import MODE from './mode';
import * as config from './config';

process.on('unhandledRejection', function(reason, p) {
  if (reason && reason.name === 'CustomError') {
    logger.error({
      message: 'Unhandled Rejection',
      p,
    });
    logger.error({ err: reason });
  } else {
    logger.error({
      message: 'Unhandled Rejection',
      p,
      reason: reason.stack || reason,
    });
  }
});

async function initialize() {
  logger.info({ message: 'Initializing server' });
  try {
    if (config.mode === MODE.MASTER) {
      await jobMaster.initialize();
      logger.info({ message: 'Waiting for available worker' });
      await new Promise((resolve) =>
        jobMaster.eventEmitter.once('worker_connected', () => resolve())
      );
    } else if (config.mode === MODE.WORKER) {
      await jobWorker.initialize();
    }

    tendermint.loadSavedData();

    await Promise.all([
      cacheDb.initialize(),
      longTermDb.initialize(),
      dataDb.initialize(),
    ]);

    if (config.prometheusEnabled) {
      prometheus.initialize();
    }

    if (config.ndidNode) {
      tendermint.setWaitForInitEndedBeforeReady(false);
    }
    tendermint.setTxResultCallbackFnGetter(getFunction);

    const tendermintReady = new Promise((resolve) =>
      tendermint.eventEmitter.once('ready', (status) => resolve(status))
    );

    await tendermint.connectWS();
    const tendermintStatusOnSync = await tendermintReady;

    let role;
    if (!config.ndidNode) {
      logger.info({ message: 'Getting node role' });
      role = await node.getNodeRoleFromBlockchain();
      logger.info({ message: 'Node role', role });
    }

    if (role === 'rp') {
      if (config.mode === MODE.STANDALONE || config.mode === MODE.MASTER) {
        mq.setMessageHandlerFunction(rp.handleMessageFromQueue);
      }
      tendermint.setTendermintNewBlockEventHandler(rp.handleTendermintNewBlock);
      await rp.checkCallbackUrls();
    } else if (role === 'idp') {
      if (config.mode === MODE.STANDALONE || config.mode === MODE.MASTER) {
        mq.setMessageHandlerFunction(idp.handleMessageFromQueue);
      }
      tendermint.setTendermintNewBlockEventHandler(
        idp.handleTendermintNewBlock
      );
      await idp.checkCallbackUrls();
    } else if (role === 'as') {
      if (config.mode === MODE.STANDALONE || config.mode === MODE.MASTER) {
        mq.setMessageHandlerFunction(as.handleMessageFromQueue);
      }
      tendermint.setTendermintNewBlockEventHandler(as.handleTendermintNewBlock);
      await as.checkCallbackUrls();
    } else if (role === 'proxy') {
      if (config.mode === MODE.STANDALONE || config.mode === MODE.MASTER) {
        mq.setMessageHandlerFunction(proxy.handleMessageFromQueue);
      }
      tendermint.setTendermintNewBlockEventHandler(
        proxy.handleTendermintNewBlock
      );
      await rp.checkCallbackUrls();
      await idp.checkCallbackUrls();
      await as.checkCallbackUrls();
    }

    callbackUtil.setShouldRetryFnGetter(getFunction);
    callbackUtil.setResponseCallbackFnGetter(getFunction);

    let externalCryptoServiceReady;
    if (config.useExternalCryptoService) {
      await externalCryptoService.checkCallbackUrls();
      if (!(await externalCryptoService.isCallbackUrlsSet())) {
        externalCryptoServiceReady = new Promise((resolve) =>
          externalCryptoService.eventEmitter.once('allCallbacksSet', () =>
            resolve()
          )
        );
      }
    } else {
      await nodeKey.initialize();
    }

    if (config.mode === MODE.STANDALONE || config.mode === MODE.WORKER) {
      httpServer.initialize();
    }

    if (externalCryptoServiceReady != null) {
      logger.info({ message: 'Waiting for DPKI callback URLs to be set' });
      await externalCryptoServiceReady;
    }

    if (role === 'rp' || role === 'idp' || role === 'as' || role === 'proxy') {
      mq.setErrorHandlerFunction(
        coreCommon.getHandleMessageQueueErrorFn(() => {
          if (role === 'rp') {
            return 'rp.getErrorCallbackUrl';
          } else if (role === 'idp') {
            return 'idp.getErrorCallbackUrl';
          } else if (role === 'as') {
            return 'as.getErrorCallbackUrl';
          } else if (role === 'proxy') {
            return 'proxy.getErrorCallbackUrl';
          }
        })
      );
      if (config.mode === MODE.STANDALONE) {
        await mq.initialize();
      } else if (config.mode === MODE.MASTER) {
        await mq.initializeInbound();
      } else if (config.mode === MODE.WORKER) {
        await mq.initializeOutbound(false);
      }
    }

    await tendermint.initialize();

    if (role === 'rp' || role === 'idp' || role === 'proxy') {
      let nodeIds;
      if (role === 'rp') {
        nodeIds = [config.nodeId];
      } else if (role === 'idp') {
        nodeIds = [config.nodeId];
      } else if (role === 'proxy') {
        const nodesBehindProxy = await node.getNodesBehindProxyWithKeyOnProxy();
        nodeIds = nodesBehindProxy.map((node) => node.node_id);
      }
      await coreCommon.resumeTimeoutScheduler(nodeIds);
    }

    if (role === 'rp' || role === 'idp' || role === 'as' || role === 'proxy') {
      if (config.mode === MODE.STANDALONE || config.mode === MODE.WORKER) {
        await coreCommon.setMessageQueueAddress();
      }
      if (config.mode === MODE.STANDALONE || config.mode === MODE.MASTER) {
        await mq.loadAndProcessBacklogMessages();
      }
    }

    if (config.mode === MODE.STANDALONE || config.mode === MODE.MASTER) {
      tendermint.processMissingBlocks(tendermintStatusOnSync);
      await tendermint.loadExpectedTxFromDB();
      tendermint.loadAndRetryBacklogTransactRequests();

      callbackUtil.resumeCallbackToClient();
    }

    logger.info({ message: 'Server initialized' });
  } catch (error) {
    logger.error({
      message: 'Cannot initialize server',
      err: error,
    });
    // shutDown();
  }
}

const {
  privateKeyPassphrase, // eslint-disable-line no-unused-vars
  masterPrivateKeyPassphrase, // eslint-disable-line no-unused-vars
  dbPassword, // eslint-disable-line no-unused-vars
  ...configToLog
} = config;
logger.info({
  message: 'Starting server',
  version,
  NODE_ENV: process.env.NODE_ENV,
  config: configToLog,
});

// Make sure data and log directories exist
mkdirp.sync(config.dataDirectoryPath);
// mkdirp.sync(config.logDirectoryPath);

// Graceful Shutdown
let shutDownCalledOnce = false;
async function shutDown() {
  if (shutDownCalledOnce) {
    logger.error({
      message: 'Forcefully shutting down',
    });
    process.exit(1);
  }
  shutDownCalledOnce = true;

  logger.info({
    message: 'Received kill signal, shutting down gracefully',
  });
  console.log('(Ctrl+C again to force shutdown)');

  await prometheus.stop();
  await httpServer.close();
  callbackUtil.stopAllCallbackRetries();
  externalCryptoService.stopAllCallbackRetries();
  await mq.close();
  tendermint.tendermintWsClient.close();
  tendermintWsPool.closeAllConnections();
  coreCommon.stopAllTimeoutScheduler();

  if (config.mode === MODE.MASTER) {
    jobMaster.shutdown();
  } else if (config.mode === MODE.WORKER) {
    await jobWorker.shutdown();
  }
  // TODO: wait for async operations which going to use DB to finish before closing
  // a connection to DB
  // Possible solution: Have those async operations append a queue to use DB and
  // remove after finish using DB
  // => Wait here until a queue to use DB is empty
  await Promise.all([cacheDb.close(), longTermDb.close(), dataDb.close()]);
}

process.on('SIGTERM', shutDown);
process.on('SIGINT', shutDown);

initialize();
