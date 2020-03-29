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
const http = require('http');
const ngrok = require('ngrok');
const url = require('url');
const util = require('util');
const crypto = require("crypto");

class NgrokAgent {
    constructor(argv) {
        this.argv = argv;
    }

    async getAgent(action) {
        if (this.argv.verbose) {
            console.log("Setting up ngrok", this.argv.ngrokRegion ? `(region: ${this.argv.ngrokRegion})` : "");
        }

        // 1. start local server on random port
        this.ngrokServer = http.createServer(this.ngrokHandler.bind(this));
        // turn server.listen() into promise so we can await
        const listen = util.promisify( this.ngrokServer.listen.bind(this.ngrokServer) );
        await listen(0, '127.0.0.1');

        // 2. start ngrok tunnel connected to that port
        this.ngrokServerPort = this.ngrokServer.address().port;

        // create a unique authorization token that we check on our local instance later
        // this adds extra protection on top of the uniquely generated ngrok subdomain (e.g. a01ae275.ngrok.io)
        this.ngrokAuth = crypto.randomBytes(32).toString("hex");
        const ngrokUrl = await ngrok.connect({
            addr: this.ngrokServerPort,
            region: this.argv.ngrokRegion
        });

        // 3. pass on public ngrok url to agent
        action.parameters.push({
            key: "$ngrokUrl",
            value: url.parse(ngrokUrl).host
        });
        action.parameters.push({
            key: "$ngrokAuth",
            value: this.ngrokAuth
        });

        console.log(`Ngrok forwarding: ${ngrokUrl} => http://localhost:${this.ngrokServerPort} (auth: ${this.ngrokAuth})`);

        return fs.readFileSync(`${__dirname}/../agent/agent-ngrok.js`, {encoding: 'utf8'});
    }

    async stop() {
        try {
            if (this.ngrokServer) {
                this.ngrokServer.close();
                this.ngrokServer = null;
            }
        } finally {
            await ngrok.kill();
        }
    }

    // local http server retrieving forwards from the ngrok agent, running them
    // as a blocking local invocation and then returning the activation result back
    ngrokHandler(req, res) {
        // check authorization against our unique token
        const authHeader = req.headers.authorization;
        if (authHeader !== this.ngrokAuth) {
            res.statusCode = 401;
            res.end();
            return;
        }

        if (req.method === 'POST') {
            // agent POSTs arguments as json body
            let body = '';
            // collect full request body first
            req.on('data', chunk => {
                body += chunk.toString();
            });
            req.on('end', async () => {
                try {
                    const params = JSON.parse(body);
                    const id = params.$activationId;
                    delete params.$activationId;

                    if (this.argv.verbose) {
                        console.log();
                        console.info(`Activation: ${id}`);
                        console.log(params);
                    } else {
                        console.info(`Activation: ${id}`);
                    }

                    const startTime = Date.now();

                    const result = await this.invoker.run(params, id);

                    const duration = Date.now() - startTime;
                    console.info(`Completed activation ${id} in ${duration/1000.0} sec`);
                    if (this.argv.verbose) {
                        console.log(result);
                    }

                    res.statusCode = 200;
                    res.setHeader("Content-Type", "application/json");
                    res.end(JSON.stringify(result));

                } catch (e) {
                    console.error(e);
                    res.statusCode = 400;
                    res.end();
                }
            });
        } else {
            res.statusCode = 404;
            res.end();
        }
    }
}

module.exports = NgrokAgent;
