<!--
#
# Licensed to the Apache Software Foundation (ASF) under one or more
# contributor license agreements.  See the NOTICE file distributed with
# this work for additional information regarding copyright ownership.
# The ASF licenses this file to You under the Apache License, Version 2.0
# (the "License"); you may not use this file except in compliance with
# the License.  You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
-->

# Changelog

## v1.4.0

### Improvements

- travis: log detailed test output on failure
- travis: get most verbose logging while keeping standard npm test quiet
- chore: example/nodejs: put name first in vs code launch.json examples
- chore: README: put name first in vs code launch.json examples
- chore: configure more github project properties vis asf.yaml #88
- chore: update openwhisk-client-js to 3.21.4

### Fixes

- fix: swap isomorphic-fetch for node-fetch for security issue #96
- fix: disable installation of peer dependencies (npm@7 default) #97
- fix: pull image before test runs - should fix flaky agentmgr.test.js tests in Travis #84
- fix: wskdebug does not work with new VS Code 1.48 debugger #74
- fix: use lts node, instead of latest (test Dockerfile)
- fix: fix travis badge url #92
- fix: formatting for github and usage output
- fix: spelling #86
- fix: link and grammar #87
- chore: various dependabot dependency updates #99 #100 #102 #103
- chore: update copyright notice #90
- chore: npm audit fixes

## v1.3.0

### Features

- support credentials stored in .env file and Adobe I/O Runtime variables #72
- support reading package name from WSK_PACKAGE env var #10
- support custom docker host IPs #67
- add -q/—quiet option #56 #68
- [nodejs] pass through DEBUG, NODE_DEBUG environment variables #43

### Improvements

- use docker api client instead of `docker` child process #54
- drop concurrency api check for performance #58
- nicer console ui using spinner #8
- performance: load action sources lazily on container  #53
- validate source path etc. before async installation of agent #52
- improve startup and shutdown speed #41
- make ngrok an optional dependency #22

### Fixes

- warn if new incompatible vs code debugger is invoking in and document workaround #76
- detect if debug port is already used, e.g. by left over container #59
- fix activation DB agent on Adobe I/O Runtime requiring `X-OW-EXTRA-LOGGING` header #49
- ignore 503 errors with activation db agent #44
- include hidden `--ignoreCerts` option in usage info #42
- restoring action sometimes fails from vscode, then on next run polling fails #25
- fix concurrency error when using wskdebug with IBM Cloud Functions #7
- [nodejs] mount-require is only reloading the main source file, not any other required files #9


## v1.2.0
* Initial release under new Apache OpenWhisk ownership and new name @openwhisk/wskdebug
