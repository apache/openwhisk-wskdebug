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

let NgrokAgent;
try {
    // optional dependency, only needed if --ngrok is set
    NgrokAgent = require('./agents/ngrok');
} catch (err) {
    NgrokAgent = null
}

const fs = require('fs-extra');
const sleep = require('util').promisify(setTimeout);
const clone = require('clone');
const log = require('./log');

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
    log.debug(`restore: ensured removal of action ${name}`);
}


class AgentMgr {

    constructor(argv, wsk, actionName) {
        this.argv = argv;
        this.wsk = wsk;
        this.actionName = actionName;
        this.polling = true;

        if (this.argv.ngrok && !NgrokAgent) {
            throw new Error("ngrok dependency required for --ngrok is not installed. Please install it using:\n\n    npm install -g ngrok --unsafe-perm=true\n");
        }
    }

    /**
     * Fast way to get just the action metadata
     */
    async peekAction() {
        let action = await getWskActionWithoutCode(this.wsk, this.actionName);
        if (action === null) {
            throw new Error(`Action not found: ${this.actionName}`);
        }

        // check if there was an agent leftover
        if (isAgent(action)) {
            // ups, action is our agent, not the original
            // happens if a previous wskdebug was killed and could not restore before it exited
            const backupName = getActionCopyName(this.actionName);

            // check the backup action
            try {
                const backup = await getWskActionWithoutCode(this.wsk, backupName);

                if (!backup) {
                    // backup is also an agent (should not happen)
                    throw new Error(`Dang! Agent is already installed and action backup is missing.\n\nPlease redeploy your action first before running wskdebug again.`);

                } else if (isAgent(backup)) {
                    // backup is also an agent (should not happen)
                    throw new Error(`Dang! Agent is already installed and action backup is broken (${backupName}).\n\nPlease redeploy your action first before running wskdebug again.`);

                } else {
                    log.warn("Agent was already installed, but backup is still present. All good.");

                    // need to look at the original action
                    action = backup;
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
        return action;
    }

    async readActionWithCode() {
        // user can switch between agents (ngrok or not), hence we need to restore first
        // (better would be to track the agent + its version and avoid a restore, but that's TBD)
        if (this.agentInstalled) {
            this.actionWithCode = await this.restoreAction(true);
        } else {
            this.actionWithCode = await this.wsk.actions.get(this.actionName);
        }
        // extra sanity check
        if (isAgent(this.actionWithCode)) {
            throw new Error("Action seems to be a left over wskdebug agent instead of the original action. Possible bug in wskdebug. Please redeploy your action. Aborting.");
        }

        return this.actionWithCode;
    }

    async installAgent(invoker, debug2) {
        this.agentInstalled = true;

        let agentName;

        // base agent on the original action to keep default parameters & annotations
        const agentAction = this.actionWithCode ? clone(this.actionWithCode) : {
            exec: {},
            limits: {},
            annotations: [],
            parameters: []
        };

        // choose the right agent implementation
        let agentCode;
        if (this.argv.ngrok) {
            // user manually requested ngrok
            this.ngrokAgent = new NgrokAgent(this.argv, invoker);

            // agent using ngrok for forwarding
            agentName = "ngrok";
            agentCode = await this.ngrokAgent.getAgent(agentAction);
            debug2("started local ngrok proxy");

        } else {
            this.concurrency = !this.argv.disableConcurrency;

            if (this.concurrency) {
                // normal fast agent using concurrent node.js actions
                agentName = "concurrency";
                agentCode = await this.getConcurrencyAgent();

            } else {
                agentName = "polling activation db";
                agentCode = await this.getPollingActivationDbAgent();
            }
        }

        const backupName = getActionCopyName(this.actionName);

        // create copy in case wskdebug gets killed hard
        // do async as this can be slow for larger actions and this is part of the critical startup path
        this.createBackup = (async () => {
            const debug3 = log.newDebug();

            await this.wsk.actions.update({
                name: backupName,
                action: agentAction
            });
            debug3(`created action backup ${backupName}`);
        })();

        if (this.argv.condition) {
            agentAction.parameters.push({
                key: "$condition",
                value: this.argv.condition
            });
        }

        try {
            await this.pushAgent(agentAction, agentCode, backupName);
        } catch (e) {
            // openwhisk does not support concurrent nodejs actions, try with another
            if (e.statusCode === 400 && e.error && typeof e.error.error === "string" && e.error.error.includes("concurrency")) {
                log.log(`The Openwhisk server does not support concurrent actions, using alternative agent. Consider using --ngrok for a possibly faster agent.`);
                this.concurrency = false;
                agentCode = await this.getPollingActivationDbAgent();
                await this.pushAgent(agentAction, agentCode, backupName);
            }
        }
        debug2(`installed agent type '${agentName}' in place of action '${this.actionName}'`);
    }

    stop() {
        this.polling = false;
    }

    async shutdown() {
        this.shuttingDown = true;

        try {
            // make sure we finished creating the backup
            await this.createBackup;

            if (this.agentInstalled) {
                await this.restoreAction();
            }
        } finally {
            if (this.ngrokAgent) {
                await this.ngrokAgent.stop();
                log.debug("ngrok shut down");
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

                    log.verboseWrite(".");

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
                                if (!activation.response.success) {
                                    throw {
                                        error: activation
                                    };
                                }
                                break;
                            }
                        }

                        log.verboseWrite(".");

                        // need to limit load on openwhisk (activation list)
                        await sleep(1000);
                    }
                }

                log.verboseWrite(".");

                // check for successful response with a new activation
                if (activation && activation.response) {
                    const params = activation.response.result;

                    // mark this as seen so we don't reinvoke it
                    this.activationsSeen[activation.activationId] = true;

                    log.verbose(); // because of the .....
                    log.log();
                    log.highlight("Activation: ", params.$activationId);
                    return params;

                } else if (activation && activation.activationId) {
                    // ignore this and retry.
                    // usually means the action did not respond within one minute,
                    // which in turn is unlikely for the agent who should exit itself
                    // after 50 seconds, so can only happen if there was some delay
                    // outside the action itself

                } else {
                    // unexpected, just log and retry
                    log.log("Unexpected empty response while waiting for new activations:", activation);
                }

            } catch (e) {
                // look for special error codes from agent
                const errorCode = getActivationError(e).code;
                if (errorCode === 42) {
                    // 42 => retry, do nothing here (except logging progress)
                    log.verboseWrite(".");

                } else if (errorCode === 43) {
                    // 43 => graceful shutdown (for unit tests)
                    log.log("Graceful shutdown requested by agent (only for unit tests)");
                    return null;

                } else if (e.statusCode === 503 && !this.concurrency) {
                    // 503 => openwhisk activation DB likely overloaded with requests, warn, wait a bit and retry

                    log.verbose("x");
                    log.warn("Server responded with 503 while looking for new activation records. Consider using --ngrok option.")

                    await sleep(5000);

                } else {
                    // otherwise log error and abort
                    log.error();
                    log.error("Unexpected error while polling agent for activation:");
                    log.deepObject(e);
                    throw new Error("Unexpected error while polling agent for activation.");
                }
            }

            // some small wait to avoid too many requests in case things run amok
            await sleep(100);
        }
    }

    async completeActivation(activationId, result, duration) {
        log.succeed(`Completed activation ${activationId} in ` + log.highlightColor(`${duration/1000.0} sec`));
        log.verbose("Result:", result);

        try {
            result.$activationId = activationId;
            await this.wsk.actions.invoke({
                name: this.concurrency ? this.actionName : `${this.actionName}_wskdebug_completed`,
                params: result,
                blocking: true,
                headers: {
                    "X-OW-EXTRA-LOGGING": "on"
                }
            });
        } catch (e) {
            // look for special error codes from agent
            const errorCode = getActivationError(e).code;
            // 42 => retry
            if (errorCode === 42) {
                // do nothing
            } else if (errorCode === 43) {
                // 43 => graceful shutdown (for unit tests)
                log.log("Graceful shutdown requested by agent (only for unit tests)");
                return false;
            } else {
                log.error("Unexpected error while completing activation:", e);
            }
        }
        return true;
    }

    // --------------------------------------< restoring >------------------

    async restoreAction(isStartup) {
        // if a restore is already running, wait for it to finish
        if (this._restorePromise) {
            await this._restorePromise;
            return;
        }

        // start actual restore and store the promise
        this._restorePromise = this._restoreAction(isStartup);
        // wait for the result
        const result = await this._restorePromise;
        // make sure to delete the promise once done
        delete this._restorePromise;
        return result;
    }

    async _restoreAction(isStartup) {
        const copy = getActionCopyName(this.actionName);

        try {
            // unfortunately, openwhisk does not support a server-side "move action" API,
            // otherwise the next 3 steps (read, update, delete) could be a single
            // and presumably fast move operation

            let original;
            if (this.actionWithCode) {
                // normal case during shutdown: we have the original action in memory
                original = this.actionWithCode;
            } else {
                // the original was fetched before or was backed up in the copy
                original = await this.wsk.actions.get(copy)
                log.debug("restore: fetched action original from backup copy");
            }

            // copy the backup (copy) to the regular action
            await this.wsk.actions.update({
                name: this.actionName,
                action: original
            });
            log.debug("restore: restored original action");

            if (this.argv.cleanup) {
                if (!isStartup) {
                    log.log("Removing helper actions due to --cleanup...");
                }
                // remove the backup
                await this.wsk.actions.delete(copy);
                log.debug("restore: deleted backup copy");

                // remove any helpers if they exist
                await deleteActionIfExists(this.wsk, `${this.actionName}_wskdebug_invoked`);
                await deleteActionIfExists(this.wsk, `${this.actionName}_wskdebug_completed`);

            } else if (!isStartup) {
                log.log(`Following helper actions are not removed to keep shutdown fast. Remove using --cleanup if desired.`);
                log.log(`- ${log.highlightColor(copy)}`);
                if (!this.concurrency && !this.ngrokAgent) {
                    log.log("- " + log.highlightColor(`${this.actionName}_wskdebug_invoked`));
                    log.log("- " + log.highlightColor(`${this.actionName}_wskdebug_completed`));
                }
                log.log();
            }

            return original;

        } catch (e) {
            log.error("Error while restoring original action:", e);
        }
    }

    // --------------------------------------< agent types >------------------

    async getConcurrencyAgent() {
        return fs.readFileSync(`${__dirname}/../agent/agent-concurrency.js`, {encoding: 'utf8'});
    }

    async getPollingActivationDbAgent() {
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

        if (this.shuttingDown) {
            // race condition on shutdown during startup due to errors
            return;
        }

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
                parameters: action.parameters || []
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
                    timeout: (this.argv.agentTimeout || 30) * 1000
                },
                annotations: [
                    { key: "description", value: `wskdebug agent helper. temporarily installed.` }
                ]
            }
        });
        log.debug(`created helper action ${actionName}`);
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
                log.warn("Could not retrieve OpenWhisk version:", e.message);
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
            // concurrency: async (_, wsk) => {
            //     // check swagger api docs instead of version to see if concurrency is supported
            //     try {
            //         const swagger = await wsk.actions.client.request("GET", "/api/v1/api-docs");

            //         if (swagger && swagger.definitions && swagger.definitions.ActionLimits && swagger.definitions.ActionLimits.properties) {
            //             return swagger.definitions.ActionLimits.properties.concurrency;
            //         }
            //     } catch (e) {
            //         log.warn('Could not read /api/v1/api-docs, setting max action concurrency to 1')
            //         return false;
            //     }
            // }
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
