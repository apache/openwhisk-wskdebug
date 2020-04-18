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

const { spawn, execSync } = require('child_process');
const fetch = require('fetch-retry')(require('isomorphic-fetch'));
const kinds = require('./kinds/kinds');
const path = require('path');
const log = require("./log");

const RUNTIME_PORT = 8080;
const INIT_RETRY_DELAY_MS = 100;

// https://github.com/apache/incubator-openwhisk/blob/master/docs/reference.md#system-limits
const OPENWHISK_DEFAULTS = {
    timeout: 60*1000,
    memory: 256
};

function execute(cmd, options, debug2) {
    cmd = cmd.replace(/\s+/g, ' ');
    const result = execSync(cmd, options);

    (debug2 || log.debug)(`executed: ${cmd}`);
    if (result) {
        return result.toString().trim();
    } else {
        return '';
    }
}

// if value is a function, invoke it with args, otherwise return it as object
// if value is undefined, will return undefined
function resolveValue(value, ...args) {
    if (typeof value === "function") {
        return value(...args);
    } else {
        return value;
    }
}

class OpenWhiskInvoker {
    constructor(actionName, action, options, wskProps, wsk) {
        this.actionName = actionName;
        this.action = action;

        this.kind = options.kind;
        this.image = options.image;
        this.port = options.port;
        this.internalPort = options.internalPort;
        this.command = options.command;
        this.dockerArgs = options.dockerArgs;

        // the build path can be separate, if not, same as the source/watch path
        this.sourcePath = options.buildPath || options.sourcePath;
        if (this.sourcePath) {
            this.sourceDir = process.cwd();
            // ensure sourcePath is relative to sourceDir
            this.sourceFile = path.relative(this.sourceDir, this.sourcePath);
        }

        this.main = options.main;

        this.wskProps = wskProps;
        this.wsk = wsk;

        this.containerName = this.asContainerName(`wskdebug-${this.action.name}-${Date.now()}`);
    }

    async checkIfDockerAvailable() {
        try {
            execute("docker info", {stdio: 'ignore'});
        } catch (e) {
            throw new Error("Docker not running on local system. A local docker environment is required for the debugger.")
        }
    }

    async getImageForKind(kind) {
        try {
            const owSystemInfo = await this.wsk.actions.client.request("GET", "/");
            if (owSystemInfo.runtimes) {
                // transform result into a nice dictionary kind => image
                const runtimes = {};
                for (const set of Object.values(owSystemInfo.runtimes)) {
                    for (const entry of set) {
                        let image = entry.image;
                        // fix for Adobe I/O Runtime reporting incorrect image prefixes
                        image = image.replace("bladerunner/", "adobeapiplatform/");
                        runtimes[entry.kind] = image;
                    }
                }
                return runtimes[kind];

            } else {
                log.warn("Could not retrieve runtime images from OpenWhisk, using default image list.");
            }

        } catch (e) {
            log.warn("Could not retrieve runtime images from OpenWhisk, using default image list.", e.message);
        }
        return kinds.images[kind];
    }

    async prepare() {
        const action = this.action;

        // this must run after initial build was kicked off in Debugger so that built files are present

        // kind and image - precendence:
        // 1. arguments (this.image)
        // 2. action (action.exec.image)
        // 3. defaults (kinds.images[kind])

        const kind = this.kind || action.exec.kind;

        if (kind === "blackbox") {
            throw new Error("Action is of kind 'blackbox', must specify kind using `--kind` argument.");
        }

        this.image = this.image || action.exec.image || await this.getImageForKind(kind);

        if (!this.image) {
            throw new Error(`Unknown kind: ${kind}. You might want to specify --image.`);
        }

        // debugging instructions
        this.debugKind = kinds.debugKinds[kind] || kind.split(":")[0];
        try {
            this.debug = require(`${__dirname}/kinds/${this.debugKind}/${this.debugKind}`);
        } catch (e) {
            log.warn(`Cannot find debug info for kind ${this.debugKind}:`, e.message);
            this.debug = {};
        }

        this.debug.internalPort = this.internalPort                      || resolveValue(this.debug.port, this);
        this.debug.port         = this.port         || this.internalPort || resolveValue(this.debug.port, this);

        // ------------------------

        this.debug.command = this.command || resolveValue(this.debug.command, this);

        if (!this.debug.port) {
            throw new Error(`No debug port known for kind: ${kind}. Please specify --port.`);
        }
        if (!this.debug.internalPort) {
            throw new Error(`No debug port known for kind: ${kind}. Please specify --internal-port.`);
        }
        if (!this.debug.command) {
            throw new Error(`No debug command known for kind: ${kind}. Please specify --command.`);
        }

        // limits
        this.memory = (action.limits.memory || OPENWHISK_DEFAULTS.memory) * 1024 * 1024;

        // source mounting
        if (this.sourcePath) {
            if (!this.debug.mountAction) {
                log.warn(`Warning: Sorry, mounting sources not yet supported for: ${kind}.`);
                this.sourcePath = undefined;
            }
        }

        this.dockerArgsFromKind = resolveValue(this.debug.dockerArgs, this) || "";
        this.dockerArgsFromUser = this.dockerArgs || "";

        if (this.sourcePath && this.debug.mountAction) {
            this.sourceMountAction = resolveValue(this.debug.mountAction, this);
        }
    }

    async startContainer(debug2) {
        let showDockerRunOutput = log.isVerbose;

        // quick fail for missing requirements such as docker not running
        await this.checkIfDockerAvailable();

        try {
            execute(`docker inspect --type=image ${this.image} 2> /dev/null`);
        } catch (e) {
            // make sure the user can see the image download process as part of docker run
            showDockerRunOutput = true;
            log.warn(`
+------------------------------------------------------------------------------------------+
| Docker image must be downloaded: ${this.image}
|                                                                                          |
| Note: If you debug in VS Code and it fails with "Cannot connect to runtime process"      |
| due to a timeout, run this command once:                                                 |
|                                                                                          |
|     docker pull ${this.image}
|                                                                                          |
| Alternatively set a higher 'timeout' in the launch configuration, such as 60000 (1 min). |
+------------------------------------------------------------------------------------------+
`);
        }

        execute(
            `docker run
                -d
                --name ${this.name()}
                --rm
                -m ${this.memory}
                -p ${RUNTIME_PORT}
                -p ${this.debug.port}:${this.debug.internalPort}
                ${this.dockerArgsFromKind}
                ${this.dockerArgsFromUser}
                ${this.image}
                ${this.debug.command}
            `,
            // live stream view for docker image download output
            { stdio: showDockerRunOutput ? "inherit" : null },
            debug2
        );

        this.containerRunning = true;

        log.stopSpinner();
        spawn("docker", ["logs", "-t", "-f", this.name()], {
            stdio: [
                "inherit", // stdin
                global.mochaLogFile || "inherit", // stdout
                global.mochaLogFile || "inherit"  // stderr
            ]
        });
    }

    getSourcePath() {
        return this.sourcePath;
    }

    getImage() {
        return this.image;
    }

    getDebugKind() {
        return this.debugKind;
    }

    getPort() {
        return this.debug.port;
    }

    async init(actionWithCode) {
        let action;
        if (this.sourceMountAction) {
            action = this.sourceMountAction;

        } else {
            action = {
                binary: actionWithCode.exec.binary,
                main:   actionWithCode.exec.main || "main",
                code:   actionWithCode.exec.code,
            };
        }

        const response = await fetch(`${this.url()}/init`, {
            method: "POST",
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                value: action
            }),
            retries: this.timeout() / INIT_RETRY_DELAY_MS,
            retryDelay: INIT_RETRY_DELAY_MS
        });

        if (response.status === 502) {
            const body = await response.json();
            throw new Error("Could not initialize action code on local debug container:\n\n" + body.error);
        }
    }

    async run(args, activationId) {
        const response = await fetch(`${this.url()}/run`, {
            method: "POST",
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                value: args,

                api_host        : this.wskProps.apihost,
                api_key         : this.wskProps.api_key,
                namespace       : this.wskProps.namespace,
                action_name     : `/${this.wskProps.namespace}/${this.actionName}`,
                activation_id   : activationId,
                deadline        : `${Date.now() + this.timeout()}`,
                allow_concurrent: "true"
            })
        });

        return response.json();
    }

    async stop() {
        if (this.containerRunning) {
            execute(`docker kill ${this.name()}`);
        }
    }

    name() {
        return this.containerName;
    }

    url() {
        if (!this.containerURL) {
            // ask docker for the exposed IP and port of the RUNTIME_PORT on the container
            const host = execute(`docker port ${this.name()} ${RUNTIME_PORT}`);
            this.containerURL = `http://${host}`;
        }
        return this.containerURL;
    }

    timeout() {
        return this.action.limits.timeout || OPENWHISK_DEFAULTS.timeout;
    }

    asContainerName(name) {
        // docker container names are restricted to [a-zA-Z0-9][a-zA-Z0-9_.-]*

        // 1. replace special characters with dash
        name = name.replace(/[^a-zA-Z0-9_.-]+/g, '-');
        // 2. leading character is more limited
        name = name.replace(/^[^a-zA-Z0-9]+/g, '');
        // 3. (nice to have) remove trailing special chars
        name = name.replace(/[^a-zA-Z0-9]+$/g, '');

        return name;
    }
}

module.exports = OpenWhiskInvoker;
