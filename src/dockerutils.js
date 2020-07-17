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

const yargsParser = require('yargs-parser');

function safeContainerName(name) {
    // docker container names are restricted to [a-zA-Z0-9][a-zA-Z0-9_.-]*

    // 1. replace special characters with dash
    name = name.replace(/[^a-zA-Z0-9_.-]+/g, '-');
    // 2. leading character is more limited
    name = name.replace(/^[^a-zA-Z0-9]+/g, '');
    // 3. (nice to have) remove trailing special chars
    name = name.replace(/[^a-zA-Z0-9]+$/g, '');

    return name;
}

// convert docker run cli args to docker create container config
// https://docs.docker.com/engine/reference/commandline/run/
// https://docs.docker.com/engine/api/v1.37/#operation/ContainerCreate
function dockerRunArgs2CreateContainerConfig(args, containerConfig) {
    if (!args) {
        return containerConfig;
    }

    containerConfig = containerConfig || {};

    const argv = yargsParser(args.split(" "));

    for (const [key, value] of Object.entries(argv)) {
        // treat all as array, makes it simpler below
        const values = Array.isArray(value) ? value : [ value ];

        switch (key) {
        case "e": // environment variables
            values.forEach(e => containerConfig.Env.push(e));
            break;
        case "v": // volume mounts (binds)
            values.forEach(v => containerConfig.HostConfig.Binds.push(v));
            break;
        case "_": // ignore yargs specials
        case "$0":
            break;
        default:
            throw new Error(`Unsupported argument in --dockerArgs: '-${key}'. Please report at https://github.com/apache/openwhisk-wskdebug/issues`)
        }
    }

    return containerConfig;
}

function getContainerName(container) {
    if (container.Names && container.Names.length >= 1) {
        // remove leading slash
        return container.Names[0].substring(1);
    }
}

module.exports = {
    safeContainerName,
    dockerRunArgs2CreateContainerConfig,
    getContainerName
};
