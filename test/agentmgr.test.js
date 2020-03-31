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

const Debugger = require("../src/debugger");

const test = require('./test');

describe('agentmgr',  function() {
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

    it("should use non-concurrrent agent if openwhisk does not support concurrency", async function() {
        const action = "myaction";
        const code = `const main = () => ({ msg: 'WRONG' });`;

        test.mockAction(action, code);

        test.mockCreateBackupAction(action);

        // wskdebug overwriting the action with the agent
        test.openwhiskNock()
            .put(
                `${test.openwhiskApiUrlActions()}/${action}?overwrite=true`,
                body => body.annotations.some(v => v.key === "wskdebug" && v.value === true)
            )
            .matchHeader("authorization", test.openwhiskApiAuthHeader())
            .reply(400, {
                code: 'df940ccf1d076f103c3743685c25d2b2',
                error: 'The request content was malformed:\nrequirement failed: concurrency 200 exceeds allowed threshold of 1'
            });

        // another wskdebug with non-concurrent action
        test.openwhiskNock()
            .put(
                `${test.openwhiskApiUrlActions()}/${action}?overwrite=true`,
                body => body.annotations.some(v => v.key === "wskdebug" && v.value === true)
            )
            .matchHeader("authorization", test.openwhiskApiAuthHeader())
            .reply(200, test.nodejsActionDescription(action));

        // helper actions for non-concurrent action
        test.openwhiskNock()
            .put(`${test.openwhiskApiUrlActions()}/${action}_wskdebug_invoked?overwrite=true`)
            .matchHeader("authorization", test.openwhiskApiAuthHeader())
            .reply(200, test.nodejsActionDescription(action));
        test.openwhiskNock()
            .put(`${test.openwhiskApiUrlActions()}/${action}_wskdebug_completed?overwrite=true`)
            .matchHeader("authorization", test.openwhiskApiAuthHeader())
            .reply(200, test.nodejsActionDescription(action));


        // invocation
        test.openwhiskNock()
            .get(`${test.openwhiskApiUrl()}/activations`)
            .query(query => query.name === `${action}_wskdebug_invoked`)
            .matchHeader("authorization", test.openwhiskApiAuthHeader())
            .reply(200, [{
                activationId: "dummy-invoked",
                response: {
                    success: true,
                    result: {
                        $activationId: "1234567890"
                    }
                }
            }]);

        // completion of invocation
        test.openwhiskNock()
            .post(`${test.openwhiskApiUrlActions()}/${action}_wskdebug_completed?blocking=true`, {
                msg: "CORRECT",
                $activationId: "1234567890"
            })
            .matchHeader("authorization", test.openwhiskApiAuthHeader())
            .reply(200, test.nodejsActionDescription(action));

        // abort polling
        test.openwhiskNock()
            .get(`${test.openwhiskApiUrl()}/activations`)
            .query(query => query.name === `${action}_wskdebug_invoked`)
            .matchHeader("authorization", test.openwhiskApiAuthHeader())
            .reply(200, [{
                activationId: "dummy-invoked-2",
                response: {
                    success: false,
                    result: {
                        error: {
                            code: 43
                        },
                        $activationId: "99999999999"
                    }
                }
            }]);

        // shutdown/restore process
        test.mockReadBackupAction(action, code);
        test.mockRestoreAction(action, code);
        test.mockRemoveBackupAction(action);
        test.openwhiskNock()
            .get(`${test.openwhiskApiUrlActions()}/${action}_wskdebug_invoked?code=false`)
            .matchHeader("authorization", test.openwhiskApiAuthHeader())
            .reply(200, {});
        test.openwhiskNock()
            .delete(`${test.openwhiskApiUrlActions()}/${action}_wskdebug_invoked`)
            .matchHeader("authorization", test.openwhiskApiAuthHeader())
            .reply(200, {});
        test.openwhiskNock()
            .get(`${test.openwhiskApiUrlActions()}/${action}_wskdebug_completed?code=false`)
            .matchHeader("authorization", test.openwhiskApiAuthHeader())
            .reply(200, {});
        test.openwhiskNock()
            .delete(`${test.openwhiskApiUrlActions()}/${action}_wskdebug_completed`)
            .matchHeader("authorization", test.openwhiskApiAuthHeader())
            .reply(200, {});


        process.chdir("test/nodejs/plain-flat");
        const argv = {
            port: test.port,
            action: "myaction",
            sourcePath: `${process.cwd()}/action.js`,
            invokeParams: '{ "key": "invocationOnSourceModification" }'
        };

        const dbgr = new Debugger(argv);
        await dbgr.start();
        dbgr.run();

        // wait a bit
        await test.sleep(500);

        await dbgr.stop();

        test.assertAllNocksInvoked();
    });
});
