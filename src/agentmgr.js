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

'use strict';

const NgrokAgent = require('./ngrok');
const fs = require('fs-extra');
const sleep = require('util').promisify(setTimeout);

function getAnnotation(action, key) {
    const a = action.annotations.find(a => a.key === key);
    if (a) {
        return a.value;
    }
}

function getActionCopyName(name) {
    return `${name}_wskdebug_original`;
}

function isAgent(action) {
    return getAnnotation(action, "wskdebug") ||
           (getAnnotation(action, "description") || "").startsWith("wskdebug agent.");
}

function getActivationError(e) {
    if (e.error && e.error.response && e.error.response.result && e.error.response.result.error) {
        return e.error.response.result.error;
    }
    return {};
}

async function getWskActionWithoutCode(wsk, actionName) {
    try {
        return await wsk.actions.get({name: actionName, code:false});
    } catch (e) {
        if (e.statusCode === 404) {
            return null;
        } else {
            throw e;
        }
    }
}

async function actionExists(wsk, name) {
    try {
        await wsk.actions.get({name: name, code: false});
        return true;
    } catch (e) {
        return false;
    }
}

async function deleteActionIfExists(wsk, name) {
    if (await actionExists(wsk, name)) {
        await wsk.actions.delete(name);
    }
}


// TODO: test wskdebug manually
// TODO: openwhiskSupports() into separate shared class
class AgentMgr {

    constructor(argv, wsk, actionName) {
        this.argv = argv;
        this.wsk = wsk;
        this.actionName = actionName;
        this.polling = true;
    }

    async readAction() {
        if (this.argv.verbose) {
            console.log(`Getting action metadata from OpenWhisk: ${this.actionName}`);
        }
        let action = await getWskActionWithoutCode(this.wsk, this.actionName);
        if (action === null) {
            throw new Error(`Action not found: ${this.actionName}`);
        }

        let agentAlreadyInstalled = false;

        // check if this actoin needs to
        if (isAgent(action)) {
            // ups, action is our agent, not the original
            // happens if a previous wskdebug was killed and could not restore before it exited
            const backupName = getActionCopyName(this.actionName);

            // check the backup action
            try {
                const backup = await this.wsk.actions.get(backupName);

                if (isAgent(backup)) {
                    // backup is also an agent (should not happen)
                    // backup is useless, delete it
                    // await this.wsk.actions.delete(backupName);
                    throw new Error(`Dang! Agent is already installed and action backup is broken (${backupName}).\n\nPlease redeploy your action first before running wskdebug again.`);

                } else {
                    console.warn("Agent was already installed, but backup is still present. All good.");

                    // need to look at the original action
                    action = backup;
                    agentAlreadyInstalled = true;
                    this.agentInstalled = true;
                }

            } catch (e) {
                if (e.statusCode === 404) {
                    // backup missing
                    throw new Error(`Dang! Agent is already installed and action backup is gone (${backupName}).\n\nPlease redeploy your action first before running wskdebug again.`);

                } else {
                    // other error
                    throw e;
                }
            }
        }
        return {action, agentAlreadyInstalled };
    }

    async installAgent(action) {
        this.agentInstalled = true;

        let agentName;

        // choose the right agent implementation
        let agentCode;
        if (this.argv.ngrok) {
            // user manually requested ngrok

            this.ngrokAgent = new NgrokAgent(this.argv);

            // agent using ngrok for forwarding
            agentName = "ngrok";
            agentCode = await this.ngrokAgent.getAgent(action);

        } else {
            this.concurrency = await this.openwhiskSupports("concurrency");
            if (this.concurrency) {
                // normal fast agent using concurrent node.js actions
                agentName = "concurrency";
                agentCode = await this.getConcurrencyAgent();

            } else {
                console.log("This OpenWhisk does not support action concurrency. Debugging will be a bit slower. Consider using '--ngrok' which might be a faster option.");

                agentName = "polling activation db";
                agentCode = await this.getPollingActivationRecordAgent();
            }
        }

        const backupName = getActionCopyName(this.actionName);

        if (this.argv.verbose) {
            console.log(`Installing agent in OpenWhisk (${agentName})...`);
        }

        // create copy
        await this.wsk.actions.update({
            name: backupName,
            action: action
        });

        if (this.argv.verbose) {
            console.log(`Original action backed up at ${backupName}.`);
        }

        if (this.argv.condition) {
            action.parameters.push({
                key: "$condition",
                value: this.argv.condition
            });
        }

        await this.pushAgent(action, agentCode, backupName);

        if (this.argv.verbose) {
            console.log(`Agent installed.`);
        }
    }

    stop() {
        this.polling = false;
    }

    async shutdown() {
        try {
            await this.restoreAction();
        } finally {
            if (this.ngrokAgent) {
                await this.ngrokAgent.stop();
            }
        }
    }

    // --------------------------------------< polling >-------------------

    async waitForActivations() {
        this.activationsSeen = this.activationsSeen || {};

        // secondary loop to get next activation
        // the $waitForActivation agent activation will block, but only until
        // it times out, hence we need to retry when it fails
        while (this.polling) {
            if (this.argv.verbose) {
                process.stdout.write(".");
            }
            try {
                let activation;
                if (this.concurrency) {
                    // invoke - blocking for up to 1 minute
                    activation = await this.wsk.actions.invoke({
                        name: this.actionName,
                        params: {
                            $waitForActivation: true
                        },
                        blocking: true
                    });

                } else {
                    // poll for the newest activation
                    const since = Date.now();

                    // older openwhisk only allows the name of an action when filtering activations
                    // newer openwhisk versions want package/name
                    let name = this.actionName;
                    if (await this.openwhiskSupports("activationListFilterOnlyBasename")) {
                        if (this.actionName.includes("/")) {
                            name = this.actionName.substring(this.actionName.lastIndexOf("/") + 1);
                        }
                    }

                    while (true) {
                        if (this.argv.verbose) {
                            process.stdout.write(".");
                        }

                        const activations = await this.wsk.activations.list({
                            name: `${name}_wskdebug_invoked`,
                            since: since,
                            limit: 1, // get the most recent one only
                            docs: true // include results
                        });

                        if (activations && activations.length >= 1) {
                            const a = activations[0];
                            if (a.response && a.response.result && !this.activationsSeen[a.activationId]) {
                                activation = a;
                                break;
                            }
                        }

                        // need to limit load on openwhisk (activation list)
                        await sleep(1000);
                    }
                }

                // check for successful response with a new activation
                if (activation && activation.response) {
                    const params = activation.response.result;

                    // mark this as seen so we don't reinvoke it
                    this.activationsSeen[activation.activationId] = true;

                    if (this.argv.verbose) {
                        console.log();
                        console.info(`Activation: ${params.$activationId}`);
                        console.log(params);
                    } else {
                        console.info(`Activation: ${params.$activationId}`);
                    }
                    return params;

                } else if (activation && activation.activationId) {
                    // ignore this and retry.
                    // usually means the action did not respond within one second,
                    // which in turn is unlikely for the agent who should exit itself
                    // after 50 seconds, so can only happen if there was some delay
                    // outside the action itself

                } else {
                    // unexpected, just log and retry
                    console.log("Unexpected empty response while waiting for new activations:", activation);
                }

            } catch (e) {
                // look for special error codes from agent
                const errorCode = getActivationError(e).code;
                // 42 => retry
                if (errorCode === 42) {
                    // do nothing
                } else if (errorCode === 43) {
                    // 43 => graceful shutdown (for unit tests)
                    console.log("Graceful shutdown requested by agent (only for unit tests)");
                    return null;
                } else {
                    // otherwise log error and abort
                    console.error();
                    console.error("Unexpected error while polling agent for activation:");
                    console.dir(e, { depth: null });
                    throw new Error("Unexpected error while polling agent for activation.");
                }
            }

            // some small wait to avoid too many requests in case things run amok
            await sleep(100);
        }
    }

    async completeActivation(activationId, result, duration) {
        console.info(`Completed activation ${activationId} in ${duration/1000.0} sec`);
        if (this.argv.verbose) {
            console.log(result);
        }

        try {
            result.$activationId = activationId;
            await this.wsk.actions.invoke({
                name: this.concurrency ? this.actionName : `${this.actionName}_wskdebug_completed`,
                params: result,
                blocking: true
            });
        } catch (e) {
            // look for special error codes from agent
            const errorCode = getActivationError(e).code;
            // 42 => retry
            if (errorCode === 42) {
                // do nothing
            } else if (errorCode === 43) {
                // 43 => graceful shutdown (for unit tests)
                console.log("Graceful shutdown requested by agent (only for unit tests)");
                return false;
            } else {
                console.error("Unexpected error while completing activation:", e);
            }
        }
        return true;
    }

    // --------------------------------------< restoring >------------------

    async restoreAction() {
        if (this.agentInstalled) {
            if (this.argv.verbose) {
                console.log();
                console.log(`Restoring action`);
            }

            const copy = getActionCopyName(this.actionName);

            try {
                const original = await this.wsk.actions.get(copy);

                // copy the backup (copy) to the regular action
                await this.wsk.actions.update({
                    name: this.actionName,
                    action: original
                });

                // remove the backup
                await this.wsk.actions.delete(copy);

                // remove any helpers if they exist
                await deleteActionIfExists(this.wsk, `${this.actionName}_wskdebug_invoked`);
                await deleteActionIfExists(this.wsk, `${this.actionName}_wskdebug_completed`);

            } catch (e) {
                console.error("Error while restoring original action:", e);
            }
        }
    }

    // --------------------------------------< agent types >------------------

    async getConcurrencyAgent() {
        return fs.readFileSync(`${__dirname}/../agent/agent-concurrency.js`, {encoding: 'utf8'});
    }

    async getPollingActivationRecordAgent() {
        // this needs 2 helper actions in addition to the agent in place of the action
        await this.createHelperAction(`${this.actionName}_wskdebug_invoked`,   `${__dirname}/../agent/echo.js`);
        await this.createHelperAction(`${this.actionName}_wskdebug_completed`, `${__dirname}/../agent/echo.js`);

        let agentCode = fs.readFileSync(`${__dirname}/../agent/agent-activationdb.js`, {encoding: 'utf8'});
        // rewrite the code to pass config (we want to avoid fiddling with default params of the action)
        if (await this.openwhiskSupports("activationListFilterOnlyBasename")) {
            agentCode = agentCode.replace("const activationListFilterOnlyBasename = false;", "const activationListFilterOnlyBasename = true;");
        }
        return agentCode;
    }

    async pushAgent(action, agentCode, backupName) {
        // overwrite action with agent

        // this is to support older openwhisks for which nodejs:default is less than version 8
        const nodejs8 = await this.openwhiskSupports("nodejs8");

        await this.wsk.actions.update({
            name: this.actionName,
            action: {
                exec: {
                    kind: nodejs8 ? "nodejs:default" : "blackbox",
                    image: nodejs8 ? undefined : "openwhisk/action-nodejs-v8",
                    code: agentCode
                },
                limits: {
                    timeout: (this.argv.agentTimeout || 300) * 1000,
                    concurrency: this.concurrency ? 200: 1
                },
                annotations: [
                    ...action.annotations,
                    { key: "provide-api-key", value: true },
                    { key: "wskdebug", value: true },
                    { key: "description", value: `wskdebug agent. temporarily installed over original action. original action backup at ${backupName}.` }
                ],
                parameters: action.parameters
            }
        });
    }

    async createHelperAction(actionName, file) {
        const nodejs8 = await this.openwhiskSupports("nodejs8");

        await this.wsk.actions.update({
            name: actionName,
            action: {
                exec: {
                    kind: nodejs8 ? "nodejs:default" : "blackbox",
                    image: nodejs8 ? undefined : "openwhisk/action-nodejs-v8",
                    code: fs.readFileSync(file, {encoding: 'utf8'})
                },
                limits: {
                    timeout: (this.argv.agentTimeout || 300) * 1000
                },
                annotations: [
                    { key: "description", value: `wskdebug agent helper. temporarily installed.` }
                ]
            }
        });
    }

    // ----------------------------------------< openwhisk feature detection >-----------------

    async getOpenWhiskVersion() {
        if (this.openwhiskVersion === undefined) {
            try {
                const json = await this.wsk.actions.client.request("GET", "/api/v1");
                if (json && typeof json.build === "string") {
                    this.openwhiskVersion = json.build;
                } else {
                    this.openwhiskVersion = null;
                }
            } catch (e) {
                console.warn("Could not retrieve OpenWhisk version:", e.message);
                this.openwhiskVersion = null;
            }
        }
        return this.openwhiskVersion;
    }

    async openwhiskSupports(feature) {
        const FEATURES = {
            // guesstimated
            activationListFilterOnlyBasename: v => v.startsWith("2018") || v.startsWith("2017"),
            // hack
            nodejs8: v => !v.startsWith("2018") && !v.startsWith("2017"),
            concurrency: async (_, wsk) => {
                // check swagger api docs instead of version to see if concurrency is supported
                try {
                    const swagger = await wsk.actions.client.request("GET", "/api/v1/api-docs");

                    if (swagger && swagger.definitions && swagger.definitions.ActionLimits && swagger.definitions.ActionLimits.properties) {
                        return swagger.definitions.ActionLimits.properties.concurrency;
                    }
                } catch (e) {
                    console.warn('Could not read /api/v1/api-docs, setting max action concurrency to 1')
                    return false;
                }
            }
        };
        const checker = FEATURES[feature];
        if (checker) {
            return checker(await this.getOpenWhiskVersion(), this.wsk);
        } else {
            throw new Error("Unknown feature " + feature);
        }
    }
}

module.exports = AgentMgr;