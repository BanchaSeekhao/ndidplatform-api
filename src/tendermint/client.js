import fetch from 'node-fetch';

import CustomError from '../error/customError';
import errorType from '../error/type';

import { tendermintAddress } from '../config';

async function httpUriCall(method, params) {
  const queryString = params.reduce((paramsString, param) => {
    if (param.key == null || param.value == null) {
      return paramsString;
    }
    const uriEncodedParamValue = encodeURIComponent(param.value);
    if (paramsString !== '') {
      return paramsString + `&${param.key}="${uriEncodedParamValue}"`;
    }
    return paramsString + `${param.key}="${uriEncodedParamValue}"`;
  }, '');

  let uri = `http://${tendermintAddress}/${method}`;
  if (params.length > 0) {
    uri = uri + `?${queryString}`;
  }

  try {
    const response = await fetch(uri);
    const responseJson = await response.json();
    return responseJson;
  } catch (error) {
    throw new CustomError({
      message: errorType.TENDERMINT_HTTP_CALL_ERROR.message,
      code: errorType.TENDERMINT_HTTP_CALL_ERROR.code,
      details: {
        uri,
      },
      cause: error,
    });
  }
}

export function abciQuery(data) {
  return httpUriCall('abci_query', [
    {
      key: 'data',
      value: data,
    },
  ]);
}

export function broadcastTxCommit(tx) {
  return httpUriCall('broadcast_tx_commit', [
    {
      key: 'tx',
      value: tx,
    },
  ]);
}

export function status() {
  return httpUriCall('status');
}
