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

/* eslint-disable strict */

const fs = require('fs');
const nodePath = require('path');

// Variables will be replaced before the code is loaded

// path to actual action sources
const path = "$$sourcePath$$";
// main function
const mainFn = "$$main$$";
// name of module file (for helpful errors)
const sourceFile = "$$sourceFile$$";

function load(path) {
    const code = fs.readFileSync(path, {encoding: 'utf8'});

    // eslint-disable-next-line no-eval
    const fn = eval('(function(){' + code + '\n; return ' + mainFn + '})()\n //@ sourceURL=' + path);

    if (typeof fn !== 'function') {
        throw `'${mainFn}' is not a function in '${sourceFile}'. Specify the right function in wskdebug using --main.`;
    }

    return fn;
}

// eslint-disable-next-line no-unused-vars
function main(args) { // lgtm [js/unused-local-variable]
    process.chdir(nodePath.dirname(path));

    // load code again on every new invocation
    const actionMain = load(path);

    // invoke
    return actionMain(args);
}
