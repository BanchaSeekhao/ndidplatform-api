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

import EventEmitter from 'events';

import fetch from 'node-fetch';
import { ExponentialBackoff } from 'simple-backoff';

import { randomBase64Bytes } from './crypto';

import { wait } from '.';
import * as cacheDb from '../db/cache';
import logger from '../logger';
import CustomError from 'ndid-error/custom_error';
import errorType from 'ndid-error/type';
import * as config from '../config';

import MODE from '../mode';

const RESPONSE_BODY_SIZE_LIMIT = 3 * 1024 * 1024; // 3MB

const waitPromises = [];
let stopCallbackRetry = false;

let getShouldRetryFn;
let getResponseCallbackFn;

let pendingCallbacksCount = 0;
let pendingCallback = {};

export const metricsEventEmitter = new EventEmitter();

export function setShouldRetryFnGetter(fn) {
  if (typeof fn !== 'function') {
    throw new Error('Invalid argument type. Must be function.');
  }
  getShouldRetryFn = fn;
}

export function setResponseCallbackFnGetter(fn) {
  if (typeof fn !== 'function') {
    throw new Error('Invalid argument type. Must be function.');
  }
  getResponseCallbackFn = fn;
}

/**
 * Make a HTTP POST to callback url with body
 *
 * @param {string} callbackUrl
 * @param {Object} body
 */
async function httpPost(cbId, callbackUrl, body) {
  const response = await fetch(callbackUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    size: RESPONSE_BODY_SIZE_LIMIT,
  });

  const responseBody = await response.text();

  logger.info({
    message: 'Got callback response',
    cbId,
    httpStatusCode: response.status,
  });
  logger.debug({
    message: 'Callback response body',
    cbId,
    body: responseBody,
  });

  return {
    response,
    body: responseBody,
  };
}

export async function handleCallbackWorkerLost(
  cbId,
  deadline,
) {
  let backupCallbackData = await cacheDb.getCallbackWithRetryData(config.nodeId, cbId);

  if(backupCallbackData) {
    const {
      callbackUrl,
      body,
      shouldRetryFnName,
      shouldRetryArguments,
      responseCallbackFnName,
      dataForResponseCallback,
    } = backupCallbackData;

    callbackWithRetry(
      callbackUrl,
      body,
      cbId,
      shouldRetryFnName,
      shouldRetryArguments,
      responseCallbackFnName,
      dataForResponseCallback,
      deadline,
    );
  }
}

async function callbackWithRetry(
  callbackUrl,
  body,
  cbId,
  shouldRetryFnName,
  shouldRetryArguments = [],
  responseCallbackFnName,
  dataForResponseCallback,
  deadline,
) {
  incrementPendingCallbacksCount();

  const backoff = new ExponentialBackoff({
    min: 5000,
    max: 180000,
    factor: 2,
    jitter: 0.2,
  });

  const startTime = Date.now();

  //tell master about timerJob
  if(config.mode === MODE.WORKER) {
    pendingCallback[cbId] = { 
      deadline: deadline || Date.now() + config.callbackRetryTimeout * 1000,
    };
  }

  for (;;) {
    if (stopCallbackRetry) return;
    logger.info({
      message: 'Sending a callback with retry',
      url: callbackUrl,
      cbId,
    });
    logger.debug({
      message: 'Callback data in body',
      body,
      cbId,
    });
    try {
      const responseObj = await httpPost(cbId, callbackUrl, body);

      if(config.mode === MODE.WORKER) {
        delete pendingCallback[cbId];
      }

      decrementPendingCallbacksCount();
      metricsEventEmitter.emit(
        'callbackTime',
        responseObj.response.status,
        responseObj.body !== '',
        Date.now() - startTime
      );
      cacheDb.removeCallbackWithRetryData(config.nodeId, cbId);
      if (responseCallbackFnName) {
        getResponseCallbackFn(responseCallbackFnName)(
          responseObj,
          dataForResponseCallback
        );
      }
      return;
    } catch (error) {
      const nextRetry = backoff.next();

      logger.error({
        message: 'Cannot send callback to client application',
        err: error,
        cbId,
      });

      if (error.name === 'FetchError' && error.type === 'max-size') {
        decrementPendingCallbacksCount();
        cacheDb.removeCallbackWithRetryData(config.nodeId, cbId);
        if (responseCallbackFnName) {
          getResponseCallbackFn(responseCallbackFnName)(
            {
              error: new CustomError({
                errorType: errorType.BODY_TOO_LARGE,
              }),
            },
            dataForResponseCallback
          );
        }
        metricsEventEmitter.emit('callbackFail');
        return;
      }

      if (shouldRetryFnName) {
        let shouldRetry;
        try {
          shouldRetry = await getShouldRetryFn(shouldRetryFnName)(
            ...shouldRetryArguments
          );
        } catch (error) {
          logger.debug({
            message:
              'Error calling should retry decision function. Will retry callback.',
            shouldRetryFnName,
          });
          shouldRetry = true;
        }
        if (!shouldRetry) {
          decrementPendingCallbacksCount();
          cacheDb.removeCallbackWithRetryData(config.nodeId, cbId);
          metricsEventEmitter.emit('callbackFail');
          return;
        }
      } else {
        if(!deadline || Date.now() < deadline) {
          if (
            Date.now() - startTime + nextRetry >
            config.callbackRetryTimeout * 1000
          ) {
            logger.warn({
              message: 'Callback retry timed out',
              url: callbackUrl,
              cbId,
            });
            decrementPendingCallbacksCount();
            cacheDb.removeCallbackWithRetryData(config.nodeId, cbId);
            metricsEventEmitter.emit('callbackTimedOut');
            return;
          }
        }
      }

      logger.info({
        message: `Retrying callback in ${nextRetry} milliseconds`,
        cbId,
      });

      const waitPromise = wait(nextRetry, true);
      waitPromises.push(waitPromise);
      await waitPromise;
      waitPromises.splice(waitPromises.indexOf(waitPromise), 1);
    }
  }
}

/**
 * Send callback to client application
 *
 * @param {string} callbackUrl
 * @param {Object} body
 * @param {boolean} retry
 * @param {function} shouldRetry
 * @param {Array} shouldRetryArguments
 * @param {function} responseCallback
 * @param {Object} dataForResponseCallback
 */
export async function callbackToClient(
  // FIXME: take "getCallbackUrl" function name as an argument instead of "callbackUrl".
  // Need to add more function name (string) mapping to function.
  callbackUrl,
  body,
  retry,
  shouldRetryFnName,
  shouldRetryArguments,
  responseCallbackFnName,
  dataForResponseCallback
) {
  const cbId = randomBase64Bytes(10);
  if (retry) {
    logger.info({
      message: 'Saving data for callback with retry',
      url: callbackUrl,
      cbId,
    });
    await cacheDb.setCallbackWithRetryData(config.nodeId, cbId, {
      callbackUrl,
      body,
      shouldRetryFnName,
      shouldRetryArguments,
      responseCallbackFnName,
      dataForResponseCallback,
    });
    callbackWithRetry(
      callbackUrl,
      body,
      cbId,
      shouldRetryFnName,
      shouldRetryArguments,
      responseCallbackFnName,
      dataForResponseCallback
    );
  } else {
    logger.info({
      message: 'Sending a callback without retry',
      url: callbackUrl,
      cbId,
    });
    logger.debug({
      message: 'Callback data in body',
      body,
      cbId,
    });
    const startTime = Date.now();
    try {
      const responseObj = await httpPost(cbId, callbackUrl, body);
      metricsEventEmitter.emit(
        'callbackTime',
        responseObj.response.status,
        responseObj.body !== '',
        Date.now() - startTime
      );
      if (responseCallbackFnName) {
        getResponseCallbackFn(responseCallbackFnName)(
          responseObj,
          dataForResponseCallback
        );
      }
    } catch (error) {
      logger.error({
        message: 'Cannot send callback to client application',
        err: error,
      });

      metricsEventEmitter.emit('callbackFail');

      if (error.name === 'FetchError' && error.type === 'max-size') {
        if (responseCallbackFnName) {
          getResponseCallbackFn(responseCallbackFnName)(
            {
              error: new CustomError({
                errorType: errorType.BODY_TOO_LARGE,
              }),
            },
            dataForResponseCallback
          );
        }
      }
    }
  }
}

/**
 * Resume all cached retry callback
 * This function should be called once on server start
 *
 * @param {function} responseCallback
 */
export async function resumeCallbackToClient() {
  const callbackDatum = await cacheDb.getAllCallbackWithRetryData(
    config.nodeId
  );
  callbackDatum.forEach((callback) =>
    callbackWithRetry(
      callback.data.callbackUrl,
      callback.data.body,
      callback.cbId,
      callback.data.shouldRetryFnName,
      callback.data.shouldRetryArguments,
      callback.data.responseCallbackFnName,
      callback.data.dataForResponseCallback
    )
  );
}

export function stopAllCallbackRetries() {
  stopCallbackRetry = true;
  waitPromises.forEach((waitPromise) => waitPromise.stop());
  logger.info({
    message: 'Stopped all callback retries',
  });
}

function incrementPendingCallbacksCount() {
  pendingCallbacksCount++;
  metricsEventEmitter.emit('pendingCallbacksCount', pendingCallbacksCount);
}

function decrementPendingCallbacksCount() {
  pendingCallbacksCount--;
  metricsEventEmitter.emit('pendingCallbacksCount', pendingCallbacksCount);
}

export function getPendingCallbacksCount() {
  return pendingCallbacksCount;
}

export function getCallbackPendingTimer() {
  return pendingCallback;
}
