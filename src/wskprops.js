/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// based on from serverless-openwhisk, MIT licensed
// but changed to drop usage of async Promises and some renaming
// https://github.com/serverless/serverless-openwhisk/blob/master/provider/credentials.js

'use strict';

const log = require('./log');

const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs-extra');

const ENV_PARAMS = ['OW_APIHOST', 'OW_AUTH', 'OW_NAMESPACE', 'OW_APIGW_ACCESS_TOKEN'];

function getWskPropsUserHomeFile() {
    const Home = process.env[(process.platform === 'win32') ? 'USERPROFILE' : 'HOME'];
    return path.format({ dir: Home, base: '.wskprops' });
}

function readWskPropsFile() {
    const wskFilePath = process.env.WSK_CONFIG_FILE || getWskPropsUserHomeFile();

    if (fs.existsSync(wskFilePath)) {
        log.verbose(`Using openwhisk credentials from ${wskFilePath}${process.env.WSK_CONFIG_FILE ? " (set by WSK_CONFIG_FILE)" : ""}`);
        return fs.readFileSync(wskFilePath, 'utf8');
    } else {
        return null;
    }
}

function getWskProps() {
    const data = readWskPropsFile();
    if (!data) return {};

    const wskProps = data.trim().split('\n')
        .map(line => line.split('='))
        .reduce((params, keyValue) => {
            params[keyValue[0].toLowerCase()] = keyValue[1]; // eslint-disable-line no-param-reassign
            return params;
        }, {});

    return wskProps;
}

function getAioEnvProps() {
    const envProps = {};
    // do first, as OW_* ones later shall take precedence
    if (process.env.AIO_runtime_auth) {
        envProps.apihost = "https://adobeioruntime.net";
        envProps.auth = process.env.AIO_runtime_auth;
        envProps.namespace = process.env.AIO_runtime_namespace;
        log.verbose(`Using openwhisk credential from AIO_runtime_auth environment variable`);
    }
    return envProps;
}

function getWskEnvProps() {
    const envProps = {};
    ENV_PARAMS.forEach((envName) => {
        if (process.env[envName]) {
            const key = envName.slice(3).toLowerCase();
            envProps[key] = process.env[envName];
            if (key === "auth" || key === "api_key") {
                log.verbose(`Using openwhisk credential from ${envName} environment variable`);
            }
        }
    });
    return envProps;
}

module.exports = {
    get() {
        // load .env file if present
        dotenv.config();

        const props = Object.assign(getWskProps(), getAioEnvProps(), getWskEnvProps());
        if (props.auth) {
            props.api_key = props.auth;
            delete props.auth;
        }
        return props;
    },
    ENV_PARAMS,
};
