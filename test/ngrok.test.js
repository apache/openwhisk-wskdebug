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

const test = require('./test');
let Debugger = require("../src/debugger");

const assert = require('assert');
const nock = require('nock');
const fetch = require('node-fetch');
const mockRequire = require('mock-require');

function mockNgrokLibrary(connect, kill) {
    mockRequire("ngrok", {
        connect: connect || function() {
            console.log('ngrok.connect called');
        },
        kill: kill || function() {
            console.log('ngrok.kill called');
        }
    });
    // the modules have been loaded from another test file before,
    // so we need to re-require them in the reverse order
    // to make the mockRequire("ngrok") have an effect
    mockRequire.reRequire("../src/agents/ngrok");
    mockRequire.reRequire("../src/agentmgr");
    Debugger = mockRequire.reRequire("../src/debugger");
}

describe('ngrok',  function() {
    this.timeout(30000);

    before(function() {
        test.isDockerInstalled();
    });

    beforeEach(async function() {
        await test.beforeEach();
    });

    afterEach(function() {
        test.afterEach();
    });

    it("should connect to ngrok if selected", async function() {
        test.mockActionAndInvocation(
            "myaction",
            // should not use this code if we specify local sources which return CORRECT
            `const main = () => ({ msg: 'WRONG' });`,
            {},
            { msg: "CORRECT" }
        );

        // validate that it connects to ngrok
        // leaving it at that for now - more validation would be quite difficult
        const ngrok = nock('http://127.0.0.1', {
            filteringScope: scope => /^http:\/\/127\.0\.0\.1:.*/.test(scope),
        })
            .post('/api/tunnels')
            .reply(201, { "public_url":"https://UNIT_TEST.ngrok.io" });

        // wskdebug myaction --ngrok -p ${test.port}
        const argv = {
            port: test.port,
            action: "myaction",
            ngrok: true
        };

        const dbgr = new Debugger(argv);
        await dbgr.start();
        // no need to run() for this test
        await dbgr.stop();

        assert(ngrok.isDone(), "Expected these HTTP requests: " + ngrok.pendingMocks().join());
    });

    /*

    Runtime setup:

        [ wskdebug ]------<start>-----+
            ^                         |
            |                         |
         <handle>                     |
            |                         v
        [ local server ]<---------[ local ngrok ]
                                      ^
                                      |
                                      |
                                  [ ngrok.io ]
                                      ^
                                      |
        [ openwhisk action ]----------+

    Test setup:

        [ wskdebug ]------<start>-----+
            ^                         |
            |                         |
         <handle>                     |
            |                         v
        [ local server ]         [ MOCKED ngrok ]
            ^                         |
            |                    <pass on port>
            |                         |
            |                         |
        [ MOCKED invocation call ] <--+
    */

    it("should handle action invocation using ngrok", async function() {
        const actionName = "myaction";
        // should not use this code if we specify local sources which return CORRECT
        const code = `const main = () => ({ msg: 'WRONG' });`;

        // port of the local server started by wskdebug to be expecting calls from ngrok
        // which we will do in this test
        let ngrokServerPort, ngrokKillInvoked, ngrokAuth;
        mockNgrokLibrary(function(opts) {
            ngrokServerPort = opts.addr;
            return "https://UNIT_TEST.ngrok.io";
        }, function() {
            ngrokKillInvoked = true;
        });

        test.mockAction(actionName, code);
        test.mockCreateBackupAction(actionName);

        // ngrok agent installation
        // custom version instead of test.mockInstallAgent() to catch the ngrokAuth
        test.openwhiskNock()
            .put(
                `${test.openwhiskApiUrlActions()}/${actionName}?overwrite=true`,
                body => {
                    ngrokAuth = body.parameters.find(e => e.key === "$ngrokAuth").value;
                    return body.annotations.some(v => v.key === "wskdebug" && v.value === true);
                }
            )
            .matchHeader("authorization", test.openwhiskApiAuthHeader())
            .reply(200, test.nodejsActionDescription(actionName));

        test.mockRestoreAction(actionName, code);

        // wskdebug myaction action.js --ngrok -p ${test.port}
        const argv = {
            port: test.port,
            action: actionName,
            sourcePath: "action.js",
            ngrok: true
        };
        process.chdir("test/nodejs/plain-flat");

        const dbgr = new Debugger(argv);
        await dbgr.start();
        dbgr.run();

        // wait for everything to startup
        await test.sleep(10);

        try {
            // simulate invocation coming in via ngrok forwarding
            const response = await fetch(`http://127.0.0.1:${ngrokServerPort}`, {
                method: "POST",
                headers: {
                    authorization: ngrokAuth
                },
                body: JSON.stringify({
                    $activationId: "1234567890"
                })
            });

            // ensure correct result
            assert.strictEqual(response.status, 200);
            const result = await response.json();
            assert.strictEqual(result.msg, "CORRECT");

        } finally {
            await dbgr.stop();
        }

        assert(ngrokKillInvoked);
        assert(nock.isDone(), "Expected these HTTP requests: " + nock.pendingMocks().join());
    });
});
