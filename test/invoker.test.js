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

const OpenWhiskInvoker = require('../src/invoker');
const Docker = require('dockerode');
const assert = require("assert");

const TEST_IMAGE = "adobeapiplatform/adobe-action-nodejs-v10:3.0.21";
const ACTION_NAME = "myaction";
const ACTION_METADATA = {
    exec: {
        kind: "nodejs"
    },
    limits: {
    }
};
const WSK_PROPS = {
    namespace: "namespace"
};
const WSK = {
    actions: {
        client: {
            request: async function() {
                return {
                    runtimes: {
                        nodejs: [{
                            kind: "nodejs",
                            image: TEST_IMAGE
                        }]
                    }
                }
            }
        }
    }
};

const docker = new Docker();

async function isContainerRunning(id) {
    const containers = await docker.listContainers();
    for (const container of containers) {
        if (container.Id === id) {
            return true;
        }
    }
    return false;
}


describe('invoker',  function() {

    it("should detect and replace an existing container", async function() {
        // preparation: start first container with right fields using dockerode
        const previousInvoker = new OpenWhiskInvoker(ACTION_NAME, ACTION_METADATA, {}, WSK_PROPS, WSK);
        await previousInvoker.prepare();
        await previousInvoker.startContainer(() => {});
        const previousContainerId = previousInvoker.container.id;

        // start second container
        const invoker = new OpenWhiskInvoker(ACTION_NAME, ACTION_METADATA, {}, WSK_PROPS, WSK);

        let id;

        try {
            await invoker.prepare();
            await invoker.startContainer(() => {});

            id = invoker.container.id;

            // verify it replaced the container (old id gone, new id with same label there)
            assert.ok(!await isContainerRunning(previousContainerId), "container was not replaced");

        } finally {
            await invoker.stop();

            if (id) {
                // verify the new container is gone
                assert.ok(!await isContainerRunning(id), "container was not removed");
            }
        }
    }).timeout(30000);

    it("should replace all previous container for the same action", async function() {
        // preparation: start multiple "left over" containers
        async function startContainer(port) {
            const createContainerConfig = {
                name: `wskdebug-invoker.test-${port}-${Date.now()}`,
                Labels: {
                    "org.apache.wskdebug.action": "/namespace/myaction"
                },
                Image: TEST_IMAGE,
                Cmd: [ 'sh', '-c', "node --expose-gc --inspect=0.0.0.0:9229 app.js" ],
                Env: [],
                Volumes: {},
                ExposedPorts: {
                    "8080/tcp": {},
                    "9229/tcp": {}
                },
                HostConfig: {
                    AutoRemove: true,
                    PortBindings: {
                        "8080/tcp": [{ HostPort: `${port+100}` }],
                        "9229/tcp": [{ HostPort: `${port}` }]
                    },
                    Memory: 50*1000*1000,
                    Binds: []
                }
            };
            const container = await docker.createContainer(createContainerConfig);
            await container.start();
            return container.id;
        }

        const previousContainerIds = [];
        previousContainerIds.push(await startContainer(9701));
        previousContainerIds.push(await startContainer(9702));
        previousContainerIds.push(await startContainer(9703));

        // start second container
        const invoker = new OpenWhiskInvoker(ACTION_NAME, ACTION_METADATA, {}, WSK_PROPS, WSK);

        let id;

        try {
            await invoker.prepare();
            await invoker.startContainer(() => {});

            id = invoker.container.id;

            // verify it replaced the container
            for (const previousContainerId of previousContainerIds) {
                assert.ok(!await isContainerRunning(previousContainerId), `old container was not removed: ${previousContainerId}`);
            }

        } finally {
            await invoker.stop();

            if (id) {
                // verify the new container is gone
                assert.ok(!await isContainerRunning(id), "container was not removed after stop()");
            }
        }
    }).timeout(30000);
});
