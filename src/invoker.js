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

const fetch = require('fetch-retry')(require('node-fetch'));
const kinds = require('./kinds/kinds');
const path = require('path');
const log = require("./log");
const Docker = require('dockerode');
const getPort = require('get-port');
const dockerUtils = require('./dockerutils');
const prettyBytes = require('pretty-bytes');
const isPortReachable = require('is-port-reachable');

const RUNTIME_PORT = 8080;
const MAX_INIT_RETRY_MS = 20000; // 20 sec
const INIT_RETRY_DELAY_MS = 200;
const LABEL_ACTION_NAME = "org.apache.wskdebug.action";

// https://github.com/apache/incubator-openwhisk/blob/master/docs/reference.md#system-limits
const OPENWHISK_DEFAULTS = {
    timeout: 60*1000,
    memory: 256
};

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

        this.containerName = dockerUtils.safeContainerName(`wskdebug-${this.actionName}-${Date.now()}`);
        this.docker = new Docker();
    }

    async checkIfDockerAvailable() {
        try {
            await this.docker.ping();
            log.debug("docker - availability check")
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
            console.log(e);
            log.warn("Could not retrieve runtime images from OpenWhisk, using default image list.", e.message);
        }
        return kinds.images[kind];
    }

    async prepare() {
        const action = this.action;

        // this must run after initial build was kicked off in Debugger so that built files are present

        // kind and image - precedence:
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

    async isImagePresent(image, debug) {
        try {
            await this.docker.getImage(image).inspect();
            debug(`docker - image inspected, is present: ${image}`);
            return true;
        } catch (e) {
            debug(`docker - image inspected, not found: ${image}`);
            return false;
        }
    }

    async pull(image) {
        await new Promise((resolve, reject) => {
            this.docker.pull(image, (err, stream) => {
                // streaming output from pull...
                if (err) {
                    return reject(err);
                }

                function onFinished(err, output) {
                    if (err) {
                        return reject(err);
                    }
                    return resolve(output);
                }

                const events = {};
                function onProgress(event) {
                    if (!event.progress) {
                        return;
                    }

                    if (event.status) {
                        events[event.status] = events[event.status] || {};
                        if (event.id) {
                            events[event.status][event.id] = event;
                        }
                    }
                    const progressMsg = Object.entries(events).reduce((result, [status, events], idx) => {
                        const progress = Object.values(events).reduce((sum, e) => {
                            if (e.progressDetail && e.progressDetail.current && e.progressDetail.total) {
                                sum.current += e.progressDetail.current;
                                sum.total   += e.progressDetail.total;
                            }
                            return sum;
                        }, { current: 0, total: 0 });

                        return result + `${idx > 0 ? ", " : ""}${status}: ${prettyBytes(progress.current)} of ${prettyBytes(progress.total)}`;
                    }, "");

                    log.spinner(`Pulling docker image ${image} (${progressMsg})`);
                }

                this.docker.modem.followProgress(stream, onFinished, onProgress);
            });
        });
    }

    getFullActionName() {
        return `/${this.wskProps.namespace}/${this.actionName}`;
    }

    async checkExistingContainers() {
        let containers = await this.docker.listContainers();
        const fullActionName = this.getFullActionName();

        // remove all left over containers with the same action name label
        for (const container of containers) {
            if (container.Labels[LABEL_ACTION_NAME] === fullActionName) {
                log.warn(`Removing container from a previous wskdebug run for this action (${dockerUtils.getContainerName(container)}).`)
                const oldContainer = await this.docker.getContainer(container.Id);
                await oldContainer.remove({force: true});
            }
        }

        // check if the debug port is already in use
        if (await isPortReachable(this.debug.port)) {
            containers = await this.docker.listContainers();
            // then check if it's another container with that port
            for (const container of containers) {
                for (const port of container.Ports) {
                    if (port.PublicPort === this.debug.port) {
                        // check if wskdebug container by looking at our label
                        if (container.Labels[LABEL_ACTION_NAME]) {
                            // wskdebug of different action
                            throw new Error(`Debug port ${this.debug.port} already in use by wskdebug for action ${container.Labels[LABEL_ACTION_NAME]}, cotainer ${dockerUtils.getContainerName(container)} (id: ${container.Id}).`);
                        } else {
                            // some non-wskdebug container
                            throw new Error(`Debug port ${this.debug.port} already in use by another docker container ${dockerUtils.getContainerName(container)} (id: ${container.Id}).`);
                        }
                    }
                }
            }

            // some other process uses the port
            throw new Error(`Debug port ${this.debug.port} already in use.`);
        }
    }

    async startContainer(debug) {
        if (!await this.isImagePresent(this.image, debug)) {
            // show after 8 seconds, as VS code will timeout after 10 secs by default,
            // so that the user can see it after all the "docker pull" progress output
            setTimeout(() => {
                log.warn(`
+------------------------------------------------------------------------------------------+
| Docker image being downloaded: ${this.image}
|                                                                                          |
| Note: If you debug in VS Code and it fails with "Cannot connect to runtime process"      |
| due to a timeout, run this command once:                                                 |
|                                                                                          |
|     docker pull ${this.image}
|                                                                                          |
| Alternatively set a higher 'timeout' in the launch configuration, such as 60000 (1 min). |
+------------------------------------------------------------------------------------------+
`);
            }, 8000);

            debug(`Pulling ${this.image}`)
            log.spinner(`Pulling ${this.image}...`);

            await this.pull(this.image);

            debug("Pull complete");
        }

        await this.checkExistingContainers();

        log.spinner('Starting container');

        // links for docker create container config:
        //   docker api: https://docs.docker.com/engine/api/v1.37/#operation/ContainerCreate
        //   docker run impl: https://github.com/docker/cli/blob/2c3797015f5e7ef4502235b638d161279c471a8d/cli/command/container/run.go#L33
        //   https://github.com/apocas/dockerode/issues/257
        //   https://github.com/apocas/dockerode/blob/master/lib/docker.js#L1442
        //   https://medium.com/@johnnyeric/how-to-reproduce-command-docker-run-via-docker-remote-api-with-node-js-5918d7b221ea

        const containerRuntimePort = `${RUNTIME_PORT}/tcp`;
        const hostRuntimePort = await getPort();
        const ipAddress = process.env.DOCKER_HOST_IP || "0.0.0.0";
        this.containerURL = `http://${ipAddress}:${hostRuntimePort}`;
        const containerDebugPort = `${this.debug.internalPort}/tcp`;

        const createContainerConfig = {
            name: this.containerName,
            Labels: {
                [LABEL_ACTION_NAME]: this.getFullActionName()
            },
            Image: this.image,
            Cmd: [ 'sh', '-c', this.debug.command ],
            Env: [],
            Volumes: {},
            ExposedPorts: {
                [containerRuntimePort]: {},
                [containerDebugPort]: {}
            },
            HostConfig: {
                AutoRemove: true,
                PortBindings: {
                    [containerRuntimePort]: [{ HostPort: `${hostRuntimePort}` }],
                    [containerDebugPort]: [{ HostPort: `${this.debug.port}` }]
                },
                Memory: this.memory,
                Binds: []
            }
        };

        if (this.debug.updateContainerConfig) {
            this.debug.updateContainerConfig(this, createContainerConfig);
        }

        dockerUtils.dockerRunArgs2CreateContainerConfig(this.dockerArgsFromUser, createContainerConfig);

        debug("docker - creating container:", createContainerConfig);

        this.container = await this.docker.createContainer(createContainerConfig);

        const stream = await this.container.attach({
            stream: true,
            stdout: true,
            stderr: true
        });

        const spinnerSafeStream = (stream) => ({
            write: (data) => {
                log.stopSpinner();
                stream(data.toString().replace(/\n$/, ""));
                log.resumeSpinner();
            }
        });

        this.container.modem.demuxStream(
            stream,
            spinnerSafeStream(console.log),
            spinnerSafeStream(console.error)
        );

        await this.container.start();

        debug(`docker - started container ${this.container.id}`);
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

    name() {
        return this.containerName;
    }

    url() {
        return this.containerURL || "";
    }

    timeout() {
        return this.action.limits.timeout || OPENWHISK_DEFAULTS.timeout;
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

        const RETRIES = MAX_INIT_RETRY_MS / INIT_RETRY_DELAY_MS;

        const response = await fetch(`${this.url()}/init`, {
            method: "POST",
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                value: action
            }),
            retryDelay: INIT_RETRY_DELAY_MS,
            retryOn: function(attempt, error) {
                // after 1.5 seconds, show retry to user via spinner
                if (attempt >= 1500 / INIT_RETRY_DELAY_MS) {
                    log.spinner(`Installing action (retry ${attempt}/${RETRIES})`)
                }
                return error !== null && attempt < RETRIES;
            }
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
        if (this.container) {
            // log this here for VS Code, will be the last visible log message since
            // we will be killed by VS code after the container is gone after the kill()
            log.log(`Stopping container ${this.name()}.`);
            try {
                await this.container.remove({ force: true});
            } catch (e) {
                // if we get a 404 the container is already gone (our goal), no need to log this error
                if (e.statusCode !== 404) {
                    log.exception(e, "Error while removing container");
                }
            }
            delete this.container;
            log.debug(`docker - stopped container ${this.name()}`);
        }
    }
}

module.exports = OpenWhiskInvoker;
