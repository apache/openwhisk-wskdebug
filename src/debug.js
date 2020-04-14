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

// common debug() instance for shared time spent measurments (+millis)
module.exports = require('debug')('wskdebug');

// start a sub debug instance for logging times in parallel promises
module.exports.task = () => {
    const debug = require('debug')('wskdebug')
    // trick to start time measurement from now on without logging an extra line
    debug.log = () => {};
    debug();
    delete debug.log;
    return debug;
}