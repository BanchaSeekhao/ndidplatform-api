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

import * as tendermintNdid from '../tendermint/ndid';
import { getErrorObjectForClient } from '../utils/error';
import { validateKey, verifyNewKey } from '../utils/node_key';
import { callbackToClient } from '../callback';
import CustomError from 'ndid-error/custom_error';
import errorType from 'ndid-error/type';
import logger from '../logger';

import * as config from '../config';

/**
 * Update node
 *
 * @param {Object} updateNodeParams
 * @param {string} [updateNodeParams.node_id]
 * @param {string} updateNodeParams.reference_id
 * @param {string} updateNodeParams.callback_url
 * @param {string} [updateNodeParams.public_key]
 * @param {string} [updateNodeParams.public_key_type]
 * @param {string} [updateNodeParams.master_public_key]
 * @param {string} [updateNodeParams.master_public_key_type]
 * @param {string} [updateNodeParams.check_string]
 * @param {string} [updateNodeParams.signed_check_string]
 * @param {string} [updateNodeParams.master_signed_check_string]
 * @param {string[]} [updateNodeParams.supported_request_message_data_url_type_list]
 * @param {Object} [options]
 * @param {boolean} [options.synchronous]
 *
 * @returns {Promise<Object>} Request ID and request message salt
 */
export async function updateNode(
  {
    node_id,
    public_key,
    public_key_type,
    master_public_key,
    master_public_key_type,
    check_string,
    signed_check_string,
    master_signed_check_string,
    supported_request_message_data_url_type_list,
  },
  { synchronous = false } = {}
) {
  if (node_id == null) {
    node_id = config.nodeId;
  }

  // Validate public keys
  if (public_key != null) {
    validateKey(public_key, public_key_type);
    if (check_string != null) {
      verifyNewKey(signed_check_string, public_key, check_string);
    }
  }

  if (master_public_key != null) {
    validateKey(master_public_key, master_public_key_type);
    if (check_string != null) {
      verifyNewKey(
        master_signed_check_string,
        master_public_key,
        check_string,
        true
      );
    }
  }

  if (supported_request_message_data_url_type_list != null) {
    const nodeInfo = await tendermintNdid.getNodeInfo(node_id);
    if (nodeInfo == null) {
      throw new CustomError({
        errorType: errorType.NODE_INFO_NOT_FOUND,
        details: {
          node_id,
        },
      });
    }
    if (nodeInfo.role.toLowerCase() !== 'idp') {
      throw new CustomError({
        errorType: errorType.MUST_BE_IDP_NODE,
      });
    }
  }

  if (synchronous) {
    await updateNodeInternalAsync(...arguments, { nodeId: node_id });
  } else {
    updateNodeInternalAsync(...arguments, { nodeId: node_id });
  }
}

async function updateNodeInternalAsync(
  {
    reference_id,
    callback_url,
    public_key,
    master_public_key,
    supported_request_message_data_url_type_list,
  },
  { synchronous = false } = {},
  { nodeId }
) {
  try {
    if (!synchronous) {
      await tendermintNdid.updateNode(
        {
          public_key,
          master_public_key,
          supported_request_message_data_url_type_list,
        },
        nodeId,
        'node.updateNodeInternalAsyncAfterBlockchain',
        [{ nodeId, reference_id, callback_url }, { synchronous }]
      );
    } else {
      await tendermintNdid.updateNode(
        {
          public_key,
          master_public_key,
          supported_request_message_data_url_type_list,
        },
        nodeId
      );
      await updateNodeInternalAsyncAfterBlockchain(
        {},
        { nodeId, reference_id, callback_url },
        { synchronous }
      );
    }
  } catch (error) {
    logger.error({
      message: 'Update node internal async error',
      originalArgs: arguments[0],
      options: arguments[1],
      additionalArgs: arguments[2],
      err: error,
    });

    if (!synchronous) {
      await callbackToClient({
        callbackUrl: callback_url,
        body: {
          node_id: nodeId,
          type: 'update_node_result',
          reference_id,
          success: false,
          error: getErrorObjectForClient(error),
        },
        retry: true,
      });
    }

    throw error;
  }
}

export async function updateNodeInternalAsyncAfterBlockchain(
  { error },
  { nodeId, reference_id, callback_url },
  { synchronous = false } = {}
) {
  try {
    if (error) throw error;

    if (!synchronous) {
      await callbackToClient({
        callbackUrl: callback_url,
        body: {
          node_id: nodeId,
          type: 'update_node_result',
          reference_id,
          success: true,
        },
        retry: true,
      });
    }
  } catch (error) {
    logger.error({
      message: 'Update node internal async after blockchain error',
      originalArgs: arguments[0],
      options: arguments[1],
      additionalArgs: arguments[2],
      err: error,
    });

    if (!synchronous) {
      await callbackToClient({
        callbackUrl: callback_url,
        body: {
          node_id: nodeId,
          type: 'update_node_result',
          reference_id,
          success: false,
          error: getErrorObjectForClient(error),
        },
        retry: true,
      });
    }

    throw error;
  }
}
