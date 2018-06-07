import fs from 'fs';
import crypto from 'crypto';
import path from 'path';

import * as cryptoUtils from './crypto';
import * as config from '../config';
import fetch from 'node-fetch';
import bignum from 'bignum';
import { spawnSync } from 'child_process';
import logger from '../logger';

let nonce = Date.now() % 10000;
let callbackUrl = {};
const saltByteLength = 8;
const saltStringLength = saltByteLength*2;

const callbackUrlFilesPrefix = path.join(
  __dirname,
  '..',
  '..',
  'dpki-callback-url-' + config.nodeId,
);

[ 'signature',
  'masterSignature',
  'decrypt',
].forEach((key) => {
  try {
    callbackUrl[key] = fs.readFileSync(callbackUrlFilesPrefix + '-' + key, 'utf8');
  } 
  catch (error) {
    if (error.code === 'ENOENT') {
      logger.warn({
        message: 'DPKI ' + key + ' callback url file not found',
      });
    }
    else {
      logger.error({
        message: 'Cannot read DPKI ' + key + ' callback url file(s)',
        error,
      });
    }
  }
});

export function wait(ms, stoppable) {
  let setTimeoutFn;
  const promise = new Promise((resolve) => setTimeoutFn = setTimeout(resolve, ms));
  if (stoppable) {
    return {
      promise,
      stopWaiting: () => clearTimeout(setTimeoutFn),
    };
  }
  return promise;
}

export function randomBase64Bytes(length) {
  return cryptoUtils.randomBase64Bytes(length);
}

export function getNonce() {
  // TODO
  return (nonce++).toString();
}

export function hash(stringToHash) {
  return cryptoUtils.hash(stringToHash);
}

export function hashWithRandomSalt(stringToHash) {
  let saltByte = crypto.randomBytes(saltByteLength);
  let saltString = saltByte.toString('base64');
  return saltString + hash(saltString + stringToHash);
}

export function compareSaltedHash({saltedHash, plain}) {
  let saltString = saltedHash.substring(0,saltStringLength);
  return saltedHash === saltString + hash(saltString + plain);
}

export async function decryptAsymetricKey(cipher) {
  // TODO: implement decryption with callback decrypt? no design yet... (HSM)
  const [encryptedSymKey, encryptedMessage] = cipher.split('|');
  let symKeyBuffer;
  let decryptCallback = callbackUrl.decrypt;

  if(decryptCallback) {
    let response = await fetch( decryptCallback, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        cipher: encryptedSymKey
      }),
    });
    let base64 = await response.text();
    symKeyBuffer = Buffer.from(base64, 'base64');
  }
  else {
    const privateKey = fs.readFileSync(config.privateKeyPath, 'utf8');
    symKeyBuffer = cryptoUtils.privateDecrypt(privateKey, encryptedSymKey);
  }
  
  return cryptoUtils.decryptAES256GCM(symKeyBuffer, encryptedMessage, false);
}

export function encryptAsymetricKey(publicKey, message) {
  const symKeyBuffer = crypto.randomBytes(32);
  const encryptedSymKey = cryptoUtils.publicEncrypt(publicKey, symKeyBuffer);
  const encryptedMessage = cryptoUtils.encryptAES256GCM(
    symKeyBuffer,
    message,
    false // Key derivation is not needed since key is cryptographically random generated and use only once
  );
  return encryptedSymKey + '|' + encryptedMessage;
}

export function generateIdentityProof(data) {

  logger.debug({
    message: 'Generating proof',
    data,
  });

  let k = randomBase64Bytes(config.zkRandomLengthForIdp);
  let kInt = stringToBigInt(k);
  let { n, e } = extractParameterFromPublicKey(data.publicKey);
  let secret = stringToBigInt(data.secret);
  let challenge = stringToBigInt(data.challenge);

  let blockchainProof = powerMod(kInt,e,n).toBuffer().toString('base64');
  //console.log(blockchainProof);
  let privateProof = kInt.mul( 
    powerMod(secret,challenge,n) 
  ).mod(n).toBuffer().toString('base64');

  logger.debug({
    message: 'Proof generated',
    k: stringToBigInt(k),
    bcInt: stringToBigInt(blockchainProof),
    pvInt: stringToBigInt(privateProof),
    n,e,
    secret,
    challenge: stringToBigInt(data.challenge),
  });

  return [blockchainProof, privateProof];
}

function extractParameterFromPublicKey(publicKey) {
  let fileName = 'tmpNDIDFile' + Date.now();
  fs.writeFileSync(fileName,publicKey);
  let result = spawnSync('openssl',('rsa -pubin -in ' + fileName + ' -text -noout').split(' '));
  let resultStr = result.stdout.toString().split(':').join('');
  let resultNoHeader = resultStr.split('\n').splice(2);
  let modStr = resultNoHeader.splice(0,resultNoHeader.length-2).join('').split(' ').join('');
  let exponentStr = resultNoHeader[0].split(' ')[1];

  fs.unlink(fileName, () => {});
  return {
    n: stringToBigInt(Buffer.from(modStr,'hex').toString('base64')),
    e: bignum(exponentStr)
  };
}

function powerMod(base, exponent, modulus) {
  return base.powm(exponent, modulus);
}

function stringToBigInt(string) {
  return bignum.fromBuffer(Buffer.from(string,'base64'));
}

function euclideanGCD(a, b) {
  if( a.eq(bignum('0')) ) return [b, bignum('0'), bignum('1')];
  let [g, y, x] = euclideanGCD(b.mod(a),a);
  return [
    g, 
    x.sub(
      b.sub(
        b.mod(a)
      )
      .div(a)
      .mul(y)
    ),
    y
  ];
}

function moduloMultiplicativeInverse(a, modulo) {
  let [g, x, y] = euclideanGCD(a, modulo);
  if(!g.eq(1)) throw 'No modular inverse';
  return x.mod(modulo);
}

export function verifyZKProof(publicKey, 
  challenge, 
  privateProof, 
  publicProof, 
  sid,
  privateProofHash,
) {
  if(privateProofHash !== hash(privateProof)) return false;

  let { n, e } = extractParameterFromPublicKey(publicKey);
  let hashedSid = hash(sid.namespace + ':' + sid.identifier);
  let inverseHashSid = moduloMultiplicativeInverse(stringToBigInt(hashedSid), n);

  let tmp1 = powerMod(stringToBigInt(privateProof),e,n);
  let tmp2 = powerMod(
    inverseHashSid, 
    stringToBigInt(challenge),
    n,
  ); 

  let tmp3 = (tmp1.mul(tmp2)).mod(n);

  logger.debug({
    message: 'ZK Verify result',
    hashBigInt: stringToBigInt(hashedSid),
    inverseHashSid,
    n,e,
    tmp1,
    tmp2,
    tmp3,
    publicProofBigInt: stringToBigInt(publicProof),
    publicProof,
  });

  return stringToBigInt(publicProof).eq(tmp3);
}

export function setSignatureCallback(signCallbackUrl, decryptCallbackUrl) {
  if(signCallbackUrl) {
    callbackUrl.signature = signCallbackUrl;
    fs.writeFile(callbackUrlFilesPrefix + '-signature', signCallbackUrl, (err) => {
      if (err) {
        logger.error({
          message: 'Cannot write DPKI sign callback url file',
          error: err,
        });
      }
    });
  }
  if(decryptCallbackUrl) {
    callbackUrl.decrypt = decryptCallbackUrl;
    fs.writeFile(callbackUrlFilesPrefix + '-decrypt', decryptCallbackUrl, (err) => {
      if (err) {
        logger.error({
          message: 'Cannot write DPKI sign callback url file',
          error: err,
        });
      }
    });
  }
}

export function setMasterSignatureCallback(url) {
  if(url) {
    callbackUrl.masterSignature = url;
    fs.writeFile(callbackUrlFilesPrefix + '-master-signature', url, (err) => {
      if (err) {
        logger.error({
          message: 'Cannot write DPKI master-sign callback url file',
          error: err,
        });
      }
    });
  }
}

async function createSignatureByCallback(data, useMasterKey) {
  //TODO implement this properly
  //MUST be base64 format
  let response = await fetch( useMasterKey 
    ? callbackUrl.signature
    : callbackUrl.masterSignature
    , {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      node_id: config.nodeId,
      //request_message: 'string',
      //request_hash: 'string',
      hash_method: 'SHA256',
      //key_type: 'string',
      //sign_method: 'string'
    }),
  });
  return await response.text();
}

export async function createSignature(data, nonce = '', useMasterKey) {
  if (callbackUrl.signature)
    return await createSignatureByCallback(JSON.stringify(data) + nonce, useMasterKey);
  let privateKey = (useMasterKey 
    ? fs.readFileSync(config.masterPrivateKeyPath, 'utf8')
    : fs.readFileSync(config.privateKeyPath, 'utf8')
  );
  return cryptoUtils.createSignature(data, nonce, privateKey);
}

export function verifySignature(signatureInBase64, publicKey, plainText) {
  return cryptoUtils.verifySignature(signatureInBase64, publicKey, plainText);
}

export function createRequestId() {
  return cryptoUtils.randomHexBytes(32);
}