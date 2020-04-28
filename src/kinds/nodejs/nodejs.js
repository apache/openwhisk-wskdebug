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

const fs = require('fs-extra');
const path = require('path');

// path inside docker container where action code is mounted
const CODE_MOUNT = "/code";

module.exports = {
    description: "Node.js V8 inspect debugger on port 9229. Supports source mount",

    // additional debug port to expose
    port: 9229,

    // modified docker image command/entrypoint to enable debugging
    command: function(invoker) {
        return `node --expose-gc --inspect=0.0.0.0:${invoker.debug.internalPort} app.js`
    },

    // set extra docker container settings such as mounting the source path
    updateContainerConfig: function(invoker, containerConfig) {
        if (invoker.sourceDir) {
            if (!invoker.sourceFile) {
                throw new Error(`[source-path] or --build-path must point to a source file, it cannot be a folder: '${invoker.sourcePath}'`);
            }

            containerConfig.HostConfig.Binds.push(`${invoker.sourceDir}:${CODE_MOUNT}`);
        }

        if (process.env.WSK_NODE_DEBUG) {
            containerConfig.Env.push(`NODE_DEBUG=${process.env.WSK_NODE_DEBUG}`);
        }
        if (process.env.DEBUG) {
            containerConfig.Env.push(`DEBUG=${process.env.DEBUG}`);
        }
    },

    // return action for /init that mounts the sources specified by invoker.sourcePath
    mountAction: function(invoker) {
        // bridge that mounts local source path

        if (fs.statSync(invoker.sourcePath).isDirectory()) {
            throw new Error(`[source-path] or --build-path must point to a source file, it cannot be a folder: '${invoker.sourcePath}'`);
        }

        // test if code uses commonjs require()
        const isCommonJS = /(\s|=)require\(\s*['"`]/.test(fs.readFileSync(invoker.sourcePath));

        // is it a require() based action or a plain JS one?
        const bridgeSource = isCommonJS ? "mount-require.js" : "mount-plain.js";

        let code = fs.readFileSync(`${__dirname}/${bridgeSource}`, {encoding: 'utf8'});
        let sourceFile = invoker.sourceFile.toString();

        // On Windows, the path set on the cli would typically be in windows format,
        // but the nodejs container is Unix and requires Unix paths
        if (path.sep !== path.posix.sep) {
            sourceFile = sourceFile.split(path.sep).join(path.posix.sep);
        }

        code = code.replace("$$main$$",        invoker.main || "main");
        code = code.replace("$$sourcePath$$", `${CODE_MOUNT}/${sourceFile}`);
        code = code.replace("$$sourceFile$$",  sourceFile);

        return {
            binary: false,
            main:   "main",
            code:   code,
        };
    }
}
