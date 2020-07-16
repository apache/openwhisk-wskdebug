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


/* eslint-env mocha */

'use strict';

const wskprops = require('../src/wskprops');
const assert = require('assert');
const mockFs = require('mock-fs');
const os = require('os');

function resetEnvVars() {
    delete process.env.OW_AUTH;
    delete process.env.OW_NAMESPACE;
    delete process.env.OW_APIHOST;
    delete process.env.WSK_CONFIG_FILE;
    delete process.env.AIO_runtime_auth;
    delete process.env.AIO_runtime_namespace;
}

describe('wskprops', function() {

    beforeEach(function() {
        resetEnvVars();
    });

    afterEach(function() {
        resetEnvVars();
        mockFs.restore();
    });

    it("should read WSK_CONFIG_FILE", async function() {
        process.env.WSK_CONFIG_FILE = "some/wskprops";
        mockFs({
            "some/wskprops":
`APIHOST=https://some-wskprops
NAMESPACE=some-wskprops-namespace
AUTH=some-wskprops-auth`
        });

        const props = wskprops.get();
        assert.strictEqual(props.apihost, "https://some-wskprops");
        assert.strictEqual(props.namespace, "some-wskprops-namespace");
        assert.strictEqual(props.api_key, "some-wskprops-auth");
    });

    it("should read ~/.wskprops", async function() {
        mockFs({
            [`${os.homedir()}/.wskprops`]:
`APIHOST=https://home-wskprops
NAMESPACE=home-wskprops-namespace
AUTH=home-wskprops-auth`
        });

        const props = wskprops.get();
        assert.strictEqual(props.apihost, "https://home-wskprops");
        assert.strictEqual(props.namespace, "home-wskprops-namespace");
        assert.strictEqual(props.api_key, "home-wskprops-auth");
    });

    it("should read OW_* vars", async function() {
        process.env.OW_APIHOST = "https://ow_apihost";
        process.env.OW_NAMESPACE = "ow_namespace";
        process.env.OW_AUTH = "ow_auth";

        const props = wskprops.get();
        assert.strictEqual(props.apihost, "https://ow_apihost");
        assert.strictEqual(props.namespace, "ow_namespace");
        assert.strictEqual(props.api_key, "ow_auth");
    });

    it("should give OW_* vars precedence over WSK_CONFIG_FILE", async function() {
        process.env.WSK_CONFIG_FILE = "some/wskprops";

        process.env.OW_APIHOST = "https://ow_apihost";
        process.env.OW_NAMESPACE = "ow_namespace";
        process.env.OW_AUTH = "ow_auth";

        const props = wskprops.get();
        assert.strictEqual(props.apihost, "https://ow_apihost");
        assert.strictEqual(props.namespace, "ow_namespace");
        assert.strictEqual(props.api_key, "ow_auth");
    });

    it("should read AIO_* vars", async function() {
        process.env.AIO_runtime_namespace = "aio_namespace";
        process.env.AIO_runtime_auth = "aio_auth";

        const props = wskprops.get();
        assert.strictEqual(props.apihost, "https://adobeioruntime.net");
        assert.strictEqual(props.namespace, "aio_namespace");
        assert.strictEqual(props.api_key, "aio_auth");
    });

    it("should give AIO_* vars precedence over WSK_CONFIG_FILE", async function() {
        process.env.WSK_CONFIG_FILE = "some/wskprops";
        process.env.AIO_runtime_namespace = "aio_namespace";
        process.env.AIO_runtime_auth = "aio_auth";

        const props = wskprops.get();
        assert.strictEqual(props.apihost, "https://adobeioruntime.net");
        assert.strictEqual(props.namespace, "aio_namespace");
        assert.strictEqual(props.api_key, "aio_auth");
    });

    it("should give AIO_* vars precedence over ~/.wskprops", async function() {
        mockFs({
            [`${os.homedir()}/.wskprops`]:
`APIHOST=https://home-wskprops
NAMESPACE=home-wskprops-namespace
AUTH=home-wskprops-auth`
        });

        process.env.AIO_runtime_namespace = "aio_namespace";
        process.env.AIO_runtime_auth = "aio_auth";

        const props = wskprops.get();
        assert.strictEqual(props.apihost, "https://adobeioruntime.net");
        assert.strictEqual(props.namespace, "aio_namespace");
        assert.strictEqual(props.api_key, "aio_auth");
    });

    it("should give OW_* precedence over AIO_* vars", async function() {
        process.env.AIO_runtime_namespace = "aio_namespace";
        process.env.AIO_runtime_auth = "aio_auth";

        process.env.OW_APIHOST = "https://ow_apihost";
        process.env.OW_NAMESPACE = "ow_namespace";
        process.env.OW_AUTH = "ow_auth";

        const props = wskprops.get();
        assert.strictEqual(props.apihost, "https://ow_apihost");
        assert.strictEqual(props.namespace, "ow_namespace");
        assert.strictEqual(props.api_key, "ow_auth");
    });

    it("should read AIO_* from .env", async function() {
        mockFs({
            ".env":
`AIO_runtime_namespace=aio_namespace
AIO_runtime_auth=aio_auth`
        });

        const props = wskprops.get();
        assert.strictEqual(props.apihost, "https://adobeioruntime.net");
        assert.strictEqual(props.namespace, "aio_namespace");
        assert.strictEqual(props.api_key, "aio_auth");
    });

    it("should read WSK_CONFIG_FILE from .env", async function() {
        mockFs({
            ".env": "WSK_CONFIG_FILE=some/wskprops",
            "some/wskprops":
`APIHOST=https://some-wskprops
NAMESPACE=some-wskprops-namespace
AUTH=some-wskprops-auth`
        });

        const props = wskprops.get();
        assert.strictEqual(props.apihost, "https://some-wskprops");
        assert.strictEqual(props.namespace, "some-wskprops-namespace");
        assert.strictEqual(props.api_key, "some-wskprops-auth");
    });

});
