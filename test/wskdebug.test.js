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


/* eslint-env mocha */

'use strict';

// tests basic cli

let wskdebug = require('../index');
const dockerUtils = require('../src/dockerutils');

const test = require('./test');
const assert = require('assert');
const stripAnsi = require('strip-ansi');
const {execSync} = require('child_process');

const mockRequire = require('mock-require');

function mockDebugger() {
    const receivedArgv = {};

    class MockDebugger {
        constructor(argv) {
            Object.assign(receivedArgv, argv);
        }

        start() {}
        run() {}
    }

    mockRequire("../src/debugger", MockDebugger);
    wskdebug = mockRequire.reRequire("../index");
    return receivedArgv;
}

describe('wskdebug cli', function() {

    after(function() {
        // stop mock otherwise bad effect on other tests
        mockRequire.stop("../src/debugger");
    })

    it("should print version (via wskdebug.js)", async function() {
        this.timeout(5000);
        const stdout = execSync("node wskdebug.js --version").toString();
        assert.equal(stripAnsi(stdout.trim()), require(`${process.cwd()}/package.json`).version);
    });

    it("should print help", async function() {
        test.startCaptureStdout();

        await wskdebug(`-h`);

        const stdio = test.endCaptureStdout();

        // testing a couple strings that should rarely change
        assert(stdio.stdout.includes("Debug an Apache OpenWhisk <action> by forwarding its activations to a local docker"));
        assert(stdio.stdout.includes("Supported kinds:"));
        assert(stdio.stdout.includes("Arguments:"));
        assert(stdio.stdout.includes("Action options:"));
        assert(stdio.stdout.includes("LiveReload options:"));
        assert(stdio.stdout.includes("Debugger options:"));
        assert(stdio.stdout.includes("Agent options:"));
        assert(stdio.stdout.includes("Options:"));
    });

    it("should print the version", async function() {
        test.startCaptureStdout();

        await wskdebug(`--version`);

        const stdio = test.endCaptureStdout();
        assert.equal(stripAnsi(stdio.stdout.trim()), require(`${process.cwd()}/package.json`).version);
    });

    it("should take action argument", async function() {
        const argv = mockDebugger();

        await wskdebug(`action`);
        assert.strictEqual(argv.action, "action");

        await wskdebug(`package/action`);
        assert.strictEqual(argv.action, "package/action");
    });

    it("should use WSK_PACKAGE env var as package name", async function() {
        const argv = mockDebugger();

        process.env.WSK_PACKAGE = "envPackage";
        await wskdebug(`action`);
        assert.strictEqual(argv.action, "envPackage/action");

        // cli package takes precedence
        await wskdebug(`package/action`);
        assert.strictEqual(argv.action, "package/action");
    });

    it("should parse docker args", function() {
        const args = " -e foo=bar -v /some/path:/mount/path -v /another:/path";

        const containerConfig = {
            Cmd: [],
            Env: [],
            Volumes: {},
            HostConfig: {
                Binds: [],
                ExposedPorts: {},
                PortBindings: {}
            }
        };
        dockerUtils.dockerRunArgs2CreateContainerConfig(args, containerConfig);

        console.log(containerConfig);

        assert.strictEqual(containerConfig.Env[0], "foo=bar");
        assert.strictEqual(containerConfig.HostConfig.Binds[0], "/some/path:/mount/path");
        assert.strictEqual(containerConfig.HostConfig.Binds[1], "/another:/path");
    })
});
