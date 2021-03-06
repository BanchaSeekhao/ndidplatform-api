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

import { processAsData } from './process_as_data';

import * as tendermintNdid from '../../tendermint/ndid';
import * as tendermint from '../../tendermint';
import * as common from '../common';
import * as nodeCallback from '../node_callback';
import * as utils from '../../utils';
import * as mq from '../../mq';
import * as cacheDb from '../../db/cache';
import * as dataDb from '../../db/data';
import { callbackToClient } from '../../callback';
import privateMessageType from '../../mq/message/type';
import CustomError from 'ndid-error/custom_error';
import errorType from 'ndid-error/type';
import logger from '../../logger';

import * as config from '../../config';
import { role } from '../../node';

export * from './event_handlers';
export * from './process_as_data';

const CALLBACK_URL_NAME = {
  ERROR: 'error_url',
};
const CALLBACK_URL_NAME_ARR = Object.values(CALLBACK_URL_NAME);

export async function checkCallbackUrls() {
  const callbackUrls = await getCallbackUrls();
  for (let i = 0; i < CALLBACK_URL_NAME_ARR.length; i++) {
    const callbackName = CALLBACK_URL_NAME_ARR[i];
    if (callbackUrls[callbackName] != null) {
      logger.info({
        message: `[RP] ${callbackName} callback url`,
        callbackUrl: callbackUrls[callbackName],
      });
    } else {
      logger.warn({
        message: `[RP] ${callbackName} callback url is not set`,
      });
    }
  }
}

export async function setCallbackUrls({ error_url }) {
  if (error_url != null) {
    await dataDb.setCallbackUrl(
      config.nodeId,
      `rp.${CALLBACK_URL_NAME.ERROR}`,
      error_url
    );
  }
}

export async function getCallbackUrls() {
  const callbackNames = CALLBACK_URL_NAME_ARR.map((name) => `rp.${name}`);
  const callbackUrlsArr = await dataDb.getCallbackUrls(
    config.nodeId,
    callbackNames
  );
  const callbackUrls = callbackUrlsArr.reduce((callbackUrlsObj, url, index) => {
    if (url != null) {
      return {
        ...callbackUrlsObj,
        [callbackNames[index].replace(/^rp\./, '')]: url,
      };
    } else {
      return callbackUrlsObj;
    }
  }, {});
  return callbackUrls;
}

export function getErrorCallbackUrl() {
  return dataDb.getCallbackUrl(config.nodeId, `rp.${CALLBACK_URL_NAME.ERROR}`);
}

export function isAllIdpResponsesValid(responseValidList) {
  for (let i = 0; i < responseValidList.length; i++) {
    const { valid_ial } = responseValidList[i];
    if (valid_ial !== true) {
      return false;
    }
  }
  return true;
}

export function isAllIdpRespondedAndValid({
  requestStatus,
  responseValidList,
}) {
  if (requestStatus.status !== 'confirmed') return false;
  if (requestStatus.answered_idp_count !== requestStatus.min_idp) return false;
  if (requestStatus.closed === true || requestStatus.timed_out === true)
    return false;
  const asAnswerCount = requestStatus.service_list.reduce(
    (total, service) => total + service.signed_data_count,
    0
  );
  if (asAnswerCount === 0) {
    // Send request to AS only when all IdP responses' IAL are valid in mode 3
    if (
      requestStatus.mode === 1 ||
      ((requestStatus.mode === 2 || requestStatus.mode === 3) &&
        isAllIdpResponsesValid(responseValidList))
    ) {
      return true;
    }
  }
  return false;
}

async function getASReceiverList(data_request) {
  const asNodes = await tendermintNdid.getAsNodesInfoByServiceId({
    service_id: data_request.service_id,
    node_id_list: data_request.as_id_list, // filter to include only nodes in this list if node ID exists
  });

  const receivers = asNodes
    .map((asNode) => {
      if (asNode.proxy != null) {
        if (asNode.proxy.mq == null) {
          return null;
        }
        return {
          node_id: asNode.node_id,
          public_key: asNode.public_key,
          proxy: {
            node_id: asNode.proxy.node_id,
            public_key: asNode.proxy.public_key,
            ip: asNode.proxy.mq[0].ip,
            port: asNode.proxy.mq[0].port,
            config: asNode.proxy.config,
          },
        };
      } else {
        if (asNode.mq == null) {
          return null;
        }
        return {
          node_id: asNode.node_id,
          public_key: asNode.public_key,
          ip: asNode.mq[0].ip,
          port: asNode.mq[0].port,
        };
      }
    })
    .filter((asNode) => asNode != null);
  return receivers;
}

export async function sendRequestToAS(nodeId, requestData, height) {
  logger.debug({
    message: 'Sending request to AS',
    nodeId,
    requestData,
    height,
  });

  if (requestData.data_request_list == null) return;
  if (requestData.data_request_list.length === 0) return;

  const [requestCreationMetadata, responsePrivateDataList] = await Promise.all([
    cacheDb.getRequestCreationMetadata(nodeId, requestData.request_id),
    cacheDb.getResponsePrivateDataListForRequest(
      nodeId,
      requestData.request_id
    ),
  ]);

  const dataToSendByNodeId = {};
  await Promise.all(
    requestData.data_request_list.map(async (data_request, index) => {
      const receivers = await getASReceiverList(data_request);
      if (receivers.length === 0) {
        logger.error({
          message: 'No AS found',
          data_request,
        });
        return;
      }

      const serviceDataRequest = {
        service_id: data_request.service_id,
        request_params: data_request.request_params,
        request_params_salt: requestData.data_request_params_salt_list[index],
      };
      receivers.forEach((receiver) => {
        if (dataToSendByNodeId[receiver.node_id]) {
          dataToSendByNodeId[receiver.node_id].service_data_request_list.push(
            serviceDataRequest
          );
          dataToSendByNodeId[receiver.node_id].concat_service_id_index +=
            '|' + index.toString();
        } else {
          dataToSendByNodeId[receiver.node_id] = {
            receiver,
            service_data_request_list: [serviceDataRequest],
            concat_service_id_index: index.toString(),
          };
        }
      });
    })
  );

  const dataToSendByNodeIdAndServiceList = {};
  Object.values(dataToSendByNodeId).forEach(
    ({ receiver, service_data_request_list, concat_service_id_index }) => {
      if (dataToSendByNodeIdAndServiceList[concat_service_id_index]) {
        dataToSendByNodeIdAndServiceList[
          concat_service_id_index
        ].receivers.push(receiver);
      } else {
        dataToSendByNodeIdAndServiceList[concat_service_id_index] = {
          receivers: [receiver],
          service_data_request_list,
        };
      }
    }
  );

  await Promise.all(
    Object.values(dataToSendByNodeIdAndServiceList).map(
      ({ receivers, service_data_request_list }) =>
        mq.send({
          receivers,
          message: {
            type: privateMessageType.DATA_REQUEST,
            request_id: requestData.request_id,
            mode: requestData.mode,
            namespace: requestData.namespace,
            identifier: requestData.identifier,
            service_data_request_list,
            request_message: requestData.request_message,
            request_message_salt: requestData.request_message_salt,
            response_private_data_list: responsePrivateDataList,
            creation_time: requestCreationMetadata.creation_time,
            request_timeout: requestData.request_timeout,
            rp_id: requestData.rp_id,
            initial_salt: requestData.initial_salt,
            chain_id: tendermint.chainId,
            height,
          },
          senderNodeId: nodeId,
          onSuccess: ({ mqDestAddress, receiverNodeId }) => {
            nodeCallback.notifyMessageQueueSuccessSend({
              nodeId,
              getCallbackUrlFnName:
                'nodeCallback.getMessageQueueSendSuccessCallbackUrl',
              destNodeId: receiverNodeId,
              destIp: mqDestAddress.ip,
              destPort: mqDestAddress.port,
              requestId: requestData.request_id,
            });
          },
        })
    )
  );
}

export async function processMessage(nodeId, messageId, message) {
  const requestId = message.request_id;
  logger.debug({
    message: 'Processing message',
    nodeId,
    messageId,
    requestId,
  });

  try {
    if (message.type === privateMessageType.IDP_RESPONSE) {
      const requestData = await cacheDb.getRequestData(
        nodeId,
        message.request_id
      );
      if (requestData != null) {
        // "accessor_id" is present only in mode 2,3
        if (message.mode === 2 || message.mode === 3) {
          //store accessor_id from EACH IdP, to pass along to AS
          await cacheDb.addResponsePrivateDataForRequest(
            nodeId,
            message.request_id,
            {
              idp_id: message.idp_id,
              accessor_id: message.accessor_id,
            }
          );
        }

        const requestDetail = await tendermintNdid.getRequestDetail({
          requestId: message.request_id,
          height: message.height,
        });

        const requestStatus = utils.getDetailedRequestStatus(requestDetail);

        if (requestStatus.closed || requestStatus.timed_out) {
          return;
        }

        const savedResponseValidList = await cacheDb.getIdpResponseValidList(
          nodeId,
          message.request_id
        );

        const responseValid = await common.getAndSaveIdpResponseValid({
          nodeId,
          requestStatus,
          idpId: message.idp_id,
          requestDataFromMq: message,
          responseIal: requestDetail.response_list.find(
            (response) => response.idp_id === message.idp_id
          ).ial,
        });

        const responseValidList = savedResponseValidList.concat([
          responseValid,
        ]);

        const eventDataForCallback = {
          node_id: nodeId,
          type: 'request_status',
          ...requestStatus,
          response_valid_list: responseValidList,
          block_height: `${requestDetail.creation_chain_id}:${message.height}`,
        };

        const callbackUrl = requestData.callback_url;
        await callbackToClient({
          callbackUrl,
          body: eventDataForCallback,
          retry: true,
        });

        if (isAllIdpRespondedAndValid({ requestStatus, responseValidList })) {
          const requestData = await cacheDb.getRequestData(
            nodeId,
            message.request_id
          );
          if (requestData != null) {
            await sendRequestToAS(nodeId, requestData, message.height);
          }
        }

        if (
          requestStatus.status === 'completed' &&
          !requestStatus.closed &&
          !requestStatus.timed_out &&
          (requestStatus.mode === 1 ||
            ((requestStatus.mode === 2 || requestStatus.mode === 3) &&
              isAllIdpResponsesValid(responseValidList)))
        ) {
          logger.debug({
            message: 'Automatically closing request',
            requestId: message.request_id,
          });
          await common.closeRequest(
            { node_id: nodeId, request_id: message.request_id },
            {
              synchronous: false,
              sendCallbackToClient: false,
              saveForRetryOnChainDisabled: true,
              retryOnFail: true,
            }
          );
        }
      }
    } else if (message.type === privateMessageType.AS_DATA_RESPONSE) {
      await processAsData({
        nodeId,
        requestId: message.request_id,
        serviceId: message.service_id,
        asNodeId: message.as_id,
        signature: message.signature,
        dataSalt: message.data_salt,
        data: message.data,
      });
    } else {
      logger.warn({
        message: 'Cannot process unknown message type',
        type: message.type,
      });
    }
  } catch (error) {
    const err = new CustomError({
      message: 'Error processing message from message queue',
      cause: error,
    });
    logger.error({ err });
    await common.notifyError({
      nodeId,
      getCallbackUrlFnName: 'rp.getErrorCallbackUrl',
      action: 'rp.processMessage',
      error: err,
      requestId,
    });
    throw err;
  }
}

export async function getRequestIdByReferenceId(nodeId, referenceId) {
  try {
    if (role === 'proxy') {
      if (nodeId == null) {
        throw new CustomError({
          errorType: errorType.MISSING_NODE_ID,
        });
      }
    } else {
      nodeId = config.nodeId;
    }

    return await cacheDb.getRequestIdByReferenceId(nodeId, referenceId);
  } catch (error) {
    throw new CustomError({
      message: 'Cannot get request ID by reference ID',
      cause: error,
    });
  }
}

export async function getDataFromAS(nodeId, requestId) {
  try {
    if (role === 'proxy') {
      if (nodeId == null) {
        throw new CustomError({
          errorType: errorType.MISSING_NODE_ID,
        });
      }
    } else {
      nodeId = config.nodeId;
    }

    // Check if request exists
    const request = await tendermintNdid.getRequest({ requestId });
    if (request == null) {
      return null;
    }

    return await cacheDb.getDatafromAS(nodeId, requestId);
  } catch (error) {
    throw new CustomError({
      message: 'Cannot get data received from AS',
      cause: error,
    });
  }
}

export async function removeDataFromAS(nodeId, requestId) {
  try {
    if (role === 'proxy') {
      if (nodeId == null) {
        throw new CustomError({
          errorType: errorType.MISSING_NODE_ID,
        });
      }
    } else {
      nodeId = config.nodeId;
    }

    return await cacheDb.removeDataFromAS(nodeId, requestId);
  } catch (error) {
    throw new CustomError({
      message: 'Cannot remove data received from AS',
      cause: error,
    });
  }
}

export async function removeAllDataFromAS(nodeId) {
  try {
    if (role === 'proxy') {
      if (nodeId == null) {
        throw new CustomError({
          errorType: errorType.MISSING_NODE_ID,
        });
      }
    } else {
      nodeId = config.nodeId;
    }

    return await cacheDb.removeAllDataFromAS(nodeId);
  } catch (error) {
    throw new CustomError({
      message: 'Cannot remove all data received from AS',
      cause: error,
    });
  }
}
