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
const prettyBytes = require('pretty-bytes');
const prettyMilliseconds = require('pretty-ms');
const log = require('./log');
const inspector = require('inspector');

function prettyMBytes1024(mb) {
    if (mb > 1024) {
        return `${mb/1024} GB`;
    } else {
        return `${mb} MB`;
    }
}

function getNamespaceFromActionMetadata(actionMetadata) {
    // if the action is inside a package, this returns <namespace>/<package>
    // but we only want the namespace
    return actionMetadata.namespace.split("/")[0];
}

/**
 * Central component of wskdebug.
 */
class Debugger {
    constructor(argv) {
        this.startTime = Date.now();
        log.debug("starting debugger");

        // see if our process is debugged, which might not be desired
        if (inspector.url()) {
            log.warn(`
+------------------------------------------------------------------------------------------+
| WARNING: wskdebug itself is debugged and likely NOT the action                           |
|                                                                                          |
| This could be an issue with the debug setup. Notably, VS Code changed their debugger     |
| implementation in June/July 2020 requiring changes to launch.json. For more see:         |
|                                                                                          |
|     https://github.com/apache/openwhisk-wskdebug/issues/74                               |
|                                                                                          |
+------------------------------------------------------------------------------------------+
            `);
        }

        this.argv = argv;
        this.actionName = argv.action;

        this.wskProps = wskprops.get();
        if (Object.keys(this.wskProps).length === 0) {
            log.error(`Error: Missing openwhisk credentials. Found no ~/.wskprops or .env file or WSK_* environment variable.`);
            process.exit(1);
        }
        if (argv.ignoreCerts) {
            this.wskProps.ignore_certs = true;
        }

        try {
            this.wsk = openwhisk(this.wskProps);
        } catch (err) {
            log.error(`Error: Could not setup openwhisk client: ${err.message}`);
            process.exit(1);
        }

        const h = log.highlightColor;
        log.spinner("Debugging " + h(`/_/${this.actionName}`) + " on " + h(this.wskProps.apihost));
    }

    async start() {
        this.agentMgr = new AgentMgr(this.argv, this.wsk, this.actionName);
        this.watcher = new Watcher(this.argv, this.wsk);

        // get the action metadata
        this.actionMetadata = await this.agentMgr.peekAction();
        log.debug("fetched action metadata from openwhisk");
        this.wskProps.namespace = getNamespaceFromActionMetadata(this.actionMetadata);

        const h = log.highlightColor;
        log.step("Debugging " + h(`/${this.wskProps.namespace}/${this.actionName}`) + " on " + h(this.wskProps.apihost));

        // local debug container
        this.invoker = new OpenWhiskInvoker(this.actionName, this.actionMetadata, this.argv, this.wskProps, this.wsk);

        // quick fail for missing requirements such as docker not running
        await this.invoker.checkIfDockerAvailable();

        try {
            // run build initially (would be required by starting container)
            if (this.argv.onBuild) {
                log.highlight("On build: ", this.argv.onBuild);
                spawnSync(this.argv.onBuild, {shell: true, stdio: "inherit"});
            }
            await this.invoker.prepare();

            // parallelize slower work using promises

            // task 1 - start local container
            const containerTask = (async () => {
                const debug2 = log.newDebug();

                // start container - get it up fast for VSCode to connect within its 10 seconds timeout
                await this.invoker.startContainer(debug2);

                debug2(`started container: ${this.invoker.name()}`);
            })();

            // task 2 - fetch action code from openwhisk
            const openwhiskTask = (async () => {
                const debug2 = log.newDebug();
                const actionWithCode = await this.agentMgr.readActionWithCode();

                debug2(`downloaded action code (${prettyBytes(actionWithCode.exec.code.length)})`);
                return actionWithCode;
            })();

            // wait for both tasks 1 & 2
            const results = await Promise.all([containerTask, openwhiskTask]);
            const actionWithCode = results[1];

            log.spinner('Installing agent');

            // parallelize slower work using promises again

            // task 3 - initialize local container with code
            const initTask = (async () => {
                const debug2 = log.newDebug();

                // /init local container
                await this.invoker.init(actionWithCode);

                debug2("installed action on container");
            })();

            // task 4 - install agent in openwhisk
            const agentTask = (async () => {
                const debug2 = log.newDebug();

                // setup agent in openwhisk
                await this.agentMgr.installAgent(this.invoker, debug2);
            })();

            await Promise.all([initTask, agentTask]);

            if (this.argv.onStart) {
                log.highlight("On start: ", this.argv.onStart);
                spawnSync(this.argv.onStart, {shell: true, stdio: "inherit"});
            }

            // start source watching (live reload) if requested
            await this.watcher.start();

            this.logDetails();
            const abortMsg = log.isInteractive ? log.highlightColor(" Use CTRL+C to exit.") : "";
            log.ready(`Ready for activations. Started in ${prettyMilliseconds(Date.now() - this.startTime)}.${abortMsg}`);

            this.ready = true;

        } catch (e) {
            await this.shutdown();
            throw e;
        }
    }

    async logDetails() {
        log.stopSpinner();
        log.log();
        log.highlight("Action     : ", `/${this.wskProps.namespace}/${this.actionName}`);
        if (this.sourcePath) {
            log.highlight("Sources    : ", `${this.invoker.getSourcePath()}`);
        }
        log.highlight("Image      : ", `${this.invoker.getImage()}`);
        log.highlight("Container  : ", `${this.invoker.name()}`);
        if (this.actionMetadata.limits) {
            if (this.actionMetadata.limits.memory) {
                log.highlight("Memory     : ", `${prettyMBytes1024(this.actionMetadata.limits.memory)}`);
            }
            if (this.actionMetadata.limits.timeout) {
                log.highlight("Timeout    : ", `${prettyMilliseconds(this.actionMetadata.limits.timeout, {verbose:true})}`);
            }
        }
        log.highlight("Debug type : ", `${this.invoker.getDebugKind()}`);
        log.highlight("Debug port : ", `localhost:${this.invoker.getPort()}`);
        if (this.argv.condition) {
            log.highlight("Condition  : ", `${this.argv.condition}`);
        }
        log.log();
    }

    async run() {
        return this.runPromise = this._run();
    }

    async _run() {
        try {
            this.running = true;

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
                    log.verbose("Parameters:", activation);

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
        if (!this.shutdownPromise) {
            this.shutdownPromise = this._shutdown();
        }

        await this.shutdownPromise;
        delete this.shutdownPromise;
    }

    async _shutdown() {
        const shutdownStart = Date.now();

        // only log this if we started properly
        if (this.ready) {
            log.log();
            log.log();
            log.debug("shutting down...");
        } else {
            log.debug("aborting start - shutting down ...");
        }
        log.spinner("Shutting down");

        // need to shutdown everything even if some fail, hence tryCatch() for each

        if (this.agentMgr) {
            await this.tryCatch(this.agentMgr.shutdown());
        }

        // ------------< critical removal must happen above this line >---------------

        // in VS Code, we will not run beyond this line upon debug stop.
        // this is because invoker.stop() will kill the container & thus close the
        // debug port, upon which VS Code kills the debug process (us)
        if (this.invoker) {
            await this.tryCatch(this.invoker.stop());
        }

        if (this.watcher) {
            // this is not critical on a process exit, only if Debugger is used programmatically
            // and might be reused for a new run()
            await this.tryCatch(this.watcher.stop());
            log.debug("stopped source file watching");
        }

        // only log this if we started properly
        if (this.ready) {
            log.succeed(`Done. Shutdown in ${prettyMilliseconds(Date.now() - shutdownStart)}.`);
        }
        this.ready = false;
    }

    // ------------------------------------------------< utils >-----------------

    async tryCatch(task) {
        try {
            if (typeof task === "function") {
                task();
            } else {
                await task;
            }
        } catch (e) {
            log.exception(e, "Error during shutdown:");
        }
    }

}

module.exports = Debugger;
