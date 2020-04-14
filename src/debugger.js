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

const wskprops = require('./wskprops');
const OpenWhiskInvoker = require('./invoker');
const AgentMgr = require('./agentmgr');
const Watcher = require('./watcher');
const openwhisk = require('openwhisk');
const { spawnSync } = require('child_process');
const sleep = require('util').promisify(setTimeout);
const debug = require('./debug');
const prettyBytes = require('pretty-bytes');
const prettyMilliseconds = require('pretty-ms');

/**
 * Central component of wskdebug.
 */
class Debugger {
    constructor(argv) {
        this.startTime = Date.now();
        debug("starting debugger");

        this.argv = argv;
        this.actionName = argv.action;

        this.wskProps = wskprops.get();
        if (Object.keys(this.wskProps).length === 0) {
            console.error(`Error: Missing openwhisk credentials. Found no ~/.wskprops file or WSK_* environment variable.`);
            process.exit(1);
        }
        if (argv.ignoreCerts) {
            this.wskProps.ignore_certs = true;
        }

        try {
            this.wsk = openwhisk(this.wskProps);
        } catch (err) {
            console.error(`Error: Could not setup openwhisk client: ${err.message}`);
            process.exit(1);
        }
    }

    async start() {
        this.agentMgr = new AgentMgr(this.argv, this.wsk, this.actionName);
        this.watcher = new Watcher(this.argv, this.wsk);

        // get the action metadata
        const actionMetadata = await this.agentMgr.peekAction();
        debug("fetched action metadata from openwhisk");

        this.wskProps.namespace = actionMetadata.namespace;
        console.info(`Starting debugger for /${this.wskProps.namespace}/${this.actionName}`);

        // local debug container
        this.invoker = new OpenWhiskInvoker(this.actionName, actionMetadata, this.argv, this.wskProps, this.wsk);

        try {
            // parallelize slower work using promises

            // task 1 - start local container
            const containerTask = (async () => {
                const debugTask = debug.task();
                // run build initially (would be required by starting container)
                if (this.argv.onBuild) {
                    console.info("=> Build:", this.argv.onBuild);
                    spawnSync(this.argv.onBuild, {shell: true, stdio: "inherit"});
                }

                // start container - get it up fast for VSCode to connect within its 10 seconds timeout
                await this.invoker.startContainer();

                debugTask(`started container: ${this.invoker.name()}`);
            })();

            // task 2 - fetch action code from openwhisk
            const openwhiskTask = (async () => {
                const debugTask = debug.task();
                const actionWithCode = await this.agentMgr.readActionWithCode();

                debugTask(`got action code (${prettyBytes(actionWithCode.exec.code.length)})`);
                return actionWithCode;
            })();

            // wait for both tasks 1 & 2
            const results = await Promise.all([containerTask, openwhiskTask]);
            const actionWithCode = results[1];

            // parallelize slower work using promises again

            // task 3 - initialize local container with code
            const initTask = (async () => {
                const debugTask = debug.task();

                // /init local container
                await this.invoker.init(actionWithCode);

                debugTask("installed action on container");
            })();

            // task 4 - install agent in openwhisk
            const agentTask = (async () => {
                const debugTask = debug.task();

                // setup agent in openwhisk
                await this.agentMgr.installAgent(this.invoker, debugTask);
            })();

            await Promise.all([initTask, agentTask]);

            if (this.argv.onStart) {
                console.log("On start:", this.argv.onStart);
                spawnSync(this.argv.onStart, {shell: true, stdio: "inherit"});
            }

            // start source watching (live reload) if requested
            await this.watcher.start();

            console.log();
            console.info(`Action     : ${this.actionName}`);
            if (this.sourcePath) {
                console.info(`Sources    : ${this.invoker.getSourcePath()}`);
            }
            console.info(`Image      : ${this.invoker.getImage()}`);
            console.info(`Container  : ${this.invoker.name()}`);
            console.info(`Debug type : ${this.invoker.getDebugKind()}`);
            console.info(`Debug port : localhost:${this.invoker.getPort()}`);
            if (this.argv.condition) {
                console.info(`Condition  : ${this.argv.condition}`);
            }
            console.log();
            console.info(`Ready for activations. Started in ${prettyMilliseconds(Date.now() - this.startTime)}. Use CTRL+C to exit`);

            this.ready = true;

        } catch (e) {
            await this.shutdown();
            throw e;
        }
    }

    async run() {
        return this.runPromise = this._run();
    }

    async _run() {
        try {
            this.running = true;
            this.shuttingDown = false;

            // main blocking loop
            // abort if this.running is set to false
            // from here on, user can end debugger with ctrl+c
            while (this.running) {
                if (this.argv.ngrok) {
                    // agent: ngrok
                    // simply block, ngrokServer keeps running in background
                    await sleep(1000);

                } else {
                    // agent: concurrent
                    // agent: non-concurrent
                    // wait for activation, run it, complete, repeat
                    const activation = await this.agentMgr.waitForActivations();
                    if (!activation) {
                        return;
                    }

                    const id = activation.$activationId;
                    delete activation.$activationId;

                    const startTime = Date.now();

                    // run this activation on the local docker container
                    // which will block if the actual debugger hits a breakpoint
                    const result = await this.invoker.run(activation, id);

                    const duration = Date.now() - startTime;

                    // pass on the local result to the agent in openwhisk
                    if (!await this.agentMgr.completeActivation(id, result, duration)) {
                        return;
                    }
                }
            }
        } finally {
            await this.shutdown();
        }
    }

    // normal graceful stop() initiated by a client
    async stop() {
        this.running = false;
        if (this.agentMgr) {
            this.agentMgr.stop();
        }

        if (this.runPromise) {
            // wait for the main loop to gracefully end, which will call shutdown()
            await this.runPromise;
        } else {
            // someone called stop() without run()
            await this.shutdown();
        }
    }

    // fastest way to end, triggered by CTRL+C
    async kill() {
        this.running = false;
        if (this.agentMgr) {
            this.agentMgr.stop();
        }

        await this.shutdown();
    }

    async shutdown() {
        // avoid duplicate shutdown on CTRL+C
        if (this.shuttingDown) {
            return;
        }
        this.shuttingDown = true;
        const shutdownStart = Date.now();
        debug("shutting down...");

        // only log this if we started properly
        if (this.ready) {
            console.log();
            console.log();
            console.log("Shutting down...");
        }

        // need to shutdown everything even if some fail, hence tryCatch() for each

        if (this.agentMgr) {
            await this.tryCatch(this.agentMgr.shutdown());
        }
        if (this.invoker) {
            await this.tryCatch(this.invoker.stop());
            debug(`stopped container: ${this.invoker.name()}`);
        }
        if (this.watcher) {
            await this.tryCatch(this.watcher.stop());
            debug("stopped source file watching");
        }

        // only log this if we started properly
        if (this.ready) {
            console.log(`Done (shutdown took ${prettyMilliseconds(Date.now() - shutdownStart)})`);
        }
        this.ready = false;
    }

    // ------------------------------------------------< utils >-----------------

    async tryCatch(task, message="Error during shutdown:") {
        try {
            if (typeof task === "function") {
                task();
            } else {
                await task;
            }
        } catch (e) {
            console.log(e);
            if (this.argv.verbose) {
                console.error(message);
                console.error(e);
            } else {
                console.error(message, e.message);
            }
        }
    }

}

module.exports = Debugger;
