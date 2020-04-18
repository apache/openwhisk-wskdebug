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
const livereload = require('livereload');
const { spawnSync } = require('child_process');
const log = require('./log');

class Watcher {
    constructor(argv, wsk) {
        this.argv = argv;
        this.wsk = wsk;
    }

    async start() {
        const watch = this.argv.watch || process.cwd();
        if (watch &&
            // each of these triggers listening
            (   this.argv.livereload
             || this.argv.onBuild
             || this.argv.onChange
             || this.argv.invokeParams
             || this.argv.invokeAction )
        ) {
            log.spinner('Initializing source watching');

            this.liveReloadServer = livereload.createServer({
                port: this.argv.livereloadPort,
                noListen: !this.argv.livereload,
                exclusions: [this.argv.buildPath, "**/node_modules/**", "**/.*"],
                exts: this.argv.watchExts || ["json", "js", "ts", "coffee", "py", "rb", "erb", "go", "java", "scala", "php", "swift", "rs", "cs", "bal", "php", "php5"],
                extraExts: []
            });
            this.liveReloadServer.watch(watch);

            // overwrite function to get notified on changes
            const refresh = this.liveReloadServer.refresh;
            const argv = this.argv;
            const wsk = this.wsk;
            this.liveReloadServer.refresh = function(filepath) {
                try {
                    let result = [];

                    log.verbose("File modified:", filepath);

                    // call original function if we are listening
                    if (argv.livereload) {
                        result = refresh.call(this, filepath);
                    }

                    // run build command before invoke triggers below
                    if (argv.onBuild) {
                        log.highlight("On build: ", argv.onBuild);
                        spawnSync(argv.onBuild, {shell: true, stdio: "inherit"});
                    }

                    // run shell command
                    if (argv.onChange) {
                        log.highlight("On run: ", argv.onChange);
                        spawnSync(argv.onChange, {shell: true, stdio: "inherit"});
                    }

                    // action invoke
                    if (argv.invokeParams || argv.invokeAction) {
                        let json = {};
                        if (argv.invokeParams) {
                            if (argv.invokeParams.trim().startsWith("{")) {
                                json = JSON.parse(argv.invokeParams);
                            } else {
                                json = JSON.parse(fs.readFileSync(argv.invokeParams, {encoding: 'utf8'}));
                            }
                        }
                        const action = argv.invokeAction || argv.action;
                        wsk.actions.invoke({
                            name: action,
                            params: json
                        }).then(response => {
                            log.step(`Invoked action ${action} with params ${argv.invokeParams}: ${response.activationId}`);
                        }).catch(err => {
                            log.error("Error invoking action:", err);
                        });
                    }

                    return result;
                } catch (e) {
                    log.error(e);
                }
            };

            if (this.argv.livereload) {
                log.log(`LiveReload enabled for ${log.highlightColor(watch)} on port ${this.liveReloadServer.config.port}`);
            }
            log.debug("started source file watching");
        }
    }

    async stop() {
        if (this.liveReloadServer) {
            if (this.liveReloadServer.server) {
                this.liveReloadServer.close();
            } else {
                this.liveReloadServer.watcher.close();
            }
            this.liveReloadServer = null;
        }
    }
}

module.exports = Watcher;
