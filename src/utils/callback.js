import fetch from 'node-fetch';
import { ExponentialBackoff } from 'simple-backoff';

import { randomBase64Bytes } from './crypto';

import { wait } from '../utils';
import * as db from '../db';
import logger from '../logger';

const waitStopFunction = [];
let stopCallbackRetry = false;

/**
 * Make a HTTP POST to callback url with body
 * @param {string} callbackUrl
 * @param {Object} body
 */
function httpPost(callbackUrl, body) {
  return fetch(callbackUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function callbackWithRetry(
  callbackUrl,
  body,
  cbId,
  responseCallback,
  dataForResponseCallback
) {
  const backoff = new ExponentialBackoff({
    min: 1000,
    max: 60000,
    factor: 2,
    jitter: 0.2,
  });

  for (;;) {
    if (stopCallbackRetry) return;
    try {
      const response = await httpPost(callbackUrl, body);
      db.removeCallbackWithRetryData(cbId);
      if (responseCallback) {
        responseCallback(response, dataForResponseCallback);
      }
      return;
    } catch (error) {
      const nextRetry = backoff.next();

      logger.error({
        message: `Cannot send callback to client application. Retrying in ${nextRetry} milliseconds`,
        error,
      });

      const { promise: waitPromise, stopWaiting } = wait(nextRetry, true);
      waitStopFunction.push(stopWaiting);
      await waitPromise;
      waitStopFunction.splice(waitStopFunction.indexOf(stopWaiting), 1);
    }
  }
}

/**
 * Send callback to client application
 * @param {string} callbackUrl
 * @param {Object} body
 * @param {boolean} retry
 * @param {function} responseCallback
 * @param {Object} dataForResponseCallback
 */
export async function callbackToClient(
  callbackUrl,
  body,
  retry,
  responseCallback,
  dataForResponseCallback
) {
  if (retry) {
    const cbId = randomBase64Bytes(10);
    await db.addCallbackWithRetryData(cbId, {
      callbackUrl,
      body,
      dataForResponseCallback,
    });
    callbackWithRetry(
      callbackUrl,
      body,
      cbId,
      responseCallback,
      dataForResponseCallback
    );
  } else {
    try {
      await httpPost(callbackUrl, body);
    } catch (error) {
      logger.error({
        message: 'Cannot send callback to client application',
        error,
      });
    }
  }
}

/**
 * Resume all cached retry callback
 * This function should be called only when server starts
 * @param {function} responseCallback
 */
export async function resumeCallbackToClient(responseCallback) {
  const callbackDatum = await db.getAllCallbackWithRetryData();
  callbackDatum.forEach((callback) =>
    callbackWithRetry(
      callback.data.callbackUrl,
      callback.data.body,
      callback.cbId,
      responseCallback,
      callback.data.dataForResponseCallback
    )
  );
}

export function stopAllCallbackRetries() {
  stopCallbackRetry = true;
  waitStopFunction.forEach((stopWaiting) => stopWaiting());
  logger.info({
    message: 'Stopped all callback retries',
  });
}
